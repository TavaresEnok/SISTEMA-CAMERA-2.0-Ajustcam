#!/usr/bin/env bash
#
# Fixture POSTGRES EFÊMERA para o e2e de autorização (RBAC) contra banco REAL.
#
# Por que existe: a matriz de acesso (apps/api/tests/access-matrix.test.ts) roda
# contra um Prisma FAKE — um objeto literal que reimplementa a semântica de
# `where` à mão. Isso cobre a lógica pura, mas é estruturalmente cego para a
# classe de bug que mais dói num produto multi-cliente:
#   * `select:` é honrado pelo Prisma real e IGNORADO pelo fake;
#   * constraints do banco (o CHECK cameraId XOR groupId, os índices únicos
#     parciais, o ON DELETE RESTRICT do dono) não existem no fake;
#   * uma query cujo `where` o fake não modelou pode devolver TUDO — no banco
#     real ela devolve o que o SQL mandar.
# Um vazamento de câmera entre clientes é o incidente mais caro deste produto;
# ele merece um teste que fale com o Postgres de verdade.
#
# NÃO TOCA A INSTALAÇÃO VIVA. Container com nome próprio (drac-e2e-postgres),
# porta de host distinta (default 127.0.0.1:15432 — a de produção é 5432) e um
# banco descartável criado só para a rodada. O e2e faz TRUNCATE; apontar isto
# para o banco de produção destruiria dados, então o isolamento é deliberado e
# as portas/nomes seguem o mesmo precedente da fixture RTSP (drac-e2e-*).
#
# Uso:
#   scripts/e2e-postgres-fixture.sh up      # sobe o Postgres e aplica as migrations
#   scripts/e2e-postgres-fixture.sh status  # exit!=0 se não estiver pronto
#   scripts/e2e-postgres-fixture.sh down    # derruba (idempotente)
#   scripts/e2e-postgres-fixture.sh run     # up -> roda o e2e -> down (sempre derruba)
#
# Variáveis (com defaults):
#   E2E_PG_PORT=15432                porta de HOST do Postgres de teste
#   E2E_PG_IMAGE=postgres:16-alpine  imagem (a mesma já usada pela infra)
#
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

PG=drac-e2e-postgres
E2E_PG_PORT="${E2E_PG_PORT:-15432}"
E2E_PG_IMAGE="${E2E_PG_IMAGE:-postgres:16-alpine}"
PG_USER=drac_e2e
PG_PASS=drac_e2e
PG_DB=drac_e2e

DB_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${E2E_PG_PORT}/${PG_DB}?schema=public"

log() { printf '[e2e-pg-fixture] %s\n' "$*" >&2; }

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "ERRO: docker não encontrado. A fixture Postgres exige docker."
    exit 3
  fi
}

pg_ready() {
  docker exec "$PG" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1
}

up() {
  require_docker
  # Idempotente: uma sobra de rodada anterior seguraria a porta.
  docker rm -f "$PG" >/dev/null 2>&1 || true

  log "subindo Postgres de teste em 127.0.0.1:${E2E_PG_PORT}"
  docker run -d --name "$PG" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASS" \
    -e POSTGRES_DB="$PG_DB" \
    -p "127.0.0.1:${E2E_PG_PORT}:5432" \
    "$E2E_PG_IMAGE" >/dev/null

  log "aguardando o banco aceitar conexão"
  local tries=0
  until pg_ready; do
    tries=$((tries + 1))
    if [ "$tries" -gt 60 ]; then
      log "ERRO: Postgres não ficou pronto em 60 tentativas"
      docker logs --tail 40 "$PG" >&2 || true
      exit 1
    fi
    sleep 1
  done

  # O schema REAL vem das migrations — é isso que faz o teste valer: os CHECKs e
  # índices únicos que o fake não tem passam a existir de verdade.
  log "aplicando migrations (prisma migrate deploy)"
  ( cd "$REPO_ROOT" && DATABASE_URL="$DB_URL" pnpm --filter api exec prisma migrate deploy >&2 )

  log "pronto: ${DB_URL}"
  echo "export DRAC_E2E_DATABASE_URL='${DB_URL}'"
}

status() {
  require_docker
  if ! docker ps --format '{{.Names}}' | grep -qx "$PG"; then
    log "Postgres de teste não está rodando"; exit 1
  fi
  if pg_ready; then
    log "OK: ${DB_URL}"
  else
    log "container de pé, mas o banco não aceita conexão"; exit 1
  fi
}

down_quiet() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
}

down() {
  require_docker
  log "derrubando fixture"
  down_quiet
  log "ok"
}

run() {
  # Sobe, roda o e2e e SEMPRE derruba — inclusive se o `up` abortar no meio
  # (senão o container fica segurando a porta de teste).
  trap down_quiet EXIT
  up >/dev/null
  local rc=0
  DRAC_E2E_DATABASE_URL="$DB_URL" \
  DRAC_E2E_REQUIRED="${DRAC_E2E_REQUIRED:-}" \
    pnpm --filter api test:e2e:pg || rc=$?
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
    printf 'uso: %s {up|status|down|run}\n' "$0" >&2
    exit 2
    ;;
esac
