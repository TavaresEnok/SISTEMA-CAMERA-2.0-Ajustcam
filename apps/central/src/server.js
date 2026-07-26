const http = require('node:http');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveConfig, createDatastore } = require('./datastore');
const { normalizeComputeNodes, validateComputeNodes, summarizeNodes } = require('./datastore/compute-nodes');

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fsSync.existsSync(envPath)) return;
  const raw = fsSync.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const HOST = process.env.DRAC_CENTRAL_HOST || '0.0.0.0';
const PORT = Number(process.env.DRAC_CENTRAL_PORT || 9765);
const ADMIN_TOKEN = String(process.env.DRAC_CENTRAL_ADMIN_TOKEN || '').trim();
const ADMIN_EMAIL = String(process.env.DRAC_CENTRAL_ADMIN_EMAIL || 'admin@drac.local').trim().toLowerCase();
const ADMIN_PASSWORD_HASH = String(process.env.DRAC_CENTRAL_ADMIN_PASSWORD_HASH || '').trim();
const SESSION_TTL_MS = Math.max(1, Number(process.env.DRAC_CENTRAL_SESSION_HOURS || 8)) * 60 * 60 * 1000;
const DATA_FILE = path.resolve(process.cwd(), process.env.DRAC_CENTRAL_DATA_FILE || './data/installations.json');
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

const LICENSE_ACTIVE = 'ACTIVE';
const DEFAULT_INSTALLER_URL =
  process.env.DRAC_CENTRAL_INSTALLER_URL || 'https://raw.githubusercontent.com/TavaresEnok/DRAC/main/scripts/install-drac.sh';
const ONLINE_THRESHOLD_SECONDS = Number(process.env.DRAC_CENTRAL_ONLINE_THRESHOLD_SECONDS || 180);
const HEARTBEAT_HISTORY_LIMIT = Number(process.env.DRAC_CENTRAL_HISTORY_LIMIT || 100);
const AUDIT_HISTORY_LIMIT = Number(process.env.DRAC_CENTRAL_AUDIT_HISTORY_LIMIT || 500);
const ALERT_HISTORY_LIMIT = Number(process.env.DRAC_CENTRAL_ALERT_HISTORY_LIMIT || 500);
const LOGIN_WINDOW_MS = Math.max(1, Number(process.env.DRAC_CENTRAL_LOGIN_WINDOW_MINUTES || 15)) * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = Math.max(1, Number(process.env.DRAC_CENTRAL_LOGIN_MAX_ATTEMPTS || 8));
const ALLOWED_ORIGINS = String(process.env.DRAC_CENTRAL_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const loginAttempts = new Map();
const MAX_REQUEST_BODY_BYTES = Math.max(16 * 1024, Number(process.env.DRAC_CENTRAL_MAX_BODY_BYTES || 1024 * 1024));

// Build-agent (gera os APKs white-label). Roda no HOST; a Central fala com ele
// pela gateway da bridge Docker. Token compartilhado (nunca exposto ao browser).
const APP_BUILDER_AGENT_URL = String(process.env.APP_BUILDER_AGENT_URL || '').replace(/\/+$/, '');
const APP_BUILDER_AGENT_TOKEN = String(process.env.APP_BUILDER_AGENT_TOKEN || '');
// De onde a Central busca o APK publicado p/ reentregar com nome amigável.
// Mesma gateway usada p/ o agente; o web publica os APKs em /apk no :5173.
const APK_SOURCE_BASE = String(process.env.APK_SOURCE_BASE || 'http://172.17.0.1:5173').replace(/\/+$/, '');

// Jobs de instalação remota via SSH (em memória; o log é volátil por design —
// nunca persiste credenciais). jobId -> { id, installationId, status, log, ... }
const remoteInstalls = new Map();
const REMOTE_INSTALL_KEEP = 30;

function securityHeaders(req) {
  const origin = String(req?.headers?.origin || '');
  const allowAnyOrigin = ALLOWED_ORIGINS.includes('*');
  const allowedOrigin = allowAnyOrigin || !origin ? (allowAnyOrigin ? '*' : ALLOWED_ORIGINS[0]) : ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'access-control-allow-origin': allowedOrigin || ALLOWED_ORIGINS[0] || '*',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-drac-installation-id,x-drac-license-key',
    'access-control-allow-credentials': 'true',
  };
}

function json(req, res, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(statusCode, {
    ...securityHeaders(req),
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(payload);
}

function text(req, res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    ...securityHeaders(req),
    'content-type': contentType,
  });
  res.end(body);
}

function empty(req, res, statusCode, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...securityHeaders(req),
    ...extraHeaders,
  });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      const error = new Error('Corpo da requisição excede o limite permitido.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function parseDbText(raw) {
  if (!raw || !raw.trim()) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

function normalizeDb(parsed) {
  if (!parsed || typeof parsed !== 'object') parsed = {};
  if (!parsed.installations || typeof parsed.installations !== 'object') parsed.installations = {};
  if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
  if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
  return parsed;
}

// legacyLoadDb NUNCA lança: arquivo corrompido derrubava o processo em qualquer
// request (login/heartbeat) num loop de crash. Agora cai pro .bak e, em último caso,
// isola o arquivo corrompido e começa limpo — a Central continua de pé.
// (É a fonte JSON legada; em modo Postgres vira read-only, janela de rollback.)
async function legacyLoadDb() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = parseDbText(raw);
    if (parsed) return normalizeDb(parsed);
  } catch (error) {
    if (error && error.code === 'ENOENT') return normalizeDb({});
    console.error(`[central] ${DATA_FILE} ilegível/corrompido: ${error.message}`);
  }
  // Tentativa de recuperação pelo backup conhecido-bom.
  try {
    const bak = await fs.readFile(`${DATA_FILE}.bak`, 'utf8');
    const parsed = parseDbText(bak);
    if (parsed) {
      console.error('[central] recuperado a partir de .bak');
      return normalizeDb(parsed);
    }
  } catch { /* sem backup utilizável */ }
  // Último recurso: isola o arquivo corrompido e segue com base limpa.
  try {
    if (fsSync.existsSync(DATA_FILE)) {
      const quarantine = `${DATA_FILE}.corrupt-${Date.now()}`;
      await fs.copyFile(DATA_FILE, quarantine);
      console.error(`[central] arquivo corrompido isolado em ${quarantine}; iniciando base limpa`);
    }
  } catch { /* ignore */ }
  return normalizeDb({});
}

// legacySaveDb atômico: grava em .tmp e faz rename (atômico no mesmo FS), evitando
// o arquivo meio-escrito que corrompia em crash/escrita concorrente. Antes de
// sobrescrever, guarda o último estado VÁLIDO em .bak (rede de segurança).
async function legacySaveDb(db) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    const current = await fs.readFile(DATA_FILE, 'utf8');
    if (parseDbText(current)) await fs.writeFile(`${DATA_FILE}.bak`, current);
  } catch { /* sem arquivo atual ainda, ou ilegível: ignora o backup */ }
  // Nome único também protege contra duas instâncias acidentalmente apontando
  // para o mesmo volume (ou uma rota não serializada no futuro).
  const tmp = `${DATA_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, DATA_FILE);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// ── Datastore plugável (item 2.10): JSON | Postgres dual-read | Postgres ──────
// Sem DRAC_CENTRAL_DATABASE_URL, loadDb/saveDb são passthrough p/ o JSON legado
// (comportamento atual, DEFAULT). Com URL, a Central lê do Postgres (dual-read cai
// para o JSON legado read-only) e escreve só no Postgres — sem tocar nas rotas.
let _datastore = null;
function getDatastore() {
  if (!_datastore) {
    _datastore = createDatastore({
      legacy: { load: legacyLoadDb, save: legacySaveDb },
      config: resolveConfig(process.env),
    });
    if (_datastore.mode !== 'json') {
      console.log(`[central] datastore em modo "${_datastore.mode}" (Postgres); JSON legado read-only.`);
    }
  }
  return _datastore;
}

async function loadDb() {
  return getDatastore().load();
}

async function saveDb(db) {
  return getDatastore().save(db);
}

function timingSafeTextEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password, encodedHash) {
  const [scheme, iterationsRaw, salt, hash] = String(encodedHash || '').split('$');
  if (scheme !== 'pbkdf2_sha256' || !iterationsRaw || !salt || !hash) return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const derived = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, 'sha256').toString('hex');
  return timingSafeTextEquals(derived, hash);
}

function hashPassword(password) {
  const iterations = 600000;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function isStrongPassword(password) {
  const value = String(password || '');
  return value.length >= 12
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value);
}

// Autentica contra o admin do .env OU um usuário cadastrado (db.users).
function authenticate(db, email, password) {
  if (ADMIN_PASSWORD_HASH && email === ADMIN_EMAIL && verifyPassword(password, ADMIN_PASSWORD_HASH)) {
    return { email: ADMIN_EMAIL, name: 'Administrador', builtin: true };
  }
  const u = db.users && db.users[email];
  if (u && verifyPassword(password, u.passwordHash)) {
    return { email, name: u.name || email, builtin: false };
  }
  return null;
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = {};
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index === -1) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionCookie(token, maxAgeSeconds) {
  const secure = String(process.env.DRAC_CENTRAL_COOKIE_SECURE || 'false').toLowerCase() === 'true' ? '; Secure' : '';
  return `drac_central_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookie() {
  return 'drac_central_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
}

function loginAttemptKey(req, email) {
  return `${clientIp(req)}:${String(email || '').trim().toLowerCase()}`;
}

function loginRateLimitStatus(req, email) {
  const key = loginAttemptKey(req, email);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    const next = { firstAt: now, count: 0 };
    loginAttempts.set(key, next);
    return { key, blocked: false, entry: next };
  }
  return { key, blocked: entry.count >= LOGIN_MAX_ATTEMPTS, entry };
}

function recordLoginFailure(key, entry) {
  entry.count += 1;
  loginAttempts.set(key, entry);
}

function resetLoginFailures(key) {
  loginAttempts.delete(key);
}

function addAuditEvent(db, req, event) {
  const auditEvents = Array.isArray(db.auditEvents) ? db.auditEvents : [];
  auditEvents.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 240),
    ...event,
  });
  while (auditEvents.length > AUDIT_HISTORY_LIMIT) auditEvents.shift();
  db.auditEvents = auditEvents;
}

function slugify(value) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return normalized || `cliente-${crypto.randomBytes(4).toString('hex')}`;
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function publicBaseUrl(req) {
  const configured = String(process.env.DRAC_CENTRAL_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim();
  const prefix = String(req.headers['x-forwarded-prefix'] || '').split(',')[0].trim().replace(/\/+$/, '');
  return `${proto}://${host}${prefix && prefix.startsWith('/') ? prefix : ''}`;
}

function buildInstallCommand({ customerName, installationId, licenseKey, serverAddress, centralUrl }) {
  return buildLegacyInstallCommand({ customerName, installationId, licenseKey, serverAddress, centralUrl });
}

function buildLegacyInstallCommand({ customerName, installationId, licenseKey, serverAddress, centralUrl }) {
  return [
    `curl -fsSL ${shellQuote(DEFAULT_INSTALLER_URL)} | \\`,
    `DRAC_CUSTOMER_NAME=${shellQuote(customerName)} \\`,
    `DRAC_INSTALLATION_ID=${shellQuote(installationId)} \\`,
    `DRAC_LICENSE_KEY=${shellQuote(licenseKey)} \\`,
    `DRAC_SERVER_IP=${shellQuote(serverAddress)} \\`,
    `DRAC_CENTRAL_URL=${shellQuote(centralUrl)} \\`,
    'DRAC_AUTO_YES=true \\',
    'bash',
  ].join('\n');
}

function buildQuickInstallCommand({ centralUrl, installationId, installerToken }) {
  return `curl -fsSL ${shellQuote(`${centralUrl}/install/${encodeURIComponent(installationId)}/${encodeURIComponent(installerToken)}`)} | bash`;
}

function buildInstallerScript(item, centralUrl) {
  const command = buildLegacyInstallCommand({
    customerName: item.customerName || item.id,
    installationId: item.id,
    licenseKey: item.licenseKey,
    serverAddress: item.provisionedServerAddress || '',
    centralUrl,
  });
  return `#!/usr/bin/env bash
set -Eeuo pipefail

${command}
`;
}

function buildInstallerResponse(item, centralUrl) {
  const installerToken = item.installerToken || crypto.randomBytes(24).toString('base64url');
  item.installerToken = installerToken;
  const installCommand = buildQuickInstallCommand({ centralUrl, installationId: item.id, installerToken });
  const fallbackInstallCommand = buildLegacyInstallCommand({
    customerName: item.customerName || item.id,
    installationId: item.id,
    licenseKey: item.licenseKey,
    serverAddress: item.provisionedServerAddress || '',
    centralUrl,
  });
  return {
    licenseKey: item.licenseKey,
    centralUrl,
    serverAddress: item.provisionedServerAddress || null,
    installCommand,
    fallbackInstallCommand,
    quickInstallUrl: `${centralUrl}/install/${encodeURIComponent(item.id)}/${encodeURIComponent(installerToken)}`,
  };
}

function cleanExpiredSessions(db) {
  const now = Date.now();
  for (const [key, session] of Object.entries(db.sessions || {})) {
    if (!session?.expiresAt || new Date(session.expiresAt).getTime() <= now) {
      delete db.sessions[key];
    }
  }
}

function getAuthenticatedUser(req, db) {
  const header = String(req.headers.authorization || '');
  // timing-safe: acertar este token é bypass TOTAL de autenticação da Central.
  if (ADMIN_TOKEN && timingSafeTextEquals(header, `Bearer ${ADMIN_TOKEN}`)) {
    return { email: 'api-token', method: 'bearer' };
  }
  cleanExpiredSessions(db);
  const token = parseCookies(req).drac_central_session;
  if (!token) return null;
  const key = sessionHash(token);
  const session = db.sessions?.[key];
  if (!session) return null;
  const expiresAt = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    delete db.sessions[key];
    return null;
  }
  session.lastSeenAt = new Date().toISOString();
  return { email: session.email, method: 'session' };
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const limit = loginRateLimitStatus(req, email);
  const db = await loadDb();
  cleanExpiredSessions(db);
  if (limit.blocked) {
    addAuditEvent(db, req, { type: 'auth.login_blocked', actor: email || 'unknown', result: 'blocked' });
    await saveDb(db);
    return json(req, res, 429, { error: 'too_many_attempts', message: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
  }
  const account = authenticate(db, email, password);
  if (!account) {
    recordLoginFailure(limit.key, limit.entry);
    addAuditEvent(db, req, { type: 'auth.login_failed', actor: email || 'unknown', result: 'denied' });
    await saveDb(db);
    return json(req, res, 401, { error: 'invalid_credentials', message: 'E-mail ou senha inválidos.' });
  }

  resetLoginFailures(limit.key);
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.sessions[sessionHash(token)] = {
    email: account.email,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  addAuditEvent(db, req, { type: 'auth.login_success', actor: account.email, result: 'accepted' });
  await saveDb(db);

  return json(
    req,
    res,
    200,
    {
      user: { email: account.email, name: account.name, role: 'ADMIN' },
      expiresAt: expiresAt.toISOString(),
    },
    { 'set-cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) },
  );
}

async function handleLogout(req, res) {
  const db = await loadDb();
  const user = getAuthenticatedUser(req, db);
  const token = parseCookies(req).drac_central_session;
  if (token) delete db.sessions[sessionHash(token)];
  addAuditEvent(db, req, { type: 'auth.logout', actor: user?.email || 'unknown', result: 'accepted' });
  await saveDb(db);
  return json(req, res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
}

async function handleMe(req, res) {
  const db = await loadDb();
  const user = getAuthenticatedUser(req, db);
  await saveDb(db);
  if (!user) return json(req, res, 200, { authenticated: false, user: null });
  return json(req, res, 200, { authenticated: true, user: { email: user.email, role: 'ADMIN', method: user.method } });
}

function metricValue(item, key, fallback = null) {
  const metrics = item.metrics || {};
  if (metrics[key] !== undefined && metrics[key] !== null) return metrics[key];
  if (key === 'cameraTotal') return metrics.cameras?.total ?? fallback;
  if (key === 'cameraOnline') return metrics.cameras?.online ?? fallback;
  if (key === 'cameraOffline') return metrics.cameras?.offline ?? fallback;
  if (key === 'cameraError') return metrics.cameras?.error ?? fallback;
  if (key === 'diskUsagePercent') return metrics.disk?.usagePercent ?? fallback;
  return fallback;
}

function alertKey(alert) {
  const code = String(alert?.code || 'generic').trim().toLowerCase();
  const message = String(alert?.message || '').trim().toLowerCase().slice(0, 120);
  return `${code}:${message}`;
}

function updateAlertHistory(existing, alerts, now) {
  const history = Array.isArray(existing.alertHistory) ? existing.alertHistory.slice() : [];
  const activeKeys = new Set(alerts.map(alertKey));
  const indexByKey = new Map(history.map((entry, index) => [entry.key, index]));

  for (const alert of alerts) {
    const key = alertKey(alert);
    const previousIndex = indexByKey.get(key);
    if (previousIndex == null) {
      history.push({
        id: crypto.randomUUID(),
        key,
        status: 'ACTIVE',
        level: alert.level || 'warning',
        code: alert.code || 'generic',
        message: alert.message || 'Alerta operacional.',
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedAt: null,
        occurrences: 1,
      });
      continue;
    }
    const entry = history[previousIndex];
    entry.status = 'ACTIVE';
    entry.level = alert.level || entry.level || 'warning';
    entry.code = alert.code || entry.code || 'generic';
    entry.message = alert.message || entry.message || 'Alerta operacional.';
    entry.lastSeenAt = now;
    entry.resolvedAt = null;
    entry.occurrences = Number(entry.occurrences || 0) + 1;
  }

  for (const entry of history) {
    if (entry.status === 'ACTIVE' && !activeKeys.has(entry.key)) {
      entry.status = 'RESOLVED';
      entry.resolvedAt = now;
    }
  }

  return history
    .sort((a, b) => new Date(b.lastSeenAt || b.firstSeenAt || 0).getTime() - new Date(a.lastSeenAt || a.firstSeenAt || 0).getTime())
    .slice(0, ALERT_HISTORY_LIMIT);
}

function publicInstallation(item) {
  const lastHeartbeatAt = item.lastHeartbeatAt ? new Date(item.lastHeartbeatAt).getTime() : 0;
  const updatedAt = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
  const ageSeconds = lastHeartbeatAt ? Math.round((Date.now() - lastHeartbeatAt) / 1000) : null;
  const policyPending = Boolean(updatedAt && lastHeartbeatAt && updatedAt > lastHeartbeatAt);
  const status = ageSeconds == null ? 'PENDING_INSTALL' : ageSeconds <= ONLINE_THRESHOLD_SECONDS ? 'ONLINE' : 'OFFLINE';
  // Nós de computação (item 3.2): campo OMITIDO quando não há nós definidos, para
  // preservar exatamente a saída atual das instalações single-primary (retrocompat).
  const computeNodes = normalizeComputeNodes(item.computeNodes);
  return {
    id: item.id,
    name: item.name,
    customerName: item.customerName,
    status,
    ageSeconds,
    licenseStatus: item.licenseStatus || LICENSE_ACTIVE,
    licenseMessage: item.licenseMessage || null,
    restrictions: licenseResponse(item).restrictions,
    policyPending,
    launchProfile: item.launchProfile || item.metrics?.launchProfile || null,
    version: item.version || null,
    lastHeartbeatAt: item.lastHeartbeatAt || null,
    metrics: item.metrics || {},
    alerts: item.alerts || [],
    alertHistory: Array.isArray(item.alertHistory) ? item.alertHistory : [],
    server: item.server || null,
    storage: item.storage || null,
    production: item.production || null,
    heartbeatHistory: Array.isArray(item.heartbeatHistory) ? item.heartbeatHistory : [],
    licenseHistory: Array.isArray(item.licenseHistory) ? item.licenseHistory.slice(-30) : [],
    provisionedAt: item.provisionedAt || null,
    provisionedBy: item.provisionedBy || null,
    provisionedServerAddress: item.provisionedServerAddress || null,
    app: item.app || null,
    updatedAt: item.updatedAt || null,
    ...(computeNodes.length ? { computeNodes } : {}),
  };
}

function fleetSummary(installations) {
  const items = installations.map(publicInstallation);
  const totals = items.reduce((acc, item) => {
    const cameraTotal = Number(metricValue(item, 'cameraTotal', 0) || 0);
    const cameraOnline = Number(metricValue(item, 'cameraOnline', 0) || 0);
    const cameraOffline = Number(metricValue(item, 'cameraOffline', 0) || 0);
    const cameraError = Number(metricValue(item, 'cameraError', 0) || 0);
    const diskUsagePercent = Number(metricValue(item, 'diskUsagePercent', 0) || 0);
    const openAlarms = Number(item.metrics?.openAlarms || 0);
    const hasAttention =
      item.status !== 'ONLINE' ||
      item.licenseStatus === 'RESTRICTED' ||
      item.licenseStatus === 'SUSPENDED' ||
      item.metrics?.productionReadiness === 'blocked' ||
      item.metrics?.productionReadiness === 'attention' ||
      cameraOffline + cameraError > 0 ||
      diskUsagePercent >= 85 ||
      openAlarms > 0;

    acc.installations += 1;
    acc.online += item.status === 'ONLINE' ? 1 : 0;
    acc.offline += item.status === 'OFFLINE' ? 1 : 0;
    acc.pendingInstall += item.status === 'PENDING_INSTALL' ? 1 : 0;
    acc.attention += hasAttention ? 1 : 0;
    acc.suspended += item.licenseStatus === 'SUSPENDED' ? 1 : 0;
    acc.restricted += item.licenseStatus === 'RESTRICTED' ? 1 : 0;
    acc.cameraTotal += cameraTotal;
    acc.cameraOnline += cameraOnline;
    acc.cameraOffline += cameraOffline;
    acc.cameraError += cameraError;
    acc.openAlarms += openAlarms;
    acc.streamHighCpuRiskCameras += Number(item.metrics?.streamHighCpuRiskCameras || 0);
    acc.streamLiveTranscodeLikely += Number(item.metrics?.streamLiveTranscodeLikely || 0);
    acc.streamLiveFailuresLast24h += Number(item.metrics?.streamLiveFailuresLast24h || 0);
    acc.streamOptimizationSafeActions += Number(item.metrics?.streamOptimizationSafeActions || 0);
    acc.recordingGapSecondsLast24h += Number(item.metrics?.recordingGapSecondsLast24h || 0);
    acc.recordingAttentionCameras += Number(item.metrics?.recordingAttentionCameras || 0);
    acc.maxDiskUsagePercent = Math.max(acc.maxDiskUsagePercent, diskUsagePercent);
    // Nós de computação (item 3.2): agregados aditivos. Sem nós → não conta como
    // "configured" (single-primary implícito) — retrocompat total do resumo.
    const nodeSummary = summarizeNodes(item.computeNodes);
    acc.computeNodesConfigured += nodeSummary.configured ? 1 : 0;
    acc.computeNodesTotal += nodeSummary.total;
    return acc;
  }, {
    installations: 0,
    online: 0,
    offline: 0,
    pendingInstall: 0,
    attention: 0,
    suspended: 0,
    restricted: 0,
    cameraTotal: 0,
    cameraOnline: 0,
    cameraOffline: 0,
    cameraError: 0,
    openAlarms: 0,
    streamHighCpuRiskCameras: 0,
    streamLiveTranscodeLikely: 0,
    streamLiveFailuresLast24h: 0,
    streamOptimizationSafeActions: 0,
    recordingGapSecondsLast24h: 0,
    recordingAttentionCameras: 0,
    maxDiskUsagePercent: 0,
    computeNodesConfigured: 0,
    computeNodesTotal: 0,
  });

  const topAttention = items
    .map((item) => {
      const diskUsagePercent = Number(metricValue(item, 'diskUsagePercent', 0) || 0);
      const cameraIssues = Number(metricValue(item, 'cameraOffline', 0) || 0) + Number(metricValue(item, 'cameraError', 0) || 0);
      const openAlarms = Number(item.metrics?.openAlarms || 0);
      let score = 0;
      if (item.status !== 'ONLINE') score += item.status === 'PENDING_INSTALL' ? 45 : 100;
      if (item.licenseStatus === 'SUSPENDED') score += 90;
      if (item.licenseStatus === 'RESTRICTED') score += 45;
      if (item.metrics?.productionReadiness === 'blocked') score += 80;
      if (item.metrics?.productionReadiness === 'attention') score += 30;
      if (cameraIssues) score += 35;
      if (diskUsagePercent >= 85) score += 30;
      if (openAlarms) score += 10;
      return {
        id: item.id,
        customerName: item.customerName || item.name || item.id,
        status: item.status,
        licenseStatus: item.licenseStatus,
        productionReadiness: item.metrics?.productionReadiness || item.metrics?.status || 'unknown',
        diskUsagePercent,
        cameraIssues,
        openAlarms,
        ageSeconds: item.ageSeconds,
        score,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    onlineThresholdSeconds: ONLINE_THRESHOLD_SECONDS,
    totals,
    topAttention,
  };
}

function supportDiagnostics(item) {
  const publicItem = publicInstallation(item);
  const activeAlerts = (publicItem.alertHistory || []).filter((alert) => alert.status === 'ACTIVE').slice(0, 20);
  return {
    generatedAt: new Date().toISOString(),
    installation: {
      id: publicItem.id,
      customerName: publicItem.customerName,
      status: publicItem.status,
      ageSeconds: publicItem.ageSeconds,
      licenseStatus: publicItem.licenseStatus,
      policyPending: publicItem.policyPending,
      version: publicItem.version,
      launchProfile: publicItem.launchProfile,
      lastHeartbeatAt: publicItem.lastHeartbeatAt,
    },
    readiness: {
      status: publicItem.metrics?.productionReadiness || publicItem.metrics?.status || 'unknown',
      checks: publicItem.metrics?.readiness?.checks ?? null,
      warnings: publicItem.metrics?.readiness?.warnings ?? null,
      failures: publicItem.metrics?.readiness?.failures ?? null,
      lastError: publicItem.metrics?.lastError || null,
    },
    cameras: {
      total: metricValue(publicItem, 'cameraTotal', 0),
      online: metricValue(publicItem, 'cameraOnline', 0),
      offline: metricValue(publicItem, 'cameraOffline', 0),
      error: metricValue(publicItem, 'cameraError', 0),
    },
    storage: publicItem.storage?.disk ? {
      usedBytes: publicItem.storage.disk.usedBytes,
      totalBytes: publicItem.storage.disk.totalBytes,
      usagePercent: publicItem.storage.disk.usagePercent ?? metricValue(publicItem, 'diskUsagePercent', null),
    } : null,
    server: publicItem.server ? {
      hostname: publicItem.server.hostname,
      platform: publicItem.server.platform,
      cpuCount: publicItem.server.cpuCount,
      totalMemoryBytes: publicItem.server.totalMemoryBytes,
      freeMemoryBytes: publicItem.server.freeMemoryBytes,
      loadAverage: publicItem.server.loadAverage,
    } : null,
    alerts: activeAlerts.map((alert) => ({
      level: alert.level,
      code: alert.code,
      message: alert.message,
      firstSeenAt: alert.firstSeenAt,
      lastSeenAt: alert.lastSeenAt,
      occurrences: alert.occurrences,
    })),
    lastHeartbeats: (publicItem.heartbeatHistory || []).slice(-10),
  };
}

function licenseResponse(item) {
  const status = item.licenseStatus || LICENSE_ACTIVE;
  const restrictions = {
    adminAccess: true,
    cloudSupport: status !== 'SUSPENDED',
    updates: status === 'ACTIVE' || status === 'GRACE',
    addCameras: status !== 'RESTRICTED' && status !== 'SUSPENDED',
    aiAdvanced: status === 'ACTIVE' || status === 'GRACE',
    exports: true,
    localLive: status !== 'SUSPENDED',
    localPlayback: true,
    localRecording: status !== 'SUSPENDED',
  };
  return {
    licenseStatus: status,
    licenseMessage: item.licenseMessage || null,
    restrictions,
  };
}

async function handleHeartbeat(req, res) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  if (!installationId || !licenseKey) {
    return json(req, res, 401, { error: 'missing_installation_or_license' });
  }

  const body = await readBody(req);
  const db = await loadDb();
  const existing = db.installations[installationId];
  // A instalação TEM de existir: handleProvision a cria (com licenseKey) antes de o
  // cliente dar o primeiro heartbeat. Antes, um id desconhecido caía em `{}` e o check
  // de licença era pulado (`existing.licenseKey` undefined) → QUALQUER UM na internet
  // registrava instalações e injetava `metrics`/`server` arbitrários, que o painel do
  // dono renderiza (era o vetor do XSS armazenado) — além de encher o installations.json.
  if (!existing) {
    addAuditEvent(db, req, { type: 'agent.heartbeat_denied', actor: installationId, result: 'denied' });
    await saveDb(db);
    return json(req, res, 403, { error: 'unknown_installation' });
  }
  const expectedKey = existing.licenseKey || licenseKey;
  // timing-safe, como já era em handleAgentStatus/handleInstall.
  if (existing.licenseKey && !timingSafeTextEquals(existing.licenseKey, licenseKey)) {
    addAuditEvent(db, req, { type: 'agent.heartbeat_denied', actor: installationId, result: 'denied' });
    await saveDb(db);
    return json(req, res, 403, { error: 'invalid_license_key' });
  }

  const now = new Date().toISOString();
  const metrics = body.summary || body.metrics || {};
  const alerts = Array.isArray(metrics.alerts) ? metrics.alerts : Array.isArray(body.alerts) ? body.alerts : [];
  const memoryUsagePercent = body.server?.totalMemoryBytes
    ? Math.round(((Number(body.server.totalMemoryBytes) - Number(body.server.freeMemoryBytes || 0)) / Number(body.server.totalMemoryBytes)) * 100)
    : null;
  const heartbeatHistory = Array.isArray(existing.heartbeatHistory) ? existing.heartbeatHistory : [];
  heartbeatHistory.push({
    at: now,
    status: metrics.status || 'ok',
    cameraTotal: Number(metricValue({ metrics }, 'cameraTotal', 0)),
    cameraOnline: Number(metricValue({ metrics }, 'cameraOnline', 0)),
    cameraOffline: Number(metricValue({ metrics }, 'cameraOffline', 0)),
    cameraError: Number(metricValue({ metrics }, 'cameraError', 0)),
    openAlarms: Number(metrics.openAlarms || 0),
    diskUsagePercent: metrics.diskUsagePercent ?? metrics.disk?.usagePercent ?? null,
    memoryUsagePercent,
    load1: Array.isArray(body.server?.loadAverage) ? body.server.loadAverage[0] ?? null : null,
    recordingCount: Number(metrics.recordingCount || 0),
    activeRecordingCount: Number(metrics.activeRecordingCount || 0),
    streamHighCpuRiskCameras: Number(metrics.streamHighCpuRiskCameras || 0),
    streamLiveTranscodeLikely: Number(metrics.streamLiveTranscodeLikely || 0),
    streamLiveFailuresLast24h: Number(metrics.streamLiveFailuresLast24h || 0),
    streamMediaMtxReaders: Number(metrics.streamMediaMtxReaders || 0),
    streamOptimizationSafeActions: Number(metrics.streamOptimizationSafeActions || 0),
    recordingGapSecondsLast24h: Number(metrics.recordingGapSecondsLast24h || 0),
    recordingAttentionCameras: Number(metrics.recordingAttentionCameras || 0),
    activeUsers: Number(metrics.activeUsers || 0),
  });
  while (heartbeatHistory.length > HEARTBEAT_HISTORY_LIMIT) heartbeatHistory.shift();
  const alertHistory = updateAlertHistory(existing, alerts, now);
  const item = {
    ...existing,
    id: installationId,
    licenseKey: expectedKey,
    // IP de onde o cliente envia heartbeat — usado p/ derivar o servidor da API
    // ao gerar o app automaticamente, quando não há endereço cadastrado.
    observedAddress: clientIp(req) || existing.observedAddress || null,
    reportedApiUrl: body.installation?.apiUrl || body.apiUrl || existing.reportedApiUrl || null,
    name: body.installation?.name || existing.name || installationId,
    customerName: body.installation?.customerName || existing.customerName || null,
    launchProfile: body.installation?.launchProfile || metrics.launchProfile || existing.launchProfile || null,
    version: body.installation?.version || existing.version || null,
    lastHeartbeatAt: now,
    updatedAt: now,
    metrics,
    alerts: alerts.slice(0, 100),
    alertHistory,
    server: body.server || existing.server || null,
    storage: body.storage || existing.storage || null,
    production: body.production || existing.production || null,
    heartbeatHistory,
    lastPayloadHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    licenseStatus: existing.licenseStatus || LICENSE_ACTIVE,
    licenseMessage: existing.licenseMessage || null,
  };
  db.installations[installationId] = item;
  await saveDb(db);
  return json(req, res, 200, {
    accepted: true,
    serverTime: now,
    ...licenseResponse(item),
  });
}

async function handleAgentStatus(req, res) {
  const installationId = String(req.headers['x-drac-installation-id'] || '').trim();
  const licenseKey = String(req.headers['x-drac-license-key'] || '').trim();
  if (!installationId || !licenseKey) {
    return json(req, res, 401, { error: 'missing_installation_or_license' });
  }

  const db = await loadDb();
  const item = db.installations[installationId];
  if (!item) {
    return json(req, res, 404, { error: 'installation_not_found' });
  }
  if (!timingSafeTextEquals(item.licenseKey || '', licenseKey)) {
    addAuditEvent(db, req, { type: 'agent.status_denied', actor: installationId, result: 'denied' });
    await saveDb(db);
    return json(req, res, 403, { error: 'invalid_license_key' });
  }

  const lastHeartbeatAt = item.lastHeartbeatAt || null;
  const ageSeconds = lastHeartbeatAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000))
    : null;
  return json(req, res, 200, {
    accepted: true,
    installationId,
    customerName: item.customerName || null,
    lastHeartbeatAt,
    heartbeatAgeSeconds: ageSeconds,
    online: ageSeconds !== null && ageSeconds <= ONLINE_THRESHOLD_SECONDS,
    ...licenseResponse(item),
  });
}

async function handleProvision(req, res, db, actor) {
  const body = await readBody(req);
  const customerName = String(body.customerName || '').trim();
  const requestedId = String(body.installationId || '').trim();
  const serverAddress = String(body.serverAddress || '').trim();
  const notes = String(body.notes || '').trim();

  if (!customerName) return json(req, res, 400, { error: 'missing_customer_name', message: 'Informe o nome do cliente.' });

  const installationId = slugify(requestedId || customerName);
  const existing = db.installations[installationId];
  if (existing?.lastHeartbeatAt) {
    return json(req, res, 409, {
      error: 'installation_already_active',
      message: 'Esta instalação já recebeu heartbeat. Use outro código ou edite o cliente existente.',
    });
  }

  const now = new Date().toISOString();
  const licenseKey = existing?.licenseKey || `drac-${crypto.randomBytes(16).toString('hex')}`;
  const centralUrl = publicBaseUrl(req);

  const item = {
    ...existing,
    id: installationId,
    name: installationId,
    customerName,
    licenseKey,
    installerToken: existing?.installerToken || crypto.randomBytes(24).toString('base64url'),
    licenseStatus: existing?.licenseStatus || LICENSE_ACTIVE,
    licenseMessage: existing?.licenseMessage || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    provisionedAt: now,
    provisionedBy: actor.email,
    provisionedServerAddress: serverAddress || null,
    provisionNotes: notes || null,
    metrics: existing?.metrics || {},
    alerts: existing?.alerts || [],
    alertHistory: Array.isArray(existing?.alertHistory) ? existing.alertHistory : [],
    heartbeatHistory: Array.isArray(existing?.heartbeatHistory) ? existing.heartbeatHistory : [],
    licenseHistory: Array.isArray(existing?.licenseHistory) ? existing.licenseHistory : [],
  };
  const installer = buildInstallerResponse(item, centralUrl);
  item.lastInstallerCommandHash = crypto.createHash('sha256').update(installer.fallbackInstallCommand).digest('hex');
  db.installations[installationId] = item;
  addAuditEvent(db, req, {
    type: existing ? 'installation.provision_regenerated' : 'installation.provision_created',
    actor: actor.email,
    result: 'accepted',
    installationId,
  });
  await saveDb(db);

  return json(req, res, 201, {
    installation: publicInstallation(item),
    ...installer,
  });
}

async function handleGetInstallerCommand(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const centralUrl = publicBaseUrl(req);
  const installer = buildInstallerResponse(item, centralUrl);
  item.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'installation.installer_command_viewed',
    actor: actor.email,
    result: 'accepted',
    installationId,
  });
  await saveDb(db);
  return json(req, res, 200, {
    installation: publicInstallation(item),
    ...installer,
  });
}

async function handleQuickInstaller(req, res, installationId, installerToken) {
  const db = await loadDb();
  const item = db.installations[installationId];
  if (!item || !item.installerToken || !timingSafeTextEquals(item.installerToken, installerToken)) {
    addAuditEvent(db, req, { type: 'installation.installer_denied', actor: installationId, result: 'denied', installationId });
    await saveDb(db);
    return text(req, res, 404, 'Instalador nao encontrado.\n');
  }
  const centralUrl = publicBaseUrl(req);
  addAuditEvent(db, req, { type: 'installation.installer_downloaded', actor: installationId, result: 'accepted', installationId });
  await saveDb(db);
  return text(req, res, 200, buildInstallerScript(item, centralUrl), 'text/x-shellscript; charset=utf-8');
}

async function serveStatic(req, res) {
  const file = req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '');
  const safe = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(PUBLIC_DIR, safe);
  try {
    const data = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : 'application/javascript';
    text(req, res, 200, data, type);
  } catch {
    text(req, res, 404, 'not found');
  }
}

// ── Proxy para o build-agent (geração de APK) ───────────────────────────────
async function agentFetch(pathname, init = {}) {
  if (!APP_BUILDER_AGENT_URL) {
    const err = new Error('Build-agent não configurado (APP_BUILDER_AGENT_URL vazio).');
    err.statusCode = 503;
    throw err;
  }
  const res = await fetch(`${APP_BUILDER_AGENT_URL}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-build-token': APP_BUILDER_AGENT_TOKEN,
      ...(init.headers || {}),
    },
  });
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  return { status: res.status, data };
}

async function artifactFetch(pathname) {
  try {
    return await fetch(`${APK_SOURCE_BASE}${pathname}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error(`[central] fonte de artefatos indisponível para ${pathname}:`, error?.cause?.code || error?.name || 'fetch_failed');
    return null;
  }
}

// ── Geração automática de app por cliente ────────────────────────────────────
function clientIp(req) {
  // X-Real-IP é setado pelo nginx com $remote_addr e SOBRESCRITO a cada request — o
  // cliente não consegue forjá-lo. Já o X-Forwarded-For é `$proxy_add_x_forwarded_for`
  // (o nginx ANEXA o IP real ao FINAL), então o primeiro elemento é o que o atacante
  // mandou: usá-lo permitia zerar o bucket do rate limit de login a cada tentativa
  // (a chave é `${clientIp}:${email}`) e envenenar o IP da trilha de auditoria.
  const realIp = String(req?.headers?.['x-real-ip'] || '').trim();
  const ip = realIp || req?.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

// Converte um endereço (host, host:porta ou URL) na URL da API do DRAC. Layout
// padrão: web/API atrás do nginx em :5173 com a API em /api.
function addrToApiUrl(addr) {
  let a = String(addr || '').trim();
  if (!a) return '';
  if (/^https?:\/\//i.test(a)) return a.replace(/\/+$/, '').replace(/\/api$/i, '') + '/api';
  if (/:\d+$/.test(a)) return `http://${a}/api`;
  return `http://${a}:5173/api`;
}

// Endereço privado/loopback/Docker — NÃO serve p/ um celular acessar.
function isPrivateHost(addr) {
  const h = String(addr || '').replace(/^https?:\/\//i, '').split(/[:/]/)[0].trim();
  if (!h) return true;
  if (h === 'localhost' || h === '::1') return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

// Descobre a URL da API do cliente. PRIORIZA endereço PÚBLICO (alcançável pelo
// celular). O IP de origem do heartbeat costuma ser interno do Docker
// (172.17.0.1) — inútil p/ o app; por isso só entra como último recurso.
// Override manual (definido na edição do app) sempre vence.
function deriveClientApiUrl(item) {
  const override = item.app && item.app.apiUrlOverride;
  if (override) return addrToApiUrl(override);

  const candidates = [item.reportedApiUrl, item.provisionedServerAddress, item.observedAddress].filter(Boolean);
  const m = String(item.id || '').match(/(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/);
  const idIp = m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : null;

  for (const c of candidates) if (!isPrivateHost(c)) return addrToApiUrl(c); // público reportado
  if (idIp && !isPrivateHost(idIp)) return addrToApiUrl(idIp);               // IP público do id
  if (candidates.length) return addrToApiUrl(candidates[0]);                 // rede local (fallback)
  if (idIp) return addrToApiUrl(idIp);
  return '';
}

// Slug estável e único por instalação (1 app por cliente). a-z 0-9 -, máx 39.
function deriveAppSlug(item) {
  let s = String(item.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (s.length < 2) s = `app-${s || 'cliente'}`;
  return s.slice(0, 39);
}

// Segmento de package Android válido a partir de um texto livre.
function sanitizePkgSegment(s) {
  let seg = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!seg) seg = 'app';
  if (!/^[a-z]/.test(seg)) seg = `a${seg}`;
  return seg.slice(0, 40);
}

// Package ID padrão LIMPO, derivado do NOME do cliente (não do id com IP).
// Ex.: "DRAC Local" → com.ajustconsulting.draclocal. Editável por cliente.
function deriveAppPackageId(item) {
  return `com.ajustconsulting.${sanitizePkgSegment(item.customerName || item.name || item.id)}`;
}

const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

// Nome e package efetivos (override do usuário tem prioridade sobre o padrão).
function effectiveAppName(item) {
  return (item.app && item.app.appName) || item.customerName || item.name || deriveAppSlug(item);
}
function effectiveAppPackageId(item) {
  return (item.app && item.app.packageId) || deriveAppPackageId(item);
}

// Nome de arquivo seguro p/ o download (ASCII), derivado do nome do app.
function safeApkFilename(name) {
  let n = String(name || 'app').normalize('NFKD').replace(/[^\w.\- ]/g, '').trim().replace(/\s+/g, '-');
  return `${n || 'app'}.apk`;
}

async function fetchClientBranding(apiUrl) {
  try {
    const res = await fetch(`${apiUrl}/settings/branding`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Monta o cliente no build-agent a partir do cadastro do cliente + puxa logo/cor
// do próprio sistema dele, e dispara o build. SEM digitação manual.
// Usada tanto pela geração inicial quanto pelo rebuild automático após edição
// (ver handlePatchApp) — os dois caminhos precisam mandar o MESMO payload pro
// build-agent, senão uma edição salva na Central nunca chega no APK.
async function pushAppToBuildAgent(item, actor, req, db, installationId) {
  const apiUrl = deriveClientApiUrl(item);
  if (!apiUrl) {
    return {
      status: 400,
      data: {
        error: 'no_server_address',
        message: 'A Central ainda não conhece o servidor deste cliente. Provisione pela aba Instalação ou aguarde o primeiro heartbeat.',
      },
    };
  }
  const slug = deriveAppSlug(item);
  const appName = effectiveAppName(item);
  const packageId = effectiveAppPackageId(item);
  const branding = await fetchClientBranding(apiUrl);
  const payload = { slug, appName, apiUrl, packageId };
  if (branding) {
    if (branding.brandPrimaryColor) payload.primaryColor = branding.brandPrimaryColor;
    if (branding.brandLogoDataUrl) payload.logoBase64 = branding.brandLogoDataUrl;
  }
  const created = await agentFetch('/clients', { method: 'POST', body: JSON.stringify(payload) });
  if (created.status >= 400) return { status: created.status, data: created.data };
  const build = await agentFetch('/builds', { method: 'POST', body: JSON.stringify({ slug }) });
  addAuditEvent(db, req, { type: 'apk.build_started', actor: actor.email, result: build.status < 400 ? 'accepted' : 'denied', installationId });
  item.app = { ...(item.app || {}), slug, apiUrl, appName, packageId, brandingApplied: !!branding, lastBuildJobId: build.data?.jobId || null, lastBuildAt: new Date().toISOString() };
  return { status: build.status, data: { slug, apiUrl, packageId, brandingApplied: !!branding, ...build.data } };
}

async function handleGenerateApp(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const result = await pushAppToBuildAgent(item, actor, req, db, installationId);
  await saveDb(db);
  return json(req, res, result.status, result.data);
}

// Edita nome de exibição, package ID e/ou servidor do app. Se o app já tinha
// sido gerado antes, dispara rebuild automaticamente — do contrário a edição
// fica só no banco da Central e o APK instalado continua com o valor antigo
// (bug relatado: servidor/nome/cor corrigidos na tela mas nunca aplicados).
async function handlePatchApp(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  const appName = String(body.appName || '').trim();
  const packageId = String(body.packageId || '').trim();
  const apiUrl = String(body.apiUrl || '').trim();
  if (packageId && !PKG_RE.test(packageId)) {
    return json(req, res, 400, { error: 'invalid_package', message: 'Pacote inválido. Use o formato com.empresa.app (letras, números, pontos).' });
  }
  // O `.+` de antes aceitava aspas/espaço/qualquer coisa após o esquema. Este valor desce
  // até o build-client.sh, que roda no HOST com as keystores — restringe o charset ao que
  // é URL de verdade (mesmo formato validado pelo build-agent).
  if (apiUrl && !/^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(apiUrl) && !/^[a-z0-9.-]+(:\d+)?$/i.test(apiUrl)) {
    return json(req, res, 400, { error: 'invalid_apiurl', message: 'Servidor inválido. Use um domínio/IP (ex.: 168.194.13.70) ou URL completa.' });
  }
  item.app = item.app || { slug: deriveAppSlug(item), apiUrl: deriveClientApiUrl(item) };
  const hadBuild = !!item.app.lastBuildAt;
  if (appName) item.app.appName = appName;
  if (packageId) item.app.packageId = packageId;
  if (apiUrl) item.app.apiUrlOverride = addrToApiUrl(apiUrl); // override manual do servidor
  addAuditEvent(db, req, { type: 'apk.app_edited', actor: actor.email, result: 'accepted', installationId });

  let rebuild = null;
  if (hadBuild) rebuild = await pushAppToBuildAgent(item, actor, req, db, installationId);
  await saveDb(db);
  if (rebuild && rebuild.status >= 400) {
    return json(req, res, rebuild.status, { ...rebuild.data, appName: effectiveAppName(item), packageId: effectiveAppPackageId(item), apiUrl: deriveClientApiUrl(item) });
  }
  return json(req, res, 200, {
    app: item.app,
    appName: effectiveAppName(item),
    packageId: effectiveAppPackageId(item),
    apiUrl: deriveClientApiUrl(item),
    rebuildTriggered: !!rebuild,
    rebuild: rebuild ? rebuild.data : null,
  });
}

// ── Nós de computação por instalação (item 3.2) ──────────────────────────────
// Gerência dos nós como DADO, seguindo o mesmo padrão da PATCH de licença: mesma
// sessão/admin do bloco /api/admin, valida ANTES de salvar, escreve no datastore
// plugável (JSON/PG) sem tabela nova (os nós vivem no objeto da instalação).
// Corpo vazio / [] volta ao single-primary implícito (remove o campo) — INERTE.
async function handlePatchComputeNodes(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  const nodes = normalizeComputeNodes(body.computeNodes);
  const validation = validateComputeNodes(nodes);
  if (!validation.valid) {
    return json(req, res, 400, { error: 'invalid_compute_nodes', details: validation.errors });
  }
  const previousCount = normalizeComputeNodes(item.computeNodes).length;
  if (nodes.length === 0) {
    // Ausência = single-primary implícito. Remove o campo em vez de gravar [] para
    // manter o registro idêntico ao de uma instalação que nunca definiu nós.
    delete item.computeNodes;
  } else {
    item.computeNodes = nodes;
  }
  item.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, {
    type: 'installation.compute_nodes_changed',
    actor: actor.email,
    result: 'accepted',
    installationId,
    from: previousCount,
    to: nodes.length,
  });
  await saveDb(db);
  return json(req, res, 200, publicInstallation(item));
}

async function handleInstallationApp(req, res, db, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const slug = deriveAppSlug(item);
  let client = null;
  try {
    const r = await agentFetch('/clients');
    client = (r.data?.clients || []).find((c) => c.slug === slug) || null;
  } catch { /* agente indisponível */ }
  return json(req, res, 200, {
    slug,
    apiUrl: deriveClientApiUrl(item),
    appName: effectiveAppName(item),
    packageId: effectiveAppPackageId(item),
    client,
  });
}

// ── Instalação remota via SSH ────────────────────────────────────────────────
// Monta o comando de instalação numa única linha (para `conn.exec`). Em Debian/
// Ubuntu instala o curl se faltar; outras distros precisam de curl pré-instalado.
function buildRemoteInstallCommand(item, centralUrl) {
  const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
  const envs = [
    `DRAC_CUSTOMER_NAME=${q(item.customerName || item.id)}`,
    `DRAC_INSTALLATION_ID=${q(item.id)}`,
    `DRAC_LICENSE_KEY=${q(item.licenseKey)}`,
    `DRAC_CENTRAL_URL=${q(centralUrl)}`,
    `DRAC_SERVER_IP=${q(item.provisionedServerAddress || '')}`,
    'DRAC_AUTO_YES=true',
  ].join(' ');
  const ensureCurl = '(command -v curl >/dev/null 2>&1 || (apt-get update -y && apt-get install -y curl))';
  return `${ensureCurl} && curl -fsSL ${q(DEFAULT_INSTALLER_URL)} | ${envs} bash`;
}

function appendInstallLog(job, chunk, secrets = []) {
  let text = String(chunk);
  for (const s of secrets) {
    if (s) text = text.split(s).join('••••••');
  }
  job.log += text;
  if (job.log.length > 200_000) job.log = job.log.slice(-200_000);
}

function pruneRemoteInstalls() {
  if (remoteInstalls.size <= REMOTE_INSTALL_KEEP) return;
  const ids = [...remoteInstalls.keys()];
  for (const id of ids.slice(0, ids.length - REMOTE_INSTALL_KEEP)) remoteInstalls.delete(id);
}

// Executa a instalação via SSH. A SENHA é usada de forma transitória e NUNCA é
// gravada (nem no log, nem no banco). Atualiza job.status e o log em streaming.
function runRemoteInstall(job, conn, opts, command) {
  const { Client } = require('ssh2');
  job.status = 'running';
  appendInstallLog(job, `>> conectando em ${opts.username}@${opts.host}:${opts.port}…\n`);

  const client = conn || new Client();
  const finish = (status, code) => {
    if (job.status === 'done' || job.status === 'failed') return;
    job.status = status;
    job.exitCode = code ?? null;
    job.finishedAt = new Date().toISOString();
    try { client.end(); } catch { /* ignore */ }
  };

  client
    .on('ready', () => {
      appendInstallLog(job, '>> conectado. iniciando instalador…\n');
      client.exec(command, { pty: true }, (err, stream) => {
        if (err) {
          appendInstallLog(job, `>> erro ao executar: ${err.message}\n`);
          return finish('failed', null);
        }
        stream
          .on('close', (code) => {
            appendInstallLog(job, `\n>> instalador finalizou com código ${code}.\n`);
            finish(code === 0 ? 'done' : 'failed', code);
          })
          .on('data', (d) => appendInstallLog(job, d, [opts.password]))
          .stderr.on('data', (d) => appendInstallLog(job, d, [opts.password]));
      });
    })
    .on('error', (err) => {
      appendInstallLog(job, `>> falha de conexão SSH: ${err.message}\n`);
      finish('failed', null);
    })
    .connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      readyTimeout: 20_000,
      // TOFU DE VERDADE. Antes o comentário dizia "TOFU" mas nada era guardado nem
      // comparado — na prática aceitava QUALQUER host key, ou seja, a senha ROOT do
      // servidor do cliente ia para quem respondesse naquele IP (MITM, DNS envenenado,
      // IP reciclado). Agora: 1ª conexão aprende e persiste a fingerprint; nas seguintes,
      // divergência ABORTA antes de enviar a senha.
      hostVerifier: (key) => {
        const fingerprint = crypto.createHash('sha256').update(key).digest('base64');
        if (opts.knownHostKey) {
          if (timingSafeTextEquals(opts.knownHostKey, fingerprint)) return true;
          appendInstallLog(
            job,
            `>> ABORTADO: a host key SSH deste servidor MUDOU (esperada SHA256:${opts.knownHostKey}, ` +
              `recebida SHA256:${fingerprint}). Pode ser man-in-the-middle. Se a troca foi legítima ` +
              `(reinstalação do servidor), limpe a chave conhecida na instalação e tente de novo.\n`,
          );
          return false;
        }
        appendInstallLog(job, `>> host key aprendida (SHA256:${fingerprint}) — será exigida nas próximas conexões.\n`);
        if (typeof opts.onLearnHostKey === 'function') opts.onLearnHostKey(fingerprint);
        return true;
      },
      algorithms: undefined,
    });
}

async function handleRemoteInstall(req, res, db, actor, installationId) {
  const item = db.installations[installationId];
  if (!item) return json(req, res, 404, { error: 'installation_not_found' });
  const body = await readBody(req);
  const host = String(body.host || item.provisionedServerAddress || '').trim();
  const port = Number(body.port || 22);
  const username = String(body.username || 'root').trim();
  const password = String(body.password || '');
  if (!host) return json(req, res, 400, { error: 'missing_host', message: 'Informe o endereço/IP do servidor.' });
  if (!password) return json(req, res, 400, { error: 'missing_password', message: 'Informe a senha de acesso (root).' });

  const centralUrl = publicBaseUrl(req);
  const command = buildRemoteInstallCommand(item, centralUrl);
  const jobId = `${Date.now()}-${installationId}`;
  const job = {
    id: jobId,
    installationId,
    host,
    username,
    status: 'queued',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
  };
  remoteInstalls.set(jobId, job);
  pruneRemoteInstalls();

  // Marca tentativa + auditoria (sem credenciais).
  item.remoteInstall = { jobId, host, username, startedAt: job.startedAt, startedBy: actor.email };
  item.updatedAt = new Date().toISOString();
  addAuditEvent(db, req, { type: 'installation.remote_install_started', actor: actor.email, result: 'accepted', installationId });
  await saveDb(db);

  // TOFU da host key SSH: guardada por host:porta (um mesmo cliente pode trocar de
  // servidor, e servidores diferentes têm chaves diferentes).
  const hostKeyId = `${host}:${port}`;
  const knownHostKey = (item.sshHostKeys || {})[hostKeyId] || null;
  const onLearnHostKey = (fingerprint) => {
    void (async () => {
      try {
        const fresh = await loadDb();
        const target = fresh.installations[installationId];
        if (!target) return;
        target.sshHostKeys = { ...(target.sshHostKeys || {}), [hostKeyId]: fingerprint };
        await saveDb(fresh);
      } catch {
        /* aprender a chave é best-effort: não deve derrubar a instalação em curso */
      }
    })();
  };

  // Dispara em background; o cliente acompanha por GET /remote-installs/:id.
  runRemoteInstall(job, null, { host, port, username, password, knownHostKey, onLearnHostKey }, command);

  return json(req, res, 202, { jobId, status: job.status });
}

function publicRemoteInstall(job) {
  if (!job) return null;
  return {
    id: job.id,
    installationId: job.installationId,
    host: job.host,
    username: job.username,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    log: job.log,
  };
}

// ── Usuários da Central (multi-admin) ────────────────────────────────────────
function publicUsers(db) {
  const out = [{ email: ADMIN_EMAIL, name: 'Administrador', builtin: true }];
  for (const [email, u] of Object.entries(db.users || {})) {
    out.push({ email, name: u.name || email, builtin: false, createdAt: u.createdAt || null, createdBy: u.createdBy || null });
  }
  return out;
}
async function handleListUsers(req, res, db) {
  await saveDb(db);
  return json(req, res, 200, { users: publicUsers(db), adminEmail: ADMIN_EMAIL });
}
async function handleUpsertUser(req, res, db, actor) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, res, 400, { error: 'invalid_email', message: 'E-mail inválido.' });
  if (email === ADMIN_EMAIL) return json(req, res, 400, { error: 'reserved_email', message: 'Este e-mail é o administrador do sistema (definido no servidor) e não é editável aqui.' });
  if (password && !isStrongPassword(password)) return json(req, res, 400, { error: 'weak_password', message: 'Use ao menos 12 caracteres, com maiúscula, minúscula e número.' });
  db.users = db.users || {};
  const existing = db.users[email];
  if (!existing && !password) return json(req, res, 400, { error: 'password_required', message: 'Defina uma senha para o novo usuário.' });
  db.users[email] = {
    name: name || (existing && existing.name) || email,
    passwordHash: password ? hashPassword(password) : existing.passwordHash,
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    createdBy: (existing && existing.createdBy) || actor.email,
  };
  addAuditEvent(db, req, { type: existing ? 'user.updated' : 'user.created', actor: actor.email, result: 'accepted', installationId: email });
  await saveDb(db);
  return json(req, res, 200, { ok: true });
}
async function handleDeleteUser(req, res, db, actor, emailRaw) {
  const email = String(emailRaw || '').toLowerCase();
  if (email === ADMIN_EMAIL) return json(req, res, 400, { error: 'reserved_email', message: 'Não é possível remover o administrador do sistema.' });
  if (email === actor.email) return json(req, res, 400, { error: 'self_delete', message: 'Você não pode remover a própria conta logada.' });
  if (!db.users || !db.users[email]) return json(req, res, 404, { error: 'user_not_found' });
  delete db.users[email];
  addAuditEvent(db, req, { type: 'user.deleted', actor: actor.email, result: 'accepted', installationId: email });
  await saveDb(db);
  return json(req, res, 200, { ok: true });
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return empty(req, res, 204);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(req, res, 200, { status: 'ok', service: 'drac-central', time: new Date().toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      return empty(req, res, 204);
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      return handleLogin(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      return handleLogout(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      return handleMe(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
      return handleHeartbeat(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/agent/status') {
      return handleAgentStatus(req, res);
    }
    const installerMatch = url.pathname.match(/^\/install\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && installerMatch) {
      return handleQuickInstaller(req, res, decodeURIComponent(installerMatch[1]), decodeURIComponent(installerMatch[2]));
    }
    if (url.pathname.startsWith('/api/admin/')) {
      const db = await loadDb();
      const actor = getAuthenticatedUser(req, db);
      if (!actor) {
        await saveDb(db);
        return json(req, res, 401, { error: 'unauthorized' });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/installations') {
        await saveDb(db);
        return json(req, res, 200, { items: Object.values(db.installations).map(publicInstallation) });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
        await saveDb(db);
        return json(req, res, 200, fleetSummary(Object.values(db.installations)));
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/provision') {
        return handleProvision(req, res, db, actor);
      }

      // ── Usuários da Central ────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/admin/users') {
        return handleListUsers(req, res, db);
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/users') {
        return handleUpsertUser(req, res, db, actor);
      }
      const userDelMatch = url.pathname.match(/^\/api\/admin\/users\/(.+)$/);
      if (req.method === 'DELETE' && userDelMatch) {
        return handleDeleteUser(req, res, db, actor, decodeURIComponent(userDelMatch[1]));
      }

      // ── Geração de APK (proxy para o build-agent) ──────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/admin/apk/clients') {
        await saveDb(db);
        const r = await agentFetch('/clients');
        return json(req, res, r.status, r.data);
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/apk/clients') {
        const body = await readBody(req);
        await saveDb(db);
        const r = await agentFetch('/clients', { method: 'POST', body: JSON.stringify(body) });
        addAuditEvent(db, req, { type: 'apk.client_upserted', actor: actor.email, result: r.status < 400 ? 'accepted' : 'denied', installationId: body.slug || null });
        await saveDb(db);
        return json(req, res, r.status, r.data);
      }
      const apkDeleteMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)$/);
      if (req.method === 'DELETE' && apkDeleteMatch) {
        const slug = decodeURIComponent(apkDeleteMatch[1]);
        const r = await agentFetch(`/clients/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        // Apaga o BUILD, mas PRESERVA as preferências do usuário (nome, pacote e
        // servidor). Antes zerávamos `inst.app = null`, o que fazia o app voltar
        // ao nome padrão do cliente (ex.: "DRAC Local") ao regenerar — perdendo
        // o "Ibtelecom" que o usuário tinha definido. Agora só limpamos o estado
        // de build; effectiveAppName/PackageId/deriveClientApiUrl continuam
        // enxergando as escolhas salvas.
        for (const inst of Object.values(db.installations)) {
          if (inst.app && inst.app.slug === slug) {
            const { appName, packageId, apiUrlOverride } = inst.app;
            inst.app = (appName || packageId || apiUrlOverride)
              ? { appName, packageId, apiUrlOverride }
              : null;
          }
        }
        addAuditEvent(db, req, { type: 'apk.client_deleted', actor: actor.email, result: r.status < 400 ? 'accepted' : 'denied', installationId: slug });
        await saveDb(db);
        return json(req, res, r.status, r.data);
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/apk/builds') {
        await saveDb(db);
        const r = await agentFetch('/builds');
        return json(req, res, r.status, r.data);
      }
      const apkBuildMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)\/build$/);
      if (req.method === 'POST' && apkBuildMatch) {
        const slug = decodeURIComponent(apkBuildMatch[1]);
        const r = await agentFetch('/builds', { method: 'POST', body: JSON.stringify({ slug }) });
        addAuditEvent(db, req, { type: 'apk.build_started', actor: actor.email, result: r.status < 400 ? 'accepted' : 'denied', installationId: slug });
        await saveDb(db);
        return json(req, res, r.status, r.data);
      }
      // Download do APK com NOME AMIGÁVEL (nome do app), não o slug interno.
      // Reentrega o arquivo publicado em /apk com Content-Disposition.
      const apkDownloadMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)\/download$/);
      if (req.method === 'GET' && apkDownloadMatch) {
        const slug = decodeURIComponent(apkDownloadMatch[1]);
        const inst = db.installations[slug];
        const filename = safeApkFilename(inst ? effectiveAppName(inst) : slug);
        await saveDb(db);
        const upstream = await artifactFetch(`/apk/drac-${encodeURIComponent(slug)}.apk`);
        if (!upstream) {
          return json(req, res, 502, { error: 'artifact_source_unavailable', message: 'Servidor de arquivos temporariamente indisponível. Tente novamente em instantes.' });
        }
        if (!upstream.ok || !upstream.body) {
          return json(req, res, 404, { error: 'apk_not_found', message: 'APK ainda não gerado para este cliente.' });
        }
        const len = upstream.headers.get('content-length');
        res.writeHead(200, {
          ...securityHeaders(req),
          'content-type': 'application/vnd.android.package-archive',
          'content-disposition': `attachment; filename="${filename}"`,
          ...(len ? { 'content-length': len } : {}),
        });
        const { Readable } = require('node:stream');
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }
      // Download do AAB (App Bundle) — arquivo que sobe na Google Play Store.
      const aabDownloadMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)\/download-aab$/);
      if (req.method === 'GET' && aabDownloadMatch) {
        const slug = decodeURIComponent(aabDownloadMatch[1]);
        const inst = db.installations[slug];
        const base = safeApkFilename(inst ? effectiveAppName(inst) : slug).replace(/\.apk$/i, '');
        await saveDb(db);
        const upstream = await artifactFetch(`/apk/drac-${encodeURIComponent(slug)}.aab`);
        if (!upstream) {
          return json(req, res, 502, { error: 'artifact_source_unavailable', message: 'Servidor de arquivos temporariamente indisponível. Tente novamente em instantes.' });
        }
        if (!upstream.ok || !upstream.body) {
          return json(req, res, 404, { error: 'aab_not_found', message: 'AAB (Play Store) ainda não gerado. Gere/atualize o app.' });
        }
        const len = upstream.headers.get('content-length');
        res.writeHead(200, {
          ...securityHeaders(req),
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${base}.aab"`,
          ...(len ? { 'content-length': len } : {}),
        });
        const { Readable } = require('node:stream');
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }
      const kitDownloadMatch = url.pathname.match(/^\/api\/admin\/apk\/clients\/([^/]+)\/download-kit$/);
      if (req.method === 'GET' && kitDownloadMatch) {
        const slug = decodeURIComponent(kitDownloadMatch[1]);
        const inst = db.installations[slug];
        const base = safeApkFilename(inst ? effectiveAppName(inst) : slug).replace(/\.apk$/i, '');
        await saveDb(db);
        const upstream = await artifactFetch(`/apk/drac-${encodeURIComponent(slug)}-playstore-kit.zip`);
        if (!upstream) {
          return json(req, res, 502, { error: 'artifact_source_unavailable', message: 'Servidor de arquivos temporariamente indisponível. Tente novamente em instantes.' });
        }
        if (!upstream.ok || !upstream.body) {
          return json(req, res, 404, { error: 'kit_not_found', message: 'Kit Play Store ainda não gerado. Gere/atualize o app.' });
        }
        const len = upstream.headers.get('content-length');
        res.writeHead(200, {
          ...securityHeaders(req),
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${base}-playstore-kit.zip"`,
          ...(len ? { 'content-length': len } : {}),
        });
        const { Readable } = require('node:stream');
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }
      const apkBuildStatusMatch = url.pathname.match(/^\/api\/admin\/apk\/builds\/([^/]+)$/);
      if (req.method === 'GET' && apkBuildStatusMatch) {
        await saveDb(db);
        const r = await agentFetch(`/builds/${encodeURIComponent(decodeURIComponent(apkBuildStatusMatch[1]))}`);
        return json(req, res, r.status, r.data);
      }

      // ── App por cliente (auto: deriva tudo do cadastro + branding do cliente) ─
      const genAppMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/generate-app$/);
      if (req.method === 'POST' && genAppMatch) {
        return handleGenerateApp(req, res, db, actor, decodeURIComponent(genAppMatch[1]));
      }
      const instAppMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/app$/);
      if (req.method === 'GET' && instAppMatch) {
        await saveDb(db);
        return handleInstallationApp(req, res, db, decodeURIComponent(instAppMatch[1]));
      }
      if (req.method === 'PATCH' && instAppMatch) {
        return handlePatchApp(req, res, db, actor, decodeURIComponent(instAppMatch[1]));
      }

      // ── Nós de computação por instalação (item 3.2) ────────────────────────
      const computeNodesMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/compute-nodes$/);
      if (req.method === 'PATCH' && computeNodesMatch) {
        return handlePatchComputeNodes(req, res, db, actor, decodeURIComponent(computeNodesMatch[1]));
      }

      // ── Instalação remota via SSH ──────────────────────────────────────────
      const remoteInstallMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/remote-install$/);
      if (req.method === 'POST' && remoteInstallMatch) {
        return handleRemoteInstall(req, res, db, actor, decodeURIComponent(remoteInstallMatch[1]));
      }
      const remoteInstallStatusMatch = url.pathname.match(/^\/api\/admin\/remote-installs\/([^/]+)$/);
      if (req.method === 'GET' && remoteInstallStatusMatch) {
        await saveDb(db);
        const job = remoteInstalls.get(decodeURIComponent(remoteInstallStatusMatch[1]));
        if (!job) return json(req, res, 404, { error: 'job_not_found' });
        return json(req, res, 200, publicRemoteInstall(job));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
        await saveDb(db);
        const events = Array.isArray(db.auditEvents) ? db.auditEvents.slice().reverse().slice(0, 200) : [];
        return json(req, res, 200, { items: events });
      }
      const detailMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)$/);
      if (req.method === 'GET' && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const item = db.installations[id];
        await saveDb(db);
        if (!item) return json(req, res, 404, { error: 'installation_not_found' });
        return json(req, res, 200, publicInstallation(item));
      }
      if (req.method === 'DELETE' && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const item = db.installations[id];
        if (!item) return json(req, res, 404, { error: 'installation_not_found' });
        if (item.lastHeartbeatAt) {
          return json(req, res, 409, {
            error: 'installation_already_active',
            message: 'Não é possível remover por aqui uma instalação que já enviou heartbeat.',
          });
        }
        delete db.installations[id];
        addAuditEvent(db, req, {
          type: 'installation.provision_deleted',
          actor: actor.email,
          result: 'accepted',
          installationId: id,
        });
        await saveDb(db);
        return json(req, res, 200, { ok: true });
      }
      const installerCommandMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/installer$/);
      if (req.method === 'GET' && installerCommandMatch) {
        return handleGetInstallerCommand(req, res, db, actor, decodeURIComponent(installerCommandMatch[1]));
      }
      const diagnosticsMatch = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/diagnostics$/);
      if (req.method === 'GET' && diagnosticsMatch) {
        const id = decodeURIComponent(diagnosticsMatch[1]);
        const item = db.installations[id];
        if (!item) return json(req, res, 404, { error: 'installation_not_found' });
        addAuditEvent(db, req, {
          type: 'installation.diagnostics_viewed',
          actor: actor.email,
          result: 'accepted',
          installationId: id,
        });
        await saveDb(db);
        return json(req, res, 200, supportDiagnostics(item));
      }
      const match = url.pathname.match(/^\/api\/admin\/installations\/([^/]+)\/license$/);
      if (req.method === 'PATCH' && match) {
        const id = decodeURIComponent(match[1]);
        const body = await readBody(req);
        const item = db.installations[id];
        if (!item) return json(req, res, 404, { error: 'installation_not_found' });
        const allowed = ['ACTIVE', 'GRACE', 'RESTRICTED', 'SUSPENDED'];
        if (!allowed.includes(body.licenseStatus)) {
          return json(req, res, 400, { error: 'invalid_license_status' });
        }
        const licenseHistory = Array.isArray(item.licenseHistory) ? item.licenseHistory : [];
        if (item.licenseStatus !== body.licenseStatus || (item.licenseMessage || null) !== (body.licenseMessage || null)) {
          licenseHistory.push({
            at: new Date().toISOString(),
            from: item.licenseStatus || LICENSE_ACTIVE,
            to: body.licenseStatus,
            message: body.licenseMessage || null,
            by: actor.email,
          });
        }
        while (licenseHistory.length > 100) licenseHistory.shift();
        item.licenseStatus = body.licenseStatus;
        item.licenseMessage = body.licenseMessage || null;
        item.licenseHistory = licenseHistory;
        item.updatedAt = new Date().toISOString();
        addAuditEvent(db, req, {
          type: 'installation.license_changed',
          actor: actor.email,
          result: 'accepted',
          installationId: id,
          from: licenseHistory.at(-1)?.from || item.licenseStatus || LICENSE_ACTIVE,
          to: body.licenseStatus,
        });
        await saveDb(db);
        return json(req, res, 200, publicInstallation(item));
      }
      return json(req, res, 404, { error: 'not_found' });
    }
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    const statusCode = Number(error?.statusCode) || 500;
    return json(req, res, statusCode, {
      error: statusCode === 413 ? 'payload_too_large' : 'internal_error',
      message: statusCode === 413 ? error.message : 'Falha interna no servidor.',
    });
  }
}

// Guardas globais: um erro solto (ex.: handler chamado sem await) NUNCA deve
// derrubar o processo — antes virava crash loop e tirava a Central do ar.
process.on('uncaughtException', (error) => {
  console.error('[central] uncaughtException:', error && error.stack ? error.stack : error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[central] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});

// Serialização das rotas que tocam o banco. loadDb()/saveDb() fazem
// read-modify-write do arquivo inteiro SEM lock; requests concorrentes (ex.: um
// heartbeat chegando no meio de uma edição do app) se sobrescreviam — o nome do
// app definido pelo usuário voltava ao padrão ("DRAC Local"), e saveDb atômico
// batia `ENOENT` no rename por gravar `.tmp` concorrente. Como o painel é de
// baixo tráfego e o Node é single-thread, serializar essas rotas elimina a
// corrida sem custo perceptível. Estáticos (não tocam o DB) seguem em paralelo.
let _dbGate = Promise.resolve();
function runSerialized(task) {
  const p = _dbGate.then(task, task);
  _dbGate = p.then(() => {}, () => {});
  return p;
}

function startServer() {
  return http.createServer((req, res) => {
  // route() é async; sem este .catch, uma rejeição (ex.: loadDb) escapava como
  // unhandledRejection. Aqui garantimos uma resposta 500 e seguimos vivos.
  const url = req.url || '';
  const touchesDb = url.startsWith('/api/') || url.startsWith('/install/');
  const run = () => Promise.resolve(route(req, res));
  const started = touchesDb ? runSerialized(run) : run();
  started.catch((error) => {
    console.error('[central] erro não tratado na rota:', error && error.stack ? error.stack : error);
    try {
      if (!res.headersSent) json(req, res, 500, { error: 'internal_error' });
      else res.end();
    } catch { /* resposta já encerrada */ }
  });
  }).listen(PORT, HOST, () => {
    console.log(`DRAC Central ouvindo em http://${HOST}:${PORT}`);
  });
}

if (require.main === module) startServer();

module.exports = {
  hashPassword,
  isStrongPassword,
  normalizeDb,
  parseDbText,
  publicInstallation,
  fleetSummary,
  runSerialized,
  startServer,
  verifyPassword,
};
