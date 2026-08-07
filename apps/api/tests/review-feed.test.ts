import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review/review.service';
import { criarQueryRaw } from './review-raw-fake';

// ─────────────────────────────────────────────────────────────────────────────
// D4: a fila de Revisão enriquece cada evento com a gravação que cobre o instante
// (recordingId + offsetSeconds). O mapeamento deve ser exato; e NÃO pode custar
// uma query por evento (N+1). Fake prisma que implementa a semântica da query E
// conta as chamadas — o teste de contagem documenta o N+1 e prova o fix.
// ─────────────────────────────────────────────────────────────────────────────

const D = (h: number, m: number, s: number) => new Date(2026, 6, 24, h, m, s);

const recordingsDb = [
  { id: 'R1', cameraId: 'cam-1', startedAt: D(10, 0, 0), endedAt: D(10, 5, 0) },
  { id: 'R2', cameraId: 'cam-1', startedAt: D(10, 5, 0), endedAt: null },        // em andamento
  { id: 'R3', cameraId: 'cam-2', startedAt: D(10, 0, 0), endedAt: D(10, 10, 0) },
];

const events = [
  { id: 'E1', cameraId: 'cam-1', occurredAt: D(10, 2, 30), metadata: {}, camera: { name: 'Cam 1' }, type: 'MOTION_DETECTED', severity: 'INFO', reviewedAt: null },
  { id: 'E2', cameraId: 'cam-1', occurredAt: D(10, 6, 0), metadata: {}, camera: { name: 'Cam 1' }, type: 'MOTION_DETECTED', severity: 'INFO', reviewedAt: null },
  { id: 'E3', cameraId: 'cam-2', occurredAt: D(10, 8, 0), metadata: {}, camera: { name: 'Cam 2' }, type: 'MOTION_DETECTED', severity: 'INFO', reviewedAt: null },
  { id: 'E4', cameraId: 'cam-1', occurredAt: D(9, 59, 0), metadata: {}, camera: { name: 'Cam 1' }, type: 'MOTION_DETECTED', severity: 'INFO', reviewedAt: null }, // antes de qualquer gravação
];

// Modela as DUAS formas de where que o serviço emite, para o fake continuar fiel:
//  - findFirst (por evento): { startedAt: {lte}, OR: [{endedAt:null},{endedAt:{gte}}] }
//  - findMany em lote: { OR: [ <mesma forma, uma por JANELA> ] }
function matchesRange(r: any, range: any) {
  const lte = range.startedAt?.lte ? new Date(range.startedAt.lte).getTime() : Infinity;
  const gteRaw = range.OR?.find((o: any) => o.endedAt?.gte)?.endedAt?.gte;
  const gte = gteRaw ? new Date(gteRaw).getTime() : null;
  return r.startedAt.getTime() <= lte
    && (r.endedAt == null || (gte == null ? true : r.endedAt.getTime() >= gte));
}

function filterRecs(where: any) {
  const camMatch = (r: any) => (where.cameraId?.in ? where.cameraId.in.includes(r.cameraId) : r.cameraId === where.cameraId);
  // Lote por janelas: o OR de topo carrega os intervalos (cada um com seu startedAt).
  const windows = Array.isArray(where.OR) && where.OR.some((o: any) => o.startedAt) ? where.OR : [where];
  return recordingsDb
    .filter((r) => camMatch(r) && windows.some((w: any) => matchesRange(r, w)))
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

function makeService() {
  const calls = { findFirst: 0, findMany: 0 };
  const prisma = {
    cameraEvent: {
      // O serviço passou a buscar por id (a seleção acontece no SQL).
      findMany: async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? [];
        return ids.length ? events.filter((e) => ids.includes(e.id)) : events;
      },
      count: async () => events.length,
    },
    $queryRaw: criarQueryRaw(events, recordingsDb),
    recording: {
      findFirst: async ({ where }: any) => { calls.findFirst++; return filterRecs(where)[0] ?? null; },
      findMany: async ({ where }: any) => { calls.findMany++; return filterRecs(where); },
    },
    userEventReview: { findMany: async () => [] },
  } as any;
  const accessControl = { getAccessibleCameraIds: async () => ['cam-1', 'cam-2'] } as any;
  const svc = new ReviewService(prisma, accessControl, {} as any);
  return { svc, calls };
}

test('D4 review feed: mapeia cada evento à gravação que cobre o instante + offset', async () => {
  const { svc } = makeService();
  const { items } = await svc.feed({ id: 'u1' } as any, { limit: 40 });
  const byId = Object.fromEntries(items.map((i: any) => [i.id, i]));

  assert.equal(byId.E1.recordingId, 'R1');
  assert.equal(byId.E1.offsetSeconds, 150, '10:02:30 - 10:00:00 = 150s');
  assert.equal(byId.E2.recordingId, 'R2', 'gravação em andamento (endedAt null) cobre o instante');
  assert.equal(byId.E2.offsetSeconds, 60);
  assert.equal(byId.E3.recordingId, 'R3');
  assert.equal(byId.E3.offsetSeconds, 480);
  // MUDOU EM 07/08/2026: antes o E4 vinha na lista com recordingId null e
  // virava um card morto na grade ("sem gravação", clique levando a uma
  // reprodução vazia). Agora ele é filtrado NO SQL e não chega ao operador.
  assert.equal(byId.E4, undefined, 'evento sem gravação que o cubra não entra na fila');
  assert.equal(items.length, 3, 'só os três eventos com vídeo');
});

test('feed avisa que existem detecções cujo vídeo já não existe', async () => {
  const { svc } = makeService();
  const resposta: any = await svc.feed({ id: 'u1' } as any, { limit: 40 });
  // E4 está fora da lista, mas o operador precisa saber POR QUE a fila pode
  // parecer menor do que o esperado — senão vai mexer em filtro à toa.
  assert.equal(resposta.haEventoSemVideo, true);
});

test('feed informa se há mais páginas sem contar o acervo inteiro', async () => {
  const { svc } = makeService();
  const primeira: any = await svc.feed({ id: 'u1' } as any, { limit: 2 });
  assert.equal(primeira.items.length, 2);
  assert.equal(primeira.temMais, true, 'há 3 revisáveis e a página pediu 2');

  const segunda: any = await svc.feed({ id: 'u1' } as any, { limit: 40 });
  assert.equal(segunda.temMais, false, 'a página cobriu tudo');
});

test('D4 review feed: NÃO faz uma query de gravação por evento (sem N+1)', async () => {
  const { svc, calls } = makeService();
  await svc.feed({ id: 'u1' } as any, { limit: 40 });
  assert.equal(calls.findFirst, 0, 'não deve haver findFirst por evento');
  assert.equal(calls.findMany, 1, 'uma única query em lote das gravações da página');
});
