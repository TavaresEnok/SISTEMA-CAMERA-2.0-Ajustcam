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
  // Série temporal (histórico REAL da frota). NÃO é documento: são fatos
  // append-only por instalação/instante, com colunas TIPADAS (nada de payload
  // jsonb aqui) porque a consulta é agregação numérica por intervalo, não
  // round-trip de documento. É por isso que isto NUNCA pode viver no JSON: a
  // 60s são 1.440 linhas/dia por instalação.
  samples: 'central_installation_samples',
  samplesHourly: 'central_installation_samples_hourly',
  cameraHealth: 'central_installation_camera_health',
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

-- ── Série temporal ──────────────────────────────────────────────────────────
-- Amostras CRUAS (uma por heartbeat, ~60s). Retenção curta (~48h): além disso
-- viram agregado horário (rollup) e SAEM daqui — senão a tabela cresce sem fim.
-- A PRIMARY KEY (installation_id, at) JÁ É o índice por (instalação, tempo)
-- exigido pela consulta do painel; o índice extra por at serve à VARREDURA DE
-- RETENÇÃO, que corta por tempo em TODAS as instalações de uma vez.
CREATE TABLE IF NOT EXISTS ${TABLES.samples} (
  installation_id     text NOT NULL,
  at                  timestamptz NOT NULL,
  cameras_total       integer,
  cameras_online      integer,
  cameras_offline     integer,
  cameras_error       integer,
  cameras_stalled     integer,
  recordings_active   integer,
  disk_usage_percent  double precision,
  alerts_critical     integer,
  PRIMARY KEY (installation_id, at)
);
CREATE INDEX IF NOT EXISTS ${TABLES.samples}_at_idx ON ${TABLES.samples} (at);

-- Agregado POR HORA (min/avg/max/count por métrica, no jsonb stats). jsonb aqui
-- é deliberado: acrescentar uma métrica nova não vira migração de 3 colunas, e o
-- merge ponderado (rollups parciais da mesma hora) é feito pela função pura.
CREATE TABLE IF NOT EXISTS ${TABLES.samplesHourly} (
  installation_id  text NOT NULL,
  bucket           timestamptz NOT NULL,
  samples          integer NOT NULL,
  stats            jsonb NOT NULL,
  PRIMARY KEY (installation_id, bucket)
);
CREATE INDEX IF NOT EXISTS ${TABLES.samplesHourly}_bucket_idx ON ${TABLES.samplesHourly} (bucket);

-- Saúde ATUAL por câmera (bloco opcional do heartbeat). Uma linha por câmera —
-- NÃO cresce com o tempo, é estado corrente; por isso não entra no rollup.
CREATE TABLE IF NOT EXISTS ${TABLES.cameraHealth} (
  installation_id              text NOT NULL,
  camera_id                    text NOT NULL,
  at                           timestamptz,
  name                         text,
  enabled                      boolean,
  status                       text,
  recording_desired            boolean,
  recording_active             boolean,
  recording_stalled            boolean,
  seconds_since_last_segment   integer,
  segments_last_hour           integer,
  restarts_last_hour           integer,
  stream_recoveries_last_hour  integer,
  payload                      jsonb NOT NULL,
  PRIMARY KEY (installation_id, camera_id)
);
`;

module.exports = { TABLES, SCHEMA_SQL };
