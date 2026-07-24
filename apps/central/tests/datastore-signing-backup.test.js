'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { collectSigningIdentities, writeSigningBackup } = require('../src/datastore/signing-backup');

const sampleDb = {
  installations: {
    'cli-a': { id: 'cli-a', licenseKey: 'drac-aaa', installerToken: 'tok-a', sshHostKeys: { '1.2.3.4:22': 'SHA256:xyz' }, customerName: 'A' },
    'cli-b': { id: 'cli-b', licenseKey: 'drac-bbb' },
    'cli-nada': { id: 'cli-nada', customerName: 'sem segredo' },
  },
  users: {
    'admin2@drac.local': { name: 'Admin 2', passwordHash: 'pbkdf2_sha256$600000$s$h' },
    'sem-hash@drac.local': { name: 'sem hash' },
  },
};

test('collectSigningIdentities coleta licenseKey/installerToken/sshHostKeys e hashes; ignora registros sem segredo', () => {
  const backup = collectSigningIdentities(sampleDb);
  assert.equal(backup.kind, 'drac-central-signing-backup');
  assert.deepEqual(Object.keys(backup.installations).sort(), ['cli-a', 'cli-b']); // cli-nada excluído
  assert.equal(backup.installations['cli-a'].licenseKey, 'drac-aaa');
  assert.equal(backup.installations['cli-a'].installerToken, 'tok-a');
  assert.deepEqual(backup.installations['cli-a'].sshHostKeys, { '1.2.3.4:22': 'SHA256:xyz' });
  assert.equal(backup.installations['cli-b'].licenseKey, 'drac-bbb');
  assert.equal(backup.installations['cli-b'].installerToken, undefined);
  assert.deepEqual(Object.keys(backup.users), ['admin2@drac.local']); // sem-hash excluído
  assert.equal(backup.users['admin2@drac.local'].passwordHash, 'pbkdf2_sha256$600000$s$h');
  assert.deepEqual(backup.counts, { installations: 2, users: 1 });
});

test('collectSigningIdentities NÃO vaza senha em claro (só o hash)', () => {
  const backup = collectSigningIdentities(sampleDb);
  const asText = JSON.stringify(backup);
  assert.equal(asText.includes('pbkdf2_sha256'), true);
  // nenhum campo "password" solto (só passwordHash)
  assert.equal(/"password"\s*:/.test(asText), false);
});

test('writeSigningBackup grava arquivo durável com timestamp, sem sobrescrever', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drac-signing-'));
  try {
    const { file, payload } = await writeSigningBackup(sampleDb, dir, new Date('2026-07-24T12:00:00.000Z'));
    assert.equal(fs.existsSync(file), true);
    assert.match(path.basename(file), /^signing-backup-2026-07-24T12-00-00-000Z-[0-9a-f]{6}\.json$/);
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(onDisk.createdAt, '2026-07-24T12:00:00.000Z');
    assert.deepEqual(onDisk.counts, payload.counts);
    assert.equal(onDisk.installations['cli-a'].licenseKey, 'drac-aaa');
    // segundo backup no mesmo instante NÃO sobrescreve (sufixo aleatório)
    const second = await writeSigningBackup(sampleDb, dir, new Date('2026-07-24T12:00:00.000Z'));
    assert.notEqual(second.file, file);
    const listing = (await fsp.readdir(dir)).filter((f) => f.startsWith('signing-backup-'));
    assert.equal(listing.length, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
