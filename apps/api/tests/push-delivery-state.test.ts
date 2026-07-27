import test from 'node:test';
import assert from 'node:assert/strict';
import { PushReceiptsProcessor } from '../src/jobs/processors/push-receipts.processor';

// Máquina de estados do push (correção do 2.8): o ticket aceito pelo Expo NÃO é
// entrega. O estágio 1 grava ACCEPTED; só o RECEIPT (estágio 2) promove para
// DELIVERED/FAILED. E falha de rede na consulta não pode ser engolida — o job tem
// de RELANÇAR para as tentativas configuradas acontecerem de verdade.

function makeProcessor(fetchResult: any) {
  const proc: any = Object.create(PushReceiptsProcessor.prototype);
  const state: any = { pruned: [], updated: null };
  proc.logger = { log() {}, warn() {} };
  proc.pushService = { fetchReceipts: async () => fetchResult };
  proc.pushDevices = { pruneInvalid: async (t: string[]) => { state.pruned.push(...t); } };
  proc.prisma = {
    alarmInstance: {
      findUnique: async () => ({ metadata: { notificationDelivery: [{ channel: 'push', status: 'ACCEPTED' }] } }),
      update: async (args: any) => { state.updated = args.data.metadata; return {}; },
    },
  };
  return { proc, state };
}

const job = (data: any) => ({ id: 'j1', data }) as any;

test('push: receipts OK PROMOVEM o alarme de ACCEPTED para DELIVERED', async () => {
  const { proc, state } = makeProcessor({ invalidTokens: [], failedChunks: 0, lastError: null, okCount: 2, errorCount: 0 });
  await proc.process(job({ receiptIds: { r1: 't1' }, alarmId: 'a1' }));
  const entries = state.updated.notificationDelivery;
  const last = entries[entries.length - 1];
  assert.equal(last.status, 'DELIVERED');
  assert.equal(last.stage, 'receipt', 'a promoção deve ser identificável como estágio de receipt');
});

test('push: receipts com erro registram FAILED (entrega negada)', async () => {
  const { proc, state } = makeProcessor({ invalidTokens: ['t1'], failedChunks: 0, lastError: null, okCount: 0, errorCount: 1 });
  await proc.process(job({ receiptIds: { r1: 't1' }, alarmId: 'a1' }));
  const entries = state.updated.notificationDelivery;
  assert.equal(entries[entries.length - 1].status, 'FAILED');
  assert.deepEqual(state.pruned, ['t1'], 'token morto deve ser podado');
});

test('push: falha de rede RELANÇA (senão as tentativas nunca acontecem)', async () => {
  const { proc } = makeProcessor({ invalidTokens: [], failedChunks: 1, lastError: 'ETIMEDOUT', okCount: 0, errorCount: 0 });
  await assert.rejects(
    () => proc.process(job({ receiptIds: { r1: 't1' }, alarmId: 'a1' })),
    /ETIMEDOUT|lote/,
    'o job precisa falhar para o BullMQ retentar',
  );
});

test('push: falha de rede ainda PODA os tokens já confirmados mortos (progresso preservado)', async () => {
  const { proc, state } = makeProcessor({ invalidTokens: ['morto'], failedChunks: 1, lastError: 'ECONNRESET', okCount: 0, errorCount: 1 });
  await assert.rejects(() => proc.process(job({ receiptIds: { r1: 't1' }, alarmId: 'a1' })));
  assert.deepEqual(state.pruned, ['morto'], 'o progresso obtido antes da falha não pode ser perdido');
});

test('push: job legado sem alarmId não quebra (só poda, sem promover)', async () => {
  const { proc, state } = makeProcessor({ invalidTokens: [], failedChunks: 0, lastError: null, okCount: 1, errorCount: 0 });
  await proc.process(job({ receiptIds: { r1: 't1' } }));
  assert.equal(state.updated, null, 'sem alarmId não há o que promover');
});
