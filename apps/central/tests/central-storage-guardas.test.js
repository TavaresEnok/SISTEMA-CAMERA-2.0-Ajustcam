'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CENTRAL_STORAGE_SECRET = process.env.CENTRAL_STORAGE_SECRET || 'chave-de-teste-com-32-caracteres!!';
const { validateCloudStorage } = require('../src/cloud-storage');

// ── AS GUARDAS QUE FALTAVAM NO CADASTRO DE STORAGE ─────────────────────────
//
// O `NoSuchBucket` desta instalação nasceu aqui: dava para HABILITAR um
// storage cuja verificação reprovava, e o prefixo — que é o que isola uma
// instalação da outra dentro do mesmo bucket — era campo livre que a tela
// apenas SUGERIA.

const BASE = {
  enabled: true,
  endpoint: 'https://object.exemplo.com.br',
  bucket: 'meu-bucket',
  prefix: 'inst-1',
  accessKeyId: 'AK123',
  secretAccessKey: 'segredo',
};

test('prefixo em branco é PREENCHIDO com o id da instalação', () => {
  // Sem prefixo, duas instalações dividem o espaço de chaves e a limpeza de
  // uma apaga o acervo da outra. Recusar o save resolveria — mas travaria um
  // fluxo legítimo; preencher com o id (o que a tela já sugere) garante o
  // isolamento SEM atrapalhar quem está configurando.
  const r = validateCloudStorage({ ...BASE, prefix: '' }, { installationId: 'inst-42' });
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.value.prefix, 'inst-42');
});

test('sem prefixo E sem id (chamada de API crua) ainda é recusado', () => {
  const r = validateCloudStorage({ ...BASE, prefix: '' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('prefixo')), r.errors.join(' | '));
});

test('prefixo em COLISÃO com outra instalação é recusado, com o nome dela', () => {
  const r = validateCloudStorage(BASE, {
    installationId: 'inst-nova',
    prefixosEmUso: [{ installationId: 'inst-antiga', endpoint: BASE.endpoint, bucket: BASE.bucket, prefix: 'inst-1' }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('inst-antiga')), r.errors.join(' | '));
});

test('o MESMO trio na PRÓPRIA instalação não é colisão (é só reeditar)', () => {
  const r = validateCloudStorage(BASE, {
    installationId: 'inst-1',
    prefixosEmUso: [{ installationId: 'inst-1', endpoint: BASE.endpoint, bucket: BASE.bucket, prefix: 'inst-1' }],
  });
  assert.equal(r.ok, true, r.errors.join(' | '));
});

test('mesmo bucket com prefixos DIFERENTES é o uso legítimo', () => {
  const r = validateCloudStorage({ ...BASE, prefix: 'inst-2' }, {
    installationId: 'inst-2',
    prefixosEmUso: [{ installationId: 'inst-1', endpoint: BASE.endpoint, bucket: BASE.bucket, prefix: 'inst-1' }],
  });
  assert.equal(r.ok, true, r.errors.join(' | '));
});

test('bucket com nome inválido é recusado ANTES de virar erro de assinatura', () => {
  // Maiúscula/barra/espaço entram sem escape na URI canônica: o operador
  // recebia "credencial inválida" por um erro de digitação no bucket.
  for (const bucket of ['Meu-Bucket', 'meu bucket', 'meu/bucket', 'meu?bucket']) {
    const r = validateCloudStorage({ ...BASE, bucket });
    assert.equal(r.ok, false, `aceitou bucket inválido: ${bucket}`);
  }
});

test('prefixo é normalizado (barras nas pontas somem)', () => {
  const r = validateCloudStorage({ ...BASE, prefix: '/inst-1/' });
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.value.prefix, 'inst-1', 'barra sobrando vira // na chave do objeto');
});

test('DESABILITADO não exige prefixo — configurar aos poucos continua possível', () => {
  const r = validateCloudStorage({ ...BASE, enabled: false, prefix: '' });
  assert.equal(r.ok, true, r.errors.join(' | '));
});
