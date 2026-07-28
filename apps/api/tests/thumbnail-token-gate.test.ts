import test from 'node:test';
import assert from 'node:assert/strict';
import { UserRole } from '@prisma/client';
import { RecordingsService } from '../src/recordings/recordings.service';
import type { AuthUser } from '../src/common/types/auth-user.type';

// Fecha a finding #1 da matriz de acesso (0.5): createThumbnailTokens NÃO pode
// emitir token de playback (derivado de CONTEÚDO) de gravação de câmera PRIVADA
// alheia para admin/super-admin — mesmo que os consumidores re-gateiem, o produtor
// respeita o gate único (invariante 1.2.i). Testa a decisão real via seam de
// instância (Object.create), sem subir o construtor pesado do serviço.
const RECORDINGS = [
  { id: 'r-common', cameraId: 'cam-common', camera: { isPrivate: false } },
  { id: 'r-private', cameraId: 'cam-private', camera: { isPrivate: true } },
];

function makeService() {
  const svc: any = Object.create(RecordingsService.prototype);
  svc.prisma = {
    recording: {
      findMany: async (args: any) =>
        RECORDINGS.filter((r) => args.where.id.in.includes(r.id)).map((r) => ({ ...r })),
    },
  };
  svc.authService = {
    createPlaybackToken: async (_userId: string, recordingId: string) => ({ playToken: `tok-${recordingId}` }),
  };
  svc.accessControlService = {
    // Espelha a inversão da privada: só o dono (u-owner) vê a privada; a comum é
    // visível a quem chega aqui. Admin cai neste caminho SÓ para a privada.
    canPlaybackCamera: async (u: AuthUser, cameraId: string) =>
      cameraId === 'cam-private' ? u.id === 'u-owner' : true,
  };
  return svc as RecordingsService;
}

function user(id: string, role: UserRole): AuthUser {
  return { id, email: `${id}@test.local`, name: id, role };
}

test('createThumbnailTokens: ADMIN recebe token da comum mas NÃO da privada alheia', async () => {
  const svc = makeService();
  const tokens = await svc.createThumbnailTokens(user('u-admin', UserRole.ADMIN), ['r-common', 'r-private']);
  assert.equal(tokens['r-common'], 'tok-r-common', 'admin deve receber token da câmera não-privada');
  assert.equal(tokens['r-private'], undefined, 'admin NÃO pode receber token de conteúdo de câmera privada alheia');
});

test('createThumbnailTokens: SUPER_ADMIN também é negado na privada alheia', async () => {
  const svc = makeService();
  const tokens = await svc.createThumbnailTokens(user('u-super', UserRole.SUPER_ADMIN), ['r-common', 'r-private']);
  assert.equal(tokens['r-common'], 'tok-r-common');
  assert.equal(tokens['r-private'], undefined, 'super-admin NÃO pode receber token de conteúdo de câmera privada alheia');
});

test('createThumbnailTokens: DONO da câmera privada recebe o token (posse)', async () => {
  const svc = makeService();
  const tokens = await svc.createThumbnailTokens(user('u-owner', UserRole.VIEWER), ['r-private']);
  assert.equal(tokens['r-private'], 'tok-r-private', 'o dono deve receber o token da própria câmera privada');
});
