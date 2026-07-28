'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { freePort, startCentral } = require('./helpers/central-server');

async function startServer(handler) {
  const port = await freePort();
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('build-agent blackhole tem deadline e não bloqueia o health da Central', async (t) => {
  const blackhole = await startServer(() => {
    // Deliberadamente não envia headers nem resposta.
  });
  const central = await startCentral({
    APP_BUILDER_AGENT_URL: blackhole.url,
    APP_BUILDER_AGENT_TIMEOUT_MS: '1000',
  });
  t.after(async () => {
    await central.stop();
    await blackhole.stop();
  });

  const pending = fetch(`${central.base}/api/admin/apk/clients`, {
    headers: central.adminHeaders(),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const healthStarted = Date.now();
  const health = await fetch(`${central.base}/api/health`);
  assert.equal(health.status, 200);
  assert.ok(Date.now() - healthStarted < 500, 'health não deve entrar na fila do datastore');

  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, 'internal_error');
});

test('resposta excessiva do build-agent é interrompida com erro seguro', async (t) => {
  const oversized = await startServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(128 * 1024),
    });
    res.end('{}');
  });
  const central = await startCentral({
    APP_BUILDER_AGENT_URL: oversized.url,
    APP_BUILDER_AGENT_MAX_RESPONSE_BYTES: String(64 * 1024),
  });
  t.after(async () => {
    await central.stop();
    await oversized.stop();
  });

  const response = await fetch(`${central.base}/api/admin/apk/clients`, {
    headers: central.adminHeaders(),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'internal_error');
  assert.doesNotMatch(body.message || '', /128|body|token/i);
});
