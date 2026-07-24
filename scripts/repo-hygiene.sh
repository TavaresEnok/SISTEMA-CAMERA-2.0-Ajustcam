#!/usr/bin/env bash
#
# repo-hygiene.sh — remove do RASTREAMENTO git artefatos que não deveriam
# estar versionados (item 0.4 do docs/PLANO-EVOLUCAO-DRAC.md).
#
# SEGURANÇA:
#   - Dry-run por PADRÃO: sem --apply, apenas LISTA o que faria.
#   - Usa `git rm --cached` (NÃO apaga o arquivo do disco, só deixa de rastrear).
#   - NUNCA faz commit nem push. Revise `git status` e commite você mesmo.
#
# Uso:
#   bash scripts/repo-hygiene.sh            # dry-run (mostra o plano)
#   bash scripts/repo-hygiene.sh --apply    # aplica no índice (sem commitar)
#   bash scripts/repo-hygiene.sh --apply --incluir-design   # tbm os dirs de design/legado
#
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

APPLY=0
INCLUIR_DESIGN=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --incluir-design) INCLUIR_DESIGN=1 ;;
    *) echo "arg desconhecido: $arg" >&2; exit 2 ;;
  esac
done

# Lixo óbvio: sempre elegível.
#  - scripts de debug soltos na raiz (check_users.js imprime hashes de senha)
#  - .zip de design versionado
LIXO_OBVIO=(
  "DRAC app redesign.zip"
  "check_recordings.js"
  "check_users.js"
  "reset_admin.js"
  "apps/api/reset_admin.js"
)

# Decisão do dono: diretórios de design/legado (podem ser referência intencional).
# Só saem do rastreamento com --incluir-design.
DIRS_DESIGN=(
  "Drac-app-redesign"
  "novo-design"
  "novo-mockup-app-drac"
  "archive"
  # "legacy"  # .gitignore tem exceção !legacy/README.md — trate manualmente se quiser
)

untrack() {
  local path="$1"
  if ! git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    # nada rastreado sob esse caminho
    return 0
  fi
  local n; n=$(git ls-files -- "$path" | wc -l | tr -d ' ')
  if [[ "$APPLY" -eq 1 ]]; then
    git rm -r --cached --quiet -- "$path"
    echo "  [removido do índice] $path ($n arquivo(s))"
  else
    echo "  [dry-run] removeria do índice: $path ($n arquivo(s))"
  fi
}

echo "== repo-hygiene =="
[[ "$APPLY" -eq 1 ]] && echo "MODO: --apply (altera o índice, NÃO commita)" || echo "MODO: dry-run (nada muda)"
echo
echo "-- lixo óbvio --"
for p in "${LIXO_OBVIO[@]}"; do untrack "$p"; done

echo
echo "-- dirs de design/legado --"
if [[ "$INCLUIR_DESIGN" -eq 1 ]]; then
  for p in "${DIRS_DESIGN[@]}"; do untrack "$p"; done
else
  echo "  (pulados; passe --incluir-design para removê-los) alvos:"
  for p in "${DIRS_DESIGN[@]}"; do echo "    - $p"; done
fi

echo
echo "-- .gitignore --"
ensure_ignore() {
  local pat="$1"
  if ! grep -qxF "$pat" .gitignore 2>/dev/null; then
    if [[ "$APPLY" -eq 1 ]]; then
      printf '%s\n' "$pat" >> .gitignore
      echo "  [+.gitignore] $pat"
    else
      echo "  [dry-run] adicionaria ao .gitignore: $pat"
    fi
  fi
}
ensure_ignore "/DRAC app redesign.zip"
ensure_ignore "/check_recordings.js"
ensure_ignore "/check_users.js"
ensure_ignore "/reset_admin.js"

echo
if [[ "$APPLY" -eq 1 ]]; then
  echo "Pronto. Revise 'git status' e commite manualmente (ver regra 1.4/9.1 do plano)."
else
  echo "Dry-run concluído. Rode com --apply para aplicar (continua sem commitar)."
fi
