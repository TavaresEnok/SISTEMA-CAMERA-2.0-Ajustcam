'use strict';

// Nós de computação por instalação (item 3.2) — DADO, não config manual por host.
//
// Filosofia: um SEAM de dados INERTE e RETROCOMPATÍVEL. Uma instalação SEM nós
// definidos (campo ausente / []) mantém o comportamento atual de PRIMÁRIO ÚNICO
// implícito — nada muda. Os nós vivem DENTRO do objeto da instalação
// (`item.computeNodes`), então fluem verbatim pelo payload jsonb do Postgres e
// pelo JSON legado (dual-read) SEM tabela/coluna nova — menor risco possível.
//
// Isto NÃO é um scheduler distribuído nem um cluster: é só o registro dos nós,
// sua validação e um resumo. Quem consome (fleet/leitura) decide o que fazer.
//
// Funções PURAS (sem I/O), 100% testáveis:
//   normalizeComputeNodes  → coerção de forma (ausente/inválido → [])
//   validateComputeNodes   → regras (papel inválido, id duplicado, worker sem primary)
//   summarizeNodes         → contagem para o fleet

const ROLE_PRIMARY = 'primary';
const ROLE_WORKER = 'worker';
const ROLES = Object.freeze([ROLE_PRIMARY, ROLE_WORKER]);

// Capacidade opcional → número de câmeras (maxCameras). Aceita um número direto
// ou um objeto { maxCameras }. Idempotente: número entra, número sai. Lixo → omitido.
function normalizeCapacity(capacity) {
  if (typeof capacity === 'number' && Number.isFinite(capacity) && capacity >= 0) {
    return capacity;
  }
  if (capacity && typeof capacity === 'object' && !Array.isArray(capacity)) {
    const maxCameras = Number(capacity.maxCameras);
    if (Number.isFinite(maxCameras) && maxCameras >= 0) return maxCameras;
  }
  return undefined;
}

// Câmeras atribuídas opcionais → array de ids (string, aparados, sem vazios).
// Ausente/não-array → undefined (campo omitido). Idempotente.
function normalizeCameras(cameras) {
  if (!Array.isArray(cameras)) return undefined;
  const out = [];
  for (const raw of cameras) {
    const id = String(raw ?? '').trim();
    if (id) out.push(id);
  }
  return out.length ? out : undefined;
}

// Coerção de forma de UM nó. Só campos conhecidos sobrevivem (id, role, host,
// label, capacity, cameras); lixo extra é descartado. Campos opcionais vazios são
// OMITIDOS (retrocompat: um nó mínimo é só { id, role }). Não valida — quem valida
// é validateComputeNodes; assim normalize é forma, validate é regra.
function normalizeNode(raw) {
  const node = {
    id: String(raw.id ?? '').trim(),
    role: String(raw.role ?? '').trim().toLowerCase(),
  };
  const host = String(raw.host ?? '').trim();
  if (host) node.host = host;
  const label = String(raw.label ?? '').trim();
  if (label) node.label = label;
  const capacity = normalizeCapacity(raw.capacity);
  if (capacity !== undefined) node.capacity = capacity;
  const cameras = normalizeCameras(raw.cameras);
  if (cameras) node.cameras = cameras;
  return node;
}

// DEFAULT = [] → tratado como PRIMÁRIO ÚNICO implícito (comportamento atual).
// Qualquer coisa que não seja array (ausente/null/objeto) vira []. Entradas não-
// objeto são descartadas; entradas objeto são normalizadas (mesmo id vazio, para
// que validate possa reprová-las). Idempotente: normalize(normalize(x)) == normalize(x).
function normalizeComputeNodes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    out.push(normalizeNode(raw));
  }
  return out;
}

// Regras (dentes). Opera sobre nós crus OU normalizados — lê id/role defensivamente.
// Retorna { valid, errors:[{code,message,index?}] }.
//   • [] (ausente) → VÁLIDO: retrocompat, primário único implícito.
//   • id vazio → invalid_id
//   • id repetido → duplicate_id
//   • papel fora de {primary,worker} → invalid_role
//   • >1 nó sem nenhum primary → missing_primary (worker sem primary quando há vários)
function validateComputeNodes(nodes) {
  const errors = [];
  const list = Array.isArray(nodes) ? nodes : [];
  if (list.length === 0) return { valid: true, errors };

  const seen = new Set();
  let primaries = 0;
  list.forEach((node, index) => {
    const id = node && node.id != null ? String(node.id).trim() : '';
    const role = node && node.role != null ? String(node.role).trim().toLowerCase() : '';
    if (!id) {
      errors.push({ code: 'invalid_id', message: `Nó ${index}: id obrigatório.`, index });
    } else if (seen.has(id)) {
      errors.push({ code: 'duplicate_id', message: `Nó "${id}": id duplicado.`, index });
    } else {
      seen.add(id);
    }
    if (role !== ROLE_PRIMARY && role !== ROLE_WORKER) {
      errors.push({ code: 'invalid_role', message: `Nó "${id || index}": papel inválido "${role}".`, index });
    }
    if (role === ROLE_PRIMARY) primaries += 1;
  });

  if (list.length > 1 && primaries === 0) {
    errors.push({ code: 'missing_primary', message: 'Com mais de um nó, ao menos um deve ter papel "primary".' });
  }

  return { valid: errors.length === 0, errors };
}

// Resumo para o fleet. Normaliza internamente (robusto a entrada crua). Uma
// instalação sem nós explícitos: { configured:false, total:0, ... } — primário
// único implícito, sem gerência de nós.
function summarizeNodes(nodes) {
  const list = normalizeComputeNodes(nodes);
  let primary = 0;
  let worker = 0;
  let assignedCameras = 0;
  for (const node of list) {
    if (node.role === ROLE_PRIMARY) primary += 1;
    else if (node.role === ROLE_WORKER) worker += 1;
    if (Array.isArray(node.cameras)) assignedCameras += node.cameras.length;
  }
  return {
    configured: list.length > 0,
    total: list.length,
    primary,
    worker,
    assignedCameras,
  };
}

module.exports = {
  ROLE_PRIMARY,
  ROLE_WORKER,
  ROLES,
  normalizeComputeNodes,
  validateComputeNodes,
  summarizeNodes,
};
