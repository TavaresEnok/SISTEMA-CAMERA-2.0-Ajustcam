#!/usr/bin/env bash
# ── GERADOR DE CÂMERAS SINTÉTICAS ───────────────────────────────────────────
#
# Sobe N publicadores que servem vídeo pré-codificado ao servidor-fonte, e o
# DRAC os consome como se fossem câmeras reais.
#
# Duas decisões que tornam a medição confiável:
#
#  1. `-c copy`. O vídeo já foi codificado uma vez, em disco; aqui só é lido e
#     empacotado. Um publicador custa ~0,5% de CPU em vez dos ~15% que custaria
#     codificando ao vivo. Sem isso, com 50 câmeras o gerador consumiria a
#     máquina e mediríamos o gerador, não o DRAC.
#
#  2. TODOS os publicadores num container só. O `docker stats` separa esse
#     container do resto, então o custo do gerador é medido e pode ser
#     subtraído — e evita o peso de N containers Docker no host.
#
# Cada câmera expõe DOIS caminhos, como um DVR real: principal (1080p) e
# sub-stream (640x360). O DRAC usa o sub na grade e o principal na tela cheia,
# exatamente como faz em campo.
#
#   uso: ./gerar-fontes.sh <quantidade> <codec: h264|h265>
set -euo pipefail

QTD="${1:?informe a quantidade de câmeras}"
CODEC="${2:-h264}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
IMG="$(docker inspect vms-mediamtx --format '{{.Config.Image}}')"

case "$CODEC" in
  h264) MAIN=/media/h264_1080p.mp4; SUB=/media/h264_360p.mp4 ;;
  h265) MAIN=/media/h265_1080p.mp4; SUB=/media/h265_360p.mp4 ;;
  *) echo "codec inválido: $CODEC (use h264 ou h265)" >&2; exit 1 ;;
esac

# Monta o script que roda dentro do container: 2 ffmpeg por câmera.
SCRIPT="set -e"
for i in $(seq 1 "$QTD"); do
  N=$(printf "%03d" "$i")
  SCRIPT="$SCRIPT
ffmpeg -hide_banner -loglevel error -re -stream_loop -1 -i $MAIN -c copy -f rtsp -rtsp_transport tcp rtsp://sim-source:8554/cam${N}_main >/dev/null 2>&1 &
ffmpeg -hide_banner -loglevel error -re -stream_loop -1 -i $SUB -c copy -f rtsp -rtsp_transport tcp rtsp://sim-source:8554/cam${N}_sub >/dev/null 2>&1 &"
done
SCRIPT="$SCRIPT
wait"

docker rm -f sim-publishers >/dev/null 2>&1 || true
docker run -d --name sim-publishers --network infra_vms-net \
  -v "$AQUI/media:/media:ro" --entrypoint sh \
  "$IMG" -c "$SCRIPT" >/dev/null

echo "  ✓ $QTD câmeras sintéticas em $CODEC ($((QTD*2)) fluxos)"
