#!/usr/bin/env bash
# ── MEDIDOR ─────────────────────────────────────────────────────────────────
#
# Tira um retrato da máquina e do DRAC, separando o que é custo do PRODUTO do
# que é custo do GERADOR da simulação. Sem essa separação, a medição incluiria
# a própria bancada e superestimaria o consumo.
#
# Mede também o que só aparece sob carga: câmeras que caíram, processos FFmpeg
# vivos e paths prontos — os três sinais que diferenciam "aguenta" de "aguenta
# mas está perdendo câmera".
set -euo pipefail
ROTULO="${1:-medicao}"

# CPU por container, separando produto de bancada.
STATS=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null)
soma() { echo "$STATS" | grep -E "$1" | awk -F'|' '{gsub("%","",$2); s+=$2} END{printf "%.1f", s+0}'; }
# Converte GiB→MiB antes de somar: sem isso "1.2GiB" entraria como 1.2.
mem()  { echo "$STATS" | grep -E "$1" | awk -F'|' '{split($3,a," "); v=a[1];
         if (v ~ /GiB/) { gsub("GiB","",v); v=v*1024 } else { gsub("MiB","",v); gsub("KiB","",v) }
         s+=v} END{printf "%.0f", s+0}'; }

CPU_PROD=$(soma "vms-(api|mediamtx|ai-service|postgres|redis|web)")
CPU_GER=$(soma "sim-(source|publishers)")
MEM_PROD=$(mem "vms-(api|mediamtx|ai-service|postgres|redis|web)")
LOAD=$(awk '{print $1}' /proc/loadavg)
NUCLEOS=$(nproc)

# Estado do DRAC: câmeras online, paths prontos, ffmpeg vivos.
ONLINE=$(docker exec vms-postgres psql -U vms -d vms_db -t -A -c \
  "SELECT COUNT(*) FROM \"Camera\" WHERE enabled AND status='ONLINE' AND name LIKE '[SIM]%';" 2>/dev/null || echo "?")
TOTAL=$(docker exec vms-postgres psql -U vms -d vms_db -t -A -c \
  "SELECT COUNT(*) FROM \"Camera\" WHERE enabled AND name LIKE '[SIM]%';" 2>/dev/null || echo "?")
FFMPEG=$(docker exec vms-mediamtx sh -c 'ps aux 2>/dev/null | grep -c "[f]fmpeg"' 2>/dev/null | tr -d '\r\n' || true)
FFMPEG=${FFMPEG:-0}

echo "$ROTULO|$TOTAL|$ONLINE|$CPU_PROD|$CPU_GER|$MEM_PROD|$LOAD|$NUCLEOS|$FFMPEG"
