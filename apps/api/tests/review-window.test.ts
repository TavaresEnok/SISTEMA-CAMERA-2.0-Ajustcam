import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review/review.service';

// A query em lote que matou o N+1 buscava TODOS os segmentos entre o evento mais
// antigo e o mais novo da página. Numa página esparsa (site quieto, filtro raro,
// offset profundo) isso varre semanas de segmentos — ~288 linhas/câmera/dia — e
// fica PIOR que o N+1 que substituiu. Estes testes travam o recorte em janelas.

const day = (d: number, h = 10) => new Date(2026, 6, d, h, 0, 0);

function makeService(eventDates: Date[]) {
  const captured: any = { recordingWhere: null, countWhere: null };
  const events = eventDates.map((occurredAt, i) => ({
    id: `E${i}`, cameraId: 'cam-1', occurredAt, metadata: {},
    camera: { name: 'Cam 1' }, type: 'MOTION_DETECTED', severity: 'INFO', reviewedAt: null,
  }));
  const prisma = {
    cameraEvent: {
      findMany: async () => events,
      count: async ({ where }: any) => { captured.countWhere = where; return events.length; },
    },
    recording: {
      findMany: async ({ where }: any) => { captured.recordingWhere = where; return []; },
      findFirst: async () => null,
    },
    userEventReview: { findMany: async () => [] },
  };
  const access = { getAccessibleCameraIds: async () => ['cam-1'] };
  const svc = new ReviewService(prisma as any, access as any, {} as any);
  return { svc, captured };
}

test('feed: eventos densos (mesmo dia) usam UMA janela — sem regressão no caso comum', async () => {
  const { svc, captured } = makeService([day(24, 10), day(24, 11), day(24, 12)]);
  await svc.feed({ id: 'u1', email: 'u@t', name: 'U', role: 'ADMIN' } as any, {});
  assert.equal(captured.recordingWhere.OR.length, 1, 'página densa deveria virar 1 janela só');
});

test('feed: eventos esparsos viram janelas SEPARADAS (não uma varredura gigante)', async () => {
  // 3 eventos separados por ~10 dias: a janela única cobriria ~20 dias de segmentos.
  const { svc, captured } = makeService([day(1), day(11), day(21)]);
  await svc.feed({ id: 'u1', email: 'u@t', name: 'U', role: 'ADMIN' } as any, {});
  assert.equal(captured.recordingWhere.OR.length, 3, 'cada evento distante deveria ter sua própria janela');
  // Nenhuma janela pode ser maior que o teto (24h).
  for (const w of captured.recordingWhere.OR) {
    const lte = new Date(w.startedAt.lte).getTime();
    const gte = new Date(w.OR.find((o: any) => o.endedAt?.gte).endedAt.gte).getTime();
    assert.ok(lte - gte <= 24 * 60 * 60 * 1000, `janela de ${(lte - gte) / 3600000}h excede o teto de 24h`);
  }
});

test('unseenCount: aplica recorte temporal (badge não conta o histórico inteiro)', async () => {
  const { svc, captured } = makeService([day(24)]);
  await svc.unseenCount({ id: 'u1', email: 'u@t', name: 'U', role: 'ADMIN' } as any);
  assert.ok(captured.countWhere.occurredAt?.gte instanceof Date, 'a contagem precisa de janela temporal');
  const days = (Date.now() - captured.countWhere.occurredAt.gte.getTime()) / 86_400_000;
  assert.ok(days > 0 && days <= 400, `janela fora do razoável: ${days} dias`);
});
