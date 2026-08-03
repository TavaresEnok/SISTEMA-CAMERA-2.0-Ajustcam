'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { ADMIN_TOKEN, startCentral } = require('./helpers/central-server');

// SALVAR JÁ TESTA A CREDENCIAL.
//
// O painel aceitava qualquer chave em silêncio; a única pista de que ela não
// funcionava era um selo vermelho discreto no cartão, visto horas depois. Caso
// real: a chave gravada tinha 22 caracteres e a do fornecedor tinha 40, e o
// operador passou o tempo procurando erro no endpoint.
//
// Testar no save transforma "salvou" em "salvou e funciona", que é a única
// coisa que ele queria saber. Falhar NÃO impede de salvar: storage que ainda
// vai subir precisa poder ser configurado antes.

const admin = () => ({ authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' });
const CHAVE = { CENTRAL_STORAGE_SECRET: 'x'.repeat(48) };

/** Bucket falso que só aceita uma Access Key específica. */
async function bucketFalso(chaveAceita) {
  const srv = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    if (!auth.includes(`Credential=${chaveAceita}/`)) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }
    res.writeHead(200);
    res.end('<ListBucketResult></ListBucketResult>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { porta: srv.address().port, stop: () => new Promise((r) => srv.close(r)) };
}

async function salvar(central, id, cloudStorage) {
  await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST', headers: admin(), body: JSON.stringify({ customerName: 'C', installationId: id }),
  });
  const res = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, {
    method: 'PATCH', headers: admin(), body: JSON.stringify({ cloudStorage }),
  });
  const corpo = await res.text();
  return { status: res.status, dados: JSON.parse(corpo) };
}

test('credencial BOA: o save já responde que a conexão funciona', async (t) => {
  const bucket = await bucketFalso('AK-BOA');
  t.after(() => bucket.stop());
  const central = await startCentral(CHAVE);
  t.after(() => central.stop());

  const { status, dados } = await salvar(central, 'cli-ok', {
    enabled: true, name: 'S', endpoint: `http://127.0.0.1:${bucket.porta}`,
    bucket: 'b', accessKeyId: 'AK-BOA', secretAccessKey: 'segredo',
  });
  assert.equal(status, 200);
  assert.equal(dados.teste.ok, true);
  assert.equal(dados.cloudStorage.lastTestOk, true, 'o cartão já nasce com o selo certo');
});

test('credencial RUIM: salva, mas diz na hora que falhou e por quê', async (t) => {
  const bucket = await bucketFalso('AK-BOA');
  t.after(() => bucket.stop());
  const central = await startCentral(CHAVE);
  t.after(() => central.stop());

  const { status, dados } = await salvar(central, 'cli-ruim', {
    enabled: true, name: 'S', endpoint: `http://127.0.0.1:${bucket.porta}`,
    bucket: 'b', accessKeyId: 'AK-ERRADA', secretAccessKey: 'segredo',
  });
  assert.equal(status, 200, 'salvar não é bloqueado — o storage pode ainda não estar no ar');
  assert.equal(dados.teste.ok, false);
  assert.match(dados.teste.error, /[Cc]redencial/, 'a mensagem aponta a credencial, não um erro genérico');
  assert.equal(dados.cloudStorage.lastTestOk, false);
});

test('endpoint inalcançável: falha explícita, sem travar o cadastro', async (t) => {
  const central = await startCentral(CHAVE);
  t.after(() => central.stop());

  // Porta fechada de propósito: é o caso do storage que ainda vai subir.
  const { status, dados } = await salvar(central, 'cli-fora', {
    enabled: true, name: 'S', endpoint: 'http://127.0.0.1:1',
    bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'segredo',
  });
  assert.equal(status, 200);
  assert.equal(dados.teste.ok, false);
  assert.equal(dados.cloudStorage.bucket, 'b', 'a configuração ficou salva mesmo assim');
});

test('storage DESABILITADO não é testado — não há resposta honesta a dar', async (t) => {
  const central = await startCentral(CHAVE);
  t.after(() => central.stop());
  const { dados } = await salvar(central, 'cli-off', {
    enabled: false, name: 'S', endpoint: 'http://127.0.0.1:1', bucket: 'b',
    accessKeyId: 'AK', secretAccessKey: 'segredo',
  });
  assert.equal(dados.teste, null, 'inventar "falhou" aqui assustaria sem motivo');
});

test('a resposta do save NAO carrega o segredo', async (t) => {
  const bucket = await bucketFalso('AK-BOA');
  t.after(() => bucket.stop());
  const central = await startCentral(CHAVE);
  t.after(() => central.stop());

  const { dados } = await salvar(central, 'cli-seg', {
    enabled: true, name: 'S', endpoint: `http://127.0.0.1:${bucket.porta}`,
    bucket: 'b', accessKeyId: 'AK-BOA', secretAccessKey: 'segredo-que-nao-pode-voltar',
  });
  assert.ok(!JSON.stringify(dados).includes('segredo-que-nao-pode-voltar'));
});
