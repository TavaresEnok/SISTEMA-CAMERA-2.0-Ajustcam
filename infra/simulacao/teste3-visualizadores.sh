#!/usr/bin/env bash
# ── TESTE 3: CAPACIDADE DE VISUALIZADORES SIMULTÂNEOS ───────────────────────
#
# Três cenários de entrega, que diferem no custo de CPU do servidor:
#
#   A) fonte H.265 → grade      : precisa TRANSCODIFICAR para H.264 (navegador
#                                 não decodifica HEVC por WebRTC). Um FFmpeg por
#                                 câmera assistida. É o caso caro.
#   B) fonte H.264 → grade      : PASSTHROUGH, sem FFmpeg. O MediaMTX só repassa.
#   C) fonte H.265 → "máxima"   : PASSTHROUGH também, entregando HEVC ao
#                                 navegador que souber decodificar (Safari/Edge).
#
# COMO O VISUALIZADOR É SIMULADO: chamando GET /camera-stream/:id/urls, que é o
# que o player faz ao abrir um tile. Essa chamada CRIA o path no MediaMTX; em
# seguida um leitor RTSP o consome, e é isso que dispara o runOnDemand — ou
# seja, o FFmpeg de transcode sobe exatamente como subiria para um operador.
#
# O que NÃO é medido aqui: a criptografia SRTP do WebRTC, que roda por sessão.
# Não há cliente WHEP de linha de comando disponível, e inventar um número seria
# pior que declarar a lacuna. O custo dominante — transcode e repasse — é o que
# separa os três cenários, e esse está medido.
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
CENARIO="${1:?use: A|B|C}"
QTD="${2:-10}"
API="http://127.0.0.1:3000"
TOKEN="$(cat /tmp/claude-1000/-home-flashnet-Drac/18239e2c-6969-4dba-989b-137412c8a8ca/scratchpad/token.txt)"

case "$CENARIO" in
  A) CODEC=h265; MODO=grid     ;;   # transcode
  B) CODEC=h264; MODO=grid     ;;   # passthrough
  C) CODEC=h265; MODO=original ;;   # passthrough HEVC
  *) echo "cenário inválido (use A, B ou C)" >&2; exit 1 ;;
esac

echo "  cenário $CENARIO: fonte $CODEC, entrega $MODO, $QTD câmeras"

"$AQUI/cadastrar-api.sh" limpar >/dev/null
docker rm -f sim-publishers sim-readers >/dev/null 2>&1 || true
"$AQUI/gerar-fontes.sh" "$QTD" "$CODEC" >/dev/null
sleep 15
"$AQUI/cadastrar-api.sh" criar "$QTD" manual >/dev/null
sleep 40

# Abre um "tile" por câmera: /urls cria o path e devolve as URLs de entrega.
IDS=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/cameras" | python3 -c "
import sys,json
print(' '.join(c['id'] for c in json.load(sys.stdin) if c.get('name','').startswith('[SIM]')))")

PATHS=""
for id in $IDS; do
  P=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/camera-stream/$id/urls?viewMode=$MODO" \
      | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); u=(d.get('protocols') or {}).get('hlsUrl') or ''
    import re; m=re.search(r'/([^/]+)/index\.m3u8', u)
    print(m.group(1) if m else '')
except Exception: print('')")
  [[ -n "$P" ]] && PATHS="$PATHS $P"
done
echo "  paths criados: $(echo $PATHS | wc -w)"

# Consome cada path por RTSP: é isso que ativa o runOnDemand e sobe o FFmpeg.
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

sleep 60   # transcodes sobem e estabilizam
echo "cenario|cams|cpu_produto|cpu_leitores|mem_mb|load|ffmpeg_transcode|paths_prontos"
M=$("$AQUI/medir.sh" "x")
IFS='|' read -r _ tot onl cpup cpug memv load nuc ffm <<< "$M"
CPU_LEIT=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}' | grep sim-readers | cut -d'|' -f2 | tr -d '%')
PRONTOS=$(docker exec -e U="$U" -e P="$PW" vms-api node -e "
const a=Buffer.from(process.env.U+':'+process.env.P).toString('base64');
fetch('http://mediamtx:9997/v3/paths/list?itemsPerPage=500',{headers:{Authorization:'Basic '+a}})
 .then(r=>r.json()).then(d=>console.log((d.items||[]).filter(x=>x.ready).length)).catch(()=>console.log('?'))" 2>/dev/null)
echo "$CENARIO|$QTD|$cpup|${CPU_LEIT:-0}|$memv|$load|$ffm|$PRONTOS"
