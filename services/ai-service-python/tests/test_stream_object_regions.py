"""Ligação do StreamProcessor com a inferência de objeto POR REGIÃO.

Importar stream_processor puxa cv2 + requests → roda no container ML
(services/ai-service-python/run-ml-tests.sh, imagem drac-ai-test-ml).

CONTRATO: a IA de OBJETO está DESLIGADA em produção e continua desligada. Com a
flag de região desligada (padrão), a chamada de inferência é EXATAMENTE a de
hoje — nem sequer o argumento novo aparece. Com ela ligada, as caixas de
movimento vão para o detector já nas coordenadas do frame que ele analisa.

Framework: unittest da stdlib (decisão 9.2).
"""

import unittest

try:
    import cv2  # noqa: F401

    from detectors.base import Detection
    from stream_processor import StreamProcessor

    HAS_STREAM = True
except Exception:
    HAS_STREAM = False


def motion(bbox):
    return Detection(label="motion", confidence=0.5, bbox=list(bbox), event_type="MOTION_DETECTED")


def objeto(bbox):
    return Detection(label="pessoa", confidence=0.9, bbox=list(bbox), event_type="OBJECT_DETECTED")


class _DetectorSemRegiao:
    accepts_motion_regions = False


class _DetectorComRegiao:
    accepts_motion_regions = True


@unittest.skipUnless(HAS_STREAM, "requer cv2 + requests (importa stream_processor) — container ML")
class TestCaixasDeMovimentoParaAIA(unittest.TestCase):
    def _proc(self):
        return StreamProcessor("cam-1", "rtsp://cam.local:554/s1", "http://api:3000", "tok", "general")

    def test_escala_para_o_frame_analisado_pela_ia(self):
        # O movimento roda no frame ORIGINAL (1080p) e a IA de objeto num frame
        # reduzido: sem reescalar, a região sairia no lugar errado da imagem.
        proc = self._proc()
        boxes = proc._motion_boxes_for_advanced(
            [motion([1500, 800, 1540, 830])],
            (1080, 1920),
            (540, 960),
        )
        self.assertEqual(boxes, [(750, 400, 770, 415)])

    def test_sem_redimensionamento_as_caixas_passam_iguais(self):
        proc = self._proc()
        boxes = proc._motion_boxes_for_advanced([motion([10, 20, 30, 40])], (1080, 1920), (1080, 1920))
        self.assertEqual(boxes, [(10, 20, 30, 40)])

    def test_so_caixas_de_movimento_viram_regiao(self):
        proc = self._proc()
        boxes = proc._motion_boxes_for_advanced(
            [motion([100, 100, 200, 200]), objeto([300, 300, 400, 400])],
            (1080, 1920),
            (1080, 1920),
        )
        self.assertEqual(boxes, [(100, 100, 200, 200)], "detecção de objeto não é fonte de região")

    def test_sem_movimento_devolve_lista_vazia(self):
        # Lista vazia → o planejador cai no frame inteiro (comportamento de hoje).
        proc = self._proc()
        self.assertEqual(proc._motion_boxes_for_advanced([], (1080, 1920), (540, 960)), [])

    def test_caixa_malformada_e_ignorada(self):
        proc = self._proc()
        ruim = Detection(label="motion", confidence=0.5, bbox=[1, 2], event_type="MOTION_DETECTED")
        boxes = proc._motion_boxes_for_advanced([ruim, motion([10, 20, 30, 40])], (1080, 1920), (1080, 1920))
        self.assertEqual(boxes, [(10, 20, 30, 40)])

    def test_frame_degenerado_nao_explode(self):
        proc = self._proc()
        self.assertEqual(proc._motion_boxes_for_advanced([motion([1, 2, 3, 4])], (0, 0), (540, 960)), [])


@unittest.skipUnless(HAS_STREAM, "requer cv2 + requests (importa stream_processor) — container ML")
class TestArgumentosDaInferenciaAvancada(unittest.TestCase):
    def _proc(self):
        return StreamProcessor("cam-1", "rtsp://cam.local:554/s1", "http://api:3000", "tok", "general")

    def test_flag_desligada_nao_acrescenta_argumento_nenhum(self):
        proc = self._proc()
        kwargs = proc._advanced_infer_kwargs(
            _DetectorSemRegiao(),
            [motion([100, 100, 200, 200])],
            (1080, 1920),
            (540, 960),
        )
        self.assertEqual(kwargs, {}, "com a flag desligada a chamada é a de hoje, sem argumento novo")

    def test_flag_ligada_manda_as_caixas_ja_escaladas(self):
        proc = self._proc()
        kwargs = proc._advanced_infer_kwargs(
            _DetectorComRegiao(),
            [motion([1500, 800, 1540, 830])],
            (1080, 1920),
            (540, 960),
        )
        self.assertEqual(kwargs, {"motion_boxes": [(750, 400, 770, 415)]})

    def test_detector_antigo_sem_o_atributo_nao_quebra(self):
        proc = self._proc()
        self.assertEqual(proc._advanced_infer_kwargs(object(), [motion([1, 2, 3, 4])], (1080, 1920), (540, 960)), {})

    def test_o_process_usa_os_argumentos_montados(self):
        # Trava o fio: se o _process parar de chamar _advanced_infer_kwargs, a
        # ligação some sem nenhum teste quebrar.
        import inspect

        fonte = inspect.getsource(StreamProcessor._process)
        self.assertIn("_advanced_infer_kwargs", fonte)


if __name__ == "__main__":
    unittest.main()
