"""Watchdog de INFERÊNCIA travada (item 1).

Hoje o /health só mede a CAPTURA: uma câmera pode ficar `ready` e CEGA para
sempre. O cenário concreto (quando religarem a IA de objeto): o modelo falha ao
carregar → a thread de processamento morre no `return` → /health responde
`online`, a câmera aparece em `active_processors` e NADA é detectado.

O que estes testes travam:
  • com a IA de objeto DESLIGADA (analysis_type='motion') o sinal é
    `not_applicable` e NUNCA degradado — falso alarme aqui é PIOR que não ter
    alarme (o `degraded_processors` do /health REINICIA a análise no api,
    apps/api/src/ai/ai-manager.service.ts → reiniciar câmera armada em
    recordingMode:motion é risco de perder gravação);
  • com a IA de objeto LIGADA, captura viva e nenhuma inferência além do limiar
    → degradado (é exatamente o modelo que não carregou);
  • captura morta NÃO vira "inferência travada" (o watchdog de captura já é dono
    desse caso — não duplicar alarme);
  • câmera hibernando (motion_trigger CAMERA fora da janela de wakeup) não é
    degradada: não inferir é o comportamento correto ali;
  • a fusão com o `degraded_processors` atual é ATRÁS DE FLAG, default OFF —
    com a flag desligada a lista sai IDÊNTICA à de hoje.

Framework: unittest da stdlib (decisão 9.2). Módulo PURO — não importa cv2.
Relógio INJETADO: nada aqui espera tempo real.

Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
(frigate/watchdog.py: acompanha `detection_start` e considera a detecção travada
quando passa do limiar).
"""

import unittest

from inference_watchdog import (
    STATUS_CAPTURE_NOT_READY,
    STATUS_IDLE,
    STATUS_NOT_APPLICABLE,
    STATUS_OK,
    STATUS_STALLED,
    STATUS_WARMING_UP,
    enforcement_enabled,
    evaluate_inference_health,
    inference_degraded_ids,
    merge_degraded,
    stall_threshold_seconds,
)

NOW = 1_000_000.0


def health(**overrides):
    """Cenário base: IA de objeto LIGADA, captura viva, acordada, inferindo."""
    params = dict(
        advanced_analysis_type="general",
        runs=120,
        errors=0,
        last_inference_at=NOW - 1.0,
        last_duration_ms=42.0,
        avg_duration_ms=40.0,
        expected_interval_seconds=0.25,
        capture_ready=True,
        awake=True,
        started_at=NOW - 3600.0,
        now=NOW,
    )
    params.update(overrides)
    return evaluate_inference_health(**params)


class TestIaDesligadaNaoAlarma(unittest.TestCase):
    """A IA de objeto/face está DESLIGADA por decisão do dono. Sem inferência
    esperada, o watchdog não pode inventar degradação."""

    def test_modo_motion_e_not_applicable_e_nunca_degradado(self):
        state = health(advanced_analysis_type=None, runs=0, last_inference_at=0.0)
        self.assertEqual(state["status"], STATUS_NOT_APPLICABLE)
        self.assertFalse(state["applicable"])
        self.assertFalse(state["degraded"], "IA desligada NÃO pode ser reportada como degradada")
        self.assertEqual(state["reason"], "object_ai_disabled")

    def test_not_applicable_mesmo_com_captura_viva_e_muito_tempo_parado(self):
        # Um mês sem inferência com a IA desligada continua sendo o esperado.
        state = health(
            advanced_analysis_type=None,
            runs=0,
            last_inference_at=0.0,
            started_at=NOW - 30 * 86400.0,
        )
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], STATUS_NOT_APPLICABLE)

    def test_not_applicable_para_string_vazia(self):
        for disabled in (None, "", "   "):
            with self.subTest(disabled=disabled):
                state = health(advanced_analysis_type=disabled, runs=0, last_inference_at=0.0)
                self.assertEqual(state["status"], STATUS_NOT_APPLICABLE)
                self.assertFalse(state["degraded"])

    def test_not_applicable_nao_expoe_limiar_falso(self):
        state = health(advanced_analysis_type=None, runs=0, last_inference_at=0.0)
        self.assertIsNone(state["stall_threshold_seconds"])
        self.assertIsNone(state["age_seconds"])


class TestInferenciaTravada(unittest.TestCase):
    def test_modelo_que_nunca_inferiu_com_captura_viva_e_degradado(self):
        # Cenário exato do modelo que falhou ao carregar: _process() deu return,
        # a captura segue viva, a câmera segue em active_processors.
        state = health(
            runs=0,
            last_inference_at=0.0,
            started_at=NOW - 600.0,
            last_error="Modelo OpenVINO 640px não encontrado.",
        )
        self.assertTrue(state["degraded"])
        self.assertEqual(state["status"], STATUS_STALLED)
        self.assertEqual(state["reason"], "no_inference_since_start")
        self.assertEqual(state["last_error"], "Modelo OpenVINO 640px não encontrado.")

    def test_inferencia_parada_alem_do_limiar_e_degradada(self):
        state = health(last_inference_at=NOW - 400.0)
        self.assertTrue(state["degraded"])
        self.assertEqual(state["status"], STATUS_STALLED)
        self.assertEqual(state["reason"], "inference_stalled")
        self.assertAlmostEqual(state["age_seconds"], 400.0, places=3)

    def test_inferencia_recente_esta_ok(self):
        state = health(last_inference_at=NOW - 0.5)
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], STATUS_OK)
        self.assertIsNone(state["reason"])

    def test_borda_do_limiar_nao_degrada_antes_da_hora(self):
        threshold = health()["stall_threshold_seconds"]
        no_limite = health(last_inference_at=NOW - threshold)
        self.assertFalse(no_limite["degraded"], "exatamente no limiar ainda não é travamento")
        passou = health(last_inference_at=NOW - threshold - 0.001)
        self.assertTrue(passou["degraded"])

    def test_erros_de_inferencia_sao_expostos_mas_nao_degradam_sozinhos(self):
        # Um erro pontual com inferência voltando a rodar não é travamento.
        state = health(errors=7, last_inference_at=NOW - 0.3)
        self.assertEqual(state["errors"], 7)
        self.assertFalse(state["degraded"])


class TestNaoDuplicaAlarmeDeCaptura(unittest.TestCase):
    def test_captura_nao_pronta_nao_vira_inferencia_travada(self):
        # Câmera offline já é reportada pelo readiness de captura; culpar a
        # inferência aqui duplicaria o alarme e escondrizaria a causa real.
        state = health(capture_ready=False, runs=0, last_inference_at=0.0, started_at=NOW - 3600.0)
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], STATUS_CAPTURE_NOT_READY)
        self.assertEqual(state["reason"], "capture_not_ready")

    def test_hibernando_nao_e_degradado(self):
        # motion_trigger=CAMERA fora da janela de wakeup: não inferir é o correto.
        state = health(awake=False, runs=0, last_inference_at=0.0, started_at=NOW - 3600.0)
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], STATUS_IDLE)
        self.assertEqual(state["reason"], "hibernating")

    def test_warmup_nao_e_degradado(self):
        # Recém-iniciado, ainda carregando o modelo: dar tempo antes de acusar.
        state = health(runs=0, last_inference_at=0.0, started_at=NOW - 5.0)
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], STATUS_WARMING_UP)


class TestLimiar(unittest.TestCase):
    def test_limiar_respeita_piso(self):
        # 4 fps → 0,25s de intervalo. 12× isso = 3s: curto demais, o piso manda.
        self.assertEqual(
            stall_threshold_seconds(0.25, multiplier=12.0, minimum=30.0, maximum=600.0),
            30.0,
        )

    def test_limiar_acompanha_fps_lento(self):
        # 0,1 fps → 10s de intervalo → 12× = 120s (acima do piso).
        self.assertEqual(
            stall_threshold_seconds(10.0, multiplier=12.0, minimum=30.0, maximum=600.0),
            120.0,
        )

    def test_limiar_respeita_teto(self):
        self.assertEqual(
            stall_threshold_seconds(1000.0, multiplier=12.0, minimum=30.0, maximum=600.0),
            600.0,
        )

    def test_intervalo_invalido_cai_no_piso(self):
        for bad in (0.0, -1.0, None):
            with self.subTest(bad=bad):
                self.assertEqual(
                    stall_threshold_seconds(bad, multiplier=12.0, minimum=30.0, maximum=600.0),
                    30.0,
                )


class TestFusaoComDegradedAtualAtrasDeFlag(unittest.TestCase):
    """`degraded_processors` do /health REINICIA a análise no api. Enquanto a
    flag estiver desligada (default), a lista tem de sair IDÊNTICA à de hoje."""

    def setUp(self):
        self.states = {
            "cam-ok": health(),
            "cam-cega": health(runs=0, last_inference_at=0.0, started_at=NOW - 600.0),
            "cam-motion": health(advanced_analysis_type=None, runs=0, last_inference_at=0.0),
        }

    def test_ids_degradados_por_inferencia(self):
        self.assertEqual(inference_degraded_ids(self.states), ["cam-cega"])

    def test_flag_desligada_preserva_a_lista_atual(self):
        capture_degraded = ["cam-offline"]
        merged = merge_degraded(capture_degraded, self.states, enforce=False)
        self.assertEqual(merged, ["cam-offline"])

    def test_flag_ligada_soma_a_inferencia_travada(self):
        merged = merge_degraded(["cam-offline"], self.states, enforce=True)
        self.assertEqual(merged, ["cam-offline", "cam-cega"])

    def test_flag_ligada_nao_duplica_id_ja_degradado(self):
        merged = merge_degraded(["cam-cega"], self.states, enforce=True)
        self.assertEqual(merged, ["cam-cega"])

    def test_merge_nao_muta_a_lista_recebida(self):
        capture_degraded = ["cam-offline"]
        merge_degraded(capture_degraded, self.states, enforce=True)
        self.assertEqual(capture_degraded, ["cam-offline"])

    def test_flag_default_e_desligada(self):
        self.assertFalse(enforcement_enabled({}))
        self.assertFalse(enforcement_enabled({"AI_INFERENCE_WATCHDOG_ENFORCE": ""}))
        self.assertFalse(enforcement_enabled({"AI_INFERENCE_WATCHDOG_ENFORCE": "false"}))
        self.assertTrue(enforcement_enabled({"AI_INFERENCE_WATCHDOG_ENFORCE": "true"}))
        self.assertTrue(enforcement_enabled({"AI_INFERENCE_WATCHDOG_ENFORCE": "  ON "}))


class TestFormaDoPayload(unittest.TestCase):
    def test_campos_expostos_no_health(self):
        state = health(runs=99, errors=2, last_duration_ms=51.5, avg_duration_ms=48.25)
        for key in (
            "applicable",
            "status",
            "degraded",
            "reason",
            "detector_type",
            "runs",
            "errors",
            "last_inference_at",
            "age_seconds",
            "last_duration_ms",
            "avg_duration_ms",
            "expected_interval_seconds",
            "stall_threshold_seconds",
            "last_error",
        ):
            self.assertIn(key, state)
        self.assertEqual(state["runs"], 99)
        self.assertEqual(state["errors"], 2)
        self.assertEqual(state["last_duration_ms"], 51.5)
        self.assertEqual(state["avg_duration_ms"], 48.25)
        self.assertEqual(state["detector_type"], "general")

    def test_payload_e_serializavel_em_json(self):
        import json

        json.dumps({key: health(**{key: value}) for key, value in (("runs", 0),)})
        json.dumps(health())
        json.dumps(health(advanced_analysis_type=None))


if __name__ == "__main__":
    unittest.main()
