// Timeline de playback por JANELA (lógica PURA — sem React, sem I/O).
//
// Problema que este módulo resolve: a PlaybackPage baixava o DIA INTEIRO de
// gravações e eventos (páginas sequenciais, offset crescente) e emitia token de
// miniatura para TODAS as gravações antes de a régua aparecer. Numa câmera
// movimentada isso são dezenas de requisições enfileiradas antes do primeiro
// pixel. Aqui ficam as contas que permitem carregar/renderizar só a FAIXA que o
// operador está olhando: janela visível, índices a renderizar, quem precisa de
// token e qual pedaço de tempo ainda falta buscar.
//
// `computeListWindow` é derivada de Frigate (MIT) —
// web/src/components/timeline/VirtualizedEventSegments.tsx (Copyright (c) Blake
// Blackshear e contribuidores): mesma matemática de scrollTop/clientHeight →
// faixa de índices com folga (overscan). Só a matemática; nada de marca/logo.
//
// REGRA DE OURO (VMS probatório): item PARCIALMENTE visível ENTRA. Renderizar um
// pouco a mais é barato; sumir com um trecho gravado da linha do tempo esconde
// prova. Na dúvida, este módulo devolve o conjunto MAIOR (e a página cai no
// comportamento antigo).

export const TIMELINE_TOTAL_MINUTES = 24 * 60;
export const TIMELINE_MIN_ZOOM = 1;
/** 192x sobre 24h = janela mínima de 7,5 min (mesmo teto da PlaybackPage). */
export const TIMELINE_MAX_ZOOM = 192;

export interface TimeRange {
  /** Minuto-do-dia (float, segundos como fração). */
  start: number;
  end: number;
}

export interface VisibleWindow extends TimeRange {
  windowMins: number;
  zoom: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Janela visível da régua a partir do zoom e do centro de visão — a MESMA conta
 * que a PlaybackPage fazia inline (janela = dia/zoom, centrada, presa às bordas
 * do dia). Entrada inválida (NaN/∞, zoom fora da faixa) nunca vira NaN: cai no
 * dia inteiro / no zoom mais próximo válido.
 */
export function computeVisibleWindow(input: {
  zoom: number;
  viewCenter: number;
  totalMins?: number;
  minZoom?: number;
  maxZoom?: number;
}): VisibleWindow {
  const totalMins = Math.max(1, finite(input.totalMins ?? TIMELINE_TOTAL_MINUTES, TIMELINE_TOTAL_MINUTES));
  const minZoom = Math.max(1e-6, finite(input.minZoom ?? TIMELINE_MIN_ZOOM, TIMELINE_MIN_ZOOM));
  const maxZoom = Math.max(minZoom, finite(input.maxZoom ?? TIMELINE_MAX_ZOOM, TIMELINE_MAX_ZOOM));
  const zoom = clamp(finite(input.zoom, minZoom), minZoom, maxZoom);
  const windowMins = clamp(totalMins / zoom, 0, totalMins);
  const center = clamp(finite(input.viewCenter, totalMins / 2), 0, totalMins);
  const start = clamp(center - windowMins / 2, 0, totalMins - windowMins);
  return { start, end: start + windowMins, windowMins, zoom };
}

export interface SpanLike {
  start: number;
  end: number;
}

/** Item PARCIALMENTE visível ENTRA (mesma regra do filtro antigo da régua). */
function overlaps(span: SpanLike, window: TimeRange) {
  return span.end >= window.start && span.start <= window.end;
}

/**
 * Faixa CONTÍGUA de índices [startIndex, endIndex) que contém, garantidamente,
 * todo item visível. Assume a lista ordenada por `start` (é o que
 * buildTimelineSegments produz). É um SUPERCONJUNTO: pode incluir item que não
 * aparece, nunca excluir um que aparece.
 */
export function visibleSpanRange(spans: readonly SpanLike[], window: TimeRange): { startIndex: number; endIndex: number } {
  const count = spans.length;
  if (!count) return { startIndex: 0, endIndex: 0 };

  // Primeiro índice cujo FIM já alcança a janela: tudo antes dele termina antes
  // do início da janela e, portanto, não pode aparecer.
  let startIndex = count;
  for (let index = 0; index < count; index += 1) {
    if (spans[index].end >= window.start) {
      startIndex = index;
      break;
    }
  }
  if (startIndex === count) return { startIndex: count, endIndex: count };

  // Primeiro índice que COMEÇA depois da janela (busca binária: `start` é ordenado).
  let low = startIndex;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (spans[mid].start > window.end) high = mid;
    else low = mid + 1;
  }
  return { startIndex, endIndex: low };
}

/**
 * Índices e itens que a régua precisa desenhar. `indices` são posições na lista
 * original — a página usa isso como `key` estável.
 */
export function sliceVisibleSpans<T extends SpanLike>(
  spans: readonly T[],
  window: TimeRange,
): { items: T[]; indices: number[]; startIndex: number; endIndex: number } {
  const { startIndex, endIndex } = visibleSpanRange(spans, window);
  const items: T[] = [];
  const indices: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    if (overlaps(spans[index], window)) {
      items.push(spans[index]);
      indices.push(index);
    }
  }
  return { items, indices, startIndex, endIndex };
}

export interface ListWindow {
  startIndex: number;
  endIndex: number;
  totalHeightPx: number;
  /** false = renderize a lista inteira (comportamento de hoje). */
  virtualized: boolean;
}

/**
 * Faixa de linhas visíveis numa lista de altura fixa. Derivada de Frigate
 * (VirtualizedEventSegments.tsx, MIT): floor(scrollTop/h) - folga →
 * ceil((scrollTop+altura)/h) + folga.
 *
 * DEGRADAÇÃO: viewport ainda não medido (0), altura de linha inválida ou lista
 * menor que `minItemsToVirtualize` → devolve a lista INTEIRA com
 * `virtualized:false`. Melhor renderizar demais do que renderizar errado.
 */
export function computeListWindow(input: {
  itemCount: number;
  rowHeightPx: number;
  scrollTopPx: number;
  viewportHeightPx: number;
  overscanRows?: number;
  minItemsToVirtualize?: number;
}): ListWindow {
  const itemCount = Math.max(0, Math.floor(finite(input.itemCount, 0)));
  const rowHeightPx = finite(input.rowHeightPx, 0);
  const viewportHeightPx = finite(input.viewportHeightPx, 0);
  const minItems = Math.max(0, finite(input.minItemsToVirtualize ?? 0, 0));

  if (!itemCount) return { startIndex: 0, endIndex: 0, totalHeightPx: 0, virtualized: false };
  if (rowHeightPx <= 0 || viewportHeightPx <= 0 || itemCount < minItems) {
    return { startIndex: 0, endIndex: itemCount, totalHeightPx: itemCount * Math.max(0, rowHeightPx), virtualized: false };
  }

  const overscan = Math.max(0, Math.floor(finite(input.overscanRows ?? 6, 6)));
  const scrollTop = clamp(finite(input.scrollTopPx, 0), 0, itemCount * rowHeightPx);
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeightPx) - overscan);
  const endIndex = Math.min(itemCount, Math.ceil((scrollTop + viewportHeightPx) / rowHeightPx) + overscan);
  return {
    startIndex: Math.min(startIndex, Math.max(0, endIndex - 1)),
    endIndex,
    totalHeightPx: itemCount * rowHeightPx,
    virtualized: true,
  };
}

/** Validade prática do token de miniatura antes de reemitir (o backend renova em 4 min). */
export const THUMBNAIL_TOKEN_TTL_MS = 4 * 60 * 1000;

/**
 * Quem precisa de token de miniatura AGORA: só os visíveis (+ os fixados, como a
 * gravação selecionada) que ainda não têm token ou cujo token já passou do TTL.
 * Lista vazia = nenhuma requisição. Deduplica e limita ao lote do backend.
 */
export function selectThumbnailTargets(input: {
  visibleIds: readonly string[];
  pinnedIds?: readonly string[];
  issuedAtMs: Readonly<Record<string, number>>;
  nowMs: number;
  ttlMs?: number;
  max?: number;
}): string[] {
  const ttlMs = Math.max(0, finite(input.ttlMs ?? THUMBNAIL_TOKEN_TTL_MS, THUMBNAIL_TOKEN_TTL_MS));
  const max = Math.max(1, Math.floor(finite(input.max ?? 100, 100)));
  const nowMs = finite(input.nowMs, 0);
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const id of [...input.visibleIds, ...(input.pinnedIds ?? [])]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const issuedAt = input.issuedAtMs[id];
    const fresh = Number.isFinite(issuedAt) && nowMs - issuedAt < ttlMs;
    if (fresh) continue;
    targets.push(id);
    if (targets.length >= max) break;
  }
  return targets;
}

/** Ordena e funde faixas que se tocam ou se sobrepõem. */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const valid = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of valid) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ start: range.start, end: range.end });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

/** `base` menos `taken` — os buracos que sobram. */
export function subtractRanges(base: TimeRange, taken: readonly TimeRange[]): TimeRange[] {
  const holes: TimeRange[] = [];
  let cursor = base.start;
  for (const range of mergeRanges(taken)) {
    if (range.end <= cursor) continue;
    if (range.start >= base.end) break;
    if (range.start > cursor) holes.push({ start: cursor, end: Math.min(range.start, base.end) });
    cursor = Math.max(cursor, range.end);
    if (cursor >= base.end) break;
  }
  if (cursor < base.end) holes.push({ start: cursor, end: base.end });
  return holes.filter((hole) => hole.end > hole.start);
}

/**
 * Orçamento de DETALHE em volta de um ponto, dentro da janela visível.
 *
 * Sem isto o zoom padrão (24h) pediria o dia inteiro — o problema original de
 * volta. Numa visão larga, quem desenha o dia é o esqueleto do resumo; o
 * detalhe (segmento a segmento, com miniatura) só faz falta perto de onde o
 * operador está. Janela menor que o orçamento passa inteira.
 */
export function limitWindowAround(input: { window: TimeRange; center: number; maxMinutes: number }): TimeRange {
  const start = finite(input.window.start, 0);
  const end = finite(input.window.end, 0);
  const budget = finite(input.maxMinutes, 0);
  if (!(budget > 0) || end - start <= budget) return { start, end };
  const center = clamp(finite(input.center, (start + end) / 2), start, end);
  const half = budget / 2;
  const rawStart = clamp(center - half, start, end - budget);
  return { start: rawStart, end: rawStart + budget };
}

/**
 * Que faixas de tempo ainda precisam ser buscadas para desenhar esta janela.
 *
 * O RECUO (`lookbackMinutes`) não é enfeite: o backend filtra por `startedAt`,
 * então uma gravação que começou 09:58 e termina 10:05 NÃO vem numa consulta
 * from=10:00 — sem o recuo ela sumiria da régua. `padMinutes` é a margem de
 * conforto para a panorâmica não pedir dados a cada pixel.
 */
export function planWindowFetch(input: {
  window: TimeRange;
  loaded: readonly TimeRange[];
  padMinutes?: number;
  lookbackMinutes?: number;
  totalMins?: number;
}): TimeRange[] {
  const totalMins = Math.max(1, finite(input.totalMins ?? TIMELINE_TOTAL_MINUTES, TIMELINE_TOTAL_MINUTES));
  const pad = Math.max(0, finite(input.padMinutes ?? 0, 0));
  const lookback = Math.max(0, finite(input.lookbackMinutes ?? 0, 0));
  const start = clamp(finite(input.window.start, 0) - pad - lookback, 0, totalMins);
  const end = clamp(finite(input.window.end, totalMins) + pad, 0, totalMins);
  if (end <= start) return [];
  return subtractRanges({ start, end }, input.loaded);
}

/**
 * Parte faixas grandes em pedaços — a carga de segundo plano do resto do dia
 * chega em lotes, e não num bloco só que segura tudo até o fim.
 */
export function chunkRanges(ranges: readonly TimeRange[], maxMinutes: number): TimeRange[] {
  const size = finite(maxMinutes, 0);
  if (!(size > 0)) return ranges.map((range) => ({ start: range.start, end: range.end }));
  const chunks: TimeRange[] = [];
  for (const range of ranges) {
    for (let start = range.start; start < range.end; start += size) {
      chunks.push({ start, end: Math.min(start + size, range.end) });
    }
  }
  return chunks;
}

/** Perto do que o operador está olhando primeiro; o resto do dia depois. */
export function orderRangesByDistance(ranges: readonly TimeRange[], center: number): TimeRange[] {
  const anchor = finite(center, 0);
  const distance = (range: TimeRange) => {
    if (anchor < range.start) return range.start - anchor;
    if (anchor > range.end) return anchor - range.end;
    return 0;
  };
  return [...ranges].sort((a, b) => distance(a) - distance(b));
}

export interface PagePlan {
  from?: string;
  to?: string;
  offset: number;
}

/**
 * Próxima página de uma faixa — por CURSOR (o carimbo do último item), não por
 * offset profundo. Quando a página inteira cai no MESMO instante o cursor não
 * avança; aí (e só aí) escapamos por offset, senão o laço nunca terminaria.
 */
export function planNextPage(input: {
  plan: PagePlan;
  pageLength: number;
  pageSize: number;
  lastTimestamp: string | null;
  direction?: 'asc' | 'desc';
}): PagePlan | null {
  const { plan, pageLength, pageSize, lastTimestamp } = input;
  if (pageLength <= 0 || pageLength < pageSize) return null;
  if (!lastTimestamp) return null;
  const descending = input.direction === 'desc';
  const boundary = descending ? plan.to : plan.from;
  if (boundary === lastTimestamp) return { ...plan, offset: plan.offset + pageLength };
  return descending
    ? { from: plan.from, to: lastTimestamp, offset: 0 }
    : { from: lastTimestamp, to: plan.to, offset: 0 };
}

/**
 * Resumo barato do dia (GET /recordings/gaps-report) → cobertura para o
 * ESQUELETO da régua: o complemento dos buracos. Serve só para o operador ver
 * onde HÁ vídeo enquanto o detalhe da janela chega.
 *
 * `truncated` (o backend corta em 240 buracos): além do último buraco conhecido
 * não sabemos nada, e desenhar "gravado" ali seria mentira — a cobertura para
 * onde a informação para.
 */
export function coverageFromGaps(input: {
  gaps: ReadonlyArray<{ startAt: string; endAt: string }>;
  dayStartMs: number;
  totalMins?: number;
  truncated?: boolean;
}): { spans: TimeRange[]; lastCoveredMinute: number | null } {
  const totalMins = Math.max(1, finite(input.totalMins ?? TIMELINE_TOTAL_MINUTES, TIMELINE_TOTAL_MINUTES));
  const dayStartMs = finite(input.dayStartMs, 0);
  const toMinute = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? clamp((ms - dayStartMs) / 60_000, 0, totalMins) : null;
  };

  const gaps: TimeRange[] = [];
  for (const gap of input.gaps ?? []) {
    const start = toMinute(gap.startAt);
    const end = toMinute(gap.endAt);
    if (start == null || end == null || end <= start) continue;
    gaps.push({ start, end });
  }

  const merged = mergeRanges(gaps);
  const horizon = input.truncated && merged.length ? merged[merged.length - 1].end : totalMins;
  const spans = subtractRanges({ start: 0, end: horizon }, merged);
  const last = spans.length ? spans[spans.length - 1].end : null;
  return { spans, lastCoveredMinute: last };
}

/**
 * Junta a janela recém-chegada com o que já estava em memória: sem duplicar (o
 * cursor é inclusivo e repete o item da borda), mantendo a ordem cronológica e
 * deixando o item NOVO substituir o antigo de mesmo id.
 */
export function mergeByIdSorted<T>(
  current: readonly T[],
  incoming: readonly T[],
  getId: (item: T) => string,
  getSortKey: (item: T) => string | number,
): T[] {
  const byId = new Map<string, T>();
  for (const item of current) byId.set(getId(item), item);
  for (const item of incoming) byId.set(getId(item), item);
  return [...byId.values()].sort((a, b) => {
    const keyA = getSortKey(a);
    const keyB = getSortKey(b);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });
}

// ── SEGUIR O PLAYHEAD SEM ROUBAR A JANELA DO OPERADOR ───────────────────────
//
// O defeito que isto corrige: a janela recentrava no playhead SEMPRE que ele
// estava fora dela. Durante a reprodução o playhead atualiza a cada ~250ms —
// no zoom máximo, qualquer pan era desfeito no instante seguinte e o operador
// "não conseguia caminhar pela timeline" (relato de produção, 2026-08-07).
//
// A regra dos grandes VMS tem dois lados:
//   · o operador NAVEGOU (clique, salto de evento, "Ir para hora") → a janela
//     VAI até lá — ele pediu para ver aquele ponto;
//   · a REPRODUÇÃO empurrou o playhead para fora → a janela só acompanha se
//     ela JÁ estava acompanhando (o playhead estava visível no quadro
//     anterior). Se o operador tinha ido embora, a janela é DELE.
export function decidirCentroAoMoverPlayhead(entrada: {
  /** Centro atual da janela, em minutos. */
  centro: number;
  /** Minutos visíveis na janela atual. */
  janelaMinutos: number;
  /** Total de minutos do dia. */
  totalMinutos: number;
  /** Playhead ANTES desta mudança. */
  playheadAnterior: number;
  /** Playhead agora. */
  playhead: number;
  /** A mudança veio da reprodução (onTimeUpdate), não de navegação. */
  vindoDoVideo: boolean;
}): number {
  const { centro, janelaMinutos, totalMinutos, playheadAnterior, playhead, vindoDoVideo } = entrada;
  const inicio = Math.min(Math.max(centro - janelaMinutos / 2, 0), totalMinutos - janelaMinutos);
  const margem = janelaMinutos * 0.05;
  const visivel = playhead >= inicio + margem && playhead <= inicio + janelaMinutos - margem;
  if (visivel) return centro;
  if (vindoDoVideo) {
    const anteriorVisivel = playheadAnterior >= inicio && playheadAnterior <= inicio + janelaMinutos;
    if (!anteriorVisivel) return centro;
  }
  return playhead;
}
