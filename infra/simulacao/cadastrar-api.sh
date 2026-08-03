#!/usr/bin/env bash
# ── CADASTRO PELA API (caminho fiel) ────────────────────────────────────────
#
# A primeira versão inseria as câmeras direto no banco. Funcionava, mas PULAVA
# o provisionamento que uma câmera real recebe ao ser criada — sonda de status,
# criação dos paths no MediaMTX, início de gravação, análise de IA. O resultado
# foi 0 câmeras ONLINE em todos os patamares: elas ficavam esperando o health
# check, que é justamente o recurso saturado.
#
# Aqui o cadastro passa por POST /cameras, exatamente como a tela faz. O que se
# mede então é o custo REAL de acrescentar uma câmera ao produto, incluindo
# tudo que ele dispara.
#
#   uso: ./cadastrar-api.sh criar <n> [modo] | limpar
set -euo pipefail
ACAO="${1:?use: criar <n> [modo] | limpar}"
API="http://127.0.0.1:3000"
TOKEN_FILE="/tmp/claude-1000/-home-flashnet-Drac/18239e2c-6969-4dba-989b-137412c8a8ca/scratchpad/token.txt"
TOKEN="$(cat "$TOKEN_FILE")"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

if [[ "$ACAO" == "limpar" ]]; then
  IDS=$(curl -s "${AUTH[@]}" "$API/cameras" | python3 -c "
import sys,json
for c in json.load(sys.stdin):
    if c.get('name','').startswith('[SIM]'): print(c['id'])" 2>/dev/null || true)
  N=0
  for id in $IDS; do
    curl -s -o /dev/null -X DELETE "${AUTH[@]}" "$API/cameras/$id/permanent" || true
    N=$((N+1))
  done
  # Rede de segurança: o que a API não apagou some pelo banco, mas SÓ com o
  # prefixo [SIM] — nenhuma consulta aqui alcança câmera real.
  docker exec vms-postgres psql -U vms -d vms_db -q -c \
    "DELETE FROM \"Camera\" WHERE name LIKE '[SIM]%';" >/dev/null 2>&1 || true
  echo "  ✓ $N câmeras de teste removidas"
  exit 0
fi

QTD="${2:?informe a quantidade}"
MODO="${3:-manual}"
FONTE_IP=$(docker inspect sim-source --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

OK=0
for i in $(seq 1 "$QTD"); do
  N=$(printf "%03d" "$i")
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${AUTH[@]}" "$API/cameras" -d "{
    \"name\": \"[SIM] cam$N\",
    \"ip\": \"$FONTE_IP\",
    \"rtspPort\": 8554,
    \"rtspPath\": \"/cam${N}_sub\",
    \"username\": \"sim\",
    \"password\": \"sim\",
    \"recordingEnabled\": true,
    \"recordingMode\": \"$MODO\",
    \"retentionDays\": 1,
    \"preferredRtspTransport\": \"tcp\",
    \"preferredLiveProtocol\": \"webrtc\",
    \"streamVideoCodec\": \"h264\",
    \"recordingVideoCodec\": \"h264\",
    \"audioEnabled\": false
  }")
  [[ "$CODE" == "201" || "$CODE" == "200" ]] && OK=$((OK+1))
done
echo "  ✓ $OK/$QTD câmeras cadastradas pela API (modo: $MODO)"
