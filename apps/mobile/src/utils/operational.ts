import type { Camera } from '../types';

/**
 * Mensagens operacionais mostradas no topo (banner de status). Lógica PURA
 * extraída do App.tsx: erro de sincronização + contagem de câmeras offline,
 * limitado a 3 mensagens.
 *
 * NÃO expõe o perfil do usuário (ex.: "somente visualização") — é informação
 * interna que o cliente/grupo não deve ver no app. As permissões continuam
 * valendo silenciosamente (gravação/PTZ bloqueados quando for o caso).
 */
export function buildOperationalMessages(
  cameras: Array<Pick<Camera, 'status'>>,
  lastSyncError: string | null,
): string[] {
  const messages: string[] = [];
  const offline = cameras.filter((camera) => camera.status !== 'ONLINE').length;
  if (lastSyncError) messages.push(lastSyncError);
  if (offline > 0) messages.push(`${offline} câmera(s) offline ou sem comunicação.`);
  return messages.slice(0, 3);
}
