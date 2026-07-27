'use strict';

// ── Fase 4 — Scheduler multi-nó: PLANEJAMENTO (função PURA, sem I/O) ─────────
//
// O registro de nós (datastore/compute-nodes.js) é uma LISTA INERTE. Este módulo
// é o cérebro que faltava: dada (a) a lista de nós, (b) o estado de cada nó
// (visto pela última vez / drenando / caído), (c) as cargas (câmeras com peso) e
// (d) a atribuição ANTERIOR, produz um PLANO de atribuição.
//
// Ele PLANEJA — não executa nada em nó nenhum (fase futura).
//
// INVARIANTES (o que os testes protegem):
//  1. DETERMINISMO. A mesma entrada produz a MESMA saída, sempre. Nada de
//     Math.random()/Date.now() aqui dentro: `now` é INJETADO e OBRIGATÓRIO (sem
//     ele a função lança). A ORDEM dos arrays de entrada é irrelevante — nós e
//     cargas são ordenados canonicamente antes de qualquer decisão, e o
//     desempate é sempre pelo id (ASC). Desempate por ordem de array seria
//     instável: o mesmo cluster daria planos diferentes conforme a ordem em que
//     alguém cadastrou os nós.
//  2. ESTABILIDADE > BALANCEAMENTO. Replanejar NÃO reembaralha. Uma câmera só
//     troca de nó quando é NECESSÁRIO (nó sumiu, morreu, estourou a capacidade,
//     ou está drenando). Migração desnecessária = stream do cliente
//     interrompido. Consequência ACEITA e documentada: um nó novo entra vazio e
//     só recebe carga NOVA (ou a que precisar migrar) — não roubamos câmeras
//     saudáveis dos outros só para "equilibrar o gráfico".
//  3. FENCING. Toda atribuição carrega um token MONOTÔNICO por instalação. Ao
//     migrar (ou nascer) uma atribuição, o token NOVO é maior que qualquer um já
//     emitido; ao ser RETIDA, o token é PRESERVADO (dono não mudou). Quem volta
//     do mundo dos mortos com token antigo é rejeitado (ver leases.js) — dois
//     nós gravando a mesma câmera é corrupção de gravação.
//  4. NUNCA ORFANAR À TOA. Se não há destino (drenagem sem nó livre), a carga
//     FICA onde está em vez de ser derrubada. Failover tem PRIORIDADE sobre
//     drenagem: quem perdeu o nó (outage) é recolocado ANTES de gastarmos folga
//     com drenagem (que é planejada e pode esperar o próximo ciclo).

const { normalizeComputeNodes } = require('../datastore/compute-nodes');
const { resolveSchedulerConfig } = require('./config');

const PLAN_VERSION = 1;

const HEALTH_ALIVE = 'alive';
const HEALTH_UNKNOWN = 'unknown';
const HEALTH_DRAINING = 'draining';
const HEALTH_DEAD = 'dead';

// Motivos de (re)colocação — viram `reason` em migrations/unassigned.
const REASON_NEW = 'new';
const REASON_NODE_REMOVED = 'node_removed';
const REASON_NODE_DEAD = 'node_dead';
const REASON_CAPACITY = 'capacity';
const REASON_DRAINING = 'draining';
const REASON_NO_CAPACITY = 'no_capacity';

function compareIds(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// ISO string, Date ou epoch-ms → ms. Lixo → null (o chamador decide).
function toMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Cargas: aceita id cru ('cam-1') ou objeto ({ id | cameraId, weight }). Peso
// inválido/ausente → 1. Último registro do mesmo id vence (mesma regra do
// parseCameraHealth da série temporal). Ids vazios são descartados.
function normalizeWorkloads(input) {
  if (!Array.isArray(input)) return [];
  const byId = new Map();
  for (const raw of input) {
    let id = '';
    let weight = 1;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      id = String(raw.id ?? raw.cameraId ?? '').trim();
      const w = Number(raw.weight);
      if (Number.isFinite(w) && w > 0) weight = w;
    } else {
      id = String(raw ?? '').trim();
    }
    if (!id) continue;
    byId.set(id, { id, weight });
  }
  return [...byId.values()];
}

// Ordem CANÔNICA de processamento: peso DESC (as cargas grandes primeiro — LPT,
// que empacota melhor), desempate por id ASC. Nunca a ordem do array de entrada.
function orderWorkloads(list) {
  return list.slice().sort((a, b) => (b.weight - a.weight) || compareIds(a.id, b.id));
}

// Estado por nó (telemetria, NÃO registro): { lastSeenAt, draining, down }.
// `status`/`state` textual também é aceito ('draining', 'down'/'dead'/'offline').
// Um nó SEM estado nenhum é "unknown" — e unknown é ELEGÍVEL (ver nodeHealth).
function normalizeNodeStates(input) {
  const out = new Map();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawId, rawState] of Object.entries(input)) {
    const id = String(rawId ?? '').trim();
    if (!id) continue;
    const state = rawState && typeof rawState === 'object' && !Array.isArray(rawState) ? rawState : {};
    const status = String(state.status ?? state.state ?? '').trim().toLowerCase();
    out.set(id, {
      lastSeenAt: toMs(state.lastSeenAt ?? state.lastHeartbeatAt ?? null),
      draining: state.draining === true || status === 'draining',
      down: state.down === true || status === 'down' || status === 'dead' || status === 'offline',
    });
  }
  return out;
}

// Saúde do nó. `unknown` (nunca reportou) é tratado como VIVO de propósito: uma
// frota que ainda não manda telemetria de nó não pode sofrer migração em massa
// só porque o scheduler não tem dado. Scheduler sem dado NÃO derruba nada.
function nodeHealth(state, nowMs, config) {
  if (!state) return HEALTH_UNKNOWN;
  if (state.down) return HEALTH_DEAD;
  if (state.lastSeenAt !== null) {
    const ageSeconds = (nowMs - state.lastSeenAt) / 1000;
    if (ageSeconds > config.nodeDeadAfterSeconds) return HEALTH_DEAD;
  }
  if (state.draining) return HEALTH_DRAINING;
  return state.lastSeenAt === null ? HEALTH_UNKNOWN : HEALTH_ALIVE;
}

// Pode RECEBER carga nova? Morto não, drenando não. Vivo e desconhecido sim.
function isPlaceable(node) {
  return node.health === HEALTH_ALIVE || node.health === HEALTH_UNKNOWN;
}

// Pode MANTER a carga que já tem? Só o morto perde tudo de uma vez; o drenando
// mantém e vai soltando aos poucos (drainBatch por replanejamento).
function canRetain(node) {
  return node.health !== HEALTH_DEAD;
}

// Atribuição anterior. Aceita: um PLANO anterior ({assignments:[…], nextToken}),
// um array de atribuições, ou um mapa simples { cameraId: nodeId } (bootstrap a
// partir do registro, onde ainda não existe token).
function normalizePrevious(previous) {
  const byCamera = new Map();
  let nextToken = 0;
  let epoch = 0;
  if (!previous || typeof previous !== 'object') return { byCamera, nextToken, epoch };

  let list = null;
  if (Array.isArray(previous)) list = previous;
  else if (Array.isArray(previous.assignments)) {
    list = previous.assignments;
    const n = Number(previous.nextToken);
    if (Number.isFinite(n) && n > 0) nextToken = n;
    const e = Number(previous.epoch);
    if (Number.isFinite(e) && e > 0) epoch = e;
  }

  if (list) {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const cameraId = String(raw.cameraId ?? raw.id ?? '').trim();
      const nodeId = String(raw.nodeId ?? '').trim();
      if (!cameraId || !nodeId) continue;
      const token = Number(raw.token);
      byCamera.set(cameraId, { nodeId, token: Number.isFinite(token) && token > 0 ? token : null });
    }
  } else {
    for (const [rawCamera, rawNode] of Object.entries(previous)) {
      const cameraId = String(rawCamera ?? '').trim();
      const nodeId = String(rawNode ?? '').trim();
      if (!cameraId || !nodeId) continue;
      byCamera.set(cameraId, { nodeId, token: null });
    }
  }

  // O próximo token tem de superar QUALQUER token já emitido — inclusive os de
  // câmeras que saíram do plano. Senão um token seria reemitido e o fencing
  // aceitaria um zumbi.
  for (const entry of byCamera.values()) {
    if (entry.token !== null && entry.token >= nextToken) nextToken = entry.token + 1;
  }
  return { byCamera, nextToken, epoch };
}

// Melhor destino para uma carga de peso `weight`: menor UTILIZAÇÃO projetada
// ((carga+peso)/capacidade), desempate ESTÁVEL pelo menor id. Utilização (e não
// carga absoluta) para que um nó com o dobro da capacidade receba o dobro.
// `nodes` já vem ordenado por id, então `<` estrito faz o menor id vencer o empate.
function pickTarget(nodes, weight) {
  let best = null;
  let bestScore = Infinity;
  for (const node of nodes) {
    if (!isPlaceable(node)) continue;
    const projected = node.load + weight;
    if (projected > node.capacity) continue;
    const score = projected / node.capacity;
    if (score < bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

function place(node, record) {
  node.load += record.weight;
  node.cameras.push(record.id);
  record.nodeId = node.id;
}

function release(node, record) {
  const index = node.cameras.indexOf(record.id);
  if (index !== -1) node.cameras.splice(index, 1);
  node.load -= record.weight;
  record.nodeId = null;
}

function planAssignments(input) {
  const options = input && typeof input === 'object' ? input : {};
  const config = resolveSchedulerConfig(options.config);

  const nowMs = toMs(options.now);
  if (nowMs === null) {
    // Dentes do determinismo: o algoritmo NÃO lê o relógio. Sem `now` injetado
    // ele se recusa a planejar (em vez de silenciosamente usar Date.now()).
    throw new TypeError('planAssignments: `now` é obrigatório (o algoritmo não lê o relógio).');
  }

  const states = normalizeNodeStates(options.nodeStates);
  // Ordem canônica dos nós: id ASC. A ordem do registro NÃO influencia o plano.
  const nodes = [];
  const byNodeId = new Map();
  for (const raw of normalizeComputeNodes(options.nodes).slice().sort((a, b) => compareIds(a.id, b.id))) {
    if (!raw.id || byNodeId.has(raw.id)) continue; // id vazio/duplicado: validateComputeNodes já reprova
    const declaredCapacity = raw.capacity === undefined ? null : raw.capacity;
    const node = {
      id: raw.id,
      role: raw.role,
      declaredCapacity,
      capacity: declaredCapacity === null ? config.defaultNodeCapacity : declaredCapacity,
      health: nodeHealth(states.get(raw.id), nowMs, config),
      load: 0,
      cameras: [],
    };
    nodes.push(node);
    byNodeId.set(node.id, node);
  }

  const workloads = orderWorkloads(normalizeWorkloads(options.workloads));
  const previous = normalizePrevious(options.previous);

  // ── 1) RETENÇÃO (afinidade) ────────────────────────────────────────────────
  // Quem já estava num nó que ainda pode segurá-lo, FICA. É isto que faz o
  // replanejamento não reembaralhar a frota.
  const records = new Map();
  const deferred = [];
  for (const workload of workloads) {
    const prev = previous.byCamera.get(workload.id) || null;
    const record = {
      id: workload.id,
      weight: workload.weight,
      nodeId: null,
      token: null,
      previousNodeId: prev ? prev.nodeId : null,
      previousToken: prev ? prev.token : null,
      reason: null,
    };
    records.set(workload.id, record);

    if (!prev) {
      record.reason = REASON_NEW;
      deferred.push(record);
      continue;
    }
    const node = byNodeId.get(prev.nodeId);
    if (!node) {
      record.reason = REASON_NODE_REMOVED;
      deferred.push(record);
      continue;
    }
    if (!canRetain(node)) {
      record.reason = REASON_NODE_DEAD;
      deferred.push(record);
      continue;
    }
    if (node.load + record.weight > node.capacity) {
      record.reason = REASON_CAPACITY;
      deferred.push(record);
      continue;
    }
    place(node, record);
  }

  // ── 2) COLOCAÇÃO (inclui o failover) ───────────────────────────────────────
  // Antes da drenagem de propósito: quem perdeu o nó está FORA DO AR agora;
  // drenagem é planejada e pode esperar o próximo ciclo.
  for (const record of deferred) {
    const target = pickTarget(nodes, record.weight);
    if (!target) continue; // fica sem nó — reportado em `unassigned`
    place(target, record);
  }

  // ── 3) DRENAGEM GRADUAL ────────────────────────────────────────────────────
  // No máximo `drainBatch` cargas saem de CADA nó drenando por replanejamento —
  // esvaziar de uma vez derrubaria todos os streams daquele nó ao mesmo tempo.
  // Sem destino disponível, a carga FICA (nunca órfã por drenagem).
  for (const node of nodes) {
    if (node.health !== HEALTH_DRAINING) continue;
    let moved = 0;
    for (const cameraId of node.cameras.slice()) {
      if (moved >= config.drainBatch) break;
      const record = records.get(cameraId);
      if (!record) continue;
      const target = pickTarget(nodes, record.weight);
      if (!target) continue;
      release(node, record);
      place(target, record);
      record.reason = REASON_DRAINING;
      moved += 1;
    }
  }

  // ── 4) TOKENS (fencing) ────────────────────────────────────────────────────
  // Emitidos no FIM, percorrendo as atribuições em ordem de cameraId, para que o
  // valor do token não dependa da ordem de processamento. Atribuição RETIDA
  // preserva o token (dono não mudou); nova/migrada recebe um token MAIOR que
  // qualquer um já emitido.
  const assignedRecords = [...records.values()]
    .filter((record) => record.nodeId !== null)
    .sort((a, b) => compareIds(a.id, b.id));
  let nextToken = Math.max(previous.nextToken, 1);
  for (const record of assignedRecords) {
    const sameOwner = record.previousNodeId === record.nodeId && record.previousToken !== null;
    if (sameOwner) {
      record.token = record.previousToken;
    } else {
      record.token = nextToken;
      nextToken += 1;
    }
  }

  const leaseExpiresAt = new Date(nowMs + config.leaseTtlSeconds * 1000).toISOString();
  const assignments = assignedRecords.map((record) => ({
    cameraId: record.id,
    nodeId: record.nodeId,
    weight: record.weight,
    token: record.token,
    leaseExpiresAt,
  }));

  const unassigned = [...records.values()]
    .filter((record) => record.nodeId === null)
    .sort((a, b) => compareIds(a.id, b.id))
    .map((record) => ({
      cameraId: record.id,
      weight: record.weight,
      reason: record.reason === REASON_NEW || record.reason === null ? REASON_NO_CAPACITY : record.reason,
      previousNodeId: record.previousNodeId,
    }));

  // Migração = a carga TROCOU de nó. Sair para lugar nenhum não é migração (é
  // revogação, abaixo) — misturar os dois esconderia perda de cobertura.
  const migrations = [...records.values()]
    .filter((record) => record.previousNodeId !== null && record.nodeId !== null && record.nodeId !== record.previousNodeId)
    .sort((a, b) => compareIds(a.id, b.id))
    .map((record) => ({
      cameraId: record.id,
      from: record.previousNodeId,
      to: record.nodeId,
      reason: record.reason || REASON_CAPACITY,
    }));

  // Revogação: todo lease anterior que deixou de valer (migrou ou ficou sem nó).
  // O nó antigo tem de ser cercado (fencing) — é ele que pode voltar zumbi.
  const revoked = [...records.values()]
    .filter((record) => record.previousNodeId !== null && record.previousNodeId !== record.nodeId)
    .sort((a, b) => compareIds(a.id, b.id))
    .map((record) => ({
      cameraId: record.id,
      nodeId: record.previousNodeId,
      token: record.previousToken,
      reason: record.reason || REASON_CAPACITY,
    }));

  const planNodes = nodes.map((node) => ({
    id: node.id,
    role: node.role,
    health: node.health,
    capacity: node.capacity,
    declaredCapacity: node.declaredCapacity,
    load: node.load,
    cameras: node.cameras.slice().sort(compareIds),
  }));

  const plan = {
    version: PLAN_VERSION,
    installationId: options.installationId === undefined || options.installationId === null
      ? null
      : String(options.installationId),
    generatedAt: new Date(nowMs).toISOString(),
    epoch: previous.epoch + 1,
    nextToken,
    leaseTtlSeconds: config.leaseTtlSeconds,
    nodes: planNodes,
    assignments,
    unassigned,
    migrations,
    revoked,
    stats: {
      nodes: planNodes.length,
      alive: planNodes.filter((node) => node.health === HEALTH_ALIVE).length,
      unknown: planNodes.filter((node) => node.health === HEALTH_UNKNOWN).length,
      draining: planNodes.filter((node) => node.health === HEALTH_DRAINING).length,
      dead: planNodes.filter((node) => node.health === HEALTH_DEAD).length,
      workloads: workloads.length,
      assigned: assignments.length,
      unassigned: unassigned.length,
      migrations: migrations.length,
      revoked: revoked.length,
      totalWeight: workloads.reduce((sum, workload) => sum + workload.weight, 0),
    },
  };
  return plan;
}

module.exports = {
  PLAN_VERSION,
  HEALTH_ALIVE,
  HEALTH_UNKNOWN,
  HEALTH_DRAINING,
  HEALTH_DEAD,
  REASON_NEW,
  REASON_NODE_REMOVED,
  REASON_NODE_DEAD,
  REASON_CAPACITY,
  REASON_DRAINING,
  REASON_NO_CAPACITY,
  normalizeWorkloads,
  orderWorkloads,
  normalizeNodeStates,
  normalizePrevious,
  nodeHealth,
  planAssignments,
  toMs,
};
