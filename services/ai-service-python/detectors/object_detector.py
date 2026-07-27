import os
import threading
from queue import Empty, Queue

import cv2
import numpy as np
import supervision as sv

from .base import Detection, Detector
from .region_proposal import MotionRegionPlanner, RegionConfig
from onnxruntime_session import inference_threading_status
from runtime_profiles import GENERAL_PROFILE


PERSON_CLASS_ID = 0
BICYCLE_CLASS_ID = 1
CAR_CLASS_ID = 2
MOTORCYCLE_CLASS_ID = 3
BUS_CLASS_ID = 5
RIDER_VEHICLE_CLASS_IDS = {BICYCLE_CLASS_ID, MOTORCYCLE_CLASS_ID}
VEHICLE_CLASS_IDS = {BICYCLE_CLASS_ID, CAR_CLASS_ID, MOTORCYCLE_CLASS_ID, BUS_CLASS_ID}
CLASS_LABELS = {
    PERSON_CLASS_ID: "pessoa",
    BICYCLE_CLASS_ID: "bicicleta",
    CAR_CLASS_ID: "carro",
    MOTORCYCLE_CLASS_ID: "moto",
    BUS_CLASS_ID: "onibus",
}


class ObjectDetector(Detector):
    event_type = "OBJECT_DETECTED"

    def __init__(self, region_config: RegionConfig | None = None):
        self.input_size = int(GENERAL_PROFILE["imgsz"])
        self.model_name = str(GENERAL_PROFILE.get("model", "yolo26n")).strip().lower()
        self.requested_precision = str(GENERAL_PROFILE.get("precision", "fp32")).strip().lower()
        self.min_conf = float(GENERAL_PROFILE["confidence_person"])
        self.class_confidence = {
            PERSON_CLASS_ID: float(GENERAL_PROFILE.get("confidence_person", self.min_conf)),
            BICYCLE_CLASS_ID: float(GENERAL_PROFILE.get("confidence_bicycle", GENERAL_PROFILE.get("confidence_vehicle", self.min_conf))),
            CAR_CLASS_ID: float(GENERAL_PROFILE.get("confidence_car", GENERAL_PROFILE.get("confidence_vehicle", self.min_conf))),
            MOTORCYCLE_CLASS_ID: float(GENERAL_PROFILE.get("confidence_motorcycle", GENERAL_PROFILE.get("confidence_vehicle", self.min_conf))),
            BUS_CLASS_ID: float(GENERAL_PROFILE.get("confidence_bus", GENERAL_PROFILE.get("confidence_vehicle", self.min_conf))),
        }
        self.rider_vehicle_min_conf = float(GENERAL_PROFILE.get("confidence_rider_vehicle", self.min_conf))
        self.vehicle_min_conf = float(GENERAL_PROFILE.get("confidence_vehicle", self.rider_vehicle_min_conf))
        self.active_class_ids = {int(value) for value in GENERAL_PROFILE.get("class_ids", (PERSON_CLASS_ID,))}
        self.min_object_height = int(GENERAL_PROFILE["min_object_height_px"])
        self.track_buffer = int(GENERAL_PROFILE["track_buffer"])
        threading_plan = inference_threading_status()
        self.inference_threads = int(threading_plan["threads_per_worker"])
        self.inference_workers = int(threading_plan["effective_workers"])
        self.model = None
        self.loaded_model_path = ""
        self.loaded_precision = "fp32"
        self.explicit_model_path = str(GENERAL_PROFILE.get("model_path", "") or "").strip()
        self.openvino_device = str(GENERAL_PROFILE.get("openvino_device", "CPU") or "CPU").strip() or "CPU"
        self.openvino_performance_hint = str(GENERAL_PROFILE.get("openvino_performance_hint", "LATENCY") or "LATENCY").strip() or "LATENCY"
        self._runtime_lock = threading.Lock()
        self._runtimes: dict[int, dict] = {}
        self._tracker_lock = threading.Lock()
        self._trackers: dict[str, sv.ByteTrack] = {}
        self._pool_busy_drops = 0
        self._pool_busy_drops_by_size: dict[int, int] = {}
        self._last_selected_size = self.input_size
        # DETECÇÃO POR REGIÃO (derivada do movimento) — PADRÃO DESLIGADO.
        # Com `enabled=False` nada muda: a inferência continua no frame inteiro,
        # mesmo que o chamador passe motion_boxes. Ver detectors/region_proposal.py.
        self._region_config = region_config if region_config is not None else RegionConfig.from_env()
        self._region_planners: dict[str, MotionRegionPlanner] = {}
        self._region_planner_locks: dict[str, threading.Lock] = {}
        self._region_registry_lock = threading.Lock()
        self._region_runs = 0
        self._region_crops = 0
        self._region_stationary_skips = 0
        self._region_sweeps = 0
        self._region_idle_full_frames = 0

    def _candidate_model_dirs(self, input_size: int) -> list[str]:
        base_dir = "/app/models"
        fp32_names = [
            f"{self.model_name}_fp32_{input_size}_openvino_model",
            f"{self.model_name}_openvino_model",
            f"{self.model_name}_fp32_openvino_model",
            f"{self.model_name}_openvino_fp32_model",
        ]
        int8_names = [
            f"{self.model_name}_int8_{input_size}_openvino_model",
            f"{self.model_name}_int8_openvino_model",
            f"{self.model_name}_openvino_int8_model",
            f"{self.model_name}_openvino_model_int8",
        ]
        if input_size != self.input_size:
            fp32_names = fp32_names[:1]
            int8_names = int8_names[:1]
        ordered_names = int8_names + fp32_names if self.requested_precision == "int8" else fp32_names + int8_names
        unique_names: list[str] = []
        for name in ordered_names:
            if name not in unique_names:
                unique_names.append(name)
        return [os.path.join(base_dir, name) for name in unique_names]

    def _resolve_model_xml(self, input_size: int) -> tuple[str, str]:
        searched: list[str] = []
        if self.explicit_model_path:
            searched.append(self.explicit_model_path)
            if os.path.isfile(self.explicit_model_path) and self.explicit_model_path.endswith(".xml"):
                precision = "int8" if "int8" in self.explicit_model_path.lower() else "fp32"
                return self.explicit_model_path, precision
        for candidate in self._candidate_model_dirs(input_size):
            searched.append(candidate)
            if not os.path.exists(candidate):
                continue
            if os.path.isfile(candidate) and candidate.endswith(".xml"):
                precision = "int8" if "int8" in os.path.basename(candidate).lower() else "fp32"
                return candidate, precision
            if os.path.isdir(candidate):
                xml_files = sorted([p for p in os.listdir(candidate) if p.endswith(".xml")])
                if not xml_files:
                    continue
                model_xml = os.path.join(candidate, xml_files[0])
                precision = "int8" if "int8" in os.path.basename(candidate).lower() else "fp32"
                return model_xml, precision
        joined = ", ".join(searched)
        raise RuntimeError(f"Modelo OpenVINO {input_size}px não encontrado. Diretórios testados: {joined}")

    def _compile_runtime(self, input_size: int) -> dict:
        try:
            import openvino as ov
        except Exception as exc:
            raise RuntimeError("Dependência openvino ausente para ObjectDetector.") from exc
        model_xml, loaded_precision = self._resolve_model_xml(input_size)
        core = ov.Core()
        model = core.read_model(model_xml)
        properties = {
            "PERFORMANCE_HINT": self.openvino_performance_hint,
            "NUM_STREAMS": str(max(1, self.inference_workers)),
            "INFERENCE_NUM_THREADS": self.inference_threads,
        }
        try:
            compiled_model = core.compile_model(model, self.openvino_device, properties)
        except Exception:
            compiled_model = core.compile_model(model, self.openvino_device)
        worker_count = max(1, self.inference_workers)
        pool = Queue(maxsize=worker_count)
        for _ in range(worker_count):
            pool.put(compiled_model.create_infer_request())
        print(
            f"[ObjectDetector] Carregado model='{model_xml}' input_size={input_size} requested_precision='{self.requested_precision}' "
            f"active_precision='{loaded_precision}' classes='{GENERAL_PROFILE.get('classes')}' "
            f"inference_threads={self.inference_threads} infer_workers={worker_count}"
        )
        return {
            "model": compiled_model,
            "input": compiled_model.input(0),
            "output": compiled_model.output(0),
            "pool": pool,
            "path": model_xml,
            "precision": loaded_precision,
            "input_size": input_size,
        }

    def _ensure_runtime(self, input_size: int) -> dict:
        if input_size in self._runtimes:
            return self._runtimes[input_size]
        with self._runtime_lock:
            if input_size not in self._runtimes:
                self._runtimes[input_size] = self._compile_runtime(input_size)
        return self._runtimes[input_size]

    def _available_input_sizes(self) -> list[int]:
        available: list[int] = []
        for input_size in (960, 640, 512, 416):
            try:
                self._resolve_model_xml(input_size)
                available.append(input_size)
            except RuntimeError:
                continue
        return available

    def _runtime_for_hint(self, input_size_hint: int | None) -> dict:
        requested_size = int(input_size_hint) if input_size_hint else self.input_size
        requested_size = max(128, min(self.input_size, requested_size))
        available = self._available_input_sizes()
        candidates = [size for size in available if size <= requested_size]
        selected_size = max(candidates) if candidates else self.input_size
        if selected_size not in available:
            selected_size = self.input_size
        self._last_selected_size = selected_size
        return self._ensure_runtime(selected_size)

    def load(self) -> None:
        if self.model is not None:
            return
        runtime = self._ensure_runtime(self.input_size)
        self.model = runtime["model"]
        self.loaded_model_path = runtime["path"]
        self.loaded_precision = runtime["precision"]

    def _preprocess(self, frame, target_size: int | None = None):
        input_size = int(target_size or self.input_size)
        h, w = frame.shape[:2]
        scale = min(input_size / w, input_size / h)
        resized_w = int(round(w * scale))
        resized_h = int(round(h * scale))
        pad_x = (input_size - resized_w) // 2
        pad_y = (input_size - resized_h) // 2

        resized = cv2.resize(frame, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((input_size, input_size, 3), 114, dtype=np.uint8)
        canvas[pad_y:pad_y + resized_h, pad_x:pad_x + resized_w] = resized
        blob = canvas[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
        return blob[None, ...], scale, pad_x, pad_y, w, h, input_size

    def _track_people(self, detections: list[Detection], context_key: str) -> list[Detection]:
        output: list[Detection] = []
        grouped: dict[int, list[Detection]] = {}
        for item in detections:
            cls = int((item.extra or {}).get("classId", PERSON_CLASS_ID))
            grouped.setdefault(cls, []).append(item)

        with self._tracker_lock:
            for cls in sorted(self.active_class_ids):
                class_detections = grouped.get(cls, [])
                tracker_key = f"{context_key}:class:{cls}"
                tracker = self._trackers.get(tracker_key)
                if tracker is None:
                    tracker = sv.ByteTrack(
                        track_activation_threshold=self._confidence_for_class(cls),
                        lost_track_buffer=self.track_buffer,
                        frame_rate=int(max(1, round(float(GENERAL_PROFILE["detection_fps"])))),
                        minimum_consecutive_frames=1,
                    )
                    self._trackers[tracker_key] = tracker

                if class_detections:
                    values = sv.Detections(
                        xyxy=np.asarray([item.bbox for item in class_detections], dtype=np.float32),
                        confidence=np.asarray([item.confidence for item in class_detections], dtype=np.float32),
                        class_id=np.asarray([cls for _ in class_detections], dtype=int),
                    )
                else:
                    values = sv.Detections.empty()
                tracked = tracker.update_with_detections(values)

                tracker_ids = tracked.tracker_id if tracked.tracker_id is not None else []
                confidences = tracked.confidence if tracked.confidence is not None else []
                class_ids = tracked.class_id if tracked.class_id is not None else []
                for bbox, score, track_id, class_id in zip(tracked.xyxy, confidences, tracker_ids, class_ids):
                    tracked_cls = int(class_id) if class_id is not None else cls
                    raw_track_id = int(track_id)
                    output.append(
                        Detection(
                            label=CLASS_LABELS.get(tracked_cls, "detected"),
                            confidence=float(score),
                            bbox=[int(value) for value in bbox.tolist()],
                            extra={
                                "classId": tracked_cls,
                                "overlayMode": GENERAL_PROFILE["overlay_mode"],
                                "trackId": int(tracked_cls * 100000 + raw_track_id),
                                "rawTrackId": raw_track_id,
                                "trackClassId": tracked_cls,
                                "riderVehicleProxy": tracked_cls in RIDER_VEHICLE_CLASS_IDS,
                                "vehicleProxy": tracked_cls in VEHICLE_CLASS_IDS,
                            },
                        )
                    )
        return output

    def _confidence_for_class(self, cls: int) -> float:
        if cls in self.class_confidence:
            return float(self.class_confidence[cls])
        if cls in VEHICLE_CLASS_IDS:
            return float(self.vehicle_min_conf)
        return float(self.min_conf)

    @property
    def accepts_motion_regions(self) -> bool:
        """True quando a inferência por região está LIGADA (padrão: False).

        O StreamProcessor consulta isto antes de sequer montar a lista de caixas
        de movimento: com a flag desligada nenhum argumento novo chega ao infer().
        """
        return bool(self._region_config.enabled)

    def _planner_for(self, context_key: str | None):
        """Planejador (cache de cena) por câmera — criado sob demanda."""
        key = str(context_key or "")
        # Tudo sob o mesmo lock: uma busca em dict é irrelevante perto de uma
        # inferência, e o par (planejador, lock) nunca pode ser visto pela metade
        # por outra câmera criando o seu.
        with self._region_registry_lock:
            if key not in self._region_planners:
                self._region_planner_locks[key] = threading.Lock()
                self._region_planners[key] = MotionRegionPlanner(self._region_config)
            return self._region_planners[key], self._region_planner_locks[key]

    def _infer_by_regions(self, frame, runtime, motion_boxes, context_key: str | None) -> list[Detection]:
        """Roda o modelo NAS REGIÕES do movimento, em resolução nativa.

        As coordenadas voltam para o frame INTEIRO (a região é uma fatia, então
        basta somar a origem — o recorte não é redimensionado antes da inferência,
        quem escala é o letterbox do _preprocess, que o pós-processamento já
        desfaz). Objetos parados são reaproveitados do cache em vez de reinferidos.
        """
        frame_height, frame_width = frame.shape[:2]
        planner, lock = self._planner_for(context_key)
        with lock:
            plan = planner.plan((frame_height, frame_width), motion_boxes)
            self._region_runs += 1
            self._region_stationary_skips += int(plan.skipped)
            if plan.sweep:
                self._region_sweeps += 1
            if plan.idle:
                self._region_idle_full_frames += 1

            fresh: list[Detection] = []
            executed: list[tuple[int, int, int, int]] = []
            for region in plan.regions:
                x1, y1, x2, y2 = region
                crop = frame[y1:y2, x1:x2]
                if getattr(crop, "size", 0) == 0:
                    continue
                found, ran = self._detect_raw(crop, runtime)
                if not ran:
                    # Pool ocupado: a região NÃO rodou. Não pode entrar em
                    # `executed`, senão o cache concluiria que o objeto sumiu por
                    # causa de uma inferência que nunca aconteceu.
                    continue
                executed.append(region)
                self._region_crops += 1
                for detection in found:
                    bx1, by1, bx2, by2 = detection.bbox
                    detection.bbox = [bx1 + x1, by1 + y1, bx2 + x1, by2 + y1]
                    detection.extra = {**(detection.extra or {}), "region": [x1, y1, x2, y2]}
                fresh.extend(found)
            return planner.commit(fresh, plan, executed_regions=executed)

    def infer(
        self,
        frame,
        context_key: str | None = None,
        input_size_hint: int | None = None,
        motion_boxes=None,
        **kwargs,
    ) -> list[Detection]:
        if self.model is None:
            self.load()
        runtime = self._runtime_for_hint(input_size_hint)
        if self._region_config.enabled and motion_boxes is not None:
            detections = self._infer_by_regions(frame, runtime, motion_boxes, context_key)
        else:
            detections, _ran = self._detect_raw(frame, runtime)
        if GENERAL_PROFILE["persistent_track_id"] and context_key:
            return self._track_people(detections, context_key)
        return detections

    def _detect_raw(self, frame, runtime) -> tuple[list[Detection], bool]:
        """Inferência + pós-processamento NAS COORDENADAS de `frame`.

        `frame` é o quadro inteiro (caminho de hoje) ou o recorte de uma região.
        O segundo retorno diz se a inferência REALMENTE rodou (False = pool
        ocupado/ausente), informação que o cache de estacionários precisa.
        """
        selected_size = int(runtime["input_size"])
        blob, scale, pad_x, pad_y, width, height, _ = self._preprocess(frame, selected_size)
        pool = runtime["pool"]
        if pool is None:
            return [], False
        # Latest-frame semantics: if no request is available now, drop this
        # frame and let the next loop consume the newest one from the camera queue.
        try:
            infer_request = pool.get_nowait()
        except Empty:
            self._pool_busy_drops += 1
            self._pool_busy_drops_by_size[selected_size] = self._pool_busy_drops_by_size.get(selected_size, 0) + 1
            return [], False
        try:
            infer_request.infer({runtime["input"]: blob})
            raw = np.array(infer_request.get_output_tensor(0).data, copy=True)
        finally:
            pool.put(infer_request)
        rows = np.squeeze(raw, axis=0)

        detections: list[Detection] = []
        for row in rows:
            if len(row) < 6:
                continue
            x1, y1, x2, y2, score, cls_id = row[:6]
            cls = int(cls_id)
            if cls not in self.active_class_ids:
                continue
            min_conf = self._confidence_for_class(cls)
            if score < min_conf:
                continue
            x1 = int(max(0, min(width, (float(x1) - pad_x) / scale)))
            y1 = int(max(0, min(height, (float(y1) - pad_y) / scale)))
            x2 = int(max(0, min(width, (float(x2) - pad_x) / scale)))
            y2 = int(max(0, min(height, (float(y2) - pad_y) / scale)))
            if x2 <= x1 or y2 <= y1 or (y2 - y1) < self.min_object_height:
                continue
            detections.append(
                Detection(
                    label=CLASS_LABELS.get(cls, "pessoa"),
                    confidence=float(score),
                    bbox=[x1, y1, x2, y2],
                    extra={
                        "classId": cls,
                        "overlayMode": GENERAL_PROFILE["overlay_mode"],
                        "riderVehicleProxy": cls in RIDER_VEHICLE_CLASS_IDS,
                        "vehicleProxy": cls in VEHICLE_CLASS_IDS,
                    },
                )
            )
        return detections, True

    def status(self) -> dict:
        loaded_variants = {
            str(size): {
                "path": runtime["path"],
                "precision": runtime["precision"],
                "pool_busy_drops": self._pool_busy_drops_by_size.get(size, 0),
            }
            for size, runtime in sorted(self._runtimes.items(), reverse=True)
        }
        return {
            "model": self.model_name,
            "requested_precision": self.requested_precision,
            "active_precision": self.loaded_precision,
            "inference_threads": self.inference_threads,
            "infer_workers": self.inference_workers,
            "pool_busy_drops": self._pool_busy_drops,
            "loaded_model_path": self.loaded_model_path,
            "input_size_override_supported": False,
            "fixed_model_switching": True,
            "available_input_sizes": self._available_input_sizes(),
            "loaded_variants": loaded_variants,
            "last_selected_input_size": self._last_selected_size,
            "active_class_ids": sorted(self.active_class_ids),
            "class_confidence": {str(key): value for key, value in sorted(self.class_confidence.items())},
            "openvino_device": self.openvino_device,
            "openvino_performance_hint": self.openvino_performance_hint,
            "region_detection": self.region_status(),
        }

    def region_status(self) -> dict:
        with self._region_registry_lock:
            contexts = {key: planner.stats() for key, planner in sorted(self._region_planners.items())}
        return {
            "enabled": bool(self._region_config.enabled),
            "config": self._region_config.as_dict(),
            "region_runs": self._region_runs,
            "region_crops": self._region_crops,
            "stationary_skips": self._region_stationary_skips,
            "sweeps": self._region_sweeps,
            "idle_full_frames": self._region_idle_full_frames,
            "contexts": contexts,
        }
