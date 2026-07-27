'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PgStore } = require('../src/datastore/pg-store');

// `CREATE TABLE IF NOT EXISTS` não é livre de corrida no Postgres. Isto não é
// teoria: com a série temporal, o schema passou a ser criado por dois caminhos
// (documento e série) e a suíte quebrou de verdade num banco novo com
// "duplicate key value violates unique constraint pg_type_typname_nsp_index".
// O DDL é idempotente, então a resposta é repetir — mas só para erro de CORRIDA.

function fakePool(sequence) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      const next = sequence[calls.length - 1];
      if (next instanceof Error) throw next;
      return next ?? { rows: [] };
    },
  };
}

function pgError(code) {
  const error = new Error(`erro postgres ${code}`);
  error.code = code;
  return error;
}

test('initSchema repete o DDL quando dois processos criam o schema ao mesmo tempo', async () => {
  const pool = fakePool([pgError('23505'), { rows: [] }]);
  const store = new PgStore({ pool });
  await store.initSchema();
  assert.equal(pool.calls.length, 2, 'a corrida de catálogo tem de ser retentada');
  assert.match(pool.calls[1], /CREATE TABLE IF NOT EXISTS central_installations/);
});

test('initSchema repete também para "relation already exists" (42P07)', async () => {
  const pool = fakePool([pgError('42P07'), { rows: [] }]);
  const store = new PgStore({ pool });
  await store.initSchema();
  assert.equal(pool.calls.length, 2);
});

test('initSchema NÃO mascara erro real (credencial/permissão sobe na primeira)', async () => {
  const pool = fakePool([pgError('28P01'), { rows: [] }]);
  const store = new PgStore({ pool });
  await assert.rejects(() => store.initSchema(), /28P01/);
  assert.equal(pool.calls.length, 1, 'erro que não é de corrida não pode ser retentado');
});

test('initSchema desiste depois de esgotar as tentativas (não fica em laço)', async () => {
  const pool = fakePool([pgError('23505'), pgError('23505'), pgError('23505'), { rows: [] }]);
  const store = new PgStore({ pool });
  await assert.rejects(() => store.initSchema(), /23505/);
  assert.equal(pool.calls.length, 3);
});

test('initSchema com falha NÃO fica memoizado (o banco pode subir depois)', async () => {
  const pool = fakePool([pgError('28P01'), { rows: [] }]);
  const store = new PgStore({ pool });
  await assert.rejects(() => store.initSchema());
  await store.initSchema();
  assert.equal(pool.calls.length, 2, 'a segunda chamada tenta de novo em vez de repetir a rejeição');
});

test('initSchema bem-sucedido roda o DDL UMA vez só (memoizado)', async () => {
  const pool = fakePool([{ rows: [] }, { rows: [] }]);
  const store = new PgStore({ pool });
  await store.initSchema();
  await store.initSchema();
  assert.equal(pool.calls.length, 1);
});
