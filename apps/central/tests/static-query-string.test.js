'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { startCentral } = require('./helpers/central-server');

// Arquivo estático com QUERY STRING.
//
// `serveStatic` montava o nome do arquivo a partir de `req.url` cru, com a
// query junto: `/?v=1` virava o arquivo "?v=1" e devolvia 404. Qualquer URL com
// parâmetro quebrava — inclusive `?v=`, que é a forma padrão de furar cache de
// página. Ou seja, a saída de emergência para um navegador preso na versão
// antiga era exatamente a que não funcionava.
//
// `PUBLIC_DIR` sai de `process.cwd()`, e o helper sobe o servidor num diretório
// temporário: os arquivos são criados LÁ, senão o teste passaria por 404 de
// tudo e não mediria nada.

const CONTEUDO = '<!doctype html><title>central de teste</title>';

async function comPublic(t) {
  const central = await startCentral();
  t.after(() => central.stop());
  await fsp.mkdir(path.join(central.dir, 'public'), { recursive: true });
  await fsp.writeFile(path.join(central.dir, 'public', 'index.html'), CONTEUDO);
  return central;
}

test('a raiz com query string serve a página, não 404', async (t) => {
  const central = await comPublic(t);

  const semQuery = await fetch(`${central.base}/`);
  assert.equal(semQuery.status, 200);
  assert.equal(await semQuery.text(), CONTEUDO);

  const comQuery = await fetch(`${central.base}/?v=123`);
  assert.equal(comQuery.status, 200, 'é a saída de emergência quando a aba está presa na versão antiga');
  assert.equal(await comQuery.text(), CONTEUDO, 'o parâmetro não muda o conteúdo — só força o navegador a buscar de novo');
});

test('arquivo nomeado com query string também serve', async (t) => {
  const central = await comPublic(t);
  const res = await fetch(`${central.base}/index.html?nocache=1`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), CONTEUDO);
});

test('a travessia de diretório continua barrada, com ou sem query', async (t) => {
  const central = await comPublic(t);
  // O arquivo-isca fica FORA de public/: se algum caminho o servir, a mudança
  // abriu buraco. Sem a isca, o teste passaria por 404 de arquivo inexistente.
  await fsp.writeFile(path.join(central.dir, 'segredo.txt'), 'nao-pode-vazar');

  for (const alvo of ['/../segredo.txt', '/../segredo.txt?v=1', '/..%2fsegredo.txt', '/%2e%2e/segredo.txt']) {
    const res = await fetch(`${central.base}${alvo}`);
    const corpo = await res.text();
    assert.ok(!corpo.includes('nao-pode-vazar'), `${alvo} serviu arquivo de fora de public/`);
  }
});
