import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { CameraPermissionLevel, UserRole } from '@prisma/client';
import { AccessControlService } from '../src/access-control/access-control.service';
import type { AuthUser } from '../src/common/types/auth-user.type';

// ─────────────────────────────────────────────────────────────────────────────
// MATRIZ ADVERSARIAL DE ACESSO — pilar LGPD / vantagem defensável #1.
// Invariante 1.2.i: o CONTEÚDO de uma câmera PRIVADA (a câmera do cliente) só é
// visível para o DONO e para quem o dono autorizou por permissão DIRETA. O
// atalho de privilégio de admin/super-admin — que abre TODAS as outras câmeras —
// é INVERTIDO aqui: admin GERENCIA a câmera privada (canAdminCamera == true) mas
// NÃO VÊ o conteúdo dela (canViewCamera == false, assertCanViewCamera lança).
//
// Esta suíte prova a matriz completa PERSONAS × RECURSOS diretamente contra o
// AccessControlService (o gate único de conteúdo), consolidando o que existia
// só parcialmente em phase2-critical.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

// Recursos: câmera comum (grupo compartilhado) e câmera PRIVADA de outro dono
// (mesma câmera do cliente cujo conteúdo só o dono vê). A privada mora no MESMO
// grupo da comum de propósito: quem tem acesso ao GRUPO ainda NÃO deve enxergar
// a privada — o acesso por grupo/privilégio não vale para o conteúdo privado.
const CAMERAS = [
  { id: 'cam-common', groupId: 'g-shared', isPrivate: false, ownerUserId: null },
  { id: 'cam-private', groupId: 'g-shared', isPrivate: true, ownerUserId: 'u-owner' },
  { id: 'cam-other', groupId: 'g-other', isPrivate: false, ownerUserId: null },
];

const V = CameraPermissionLevel.VIEW;
const C = CameraPermissionLevel.CONTROL;

const PERMISSIONS = [
  // dono: acessa o grupo compartilhado (vê a comum) e é o dono da privada
  { userId: 'u-owner', cameraId: null, groupId: 'g-shared', level: V },
  // membro de grupo (viewer): só o grupo compartilhado
  { userId: 'u-group', cameraId: null, groupId: 'g-shared', level: V },
  // operador com permissão DIRETA numa câmera comum
  { userId: 'u-operator', cameraId: 'cam-common', groupId: null, level: C },
  // delegado: o DONO compartilhou a câmera privada por permissão DIRETA
  { userId: 'u-delegate', cameraId: 'cam-private', groupId: null, level: V },
  // outro tenant: só enxerga o próprio grupo (isolamento cross-tenant)
  { userId: 'u-outsider', cameraId: null, groupId: 'g-other', level: V },
  // u-guest, u-admin, u-super: SEM nenhuma permissão de câmera
];

function makeService() {
  const prisma = {
    camera: {
      findUnique: async (args: any) => CAMERAS.find((c) => c.id === args.where.id) ?? null,
      findMany: async (args: any) => {
        const where = args?.where ?? {};
        let rows = CAMERAS;
        if (where.isPrivate === true && 'ownerUserId' in where) {
          rows = rows.filter((c) => c.isPrivate && c.ownerUserId === where.ownerUserId);
        } else if (where.id?.in && where.isPrivate === true) {
          rows = rows.filter((c) => where.id.in.includes(c.id) && c.isPrivate);
        } else if (where.isPrivate === false) {
          rows = rows.filter((c) => !c.isPrivate);
        } else if (where.groupId?.in) {
          rows = rows.filter((c) => where.groupId.in.includes(c.groupId));
        }
        return rows.map((c) => ({ ...c }));
      },
    },
    cameraPermission: {
      findMany: async (args: any) => {
        const where = args?.where ?? {};
        let rows = PERMISSIONS.filter((p) => p.userId === where.userId);
        if (where.cameraId?.not === null) rows = rows.filter((p) => p.cameraId !== null);
        if (where.groupId?.not === null) rows = rows.filter((p) => p.groupId !== null);
        if (where.level) rows = rows.filter((p) => p.level === where.level);
        if (Array.isArray(where.OR)) {
          rows = rows.filter((p) => where.OR.some((cond: any) =>
            (cond.cameraId && p.cameraId === cond.cameraId) ||
            (cond.groupId && p.groupId === cond.groupId)));
        }
        return rows.map((p) => ({ ...p }));
      },
      findFirst: async (args: any) => {
        const where = args?.where ?? {};
        return (
          PERMISSIONS.find((p) =>
            (where.userId === undefined || p.userId === where.userId) &&
            (where.cameraId === undefined || p.cameraId === where.cameraId) &&
            (where.groupId === undefined || p.groupId === where.groupId) &&
            (where.level === undefined || p.level === where.level)) ?? null
        );
      },
    },
  };
  return new AccessControlService(prisma as any);
}

function user(id: string, role: UserRole): AuthUser {
  return { id, email: `${id}@test.local`, name: id, role };
}

const owner = user('u-owner', UserRole.VIEWER);
const guest = user('u-guest', UserRole.VIEWER);
const groupMember = user('u-group', UserRole.VIEWER);
const operator = user('u-operator', UserRole.OPERATOR);
const delegate = user('u-delegate', UserRole.VIEWER);
const admin = user('u-admin', UserRole.ADMIN);
const superAdmin = user('u-super', UserRole.SUPER_ADMIN);
const outsider = user('u-outsider', UserRole.VIEWER);

async function accessibleSet(svc: AccessControlService, u: AuthUser) {
  return new Set(await svc.getAccessibleCameraIds(u));
}

// ── PERSONA: DONO da câmera privada ─────────────────────────────────────────
test('matriz: dono vê a comum (por grupo) E a privada (por posse)', async () => {
  const svc = makeService();
  assert.equal(await svc.canViewCamera(owner, 'cam-common'), true);
  assert.equal(await svc.canViewCamera(owner, 'cam-private'), true);
  await assert.doesNotReject(() => svc.assertCanViewCamera(owner, 'cam-private'));
  // dono é VIEWER: enxerga o conteúdo, mas não administra
  assert.equal(await svc.canAdminCamera(owner, 'cam-private'), false);
  assert.deepEqual(await accessibleSet(svc, owner), new Set(['cam-common', 'cam-private']));
});

// ── PERSONA: convidado SEM permissão ─────────────────────────────────────────
test('matriz: convidado sem permissão não vê nada e recebe Forbidden', async () => {
  const svc = makeService();
  assert.equal(await svc.canViewCamera(guest, 'cam-common'), false);
  assert.equal(await svc.canViewCamera(guest, 'cam-private'), false);
  await assert.rejects(() => svc.assertCanViewCamera(guest, 'cam-common'), ForbiddenException);
  await assert.rejects(() => svc.assertCanViewCamera(guest, 'cam-private'), ForbiddenException);
  assert.equal(await svc.canAdminCamera(guest, 'cam-common'), false);
  assert.deepEqual(await accessibleSet(svc, guest), new Set([]));
});

// ── PERSONA: membro de grupo (nível VIEWER) ──────────────────────────────────
test('matriz: membro de grupo vê a comum mas NUNCA a privada do mesmo grupo', async () => {
  const svc = makeService();
  assert.equal(await svc.canViewCamera(groupMember, 'cam-common'), true);
  // o acesso ao GRUPO não abre a câmera privada — o conteúdo é do dono
  assert.equal(await svc.canViewCamera(groupMember, 'cam-private'), false);
  await assert.rejects(() => svc.assertCanViewCamera(groupMember, 'cam-private'), ForbiddenException);
  assert.equal(await svc.canAdminCamera(groupMember, 'cam-common'), false);
  // getAccessibleCameraIds filtra a privada não-autorizada mesmo com acesso ao grupo
  assert.deepEqual(await accessibleSet(svc, groupMember), new Set(['cam-common']));
});

// ── PERSONA: operador com permissão DIRETA (respeita o nível) ────────────────
test('matriz: operador com permissão direta respeita o nível e não alcança a privada', async () => {
  const svc = makeService();
  assert.equal(await svc.canViewCamera(operator, 'cam-common'), true);
  assert.equal(await svc.canControlCamera(operator, 'cam-common'), true);
  assert.equal(await svc.canRecordCamera(operator, 'cam-common'), false);
  assert.equal(await svc.canAdminCamera(operator, 'cam-common'), false);
  assert.equal(await svc.canViewCamera(operator, 'cam-private'), false);
  await assert.rejects(() => svc.assertCanViewCamera(operator, 'cam-private'), ForbiddenException);
  assert.deepEqual(await accessibleSet(svc, operator), new Set(['cam-common']));
});

// ── PERSONA: delegado autorizado pelo dono via permissão DIRETA na privada ────
test('matriz: delegado com permissão DIRETA vê a privada (o dono pode compartilhar)', async () => {
  const svc = makeService();
  // a inversão NÃO é um bloqueio cego: a autorização DIRETA do dono abre a privada
  assert.equal(await svc.canViewCamera(delegate, 'cam-private'), true);
  await assert.doesNotReject(() => svc.assertCanViewCamera(delegate, 'cam-private'));
  // mas continua sem acesso à comum (não tem permissão nela)
  assert.equal(await svc.canViewCamera(delegate, 'cam-common'), false);
  assert.deepEqual(await accessibleSet(svc, delegate), new Set(['cam-private']));
});

// ── PERSONA: OUTRO usuário não relacionado (outro tenant) ────────────────────
test('matriz: outro tenant não enxerga a comum nem a privada deste tenant', async () => {
  const svc = makeService();
  assert.equal(await svc.canViewCamera(outsider, 'cam-common'), false);
  assert.equal(await svc.canViewCamera(outsider, 'cam-private'), false);
  await assert.rejects(() => svc.assertCanViewCamera(outsider, 'cam-common'), ForbiddenException);
  await assert.rejects(() => svc.assertCanViewCamera(outsider, 'cam-private'), ForbiddenException);
  // só o próprio grupo aparece
  assert.deepEqual(await accessibleSet(svc, outsider), new Set(['cam-other']));
});

// ─────────────────────────────────────────────────────────────────────────────
// O CORAÇÃO DO PILAR LGPD (invariante 1.2.i): ADMIN e SUPER_ADMIN GERENCIAM a
// câmera privada alheia, mas recebem NEGAÇÃO (Forbidden) ao tentar VER o
// conteúdo. A inversão precisa valer para AMBOS os papéis privilegiados.
// ─────────────────────────────────────────────────────────────────────────────
for (const privileged of [
  { label: 'ADMIN', u: admin },
  { label: 'SUPER_ADMIN', u: superAdmin },
]) {
  test(`matriz LGPD: ${privileged.label} vê a comum mas é NEGADO na privada alheia`, async () => {
    const svc = makeService();
    // câmera comum: o privilégio abre normalmente
    assert.equal(await svc.canViewCamera(privileged.u, 'cam-common'), true);
    assert.equal(await svc.canAdminCamera(privileged.u, 'cam-common'), true);

    // câmera privada de terceiro: GERENCIA (admin) mas NÃO VÊ (a inversão)
    assert.equal(
      await svc.canAdminCamera(privileged.u, 'cam-private'), true,
      `${privileged.label} deve poder ADMINISTRAR a câmera privada`,
    );
    assert.equal(
      await svc.canViewCamera(privileged.u, 'cam-private'), false,
      `${privileged.label} NÃO pode ver o conteúdo da câmera privada alheia`,
    );
    await assert.rejects(
      () => svc.assertCanViewCamera(privileged.u, 'cam-private'),
      ForbiddenException,
      `assertCanViewCamera deve lançar Forbidden para ${privileged.label} na privada`,
    );

    // a lista derivada de conteúdo também exclui a privada, mesmo para o privilégio
    const accessible = await accessibleSet(svc, privileged.u);
    assert.equal(accessible.has('cam-common'), true);
    assert.equal(
      accessible.has('cam-private'), false,
      `getAccessibleCameraIds NÃO pode incluir a privada alheia para ${privileged.label}`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ANTI-REGRESSÃO ESTRUTURAL — cada rota de DERIVADO de câmera (thumbnail, clip,
// snapshot, export/evidência, preview-sprite, ptz, detecções) precisa passar
// pelo MESMO gate de acesso, para que nenhum derivado vaze conteúdo de câmera
// privada sem checar. Estilo do teste "todo serviço que captura stderr sanitiza"
// de phase2-critical.test.ts: varre o SRC por rota e prova o gate presente.
// ─────────────────────────────────────────────────────────────────────────────
function routeBody(source: string, routeDecorator: string): string {
  const start = source.indexOf(routeDecorator);
  assert.notEqual(start, -1, `esperava a rota ${routeDecorator}`);
  const rest = source.slice(start + routeDecorator.length);
  const nextRoute = rest.search(/\n {2}@(?:Get|Post|Patch|Put|Delete)\(/);
  return nextRoute === -1 ? rest : rest.slice(0, nextRoute);
}

test('anti-regressão: todo derivado de câmera passa pelo gate de acesso', () => {
  const cameraStream = readFileSync('src/camera-stream/camera-stream.controller.ts', 'utf8');
  const recordings = readFileSync('src/recordings/recordings.controller.ts', 'utf8');
  const review = readFileSync('src/review/review.controller.ts', 'utf8');
  const reviewSvc = readFileSync('src/review/review.service.ts', 'utf8');
  const ptz = readFileSync('src/ptz/ptz.controller.ts', 'utf8');
  const ai = readFileSync('src/ai/ai.controller.ts', 'utf8');

  // Cada célula: [rótulo, fonte, decorador da rota, marca do gate esperada].
  // O gate de conteúdo padrão é assertCanViewCamera (herda a inversão da privada).
  const contentDerivatives: Array<[string, string, string]> = [
    ['camera-stream poster', cameraStream, "@Get(':cameraId/poster')"],
    ['camera-stream flv', cameraStream, "@Get(':cameraId/flv')"],
    ['camera-stream clip/start', cameraStream, "@Post(':cameraId/clip/start')"],
    ['recordings thumbnail', recordings, "@Get('recordings/:id/thumbnail')"],
    ['recordings preview-sprite', recordings, "@Get('recordings/:id/preview-sprite')"],
    ['recordings preview-meta', recordings, "@Get('recordings/:id/preview-meta')"],
    ['recordings snapshot', recordings, "@Get('recordings/:id/snapshot')"],
    ['recordings play', recordings, "@Get('recordings/:id/play')"],
    ['recordings download', recordings, "@Get('recordings/:id/download')"],
    ['recordings clips/export (evidência)', recordings, "@Post('recordings/:id/clips/export')"],
    ['recordings clips/:clipId/download (evidência)', recordings, "@Get('recordings/clips/:clipId/download')"],
    ['ai detections/latest', ai, "@Get('detections/latest/:cameraId')"],
  ];
  for (const [label, source, route] of contentDerivatives) {
    assert.match(
      routeBody(source, route),
      /assertCanViewCamera\(/,
      `derivado "${label}" (${route}) deve gatear por assertCanViewCamera antes de servir conteúdo`,
    );
  }

  // clip download (camera-stream): NÃO usa assertCanViewCamera — o gate de VER foi
  // aplicado no clip/start; o download é escopado ao PRÓPRIO usuário que gravou.
  assert.match(
    routeBody(cameraStream, "@Get('clip/:clipId/download')"),
    /getClipFile\(clipId, user\.id\)/,
    'download do clipe deve ser escopado ao user.id que iniciou a gravação',
  );

  // review thumbnail: o gate mora no service (canViewCamera). Prova as duas pontas.
  assert.match(
    routeBody(review, "@Get(':eventId/thumbnail')"),
    /this\.reviewService\.streamThumbnail\(user,/,
    'thumbnail de review deve delegar passando o usuário autenticado',
  );
  const streamThumbBody = reviewSvc.slice(
    reviewSvc.indexOf('async streamThumbnail'),
    reviewSvc.indexOf('async streamThumbnail') + 900,
  );
  assert.match(
    streamThumbBody,
    /canViewCamera\(user,/,
    'review.streamThumbnail deve gatear por canViewCamera (herda a inversão da privada)',
  );

  // PTZ é uma AÇÃO DE CONTROLE (não devolve conteúdo/imagem): gate de CONTROL.
  assert.match(
    routeBody(ptz, "@Post(':cameraId/move')"),
    /assertCanControlCamera\(/,
    'PTZ move deve gatear por assertCanControlCamera',
  );
});
