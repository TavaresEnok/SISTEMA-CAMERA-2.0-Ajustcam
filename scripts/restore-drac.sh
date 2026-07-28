#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DRAC_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${DRAC_ENV_FILE:-$ROOT_DIR/infra/.env}"
BACKUP_FILE="${1:-}"
STORAGE_ARCHIVE="${2:-}"
YES="${DRAC_RESTORE_YES:-false}"
DATABASE_ONLY="${DRAC_RESTORE_DATABASE_ONLY:-false}"
POSTGRES_CONTAINER="${DRAC_POSTGRES_CONTAINER:-vms-postgres}"
COMPOSE_MODE="${DRAC_COMPOSE_MODE:-prod}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SAFETY_DIR="$ROOT_DIR/infra/backups/restore-safety-$STAMP"
STORAGE_LIVE="$ROOT_DIR/infra/storage"
STORAGE_STAGING="$ROOT_DIR/infra/.storage-restore-$STAMP"
STORAGE_PREVIOUS="$SAFETY_DIR/storage-before"
STORAGE_FAILED="$SAFETY_DIR/storage-failed-$STAMP"
VALIDATION_DB="drac_restore_validate_$(printf '%s' "$STAMP" | tr -cd '0-9A-Za-z_')"
case "$COMPOSE_MODE" in
  prod) COMPOSE_OVERRIDE="$ROOT_DIR/infra/docker-compose.prod.yml" ;;
  dev) COMPOSE_OVERRIDE="$ROOT_DIR/infra/docker-compose.dev.yml" ;;
  *) printf '[DRAC restore][ERRO] DRAC_COMPOSE_MODE deve ser prod ou dev.\n' >&2; exit 1 ;;
esac
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/infra/docker-compose.yml" -f "$COMPOSE_OVERRIDE")
RESTORE_MUTATED=false
ROLLBACK_IN_PROGRESS=false
STORAGE_SWAPPED=false
STORAGE_EXISTED=false

log() {
  printf '[DRAC restore] %s\n' "$*"
}

fail() {
  printf '[DRAC restore][ERRO] %s\n' "$*" >&2
  if ! rollback_restore "falha: $*"; then
    printf '[DRAC restore][ERRO] Intervenção manual obrigatória.\n' >&2
  fi
  exit 1
}

stop_writers() {
  "${COMPOSE[@]}" stop \
    api web drac-central ai-service camera-worker postgres-backup postgres-backup-verify
}

start_runtime() {
  "${COMPOSE[@]}" up -d \
    postgres redis mediamtx api drac-central web ai-service postgres-backup postgres-backup-verify
}

copy_dump_to_postgres() {
  local source_file="$1"
  local container_file="$2"
  docker cp "$source_file" "$POSTGRES_CONTAINER:$container_file" >/dev/null
  docker exec "$POSTGRES_CONTAINER" pg_restore --list "$container_file" >/dev/null
}

restore_target_database() {
  local container_file="$1"
  docker exec "$POSTGRES_CONTAINER" sh -lc '
    set -eu
    export PGPASSWORD="$POSTGRES_PASSWORD"
    pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --clean --if-exists --no-owner --exit-on-error --single-transaction \
      "$1"
  ' sh "$container_file"
}

validate_dump_in_scratch_database() {
  local container_file="$1"
  docker exec "$POSTGRES_CONTAINER" sh -lc '
    set -eu
    export PGPASSWORD="$POSTGRES_PASSWORD"
    validation_db="$1"
    dump_file="$2"
    dropdb -U "$POSTGRES_USER" --if-exists "$validation_db"
    createdb -U "$POSTGRES_USER" "$validation_db"
    cleanup() {
      dropdb -U "$POSTGRES_USER" --if-exists "$validation_db"
    }
    trap cleanup EXIT
    pg_restore -U "$POSTGRES_USER" -d "$validation_db" \
      --no-owner --exit-on-error --single-transaction "$dump_file"
    psql -U "$POSTGRES_USER" -d "$validation_db" -v ON_ERROR_STOP=1 \
      -Atqc "SELECT 1 FROM information_schema.tables WHERE table_schema = '\''public'\'' LIMIT 1" \
      | grep -qx 1
  ' sh "$VALIDATION_DB" "$container_file"
}

validate_storage_archive() {
  local archive="$1"
  # Nomes absolutos e qualquer componente ".." são recusados antes da extração.
  if ! tar -tf "$archive" | awk '
    BEGIN { bad = 0 }
    /^\// { bad = 1 }
    /(^|\/)\.\.(\/|$)/ { bad = 1 }
    END { exit bad }
  '; then
    fail "Archive de storage contém caminho absoluto ou traversal."
  fi
  # Links e tipos especiais não entram no storage restaurado. Isso evita que
  # playback/download atravesse a raiz depois da restauração.
  if tar -tvf "$archive" | awk '
    substr($1, 1, 1) ~ /[lhbcps]/ { bad = 1 }
    END { exit bad ? 0 : 1 }
  '; then
    fail "Archive de storage contém link ou arquivo especial."
  fi
}

rollback_restore() {
  local reason="${1:-falha desconhecida}"
  if [ "$RESTORE_MUTATED" != "true" ] || [ "$ROLLBACK_IN_PROGRESS" = "true" ]; then
    return 0
  fi
  ROLLBACK_IN_PROGRESS=true
  trap - ERR
  local rollback_status=0
  local quiesced=true
  printf '[DRAC restore] Rollback iniciado (%s)\n' "$reason" >&2

  if ! stop_writers >/dev/null; then
    printf '[DRAC restore][ERRO] Não foi possível manter os writers parados.\n' >&2
    rollback_status=1
    quiesced=false
  fi

  if [ "$quiesced" = "true" ] && [ -s "$SAFETY_DIR/postgres-before.dump" ]; then
    if ! copy_dump_to_postgres "$SAFETY_DIR/postgres-before.dump" /tmp/drac-restore-safety.dump \
      || ! restore_target_database /tmp/drac-restore-safety.dump; then
      printf '[DRAC restore][ERRO] Não foi possível restaurar o banco de segurança.\n' >&2
      rollback_status=1
    fi
    docker exec "$POSTGRES_CONTAINER" rm -f /tmp/drac-restore-safety.dump >/dev/null 2>&1 || rollback_status=1
  fi

  if [ "$STORAGE_SWAPPED" = "true" ]; then
    if [ -e "$STORAGE_LIVE" ]; then
      if ! mv "$STORAGE_LIVE" "$STORAGE_FAILED"; then
        printf '[DRAC restore][ERRO] Não foi possível preservar o storage restaurado com falha.\n' >&2
        rollback_status=1
      fi
    fi
    if [ "$STORAGE_EXISTED" = "true" ]; then
      if ! mv "$STORAGE_PREVIOUS" "$STORAGE_LIVE"; then
        printf '[DRAC restore][ERRO] Não foi possível recolocar o storage anterior.\n' >&2
        rollback_status=1
      fi
    elif ! mkdir -p "$STORAGE_LIVE"; then
      rollback_status=1
    fi
  fi

  if [ "$rollback_status" -eq 0 ]; then
    if ! start_runtime >/dev/null \
      || ! curl -fsS --max-time 30 http://127.0.0.1:3000/health >/dev/null \
      || ! curl -fsSI --max-time 30 http://127.0.0.1:5173/ >/dev/null; then
      rollback_status=1
    fi
  fi

  if [ "$rollback_status" -ne 0 ]; then
    printf '[DRAC restore][ERRO] ROLLBACK INCOMPLETO. Serviços devem permanecer parados. Segurança: %s\n' "$SAFETY_DIR" >&2
    return 1
  fi
  printf '[DRAC restore] Rollback validado. Segurança preservada em %s\n' "$SAFETY_DIR" >&2
  return 0
}

on_error() {
  local status=$?
  local line="${1:-?}"
  if ! rollback_restore "erro na linha $line"; then
    printf '[DRAC restore][ERRO] Intervenção manual obrigatória.\n' >&2
  fi
  exit "$status"
}

trap 'on_error $LINENO' ERR

if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE="$(find "$ROOT_DIR/infra/backups/postgres" -type f -name 'drac-postgres-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1 {print $2}')"
fi

[ -n "$BACKUP_FILE" ] || fail "Informe o dump do Postgres ou mantenha backups em infra/backups/postgres."
[ -f "$BACKUP_FILE" ] || fail "Dump não encontrado: $BACKUP_FILE"
[ -f "$ENV_FILE" ] || fail "infra/.env não encontrado."

if [ -z "$STORAGE_ARCHIVE" ] && [ "$DATABASE_ONLY" != "true" ]; then
  fail "Informe também o archive de storage ou declare DRAC_RESTORE_DATABASE_ONLY=true conscientemente."
fi
if [ -n "$STORAGE_ARCHIVE" ]; then
  [ -f "$STORAGE_ARCHIVE" ] || fail "Arquivo de storage não encontrado: $STORAGE_ARCHIVE"
fi

if [ "$YES" != "true" ] && [ "${3:-}" != "--yes" ]; then
  printf 'Esta operação restaura banco/storage e preserva um rollback local.\n'
  printf 'Use DRAC_RESTORE_YES=true ou passe --yes como terceiro argumento para executar.\n'
  exit 2
fi

mkdir -p "$SAFETY_DIR"
chmod 700 "$SAFETY_DIR"
sha256sum "$BACKUP_FILE" > "$SAFETY_DIR/restore-inputs.sha256"

log "Validando integralmente o dump em banco descartável"
copy_dump_to_postgres "$BACKUP_FILE" /tmp/drac-restore-input.dump
validate_dump_in_scratch_database /tmp/drac-restore-input.dump

if [ -n "$STORAGE_ARCHIVE" ]; then
  log "Validando archive de storage e extraindo para staging isolado"
  sha256sum "$STORAGE_ARCHIVE" >> "$SAFETY_DIR/restore-inputs.sha256"
  validate_storage_archive "$STORAGE_ARCHIVE"
  mkdir -p "$STORAGE_STAGING"
  chmod 700 "$STORAGE_STAGING"
  tar --no-same-owner --no-same-permissions -xf "$STORAGE_ARCHIVE" -C "$STORAGE_STAGING"
  if find "$STORAGE_STAGING" \( -type l -o -type b -o -type c -o -type p -o -type s \) -print -quit | grep -q .; then
    fail "Storage extraído contém link ou arquivo especial."
  fi
fi

log "Criando dump de segurança do estado atual"
docker exec "$POSTGRES_CONTAINER" sh -lc '
  set -eu
  export PGPASSWORD="$POSTGRES_PASSWORD"
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc
' > "$SAFETY_DIR/postgres-before.dump"
[ -s "$SAFETY_DIR/postgres-before.dump" ] || fail "Dump de segurança atual ficou vazio."
copy_dump_to_postgres "$SAFETY_DIR/postgres-before.dump" /tmp/drac-restore-safety-validate.dump
docker exec "$POSTGRES_CONTAINER" rm -f /tmp/drac-restore-safety-validate.dump

log "Parando todos os processos que podem escrever em banco ou storage"
stop_writers
RESTORE_MUTATED=true

log "Restaurando banco em transação única"
restore_target_database /tmp/drac-restore-input.dump
docker exec "$POSTGRES_CONTAINER" rm -f /tmp/drac-restore-input.dump

if [ -n "$STORAGE_ARCHIVE" ]; then
  log "Trocando storage por rename, mantendo o anterior intacto"
  if [ -e "$STORAGE_LIVE" ]; then
    mv "$STORAGE_LIVE" "$STORAGE_PREVIOUS"
    STORAGE_EXISTED=true
  fi
  # A partir deste ponto o caminho ativo já foi alterado. Marcar antes do
  # segundo rename garante rollback mesmo se a instalação do staging falhar.
  STORAGE_SWAPPED=true
  mv "$STORAGE_STAGING" "$STORAGE_LIVE"
fi

log "Subindo serviços"
start_runtime

log "Validando API e Web"
curl -fsS --max-time 30 http://127.0.0.1:3000/health >/dev/null
curl -fsSI --max-time 30 http://127.0.0.1:5173/ >/dev/null

if [ -x "$ROOT_DIR/scripts/production-readiness.sh" ]; then
  set +e
  "$ROOT_DIR/scripts/production-readiness.sh"
  readiness_status=$?
  set -e
  if [ "$readiness_status" -ge 2 ]; then
    fail "Readiness bloqueou o estado restaurado."
  fi
fi

RESTORE_MUTATED=false
log "Restore validado. Estado anterior preservado para rollback em $SAFETY_DIR"
