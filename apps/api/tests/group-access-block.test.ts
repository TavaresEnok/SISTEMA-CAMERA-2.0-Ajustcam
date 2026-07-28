import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { CameraPermissionLevel, UserRole } from '@prisma/client';
import { AccessControlService } from '../src/access-control/access-control.service';
import type { AuthUser } from '../src/common/types/auth-user.type';

// ── BLOQUEIO COMERCIAL POR GRUPO ────────────────────────────────────────────
// O dono da instalação (integrador) precisa cortar um CLIENTE FINAL que parou de
// pagar — o mesmo escalonamento que a Central aplica sobre a instalação inteira,
// um nível abaixo. Antes existia `isActive`, mas ele só escondia o grupo das
// LISTAGENS: o conteúdo seguia acessível. Bloqueio cosmético é pior que nenhum,
// porque dá a falsa sensação de que o corte funcionou.
//
// Os dois pontos precisam concordar: a LISTA (getAccessibleCameraIds) e o GATE
// por câmera (canViewCamera). Bloquear só um esconderia a câmera da tela mas
// deixaria o acesso direto por URL passar.

const CAMERAS = [
  { id: 'cam-a', groupId: 'g-cliente', isPrivate: false, ownerUserId: null },
  { id: 'cam-b', groupId: 'g-cliente', isPrivate: false, ownerUserId: null },
  { id: 'cam-direta', groupId: 'g-cliente', isPrivate: false, ownerUserId: null },
];

const PERMISSIONS = [
  { userId: 'u-cliente', cameraId: null, groupId: 'g-cliente', level: CameraPermissionLevel.VIEW },
  // Permissão DIRETA: vínculo pessoa↔câmera, não do contrato do grupo.
  { userId: 'u-direto', cameraId: 'cam-direta', groupId: null, level: CameraPermissionLevel.VIEW },
];

function makeService(accessStatus: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED', isActive = true) {
  const group = { id: 'g-cliente', isActive, accessStatus };
  const prisma = {
    camera: {
      findUnique: async (a: any) => CAMERAS.find((c) => c.id === a.where.id) ?? null,
      findMany: async (a: any) => {
        const w = a?.where ?? {};
        let rows = CAMERAS;
        if (w.isPrivate === true && 'ownerUserId' in w) rows = [];
        else if (w.id?.in && w.isPrivate === true) rows = [];
        else if (w.id?.in) rows = rows.filter((c) => w.id.in.includes(c.id));
        else if (w.isPrivate === false) rows = rows.filter((c) => !c.isPrivate);
        else if (w.groupId?.in) rows = rows.filter((c) => w.groupId.in.includes(c.groupId));
        return rows.map((c) => ({ ...c }));
      },
    },
    cameraGroup: {
      findMany: async (a: any) => {
        const w = a?.where ?? {};
        const ok = (!w.id?.in || w.id.in.includes(group.id))
          && (w.isActive === undefined || group.isActive === w.isActive)
          && (typeof w.accessStatus !== 'string' || group.accessStatus === w.accessStatus)
          && (!w.accessStatus?.not || group.accessStatus !== w.accessStatus.not);
        return ok ? [{ ...group }] : [];
      },
      findUnique: async () => ({ ...group }),
    },
    cameraPermission: {
      findMany: async (a: any) => {
        const w = a?.where ?? {};
        let rows = PERMISSIONS.filter((p) => p.userId === w.userId);
        if (w.cameraId?.not === null) rows = rows.filter((p) => p.cameraId !== null);
        if (w.groupId?.not === null) rows = rows.filter((p) => p.groupId !== null);
        if (Array.isArray(w.OR)) {
          rows = rows.filter((p) => w.OR.some((c: any) =>
            (c.cameraId && p.cameraId === c.cameraId) || (c.groupId && p.groupId === c.groupId)));
        }
        return rows.map((p) => ({ ...p }));
      },
      findFirst: async () => null,
    },
  };
  return new AccessControlService(prisma as any);
}

const cliente: AuthUser = { id: 'u-cliente', email: 'c@t', name: 'Cliente', role: UserRole.VIEWER };
const direto: AuthUser = { id: 'u-direto', email: 'd@t', name: 'Direto', role: UserRole.VIEWER };
const admin: AuthUser = { id: 'u-admin', email: 'a@t', name: 'Admin', role: UserRole.ADMIN };

test('ACTIVE: o cliente vê as câmeras do grupo normalmente (linha de base)', async () => {
  const svc = makeService('ACTIVE');
  assert.equal(await svc.canViewCamera(cliente, 'cam-a'), true);
  assert.deepEqual(new Set(await svc.getAccessibleCameraIds(cliente)), new Set(['cam-a', 'cam-b', 'cam-direta']));
  assert.equal(await svc.canPlaybackCamera(cliente, 'cam-a'), true);
});

test('SUSPENDED: o cliente perde TUDO — a lista E o acesso direto por câmera', async () => {
  const svc = makeService('SUSPENDED');
  // O gate único de conteúdo nega...
  assert.equal(await svc.canViewCamera(cliente, 'cam-a'), false);
  await assert.rejects(() => svc.assertCanViewCamera(cliente, 'cam-a'), ForbiddenException);
  // ...e a lista também. Os dois têm de concordar: se só a lista bloqueasse,
  // bastaria a URL direta da câmera para furar o corte.
  assert.deepEqual(await svc.getAccessibleCameraIds(cliente), []);
  assert.equal(await svc.canPlaybackCamera(cliente, 'cam-a'), false);
});

test('SUSPENDED: permissão DIRETA na câmera sobrevive (é vínculo pessoal, não do contrato)', async () => {
  const svc = makeService('SUSPENDED');
  assert.equal(await svc.canViewCamera(direto, 'cam-direta'), true);
  assert.deepEqual(new Set(await svc.getAccessibleCameraIds(direto)), new Set(['cam-direta']));
});

test('RESTRICTED: mantém o AO VIVO, corta o HISTÓRICO (a meia-cobrança)', async () => {
  const svc = makeService('RESTRICTED');
  assert.equal(await svc.canViewCamera(cliente, 'cam-a'), true, 'ao vivo continua');
  assert.ok((await svc.getAccessibleCameraIds(cliente)).includes('cam-a'), 'segue na lista');
  assert.equal(await svc.canPlaybackCamera(cliente, 'cam-a'), false, 'playback/gravações cortados');
  await assert.rejects(() => svc.assertCanPlaybackCamera(cliente, 'cam-a'), ForbiddenException);
  assert.deepEqual(await svc.getPlaybackCameraIds(cliente), [], 'metadados do acervo também ficam ocultos');
});

test('ADMIN da instalação nunca é barrado — precisa administrar quem bloqueou', async () => {
  for (const status of ['SUSPENDED', 'RESTRICTED'] as const) {
    const svc = makeService(status);
    assert.equal(await svc.canViewCamera(admin, 'cam-a'), true, `admin barrado em ${status}`);
    assert.equal(await svc.canPlaybackCamera(admin, 'cam-a'), true, `admin sem playback em ${status}`);
  }
});

test('LEGADO: isActive=false continua bloqueando (o campo antigo passa a valer)', async () => {
  const svc = makeService('ACTIVE', false);
  assert.equal(await svc.canViewCamera(cliente, 'cam-a'), false, 'grupo desativado não concede mais acesso');
  assert.deepEqual(await svc.getAccessibleCameraIds(cliente), []);
});
