"""Ponto de integração do detector de movimento no StreamProcessor.

Importar stream_processor puxa cv2 + requests → roda no container ML
(services/ai-service-python/run-ml-tests.sh, imagem drac-ai-test-ml).

CONTRATO DE PRODUÇÃO que estes testes travam: o detector passou a devolver
TODAS as caixas de movimento (para a confirmação semântica não perder a pessoa
atrás da árvore), mas o OVERLAY do /live continua mostrando UMA caixa — a
principal —, exatamente como hoje. Nenhum pixel a mais na tela do cliente.
"""

import unittest

try:
    import cv2  # noqa: F401
    from detectors.base import Detection
    from stream_processor import StreamProcessor

    HAS_STREAM = True
except Exception:
    HAS_STREAM = False


def motion(bbox, area=100):
    return Detection(
        label="motion",
        confidence=0.5,
        bbox=bbox,
        event_type="MOTION_DETECTED",
        extra={"componentPixels": area},
    )


@unittest.skipUnless(HAS_STREAM, "requer cv2 + requests (importa stream_processor) — container ML")
class TestOverlayUmaCaixaDeMovimento(unittest.TestCase):
    def _proc(self):
        return StreamProcessor("cam-1", "rtsp://cam.local:554/s1", "http://api:3000", "tok", "motion")

    def test_overlay_mantem_apenas_a_caixa_principal(self):
        proc = self._proc()
        principal = motion([10, 10, 50, 50], area=900)
        detections = [principal, motion([100, 10, 130, 40], area=400), motion([200, 10, 220, 30], area=100)]
        self.assertEqual(
            proc._overlay_detections(detections),
            [principal],
            "o overlay do /live continua com UMA caixa de movimento, como hoje",
        )

    def test_overlay_preserva_deteccoes_que_nao_sao_movimento(self):
        # Nos modos general/face o overlay mostra TODOS os objetos: o filtro só
        # vale para movimento, senão a IA de objeto perderia caixas na tela.
        proc = self._proc()
        pessoa = Detection(label="person", confidence=0.9, bbox=[1, 2, 3, 4], event_type="AI_DETECTED")
        carro = Detection(label="car", confidence=0.8, bbox=[5, 6, 7, 8], event_type="AI_DETECTED")
        principal = motion([10, 10, 50, 50])
        got = proc._overlay_detections([principal, motion([60, 60, 90, 90]), pessoa, carro])
        self.assertEqual(got, [principal, pessoa, carro])

    def test_lista_vazia_e_sem_movimento_passam_intactas(self):
        proc = self._proc()
        self.assertEqual(proc._overlay_detections([]), [])
        pessoa = Detection(label="person", confidence=0.9, bbox=[1, 2, 3, 4], event_type="AI_DETECTED")
        self.assertEqual(proc._overlay_detections([pessoa]), [pessoa])


@unittest.skipUnless(HAS_STREAM, "requer cv2 + requests (importa stream_processor) — container ML")
class TestConfirmacaoSemanticaVeTodasAsCaixas(unittest.TestCase):
    """A confirmação semântica recebe a lista INTEIRA — é o ponto do item (3).

    Na cena clássica (árvore balançando + pessoa entrando) a maior caixa é a
    árvore; só com todas as caixas o detector de objeto chega na pessoa.
    """

    def test_roda_o_detector_em_cada_caixa_e_promove_a_que_tem_objeto(self):
        proc = StreamProcessor("cam-1", "rtsp://cam.local:554/s1", "http://api:3000", "tok", "motion")
        proc.semantic_strict = True  # descarta o que não tem objeto (galho, sombra)
        proc._last_semantic_at = 0.0
        proc.semantic_min_interval = 0.0

        import numpy as np

        import stream_processor as sp

        crops = []

        class FakeObjectDetector:
            def infer(self, crop, context_key=None, **kwargs):
                crops.append(crop.shape)
                # Só o SEGUNDO recorte (a pessoa) tem objeto; o primeiro é a árvore.
                if len(crops) == 2:
                    return [Detection(label="person", confidence=0.9, bbox=[0, 0, 10, 20])]
                return []

        class FakeRegistry:
            def ensure_detector(self, kind):
                return FakeObjectDetector()

        original = sp.registry
        sp.registry = FakeRegistry()
        try:
            frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
            arvore = motion([100, 100, 400, 400], area=9000)
            pessoa = motion([800, 500, 900, 800], area=3000)
            got = proc._confirm_motion_semantically(frame, [arvore, pessoa], 100.0)
        finally:
            sp.registry = original

        self.assertEqual(len(crops), 2, "todas as caixas têm de ser oferecidas ao detector de objeto")
        self.assertEqual([d.label for d in got], ["person"], "a pessoa sobrevive mesmo não sendo a maior caixa")


if __name__ == "__main__":
    unittest.main()
