"""Watchdog de INFERÊNCIA travada — captura viva, detector cego.

Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
(frigate/watchdog.py: o watchdog acompanha o relógio da DETECÇÃO
(`detector.detection_start`) e considera a inferência travada quando ele passa
do limiar — não basta o processo estar vivo.)

PROBLEMA QUE ISTO RESOLVE
    Hoje o /health do ai-service só mede a CAPTURA (último frame lido). Uma
    câmera pode ficar `ready`, aparecer em `active_processors` e estar CEGA para
    sempre: se o modelo falhar ao carregar (arquivo ausente, OOM, OpenVINO
    quebrado), o `_process()` do StreamProcessor faz `return` e a thread morre —
    a captura continua alimentando a fila e ninguém percebe.

REGRA DE OURO — FALSO ALARME É PIOR QUE NÃO TER ALARME
    A IA de objeto/face está DESLIGADA por decisão do dono: no modo `motion` não
    existe inferência avançada e a ausência dela é o comportamento CORRETO. Por
    isso o estado "não aplicável" é EXPLÍCITO e nunca degrada.
    Além disso, `degraded_processors` do /health não é decorativo: o api
    (apps/api/src/ai/ai-manager.service.ts) REINICIA a análise das câmeras
    degradadas. Reiniciar uma câmera armada em recordingMode:motion é risco de
    perder gravação — por isso a fusão com aquela lista fica ATRÁS DE FLAG
    (AI_INFERENCE_WATCHDOG_ENFORCE, default OFF) e o sinal novo é publicado num
    campo separado.
"""

import os

# ── Estados possíveis ────────────────────────────────────────────────────────
# Nenhuma inferência avançada é esperada (IA de objeto/face desligada).
STATUS_NOT_APPLICABLE = "not_applicable"
# Esperada, mas o processador acabou de subir (modelo ainda carregando).
STATUS_WARMING_UP = "warming_up"
# Câmera hibernando (motion_trigger=CAMERA fora da janela de wakeup).
STATUS_IDLE = "idle"
# A captura não está pronta — o watchdog de captura é o dono deste caso.
STATUS_CAPTURE_NOT_READY = "capture_not_ready"
# Inferindo dentro do esperado.
STATUS_OK = "ok"
# Captura viva, inferência esperada e parada além do limiar.
STATUS_STALLED = "stalled"

DEFAULT_STALL_MULTIPLIER = 12.0
DEFAULT_MIN_STALL_SECONDS = 30.0
DEFAULT_MAX_STALL_SECONDS = 600.0
DEFAULT_STARTUP_GRACE_SECONDS = 90.0

_TRUE_VALUES = ("1", "true", "yes", "on")


def _env_float(env, name: str, default: float) -> float:
    raw = str((env or {}).get(name, "") or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except Exception:
        return default


def enforcement_enabled(env=None) -> bool:
    """A inferência travada só entra em `degraded_processors` se ligarem a flag.

    Default OFF de propósito: com a flag desligada a lista sai IDÊNTICA à de
    hoje e o api não ganha nenhum motivo novo para reiniciar câmera armada.
    """
    source = os.environ if env is None else env
    return str(source.get("AI_INFERENCE_WATCHDOG_ENFORCE", "") or "").strip().lower() in _TRUE_VALUES


def watchdog_settings(env=None) -> dict:
    source = os.environ if env is None else env
    return {
        "multiplier": max(2.0, _env_float(source, "AI_INFERENCE_STALL_MULTIPLIER", DEFAULT_STALL_MULTIPLIER)),
        "minimum": max(5.0, _env_float(source, "AI_INFERENCE_STALL_MIN_SECONDS", DEFAULT_MIN_STALL_SECONDS)),
        "maximum": max(10.0, _env_float(source, "AI_INFERENCE_STALL_MAX_SECONDS", DEFAULT_MAX_STALL_SECONDS)),
        "startup_grace": max(
            10.0, _env_float(source, "AI_INFERENCE_STARTUP_GRACE_SECONDS", DEFAULT_STARTUP_GRACE_SECONDS)
        ),
        "enforce": enforcement_enabled(source),
    }


def stall_threshold_seconds(
    expected_interval_seconds,
    multiplier: float = DEFAULT_STALL_MULTIPLIER,
    minimum: float = DEFAULT_MIN_STALL_SECONDS,
    maximum: float = DEFAULT_MAX_STALL_SECONDS,
) -> float:
    """Quanto tempo sem inferir caracteriza travamento.

    Proporcional ao intervalo esperado entre inferências (1/fps), com PISO — um
    detector a 4 fps travaria "tecnicamente" em 3s, e acusar tão cedo encheria o
    painel de alarme por soluço de CPU. O piso compra silêncio; o teto evita que
    um fps absurdamente baixo desligue o watchdog na prática.
    """
    try:
        interval = float(expected_interval_seconds)
    except (TypeError, ValueError):
        interval = 0.0
    if interval <= 0:
        interval = 0.0
    return max(float(minimum), min(float(maximum), interval * float(multiplier)))


def evaluate_inference_health(
    *,
    advanced_analysis_type,
    runs: int,
    errors: int,
    last_inference_at: float,
    last_duration_ms: float,
    avg_duration_ms: float,
    expected_interval_seconds,
    capture_ready: bool,
    awake: bool,
    started_at: float,
    now: float,
    stall_multiplier: float = DEFAULT_STALL_MULTIPLIER,
    min_stall_seconds: float = DEFAULT_MIN_STALL_SECONDS,
    max_stall_seconds: float = DEFAULT_MAX_STALL_SECONDS,
    startup_grace_seconds: float = DEFAULT_STARTUP_GRACE_SECONDS,
    last_error=None,
) -> dict:
    """Estado da inferência de UM processador. Função pura — relógio injetado."""
    detector_type = str(advanced_analysis_type or "").strip().lower() or None

    base = {
        "applicable": detector_type is not None,
        "status": STATUS_NOT_APPLICABLE,
        "degraded": False,
        "reason": None,
        "detector_type": detector_type,
        "runs": int(runs),
        "errors": int(errors),
        "last_inference_at": None,
        "age_seconds": None,
        "last_duration_ms": round(float(last_duration_ms), 3),
        "avg_duration_ms": round(float(avg_duration_ms), 3),
        "expected_interval_seconds": None,
        "stall_threshold_seconds": None,
        "last_error": last_error,
    }

    # (1) IA de objeto/face DESLIGADA: não há inferência a vigiar. Estado
    # explícito — jamais degradado (senão TODA câmera do parque, que hoje roda
    # só movimento, apareceria cega).
    if detector_type is None:
        base["reason"] = "object_ai_disabled"
        return base

    threshold = stall_threshold_seconds(
        expected_interval_seconds,
        multiplier=stall_multiplier,
        minimum=min_stall_seconds,
        maximum=max_stall_seconds,
    )
    has_run = int(runs) > 0 and float(last_inference_at) > 0
    age = max(0.0, float(now) - float(last_inference_at)) if has_run else None
    base.update(
        {
            "last_inference_at": float(last_inference_at) if has_run else None,
            "age_seconds": round(age, 3) if age is not None else None,
            "expected_interval_seconds": (
                round(float(expected_interval_seconds), 4) if expected_interval_seconds else None
            ),
            "stall_threshold_seconds": round(float(threshold), 3),
        }
    )

    # (2) Captura parada: o readiness de captura já denuncia. Culpar a
    # inferência duplicaria o alarme e esconderia a causa real.
    if not capture_ready:
        base["status"] = STATUS_CAPTURE_NOT_READY
        base["reason"] = "capture_not_ready"
        return base

    # (3) Hibernando: não inferir é o comportamento correto.
    if not awake:
        base["status"] = STATUS_IDLE
        base["reason"] = "hibernating"
        return base

    # (4) Nunca inferiu: warmup primeiro, depois é o modelo que não carregou.
    if not has_run:
        if max(0.0, float(now) - float(started_at)) < float(startup_grace_seconds):
            base["status"] = STATUS_WARMING_UP
            base["reason"] = "warming_up"
            return base
        base["status"] = STATUS_STALLED
        base["degraded"] = True
        base["reason"] = "no_inference_since_start"
        return base

    # (5) Inferiu um dia e parou.
    if age is not None and age > threshold:
        base["status"] = STATUS_STALLED
        base["degraded"] = True
        base["reason"] = "inference_stalled"
        return base

    base["status"] = STATUS_OK
    return base


def unknown_state(detector_type=None, last_error=None) -> dict:
    """Estado neutro: não sabemos medir — e não sabemos NÃO é degradado."""
    return {
        "applicable": bool(detector_type),
        "status": "unknown",
        "degraded": False,
        "reason": "inference_state_unavailable",
        "detector_type": detector_type,
        "runs": 0,
        "errors": 0,
        "last_inference_at": None,
        "age_seconds": None,
        "last_duration_ms": 0.0,
        "avg_duration_ms": 0.0,
        "expected_interval_seconds": None,
        "stall_threshold_seconds": None,
        "last_error": last_error,
    }


def safe_inference_state(processor, **kwargs) -> dict:
    """Lê o estado de inferência de um processador SEM poder derrubar o /health.

    O /health é lido pelo watchdog do api; uma exceção aqui viraria 500 e o api
    concluiria que o ai-service inteiro caiu. Erro ao MEDIR nunca vira alarme.
    """
    try:
        return processor.inference_state(**kwargs)
    except Exception as exc:  # noqa: BLE001 — observabilidade não pode quebrar o serviço
        return unknown_state(
            detector_type=getattr(processor, "advanced_analysis_type", None),
            last_error=f"inference_state falhou: {exc}",
        )


def inference_degraded_ids(states: dict) -> list:
    """IDs cujo estado de INFERÊNCIA está degradado (ordem estável do dict)."""
    return [
        camera_id
        for camera_id, state in (states or {}).items()
        if isinstance(state, dict) and state.get("degraded")
    ]


def merge_degraded(capture_degraded, states: dict, enforce: bool) -> list:
    """Funde a degradação de inferência na lista de degradados da CAPTURA.

    Com `enforce=False` (default do serviço) devolve a lista atual INTACTA: o
    sinal novo é observável no /health sem mudar o que o api faz com ele.
    """
    merged = list(capture_degraded or [])
    if not enforce:
        return merged
    for camera_id in inference_degraded_ids(states):
        if camera_id not in merged:
            merged.append(camera_id)
    return merged
