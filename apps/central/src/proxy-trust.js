'use strict';

const net = require('node:net');

function normalizeIp(value) {
  let ip = String(value || '').trim().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : '';
}

function ipv4ToBigInt(ip) {
  return ip
    .split('.')
    .reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6ToBigInt(input) {
  let ip = input.toLowerCase();
  const ipv4Tail = ip.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const value = ipv4ToBigInt(ipv4Tail);
    const replacement = `${((value >> 16n) & 0xffffn).toString(16)}:${(value & 0xffffn).toString(16)}`;
    ip = ip.slice(0, -ipv4Tail.length) + replacement;
  }
  const halves = ip.split('::');
  if (halves.length > 2) throw new Error('IPv6 inválido');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    throw new Error('IPv6 inválido');
  }
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[a-f0-9]{1,4}$/i.test(part))) {
    throw new Error('IPv6 inválido');
  }
  return parts.reduce(
    (value, part) => (value << 16n) | BigInt(`0x${part}`),
    0n,
  );
}

function ipValue(ip) {
  const normalized = normalizeIp(ip);
  const family = net.isIP(normalized);
  if (family === 4) return { family, bits: 32, value: ipv4ToBigInt(normalized) };
  if (family === 6) return { family, bits: 128, value: ipv6ToBigInt(normalized) };
  throw new Error(`Endereço IP inválido: ${String(ip)}`);
}

function parseTrustedProxyEntry(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return null;
  const [address, prefixRaw] = raw.split('/');
  const parsed = ipValue(address);
  const prefix = prefixRaw === undefined ? parsed.bits : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) {
    throw new Error(`CIDR de proxy inválido: ${raw}`);
  }
  const shift = BigInt(parsed.bits - prefix);
  const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift;
  return { family: parsed.family, bits: parsed.bits, prefix, network };
}

function compileTrustedProxies(value) {
  return String(value || '')
    .split(',')
    .map(parseTrustedProxyEntry)
    .filter(Boolean);
}

function isTrustedProxy(ip, ranges) {
  let parsed;
  try {
    parsed = ipValue(ip);
  } catch {
    return false;
  }
  return ranges.some((range) => {
    if (range.family !== parsed.family) return false;
    const shift = BigInt(range.bits - range.prefix);
    const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift;
    return network === range.network;
  });
}

function clientIpFromRequest(req, trustedProxies) {
  const socketIp = normalizeIp(req?.socket?.remoteAddress);
  if (!socketIp) return '';
  if (!isTrustedProxy(socketIp, trustedProxies)) return socketIp;
  const forwarded = normalizeIp(req?.headers?.['x-real-ip']);
  return forwarded || socketIp;
}

module.exports = {
  clientIpFromRequest,
  compileTrustedProxies,
  isTrustedProxy,
  normalizeIp,
  parseTrustedProxyEntry,
};
