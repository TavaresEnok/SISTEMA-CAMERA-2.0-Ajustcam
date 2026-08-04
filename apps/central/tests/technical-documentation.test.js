'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { hashPassword } = require('../src/server');
const {
  TECHNICAL_DOCUMENTATION,
  TECHNICAL_DOCUMENTATION_PERMISSION,
} = require('../src/technical-documentation');
const { startCentral } = require('./helpers/central-server');

function cookieFrom(response) {
  return (response.headers.get('set-cookie') || '').split(';', 1)[0];
}

async function login(central, email, password) {
  const response = await fetch(`${central.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return { cookie: cookieFrom(response), body: await response.json() };
}

async function createUser(central, email, password) {
  const response = await fetch(`${central.base}/api/admin/users`, {
    method: 'POST',
    headers: central.adminHeaders(),
    body: JSON.stringify({ email, name: 'Pessoa técnica', password }),
  });
  assert.equal(response.status, 200, await response.text());
}

test('o documento confidencial não é incorporado aos assets públicos', async () => {
  const publicIndex = await fs.readFile(path.resolve(__dirname, '../public/index.html'), 'utf8');
  assert.match(publicIndex, /Portal técnico do AjustCam/);
  assert.doesNotMatch(publicIndex, /motionScore &gt; 0/);
  assert.doesNotMatch(publicIndex, /motionScore > 0/);
  assert.doesNotMatch(publicIndex, /O banco só deve apontar para um arquivo/);
  assert.equal(path.dirname(require.resolve('../src/technical-documentation')), path.resolve(__dirname, '../src'));
});

test('o catálogo técnico cobre os módulos ativos e só referencia arquivos existentes', async () => {
  const repositoryRoot = path.resolve(__dirname, '../../..');
  const categories = TECHNICAL_DOCUMENTATION.categories;
  const articles = categories.flatMap((category) => category.articles);
  const articleIds = articles.map((article) => article.id);
  const sourceFiles = [...new Set(articles.flatMap((article) => article.sourceFiles || []))];
  const requiredArticles = [
    'inventario-modulos-api',
    'matriz-paginas-web',
    'contratos-internos',
    'catalogo-configuracoes',
    'cloud-connector-heartbeat',
    'infra-midia-proxy',
    'worker-go-legado',
    'gpu-aceleracao',
    'central-datastore',
    'scheduler-multinode',
    'app-builder-white-label',
    'variaveis-feature-flags',
  ];

  assert.equal(TECHNICAL_DOCUMENTATION.schemaVersion, 2);
  assert.match(TECHNICAL_DOCUMENTATION.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
  assert.ok(categories.length >= 11, `esperadas pelo menos 11 categorias; recebidas ${categories.length}`);
  assert.ok(articles.length >= 55, `esperados pelo menos 55 artigos; recebidos ${articles.length}`);
  assert.equal(new Set(articleIds).size, articleIds.length, 'IDs de artigos precisam ser únicos');
  assert.ok(sourceFiles.length >= 100, `esperadas pelo menos 100 referências únicas; recebidas ${sourceFiles.length}`);
  for (const required of requiredArticles) assert.ok(articleIds.includes(required), `artigo obrigatório ausente: ${required}`);
  for (const sourceFile of sourceFiles) {
    await fs.access(path.resolve(repositoryRoot, sourceFile));
  }

  const inventory = articles.find((article) => article.id === 'inventario-modulos-api');
  const inventoryLabels = inventory.blocks
    .filter((block) => block.type === 'table')
    .flatMap((block) => block.rows.map((row) => String(row[0]).toLowerCase().replace(/[^a-z0-9]/g, '')));
  const apiSourceRoot = path.resolve(repositoryRoot, 'apps/api/src');
  const moduleFiles = (await fs.readdir(apiSourceRoot, { recursive: true }))
    .filter((entry) => entry.endsWith('.module.ts') && entry !== 'app.module.ts');
  for (const moduleFile of moduleFiles) {
    const moduleSource = await fs.readFile(path.resolve(apiSourceRoot, moduleFile), 'utf8');
    const className = moduleSource.match(/export class (\w+)Module\b/)?.[1]?.toLowerCase();
    assert.ok(className, `classe de módulo não identificada: ${moduleFile}`);
    assert.ok(
      inventoryLabels.some((label) => label.includes(className) || className.includes(label)),
      `módulo ativo ausente do inventário técnico: ${className} (${moduleFile})`,
    );
  }
});

test('a interface do portal oferece navegação, recuperação e acessibilidade básicas', async () => {
  const publicIndex = await fs.readFile(path.resolve(__dirname, '../public/index.html'), 'utf8');

  assert.match(publicIndex, /<label for="technical-query">Pesquisar na documentação<\/label>/);
  assert.match(publicIndex, /id="technical-live-status"[^>]*aria-live="polite"/);
  assert.match(publicIndex, /id="technical-index"[^>]*aria-busy="false"/);
  assert.match(publicIndex, /id="technical-article"[^>]*aria-busy="false"/);
  assert.match(publicIndex, /id="technical-copy-link"/);
  assert.match(publicIndex, /id="technical-print"/);
  assert.match(publicIndex, /id="technical-retry"/);
  assert.match(publicIndex, /window\.addEventListener\('popstate'/);
  assert.match(publicIndex, /aria-current="page"/);
  assert.match(publicIndex, /@media \(max-width: 560px\)/);
  assert.match(publicIndex, /\.technical-kv \{ grid-template-columns: 1fr; \}/);
  assert.match(publicIndex, /\.technical-flow > li:not\(:last-child\)::after \{ content: '↓'/);
  assert.doesNotMatch(publicIndex, /\.technical-(?:category|meta|code-label)[^{]*\{[^}]*color:\s*var\(--quiet\)/s);
});

test('a API do portal recusa anônimo, bearer de automação e usuário sem permissão', async (t) => {
  const central = await startCentral({ DRAC_CENTRAL_COOKIE_SECURE: 'false' });
  t.after(() => central.stop());

  const anonymous = await fetch(`${central.base}/api/admin/technical-documentation`);
  assert.equal(anonymous.status, 401);

  const bearer = await fetch(`${central.base}/api/admin/technical-documentation`, {
    headers: central.adminHeaders(),
  });
  assert.equal(bearer.status, 403);

  const email = 'sem-acesso@example.test';
  const password = 'SenhaSemAcesso123';
  await createUser(central, email, password);
  const { cookie, body } = await login(central, email, password);
  assert.deepEqual(body.user.permissions, []);
  assert.equal(body.user.canManageTechnicalAccess, false);

  const denied = await fetch(`${central.base}/api/admin/technical-documentation`, {
    headers: { cookie },
  });
  assert.equal(denied.status, 403);

  const selfGrant = await fetch(`${central.base}/api/admin/users`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email, permissions: [TECHNICAL_DOCUMENTATION_PERMISSION] }),
  });
  assert.equal(selfGrant.status, 403);

  const bearerGrant = await fetch(`${central.base}/api/admin/users`, {
    method: 'POST',
    headers: central.adminHeaders(),
    body: JSON.stringify({ email, permissions: [TECHNICAL_DOCUMENTATION_PERMISSION] }),
  });
  assert.equal(bearerGrant.status, 403);
});

test('admin nativo concede e revoga o portal com efeito imediato na sessão existente', async (t) => {
  const adminEmail = 'admin-tecnico@example.test';
  const adminPassword = 'SenhaAdminTecnico123';
  const central = await startCentral({
    DRAC_CENTRAL_COOKIE_SECURE: 'false',
    DRAC_CENTRAL_ADMIN_EMAIL: adminEmail,
    DRAC_CENTRAL_ADMIN_PASSWORD_HASH: hashPassword(adminPassword),
  });
  t.after(() => central.stop());

  const targetEmail = 'tecnico@example.test';
  const targetPassword = 'SenhaPessoaTecnica123';
  await createUser(central, targetEmail, targetPassword);
  const targetSession = await login(central, targetEmail, targetPassword);
  const adminSession = await login(central, adminEmail, adminPassword);

  assert.deepEqual(adminSession.body.user.permissions, [TECHNICAL_DOCUMENTATION_PERMISSION]);
  assert.equal(adminSession.body.user.canManageTechnicalAccess, true);

  const adminDocument = await fetch(`${central.base}/api/admin/technical-documentation`, {
    headers: { cookie: adminSession.cookie },
  });
  assert.equal(adminDocument.status, 200, await adminDocument.clone().text());
  const documentBody = await adminDocument.json();
  assert.equal(documentBody.document.product, 'AjustCam');
  assert.ok(documentBody.document.categories.length >= 11);
  assert.ok(documentBody.document.categories.flatMap((category) => category.articles).length >= 55);

  const granted = await fetch(`${central.base}/api/admin/users`, {
    method: 'POST',
    headers: { cookie: adminSession.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email: targetEmail, permissions: [TECHNICAL_DOCUMENTATION_PERMISSION] }),
  });
  assert.equal(granted.status, 200, await granted.text());

  const allowedWithExistingSession = await fetch(`${central.base}/api/admin/technical-documentation`, {
    headers: { cookie: targetSession.cookie },
  });
  assert.equal(allowedWithExistingSession.status, 200, await allowedWithExistingSession.clone().text());

  const revoked = await fetch(`${central.base}/api/admin/users`, {
    method: 'POST',
    headers: { cookie: adminSession.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email: targetEmail, permissions: [] }),
  });
  assert.equal(revoked.status, 200, await revoked.text());

  const deniedWithSameSession = await fetch(`${central.base}/api/admin/technical-documentation`, {
    headers: { cookie: targetSession.cookie },
  });
  assert.equal(deniedWithSameSession.status, 403);

  const usersResponse = await fetch(`${central.base}/api/admin/users`, {
    headers: { cookie: adminSession.cookie },
  });
  assert.equal(usersResponse.status, 200);
  const usersBody = await usersResponse.json();
  const target = usersBody.users.find((user) => user.email === targetEmail);
  assert.deepEqual(target.permissions, []);
});
