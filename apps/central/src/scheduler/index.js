'use strict';

// ── Fase 4 — Scheduler multi-nó: cola com o registro da instalação ──────────
//
// plan.js é puro e não sabe o que é uma "instalação". Aqui traduzimos o REGISTRO
// (o mesmo objeto que já viaja no payload jsonb/JSON) para a entrada do
// planejador e de volta:
//
//   • cargas      → união das câmeras já atribuídas no registro de nós
//                   (item.computeNodes[].cameras), ou a lista explícita que o
//                   admin mandou no corpo do replanejamento;
//   • anterior    → o plano SALVO (item.schedulerPlan); na PRIMEIRA vez, o
//                   próprio registro serve de atribuição anterior. Efeito
//                   desejado: o primeiro plano CONFIRMA o que já estava rodando
//                   e migra ZERO câmeras;
//   • estado dos nós → telemetria opcional (item.schedulerNodeStates) e/ou o
//                   override do corpo. Sem telemetria, todo nó é "unknown" =
//                   elegível: o scheduler não derruba nada por falta de dado.
//
// O plano fica em `item.schedulerPlan`, EXATAMENTE como computeNodes: dentro do
// objeto da instalação, sem tabela nem coluna nova. publicInstallation() lista
// campos um a um, então o plano NÃO vaza para as respostas existentes.

const { normalizeComputeNodes, summarizeNodes } = require('../datastore/compute-nodes');
const { resolveSchedulerConfig, schedulerConfigFromEnv, DEFAULT_SCHEDULER_CONFIG } = require('./config');
const plan = require('./plan');
const leases = require('./leases');

const PLAN_FIELD = 'schedulerPlan';
const NODE_STATES_FIELD = 'schedulerNodeStates';

function comparePlain(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Cargas derivadas do REGISTRO: união das câmeras atribuídas aos nós. Uma
// instalação sem `cameras` no registro simplesmente não tem carga conhecida — e
// aí o plano nasce vazio (honesto) em vez de inventar câmeras.
function workloadsFromInstallation(item) {
  const nodes = normalizeComputeNodes(item && item.computeNodes);
  const ids = new Set();
  for (const node of nodes) {
    if (!Array.isArray(node.cameras)) continue;
    for (const cameraId of node.cameras) ids.add(cameraId);
  }
  return [...ids].sort(comparePlain).map((id) => ({ id, weight: 1 }));
}

// Atribuição implícita do registro (cameraId → nodeId), usada como "anterior"
// enquanto não existe plano salvo.
function assignmentsFromRegistry(item) {
  const nodes = normalizeComputeNodes(item && item.computeNodes);
  const out = [];
  for (const node of nodes) {
    if (!Array.isArray(node.cameras)) continue;
    for (const cameraId of node.cameras) out.push({ cameraId, nodeId: node.id, token: null });
  }
  return out.sort((a, b) => comparePlain(a.cameraId, b.cameraId));
}

function storedPlan(item) {
  const saved = item && item[PLAN_FIELD];
  if (saved && typeof saved === 'object' && !Array.isArray(saved) && Array.isArray(saved.assignments)) return saved;
  return null;
}

function previousFromInstallation(item) {
  const saved = storedPlan(item);
  if (saved) return saved;
  return { assignments: assignmentsFromRegistry(item), epoch: 0, nextToken: 0 };
}

function nodeStatesFromInstallation(item) {
  const states = item && item[NODE_STATES_FIELD];
  if (states && typeof states === 'object' && !Array.isArray(states)) return states;
  return {};
}

// Erro de USO (corpo grande demais) — o servidor traduz em 400, não em 500.
function tooManyWorkloads(count, max) {
  const error = new Error(`Cargas demais para planejar: ${count} (máximo ${max}).`);
  error.code = 'too_many_workloads';
  return error;
}

// Planeja para UMA instalação. `now` é obrigatório (injetado pelo chamador) —
// mesma disciplina de plan.js: o algoritmo não lê o relógio.
function planForInstallation(item, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const config = resolveSchedulerConfig(opts.config);
  const explicit = Array.isArray(opts.workloads) ? plan.normalizeWorkloads(opts.workloads) : null;
  const workloads = explicit || workloadsFromInstallation(item);
  if (workloads.length > config.maxWorkloads) throw tooManyWorkloads(workloads.length, config.maxWorkloads);

  const overrideStates = opts.nodeStates && typeof opts.nodeStates === 'object' && !Array.isArray(opts.nodeStates)
    ? opts.nodeStates
    : null;
  const nodeStates = { ...nodeStatesFromInstallation(item), ...(overrideStates || {}) };

  return plan.planAssignments({
    installationId: item && item.id !== undefined ? item.id : null,
    nodes: item && item.computeNodes,
    nodeStates,
    workloads,
    previous: previousFromInstallation(item),
    now: opts.now,
    config,
  });
}

// Leitura pura (o GET): devolve o plano SALVO como está, sem replanejar e sem
// escrever nada. `stale` avisa que o conjunto de cargas do registro já não bate
// com o do plano — sinal para o admin forçar replanejamento.
function planView(item, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const saved = storedPlan(item);
  const workloads = Array.isArray(opts.workloads) ? plan.normalizeWorkloads(opts.workloads) : workloadsFromInstallation(item);
  const planned = new Set();
  if (saved) {
    for (const assignment of saved.assignments) planned.add(String(assignment.cameraId));
    for (const entry of Array.isArray(saved.unassigned) ? saved.unassigned : []) planned.add(String(entry.cameraId));
  }
  const current = new Set(workloads.map((workload) => workload.id));
  const sameWorkloads = planned.size === current.size && [...current].every((id) => planned.has(id));
  return {
    enabled: true,
    installationId: item && item.id !== undefined ? item.id : null,
    planned: Boolean(saved),
    stale: saved ? !sameWorkloads : workloads.length > 0,
    workloadSource: Array.isArray(opts.workloads) ? 'request' : 'registry',
    workloads: workloads.map((workload) => workload.id),
    nodes: summarizeNodes(item && item.computeNodes),
    plan: saved,
  };
}

module.exports = {
  DEFAULT_SCHEDULER_CONFIG,
  PLAN_FIELD,
  NODE_STATES_FIELD,
  resolveSchedulerConfig,
  schedulerConfigFromEnv,
  workloadsFromInstallation,
  assignmentsFromRegistry,
  previousFromInstallation,
  nodeStatesFromInstallation,
  storedPlan,
  planForInstallation,
  planView,
  planAssignments: plan.planAssignments,
  checkFencing: leases.checkFencing,
  leases,
  plan,
};
