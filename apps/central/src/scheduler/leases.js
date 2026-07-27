'use strict';

// ── Fase 4 — Scheduler multi-nó: LEASES com FENCING TOKEN ───────────────────
//
// O problema real: um nó some da rede (GC gigante, cabo, host congelado), o
// scheduler faz failover e a câmera passa a gravar no nó B. Minutos depois o nó
// A "volta do mundo dos mortos" achando que ainda é o dono e volta a gravar a
// MESMA câmera. Dois donos = dois FFmpeg no mesmo caminho, gravação corrompida.
//
// A cerca (fencing) é o TOKEN MONOTÔNICO: toda troca de dono emite um token
// MAIOR. Quem chega com token menor que o vigente é REJEITADO, sem exceção e
// sem "mas o nó parece saudável". É a única defesa que funciona contra um
// processo pausado — ele não tem como saber que morreu.
//
// Aqui só se VERIFICA. Nada é executado em nó nenhum (fase futura).

const REJECT_NO_PLAN = 'no_plan';
const REJECT_UNKNOWN_CAMERA = 'unknown_camera';
const REJECT_INVALID_CLAIM = 'invalid_claim';
const REJECT_STALE_TOKEN = 'stale_token';
const REJECT_FUTURE_TOKEN = 'future_token';
const REJECT_WRONG_NODE = 'wrong_node';
const REJECT_LEASE_EXPIRED = 'lease_expired';
const ACCEPTED = 'ok';

function findAssignment(plan, cameraId) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.assignments)) return null;
  const id = String(cameraId ?? '').trim();
  if (!id) return null;
  return plan.assignments.find((assignment) => assignment && String(assignment.cameraId) === id) || null;
}

// Verifica a reivindicação de um nó ("eu sou o dono da câmera X com o token T").
// `now` é INJETADO (nada de relógio implícito) e obrigatório para checar a
// expiração; sem `now` a expiração não é avaliada.
//
// Retorna { accepted, reason, current }. `current` é a atribuição vigente (para
// o chamador poder dizer ao zumbi QUEM é o dono agora).
function checkFencing(plan, claim) {
  const request = claim && typeof claim === 'object' ? claim : {};
  const cameraId = String(request.cameraId ?? '').trim();
  const nodeId = String(request.nodeId ?? '').trim();
  const token = Number(request.token);

  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.assignments)) {
    return { accepted: false, reason: REJECT_NO_PLAN, current: null };
  }
  if (!cameraId || !nodeId || !Number.isFinite(token)) {
    return { accepted: false, reason: REJECT_INVALID_CLAIM, current: null };
  }

  const current = findAssignment(plan, cameraId);
  if (!current) {
    // Câmera que saiu do plano não tem dono: ninguém pode reivindicá-la.
    return { accepted: false, reason: REJECT_UNKNOWN_CAMERA, current: null };
  }

  const currentToken = Number(current.token);
  if (token < currentToken) {
    // O zumbi clássico: token antigo. REJEITADO mesmo que o nó bata com o dono
    // vigente — um token velho significa que houve troca de dono no meio.
    return { accepted: false, reason: REJECT_STALE_TOKEN, current };
  }
  if (token > currentToken) {
    // Token nunca emitido por este plano (nó forjando/à frente do control-plane).
    return { accepted: false, reason: REJECT_FUTURE_TOKEN, current };
  }
  if (String(current.nodeId) !== nodeId) {
    return { accepted: false, reason: REJECT_WRONG_NODE, current };
  }

  const nowMs = request.now === undefined || request.now === null ? null : new Date(request.now).getTime();
  if (nowMs !== null && Number.isFinite(nowMs) && current.leaseExpiresAt) {
    const expiresAt = new Date(current.leaseExpiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
      return { accepted: false, reason: REJECT_LEASE_EXPIRED, current };
    }
  }

  return { accepted: true, reason: ACCEPTED, current };
}

// Todo token do plano novo é >= aos do anterior, e todo dono NOVO recebeu token
// ESTRITAMENTE maior que qualquer um já emitido. É a propriedade que garante que
// um zumbi jamais volta com token válido.
function tokensAreMonotonic(previousPlan, nextPlan) {
  const previousMax = maxIssuedToken(previousPlan);
  if (!nextPlan || !Array.isArray(nextPlan.assignments)) return false;
  const previousByCamera = new Map(
    (previousPlan && Array.isArray(previousPlan.assignments) ? previousPlan.assignments : [])
      .map((assignment) => [String(assignment.cameraId), assignment]),
  );
  for (const assignment of nextPlan.assignments) {
    const token = Number(assignment.token);
    if (!Number.isFinite(token) || token <= 0) return false;
    const before = previousByCamera.get(String(assignment.cameraId));
    const retained = before && String(before.nodeId) === String(assignment.nodeId);
    if (retained) {
      if (token !== Number(before.token)) return false; // retido preserva o token
    } else if (token <= previousMax) {
      return false; // dono novo TEM de superar tudo que já foi emitido
    }
  }
  return true;
}

function maxIssuedToken(plan) {
  let max = 0;
  if (plan && Array.isArray(plan.assignments)) {
    for (const assignment of plan.assignments) {
      const token = Number(assignment && assignment.token);
      if (Number.isFinite(token) && token > max) max = token;
    }
  }
  if (plan && Array.isArray(plan.revoked)) {
    for (const entry of plan.revoked) {
      const token = Number(entry && entry.token);
      if (Number.isFinite(token) && token > max) max = token;
    }
  }
  return max;
}

module.exports = {
  ACCEPTED,
  REJECT_NO_PLAN,
  REJECT_UNKNOWN_CAMERA,
  REJECT_INVALID_CLAIM,
  REJECT_STALE_TOKEN,
  REJECT_FUTURE_TOKEN,
  REJECT_WRONG_NODE,
  REJECT_LEASE_EXPIRED,
  findAssignment,
  checkFencing,
  maxIssuedToken,
  tokensAreMonotonic,
};
