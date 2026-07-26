// 2.9 (front) — Scrubbing da timeline com o SPRITE de preview (mosaico low-res),
// no lugar da miniatura de 1 frame. Este módulo é 100% PURO (sem I/O, sem React):
// replica a matemática tempo→tile do backend
// (apps/api/src/recordings/helpers/timeline-preview.helper.ts::locateTileAtSecond)
// para que o tile mostrado no hover ALINHE com o que o ffmpeg mosaicou. Se a
// matemática divergir do backend, o preview mostra o frame errado — por isso a
// lógica fica isolada e coberta por teste (timeline-preview.test.mts).

/** Metadados do sprite retornados por GET /recordings/:id/preview-meta. */
export interface TimelinePreviewMeta {
  recordingId: string;
  durationSeconds: number | null;
  /** Caminho relativo do sprite (o front acrescenta o token de playback). */
  spriteUrl: string;
  intervalSeconds: number;
  frameCount: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

export interface SpriteTile {
  index: number;
  column: number;
  row: number;
}

/**
 * Dado um instante (em segundos DENTRO da gravação), diz qual tile do sprite
 * mostrar. Réplica EXATA de locateTileAtSecond do backend (mesma ordem de
 * clamp/floor) — não "melhorar" sem alinhar o helper do backend junto.
 */
export function locateTileAtSecond(meta: TimelinePreviewMeta, second: number): SpriteTile {
  const safeSecond = Number.isFinite(second) && second > 0 ? second : 0;
  const interval = meta.intervalSeconds > 0 ? meta.intervalSeconds : 1;
  const columns = meta.columns > 0 ? meta.columns : 1;
  const rawIndex = Math.floor(safeSecond / interval);
  const index = Math.min(meta.frameCount - 1, Math.max(0, rawIndex));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return { index, column, row };
}

/**
 * Deslocamento (em segundos) do instante sob o cursor DENTRO da gravação, a
 * partir dos minutos-do-dia (o mesmo eixo da timeline: minuteOfDay). Nunca
 * negativo — o cursor pode cair um triz antes do início por arredondamento.
 */
export function recordingOffsetSeconds(hoverMinute: number, recordingStartMinute: number): number {
  const offset = (hoverMinute - recordingStartMinute) * 60;
  return offset > 0 ? offset : 0;
}

export interface SpriteTileStyle {
  backgroundSize: string;
  backgroundPosition: string;
}

/**
 * CSS para encaixar UM tile do sprite numa caixa de tamanho arbitrário (a caixa
 * de hover é 120×68, os tiles são 160×90): a técnica clássica de sprite por
 * PORCENTAGEM — escala o mosaico inteiro para columns×rows "telas" e posiciona
 * o tile. Independe do px real do tile, então a caixa pode ter qualquer proporção.
 * Guarda a divisão por zero quando há 1 coluna/linha (background-position 0%).
 */
export function spriteTileStyle(meta: TimelinePreviewMeta, second: number): SpriteTileStyle {
  const { column, row } = locateTileAtSecond(meta, second);
  const columns = meta.columns > 0 ? meta.columns : 1;
  const rows = meta.rows > 0 ? meta.rows : 1;
  const posX = columns > 1 ? (column / (columns - 1)) * 100 : 0;
  const posY = rows > 1 ? (row / (rows - 1)) * 100 : 0;
  return {
    backgroundSize: `${columns * 100}% ${rows * 100}%`,
    backgroundPosition: `${posX}% ${posY}%`,
  };
}
