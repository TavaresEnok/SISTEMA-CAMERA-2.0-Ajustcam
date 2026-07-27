'use strict';

// ── Política de IA POR INSTALAÇÃO (controlada pelo painel da Central) ────────
//
// Antes, o único controle de IA era `aiAdvanced`, derivado automaticamente do
// status da licença. Não havia como o administrador do white-label dizer "nesta
// instalação, só movimento" — era preciso mexer em variável de ambiente e
// recriar container, ou seja, depender de linha de comando.
//
// Aqui a decisão vira DADO por instalação, empurrado no mesmo canal que já
// existe (restrictions no heartbeat) e aplicado pela instalação.
//
// AS TRÊS CAPACIDADES, e por que motion é diferente:
//   motion → detecção de movimento MOG2 (leve, ~2% CPU/câmera). É o que ARMA a
//            gravação por movimento: desligar isto faz a câmera armada parar de
//            gravar. Por isso nasce LIGADA e desligá-la é decisão consciente.
//   object → detecção de objeto (YOLO). Pesada. Nasce DESLIGADA.
//   face   → reconhecimento facial. Pesada e sensível (LGPD). Nasce DESLIGADA.

const AI_CAPABILITIES = Object.freeze(['motion', 'object', 'face']);

const DEFAULT_AI_POLICY = Object.freeze({
  motion: true,
  object: false,
  face: false,
});

function readBool(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return fallback;
}

/**
 * Normaliza a política vinda do registro/payload. Campo ausente ou inválido cai
 * no default — nunca em "ligado por acidente" para as capacidades pesadas.
 */
function normalizeAiPolicy(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const cap of AI_CAPABILITIES) {
    out[cap] = readBool(source[cap], DEFAULT_AI_POLICY[cap]);
  }
  return out;
}

/**
 * Valida um payload de política vindo do painel. Só aceita as chaves conhecidas
 * e booleanos — um typo (`objeto`) não pode ligar nada em silêncio, e um valor
 * não-booleano não pode virar `true` por coerção.
 */
function validateAiPolicy(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['aiPolicy deve ser um objeto'] };
  }
  for (const key of Object.keys(input)) {
    if (!AI_CAPABILITIES.includes(key)) errors.push(`chave desconhecida: ${key}`);
  }
  for (const cap of AI_CAPABILITIES) {
    if (cap in input && typeof input[cap] !== 'boolean') {
      errors.push(`${cap} deve ser boolean`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Funde a política do painel nas `restrictions` do heartbeat.
 *
 * REGRA CENTRAL: a licença é TETO, o painel só restringe abaixo dela. Uma
 * instalação SUSPENSA/RESTRITA não pode ganhar IA avançada porque alguém marcou
 * a caixinha — senão o painel viraria um jeito de furar a política comercial.
 */
function applyAiPolicyToRestrictions(restrictions, policy) {
  const base = restrictions && typeof restrictions === 'object' ? restrictions : {};
  const wanted = normalizeAiPolicy(policy);
  // Teto comercial: sem aiAdvanced pela licença, object/face ficam proibidos.
  const advancedAllowed = base.aiAdvanced !== false;
  return {
    ...base,
    aiMotion: wanted.motion,
    aiObject: wanted.object && advancedAllowed,
    aiFace: wanted.face && advancedAllowed,
    // `aiAdvanced` legado permanece: verdadeiro só se a licença permite E o
    // painel liberou alguma das pesadas. Instalação antiga que não entenda as
    // chaves novas continua obedecendo a este campo.
    aiAdvanced: advancedAllowed && (wanted.object || wanted.face),
  };
}

/** Resumo curto para o painel/telemetria. */
function describeAiPolicy(policy) {
  const p = normalizeAiPolicy(policy);
  const ligadas = AI_CAPABILITIES.filter((cap) => p[cap]);
  if (!ligadas.length) return 'nenhuma';
  if (ligadas.length === 1 && ligadas[0] === 'motion') return 'somente movimento';
  return ligadas.join(', ');
}

module.exports = {
  AI_CAPABILITIES,
  DEFAULT_AI_POLICY,
  normalizeAiPolicy,
  validateAiPolicy,
  applyAiPolicyToRestrictions,
  describeAiPolicy,
};
