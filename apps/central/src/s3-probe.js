'use strict';

const { createHash, createHmac, randomBytes } = require('node:crypto');

// ── Teste de acesso a bucket S3, a partir da Central ────────────────────────
//
// Por que existe separado do cliente da API: a Central é um serviço próprio, em
// JS puro, com package.json e deploy independentes — importar o cliente
// TypeScript de `apps/api` exigiria dependência de workspace e passo de build
// só para três chamadas. A duplicação é DELIBERADA e limitada: aqui há apenas o
// suficiente para responder "esta credencial funciona neste bucket?".
//
// A implementação de referência, com testes de assinatura e e2e contra servidor
// real, é `apps/api/src/cloud-storage/s3-client.ts`. Mudou o cálculo de
// assinatura lá? Precisa mudar aqui.
//
// A credencial não aparece em URL, log nem mensagem de erro.

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

function encodePath(path) {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

function joinKey(prefix, key) {
  const clean = (v) => String(v || '').replace(/^\/+|\/+$/g, '');
  const p = clean(prefix);
  const k = clean(key);
  return p ? `${p}/${k}` : k;
}

function sign(config, { method, key, query = {}, payload = Buffer.alloc(0), extraHeaders = {} }) {
  const endpoint = String(config.endpoint).replace(/\/+$/, '');
  const url = new URL(endpoint);
  const payloadHash = payload.length ? sha256Hex(payload) : EMPTY_SHA256;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const pathStyle = config.forcePathStyle !== false;
  const bucketPart = pathStyle ? `/${config.bucket}` : '';
  const keyPart = key ? `/${encodePath(key)}` : '';
  const canonicalUri = `${bucketPart}${keyPart}` || '/';

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');

  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names
    .map((n) => {
      const orig = Object.keys(headers).find((h) => h.toLowerCase() === n);
      return `${n}:${String(headers[orig]).trim()}\n`;
    })
    .join('');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  let k = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  k = hmac(k, config.region);
  k = hmac(k, 's3');
  k = hmac(k, 'aws4_request');
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex');

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const suffix = canonicalQuery ? `?${canonicalQuery}` : '';
  const finalUrl = pathStyle
    ? `${endpoint}${canonicalUri}${suffix}`
    : `${url.protocol}//${config.bucket}.${url.host}${keyPart || '/'}${suffix}`;

  return { url: finalUrl, headers };
}

function errorCode(body) {
  const m = /<Code>([^<]+)<\/Code>/i.exec(body || '');
  return m ? m[1] : 'Unknown';
}

/** Traduz a falha para algo que o operador consiga agir. */
function explain(status, code) {
  if (code === 'SignatureDoesNotMatch' || status === 403) return 'Credencial inválida (chave ou segredo incorretos).';
  if (code === 'NoSuchBucket' || status === 404) return 'Bucket não encontrado neste endpoint.';
  if (code === 'AccessDenied') return 'Credencial sem permissão neste bucket.';
  if (code === 'NetworkError') return 'Endpoint inalcançável a partir da Central.';
  return `Storage respondeu ${status} (${code}).`;
}

async function call(config, params, timeoutMs) {
  const { url, headers } = sign(config, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: params.method,
      headers,
      body: params.payload && params.payload.length ? params.payload : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, code: res.ok ? null : errorCode(text) };
  } catch (error) {
    // Timeout/DNS/conexão recusada: não vaza credencial, só a natureza da falha.
    return { ok: false, status: 0, code: 'NetworkError' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifica LEITURA e ESCRITA.
 *
 * Só listar não basta: uma credencial somente-leitura passaria no teste e
 * falharia na primeira gravação — exatamente o cenário em que o cliente perde
 * vídeo achando que configurou certo. Por isso o probe também grava e apaga um
 * objeto descartável.
 */
async function testS3Access(config, { timeoutMs = 10000 } = {}) {
  const list = await call(config, { method: 'GET', query: { 'list-type': '2', 'max-keys': '1', prefix: joinKey(config.prefix, '') } }, timeoutMs);
  if (!list.ok) {
    return { ok: false, canWrite: false, error: explain(list.status, list.code) };
  }

  const probeKey = joinKey(config.prefix, `.drac-central-check-${Date.now()}`);
  const payload = Buffer.from('drac');
  const put = await call(
    config,
    { method: 'PUT', key: probeKey, payload, extraHeaders: { 'content-type': 'text/plain', 'content-length': String(payload.length) } },
    timeoutMs,
  );
  if (!put.ok) {
    return { ok: false, canWrite: false, error: `Leitura OK, mas ESCRITA falhou: ${explain(put.status, put.code)}` };
  }

  // Limpeza é best-effort: o teste já provou o que precisava.
  await call(config, { method: 'DELETE', key: probeKey }, timeoutMs);
  return { ok: true, canWrite: true, error: null };
}

/** Mediana — a média esconderia justamente a trava intermitente. */
function mediana(valores) {
  if (!valores.length) return 0;
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

/** Percentil por interpolação linear, para não dar degraus com poucas amostras. */
function percentil(valores, p) {
  if (!valores.length) return 0;
  if (valores.length === 1) return valores[0];
  const o = [...valores].sort((a, b) => a - b);
  const pos = (o.length - 1) * p;
  const baixo = Math.floor(pos);
  const alto = Math.ceil(pos);
  return baixo === alto ? o[baixo] : o[baixo] + (o[alto] - o[baixo]) * (pos - baixo);
}

/**
 * DESEMPENHO do bucket, medido a partir da CENTRAL.
 *
 * ATENÇÃO ao que este número significa. Ele mede o link da CENTRAL até o
 * bucket, não o da instalação — que é por onde o vídeo realmente sobe. Serve
 * para avaliar o FORNECEDOR (o bucket está saudável? o provedor está lento
 * hoje?) e para comparar candidatos antes de contratar. Não serve para
 * dimensionar quantas câmeras a instalação aguenta; para isso existe o botão
 * Desempenho na tela de Armazenamento da própria instalação.
 *
 * Conteúdo ALEATÓRIO e nunca zeros: proxy ou storage que comprime mediria a
 * compressão, não a rede, e devolveria uma banda que vídeo nenhum alcança.
 *
 * Limpa o que criou mesmo quando falha no meio — o teste não pode deixar lixo
 * pago no bucket do cliente.
 */
async function measureS3Performance(config, { timeoutMs = 60000, sizeMb = 4, latencySamples = 7 } = {}) {
  const mb = Math.min(16, Math.max(1, Number(sizeMb) || 4));
  const carga = randomBytes(mb * 1024 * 1024);
  const chave = joinKey(config.prefix, `.drac-central-perf-${Date.now()}`);
  const criadas = [];
  let falhas = 0;

  try {
    const t0 = Date.now();
    const put = await call(
      config,
      { method: 'PUT', key: chave, payload: carga, extraHeaders: { 'content-type': 'application/octet-stream', 'content-length': String(carga.length) } },
      timeoutMs,
    );
    const msSubida = Date.now() - t0;
    if (!put.ok) return { ok: false, error: `Escrita falhou: ${explain(put.status, put.code)}` };
    criadas.push(chave);

    const t1 = Date.now();
    const get = await call(config, { method: 'GET', key: chave }, timeoutMs);
    const msDescida = Date.now() - t1;
    if (!get.ok) return { ok: false, error: `Leitura falhou: ${explain(get.status, get.code)}` };

    const amostras = [];
    for (let i = 0; i < latencySamples; i += 1) {
      const inicio = Date.now();
      const head = await call(config, { method: 'HEAD', key: chave }, timeoutMs);
      if (head.ok) amostras.push(Date.now() - inicio);
      else falhas += 1;
    }

    const medianaMs = Math.round(mediana(amostras));
    const p95Ms = Math.round(percentil(amostras, 0.95));
    // Mb/s (megaBITS), a unidade em que banda é contratada. Devolver MB/s faria
    // o operador comparar com o "100 mega" do provedor e errar por 8x.
    const mbps = (bytes, ms) => (ms > 0 ? Number(((bytes * 8) / (ms / 1000) / 1e6).toFixed(2)) : 0);

    return {
      ok: true,
      error: null,
      amostraMb: mb,
      latencia: {
        medianaMs,
        p95Ms,
        minMs: amostras.length ? Math.min(...amostras) : 0,
        maxMs: amostras.length ? Math.max(...amostras) : 0,
        amostras: amostras.length,
      },
      subida: { mbps: mbps(carga.length, msSubida), segundos: Number((msSubida / 1000).toFixed(2)) },
      descida: { mbps: mbps(carga.length, msDescida), segundos: Number((msDescida / 1000).toFixed(2)) },
      falhas,
      medidoEm: new Date().toISOString(),
    };
  } finally {
    for (const k of criadas) {
      await call(config, { method: 'DELETE', key: k }, timeoutMs).catch(() => undefined);
    }
  }
}

module.exports = { testS3Access, measureS3Performance, __sign: sign, __joinKey: joinKey, __explain: explain };
