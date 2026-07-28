#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DRAC_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${DRAC_ENV_FILE:-$ROOT_DIR/infra/.env}"
BRANCH="${DRAC_UPDATE_BRANCH:-main}"
COMPOSE_MODE="${DRAC_COMPOSE_MODE:-prod}"
POSTGRES_CONTAINER="${DRAC_POSTGRES_CONTAINER:-vms-postgres}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$ROOT_DIR/infra/backups/update-$STAMP"
case "$COMPOSE_MODE" in
  prod) COMPOSE_OVERRIDE="$ROOT_DIR/infra/docker-compose.prod.yml" ;;
  dev) COMPOSE_OVERRIDE="$ROOT_DIR/infra/docker-compose.dev.yml" ;;
  *) printf '[DRAC update][ERRO] DRAC_COMPOSE_MODE deve ser prod ou dev.\n' >&2; exit 1 ;;
esac
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/infra/docker-compose.yml" -f "$COMPOSE_OVERRIDE")
BEFORE_COMMIT=""
ROLLBACK_NEEDED=false
ROLLBACK_IN_PROGRESS=false

log() {
  printf '[DRAC update] %s\n' "$*"
}

fail() {
  printf '[DRAC update][ERRO] %s\n' "$*" >&2
  if ! rollback "falha: $*"; then
    printf '[DRAC update][ERRO] Rollback incompleto; mantenha os serviços parados e use o ponto de segurança: %s\n' "$BACKUP_DIR" >&2
  fi
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "Arquivo obrigatorio nao encontrado: $1"
}

ensure_mediamtx_callback_token() {
  local current=""
  current="$(sed -n 's/^MEDIAMTX_AUTH_CALLBACK_TOKEN=//p' "$ENV_FILE" | tail -n 1)"
  if [[ "$current" =~ ^[a-fA-F0-9]{48,128}$ ]]; then
    return 0
  fi
  if [ -n "$current" ]; then
    fail "MEDIAMTX_AUTH_CALLBACK_TOKEN existe, mas não é hexadecimal ou tem menos de 24 bytes; corrija a configuração sem reutilizar outra credencial."
  fi
  command -v openssl >/dev/null 2>&1 \
    || fail "openssl é obrigatório para gerar MEDIAMTX_AUTH_CALLBACK_TOKEN."
  local generated
  generated="$(openssl rand -hex 24)"
  printf '\nMEDIAMTX_AUTH_CALLBACK_TOKEN=%s\n' "$generated" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  generated=''
  log "Token dedicado do callback MediaMTX criado para esta atualização."
}

rollback() {
  local reason="${1:-erro desconhecido}"
  if [ "$ROLLBACK_NEEDED" != "true" ] || [ "$ROLLBACK_IN_PROGRESS" = "true" ]; then
    return 0
  fi
  ROLLBACK_IN_PROGRESS=true
  trap - ERR
  printf '[DRAC update] Rollback automatico iniciado (%s)\n' "$reason" >&2
  local rollback_status=0
  local quiesced=true

  # Quiesce é obrigatório antes de tocar no banco. Não existe restore seguro
  # enquanto a API pode gravar usando o schema novo.
  if ! "${COMPOSE[@]}" stop api web drac-central >/dev/null; then
    printf '[DRAC update][ERRO] Não foi possível parar API/Web/Central para rollback.\n' >&2
    rollback_status=1
    quiesced=false
  fi

  if [ -n "$BEFORE_COMMIT" ]; then
    if ! git -C "$ROOT_DIR" reset --hard "$BEFORE_COMMIT" >/dev/null; then
      printf '[DRAC update][ERRO] Não foi possível restaurar o commit anterior.\n' >&2
      rollback_status=1
    fi
  fi

  if [ -f "$BACKUP_DIR/env.snapshot" ]; then
    if ! cp "$BACKUP_DIR/env.snapshot" "$ENV_FILE" || ! chmod 600 "$ENV_FILE"; then
      printf '[DRAC update][ERRO] Não foi possível restaurar o ambiente anterior.\n' >&2
      rollback_status=1
    fi
  fi

  if [ "$quiesced" = "true" ] && [ -s "$BACKUP_DIR/postgres-before.dump" ] && docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1; then
    printf '[DRAC update] Restaurando banco do ponto de seguranca\n' >&2
    if ! docker cp "$BACKUP_DIR/postgres-before.dump" "$POSTGRES_CONTAINER:/tmp/drac-update-rollback.dump" >/dev/null; then
      printf '[DRAC update][ERRO] Não foi possível copiar o dump de rollback.\n' >&2
      rollback_status=1
    elif ! docker exec "$POSTGRES_CONTAINER" sh -lc '
      set -eu
      export PGPASSWORD="$POSTGRES_PASSWORD"
      pg_restore --list /tmp/drac-update-rollback.dump >/dev/null
      pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --clean --if-exists --no-owner --exit-on-error --single-transaction \
        /tmp/drac-update-rollback.dump
      rm -f /tmp/drac-update-rollback.dump
    ' >/dev/null; then
      printf '[DRAC update][ERRO] A restauração transacional do banco falhou.\n' >&2
      rollback_status=1
    fi
  fi

  if [ "$rollback_status" -eq 0 ]; then
    if ! "${COMPOSE[@]}" build api web drac-central >/dev/null \
      || ! "${COMPOSE[@]}" up -d api web drac-central >/dev/null \
      || ! curl -fsS --max-time 30 http://127.0.0.1:3000/health >/dev/null \
      || ! curl -fsSI --max-time 30 http://127.0.0.1:5173/ >/dev/null; then
      printf '[DRAC update][ERRO] Código anterior restaurado, mas os serviços não validaram.\n' >&2
      rollback_status=1
    fi
  fi
  if [ "$rollback_status" -ne 0 ]; then
    printf '[DRAC update][ERRO] ROLLBACK INCOMPLETO. Ponto de segurança: %s\n' "$BACKUP_DIR" >&2
    return 1
  fi
  printf '[DRAC update] Rollback validado. Ponto de seguranca: %s\n' "$BACKUP_DIR" >&2
  return 0
}

on_error() {
  local status=$?
  local line="${1:-?}"
  if ! rollback "erro na linha $line"; then
    printf '[DRAC update][ERRO] Intervenção manual obrigatória; serviços permanecem parados.\n' >&2
  fi
  exit "$status"
}

trap 'on_error $LINENO' ERR

preflight_recording_duplicates() {
  local result
  result="$(docker exec "$POSTGRES_CONTAINER" sh -lc '
    set -eu
    export PGPASSWORD="$POSTGRES_PASSWORD"
    psql_value() {
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -v ON_ERROR_STOP=1 -Atqc "$1"
    }

    if [ "$(psql_value "SELECT to_regclass('\''public._prisma_migrations'\'') IS NOT NULL")" = t ]; then
      applied="$(psql_value "
        SELECT EXISTS (
          SELECT 1 FROM \"_prisma_migrations\"
          WHERE migration_name = '\''20260501042000_recordings_indexes'\''
            AND finished_at IS NOT NULL
            AND rolled_back_at IS NULL
        )
      ")"
      if [ "$applied" = t ]; then
        printf "already_applied\n"
        exit 0
      fi
    fi

    if [ "$(psql_value "SELECT to_regclass('\''public.Recording'\'') IS NOT NULL")" != t ]; then
      printf "clean\n"
      exit 0
    fi

    duplicate_count="$(psql_value "
      SELECT COALESCE(SUM(extra), 0)
      FROM (
        SELECT COUNT(*) - 1 AS extra
        FROM \"Recording\"
        GROUP BY \"filePath\"
        HAVING COUNT(*) > 1
      ) duplicates
    ")"
    if [ "$duplicate_count" = 0 ]; then
      printf "clean\n"
    else
      printf "duplicates:%s\n" "$duplicate_count"
    fi
  ')"
  case "$result" in
    already_applied|clean)
      return 0
      ;;
    duplicates:*)
      fail "Migration recordings_indexes ainda não aplicada e há ${result#duplicates:} metadado(s) duplicado(s). Reconcilie em laboratório a linha canônica e seus relacionamentos; a atualização recusou a deleção arbitrária por ctid."
      ;;
    *)
      fail "Preflight de duplicatas retornou estado inesperado; migrações não serão executadas."
      ;;
  esac
}

require_file "$ENV_FILE"
mkdir -p "$BACKUP_DIR"

if [ "${DRAC_UPDATE_ALLOW_DIRTY:-false}" != "true" ] && [ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]; then
  fail "Repositorio possui alteracoes locais. Faça commit/stash ou use DRAC_UPDATE_ALLOW_DIRTY=true conscientemente."
fi

log "Gerando ponto de seguranca em $BACKUP_DIR"
cp "$ENV_FILE" "$BACKUP_DIR/env.snapshot"
BEFORE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
printf '%s\n' "$BEFORE_COMMIT" > "$BACKUP_DIR/git-before.txt"
git -C "$ROOT_DIR" status --short > "$BACKUP_DIR/git-status-before.txt"
ensure_mediamtx_callback_token

if "${COMPOSE[@]}" ps postgres >/dev/null 2>&1; then
  log "Gerando backup rapido do banco"
  set +e
  docker exec "$POSTGRES_CONTAINER" sh -lc 'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP_DIR/postgres-before.dump"
  dump_status=$?
  set -e
  if [ "$dump_status" -ne 0 ] || [ ! -s "$BACKUP_DIR/postgres-before.dump" ]; then
    rm -f "$BACKUP_DIR/postgres-before.dump"
    fail "Falha ao gerar backup do banco antes da atualizacao"
  fi
  docker cp "$BACKUP_DIR/postgres-before.dump" "$POSTGRES_CONTAINER:/tmp/drac-update-validate.dump" >/dev/null
  docker exec "$POSTGRES_CONTAINER" pg_restore --list /tmp/drac-update-validate.dump >/dev/null
  docker exec "$POSTGRES_CONTAINER" rm -f /tmp/drac-update-validate.dump
fi

log "Atualizando codigo pela branch $BRANCH"
ROLLBACK_NEEDED=true
git -C "$ROOT_DIR" fetch origin "$BRANCH"
git -C "$ROOT_DIR" merge --ff-only "origin/$BRANCH"

log "Construindo API, Web e Central sem alterar os serviços ativos"
"${COMPOSE[@]}" build api web drac-central

log "Verificando duplicatas históricas antes das migrações"
preflight_recording_duplicates

log "Parando API, Web e Central antes das migrações"
"${COMPOSE[@]}" stop api web drac-central

log "Aplicando migracoes com a aplicação quiescente"
"${COMPOSE[@]}" run --rm --no-deps -w /app/apps/api api npx prisma migrate deploy

log "Subindo API, Web e Central atualizadas"
"${COMPOSE[@]}" up -d api web drac-central

log "Validando healthchecks"
curl -fsS --max-time 15 http://127.0.0.1:3000/health >/dev/null
curl -fsSI --max-time 15 http://127.0.0.1:5173/ >/dev/null

if [ -x "$ROOT_DIR/scripts/production-readiness.sh" ]; then
  log "Executando readiness"
  set +e
  "$ROOT_DIR/scripts/production-readiness.sh"
  readiness_status=$?
  set -e
  if [ "$readiness_status" -ge 2 ]; then
    fail "Readiness bloqueado apos atualizacao. Backup em $BACKUP_DIR"
  fi
fi

git -C "$ROOT_DIR" rev-parse HEAD > "$BACKUP_DIR/git-after.txt"
ROLLBACK_NEEDED=false
log "Atualizacao concluida. Ponto de seguranca: $BACKUP_DIR"
