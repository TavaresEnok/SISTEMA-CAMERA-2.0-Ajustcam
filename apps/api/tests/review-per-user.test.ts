import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review/review.service';

// ─────────────────────────────────────────────────────────────────────────────
// D6/D4 (2.6): "visto" é POR USUÁRIO. Marcar visto por um operador NÃO pode
// marcar para os outros (bug do reviewedAt global). Fake com estado por (user,evento).
// ─────────────────────────────────────────────────────────────────────────────

const events = [
  { id: 'E1', cameraId: 'cam-1', occurredAt: new Date(2026, 6, 24, 10, 0, 0), metadata: {}, camera: { name: 'Cam 1' }, type: 'MOTION_DETECTED', severity: 'INFO' },
];

function makeService() {
  const reviews = new Set<string>(); // `${userId}:${eventId}`
  const prisma = {
    cameraEvent: {
      findMany: async () => events,
      count: async () => events.length,
      findUnique: async ({ where }: any) => events.find((e) => e.id === where.id) ?? null,
    },
    recording: { findMany: async () => [] },
    userEventReview: {
      findMany: async ({ where }: any) => {
        const uid = where.userId;
        const ids: string[] = where.eventId?.in ?? [];
        return ids.filter((id) => reviews.has(`${uid}:${id}`)).map((eventId) => ({ eventId }));
      },
      upsert: async ({ where }: any) => { reviews.add(`${where.userId_eventId.userId}:${where.userId_eventId.eventId}`); return {}; },
      deleteMany: async ({ where }: any) => { reviews.delete(`${where.userId}:${where.eventId}`); return { count: 1 }; },
    },
  } as any;
  const accessControl = {
    getAccessibleCameraIds: async () => ['cam-1'],
    canViewCamera: async () => true,
  } as any;
  const svc = new ReviewService(prisma, accessControl, {} as any);
  return { svc, reviews };
}

async function reviewedFlag(svc: ReviewService, userId: string) {
  const { items } = await svc.feed({ id: userId } as any, {});
  return items.find((i: any) => i.id === 'E1')?.reviewed;
}

test('2.6: marcar visto por um operador NÃO afeta o feed de outro', async () => {
  const { svc } = makeService();
  await svc.markSeen({ id: 'userA' } as any, 'E1', true);
  assert.equal(await reviewedFlag(svc, 'userA'), true, 'quem marcou vê como revisado');
  assert.equal(await reviewedFlag(svc, 'userB'), false, 'o OUTRO operador continua vendo como NÃO revisado');
});

test('2.6: desmarcar remove só o "visto" daquele usuário', async () => {
  const { svc } = makeService();
  await svc.markSeen({ id: 'userA' } as any, 'E1', true);
  await svc.markSeen({ id: 'userA' } as any, 'E1', false);
  assert.equal(await reviewedFlag(svc, 'userA'), false);
});
