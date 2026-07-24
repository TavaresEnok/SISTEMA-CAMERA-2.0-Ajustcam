'use strict';

// Resolução dual-read + reconciliação — lógica PURA (sem I/O). É o núcleo da
// migração segura do item 2.10 e o alvo dos testes por mutação.
//
// Contrato do período dual-read:
//   • Postgres é a AUTORIDADE. O JSON legado é uma fatia CONGELADA (read-only) que
//     só preenche registros ainda não presentes no Postgres (janela de rollback).
//   • Escrita vai só para o Postgres; o JSON nunca é reescrito.
//   • `reconcile` copia (backfill) tudo que está no legado e falta no PG. Depois da
//     reconciliação, legado ⊆ PG por chave, então o merge vira efetivamente o PG.
//
// CAVEAT documentado: enquanto em modo dual, apagar um registro do PG cuja chave
// ainda exista no snapshot legado o "ressuscitaria" no merge. Por isso o estado-alvo
// pós-reconciliação é o modo pg-only (o plano: "escrita só no novo após reconciliação").

// Resolve UM registro: Postgres vence; cai para o legado se ausente no PG.
// `undefined`/`null` no lado PG contam como ausência.
function resolveDualRead(pgValue, legacyValue) {
  return pgValue === undefined || pgValue === null ? legacyValue : pgValue;
}

// Une duas coleções keyed (objeto id->registro): legado preenche lacunas, PG vence
// nas colisões. Nunca muta as entradas.
function mergeMap(pgMap, legacyMap) {
  const out = {};
  for (const [key, value] of Object.entries(legacyMap || {})) out[key] = value;
  for (const [key, value] of Object.entries(pgMap || {})) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

// Ordena eventos de auditoria de forma determinística: por `at` (asc) e desempata
// por `id` — reconstrói o array na mesma ordem cronológica do datastore em memória.
function sortAuditEvents(events) {
  return events.slice().sort((a, b) => {
    const ta = new Date(a?.at || 0).getTime() || 0;
    const tb = new Date(b?.at || 0).getTime() || 0;
    if (ta !== tb) return ta - tb;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

// Une eventos de auditoria (arrays) por `id`; o registro do PG vence. Append-only,
// então a união nunca perde histórico.
function mergeAuditEvents(pgEvents, legacyEvents) {
  const byId = new Map();
  for (const ev of legacyEvents || []) if (ev && ev.id != null) byId.set(String(ev.id), ev);
  for (const ev of pgEvents || []) if (ev && ev.id != null) byId.set(String(ev.id), ev);
  return sortAuditEvents([...byId.values()]);
}

// Combina dois "db" completos no formato do server.js.
function mergeDb(pgDb, legacyDb) {
  const pg = pgDb || {};
  const legacy = legacyDb || {};
  return {
    ...legacy,
    ...pg,
    installations: mergeMap(pg.installations, legacy.installations),
    users: mergeMap(pg.users, legacy.users),
    sessions: mergeMap(pg.sessions, legacy.sessions),
    auditEvents: mergeAuditEvents(pg.auditEvents, legacy.auditEvents),
  };
}

// Reconciliação: o que existe no LEGADO e FALTA no Postgres (backfill a inserir).
// `pgKeys` = { installations:Set, users:Set, sessions:Set, auditEvents:Set }.
// Devolve listas prontas para inserir, preservando a ordem original dos arrays.
function reconcile(legacyDb, pgKeys) {
  const legacy = legacyDb || {};
  const keys = pgKeys || {};
  const missingFromMap = (map, existing) => {
    const out = [];
    for (const [id, value] of Object.entries(map || {})) {
      if (!existing || !existing.has(String(id))) out.push({ id, value });
    }
    return out;
  };
  const auditExisting = keys.auditEvents;
  const missingAudit = (legacy.auditEvents || []).filter(
    (ev) => ev && ev.id != null && (!auditExisting || !auditExisting.has(String(ev.id))),
  );
  return {
    installations: missingFromMap(legacy.installations, keys.installations),
    users: missingFromMap(legacy.users, keys.users),
    sessions: missingFromMap(legacy.sessions, keys.sessions),
    auditEvents: missingAudit,
  };
}

// Conta total de registros a reconciliar (útil para log/decisão).
function reconcileCount(plan) {
  if (!plan) return 0;
  return (
    (plan.installations?.length || 0) +
    (plan.users?.length || 0) +
    (plan.sessions?.length || 0) +
    (plan.auditEvents?.length || 0)
  );
}

// Numa escrita de documento inteiro: quais chaves DELETAR do PG (presentes hoje no
// PG mas ausentes no estado desejado `db`). Garante estado exato == db.
function keysToDelete(currentKeys, desiredKeys) {
  const out = [];
  for (const key of currentKeys || []) {
    if (!desiredKeys || !desiredKeys.has(String(key))) out.push(String(key));
  }
  return out;
}

module.exports = {
  resolveDualRead,
  mergeMap,
  sortAuditEvents,
  mergeAuditEvents,
  mergeDb,
  reconcile,
  reconcileCount,
  keysToDelete,
};
