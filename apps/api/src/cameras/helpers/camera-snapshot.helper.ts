import { sanitizeSensitiveText } from '../../common/security/sensitive-text.helper';
import { parseFiniteNumber } from '../../common/config/env-number.helper';

/**
 * CONFIRMAÇÃO VISUAL — um único frame JPEG da câmera, mostrado ANTES de salvar.
 *
 * Por que existe: metadado (1920x1080 · H.264 · 25fps) não distingue a câmera 7
 * do estacionamento da câmera 3 da recepção. Com IP trocado no cadastro, o erro
 * só aparece quando o cliente pede a gravação de um evento — e aí alguém precisa
 * VOLTAR AO LOCAL. Um frame na tela resolve isso no ato.
 *
 * Os argumentos abaixo são o mesmo desenho do poster ao vivo já usado na grade
 * (`FfmpegMjpegService.buildPosterArgs`, em camera-stream). Não dá para chamar
 * aquele método aqui porque ele parte de um `cameraId` PERSISTIDO e o cadastro,
 * por definição, ainda não salvou nada. O que muda em relação a ele é o teto de
 * altura: aqui a imagem é conferência visual e trafega embutida em JSON, então
 * 720p basta e evita despejar um frame 4K em base64 no navegador.
 *
 * ⚠️ Este caminho executa FFmpeg com a CREDENCIAL DA CÂMERA na URL. O stderr do
 * FFmpeg imprime a URL de entrada INTEIRA, então TODA saída (resposta e log) passa
 * por sanitizeSensitiveText — sanitizar só a `url` não basta.
 */

export const SNAPSHOT_MAX_HEIGHT = 720;
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_REASON_MAX_CHARS = 300;

export type SnapshotTransport = 'tcp' | 'udp';

export type SnapshotSource = {
  rtspPort: number | null;
  rtspPath: string | null;
  transport: SnapshotTransport;
};

export type SnapshotStream = {
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
};

export type SnapshotSuccess = {
  ok: true;
  imageDataUrl: string;
  bytes: number;
  capturedAt: string;
  source: SnapshotSource;
  stream: SnapshotStream | null;
  reason: null;
};

export type SnapshotFailure = {
  ok: false;
  imageDataUrl: null;
  bytes: 0;
  capturedAt: string;
  source: SnapshotSource;
  stream: null;
  reason: string;
};

export type SnapshotResult = SnapshotSuccess | SnapshotFailure;

export function normalizeSnapshotTransport(value?: string | null): SnapshotTransport {
  // UDP perdendo pacote devolve frame rasgado; na dúvida, TCP.
  return String(value ?? '').trim().toLowerCase() === 'udp' ? 'udp' : 'tcp';
}

function positiveIntOr(raw: unknown, fallback: number): number {
  const parsed = parseFiniteNumber(raw);
  if (parsed === null || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

export function buildSnapshotFfmpegArgs(input: {
  rtspUrl: string;
  transport?: SnapshotTransport | string | null;
  timeoutUs?: number;
  probesizeBytes?: number;
  analyzedurationUs?: number;
  quality?: number;
  maxHeight?: number;
}): string[] {
  const maxHeight = positiveIntOr(input.maxHeight, SNAPSHOT_MAX_HEIGHT);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-rtsp_transport',
    normalizeSnapshotTransport(input.transport),
    // `-timeout NaN` faz o FFmpeg recusar o comando inteiro: a confirmação
    // visual sumiria da tela sem explicação nenhuma.
    '-timeout',
    String(positiveIntOr(input.timeoutUs, 6_000_000)),
    '-probesize',
    String(positiveIntOr(input.probesizeBytes, 1_000_000)),
    '-analyzeduration',
    String(positiveIntOr(input.analyzedurationUs, 1_000_000)),
    '-i',
    input.rtspUrl,
    '-an',
    '-sn',
    // Reduz para no máximo `maxHeight` mantendo a proporção (largura par com -2);
    // fonte menor que isso passa intacta. `format=yuvj420p` evita a imagem
    // verde/roxa quando a câmera entrega pixel format exótico.
    '-vf',
    `scale=-2:'min(ih,${maxHeight})',format=yuvj420p`,
    '-frames:v',
    '1',
    '-q:v',
    String(positiveIntOr(input.quality, 5)),
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ];
}

/**
 * Um DVR mal-humorado responde HTML de erro, e o FFmpeg pode fechar o pipe no
 * meio do frame. Nos dois casos o navegador mostraria um retângulo quebrado — o
 * que é PIOR que o erro, porque parece imagem de câmera. Exigimos SOI e EOI.
 */
export function isJpegBuffer(value: unknown): value is Buffer {
  if (!Buffer.isBuffer(value) || value.length < 4) return false;
  return (
    value[0] === 0xff
    && value[1] === 0xd8
    && value[value.length - 2] === 0xff
    && value[value.length - 1] === 0xd9
  );
}

export function toJpegDataUrl(buffer: Buffer): string {
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

function sanitizeSource(source: SnapshotSource): SnapshotSource {
  return {
    rtspPort: Number.isFinite(Number(source.rtspPort)) ? Number(source.rtspPort) : null,
    // O operador às vezes cola a URL RTSP inteira no campo de caminho. Se isso
    // voltar cru, a senha dele aparece na tela e vai parar num print de suporte.
    rtspPath: source.rtspPath ? sanitizeSensitiveText(source.rtspPath) : null,
    transport: normalizeSnapshotTransport(source.transport),
  };
}

export function buildSnapshotFailure(input: {
  error: unknown;
  source: SnapshotSource;
  capturedAt: string;
}): SnapshotFailure {
  const clean = sanitizeSensitiveText(input.error).trim();
  return {
    ok: false,
    imageDataUrl: null,
    bytes: 0,
    capturedAt: input.capturedAt,
    source: sanitizeSource(input.source),
    stream: null,
    reason: (clean.length ? clean : 'Não foi possível capturar a imagem da câmera.').slice(
      0,
      SNAPSHOT_REASON_MAX_CHARS,
    ),
  };
}

export function buildSnapshotSuccess(input: {
  buffer: unknown;
  source: SnapshotSource;
  stream?: SnapshotStream | null;
  capturedAt: string;
}): SnapshotResult {
  if (!isJpegBuffer(input.buffer)) {
    return buildSnapshotFailure({
      error: 'A câmera respondeu, mas o conteúdo recebido não é uma imagem válida.',
      source: input.source,
      capturedAt: input.capturedAt,
    });
  }
  return {
    ok: true,
    imageDataUrl: toJpegDataUrl(input.buffer),
    bytes: input.buffer.length,
    capturedAt: input.capturedAt,
    source: sanitizeSource(input.source),
    stream: input.stream ?? null,
    reason: null,
  };
}
