from fastapi import FastAPI, HTTPException, Header, Query
import os
import uvicorn
from pydantic import BaseModel
from typing import Any, Optional, Dict
import hmac
import time
from stream_processor import StreamProcessor
from model_registry import registry
from runtime_profiles import exposed_profiles
from onnxruntime_session import inference_threading_status

app = FastAPI(title="VMS AI Service", description="AI analysis service for VMS Drac")

# Gerenciador de processos ativos
processors: Dict[str, StreamProcessor] = {}

class AnalysisRequest(BaseModel):
    camera_id: str
    rtsp_url: str
    analysis_type: str  # 'motion' = base only; 'face' and 'general' run with motion too.
    source_info: Optional[Dict[str, Any]] = None


class ConfirmMotionRequest(BaseModel):
    camera_id: str
    rtsp_url: str  # caminho do MediaMTX (grid) — leve, já publicado
    # objetos que "valem" gravação; vazio = qualquer objeto reconhecido conta.
    accept_labels: Optional[list] = None


class ModeRequest(BaseModel):
    analysis_type: str


class LiveViewLeaseRequest(BaseModel):
    session_id: str
    ttl_seconds: int = 20
    view_mode: str = "grid"


def validate_internal_token(x_service_token: Optional[str]):
    expected = (os.getenv("INTERNAL_SERVICE_TOKEN", "") or "").strip()
    if not expected or expected == "change_me_service_token" or len(expected) < 24:
        raise HTTPException(status_code=503, detail="INTERNAL_SERVICE_TOKEN inválido no serviço.")
    if not x_service_token or not hmac.compare_digest(x_service_token, expected):
        raise HTTPException(status_code=401, detail="Token interno inválido.")

@app.get("/health")
def health_check():
    max_frame_age = max(5.0, float(os.getenv("AI_READINESS_MAX_FRAME_AGE_SECONDS", "20")))
    readiness = {
        camera_id: processor.readiness_state(max_frame_age)
        for camera_id, processor in processors.items()
    }
    degraded = [camera_id for camera_id, state in readiness.items() if not state["ready"]]
    return {
        "status": "degraded" if degraded else "online",
        "service": "ai-service",
        "ready": not degraded,
        "degraded_processors": degraded,
        "active_processors": list(processors.keys()),
        "static_profiles": exposed_profiles(),
        "model_registry": registry.status(),
        "inference_threading": inference_threading_status(),
        "processors": {
            camera_id: {
                "analysis_type": processor.analysis_type,
                "base_motion_enabled": True,
                "advanced_analysis_type": processor.advanced_analysis_type,
                "runtime_profile": processor.profile,
                "process_fps": processor.process_fps,
                "advanced_process_fps": processor.advanced_process_fps,
                "last_seen": processor.last_seen,
                "last_error": processor.last_error,
                "running": processor.running,
                "live_snapshot_count": len(processor.get_live_snapshot(max_age_ms=15000, limit=100)),
                "capture_frames_enqueued": processor.capture_frames_enqueued,
                "capture_frames_dropped": processor.capture_frames_dropped,
                "source": processor.source_state(),
                "stream": processor.capture_stream_state(),
                "motion_trigger": processor.motion_trigger,
                "wakeup_until": processor.wakeup_until,
                "hibernating": processor.motion_trigger == "CAMERA" and __import__("time").time() >= processor.wakeup_until,
                "live_view": processor.live_view_state(),
                "performance": processor.performance_state(),
                "readiness": readiness[camera_id],
            }
            for camera_id, processor in processors.items()
        },
    }


@app.get("/ready")
def readiness_check():
    max_frame_age = max(5.0, float(os.getenv("AI_READINESS_MAX_FRAME_AGE_SECONDS", "20")))
    states = {
        camera_id: processor.readiness_state(max_frame_age)
        for camera_id, processor in processors.items()
    }
    unhealthy = {camera_id: state for camera_id, state in states.items() if not state["ready"]}
    if unhealthy:
        raise HTTPException(status_code=503, detail={"status": "degraded", "processors": unhealthy})
    return {"status": "ready", "service": "ai-service", "processors": states, "time": time.time()}


@app.get("/detections/latest/{camera_id}")
async def latest_detections(
    camera_id: str,
    max_age_ms: int = Query(default=5000, ge=200, le=30000),
    limit: int = Query(default=12, ge=1, le=50),
    x_service_token: Optional[str] = Header(default=None),
):
    validate_internal_token(x_service_token)
    processor = processors.get(camera_id)
    if processor is None:
        return {"status": "not_running", "camera_id": camera_id, "detections": []}
    return {
        "status": "ok",
        "camera_id": camera_id,
        "detections": processor.get_live_snapshot(max_age_ms=max_age_ms, limit=limit),
    }

@app.post("/analyze/start")
async def start_analysis(request: AnalysisRequest, x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    if request.camera_id in processors:
        return {"status": "already_running", "camera_id": request.camera_id}
    
    api_url = os.getenv("API_URL", "http://api:3000")
    service_token = os.getenv("INTERNAL_SERVICE_TOKEN", "change_me_service_token")
    
    processor = StreamProcessor(
        request.camera_id,
        request.rtsp_url,
        api_url,
        service_token,
        request.analysis_type,
        request.source_info or {},
    )
    processor.start()
    processors[request.camera_id] = processor
    
    return {"status": "started", "camera_id": request.camera_id, "analysis_type": request.analysis_type}

@app.post("/analyze/stop/{camera_id}")
async def stop_analysis(camera_id: str, x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    if camera_id not in processors:
        raise HTTPException(status_code=404, detail="Processador não encontrado")
    
    processor = processors.pop(camera_id)
    processor.stop()
    
    return {"status": "stopped", "camera_id": camera_id}

@app.post("/confirm-motion")
async def confirm_motion(request: ConfirmMotionRequest, x_service_token: Optional[str] = Header(default=None)):
    """Confirma se um evento de movimento NATIVO (ONVIF) contém objeto real.

    Captura UM frame do caminho de grade (leve) e roda o detector de objetos.
    Usado para filtrar o ruído das câmeras (~centenas de disparos/hora de
    madrugada em cena vazia) antes de acionar a gravação.

    IMPORTANTE — falha sempre SEGURA: qualquer erro (câmera lenta, modelo
    indisponível, timeout) devolve confirmed=None. A API interpreta None como
    "não sei" e GRAVA mesmo assim — nunca se perde um evento real porque a IA
    falhou. Só confirmed=False (frame lido e SEM objeto) suprime a gravação.
    """
    validate_internal_token(x_service_token)
    import cv2 as _cv2
    import time as _time

    cap = None
    try:
        cap = _cv2.VideoCapture(request.rtsp_url, _cv2.CAP_FFMPEG)
        cap.set(_cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 4000)
        cap.set(_cv2.CAP_PROP_READ_TIMEOUT_MSEC, 4000)
        cap.set(_cv2.CAP_PROP_BUFFERSIZE, 1)
        frame = None
        started = _time.time()
        # Descarta os primeiros quadros (podem vir do buffer antigo) e pega um recente.
        for _ in range(5):
            ok, f = cap.read()
            if ok and f is not None:
                frame = f
            if _time.time() - started > 5:
                break
        if frame is None:
            return {"confirmed": None, "reason": "no_frame", "labels": []}

        detector = registry.ensure_detector("general")
        objects = detector.infer(frame, context_key=None, input_size_hint=640)
        accept = set(request.accept_labels or [])
        labels = [str(getattr(o, "label", "")) for o in objects]
        relevant = [l for l in labels if not accept or l in accept]
        best_conf = max([float(getattr(o, "confidence", 0.0)) for o in objects], default=0.0)
        return {
            "confirmed": bool(relevant),
            "reason": None if relevant else "no_object",
            "labels": labels,
            "confidence": round(best_conf, 4),
        }
    except Exception as exc:
        return {"confirmed": None, "reason": f"error:{exc}", "labels": []}
    finally:
        try:
            if cap is not None:
                cap.release()
        except Exception:
            pass


@app.post("/analyze/wakeup/{camera_id}")
async def wakeup_camera(camera_id: str, duration_seconds: int = Query(20, ge=5, le=300), x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    processor = processors.get(camera_id)
    if not processor:
        raise HTTPException(status_code=404, detail="Processador não encontrado")
    import time
    now = time.time()
    if now < processor.wakeup_until:
        return {"status": "already_awake", "camera_id": camera_id, "until": processor.wakeup_until}
    processor.wakeup_until = time.time() + duration_seconds
    return {"status": "awoken", "camera_id": camera_id, "until": processor.wakeup_until}


@app.post("/live-view/start/{camera_id}")
async def start_live_view(camera_id: str, request: LiveViewLeaseRequest, x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    processor = processors.get(camera_id)
    if not processor:
        return {"status": "not_running", "camera_id": camera_id, "session_id": request.session_id}
    try:
        lease = processor.touch_live_view_session(request.session_id, request.ttl_seconds, request.view_mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"camera_id": camera_id, **lease}


@app.post("/live-view/heartbeat/{camera_id}")
async def heartbeat_live_view(camera_id: str, request: LiveViewLeaseRequest, x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    processor = processors.get(camera_id)
    if not processor:
        return {"status": "not_running", "camera_id": camera_id, "session_id": request.session_id}
    try:
        lease = processor.touch_live_view_session(request.session_id, request.ttl_seconds, request.view_mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"camera_id": camera_id, **lease}


@app.post("/live-view/stop/{camera_id}")
async def stop_live_view(camera_id: str, request: LiveViewLeaseRequest, x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    processor = processors.get(camera_id)
    if not processor:
        return {"status": "not_running", "camera_id": camera_id, "session_id": request.session_id}
    try:
        lease = processor.stop_live_view_session(request.session_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"camera_id": camera_id, **lease}


@app.post("/analyze/stop-all")
async def stop_all(x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    stopped = []
    for camera_id, processor in list(processors.items()):
        processors.pop(camera_id, None)
        processor.stop()
        stopped.append(camera_id)
    return {"status": "stopped", "camera_ids": stopped}


@app.post("/models/reset")
async def reset_models(x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    registry.reset()
    return {"status": "reset"}


@app.post("/models/load")
async def load_model(request: ModeRequest, x_service_token: Optional[str] = Header(default=None)):
    validate_internal_token(x_service_token)
    try:
        registry.ensure_mode(request.analysis_type)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "loaded", "model_registry": registry.status()}


if __name__ == "__main__":
    port = int(os.getenv("AI_PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
