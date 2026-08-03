'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { measureS3Performance } = require('../src/s3-probe');

// Medição de desempenho a partir da Central.
//
// O risco aqui não é falhar — é MENTIR de forma convincente. Estes testes
// travam as armadilhas, contra um servidor S3 falso e controlado:
//
//   · Mb/s confundido com MB/s (fator 8 contra a banda contratada);
//   · lixo pago deixado no bucket quando a medição falha no meio;
//   · falha de escrita/leitura virando número em vez de erro.

/** Servidor S3 mínimo: registra o que recebeu e responde o que mandarem. */
async function servidorFalso(responder) {
  const http = require('node:http');
  const recebidas = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const corpo = Buffer.concat(chunks);
      recebidas.push({ method: req.method, url: req.url, bytes: corpo.length });
      responder(req, res, corpo);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  return {
    recebidas,
    endpoint: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => srv.close(r)),
  };
}

const config = (endpoint) => ({
  endpoint, region: 'us-east-1', bucket: 'b', prefix: '',
  accessKeyId: 'AK', secretAccessKey: 'SK', forcePathStyle: true,
});

test('mede em MEGABITS por segundo, não megabytes', async (t) => {
  // 1 MB atrasado ~200ms: em Mb/s dá ~40; em MB/s daria ~5. O operador compara
  // com o "100 mega" do provedor, então a unidade errada erra por 8x.
  const srv = await servidorFalso((req, res) => {
    const responder = () => {
      if (req.method === 'GET') { res.writeHead(200); res.end(Buffer.alloc(1024 * 1024)); return; }
      res.writeHead(200); res.end('');
    };
    if (req.method === 'PUT' || req.method === 'GET') setTimeout(responder, 200);
    else responder();
  });
  t.after(() => srv.stop());

  const r = await measureS3Performance(config(srv.endpoint), { sizeMb: 1, latencySamples: 2 });
  assert.equal(r.ok, true);
  assert.ok(r.subida.mbps > 20 && r.subida.mbps < 80, `esperado ~40 Mb/s, veio ${r.subida.mbps}`);
});

test('APAGA o objeto de teste — o teste não deixa lixo pago no bucket', async (t) => {
  const srv = await servidorFalso((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); res.end(Buffer.alloc(1024)); return; }
    res.writeHead(200); res.end('');
  });
  t.after(() => srv.stop());

  await measureS3Performance(config(srv.endpoint), { sizeMb: 1, latencySamples: 1 });
  assert.ok(srv.recebidas.some((r) => r.method === 'DELETE'), 'sem DELETE o cliente paga pelo teste para sempre');
});

test('apaga MESMO quando a leitura falha no meio', async (t) => {
  const srv = await servidorFalso((req, res) => {
    if (req.method === 'GET') { res.writeHead(500); res.end('<Error><Code>InternalError</Code></Error>'); return; }
    res.writeHead(200); res.end('');
  });
  t.after(() => srv.stop());

  const r = await measureS3Performance(config(srv.endpoint), { sizeMb: 1, latencySamples: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Leitura falhou/);
  assert.ok(srv.recebidas.some((x) => x.method === 'DELETE'), 'a falha não pode pular a limpeza');
});

test('escrita recusada vira ERRO, não número', async (t) => {
  const srv = await servidorFalso((req, res) => {
    if (req.method === 'PUT') { res.writeHead(403); res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
    res.writeHead(200); res.end('');
  });
  t.after(() => srv.stop());

  const r = await measureS3Performance(config(srv.endpoint), { sizeMb: 1, latencySamples: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Escrita falhou/);
  assert.equal(r.subida, undefined, 'medição inválida não pode devolver banda nenhuma');
});

test('sem tamanho pedido, refaz a medição quando a primeira sobe rápido demais', async (t) => {
  // Servidor instantâneo = link absurdamente rápido: a primeira amostra não sai
  // do slow-start e o número seria ruído. Tem de haver uma segunda, maior.
  const srv = await servidorFalso((req, res) => {
    res.writeHead(200);
    res.end(req.method === 'GET' ? Buffer.alloc(16) : '');
  });
  t.after(() => srv.stop());

  const r = await measureS3Performance(config(srv.endpoint), { latencySamples: 1 });
  const grandes = srv.recebidas.filter((x) => x.method === 'PUT' && x.bytes >= 1024 * 1024);
  assert.equal(grandes.length, 2, 'exatamente duas: uma para descobrir, outra para medir');
  assert.ok(grandes[1].bytes > grandes[0].bytes);
  assert.ok(r.notas.some((n) => n.includes('rápido demais')), 'o operador precisa saber que a primeira foi descartada');
});

test('o tamanho ESCOLHIDO é limitado nos dois extremos, sem reajuste', async (t) => {
  const srv = await servidorFalso((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); res.end(Buffer.alloc(16)); return; }
    res.writeHead(200); res.end('');
  });
  t.after(() => srv.stop());

  const grande = await measureS3Performance(config(srv.endpoint), { sizeMb: 999, latencySamples: 1 });
  assert.equal(grande.amostraMb, 256, 'teto: a amostra é gerada inteira em memória');
  const maiorPut = Math.max(...srv.recebidas.filter((r) => r.method === 'PUT').map((r) => r.bytes));
  assert.equal(maiorPut, 256 * 1024 * 1024);
});

test('a carga enviada tem o tamanho pedido e NÃO é vazia', async (t) => {
  // Um corpo vazio (ou de zeros) seria comprimido por proxy e mediria a
  // compressão, não a rede — devolvendo banda que vídeo nenhum alcança. A
  // aleatoriedade vem de `randomBytes` na origem; o que dá para afirmar daqui é
  // que o byte count chega inteiro do outro lado.
  const srv = await servidorFalso((req, res) => {
    res.writeHead(200);
    res.end(req.method === 'GET' ? Buffer.alloc(16) : '');
  });
  t.after(() => srv.stop());

  await measureS3Performance(config(srv.endpoint), { sizeMb: 1, latencySamples: 1 });
  const put = srv.recebidas.find((r) => r.method === 'PUT');
  assert.equal(put.bytes, 1024 * 1024, 'subiu 1 MB de verdade, não um corpo simbólico');
});

test('varre e apaga sobras de execuções anteriores', async (t) => {
  // Um teste que morreu no meio (timeout, restart) deixa a amostra pesando no
  // bucket do cliente para sempre. A varredura é o que impede isso de virar
  // custo silencioso — e ela só toca no prefixo próprio da medição.
  const apagadas = [];
  const srv = await servidorFalso((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      res.writeHead(200);
      res.end('<ListBucketResult>'
        + '<Contents><Key>.drac-central-perf-antiga-1</Key></Contents>'
        + '<Contents><Key>.drac-central-perf-antiga-2</Key></Contents>'
        + '<IsTruncated>false</IsTruncated></ListBucketResult>');
      return;
    }
    if (req.method === 'DELETE') { apagadas.push(decodeURIComponent(url.pathname)); res.writeHead(204); res.end(''); return; }
    res.writeHead(200);
    res.end(req.method === 'GET' ? Buffer.alloc(16) : '');
  });
  t.after(() => srv.stop());

  await measureS3Performance(config(srv.endpoint), { sizeMb: 1, latencySamples: 1 });
  assert.ok(apagadas.some((k) => k.includes('antiga-1')), 'sobra anterior tem de sair');
  assert.ok(apagadas.some((k) => k.includes('antiga-2')));
  assert.ok(!apagadas.some((k) => k.includes('gravacoes/')), 'a varredura nunca sai do prefixo da medição');
});
