'use strict';

const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');

// ── STORAGE EM NUVEM POR INSTALAÇÃO (provisionado pelo painel da Central) ────
//
// O que resolve: hoje o cliente que quer mais retenção precisa comprar disco.
// Aqui o administrador do white-label configura, POR INSTALAÇÃO, um bucket
// S3-compatível (MinIO, Backblaze B2, Eveo, AWS, Wasabi) e a instalação passa a
// usá-lo — sem ninguém entrar por SSH nem editar variável de ambiente.
//
// Desce pelo MESMO canal que a política de IA já usa: a resposta do heartbeat.
// Não abre porta na instalação, não inverte o sentido da conexão, e vale para
// instalação atrás de NAT — que é a maioria.
//
// MODO DE OPERAÇÃO (a decisão que mais importa):
//   tier   → grava LOCAL e sobe o segmento fechado para a nuvem, apagando o
//            local depois da janela. É o padrão porque é o único seguro: o
//            ffmpeg escreve um segmento a cada poucos segundos, e escrita
//            direta em bucket (via mount) trava, gera objeto parcial e cobra
//            por requisição.
//   mount  → aponta a gravação para um mount do bucket. É o que alguns
//            operadores pedem para "não ter disco local". Fica disponível, mas
//            NASCE DESLIGADO e a interface precisa dizer o risco: segmento
//            corrompido e custo por PUT são consequências reais, não teóricas.
//
// SEGREDO EM REPOUSO: a chave secreta é cifrada com AES-256-GCM antes de tocar
// o armazenamento da Central. A Central PRECISA conseguir decifrar (a
// instalação recebe a credencial para falar com o bucket), então não é hash — é
// cifra reversível com chave derivada de `CENTRAL_STORAGE_SECRET`.

const STORAGE_MODES = Object.freeze(['tier', 'mount']);

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  mode: 'tier',
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  prefix: '',
  accessKeyId: '',
  /** Janela local antes do offload, em horas (só no modo `tier`). */
  localWindowHours: 24,
  forcePathStyle: true,
});

// NÃO existe lista de "provedores suportados", e isso é deliberado.
//
// MinIO, Backblaze B2, Eveo, Wasabi e AWS S3 falam o MESMO protocolo (S3 com
// assinatura V4). A única diferença que muda o comportamento do código é o
// ESTILO DE URL: quase todos servem em `endpoint/bucket/chave` (path-style), e
// a AWS usa `bucket.endpoint` (virtual-host), que exige DNS coringa e por isso
// quebra em IP puro.
//
// Um seletor de marcas sugeriria uma diferença de capacidade que não existe, e
// deixaria de fora qualquer provedor não listado. O que o operador precisa é
// dar um NOME ao storage ("MinIO do escritório", "Backblaze backup") e informar
// o endpoint. O estilo de URL fica como interruptor técnico, com o padrão certo
// para o caso comum.

function readBool(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return fallback;
}

function readInt(value, fallback, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

// ── Cifra do segredo ────────────────────────────────────────────────────────

function storageKey() {
  const raw = String(process.env.CENTRAL_STORAGE_SECRET || '').trim();
  if (raw.length < 16) {
    // Falhar alto é melhor que cifrar com chave fraca e dar a impressão de que
    // a credencial do cliente está protegida.
    throw new Error('CENTRAL_STORAGE_SECRET é obrigatório (mínimo 16 caracteres) para guardar credenciais de storage.');
  }
  return createHash('sha256').update(raw).digest();
}

function encryptSecret(plain) {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', storageKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decryptSecret(payload) {
  if (!payload) return '';
  const raw = Buffer.from(String(payload), 'base64');
  // 12 (iv) + 16 (tag) = 28 bytes de cabeçalho; abaixo disso não é nosso formato.
  if (raw.length <= 28) return '';
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', storageKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// ── Normalização e validação ────────────────────────────────────────────────

/**
 * Normaliza o que veio do registro. Campo ausente/inválido cai no default —
 * e o default NUNCA é "ligado", para que um payload corrompido não acabe
 * mandando gravação para um bucket que ninguém configurou.
 */
function normalizeCloudStorage(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const mode = STORAGE_MODES.includes(source.mode) ? source.mode : DEFAULT_CONFIG.mode;
  return {
    enabled: readBool(source.enabled, DEFAULT_CONFIG.enabled),
    mode,
    // NOME dado pelo operador ("MinIO do escritório"). Substituiu o seletor de
    // marcas: o que ele precisa é distinguir os storages dele, não declarar
    // fabricante — o protocolo é o mesmo em todos.
    name: String(source.name ?? '').trim().slice(0, 80),
    endpoint: String(source.endpoint ?? '').trim(),
    region: String(source.region ?? DEFAULT_CONFIG.region).trim() || DEFAULT_CONFIG.region,
    bucket: String(source.bucket ?? '').trim(),
    prefix: String(source.prefix ?? '').trim(),
    accessKeyId: String(source.accessKeyId ?? '').trim(),
    secretAccessKeyEncrypted: String(source.secretAccessKeyEncrypted ?? ''),
    localWindowHours: readInt(source.localWindowHours, DEFAULT_CONFIG.localWindowHours, { min: 1, max: 24 * 30 }),
    forcePathStyle: readBool(source.forcePathStyle, DEFAULT_CONFIG.forcePathStyle),
    updatedAt: source.updatedAt ?? null,
    lastTestAt: source.lastTestAt ?? null,
    lastTestOk: readBool(source.lastTestOk, null) === null ? null : readBool(source.lastTestOk, false),
  };
}

/**
 * Valida o que veio da interface. Devolve `{ ok, errors, value }`.
 *
 * Regra central: só exigimos credencial completa quando `enabled` é true.
 * Assim o operador consegue salvar um rascunho sem ser obrigado a preencher
 * tudo de uma vez, mas não consegue LIGAR um storage pela metade.
 */
function validateCloudStorage(input, { existingSecret = '' } = {}) {
  const errors = [];
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  if (source.mode !== undefined && !STORAGE_MODES.includes(source.mode)) {
    errors.push(`mode deve ser um de: ${STORAGE_MODES.join(', ')}`);
  }

  const enabled = readBool(source.enabled, false);
  const endpoint = String(source.endpoint ?? '').trim();
  const bucket = String(source.bucket ?? '').trim();
  const accessKeyId = String(source.accessKeyId ?? '').trim();
  // Segredo em branco na edição significa "mantenha o que já está lá" — a
  // interface nunca devolve o segredo, então exigir digitação a cada save faria
  // o operador recolar credencial toda vez.
  const secret = String(source.secretAccessKey ?? '').trim() || existingSecret;

  if (enabled) {
    // O ESQUEMA não é mais obrigatório: quem cadastra não tem por que saber se
    // aquele fornecedor atende em TLS. `resolverEndpoint` sonda e decide antes
    // de chegar aqui; o que resta validar é que existe um endereço.
    if (!endpoint) errors.push('endpoint é obrigatório para habilitar');
    else if (!/^https?:\/\/[^/\s]+/i.test(endpoint)) errors.push('endpoint inválido');
    if (!bucket) errors.push('bucket é obrigatório para habilitar');
    if (!accessKeyId) errors.push('accessKeyId é obrigatório para habilitar');
    if (!secret) errors.push('secretAccessKey é obrigatório para habilitar');
  }

  const windowHours = source.localWindowHours;
  if (windowHours !== undefined && readInt(windowHours, null, { min: 1, max: 24 * 30 }) === null) {
    errors.push('localWindowHours deve estar entre 1 e 720');
  }

  if (errors.length) return { ok: false, errors, value: null };

  const normalized = normalizeCloudStorage({
    ...source,
    enabled,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKeyEncrypted: secret ? encryptSecret(secret) : '',
  });
  return { ok: true, errors: [], value: { ...normalized, updatedAt: new Date().toISOString() } };
}

/**
 * Versão para EXIBIÇÃO na interface: sem a credencial, com um indicador de que
 * ela existe. A Central nunca devolve o segredo para o navegador — quem precisa
 * dele é a instalação, e ela o recebe pelo heartbeat.
 */
function describeCloudStorage(config) {
  const c = normalizeCloudStorage(config);
  const { secretAccessKeyEncrypted, ...rest } = c;
  return {
    ...rest,
    hasSecret: Boolean(secretAccessKeyEncrypted),
    // Nome para a tela; sem nome, o bucket serve de identificação.
    displayName: c.name || c.bucket || 'Storage sem nome',
  };
}

/**
 * O que desce para a instalação no heartbeat.
 *
 * Devolve `null` quando o storage não está habilitado ou está incompleto: é
 * melhor a instalação não receber nada do que receber uma configuração pela
 * metade e tentar subir gravação para um bucket inexistente.
 */
function buildInstallationPayload(config) {
  const c = normalizeCloudStorage(config);
  if (!c.enabled) return null;
  if (!c.endpoint || !c.bucket || !c.accessKeyId || !c.secretAccessKeyEncrypted) return null;

  let secret = '';
  try {
    secret = decryptSecret(c.secretAccessKeyEncrypted);
  } catch {
    // Chave da Central trocada, registro corrompido: não desce credencial
    // quebrada (a instalação tomaria 403 em loop e encheria o log).
    return null;
  }
  if (!secret) return null;

  return {
    enabled: true,
    mode: c.mode,
    name: c.name,
    endpoint: c.endpoint,
    region: c.region,
    bucket: c.bucket,
    prefix: c.prefix,
    accessKeyId: c.accessKeyId,
    secretAccessKey: secret,
    localWindowHours: c.localWindowHours,
    forcePathStyle: c.forcePathStyle,
    updatedAt: c.updatedAt,
  };
}

module.exports = {
  STORAGE_MODES,
  DEFAULT_CONFIG,
  normalizeCloudStorage,
  validateCloudStorage,
  describeCloudStorage,
  buildInstallationPayload,
  encryptSecret,
  decryptSecret,
};
