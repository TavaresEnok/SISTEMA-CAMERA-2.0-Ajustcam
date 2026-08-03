'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ADMIN_TOKEN, startCentral } = require('./helpers/central-server');

// EXCLUIR o armazenamento em nuvem, no servidor REAL.
//
// Excluir NÃO é desabilitar, e a instalação precisa distinguir os dois porque
// as reações são OPOSTAS:
//
//   disabled — pausa. Nada sobe e nenhum outro storage assume, senão desligar
//              não desligaria nada.
//   absent   — o destino acabou. A instalação segue com outro storage que ainda
//              tenha, ou volta a gravar só no disco local.
//
// Até aqui os dois desciam como `cloudStorage: null` e eram indistinguíveis.
//
// Nenhum dos dois apaga gravação: o vínculo gravação↔storage vive na
// instalação, e continua resolvendo a leitura pelo storage de origem.

const CHAVE_CENTRAL = { CENTRAL_STORAGE_SECRET: 'x'.repeat(48) };
const admin = (extra = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', ...extra });

const CONFIG = {
  enabled: true,
  name: 'Eveo 1T',
  endpoint: 'http://192.0.2.10:9000',
  bucket: 'acervo-1t',
  accessKeyId: 'AKIAEXEMPLO',
  secretAccessKey: 'segredo-do-cliente',
};

async function preparar(central, id = 'cli-del', cloudStorage = CONFIG) {
  const provision = await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST', headers: admin(),
    body: JSON.stringify({ customerName: 'Cliente', installationId: id }),
  });
  assert.equal(provision.status, 201);
  // A licença NÃO volta no corpo de propósito (é segredo); vem do arquivo de
  // dados do servidor de teste.
  const raw = await fsp.readFile(path.join(central.dir, 'installations.json'), 'utf8');
  const licenseKey = JSON.parse(raw).installations[id].licenseKey;
  if (cloudStorage) {
    const patch = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, {
      method: 'PATCH', headers: admin(), body: JSON.stringify({ cloudStorage }),
    });
    assert.equal(patch.status, 200, await patch.text());
  }
  return { id, licenseKey };
}

/** O que a instalação recebe — é o que decide o comportamento dela. */
async function heartbeat(central, id, licenseKey) {
  const res = await fetch(`${central.base}/api/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-drac-installation-id': id,
      'x-drac-license-key': licenseKey,
    },
    body: JSON.stringify({ summary: {} }),
  });
  // Ler o corpo UMA vez: `await res.text()` na mensagem do assert consumiria o
  // stream e o `.json()` seguinte falharia mesmo com a requisição correta.
  const corpo = await res.text();
  assert.equal(res.status, 200, corpo);
  return JSON.parse(corpo);
}

async function registro(central, id) {
  const raw = await fsp.readFile(path.join(central.dir, 'installations.json'), 'utf8');
  return JSON.parse(raw).installations[id];
}

test('excluir apaga o cadastro e a instalação recebe "absent"', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const { id, licenseKey } = await preparar(central);

  const antes = await heartbeat(central, id, licenseKey);
  assert.equal(antes.cloudStorageState, 'configured');
  assert.equal(antes.cloudStorage.bucket, 'acervo-1t');

  const del = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, {
    method: 'DELETE', headers: admin(),
  });
  assert.equal(del.status, 200, await del.text());

  const depois = await heartbeat(central, id, licenseKey);
  assert.equal(depois.cloudStorage, null);
  assert.equal(depois.cloudStorageState, 'absent',
    'é o que autoriza a instalação a seguir com outro storage ou cair no disco local');
});

test('DESABILITAR desce "disabled", não "absent" — pausa não é exclusão', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const { id, licenseKey } = await preparar(central);

  const patch = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, {
    method: 'PATCH', headers: admin(),
    body: JSON.stringify({ cloudStorage: { ...CONFIG, enabled: false, secretAccessKey: '' } }),
  });
  assert.equal(patch.status, 200, await patch.text());

  const hb = await heartbeat(central, id, licenseKey);
  assert.equal(hb.cloudStorage, null, 'desabilitado não desce credencial');
  assert.equal(hb.cloudStorageState, 'disabled',
    'se descesse "absent", desligar o envio faria outro storage assumir — o oposto de desligar');
});

test('excluir bumpa a revisão de configuração', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const { id } = await preparar(central);

  const antes = (await registro(central, id)).configRevision || 0;
  await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, { method: 'DELETE', headers: admin() });
  const depois = (await registro(central, id)).configRevision || 0;
  assert.ok(depois > antes, 'sem bump a instalação não sabe que precisa reagir');
});

test('excluir vira evento de auditoria e NÃO guarda a credencial no log', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const { id } = await preparar(central);

  await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, { method: 'DELETE', headers: admin() });

  const raw = await fsp.readFile(path.join(central.dir, 'installations.json'), 'utf8');
  const eventos = (JSON.parse(raw).auditEvents || []).filter((e) => e.type === 'installation.cloud_storage_deleted');
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].installationId, id);
  assert.ok(eventos[0].actor);
  assert.ok(!raw.includes('segredo-do-cliente') || !JSON.stringify(eventos[0]).includes('segredo-do-cliente'));
});

test('excluir duas vezes: a segunda diz que não há nada, em vez de fingir sucesso', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const { id } = await preparar(central);

  const um = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, { method: 'DELETE', headers: admin() });
  assert.equal(um.status, 200);
  const dois = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, { method: 'DELETE', headers: admin() });
  assert.equal(dois.status, 404);
  assert.equal((await dois.json()).error, 'storage_not_set');
});

test('instalação que NUNCA teve storage já nasce "absent"', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const { id, licenseKey } = await preparar(central, 'cli-sem', null);

  const hb = await heartbeat(central, id, licenseKey);
  assert.equal(hb.cloudStorage, null);
  assert.equal(hb.cloudStorageState, 'absent');
});

test('sem sessão não se exclui storage de ninguém', async (t) => {
  const central = await startCentral(CHAVE_CENTRAL);
  t.after(() => central.stop());
  const { id, licenseKey } = await preparar(central);

  const res = await fetch(`${central.base}/api/admin/installations/${id}/cloud-storage`, { method: 'DELETE' });
  assert.equal(res.status, 401);

  const hb = await heartbeat(central, id, licenseKey);
  assert.equal(hb.cloudStorageState, 'configured', 'e o storage continua lá');
});
