"""Testes do detector de movimento MOG2 (exige cv2 → rodam no container).

Local (sem cv2) a classe é PULADA; no container/CI com opencv, roda de verdade.

INVARIANTE DE PRODUÇÃO: em recordingMode:motion o evento MOTION_DETECTED é o
GATILHO da gravação. Engolir evento = NÃO GRAVAR. Por isso os cenários abaixo
rodam IDÊNTICOS nos dois caminhos (BGR de hoje e plano Y sob flag): divergência
entre eles é regressão de detecção, ou seja, câmera que deixa de gravar.
"""

import unittest
from unittest import mock

import numpy as np

try:
    import cv2  # noqa: F401
    from detectors.motion import MotionDetector
    from runtime_profiles import MOTION_PROFILE
    HAS_CV2 = True
except Exception:
    HAS_CV2 = False


def gray_frame(v: int = 100) -> "np.ndarray":
    return np.full((180, 320, 3), v, dtype=np.uint8)


def frame_with_rect(bg: int = 100, val: int = 255, x: int = 140, y: int = 70, w: int = 44, h: int = 44):
    f = gray_frame(bg)
    f[y:y + h, x:x + w] = val
    return f


def frame_with_rects(bg: int = 100, rects=()):
    """Vários objetos separados na mesma cena (árvore balançando + pessoa)."""
    f = gray_frame(bg)
    for (x, y, w, h, val) in rects:
        f[y:y + h, x:x + w] = val
    return f


# ── Cena REAL sintética (para a equivalência de sensibilidade) ───────────────
# Quadro chapado não serve para comparar BGR × plano Y: a diferença entre eles
# aparece justamente com objeto de BAIXO contraste sobre RUÍDO de sensor, que é
# o caso em que "o novo caminho detecta menos" = câmera deixa de gravar.
_SRC_W, _SRC_H = 640, 360
_NOISE_WARMUP = 12
_OBJECT_BOX = (250, 170, 50, 110)  # ~pessoa em pé


def _base_scene():
    rng = np.random.default_rng(3)
    yy, xx = np.mgrid[0:_SRC_H, 0:_SRC_W]
    lum = (60 + 90 * (yy / _SRC_H) + 25 * np.sin(xx / 18.0)).astype(np.float32)
    tex = cv2.resize(rng.normal(0, 12, (_SRC_H // 6, _SRC_W // 6)).astype(np.float32), (_SRC_W, _SRC_H))
    lum = np.clip(lum + tex, 5, 250)
    # Canais correlacionados, como câmera real: o ruído de luminância domina.
    return np.clip(np.stack([lum * 0.95, lum, lum * 1.05], axis=2), 0, 255).astype(np.uint8)


_SCENE_CACHE: dict = {}


def _noisy_scene(sigma: float, delta: int = 0):
    """Sequência determinística: cena parada com ruído (+ objeto opcional)."""
    key = (sigma, delta)
    if key not in _SCENE_CACHE:
        if "base" not in _SCENE_CACHE:
            _SCENE_CACHE["base"] = _base_scene()
        base = _SCENE_CACHE["base"].astype(np.float32)
        rng = np.random.default_rng(int(sigma * 100) + 7)
        frames = []
        for _ in range(8):
            f = base + rng.normal(0, sigma, (_SRC_H, _SRC_W, 1)) + rng.normal(0, sigma * 0.3, (_SRC_H, _SRC_W, 3))
            if delta:
                x, y, w, h = _OBJECT_BOX
                f[y:y + h, x:x + w] += delta
            frames.append(np.clip(f, 0, 255).astype(np.uint8))
        _SCENE_CACHE[key] = frames
    return _SCENE_CACHE[key]


class MotionScenarios:
    """Cenários que valem para QUALQUER caminho de pixel (BGR ou plano Y).

    Mixin (não é TestCase): as subclasses fixam o perfil e herdam os cenários,
    de modo que o caminho novo é obrigado a decidir o MESMO que o atual.
    """

    PROFILE: dict = {}

    def setUp(self):
        patcher = mock.patch.dict(MOTION_PROFILE, self.PROFILE)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _det(self, zones=None):
        det = MotionDetector(zones=zones)
        det.load()
        return det

    def _warmup(self, det):
        for _ in range(det._warmup_total + 1):
            det.infer(gray_frame())

    def test_warmup_nao_reporta_nada(self):
        det = self._det()
        for _ in range(det._warmup_total):
            self.assertEqual(det.infer(gray_frame()), [], "durante o aprendizado do fundo não reporta movimento")

    def test_detecta_objeto_em_movimento(self):
        det = self._det()
        self._warmup(det)
        got = []
        for _ in range(6):
            got += det.infer(frame_with_rect())
        self.assertTrue(any(d.label == "motion" for d in got), "um objeto novo na cena deve gerar detecção 'motion'")

    def test_cena_estatica_sem_movimento(self):
        det = self._det()
        self._warmup(det)
        for _ in range(3):
            self.assertEqual(det.infer(gray_frame()), [], "cena parada não gera movimento")

    def test_zona_de_inclusao_ignora_movimento_FORA(self):
        # Zona de inclusão cobrindo só a METADE ESQUERDA (x em 0..0.5).
        zone = [{"kind": "include", "points": [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]}]
        det = self._det(zones=zone)
        self._warmup(det)
        got = []
        for _ in range(6):
            got += det.infer(frame_with_rect(x=250, y=70, w=44, h=44))  # metade DIREITA = fora da zona
        self.assertEqual(got, [], "movimento fora da zona monitorada não pode gerar evento")

    def test_zona_de_inclusao_detecta_movimento_DENTRO(self):
        zone = [{"kind": "include", "points": [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]}]
        det = self._det(zones=zone)
        self._warmup(det)
        got = []
        for _ in range(6):
            got += det.infer(frame_with_rect(x=40, y=70, w=44, h=44))  # metade ESQUERDA = dentro da zona
        self.assertTrue(any(d.label == "motion" for d in got), "movimento dentro da zona deve ser detectado")

    # ── (1) mudança global de cena AINDA reporta ─────────────────────────────
    def test_mudanca_global_AINDA_reporta_com_marcador(self):
        """Luz acendendo / IR ligando / sol saindo da nuvem = a cena inteira muda.

        Antes o evento era ENGOLIDO — ou seja, a câmera NÃO gravava exatamente no
        instante em que alguém acendeu a luz. Agora recalibra E reporta, marcado
        com sceneChange para quem quiser suprimir na camada de cima.
        """
        det = self._det()
        self._warmup(det)
        got = det.infer(gray_frame(255))
        self.assertTrue(got, "mudança global de cena NÃO pode ser engolida: é o gatilho da gravação")
        self.assertEqual(got[0].event_type, "MOTION_DETECTED")
        self.assertIs(got[0].extra.get("sceneChange"), True, "o evento tem de vir marcado como mudança de cena")
        self.assertEqual(len(got[0].bbox), 4)

    def test_mudanca_global_recalibra_o_fundo(self):
        """Recalibrar de verdade: depois da mudança, o NOVO nível vira fundo."""
        det = self._det()
        self._warmup(det)
        det.infer(gray_frame(255))  # mudança global
        for _ in range(det._rewarmup_total + 4):
            det.infer(gray_frame(255))  # reaprende a cena clara
        for _ in range(3):
            self.assertEqual(det.infer(gray_frame(255)), [], "cena clara já é o novo fundo: nada a reportar")
        got = []
        for _ in range(6):  # objeto ESCURO sobre o novo fundo claro
            got += det.infer(frame_with_rect(bg=255, val=0))
        self.assertTrue(any(d.label == "motion" for d in got), "após recalibrar, objetos no novo fundo são detectados")

    # ── (3) todas as caixas de movimento ─────────────────────────────────────
    def test_devolve_todas_as_caixas_maior_primeiro(self):
        """Árvore balançando + pessoa entrando: a MAIOR caixa é a árvore.

        Devolver só ela cega a confirmação semântica (o recorte perde a pessoa).
        """
        det = self._det()
        self._warmup(det)
        rects = ((16, 40, 48, 48, 255), (150, 60, 30, 30, 255), (262, 110, 24, 24, 255))
        got = []
        for _ in range(6):
            got = det.infer(frame_with_rects(rects=rects)) or got
        self.assertGreaterEqual(len(got), 3, "cada objeto coeso da cena deve virar uma caixa")
        areas = [d.extra["componentPixels"] for d in got]
        self.assertEqual(areas, sorted(areas, reverse=True), "maior primeiro (compatibilidade de quem lê [0])")
        self.assertEqual(got[0].extra.get("motionBoxIndex"), 0)

    def test_teto_de_caixas_nao_explode(self):
        det = self._det()
        self.assertEqual(det._max_boxes, 4)
        self._warmup(det)
        # SEIS objetos separados na cena (nenhum encosta no outro): o teto tem de
        # cortar a lista em 4, senão uma cena agitada explode a lista.
        rects = tuple((16 + i * 44, 40 + (i % 2) * 70, 26, 26, 255) for i in range(6))
        got = []
        for _ in range(6):
            got = det.infer(frame_with_rects(rects=rects)) or got
        self.assertEqual(len(got), 4, "o teto existe para a lista não explodir")


@unittest.skipUnless(HAS_CV2, "requer opencv (cv2) — roda no container do 0.3")
class TestMotionDetectorBGR(MotionScenarios, unittest.TestCase):
    """Caminho de HOJE (BGR, padrão em produção)."""

    PROFILE = {"motion_luma_plane": False, "motion_max_boxes": 4}


@unittest.skipUnless(HAS_CV2, "requer opencv (cv2) — roda no container do 0.3")
class TestMotionDetectorPlanoY(MotionScenarios, unittest.TestCase):
    """Caminho novo (plano de luminância), atrás da flag MOTION_LUMA_PLANE."""

    PROFILE = {"motion_luma_plane": True, "motion_max_boxes": 4}


@unittest.skipUnless(HAS_CV2, "requer opencv (cv2) — roda no container do 0.3")
class TestEquivalenciaPlanoY(unittest.TestCase):
    """(2) EQUIVALÊNCIA: o plano Y decide o MESMO que o BGR, frame a frame.

    Não basta cada caminho passar nos cenários isolados: alimentamos os DOIS
    detectores com a MESMA sequência e comparamos a decisão de cada frame. Se
    divergir, é regressão de detecção — câmera que deixa de gravar.
    """

    def _sequence(self):
        seq = [gray_frame(100)] * 31            # warm-up
        seq += [frame_with_rect()] * 6          # objeto entrando
        seq += [gray_frame(100)] * 3            # cena estática de novo
        seq += [gray_frame(255)] * 2            # mudança global (recalibra e reporta)
        seq += [gray_frame(255)] * 14           # re-warm-up na cena nova
        seq += [frame_with_rect(bg=255, val=0)] * 6  # objeto no fundo novo
        return seq

    def _run(self, luma, zones=None):
        with mock.patch.dict(MOTION_PROFILE, {"motion_luma_plane": luma, "motion_max_boxes": 4}):
            det = MotionDetector(zones=zones)
            det.load()
            return [det.infer(f) for f in self._sequence()]

    def _decisions(self, runs):
        return [len(r) for r in runs]

    def test_mesma_decisao_frame_a_frame(self):
        atual = self._run(False)
        novo = self._run(True)
        self.assertEqual(
            self._decisions(novo),
            self._decisions(atual),
            "o plano Y tem de disparar nos MESMOS frames que o BGR",
        )

    def test_mesmas_caixas_e_marcadores(self):
        atual = self._run(False)
        novo = self._run(True)
        for idx, (a, b) in enumerate(zip(atual, novo)):
            self.assertEqual(
                [d.bbox for d in a], [d.bbox for d in b], f"caixas divergiram no frame {idx}"
            )
            self.assertEqual(
                [d.extra.get("sceneChange") for d in a],
                [d.extra.get("sceneChange") for d in b],
                f"marcador sceneChange divergiu no frame {idx}",
            )

    def test_equivalencia_com_zona_de_inclusao(self):
        zone = [{"kind": "include", "points": [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]}]
        self.assertEqual(
            self._decisions(self._run(True, zones=zone)),
            self._decisions(self._run(False, zones=zone)),
            "com zona de inclusão a equivalência também tem de valer",
        )


@unittest.skipUnless(HAS_CV2, "requer opencv (cv2) — roda no container do 0.3")
class TestPlanoYRealmenteTrocaDePlano(unittest.TestCase):
    """O preço declarado do plano Y: objeto que só se distingue por MATIZ.

    Um alvo com a MESMA luminância do fundo (BGR 255,70,100 → cinza 100, igual ao
    fundo cinza 100) existe para o caminho BGR e desaparece no plano Y. É o
    trade-off assumido — e é também a prova de que a flag realmente troca o plano
    de pixels em vez de só existir no perfil.
    """

    def _rodada(self, luma):
        with mock.patch.dict(MOTION_PROFILE, {"motion_luma_plane": luma}):
            det = MotionDetector()
            det.load()
            for _ in range(det._warmup_total + 1):
                det.infer(gray_frame(100))
            alvo = gray_frame(100)
            alvo[70:114, 140:184] = (255, 70, 100)  # mesma luminância, outro matiz
            got = []
            for _ in range(6):
                got += det.infer(alvo)
            return got

    def test_premissa_o_alvo_tem_a_mesma_luminancia_do_fundo(self):
        alvo = gray_frame(100)
        alvo[70:114, 140:184] = (255, 70, 100)
        cinza = cv2.cvtColor(alvo, cv2.COLOR_BGR2GRAY)
        self.assertEqual(int(cinza.min()), 100)
        self.assertEqual(int(cinza.max()), 100, "no plano Y o alvo é indistinguível do fundo")

    def test_bgr_ve_o_matiz_e_o_plano_y_nao(self):
        self.assertTrue(self._rodada(luma=False), "o caminho de hoje enxerga diferença de cor pura")
        self.assertEqual(self._rodada(luma=True), [], "no plano Y o matiz puro some — custo assumido da flag")


@unittest.skipUnless(HAS_CV2, "requer opencv (cv2) — roda no container do 0.3")
class TestEquivalenciaSensibilidadePlanoY(unittest.TestCase):
    """(2) EQUIVALÊNCIA onde ela é DIFÍCIL: objeto de baixo contraste sobre ruído.

    Em quadro chapado qualquer limiar acerta. O risco real do plano Y é ele ficar
    MENOS sensível que o BGR — e detecção perdida é câmera que não grava. O
    varThreshold do MOG2 compara a soma dos desvios de TODOS os canais: com 1
    canal a distância cai, e manter 40 (o valor do caminho BGR) faz o plano Y
    perder objeto real. É este teste que prende a constante _VAR_THRESHOLD_LUMA.

    Assimetria proposital: exigimos que o plano Y NUNCA perca o que o BGR pega
    (regra dura, vale em todo nível de ruído) e que a escada de sensibilidade
    seja a mesma no ruído típico. Onde ele é um passo MAIS sensível, tudo bem —
    falso positivo é recuperável, gravação perdida não.
    """

    SIGMAS = (2.0, 5.0, 8.0)          # ruído de sensor: bom, medíocre, noturno
    SIGMAS_ESCADA_EXATA = (2.0, 8.0)
    DELTAS = (5, 8, 12, 16, 20, 30)   # contraste do objeto contra o fundo

    def _fired(self, luma, sigma, delta):
        with mock.patch.dict(MOTION_PROFILE, {"motion_luma_plane": luma, "motion_warmup_frames": _NOISE_WARMUP}):
            det = MotionDetector()
            det.load()
            fundo = _noisy_scene(sigma)
            for i in range(_NOISE_WARMUP + 1):
                det.infer(fundo[i % len(fundo)])
            objeto = _noisy_scene(sigma, delta)
            got = []
            for i in range(4):
                got = det.infer(objeto[i % len(objeto)]) or got
            return bool(got)

    _ESCADAS: dict = {}  # (caminho, ruído) → escada; determinístico, calcula uma vez

    def _escada(self, luma, sigma):
        key = (bool(luma), sigma)
        if key not in self._ESCADAS:
            self._ESCADAS[key] = tuple(self._fired(luma, sigma, delta) for delta in self.DELTAS)
        return self._ESCADAS[key]

    def test_plano_y_nunca_perde_o_que_o_bgr_pega(self):
        for sigma in self.SIGMAS:
            atual = self._escada(False, sigma)
            novo = self._escada(True, sigma)
            for delta, a, b in zip(self.DELTAS, atual, novo):
                if a:
                    self.assertTrue(
                        b,
                        f"ruído sigma={sigma}, contraste delta={delta}: o BGR detecta e o plano Y NÃO — "
                        "isso é câmera que deixa de gravar",
                    )

    def test_mesma_escada_de_sensibilidade_no_ruido_tipico(self):
        for sigma in self.SIGMAS_ESCADA_EXATA:
            self.assertEqual(
                self._escada(True, sigma),
                self._escada(False, sigma),
                f"com ruído sigma={sigma} os dois caminhos têm de disparar nos mesmos contrastes",
            )


@unittest.skipUnless(HAS_CV2, "requer opencv (cv2) — roda no container do 0.3")
class TestFlagsDesligadas(unittest.TestCase):
    """Flag desligada = comportamento IDÊNTICO ao de hoje (kill-switch)."""

    def _run(self, frames, **profile):
        """Constrói e roda o detector INTEIRO com o perfil aplicado."""
        with mock.patch.dict(MOTION_PROFILE, profile):
            det = MotionDetector()
            det.load()
            for _ in range(det._warmup_total + 1):
                det.infer(gray_frame())
            return [det.infer(f) for f in frames]

    def test_kill_switch_volta_a_engolir_a_mudanca_global(self):
        # Feed MÚLTIPLO: atravessa a confirmação temporal, provando que é o caminho
        # de rejeição global que segura (e não só "1 hit < required").
        for got in self._run([gray_frame(255)] * 4, motion_scene_change_report=False):
            self.assertEqual(got, [], "com o kill-switch, mudança global volta a ser engolida")

    def test_teto_um_devolve_exatamente_a_maior_caixa_como_hoje(self):
        rects = ((16, 40, 48, 48, 255), (150, 60, 30, 30, 255), (262, 110, 24, 24, 255))
        frames = [frame_with_rects(rects=rects)] * 6

        def ultimo(resultados):
            saida = []
            for got in resultados:
                saida = got or saida
            return saida

        got_multi = ultimo(self._run(frames, motion_max_boxes=4))
        got_unico = ultimo(self._run(frames, motion_max_boxes=1))
        self.assertEqual(len(got_multi), 3, "a cena tem três objetos separados")

        self.assertEqual(len(got_unico), 1, "teto 1 = uma caixa só, como era antes")
        self.assertEqual(got_unico[0].bbox, got_multi[0].bbox)
        self.assertEqual(got_unico[0].label, got_multi[0].label)
        self.assertEqual(got_unico[0].confidence, got_multi[0].confidence)
        self.assertEqual(got_unico[0].extra["componentPixels"], got_multi[0].extra["componentPixels"])
        self.assertEqual(got_unico[0].extra["motionPixels"], got_multi[0].extra["motionPixels"])


class TestFlagsDeAmbiente(unittest.TestCase):
    """As três chaves são configuráveis por env, com o default certo."""

    def _profile(self, env):
        import importlib
        import os

        import runtime_profiles

        with mock.patch.dict(os.environ, env, clear=False):
            return importlib.reload(runtime_profiles).MOTION_PROFILE.copy()

    def tearDown(self):
        import importlib

        import runtime_profiles

        importlib.reload(runtime_profiles)  # devolve o módulo ao estado do ambiente real

    def test_defaults(self):
        profile = self._profile({})
        self.assertIs(profile["motion_scene_change_report"], True, "reportar mudança global é o padrão (defeito corrigido)")
        self.assertIs(profile["motion_luma_plane"], False, "plano Y é opt-in: o padrão continua sendo o BGR de hoje")
        self.assertEqual(profile["motion_max_boxes"], 4)

    def test_env_liga_plano_y_e_desliga_scene_change(self):
        profile = self._profile({
            "MOTION_LUMA_PLANE": "true",
            "MOTION_SCENE_CHANGE_REPORT": "false",
            "MOTION_MAX_BOXES": "2",
        })
        self.assertIs(profile["motion_luma_plane"], True)
        self.assertIs(profile["motion_scene_change_report"], False)
        self.assertEqual(profile["motion_max_boxes"], 2)


if __name__ == "__main__":
    unittest.main()
