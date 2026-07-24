'use strict';

const { TABLES, SCHEMA_SQL } = require('./schema');
const mappers = require('./mappers');
const { reconcile, reconcileCount } = require('./dual-read');

// Store Postgres da Central. Expõe a MESMA superfície do loadDb/saveDb legado
// (documento inteiro no formato { installations, sessions, users, auditEvents }),
// para o server.js trocar de backend com risco mínimo. A lógica pura (mapeamento,
// dual-read, reconciliação) vive nos módulos irmãos e é testada isolada.

class PgStore {
  constructor(options = {}) {
    this.options = options;
    this._pool = options.pool || null;
    this._Pool = options.PoolClass || null;
    this._ready = null;
  }

  _pg() {
    if (this._pool) return this._pool;
    const { Pool } = this._Pool ? { Pool: this._Pool } : require('pg');
    this._pool = new Pool(
      this.options.connectionString
        ? { connectionString: this.options.connectionString, max: this.options.max || 4 }
        : { ...this.options.pgConfig, max: this.options.max || 4 },
    );
    return this._pool;
  }

  async initSchema() {
    if (!this._ready) this._ready = this._pg().query(SCHEMA_SQL);
    await this._ready;
  }

  async close() {
    if (this._pool && !this.options.pool) await this._pool.end();
  }

  // ── Leitura ─────────────────────────────────────────────────────────────
  // A chave (id do usuário = e-mail, da sessão = token_hash) mora na COLUNA, não
  // no payload — então recompomos os mapas pela coluna de chave, não pelo payload.
  async readAll() {
    const pg = this._pg();
    const [inst, users, sessions, audit] = await Promise.all([
      pg.query(`SELECT payload FROM ${TABLES.installations} ORDER BY seq`),
      pg.query(`SELECT email, payload FROM ${TABLES.users} ORDER BY seq`),
      pg.query(`SELECT token_hash, payload FROM ${TABLES.sessions}`),
      pg.query(`SELECT payload FROM ${TABLES.auditEvents} ORDER BY seq`),
    ]);
    const installations = {};
    for (const row of inst.rows) {
      const rec = mappers.rowToInstallation(row);
      installations[rec.id] = rec;
    }
    const usersOut = {};
    for (const row of users.rows) usersOut[row.email] = mappers.rowToUser(row);
    const sessionsOut = {};
    for (const row of sessions.rows) sessionsOut[row.token_hash] = mappers.rowToSession(row);
    const auditEvents = audit.rows.map((row) => mappers.rowToAuditEvent(row));
    return { installations, users: usersOut, sessions: sessionsOut, auditEvents };
  }

  // Conjuntos de chaves já presentes (para reconciliação/backfill).
  async getKeys() {
    const pg = this._pg();
    const [inst, users, sessions, audit] = await Promise.all([
      pg.query(`SELECT id FROM ${TABLES.installations}`),
      pg.query(`SELECT email FROM ${TABLES.users}`),
      pg.query(`SELECT token_hash FROM ${TABLES.sessions}`),
      pg.query(`SELECT id FROM ${TABLES.auditEvents}`),
    ]);
    return {
      installations: new Set(inst.rows.map((r) => String(r.id))),
      users: new Set(users.rows.map((r) => String(r.email))),
      sessions: new Set(sessions.rows.map((r) => String(r.token_hash))),
      auditEvents: new Set(audit.rows.map((r) => String(r.id))),
    };
  }

  // ── Upserts (usados no save e na reconciliação) ──────────────────────────
  async _upsertInstallation(client, id, item) {
    const r = mappers.installationToRow(id, item);
    await client.query(
      `INSERT INTO ${TABLES.installations}
         (id, license_key, customer_name, license_status, last_heartbeat_at, updated_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         license_key=$2, customer_name=$3, license_status=$4,
         last_heartbeat_at=$5, updated_at=$6, payload=$7`,
      [r.id, r.license_key, r.customer_name, r.license_status, r.last_heartbeat_at, r.updated_at, r.payload],
    );
  }

  async _upsertUser(client, email, user) {
    const r = mappers.userToRow(email, user);
    await client.query(
      `INSERT INTO ${TABLES.users}
         (email, name, password_hash, created_at, created_by, payload)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET
         name=$2, password_hash=$3, created_at=$4, created_by=$5, payload=$6`,
      [r.email, r.name, r.password_hash, r.created_at, r.created_by, r.payload],
    );
  }

  async _upsertSession(client, tokenHash, session) {
    const r = mappers.sessionToRow(tokenHash, session);
    await client.query(
      `INSERT INTO ${TABLES.sessions}
         (token_hash, email, created_at, last_seen_at, expires_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (token_hash) DO UPDATE SET
         email=$2, created_at=$3, last_seen_at=$4, expires_at=$5, payload=$6`,
      [r.token_hash, r.email, r.created_at, r.last_seen_at, r.expires_at, r.payload],
    );
  }

  async _upsertAuditEvent(client, event) {
    const r = mappers.auditEventToRow(event);
    await client.query(
      `INSERT INTO ${TABLES.auditEvents}
         (id, at, type, actor, result, installation_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         at=$2, type=$3, actor=$4, result=$5, installation_id=$6, payload=$7`,
      [r.id, r.at, r.type, r.actor, r.result, r.installation_id, r.payload],
    );
  }

  // ── Escrita de documento inteiro (estado exato == db) ────────────────────
  async writeAll(db) {
    const source = db || {};
    const pg = this._pg();
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      const instIds = Object.keys(source.installations || {});
      for (const id of instIds) await this._upsertInstallation(client, id, source.installations[id]);
      await client.query(`DELETE FROM ${TABLES.installations} WHERE NOT (id = ANY($1::text[]))`, [instIds]);

      const userEmails = Object.keys(source.users || {});
      for (const email of userEmails) await this._upsertUser(client, email, source.users[email]);
      await client.query(`DELETE FROM ${TABLES.users} WHERE NOT (email = ANY($1::text[]))`, [userEmails]);

      const sessKeys = Object.keys(source.sessions || {});
      for (const tokenHash of sessKeys) await this._upsertSession(client, tokenHash, source.sessions[tokenHash]);
      await client.query(`DELETE FROM ${TABLES.sessions} WHERE NOT (token_hash = ANY($1::text[]))`, [sessKeys]);

      const auditEvents = Array.isArray(source.auditEvents) ? source.auditEvents : [];
      const auditIds = [];
      for (const ev of auditEvents) {
        if (!ev || ev.id == null) continue;
        auditIds.push(String(ev.id));
        await this._upsertAuditEvent(client, ev);
      }
      await client.query(`DELETE FROM ${TABLES.auditEvents} WHERE NOT (id = ANY($1::text[]))`, [auditIds]);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Reconciliação/backfill (NÃO apaga nada do PG; só insere o que falta) ──
  async migrateFromLegacy(legacyDb) {
    const keys = await this.getKeys();
    const plan = reconcile(legacyDb, keys);
    const total = reconcileCount(plan);
    if (total === 0) return { inserted: 0, plan };
    const pg = this._pg();
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      for (const { id, value } of plan.installations) await this._upsertInstallation(client, id, value);
      for (const { id, value } of plan.users) await this._upsertUser(client, id, value);
      for (const { id, value } of plan.sessions) await this._upsertSession(client, id, value);
      for (const ev of plan.auditEvents) await this._upsertAuditEvent(client, ev);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { inserted: total, plan };
  }

  async getMeta(key) {
    const r = await this._pg().query(`SELECT value FROM ${TABLES.meta} WHERE key=$1`, [key]);
    return r.rows[0] ? r.rows[0].value : null;
  }

  async setMeta(key, value) {
    await this._pg().query(
      `INSERT INTO ${TABLES.meta} (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=$2`,
      [key, value],
    );
  }
}

module.exports = { PgStore };
