#!/usr/bin/env bash
#
# BENCHMARK DE CAPACIDADE: quanto custa UMA câmera gravando, neste host.
#
# Por que existe: "quantas câmeras por servidor?" é a primeira pergunta de todo
# integrador, e o repositório não tinha como responder — nenhum benchmark, nenhum
# teste de carga. Sem número medido, qualquer resposta é chute.
#
# O QUE ELE MEDE (e o que NÃO mede):
#   · Mede o custo do processo de GRAVAÇÃO, com os MESMOS argumentos de ffmpeg
#     que a API usa em produção (caminho `-c:v copy` + `-c:a aac` + segmento
#     MPEG-TS — ver buildArgs em recording-process-manager.service.ts).
#   · NÃO mede IA, nem transcode ao vivo, nem a API/Postgres/MediaMTX de
#     produção. É o piso da conta: o custo irredutível de arquivar N câmeras.
#   · O custo dos PUBLICADORES sintéticos é excluído da medição — eles existem só
#     para produzir os streams e consomem CPU encodando, o que não acontece em
#     campo (lá quem encoda é a câmera). Medir os dois juntos seria inflar o
#     custo por câmera em várias vezes.
#
# HONESTIDADE DO NÚMERO: em modo `copy` o vídeo NÃO é decodificado, então o custo
# por câmera é dominado por demux/mux, I/O e o encode de ÁUDIO — que independem
# do conteúdo da imagem. É por isso que uma fonte sintética é representativa
# aqui, e não seria se o modo fosse transcode. O resultado vale para ESTE host e
# ESTE perfil de stream; troque o hardware ou o bitrate e refaça a medição.
#
# ISOLAMENTO: containers/rede/portas próprios (drac-bench-*), nada toca a
# instalação viva. Mesmo precedente da fixture de RTSP.
#
# Uso:
#   scripts/benchmark-capacity.sh run            # 4 câmeras, 60s (padrão)
#   BENCH_CAMERAS=8 BENCH_SECONDS=90 scripts/benchmark-capacity.sh run
#   scripts/benchmark-capacity.sh down           # limpeza (idempotente)
#
# Variáveis:
#   BENCH_CAMERAS=4        quantos streams simultâneos
#   BENCH_SECONDS=60       janela de amostragem (após o aquecimento)
#   BENCH_WARMUP=10        segundos ignorados no início (startup distorce a média)
#   BENCH_RESOLUTION=1280x720
#   BENCH_FPS=15
#   BENCH_BITRATE=2000k    aproxima o perfil medido em campo (~2 Mbps)
#   BENCH_HEADROOM=70      % de CPU que se aceita usar ao projetar capacidade
#
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

NET=drac-bench-net
MTX=drac-bench-mediamtx
PUB_PREFIX=drac-bench-pub

BENCH_CAMERAS="${BENCH_CAMERAS:-4}"
BENCH_SECONDS="${BENCH_SECONDS:-60}"
BENCH_WARMUP="${BENCH_WARMUP:-10}"
BENCH_RESOLUTION="${BENCH_RESOLUTION:-1280x720}"
BENCH_FPS="${BENCH_FPS:-15}"
BENCH_BITRATE="${BENCH_BITRATE:-2000k}"
BENCH_HEADROOM="${BENCH_HEADROOM:-70}"
BENCH_RTSP_PORT="${BENCH_RTSP_PORT:-28554}"
BENCH_API_PORT="${BENCH_API_PORT:-29997}"
MEDIAMTX_IMAGE="${BENCH_MEDIAMTX_IMAGE:-bluenviron/mediamtx:1-ffmpeg}"

OUTDIR="$(mktemp -d /tmp/drac-bench.XXXXXX)"
PIDS_FILE="$OUTDIR/recorder.pids"

log() { printf '[bench] %s\n' "$*" >&2; }

require() {
  command -v docker >/dev/null 2>&1 || { log "ERRO: docker não encontrado."; exit 3; }
  command -v ffmpeg >/dev/null 2>&1 || { log "ERRO: ffmpeg não encontrado no host."; exit 3; }
}

write_mtx_config() {
  cat > "$1" <<'YAML'
logLevel: error
api: yes
apiAddress: :9997
authInternalUsers:
  - user: any
    permissions:
      - action: publish
      - action: read
      - action: api
paths:
  all_others:
YAML
}

down_quiet() {
  if [ -f "$PIDS_FILE" ]; then
    while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PIDS_FILE"
    sleep 1
    while read -r pid; do kill -9 "$pid" 2>/dev/null || true; done < "$PIDS_FILE"
  fi
  for i in $(seq 1 "${BENCH_CAMERAS}"); do
    docker rm -f "${PUB_PREFIX}-${i}" >/dev/null 2>&1 || true
  done
  docker rm -f "$MTX" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

up() {
  require
  down_quiet
  docker network create "$NET" >/dev/null 2>&1 || true

  local cfg="$OUTDIR/mediamtx.yml"
  write_mtx_config "$cfg"
  docker run -d --name "$MTX" --network "$NET" \
    -p "127.0.0.1:${BENCH_API_PORT}:9997" \
    -p "127.0.0.1:${BENCH_RTSP_PORT}:8554" \
    -v "$cfg":/mediamtx.yml:ro \
    "$MEDIAMTX_IMAGE" >/dev/null
  sleep 3

  log "publicando ${BENCH_CAMERAS} stream(s) sintético(s) ${BENCH_RESOLUTION}@${BENCH_FPS} ${BENCH_BITRATE}"
  for i in $(seq 1 "$BENCH_CAMERAS"); do
    docker run -d --name "${PUB_PREFIX}-${i}" --network "$NET" \
      --entrypoint ffmpeg "$MEDIAMTX_IMAGE" \
      -hide_banner -loglevel error \
      -re -f lavfi -i "testsrc=size=${BENCH_RESOLUTION}:rate=${BENCH_FPS}" \
      -f lavfi -i "sine=frequency=440:sample_rate=44100" \
      -c:v libx264 -preset ultrafast -tune zerolatency -b:v "$BENCH_BITRATE" -g "$((BENCH_FPS * 2))" \
      -c:a aac -ar 44100 -ac 1 \
      -f rtsp "rtsp://${MTX}:8554/cam${i}" >/dev/null
  done
  sleep 6
}

start_recorders() {
  : > "$PIDS_FILE"
  mkdir -p "$OUTDIR/rec"
  log "iniciando ${BENCH_CAMERAS} gravador(es) com os argumentos REAIS da API"
  for i in $(seq 1 "$BENCH_CAMERAS"); do
    mkdir -p "$OUTDIR/rec/cam$i"
    # Espelha buildArgs() do recording-process-manager: copy de vídeo, aac mono
    # 44.1k, segmento mpegts, reset de timestamps, nomes por strftime.
    ffmpeg -hide_banner -loglevel warning \
      -rtsp_transport tcp -timeout 8000000 \
      -i "rtsp://127.0.0.1:${BENCH_RTSP_PORT}/cam${i}" \
      -map 0:v:0 -map 0:a:0? \
      -c:v copy -c:a aac -ar 44100 -ac 1 \
      -f segment -segment_format mpegts -segment_time 60 \
      -reset_timestamps 1 -strftime 1 \
      "$OUTDIR/rec/cam$i/%Y-%m-%d_%H-%M-%S.ts" \
      >/dev/null 2>"$OUTDIR/rec/cam$i/stderr.log" &
    echo $! >> "$PIDS_FILE"
  done
}

measure() {
  log "aquecendo ${BENCH_WARMUP}s (startup distorce a média)"
  sleep "$BENCH_WARMUP"

  # Confere que todos sobreviveram: medir com gravador morto daria custo baixo
  # e resultado mentiroso.
  local alive=0
  while read -r pid; do kill -0 "$pid" 2>/dev/null && alive=$((alive + 1)); done < "$PIDS_FILE"
  if [ "$alive" -ne "$BENCH_CAMERAS" ]; then
    log "ERRO: só ${alive}/${BENCH_CAMERAS} gravadores vivos — medição inválida."
    head -5 "$OUTDIR"/rec/cam1/stderr.log >&2 2>/dev/null || true
    return 1
  fi

  log "amostrando ${BENCH_SECONDS}s"
  local samples=0 cpu_total=0 rss_total=0
  local deadline=$((SECONDS + BENCH_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local cpu=0 rss=0
    while read -r pid; do
      if [ -d "/proc/$pid" ]; then
        local line
        line=$(ps -p "$pid" -o %cpu=,rss= 2>/dev/null || true)
        [ -z "$line" ] && continue
        cpu=$(awk -v a="$cpu" -v b="$(echo "$line" | awk '{print $1}')" 'BEGIN{print a+b}')
        rss=$(awk -v a="$rss" -v b="$(echo "$line" | awk '{print $2}')" 'BEGIN{print a+b}')
      fi
    done < "$PIDS_FILE"
    cpu_total=$(awk -v a="$cpu_total" -v b="$cpu" 'BEGIN{print a+b}')
    rss_total=$(awk -v a="$rss_total" -v b="$rss" 'BEGIN{print a+b}')
    samples=$((samples + 1))
    sleep 2
  done

  local cores; cores=$(nproc)
  local bytes; bytes=$(du -sb "$OUTDIR/rec" 2>/dev/null | awk '{print $1}')
  local ram_mb; ram_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)

  awk -v s="$samples" -v c="$cpu_total" -v r="$rss_total" -v n="$BENCH_CAMERAS" \
      -v cores="$cores" -v head="$BENCH_HEADROOM" -v secs="$BENCH_SECONDS" \
      -v bytes="$bytes" -v res="$BENCH_RESOLUTION" -v fps="$BENCH_FPS" -v br="$BENCH_BITRATE" \
      -v ram_mb="$ram_mb" '
  BEGIN {
    cpu = c/s; rss = r/s;
    per_cpu = cpu/n; per_rss = rss/n/1024;
    mbps = (bytes*8)/(secs*1000000)/n;

    # Três tetos independentes. Projetar só por CPU é o erro clássico: em modo
    # copy a CPU é barata justamente porque não há decode, então RAM e disco
    # esbarram MUITO antes. O número que vale é o MENOR dos três.
    cap_cpu  = (per_cpu > 0) ? int(cores*100*(head/100)/per_cpu) : 0;
    cap_ram  = (per_rss > 0) ? int(ram_mb*(head/100)/per_rss) : 0;
    # 100 MB/s é um piso conservador de escrita sustentada para HDD 7200rpm com
    # N fluxos concorrentes (não é o pico sequencial de catálogo).
    cap_disk = (mbps > 0) ? int((100*8)/mbps) : 0;

    cap = cap_cpu; limite = "CPU";
    if (cap_ram  < cap) { cap = cap_ram;  limite = "RAM"; }
    if (cap_disk < cap) { cap = cap_disk; limite = "ESCRITA EM DISCO"; }

    gb_dia = mbps*86400/8/1000;

    printf "\n";
    printf "════════════════════════════════════════════════════════════\n";
    printf " CAPACIDADE DE GRAVAÇÃO — MEDIDO NESTE HOST\n";
    printf "════════════════════════════════════════════════════════════\n";
    printf " Perfil do stream .... %s @ %s fps, alvo %s\n", res, fps, br;
    printf " Câmeras medidas ..... %d (amostras: %d)\n", n, s;
    printf " Host ................ %d núcleos, %d MB RAM\n", cores, ram_mb;
    printf "────────────────────────────────────────────────────────────\n";
    printf " CUSTO POR CÂMERA\n";
    printf "   CPU ............... %.2f%% de um núcleo\n", per_cpu;
    printf "   RAM ............... %.1f MB (RSS)\n", per_rss;
    printf "   Escrita ........... %.2f Mbps  (~%.1f GB/dia)\n", mbps, gb_dia;
    printf "────────────────────────────────────────────────────────────\n";
    printf " TETO POR RECURSO (a %d%% de utilização)\n", head;
    printf "   por CPU ........... ~%d câmeras\n", cap_cpu;
    printf "   por RAM ........... ~%d câmeras\n", cap_ram;
    printf "   por disco (100MB/s) ~%d câmeras\n", cap_disk;
    printf "────────────────────────────────────────────────────────────\n";
    printf " ►► CAPACIDADE ....... ~%d câmeras   (limitado por %s)\n", cap, limite;
    printf "════════════════════════════════════════════════════════════\n";
    printf "\n Só GRAVAÇÃO (copy). NÃO inclui IA, transcode ao vivo, nem\n";
    printf " API/Postgres/MediaMTX no mesmo host — todos consomem do mesmo\n";
    printf " orçamento. Projeção LINEAR a partir de %d câmeras: confirme\n", n;
    printf " rodando com um N maior antes de usar como promessa comercial.\n\n";
  }'
}

run() {
  trap 'down_quiet; rm -rf "$OUTDIR"' EXIT
  up
  start_recorders
  measure
}

case "${1:-run}" in
  run) run ;;
  down) down_quiet; log "ok" ;;
  *) printf 'uso: %s {run|down}\n' "$0" >&2; exit 2 ;;
esac
