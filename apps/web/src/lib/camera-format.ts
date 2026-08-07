/**
 * Utilitários compartilhados de formatação/normalização de câmera.
 * Centraliza o que antes estava duplicado entre CamerasPage e CameraDetailPage.
 */

export type VideoCodec = 'original' | 'h264' | 'h265' | 'mjpeg';
export type RecordingMode = 'continuous' | 'motion' | 'schedule' | 'manual';
export type PreferredLiveProtocol = 'hls' | 'llhls' | 'webrtc' | 'mjpeg';

export const RECORDING_MODE_COPY: Record<RecordingMode, { label: string; detail: string; className: string }> = {
  manual: {
    label: 'Manual',
    detail: 'Só grava quando o operador liga.',
    className: 'border-border bg-muted text-muted-foreground',
  },
  motion: {
    label: 'Movimento',
    detail: 'Armada: grava quando detectar movimento e para após o período sem movimento.',
    className: 'border-[hsl(var(--status-warning)_/_0.35)] bg-[hsl(var(--status-warning)_/_0.1)] text-[hsl(var(--status-warning))]',
  },
  continuous: {
    label: 'Contínua',
    detail: 'Intenção 24h: o sistema tenta manter gravando.',
    className: 'border-[hsl(var(--primary)_/_0.35)] bg-[hsl(var(--primary)_/_0.1)] text-[hsl(var(--primary))]',
  },
  schedule: {
    label: 'Agenda indisponível',
    detail: 'Configuração legada sem executor de horários. Selecione outro modo.',
    className: 'border-[hsl(var(--chart-5)_/_0.35)] bg-[hsl(var(--chart-5)_/_0.1)] text-[hsl(var(--chart-5))]',
  },
};

export function getRecordingModeCopy(mode?: RecordingMode | null) {
  return RECORDING_MODE_COPY[mode ?? 'manual'] ?? RECORDING_MODE_COPY.manual;
}

export function normalizeVideoCodec(codec?: string | null): VideoCodec {
  const value = codec?.trim().toLowerCase();
  if (!value || value === 'original' || value === 'source' || value === 'passthrough' || value === 'pass-through') {
    return 'original';
  }
  if (value === 'hevc' || value === 'h.265' || value === 'h265') return 'h265';
  if (value === 'mjpeg' || value === 'mjpg' || value === 'jpeg') return 'mjpeg';
  return 'h264';
}

export function normalizePreferredLiveProtocol(protocol?: string | null): PreferredLiveProtocol {
  const value = String(protocol ?? '').trim().toLowerCase();
  if (value === 'webrtc' || value === 'hls' || value === 'llhls' || value === 'll-hls' || value === 'mjpeg') {
    return value === 'll-hls' ? 'llhls' : value;
  }
  return 'webrtc';
}
