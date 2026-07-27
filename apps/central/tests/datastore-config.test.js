'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { resolveConfig } = require('../src/datastore');
const { writeSigningBackup } = require('../src/datastore/signing-backup');

// ── P0: a Central NÃO pode trocar de datastore sozinha ───────────────────────
// A stack DRAC exporta DATABASE_URL para a API. Se a Central herdar essa variável
// do ambiente e adotá-la, o painel MESTRE migra de JSON para o banco do VMS em
// silêncio. Migração é decisão explícita: só DRAC_CENTRAL_DATABASE_URL conta.

test('config: DATABASE_URL genérico NÃO liga o Postgres (fica json)', () => {
  const cfg = resolveConfig({ DATABASE_URL: 'postgres://vms:x@db:5432/vms' });
  assert.equal(cfg.mode, 'json', 'DATABASE_URL genérico não pode trocar o datastore');
  assert.equal(cfg.databaseUrl, '');
});

test('config: DATABASE_URL genérico não liga nem com STORE_MODE=dual pedido', () => {
  const cfg = resolveConfig({ DATABASE_URL: 'postgres://vms:x@db:5432/vms', DRAC_CENTRAL_STORE_MODE: 'dual' });
  assert.equal(cfg.mode, 'json', 'sem a URL específica, o modo cai para json');
});

test('config: a variável ESPECÍFICA liga o modo dual (decisão explícita)', () => {
  const cfg = resolveConfig({ DRAC_CENTRAL_DATABASE_URL: 'postgres://c:x@db:5432/central' });
  assert.equal(cfg.mode, 'dual');
  assert.equal(cfg.databaseUrl, 'postgres://c:x@db:5432/central');
});

test('config: sem nenhuma URL o default segue json', () => {
  assert.equal(resolveConfig({}).mode, 'json');
});

// ── P0: backup de identidades de assinatura é SEGREDO ────────────────────────
// Guarda licenseKey, installerToken, chaves SSH e hash de senha. Não pode nascer
// legível por outros usuários do host.

test('signing-backup: arquivo 0600 e diretório 0700 mesmo com umask permissivo', async () => {
  const prev = process.umask(0o000); // pior caso: umask não protege nada
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drac-signbk-'));
  try {
    const db = {
      installations: { i1: { licenseKey: 'LIC-SECRET', installerToken: 'TOK-SECRET' } },
      users: { 'a@b.c': { passwordHash: 'hash' } },
    };
    const { file } = await writeSigningBackup(db, path.join(dir, 'backups'));
    const fileMode = (await fs.stat(file)).mode & 0o777;
    const dirMode = (await fs.stat(path.dirname(file))).mode & 0o777;
    assert.equal(fileMode, 0o600, `arquivo de segredos deveria ser 0600, veio ${fileMode.toString(8)}`);
    assert.equal(dirMode, 0o700, `diretório de backup deveria ser 0700, veio ${dirMode.toString(8)}`);
  } finally {
    process.umask(prev);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
