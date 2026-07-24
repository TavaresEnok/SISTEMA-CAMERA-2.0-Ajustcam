'use strict';

const path = require('node:path');
const { PgStore } = require('./pg-store');
const { mergeDb } = require('./dual-read');
const { writeSigningBackup } = require('./signing-backup');

// Orquestrador do datastore da Central. Escolhe o backend por env e expõe a MESMA
// interface load()/save(db) do server.js legado, para trocar de backend sem mexer
// na lógica de rotas (hardening de corrupção/atômico/.bak do JSON fica intacto e
// é reusado como fonte legada read-only).
//
// Modos (item 2.10):
//   json  → só JSON (comportamento atual; DEFAULT sem DATABASE_URL).
//   dual  → lê Postgres com fallback p/ o JSON legado; escreve só no PG; JSON
//           read-only (janela de rollback). DEFAULT quando há DATABASE_URL.
//   pg    → só Postgres (estado-alvo após reconciliação).

function resolveConfig(env = process.env) {
  const databaseUrl = String(env.DRAC_CENTRAL_DATABASE_URL || env.DATABASE_URL || '').trim();
  let mode = String(env.DRAC_CENTRAL_STORE_MODE || '').trim().toLowerCase();
  if (!databaseUrl) {
    // Sem URL, só há o JSON. Um modo pg/dual pedido sem URL cai p/ json (com aviso).
    if (mode === 'pg' || mode === 'dual') {
      console.warn('[central] DRAC_CENTRAL_STORE_MODE pede Postgres mas DRAC_CENTRAL_DATABASE_URL está vazio — usando JSON.');
    }
    mode = 'json';
  } else if (!['json', 'dual', 'pg'].includes(mode)) {
    mode = 'dual';
  }
  const dataFile = path.resolve(process.cwd(), env.DRAC_CENTRAL_DATA_FILE || './data/installations.json');
  const backupDir = String(env.DRAC_CENTRAL_BACKUP_DIR || '').trim()
    ? path.resolve(process.cwd(), env.DRAC_CENTRAL_BACKUP_DIR)
    : path.join(path.dirname(dataFile), 'backups');
  return { databaseUrl, mode, dataFile, backupDir };
}

// legacy = { load, save } (o loadDb/saveDb do server.js). store = PgStore (injetável
// para teste). config = resolveConfig(). Em modo json, é um passthrough puro.
function createDatastore({ legacy, config, store } = {}) {
  const cfg = config || resolveConfig();
  const usesPg = cfg.mode === 'dual' || cfg.mode === 'pg';
  const pg = usesPg ? (store || new PgStore({ connectionString: cfg.databaseUrl })) : null;

  let initPromise = null;
  async function ensureInit() {
    if (!usesPg) return;
    if (!initPromise) initPromise = doInit();
    return initPromise;
  }

  // Roda UMA vez: cria schema, faz BACKUP das identidades de assinatura ANTES de
  // migrar, então reconcilia (backfill do legado). O marker `migration` no meta
  // impede repetir backup/migração a cada start.
  async function doInit() {
    await pg.initSchema();
    const already = await pg.getMeta('migration');
    if (already) return already;
    const legacyDb = legacy ? await legacy.load() : { installations: {}, users: {}, sessions: {}, auditEvents: [] };
    const backup = await writeSigningBackup(legacyDb, cfg.backupDir);
    const result = await pg.migrateFromLegacy(legacyDb);
    const marker = {
      at: new Date().toISOString(),
      inserted: result.inserted,
      backupFile: backup.file,
      backupCounts: backup.payload.counts,
    };
    await pg.setMeta('migration', marker);
    console.log(`[central] migração JSON→Postgres: ${result.inserted} registros reconciliados; backup de assinatura em ${backup.file}`);
    return marker;
  }

  async function load() {
    if (!usesPg) return legacy.load();
    await ensureInit();
    const pgDb = await pg.readAll();
    if (cfg.mode === 'pg') return pgDb;
    // dual: JSON legado (read-only) preenche o que o PG ainda não tem.
    const legacyDb = legacy ? await legacy.load() : {};
    return mergeDb(pgDb, legacyDb);
  }

  async function save(db) {
    if (!usesPg) return legacy.save(db);
    await ensureInit();
    // Escrita só no Postgres. O JSON legado NUNCA é reescrito (janela de rollback).
    await pg.writeAll(db);
  }

  async function close() {
    if (pg) await pg.close();
  }

  return { mode: cfg.mode, config: cfg, load, save, ensureInit, close, store: pg };
}

module.exports = { resolveConfig, createDatastore, PgStore };
