"""Confirmação de movimento FORA do event loop (item 2.1 do PLANO-EVOLUCAO-DRAC).

O handler `/confirm-motion` fazia `cv2.VideoCapture` + `cap.read()` + inferência
SÍNCRONOS dentro de um `async def` — travando o event loop do uvicorn por até ~5s a
cada evento ONVIF (e uma câmera ruidosa dispara centenas/hora). Aqui o trabalho
bloqueante roda numa THREAD (`asyncio.to_thread`), com:

  * SEMÁFORO — limita a concorrência de captura/inferência (default 1 = serializa o
    acesso ao modelo ÚNICO compartilhado, como antes, mas sem prender o loop). Pool
    por PROCESSO/MODELO, nunca processo-por-câmera (não duplica pesos).
  * DEADLINE — `asyncio.wait_for`; se estourar, devolve confirmed=None.

Invariante 1.3 (fail-safe) PRESERVADO: qualquer erro/timeout -> confirmed=None (a API
interpreta None como "não sei" e GRAVA). SÓ um frame lido SEM objeto devolve
confirmed=False (única supressão de gravação).
"""
import asyncio
import os
from typing import Any, Callable, Dict, Optional

CONFIRM_MOTION_CONCURRENCY = int(os.getenv("AI_CONFIRM_MOTION_CONCURRENCY", "1") or "1")
CONFIRM_MOTION_DEADLINE_SEC = float(os.getenv("AI_CONFIRM_MOTION_DEADLINE_SEC", "8") or "8")

_sem: Optional[asyncio.Semaphore] = None


def get_semaphore(concurrency: int = CONFIRM_MOTION_CONCURRENCY) -> asyncio.Semaphore:
    """Semáforo global do processo, criado preguiçosamente já dentro do event loop
    em execução (evita amarrar num loop errado no import)."""
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(max(1, concurrency))
    return _sem


def _failsafe(reason: str) -> Dict[str, Any]:
    # NUNCA confirmed=False aqui: um erro não pode virar "sem objeto" (isso suprimiria
    # gravação por falha da IA). None = "não sei" => a API grava.
    return {"confirmed": None, "reason": reason, "labels": []}


async def run_confirm_motion(
    blocking_call: Callable[[], Dict[str, Any]],
    *,
    camera_id: str = "",
    deadline: float = CONFIRM_MOTION_DEADLINE_SEC,
    semaphore: Optional[asyncio.Semaphore] = None,
    logger: Any = None,
) -> Dict[str, Any]:
    """Roda `blocking_call` (sem args) numa thread, com semáforo + deadline, tirando o
    trabalho pesado do event loop. Falha SEMPRE SEGURA (timeout/erro -> None)."""
    sem = semaphore if semaphore is not None else get_semaphore()
    try:
        async with sem:
            return await asyncio.wait_for(asyncio.to_thread(blocking_call), timeout=deadline)
    except asyncio.TimeoutError:
        if logger is not None:
            logger.warning(
                "confirm-motion excedeu o deadline de %ss (camera=%s) -> confirmed=None (grava)",
                deadline, camera_id,
            )
        return _failsafe("timeout")
    except Exception as exc:  # noqa: BLE001 — fail-safe: qualquer erro vira None
        if logger is not None:
            logger.warning(
                "confirm-motion falhou (camera=%s): %s -> confirmed=None (grava)",
                camera_id, exc,
            )
        return _failsafe(f"error:{exc}")


def capture_and_detect(
    rtsp_url: str,
    accept_labels: Optional[list],
    ensure_detector: Callable[[str], Any],
) -> Dict[str, Any]:
    """Trabalho BLOQUEANTE: captura 1 frame recente do RTSP (grade leve) e roda o
    detector de objetos. NÃO chamar no event loop — passar para `run_confirm_motion`.

    `ensure_detector` é injetado (ex.: `registry.ensure_detector`) para manter este
    módulo livre de imports pesados (onnxruntime/model_registry) e testável isolado.
    Falha SEMPRE SEGURA: qualquer erro (inclui cv2 ausente) -> confirmed=None.
    """
    import time as _time

    cap = None
    try:
        import cv2 as _cv2

        cap = _cv2.VideoCapture(rtsp_url, _cv2.CAP_FFMPEG)
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

        detector = ensure_detector("general")
        objects = detector.infer(frame, context_key=None, input_size_hint=640)
        accept = set(accept_labels or [])
        labels = [str(getattr(o, "label", "")) for o in objects]
        relevant = [l for l in labels if not accept or l in accept]
        best_conf = max([float(getattr(o, "confidence", 0.0)) for o in objects], default=0.0)
        return {
            "confirmed": bool(relevant),
            "reason": None if relevant else "no_object",
            "labels": labels,
            "confidence": round(best_conf, 4),
        }
    except Exception as exc:  # noqa: BLE001 — fail-safe
        return {"confirmed": None, "reason": f"error:{exc}", "labels": []}
    finally:
        try:
            if cap is not None:
                cap.release()
        except Exception:
            pass
