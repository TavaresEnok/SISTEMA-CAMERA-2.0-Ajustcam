#!/usr/bin/env bash
set -Eeuo pipefail

# Shim exclusivo dos laboratórios descartáveis de update/restore. Comandos
# Docker normais continuam indo ao daemon; apenas "docker compose" é simulado
# para que nenhum serviço real do DRAC seja parado, recriado ou reconstruído.
command_name="$(basename "$0")"
log_file="${DRAC_OPS_LAB_LOG:?DRAC_OPS_LAB_LOG is required}"

case "$command_name" in
  docker)
    if [ "${1:-}" = "compose" ]; then
      shift
      printf 'docker compose' >> "$log_file"
      printf ' %q' "$@" >> "$log_file"
      printf '\n' >> "$log_file"
      exit 0
    fi
    exec /usr/bin/docker "$@"
    ;;
  curl)
    printf 'curl' >> "$log_file"
    printf ' %q' "$@" >> "$log_file"
    printf '\n' >> "$log_file"
    if [ "${DRAC_OPS_LAB_FAIL_FIRST_HEALTH:-false}" = "true" ]; then
      marker="${DRAC_OPS_LAB_HEALTH_MARKER:?health marker is required}"
      if [ ! -e "$marker" ]; then
        : > "$marker"
        exit 22
      fi
    fi
    exit 0
    ;;
  *)
    printf 'Nome de shim inesperado: %s\n' "$command_name" >&2
    exit 64
    ;;
esac
