import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRemoveToken, invalidTokensFromReceipts } from '../src/notifications/expo-receipts.helper';

// D6 (2.8): entrega de push comprovada — receipts pegam erros que o ticket não pega,
// e só DeviceNotRegistered mata o token (config/rate NÃO removem).

test('2.8: só DeviceNotRegistered marca o token para remoção', () => {
  assert.equal(shouldRemoveToken('DeviceNotRegistered'), true);
  assert.equal(shouldRemoveToken('MessageTooBig'), false, 'config/rate não remove token');
  assert.equal(shouldRemoveToken('MessageRateExceeded'), false);
  assert.equal(shouldRemoveToken('MismatchSenderId'), false);
  assert.equal(shouldRemoveToken(undefined), false);
  assert.equal(shouldRemoveToken(''), false);
});

test('2.8: extrai os tokens mortos dos receipts, mapeando por receiptId', () => {
  const receipts = {
    'rec-1': { status: 'ok' as const },
    'rec-2': { status: 'error' as const, details: { error: 'DeviceNotRegistered' } },
    'rec-3': { status: 'error' as const, details: { error: 'MessageTooBig' } },
  };
  const idToToken = { 'rec-1': 'ExponentPushToken[a]', 'rec-2': 'ExponentPushToken[b]', 'rec-3': 'ExponentPushToken[c]' };
  const { invalidTokens, errors } = invalidTokensFromReceipts(receipts, idToToken);
  assert.deepEqual(invalidTokens, ['ExponentPushToken[b]'], 'só o DeviceNotRegistered vira token morto');
  assert.equal(errors.length, 2, 'os dois erros são reportados (mesmo o que não remove)');
});

test('2.8: receipt de erro sem token mapeado é ignorado (sem quebrar)', () => {
  const { invalidTokens } = invalidTokensFromReceipts(
    { 'rec-x': { status: 'error', details: { error: 'DeviceNotRegistered' } } },
    {},
  );
  assert.deepEqual(invalidTokens, []);
});

test('2.8: receipts vazio/nulo não quebra', () => {
  assert.deepEqual(invalidTokensFromReceipts(null, {}).invalidTokens, []);
  assert.deepEqual(invalidTokensFromReceipts({}, {}).invalidTokens, []);
});
