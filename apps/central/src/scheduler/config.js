'use strict';

// ── Fase 4 — Scheduler multi-nó: CONFIGURAÇÃO + FLAG ─────────────────────────
//
// A flag é a coisa mais importante deste módulo. O scheduler nasce DESLIGADO:
// com `enabled:false` o servidor NEM REGISTRA as rotas, não lê nem escreve nada,
// e o registro de nós (datastore/compute-nodes.js) continua exatamente tão
// INERTE quanto é hoje. Produção não pode notar diferença nenhuma.
//
// Só o valor EXPLÍCITO "true"/"1" liga. Qualquer outra coisa (vazio, "sim",
// "yes", "on", lixo, variável ausente) é DESLIGADO — um typo no .env não pode
// ligar um control-plane por acidente.

const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  enabled: false,
  // Validade do lease de uma atribuição. O nó precisa renovar (fase futura);
  // depois disso a atribuição é considerada expirada por leases.checkFencing.
  leaseTtlSeconds: 120,
  // Sem heartbeat por mais que isto, o nó é considerado MORTO e suas cargas são
  // redistribuídas (failover). Mesma ordem de grandeza do limiar de instalação.
  nodeDeadAfterSeconds: 180,
  // Capacidade assumida para um nó que não declarou `capacity` no registro.
  // Sem isto, um nó sem capacidade seria "infinito" e sequestraria tudo.
  defaultNodeCapacity: 16,
  // Drenagem GRADUAL: no máximo N cargas saem de CADA nó drenando por
  // replanejamento. 0 congela a drenagem (nada sai).
  drainBatch: 1,
  // Teto defensivo: um corpo hostil não pode inflar o data file da Central.
  maxWorkloads: 5000,
});

function readBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === '') return fallback;
  return false;
}

// Número positivo e finito, ou `undefined` (→ cai no default). `min` permite 0
// onde 0 é um valor legítimo (drainBatch=0 = drenagem congelada).
function readNumber(value, min) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n < min) return undefined;
  return n;
}

// Mescla um objeto parcial sobre os defaults, descartando valores inválidos.
// Idempotente: resolve(resolve(x)) === resolve(x).
function resolveSchedulerConfig(partial) {
  const input = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {};
  return {
    enabled: readBool(input.enabled, DEFAULT_SCHEDULER_CONFIG.enabled),
    leaseTtlSeconds: readNumber(input.leaseTtlSeconds, 1) ?? DEFAULT_SCHEDULER_CONFIG.leaseTtlSeconds,
    nodeDeadAfterSeconds: readNumber(input.nodeDeadAfterSeconds, 1) ?? DEFAULT_SCHEDULER_CONFIG.nodeDeadAfterSeconds,
    defaultNodeCapacity: readNumber(input.defaultNodeCapacity, 0) ?? DEFAULT_SCHEDULER_CONFIG.defaultNodeCapacity,
    drainBatch: readNumber(input.drainBatch, 0) ?? DEFAULT_SCHEDULER_CONFIG.drainBatch,
    maxWorkloads: readNumber(input.maxWorkloads, 1) ?? DEFAULT_SCHEDULER_CONFIG.maxWorkloads,
  };
}

function schedulerConfigFromEnv(env) {
  const source = env && typeof env === 'object' ? env : process.env;
  return resolveSchedulerConfig({
    enabled: readBool(source.DRAC_CENTRAL_SCHEDULER_ENABLED, false),
    leaseTtlSeconds: source.DRAC_CENTRAL_SCHEDULER_LEASE_SECONDS,
    nodeDeadAfterSeconds: source.DRAC_CENTRAL_SCHEDULER_NODE_DEAD_SECONDS,
    defaultNodeCapacity: source.DRAC_CENTRAL_SCHEDULER_DEFAULT_CAPACITY,
    drainBatch: source.DRAC_CENTRAL_SCHEDULER_DRAIN_BATCH,
    maxWorkloads: source.DRAC_CENTRAL_SCHEDULER_MAX_WORKLOADS,
  });
}

module.exports = {
  DEFAULT_SCHEDULER_CONFIG,
  resolveSchedulerConfig,
  schedulerConfigFromEnv,
};
