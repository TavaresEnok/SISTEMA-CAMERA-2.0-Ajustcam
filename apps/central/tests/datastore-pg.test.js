'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PgStore } = require('../src/datastore/pg-store');
const { createDatastore } = require('../src/datastore');

const DB_URL = process.env.DRAC_CENTRAL_DATABASE_URL || process.env.DATABASE_URL || '';
// Sem Postgres configurado, o suite inteiro é PULADO (não falha): `pnpm test` no
// host segue verde; a verificação real roda contra o Postgres efêmero em docker.
const skip = DB_URL ? false : 'defina DRAC_CENTRAL_DATABASE_URL (Postgres efêmero) para rodar';

const TABLES_TO_RESET =
  'central_installations, central_users, central_sessions, central_audit_events, central_meta';

function sampleDb() {
  return {
    installations: {
      'cli-a': {
        id: 'cli-a', licenseKey: 'drac-aaa', customerName: 'Cliente A', licenseStatus: 'ACTIVE',
        lastHeartbeatAt: '2026-07-24T10:00:00.000Z', updatedAt: '2026-07-24T10:05:00.000Z',
        installerTokenHash: 'a'.repeat(64), sshHostKeys: { '1.2.3.4:22': 'SHA256:xyz' },
        metrics: { cameras: { total: 3, online: 2, offline: 1 }, openAlarms: 0 },
        alertHistory: [{ id: 'al1', key: 'x:y', status: 'ACTIVE', occurrences: 2 }],
        heartbeatHistory: [{ at: '2026-07-24T10:00:00.000Z', status: 'ok', cameraTotal: 3 }],
      },
      'cli-b': { id: 'cli-b', licenseKey: 'drac-bbb', customerName: 'Cliente B', licenseStatus: 'SUSPENDED' },
    },
    users: {
      'admin2@drac.local': { name: 'Admin 2', passwordHash: 'pbkdf2_sha256$600000$salt$hash', createdAt: '2026-07-01T00:00:00.000Z', createdBy: 'admin@drac.local' },
    },
    sessions: {
      hash1: { email: 'admin2@drac.local', createdAt: '2026-07-24T00:00:00.000Z', lastSeenAt: '2026-07-24T00:10:00.000Z', expiresAt: '2026-07-24T08:00:00.000Z' },
    },
    auditEvents: [
      { id: 'ev1', at: '2026-07-24T00:00:00.000Z', type: 'auth.login_success', actor: 'admin2@drac.local', result: 'accepted', ip: '1.2.3.4' },
      { id: 'ev2', at: '2026-07-24T00:01:00.000Z', type: 'installation.provision_created', actor: 'admin2@drac.local', result: 'accepted', installationId: 'cli-a' },
    ],
  };
}

async function makeStore() {
  const store = new PgStore({ connectionString: DB_URL });
  await store.initSchema();
  await store._pg().query(`TRUNCATE ${TABLES_TO_RESET}`);
  return store;
}

test('Postgres: writeAll → readAll faz round-trip IDÊNTICO do documento inteiro', { skip }, async () => {
  const store = await makeStore();
  try {
    const db = sampleDb();
    await store.writeAll(db);
    const back = await store.readAll();
    assert.deepEqual(back.installations, db.installations);
    assert.deepEqual(back.users, db.users);
    assert.deepEqual(back.sessions, db.sessions);
    assert.deepEqual(back.auditEvents, db.auditEvents); // ordem preservada por seq
  } finally {
    await store.close();
  }
});

test('Postgres: writeAll é estado-exato — remover um registro do doc o APAGA do PG', { skip }, async () => {
  const store = await makeStore();
  try {
    await store.writeAll(sampleDb());
    let back = await store.readAll();
    assert.deepEqual(Object.keys(back.installations).sort(), ['cli-a', 'cli-b']);

    // Segunda escrita SEM cli-b e sem a sessão: devem sumir do PG.
    const db2 = sampleDb();
    delete db2.installations['cli-b'];
    db2.sessions = {};
    await store.writeAll(db2);
    back = await store.readAll();
    assert.deepEqual(Object.keys(back.installations), ['cli-a']);
    assert.deepEqual(Object.keys(back.sessions), []);
    assert.equal(back.auditEvents.length, 2);
  } finally {
    await store.close();
  }
});

test('Postgres: migrateFromLegacy só faz BACKFILL (insere o que falta, não apaga)', { skip }, async () => {
  const store = await makeStore();
  try {
    // PG já tem cli-a (só ele).
    await store.writeAll({ installations: { 'cli-a': { id: 'cli-a', licenseKey: 'drac-aaa' } }, users: {}, sessions: {}, auditEvents: [] });
    const legacy = sampleDb(); // tem cli-a (versão diferente) + cli-b + user + sessão + audit
    const result = await store.migrateFromLegacy(legacy);
    // cli-a NÃO é sobrescrito (já existe); cli-b, user, sessão e 2 audits entram.
    assert.equal(result.inserted, 5);
    const back = await store.readAll();
    assert.equal(back.installations['cli-a'].licenseKey, 'drac-aaa'); // preservado, não sobrescrito
    assert.equal(back.installations['cli-a'].customerName, undefined); // versão original do PG
    assert.equal(back.installations['cli-b'].customerName, 'Cliente B'); // backfill
    assert.equal(back.users['admin2@drac.local'].name, 'Admin 2');
    assert.equal(back.auditEvents.length, 2);

    // Rodar de novo é idempotente (nada novo a inserir).
    const again = await store.migrateFromLegacy(legacy);
    assert.equal(again.inserted, 0);
  } finally {
    await store.close();
  }
});

test('Postgres dual-read: createDatastore lê do PG com fallback ao JSON legado e faz backup ANTES de migrar', { skip }, async () => {
  const store = await makeStore();
  const backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drac-ds-'));
  try {
    // Legado (read-only) em memória com um cliente que o PG ainda não tem.
    const legacyDb = {
      installations: { 'cli-legacy': { id: 'cli-legacy', licenseKey: 'drac-leg', customerName: 'Legado' } },
      users: {}, sessions: {}, auditEvents: [],
    };
    let saved = null;
    const legacy = { load: async () => legacyDb, save: async (db) => { saved = db; } };
    const ds = createDatastore({
      legacy,
      config: { databaseUrl: DB_URL, mode: 'dual', dataFile: path.join(backupDir, 'installations.json'), backupDir },
      store,
    });

    // load() dispara init: backup + reconcile do legado para o PG.
    const merged = await ds.load();
    assert.equal(merged.installations['cli-legacy'].customerName, 'Legado');

    // Backup de assinatura foi escrito ANTES da migração.
    const backups = (await fsp.readdir(backupDir)).filter((f) => f.startsWith('signing-backup-'));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(await fsp.readFile(path.join(backupDir, backups[0]), 'utf8'));
    assert.equal(backup.installations['cli-legacy'].licenseKey, 'drac-leg');

    // O legado foi reconciliado para o PG (agora existe lá).
    const inPg = await store.readAll();
    assert.equal(inPg.installations['cli-legacy'].customerName, 'Legado');

    // save() escreve SÓ no PG; o JSON legado NUNCA é reescrito (janela de rollback).
    const toSave = await ds.load();
    toSave.installations['cli-new'] = { id: 'cli-new', licenseKey: 'drac-new' };
    await ds.save(toSave);
    assert.equal(saved, null, 'legacy.save não deve ser chamado em modo dual/pg');
    const afterSave = await store.readAll();
    assert.equal(afterSave.installations['cli-new'].licenseKey, 'drac-new');
  } finally {
    await fsp.rm(backupDir, { recursive: true, force: true });
    await store.close();
  }
});
