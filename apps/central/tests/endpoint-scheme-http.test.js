'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ADMIN_TOKEN, startCentral } = require('./helpers/central-server');

const admin = () => ({ authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' });

// Ponta a ponta no servidor REAL: salvar sem esquema e ver o que ficou gravado.
test('salvar endpoint SEM http:// grava o esquema descoberto', async (t) => {
  const alvo = http.createServer((_q, r) => { r.writeHead(403); r.end(''); });
  await new Promise((r) => alvo.listen(0, '127.0.0.1', r));
  const porta = alvo.address().port;
  t.after(() => new Promise((r) => alvo.close(r)));

  const central = await startCentral({ CENTRAL_STORAGE_SECRET: 'x'.repeat(48) });
  t.after(() => central.stop());

  await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST', headers: admin(), body: JSON.stringify({ customerName: 'C', installationId: 'cli-ep' }),
  });
  const res = await fetch(`${central.base}/api/admin/installations/cli-ep/cloud-storage`, {
    method: 'PATCH', headers: admin(),
    body: JSON.stringify({ cloudStorage: {
      enabled: true, name: 'S', endpoint: `127.0.0.1:${porta}`, bucket: 'b',
      accessKeyId: 'AK', secretAccessKey: 'seg',
    } }),
  });
  const corpo = await res.text();
  assert.equal(res.status, 200, corpo);
  assert.equal(JSON.parse(corpo).cloudStorage.endpoint, `http://127.0.0.1:${porta}`,
    'o 403 do servidor prova que há HTTP ali — é isso que decide, não a heurística');
});
