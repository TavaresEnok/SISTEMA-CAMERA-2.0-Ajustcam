import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review/review.service';

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

function filterRecs(where: any) {
  const camMatch = (r: any) => (where.cameraId?.in ? where.cameraId.in.includes(r.cameraId) : r.cameraId === where.cameraId);
  const lte = where.startedAt?.lte ? new Date(where.startedAt.lte).getTime() : Infinity;
  const gteRaw = where.OR?.find((o: any) => o.endedAt?.gte)?.endedAt?.gte;
  const gte = gteRaw ? new Date(gteRaw).getTime() : null;
  return recordingsDb
    .filter((r) =>
      camMatch(r) &&
      r.startedAt.getTime() <= lte &&
      (r.endedAt == null || (gte == null ? true : r.endedAt.getTime() >= gte)))
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

function makeService() {
  const calls = { findFirst: 0, findMany: 0 };
  const prisma = {
    cameraEvent: { findMany: async () => events, count: async () => events.length },
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
  assert.equal(byId.E4.recordingId, null, 'evento antes de qualquer gravação não aponta para nada');
  assert.equal(byId.E4.offsetSeconds, null);
});

test('D4 review feed: NÃO faz uma query de gravação por evento (sem N+1)', async () => {
  const { svc, calls } = makeService();
  await svc.feed({ id: 'u1' } as any, { limit: 40 });
  assert.equal(calls.findFirst, 0, 'não deve haver findFirst por evento');
  assert.equal(calls.findMany, 1, 'uma única query em lote das gravações da página');
});
