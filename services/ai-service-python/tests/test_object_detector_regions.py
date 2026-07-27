"""Inferência de objeto POR REGIÃO derivada do movimento (ObjectDetector).

Requer a stack ML (cv2 + supervision) → roda no container drac-ai-test-ml
(services/ai-service-python/run-ml-tests.sh).

O "modelo" aqui é FIEL ao fenômeno que este item resolve, não um stub que
devolve caixas combinadas: a inferência sintética olha o TENSOR DE ENTRADA de
verdade (o mesmo que o `_preprocess` monta), acha o alvo por limiar e só o
reporta se ele tiver ao menos `_MIN_INPUT_HEIGHT` px de altura NA ENTRADA DO
MODELO. É exatamente por isso que um alvo de 30 px num frame 1080p some quando o
frame inteiro é esmagado em 640×640 (30 × 640/1920 = 10 px) e aparece quando a
região de 320 px é recortada e ampliada (30 × 640/320 = 60 px).

Framework: unittest da stdlib (decisão 9.2).
"""

import unittest

import numpy as np

try:
    import cv2
    import supervision  # noqa: F401

    from detectors.object_detector import ObjectDetector, PERSON_CLASS_ID
    from detectors.region_proposal import RegionConfig

    HAS_ML = True
except Exception:
    HAS_ML = False


# Piso de resolução do "modelo": abaixo disto o objeto não é representável na
# entrada (stride/receptive field de um detector real).
_MIN_INPUT_HEIGHT = 20


class _SyntheticModel:
    """Detector sintético que enxerga o BLOB REAL passado pelo _preprocess."""

    def __init__(self):
        self.calls = 0
        self.blobs = []
        self._rows = np.zeros((1, 0, 6), dtype=np.float32)

    def infer(self, feed):
        self.calls += 1
        blob = list(feed.values())[0]
        self.blobs.append(blob)
        self._rows = self._detect(blob)
        return None

    def get_output_tensor(self, index):
        rows = self._rows

        class _Tensor:
            data = rows

        return _Tensor()

    @staticmethod
    def _detect(blob):
        # blob: (1, 3, S, S) float32 0..1 em RGB — alvo é branco (=1.0).
        image = np.asarray(blob)[0]
        mask = (image.max(axis=0) > 0.8).astype(np.uint8)
        found = []
        num_labels, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
        for label in range(1, num_labels):
            x = int(stats[label, cv2.CC_STAT_LEFT])
            y = int(stats[label, cv2.CC_STAT_TOP])
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h = int(stats[label, cv2.CC_STAT_HEIGHT])
            if h < _MIN_INPUT_HEIGHT:
                continue  # pequeno demais para o modelo resolver
            found.append([x, y, x + w, y + h, 0.9, float(PERSON_CLASS_ID)])
        if not found:
            return np.zeros((1, 0, 6), dtype=np.float32)
        return np.asarray(found, dtype=np.float32)[None, ...]


class _Pool:
    """Pool de 1 infer_request, como o Queue do runtime real (get_nowait/put)."""

    def __init__(self, request, empty=False):
        self._request = request
        self._empty = empty

    def get_nowait(self):
        from queue import Empty

        if self._empty:
            raise Empty()
        return self._request

    def put(self, request):
        return None


def _detector(region_config=None, empty_pool=False):
    det = ObjectDetector(region_config=region_config)
    det.model = object()  # pula load(): não há modelo real no container de teste
    model = _SyntheticModel()
    runtime = {
        "model": None,
        "input": "input",
        "output": "output",
        "pool": _Pool(model, empty=empty_pool),
        "path": "/fake/model.xml",
        "precision": "int8",
        "input_size": 640,
    }
    det._runtime_for_hint = lambda hint=None: runtime
    det.min_object_height = 8
    det.active_class_ids = {PERSON_CLASS_ID}
    det.class_confidence = {PERSON_CLASS_ID: 0.3}
    return det, model


def _frame_with(*rects, shape=(1080, 1920)):
    frame = np.zeros((shape[0], shape[1], 3), dtype=np.uint8)
    for x1, y1, x2, y2 in rects:
        frame[y1:y2, x1:x2] = 255
    return frame


ALVO_PEQUENO = (1500, 800, 1540, 830)   # 40×30 px — pessoa a ~40 m em 1080p
ALVO_GRANDE = (300, 400, 360, 560)      # 60×160 px — pessoa perto


@unittest.skipUnless(HAS_ML, "requer cv2 + supervision (stack ML) — container drac-ai-test-ml")
class TestFlagDesligada(unittest.TestCase):
    """Padrão DESLIGADO: o caminho continua sendo o frame inteiro, idêntico."""

    def test_padrao_e_desligado(self):
        det, _ = _detector()
        self.assertFalse(det.accepts_motion_regions)
        self.assertFalse(det.status()["region_detection"]["enabled"])

    def test_motion_boxes_sao_ignoradas_com_a_flag_desligada(self):
        det, model = _detector()
        frame = _frame_with(ALVO_GRANDE)

        sem_boxes = det.infer(frame, context_key=None, input_size_hint=640)
        chamadas_apos_primeira = model.calls
        com_boxes = det.infer(
            frame,
            context_key=None,
            input_size_hint=640,
            motion_boxes=[(1495, 795, 1545, 835)],
        )

        self.assertEqual(len(sem_boxes), 1)
        self.assertEqual([d.bbox for d in com_boxes], [d.bbox for d in sem_boxes])
        self.assertEqual(
            model.calls - chamadas_apos_primeira,
            1,
            "com a flag desligada é UMA inferência no frame inteiro, como hoje",
        )
        self.assertEqual(model.blobs[-1].shape, (1, 3, 640, 640))
        self.assertNotIn("region", com_boxes[0].extra)


@unittest.skipUnless(HAS_ML, "requer cv2 + supervision (stack ML)")
class TestAlvoPequeno(unittest.TestCase):
    """O item inteiro: enxergar (ou não) uma pessoa a 40 metros."""

    def test_alvo_pequeno_some_no_frame_inteiro(self):
        det, _ = _detector()
        frame = _frame_with(ALVO_PEQUENO)
        self.assertEqual(
            det.infer(frame, context_key=None, input_size_hint=640),
            [],
            "premissa do item: 30 px em 1080p viram ~10 px na entrada e somem",
        )

    def test_alvo_pequeno_aparece_na_regiao_e_volta_para_o_frame_inteiro(self):
        det, model = _detector(RegionConfig(enabled=True, sweep_every=0))
        frame = _frame_with(ALVO_PEQUENO)
        # Caixa de movimento do MOG2: só o que se moveu, com folga de poucos px.
        out = det.infer(
            frame,
            context_key=None,
            input_size_hint=640,
            motion_boxes=[(1498, 798, 1542, 832)],
        )

        self.assertEqual(len(out), 1, "o alvo tem de aparecer quando o modelo roda na região")
        x1, y1, x2, y2 = out[0].bbox
        ax1, ay1, ax2, ay2 = ALVO_PEQUENO
        for got, esperado, nome in ((x1, ax1, "x1"), (y1, ay1, "y1"), (x2, ax2, "x2"), (y2, ay2, "y2")):
            self.assertLessEqual(
                abs(got - esperado),
                8,
                f"coordenada {nome} não voltou para o frame inteiro: {out[0].bbox} vs {list(ALVO_PEQUENO)}",
            )
        region = out[0].extra.get("region")
        self.assertIsNotNone(region, "a detecção tem de dizer de que região veio")
        self.assertLessEqual(region[2] - region[0], 512)
        # O recorte foi realmente menor que o frame (é daí que vem a resolução).
        self.assertEqual(model.blobs[-1].shape, (1, 3, 640, 640))

    def test_duas_caixas_de_movimento_duas_regioes(self):
        det, model = _detector(RegionConfig(enabled=True, sweep_every=0))
        frame = _frame_with(ALVO_PEQUENO, (200, 900, 240, 930))
        antes = model.calls
        out = det.infer(
            frame,
            context_key=None,
            input_size_hint=640,
            motion_boxes=[(1498, 798, 1542, 832), (198, 898, 242, 932)],
        )
        self.assertEqual(model.calls - antes, 2, "uma inferência por região")
        self.assertEqual(len(out), 2, "os dois alvos pequenos têm de sobreviver")
        centros = sorted(int((d.bbox[0] + d.bbox[2]) / 2) for d in out)
        self.assertLessEqual(abs(centros[0] - 220), 10)
        self.assertLessEqual(abs(centros[1] - 1520), 10)

    def test_sem_movimento_roda_o_frame_inteiro(self):
        # Cena parada com a flag LIGADA: mantém o comportamento de hoje.
        det, model = _detector(RegionConfig(enabled=True, sweep_every=0))
        frame = _frame_with(ALVO_GRANDE)
        antes = model.calls
        out = det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=[])
        self.assertEqual(model.calls - antes, 1)
        self.assertEqual(model.blobs[-1].shape, (1, 3, 640, 640))
        self.assertEqual(len(out), 1)
        self.assertLessEqual(abs(out[0].bbox[0] - ALVO_GRANDE[0]), 10)


@unittest.skipUnless(HAS_ML, "requer cv2 + supervision (stack ML)")
class TestEstacionarios(unittest.TestCase):
    def _config(self, **kwargs):
        kwargs.setdefault("sweep_every", 0)
        kwargs.setdefault("stationary_threshold", 2)
        kwargs.setdefault("stationary_interval", 50)
        return RegionConfig(enabled=True, **kwargs)

    def test_parado_e_pulado_e_volta_a_ser_inferido_ao_se_mover(self):
        det, model = _detector(self._config())
        frame = _frame_with(ALVO_GRANDE)
        motion = [(295, 395, 365, 565)]

        for _ in range(3):
            out = det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=motion)
            self.assertEqual(len(out), 1)

        # Ninguém se mexeu: nenhuma inferência nova, mas o objeto NÃO some.
        antes = model.calls
        parado = det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=[])
        self.assertEqual(model.calls, antes, "objeto parado não pode gastar inferência a cada frame")
        self.assertEqual(len(parado), 1, "objeto parado não pode sumir do relatório")
        self.assertTrue(parado[0].extra.get("stationary"))
        self.assertLessEqual(abs(parado[0].bbox[0] - ALVO_GRANDE[0]), 10)

        # Voltou a se mexer: inferência nova, sem a marca de estacionário.
        antes = model.calls
        movendo = det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=motion)
        self.assertGreater(model.calls, antes, "movimento em cima do objeto TEM de re-inferir")
        self.assertEqual(len(movendo), 1)
        self.assertFalse(movendo[0].extra.get("stationary"))

    def test_objeto_que_sai_de_cena_para_de_ser_reportado(self):
        det, _ = _detector(self._config(stationary_interval=1))
        frame = _frame_with(ALVO_GRANDE)
        motion = [(295, 395, 365, 565)]
        for _ in range(3):
            det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=motion)

        vazio = _frame_with()
        # interval=1 força a re-checagem: a região roda e não acha mais nada.
        self.assertEqual(det.infer(vazio, context_key=None, input_size_hint=640, motion_boxes=[]), [])

    def test_pool_ocupado_nao_apaga_o_cache(self):
        det, _ = _detector(self._config(stationary_interval=1))
        frame = _frame_with(ALVO_GRANDE)
        motion = [(295, 395, 365, 565)]
        for _ in range(3):
            det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=motion)

        # Runtime sem infer_request disponível: a região é PLANEJADA mas não RODA.
        runtime = det._runtime_for_hint()
        runtime["pool"] = _Pool(None, empty=True)
        antes_drops = det._pool_busy_drops
        det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=[])
        self.assertGreater(det._pool_busy_drops, antes_drops)

        # Com o pool livre de novo o objeto continua conhecido (não foi apagado
        # por uma inferência que NUNCA aconteceu).
        runtime["pool"] = _Pool(_SyntheticModel())
        out = det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=[])
        self.assertEqual(len(out), 1)


@unittest.skipUnless(HAS_ML, "requer cv2 + supervision (stack ML)")
class TestVarreduraEStatus(unittest.TestCase):
    def test_varredura_periodica_roda_o_frame_inteiro_alem_das_regioes(self):
        det, model = _detector(RegionConfig(enabled=True, sweep_every=3))
        frame = _frame_with(ALVO_PEQUENO, ALVO_GRANDE)
        motion = [(1498, 798, 1542, 832)]

        antes = model.calls
        primeira = det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=motion)
        self.assertEqual(model.calls - antes, 2, "varredura = frame inteiro ALÉM da região")
        self.assertEqual(
            len(primeira),
            2,
            "o alvo grande (visto pela varredura) e o pequeno (visto pela região)",
        )
        self.assertEqual(det.region_status()["sweeps"], 1)

        # Nos frames seguintes a varredura NÃO se repete. O alvo grande ainda é
        # re-inferido por uma região própria enquanto não vira estacionário; assim
        # que vira, deixa de gastar inferência.
        for _ in range(6):
            det.infer(frame, context_key=None, input_size_hint=640, motion_boxes=motion)
        status = det.region_status()
        self.assertEqual(status["sweeps"], 3, "sweep_every=3 → varreduras nos frames 1, 4 e 7")
        self.assertGreaterEqual(
            status["stationary_skips"],
            1,
            "o alvo que ficou parado tem de parar de ser reinferido",
        )

    def test_status_expoe_a_configuracao_e_os_contadores(self):
        det, _ = _detector(RegionConfig(enabled=True, sweep_every=0))
        frame = _frame_with(ALVO_PEQUENO)
        det.infer(frame, context_key="cam-1", input_size_hint=640, motion_boxes=[(1498, 798, 1542, 832)])
        status = det.status()["region_detection"]
        self.assertTrue(status["enabled"])
        self.assertGreaterEqual(status["region_runs"], 1)
        self.assertGreaterEqual(status["region_crops"], 1)
        self.assertIn("min_size", status["config"])

    def test_cache_e_por_camera(self):
        det, _ = _detector(RegionConfig(enabled=True, sweep_every=0, stationary_threshold=1))
        frame = _frame_with(ALVO_GRANDE)
        motion = [(295, 395, 365, 565)]
        for _ in range(3):
            det.infer(frame, context_key="cam-a", input_size_hint=640, motion_boxes=motion)
        # A câmera B nunca viu nada: sem cache para carregar, cai no frame inteiro.
        out = det.infer(_frame_with(), context_key="cam-b", input_size_hint=640, motion_boxes=[])
        self.assertEqual(out, [])
        self.assertIn("cam-a", det._region_planners)
        self.assertIn("cam-b", det._region_planners)


if __name__ == "__main__":
    unittest.main()
