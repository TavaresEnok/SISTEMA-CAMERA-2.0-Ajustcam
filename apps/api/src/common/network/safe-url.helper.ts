import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const DEVELOPMENT_CAMERA_CIDRS = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7';
const ALWAYS_DENIED_CAMERA_CIDRS = [
  '0.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fe80::/10',
  'ff00::/8',
].join(',');

export class CameraNetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CameraNetworkPolicyError';
  }
}

function parseIpv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

function isPrivateIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  return false;
}

function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function parseCidrList(value: string, label: string): BlockList {
  const list = new BlockList();
  for (const rawEntry of String(value || '').split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const slash = entry.lastIndexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const familyNumber = isIP(address);
    if (!familyNumber) {
      throw new CameraNetworkPolicyError(`${label} contém endereço/CIDR inválido.`);
    }
    const family = familyNumber === 4 ? 'ipv4' : 'ipv6';
    const maxPrefix = familyNumber === 4 ? 32 : 128;
    const prefix = slash === -1 ? maxPrefix : Number(entry.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new CameraNetworkPolicyError(`${label} contém prefixo CIDR inválido.`);
    }
    try {
      list.addSubnet(address, prefix, family);
    } catch {
      throw new CameraNetworkPolicyError(`${label} contém endereço/CIDR inválido.`);
    }
  }
  return list;
}

function blockListHas(list: BlockList, ip: string): boolean {
  const family = isIP(ip);
  return family === 4
    ? list.check(ip, 'ipv4')
    : family === 6
      ? list.check(ip, 'ipv6')
      : false;
}

/**
 * Política de egress das câmeras.
 *
 * Produção falha fechada sem `CAMERA_ALLOWED_CIDRS`: não há como distinguir a
 * VLAN de câmeras do plano de controle apenas olhando "IP privado". Em dev/test
 * o fallback RFC1918/ULA mantém fixtures locais, mas as faixas de alto risco
 * continuam sempre negadas.
 */
export function assertCameraTargetAllowed(
  ipRaw: string,
  port?: number | null,
  source: Record<string, string | undefined> = process.env,
): string {
  const ip = normalizeIp(String(ipRaw || '').trim());
  if (!ip || isIP(ip) === 0) {
    throw new CameraNetworkPolicyError('O destino da câmera deve ser um endereço IP literal válido.');
  }
  if (port !== undefined && port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new CameraNetworkPolicyError('A porta da câmera deve estar entre 1 e 65535.');
  }

  const denied = parseCidrList(
    `${ALWAYS_DENIED_CAMERA_CIDRS},${source.CAMERA_DENIED_CIDRS || ''}`,
    'CAMERA_DENIED_CIDRS',
  );
  if (blockListHas(denied, ip)) {
    throw new CameraNetworkPolicyError('Destino de câmera bloqueado pela política de rede.');
  }

  const configuredAllowed = String(source.CAMERA_ALLOWED_CIDRS || '').trim();
  const production = String(source.NODE_ENV || '').trim().toLowerCase() === 'production';
  if (!configuredAllowed && production) {
    throw new CameraNetworkPolicyError(
      'CAMERA_ALLOWED_CIDRS não está configurado; conexões de câmera estão bloqueadas.',
    );
  }
  const allowed = parseCidrList(
    configuredAllowed || DEVELOPMENT_CAMERA_CIDRS,
    'CAMERA_ALLOWED_CIDRS',
  );
  if (!blockListHas(allowed, ip)) {
    throw new CameraNetworkPolicyError('Destino fora das redes de câmera autorizadas.');
  }
  return ip;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }
  return false;
}

export function isPrivateOrReservedIp(ipRaw: string): boolean {
  const ip = normalizeIp(ipRaw);
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

export function isAllowedHost(hostname: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith('.')) return host.endsWith(rule);
    return host === rule || host.endsWith(`.${rule}`);
  });
}

export async function resolveHostIps(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((entry) => entry.address);
  } catch {
    return [];
  }
}
