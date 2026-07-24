'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const d = require('../src/datastore/dual-read');

test('resolveDualRead: Postgres vence; cai p/ legado quando o PG está ausente (null/undefined)', () => {
  assert.equal(d.resolveDualRead('pg', 'legacy'), 'pg');
  assert.equal(d.resolveDualRead(null, 'legacy'), 'legacy');
  assert.equal(d.resolveDualRead(undefined, 'legacy'), 'legacy');
  // valores "falsy" que NÃO são ausência (0, '', false) continuam vencendo pelo PG.
  assert.equal(d.resolveDualRead(0, 'legacy'), 0);
  assert.equal(d.resolveDualRead('', 'legacy'), '');
  assert.equal(d.resolveDualRead(false, 'legacy'), false);
});

test('mergeMap: legado preenche lacunas, Postgres é autoridade nas colisões', () => {
  const pg = { a: { v: 'pg-a' }, c: { v: 'pg-c' } };
  const legacy = { a: { v: 'legacy-a' }, b: { v: 'legacy-b' } };
  const merged = d.mergeMap(pg, legacy);
  assert.equal(merged.a.v, 'pg-a'); // colisão → PG vence
  assert.equal(merged.b.v, 'legacy-b'); // só no legado → preenche
  assert.equal(merged.c.v, 'pg-c'); // só no PG
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c']);
});

test('mergeAuditEvents: união por id, ordenado cronologicamente; PG vence no mesmo id', () => {
  const pg = [
    { id: '2', at: '2026-07-24T00:02:00.000Z', type: 'pg2' },
    { id: '1', at: '2026-07-24T00:01:00.000Z', type: 'pg1' },
  ];
  const legacy = [
    { id: '1', at: '2026-07-24T00:01:00.000Z', type: 'legacy1' },
    { id: '3', at: '2026-07-24T00:00:00.000Z', type: 'legacy3' },
  ];
  const merged = d.mergeAuditEvents(pg, legacy);
  assert.deepEqual(merged.map((e) => e.id), ['3', '1', '2']); // ordem cronológica
  assert.equal(merged.find((e) => e.id === '1').type, 'pg1'); // PG vence no id colidido
});

test('mergeDb: combina installations/users/sessions/auditEvents e mantém PG como autoridade', () => {
  const pgDb = {
    installations: { x: { id: 'x', src: 'pg' } },
    users: { 'a@b.com': { name: 'pg' } },
    sessions: { h1: { email: 'pg' } },
    auditEvents: [{ id: '1', at: '2026-07-24T00:01:00.000Z' }],
  };
  const legacyDb = {
    installations: { x: { id: 'x', src: 'legacy' }, y: { id: 'y', src: 'legacy' } },
    users: { 'c@d.com': { name: 'legacy' } },
    sessions: { h2: { email: 'legacy' } },
    auditEvents: [{ id: '0', at: '2026-07-24T00:00:00.000Z' }],
  };
  const merged = d.mergeDb(pgDb, legacyDb);
  assert.equal(merged.installations.x.src, 'pg'); // PG vence
  assert.equal(merged.installations.y.src, 'legacy'); // legado preenche
  assert.deepEqual(Object.keys(merged.users).sort(), ['a@b.com', 'c@d.com']);
  assert.deepEqual(Object.keys(merged.sessions).sort(), ['h1', 'h2']);
  assert.deepEqual(merged.auditEvents.map((e) => e.id), ['0', '1']);
});

test('reconcile: lista o que existe no legado e FALTA no Postgres (backfill), preservando ordem', () => {
  const legacyDb = {
    installations: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
    users: { 'x@y.com': { name: 'X' } },
    sessions: { s1: { email: 'e' } },
    auditEvents: [{ id: '1' }, { id: '2' }, { id: '3' }],
  };
  const pgKeys = {
    installations: new Set(['b']),
    users: new Set(),
    sessions: new Set(['s1']),
    auditEvents: new Set(['2']),
  };
  const plan = d.reconcile(legacyDb, pgKeys);
  assert.deepEqual(plan.installations.map((r) => r.id), ['a', 'c']); // b já está no PG
  assert.deepEqual(plan.users.map((r) => r.id), ['x@y.com']);
  assert.deepEqual(plan.sessions.map((r) => r.id), []); // s1 já está no PG
  assert.deepEqual(plan.auditEvents.map((e) => e.id), ['1', '3']); // 2 já está no PG
  assert.equal(d.reconcileCount(plan), 5); // 2 inst + 1 user + 0 sessão + 2 audit
});

test('keysToDelete: numa escrita de doc inteiro, apaga do PG as chaves ausentes no estado desejado', () => {
  const current = new Set(['a', 'b', 'c']);
  const desired = new Set(['b']);
  assert.deepEqual(d.keysToDelete(current, desired).sort(), ['a', 'c']);
  // estado desejado vazio → apaga tudo
  assert.deepEqual(d.keysToDelete(current, new Set()).sort(), ['a', 'b', 'c']);
  // nada a apagar
  assert.deepEqual(d.keysToDelete(new Set(['b']), desired), []);
});
