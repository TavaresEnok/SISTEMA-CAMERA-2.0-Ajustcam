'use strict';

// Esquema Postgres da DRAC Central (item 2.10 do plano).
//
// Filosofia do modelo: cada registro guarda o documento ORIGINAL em `payload`
// (jsonb) — round-trip sem perda, essencial para a janela de rollback e para a
// migração incremental do server.js (que opera no documento inteiro). As colunas
// extraídas (id, license_key, timestamps, status) existem só para índice/consulta
// e são DERIVADAS do payload na escrita; a leitura devolve o payload verbatim.
//
// `seq` (bigserial) em installations/users/sessions/audit preserva ordem estável
// de inserção — os eventos de auditoria são append-only com janela deslizante, então
// ordem de inserção == ordem cronológica == ordem do array em memória.

const TABLES = Object.freeze({
  installations: 'central_installations',
  users: 'central_users',
  sessions: 'central_sessions',
  auditEvents: 'central_audit_events',
  meta: 'central_meta',
});

// DDL idempotente (CREATE TABLE IF NOT EXISTS). Seguro de rodar em todo start.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLES.installations} (
  id                 text PRIMARY KEY,
  license_key        text,
  customer_name      text,
  license_status     text,
  last_heartbeat_at  timestamptz,
  updated_at         timestamptz,
  payload            jsonb NOT NULL,
  seq                bigserial
);
CREATE INDEX IF NOT EXISTS ${TABLES.installations}_seq_idx ON ${TABLES.installations} (seq);

CREATE TABLE IF NOT EXISTS ${TABLES.users} (
  email          text PRIMARY KEY,
  name           text,
  password_hash  text,
  created_at     timestamptz,
  created_by     text,
  payload        jsonb NOT NULL,
  seq            bigserial
);

CREATE TABLE IF NOT EXISTS ${TABLES.sessions} (
  token_hash    text PRIMARY KEY,
  email         text,
  created_at    timestamptz,
  last_seen_at  timestamptz,
  expires_at    timestamptz,
  payload       jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ${TABLES.sessions}_expires_idx ON ${TABLES.sessions} (expires_at);

CREATE TABLE IF NOT EXISTS ${TABLES.auditEvents} (
  id               text PRIMARY KEY,
  at               timestamptz,
  type             text,
  actor            text,
  result           text,
  installation_id  text,
  payload          jsonb NOT NULL,
  seq              bigserial
);
CREATE INDEX IF NOT EXISTS ${TABLES.auditEvents}_seq_idx ON ${TABLES.auditEvents} (seq);

CREATE TABLE IF NOT EXISTS ${TABLES.meta} (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
`;

module.exports = { TABLES, SCHEMA_SQL };
