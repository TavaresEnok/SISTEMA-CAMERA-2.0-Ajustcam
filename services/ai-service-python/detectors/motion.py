import cv2
import numpy as np

from .base import Detection, Detector
from .motion_contrast import stretch_lut, uint8_percentile
from runtime_profiles import MOTION_PROFILE


class MotionDetector(Detector):
    """Detector de movimento leve (MOG2), calibrado para se aproximar da
    sensibilidade da detecção nativa das câmeras (validada em campo 2026-07-21):

    - COMPONENTES CONECTADOS em vez de contagem bruta de pixels: dispara quando
      UM objeto coeso ultrapassa um limiar PROPORCIONAL à imagem (~0,12% por
      padrão ≈ pessoa/moto distante), em vez de exigir 3% da tela somados —
      que ignorava tudo que não estivesse grande e perto. Ruído disperso
      (chuva/insetos/compressão) não forma componente grande e não dispara.
    - MUDANÇA GLOBAL DE CENA: troca dia/noite (IR), exposição automática,
      relâmpago, farol varrendo ou câmera reposicionada mudam a cena inteira de
      uma vez. O fundo é RECALIBRADO — mas o evento CONTINUA sendo reportado,
      marcado com sceneChange=true. Técnica derivada do Frigate (MIT) —
      Copyright (c) Frigate, Inc. — que recalibra sem parar de reportar
      (`lightning_threshold`), justamente porque descartar aqui apagaria a
      gravação no instante em que alguém acendeu a luz. Quem decide suprimir é
      a camada de cima; o gatilho da gravação não pode ser engolido.
    - SOMBRAS: MOG2 com detectShadows=True e pixels de sombra (127) descartados
      antes da análise — sombra projetada não vira movimento.
    - VIA RÁPIDA: movimento grande confirma em 2 frames (~1,0s a 2 fps);
      movimento pequeno segue exigindo 3 (~1,5s) para matar falso positivo.
    - TODAS AS CAIXAS: devolve um Detection por objeto coeso (maior primeiro,
      com teto), não só o maior. Quem lê apenas o [0] continua vendo o mesmo de
      sempre; a confirmação semântica passa a enxergar a pessoa que entrou ao
      lado da árvore que balança (a árvore é a MAIOR caixa, não a relevante).
    """

    event_type = "MOTION_DETECTED"

    # varThreshold do MOG2 é comparado com a soma dos desvios de TODOS os canais.
    # Em 3 canais (BGR) a distância acumula 3 vezes; no plano Y (1 canal) ela cai,
    # e manter 40 tornaria o caminho novo MENOS sensível — objeto real deixaria de
    # disparar (= câmera deixa de gravar). Medido em cena sintética com ruído de
    # sensor (bench de calibração, 2026-07-27): com objeto de baixo contraste
    # (delta 12 sobre ruído sigma 5) o BGR/40 dispara (114 px) e o Y/40 NÃO
    # dispara (0 px); Y/20 dispara (153 px) e acompanha o BGR em sigma 1..10 sem
    # criar falso positivo em cena parada (0 px nos dois). Daí o par 40/20.
    _VAR_THRESHOLD_BGR = 40
    _VAR_THRESHOLD_LUMA = 20

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
        # Mudança global de cena: reportar (padrão) ou voltar a engolir o evento
        # como antes (kill-switch MOTION_SCENE_CHANGE_REPORT=false).
        self._scene_change_report = bool(MOTION_PROFILE.get("motion_scene_change_report", True))
        # Plano de luminância em vez de BGR (MOTION_LUMA_PLANE=true). OPT-IN: o
        # padrão continua sendo o caminho de hoje, com o BGR inteiro.
        self._luma_plane = bool(MOTION_PROFILE.get("motion_luma_plane", False))
        # Teto de caixas devolvidas por frame (a lista não pode explodir numa
        # cena agitada: cada caixa vira um recorte na confirmação semântica).
        self._max_boxes = max(1, int(MOTION_PROFILE.get("motion_max_boxes", 4)))

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
            # Sensível a diferenças reais; escalado por nº de canais (ver constantes).
            varThreshold=self._VAR_THRESHOLD_LUMA if self._luma_plane else self._VAR_THRESHOLD_BGR,
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

        # PLANO DE LUMINÂNCIA (opt-in): a IA aqui é SÓ movimento, e movimento vive
        # na luminância — os dois canais de cor custam CPU no MOG2 sem mudar a
        # decisão em cena monocromática/noturna. O cinza já era calculado para o
        # contraste, então ligar a flag não acrescenta conversão nenhuma: apenas
        # passa 1 canal adiante em vez de 3. Cor NÃO é de graça, porém — objeto
        # que se distingue só por matiz (mesma luminância do fundo) some no plano
        # Y; por isso o padrão continua BGR e a troca é consciente, por câmera.
        gray_probe = None
        if self._luma_plane or self._improve_contrast:
            gray_probe = (
                cv2.cvtColor(small_frame, cv2.COLOR_BGR2GRAY) if small_frame.ndim == 3 else small_frame
            )
        if self._luma_plane:
            small_frame = gray_probe

        # Normalização de contraste antes do diff (média móvel evita "pulos").
        #
        # `uint8_percentile` e `stretch_lut` são substitutos BIT-EXATOS do
        # `np.percentile` + esticamento em float32 que estavam aqui — a etapa
        # respondia por ~52% do custo por frame (mais que o próprio MOG2), toda
        # ela em ordenar 57.600 elementos para extrair dois números e em alocar
        # buffers float32 para uma função de apenas 256 respostas possíveis.
        # A equivalência é travada por tests/test_motion_contrast_fastpath.py:
        # sem ela, a sensibilidade de TODAS as câmeras mudaria em silêncio.
        if self._improve_contrast:
            lo = uint8_percentile(gray_probe, 4)
            hi = uint8_percentile(gray_probe, 96)
            if hi > lo:
                self._contrast_history[self._contrast_index] = (lo, hi)
                self._contrast_index = (self._contrast_index + 1) % len(self._contrast_history)
                avg_lo, avg_hi = self._contrast_history.mean(axis=0)
                if avg_hi > avg_lo + 1:
                    small_frame = stretch_lut(small_frame, float(avg_lo), float(avg_hi))

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

        # MUDANÇA GLOBAL (IR/exposição/relâmpago/câmera mexida): a cena inteira
        # muda de uma vez. Reaprende o fundo com warm-up curto para não disparar
        # no reajuste — MAS CONTINUA REPORTANDO. Engolir aqui significava não
        # gravar exatamente no instante em que a luz acendeu, que é quando algo
        # costuma estar acontecendo. O evento sai marcado (sceneChange=true) para
        # que a camada de cima possa classificá-lo; a gravação não se perde.
        # Com zonas, o limiar é proporcional à ÁREA MONITORADA (não à tela toda),
        # senão uma zona pequena jamais atingiria a fração de mudança global.
        if motion_pixels >= self._effective_global_change_pixels():
            components = self._largest_components(fgmask)
            self._create_background(self._rewarmup_total)
            if not self._scene_change_report:
                return []  # kill-switch: comportamento anterior (engole o evento)
            if not components:
                # A cena mudou inteira mas a morfologia não deixou componente
                # nenhum: reporta a área monitorada, nunca silêncio.
                components = [(motion_pixels, (0, 0, self.frame_width, self.frame_height))]
            # Sem confirmação temporal: a recalibração acabou de zerar o contador,
            # e exigir N frames iguais aqui é o mesmo que nunca reportar.
            return self._build_detections(frame, components, motion_pixels, scene_change=True)

        if motion_pixels < self.min_component_pixels:
            self._consecutive_hits = 0
            self._motion_streak = 0
            return []

        # Componentes conectados: cada objeto coeso vira uma caixa (maior primeiro).
        components = self._largest_components(fgmask)
        if not components:
            self._consecutive_hits = 0
            self._motion_streak = 0
            return []

        best_area = components[0][0]

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

        return self._build_detections(frame, components, motion_pixels)

    def _largest_components(self, fgmask) -> list:
        """Componentes acima do limiar, do MAIOR para o menor, com teto.

        O maior continua sendo o primeiro — quem só lê [0] não percebe diferença.
        """
        num_labels, _labels, stats, _centroids = cv2.connectedComponentsWithStats(fgmask, connectivity=8)
        found = []
        for label in range(1, num_labels):  # 0 = fundo
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area < self.min_component_pixels:
                continue
            found.append(
                (
                    area,
                    (
                        int(stats[label, cv2.CC_STAT_LEFT]),
                        int(stats[label, cv2.CC_STAT_TOP]),
                        int(stats[label, cv2.CC_STAT_WIDTH]),
                        int(stats[label, cv2.CC_STAT_HEIGHT]),
                    ),
                )
            )
        # sort estável: em empate de área vence o menor label, como no varrimento
        # sequencial que existia aqui antes.
        found.sort(key=lambda item: -item[0])
        return found[: self._max_boxes]

    def _build_detections(self, frame, components: list, motion_pixels: int, scene_change: bool = False) -> list[Detection]:
        # bbox do objeto em coordenadas do frame ORIGINAL (overlay/diagnóstico).
        scale_x = frame.shape[1] / float(self.frame_width)
        scale_y = frame.shape[0] / float(self.frame_height)
        frame_area = float(self.frame_width * self.frame_height)
        boxes = [
            [int(x * scale_x), int(y * scale_y), int((x + w) * scale_x), int((y + h) * scale_y)]
            for _area, (x, y, w, h) in components
        ]

        detections: list[Detection] = []
        for index, ((area, _box), bbox) in enumerate(zip(components, boxes)):
            extra = {
                "value": area,
                "motionPixels": motion_pixels,
                "componentPixels": area,
                "componentRatio": round(area / frame_area, 5),
                "motionBoxIndex": index,
                "motionBoxCount": len(boxes),
            }
            if index == 0 and len(boxes) > 1:
                # Quem consome só o primeiro Detection ainda enxerga a cena toda.
                extra["motionBoxes"] = boxes
            if scene_change:
                extra["sceneChange"] = True
            detections.append(
                Detection(
                    label="motion",
                    confidence=min(1.0, area / max(1.0, self.min_component_pixels * 8.0)),
                    bbox=bbox,
                    event_type=self.event_type,
                    extra=extra,
                )
            )
        return detections
