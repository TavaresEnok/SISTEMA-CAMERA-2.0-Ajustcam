import type { Camera } from '../types';

/** Chave YYYY-MM-DD no fuso local do aparelho (não em UTC). */
export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Intervalo ISO que representa um dia civil no fuso local do aparelho. */
export function localDayIsoRange(value: string): { from: string; to: string } {
  const [year, month, day] = value.split('-').map(Number);
  const from = new Date(year, month - 1, day, 0, 0, 0, 0);
  const to = new Date(year, month - 1, day, 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Desloca uma chave YYYY-MM-DD por N dias (fuso local), sem NUNCA passar de hoje
 * — o app não tem gravações do futuro. Usa meio-dia como âncora para não
 * escorregar de dia por horário de verão. `today` é injetável para teste, mas
 * cai em `localDateKey()` (avaliado a cada chamada) no uso real.
 */
export function shiftDateKey(current: string, days: number, today = localDateKey()): string {
  const next = new Date(`${current}T12:00:00`);
  next.setDate(next.getDate() + days);
  const nextKey = localDateKey(next);
  return nextKey > today ? today : nextKey;
}

export function formatTime(value?: string | null) {
  if (!value) return '--:--';
  return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  const todayKey = localDateKey();
  if (value === todayKey) return 'Hoje';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
}

export function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) return 'em andamento';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

export function formatBytes(value?: string | number | null) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '--';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatResolution(camera?: Camera | null) {
  if (!camera?.detectedWidth || !camera.detectedHeight) return 'Resolução pendente';
  const fps = camera.detectedFps ? ` @ ${camera.detectedFps} FPS` : '';
  return `${camera.detectedWidth}x${camera.detectedHeight}${fps}`;
}

export function isOnline(camera: Camera) {
  return camera.status?.toUpperCase() === 'ONLINE';
}
