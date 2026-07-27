"""Contrato + registry de detectores por RUNTIME DE HARDWARE (item 2).

Estrutural, não comportamental: cada cliente tem hardware diferente (mini-PC
N100 com iGPU, servidor com RTX, site pequeno com Coral USB) e o serviço precisa
de UM contrato para plugar runtimes novos sem reescrever o pipeline. O que roda
HOJE tem de continuar rodando IGUAL.

O que estes testes travam:
  • o registry resolve os detectores ATUAIS (motion/MOG2, general/OpenVINO CPU,
    face/onnxruntime CPU) exatamente como o `build_detector` de hoje;
  • runtime desconhecido FALHA com mensagem clara (chave pedida, tipo e chaves
    registradas) — nunca cai calado num detector diferente do pedido;
  • runtime previsto mas sem plugin instalado (EdgeTPU/TensorRT/Hailo…) tem
    mensagem própria, distinguível de "digitou errado";
  • dependência de ML ausente vira erro que NOMEIA o pacote (o Frigate tolera
    ImportError de plugin justamente porque o runtime pode não existir na
    máquina) — e não um ImportError cru no meio do pipeline;
  • o runtime do MOVIMENTO é FIXO, sem override por env: o caminho de movimento
    arma a gravação e não pode ser reapontado por variável de ambiente;
  • `build_detector` preserva a mensagem de erro legada.

Framework: unittest da stdlib (decisão 9.2). Roda no HOST: o registry só resolve
strings — as classes pesadas (cv2/supervision/insightface) são importadas
apenas quando o detector é realmente criado.

Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
(frigate/detectors/: `DetectionApi` + `api_types` + `create_detector`).
"""

import json
import unittest

from detectors.runtime_registry import (
    DetectorRuntime,
    DetectorRuntimeRegistry,
    DetectorRuntimeUnavailableError,
    UnknownDetectorRuntimeError,
    UnknownDetectorTypeError,
    detector_runtimes,
)

try:
    import cv2  # noqa: F401

    HAS_CV2 = True
except Exception:
    HAS_CV2 = False


class TestDetectoresAtuaisRegistrados(unittest.TestCase):
    """O que roda hoje continua resolvendo para as MESMAS classes."""

    def test_motion_resolve_para_o_mog2_atual(self):
        runtime = detector_runtimes.resolve("motion")
        self.assertEqual(runtime.key, "opencv_mog2")
        self.assertEqual(runtime.class_path, "detectors.motion:MotionDetector")
        self.assertEqual(runtime.device, "cpu")

    def test_general_resolve_para_o_object_detector_openvino_cpu(self):
        runtime = detector_runtimes.resolve("general")
        self.assertEqual(runtime.key, "openvino_cpu")
        self.assertEqual(runtime.class_path, "detectors.object_detector:ObjectDetector")
        self.assertEqual(runtime.device, "cpu")

    def test_face_resolve_para_o_face_detector_onnx_cpu(self):
        runtime = detector_runtimes.resolve("face")
        self.assertEqual(runtime.key, "onnxruntime_cpu")
        self.assertEqual(runtime.class_path, "detectors.face_detector:FaceDetector")
        self.assertEqual(runtime.device, "cpu")

    def test_face_ja_tem_o_runtime_cuda_registrado(self):
        # FACE_RUNTIME=onnxruntime_cuda já é suportado hoje pelo FaceDetector.
        runtime = detector_runtimes.resolve("face", "onnxruntime_cuda")
        self.assertEqual(runtime.key, "onnxruntime_cuda")
        self.assertEqual(runtime.device, "gpu")
        self.assertEqual(runtime.class_path, "detectors.face_detector:FaceDetector")

    def test_tipos_registrados(self):
        self.assertEqual(sorted(detector_runtimes.detector_types()), ["face", "general", "motion"])

    def test_chave_e_normalizada(self):
        for spelling in ("OpenVINO_CPU", "  openvino-cpu ", "openvino_cpu"):
            with self.subTest(spelling=spelling):
                self.assertEqual(detector_runtimes.resolve("general", spelling).key, "openvino_cpu")

    def test_tipo_e_normalizado(self):
        self.assertEqual(detector_runtimes.resolve("  GENERAL ").key, "openvino_cpu")


class TestRuntimeDoMovimentoEFixo(unittest.TestCase):
    """O movimento arma a gravação: seu runtime não é configurável por env."""

    def test_default_do_motion_ignora_env(self):
        self.assertEqual(
            detector_runtimes.default_runtime_key("motion", {"MOTION_RUNTIME": "tensorrt", "GENERAL_RUNTIME": "tensorrt"}),
            "opencv_mog2",
        )

    def test_default_do_general_vem_do_perfil(self):
        self.assertEqual(detector_runtimes.default_runtime_key("general"), "openvino_cpu")

    def test_default_do_face_vem_do_perfil(self):
        self.assertEqual(detector_runtimes.default_runtime_key("face"), "onnxruntime_cpu")

    def test_defaults_do_registry_nao_divergem_do_runtime_profiles(self):
        # Duas fontes para a mesma decisão = bug esperando acontecer. O registry
        # tem de concordar com o perfil que o detector realmente usa.
        from runtime_profiles import FACE_PROFILE, GENERAL_PROFILE
        from detectors.runtime_registry import normalize_runtime_key

        self.assertEqual(
            detector_runtimes.default_runtime_key("general"),
            normalize_runtime_key(GENERAL_PROFILE["runtime"]),
        )
        self.assertEqual(
            detector_runtimes.default_runtime_key("face"),
            normalize_runtime_key(FACE_PROFILE["runtime"]),
        )


class TestErrosClaros(unittest.TestCase):
    def test_runtime_desconhecido_falha_com_mensagem_util(self):
        with self.assertRaises(UnknownDetectorRuntimeError) as ctx:
            detector_runtimes.resolve("general", "runtime_que_nao_existe")
        message = str(ctx.exception)
        self.assertIn("runtime_que_nao_existe", message)
        self.assertIn("general", message)
        self.assertIn("openvino_cpu", message, "a mensagem deve listar os runtimes registrados")

    def test_runtime_desconhecido_nao_cai_calado_no_default(self):
        # Falha ALTO: cair no default silenciosamente rodaria um detector
        # diferente do que o cliente configurou.
        with self.assertRaises(UnknownDetectorRuntimeError):
            detector_runtimes.resolve("general", "tpu_do_vizinho")

    def test_runtime_previsto_sem_plugin_tem_mensagem_propria(self):
        with self.assertRaises(DetectorRuntimeUnavailableError) as ctx:
            detector_runtimes.resolve("general", "tensorrt")
        message = str(ctx.exception)
        self.assertIn("tensorrt", message)
        # Distinguível de "chave inválida": diz que é previsto e ainda não instalado.
        self.assertNotIsInstance(ctx.exception, UnknownDetectorRuntimeError)

    def test_tipo_de_detector_desconhecido_falha_com_mensagem_util(self):
        with self.assertRaises(UnknownDetectorTypeError) as ctx:
            detector_runtimes.resolve("telepatia")
        message = str(ctx.exception)
        self.assertIn("telepatia", message)
        self.assertIn("motion", message)

    def test_runtime_do_tipo_errado_nao_e_aceito(self):
        # onnxruntime_cpu existe, mas é do 'face'; pedir para 'general' falha.
        with self.assertRaises(UnknownDetectorRuntimeError):
            detector_runtimes.resolve("general", "onnxruntime_cpu")


class TestRegistroDePluginNovo(unittest.TestCase):
    """O caminho para plugar runtime novo depois — sem tocar no pipeline."""

    def setUp(self):
        self.registry = DetectorRuntimeRegistry()
        self.created = []

    def _fake_runtime(self, **overrides):
        params = dict(
            key="fake_npu",
            detector_type="general",
            device="npu",
            class_path="tests.fake:FakeDetector",
            description="detector sintético de teste",
        )
        params.update(overrides)
        return DetectorRuntime(**params)

    def test_registrar_e_criar_usa_a_factory(self):
        sentinel = object()
        self.registry.register(
            self._fake_runtime(factory=lambda: sentinel),
            default_for_type=True,
        )
        self.assertIs(self.registry.create("general"), sentinel)

    def test_registry_novo_nasce_vazio(self):
        self.assertEqual(self.registry.detector_types(), [])
        with self.assertRaises(UnknownDetectorTypeError):
            self.registry.resolve("general")

    def test_alias_resolve_para_a_chave_canonica(self):
        self.registry.register(self._fake_runtime(factory=lambda: None), aliases=("npu", "fake"))
        self.assertEqual(self.registry.resolve("general", "npu").key, "fake_npu")
        self.assertEqual(self.registry.resolve("general", "FAKE").key, "fake_npu")

    def test_chave_duplicada_e_rejeitada(self):
        self.registry.register(self._fake_runtime(factory=lambda: None))
        with self.assertRaises(ValueError):
            self.registry.register(self._fake_runtime(factory=lambda: None))

    def test_runtimes_por_tipo(self):
        self.registry.register(self._fake_runtime(factory=lambda: None))
        self.registry.register(self._fake_runtime(key="fake_gpu", device="gpu", factory=lambda: None))
        self.assertEqual(self.registry.runtimes_for("general"), ["fake_npu", "fake_gpu"])
        self.assertEqual(self.registry.runtimes_for("face"), [])

    def test_dependencia_ausente_nomeia_o_pacote(self):
        self.registry.register(
            self._fake_runtime(class_path="modulo_que_nao_existe_no_mundo:X"),
            default_for_type=True,
        )
        with self.assertRaises(DetectorRuntimeUnavailableError) as ctx:
            self.registry.create("general")
        self.assertIn("modulo_que_nao_existe_no_mundo", str(ctx.exception))
        self.assertIn("fake_npu", str(ctx.exception))


class TestDescribeParaOHealth(unittest.TestCase):
    def test_describe_e_serializavel_e_lista_tudo(self):
        described = detector_runtimes.describe()
        json.dumps(described)
        self.assertIn("general", described["types"])
        general = described["types"]["general"]
        self.assertEqual(general["default"], "openvino_cpu")
        self.assertIn("openvino_cpu", general["available"])
        self.assertIn("tensorrt", described["planned"])


class TestCompatibilidadeBuildDetector(unittest.TestCase):
    def test_mensagem_de_erro_legada_preservada(self):
        from detectors import build_detector

        with self.assertRaises(ValueError) as ctx:
            build_detector("bogus")
        self.assertEqual(str(ctx.exception), "analysis_type invalido: bogus")

    def test_build_detector_delega_ao_registry(self):
        import detectors

        self.assertTrue(hasattr(detectors, "build_detector"))
        self.assertTrue(hasattr(detectors, "create_detector"))

    @unittest.skipUnless(HAS_CV2, "requer cv2 (MotionDetector) — container de teste")
    def test_build_detector_motion_continua_devolvendo_o_mog2(self):
        from detectors import build_detector
        from detectors.motion import MotionDetector

        for spelling in ("motion", "  MOTION ", "", None):
            with self.subTest(spelling=spelling):
                self.assertIsInstance(build_detector(spelling), MotionDetector)

    @unittest.skipUnless(HAS_CV2, "requer cv2 (MotionDetector) — container de teste")
    def test_create_detector_motion_equivale_ao_build_detector(self):
        from detectors import create_detector
        from detectors.motion import MotionDetector

        self.assertIsInstance(create_detector("motion"), MotionDetector)


if __name__ == "__main__":
    unittest.main()
