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

// ── TAMANHO ESCOLHIDO À MÃO VALE NOS DOIS SENTIDOS ──────────────────────────
//
// Reclamação do operador, com razão: "se eu escolher 64MB deveria ser 64MB de
// subida e 64 de descida". A sonda adaptativa da descida (256 KB crescendo até
// a transferência durar ~2,5s) existe para o modo Automático não demorar
// minutos num link lento — mas ela estava se aplicando TAMBÉM quando alguém
// escolhia o tamanho, e o painel mostrava "descida medida com 1,5 MB" depois de
// pedirem 64. Isso não é adaptar: é ignorar a ordem.

test('escolha explícita baixa o objeto INTEIRO, sem fatiar', async (t) => {
  const MB = 4;
  const gets = [];
  const srv = await servidorFalso((req, res) => {
    if (req.method === 'GET') {
      // A varredura de limpeza também usa GET (list-type=2). Ela não é uma
      // fatia de download e não pode contar como tal.
      if (!/list-type/.test(req.url)) gets.push(req.headers.range || '(sem range)');
      res.writeHead(200);
      res.end(Buffer.alloc(MB * 1024 * 1024));
      return;
    }
    res.writeHead(200); res.end('');
  });
  t.after(() => srv.stop());

  const r = await measureS3Performance(config(srv.endpoint), { sizeMb: MB, latencySamples: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.amostraDescidaMb, MB, `pediram ${MB} MB e a descida mediu ${r.amostraDescidaMb} MB`);
  // Um único GET pedindo o arquivo todo — não uma sonda seguida de refino.
  assert.equal(gets.length, 1, `esperado 1 GET, houve ${gets.length}: ${gets.join(' | ')}`);
  assert.equal(gets[0], `bytes=0-${MB * 1024 * 1024 - 1}`, 'o range tem de cobrir o objeto inteiro');
});

test('modo Automático CONTINUA sondando — senão link lento volta a demorar minutos', async (t) => {
  const MB = 8;
  const gets = [];
  const srv = await servidorFalso((req, res) => {
    if (req.method === 'GET') {
      if (/list-type/.test(req.url)) { res.writeHead(200); res.end(''); return; }
      gets.push(req.headers.range || '');
      // Devolve só o que foi pedido, como um gateway de verdade faz com Range.
      const m = /bytes=0-(\d+)/.exec(req.headers.range || '');
      const n = m ? Number(m[1]) + 1 : MB * 1024 * 1024;
      res.writeHead(206);
      res.end(Buffer.alloc(n));
      return;
    }
    res.writeHead(200); res.end('');
  });
  t.after(() => srv.stop());

  const r = await measureS3Performance(config(srv.endpoint), { latencySamples: 1 });
  assert.equal(r.ok, true);
  // Sem tamanho pedido, a primeira leitura é a sonda pequena — não o objeto todo.
  assert.match(gets[0], /^bytes=0-(\d+)$/);
  const primeiro = Number(/bytes=0-(\d+)/.exec(gets[0])[1]) + 1;
  assert.ok(primeiro <= 256 * 1024, `a sonda deveria ser pequena, veio com ${primeiro} bytes`);
});

test('a conta usa os bytes que CHEGARAM, não os que foram pedidos', async (t) => {
  // Gateway que ignora Range e manda o objeto inteiro: se a conta usasse o
  // tamanho pedido, o painel anunciaria uma banda que não existe.
  const MB = 2;
  const srv = await servidorFalso((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); res.end(Buffer.alloc(MB * 1024 * 1024)); return; }
    res.writeHead(200); res.end('');
  });
  t.after(() => srv.stop());

  const r = await measureS3Performance(config(srv.endpoint), { sizeMb: MB, latencySamples: 1 });
  assert.equal(r.amostraDescidaMb, MB);
});
