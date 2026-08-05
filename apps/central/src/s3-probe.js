'use strict';

const { createHash, createHmac, randomBytes } = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const tls = require('node:tls');

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
    // O corpo é lido como BYTES, não como texto.
    //
    // `res.text()` decodifica tudo como UTF-8, e o teste de desempenho baixa
    // uma amostra de megabytes de bytes ALEATÓRIOS: quase nenhuma sequência é
    // UTF-8 válida, então o decodificador troca byte a byte por U+FFFD e
    // constrói um texto gigante — que é descartado na linha seguinte. Esse
    // trabalho entrava na conta da "descida" e fazia o teste medir o
    // decodificador em vez do link.
    //
    // O corpo continua sendo consumido até o fim (é o que mede a transferência
    // de verdade). Só o de ERRO vira texto, e erro de S3 é um XML de linhas.
    const bytes = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, bytes: bytes.length,
      code: res.ok ? null : errorCode(bytes.toString('utf-8')),
      conexao: String(res.headers.get('connection') || '').toLowerCase() };
  } catch (error) {
    // Timeout/DNS/conexão recusada: não vaza credencial, só a natureza da falha.
    return { ok: false, status: 0, code: 'NetworkError', conexao: '' };
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
const PREFIXO_PERF = '.drac-central-perf-';
// Teto de 256 MB. A amostra é gerada inteira em memória (o SigV4 assina o corpo
// completo), então o teto é sobre a RAM do processo, não sobre a paciência: a
// 1 Gb/s isso já dura 2s, que é folgado para o TCP acelerar.
const TETO_MB = 256;
// Alvo de duração. Abaixo disso a transferência não sai do slow-start e o que
// se cronometra é a conexão, não a banda.
const DURACAO_ALVO_MS = 2500;

async function measureS3Performance(config, { timeoutMs = 300000, sizeMb = null, latencySamples = 7 } = {}) {
  const explicito = Number(sizeMb) > 0;
  let mb = Math.min(TETO_MB, Math.max(1, Number(sizeMb) || 8));
  const criadas = [];
  const notas = [];
  let falhas = 0;

  const subir = async (bytes) => {
    const k = joinKey(config.prefix, `${PREFIXO_PERF}${Date.now()}-${randomBytes(3).toString('hex')}`);
    const t = Date.now();
    const r = await call(
      config,
      { method: 'PUT', key: k, payload: bytes, extraHeaders: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } },
      timeoutMs,
    );
    if (r.ok) criadas.push(k);
    return { r, ms: Date.now() - t, chave: k };
  };

  try {
    let carga = randomBytes(mb * 1024 * 1024);
    let { r: put, ms: msSubida, chave } = await subir(carga);
    if (!put.ok) return { ok: false, error: `Escrita falhou: ${explain(put.status, put.code)}` };

    // AJUSTE À VELOCIDADE DO LINK. Amostra fixa mede bem um link lento e mente
    // num rápido: se a transferência acaba antes de o TCP acelerar, cronometrou-se
    // a conexão, não a banda. Refaz UMA vez, no máximo — escalar em laço gastaria
    // banda e requisição cobrada a cada rodada.
    if (!explicito && msSubida < DURACAO_ALVO_MS && mb < TETO_MB) {
      const alvo = Math.min(TETO_MB, Math.ceil(mb * (DURACAO_ALVO_MS / Math.max(1, msSubida))));
      if (alvo > mb) {
        notas.push(`A primeira amostra de ${mb} MB subiu em ${(msSubida / 1000).toFixed(2)}s — rápido demais para ser confiável. Repetido com ${alvo} MB.`);
        carga = randomBytes(alvo * 1024 * 1024);
        const nova = await subir(carga);
        if (nova.r.ok) { msSubida = nova.ms; chave = nova.chave; mb = alvo; }
      }
    }

    // ── DESCIDA: A AMOSTRA SE AJUSTA AO LINK ────────────────────────────────
    //
    // Baixar a amostra inteira parece o teste mais fiel — e é, num link rápido.
    // Num link lento vira um teste que não termina. Medido aqui: os mesmos 8 MB
    // que SOBEM em 3,4s DESCEM em 65s, porque este link tem 19 Mbps de subida e
    // 4,4 Mbps de descida. O teste inteiro passava de 70s e o nginx na frente
    // corta em 60 — ou seja, o operador via um erro de um teste que estava
    // funcionando.
    //
    // Então a descida começa por um pedaço pequeno e só cresce se houver tempo,
    // exatamente como a subida já fazia. Link rápido continua sendo medido com
    // amostra grande; link lento responde em segundos em vez de minutos.
    const totalBytes = carga.length;
    const baixarFatia = async (bytes) => {
      const t = Date.now();
      const r = await call(
        config,
        { method: 'GET', key: chave, extraHeaders: { range: `bytes=0-${bytes - 1}` } },
        timeoutMs,
      );
      // `r.bytes` é o que REALMENTE chegou: um gateway que ignore o Range
      // devolve o objeto todo, e a conta tem de usar o tamanho recebido, não o
      // pedido — senão o teste reporta uma banda que não existe.
      return { r, ms: Date.now() - t, bytes: r.bytes ?? bytes };
    };

    // 256 KB de sonda: é o pior caso que se aceita esperar às cegas. Num link
    // rápido ela volta em milissegundos e a segunda fatia faz a medida de
    // verdade; num link ruim, ela sozinha já não estoura o tempo do navegador.
    let descida = await baixarFatia(Math.min(totalBytes, 256 * 1024));
    if (!descida.r.ok) return { ok: false, error: `Leitura falhou: ${explain(descida.r.status, descida.r.code)}` };
    if (descida.ms < DURACAO_ALVO_MS && descida.bytes < totalBytes) {
      const alvo = Math.min(totalBytes, Math.ceil(descida.bytes * (DURACAO_ALVO_MS / Math.max(1, descida.ms))));
      if (alvo > descida.bytes) {
        const nova = await baixarFatia(alvo);
        if (nova.r.ok) descida = nova;
      }
    }
    const msDescida = descida.ms;
    const bytesDescida = descida.bytes;
    if (bytesDescida < totalBytes) {
      notas.push(
        `Descida medida com ${(bytesDescida / 1024 / 1024).toFixed(1)} MB dos ${mb} MB enviados: neste link a amostra inteira levaria ${Math.round((totalBytes / Math.max(1, bytesDescida)) * (msDescida / 1000))}s.`,
      );
    }

    const amostras = [];
    // Keep-alive medido nas requisições REAIS, assinadas. Um GET anônimo na raiz
    // é respondido de outro jeito pelo gateway e diz keep-alive quando as
    // operações de verdade recebem `close`.
    let fechaConexao = false;
    for (let i = 0; i < latencySamples; i += 1) {
      const inicio = Date.now();
      const head = await call(config, { method: 'HEAD', key: chave }, timeoutMs);
      if (head.conexao === 'close') fechaConexao = true;
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
      amostraDescidaMb: Number((bytesDescida / 1024 / 1024).toFixed(1)),
      subida: { mbps: mbps(carga.length, msSubida), segundos: Number((msSubida / 1000).toFixed(2)) },
      descida: { mbps: mbps(bytesDescida, msDescida), segundos: Number((msDescida / 1000).toFixed(2)) },
      falhas,
      fechaConexao,
      notas,
      medidoEm: new Date().toISOString(),
    };
  } finally {
    // LIMPEZA. O teste sobe centenas de MB no bucket do cliente; deixar isso lá
    // é cobrar por lixo. Apaga o que criou AGORA e também qualquer sobra de
    // execução anterior que tenha morrido no meio — sem a varredura, um timeout
    // ou um restart deixaria a amostra pesando no bucket para sempre, sem
    // ninguém suspeitar de onde veio.
    for (const k of criadas) {
      await call(config, { method: 'DELETE', key: k }, timeoutMs).catch(() => undefined);
    }
    await limparSobras(config, timeoutMs).catch(() => undefined);
  }
}

/**
 * Apaga objetos de teste esquecidos por execuções anteriores.
 *
 * Só toca em chaves sob o prefixo próprio da medição: é a garantia de que uma
 * varredura nunca alcança gravação. Percorre a paginação até o fim — parar nas
 * primeiras 1000 deixaria sobra e relataria limpeza completa.
 */
async function limparSobras(config, timeoutMs) {
  const base = joinKey(config.prefix, '');
  let token = null;
  let apagados = 0;
  do {
    const query = { 'list-type': '2', 'max-keys': '1000', prefix: joinKey(config.prefix, PREFIXO_PERF) };
    if (token) query['continuation-token'] = token;
    const { url, headers } = sign(config, { method: 'GET', query });
    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    const xml = await res.text();
    if (!res.ok) return apagados;
    const chaves = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
    for (const cheia of chaves) {
      const relativa = base && cheia.startsWith(base) ? cheia.slice(base.length) : cheia;
      const r = await call(config, { method: 'DELETE', key: cheia }, timeoutMs);
      if (r.ok) apagados += 1;
      void relativa;
    }
    const truncado = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    const prox = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] || null;
    token = truncado && prox ? prox : null;
  } while (token);
  return apagados;
}

/**
 * DE ONDE VEM A LATÊNCIA — separa rede de aperto de mão.
 *
 * Sem esta decomposição, "143 ms" parecia distância e assustava: o operador
 * olhava um servidor na mesma cidade e concluía que a rede estava ruim. Não
 * estava. Medido no Eveo: DNS 34 + TCP 34 + TLS 40 + requisição 35. A REDE são
 * os 34 ms do TCP; o resto é o custo de ABRIR a conexão.
 *
 * E esse custo se repete a cada objeto quando o servidor responde
 * `connection: close` — que é o caso do gateway Ceph do Eveo. Por isso o
 * keep-alive é medido e mostrado: com ele desligado, subir mil arquivos
 * pequenos paga mil apertos de mão, e isso decide se vale agrupar gravações.
 */
async function diagnosticarConexao(endpoint, { timeoutMs = 8000 } = {}) {
  let alvo;
  try {
    alvo = new URL(endpoint);
  } catch {
    return null;
  }
  const seguro = alvo.protocol === 'https:';
  const porta = Number(alvo.port) || (seguro ? 443 : 80);
  const resultado = { host: alvo.hostname, ip: null, dnsMs: null, tcpMs: null, tlsMs: null, keepAlive: null };

  const t0 = Date.now();
  try {
    const { address } = await dns.lookup(alvo.hostname);
    resultado.ip = address;
    resultado.dnsMs = Date.now() - t0;
  } catch {
    return resultado;
  }

  await new Promise((resolve) => {
    const inicio = Date.now();
    const soquete = seguro
      ? tls.connect({ host: resultado.ip, port: porta, servername: alvo.hostname, timeout: timeoutMs })
      : net.connect({ host: resultado.ip, port: porta, timeout: timeoutMs });
    let tcpEm = null;
    soquete.on('connect', () => { tcpEm = Date.now() - inicio; resultado.tcpMs = tcpEm; });
    const encerrar = () => { try { soquete.destroy(); } catch { /* já morto */ } resolve(); };
    if (seguro) {
      soquete.on('secureConnect', () => {
        // O evento `connect` do tls não dispara antes do `secureConnect` em todas
        // as versões; quando não dispara, o TCP fica embutido no total.
        resultado.tlsMs = Date.now() - inicio - (tcpEm ?? 0);
        encerrar();
      });
    }
    soquete.on('ready', () => { if (!seguro) encerrar(); });
    soquete.on('error', encerrar);
    soquete.on('timeout', encerrar);
  });

  return resultado;
}

/**
 * Onde fica o servidor, pelo IP.
 *
 * Consulta um serviço público e falha em silêncio: é informação de contexto,
 * não pode derrubar a medição nem travar a tela se a Central estiver sem saída
 * para a internet. Só o IP sai daqui — nenhuma credencial.
 */
async function localizarServidor(ip, { timeoutMs = 5000 } = {}) {
  if (!ip) return null;
  try {
    const campos = 'status,country,regionName,city,isp,org,lat,lon';
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${campos}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const d = await res.json();
    if (d.status !== 'success') return null;
    return { pais: d.country, regiao: d.regionName, cidade: d.city, isp: d.isp || d.org || null, lat: d.lat, lon: d.lon };
  } catch {
    return null;
  }
}

module.exports = { testS3Access, measureS3Performance, diagnosticarConexao, localizarServidor, __sign: sign, __joinKey: joinKey, __explain: explain };
