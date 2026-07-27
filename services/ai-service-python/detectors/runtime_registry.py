"""Contrato + registry de detectores por RUNTIME DE HARDWARE.

Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
(frigate/detectors/: `DetectionApi` como contrato único, `api_types` como
registry chaveado por `type_key` e `create_detector()` resolvendo o plugin;
a descoberta tolera ImportError porque o runtime pode não existir na máquina.)

POR QUE ISTO EXISTE
    Cada cliente tem hardware diferente: mini-PC N100 com iGPU, servidor com
    RTX, site pequeno com Coral USB. O Frigate suporta EdgeTPU/OpenVINO/
    TensorRT/ONNX/Hailo pelo MESMO contrato; aqui fica o mesmo ponto de
    extensão, para que plugar um runtime novo seja registrar uma entrada — não
    reescrever o pipeline.

O QUE ISTO **NÃO** É
    Não liga nada. É REFATORAÇÃO ESTRUTURAL: o que roda hoje (MOG2 no
    movimento, OpenVINO CPU no objeto, onnxruntime CPU no rosto) continua
    resolvendo para as MESMAS classes, com os MESMOS defaults, sem dependência
    nova. Nenhum runtime novo é registrado — os previstos ficam declarados em
    PLANNED_RUNTIMES só para dar mensagem de erro decente a quem configurar um
    deles antes de o plugin existir.

INVARIANTE DURA
    O runtime do MOVIMENTO é FIXO (`opencv_mog2`) e NÃO tem override por env: o
    movimento é o gatilho de gravação em recordingMode:motion, e uma variável de
    ambiente errada não pode reapontar esse detector.

As classes são referenciadas por STRING (`"modulo:Classe"`) e importadas apenas
na criação: importar este módulo não puxa cv2/supervision/insightface.
"""

import importlib
import os
from dataclasses import dataclass, field
from typing import Callable, Optional


class UnknownDetectorTypeError(ValueError):
    """Tipo de detector inexistente (não é motion/face/general)."""


class UnknownDetectorRuntimeError(ValueError):
    """Chave de runtime que ninguém registrou para este tipo."""


class DetectorRuntimeUnavailableError(RuntimeError):
    """Runtime conhecido, mas sem plugin/dependência instalada nesta imagem."""


# Runtimes que o mercado pede e que ainda NÃO têm plugin aqui. Existem só para
# que configurar um deles produza uma mensagem honesta ("previsto, não
# instalado") em vez de "chave inválida" — e para documentar o caminho.
PLANNED_RUNTIMES = {
    "edgetpu": "Coral EdgeTPU (USB/PCIe) — requer pycoral/libedgetpu no build.",
    "tensorrt": "NVIDIA TensorRT — requer engine .trt e o runtime NVIDIA no build.",
    "onnxruntime_cuda_general": "ONNX Runtime CUDA para objetos — requer onnxruntime-gpu (ver Dockerfile.gpu).",
    "hailo8l": "Hailo-8L — requer HailoRT no build.",
    "rknn": "Rockchip NPU — requer rknn-toolkit no build.",
    "openvino_gpu": "OpenVINO em iGPU — hoje o dispositivo vem de GENERAL_OPENVINO_DEVICE, sem plugin próprio.",
    "openvino_npu": "OpenVINO em NPU — hoje o dispositivo vem de GENERAL_OPENVINO_DEVICE, sem plugin próprio.",
}


def normalize_runtime_key(value) -> str:
    return str(value or "").strip().lower().replace("-", "_")


def normalize_detector_type(value) -> str:
    return str(value or "").strip().lower()


@dataclass(frozen=True)
class DetectorRuntime:
    """Uma implementação de detector para um par (tipo, hardware).

    key            chave canônica do runtime, ex.: 'openvino_cpu'
    detector_type  'motion' | 'face' | 'general'
    device         'cpu' | 'gpu' | 'npu' | 'tpu' (informativo, aparece no /health)
    class_path     'modulo:Classe' — importado SÓ na criação (lazy)
    requires       pacotes python que o runtime precisa (documental/diagnóstico)
    factory        atalho para plugins externos/testes; ganha do class_path
    """

    key: str
    detector_type: str
    device: str
    class_path: str
    description: str = ""
    requires: tuple = ()
    factory: Optional[Callable[[], object]] = None

    def load_class(self):
        module_name, _, class_name = str(self.class_path).partition(":")
        if not module_name or not class_name:
            raise DetectorRuntimeUnavailableError(
                f"Runtime '{self.key}' tem class_path inválido: '{self.class_path}' (esperado 'modulo:Classe')."
            )
        try:
            module = importlib.import_module(module_name)
        except ImportError as exc:
            # O Frigate tolera ImportError de plugin porque o runtime pode
            # simplesmente não existir naquela máquina. Aqui traduzimos para uma
            # mensagem que diz QUAL runtime e QUAL dependência faltou.
            missing = ", ".join(self.requires) if self.requires else module_name
            raise DetectorRuntimeUnavailableError(
                f"Runtime '{self.key}' ({self.detector_type}) indisponível: falha ao importar "
                f"'{module_name}' — dependência ausente ({missing}). Detalhe: {exc}"
            ) from exc
        klass = getattr(module, class_name, None)
        if klass is None:
            raise DetectorRuntimeUnavailableError(
                f"Runtime '{self.key}' ({self.detector_type}) indisponível: '{module_name}' não expõe '{class_name}'."
            )
        return klass

    def create(self):
        if self.factory is not None:
            return self.factory()
        return self.load_class()()

    def describe(self) -> dict:
        return {
            "key": self.key,
            "detector_type": self.detector_type,
            "device": self.device,
            "class_path": self.class_path,
            "description": self.description,
            "requires": list(self.requires),
        }


@dataclass(frozen=True)
class _DefaultSpec:
    key: str
    env_var: Optional[str] = None


@dataclass
class _TypeEntry:
    runtimes: dict = field(default_factory=dict)
    aliases: dict = field(default_factory=dict)
    default: Optional[_DefaultSpec] = None
    order: list = field(default_factory=list)


class DetectorRuntimeRegistry:
    """Registry de runtimes por tipo de detector."""

    def __init__(self, planned: Optional[dict] = None):
        self._types: dict = {}
        self._planned = dict(PLANNED_RUNTIMES if planned is None else planned)

    # ── registro ─────────────────────────────────────────────────────────────

    def register(
        self,
        runtime: DetectorRuntime,
        aliases: tuple = (),
        default_for_type: bool = False,
        default_env_var: Optional[str] = None,
    ) -> DetectorRuntime:
        detector_type = normalize_detector_type(runtime.detector_type)
        key = normalize_runtime_key(runtime.key)
        entry = self._types.setdefault(detector_type, _TypeEntry())
        if key in entry.runtimes:
            raise ValueError(f"Runtime '{key}' já registrado para o tipo '{detector_type}'.")
        entry.runtimes[key] = runtime
        entry.order.append(key)
        for alias in aliases:
            entry.aliases[normalize_runtime_key(alias)] = key
        if default_for_type or entry.default is None:
            entry.default = _DefaultSpec(key=key, env_var=default_env_var)
        return runtime

    # ── consulta ─────────────────────────────────────────────────────────────

    def detector_types(self) -> list:
        return list(self._types.keys())

    def runtimes_for(self, detector_type) -> list:
        entry = self._types.get(normalize_detector_type(detector_type))
        return list(entry.order) if entry else []

    def _require_type(self, detector_type) -> str:
        resolved = normalize_detector_type(detector_type)
        if resolved not in self._types:
            known = ", ".join(sorted(self._types)) or "(nenhum)"
            raise UnknownDetectorTypeError(
                f"tipo de detector desconhecido: '{detector_type}'. Tipos registrados: {known}."
            )
        return resolved

    def default_runtime_key(self, detector_type, env=None) -> str:
        resolved = self._require_type(detector_type)
        spec = self._types[resolved].default
        # env_var None = runtime FIXO (movimento): nenhuma variável de ambiente
        # pode reapontar o detector que arma a gravação.
        if spec.env_var:
            source = os.environ if env is None else env
            raw = normalize_runtime_key(source.get(spec.env_var, ""))
            if raw:
                return raw
        return spec.key

    def resolve(self, detector_type, runtime_key=None) -> DetectorRuntime:
        resolved_type = self._require_type(detector_type)
        entry = self._types[resolved_type]
        requested = normalize_runtime_key(runtime_key) if runtime_key else self.default_runtime_key(resolved_type)
        canonical = entry.aliases.get(requested, requested)
        runtime = entry.runtimes.get(canonical)
        if runtime is not None:
            return runtime
        if canonical in self._planned:
            raise DetectorRuntimeUnavailableError(
                f"Runtime '{canonical}' é PREVISTO mas ainda não tem plugin neste serviço "
                f"({self._planned[canonical]}). Runtimes disponíveis para '{resolved_type}': "
                f"{', '.join(entry.order) or '(nenhum)'}."
            )
        raise UnknownDetectorRuntimeError(
            f"runtime de detector desconhecido: '{runtime_key or requested}' para o tipo '{resolved_type}'. "
            f"Runtimes registrados para '{resolved_type}': {', '.join(entry.order) or '(nenhum)'}. "
            f"Registre o runtime em detectors/runtime_registry.py antes de usá-lo."
        )

    def create(self, detector_type, runtime_key=None):
        return self.resolve(detector_type, runtime_key).create()

    def describe(self) -> dict:
        types = {}
        for detector_type, entry in self._types.items():
            try:
                default_key = self.default_runtime_key(detector_type)
            except Exception:
                default_key = entry.default.key if entry.default else None
            types[detector_type] = {
                "default": default_key,
                "available": list(entry.order),
                "aliases": dict(entry.aliases),
                "runtimes": {key: runtime.describe() for key, runtime in entry.runtimes.items()},
            }
        return {"types": types, "planned": dict(self._planned)}


detector_runtimes = DetectorRuntimeRegistry()

# ── Runtimes ATUAIS ──────────────────────────────────────────────────────────
# Espelham 1:1 o que o build_detector fazia antes desta refatoração.

detector_runtimes.register(
    DetectorRuntime(
        key="opencv_mog2",
        detector_type="motion",
        device="cpu",
        class_path="detectors.motion:MotionDetector",
        description="Movimento por subtração de fundo MOG2 (OpenCV).",
        requires=("opencv-python-headless", "numpy"),
    ),
    aliases=("mog2", "opencv", "motion"),
    default_for_type=True,
    default_env_var=None,  # FIXO de propósito — ver invariante no topo.
)

detector_runtimes.register(
    DetectorRuntime(
        key="openvino_cpu",
        detector_type="general",
        device="cpu",
        class_path="detectors.object_detector:ObjectDetector",
        description="Objetos (YOLO) via OpenVINO em CPU — o runtime de objeto atual.",
        requires=("openvino", "supervision", "opencv-python-headless"),
    ),
    aliases=("openvino", "cpu"),
    default_for_type=True,
    default_env_var="GENERAL_RUNTIME",  # mesmo env de runtime_profiles.GENERAL_PROFILE['runtime']
)

detector_runtimes.register(
    DetectorRuntime(
        key="onnxruntime_cpu",
        detector_type="face",
        device="cpu",
        class_path="detectors.face_detector:FaceDetector",
        description="Rostos (SCRFD/insightface) via ONNX Runtime em CPU.",
        requires=("insightface", "onnxruntime"),
    ),
    aliases=("onnxruntime", "cpu"),
    default_for_type=True,
    default_env_var="FACE_RUNTIME",  # mesmo env de runtime_profiles.FACE_PROFILE['runtime']
)

detector_runtimes.register(
    DetectorRuntime(
        key="onnxruntime_cuda",
        detector_type="face",
        device="gpu",
        class_path="detectors.face_detector:FaceDetector",
        description="Rostos via ONNX Runtime CUDA — o FaceDetector já cai para CPU se o provider faltar.",
        requires=("insightface", "onnxruntime-gpu"),
    ),
    aliases=("onnxruntime_gpu", "cuda"),
)


def create_detector(detector_type, runtime_key=None):
    """Cria o detector do tipo pedido no runtime configurado (ou explícito)."""
    return detector_runtimes.create(detector_type, runtime_key)


def resolve_detector_runtime(detector_type, runtime_key=None) -> DetectorRuntime:
    return detector_runtimes.resolve(detector_type, runtime_key)


def describe_detector_runtimes() -> dict:
    return detector_runtimes.describe()
