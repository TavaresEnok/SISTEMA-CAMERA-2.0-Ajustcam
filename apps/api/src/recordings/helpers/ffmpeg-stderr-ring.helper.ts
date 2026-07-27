// ─────────────────────────────────────────────────────────────────────────────
// RING BUFFER DO STDERR DO FFMPEG (últimas N linhas, teto rígido de memória).
//
// Inspirado no Frigate (`frigate/log.py`: a `LogPipe` mantém um deque das
// últimas linhas do stderr do ffmpeg e só o despeja quando o processo cai).
// Nenhuma linha de código de lá é copiada — a ideia é: em operação normal o
// stderr do ffmpeg é ruído (ninguém deixa DEBUG ligado em produção), mas na hora
// da morte ele é a ÚNICA resposta para "por que a câmera parou de gravar às 3h?".
//
// SEGURANÇA (não negociável): o stderr do FFmpeg carrega a URL RTSP INTEIRA, com
// a senha da câmera. Tudo que entra no ring já entra sanitizado, e a sanitização
// acontece por LINHA COMPLETA — o stream é fatiado pelo SO onde bem entende, e
// sanitizar chunk a chunk deixaria passar uma credencial partida ao meio.
// ─────────────────────────────────────────────────────────────────────────────

import { sanitizeSensitiveText } from '../../common/security/sensitive-text.helper';

export const DEFAULT_STDERR_RING_LINES = 50;
export const DEFAULT_STDERR_LINE_LENGTH = 500;
/** Sem quebra de linha por tanto tempo? Despeja assim mesmo — memória é teto rígido. */
const MAX_PENDING_LENGTH = 8 * 1024;

export type FfmpegStderrRing = {
  lines: string[];
  /** Linha ainda incompleta (o chunk terminou no meio dela). */
  pending: string;
  maxLines: number;
  maxLineLength: number;
};

export function createStderrRing(
  maxLines: number = DEFAULT_STDERR_RING_LINES,
  maxLineLength: number = DEFAULT_STDERR_LINE_LENGTH,
): FfmpegStderrRing {
  const lines = Number.isFinite(maxLines) ? Math.floor(maxLines) : DEFAULT_STDERR_RING_LINES;
  const length = Number.isFinite(maxLineLength) ? Math.floor(maxLineLength) : DEFAULT_STDERR_LINE_LENGTH;
  return {
    lines: [],
    pending: '',
    maxLines: Math.max(0, Math.min(500, lines)),
    maxLineLength: Math.max(40, Math.min(4_000, length)),
  };
}

function pushLine(ring: FfmpegStderrRing, raw: string): void {
  // ORDEM INVARIANTE: sanitiza ANTES de truncar. Truncar primeiro poderia deixar
  // um pedaço da senha (o começo dela) sobreviver ao corte.
  const clean = sanitizeSensitiveText(raw).trim();
  if (!clean) return;
  ring.lines.push(clean.slice(0, ring.maxLineLength));
  while (ring.lines.length > ring.maxLines) ring.lines.shift();
}

/** Consome um pedaço do stderr. Nunca lança e nunca cresce sem limite. */
export function appendStderrChunk(ring: FfmpegStderrRing, chunk: unknown): void {
  if (ring.maxLines <= 0) {
    ring.pending = '';
    ring.lines.length = 0;
    return;
  }
  const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
  if (!text) return;
  ring.pending += text;
  const parts = ring.pending.split(/\r\n|\r|\n/);
  ring.pending = parts.pop() ?? '';
  for (const part of parts) pushLine(ring, part);
  if (ring.pending.length > MAX_PENDING_LENGTH) {
    pushLine(ring, ring.pending);
    ring.pending = '';
  }
}

/**
 * Devolve o bloco acumulado E ESVAZIA o ring: o mesmo despejo nunca sai duas
 * vezes. A linha incompleta também vai — costuma ser a mais importante.
 */
export function drainStderrRing(ring: FfmpegStderrRing): string[] {
  if (ring.pending) {
    pushLine(ring, ring.pending);
    ring.pending = '';
  }
  const out = [...ring.lines];
  ring.lines.length = 0;
  return out;
}
