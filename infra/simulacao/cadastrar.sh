#!/usr/bin/env bash
# ── CADASTRO E LIMPEZA DAS CÂMERAS DE TESTE ─────────────────────────────────
#
# Registra N câmeras no DRAC apontando para o servidor-fonte da simulação. Elas
# entram no sistema pelo MESMO caminho de uma câmera real (RTSP pull), então o
# que medimos é o custo verdadeiro do produto, não um atalho.
#
# SEGURANÇA DA FROTA REAL: toda câmera de teste nasce com o prefixo `[SIM]` no
# nome e IP do servidor-fonte. A limpeza apaga SÓ o que casa com esse prefixo —
# nenhuma consulta toca em câmera cujo nome não comece com ele. As 21 reais não
# são alcançáveis por este script nem por engano.
#
#   uso: ./cadastrar.sh criar <quantidade> [modo-gravacao]
#        ./cadastrar.sh limpar
set -euo pipefail

ACAO="${1:?use: criar <n> | limpar}"
PSQL=(docker exec -i vms-postgres psql -U vms -d vms_db)

if [[ "$ACAO" == "limpar" ]]; then
  N=$("${PSQL[@]}" -t -A -c "DELETE FROM \"Camera\" WHERE name LIKE '[SIM]%' RETURNING 1;" | wc -l)
  echo "  ✓ $N câmeras de teste removidas"
  exit 0
fi

QTD="${2:?informe a quantidade}"
MODO="${3:-manual}"
FONTE_IP=$(docker inspect sim-source --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

# Reaproveita a credencial cifrada de uma câmera existente: o campo é NOT NULL e
# o servidor-fonte não pede autenticação, então o valor é irrelevante — só
# precisa ser decifrável para o código não quebrar ao montar a URL.
SENHA=$("${PSQL[@]}" -t -A -c "SELECT \"passwordEncrypted\" FROM \"Camera\" WHERE name NOT LIKE '[SIM]%' LIMIT 1;")

SQL="INSERT INTO \"Camera\" (id, name, ip, \"rtspPort\", \"rtspPath\", username, \"passwordEncrypted\",
     \"updatedAt\", \"recordingMode\", \"recordingEnabled\", \"aiEnabled\", \"motionTrigger\",
     \"streamVideoCodec\", \"detectedVideoCodec\", enabled, \"liveSubtype\", \"recordingSubtype\") VALUES "
for i in $(seq 1 "$QTD"); do
  N=$(printf "%03d" "$i")
  [[ $i -gt 1 ]] && SQL="$SQL,"
  # rtspPath aponta para o SUB (é o que a grade usa); o principal fica em _main.
  SQL="$SQL (gen_random_uuid(), '[SIM] cam$N', '$FONTE_IP', 8554, '/cam${N}_sub',
       'sim', '$SENHA', now(), '$MODO', true, false, 'SYSTEM', 'h264', 'h264', true, 0, 0)"
done
SQL="$SQL;"

echo "$SQL" | "${PSQL[@]}" >/dev/null
echo "  ✓ $QTD câmeras cadastradas apontando para $FONTE_IP (modo: $MODO)"
