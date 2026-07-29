import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient, CameraPermissionLevel, UserRole } from '@prisma/client';
import { AccessControlService } from '../src/access-control/access-control.service';
import type { AuthUser } from '../src/common/types/auth-user.type';

// ─────────────────────────────────────────────────────────────────────────────
// A MATRIZ DE ACESSO CONTRA POSTGRES DE VERDADE.
//
// `access-matrix.test.ts` roda a mesma matriz contra um Prisma FAKE — um objeto
// literal que reimplementa `where` à mão. Ele cobre a lógica e roda em todo PR
// sem infra, e por isso continua existindo. Mas é ESTRUTURALMENTE cego para a
// classe de bug que mais dói num produto que isola clientes:
//
//   · `select:` é honrado pelo Prisma real e ignorado pelo fake;
//   · uma query cujo `where` o fake não modelou cai no `else` e devolve TUDO —
//     no banco real ela devolve o que o SQL mandar (o fake pode passar verde
//     num código que vaza);
//   · constraints só existem no banco: o CHECK `cameraId` XOR `groupId`, os
//     índices únicos parciais (userId,cameraId)/(userId,groupId) e o
//     `ON DELETE RESTRICT` do dono da câmera privada.
//
// Vazar câmera de um cliente para outro é o incidente mais caro deste produto.
// O gate que impede isso merece um teste que fale com o banco real.
//
// POR QUE `.e2e.ts` E NÃO `.test.ts`: o glob de CI é `tests/**/*.test.ts` e o
// job `pnpm-verify` NÃO tem serviço de Postgres. Um `.test.ts` que exige banco
// deixaria o CI vermelho em todo PR. Este arquivo roda por script próprio
// (`pnpm --filter api test:e2e:pg`), com a fixture efêmera
// `scripts/e2e-postgres-fixture.sh`.
//
// ANTI-TEATRO (mesma regra de rtsp-pipeline.e2e.ts): sem banco configurado o
// teste PULA visivelmente; sob `DRAC_E2E_REQUIRED=1` ele FALHA em vez de passar
// verde — um e2e que se pula sozinho no CI é pior que não existir, porque
// mente.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DRAC_E2E_DATABASE_URL ?? '';
const REQUIRED = process.env.DRAC_E2E_REQUIRED === '1';

// Sufixo por processo: `node:test` roda ARQUIVOS em paralelo, e a branch de
// admin do serviço consulta TODAS as câmeras não-privadas do banco — linha
// deixada por outro teste quebraria a asserção de conjunto.
const TAG = `e2e${process.pid}`;
const id = (name: string) => `${TAG}-${name}`;

const CAM_COMUM = id('cam-comum');
const CAM_PRIVADA = id('cam-privada');
const CAM_OUTRA = id('cam-outra');
const GRUPO_OK = id('grupo-ok');
const GRUPO_RESTRITO = id('grupo-restrito');
const GRUPO_SUSPENSO = id('grupo-suspenso');
const DONO = id('dono');
const DELEGADO = id('delegado');
const ESTRANHO = id('estranho');
const ADMIN = id('admin');

const user = (uid: string, role: UserRole): AuthUser => ({ id: uid, role } as AuthUser);

if (!DB_URL) {
  const motivo = 'defina DRAC_E2E_DATABASE_URL (use scripts/e2e-postgres-fixture.sh run)';
  if (REQUIRED) {
    test('e2e de RBAC contra Postgres real', () => {
      assert.fail(`DRAC_E2E_REQUIRED=1 mas ${motivo}`);
    });
  } else {
    test('e2e de RBAC contra Postgres real', { skip: motivo }, () => {});
  }
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const svc = new AccessControlService(prisma as never);

  /**
   * Ordem de limpeza importa: `Camera.ownerUserId` é ON DELETE RESTRICT, então
   * a câmera sai ANTES do dono — apagar na ordem ingênua faz o próprio teardown
   * explodir.
   */
  async function limpar() {
    await prisma.cameraPermission.deleteMany({ where: { userId: { startsWith: TAG } } });
    await prisma.camera.deleteMany({ where: { id: { startsWith: TAG } } });
    await prisma.cameraGroup.deleteMany({ where: { id: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: TAG } } });
  }

  async function semear() {
    await limpar();

    // Colunas NOT NULL que o fixture em memória do teste-irmão pode omitir mas o
    // banco exige — parte do valor deste teste é justamente casar com o schema.
    await prisma.user.createMany({
      data: [DONO, DELEGADO, ESTRANHO, ADMIN].map((uid) => ({
        id: uid,
        name: uid,
        email: `${uid}@e2e.local`,
        passwordHash: 'x',
        role: uid === ADMIN ? UserRole.ADMIN : UserRole.VIEWER,
      })),
    });

    await prisma.cameraGroup.createMany({
      data: [
        { id: GRUPO_OK, name: GRUPO_OK, isActive: true, accessStatus: 'ACTIVE' },
        { id: GRUPO_RESTRITO, name: GRUPO_RESTRITO, isActive: true, accessStatus: 'RESTRICTED' },
        { id: GRUPO_SUSPENSO, name: GRUPO_SUSPENSO, isActive: true, accessStatus: 'SUSPENDED' },
      ],
    });

    await prisma.camera.createMany({
      data: [
        { id: CAM_COMUM, name: CAM_COMUM, ip: '10.0.0.1', username: 'u', passwordEncrypted: 'e', groupId: GRUPO_OK, isPrivate: false },
        { id: CAM_PRIVADA, name: CAM_PRIVADA, ip: '10.0.0.2', username: 'u', passwordEncrypted: 'e', groupId: GRUPO_OK, isPrivate: true, ownerUserId: DONO },
        { id: CAM_OUTRA, name: CAM_OUTRA, ip: '10.0.0.3', username: 'u', passwordEncrypted: 'e', groupId: GRUPO_RESTRITO, isPrivate: false },
      ],
    });

    await prisma.cameraPermission.createMany({
      data: [
        { userId: DONO, groupId: GRUPO_OK, level: CameraPermissionLevel.VIEW },
        { userId: DELEGADO, groupId: GRUPO_OK, level: CameraPermissionLevel.VIEW },
        { userId: ESTRANHO, groupId: GRUPO_OK, level: CameraPermissionLevel.VIEW },
      ],
    });
  }

  test.after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  test('privacidade: admin NÃO abre câmera privada de terceiro (banco real)', async () => {
    await semear();
    // A inversão de privilégio é a regra mais cara do produto (LGPD) e a que um
    // fake mais facilmente "confirma" por acidente.
    assert.equal(await svc.canViewCamera(user(ADMIN, UserRole.ADMIN), CAM_PRIVADA), false);
    assert.equal(await svc.canViewCamera(user(DONO, UserRole.VIEWER), CAM_PRIVADA), true);
    assert.equal(await svc.canViewCamera(user(ESTRANHO, UserRole.VIEWER), CAM_PRIVADA), false);
  });

  test('privacidade: permissão DIRETA do dono libera; a de grupo não', async () => {
    await semear();
    assert.equal(await svc.canViewCamera(user(DELEGADO, UserRole.VIEWER), CAM_PRIVADA), false,
      'permissão de GRUPO não pode abrir câmera privada');

    await prisma.cameraPermission.create({
      data: { userId: DELEGADO, cameraId: CAM_PRIVADA, level: CameraPermissionLevel.VIEW },
    });
    assert.equal(await svc.canViewCamera(user(DELEGADO, UserRole.VIEWER), CAM_PRIVADA), true,
      'permissão DIRETA do dono libera');
  });

  test('lista acessível: privada alheia não vaza nem para admin', async () => {
    await semear();
    const doAdmin = new Set(await svc.getAccessibleCameraIds(user(ADMIN, UserRole.ADMIN)));
    assert.ok(doAdmin.has(CAM_COMUM), 'admin vê as não-privadas');
    assert.ok(!doAdmin.has(CAM_PRIVADA), 'a privada de terceiro NÃO entra na lista do admin');

    const doDono = new Set(await svc.getAccessibleCameraIds(user(DONO, UserRole.VIEWER)));
    assert.ok(doDono.has(CAM_PRIVADA), 'o dono vê a própria privada');

    const doEstranho = new Set(await svc.getAccessibleCameraIds(user(ESTRANHO, UserRole.VIEWER)));
    assert.ok(!doEstranho.has(CAM_PRIVADA));
  });

  test('bloqueio comercial: grupo SUSPENSO deixa de conceder acesso', async () => {
    await semear();
    await prisma.cameraPermission.deleteMany({ where: { userId: ESTRANHO } });
    await prisma.cameraPermission.create({
      data: { userId: ESTRANHO, groupId: GRUPO_SUSPENSO, level: CameraPermissionLevel.VIEW },
    });
    await prisma.camera.update({ where: { id: CAM_COMUM }, data: { groupId: GRUPO_SUSPENSO } });

    assert.equal(await svc.canViewCamera(user(ESTRANHO, UserRole.VIEWER), CAM_COMUM), false,
      'grupo suspenso (inadimplente) não concede conteúdo');
    const lista = new Set(await svc.getAccessibleCameraIds(user(ESTRANHO, UserRole.VIEWER)));
    assert.ok(!lista.has(CAM_COMUM), 'e também some da listagem — bloquear só um dos dois seria cosmético');
  });

  test('RESTRICTED preserva ao vivo mas corta o histórico', async () => {
    await semear();
    await prisma.cameraPermission.deleteMany({ where: { userId: ESTRANHO } });
    await prisma.cameraPermission.create({
      data: { userId: ESTRANHO, groupId: GRUPO_RESTRITO, level: CameraPermissionLevel.VIEW },
    });

    const u = user(ESTRANHO, UserRole.VIEWER);
    assert.equal(await svc.canViewCamera(u, CAM_OUTRA), true, 'ao vivo continua');
    assert.equal(await svc.canPlaybackCamera(u, CAM_OUTRA), false, 'histórico é cortado');
    const playback = new Set(await svc.getPlaybackCameraIds(u));
    assert.ok(!playback.has(CAM_OUTRA), 'e a câmera some da lista de playback');

    // O admin da instalação precisa administrar quem ele bloqueou.
    assert.equal(await svc.canPlaybackCamera(user(ADMIN, UserRole.ADMIN), CAM_OUTRA), true);
  });

  test('assert* lança ForbiddenException (o caminho que o controller usa)', async () => {
    await semear();
    await assert.rejects(
      () => svc.assertCanViewCamera(user(ESTRANHO, UserRole.VIEWER), CAM_PRIVADA),
      /permissão/i,
    );
    await assert.doesNotReject(() => svc.assertCanViewCamera(user(DONO, UserRole.VIEWER), CAM_PRIVADA));
  });

  test('constraint do banco: permissão com câmera E grupo é REJEITADA', async () => {
    await semear();
    // O fake aceita qualquer linha; o banco tem o CHECK
    // `CameraPermission_exactly_one_target_check`. Se essa invariante cair numa
    // migration futura, o modelo de permissão perde a âncora — e só um teste
    // contra banco real percebe.
    await assert.rejects(
      () => prisma.cameraPermission.create({
        data: { userId: ESTRANHO, cameraId: CAM_COMUM, groupId: GRUPO_OK, level: CameraPermissionLevel.VIEW },
      }),
      'permissão não pode mirar câmera e grupo ao mesmo tempo',
    );
    await assert.rejects(
      () => prisma.cameraPermission.create({
        data: { userId: ESTRANHO, level: CameraPermissionLevel.VIEW },
      }),
      'permissão sem alvo também é inválida',
    );
  });

  test('constraint do banco: dono de câmera privada não pode ser apagado (RESTRICT)', async () => {
    await semear();
    // Proteção real de integridade: apagar o dono deixaria a câmera privada
    // órfã — e uma câmera privada sem dono é exatamente o estado em que a
    // inversão de privilégio de admin deixa de ter a quem proteger.
    await assert.rejects(
      () => prisma.user.delete({ where: { id: DONO } }),
      'apagar o dono de uma câmera privada tem que ser barrado pelo banco',
    );
  });
}
