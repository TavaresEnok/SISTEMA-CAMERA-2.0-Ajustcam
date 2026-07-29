'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// A cifra do segredo exige a chave da Central; define ANTES de importar o módulo.
process.env.CENTRAL_STORAGE_SECRET = process.env.CENTRAL_STORAGE_SECRET || 'chave-de-teste-com-mais-de-16-chars';

const {
  DEFAULT_CONFIG,
  STORAGE_MODES,
  normalizeCloudStorage,
  validateCloudStorage,
  describeCloudStorage,
  buildInstallationPayload,
  encryptSecret,
  decryptSecret,
} = require('../src/cloud-storage');

// Storage em nuvem POR INSTALAÇÃO, provisionado pela Central.
//
// O que estes testes travam, em ordem de gravidade:
//  1. credencial do cliente NUNCA volta para o navegador nem fica em claro no
//     registro — é o dado mais sensível que a Central passa a guardar;
//  2. configuração PELA METADE não desce para a instalação (subir gravação para
//     um bucket inexistente perde vídeo achando que salvou);
//  3. o modo `mount` (escrita direta no bucket) nasce DESLIGADO — é o caminho
//     que corrompe segmento e cobra por requisição;
//  4. salvar sem redigitar o segredo mantém o segredo anterior.

const BASE = {
  enabled: true,
  mode: 'tier',
  name: 'MinIO do escritório',
  endpoint: 'http://168.194.13.18:9100',
  region: 'us-east-1',
  bucket: 'meu-storage',
  accessKeyId: 'AK123',
  secretAccessKey: 'SEGREDO-DO-CLIENTE',
};

test('default nasce DESLIGADO e em modo tier (o seguro)', () => {
  const c = normalizeCloudStorage(undefined);
  assert.equal(c.enabled, false, 'nada de mandar gravação para nuvem que ninguém configurou');
  assert.equal(c.mode, 'tier');
  assert.equal(DEFAULT_CONFIG.mode, 'tier');
  assert.ok(STORAGE_MODES.includes('mount'), 'mount existe, mas não é o default');
});

test('payload corrompido cai no default em vez de habilitar por acidente', () => {
  assert.equal(normalizeCloudStorage('lixo').enabled, false);
  assert.equal(normalizeCloudStorage({ mode: 'inventado' }).mode, 'tier');
  assert.equal(normalizeCloudStorage({ name: 123 }).name, '123', 'nome não-string vira texto em vez de quebrar');
});

test('cifra do segredo faz round-trip e NÃO guarda em claro', () => {
  const cifrado = encryptSecret('SEGREDO-DO-CLIENTE');
  assert.notEqual(cifrado, 'SEGREDO-DO-CLIENTE');
  assert.ok(!cifrado.includes('SEGREDO'), 'o texto claro não pode aparecer no ciphertext');
  assert.equal(decryptSecret(cifrado), 'SEGREDO-DO-CLIENTE');
});

test('cifra usa IV aleatório (dois saves do mesmo segredo dão ciphertexts diferentes)', () => {
  assert.notEqual(encryptSecret('igual'), encryptSecret('igual'));
});

test('segredo adulterado é REJEITADO (GCM autentica)', () => {
  const cifrado = encryptSecret('SEGREDO');
  const bytes = Buffer.from(cifrado, 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  assert.throws(() => decryptSecret(bytes.toString('base64')));
});

test('validação: habilitar exige credencial COMPLETA', () => {
  const semBucket = validateCloudStorage({ ...BASE, bucket: '' });
  assert.equal(semBucket.ok, false);
  assert.ok(semBucket.errors.some((e) => /bucket/.test(e)));

  const semSegredo = validateCloudStorage({ ...BASE, secretAccessKey: '' });
  assert.equal(semSegredo.ok, false, 'sem segredo não liga');

  const endpointRuim = validateCloudStorage({ ...BASE, endpoint: '168.194.13.18:9100' });
  assert.equal(endpointRuim.ok, false, 'endpoint sem esquema é erro comum de digitação');
});

test('validação: rascunho DESLIGADO pode ficar incompleto', () => {
  const rascunho = validateCloudStorage({ enabled: false, endpoint: '', bucket: '' });
  assert.equal(rascunho.ok, true, 'o operador precisa poder salvar aos poucos');
  assert.equal(rascunho.value.enabled, false);
});

test('salvar sem redigitar o segredo MANTÉM o anterior', () => {
  // A interface nunca devolve o segredo; exigir redigitação a cada save faria o
  // operador recolar credencial toda vez que mudasse a janela de retenção.
  const anterior = encryptSecret('SEGREDO-ANTIGO');
  const r = validateCloudStorage({ ...BASE, secretAccessKey: '' }, { existingSecret: 'SEGREDO-ANTIGO' });
  assert.equal(r.ok, true);
  assert.equal(decryptSecret(r.value.secretAccessKeyEncrypted), 'SEGREDO-ANTIGO');
  assert.ok(anterior);
});

test('describe: NUNCA devolve o segredo para o navegador', () => {
  const salvo = validateCloudStorage(BASE).value;
  const visao = describeCloudStorage(salvo);
  const serializado = JSON.stringify(visao);
  assert.ok(!serializado.includes('SEGREDO-DO-CLIENTE'), 'segredo em claro no JSON da UI seria vazamento');
  assert.ok(!('secretAccessKeyEncrypted' in visao), 'nem o ciphertext precisa ir para a tela');
  assert.equal(visao.hasSecret, true, 'mas a tela precisa saber que EXISTE segredo salvo');
  assert.equal(visao.displayName, 'MinIO do escritório', 'a tela identifica pelo NOME dado pelo operador');
});

test('payload para a instalação leva o segredo DECIFRADO (ela precisa falar com o bucket)', () => {
  const salvo = validateCloudStorage(BASE).value;
  const payload = buildInstallationPayload(salvo);
  assert.equal(payload.secretAccessKey, 'SEGREDO-DO-CLIENTE');
  assert.equal(payload.bucket, 'meu-storage');
  assert.equal(payload.mode, 'tier');
});

test('config DESLIGADA não desce nada', () => {
  const salvo = validateCloudStorage({ ...BASE, enabled: false }).value;
  assert.equal(buildInstallationPayload(salvo), null);
});

test('config pela METADE não desce (não manda gravação para bucket inexistente)', () => {
  const meio = normalizeCloudStorage({ ...BASE, enabled: true, bucket: '', secretAccessKeyEncrypted: encryptSecret('x') });
  assert.equal(buildInstallationPayload(meio), null, 'sem bucket não desce');

  const semSegredo = normalizeCloudStorage({ ...BASE, enabled: true, secretAccessKeyEncrypted: '' });
  assert.equal(buildInstallationPayload(semSegredo), null, 'sem segredo não desce');
});

test('segredo indecifrável (chave da Central trocada) não desce credencial quebrada', () => {
  // Melhor a instalação não receber nada do que entrar em laço de 403.
  const corrompido = normalizeCloudStorage({
    ...BASE,
    enabled: true,
    secretAccessKeyEncrypted: Buffer.from('nao-e-nosso-formato-mas-passa-do-tamanho-minimo-xx').toString('base64'),
  });
  assert.equal(buildInstallationPayload(corrompido), null);
});

test('janela local fora da faixa cai no default (não vira 0 nem infinito)', () => {
  assert.equal(normalizeCloudStorage({ localWindowHours: 0 }).localWindowHours, 24);
  assert.equal(normalizeCloudStorage({ localWindowHours: 99999 }).localWindowHours, 24);
  assert.equal(normalizeCloudStorage({ localWindowHours: 6 }).localWindowHours, 6);
});

test('modo mount é aceito quando pedido explicitamente', () => {
  const r = validateCloudStorage({ ...BASE, mode: 'mount' });
  assert.equal(r.ok, true);
  assert.equal(r.value.mode, 'mount');
  assert.equal(buildInstallationPayload(r.value).mode, 'mount');
});

test('estilo de URL: padrão é CAMINHO, e a escolha do operador vence', () => {
  // Não há mais seletor de "provedor": MinIO, Backblaze, Eveo, Wasabi e AWS
  // falam o mesmo protocolo. A única diferença que muda o código é esta, e ela
  // é exposta como o interruptor técnico que de fato é.
  assert.equal(normalizeCloudStorage({}).forcePathStyle, true, 'caminho é o caso comum');
  assert.equal(normalizeCloudStorage({ forcePathStyle: false }).forcePathStyle, false, 'subdomínio para AWS');
});

test('sem nome, a tela ainda identifica o storage pelo bucket', () => {
  const salvo = validateCloudStorage({ ...BASE, name: '' }).value;
  assert.equal(describeCloudStorage(salvo).displayName, 'meu-storage');
});
