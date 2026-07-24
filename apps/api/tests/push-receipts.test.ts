import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushReceiptsProcessor } from '../src/jobs/processors/push-receipts.processor';
import { pushReceiptsDelayMs } from '../src/jobs/queues/push-receipts.queue';

// ─────────────────────────────────────────────────────────────────────────────
// 2.8 — job ATRASADO do estágio 2 do push: recebe os receiptIds, consulta os
// receipts do Expo e remove os tokens mortos via push-devices.
// ─────────────────────────────────────────────────────────────────────────────

function makeProcessor(fetchResult: { invalidTokens: string[] }) {
  const calls = { fetched: [] as Array<Record<string, string>>, pruned: [] as string[][] };
  const pushService = {
    async fetchReceipts(map: Record<string, string>) {
      calls.fetched.push(map);
      return fetchResult;
    },
  } as any;
  const pushDevices = {
    async pruneInvalid(tokens: string[]) {
      calls.pruned.push(tokens);
    },
  } as any;
  const proc = new PushReceiptsProcessor(pushService, pushDevices) as any;
  proc.logger = { log() {}, warn() {} };
  return { proc, calls };
}

test('2.8: consulta os receipts e poda os tokens mortos', async () => {
  const { proc, calls } = makeProcessor({ invalidTokens: ['ExponentPushToken[dead]'] });
  const receiptIds = { 'rec-1': 'ExponentPushToken[a]', 'rec-2': 'ExponentPushToken[dead]' };
  await proc.process({ id: 'job-1', data: { receiptIds } });

  assert.equal(calls.fetched.length, 1, 'fetchReceipts chamado uma vez');
  assert.deepEqual(calls.fetched[0], receiptIds, 'mapa receiptId→token repassado igual');
  assert.deepEqual(calls.pruned, [['ExponentPushToken[dead]']], 'só o token morto é removido');
});

test('2.8: sem token morto → não chama pruneInvalid', async () => {
  const { proc, calls } = makeProcessor({ invalidTokens: [] });
  await proc.process({ id: 'job-2', data: { receiptIds: { 'rec-1': 'ExponentPushToken[a]' } } });
  assert.equal(calls.fetched.length, 1, 'ainda consulta os receipts');
  assert.deepEqual(calls.pruned, [], 'nada a podar → sem chamada de remoção');
});

test('2.8: receiptIds vazio → não faz I/O nenhum', async () => {
  const { proc, calls } = makeProcessor({ invalidTokens: ['x'] });
  await proc.process({ id: 'job-3', data: { receiptIds: {} } });
  assert.deepEqual(calls.fetched, [], 'sem receipts, nem consulta');
  assert.deepEqual(calls.pruned, [], 'sem receipts, nem poda');
});

test('2.8: job sem data não quebra', async () => {
  const { proc, calls } = makeProcessor({ invalidTokens: [] });
  await proc.process({ id: 'job-4' });
  assert.deepEqual(calls.fetched, []);
});

test('2.8: atraso padrão é ~15min (900000ms), configurável por env', () => {
  const previous = process.env.PUSH_RECEIPTS_DELAY_MS;
  delete process.env.PUSH_RECEIPTS_DELAY_MS;
  assert.equal(pushReceiptsDelayMs(), 15 * 60_000, 'padrão 15 minutos');
  process.env.PUSH_RECEIPTS_DELAY_MS = '1000';
  assert.equal(pushReceiptsDelayMs(), 1000, 'sobrescrito pelo env');
  process.env.PUSH_RECEIPTS_DELAY_MS = 'lixo';
  assert.equal(pushReceiptsDelayMs(), 15 * 60_000, 'valor inválido cai no padrão');
  if (previous === undefined) delete process.env.PUSH_RECEIPTS_DELAY_MS;
  else process.env.PUSH_RECEIPTS_DELAY_MS = previous;
});
