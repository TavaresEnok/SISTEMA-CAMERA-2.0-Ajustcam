'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JsonInstanceLock } = require('../src/datastore/singleton-lock');

test('JSON datastore recusa uma segunda instância e libera o lock no shutdown', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drac-central-lock-'));
  const lockFile = path.join(directory, 'central.lock');
  const first = new JsonInstanceLock(lockFile);
  const second = new JsonInstanceLock(lockFile);
  try {
    await first.acquire();
    await assert.rejects(
      () => second.acquire(),
      (error) => error?.code === 'CENTRAL_INSTANCE_LOCKED',
    );
    await first.release();
    await second.acquire();
  } finally {
    await first.release();
    await second.release();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Postgres usa advisory lock exclusivo de sessão', async () => {
  const source = await fs.readFile(
    path.join(__dirname, '../src/datastore/pg-store.js'),
    'utf8',
  );
  assert.match(source, /pg_try_advisory_lock/);
  assert.match(source, /pg_advisory_unlock/);
  assert.match(source, /this\._instanceLockClient = client/);
});
