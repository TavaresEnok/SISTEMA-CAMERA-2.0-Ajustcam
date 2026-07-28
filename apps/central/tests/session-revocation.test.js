'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { startCentral } = require('./helpers/central-server');

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(';', 1)[0];
}

async function login(central, email, password) {
  const response = await fetch(`${central.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, await response.text());
  return cookieFrom(response);
}

async function me(central, cookie) {
  const response = await fetch(`${central.base}/api/auth/me`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('troca de senha e exclusão revogam todas as sessões do usuário da Central', async (t) => {
  const central = await startCentral({ DRAC_CENTRAL_COOKIE_SECURE: 'false' });
  t.after(() => central.stop());

  const email = 'operador@example.test';
  const firstPassword = 'SenhaInicialForte123';
  const nextPassword = 'SenhaNovaMuitoForte456';

  const created = await fetch(`${central.base}/api/admin/users`, {
    method: 'POST',
    headers: central.adminHeaders(),
    body: JSON.stringify({ email, name: 'Operador', password: firstPassword }),
  });
  assert.equal(created.status, 200, await created.text());

  const cookieA = await login(central, email, firstPassword);
  const cookieB = await login(central, email, firstPassword);
  assert.equal((await me(central, cookieA)).authenticated, true);
  assert.equal((await me(central, cookieB)).authenticated, true);

  const changed = await fetch(`${central.base}/api/admin/users`, {
    method: 'POST',
    headers: central.adminHeaders(),
    body: JSON.stringify({ email, name: 'Operador', password: nextPassword }),
  });
  assert.equal(changed.status, 200, await changed.text());
  assert.equal((await me(central, cookieA)).authenticated, false);
  assert.equal((await me(central, cookieB)).authenticated, false);

  const currentCookie = await login(central, email, nextPassword);
  assert.equal((await me(central, currentCookie)).authenticated, true);

  const deleted = await fetch(
    `${central.base}/api/admin/users/${encodeURIComponent(email)}`,
    { method: 'DELETE', headers: central.adminHeaders() },
  );
  assert.equal(deleted.status, 200, await deleted.text());
  assert.equal((await me(central, currentCookie)).authenticated, false);
});

test('cookies de sessão são Secure por padrão e o cookie de logout preserva a flag', async (t) => {
  const central = await startCentral({
    DRAC_CENTRAL_ADMIN_EMAIL: 'admin@example.test',
    DRAC_CENTRAL_ADMIN_PASSWORD_HASH: '',
    DRAC_CENTRAL_COOKIE_SECURE: '',
  });
  t.after(() => central.stop());

  const email = 'cookie@example.test';
  const password = 'CookieSeguroForte123';
  const created = await fetch(`${central.base}/api/admin/users`, {
    method: 'POST',
    headers: central.adminHeaders(),
    body: JSON.stringify({ email, password }),
  });
  assert.equal(created.status, 200);

  const response = await fetch(`${central.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /;\s*Secure(?:;|$)/i);
  assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(setCookie, /;\s*SameSite=Lax(?:;|$)/i);

  const logout = await fetch(`${central.base}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: cookieFrom(response) },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /;\s*Secure(?:;|$)/i);
});
