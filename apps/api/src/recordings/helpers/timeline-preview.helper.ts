import { extname } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// 2.9 — Scrubbing de timeline com previews low-res (sprite de miniaturas).
//
// A TÉCNICA é a mesma do Frigate (frigate/output/preview.py, GPL): a partir de
// um MP4 já gravado extraímos 1 frame a cada N segundos em resolução MUITO baixa
// e montamos um ÚNICO sprite (mosaico) que o front usa para varrer horas de
// vídeo barato — sem baixar o vídeo inteiro nem decodificar em JS. NENHUMA linha
// de código do Frigate é copiada; só a ideia (extrair-amostrar-mosaicar) é.
//
// Este módulo é 100% PURO (nada de I/O nem ffmpeg): calcula o intervalo de
// amostragem por duração, o grid do sprite (colunas × linhas), as dimensões de
// cada tile e os argumentos exatos do ffmpeg. Assim a lógica crítica de layout
// é testável e DETERMINÍSTICA — a mesma entrada gera o mesmo sprite e o mesmo
// mapa de tempo→tile no front, sem sidecar de metadados.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanTimelinePreviewInput {
  /** Duração da gravação em segundos (Recording.durationSeconds). */
  durationSeconds: number | null | undefined;
  /** Largura de cada miniatura no sprite, em px. Padrão 160 (low-res). */
  tileWidth?: number;
  /** Razão de aspecto da fonte (largura). Padrão 16. */
  aspectWidth?: number;
  /** Razão de aspecto da fonte (altura). Padrão 9. */
  aspectHeight?: number;
  /** Máximo de colunas no mosaico. Padrão 10. */
  maxColumns?: number;
  /** Teto de tiles no sprite inteiro (limita custo/tamanho). Padrão 120. */
  maxTiles?: number;
  /** Intervalo MÍNIMO entre frames amostrados, em segundos. Padrão 2. */
  minIntervalSeconds?: number;
}

export interface TimelinePreviewPlan {
  /** Amostra 1 frame a cada `intervalSeconds` segundos de vídeo. */
  intervalSeconds: number;
  /** Quantidade de tiles (miniaturas) no sprite. */
  frameCount: number;
  /** Colunas do mosaico. */
  columns: number;
  /** Linhas do mosaico. */
  rows: number;
  /** Largura de cada tile, em px (sempre par). */
  tileWidth: number;
  /** Altura de cada tile, em px (sempre par). */
  tileHeight: number;
}

const DEFAULTS = {
  tileWidth: 160,
  aspectWidth: 16,
  aspectHeight: 9,
  maxColumns: 10,
  maxTiles: 120,
  minIntervalSeconds: 2,
};

function toEven(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/**
 * Escolhe o intervalo de amostragem e o grid do sprite a partir da duração.
 *
 * Regras:
 *  - intervalo cresce com a duração para NUNCA passar de `maxTiles` tiles;
 *  - respeita um piso `minIntervalSeconds` (não faz sentido amostrar sub-2s);
 *  - o número de tiles cobre a duração inteira (inclui o frame do 2º 0);
 *  - colunas ≤ `maxColumns`, linhas o suficiente para caber todos os tiles.
 */
export function planTimelinePreview(input: PlanTimelinePreviewInput): TimelinePreviewPlan {
  const tileWidth = Math.max(16, Math.floor(input.tileWidth ?? DEFAULTS.tileWidth));
  const aspectWidth = Math.max(1, input.aspectWidth ?? DEFAULTS.aspectWidth);
  const aspectHeight = Math.max(1, input.aspectHeight ?? DEFAULTS.aspectHeight);
  const maxColumns = Math.max(1, Math.floor(input.maxColumns ?? DEFAULTS.maxColumns));
  const maxTiles = Math.max(1, Math.floor(input.maxTiles ?? DEFAULTS.maxTiles));
  const minIntervalSeconds = Math.max(1, Math.floor(input.minIntervalSeconds ?? DEFAULTS.minIntervalSeconds));

  const rawDuration = Number(input.durationSeconds);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.floor(rawDuration) : 0;

  // Intervalo: o menor múltiplo (>= piso) que mantém frameCount <= maxTiles.
  // frameCount ~ floor(duration / interval) + 1. Queremos floor(d/i)+1 <= maxTiles.
  const intervalForCap = Math.ceil(duration / Math.max(1, maxTiles - 1));
  const intervalSeconds = Math.max(minIntervalSeconds, intervalForCap || minIntervalSeconds);

  const frameCount =
    duration <= 0 ? 1 : Math.min(maxTiles, Math.floor(duration / intervalSeconds) + 1);

  const columns = Math.min(maxColumns, frameCount);
  const rows = Math.ceil(frameCount / columns);

  const tileHeight = toEven((tileWidth * aspectHeight) / aspectWidth);
  const evenTileWidth = toEven(tileWidth);

  return {
    intervalSeconds,
    frameCount,
    columns,
    rows,
    tileWidth: evenTileWidth,
    tileHeight,
  };
}

/**
 * Caminho do sprite no disco, derivado do caminho do MP4 gravado.
 * Ex.: `.../2026-07-24_10-00-00.mp4` → `.../2026-07-24_10-00-00.preview.jpg`.
 * Fica AO LADO da gravação (mesma raiz privada) → herda o gate de conteúdo e a
 * retenção da origem (invariante LGPD 1.2.i).
 */
export function buildTimelinePreviewPath(recordingFilePath: string): string {
  const ext = extname(recordingFilePath);
  const base = ext ? recordingFilePath.slice(0, -ext.length) : recordingFilePath;
  return `${base}.preview.jpg`;
}

/**
 * Argumentos EXATOS do ffmpeg para gerar o sprite num único passe:
 *   fps=1/N  → amostra 1 frame a cada N s
 *   scale    → derruba para a resolução baixa do tile
 *   tile=CxR → mosaica os frames num único quadro
 *   -frames:v 1 → emite só esse quadro mosaicado
 *
 * `-an` descarta áudio; `-q:v` controla a qualidade JPEG (menor = melhor).
 */
export function buildTimelinePreviewArgs(
  inputPath: string,
  outputPath: string,
  plan: TimelinePreviewPlan,
): string[] {
  const filter =
    `fps=1/${plan.intervalSeconds},` +
    `scale=${plan.tileWidth}:${plan.tileHeight},` +
    `tile=${plan.columns}x${plan.rows}`;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-an',
    '-vf',
    filter,
    '-q:v',
    '5',
    '-y',
    outputPath,
  ];
}

/**
 * Mapa tempo→tile que o front usa ao varrer a timeline: dado um instante da
 * gravação (s), diz qual tile mostrar e onde ele está no sprite (px). Puro para
 * travar a matemática de scrubbing em teste (o front replica isto no JS).
 */
export function locateTileAtSecond(
  plan: TimelinePreviewPlan,
  second: number,
): { index: number; column: number; row: number; x: number; y: number } {
  const safeSecond = Number.isFinite(second) && second > 0 ? second : 0;
  const rawIndex = Math.floor(safeSecond / plan.intervalSeconds);
  const index = Math.min(plan.frameCount - 1, Math.max(0, rawIndex));
  const column = index % plan.columns;
  const row = Math.floor(index / plan.columns);
  return {
    index,
    column,
    row,
    x: column * plan.tileWidth,
    y: row * plan.tileHeight,
  };
}
