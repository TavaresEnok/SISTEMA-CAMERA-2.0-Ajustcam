import test from 'node:test';
import assert from 'node:assert/strict';
import { withStartupTimeout } from '../src/jobs/jobs.module';

test('operação BullMQ que nunca responde falha dentro do prazo', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () => withStartupTimeout(
      new Promise<never>(() => undefined),
      25,
      'Redis sintético',
    ),
    /Redis sintético excedeu o prazo de 25ms/,
  );
  assert.ok(Date.now() - startedAt < 500, 'o bootstrap não pode ficar preso');
});

test('operação concluída limpa o timer e preserva o resultado', async () => {
  const result = await withStartupTimeout(Promise.resolve('ok'), 1000, 'fila');
  assert.equal(result, 'ok');
});
