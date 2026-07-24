'use strict';

// Mapeamento PURO registro <-> linha. Sem I/O, sem pg — 100% testável.
//
// Invariante de fidelidade: `rowTo*` devolve o PAYLOAD original (o documento como o
// server.js espera). As colunas extraídas por `*ToRow` são derivadas e servem só
// para índice/consulta; nunca são a fonte da verdade do registro. Assim o
// round-trip registro -> linha -> registro é IDÊNTICO (crítico p/ rollback).

// Converte um valor de data (ISO string, Date, número) para ISO ou null. Datas
// inválidas viram null em vez de "Invalid Date" — timestamptz não aceita lixo.
function toTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : null;
}

// ── Instalações ─────────────────────────────────────────────────────────────
function installationToRow(id, item) {
  const payload = { ...(item || {}), id };
  return {
    id: String(id),
    license_key: payload.licenseKey ?? null,
    customer_name: payload.customerName ?? null,
    license_status: payload.licenseStatus ?? null,
    last_heartbeat_at: toTimestamp(payload.lastHeartbeatAt),
    updated_at: toTimestamp(payload.updatedAt),
    payload,
  };
}

function rowToInstallation(row) {
  if (!row) return null;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return { ...payload, id: payload.id ?? row.id };
}

// ── Usuários ────────────────────────────────────────────────────────────────
function userToRow(email, user) {
  const key = String(email).trim().toLowerCase();
  const payload = { ...(user || {}) };
  return {
    email: key,
    name: payload.name ?? null,
    password_hash: payload.passwordHash ?? null,
    created_at: toTimestamp(payload.createdAt),
    created_by: payload.createdBy ?? null,
    payload,
  };
}

function rowToUser(row) {
  if (!row) return null;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return { ...payload };
}

// ── Sessões ─────────────────────────────────────────────────────────────────
function sessionToRow(tokenHash, session) {
  const payload = { ...(session || {}) };
  return {
    token_hash: String(tokenHash),
    email: payload.email ?? null,
    created_at: toTimestamp(payload.createdAt),
    last_seen_at: toTimestamp(payload.lastSeenAt),
    expires_at: toTimestamp(payload.expiresAt),
    payload,
  };
}

function rowToSession(row) {
  if (!row) return null;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return { ...payload };
}

// ── Eventos de auditoria ──────────────────────────────────────────────────────
function auditEventToRow(event) {
  const payload = { ...(event || {}) };
  return {
    id: String(payload.id),
    at: toTimestamp(payload.at),
    type: payload.type ?? null,
    actor: payload.actor ?? null,
    result: payload.result ?? null,
    installation_id: payload.installationId ?? null,
    payload,
  };
}

function rowToAuditEvent(row) {
  if (!row) return null;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return { ...payload };
}

module.exports = {
  toTimestamp,
  installationToRow,
  rowToInstallation,
  userToRow,
  rowToUser,
  sessionToRow,
  rowToSession,
  auditEventToRow,
  rowToAuditEvent,
};
