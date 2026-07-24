'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const m = require('../src/datastore/mappers');

test('installationToRow extrai colunas e preserva o payload; rowToInstallation faz round-trip idêntico', () => {
  const item = {
    id: 'cliente-a',
    licenseKey: 'drac-abc',
    customerName: 'Cliente A',
    licenseStatus: 'ACTIVE',
    lastHeartbeatAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:05:00.000Z',
    metrics: { cameras: { total: 3, online: 2 } },
    alerts: [{ code: 'x', message: 'y' }],
  };
  const row = m.installationToRow('cliente-a', item);
  assert.equal(row.id, 'cliente-a');
  assert.equal(row.license_key, 'drac-abc');
  assert.equal(row.customer_name, 'Cliente A');
  assert.equal(row.license_status, 'ACTIVE');
  assert.equal(row.last_heartbeat_at, '2026-07-24T10:00:00.000Z');
  assert.equal(row.updated_at, '2026-07-24T10:05:00.000Z');
  // round-trip: o registro reconstruído é IGUAL ao original.
  const back = m.rowToInstallation(row);
  assert.deepEqual(back, item);
});

test('rowToInstallation usa o id da coluna quando o payload não tem id', () => {
  const back = m.rowToInstallation({ id: 'k', payload: { customerName: 'X' } });
  assert.equal(back.id, 'k');
  assert.equal(back.customerName, 'X');
});

test('toTimestamp: ISO válido vira ISO, inválido/vazio vira null (timestamptz não aceita lixo)', () => {
  assert.equal(m.toTimestamp('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z');
  assert.equal(m.toTimestamp(''), null);
  assert.equal(m.toTimestamp(null), null);
  assert.equal(m.toTimestamp(undefined), null);
  assert.equal(m.toTimestamp('not-a-date'), null);
  assert.equal(m.toTimestamp('Invalid Date'), null);
});

test('userToRow normaliza e-mail e extrai passwordHash; round-trip preserva o payload', () => {
  const user = { name: 'Fulano', passwordHash: 'pbkdf2_sha256$600000$s$h', createdAt: '2026-07-01T00:00:00.000Z', createdBy: 'admin@drac.local' };
  const row = m.userToRow('  Fulano@Example.COM ', user);
  assert.equal(row.email, 'fulano@example.com');
  assert.equal(row.password_hash, 'pbkdf2_sha256$600000$s$h');
  assert.equal(row.created_by, 'admin@drac.local');
  assert.deepEqual(m.rowToUser(row), user);
});

test('sessionToRow extrai expiresAt/email; round-trip idêntico', () => {
  const session = { email: 'a@b.com', createdAt: '2026-07-24T00:00:00.000Z', lastSeenAt: '2026-07-24T00:10:00.000Z', expiresAt: '2026-07-24T08:00:00.000Z' };
  const row = m.sessionToRow('hash123', session);
  assert.equal(row.token_hash, 'hash123');
  assert.equal(row.email, 'a@b.com');
  assert.equal(row.expires_at, '2026-07-24T08:00:00.000Z');
  assert.deepEqual(m.rowToSession(row), session);
});

test('auditEventToRow extrai type/actor/installationId; round-trip idêntico', () => {
  const ev = { id: 'uuid-1', at: '2026-07-24T00:00:00.000Z', type: 'auth.login_success', actor: 'admin@drac.local', result: 'accepted', ip: '1.2.3.4', installationId: 'cli-x' };
  const row = m.auditEventToRow(ev);
  assert.equal(row.id, 'uuid-1');
  assert.equal(row.type, 'auth.login_success');
  assert.equal(row.installation_id, 'cli-x');
  assert.deepEqual(m.rowToAuditEvent(row), ev);
});
