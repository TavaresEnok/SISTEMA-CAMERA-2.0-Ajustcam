// Regras PURAS de saúde de gravação por câmera (contrato A). Puras de propósito:
// é aqui que mora a decisão "isto é defeito ou é normal?", e ela precisa ser
// testável sem banco, sem FFmpeg e sem relógio real.

export type DesiredRecording = 'continuous' | 'motion' | 'manual' | 'off';

export type CameraDesiredInput = {
  enabled?: boolean | null;
  recordingMode?: string | null;
  recordingEnabled?: boolean | null;
};

/**
 * O que o CLIENTE pediu que esta câmera faça.
 *
 * Sutileza que já custou caro neste repo: em modo `motion`, `recordingEnabled`
 * representa o PROCESSO ATIVO (o gatilho liga/desliga a gravação), não o
 * armamento — ver o comentário em jobs/processors/camera-health-check.processor.ts.
 * Portanto uma câmera armada por movimento continua "desejando" gravar mesmo com
 * `recordingEnabled=false`; só `enabled=false` a desarma.
 */
export function resolveDesiredRecording(camera: CameraDesiredInput): DesiredRecording {
  if (camera?.enabled === false) return 'off';
  const mode = String(camera?.recordingMode ?? '').trim().toLowerCase();
  if (mode === 'motion') return 'motion';
  if (camera?.recordingEnabled === false) return 'off';
  if (mode === 'manual') return 'manual';
  if (mode === 'off' || mode === 'none' || mode === 'disabled') return 'off';
  return 'continuous';
}

export type StalledInput = {
  desired: DesiredRecording;
  /** Há processo de gravação rodando para esta câmera AGORA. */
  active: boolean;
  secondsSinceLastSegment: number | null;
  staleThresholdSeconds: number;
};

/**
 * "Travada" = deveria estar produzindo segmento e não produz.
 *
 * `continuous` é cobrada SEMPRE (é o modo que promete gravação ininterrupta —
 * inclusive quando o processo morreu, que é justamente o caso a denunciar).
 * `motion`/`manual` só são cobradas com o processo ATIVO: uma câmera armada por
 * movimento passa horas legitimamente sem segmento, e acusá-la de travada
 * produziria alarme falso em toda a frota — o mesmo motivo pelo qual o
 * camera-health-check já EXCLUI o modo motion da varredura de staleness.
 *
 * Nunca ter gravado conta como travada (mesma regra do getStatus atual).
 */
export function isRecordingStalled(input: StalledInput): boolean {
  const armed = input.desired === 'continuous'
    || ((input.desired === 'motion' || input.desired === 'manual') && input.active);
  if (!armed) return false;
  if (input.secondsSinceLastSegment == null) return true;
  return input.secondsSinceLastSegment > input.staleThresholdSeconds;
}

/** O contrato A tem 3 estados; ERROR do banco é reportado como OFFLINE. */
export function normalizeCameraStatus(status: unknown): 'ONLINE' | 'OFFLINE' | 'UNKNOWN' {
  const value = String(status ?? '').toUpperCase();
  if (value === 'ONLINE') return 'ONLINE';
  if (value === 'OFFLINE' || value === 'ERROR') return 'OFFLINE';
  return 'UNKNOWN';
}
