from .base import Detection, Detector
from .runtime_registry import (
    DetectorRuntime,
    DetectorRuntimeRegistry,
    DetectorRuntimeUnavailableError,
    UnknownDetectorRuntimeError,
    UnknownDetectorTypeError,
    create_detector,
    describe_detector_runtimes,
    detector_runtimes,
    resolve_detector_runtime,
)

_LEGACY_MODES = ("motion", "face", "general")


def build_detector(analysis_type: str) -> Detector:
    """Compatibilidade: mesma assinatura e MESMO resultado de antes do registry.

    'motion' → MotionDetector, 'face' → FaceDetector, 'general' → ObjectDetector,
    qualquer outra coisa → ValueError com a mensagem legada. A construção passa
    pelo registry (que escolhe o runtime de hardware por tipo) e continua LAZY:
    nada de cv2/supervision/insightface é importado enquanto o detector não for
    efetivamente criado.
    """
    mode = (analysis_type or "motion").strip().lower()
    if mode not in _LEGACY_MODES:
        raise ValueError(f"analysis_type invalido: {analysis_type}")
    return create_detector(mode)


def __getattr__(name):
    # MotionDetector continua acessível como `detectors.MotionDetector`, mas sem
    # arrastar cv2 no import do pacote (o registry precisa ser importável em
    # máquina sem stack de ML — mesma tolerância do Frigate a plugin ausente).
    if name == "MotionDetector":
        from .motion import MotionDetector

        return MotionDetector
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "Detection",
    "Detector",
    "DetectorRuntime",
    "DetectorRuntimeRegistry",
    "DetectorRuntimeUnavailableError",
    "MotionDetector",
    "UnknownDetectorRuntimeError",
    "UnknownDetectorTypeError",
    "build_detector",
    "create_detector",
    "describe_detector_runtimes",
    "detector_runtimes",
    "resolve_detector_runtime",
]
