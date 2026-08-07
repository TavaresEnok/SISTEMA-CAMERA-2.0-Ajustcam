import cv2
import time
import threading
import logging
import requests
import os
import numpy as np
from collections import deque
from queue import Queue
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from detectors.base import Detection
from detectors.motion import MotionDetector
from detectors.tripwire import DetectorDeTravessia
from model_registry import registry
from runtime_profiles import MOTION_PROFILE, runtime_profile
from reconnect_backoff import compute_reconnect_delay
from capture_rate_guard import CaptureRateGuard
from inference_watchdog import evaluate_inference_health, watchdog_settings

logger = logging.getLogger("ai-service.stream")

class StreamProcessor:
    def __init__(self, camera_id, rtsp_url, api_url, service_token, analysis_type="motion", source_info=None):
        self.camera_id = camera_id
        self.rtsp_url = rtsp_url
        self.api_url = api_url
        self.service_token = service_token
        self.analysis_type = (analysis_type or "motion").strip().lower()
        self.source_info = source_info or {}
        self.profile = runtime_profile(self.analysis_type)
        self.motion_trigger = str(self.profile["motion_trigger"]).upper()
        self.wakeup_until = 0
        self.running = False
        self.thread = None
        self.capture_thread = None
        self.base_process_fps = float(self.profile["detection_fps"])
        self.base_advanced_process_fps = float(self.profile["detection_fps"])
        self.base_frame_width = int(self.profile["analysis_width"])
        self.base_frame_height = int(self.profile["analysis_height"])
        self.base_input_size = int(self.profile.get("imgsz", 0))
        self.selected_process_fps = float(os.getenv("AI_SELECTED_DETECTION_FPS", "3.0"))
        self.selected_advanced_process_fps = float(os.getenv("AI_SELECTED_DETECTION_FPS", str(self.selected_process_fps)))
        self.selected_frame_width = int(os.getenv("AI_SELECTED_ANALYSIS_WIDTH", "960"))
        self.selected_frame_height = int(os.getenv("AI_SELECTED_ANALYSIS_HEIGHT", "540"))
        self.selected_input_size = int(os.getenv("AI_SELECTED_IMGSZ", str(self.base_input_size)))
        self.grid_process_fps = float(os.getenv("AI_GRID_DETECTION_FPS", "1.0"))
        self.grid_advanced_process_fps = float(os.getenv("AI_GRID_DETECTION_FPS", str(self.grid_process_fps)))
        self.grid_frame_width = int(os.getenv("AI_GRID_ANALYSIS_WIDTH", "640"))
        self.grid_frame_height = int(os.getenv("AI_GRID_ANALYSIS_HEIGHT", "360"))
        self.grid_input_size = int(os.getenv("AI_GRID_IMGSZ", "512"))
        self.process_fps = self.base_process_fps
        self.advanced_process_fps = self.base_advanced_process_fps
        self.frame_width = self.base_frame_width
        self.frame_height = self.base_frame_height
        self.current_qos_mode = "base"
        self.current_input_size_hint = self.base_input_size if self.base_input_size > 0 else None
        self.qos_live_enabled = str(os.getenv("AI_QOS_LIVE_ENABLED", "true")).strip().lower() in ("1", "true", "yes", "on")
        self.adaptive_feature_enabled = str(os.getenv("AI_ADAPTIVE_MODE", "true")).strip().lower() in ("1", "true", "yes", "on")
        pilot_raw = str(os.getenv("AI_ADAPTIVE_PILOT_CAMERA_IDS", "*") or "").strip()
        self.adaptive_pilot_raw = pilot_raw
        self.adaptive_pilot_all = pilot_raw in ("", "*", "all", "ALL")
        self.adaptive_pilot_ids = {
            token.strip()
            for token in pilot_raw.split(",")
            if token.strip()
        } if not self.adaptive_pilot_all else set()
        self.adaptive_enabled = self.adaptive_feature_enabled and (
            self.adaptive_pilot_all or self.camera_id in self.adaptive_pilot_ids
        )
        self.adaptive_window_seconds = max(3.0, float(os.getenv("AI_ADAPTIVE_WINDOW_SECONDS", "6")))
        self.adaptive_degrade_cooldown_seconds = max(
            2.0,
            float(os.getenv("AI_ADAPTIVE_DEGRADE_COOLDOWN_SECONDS", "8")),
        )
        self.adaptive_recover_cooldown_seconds = max(
            2.0,
            float(os.getenv("AI_ADAPTIVE_RECOVER_COOLDOWN_SECONDS", "15")),
        )
        self.adaptive_drop_ratio_high = min(
            0.95,
            max(0.01, float(os.getenv("AI_ADAPTIVE_DROP_RATIO_HIGH", "0.12"))),
        )
        self.adaptive_drop_ratio_low = min(
            0.5,
            max(0.0, float(os.getenv("AI_ADAPTIVE_DROP_RATIO_LOW", "0.03"))),
        )
        self.adaptive_cpu_high = min(
            99.0,
            max(10.0, float(os.getenv("AI_ADAPTIVE_CPU_HIGH", "88"))),
        )
        self.adaptive_cpu_low = min(
            95.0,
            max(5.0, float(os.getenv("AI_ADAPTIVE_CPU_LOW", "68"))),
        )
        self._adaptive_state: dict[str, dict[str, int]] = {
            "selected": {"fps_idx": 0, "imgsz_idx": 0, "res_idx": 0},
            "grid": {"fps_idx": 0, "imgsz_idx": 0, "res_idx": 0},
            "base": {"fps_idx": 0, "imgsz_idx": 0, "res_idx": 0},
        }
        self._adaptive_last_eval_at = 0.0
        self._adaptive_last_change_at = 0.0
        self._adaptive_last_metrics: dict[str, float | None] = {
            "drop_ratio": 0.0,
            "cpu_percent": None,
            "window_enqueued": 0.0,
            "window_dropped": 0.0,
        }
        self._adaptive_last_capture_enqueued = 0
        self._adaptive_last_capture_dropped = 0
        self._cpu_prev_total = None
        self._cpu_prev_idle = None
        self._adaptive_profiles = self._build_adaptive_profiles()
        self.capture_loop_iterations = 0
        self.process_loop_iterations = 0
        self.advanced_infer_runs = 0
        self.advanced_infer_errors = 0
        self.advanced_infer_sum_ms = 0.0
        self.advanced_infer_last_ms = 0.0
        self.overlay_payload_frames = 0
        self.overlay_empty_frames = 0
        self.motion_debounce_seconds = int(MOTION_PROFILE["event_debounce_seconds"])
        self.detect_debounce_seconds = int(self.profile["event_debounce_seconds"])
        self.emit_events = bool(self.profile.get("emit_events", True))
        self.live_detection_hold_ms = int(self.profile["overlay_ttl_ms"])
        self.show_after_hits = int(self.profile["show_after_hits"])
        self.hide_after_misses = int(self.profile["hide_after_misses"])
        self.lost_ttl_ms = int(self.profile["lost_ttl_ms"])
        self.frame_queue = Queue(maxsize=1)
        self.last_event_by_type = {}
        self.last_seen = 0
        self.last_capture_success_at = 0.0
        self.last_capture_failure_at = 0.0
        self.consecutive_capture_failures = 0
        self.last_advanced_infer_at = 0
        # Zonas de detecção vêm no source_info enviado pela API (polígonos
        # normalizados). Sem zonas, o detector monitora a câmera inteira.
        zones = (source_info or {}).get("detectionZones") if isinstance(source_info, dict) else None
        self.detection_zones = zones if isinstance(zones, list) else []
        self.motion_detector = MotionDetector(zones=self.detection_zones)
        # Tripwire: as LINHAS viajam na mesma lista das zonas (kind: 'line').
        # Fica inativo — e sem custo — quando não há nenhuma desenhada.
        self.tripwire = DetectorDeTravessia(self.detection_zones)
        self.last_error = None
        self._snapshot_lock = threading.Lock()
        self._latest_detections = []
        self._latest_detections_at = 0.0
        self._pending_hit_count = 0
        self._miss_count = 0
        self.capture_frames_enqueued = 0
        self.capture_frames_dropped = 0
        self.processed_frames = 0
        self._started_at = time.time()
        self._capture_timestamps = deque(maxlen=120)
        self._inference_timestamps = deque(maxlen=120)
        self._advanced_infer_latencies_ms = deque(maxlen=240)
        self._frame_age_sum_ms = 0.0
        self._frame_age_samples = 0
        self._frame_age_last_ms = 0.0
        self._capture_stream_info = {
            "codec": None,
            "width": None,
            "height": None,
            "fps": None,
        }
        self._live_view_lock = threading.Lock()
        self._live_view_sessions: dict[str, dict[str, Any]] = {}
        self.force_awake_until = 0.0
        self._last_applied_qos_signature = None
        # ── Confirmação semântica sob demanda ────────────────────────────────
        # Quando o MOG2 acusa movimento, roda o detector de objetos APENAS no
        # recorte da região que mudou (e só a cada N segundos). Isso rotula o
        # evento ("pessoa", "carro") sem pagar IA contínua: o custo existe só no
        # instante do movimento, e o recorte é ampliado para o tamanho de entrada
        # do modelo — o que ajuda justamente os alvos pequenos/distantes.
        # Por padrão o modo é 'enrich': NUNCA descarta movimento (a gravação
        # continua garantida); apenas acrescenta o objeto reconhecido. O modo
        # 'strict' (descartar movimento sem objeto) é opt-in consciente.
        self.semantic_enabled = str(os.getenv("MOTION_SEMANTIC_CONFIRM", "true")).strip().lower() != "false"
        self.semantic_strict = str(os.getenv("MOTION_SEMANTIC_STRICT", "false")).strip().lower() == "true"
        self.semantic_min_interval = max(1.0, float(os.getenv("MOTION_SEMANTIC_MIN_INTERVAL_SECONDS", "3")))
        self.semantic_input_size = int(os.getenv("MOTION_SEMANTIC_INPUT_SIZE", "320"))
        self._last_semantic_at = 0.0
        self.semantic_runs = 0
        self.semantic_confirmations = 0
        self.semantic_errors = 0
        self.semantic_last_labels: list[str] = []
        # ── FPS de captura anômalo (timestamp quebrado na câmera) ────────────
        # Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
        # Quando os timestamps da câmera estão quebrados, o decoder para de se
        # cadenciar pelo relógio do stream e lê o mais rápido que consegue: CPU
        # a 100% sem que ninguém saiba por quê. O guarda só DENUNCIA (o DRAC não
        # mata captura por suspeita); o freio de CPU é opt-in.
        self._capture_rate_guard = CaptureRateGuard(
            expected_fps=0.0,
            margin_fps=float(os.getenv("AI_CAPTURE_RATE_MARGIN_FPS", "10")),
            sustain_seconds=float(os.getenv("AI_CAPTURE_RATE_SUSTAIN_SECONDS", "30")),
            cooldown_seconds=float(os.getenv("AI_CAPTURE_RATE_ALERT_COOLDOWN_SECONDS", "300")),
        )
        self._capture_rate_throttle_enabled = str(
            os.getenv("AI_CAPTURE_RATE_THROTTLE_ENABLED", "false")
        ).strip().lower() in ("1", "true", "yes", "on")

    @property
    def advanced_analysis_type(self):
        return None if self.analysis_type == "motion" else self.analysis_type

    def _normalize_view_mode(self, view_mode: str | None) -> str:
        normalized = (view_mode or "").strip().lower()
        return "selected" if normalized == "selected" else "grid"

    def _parse_float_list(self, raw: str, default: list[float]) -> list[float]:
        values: list[float] = []
        for part in str(raw or "").split(","):
            token = part.strip()
            if not token:
                continue
            try:
                values.append(float(token))
            except Exception:
                continue
        if not values:
            return default
        return values

    def _parse_int_list(self, raw: str, default: list[int]) -> list[int]:
        values: list[int] = []
        for part in str(raw or "").split(","):
            token = part.strip()
            if not token:
                continue
            try:
                values.append(int(token))
            except Exception:
                continue
        if not values:
            return default
        return values

    def _read_system_cpu_percent(self) -> float | None:
        try:
            with open("/proc/stat", "r", encoding="utf-8") as handle:
                first = handle.readline().strip()
            if not first.startswith("cpu "):
                return None
            parts = [int(item) for item in first.split()[1:] if item.isdigit()]
            if len(parts) < 4:
                return None
            idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
            total = sum(parts)
            if self._cpu_prev_total is None or self._cpu_prev_idle is None:
                self._cpu_prev_total = total
                self._cpu_prev_idle = idle
                return None
            total_delta = total - self._cpu_prev_total
            idle_delta = idle - self._cpu_prev_idle
            self._cpu_prev_total = total
            self._cpu_prev_idle = idle
            if total_delta <= 0:
                return None
            busy = (total_delta - idle_delta) / total_delta
            return max(0.0, min(100.0, busy * 100.0))
        except Exception:
            return None

    def _build_adaptive_profiles(self) -> dict[str, dict[str, list[float] | list[int]]]:
        selected_fps_factors = self._parse_float_list(
            os.getenv("AI_ADAPTIVE_SELECTED_FPS_FACTORS", "1.0,0.85,0.70"),
            [1.0, 0.85, 0.70],
        )
        grid_fps_factors = self._parse_float_list(
            os.getenv("AI_ADAPTIVE_GRID_FPS_FACTORS", "1.0,0.85"),
            [1.0, 0.85],
        )
        selected_imgsz_steps = self._parse_int_list(
            os.getenv("AI_ADAPTIVE_SELECTED_IMGSZ_STEPS", "640,512,416"),
            [640, 512, 416],
        )
        grid_imgsz_steps = self._parse_int_list(
            os.getenv("AI_ADAPTIVE_GRID_IMGSZ_STEPS", "512,416"),
            [512, 416],
        )
        selected_resolution_scales = self._parse_float_list(
            os.getenv("AI_ADAPTIVE_SELECTED_RESOLUTION_SCALES", "1.0,0.92,0.84,0.76"),
            [1.0, 0.92, 0.84, 0.76],
        )
        grid_resolution_scales = self._parse_float_list(
            os.getenv("AI_ADAPTIVE_GRID_RESOLUTION_SCALES", "1.0,0.90,0.80"),
            [1.0, 0.90, 0.80],
        )
        return {
            "selected": {
                "fps_factors": selected_fps_factors,
                "imgsz_steps": sorted(set(selected_imgsz_steps), reverse=True),
                "resolution_scales": sorted(set(selected_resolution_scales), reverse=True),
            },
            "grid": {
                "fps_factors": grid_fps_factors,
                "imgsz_steps": sorted(set(grid_imgsz_steps), reverse=True),
                "resolution_scales": sorted(set(grid_resolution_scales), reverse=True),
            },
            "base": {
                "fps_factors": selected_fps_factors,
                "imgsz_steps": sorted(set(selected_imgsz_steps), reverse=True),
                "resolution_scales": sorted(set(selected_resolution_scales), reverse=True),
            },
        }

    def _adaptive_profile_for_mode(self, qos_mode: str) -> dict[str, list[float] | list[int]]:
        if qos_mode == "grid":
            return self._adaptive_profiles["grid"]
        return self._adaptive_profiles.get(qos_mode, self._adaptive_profiles["selected"])

    def _advance_adaptive_degradation(self, mode_key: str):
        state = self._adaptive_state.get(mode_key)
        if state is None:
            return
        profile = self._adaptive_profile_for_mode(mode_key)
        fps_factors = profile["fps_factors"]
        imgsz_steps = profile["imgsz_steps"]
        resolution_scales = profile["resolution_scales"]
        if state["fps_idx"] < len(fps_factors) - 1:
            state["fps_idx"] += 1
            return
        if state["imgsz_idx"] < len(imgsz_steps) - 1:
            state["imgsz_idx"] += 1
            return
        if state["res_idx"] < len(resolution_scales) - 1:
            state["res_idx"] += 1

    def _relax_adaptive_degradation(self, mode_key: str):
        state = self._adaptive_state.get(mode_key)
        if state is None:
            return
        if state["res_idx"] > 0:
            state["res_idx"] -= 1
            return
        if state["imgsz_idx"] > 0:
            state["imgsz_idx"] -= 1
            return
        if state["fps_idx"] > 0:
            state["fps_idx"] -= 1

    def _adaptive_mode_key(self) -> str:
        if self.current_qos_mode == "grid":
            return "grid"
        if self.current_qos_mode == "selected":
            return "selected"
        return "base"

    def _evaluate_adaptive_degradation(self):
        if not self.adaptive_enabled or not self.advanced_analysis_type:
            return
        now = time.time()
        if now - self._adaptive_last_eval_at < self.adaptive_window_seconds:
            return
        self._adaptive_last_eval_at = now

        delta_enqueued = max(0, self.capture_frames_enqueued - self._adaptive_last_capture_enqueued)
        delta_dropped = max(0, self.capture_frames_dropped - self._adaptive_last_capture_dropped)
        self._adaptive_last_capture_enqueued = self.capture_frames_enqueued
        self._adaptive_last_capture_dropped = self.capture_frames_dropped
        drop_ratio = float(delta_dropped) / float(max(1, delta_enqueued))
        cpu_percent = self._read_system_cpu_percent()
        mode_key = self._adaptive_mode_key()

        overloaded = drop_ratio >= self.adaptive_drop_ratio_high
        if cpu_percent is not None and cpu_percent >= self.adaptive_cpu_high:
            overloaded = True
        recovered = drop_ratio <= self.adaptive_drop_ratio_low
        if cpu_percent is not None and cpu_percent > self.adaptive_cpu_low:
            recovered = False

        self._adaptive_last_metrics = {
            "drop_ratio": drop_ratio,
            "cpu_percent": cpu_percent,
            "window_enqueued": float(delta_enqueued),
            "window_dropped": float(delta_dropped),
        }

        elapsed_change = now - self._adaptive_last_change_at
        if overloaded and elapsed_change >= self.adaptive_degrade_cooldown_seconds:
            before = dict(self._adaptive_state[mode_key])
            self._advance_adaptive_degradation(mode_key)
            after = self._adaptive_state[mode_key]
            if before != after:
                self._adaptive_last_change_at = now
        elif recovered and elapsed_change >= self.adaptive_recover_cooldown_seconds:
            before = dict(self._adaptive_state[mode_key])
            self._relax_adaptive_degradation(mode_key)
            after = self._adaptive_state[mode_key]
            if before != after:
                self._adaptive_last_change_at = now

    def start(self):
        if self.running:
            return
        self.running = True
        
        # Thread de captura
        self.capture_thread = threading.Thread(target=self._capture_frames)
        self.capture_thread.daemon = True
        self.capture_thread.start()
        
        # Thread de processamento
        self.thread = threading.Thread(target=self._process)
        self.thread.daemon = True
        self.thread.start()

    def stop(self):
        self.running = False
        if self.capture_thread:
            self.capture_thread.join(timeout=2)
        if self.thread:
            self.thread.join(timeout=2)

    def _sanitize_url(self, url):
        try:
            parsed = urlsplit(url)
            if "@" not in parsed.netloc:
                return url
            safe_netloc = f"<redacted>@{parsed.netloc.rsplit('@', 1)[1]}"
            return urlunsplit((parsed.scheme, safe_netloc, parsed.path, parsed.query, parsed.fragment))
        except Exception:
            return "<rtsp-url-redacted>"

    def _fourcc_to_codec(self, fourcc):
        try:
            value = int(fourcc or 0)
            if value <= 0:
                return None
            text = "".join(chr((value >> 8 * i) & 0xFF) for i in range(4)).strip("\x00 ").lower()
            if not text:
                return None
            aliases = {
                "h264": "h264",
                "avc1": "h264",
                "x264": "h264",
                "hev1": "hevc",
                "hvc1": "hevc",
                "hevc": "hevc",
                "h265": "hevc",
                "mjpg": "mjpeg",
            }
            return aliases.get(text, text)
        except Exception:
            return None

    def _note_capture_rate(self) -> float:
        """Contabiliza UM frame consumido e denuncia FPS de captura anômalo.

        NUNCA derruba a captura: o DRAC é VMS com valor probatório e matar o
        stream por suspeita pode custar exatamente o instante que interessava.
        Devolve o sleep (s) sugerido pelo freio de CPU — 0.0 quando não há
        anomalia OU quando o throttle está desligado (o default).
        """
        try:
            event = self._capture_rate_guard.observe()
        except Exception:
            return 0.0
        if event:
            logger.warning(
                "[%s] FPS de captura ANÔMALO: %.1f fps observados x %.1f esperados (limite %.1f) "
                "sustentados por %.0fs — assinatura de TIMESTAMP QUEBRADO NA CÂMERA: o decoder "
                "perde a cadência do stream e lê o mais rápido que consegue, queimando CPU. "
                "A análise e a gravação seguem; verifique relógio/RTP da câmera (ou force TCP).",
                self.camera_id,
                event["observed_fps"],
                event["expected_fps"],
                event["threshold_fps"],
                event["sustained_seconds"],
            )
        if not self._capture_rate_throttle_enabled:
            return 0.0
        try:
            return float(self._capture_rate_guard.suggested_sleep_seconds())
        except Exception:
            return 0.0

    def _rate_from_timestamps(self, timestamps):
        if len(timestamps) < 2:
            return 0.0
        elapsed = max(0.001, timestamps[-1] - timestamps[0])
        return (len(timestamps) - 1) / elapsed

    def _update_capture_stream_info(self, cap, frame=None):
        info = dict(self._capture_stream_info)
        try:
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
            codec = self._fourcc_to_codec(cap.get(cv2.CAP_PROP_FOURCC))
            if frame is not None:
                frame_height, frame_width = frame.shape[:2]
                width = int(frame_width or width)
                height = int(frame_height or height)
            info.update({
                "codec": codec or info.get("codec"),
                "width": width if width > 0 else info.get("width"),
                "height": height if height > 0 else info.get("height"),
                "fps": round(fps, 3) if fps > 0 else info.get("fps"),
            })
            self._capture_stream_info = info
            # O FPS declarado pela fonte é a referência do guarda de taxa (valor
            # inválido/absurdo é ignorado lá dentro, mantendo o fallback).
            self._capture_rate_guard.set_expected_fps(info.get("fps"))
        except Exception:
            pass

    def source_state(self) -> dict:
        record_subtype = self.source_info.get("recordSubtype")
        record_channel = self.source_info.get("recordChannel")
        live_subtype = self.source_info.get("liveSubtype")
        live_channel = self.source_info.get("liveChannel")
        analytics_subtype = self.source_info.get("analyticsSubtype")
        analytics_channel = self.source_info.get("analyticsChannel")
        analytics_url = self.source_info.get("analyticsRtspUrl") or self.source_info.get("analyticsSourceUrlSanitized") or self._sanitize_url(self.rtsp_url)
        return {
            "kind": self.source_info.get("sourceKind") or self.source_info.get("kind") or "direct_camera",
            "uses_mediamtx": bool(self.source_info.get("usesMediaMtx", False)),
            "usesMediaMtx": bool(self.source_info.get("usesMediaMtx", False)),
            "audio_requested": bool(self.source_info.get("audioRequested", False)),
            "audioRequested": bool(self.source_info.get("audioRequested", False)),
            "audio_processed": False,
            "audioProcessed": False,
            "analytics_rtsp_url": analytics_url,
            "analyticsRtspUrl": analytics_url,
            "analytics_source_url_sanitized": self.source_info.get("analyticsSourceUrlSanitized") or self._sanitize_url(self.rtsp_url),
            "analyticsSourceUrlSanitized": self.source_info.get("analyticsSourceUrlSanitized") or self._sanitize_url(self.rtsp_url),
            "analytics_source_codec": self.source_info.get("analyticsSourceCodec"),
            "analyticsSourceCodec": self.source_info.get("analyticsSourceCodec"),
            "analytics_transcoded_for_ai": bool(self.source_info.get("analyticsTranscodedForAi", False)),
            "analyticsTranscodedForAi": bool(self.source_info.get("analyticsTranscodedForAi", False)),
            "analytics_media_mtx_path": self.source_info.get("analyticsMediaMtxPath"),
            "analyticsMediaMtxPath": self.source_info.get("analyticsMediaMtxPath"),
            "analytics_fallback_reason": self.source_info.get("analyticsFallbackReason"),
            "analyticsFallbackReason": self.source_info.get("analyticsFallbackReason"),
            "record_subtype": record_subtype,
            "recordSubtype": record_subtype,
            "record_channel": record_channel,
            "recordChannel": record_channel,
            "live_subtype": live_subtype,
            "liveSubtype": live_subtype,
            "live_channel": live_channel,
            "liveChannel": live_channel,
            "analytics_subtype": analytics_subtype,
            "analyticsSubtype": analytics_subtype,
            "analytics_channel": analytics_channel,
            "analyticsChannel": analytics_channel,
        }

    def capture_stream_state(self) -> dict:
        avg_frame_age_ms = (
            self._frame_age_sum_ms / self._frame_age_samples
            if self._frame_age_samples > 0 else 0.0
        )
        return {
            **self._capture_stream_info,
            "capture_fps": round(float(self._rate_from_timestamps(self._capture_timestamps)), 3),
            "inference_fps": round(float(self._rate_from_timestamps(self._inference_timestamps)), 3),
            "frame_age_last_ms": round(float(self._frame_age_last_ms), 3),
            "frame_age_avg_ms": round(float(avg_frame_age_ms), 3),
            "latest_frame_only": True,
            "buffer_size": 1,
            "queue_size": self.frame_queue.qsize(),
            "dropped_frames": self.capture_frames_dropped,
            "last_capture_success_at": self.last_capture_success_at,
            "last_capture_failure_at": self.last_capture_failure_at,
            "consecutive_capture_failures": self.consecutive_capture_failures,
            # Diagnóstico do FPS anômalo (timestamp quebrado): números crus para
            # o operador/health, sem interpretar por ele.
            "capture_rate_guard": self._capture_rate_guard.state(),
        }

    def readiness_state(self, max_frame_age_seconds: float = 20.0) -> dict:
        now = time.time()
        awake = self._is_awake()
        startup_grace = max(0.0, now - self._started_at) < max_frame_age_seconds
        frame_age_seconds = None if self.last_seen <= 0 else max(0.0, now - self.last_seen)
        ready = bool(self.running)
        reason = None
        if not self.running:
            ready = False
            reason = "processor_stopped"
        elif awake and not startup_grace and self.last_seen <= 0:
            ready = False
            reason = "no_frame_received"
        elif awake and frame_age_seconds is not None and frame_age_seconds > max_frame_age_seconds:
            ready = False
            reason = "last_frame_stale"
        elif awake and self.consecutive_capture_failures >= 3:
            ready = False
            reason = "capture_repeatedly_failed"
        return {
            "ready": ready,
            "reason": reason,
            "awake": awake,
            "frame_age_seconds": round(frame_age_seconds, 3) if frame_age_seconds is not None else None,
            "consecutive_capture_failures": self.consecutive_capture_failures,
        }

    def inference_state(self, capture_ready: bool | None = None, max_frame_age_seconds: float = 20.0, now=None) -> dict:
        """Saúde da INFERÊNCIA avançada deste processador (item 1 do watchdog).

        Só OBSERVA: nenhum contador é tocado, nenhum caminho de movimento é
        alterado. Com a IA de objeto/face desligada (analysis_type='motion') o
        veredito é `not_applicable` — nunca degradado.

        `capture_ready` pode ser injetado pelo /health, que já calculou o
        readiness de captura; sem ele, é recalculado aqui.
        """
        moment = time.time() if now is None else float(now)
        if capture_ready is None:
            capture_ready = bool(self.readiness_state(max_frame_age_seconds)["ready"])
        last_inference_at = float(self._inference_timestamps[-1]) if self._inference_timestamps else 0.0
        avg_ms = (
            self.advanced_infer_sum_ms / self.advanced_infer_runs
            if self.advanced_infer_runs > 0 else 0.0
        )
        # Mesmo intervalo que o _process usa para decidir quando inferir.
        expected_interval = 1.0 / max(0.5, float(self.advanced_process_fps))
        settings = watchdog_settings()
        return evaluate_inference_health(
            advanced_analysis_type=self.advanced_analysis_type,
            runs=self.advanced_infer_runs,
            errors=self.advanced_infer_errors,
            last_inference_at=last_inference_at,
            last_duration_ms=self.advanced_infer_last_ms,
            avg_duration_ms=avg_ms,
            expected_interval_seconds=expected_interval,
            capture_ready=bool(capture_ready),
            awake=self._is_awake(),
            started_at=self._started_at,
            now=moment,
            stall_multiplier=settings["multiplier"],
            min_stall_seconds=settings["minimum"],
            max_stall_seconds=settings["maximum"],
            startup_grace_seconds=settings["startup_grace"],
            last_error=self.last_error,
        )

    def _is_awake(self):
        return self.motion_trigger != "CAMERA" or time.time() < self.wakeup_until or self._has_active_live_view_session()

    def _cleanup_live_view_sessions_locked(self, now: float):
        expired = [
            session_id
            for session_id, payload in self._live_view_sessions.items()
            if float(payload.get("until", 0.0)) <= now
        ]
        for session_id in expired:
            self._live_view_sessions.pop(session_id, None)
        self.force_awake_until = max((float(payload.get("until", 0.0)) for payload in self._live_view_sessions.values()), default=0.0)

    def _live_view_mode_counts_locked(self) -> dict[str, int]:
        selected_count = 0
        grid_count = 0
        for payload in self._live_view_sessions.values():
            mode = self._normalize_view_mode(str(payload.get("view_mode", "grid")))
            if mode == "selected":
                selected_count += 1
            else:
                grid_count += 1
        return {"selected": selected_count, "grid": grid_count}

    def _current_live_view_mode_locked(self) -> str | None:
        counts = self._live_view_mode_counts_locked()
        if counts["selected"] > 0:
            return "selected"
        if counts["grid"] > 0:
            return "grid"
        return None

    def _apply_qos_mode(self, qos_mode: str):
        if self.advanced_analysis_type:
            if qos_mode == "grid":
                process_fps = max(0.5, float(self.grid_process_fps))
                advanced_fps = max(0.5, float(self.grid_advanced_process_fps))
                frame_width = max(160, int(self.grid_frame_width))
                frame_height = max(120, int(self.grid_frame_height))
                input_size_hint = max(0, int(self.grid_input_size))
            elif qos_mode == "selected":
                process_fps = max(0.5, float(self.selected_process_fps))
                advanced_fps = max(0.5, float(self.selected_advanced_process_fps))
                frame_width = max(160, int(self.selected_frame_width))
                frame_height = max(120, int(self.selected_frame_height))
                input_size_hint = max(0, int(self.selected_input_size))
            else:
                process_fps = max(0.5, float(self.base_process_fps))
                advanced_fps = max(0.5, float(self.base_advanced_process_fps))
                frame_width = max(160, int(self.base_frame_width))
                frame_height = max(120, int(self.base_frame_height))
                input_size_hint = max(0, int(self.base_input_size))
            mode_key = "grid" if qos_mode == "grid" else "selected" if qos_mode == "selected" else "base"
            if self.adaptive_enabled:
                profile = self._adaptive_profile_for_mode(mode_key)
                state = self._adaptive_state.get(mode_key, {"fps_idx": 0, "imgsz_idx": 0, "res_idx": 0})
                fps_factors = profile["fps_factors"]
                imgsz_steps = profile["imgsz_steps"]
                resolution_scales = profile["resolution_scales"]
                fps_index = max(0, min(int(state["fps_idx"]), len(fps_factors) - 1))
                imgsz_index = max(0, min(int(state["imgsz_idx"]), len(imgsz_steps) - 1))
                res_index = max(0, min(int(state["res_idx"]), len(resolution_scales) - 1))
                process_fps = max(0.5, process_fps * float(fps_factors[fps_index]))
                advanced_fps = max(0.5, advanced_fps * float(fps_factors[fps_index]))
                input_size_hint = min(input_size_hint, max(128, int(imgsz_steps[imgsz_index])))
                res_scale = max(0.4, min(1.0, float(resolution_scales[res_index])))
                frame_width = max(160, int(round(frame_width * res_scale)))
                frame_height = max(120, int(round(frame_height * res_scale)))
        else:
            process_fps = max(0.5, float(self.base_process_fps))
            advanced_fps = max(0.5, float(self.base_advanced_process_fps))
            frame_width = max(160, int(self.base_frame_width))
            frame_height = max(120, int(self.base_frame_height))
            input_size_hint = 0

        self.process_fps = process_fps
        self.advanced_process_fps = advanced_fps
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.current_input_size_hint = input_size_hint if input_size_hint > 0 else None
        self.current_qos_mode = qos_mode

    def _refresh_qos_mode_locked(self):
        mode = self._current_live_view_mode_locked() if self.qos_live_enabled else None
        target_qos_mode = "selected" if mode == "selected" else "grid" if mode == "grid" else "base"
        mode_key = "grid" if target_qos_mode == "grid" else "selected" if target_qos_mode == "selected" else "base"
        state = self._adaptive_state.get(mode_key, {"fps_idx": 0, "imgsz_idx": 0, "res_idx": 0})
        signature = (
            target_qos_mode,
            int(state.get("fps_idx", 0)),
            int(state.get("imgsz_idx", 0)),
            int(state.get("res_idx", 0)),
            bool(self.adaptive_enabled),
        )
        if self.current_qos_mode == target_qos_mode and self._last_applied_qos_signature == signature:
            return
        self._apply_qos_mode(target_qos_mode)
        self._last_applied_qos_signature = signature
        logger.info(
            "[%s] QoS ativo=%s fps=%.2f analysis=%dx%d imgsz_hint=%s",
            self.camera_id,
            self.current_qos_mode,
            self.process_fps,
            self.frame_width,
            self.frame_height,
            self.current_input_size_hint or "default",
        )

    def _refresh_qos_mode(self):
        with self._live_view_lock:
            self._cleanup_live_view_sessions_locked(time.time())
            self._evaluate_adaptive_degradation()
            self._refresh_qos_mode_locked()

    def _has_active_live_view_session(self) -> bool:
        now = time.time()
        with self._live_view_lock:
            self._cleanup_live_view_sessions_locked(now)
            return bool(self._live_view_sessions)

    def touch_live_view_session(self, session_id: str, ttl_seconds: int = 20, view_mode: str = "grid") -> dict:
        normalized_session = (session_id or "").strip()
        if not normalized_session:
            raise ValueError("session_id obrigatório")

        ttl = max(5, min(120, int(ttl_seconds)))
        normalized_mode = self._normalize_view_mode(view_mode)
        now = time.time()
        until = now + ttl
        with self._live_view_lock:
            self._cleanup_live_view_sessions_locked(now)
            was_active = normalized_session in self._live_view_sessions
            self._live_view_sessions[normalized_session] = {"until": until, "view_mode": normalized_mode}
            self._cleanup_live_view_sessions_locked(now)
            self._refresh_qos_mode_locked()
            count = len(self._live_view_sessions)
            counts = self._live_view_mode_counts_locked()
            return {
                "status": "renewed" if was_active else "started",
                "session_id": normalized_session,
                "view_mode": normalized_mode,
                "active_sessions": count,
                "forced_awake": count > 0,
                "force_awake_until": self.force_awake_until,
                "ttl_seconds": ttl,
                "active_view_mode": self._current_live_view_mode_locked(),
                "view_mode_counts": counts,
                "qos_mode": self.current_qos_mode,
            }

    def stop_live_view_session(self, session_id: str) -> dict:
        normalized_session = (session_id or "").strip()
        if not normalized_session:
            raise ValueError("session_id obrigatório")

        now = time.time()
        with self._live_view_lock:
            self._cleanup_live_view_sessions_locked(now)
            removed = self._live_view_sessions.pop(normalized_session, None) is not None
            self._cleanup_live_view_sessions_locked(now)
            self._refresh_qos_mode_locked()
            count = len(self._live_view_sessions)
            counts = self._live_view_mode_counts_locked()
            return {
                "status": "stopped" if removed else "not_found",
                "session_id": normalized_session,
                "active_sessions": count,
                "forced_awake": count > 0,
                "force_awake_until": self.force_awake_until,
                "active_view_mode": self._current_live_view_mode_locked(),
                "view_mode_counts": counts,
                "qos_mode": self.current_qos_mode,
            }

    def live_view_state(self) -> dict:
        now = time.time()
        with self._live_view_lock:
            self._cleanup_live_view_sessions_locked(now)
            count = len(self._live_view_sessions)
            counts = self._live_view_mode_counts_locked()
            return {
                "active_sessions": count,
                "forced_awake": count > 0,
                "force_awake_until": self.force_awake_until,
                "active_view_mode": self._current_live_view_mode_locked(),
                "view_mode_counts": counts,
                "qos_mode": self.current_qos_mode,
                "feature_flags": {
                    "qos_live_enabled": self.qos_live_enabled,
                    "adaptive_feature_enabled": self.adaptive_feature_enabled,
                    "adaptive_enabled_for_camera": self.adaptive_enabled,
                    "adaptive_pilot_raw": self.adaptive_pilot_raw,
                },
                "adaptive": {
                    "enabled": self.adaptive_enabled,
                    "state": self._adaptive_state,
                    "metrics": self._adaptive_last_metrics,
                },
            }

    def _capture_frames(self):
        # NUNCA logar self.rtsp_url cru: _sanitize_url remove user:senha (invariante 1.2.v).
        logger.info("[%s] Iniciando captura: %s", self.camera_id, self._sanitize_url(self.rtsp_url))
        cap = None
        last_yield_time = 0
        grab_failures = 0

        while self.running:
            self.capture_loop_iterations += 1
            self._refresh_qos_mode()
            if not self._is_awake():
                if cap is not None:
                    cap.release()
                    cap = None
                    last_yield_time = 0
                time.sleep(0.25)
                continue

            if cap is None:
                cap = self._open_capture()
                self._update_capture_stream_info(cap)

            now = time.time()
            capture_interval = 1.0 / max(0.5, float(self.process_fps))
            if now - last_yield_time < capture_interval:
                # DRENA o stream entre análises: grab() consome o pacote do socket sem
                # o custo de converter/copiar a imagem. Sem isto, analisar a ~2fps um
                # stream de ~20fps acumula backpressure TCP e o MediaMTX derruba o
                # leitor lento ("write i/o timeout") a cada poucos minutos — churn de
                # sessão infinita + ~5s de detecção cega a cada reconexão (observado:
                # 71 kills/hora com 4 câmeras). grab() bloqueia até o próximo frame,
                # então o loop se auto-cadencia no FPS do stream.
                if cap.grab():
                    grab_failures = 0
                    # Cada frame DRENADO também conta para a taxa de captura: é
                    # justamente aqui que o timestamp quebrado aparece (grab()
                    # deveria bloquear até o próximo frame e passa a voltar na hora).
                    throttle = self._note_capture_rate()
                    if throttle > 0:
                        time.sleep(throttle)
                else:
                    grab_failures += 1
                    time.sleep(0.05)
                    if grab_failures >= 40:  # ~2s+ sem frames = stream caiu de verdade
                        self.consecutive_capture_failures += 1
                        self.last_capture_failure_at = time.time()
                        self.last_error = f"capture_failed (grab x{grab_failures})"
                        delay = compute_reconnect_delay(self.consecutive_capture_failures)
                        logger.warning("[%s] Falha na captura (grab), reconectando em %.1fs...", self.camera_id, delay)
                        cap.release()
                        time.sleep(delay)
                        cap = self._open_capture()
                        grab_failures = 0
                continue

            # A IA não precisa decodificar o FPS inteiro da câmera.
            # Com buffer baixo/nobuffer, ler no FPS de análise mantém o frame recente
            # e evita que FFmpeg/OpenCV consuma CPU decodificando frames descartados.
            ret, frame = cap.read()
            if not ret:
                self.consecutive_capture_failures += 1
                self.last_capture_failure_at = time.time()
                self.last_error = f"capture_failed ({self.consecutive_capture_failures} consecutive)"
                delay = compute_reconnect_delay(self.consecutive_capture_failures)
                logger.warning("[%s] Falha na captura, reconectando em %.1fs...", self.camera_id, delay)
                cap.release()
                time.sleep(delay)
                cap = self._open_capture()
                continue
            
            capture_timestamp = time.time()
            self.last_seen = capture_timestamp
            self.last_capture_success_at = capture_timestamp
            self.consecutive_capture_failures = 0
            self._note_capture_rate()
            if isinstance(self.last_error, str) and self.last_error.startswith("capture_failed"):
                self.last_error = None
            self._capture_timestamps.append(capture_timestamp)
            self._update_capture_stream_info(cap, frame)
            
            last_yield_time = self.last_seen
            if not self.frame_queue.full():
                self.frame_queue.put((frame, capture_timestamp))
                self.capture_frames_enqueued += 1
            else:
                # Fila cheia: descarta o antigo e coloca o novo (mantém tempo real)
                try:
                    self.frame_queue.get_nowait()
                    self.frame_queue.put((frame, capture_timestamp))
                    self.capture_frames_dropped += 1
                    self.capture_frames_enqueued += 1
                except:
                    pass
        
        if cap is not None:
            cap.release()

    def _open_capture(self):
        # fflags;nobuffer|flags;low_delay instrui o FFMPEG a não fazer cache de vídeo,
        # garantindo que o primeiro frame lido seja exatamente o momento presente.
        capture_options = os.getenv("AI_OPENCV_CAPTURE_OPTIONS", "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|stimeout;5000000").strip()
        if capture_options:
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = capture_options
        cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        # Evita travar indefinidamente no primeiro frame quando a câmera oscila.
        try:
            if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
                cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000)
            if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
                cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000)
        except Exception:
            pass
        return cap

    def _resize_for_advanced(self, frame):
        height, width = frame.shape[:2]
        if width <= 0 or height <= 0:
            return frame

        scale = min(self.frame_width / width, self.frame_height / height)
        if not np.isfinite(scale) or scale <= 0:
            return frame

        target_width = max(1, int(round(width * scale)))
        target_height = max(1, int(round(height * scale)))
        if target_width == width and target_height == height:
            return frame
        return cv2.resize(frame, (target_width, target_height))

    def _debounce_seconds(self, event_type):
        return self.motion_debounce_seconds if event_type == "MOTION_DETECTED" else self.detect_debounce_seconds

    def _process(self):
        if self.advanced_analysis_type:
            logger.info("[%s] Iniciando IA global 'motion+%s' (%s fps)...", self.camera_id, self.advanced_analysis_type, self.process_fps)
            try:
                # Pré-carrega o detector no registry (serializado, sem duplicatas)
                registry.ensure_detector(self.advanced_analysis_type)
            except Exception as exc:
                self.last_error = str(exc)
                logger.error("[%s] Falha ao carregar detector '%s': %s", self.camera_id, self.advanced_analysis_type, exc)
                return
        else:
            logger.info("[%s] Iniciando IA global 'motion' (%s fps)...", self.camera_id, self.process_fps)

        while self.running:
            self.process_loop_iterations += 1
            self._refresh_qos_mode()
            if self.frame_queue.empty():
                time.sleep(0.01)
                continue

            queued = self.frame_queue.get()
            if isinstance(queued, tuple) and len(queued) == 2:
                frame, capture_timestamp = queued
            else:
                frame = queued
                capture_timestamp = time.time()

            # EDGE AI HIBERNATION LOGIC
            if not self._is_awake():
                # O servidor está dormindo aguardando o ONVIF da câmera
                self.last_advanced_infer_at = time.time()
                continue

            try:
                current_time = time.time()
                frame_age_ms = max(0.0, (current_time - float(capture_timestamp)) * 1000.0)
                self._frame_age_last_ms = frame_age_ms
                self._frame_age_sum_ms += frame_age_ms
                self._frame_age_samples += 1
                self.processed_frames += 1
                detections = self.motion_detector.infer(frame)
                # Movimento acusado → confirma semanticamente no recorte (só no
                # modo 'motion'; nos modos general/face o detector já roda no
                # frame inteiro e a confirmação seria trabalho duplicado).
                if detections and self.semantic_enabled and not self.advanced_analysis_type:
                    detections = self._confirm_motion_semantically(frame, detections, current_time)
                advanced_detections = []
                should_run_advanced = (
                    self.advanced_analysis_type
                    and current_time - self.last_advanced_infer_at >= (1.0 / max(0.5, float(self.advanced_process_fps)))
                )
                if should_run_advanced:
                    det = registry.ensure_detector(self.advanced_analysis_type)
                    advanced_frame = self._resize_for_advanced(frame)
                    advanced_height, advanced_width = advanced_frame.shape[:2]
                    # Detecção por REGIÃO (flag do detector, padrão DESLIGADA): as
                    # caixas de movimento deste mesmo frame viram os recortes onde
                    # o modelo roda. Desligada, `extra_infer_kwargs` é {} e a
                    # chamada abaixo é exatamente a de hoje.
                    extra_infer_kwargs = self._advanced_infer_kwargs(
                        det,
                        detections,
                        frame.shape[:2],
                        (advanced_height, advanced_width),
                    )
                    # O detector compartilhado gerencia a inferência thread-safe.
                    infer_started_at = time.time()
                    try:
                        advanced_detections = det.infer(
                            advanced_frame,
                            context_key=self.camera_id,
                            input_size_hint=self.current_input_size_hint,
                            **extra_infer_kwargs,
                        )
                    except Exception:
                        self.advanced_infer_errors += 1
                        raise
                    infer_elapsed_ms = max(0.0, (time.time() - infer_started_at) * 1000.0)
                    self.advanced_infer_runs += 1
                    self._inference_timestamps.append(time.time())
                    self.advanced_infer_sum_ms += infer_elapsed_ms
                    self.advanced_infer_last_ms = infer_elapsed_ms
                    self._advanced_infer_latencies_ms.append(infer_elapsed_ms)
                    detector_event_type = getattr(det, "event_type", None)
                    for detection in advanced_detections:
                        if not detection.event_type and detector_event_type:
                            detection.event_type = detector_event_type
                        detection.extra = {
                            **(detection.extra or {}),
                            "frameWidth": int(advanced_width),
                            "frameHeight": int(advanced_height),
                        }
                    detections.extend(advanced_detections)
                    self.last_advanced_infer_at = current_time

                    # ── CRUZAMENTO DE LINHA ──────────────────────────────
                    #
                    # Só aqui, e não no caminho semântico: este detector roda
                    # com `context_key=self.camera_id`, ou seja, COM
                    # rastreamento. Sem identidade entre quadros não existe
                    # trajeto, e sem trajeto não há travessia — só se saberia
                    # que "há alguém de cada lado", que é outra pergunta.
                    if self.tripwire.ativo:
                        try:
                            for t in self.tripwire.avaliar(advanced_detections, advanced_width, advanced_height):
                                if not t.get("proibido"):
                                    continue  # travessia no sentido permitido: registrada, não alarmada
                                detections.append(Detection(
                                    label=t.get("label") or "objeto",
                                    confidence=float(t.get("confidence") or 0.0),
                                    bbox=[0, 0, 0, 0],
                                    event_type="LINE_CROSSED",
                                    extra={
                                        "linhaId": t.get("linhaId"),
                                        "linhaNome": t.get("linhaNome"),
                                        "sentido": t.get("sentido"),
                                        "trackId": t.get("trackId"),
                                        "frameWidth": int(advanced_width),
                                        "frameHeight": int(advanced_height),
                                    },
                                ))
                        except Exception as exc:
                            # Perímetro não pode derrubar a análise: falhar aqui
                            # deixaria a câmera sem detecção NENHUMA.
                            self.last_error = f"tripwire: {exc}"
                            logger.warning("[%s] tripwire falhou: %s", self.camera_id, exc)

                # Snapshot "ao vivo" para overlays (sem debounce de evento).
                if self.advanced_analysis_type:
                    live_overlay = [d for d in detections if (d.event_type or "") != "MOTION_DETECTED"]
                    if should_run_advanced or live_overlay:
                        self._store_live_detections(live_overlay, current_time)
                else:
                    self._store_live_detections(self._overlay_detections(detections), current_time)
            except Exception as exc:
                self.last_error = str(exc)
                logger.warning("[%s] erro inferência: %s", self.camera_id, exc)
                time.sleep(1)
                continue

            if detections and self.emit_events:
                ready = []
                for detection in detections:
                    event_type = detection.event_type or "AI_DETECTED"
                    last_event_time = self.last_event_by_type.get(event_type, 0)
                    if current_time - last_event_time > self._debounce_seconds(event_type):
                        ready.append(detection)
                        self.last_event_by_type[event_type] = current_time
                if ready:
                    self._report_detections(ready)

            # Pausa para aliviar CPU entre frames
            time.sleep(0.02)

    @staticmethod
    def _motion_boxes_for_advanced(motion_detections, frame_shape, advanced_shape) -> list:
        """Caixas de movimento nas coordenadas do frame que a IA de objeto analisa.

        O movimento roda no frame ORIGINAL e a IA de objeto num frame reduzido
        (`_resize_for_advanced`). Sem reescalar aqui, a região sairia deslocada e
        o alvo pequeno — que é justamente o motivo de existir o recorte — ficaria
        de fora. Só MOTION_DETECTED vira região; detecção de objeto não.
        """
        try:
            frame_height, frame_width = int(frame_shape[0]), int(frame_shape[1])
            advanced_height, advanced_width = int(advanced_shape[0]), int(advanced_shape[1])
        except Exception:
            return []
        if frame_width <= 0 or frame_height <= 0:
            return []
        scale_x = advanced_width / float(frame_width)
        scale_y = advanced_height / float(frame_height)
        boxes = []
        for detection in motion_detections or []:
            if (getattr(detection, "event_type", None) or "") != "MOTION_DETECTED":
                continue
            bbox = getattr(detection, "bbox", None)
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            try:
                x1, y1, x2, y2 = (float(value) for value in bbox)
            except Exception:
                continue
            boxes.append(
                (
                    int(round(x1 * scale_x)),
                    int(round(y1 * scale_y)),
                    int(round(x2 * scale_x)),
                    int(round(y2 * scale_y)),
                )
            )
        return boxes

    def _advanced_infer_kwargs(self, detector, motion_detections, frame_shape, advanced_shape) -> dict:
        """Argumentos extras da inferência avançada.

        As caixas só são montadas quando o detector declara
        `accepts_motion_regions` (flag GENERAL_REGION_DETECTION ligada). Com a
        flag desligada — o padrão, e o estado de produção — devolve {} e a
        chamada de inferência continua idêntica à de hoje.
        """
        if not getattr(detector, "accepts_motion_regions", False):
            return {}
        return {
            "motion_boxes": self._motion_boxes_for_advanced(motion_detections, frame_shape, advanced_shape),
        }

    def _confirm_motion_semantically(self, frame, motion_detections, current_time):
        """Roda o detector de objetos SÓ no recorte do movimento.

        Devolve a lista de detecções (possivelmente enriquecida com o objeto
        reconhecido). Em modo 'strict', detecções sem objeto relevante são
        removidas — em 'enrich' (padrão) nada é descartado.

        Falha SEMPRE de forma segura: qualquer erro aqui devolve o movimento
        original intacto, porque perder gravação é pior do que perder o rótulo.
        """
        if current_time - self._last_semantic_at < self.semantic_min_interval:
            return motion_detections
        self._last_semantic_at = current_time

        try:
            detector = registry.ensure_detector("general")
        except Exception as exc:
            self.semantic_errors += 1
            self.last_error = f"semantic_load: {exc}"
            return motion_detections

        frame_height, frame_width = frame.shape[:2]
        confirmed: list = []
        labels: list[str] = []

        for detection in motion_detections:
            bbox = getattr(detection, "bbox", None)
            if not isinstance(bbox, list) or len(bbox) != 4:
                confirmed.append(detection)
                continue

            # Margem de 25% em volta do objeto: o MOG2 marca só a parte que se
            # MOVEU (ex.: pernas), e o detector precisa do corpo inteiro.
            x1, y1, x2, y2 = [int(v) for v in bbox]
            margin_x = int((x2 - x1) * 0.25) + 8
            margin_y = int((y2 - y1) * 0.25) + 8
            cx1 = max(0, x1 - margin_x)
            cy1 = max(0, y1 - margin_y)
            cx2 = min(frame_width, x2 + margin_x)
            cy2 = min(frame_height, y2 + margin_y)
            if cx2 - cx1 < 16 or cy2 - cy1 < 16:
                confirmed.append(detection)
                continue

            try:
                crop = frame[cy1:cy2, cx1:cx2]
                self.semantic_runs += 1
                # context_key=None: sem tracking (o recorte muda de origem a cada
                # evento; rastrear aqui produziria IDs sem sentido).
                objects = detector.infer(crop, context_key=None, input_size_hint=self.semantic_input_size)
            except Exception as exc:
                self.semantic_errors += 1
                self.last_error = f"semantic_infer: {exc}"
                confirmed.append(detection)
                continue

            if not objects:
                # Nada reconhecido: em strict o movimento é descartado (galho,
                # sombra, chuva); em enrich segue como movimento sem rótulo.
                if not self.semantic_strict:
                    confirmed.append(detection)
                continue

            best = max(objects, key=lambda o: float(getattr(o, "confidence", 0.0)))
            label = str(getattr(best, "label", "") or "objeto")
            labels.append(label)
            self.semantic_confirmations += 1

            # Reposiciona a caixa do objeto nas coordenadas do frame inteiro.
            obj_bbox = getattr(best, "bbox", None)
            if isinstance(obj_bbox, list) and len(obj_bbox) == 4:
                ox1, oy1, ox2, oy2 = [int(v) for v in obj_bbox]
                crop_h, crop_w = crop.shape[:2]
                scale_x = (cx2 - cx1) / max(1, crop_w)
                scale_y = (cy2 - cy1) / max(1, crop_h)
                detection.bbox = [
                    int(cx1 + ox1 * scale_x),
                    int(cy1 + oy1 * scale_y),
                    int(cx1 + ox2 * scale_x),
                    int(cy1 + oy2 * scale_y),
                ]

            detection.label = label
            detection.extra = {
                **(getattr(detection, "extra", None) or {}),
                "semanticLabel": label,
                "semanticConfidence": round(float(getattr(best, "confidence", 0.0)), 4),
                "semanticConfirmed": True,
            }
            confirmed.append(detection)

        self.semantic_last_labels = labels
        return confirmed

    def _overlay_detections(self, detections):
        """Overlay do /live: UMA caixa de movimento — a principal —, como sempre.

        O MotionDetector passou a devolver TODAS as caixas de movimento (é o que
        permite a confirmação semântica achar a pessoa que entrou ao lado da
        árvore que balança, já que a árvore é a MAIOR caixa). Isso é para o
        pipeline; a tela do cliente não muda: aqui só a primeira caixa de
        movimento segue para o overlay.

        Detecções que NÃO são de movimento (objeto/face) passam todas — nesses
        modos o overlay sempre mostrou um retângulo por objeto.

        Os EVENTOS não precisam deste filtro: o debounce por tipo em _process já
        deixa passar um único MOTION_DETECTED por janela.
        """
        filtered = []
        motion_seen = False
        for detection in detections:
            if (getattr(detection, "event_type", None) or "") == "MOTION_DETECTED":
                if motion_seen:
                    continue
                motion_seen = True
            filtered.append(detection)
        return filtered

    def _store_live_detections(self, detections, timestamp):
        payload = []
        ts_ms = int(timestamp * 1000)
        for idx, detection in enumerate(detections[:24]):
            bbox = getattr(detection, "bbox", None)
            if not isinstance(bbox, list) or len(bbox) != 4:
                continue
            if not all(isinstance(v, (int, float)) for v in bbox):
                continue

            extra = getattr(detection, "extra", None) or {}
            label = str(extra.get("name") or detection.label or "detected")
            similarity_value = None
            if "similarity" in extra:
                try:
                    similarity_value = float(extra["similarity"])
                except Exception:
                    similarity_value = None

            payload.append(
                {
                    "id": f"{self.camera_id}-{ts_ms}-{idx}",
                    "cameraId": self.camera_id,
                    "type": detection.event_type or "AI_DETECTED",
                    "label": label,
                    "confidence": round(float(getattr(detection, "confidence", 0.0)), 4),
                    "similarity": similarity_value,
                    "bbox": [int(v) for v in bbox],
                    "frameWidth": int(extra.get("frameWidth") or self.frame_width),
                    "frameHeight": int(extra.get("frameHeight") or self.frame_height),
                    "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp)),
                    "overlayMode": extra.get("overlayMode"),
                    "trackId": extra.get("trackId"),
                }
            )

        with self._snapshot_lock:
            if payload:
                self.overlay_payload_frames += 1
                self._pending_hit_count += 1
                self._miss_count = 0
                if self._pending_hit_count >= self.show_after_hits:
                    self._latest_detections = payload
                    self._latest_detections_at = timestamp
                return

            self.overlay_empty_frames += 1
            self._pending_hit_count = 0
            self._miss_count += 1
            if not self._latest_detections:
                self._latest_detections_at = timestamp
                return

            age_ms = (timestamp - self._latest_detections_at) * 1000
            should_hide_by_misses = self._miss_count >= self.hide_after_misses
            should_hide_by_ttl = self.lost_ttl_ms > 0 and age_ms >= self.lost_ttl_ms
            should_hold = self.live_detection_hold_ms > 0 and age_ms <= self.live_detection_hold_ms

            if should_hide_by_misses or should_hide_by_ttl or not should_hold:
                self._latest_detections = []
                self._latest_detections_at = timestamp

    def get_live_snapshot(self, max_age_ms=5000, limit=12):
        with self._snapshot_lock:
            snapshot = list(self._latest_detections)
            snapshot_at = self._latest_detections_at
        if snapshot_at <= 0:
            return []
        age_ms = (time.time() - snapshot_at) * 1000
        requested_age_ms = max(200, int(max_age_ms))
        effective_age_ms = min(requested_age_ms, self.live_detection_hold_ms) if self.live_detection_hold_ms > 0 else requested_age_ms
        if age_ms > effective_age_ms:
            return []
        return snapshot[: max(1, int(limit))]

    def performance_state(self) -> dict:
        avg_advanced_ms = (
            self.advanced_infer_sum_ms / self.advanced_infer_runs
            if self.advanced_infer_runs > 0 else 0.0
        )
        latencies = sorted(float(value) for value in self._advanced_infer_latencies_ms)
        advanced_p95_ms = latencies[min(len(latencies) - 1, int(round((len(latencies) - 1) * 0.95)))] if latencies else 0.0
        overlay_total = self.overlay_payload_frames + self.overlay_empty_frames
        overlay_payload_ratio = (
            float(self.overlay_payload_frames) / float(overlay_total)
            if overlay_total > 0 else 0.0
        )
        pool_busy_drops = 0
        if self.advanced_analysis_type:
            try:
                detector_state = registry.status().get("detectors", {}).get(self.advanced_analysis_type, {})
                pool_busy_drops = int(detector_state.get("pool_busy_drops") or 0)
            except Exception:
                pool_busy_drops = 0
        elapsed = max(0.001, time.time() - self._started_at)
        return {
            "capture_loop_iterations": self.capture_loop_iterations,
            "process_loop_iterations": self.process_loop_iterations,
            "processed_frames": self.processed_frames,
            "process_fps_real": round(float(self.processed_frames) / elapsed, 3),
            "advanced_infer_runs": self.advanced_infer_runs,
            "advanced_infer_errors": self.advanced_infer_errors,
            "advanced_infer_last_ms": round(float(self.advanced_infer_last_ms), 3),
            "advanced_infer_avg_ms": round(float(avg_advanced_ms), 3),
            "advanced_infer_p95_ms": round(float(advanced_p95_ms), 3),
            "pool_busy_drops": pool_busy_drops,
            "overlay_payload_frames": self.overlay_payload_frames,
            "overlay_empty_frames": self.overlay_empty_frames,
            "overlay_payload_ratio": round(float(overlay_payload_ratio), 4),
            "semantic": {
                "enabled": self.semantic_enabled,
                "strict": self.semantic_strict,
                "runs": self.semantic_runs,
                "confirmations": self.semantic_confirmations,
                "errors": self.semantic_errors,
                "last_labels": self.semantic_last_labels[-5:],
            },
        }

    def _report_detections(self, detections):
        for detection in detections:
            event_type = detection.event_type or "AI_DETECTED"
            metadata = {
                "label": detection.label,
                "confidence": round(float(detection.confidence), 4),
                "bbox": detection.bbox,
                "frameWidth": (detection.extra or {}).get("frameWidth", self.frame_width),
                "frameHeight": (detection.extra or {}).get("frameHeight", self.frame_height),
                "analysisType": "motion" if event_type == "MOTION_DETECTED" else self.analysis_type,
                "advancedAnalysisType": self.advanced_analysis_type,
                **(detection.extra or {}),
            }
            if detection.landmarks is not None:
                metadata["landmarks"] = detection.landmarks
            message = f"{detection.label} ({float(detection.confidence):.2f})"
            self._report_event(event_type, metadata.get("value", detection.confidence), message, metadata)

    def _report_event(self, event_type, value, message=None, metadata=None):
        logger.info("[%s] Evento: %s (%s)", self.camera_id, event_type, value)
        try:
            url = f"{self.api_url}/cameras/internal/{self.camera_id}/events"
            payload = {
                "type": event_type,
                "value": str(value),
                "message": message or f"Evento {event_type} detectado",
                "metadata": metadata or {"value": value, "analysisType": self.analysis_type},
                "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            }
            headers = {"X-Service-Token": self.service_token}
            # Timeout curto para não travar a thread de IA
            response = requests.post(url, json=payload, headers=headers, timeout=3)
            if response.status_code not in [200, 201]:
                logger.warning("[%s] Erro API: %s", self.camera_id, response.status_code)
        except Exception as e:
            logger.warning("[%s] Falha de conexão com API: %s", self.camera_id, e)
