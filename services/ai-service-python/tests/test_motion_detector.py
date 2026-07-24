"""Testes do detector de movimento MOG2 (exige cv2 → rodam no container).

Local (sem cv2) a classe é PULADA; no container/CI com opencv, roda de verdade.
"""

import unittest

import numpy as np

try:
    import cv2  # noqa: F401
    from detectors.motion import MotionDetector
    HAS_CV2 = True
except Exception:
    HAS_CV2 = False


def gray_frame(v: int = 100) -> "np.ndarray":
    return np.full((180, 320, 3), v, dtype=np.uint8)


def frame_with_rect(bg: int = 100, val: int = 255, x: int = 140, y: int = 70, w: int = 44, h: int = 44):
    f = gray_frame(bg)
    f[y:y + h, x:x + w] = val
    return f


@unittest.skipUnless(HAS_CV2, "requer opencv (cv2) — roda no container do 0.3")
class TestMotionDetector(unittest.TestCase):
    def _warmup(self, det):
        for _ in range(det._warmup_total + 1):
            det.infer(gray_frame())

    def test_warmup_nao_reporta_nada(self):
        det = MotionDetector(); det.load()
        for _ in range(det._warmup_total):
            self.assertEqual(det.infer(gray_frame()), [], "durante o aprendizado do fundo não reporta movimento")

    def test_detecta_objeto_em_movimento(self):
        det = MotionDetector(); det.load()
        self._warmup(det)
        got = []
        for _ in range(6):
            got += det.infer(frame_with_rect())
        self.assertTrue(any(d.label == "motion" for d in got), "um objeto novo na cena deve gerar detecção 'motion'")

    def test_mudanca_global_NAO_e_movimento(self):
        det = MotionDetector(); det.load()
        self._warmup(det)
        # A tela inteira mudando (IR dia/noite, exposição, relâmpago) NÃO é movimento.
        # Feed MÚLTIPLO: atravessa a confirmação temporal, provando que é o caminho de
        # rejeição global que segura (e não só "1 hit < required").
        for _ in range(4):
            self.assertEqual(det.infer(gray_frame(255)), [], "mudança global deve ser rejeitada, não virar evento")

    def test_cena_estatica_sem_movimento(self):
        det = MotionDetector(); det.load()
        self._warmup(det)
        for _ in range(3):
            self.assertEqual(det.infer(gray_frame()), [], "cena parada não gera movimento")

    def test_zona_de_inclusao_ignora_movimento_FORA(self):
        # Zona de inclusão cobrindo só a METADE ESQUERDA (x em 0..0.5).
        zone = [{"kind": "include", "points": [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]}]
        det = MotionDetector(zones=zone); det.load()
        self._warmup(det)
        got = []
        for _ in range(6):
            got += det.infer(frame_with_rect(x=250, y=70, w=44, h=44))  # metade DIREITA = fora da zona
        self.assertEqual(got, [], "movimento fora da zona monitorada não pode gerar evento")

    def test_zona_de_inclusao_detecta_movimento_DENTRO(self):
        zone = [{"kind": "include", "points": [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]}]
        det = MotionDetector(zones=zone); det.load()
        self._warmup(det)
        got = []
        for _ in range(6):
            got += det.infer(frame_with_rect(x=40, y=70, w=44, h=44))  # metade ESQUERDA = dentro da zona
        self.assertTrue(any(d.label == "motion" for d in got), "movimento dentro da zona deve ser detectado")


if __name__ == "__main__":
    unittest.main()
