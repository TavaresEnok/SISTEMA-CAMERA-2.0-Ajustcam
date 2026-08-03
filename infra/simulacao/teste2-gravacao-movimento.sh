#!/usr/bin/env bash
# ── TESTE 2: CAPACIDADE COM GRAVAÇÃO POR MOVIMENTO ──────────────────────────
#
# Pergunta: quantas câmeras a máquina sustenta gravando por movimento, sem
# ninguém assistindo?
#
# O que esse modo liga, e que os outros testes não tinham:
#   · a ANÁLISE de vídeo do servidor (MOG2 no ai-service), que precisa decodificar
#     o fluxo continuamente para detectar movimento — é o custo dominante aqui;
#   · a GRAVAÇÃO em si, que é remux para disco quando o movimento dispara.
#
# A regra do produto (ai-manager.service.ts) só analisa câmera que é ao mesmo
# tempo `recordingMode='motion'` E `motionTrigger='SYSTEM'`. As duas condições
# são forçadas aqui — sem isso o teste mediria câmeras paradas e daria um número
# otimista e falso.
#
# Medição por série temporal (mediana e p95), não foto única: a análise de
# movimento tem picos por keyframe e a gravação escreve em rajadas.
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
PATAMARES="${*:-10 25}"
ESTABILIZA=120   # a IA leva ~1 min para abrir os processadores

psql() { docker exec vms-postgres psql -U vms -d vms_db -t -A "$@"; }

echo "cams|cpu_mediana|cpu_p95|mem_mb|cpu_gerador|load|variacao%|amostras|proc_ia|disco_mb"
for N in $PATAMARES; do
  "$AQUI/cadastrar-api.sh" limpar >/dev/null
  docker rm -f sim-publishers sim-readers >/dev/null 2>&1 || true
  "$AQUI/gerar-fontes.sh" "$N" h264 >/dev/null
  sleep 15
  "$AQUI/cadastrar-api.sh" criar "$N" motion >/dev/null

  # A criação pela API pode não fixar motionTrigger; garante que a análise do
  # SERVIDOR seja a acionada (e não um evento ONVIF, que a fonte sintética não emite).
  # analyticsSubtype=0 é ESSENCIAL: a IA monta a própria URL a partir desse
  # campo, e com o padrão 1 ela pediria um caminho que a fonte sintética não
  # serve — o detector abria e morria em timeout de 30 s, medindo processadores
  # falhando em vez de análise real (foi o que invalidou a primeira rodada).
  psql -c "UPDATE \"Camera\" SET \"motionTrigger\"='SYSTEM', \"aiEnabled\"=true,
           \"analyticsSubtype\"=0, \"analyticsChannel\"=1
           WHERE name LIKE '[SIM]%';" >/dev/null
  # Reinicia a análise para pegar a URL corrigida.
  docker restart vms-ai-service >/dev/null 2>&1 || true
  sleep 20
  sleep "$ESTABILIZA"

  DISCO_ANTES=$(du -sm /home/flashnet/Drac/infra/storage 2>/dev/null | cut -f1 || echo 0)
  M=$("$AQUI/medir-serie.sh" "cams-$N" 10 5)
  DISCO_DEPOIS=$(du -sm /home/flashnet/Drac/infra/storage 2>/dev/null | cut -f1 || echo 0)

  PROC=$(docker exec vms-api node -e "
    fetch('http://ai-service:8000/status').then(r=>r.json())
      .then(d=>console.log(Object.keys(d.processors||{}).length)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
  IFS='|' read -r _ med p95 mem ger load cv am <<< "$M"
  echo "$N|$med|$p95|$mem|$ger|$load|$cv|$am|${PROC:-0}|$((DISCO_DEPOIS-DISCO_ANTES))"
done
