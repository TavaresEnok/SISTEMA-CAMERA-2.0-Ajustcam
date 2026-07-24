'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Backup das IDENTIDADES DE ASSINATURA antes de migrar (exigência do item 2.10).
//
// Na Central, a "identidade de assinatura" de cada instalação é o material secreto
// que a autentica/identifica: a `licenseKey` (assina/autoriza os heartbeats), o
// `installerToken` (autoriza o download do instalador) e as `sshHostKeys` (TOFU).
// São irreproduzíveis: se a migração corromper o datastore, sem esse backup os
// clientes perderiam a licença e precisariam reinstalar. Também guardamos o
// `passwordHash` dos usuários admin (identidade de login), sem senha em claro.

// Extração PURA: nada de I/O. Só coleta os campos sensíveis do db em memória.
function collectSigningIdentities(db) {
  const source = db || {};
  const installations = {};
  for (const [id, item] of Object.entries(source.installations || {})) {
    const entry = {};
    if (item && item.licenseKey) entry.licenseKey = item.licenseKey;
    if (item && item.installerToken) entry.installerToken = item.installerToken;
    if (item && item.sshHostKeys && typeof item.sshHostKeys === 'object') {
      entry.sshHostKeys = { ...item.sshHostKeys };
    }
    // Só inclui instalações que carregam algum segredo — evita ruído.
    if (Object.keys(entry).length) installations[id] = entry;
  }
  const users = {};
  for (const [email, user] of Object.entries(source.users || {})) {
    if (user && user.passwordHash) users[email] = { passwordHash: user.passwordHash };
  }
  return {
    kind: 'drac-central-signing-backup',
    version: 1,
    installations,
    users,
    counts: {
      installations: Object.keys(installations).length,
      users: Object.keys(users).length,
    },
  };
}

// Escreve o backup em disco com fsync (durável antes de qualquer escrita de
// migração). Nome com timestamp: nunca sobrescreve backups anteriores.
async function writeSigningBackup(db, dir, now = new Date()) {
  const payload = collectSigningIdentities(db);
  payload.createdAt = now.toISOString();
  await fs.mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(3).toString('hex');
  const file = path.join(dir, `signing-backup-${stamp}-${suffix}.json`);
  const body = JSON.stringify(payload, null, 2);
  // Grava + fsync do arquivo e do diretório: o rename/entrada tem de sobreviver a
  // um crash logo após o backup (senão migrávamos sem rede de segurança real).
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const dirHandle = await fs.open(dir);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch { /* fsync de diretório é best-effort em alguns FS */ }
  return { file, payload };
}

module.exports = { collectSigningIdentities, writeSigningBackup };
