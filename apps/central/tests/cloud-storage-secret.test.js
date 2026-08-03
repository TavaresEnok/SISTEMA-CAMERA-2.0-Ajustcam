'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ADMIN_TOKEN, startCentral } = require('./helpers/central-server');

// Exibir a Secret Access Key guardada, no servidor REAL e com arquivo de dados
// temporário.
//
// A credencial é do CLIENTE: um dia ele precisa conferir com o fornecedor,
// reconfigurar em outro lugar ou responder a uma auditoria. Esconder para
// sempre não protegia ninguém — quem tem sessão de administrador na Central já
// pode SUBSTITUIR o segredo pelo formulário; negar a leitura só obrigava a
// reemitir a chave no fornecedor para descobrir o que já estava guardado.
//
// O que estes testes travam:
//   · a listagem geral continua SEM segredo (a exibição é sob demanda);
//   · sem sessão não se lê nada;
//   · cada exibição vira evento de auditoria;
//   · o valor devolvido é exatamente o que foi salvo — inclusive depois de um
//     save que deixou o campo em branco (o "manter a atual").

const SEGREDO = 'ChaveSuperSecreta-1234567890';
const CHAVE_CENTRAL = { CENTRAL_STORAGE_SECRET: 'x'.repeat(48) };
const admin = (extra = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', ...extra });

async function preparar(central, id = 'cli-storage') {
  const provision = await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({ customerName: 'Cliente Storage', installationId: id }),
  });
  assert.equal(provision.status, 201);
  const patch = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, {
    method: 'PATCH',
    headers: admin(),
    body: JSON.stringify({
      cloudStorage: {
        enabled: true,
        name: 'MinIO do cliente',
        endpoint: 'http://192.0.2.10:9000',
        bucket: 'gravacoes',
        accessKeyId: 'AKIAEXEMPLO',
        secretAccessKey: SEGREDO,
      },
    }),
  });
  assert.equal(patch.status, 200, await patch.text());
  return id;
}

async function auditoria(central) {
  const raw = await fsp.readFile(path.join(central.dir, 'installations.json'), 'utf8');
  return JSON.parse(raw).auditEvents || [];
}

test('mostra a Secret Access Key exatamente como foi salva', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const id = await preparar(central);

  const res = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage/secret`, { headers: admin() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.secretAccessKey, SEGREDO, 'o segredo volta em claro para quem opera a Central');
  assert.equal(body.accessKeyId, 'AKIAEXEMPLO', 'o par vem junto — de nada adianta o segredo sem a chave');
});

test('a listagem de instalações continua sem o segredo', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const id = await preparar(central);

  const res = await fetch(`${central.base}/api/admin/installations`, { headers: admin() });
  assert.equal(res.status, 200);
  const texto = JSON.stringify(await res.json());
  assert.ok(!texto.includes(SEGREDO), 'o segredo NÃO pode viajar no payload que a tela carrega sozinha');
  const item = JSON.parse(texto).items.find((i) => i.id === id);
  assert.equal(item.cloudStorage.hasSecret, true, 'a tela sabe que existe segredo sem receber o segredo');
  assert.equal(item.cloudStorage.secretAccessKeyEncrypted, undefined, 'nem o texto cifrado desce para o navegador');
});

test('sem sessão não se lê a credencial', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const id = await preparar(central);

  const res = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage/secret`);
  assert.equal(res.status, 401);
  const texto = await res.text();
  assert.ok(!texto.includes(SEGREDO));
});

test('cada exibição fica registrada na auditoria', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const id = await preparar(central);

  const antes = (await auditoria(central)).filter((e) => e.type === 'installation.cloud_storage_secret_revealed').length;
  await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage/secret`, { headers: admin() });
  await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage/secret`, { headers: admin() });

  const eventos = (await auditoria(central)).filter((e) => e.type === 'installation.cloud_storage_secret_revealed');
  assert.equal(eventos.length - antes, 2, 'ver duas vezes registra duas vezes — é o rastro que substitui o segredo escondido');
  const ultimo = eventos[eventos.length - 1];
  assert.equal(ultimo.installationId, id);
  assert.ok(ultimo.actor, 'o evento diz QUEM viu');
  assert.ok(!JSON.stringify(ultimo).includes(SEGREDO), 'o próprio log de auditoria não pode guardar a credencial');
});

test('salvar com o campo em branco mantém a credencial, e a exibição prova', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const id = await preparar(central);

  const patch = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, {
    method: 'PATCH',
    headers: admin(),
    body: JSON.stringify({ cloudStorage: { enabled: true, name: 'Nome trocado', endpoint: 'http://192.0.2.10:9000', bucket: 'gravacoes', accessKeyId: 'AKIAEXEMPLO', secretAccessKey: '' } }),
  });
  assert.equal(patch.status, 200, await patch.text());

  const res = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage/secret`, { headers: admin() });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).secretAccessKey, SEGREDO);
});

test('instalação sem storage cadastrado responde 404, não vazio', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const provision = await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({ customerName: 'Sem storage', installationId: 'cli-vazio' }),
  });
  assert.equal(provision.status, 201);

  const res = await fetch(`${central.base}/api/admin/installations/cli-vazio/cloud-storage/secret`, { headers: admin() });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'secret_not_set', 'distinguir "não cadastrado" de "ilegível" é o que evita o operador achar que perdeu a chave');
});

test('instalação inexistente não vira 200 vazio', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const res = await fetch(`${central.base}/api/admin/installations/nao-existe/cloud-storage/secret`, { headers: admin() });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'installation_not_found');
});
