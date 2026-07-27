"""Regiões de inferência derivadas do MOVIMENTO + salto de objetos parados.

Mecanismo derivado do Frigate (MIT) — Copyright (c) Blake Blackshear / Frigate —
de `frigate/video/detect.py` (montagem das regiões a partir do movimento e o
pulo de estacionários) e `frigate/util/object.py` (`calculate_region`,
`get_cluster_boundary`, `get_cluster_candidates`). Adaptado para o DRAC.

POR QUE ISTO EXISTE
-------------------
Rodando o modelo em 640×640 sobre o frame INTEIRO de 1080p, um alvo de 30 px de
altura chega à entrada com ~18 px e some. Recortando uma região de 320 px em
volta do movimento e rodando o modelo nela, o mesmo alvo chega com 60 px. É a
diferença entre ver e não ver uma pessoa a 40 metros.

O QUE MUDA EM RELAÇÃO AO FRIGATE (DRAC é VMS PROBATÓRIO)
--------------------------------------------------------
* TETO POR FUSÃO, NUNCA POR DESCARTE. Numa cena agitada o número de regiões
  precisa de teto (cada região é uma inferência). O Frigate simplesmente gera
  uma região por cluster; aqui, ao estourar o teto, as regiões mais próximas se
  FUNDEM até caber. Perde-se resolução, nunca cobertura — um alvo descartado é
  gravação perdida.
* CENA PARADA = COMPORTAMENTO DE HOJE. Sem movimento e sem nada em cache, o
  plano é o FRAME INTEIRO (`idle_full_frame`), exatamente o que o serviço faz
  hoje. Ligar a flag não pode cegar câmera nenhuma.
* VARREDURA PERIÓDICA (`sweep_every`). De tempos em tempos o frame inteiro entra
  no plano ALÉM das regiões (não no lugar delas), para que um objeto que nunca
  se moveu — carro já estacionado quando a IA subiu — não fique invisível para
  sempre. Equivale ao startup scan + region grid do Frigate, sem precisar do
  banco de regiões histórico.
* ESTACIONÁRIO PULADO NUNCA É PERDIDO. Objeto parado deixa de ser inferido, mas
  continua sendo REPORTADO a partir do cache (marcado com `stationary`), volta a
  ser inferido no instante em que uma caixa de movimento encosta nele, e é
  re-checado periodicamente. Se a região roda e ele não está mais lá, aí sim sai.

TUDO ATRÁS DE FLAG, PADRÃO DESLIGADO (`GENERAL_REGION_DETECTION`). Com a flag
desligada nada aqui é chamado e o caminho continua sendo o frame inteiro.

Módulo de LÓGICA PURA: sem cv2, sem numpy, sem I/O. Testável no host.
"""

from __future__ import annotations

import copy
import math
import os
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence

Box = tuple[int, int, int, int]


# ---------------------------------------------------------------------------
# Configuração (env). Lixo NUNCA vira número: `int("92%")` explode e
# `float("nan")` NÃO explode — NaN em comparação é sempre False e desarmaria os
# limites em silêncio. Qualquer entrada inválida cai no default.
# ---------------------------------------------------------------------------


def _env_bool(env: dict, name: str, default: bool) -> bool:
    raw = str(env.get(name, "") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


def _env_int(env: dict, name: str, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    raw = str(env.get(name, "") or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except Exception:
        return default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _env_float(env: dict, name: str, default: float, minimum: float | None = None, maximum: float | None = None) -> float:
    raw = str(env.get(name, "") or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except Exception:
        return default
    if not math.isfinite(value):  # "nan"/"inf" convertem sem erro — barrar aqui
        return default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


@dataclass(frozen=True)
class RegionConfig:
    """Parâmetros do recorte por região. `enabled=False` = caminho de hoje."""

    enabled: bool = False
    # Lado mínimo do recorte. 320 é o piso do Frigate: abaixo disso o upscale
    # até a entrada do modelo já não acrescenta informação.
    min_size: int = 320
    # Margem em volta da caixa de movimento. O MOG2 marca só o que se MOVEU
    # (as pernas); o modelo precisa do corpo inteiro.
    margin: float = 1.35
    max_regions: int = 4
    sweep_every: int = 20
    idle_full_frame: bool = True
    stationary_skip: bool = True
    stationary_threshold: int = 3
    # Re-checagem forçada do objeto parado (em frames). Tem de ser MENOR que
    # `stationary_max_age`, senão a entrada morre de velha antes de ser
    # reconfirmada — o objeto some da saída até o próximo movimento/varredura.
    stationary_interval: int = 10
    stationary_iou: float = 0.85
    stationary_max_age: int = 45
    match_iou: float = 0.45
    merge_iou: float = 0.6

    @classmethod
    def from_env(cls, env: dict | None = None) -> "RegionConfig":
        source = os.environ if env is None else env
        defaults = cls()
        return cls(
            enabled=_env_bool(source, "GENERAL_REGION_DETECTION", defaults.enabled),
            min_size=_env_int(source, "GENERAL_REGION_MIN_SIZE", defaults.min_size, 32, 4096),
            margin=_env_float(source, "GENERAL_REGION_MARGIN", defaults.margin, 1.0, 4.0),
            max_regions=_env_int(source, "GENERAL_REGION_MAX", defaults.max_regions, 1, 32),
            sweep_every=_env_int(source, "GENERAL_REGION_SWEEP_EVERY", defaults.sweep_every, 0, 100000),
            idle_full_frame=_env_bool(source, "GENERAL_REGION_IDLE_FULL_FRAME", defaults.idle_full_frame),
            stationary_skip=_env_bool(source, "GENERAL_REGION_STATIONARY_SKIP", defaults.stationary_skip),
            stationary_threshold=_env_int(source, "GENERAL_REGION_STATIONARY_THRESHOLD", defaults.stationary_threshold, 1, 1000),
            stationary_interval=_env_int(source, "GENERAL_REGION_STATIONARY_INTERVAL", defaults.stationary_interval, 1, 100000),
            stationary_iou=_env_float(source, "GENERAL_REGION_STATIONARY_IOU", defaults.stationary_iou, 0.0, 1.0),
            stationary_max_age=_env_int(source, "GENERAL_REGION_STATIONARY_MAX_AGE", defaults.stationary_max_age, 1, 100000),
            match_iou=_env_float(source, "GENERAL_REGION_MATCH_IOU", defaults.match_iou, 0.0, 1.0),
            merge_iou=_env_float(source, "GENERAL_REGION_MERGE_IOU", defaults.merge_iou, 0.0, 1.0),
        )

    def as_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "min_size": self.min_size,
            "margin": self.margin,
            "max_regions": self.max_regions,
            "sweep_every": self.sweep_every,
            "idle_full_frame": self.idle_full_frame,
            "stationary_skip": self.stationary_skip,
            "stationary_threshold": self.stationary_threshold,
            "stationary_interval": self.stationary_interval,
            "stationary_iou": self.stationary_iou,
            "stationary_max_age": self.stationary_max_age,
            "match_iou": self.match_iou,
            "merge_iou": self.merge_iou,
        }


# ---------------------------------------------------------------------------
# Geometria
# ---------------------------------------------------------------------------


def area(box: Sequence[int]) -> int:
    return max(0, int(box[2]) - int(box[0])) * max(0, int(box[3]) - int(box[1]))


def boxes_intersect(box_a: Sequence[int], box_b: Sequence[int]) -> bool:
    if box_a[2] < box_b[0] or box_a[0] > box_b[2] or box_a[1] > box_b[3] or box_a[3] < box_b[1]:
        return False
    return True


def box_inside(outer: Sequence[int], inner: Sequence[int]) -> bool:
    """True se `inner` está inteiramente dentro de `outer`."""
    return (
        inner[0] >= outer[0]
        and inner[1] >= outer[1]
        and inner[2] <= outer[2]
        and inner[3] <= outer[3]
    )


def intersection_over_union(box_a: Sequence[int], box_b: Sequence[int]) -> float:
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    if inter <= 0:
        return 0.0
    union = area(box_a) + area(box_b) - inter
    if union <= 0:
        return 0.0
    return float(inter) / float(union)


def clip_box(box: Sequence[int], frame_shape: Sequence[int]) -> Box | None:
    """Recorta a caixa para dentro do frame. `None` se sobra nada (degenerada)."""
    try:
        x1, y1, x2, y2 = (int(round(float(value))) for value in box[:4])
    except Exception:
        return None
    frame_h, frame_w = int(frame_shape[0]), int(frame_shape[1])
    x1 = max(0, min(frame_w, x1))
    y1 = max(0, min(frame_h, y1))
    x2 = max(0, min(frame_w, x2))
    y2 = max(0, min(frame_h, y2))
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2, y2)


def union_box(box_a: Sequence[int], box_b: Sequence[int]) -> Box:
    return (
        min(int(box_a[0]), int(box_b[0])),
        min(int(box_a[1]), int(box_b[1])),
        max(int(box_a[2]), int(box_b[2])),
        max(int(box_a[3]), int(box_b[3])),
    )


def calculate_region(
    frame_shape: Sequence[int],
    xmin: float,
    ymin: float,
    xmax: float,
    ymax: float,
    min_size: int,
    multiplier: float = 1.35,
) -> Box:
    """Região (quase) quadrada em volta da caixa — derivada do Frigate (MIT).

    Diferenças em relação ao original: o lado é limitado às dimensões do frame e
    a região é unida à caixa de origem. No Frigate a região pode passar da borda
    (ele preenche com padding); aqui o recorte é uma FATIA numpy — uma região que
    vaza viraria uma fatia truncada em silêncio, com o modelo vendo outro
    enquadramento que não o calculado.
    """
    frame_h, frame_w = int(frame_shape[0]), int(frame_shape[1])
    size = int((max(xmax - xmin, ymax - ymin) * multiplier) // 4 * 4)
    if size < min_size:
        size = min_size
    width = max(4, min(size, frame_w))
    height = max(4, min(size, frame_h))

    x_offset = int((xmax - xmin) / 2.0 + xmin - width / 2.0)
    x_offset = max(0, min(x_offset, frame_w - width))
    y_offset = int((ymax - ymin) / 2.0 + ymin - height / 2.0)
    y_offset = max(0, min(y_offset, frame_h - height))

    region = (x_offset, y_offset, x_offset + width, y_offset + height)
    # A caixa de origem pode ser maior que o lado da região (movimento largo numa
    # cena panorâmica): a região se estica para não cortá-la. Letterbox no
    # pré-processamento cuida do aspecto.
    source = clip_box((xmin, ymin, xmax, ymax), frame_shape)
    if source is not None and not box_inside(region, source):
        region = union_box(region, source)
    return (int(region[0]), int(region[1]), int(region[2]), int(region[3]))


def _cluster_boundary(box: Sequence[int], min_size: int) -> Box:
    """Área em que outra caixa ainda vale a pena agrupar (Frigate, MIT)."""
    box_width = box[2] - box[0]
    box_height = box[3] - box[1]
    max_region_area = abs(box_width * box_height) / 0.1
    max_region_size = max(min_size, int(math.sqrt(max_region_area)))
    centroid = (box_width / 2 + box[0], box_height / 2 + box[1])
    max_x_dist = int(max_region_size - box_width / 2 * 1.1)
    max_y_dist = int(max_region_size - box_height / 2 * 1.1)
    return (
        int(centroid[0] - max_x_dist),
        int(centroid[1] - max_y_dist),
        int(centroid[0] + max_x_dist),
        int(centroid[1] + max_y_dist),
    )


def cluster_boxes(frame_shape: Sequence[int], boxes: Sequence[Box], config: RegionConfig) -> list[list[int]]:
    """Agrupa caixas próximas (índices), para não explodir o nº de recortes.

    Adaptado de `get_cluster_candidates` do Frigate (MIT).
    """
    clusters: list[list[int]] = []
    used: set[int] = set()
    for current_index, box in enumerate(boxes):
        if current_index in used:
            continue
        cluster = [current_index]
        used.add(current_index)
        boundary = _cluster_boundary(box, config.min_size)
        for compare_index, compare_box in enumerate(boxes):
            if compare_index in used:
                continue
            if not box_inside(boundary, compare_box):
                continue
            candidate = cluster + [compare_index]
            candidate_region = _region_for_cluster(frame_shape, boxes, candidate, config)
            # Se a região resultante ficar grande a ponto de a caixa virar poeira
            # dentro dela (<5% da área), agrupar destrói justamente a resolução
            # que este mecanismo existe para ganhar.
            should_cluster = True
            if (candidate_region[2] - candidate_region[0]) > config.min_size:
                region_area = max(1, area(candidate_region))
                for index in candidate:
                    if area(boxes[index]) / region_area < 0.05:
                        should_cluster = False
                        break
            if should_cluster:
                cluster.append(compare_index)
                used.add(compare_index)
        clusters.append(cluster)
    return clusters


def _region_for_cluster(
    frame_shape: Sequence[int],
    boxes: Sequence[Box],
    cluster: Sequence[int],
    config: RegionConfig,
) -> Box:
    min_x = min(boxes[index][0] for index in cluster)
    min_y = min(boxes[index][1] for index in cluster)
    max_x = max(boxes[index][2] for index in cluster)
    max_y = max(boxes[index][3] for index in cluster)
    return calculate_region(frame_shape, min_x, min_y, max_x, max_y, config.min_size, config.margin)


def dedupe_regions(regions: Iterable[Box]) -> list[Box]:
    """Remove repetidas e as que já estão contidas em outra."""
    unique: list[Box] = []
    for region in regions:
        if region not in unique:
            unique.append(region)
    kept: list[Box] = []
    for region in unique:
        # contida em outra (necessariamente maior, pois as iguais já saíram)
        if any(other != region and box_inside(other, region) for other in unique):
            continue
        kept.append(region)
    return kept


def cap_regions(frame_shape: Sequence[int], regions: Sequence[Box], config: RegionConfig) -> list[Box]:
    """Limita o nº de regiões FUNDINDO as mais próximas — nunca descartando."""
    current = list(regions)
    limit = max(1, int(config.max_regions))
    guard = 0
    while len(current) > limit and guard < 1000:
        guard += 1
        best: tuple[int, int, int, Box] | None = None
        for i in range(len(current)):
            for j in range(i + 1, len(current)):
                merged = union_box(current[i], current[j])
                merged_area = area(merged)
                if best is None or merged_area < best[0]:
                    best = (merged_area, i, j, merged)
        if best is None:
            break
        _, i, j, merged = best
        region = calculate_region(frame_shape, merged[0], merged[1], merged[2], merged[3], config.min_size, 1.0)
        current = [box for index, box in enumerate(current) if index not in (i, j)]
        current.append(region)
    return current


def build_regions(frame_shape: Sequence[int], boxes: Iterable[Sequence[int]], config: RegionConfig) -> list[Box]:
    """Regiões de inferência a partir das caixas de movimento."""
    valid: list[Box] = []
    for box in boxes or []:
        clipped = clip_box(box, frame_shape)
        if clipped is not None:
            valid.append(clipped)
    if not valid:
        return []
    clusters = cluster_boxes(frame_shape, valid, config)
    regions = [_region_for_cluster(frame_shape, valid, cluster, config) for cluster in clusters]
    return sorted(cap_regions(frame_shape, dedupe_regions(regions), config))


# ---------------------------------------------------------------------------
# Deduplicação entre regiões vizinhas
# ---------------------------------------------------------------------------


def _default_box_of(item: Any) -> Box:
    bbox = getattr(item, "bbox", None) or item
    return (int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3]))


def _default_class_of(item: Any) -> int:
    extra = getattr(item, "extra", None) or {}
    try:
        return int(extra.get("classId", -1))
    except Exception:
        return -1


def _default_score_of(item: Any) -> float:
    try:
        return float(getattr(item, "confidence", 0.0) or 0.0)
    except Exception:
        return 0.0


def dedupe_by_iou(
    items: Sequence[Any],
    threshold: float,
    box_of: Callable[[Any], Box] = _default_box_of,
    class_of: Callable[[Any], int] = _default_class_of,
    score_of: Callable[[Any], float] = _default_score_of,
) -> list[Any]:
    """Mesmo objeto visto por duas regiões vizinhas vira UM (o de maior score).

    A ordem de entrada é preservada na saída — quem consome só o primeiro item
    não pode ver a lista embaralhar por causa do recorte.
    """
    indexed = list(enumerate(items))
    indexed.sort(key=lambda pair: -score_of(pair[1]))
    kept: list[tuple[int, Any]] = []
    for index, item in indexed:
        box = box_of(item)
        cls = class_of(item)
        duplicated = False
        for _, other in kept:
            if class_of(other) != cls:
                continue
            if intersection_over_union(box_of(other), box) >= threshold:
                duplicated = True
                break
        if not duplicated:
            kept.append((index, item))
    kept.sort(key=lambda pair: pair[0])
    return [item for _, item in kept]


# ---------------------------------------------------------------------------
# Plano de inferência (regiões + estacionários)
# ---------------------------------------------------------------------------


@dataclass
class RegionPlan:
    regions: list[Box] = field(default_factory=list)
    carried: list[Any] = field(default_factory=list)
    sweep: bool = False
    idle: bool = False
    skipped: int = 0


@dataclass
class _Entry:
    payload: Any
    box: Box
    class_id: int
    motionless: int = 0
    last_seen: int = 0
    last_infer: int = 0
    skips: int = 0


class MotionRegionPlanner:
    """Decide, por frame, ONDE inferir e O QUE pode ser reaproveitado do cache.

    Uso (por câmera — o cache é estado da cena):

        plan = planner.plan(frame_shape, motion_boxes)
        fresh = [inferir em cada plan.regions ...]
        saida = planner.commit(fresh, plan, executed_regions=rodadas)
    """

    def __init__(
        self,
        config: RegionConfig,
        box_of: Callable[[Any], Box] = _default_box_of,
        class_of: Callable[[Any], int] = _default_class_of,
        score_of: Callable[[Any], float] = _default_score_of,
    ) -> None:
        self._config = config
        self._box_of = box_of
        self._class_of = class_of
        self._score_of = score_of
        self._entries: list[_Entry] = []
        self._frame_index = 0
        self._sweeps = 0
        self._skipped_total = 0

    @property
    def config(self) -> RegionConfig:
        return self._config

    def reset(self) -> None:
        self._entries = []

    def stats(self) -> dict:
        return {
            "frames": self._frame_index,
            "cached_objects": len(self._entries),
            "sweeps": self._sweeps,
            "stationary_skips": self._skipped_total,
        }

    def plan(self, frame_shape: Sequence[int], motion_boxes: Iterable[Sequence[int]]) -> RegionPlan:
        self._frame_index += 1
        frame_h, frame_w = int(frame_shape[0]), int(frame_shape[1])
        full_frame: Box = (0, 0, frame_w, frame_h)

        boxes: list[Box] = []
        for box in motion_boxes or []:
            clipped = clip_box(box, frame_shape)
            if clipped is not None:
                boxes.append(clipped)

        regions = build_regions(frame_shape, boxes, self._config)
        plan = RegionPlan(regions=list(regions))

        forced: list[Box] = []
        for entry in self._entries:
            if any(box_inside(region, entry.box) for region in plan.regions):
                continue  # a região de movimento já cobre este objeto
            moving = any(boxes_intersect(entry.box, box) for box in boxes)
            due = (self._frame_index - entry.last_infer) >= self._config.stationary_interval
            stationary = self._config.stationary_skip and entry.motionless >= self._config.stationary_threshold
            if stationary and not moving and not due:
                entry.skips += 1
                self._skipped_total += 1
                plan.skipped += 1
                plan.carried.append(self._carry(entry))
                continue
            forced.append(
                calculate_region(
                    frame_shape,
                    entry.box[0],
                    entry.box[1],
                    entry.box[2],
                    entry.box[3],
                    self._config.min_size,
                    self._config.margin,
                )
            )

        if forced:
            plan.regions = sorted(cap_regions(frame_shape, dedupe_regions(plan.regions + forced), self._config))

        # Varredura periódica do frame inteiro — ADICIONADA às regiões (não no
        # lugar delas): o objeto que nunca se moveu não pode ficar invisível.
        if self._config.sweep_every > 0 and (self._frame_index - 1) % self._config.sweep_every == 0:
            plan.sweep = True
            self._sweeps += 1
            if full_frame not in plan.regions:
                plan.regions.append(full_frame)

        # Cena parada e nada em cache: frame inteiro, que é o que o serviço faz
        # hoje. Ligar a flag não pode cegar câmera nenhuma.
        if not plan.regions and not plan.carried and self._config.idle_full_frame:
            plan.idle = True
            plan.regions = [full_frame]

        return plan

    def commit(
        self,
        detections: Sequence[Any],
        plan: RegionPlan,
        executed_regions: Sequence[Box] | None = None,
    ) -> list[Any]:
        """Atualiza o cache com o que foi inferido e devolve a saída do frame."""
        executed = list(executed_regions if executed_regions is not None else plan.regions)
        fresh = dedupe_by_iou(list(detections or []), self._config.merge_iou, self._box_of, self._class_of, self._score_of)

        matched: set[int] = set()
        for item in fresh:
            box = self._box_of(item)
            class_id = self._class_of(item)
            best_index = -1
            best_iou = 0.0
            for index, entry in enumerate(self._entries):
                if index in matched or entry.class_id != class_id:
                    continue
                iou = intersection_over_union(entry.box, box)
                if iou >= self._config.match_iou and iou > best_iou:
                    best_index = index
                    best_iou = iou
            if best_index >= 0:
                entry = self._entries[best_index]
                matched.add(best_index)
                entry.motionless = entry.motionless + 1 if best_iou >= self._config.stationary_iou else 0
                entry.payload = item
                entry.box = box
                entry.last_seen = self._frame_index
                entry.last_infer = self._frame_index
            else:
                self._entries.append(
                    _Entry(
                        payload=item,
                        box=box,
                        class_id=class_id,
                        motionless=0,
                        last_seen=self._frame_index,
                        last_infer=self._frame_index,
                    )
                )
                matched.add(len(self._entries) - 1)

        survivors: list[_Entry] = []
        for index, entry in enumerate(self._entries):
            if index in matched:
                survivors.append(entry)
                continue
            if any(box_inside(region, entry.box) for region in executed):
                continue  # a região RODOU e não o encontrou: saiu de cena
            if self._frame_index - entry.last_seen >= self._config.stationary_max_age:
                continue  # velho demais: não vira fantasma eterno
            survivors.append(entry)
        self._entries = survivors

        if not plan.carried:
            return list(fresh)
        return dedupe_by_iou(
            list(fresh) + list(plan.carried),
            self._config.merge_iou,
            self._box_of,
            self._class_of,
            self._score_of,
        )

    def _carry(self, entry: _Entry) -> Any:
        """Cópia do último Detection do objeto parado, marcada como estacionária."""
        payload = entry.payload
        try:
            clone = copy.copy(payload)
            extra = getattr(clone, "extra", None)
            clone.extra = {
                **(extra or {}),
                "stationary": True,
                "stationaryFrames": int(entry.skips),
                "stationaryReused": True,
            }
            return clone
        except Exception:
            return payload
