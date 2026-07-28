'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clientIpFromRequest,
  compileTrustedProxies,
  isTrustedProxy,
  normalizeIp,
} = require('../src/proxy-trust');

test('normaliza IPv4 mapeado em IPv6 e rejeita endereços inválidos', () => {
  assert.equal(normalizeIp('::ffff:192.0.2.10'), '192.0.2.10');
  assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizeIp('endereco-invalido'), '');
});

test('allowlist de proxies respeita limites IPv4 e IPv6', () => {
  const ranges = compileTrustedProxies('127.0.0.1/32,10.20.0.0/16,2001:db8:1::/48');

  assert.equal(isTrustedProxy('127.0.0.1', ranges), true);
  assert.equal(isTrustedProxy('127.0.0.2', ranges), false);
  assert.equal(isTrustedProxy('10.20.255.254', ranges), true);
  assert.equal(isTrustedProxy('10.21.0.1', ranges), false);
  assert.equal(isTrustedProxy('2001:db8:1:ffff::1', ranges), true);
  assert.equal(isTrustedProxy('2001:db8:2::1', ranges), false);
});

test('peer não confiável não pode forjar o IP por headers', () => {
  const trusted = compileTrustedProxies('127.0.0.1/32');
  const req = {
    socket: { remoteAddress: '198.51.100.20' },
    headers: {
      'x-real-ip': '203.0.113.44',
      'x-forwarded-for': '192.0.2.60',
    },
  };

  assert.equal(clientIpFromRequest(req, trusted), '198.51.100.20');
});

test('peer confiável encaminha apenas um X-Real-IP válido', () => {
  const trusted = compileTrustedProxies('127.0.0.1/32');

  assert.equal(clientIpFromRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      'x-real-ip': '203.0.113.44',
      'x-forwarded-for': '192.0.2.60',
    },
  }, trusted), '203.0.113.44');

  assert.equal(clientIpFromRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-real-ip': 'forjado' },
  }, trusted), '127.0.0.1');
});

test('configurações de proxy inválidas falham de modo fechado na inicialização', () => {
  assert.throws(
    () => compileTrustedProxies('10.0.0.0/99'),
    /CIDR de proxy inválido/,
  );
  assert.throws(
    () => compileTrustedProxies('proxy.example.com'),
    /Endereço IP inválido/,
  );
});
