'use strict';

// Sobe a Central REAL num processo filho, com arquivo de dados TEMPORÁRIO.
// Nunca toca o data file vivo (o env é montado do zero para as variáveis que
// importam). Não é um arquivo *.test.js — o runner (`node --test tests/*.test.js`)
// não o executa como suíte.

const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const SERVER = path.resolve(__dirname, '../../src/server.js');
const ADMIN_TOKEN = 'token-de-teste-nao-secreto';
const TEST_INSTALLER_COMMIT = '1'.repeat(40);
const TEST_INSTALLER_SHA256 = 'a'.repeat(64);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startCentral(extraEnv = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drac-central-ts-'));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      DRAC_CENTRAL_HOST: '127.0.0.1',
      DRAC_CENTRAL_PORT: String(port),
      DRAC_CENTRAL_ADMIN_TOKEN: ADMIN_TOKEN,
      DRAC_CENTRAL_DATA_FILE: path.join(dir, 'installations.json'),
      DRAC_CENTRAL_BACKUP_DIR: path.join(dir, 'backups'),
      // Default explícito: mesmo que o host tenha essas variáveis exportadas, o
      // teste decide o modo.
      DRAC_CENTRAL_DATABASE_URL: '',
      DRAC_CENTRAL_STORE_MODE: '',
      // Artefato sintético: a Central apenas gera comandos nos testes gerais e
      // nunca acessa example.invalid. Testes do instalador sobrescrevem estes
      // valores com um servidor HTTP local e conteúdo controlado.
      DRAC_CENTRAL_INSTALLER_COMMIT: TEST_INSTALLER_COMMIT,
      DRAC_CENTRAL_INSTALLER_SHA256: TEST_INSTALLER_SHA256,
      DRAC_CENTRAL_INSTALLER_URL_TEMPLATE:
        'https://example.invalid/drac/{commit}/scripts/install-drac.sh',
      DRAC_CENTRAL_INSTALLER_TOKEN_TTL_SECONDS: '1800',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`central morreu: ${logs.join('')}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch { /* ainda subindo */ }
    if (Date.now() > deadline) throw new Error(`central não subiu: ${logs.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    base,
    dir,
    logs,
    adminHeaders(extra = {}) {
      return { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', ...extra };
    },
    async stop() {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

module.exports = {
  ADMIN_TOKEN,
  TEST_INSTALLER_COMMIT,
  TEST_INSTALLER_SHA256,
  freePort,
  startCentral,
};
