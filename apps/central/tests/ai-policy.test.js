'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_AI_POLICY,
  normalizeAiPolicy,
  validateAiPolicy,
  applyAiPolicyToRestrictions,
  describeAiPolicy,
} = require('../src/ai-policy');

test('default: movimento LIGADO (essencial), objeto e face DESLIGADOS (pesadas)', () => {
  assert.deepEqual(normalizeAiPolicy(undefined), { motion: true, object: false, face: false });
  assert.equal(DEFAULT_AI_POLICY.motion, true);
  assert.equal(DEFAULT_AI_POLICY.object, false);
  assert.equal(DEFAULT_AI_POLICY.face, false);
});

test('normalize: valor inválido cai no default (nunca liga o pesado por acidente)', () => {
  assert.deepEqual(normalizeAiPolicy({ object: 'talvez', face: 1, motion: null }), DEFAULT_AI_POLICY);
  assert.deepEqual(normalizeAiPolicy('x'), DEFAULT_AI_POLICY);
  assert.deepEqual(normalizeAiPolicy([]), DEFAULT_AI_POLICY);
});

test('validate: só chaves conhecidas e booleanos (typo não liga nada em silêncio)', () => {
  assert.equal(validateAiPolicy({ motion: true }).valid, true);
  assert.equal(validateAiPolicy({ objeto: true }).valid, false, 'typo deve ser rejeitado');
  assert.equal(validateAiPolicy({ object: 'true' }).valid, false, 'string não vira boolean');
  assert.equal(validateAiPolicy(null).valid, false);
});

// A licença é TETO: o painel restringe abaixo dela, nunca acima. Senão o painel
// viraria um jeito de furar a política comercial.
test('teto comercial: licença sem aiAdvanced proíbe objeto/face mesmo marcados', () => {
  const r = applyAiPolicyToRestrictions({ aiAdvanced: false }, { motion: true, object: true, face: true });
  assert.equal(r.aiObject, false);
  assert.equal(r.aiFace, false);
  assert.equal(r.aiAdvanced, false);
  assert.equal(r.aiMotion, true, 'movimento não depende de aiAdvanced');
});

test('licença permitindo: o painel decide', () => {
  const r = applyAiPolicyToRestrictions({ aiAdvanced: true }, { motion: true, object: true, face: false });
  assert.equal(r.aiObject, true);
  assert.equal(r.aiFace, false);
  assert.equal(r.aiAdvanced, true, 'legado verdadeiro quando alguma pesada está ligada');
});

test('somente movimento produz aiAdvanced=false (e a instalação NÃO pode parar tudo por isso)', () => {
  const r = applyAiPolicyToRestrictions({ aiAdvanced: true }, { motion: true, object: false, face: false });
  assert.equal(r.aiAdvanced, false);
  assert.equal(r.aiMotion, true, 'a chave granular é o que impede o stopAll cego do outro lado');
});

test('outras restrições da licença são preservadas', () => {
  const r = applyAiPolicyToRestrictions({ aiAdvanced: true, localRecording: false, exports: true }, {});
  assert.equal(r.localRecording, false);
  assert.equal(r.exports, true);
});

test('describe: resumo legível para o painel', () => {
  assert.equal(describeAiPolicy({ motion: true, object: false, face: false }), 'somente movimento');
  assert.equal(describeAiPolicy({ motion: false, object: false, face: false }), 'nenhuma');
  assert.match(describeAiPolicy({ motion: true, object: true, face: false }), /motion.*object/);
});
