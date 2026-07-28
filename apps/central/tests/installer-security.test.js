'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  buildInstallerExecutionCommand,
  configuredInstallerArtifact,
  issueInstallerGrant,
  isInstallerTokenActive,
} = require('../src/installer-security');
const {
  TEST_INSTALLER_COMMIT,
  freePort,
  startCentral,
} = require('./helpers/central-server');

const STUB_INSTALLER = `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n%s\\n%s\\n' \
  "\${DRAC_CUSTOMER_NAME:-}" \
  "\${DRAC_INSTALLATION_ID:-}" \
  "\${DRAC_LICENSE_KEY:-}" > "\${DRAC_TEST_MARKER:?}"
`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function startArtifactServer(handler) {
  const port = await freePort();
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runShell(command, env = {}, input = '') {
  const child = spawn('/bin/bash', ['-c', command], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(input);
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const result = await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

async function makeSandbox(prefix = 'drac-installer-test-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const tmp = path.join(root, 'tmp com espacos');
  await fs.mkdir(tmp);
  return {
    root,
    tmp,
    marker: path.join(root, 'executado.txt'),
    async tempEntries() {
      return fs.readdir(tmp);
    },
    async stop() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function localArtifact(url, content = STUB_INSTALLER) {
  return {
    id: TEST_INSTALLER_COMMIT,
    commit: TEST_INSTALLER_COMMIT,
    url,
    sha256: sha256(content),
    compatibility: 'exact-commit',
    boundAt: '2026-07-28T00:00:00.000Z',
  };
}

test('configuração exige commit completo, SHA-256 completo e URL vinculada ao commit', () => {
  const base = {
    DRAC_CENTRAL_INSTALLER_COMMIT: TEST_INSTALLER_COMMIT,
    DRAC_CENTRAL_INSTALLER_SHA256: sha256(STUB_INSTALLER),
    DRAC_CENTRAL_INSTALLER_URL_TEMPLATE:
      'https://example.invalid/drac/{commit}/scripts/install-drac.sh',
  };

  const artifact = configuredInstallerArtifact(base, new Date('2026-07-28T00:00:00.000Z'));
  assert.equal(artifact.id, TEST_INSTALLER_COMMIT);
  assert.equal(artifact.sha256, sha256(STUB_INSTALLER));
  assert.match(artifact.url, new RegExp(TEST_INSTALLER_COMMIT));

  assert.throws(
    () => configuredInstallerArtifact({ ...base, DRAC_CENTRAL_INSTALLER_COMMIT: '' }),
    /identificador imutável/i,
  );
  for (const branch of ['main', 'master', 'develop', 'latest', 'HEAD', 'abc123']) {
    assert.throws(
      () => configuredInstallerArtifact({ ...base, DRAC_CENTRAL_INSTALLER_COMMIT: branch }),
      /identificador imutável/i,
    );
  }
  assert.throws(
    () => configuredInstallerArtifact({ ...base, DRAC_CENTRAL_INSTALLER_SHA256: 'abc' }),
    /sha-256/i,
  );
  assert.throws(
    () => configuredInstallerArtifact({
      ...base,
      DRAC_CENTRAL_INSTALLER_URL_TEMPLATE: 'https://example.invalid/install-drac.sh',
    }),
    /\{commit\}/i,
  );
  assert.throws(
    () => configuredInstallerArtifact({
      ...base,
      DRAC_CENTRAL_INSTALLER_URL_TEMPLATE:
        'http://example.invalid/drac/{commit}/scripts/install-drac.sh',
    }),
    /https/i,
  );
});

test('artefato válido executa somente depois do hash e remove o temporário', async (t) => {
  const server = await startArtifactServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/x-shellscript' });
    res.end(STUB_INSTALLER);
  });
  const sandbox = await makeSandbox();
  t.after(async () => {
    await server.stop();
    await sandbox.stop();
  });

  const customer = 'Cliente com espaços';
  const command = buildInstallerExecutionCommand({
    artifact: localArtifact(`${server.base}/installer`),
    environment: {
      DRAC_CUSTOMER_NAME: customer,
      DRAC_INSTALLATION_ID: 'cliente-seguro',
      DRAC_LICENSE_KEY: 'licenca-sintetica',
      DRAC_TEST_MARKER: sandbox.marker,
    },
    allowInsecureLoopback: true,
  });

  assert.doesNotMatch(command, /curl[^\n]*\|\s*(?:ba)?sh/);
  assert.doesNotMatch(command, /wget[^\n]*\|\s*(?:ba)?sh/);
  assert.doesNotMatch(command, /\/(?:main|master|develop|latest|HEAD)\//i);
  assert.match(command, /\/dev\/fd\/4|\/proc\/self\/fd\/4/);

  const result = await runShell(command, { TMPDIR: sandbox.tmp });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await fs.readFile(sandbox.marker, 'utf8'),
    `${customer}\ncliente-seguro\nlicenca-sintetica\n`,
  );
  assert.deepEqual(await sandbox.tempEntries(), []);
});

test('hash divergente, ausente ou malformado nunca executa o instalador', async (t) => {
  const server = await startArtifactServer((_req, res) => res.end(STUB_INSTALLER));
  const sandbox = await makeSandbox();
  t.after(async () => {
    await server.stop();
    await sandbox.stop();
  });

  const command = buildInstallerExecutionCommand({
    artifact: {
      ...localArtifact(`${server.base}/installer`),
      sha256: '0'.repeat(64),
    },
    environment: { DRAC_TEST_MARKER: sandbox.marker },
    allowInsecureLoopback: true,
  });
  const result = await runShell(command, { TMPDIR: sandbox.tmp });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /sha-256.*diverge/i);
  await assert.rejects(fs.access(sandbox.marker));
  assert.deepEqual(await sandbox.tempEntries(), []);

  assert.throws(
    () => buildInstallerExecutionCommand({
      artifact: { ...localArtifact(`${server.base}/installer`), sha256: '' },
      allowInsecureLoopback: true,
    }),
    /sha-256/i,
  );
  assert.throws(
    () => buildInstallerExecutionCommand({
      artifact: { ...localArtifact(`${server.base}/installer`), sha256: 'abc' },
      allowInsecureLoopback: true,
    }),
    /sha-256/i,
  );
});

test('erros HTTP, interrupção, vazio, redirect e timeout falham com cleanup', async (t) => {
  const server = await startArtifactServer((req, res) => {
    if (req.url === '/error') {
      res.writeHead(503);
      return res.end('indisponivel');
    }
    if (req.url === '/interrompido') {
      res.writeHead(200, { 'content-length': String(STUB_INSTALLER.length * 2) });
      res.write(STUB_INSTALLER.slice(0, 20));
      return res.destroy();
    }
    if (req.url === '/vazio') return res.end('');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/valido' });
      return res.end();
    }
    if (req.url === '/lento') {
      return setTimeout(() => res.end(STUB_INSTALLER), 1500);
    }
    return res.end(STUB_INSTALLER);
  });
  const sandbox = await makeSandbox();
  t.after(async () => {
    await server.stop();
    await sandbox.stop();
  });

  for (const scenario of ['error', 'interrompido', 'vazio', 'redirect', 'lento']) {
    const marker = path.join(sandbox.root, `${scenario}.txt`);
    const command = buildInstallerExecutionCommand({
      artifact: localArtifact(`${server.base}/${scenario}`),
      environment: { DRAC_TEST_MARKER: marker },
      allowInsecureLoopback: true,
      maxTimeSeconds: scenario === 'lento' ? 1 : 5,
    });
    const result = await runShell(command, { TMPDIR: sandbox.tmp });
    assert.notEqual(result.code, 0, `${scenario} deveria falhar`);
    await assert.rejects(fs.access(marker));
    assert.deepEqual(await sandbox.tempEntries(), []);
  }
});

test('ausência de sha256sum e shasum falha antes do download', async (t) => {
  let requests = 0;
  const server = await startArtifactServer((_req, res) => {
    requests += 1;
    res.end(STUB_INSTALLER);
  });
  const sandbox = await makeSandbox();
  const bin = path.join(sandbox.root, 'bin');
  await fs.mkdir(bin);
  await fs.symlink('/usr/bin/curl', path.join(bin, 'curl'));
  t.after(async () => {
    await server.stop();
    await sandbox.stop();
  });

  const command = buildInstallerExecutionCommand({
    artifact: localArtifact(`${server.base}/installer`),
    environment: { DRAC_TEST_MARKER: sandbox.marker },
    allowInsecureLoopback: true,
    toolSearchPath: bin,
  });
  const result = await runShell(command, { PATH: bin, TMPDIR: sandbox.tmp });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /sha256sum.*shasum/i);
  assert.equal(requests, 0);
  await assert.rejects(fs.access(sandbox.marker));
});

test('parâmetros preservam espaços e tentativas de injeção como dados', async (t) => {
  const server = await startArtifactServer((_req, res) => res.end(STUB_INSTALLER));
  const sandbox = await makeSandbox();
  const injected = path.join(sandbox.root, 'nao-deve-existir');
  const payload = `texto literal $(touch ${injected}) ; ' "`;
  t.after(async () => {
    await server.stop();
    await sandbox.stop();
  });

  const command = buildInstallerExecutionCommand({
    artifact: localArtifact(`${server.base}/installer`),
    environment: {
      DRAC_CUSTOMER_NAME: 'Cliente A B',
      DRAC_INSTALLATION_ID: payload,
      DRAC_LICENSE_KEY: 'valor-sintetico',
      DRAC_TEST_MARKER: sandbox.marker,
    },
    allowInsecureLoopback: true,
  });
  const result = await runShell(command, { TMPDIR: sandbox.tmp });
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(sandbox.marker, 'utf8'), /Cliente A B/);
  assert.match(await fs.readFile(sandbox.marker, 'utf8'), /texto literal \$\(touch/);
  await assert.rejects(fs.access(injected));
});

test('grant vincula artefato, expira e permite retries somente dentro da janela', () => {
  const item = { id: 'cliente-a' };
  const now = new Date('2026-07-28T12:00:00.000Z');
  const grant = issueInstallerGrant(item, {
    artifact: localArtifact('https://example.invalid/installer'),
    now,
    ttlMs: 30 * 60 * 1000,
    randomToken: () => 'token-sintetico',
    rotateArtifact: true,
  });

  assert.equal(grant.installerToken, 'token-sintetico');
  assert.equal('installerToken' in item, false);
  assert.equal(item.installerTokenHash, sha256('token-sintetico'));
  assert.equal(item.installerArtifact.id, TEST_INSTALLER_COMMIT);
  assert.equal(item.installerArtifact.sha256, sha256(STUB_INSTALLER));
  assert.equal(item.installerTokenExpiresAt, '2026-07-28T12:30:00.000Z');
  assert.equal(item.installerTokenRemainingDownloads, 3);
  assert.equal(isInstallerTokenActive(item, new Date('2026-07-28T12:29:59.999Z')), true);
  assert.equal(isInstallerTokenActive(item, new Date('2026-07-28T12:30:00.000Z')), false);
});

test('fluxo HTTP completo persiste vínculo, valida dois downloads e não vaza segredos na execução', async (t) => {
  const artifactServer = await startArtifactServer((req, res) => {
    assert.equal(req.url, `/${TEST_INSTALLER_COMMIT}/install-drac.sh`);
    res.end(STUB_INSTALLER);
  });
  const central = await startCentral({
    DRAC_CENTRAL_INSTALLER_COMMIT: TEST_INSTALLER_COMMIT,
    DRAC_CENTRAL_INSTALLER_SHA256: sha256(STUB_INSTALLER),
    DRAC_CENTRAL_INSTALLER_URL_TEMPLATE:
      `${artifactServer.base}/{commit}/install-drac.sh`,
    DRAC_CENTRAL_ALLOW_INSECURE_INSTALLER_URL: 'true',
  });
  const sandbox = await makeSandbox();
  t.after(async () => {
    await central.stop();
    await artifactServer.stop();
    await sandbox.stop();
  });

  const provision = await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST',
    headers: central.adminHeaders(),
    body: JSON.stringify({
      customerName: 'Cliente Teste',
      installationId: 'cliente-teste',
      serverAddress: '192.0.2.10',
    }),
  });
  assert.equal(provision.status, 201);
  const body = await provision.json();
  assert.equal(body.installerArtifact.id, TEST_INSTALLER_COMMIT);
  assert.equal(body.installerArtifact.sha256, sha256(STUB_INSTALLER));
  assert.match(body.installerTokenExpiresAt, /Z$/);
  assert.doesNotMatch(body.installCommand, /curl[^\n]*\|\s*(?:ba)?sh/);
  assert.doesNotMatch(body.installCommand, /\/(?:main|master|develop|latest|HEAD)\//i);

  const token = body.installerToken;
  assert.match(token, /^[A-Za-z0-9_-]{20,200}$/);
  assert.equal(body.installCommand.includes(token), false);
  assert.equal(body.quickInstallUrl.includes(token), false);
  const execution = await runShell(body.installCommand, {
    DRAC_TEST_MARKER: sandbox.marker,
    TMPDIR: sandbox.tmp,
  }, `${token}\n`);
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout.includes(token), false);
  assert.equal(execution.stderr.includes(token), false);
  assert.equal(execution.stdout.includes(body.licenseKey), false);
  assert.equal(execution.stderr.includes(body.licenseKey), false);
  assert.deepEqual(await sandbox.tempEntries(), []);
  assert.match(await fs.readFile(sandbox.marker, 'utf8'), /cliente-teste/);

  const retry = await runShell(body.installCommand, {
    DRAC_TEST_MARKER: sandbox.marker,
    TMPDIR: sandbox.tmp,
  }, `${token}\n`);
  assert.equal(retry.code, 0, retry.stderr);

  const persisted = JSON.parse(
    await fs.readFile(path.join(central.dir, 'installations.json'), 'utf8'),
  );
  const item = persisted.installations['cliente-teste'];
  assert.equal(item.installerArtifact.id, TEST_INSTALLER_COMMIT);
  assert.equal(item.installerArtifact.sha256, sha256(STUB_INSTALLER));
  assert.ok(item.installerTokenExpiresAt);
  assert.equal('installerToken' in item, false);
  assert.match(item.installerTokenHash, /^[a-f0-9]{64}$/);
  assert.equal(item.installerTokenRemainingDownloads, 1);

  const lastAllowed = await runShell(body.installCommand, {
    DRAC_TEST_MARKER: sandbox.marker,
    TMPDIR: sandbox.tmp,
  }, `${token}\n`);
  assert.equal(lastAllowed.code, 0, lastAllowed.stderr);

  const exhausted = await runShell(body.installCommand, {
    DRAC_TEST_MARKER: sandbox.marker,
    TMPDIR: sandbox.tmp,
  }, `${token}\n`);
  assert.notEqual(exhausted.code, 0);
  assert.equal(exhausted.stdout.includes(token), false);
  assert.equal(exhausted.stderr.includes(token), false);
  assert.equal(exhausted.stderr.includes(body.licenseKey), false);

  const consumed = JSON.parse(
    await fs.readFile(path.join(central.dir, 'installations.json'), 'utf8'),
  ).installations['cliente-teste'];
  assert.equal(consumed.installerTokenRemainingDownloads, 0);
  assert.match(consumed.installerTokenUsedAt, /Z$/);
});

test('configuração ausente falha fechada sem emitir comando ou token', async (t) => {
  const central = await startCentral({
    DRAC_CENTRAL_INSTALLER_COMMIT: '',
    DRAC_CENTRAL_INSTALLER_SHA256: '',
    DRAC_CENTRAL_INSTALLER_URL_TEMPLATE: '',
  });
  t.after(() => central.stop());

  const response = await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST',
    headers: central.adminHeaders(),
    body: JSON.stringify({ customerName: 'Cliente sem artefato' }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'installer_artifact_not_configured');
  assert.equal('installCommand' in body, false);
  assert.equal('installerToken' in body, false);
});

test('reprovisionamento invalida comando anterior e emite novo token com o mesmo vínculo', async (t) => {
  const central = await startCentral();
  t.after(() => central.stop());

  async function provision() {
    const response = await fetch(`${central.base}/api/admin/provision`, {
      method: 'POST',
      headers: central.adminHeaders(),
      body: JSON.stringify({
        customerName: 'Cliente Compat',
        installationId: 'cliente-compat',
      }),
    });
    assert.equal(response.status, 201);
    return response.json();
  }

  const before = await provision();
  const after = await provision();
  const beforeToken = before.installerToken;
  const afterToken = after.installerToken;
  assert.equal(before.installCommand.includes(beforeToken), false);
  assert.equal(after.installCommand.includes(afterToken), false);
  assert.equal(after.quickInstallUrl, before.quickInstallUrl);
  assert.notEqual(afterToken, beforeToken);
  assert.equal(before.quickInstallUrl.includes(beforeToken), false);
  assert.equal(after.quickInstallUrl.includes(afterToken), false);
  assert.equal(after.installerArtifact.id, before.installerArtifact.id);
  assert.equal(after.installerArtifact.sha256, before.installerArtifact.sha256);

  const oldResponse = await fetch(before.quickInstallUrl, {
    headers: { authorization: `Bearer ${beforeToken}` },
  });
  assert.equal(oldResponse.status, 404);
  assert.doesNotMatch(await oldResponse.text(), /token|sha|licen/i);
  const currentResponse = await fetch(after.quickInstallUrl, {
    headers: { authorization: `Bearer ${afterToken}` },
  });
  assert.equal(currentResponse.status, 200);
});

test('todos os caminhos versionados removem pipe para shell e branch móvel', async () => {
  const serverSource = await fs.readFile(
    path.resolve(__dirname, '../src/server.js'),
    'utf8',
  );
  const securitySource = await fs.readFile(
    path.resolve(__dirname, '../src/installer-security.js'),
    'utf8',
  );
  const installerSource = await fs.readFile(
    path.resolve(__dirname, '../../../scripts/install-drac.sh'),
    'utf8',
  );
  const activeFlow = `${serverSource}\n${securitySource}\n${installerSource}`;

  assert.doesNotMatch(activeFlow, /curl[^\n]*\|\s*(?:ba)?sh/);
  assert.doesNotMatch(activeFlow, /wget[^\n]*\|\s*(?:ba)?sh/);
  assert.doesNotMatch(installerSource, /\bDRAC_BRANCH\b/);
  assert.doesNotMatch(installerSource, /\/(?:main|master|develop|latest|HEAD)\//i);
  assert.match(installerSource, /DRAC_INSTALLER_COMMIT/);
  assert.match(installerSource, /fetch --depth 1 origin "\$DRAC_INSTALLER_COMMIT"/);
  assert.match(installerSource, /checkout --detach "\$DRAC_INSTALLER_COMMIT"/);
  assert.doesNotMatch(installerSource, /git[^\n]*pull/);
});
