import { join } from 'node:path';

export function buildRecordingOutputDir(recordingsRoot: string, cameraId: string, date = new Date()): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return join(recordingsRoot, `camera-${cameraId}`, year, month, day, hour);
}

export function buildRecordingOutputPattern(outputDir: string, format: string): string {
  return join(outputDir, `%Y-%m-%d_%H-%M-%S.${format}`);
}

/**
 * Raiz de uma câmera no acervo. Existe para que o prefixo `camera-` tenha UM
 * dono: ele é lido de volta pela retenção (que APAGA derivados) e pela
 * recuperação de órfãos, e um rename solto ali faria a varredura simplesmente
 * não encontrar nada — falhando em silêncio, sem erro nenhum.
 */
export function buildCameraRootDir(recordingsRoot: string, cameraId: string): string {
  return join(recordingsRoot, `camera-${cameraId}`);
}

/** Inverso de `buildCameraRootDir`: devolve o cameraId, ou null se não for pasta de câmera. */
export function parseCameraIdFromDirName(dirName: string): string | null {
  return dirName.startsWith('camera-') && dirName.length > 'camera-'.length
    ? dirName.slice('camera-'.length)
    : null;
}
