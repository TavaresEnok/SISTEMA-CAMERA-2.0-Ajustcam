#!/usr/bin/env bash
# ── RE-AMOSTRAGEM DO TESTE 3 COM SÉRIE TEMPORAL ─────────────────────────────
#
# A primeira rodada do Teste 3 mediu com uma foto única e produziu números que
# não davam para defender: o cenário C apareceu com 28 transcodes que eram das
# câmeras REAIS, e a comparação entre cenários ficou contaminada.
#
# Aqui cada cenário é medido em série (mediana + p95), e a BASE é medida antes
# de cada um — com as câmeras reais no mesmo estado — para que o número
# reportado seja o custo do CENÁRIO, não do sistema inteiro.
#
#   custo do cenário = medição com N câmeras de teste − base sem elas
#
# Sem essa subtração, o que a frota real faz no momento entra na conta e a
# comparação entre A, B e C perde o sentido.
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
CENARIO="${1:?use A|B|C}"
QTD="${2:-25}"
API="http://127.0.0.1:3000"
TOKEN="$(cat /tmp/claude-1000/-home-flashnet-Drac/18239e2c-6969-4dba-989b-137412c8a8ca/scratchpad/token.txt)"

case "$CENARIO" in
  A) CODEC=h265; MODO=grid     ;;
  B) CODEC=h264; MODO=grid     ;;
  C) CODEC=h265; MODO=original ;;
  *) echo "cenário inválido" >&2; exit 1 ;;
esac

# 1) Limpa e espera os transcodes residuais morrerem — sem isso a base já vem suja.
"$AQUI/cadastrar-api.sh" limpar >/dev/null
docker rm -f sim-publishers sim-readers >/dev/null 2>&1 || true
until [ "$(docker exec vms-mediamtx sh -c 'ps aux | grep -c "[f]fmpeg"' 2>/dev/null | tr -d '\r\n')" -le 2 ]; do sleep 15; done

# 2) BASE: só as câmeras reais, medida em série.
BASE=$("$AQUI/medir-serie.sh" "base" 8 4)
IFS='|' read -r _ bmed bp95 bmem bger bload bcv bam <<< "$BASE"

# 3) Sobe o cenário.
"$AQUI/gerar-fontes.sh" "$QTD" "$CODEC" >/dev/null
sleep 15
"$AQUI/cadastrar-api.sh" criar "$QTD" manual >/dev/null
sleep 40

IDS=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/cameras" | python3 -c "
import sys,json
print(' '.join(c['id'] for c in json.load(sys.stdin) if c.get('name','').startswith('[SIM]')))")
PATHS=""
for id in $IDS; do
  P=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/camera-stream/$id/urls?viewMode=$MODO" | python3 -c "
import sys,json,re
try:
    d=json.load(sys.stdin); u=(d.get('protocols') or {}).get('hlsUrl') or ''
    m=re.search(r'/([^/]+)/index\.m3u8', u); print(m.group(1) if m else '')
except Exception: print('')")
  [[ -n "$P" ]] && PATHS="$PATHS $P"
done

U=$(grep '^MEDIAMTX_API_USER=' "$AQUI/../.env" | cut -d= -f2-)
PW=$(grep '^MEDIAMTX_API_PASS=' "$AQUI/../.env" | cut -d= -f2-)
SCRIPT="set -e"
for P in $PATHS; do
  SCRIPT="$SCRIPT
ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i 'rtsp://$U:$PW@mediamtx:8554/$P' -f null - >/dev/null 2>&1 &"
done
SCRIPT="$SCRIPT
wait"
docker run -d --name sim-readers --network infra_vms-net --entrypoint sh \
  "$(docker inspect vms-mediamtx --format '{{.Config.Image}}')" -c "$SCRIPT" >/dev/null
sleep 75   # transcodes sobem e o regime estabiliza

CARGA=$("$AQUI/medir-serie.sh" "carga" 12 5)
IFS='|' read -r _ cmed cp95 cmem cger cload ccv cam <<< "$CARGA"
FF=$(docker exec vms-mediamtx sh -c 'ps aux | grep -c "[f]fmpeg"' 2>/dev/null | tr -d '\r\n')

python3 - "$CENARIO" "$QTD" "$bmed" "$cmed" "$bp95" "$cp95" "$bmem" "$cmem" "$cload" "$ccv" "${FF:-0}" <<'PY'
import sys
c,q,bm,cm,bp,cp,bmem,cmem,load,cv,ff = sys.argv[1:12]
q=int(q); bm,cm,bp,cp=float(bm),float(cm),float(bp),float(cp)
dm, dp = cm-bm, cp-bp
print(f"{c}|{q}|{bm:.1f}|{cm:.1f}|{dm:.1f}|{dm/q:.2f}|{dp:.1f}|{int(cmem)-int(bmem)}|{load}|{cv}|{ff}")
PY
