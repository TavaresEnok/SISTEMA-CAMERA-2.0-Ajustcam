#!/usr/bin/env bash
set -Eeuo pipefail

# O repositório REAL do produto. O padrão anterior (TavaresEnok/DRAC) não
# contém os commits publicados pela Central — clonar de lá falha com
# "upload-pack: not our ref" no commit fixado.
DRAC_REPO_URL="${DRAC_REPO_URL:-https://github.com/TavaresEnok/SISTEMA-CAMERA-2.0-Ajustcam.git}"
DRAC_INSTALLER_COMMIT="${DRAC_INSTALLER_COMMIT:-}"
# Padrões de PRODUTO, não da máquina de desenvolvimento.
#
# Até 07/08/2026 estes eram `/home/flashnet/Drac` e `flashnet` — o diretório e
# o usuário do desenvolvedor. Numa instalação de cliente isso criava uma pasta
# com o nome de alguém que não existe naquele servidor, e um usuário idem.
# `/opt/drac` é onde software de terceiro mora em Linux, e o usuário operador
# passa a ser quem de fato invocou o instalador (via sudo), com queda para
# `drac` quando não dá para saber.
DRAC_INSTALL_DIR="${DRAC_INSTALL_DIR:-/opt/drac}"
DRAC_OPERATING_USER="${DRAC_OPERATING_USER:-${SUDO_USER:-drac}}"
DRAC_CENTRAL_URL="${DRAC_CENTRAL_URL:-https://ajustcam.ajustconsulting.com.br/central}"
DRAC_ENVIRONMENT="${DRAC_ENVIRONMENT:-prod}"
DRAC_AUTO_YES="${DRAC_AUTO_YES:-false}"
DRAC_WATCHDOG_ENABLED="${DRAC_WATCHDOG_ENABLED:-true}"
DRAC_WATCHDOG_INTERVAL_MINUTES="${DRAC_WATCHDOG_INTERVAL_MINUTES:-5}"
DRAC_CAMERA_ALLOWED_CIDRS="${DRAC_CAMERA_ALLOWED_CIDRS:-}"

log() {
  printf '\033[1;36m[DRAC]\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33m[DRAC]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[DRAC]\033[0m %s\n' "$*" >&2
  exit 1
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_user() {
  local user="$1"
  shift
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$user" -- "$@"
  elif [ "$(id -un)" = "$user" ]; then
    "$@"
  else
    sudo -u "$user" "$@"
  fi
}

run_git_as_user() {
  local user="$1"
  shift
  run_as_user "$user" env \
    -u BASH_ENV \
    -u ENV \
    -u GIT_CONFIG_COUNT \
    -u GIT_CONFIG_KEY_0 \
    -u GIT_CONFIG_VALUE_0 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    git \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    "$@"
}

prompt() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local current_value="${!var_name:-}"

  if [ -n "$current_value" ]; then
    return
  fi

  if [ "$DRAC_AUTO_YES" = "true" ]; then
    if [ -n "$default_value" ]; then
      printf -v "$var_name" '%s' "$default_value"
      return
    fi
    fail "Variavel obrigatoria nao informada: $var_name"
  fi

  local answer
  if [ -n "$default_value" ]; then
    read -r -p "$label [$default_value]: " answer
    printf -v "$var_name" '%s' "${answer:-$default_value}"
  else
    while true; do
      read -r -p "$label: " answer
      if [ -n "$answer" ]; then
        printf -v "$var_name" '%s' "$answer"
        return
      fi
      warn "Campo obrigatorio."
    done
  fi
}

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

random_hex() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

detect_ip() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnu "( sport = :$port )" 2>/dev/null | tail -n +2 | grep -q .
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltnu 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"
    return $?
  fi
  return 1
}

host_from_url() {
  printf '%s' "$1" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#/.*$##; s#:.*$##'
}

check_dns_host() {
  local label="$1"
  local host="$2"
  [ -n "$host" ] || return 0
  if command -v getent >/dev/null 2>&1 && getent hosts "$host" >/dev/null 2>&1; then
    log "DNS OK: $label ($host)"
    return 0
  fi
  if command -v host >/dev/null 2>&1 && host "$host" >/dev/null 2>&1; then
    log "DNS OK: $label ($host)"
    return 0
  fi
  warn "Nao foi possivel resolver DNS de $label ($host). Se for IP local, ignore; se for dominio publico, corrija antes da producao."
}

check_http_url() {
  local label="$1"
  local url="$2"
  [ -n "$url" ] || return 0
  if curl -fsS --max-time 10 "$url" >/dev/null 2>&1; then
    log "Conectividade OK: $label"
  else
    warn "Nao foi possivel acessar $label em $url agora."
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; :a;N;$!ba;s/\n/\\n/g'
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local attempts="${3:-30}"
  local delay="${4:-3}"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      log "$label respondeu."
      return 0
    fi
    sleep "$delay"
  done
  warn "$label nao respondeu apos $((attempts * delay)) segundos: $url"
  return 1
}

preflight() {
  log "Executando pre-checagens"

  if [[ ! "$DRAC_INSTALLER_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
    fail "DRAC_INSTALLER_COMMIT deve ser um commit Git completo e imutavel de 40 caracteres hexadecimais."
  fi
  DRAC_INSTALLER_COMMIT="$(printf '%s' "$DRAC_INSTALLER_COMMIT" | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$DRAC_REPO_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$ ]]; then
    fail "DRAC_REPO_URL deve ser uma URL HTTPS sem credenciais, query ou fragmento."
  fi

  if [ "$DRAC_OPERATING_USER" = "root" ]; then
    fail "DRAC_OPERATING_USER nao pode ser root. Use um usuario operacional, por exemplo flashnet."
  fi

  case "$DRAC_INSTALL_DIR" in
    /root|/root/*)
      fail "DRAC_INSTALL_DIR nao pode ficar dentro de /root. Use /home/$DRAC_OPERATING_USER/Drac ou outro diretorio operacional."
      ;;
  esac

  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    fail "Execute como root ou instale sudo para permitir configuracao de dependencias do host."
  fi

  if ! command -v curl >/dev/null 2>&1; then
    fail "curl e obrigatorio para a instalacao automatica."
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    warn "openssl ainda nao esta instalado; sera instalado nas dependencias do host."
  fi

  if command -v awk >/dev/null 2>&1; then
    local mem_mb disk_kb disk_gb
    mem_mb="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 0)"
    disk_kb="$(df -Pk "$(dirname "$DRAC_INSTALL_DIR")" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
    disk_gb="$(awk -v kb="${disk_kb:-0}" 'BEGIN { printf "%d", kb / 1024 / 1024 }')"
    if [ "${mem_mb:-0}" -lt 3900 ]; then
      warn "Memoria baixa detectada (${mem_mb:-0}MB). Para producao, use pelo menos 4GB; para varias cameras, 8GB+."
    else
      log "Memoria OK: ${mem_mb}MB"
    fi
    if [ "${disk_gb:-0}" -lt 20 ]; then
      warn "Disco livre baixo em $(dirname "$DRAC_INSTALL_DIR") (${disk_gb:-0}GB). Grave videos somente com storage dimensionado."
    else
      log "Disco livre OK: ${disk_gb}GB"
    fi
  fi

  check_dns_host "GitHub" "github.com"
  check_dns_host "Central" "$(host_from_url "$DRAC_CENTRAL_URL")"
  check_http_url "GitHub raw" "https://raw.githubusercontent.com/TavaresEnok/DRAC/${DRAC_INSTALLER_COMMIT}/README.md"
  check_http_url "DRAC Central" "${DRAC_CENTRAL_URL%/}/api/health"

  for port in 3000 5173 8554 8888 8889; do
    if port_in_use "$port"; then
      warn "Porta $port ja esta em uso. Se for uma instalacao DRAC existente, o Compose fara a atualizacao; se for outro servico, ajuste antes de continuar."
    fi
  done
}

ensure_operating_user() {
  if id "$DRAC_OPERATING_USER" >/dev/null 2>&1; then
    return
  fi
  log "Criando usuario operacional $DRAC_OPERATING_USER"
  run_sudo useradd -m -s /bin/bash "$DRAC_OPERATING_USER"
}

install_host_dependencies() {
  if ! command -v apt-get >/dev/null 2>&1; then
    fail "Instalador automatico suporta Ubuntu/Debian com apt-get. Instale Docker, Compose e Git manualmente neste sistema."
  fi

  log "Instalando dependencias do host"
  run_sudo apt-get update
  run_sudo apt-get install -y ca-certificates curl git gnupg openssl lsb-release

  if ! command -v docker >/dev/null 2>&1; then
    log "Instalando Docker"
    run_sudo install -m 0755 -d /etc/apt/keyrings
    . /etc/os-release
    local docker_os="$ID"
    if [ "$docker_os" != "ubuntu" ] && [ "$docker_os" != "debian" ]; then
      docker_os="ubuntu"
    fi
    run_sudo rm -f /etc/apt/keyrings/docker.gpg
    curl -fsSL "https://download.docker.com/linux/${docker_os}/gpg" | run_sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    run_sudo chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${docker_os} ${VERSION_CODENAME} stable" \
      | run_sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    run_sudo apt-get update
    run_sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  if ! docker compose version >/dev/null 2>&1; then
    fail "Docker Compose plugin nao ficou disponivel apos a instalacao."
  fi

  run_sudo usermod -aG docker "$DRAC_OPERATING_USER" || true
}

sync_repository() {
  local parent_dir fetched_commit current_origin untracked
  parent_dir="$(dirname "$DRAC_INSTALL_DIR")"
  run_sudo mkdir -p "$parent_dir"
  run_sudo chown -R "$DRAC_OPERATING_USER:$DRAC_OPERATING_USER" "$parent_dir"

  if [ -d "$DRAC_INSTALL_DIR/.git" ]; then
    if ! run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" diff --quiet --ignore-submodules --; then
      fail "O repositorio existente possui alteracoes rastreadas. A instalacao foi recusada para preservar a integridade do commit aprovado."
    fi
    if ! run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" diff --cached --quiet --ignore-submodules --; then
      fail "O repositorio existente possui alteracoes staged. A instalacao foi recusada."
    fi
    untracked="$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" ls-files --others --exclude-standard)"
    if [ -n "$untracked" ]; then
      fail "O repositorio existente possui arquivos nao rastreados. Mova-os para fora do checkout antes de instalar."
    fi
    current_origin="$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" remote get-url origin)"
    if [ "$current_origin" != "$DRAC_REPO_URL" ]; then
      fail "A origem Git existente diverge da origem aprovada; ajuste-a por procedimento administrativo antes de instalar."
    fi
    log "Atualizando repositorio para o commit aprovado em $DRAC_INSTALL_DIR"
    run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" fetch --depth 1 origin "$DRAC_INSTALLER_COMMIT"
  else
    if [ -e "$DRAC_INSTALL_DIR" ] && [ -n "$(find "$DRAC_INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      fail "DRAC_INSTALL_DIR existe, nao e repositorio Git e nao esta vazio."
    fi
    log "Inicializando repositorio DRAC em $DRAC_INSTALL_DIR"
    run_as_user "$DRAC_OPERATING_USER" mkdir -p "$DRAC_INSTALL_DIR"
    run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" init
    run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" remote add origin "$DRAC_REPO_URL"
    run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" fetch --depth 1 origin "$DRAC_INSTALLER_COMMIT"
  fi

  fetched_commit="$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" rev-parse --verify 'FETCH_HEAD^{commit}')"
  if [ "$fetched_commit" != "$DRAC_INSTALLER_COMMIT" ]; then
    fail "O repositorio remoto nao entregou o commit imutavel aprovado."
  fi
  run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" checkout --detach "$DRAC_INSTALLER_COMMIT"
  if [ "$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" rev-parse HEAD)" != "$DRAC_INSTALLER_COMMIT" ]; then
    fail "O checkout final nao corresponde ao commit aprovado."
  fi
  if ! run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" diff --quiet --ignore-submodules -- ||
    ! run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" diff --cached --quiet --ignore-submodules --; then
    fail "O checkout final divergiu do commit aprovado."
  fi
  untracked="$(run_git_as_user "$DRAC_OPERATING_USER" -C "$DRAC_INSTALL_DIR" ls-files --others --exclude-standard)"
  if [ -n "$untracked" ]; then
    fail "O checkout final contem arquivos nao rastreados e nao sera executado."
  fi
}

env_set() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[\/&]/\\&/g')"

  if grep -qE "^${key}=" "$file"; then
    run_sudo sed -i -E "s/^${key}=.*/${key}=${escaped}/" "$file"
  else
    printf '%s=%s\n' "$key" "$value" | run_sudo tee -a "$file" >/dev/null
  fi
}

prepare_env() {
  local env_file="$DRAC_INSTALL_DIR/infra/.env"
  local example_file="$DRAC_INSTALL_DIR/infra/.env.example"
  local server_ip="${DRAC_SERVER_IP:-$(detect_ip)}"
  local rtmp_short_host="${DRAC_RTMP_SHORT_HOST:-}"
  local install_slug

  prompt DRAC_CUSTOMER_NAME "Nome do cliente"
  install_slug="$(slugify "${DRAC_CUSTOMER_NAME:-$(hostname)}")"
  prompt DRAC_INSTALLATION_ID "Codigo da instalacao" "${install_slug:-drac-cliente}"
  prompt DRAC_LICENSE_KEY "Chave/licenca do cliente" "drac-$(random_hex 16)"
  prompt DRAC_SERVER_IP "IP ou dominio deste servidor" "${server_ip:-127.0.0.1}"
  # Se o endereço principal já é IPv4, ele também é a representação compacta.
  # Com domínio não adivinhamos NAT/DNS: o operador pode fornecer explicitamente
  # DRAC_RTMP_SHORT_HOST, evitando publicar um IP privado por engano.
  if [ -z "$rtmp_short_host" ] && printf '%s' "$DRAC_SERVER_IP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    rtmp_short_host="$DRAC_SERVER_IP"
  fi
  prompt DRAC_CENTRAL_URL "URL da DRAC Central" "$DRAC_CENTRAL_URL"
  prompt DRAC_CAMERA_ALLOWED_CIDRS \
    "CIDRs exclusivos das redes de cameras (separados por virgula; ex.: 192.168.10.0/24)"

  if [ ! -f "$env_file" ]; then
    log "Criando infra/.env"
    run_sudo cp "$example_file" "$env_file"
    run_sudo chmod 600 "$env_file"
  else
    warn "infra/.env ja existe; atualizando somente chaves controladas pelo instalador."
    run_sudo cp "$env_file" "$env_file.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  fi

  env_set "$env_file" POSTGRES_PASSWORD "$(random_hex 24)"
  env_set "$env_file" JWT_SECRET "$(random_hex 32)"
  env_set "$env_file" CAMERA_SECRET_KEY "$(random_hex 32)"
  env_set "$env_file" CAMERA_ALLOWED_CIDRS "$DRAC_CAMERA_ALLOWED_CIDRS"
  env_set "$env_file" INTERNAL_SERVICE_TOKEN "$(random_hex 24)"
  env_set "$env_file" EVIDENCE_HMAC_SECRET "$(random_hex 32)"
  env_set "$env_file" MEDIAMTX_API_USER "drac_media"
  env_set "$env_file" MEDIAMTX_API_PASS "$(random_hex 18)"
  env_set "$env_file" MEDIAMTX_AUTH_CALLBACK_TOKEN "$(random_hex 24)"
  env_set "$env_file" CORS_ALLOWED_ORIGINS "http://${DRAC_SERVER_IP}:5173,http://${DRAC_SERVER_IP}:3002"
  env_set "$env_file" PUBLIC_APP_URL "http://${DRAC_SERVER_IP}:5173"
  env_set "$env_file" API_PUBLIC_URL "http://${DRAC_SERVER_IP}:3000"
  env_set "$env_file" VITE_API_URL ""
  env_set "$env_file" CLOUD_CONNECTOR_ENABLED "true"
  env_set "$env_file" CLOUD_API_URL "$DRAC_CENTRAL_URL"
  env_set "$env_file" CLOUD_INSTALLATION_ID "$DRAC_INSTALLATION_ID"
  env_set "$env_file" CLOUD_LICENSE_KEY "$DRAC_LICENSE_KEY"
  env_set "$env_file" CLOUD_CUSTOMER_NAME "$DRAC_CUSTOMER_NAME"
  env_set "$env_file" CLOUD_HEARTBEAT_INTERVAL_SECONDS "60"
  env_set "$env_file" CLOUD_CONNECTOR_TIMEOUT_MS "8000"
  env_set "$env_file" DRAC_VERSION "$DRAC_INSTALLER_COMMIT"
  env_set "$env_file" DRAC_LAUNCH_PROFILE "standard"
  # ── O QUE FICA EXPOSTO À INTERNET ─────────────────────────────────────────
  #
  # ATENÇÃO: publicar em 0.0.0.0 aqui EXPÕE DE VERDADE, mesmo com ufw ativo —
  # o Docker escreve regras de DNAT que são avaliadas ANTES das do firewall.
  # Medido na instalação do D-GUARDIAN: ufw liberava só 22/80/443/1935/8189 e,
  # ainda assim, a API (3000), o HLS (8888) e a sinalização WebRTC (8889)
  # respondiam da internet — a API inteira alcançável sem HTTPS e sem passar
  # pelo nginx.
  #
  # A regra: só é público o que NÃO PODE passar pelo nginx.
  #   · 8189/udp — mídia WebRTC: o navegador conecta direto no IP anunciado.
  #   · 1935/tcp — RTMP: a câmera disca para cá (tratado à parte).
  # Todo o resto (API, web, HLS, sinalização, RTSP) fica em loopback e é
  # servido pelo nginx do host, com HTTPS.
  env_set "$env_file" DRAC_API_BIND "127.0.0.1"
  env_set "$env_file" DRAC_WEB_BIND "127.0.0.1"
  env_set "$env_file" DRAC_POSTGRES_BIND "127.0.0.1"
  env_set "$env_file" DRAC_REDIS_BIND "127.0.0.1"
  env_set "$env_file" DRAC_MEDIAMTX_RTSP_BIND "127.0.0.1"
  env_set "$env_file" DRAC_MEDIAMTX_HLS_BIND "127.0.0.1"
  env_set "$env_file" DRAC_MEDIAMTX_WEBRTC_HTTP_BIND "127.0.0.1"
  env_set "$env_file" DRAC_MEDIAMTX_WEBRTC_UDP_BIND "0.0.0.0"
  env_set "$env_file" MEDIAMTX_WEBRTC_ADDITIONAL_HOST "$DRAC_SERVER_IP"
  env_set "$env_file" MEDIAMTX_PUBLIC_HOST "$DRAC_SERVER_IP"
  env_set "$env_file" MEDIAMTX_RTMP_SHORT_HOST "$rtmp_short_host"
  env_set "$env_file" MEDIAMTX_PUBLIC_SCHEME "http"
  env_set "$env_file" MEDIAMTX_PUBLIC_WEBRTC_URL ""
  env_set "$env_file" MEDIAMTX_PUBLIC_HLS_URL ""
  env_set "$env_file" MEDIAMTX_HLS_ALLOW_ORIGIN "*"
  env_set "$env_file" MEDIAMTX_WEBRTC_ALLOW_ORIGIN "*"

  run_sudo chown "$DRAC_OPERATING_USER:$DRAC_OPERATING_USER" "$env_file"
}

compose_files() {
  if [ "$DRAC_ENVIRONMENT" = "dev" ]; then
    printf -- '-f infra/docker-compose.yml -f infra/docker-compose.dev.yml'
  else
    printf -- '-f infra/docker-compose.yml -f infra/docker-compose.prod.yml'
  fi
}

start_stack() {
  local files
  files="$(compose_files)"
  log "Subindo containers DRAC"
  # shellcheck disable=SC2086
  run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && docker compose --env-file infra/.env $files up -d --build"
}

run_migrations() {
  local files
  files="$(compose_files)"
  log "Aplicando migrations do banco"
  # shellcheck disable=SC2086
  run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && docker compose --env-file infra/.env $files exec -T -w /app/apps/api api npx prisma migrate deploy"
}

remove_watchdog_cron() {
  # Remove QUALQUER agendamento antigo do watchdog no crontab do usuario operacional
  # (marcado por "drac-runtime-watchdog"), preservando as demais linhas. Idempotente:
  # se nao houver nada nosso, nao mexe no crontab.
  command -v crontab >/dev/null 2>&1 || return 0
  local current
  current="$(run_as_user "$DRAC_OPERATING_USER" crontab -l 2>/dev/null || true)"
  printf '%s' "$current" | grep -q 'drac-runtime-watchdog' || return 0
  printf '%s\n' "$current" | grep -v 'drac-runtime-watchdog' | sed '/^[[:space:]]*$/d' \
    | run_as_user "$DRAC_OPERATING_USER" crontab - 2>/dev/null || true
}

provision_watchdog_systemd() {
  local script_path="$1"
  local interval="$2"
  command -v systemctl >/dev/null 2>&1 || return 1
  [ -d /run/systemd/system ] || return 1

  local service_file="/etc/systemd/system/drac-watchdog.service"
  local timer_file="/etc/systemd/system/drac-watchdog.timer"

  log "Agendando runtime-watchdog via systemd timer (a cada ${interval}min)"

  # Reescrever os units com o mesmo conteudo e' idempotente por natureza.
  run_sudo tee "$service_file" >/dev/null <<EOF || return 1
[Unit]
Description=DRAC runtime watchdog (deteccao + auto-cura de infra)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
User=$DRAC_OPERATING_USER
Nice=10
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$script_path
EOF

  run_sudo tee "$timer_file" >/dev/null <<EOF || return 1
[Unit]
Description=Executa o DRAC runtime watchdog a cada ${interval} minutos

[Timer]
OnCalendar=*:0/${interval}
Persistent=true
AccuracySec=30s
RandomizedDelaySec=20s
Unit=drac-watchdog.service

[Install]
WantedBy=timers.target
EOF

  run_sudo systemctl daemon-reload || { warn "systemctl daemon-reload falhou; tentando cron."; return 1; }
  # Evita execucao dupla se uma instalacao anterior usou cron.
  remove_watchdog_cron
  if run_sudo systemctl enable --now drac-watchdog.timer >/dev/null 2>&1; then
    log "Timer drac-watchdog ativo (systemctl list-timers | grep drac-watchdog)."
    return 0
  fi
  warn "Nao foi possivel habilitar o timer systemd; tentando cron."
  return 1
}

provision_watchdog_cron() {
  local script_path="$1"
  local interval="$2"
  if ! command -v crontab >/dev/null 2>&1; then
    warn "Nem systemd nem crontab disponiveis. Agende manualmente: */$interval * * * * $script_path"
    return 0
  fi

  log "Agendando runtime-watchdog via cron do usuario $DRAC_OPERATING_USER (a cada ${interval}min)"
  local cron_line existing merged
  cron_line="*/$interval * * * * PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin $script_path >/dev/null 2>&1 # drac-runtime-watchdog"

  existing="$(run_as_user "$DRAC_OPERATING_USER" crontab -l 2>/dev/null || true)"
  # Remove a nossa linha antiga (idempotencia) e re-adiciona a atual; preserva o resto.
  merged="$(printf '%s\n' "$existing" | grep -v 'drac-runtime-watchdog' | sed '/^[[:space:]]*$/d' || true)"
  merged="$(printf '%s\n%s\n' "$merged" "$cron_line" | sed '/^[[:space:]]*$/d')"
  if printf '%s\n' "$merged" | run_as_user "$DRAC_OPERATING_USER" crontab - 2>/dev/null; then
    log "Cron do watchdog instalado (crontab -l -u $DRAC_OPERATING_USER)."
  else
    warn "Falha ao instalar o cron do watchdog. Agende manualmente: $cron_line"
  fi
  return 0
}

provision_watchdog() {
  if [ "$DRAC_WATCHDOG_ENABLED" != "true" ]; then
    log "Watchdog de runtime desabilitado (DRAC_WATCHDOG_ENABLED=$DRAC_WATCHDOG_ENABLED); pulando agendamento."
    return 0
  fi

  local script_path="$DRAC_INSTALL_DIR/scripts/runtime-watchdog.sh"
  if [ ! -f "$script_path" ]; then
    warn "runtime-watchdog.sh nao encontrado em $script_path; auto-cura nao sera agendada."
    return 0
  fi
  run_sudo chmod +x "$script_path" 2>/dev/null || true

  # Intervalo em minutos (1..59); cai para 5 se invalido.
  local interval="$DRAC_WATCHDOG_INTERVAL_MINUTES"
  case "$interval" in
    ''|*[!0-9]*) interval=5 ;;
  esac
  { [ "$interval" -ge 1 ] && [ "$interval" -le 59 ]; } 2>/dev/null || interval=5

  if provision_watchdog_systemd "$script_path" "$interval"; then
    return 0
  fi
  provision_watchdog_cron "$script_path" "$interval"
  return 0
}

register_central_now() {
  local base="${DRAC_CENTRAL_URL%/}"
  local payload response_file
  response_file="$(mktemp)"
  payload="$(printf '{"installation":{"id":"%s","name":"%s","customerName":"%s","version":"%s","launchProfile":"standard"},"summary":{"status":"installing","alerts":[]}}' \
    "$(json_escape "$DRAC_INSTALLATION_ID")" \
    "$(json_escape "$DRAC_INSTALLATION_ID")" \
    "$(json_escape "$DRAC_CUSTOMER_NAME")" \
    "$(json_escape "$DRAC_INSTALLER_COMMIT")")"

  log "Registrando instalacao imediatamente na DRAC Central"
  if curl -fsS --max-time 12 \
    -H 'Content-Type: application/json' \
    -H "X-DRAC-Installation-Id: $DRAC_INSTALLATION_ID" \
    -H "X-DRAC-License-Key: $DRAC_LICENSE_KEY" \
    -d "$payload" \
    "$base/api/agent/heartbeat" > "$response_file"; then
    log "Primeiro heartbeat aceito pela Central."
  else
    warn "A Central nao aceitou o heartbeat imediato; o conector local continuara tentando automaticamente."
    rm -f "$response_file"
    return 0
  fi

  if curl -fsS --max-time 12 \
    -H "X-DRAC-Installation-Id: $DRAC_INSTALLATION_ID" \
    -H "X-DRAC-License-Key: $DRAC_LICENSE_KEY" \
    "$base/api/agent/status" >/dev/null; then
    log "Instalacao confirmada na Central."
  else
    warn "Heartbeat enviado, mas a confirmacao de status da Central ainda nao respondeu."
  fi
  rm -f "$response_file"
}

validate_installation() {
  log "Validando instalacao"
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | sed -n '1,20p'

  wait_for_http "API local" "http://127.0.0.1:3000/health" 30 3 || true
  wait_for_http "Painel local" "http://127.0.0.1:5173/" 20 3 || true

  if curl -fsS "${DRAC_CENTRAL_URL%/}/api/health" >/dev/null; then
    log "Central respondeu em ${DRAC_CENTRAL_URL%/}/api/health"
  else
    warn "Nao foi possivel validar a central agora. Confira rede/firewall e CLOUD_API_URL."
  fi

  if [ -x "$DRAC_INSTALL_DIR/scripts/production-readiness.sh" ]; then
    log "Executando checklist automatico de producao"
    if run_as_user "$DRAC_OPERATING_USER" bash -lc "cd '$DRAC_INSTALL_DIR' && ./scripts/production-readiness.sh"; then
      log "Checklist automatico retornou Pronto."
    else
      warn "Checklist automatico encontrou pendencias. Revise os itens ATENCAO/BLOQUEADO acima."
    fi
  fi
}

print_summary() {
  cat <<EOF

Instalacao DRAC concluida.

Painel local:
  http://${DRAC_SERVER_IP}:5173

API local:
  http://${DRAC_SERVER_IP}:3000/health

Central configurada:
  ${DRAC_CENTRAL_URL}

Instalacao enviada para a central:
  ${DRAC_INSTALLATION_ID} - ${DRAC_CUSTOMER_NAME}

Versao imutavel instalada:
  ${DRAC_INSTALLER_COMMIT}

Auto-cura / monitoramento (watchdog de infra):
  journalctl -t drac-watchdog             (eventos e auto-curas)
  systemctl list-timers | grep drac-watchdog   (se agendado via systemd)

Se a instalacao ainda nao apareceu na central, aguarde ate 60 segundos
ou verifique os logs:
  docker logs --tail=120 vms-api

EOF
}

main() {
  log "Instalador DRAC VMS"
  preflight
  ensure_operating_user
  install_host_dependencies
  sync_repository
  prepare_env
  start_stack
  run_migrations
  provision_watchdog || warn "Watchdog nao pode ser agendado automaticamente; agende scripts/runtime-watchdog.sh manualmente."
  register_central_now
  validate_installation
  print_summary
}

main "$@"
