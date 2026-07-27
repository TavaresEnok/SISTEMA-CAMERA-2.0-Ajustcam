// CONFIRMAÇÃO VISUAL — o frame único que o cadastro/edição mostra antes de salvar.
//
// Módulo 100% PURO (sem React, sem axios): recebe a resposta de
// `POST /cameras/preview-frame` (rascunho) ou `POST /cameras/:id/preview-frame`
// (câmera salva) e devolve o que a tela desenha.
//
// Duas regras:
//  1. A tela NÃO PODE QUEBRAR. Câmera muda, resposta truncada, API antiga — tudo
//     vira "sem imagem + motivo", nunca exceção no meio do cadastro.
//  2. O que vira `src` de <img> é validado aqui. O valor chega por HTTP; aceitar
//     esquema arbitrário transformaria uma resposta adulterada em execução de
//     script dentro do painel. Só `data:image/jpeg;base64,<base64>` passa —
//     SVG inclusive é recusado, porque SVG carrega script.

export type PreviewFrameSource = {
  rtspPort: number | null;
  rtspPath: string | null;
  transport: string | null;
};

export type PreviewFrameStream = {
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
};

export type PreviewFrame = {
  ok: boolean;
  imageDataUrl: string | null;
  bytes: number;
  capturedAt: string | null;
  source: PreviewFrameSource | null;
  stream: PreviewFrameStream | null;
  reason: string;
};

const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

export function isSafeJpegDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length > 32 && JPEG_DATA_URL.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length ? value.trim() : null;
}

function parseSource(raw: unknown): PreviewFrameSource | null {
  const data = record(raw);
  if (!data) return null;
  return {
    rtspPort: num(data.rtspPort),
    rtspPath: str(data.rtspPath),
    transport: str(data.transport),
  };
}

function parseStream(raw: unknown): PreviewFrameStream | null {
  const data = record(raw);
  if (!data) return null;
  return {
    codec: str(data.codec),
    width: num(data.width),
    height: num(data.height),
    fps: num(data.fps),
  };
}

const DEFAULT_REASON = 'A câmera não devolveu imagem para conferência.';

export function parsePreviewFrame(raw: unknown): PreviewFrame {
  const data = record(raw);
  if (!data) {
    return { ok: false, imageDataUrl: null, bytes: 0, capturedAt: null, source: null, stream: null, reason: DEFAULT_REASON };
  }

  const source = parseSource(data.source);
  const reason = str(data.reason);

  // `ok: true` sem imagem utilizável NÃO é sucesso: seria um retângulo quebrado
  // na tela, que o integrador leria como "a câmera está estranha" em vez de
  // "o DRAC não conseguiu confirmar".
  if (!isSafeJpegDataUrl(data.imageDataUrl)) {
    return {
      ok: false,
      imageDataUrl: null,
      bytes: 0,
      capturedAt: str(data.capturedAt),
      source,
      stream: null,
      reason: reason ?? DEFAULT_REASON,
    };
  }

  return {
    ok: true,
    imageDataUrl: data.imageDataUrl,
    bytes: num(data.bytes) ?? 0,
    capturedAt: str(data.capturedAt),
    source,
    stream: parseStream(data.stream),
    reason: '',
  };
}

/** Rótulo curto da fonte que respondeu — é por ele que o técnico confere o perfil. */
export function describePreviewSource(source: PreviewFrameSource | null): string {
  if (!source) return '';
  const identity = [source.rtspPort ? `porta ${source.rtspPort}` : null, source.rtspPath].filter(
    (part): part is string => Boolean(part),
  );
  // Sem porta nem caminho não há nada a conferir: melhor sumir com a linha do
  // que imprimir só "TCP" e dar impressão de informação.
  if (!identity.length) return '';
  const transport = source.transport ? source.transport.toUpperCase() : null;
  return [...identity, transport].filter((part): part is string => Boolean(part)).join(' · ');
}

export function describePreviewStream(stream: PreviewFrameStream | null): string {
  if (!stream) return '';
  const parts = [
    stream.codec ? stream.codec.toUpperCase() : null,
    stream.width && stream.height ? `${stream.width}x${stream.height}` : null,
    stream.fps ? `${Math.round(stream.fps)} FPS` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}
