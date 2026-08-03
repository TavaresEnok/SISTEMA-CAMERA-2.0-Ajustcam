#!/usr/bin/env bash
# ── MEDIDOR POR SÉRIE TEMPORAL ──────────────────────────────────────────────
#
# A primeira versão tirava UMA foto (`docker stats --no-stream`) e chamava de
# medição. Está errado: transcode tem picos no keyframe, o health check dispara
# a cada 60 s, e o coletor de lixo do Node aparece e some. Uma amostra única
# pode cair num pico ou num vale e a conclusão muda de acordo.
#
# Aqui a medição é uma SÉRIE: N amostras espaçadas, das quais se reporta
#   · mediana  — o comportamento típico, imune a um pico isolado;
#   · p95      — o pior caso realista, que é o que dimensiona servidor;
#   · desvio   — se for alto, a carga não estabilizou e a medição não vale.
#
# Também descarta as primeiras amostras (aquecimento): logo após subir N
# transcodes o sistema está alocando buffers e sondando, e isso não representa
# o regime permanente que se quer medir.
#
#   uso: ./medir-serie.sh <rotulo> [amostras] [intervalo_s]
set -euo pipefail
ROTULO="${1:-medicao}"
N="${2:-12}"
INTERVALO="${3:-5}"
DESCARTE=2   # amostras de aquecimento

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

for i in $(seq 1 $((N + DESCARTE))); do
  S=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null)
  CPU=$(echo "$S" | grep -E "vms-(api|mediamtx|ai-service|postgres|redis|web)" \
        | awk -F'|' '{gsub("%","",$2); s+=$2} END{printf "%.1f", s+0}')
  MEM=$(echo "$S" | grep -E "vms-(api|mediamtx|ai-service|postgres|redis|web)" \
        | awk -F'|' '{split($3,a," "); v=a[1];
            if (v ~ /GiB/) { gsub("GiB","",v); v=v*1024 } else { gsub("MiB","",v); gsub("KiB","",v) }
            s+=v} END{printf "%.0f", s+0}')
  GER=$(echo "$S" | grep -E "sim-" | awk -F'|' '{gsub("%","",$2); s+=$2} END{printf "%.1f", s+0}')
  LOAD=$(awk '{print $1}' /proc/loadavg)
  [[ $i -gt $DESCARTE ]] && echo "$CPU|$MEM|$GER|$LOAD" >> "$TMP"
  sleep "$INTERVALO"
done

# mediana, p95 e desvio de cada coluna
python3 - "$TMP" "$ROTULO" <<'PY'
import sys, statistics as st
linhas=[l.strip().split('|') for l in open(sys.argv[1]) if l.strip()]
if not linhas: print(f"{sys.argv[2]}|sem-amostras"); sys.exit()
col=lambda i: sorted(float(l[i]) for l in linhas)
def p95(v): return v[min(len(v)-1, int(round(0.95*(len(v)-1))))]
cpu, mem, ger, load = col(0), col(1), col(2), col(3)
cv = (st.pstdev(cpu)/st.mean(cpu)*100) if st.mean(cpu) else 0
print(f"{sys.argv[2]}|{st.median(cpu):.1f}|{p95(cpu):.1f}|{st.median(mem):.0f}|"
      f"{st.median(ger):.1f}|{st.median(load):.2f}|{cv:.0f}|{len(linhas)}")
PY
