"""Static AI runtime profiles.

These values are deliberately code-owned. The API selects a mode, but it
cannot override detector model, thresholds, sizing or overlay behavior.
"""

import os


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name, "") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except Exception:
        return default


def _env_str(name: str, default: str) -> str:
    raw = (os.getenv(name, "") or "").strip()
    return raw if raw else default


def _env_csv_str(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    values = tuple(value.strip() for value in raw.split(",") if value.strip())
    return values or default


def _env_csv_int(name: str, default: tuple[int, ...]) -> tuple[int, ...]:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    values: list[int] = []
    for value in raw.split(","):
        try:
            values.append(int(value.strip()))
        except Exception:
            continue
    return tuple(values) or default


MOTION_PROFILE = {
    "mode": "motion",
    "detection_fps": 2.0,
    "analysis_width": 320,
    "analysis_height": 180,
    "motion_trigger": "SYSTEM",
    # Limiar por OBJETO (componente conectado), como FRAÇÃO da área analisada.
    # 0,0012 = 0,12% da tela (~69 px em 320×180) ≈ pessoa/moto distante — calibrado
    # pelo comparativo de campo com a detecção nativa ONVIF (2026-07-21). O limiar
    # antigo de 1800 px (3,1% da tela) ignorava tudo que não estivesse perto.
    "motion_min_component_ratio": _env_float("MOTION_MIN_COMPONENT_RATIO", 0.0012),
    # Fração da tela mudando de uma vez que caracteriza ALTERAÇÃO GLOBAL
    # (IR dia/noite, exposição, relâmpago, câmera mexida) — reaprende, não dispara.
    "motion_global_change_ratio": _env_float("MOTION_GLOBAL_CHANGE_RATIO", 0.55),
    "motion_min_consecutive_hits": 3,
    # 30 frames a 2 fps = 15s de aprendizado no boot (antes 60 = 30s cego).
    "motion_warmup_frames": _env_int("MOTION_WARMUP_FRAMES", 30),
    # Normalização de contraste pré-diff (padrão Frigate) — essencial à noite.
    "motion_improve_contrast": str(os.getenv("MOTION_IMPROVE_CONTRAST", "true")).strip().lower() != "false",
    # Congela o aprendizado do fundo nos primeiros N frames de movimento (padrão
    # Frigate): quem entra e FICA continua sendo detectado; mudança persistente
    # (carro estacionado) é absorvida gradualmente depois.
    "motion_freeze_learning_frames": _env_int("MOTION_FREEZE_LEARNING_FRAMES", 6),
    # MUDANÇA GLOBAL DE CENA (luz acendendo, IR ligando, sol saindo da nuvem):
    # recalibra o fundo E CONTINUA reportando o movimento, marcado com
    # sceneChange=true no metadata. Engolir o evento era não gravar justamente no
    # instante em que algo acontece — e o MOTION_DETECTED é o gatilho da gravação.
    # false = kill-switch, volta ao comportamento antigo (descarta o evento).
    "motion_scene_change_report": _env_bool("MOTION_SCENE_CHANGE_REPORT", True),
    # Roda o MOG2 no plano de LUMINÂNCIA (1 canal) em vez do BGR (3 canais).
    # OPT-IN: o padrão é o caminho de hoje. Objeto que só se distingue por matiz
    # (mesma luminância do fundo) some no plano Y — por isso a troca é consciente.
    "motion_luma_plane": _env_bool("MOTION_LUMA_PLANE", False),
    # Teto de caixas de movimento por frame. O detector devolve um Detection por
    # objeto coeso (maior primeiro); o teto impede que uma cena agitada vire uma
    # lista enorme — cada caixa custa um recorte na confirmação semântica.
    "motion_max_boxes": _env_int("MOTION_MAX_BOXES", 4),
    # O primeiro movimento continua imediato; apenas eventos repetidos da mesma
    # cena são consolidados. Mantém o post-roll da gravação acima deste valor.
    "event_debounce_seconds": _env_int("MOTION_EVENT_DEBOUNCE_SECONDS", 45),
    "show_after_hits": 1,
    "hide_after_misses": 2,
    "lost_ttl_ms": 600,
    "overlay_ttl_ms": 600,
}

FACE_PROFILE = {
    "mode": "face",
    "model": "scrfd_500m",
    "pack": "buffalo_s",
    # Runtime do detector de rostos (onnxruntime). Default CPU. Para acelerar por
    # GPU NVIDIA, suba o serviço com FACE_RUNTIME=onnxruntime_cuda numa imagem com
    # onnxruntime-gpu (ver Dockerfile.gpu). Dormente por padrão.
    "runtime": _env_str("FACE_RUNTIME", "onnxruntime_cpu"),
    "analysis_width": 960,
    "analysis_height": 540,
    "detector_size": 640,
    "detection_fps": 2.0,
    "confidence": 0.35,
    "motion_trigger": "CAMERA",
    "event_debounce_seconds": 10,
    "show_after_hits": 1,
    "hide_after_misses": 2,
    "lost_ttl_ms": 600,
    "overlay_ttl_ms": 600,
    "recognition": False,
}

GENERAL_PROFILE = {
    "mode": _env_str("GENERAL_MODE", "general"),
    "model": _env_str("GENERAL_MODEL", "yolo26n"),
    "runtime": _env_str("GENERAL_RUNTIME", "openvino_cpu"),
    "precision": _env_str("GENERAL_PRECISION", "int8"),
    "analysis_width": _env_int("GENERAL_ANALYSIS_WIDTH", 960),
    "analysis_height": _env_int("GENERAL_ANALYSIS_HEIGHT", 540),
    "imgsz": _env_int("GENERAL_IMGSZ", 640),
    "detection_fps": _env_float("GENERAL_DETECTION_FPS", 4.0),
    "motion_trigger": _env_str("GENERAL_MOTION_TRIGGER", "SYSTEM"),
    "event_debounce_seconds": _env_int("GENERAL_EVENT_DEBOUNCE_SECONDS", 10),
    "classes": _env_csv_str("GENERAL_CLASSES", ("person", "bicycle", "car", "motorcycle", "bus")),
    "class_ids": _env_csv_int("GENERAL_CLASS_IDS", (0, 1, 2, 3, 5)),
    "confidence_person": _env_float("GENERAL_CONFIDENCE_PERSON", 0.30),
    "confidence_bicycle": _env_float("GENERAL_CONFIDENCE_BICYCLE", 0.25),
    "confidence_car": _env_float("GENERAL_CONFIDENCE_CAR", 0.25),
    "confidence_motorcycle": _env_float("GENERAL_CONFIDENCE_MOTORCYCLE", 0.25),
    "confidence_rider_vehicle": _env_float("GENERAL_CONFIDENCE_RIDER_VEHICLE", 0.25),
    "confidence_vehicle": _env_float("GENERAL_CONFIDENCE_VEHICLE", 0.25),
    "tracker": _env_str("GENERAL_TRACKER", "bytetrack"),
    "track_buffer": _env_int("GENERAL_TRACK_BUFFER", 20),
    "lost_ttl_ms": _env_int("GENERAL_LOST_TTL_MS", 2000),
    "hide_after_misses": _env_int("GENERAL_HIDE_AFTER_MISSES", 5),
    "show_after_hits": _env_int("GENERAL_SHOW_AFTER_HITS", 1),
    "min_object_height_px": _env_int("GENERAL_MIN_OBJECT_HEIGHT_PX", 10),
    "overlay_mode": _env_str("GENERAL_OVERLAY_MODE", "triangle"),
    "overlay_ttl_ms": _env_int("GENERAL_OVERLAY_TTL_MS", 1800),
    "persistent_track_id": _env_bool("GENERAL_PERSISTENT_TRACK_ID", True),
    "recognition": _env_bool("GENERAL_RECOGNITION", False),
    "face_detection": _env_bool("GENERAL_FACE_DETECTION", False),
    "detect_vehicles": _env_bool("GENERAL_DETECT_VEHICLES", False),
    "detect_animals": _env_bool("GENERAL_DETECT_ANIMALS", False),
    "detect_objects": _env_bool("GENERAL_DETECT_OBJECTS", False),
    "emit_events": _env_bool("GENERAL_EMIT_EVENTS", True),
    "model_path": _env_str("GENERAL_MODEL_PATH", ""),
    "model_input_width": _env_int("GENERAL_MODEL_INPUT_WIDTH", 0),
    "model_input_height": _env_int("GENERAL_MODEL_INPUT_HEIGHT", 0),
    "model_dynamic": _env_bool("GENERAL_MODEL_DYNAMIC", False),
    "model_end2end": _env_bool("GENERAL_MODEL_END2END", True),
    "model_nms": _env_bool("GENERAL_MODEL_NMS", False),
    "openvino_device": _env_str("GENERAL_OPENVINO_DEVICE", "CPU"),
    "openvino_performance_hint": _env_str("GENERAL_OPENVINO_PERFORMANCE_HINT", "LATENCY"),
}


def runtime_profile(mode: str) -> dict:
    selected = (mode or "motion").strip().lower()
    if selected == "face":
        return FACE_PROFILE.copy()
    if selected == "general":
        return GENERAL_PROFILE.copy()
    return MOTION_PROFILE.copy()


def onnxruntime_providers(runtime: str | None) -> list:
    """ONNX Runtime providers para um runtime de perfil.

    'onnxruntime_cuda' / qualquer coisa com 'cuda'/'gpu' → tenta CUDA e cai para CPU.
    Caso contrário → só CPU (comportamento atual, default). Dormente até alguém
    setar FACE_RUNTIME=onnxruntime_cuda numa imagem com onnxruntime-gpu.
    """
    selected = (runtime or "").strip().lower()
    if "cuda" in selected or "gpu" in selected:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def runtime_uses_gpu(runtime: str | None) -> bool:
    selected = (runtime or "").strip().lower()
    return "cuda" in selected or "gpu" in selected


def exposed_profiles() -> dict:
    return {
        "face": FACE_PROFILE.copy(),
        "general": {
            **GENERAL_PROFILE,
            "classes": list(GENERAL_PROFILE["classes"]),
            "class_ids": list(GENERAL_PROFILE["class_ids"]),
        },
    }
