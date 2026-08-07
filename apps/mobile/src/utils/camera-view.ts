/**
 * Helpers de APRESENTAÇÃO de câmera para a UI do redesign. O tipo Camera de
 * produção não tem os campos visuais do mockup (area/resolution/tint); estes
 * helpers derivam rótulos e um gradiente placeholder determinístico a partir
 * dos dados reais, para os tiles ficarem variados quando não há poster ainda.
 */
import type { Camera } from '../types';

// Paleta de gradientes placeholder (mesma vibe do mockup).
const TINTS: Array<[string, string]> = [
  ['#1f2937', '#0f172a'],
  ['#2b2733', '#13111a'],
  ['#243044', '#101826'],
  ['#1e2b29', '#0c1413'],
  ['#26223a', '#120f1f'],
  ['#203a3a', '#0c1a1a'],
  ['#27313f', '#101722'],
  ['#2a2433', '#141019'],
];

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Gradiente determinístico (estável por câmera) para o placeholder do tile. */
export function tintFor(camera: Pick<Camera, 'id'>): [string, string] {
  return TINTS[hash(camera.id) % TINTS.length];
}

/** Rótulo de área/grupo da câmera (nome do grupo do servidor ou travessão). */
export function areaLabel(camera: Pick<Camera, 'group'>): string {
  return camera.group?.name ?? '—';
}

/** Resolução amigável a partir da altura detectada; vazio se desconhecida. */
export function resolutionLabel(camera: Pick<Camera, 'detectedWidth' | 'detectedHeight'>): string {
  const h = camera.detectedHeight ?? 0;
  if (h >= 2160) return '4K';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (camera.detectedWidth && camera.detectedHeight) return `${camera.detectedWidth}×${camera.detectedHeight}`;
  return '';
}

export function isOnlineStatus(status: string | undefined): boolean {
  return (status ?? '').toUpperCase() === 'ONLINE';
}

/**
 * Câmera com GRAVAÇÃO ARMADA e capaz de gravar agora (online).
 *
 * A Home do redesign estimava este número com `online × 0,4` e o comentário
 * "estimativa visual", exibindo-o ao lado de contagens reais de online/offline.
 * Num produto de segurança, número inventado é justamente o que o cliente usa
 * para conferir se está sendo atendido.
 *
 * `recordingEnabled` vem da API (o findAll devolve a câmera inteira); o enum de
 * status NÃO tem "gravando", então o honesto é contar o que se sabe: gravação
 * ligada + câmera online.
 */
/**
 * Rótulo em português do movimento PTZ.
 *
 * `setPtzFeedback(direction)` recebia o valor do enum (`'Up'`, `'ZoomOut'`…) e a
 * pílula na tela mostrava isso cru, em inglês, numa interface pt-BR — o próprio
 * comentário do redesign prometia "Movendo para a direita…" que nunca existiu.
 */
export function ptzLabel(direcao: string | null | undefined): string | null {
  if (!direcao) return null;
  const mapa: Record<string, string> = {
    Up: 'Movendo para cima',
    Down: 'Movendo para baixo',
    Left: 'Movendo para a esquerda',
    Right: 'Movendo para a direita',
    ZoomIn: 'Aproximando',
    ZoomOut: 'Afastando',
  };
  return mapa[direcao] ?? direcao;
}

export function isRecordingArmed(camera: { status?: string; recordingEnabled?: boolean }): boolean {
  return camera.recordingEnabled === true && isOnlineStatus(camera.status);
}

/** Sem sinal: a câmera está cadastrada mas sem fluxo de vídeo. */
export function isNoSignalStatus(status: string | undefined): boolean {
  const s = (status ?? '').toUpperCase();
  return s === 'NOSIGNAL' || s === 'NO_SIGNAL' || s === 'UNKNOWN';
}
