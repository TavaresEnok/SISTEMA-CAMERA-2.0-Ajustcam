#!/usr/bin/env bash
#
# Fixture RTSP SINTÉTICA para o e2e do pipeline de vídeo (item 0.3 do
# docs/PLANO-EVOLUCAO-DRAC.md).
#
# Sobe, em CONTAINERS EFÊMEROS e ISOLADOS (rede docker própria), um servidor RTSP
# de teste + uma fonte sintética (ffmpeg lavfi `testsrc`), para o e2e exercitar o
# caminho REAL de streaming/gravação — não CRUD. NÃO toca o MediaMTX de produção:
#   * imagem: a MESMA `bluenviron/mediamtx:1-ffmpeg` (já cacheada no host), mas
#     um container com NOME e REDE próprios (drac-e2e-*), config gerada em runtime
#     (permissiva, jamais o infra/mediamtx.yml de produção) e portas de HOST
#     distintas (default 127.0.0.1:19997 API / :18554 RTSP) — zero conflito com o
#     vms-mediamtx vivo.
#
# Uso:
#   scripts/e2e-rtsp-fixture.sh up       # sobe server + publisher, espera o path ficar READY
#   scripts/e2e-rtsp-fixture.sh status   # imprime estado (exit!=0 se não estiver pronto)
#   scripts/e2e-rtsp-fixture.sh down     # derruba tudo (idempotente)
#   scripts/e2e-rtsp-fixture.sh run      # up -> roda o e2e (pnpm --filter api test:e2e:rtsp) -> down
#
# Variáveis (com defaults):
#   E2E_RTSP_API_PORT=19997   porta de host p/ a API do MediaMTX de teste
#   E2E_RTSP_PORT=18554       porta de host p/ o RTSP do MediaMTX de teste
#   E2E_RTSP_PATH=e2ecam      nome do path publicado
#   E2E_MEDIAMTX_IMAGE=bluenviron/mediamtx:1-ffmpeg
#
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

NET=drac-e2e-net
MTX=drac-e2e-mediamtx
PUB=drac-e2e-publisher

E2E_RTSP_API_PORT="${E2E_RTSP_API_PORT:-19997}"
E2E_RTSP_PORT="${E2E_RTSP_PORT:-18554}"
E2E_RTSP_PATH="${E2E_RTSP_PATH:-e2ecam}"
E2E_MEDIAMTX_IMAGE="${E2E_MEDIAMTX_IMAGE:-bluenviron/mediamtx:1-ffmpeg}"

API_URL="http://127.0.0.1:${E2E_RTSP_API_PORT}"
RTSP_URL="rtsp://127.0.0.1:${E2E_RTSP_PORT}/${E2E_RTSP_PATH}"

log() { printf '[e2e-rtsp-fixture] %s\n' "$*" >&2; }

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "ERRO: docker não encontrado. A fixture RTSP sintética exige docker."
    exit 3
  fi
}

# Config EFÊMERA e PERMISSIVA do MediaMTX de teste — gerada em runtime num arquivo
# temporário. NÃO é o infra/mediamtx.yml de produção. Libera API/publish/read de
# qualquer IP porque a porta é publicada só em 127.0.0.1 do host de teste; o
# default do MediaMTX restringe a API ao loopback do container (a curl do host
# chega pelo gateway docker e tomaria "authentication error").
write_mtx_config() {
  local dest="$1"
  cat > "$dest" <<'YAML'
logLevel: info
api: yes
apiAddress: :9997
authMethod: internal
authInternalUsers:
  - user: any
    pass:
    ips: []
    permissions:
      - action: publish
      - action: read
      - action: playback
      - action: api
      - action: metrics
rtsp: yes
rtspAddress: :8554
rtspTransports: [tcp, udp]
hls: no
webrtc: no
rtmp: no
srt: no
paths:
  all_others:
YAML
}

path_ready() {
  # Sem depender de jq no runner: extrai "ready":true|false do path alvo.
  curl -s --max-time 3 "${API_URL}/v3/paths/get/${E2E_RTSP_PATH}" 2>/dev/null \
    | grep -q '"ready":true'
}

up() {
  require_docker
  down_quiet

  log "criando rede ${NET}"
  docker network create "$NET" >/dev/null 2>&1 || true

  local cfg
  cfg="$(mktemp /tmp/drac-e2e-mtx.XXXXXX.yml)"
  write_mtx_config "$cfg"

  log "subindo servidor RTSP de teste (${MTX}) — imagem ${E2E_MEDIAMTX_IMAGE}"
  docker run -d --name "$MTX" --network "$NET" \
    -v "${cfg}:/mediamtx.yml:ro" \
    -p "127.0.0.1:${E2E_RTSP_API_PORT}:9997" \
    -p "127.0.0.1:${E2E_RTSP_PORT}:8554" \
    "$E2E_MEDIAMTX_IMAGE" >/dev/null

  log "aguardando a API do MediaMTX de teste em ${API_URL}"
  local ok=""
  for _ in $(seq 1 30); do
    if curl -sf --max-time 3 "${API_URL}/v3/paths/list" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ -z "$ok" ]; then
    log "ERRO: API do MediaMTX de teste não respondeu."
    docker logs "$MTX" 2>&1 | tail -20 >&2 || true
    exit 4
  fi

  log "subindo publisher sintético (${PUB}) — ffmpeg lavfi testsrc -> ${E2E_RTSP_PATH}"
  # H.264 640x480 15fps + áudio senoidal AAC. -re = ritmo de tempo real (como uma
  # câmera). lavfi é infinito, roda até o container ser removido.
  docker run -d --name "$PUB" --network "$NET" \
    --entrypoint ffmpeg "$E2E_MEDIAMTX_IMAGE" \
    -hide_banner -loglevel error -re \
    -f lavfi -i "testsrc=size=640x480:rate=15" \
    -f lavfi -i "sine=frequency=1000:sample_rate=44100" \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 30 \
    -c:a aac \
    -f rtsp -rtsp_transport tcp "rtsp://${MTX}:8554/${E2E_RTSP_PATH}" >/dev/null

  log "aguardando o path '${E2E_RTSP_PATH}' ficar READY no MediaMTX de teste"
  ok=""
  for _ in $(seq 1 30); do
    if path_ready; then ok=1; break; fi
    sleep 1
  done
  if [ -z "$ok" ]; then
    log "ERRO: path '${E2E_RTSP_PATH}' não ficou pronto."
    docker logs "$PUB" 2>&1 | tail -20 >&2 || true
    exit 5
  fi

  log "PRONTO. API=${API_URL}  RTSP=${RTSP_URL}"
  # Emite exports para quem quiser 'eval $(scripts/e2e-rtsp-fixture.sh up)'.
  echo "export DRAC_E2E_RTSP_API_URL=${API_URL}"
  echo "export DRAC_E2E_RTSP_URL=${RTSP_URL}"
  echo "export DRAC_E2E_RTSP_PATH=${E2E_RTSP_PATH}"
}

status() {
  require_docker
  if ! docker ps --format '{{.Names}}' | grep -qx "$MTX"; then
    log "servidor RTSP de teste não está rodando"; exit 1
  fi
  if path_ready; then
    log "OK: path '${E2E_RTSP_PATH}' READY em ${API_URL}"
    curl -s --max-time 3 "${API_URL}/v3/paths/get/${E2E_RTSP_PATH}" || true
    echo
  else
    log "servidor de pé, mas path '${E2E_RTSP_PATH}' NÃO está pronto"; exit 1
  fi
}

down_quiet() {
  rm -f /tmp/drac-e2e-mtx.*.yml 2>/dev/null || true
  docker rm -f "$PUB" >/dev/null 2>&1 || true
  docker rm -f "$MTX" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

down() {
  require_docker
  log "derrubando fixture"
  down_quiet
  log "ok"
}

run() {
  # Conveniência local: sobe, roda o e2e, e SEMPRE derruba (mesmo em falha).
  # Limpa SEMPRE — inclusive se o próprio `up` abortar (API não responde / path não
  # fica READY). Sem o trap, o `exit` do up deixava container+rede segurando as
  # portas de teste.
  trap down_quiet EXIT
  up >/dev/null
  local rc=0
  # DRAC_E2E_REQUIRED é repassado do ambiente (CI seta =1 p/ falhar se algo não
  # configurar, em vez de pular calado).
  DRAC_E2E_RTSP_API_URL="$API_URL" \
  DRAC_E2E_RTSP_URL="$RTSP_URL" \
  DRAC_E2E_RTSP_PATH="$E2E_RTSP_PATH" \
  DRAC_E2E_REQUIRED="${DRAC_E2E_REQUIRED:-}" \
    pnpm --filter api test:e2e:rtsp || rc=$?
  down
  return "$rc"
}

cmd="${1:-}"
case "$cmd" in
  up) up ;;
  status) status ;;
  down) down ;;
  run) run ;;
  *)
    echo "uso: $0 {up|status|down|run}" >&2
    exit 2
    ;;
esac
