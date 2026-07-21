import cv2
import numpy as np

from .base import Detection, Detector
from runtime_profiles import MOTION_PROFILE


class MotionDetector(Detector):
    """Detector de movimento leve (MOG2), calibrado para se aproximar da
    sensibilidade da detecção nativa das câmeras (validada em campo 2026-07-21):

    - COMPONENTES CONECTADOS em vez de contagem bruta de pixels: dispara quando
      UM objeto coeso ultrapassa um limiar PROPORCIONAL à imagem (~0,12% por
      padrão ≈ pessoa/moto distante), em vez de exigir 3% da tela somados —
      que ignorava tudo que não estivesse grande e perto. Ruído disperso
      (chuva/insetos/compressão) não forma componente grande e não dispara.
    - REJEIÇÃO DE MUDANÇA GLOBAL: troca dia/noite (IR), exposição automática,
      relâmpago, farol varrendo ou câmera reposicionada mudam a cena inteira de
      uma vez; isso NÃO é movimento — reaprende o fundo e segue, sem evento.
    - SOMBRAS: MOG2 com detectShadows=True e pixels de sombra (127) descartados
      antes da análise — sombra projetada não vira movimento.
    - VIA RÁPIDA: movimento grande confirma em 2 frames (~1,0s a 2 fps);
      movimento pequeno segue exigindo 3 (~1,5s) para matar falso positivo.
    """

    event_type = "MOTION_DETECTED"

    def __init__(self, cfg: dict | None = None, zones: list | None = None):
        self.frame_width = int(MOTION_PROFILE["analysis_width"])
        self.frame_height = int(MOTION_PROFILE["analysis_height"])
        # Máscara de zonas (0/255) na resolução de ANÁLISE. None = câmera inteira.
        self._zones = zones or []
        self._zone_mask = self._build_zone_mask(self._zones)
        frame_area = float(self.frame_width * self.frame_height)
        # Limiar por OBJETO (componente conectado), proporcional à área analisada.
        self.min_component_pixels = max(
            12, int(frame_area * float(MOTION_PROFILE["motion_min_component_ratio"]))
        )
        # Acima desta fração da tela mudada de uma vez = alteração global (não é movimento).
        self.global_change_pixels = int(
            frame_area * float(MOTION_PROFILE["motion_global_change_ratio"])
        )
        self.fgbg = None
        # Warm-up: MOG2 aprende o fundo com taxa alta para eliminar fantasmas.
        self._warmup_frames = 0
        self._warmup_total = int(MOTION_PROFILE["motion_warmup_frames"])
        # Re-warmup curto após reset por mudança global (cena nova ≠ boot do zero).
        self._rewarmup_total = max(4, int(self._warmup_total // 3))
        self._consecutive_hits = 0
        self._min_consecutive = int(MOTION_PROFILE.get("motion_min_consecutive_hits", 3))
        self._fast_min_consecutive = max(1, self._min_consecutive - 1)
        # Normalização de contraste (padrão Frigate): estica o histograma entre os
        # percentis 4–96, suavizado por média móvel — crucial à noite/baixa luz,
        # quando a imagem "achata" e o diff perde amplitude.
        self._improve_contrast = bool(MOTION_PROFILE.get("motion_improve_contrast", True))
        self._contrast_history = np.zeros((50, 2), dtype=np.float32)
        self._contrast_history[:, 1] = 255.0
        self._contrast_index = 0
        # Preservação de quem FICA na cena (padrão Frigate): enquanto o movimento
        # é recente, o fundo NÃO aprende (pessoa parada não é "engolida" e some);
        # só depois de persistir é que a mudança começa a ser absorvida (carro
        # estacionado vira fundo aos poucos, como deve ser).
        self._motion_streak = 0
        self._freeze_learning_frames = int(MOTION_PROFILE.get("motion_freeze_learning_frames", 6))

    def _build_zone_mask(self, zones: list | None):
        """Converte polígonos normalizados (0..1) numa máscara binária.

        - `exclude`: recortado da área monitorada.
        - `include`: havendo ao menos um, só o interior deles é monitorado.
        Retorna None quando não há zonas (câmera inteira — caminho mais rápido,
        sem custo nenhum para quem não usa o recurso).
        """
        if not zones:
            return None
        try:
            includes = [z for z in zones if str(z.get("kind", "exclude")) == "include"]
            excludes = [z for z in zones if str(z.get("kind", "exclude")) == "exclude"]
            if not includes and not excludes:
                return None

            def to_polygon(zone):
                pts = zone.get("points") or []
                arr = [
                    [
                        int(max(0.0, min(1.0, float(p[0]))) * (self.frame_width - 1)),
                        int(max(0.0, min(1.0, float(p[1]))) * (self.frame_height - 1)),
                    ]
                    for p in pts
                    if isinstance(p, (list, tuple)) and len(p) >= 2
                ]
                return np.array(arr, dtype=np.int32) if len(arr) >= 3 else None

            # Base: tudo monitorado, salvo se houver zonas de inclusão.
            mask = np.full((self.frame_height, self.frame_width), 0 if includes else 255, dtype=np.uint8)
            for zone in includes:
                poly = to_polygon(zone)
                if poly is not None:
                    cv2.fillPoly(mask, [poly], 255)
            for zone in excludes:
                poly = to_polygon(zone)
                if poly is not None:
                    cv2.fillPoly(mask, [poly], 0)
            # Máscara totalmente vazia seria "câmera cega": trata como sem zonas.
            return mask if int(np.count_nonzero(mask)) > 0 else None
        except Exception:
            return None  # zona malformada nunca pode cegar a câmera

    def set_zones(self, zones: list | None) -> None:
        self._zones = zones or []
        self._zone_mask = self._build_zone_mask(self._zones)

    def _effective_global_change_pixels(self) -> int:
        if self._zone_mask is None:
            return self.global_change_pixels
        monitored = int(np.count_nonzero(self._zone_mask))
        ratio = float(MOTION_PROFILE["motion_global_change_ratio"])
        return max(self.min_component_pixels * 4, int(monitored * ratio))

    def load(self) -> None:
        if self.fgbg is None:
            self._create_background(self._warmup_total)

    def _create_background(self, warmup_total: int) -> None:
        self.fgbg = cv2.createBackgroundSubtractorMOG2(
            history=300,        # Menos história = adapta mais rápido
            varThreshold=40,    # Sensível a diferenças reais
            detectShadows=True,  # Sombras marcadas com 127 e DESCARTADAS abaixo
        )
        self._warmup_frames = 0
        self._warmup_total_current = warmup_total
        self._consecutive_hits = 0
        self._motion_streak = 0

    def infer(self, frame, context_key: str | None = None, **kwargs) -> list[Detection]:
        if self.fgbg is None:
            self.load()

        small_frame = cv2.resize(frame, (self.frame_width, self.frame_height))

        # Normalização de contraste antes do diff (média móvel evita "pulos").
        if self._improve_contrast:
            gray_probe = cv2.cvtColor(small_frame, cv2.COLOR_BGR2GRAY) if small_frame.ndim == 3 else small_frame
            lo = float(np.percentile(gray_probe, 4))
            hi = float(np.percentile(gray_probe, 96))
            if hi > lo:
                self._contrast_history[self._contrast_index] = (lo, hi)
                self._contrast_index = (self._contrast_index + 1) % len(self._contrast_history)
                avg_lo, avg_hi = self._contrast_history.mean(axis=0)
                if avg_hi > avg_lo + 1:
                    stretched = (np.clip(small_frame.astype(np.float32), avg_lo, avg_hi) - avg_lo) * (255.0 / (avg_hi - avg_lo))
                    small_frame = stretched.astype(np.uint8)

        warmup_total = getattr(self, "_warmup_total_current", self._warmup_total)
        if self._warmup_frames < warmup_total:
            learning_rate = 0.1  # queima o fundo rápido nos primeiros frames
            self._warmup_frames += 1
        elif 0 < self._motion_streak <= self._freeze_learning_frames:
            learning_rate = 0.0  # movimento RECENTE: congela o fundo (não engole quem parou)
        else:
            learning_rate = -1  # modo automático estável

        fgmask = self.fgbg.apply(small_frame, learningRate=learning_rate)

        # Sombra (127) não é movimento; só primeiro plano pleno (255) conta.
        fgmask = np.where(fgmask == 255, np.uint8(255), np.uint8(0))

        # Zonas: zera o que está fora da área monitorada ANTES de medir. Assim
        # árvore/rua excluídas não contam para movimento nem para a rejeição
        # global (senão vento numa árvore grande "apagaria" a cena inteira).
        if self._zone_mask is not None:
            fgmask = cv2.bitwise_and(fgmask, self._zone_mask)

        # Morfologia para eliminar ruído fino e unir fragmentos do mesmo objeto.
        kernel = np.ones((5, 5), np.uint8)
        fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_OPEN, kernel)
        fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_CLOSE, kernel)

        if self._warmup_frames < warmup_total:
            return []  # aprendendo o fundo — não reporta

        motion_pixels = int(np.count_nonzero(fgmask))

        # MUDANÇA GLOBAL (IR/exposição/relâmpago/câmera mexida): não é movimento.
        # Reaprende o fundo com warm-up curto para não disparar no reajuste.
        # Com zonas, o limiar é proporcional à ÁREA MONITORADA (não à tela toda),
        # senão uma zona pequena jamais atingiria a fração de mudança global.
        if motion_pixels >= self._effective_global_change_pixels():
            self._create_background(self._rewarmup_total)
            return []

        if motion_pixels < self.min_component_pixels:
            self._consecutive_hits = 0
            self._motion_streak = 0
            return []

        # Componentes conectados: o MAIOR objeto coeso decide, não a soma difusa.
        num_labels, _labels, stats, _centroids = cv2.connectedComponentsWithStats(fgmask, connectivity=8)
        best_area = 0
        best_box = None
        for label in range(1, num_labels):  # 0 = fundo
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area > best_area:
                best_area = area
                best_box = (
                    int(stats[label, cv2.CC_STAT_LEFT]),
                    int(stats[label, cv2.CC_STAT_TOP]),
                    int(stats[label, cv2.CC_STAT_WIDTH]),
                    int(stats[label, cv2.CC_STAT_HEIGHT]),
                )

        if best_area < self.min_component_pixels or best_box is None:
            self._consecutive_hits = 0
            self._motion_streak = 0
            return []

        # Confirmação temporal: grande = 2 frames; pequeno = 3 frames.
        self._motion_streak += 1
        self._consecutive_hits += 1
        required = (
            self._fast_min_consecutive
            if best_area >= self.min_component_pixels * 6
            else self._min_consecutive
        )
        if self._consecutive_hits < required:
            return []

        # bbox do objeto em coordenadas do frame ORIGINAL (overlay/diagnóstico).
        scale_x = frame.shape[1] / float(self.frame_width)
        scale_y = frame.shape[0] / float(self.frame_height)
        x, y, w, h = best_box
        bbox = [
            int(x * scale_x),
            int(y * scale_y),
            int((x + w) * scale_x),
            int((y + h) * scale_y),
        ]

        return [
            Detection(
                label="motion",
                confidence=min(1.0, best_area / max(1.0, self.min_component_pixels * 8.0)),
                bbox=bbox,
                event_type=self.event_type,
                extra={
                    "value": best_area,
                    "motionPixels": motion_pixels,
                    "componentPixels": best_area,
                    "componentRatio": round(best_area / float(self.frame_width * self.frame_height), 5),
                },
            )
        ]
