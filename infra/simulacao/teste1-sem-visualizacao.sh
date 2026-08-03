#!/usr/bin/env bash
# ── TESTE 1: CAPACIDADE SEM VISUALIZAÇÃO ────────────────────────────────────
#
# Pergunta: quantas câmeras a máquina sustenta com ninguém assistindo?
#
# A PRIMEIRA versão deste teste usava "quantas ficam ONLINE" como critério, e
# estava errada. Medindo, descobriu-se que o gargalo sem espectador NÃO é vídeo
# — é o HEALTH CHECK: o laço de reteste ativo percorre as câmeras uma a uma
# (`for...await getStatus`), e cada uma custa ~11 s de sonda RTSP+ONVIF. Com o
# ciclo rodando a cada 60 s, bastam 6 câmeras em reteste para o ciclo não
# fechar. Esperar "todas ONLINE" mediria a fila do health check, não a máquina.
#
# Então este teste mede o que de fato limita:
#   · custo em repouso de TER N câmeras cadastradas (CPU, memória, carga);
#   · quanto tempo um ciclo de verificação leva para fechar;
#   · quantas câmeras ficam para trás (fila de reteste crescendo = saturação).
#
# O critério de saturação é a fila: quando o reteste passa a demorar mais que o
# intervalo do ciclo, o sistema deixa de perceber câmera caída em tempo útil —
# e é esse o limite que importa num sistema de segurança.
#
# O cadastro é pela API (não pelo banco): inserir direto pulava o provisionamento
# e dava 0 câmeras ONLINE, medindo a fila do health check em vez do produto.
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
PATAMARES="${*:-10 25 50}"
ESTABILIZA=90

psql() { docker exec vms-postgres psql -U vms -d vms_db -t -A "$@"; }

echo "cams|online|unknown|cpu_prod|cpu_ger|mem_mb|load|retestes_ciclo|espera_fila_s"
for N in $PATAMARES; do
  "$AQUI/cadastrar-api.sh" limpar >/dev/null
  docker rm -f sim-publishers >/dev/null 2>&1 || true
  "$AQUI/gerar-fontes.sh" "$N" h264 >/dev/null
  sleep 15
  "$AQUI/cadastrar-api.sh" criar "$N" manual >/dev/null
  sleep "$ESTABILIZA"

  M=$("$AQUI/medir.sh" "x")
  IFS='|' read -r _ tot onl cpup cpug memv load nuc ffm <<< "$M"
  unk=$(psql -c "SELECT COUNT(*) FROM \"Camera\" WHERE name LIKE '[SIM]%' AND status='UNKNOWN';")
  # Quantas câmeras entraram em reteste no último ciclo e quanto isso custaria
  # em fila: cada reteste é ~11 s e eles são sequenciais.
  ret=$(docker logs vms-api --since 2m 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' \
        | grep -oE "[0-9]+ câmera\(s\) sem heartbeat" | tail -1 | grep -oE "^[0-9]+" || echo 0)
  fila=$(( ${ret:-0} * 11 ))
  echo "$N|$onl|$unk|$cpup|$cpug|$memv|$load|${ret:-0}|$fila"
done
