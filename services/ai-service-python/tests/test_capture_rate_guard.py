"""Detecção de FPS de captura ANÔMALO — assinatura de timestamp quebrado.

Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
(frigate/video/ffmpeg.py: `camera_fps >= detect.fps + 10` por N checagens).

O que estes testes travam:
  • stream saudável NUNCA alarma (falso positivo aqui vira ruído que o operador
    aprende a ignorar — pior que não ter alarme);
  • excesso instantâneo (rajada pós-reconexão) também não alarma: o excesso
    precisa se SUSTENTAR;
  • quando alarma, o evento carrega os números para o log;
  • alarme não vira spam (cooldown) e o relógio de anomalia zera quando o stream
    volta ao normal;
  • o guarda NUNCA levanta exceção nem derruba a captura — ele DENUNCIA.

Relógio INJETADO (FakeClock): nada aqui espera tempo real.
Framework: unittest da stdlib. Puro — não importa cv2.
"""

import ast
import math
import os
import unittest

from capture_rate_guard import CaptureRateGuard

SVC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class FakeClock:
    def __init__(self, start=1_000_000.0):
        self.t = float(start)

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += float(seconds)


def make_guard(clock, expected_fps=20.0, **kwargs):
    params = dict(
        margin_fps=10.0,
        sustain_seconds=30.0,
        window_seconds=5.0,
        cooldown_seconds=60.0,
        min_samples=12,
    )
    params.update(kwargs)
    return CaptureRateGuard(expected_fps=expected_fps, clock=clock, **params)


def feed(guard, clock, fps, seconds):
    """Alimenta o guarda a `fps` durante `seconds`; devolve os eventos emitidos."""
    events = []
    step = 1.0 / float(fps)
    for _ in range(int(round(float(seconds) * float(fps)))):
        clock.advance(step)
        event = guard.observe()
        if event:
            events.append(event)
    return events


class TestCaptureRateGuard(unittest.TestCase):
    def test_stream_saudavel_nunca_alarma(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        # 20 fps esperados, 20 fps observados, por 5 minutos.
        self.assertEqual(feed(guard, clock, 20.0, 300), [])
        self.assertFalse(guard.state()["anomalous"])

    def test_fps_no_limite_nao_alarma(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)  # limite = 20 + 10 = 30
        self.assertEqual(feed(guard, clock, 29.0, 300), [])

    def test_rajada_curta_nao_alarma(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        # Buffer drenando depois de reconectar: 400 fps por 20s (< sustain de 30s).
        self.assertEqual(feed(guard, clock, 400.0, 20), [])

    def test_excesso_SUSTENTADO_alarma_uma_vez_com_os_numeros(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        events = feed(guard, clock, 400.0, 45)
        self.assertEqual(len(events), 1, "deve denunciar exatamente uma vez (cooldown de 60s)")
        event = events[0]
        self.assertGreater(event["observed_fps"], 300.0)
        self.assertEqual(event["expected_fps"], 20.0)
        self.assertEqual(event["threshold_fps"], 30.0)
        self.assertGreaterEqual(event["sustained_seconds"], 30.0)
        self.assertTrue(guard.state()["anomalous"])

    def test_alarme_respeita_cooldown_e_repete_depois(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        primeiro = feed(guard, clock, 400.0, 45)
        self.assertEqual(len(primeiro), 1)
        # Mais 40s de anomalia contínua: cooldown de 60s ainda cala o alarme.
        self.assertEqual(feed(guard, clock, 400.0, 40), [])
        # Passado o cooldown, denuncia de novo (o problema continua lá).
        self.assertEqual(len(feed(guard, clock, 400.0, 20)), 1)

    def test_voltar_ao_normal_zera_o_relogio_da_anomalia(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        self.assertEqual(feed(guard, clock, 400.0, 20), [])  # quase sustentou
        self.assertEqual(feed(guard, clock, 20.0, 20), [])   # voltou ao normal
        self.assertFalse(guard.state()["anomalous"])
        self.assertEqual(feed(guard, clock, 400.0, 25), [])  # começa a contar do zero
        self.assertEqual(len(feed(guard, clock, 400.0, 10)), 1)

    def test_captura_parada_nao_alarma(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        feed(guard, clock, 400.0, 20)
        # Stream congelou: nenhuma amostra nova por 10 min. Sem evidência, sem alarme.
        clock.advance(600)
        self.assertIsNone(guard.observe())
        self.assertFalse(guard.state()["anomalous"])

    def test_fps_esperado_desconhecido_usa_fallback(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=0.0, fallback_expected_fps=30.0)
        self.assertEqual(guard.expected_fps, 30.0)
        self.assertEqual(feed(guard, clock, 30.0, 120), [])
        self.assertEqual(len(feed(guard, clock, 600.0, 40)), 1)

    def test_set_expected_fps_ignora_lixo(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        for junk in (0, -5, float("nan"), float("inf"), "abc", None, 100_000):
            guard.set_expected_fps(junk)
            self.assertEqual(guard.expected_fps, 20.0, f"lixo {junk!r} não pode virar FPS esperado")
        guard.set_expected_fps(25.0)
        self.assertEqual(guard.expected_fps, 25.0)
        self.assertEqual(guard.threshold_fps, 35.0)

    def test_observe_nunca_levanta_e_ignora_relogio_quebrado(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        for bad in (float("nan"), float("inf"), "não é hora", None):
            self.assertIsNone(guard.observe(bad))
        # E o guarda segue funcional depois do lixo.
        self.assertEqual(len(feed(guard, clock, 400.0, 45)), 1)

    def test_throttle_sugerido_so_existe_na_anomalia(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        feed(guard, clock, 20.0, 60)
        self.assertEqual(guard.suggested_sleep_seconds(), 0.0)
        feed(guard, clock, 400.0, 45)
        sleep = guard.suggested_sleep_seconds()
        self.assertGreater(sleep, 0.0)
        # O freio nunca pode ser mais lento que o limite (senão viraria o problema).
        self.assertLessEqual(sleep, 1.0 / guard.threshold_fps + 1e-9)

    def test_state_expoe_diagnostico_para_o_health(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0)
        feed(guard, clock, 400.0, 45)
        state = guard.state()
        self.assertTrue(state["anomalous"])
        self.assertEqual(state["reports"], 1)
        self.assertEqual(state["expected_fps"], 20.0)
        self.assertEqual(state["threshold_fps"], 30.0)
        self.assertGreater(state["observed_fps"], 300.0)
        self.assertTrue(math.isfinite(state["observed_fps"]))

    def test_memoria_limitada_mesmo_com_fps_absurdo(self):
        clock = FakeClock()
        guard = make_guard(clock, expected_fps=20.0, max_samples=256)
        feed(guard, clock, 5_000.0, 5)
        self.assertLessEqual(len(guard._samples), 256)
        # Mesmo com a janela truncada, a taxa observada continua sendo denunciada.
        self.assertGreater(guard.observed_fps(), 1_000.0)


class TestStreamProcessorWiring(unittest.TestCase):
    """O guarda só serve se estiver LIGADO no laço de captura (leitura estática:
    stream_processor.py importa cv2 e não pode ser importado no host)."""

    def setUp(self):
        with open(os.path.join(SVC_DIR, "stream_processor.py"), "r", encoding="utf-8") as handle:
            self.source = handle.read()

    def test_importa_e_instancia_o_guarda(self):
        self.assertIn("from capture_rate_guard import CaptureRateGuard", self.source)
        self.assertIn("CaptureRateGuard(", self.source)

    def test_laco_de_captura_contabiliza_cada_frame_consumido(self):
        # Um por caminho de consumo de frame: grab() (drenagem) e read() (análise).
        self.assertGreaterEqual(
            self.source.count("self._note_capture_rate()"),
            2,
            "grab() e read() consomem frame: os dois precisam alimentar o guarda",
        )
        tree = ast.parse(self.source)
        self.assertTrue(
            any(isinstance(node, ast.FunctionDef) and node.name == "_note_capture_rate" for node in ast.walk(tree)),
            "o método que denuncia o FPS anômalo precisa existir",
        )

    def test_denuncia_com_warning_e_expoe_no_estado_da_captura(self):
        self.assertIn("TIMESTAMP QUEBRADO", self.source)
        self.assertIn("capture_rate_guard", self.source)


if __name__ == "__main__":
    unittest.main()
