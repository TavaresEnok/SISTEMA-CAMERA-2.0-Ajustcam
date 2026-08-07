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
  // A política ganhou `objectClasses` (07/08/2026); a REGRA protegida aqui
  // continua sendo a mesma — pesadas nascem desligadas.
  const p = normalizeAiPolicy(undefined);
  assert.equal(p.motion, true);
  assert.equal(p.object, false);
  assert.equal(p.face, false);
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

// ─────────────────────────────────────────────────────────────────────────────
// QUAIS objetos, além de SE. A lista vive na Central porque é decisão de
// ESCOPO COMERCIAL — o cliente contratou pessoa e veículo, não cachorro — e
// porque cada classe extra custa CPU no servidor dele.
// ─────────────────────────────────────────────────────────────────────────────

test('a política nasce com classes de pessoa e veículo', () => {
  const p = normalizeAiPolicy({});
  assert.ok(p.objectClasses.includes('person'));
  assert.ok(p.objectClasses.includes('car'));
  assert.ok(!p.objectClasses.includes('dog'), 'padrão precisa ser enxuto — classe extra é custo sem pedido');
});

test('as classes viajam nas restrictions só quando objeto está LIGADO', () => {
  const ligado = applyAiPolicyToRestrictions({}, { object: true, objectClasses: ['person'] });
  assert.deepEqual(ligado.aiObjectClasses, ['person']);

  const desligado = applyAiPolicyToRestrictions({}, { object: false, objectClasses: ['person'] });
  assert.deepEqual(desligado.aiObjectClasses, [], 'sugerir permissão que não existe confunde o diagnóstico');
});

test('licença suspensa não deixa passar classe nenhuma', () => {
  // O painel não pode furar a política comercial: sem aiAdvanced pela licença,
  // marcar objeto e escolher classes não vale nada.
  const r = applyAiPolicyToRestrictions({ aiAdvanced: false }, { object: true, objectClasses: ['person'] });
  assert.equal(r.aiObject, false);
  assert.deepEqual(r.aiObjectClasses, []);
});

test('classe desconhecida vinda do PAINEL é rejeitada', () => {
  // Aceitar em silêncio faria a tela mostrar uma classe que nunca seria
  // detectada — o operador confiaria num perímetro que não existe.
  const r = validateAiPolicy({ object: true, objectClasses: ['person', 'dragao'] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('dragao')));
});

test('classe desconhecida vinda do REGISTRO é descartada, não trava tudo', () => {
  // Assimetria deliberada: uma Central mais nova pode conhecer classes que este
  // código ainda não. Travar a política inteira deixaria a instalação sem IA.
  const p = normalizeAiPolicy({ object: true, objectClasses: ['person', 'classe-do-futuro'] });
  assert.deepEqual(p.objectClasses, ['person']);
});

test('lista de classes vazia cai no padrão em vez de detectar nada', () => {
  // "Objeto ligado sem classe nenhuma" nunca detectaria coisa alguma e
  // pareceria defeito do sistema.
  const p = normalizeAiPolicy({ object: true, objectClasses: [] });
  assert.ok(p.objectClasses.length > 0);
});

test('classes duplicadas e com caixa diferente são normalizadas', () => {
  const p = normalizeAiPolicy({ objectClasses: ['Person', 'person', ' PERSON '] });
  assert.deepEqual(p.objectClasses, ['person']);
});

test('o resumo de auditoria mostra as classes escolhidas', () => {
  const texto = describeAiPolicy({ motion: true, object: true, objectClasses: ['person', 'car'] });
  assert.match(texto, /person/);
  assert.match(texto, /car/);
});
