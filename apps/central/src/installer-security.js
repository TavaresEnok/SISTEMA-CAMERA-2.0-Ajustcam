'use strict';

const crypto = require('node:crypto');

const FULL_GIT_COMMIT_RE = /^[a-f0-9]{40}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_INSTALLER_URL_TEMPLATE =
  'https://raw.githubusercontent.com/TavaresEnok/DRAC/{commit}/scripts/install-drac.sh';
const DEFAULT_REPOSITORY_URL = 'https://github.com/TavaresEnok/DRAC.git';
const DEFAULT_INSTALLER_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_INSTALLER_TOKEN_MAX_DOWNLOADS = 3;

class InstallerConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallerConfigurationError';
    this.code = 'installer_artifact_not_configured';
    this.statusCode = 503;
  }
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function fullSha256(value, label = 'SHA-256') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(normalized)) {
    throw new InstallerConfigurationError(
      `${label} deve conter exatamente 64 caracteres hexadecimais.`,
    );
  }
  return normalized;
}

function fullGitCommit(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!FULL_GIT_COMMIT_RE.test(normalized)) {
    throw new InstallerConfigurationError(
      'Configure um identificador imutável do instalador como commit Git completo de 40 caracteres hexadecimais.',
    );
  }
  return normalized;
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function checkedUrl(value, { allowInsecureLoopback = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new InstallerConfigurationError('A URL do artefato do instalador é inválida.');
  }
  if (parsed.username || parsed.password) {
    throw new InstallerConfigurationError(
      'A URL do artefato do instalador não pode conter credenciais.',
    );
  }
  if (parsed.hash) {
    throw new InstallerConfigurationError(
      'A URL do artefato do instalador não pode conter fragmento.',
    );
  }
  if (parsed.protocol !== 'https:') {
    const allowedForLocalTest =
      allowInsecureLoopback &&
      parsed.protocol === 'http:' &&
      isLoopbackHostname(parsed.hostname);
    if (!allowedForLocalTest) {
      throw new InstallerConfigurationError(
        'A URL do artefato do instalador deve usar HTTPS.',
      );
    }
  }
  return parsed;
}

function configuredInstallerArtifact(env = process.env, now = new Date()) {
  const commit = fullGitCommit(env.DRAC_CENTRAL_INSTALLER_COMMIT);
  const sha256 = fullSha256(env.DRAC_CENTRAL_INSTALLER_SHA256);
  const template = String(
    env.DRAC_CENTRAL_INSTALLER_URL_TEMPLATE || DEFAULT_INSTALLER_URL_TEMPLATE,
  ).trim();
  if (!template.includes('{commit}')) {
    throw new InstallerConfigurationError(
      'DRAC_CENTRAL_INSTALLER_URL_TEMPLATE deve conter o marcador {commit}.',
    );
  }
  const url = template.split('{commit}').join(commit);
  const parsed = checkedUrl(url, {
    allowInsecureLoopback:
      String(env.DRAC_CENTRAL_ALLOW_INSECURE_INSTALLER_URL || '') === 'true',
  });
  if (!parsed.href.includes(commit)) {
    throw new InstallerConfigurationError(
      'A URL do artefato não ficou vinculada ao commit configurado.',
    );
  }
  const repositoryUrl = checkedUrl(
    env.DRAC_CENTRAL_REPOSITORY_URL || DEFAULT_REPOSITORY_URL,
  ).href;
  return {
    id: commit,
    commit,
    url: parsed.href,
    repositoryUrl,
    sha256,
    compatibility: 'exact-commit',
    approvedAt: now.toISOString(),
  };
}

function installerTokenTtlMs(env = process.env) {
  const raw = Number(
    env.DRAC_CENTRAL_INSTALLER_TOKEN_TTL_SECONDS ||
      DEFAULT_INSTALLER_TOKEN_TTL_SECONDS,
  );
  const seconds = Number.isFinite(raw)
    ? Math.min(24 * 60 * 60, Math.max(60, Math.floor(raw)))
    : DEFAULT_INSTALLER_TOKEN_TTL_SECONDS;
  return seconds * 1000;
}

function installerTokenMaxDownloads(env = process.env) {
  const raw = Number(
    env.DRAC_CENTRAL_INSTALLER_TOKEN_MAX_DOWNLOADS ||
      DEFAULT_INSTALLER_TOKEN_MAX_DOWNLOADS,
  );
  if (!Number.isFinite(raw)) return DEFAULT_INSTALLER_TOKEN_MAX_DOWNLOADS;
  return Math.min(10, Math.max(1, Math.floor(raw)));
}

function normalizedExecutionArtifact(
  artifact,
  { allowInsecureLoopback = false } = {},
) {
  const id = String(artifact?.id || artifact?.commit || '').trim().toLowerCase();
  if (!FULL_GIT_COMMIT_RE.test(id) && !SHA256_RE.test(id)) {
    throw new InstallerConfigurationError(
      'O artefato deve possuir identificador imutável completo.',
    );
  }
  const parsed = checkedUrl(artifact?.url, { allowInsecureLoopback });
  const commit = artifact?.commit ? fullGitCommit(artifact.commit) : undefined;
  if (commit && commit !== id) {
    throw new InstallerConfigurationError(
      'O commit do instalador não corresponde ao identificador aprovado.',
    );
  }
  return {
    ...artifact,
    id,
    commit,
    url: parsed.href,
    repositoryUrl: checkedUrl(
      artifact?.repositoryUrl || DEFAULT_REPOSITORY_URL,
    ).href,
    sha256: fullSha256(artifact?.sha256),
  };
}

function isInstallerTokenActive(item, now = new Date()) {
  if (!SHA256_RE.test(String(item?.installerTokenHash || ''))) return false;
  if (!item?.installerTokenExpiresAt) return false;
  const remainingDownloads = Number(item?.installerTokenRemainingDownloads);
  if (!Number.isInteger(remainingDownloads) || remainingDownloads < 1) return false;
  const expiresAt = new Date(item.installerTokenExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function installerTokenDigest(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function issueInstallerGrant(
  item,
  {
    artifact,
    now = new Date(),
    ttlMs = DEFAULT_INSTALLER_TOKEN_TTL_SECONDS * 1000,
    randomToken = () => crypto.randomBytes(24).toString('base64url'),
    maxDownloads = DEFAULT_INSTALLER_TOKEN_MAX_DOWNLOADS,
    rotateArtifact = false,
    rotateToken = true,
    createToken = true,
  } = {},
) {
  if (!item || typeof item !== 'object') {
    throw new InstallerConfigurationError('Instalação inválida para emissão do instalador.');
  }
  const currentArtifact = item.installerArtifact;
  if (rotateArtifact || !currentArtifact) {
    const normalized = normalizedExecutionArtifact(artifact, {
      allowInsecureLoopback: true,
    });
    item.installerArtifact = {
      id: normalized.id,
      commit: normalized.commit || normalized.id,
      url: normalized.url,
      repositoryUrl: normalized.repositoryUrl || DEFAULT_REPOSITORY_URL,
      sha256: normalized.sha256,
      compatibility: normalized.compatibility || 'exact-commit',
      approvedAt: normalized.approvedAt || now.toISOString(),
      boundAt: now.toISOString(),
    };
  } else {
    normalizedExecutionArtifact(currentArtifact, { allowInsecureLoopback: true });
  }

  let installerToken = null;
  if (createToken && (rotateToken || !isInstallerTokenActive(item, now))) {
    installerToken = randomToken();
    item.installerTokenHash = installerTokenDigest(installerToken);
    item.installerTokenExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
    item.installerTokenCreatedAt = now.toISOString();
    item.installerTokenRemainingDownloads = Math.min(
      10,
      Math.max(1, Math.floor(Number(maxDownloads) || DEFAULT_INSTALLER_TOKEN_MAX_DOWNLOADS)),
    );
    delete item.installerTokenLastUsedAt;
    delete item.installerTokenUsedAt;
  }
  // Registros legados armazenavam o bearer em claro. A partir daqui apenas o
  // digest persiste; o valor bruto existe somente na resposta administrativa.
  delete item.installerToken;
  return { item, installerToken };
}

function consumeInstallerDownload(item, now = new Date()) {
  if (!isInstallerTokenActive(item, now)) {
    throw new InstallerConfigurationError(
      'O token do instalador está ausente, expirado ou consumido.',
    );
  }
  item.installerTokenRemainingDownloads -= 1;
  item.installerTokenLastUsedAt = now.toISOString();
  if (item.installerTokenRemainingDownloads === 0) {
    item.installerTokenUsedAt = now.toISOString();
  }
  return item.installerTokenRemainingDownloads;
}

function buildInstallerExecutionCommand({
  artifact,
  environment = {},
  bearerInput = 'none',
  allowInsecureLoopback = false,
  connectTimeoutSeconds = 10,
  maxTimeSeconds = 120,
  toolSearchPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
} = {}) {
  const normalized = normalizedExecutionArtifact(artifact, {
    allowInsecureLoopback,
  });
  const protocol = new URL(normalized.url).protocol.slice(0, -1);
  const connectTimeout = Math.max(1, Math.floor(Number(connectTimeoutSeconds) || 10));
  const maxTime = Math.max(1, Math.floor(Number(maxTimeSeconds) || 120));
  if (!['none', 'prompt'].includes(bearerInput)) {
    throw new InstallerConfigurationError(
      'Modo inválido de entrega do token do instalador.',
    );
  }
  const envAssignments = [];
  const envExports = [];
  for (const [key, value] of Object.entries(environment || {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new InstallerConfigurationError(
        'Nome inválido de variável de ambiente do instalador.',
      );
    }
    envAssignments.push(`${key}=${shellQuote(value)}`);
    envExports.push(key);
  }
  const environmentSetup = envAssignments.length
    ? `${envAssignments.join('\n')}
export ${envExports.join(' ')}`
    : '';
  const bearerSetup = bearerInput === 'prompt'
    ? `printf '%s' 'Token temporário do instalador: ' >&2
if ! IFS= read -r -s drac_installer_bearer_token; then
  printf '\\n%s\\n' 'DRAC: não foi possível ler o token temporário.' >&2
  exit 1
fi
printf '\\n' >&2
if [[ ! "$drac_installer_bearer_token" =~ ^[A-Za-z0-9_-]{20,200}$ ]]; then
  printf '%s\\n' 'DRAC: token temporário ausente ou inválido.' >&2
  exit 1
fi`
    : '';

  return `(
set +x
set -Eeuo pipefail
PATH=${shellQuote(toolSearchPath)}
export PATH
unset BASH_ENV ENV CDPATH
drac_installer_url=${shellQuote(normalized.url)}
drac_installer_sha256=${shellQuote(normalized.sha256)}
drac_installer_bearer_token=''
drac_installer_tmp=''
drac_installer_cleanup() {
  exec 4<&- 2>/dev/null || true
  if [ -n "\${drac_installer_tmp:-}" ]; then
    command rm -f -- "$drac_installer_tmp"
  fi
  drac_installer_bearer_token=''
}
trap drac_installer_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

${bearerSetup}

case "$drac_installer_sha256" in
  ''|*[!a-f0-9]*)
    printf '%s\\n' 'DRAC: SHA-256 esperado ausente ou inválido.' >&2
    exit 1
    ;;
esac
if [ "\${#drac_installer_sha256}" -ne 64 ]; then
  printf '%s\\n' 'DRAC: SHA-256 esperado ausente ou inválido.' >&2
  exit 1
fi
drac_installer_curl="$(type -P curl || true)"
if [ -z "$drac_installer_curl" ]; then
  printf '%s\\n' 'DRAC: curl não está disponível.' >&2
  exit 1
fi
drac_installer_sha256sum="$(type -P sha256sum || true)"
drac_installer_shasum="$(type -P shasum || true)"
if [ -n "$drac_installer_sha256sum" ]; then
  drac_installer_hash_tool="$drac_installer_sha256sum"
elif [ -n "$drac_installer_shasum" ]; then
  drac_installer_hash_tool="$drac_installer_shasum"
else
  printf '%s\\n' 'DRAC: sha256sum ou shasum não está disponível.' >&2
  exit 1
fi

drac_installer_tmp="$(command mktemp "\${TMPDIR:-/tmp}/drac-installer.XXXXXXXXXX")"
command chmod 600 "$drac_installer_tmp"
drac_installer_curl_args=(
  --fail --silent --show-error --location --max-redirs 0
  --connect-timeout ${connectTimeout} --max-time ${maxTime}
  --proto '=${protocol}' --proto-redir '=${protocol}'
  --output "$drac_installer_tmp"
)
if [ -n "$drac_installer_bearer_token" ]; then
  if ! printf 'header = "Authorization: Bearer %s"\\n' "$drac_installer_bearer_token" |
    "$drac_installer_curl" --disable --config - "\${drac_installer_curl_args[@]}" "$drac_installer_url"; then
    printf '%s\\n' 'DRAC: falha ao baixar o instalador aprovado.' >&2
    exit 1
  fi
else
  if ! "$drac_installer_curl" --disable "\${drac_installer_curl_args[@]}" "$drac_installer_url"; then
    printf '%s\\n' 'DRAC: falha ao baixar o instalador aprovado.' >&2
    exit 1
  fi
fi
drac_installer_bearer_token=''
if [ ! -s "$drac_installer_tmp" ]; then
  printf '%s\\n' 'DRAC: o instalador baixado está vazio.' >&2
  exit 1
fi
command chmod 400 "$drac_installer_tmp"

exec 4<"$drac_installer_tmp"
command rm -f -- "$drac_installer_tmp"
drac_installer_tmp=''
if [ -r '/proc/self/fd/4' ]; then
  drac_installer_fd_path='/proc/self/fd/4'
elif [ -r '/dev/fd/4' ]; then
  drac_installer_fd_path='/dev/fd/4'
else
  printf '%s\\n' 'DRAC: não foi possível acessar com segurança o arquivo validado.' >&2
  exit 1
fi
if [[ "$drac_installer_hash_tool" == */sha256sum ]]; then
  drac_installer_actual="$("$drac_installer_hash_tool" "$drac_installer_fd_path")"
else
  drac_installer_actual="$("$drac_installer_hash_tool" -a 256 "$drac_installer_fd_path")"
fi
drac_installer_actual="\${drac_installer_actual%% *}"
if [ "$drac_installer_actual" != "$drac_installer_sha256" ]; then
  printf '%s\\n' 'DRAC: SHA-256 do instalador diverge do valor aprovado; execução recusada.' >&2
  exit 1
fi
${environmentSetup}
env -u BASH_ENV -u ENV bash --noprofile --norc "$drac_installer_fd_path"
)`;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
  DEFAULT_INSTALLER_TOKEN_TTL_SECONDS,
  DEFAULT_INSTALLER_TOKEN_MAX_DOWNLOADS,
  DEFAULT_INSTALLER_URL_TEMPLATE,
  DEFAULT_REPOSITORY_URL,
  InstallerConfigurationError,
  buildInstallerExecutionCommand,
  configuredInstallerArtifact,
  consumeInstallerDownload,
  fullGitCommit,
  fullSha256,
  installerTokenDigest,
  installerTokenTtlMs,
  installerTokenMaxDownloads,
  isInstallerTokenActive,
  issueInstallerGrant,
  sha256Text,
  shellQuote,
};
