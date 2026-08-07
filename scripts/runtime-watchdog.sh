#!/usr/bin/env bash
# DRAC runtime watchdog — saúde de INFRA (para o dono/operador da Central, não para o
# cliente final). Roda a cada poucos minutos (cron/systemd). Faz 3 coisas:
#   1) DETECTA problemas técnicos (container morto, /live 502, disco cheio, backup velho…).
#   2) AUTO-CURA o que dá pra curar sozinho (ex.: religar as portas do MediaMTX que já
#      derrubaram o /live inteiro uma vez — nginx batia em porta morta → 502).
#   3) ALERTA você quando algo degrada e a auto-cura não resolveu (Telegram/webhook), só
#      na MUDANÇA de estado (nada de spam). Sem canal configurado, cai no journal + arquivo.
set -uo pipefail

ROOT_DIR="${DRAC_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INFRA_DIR="$ROOT_DIR/infra"
STATE_DIR="$INFRA_DIR/storage/.monitor"
STATUS_FILE="$STATE_DIR/runtime-status.json"
HASH_FILE="$STATE_DIR/runtime-status.sha256"
LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/drac-runtime-watchdog.lock"
# `storage` costuma pertencer ao root (os containers o criam), enquanto o
# watchdog roda como usuário operador. Sem isto, o mkdir falha em silêncio e o
# serviço morre em "No such file or directory" no primeiro disparo — foi o que
# aconteceu na instalação do D-GUARDIAN.
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  sudo -n mkdir -p "$STATE_DIR" 2>/dev/null || true
  sudo -n chown "$(id -u):$(id -g)" "$STATE_DIR" 2>/dev/null || true
fi
[ -w "$STATE_DIR" ] || { echo "drac-watchdog: sem permissão de escrita em $STATE_DIR" >&2; exit 1; }
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

# Config de alerta: lida do ambiente OU do infra/.env (sem exigir export manual).
# Suporta Telegram (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID) e/ou um webhook
# genérico (ALERT_WEBHOOK_URL, recebe JSON — serve p/ Discord/Slack/ntfy/gateway).
load_env_var() { # nome -> valor do infra/.env (sem sobrescrever o que já está no ambiente)
  local name="$1"
  local current="${!name:-}"
  if [ -n "$current" ]; then printf '%s' "$current"; return; fi
  [ -f "$INFRA_DIR/.env" ] || return
  sed -n "s/^${name}=//p" "$INFRA_DIR/.env" | head -n1 | sed 's/^"//; s/"$//'
}
TG_TOKEN="$(load_env_var ALERT_TELEGRAM_BOT_TOKEN)"
TG_CHAT="$(load_env_var ALERT_TELEGRAM_CHAT_ID)"
ALERT_WEBHOOK="$(load_env_var ALERT_WEBHOOK_URL)"
INSTANCE_NAME="$(load_env_var DRAC_INSTANCE_NAME)"; INSTANCE_NAME="${INSTANCE_NAME:-$(hostname)}"

issues=()      # problemas ativos (viram status degraded)
actions=()     # auto-curas executadas neste ciclo (para o log/alerta)

# ── 1) CONTAINERS ────────────────────────────────────────────────────────────
for container in vms-postgres vms-redis vms-mediamtx vms-api vms-web vms-ai-service; do
  state="$(docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
  case "$state" in
    running\|healthy|running\|none) ;;
    *) issues+=("container:$container:${state:-missing}") ;;
  esac
done

# ── 2) SERVIÇOS HTTP internos ────────────────────────────────────────────────
curl -fsS --max-time 5 http://127.0.0.1:3000/health >/dev/null 2>&1 || issues+=("api:unreachable")
curl -fsS --max-time 5 http://127.0.0.1:5173/ >/dev/null 2>&1 || issues+=("web:unreachable")
# O build-agent (geração de APK) só existe no servidor MESTRE. Cobrá-lo numa
# instalação de cliente deixava o watchdog em "degraded" PARA SEMPRE, por um
# serviço que não deveria estar lá — e um alerta que nunca apaga é um alerta
# que o operador aprende a ignorar. Verifica só se foi declarado.
if [ "${DRAC_BUILD_AGENT_EXPECTED:-false}" = "true" ]; then
  curl -fsS --max-time 5 http://172.17.0.1:8780/health >/dev/null 2>&1 || issues+=("build-agent:unreachable")
fi

# ── 3) PIPELINE DE LIVE (a falha de hoje) + AUTO-CURA ────────────────────────
# O nginx faz proxy de /hls/ e /webrtc/ para 127.0.0.1:8888/8889. Se o MediaMTX for
# recriado sem as portas (ex.: `up` só com o compose base), NADA escuta lá → 502 → todas
# as câmeras presas em "conectando...". Detecta pela porta publicada no host e RELIGA.
mediamtx_ports_ok() {
  docker port vms-mediamtx 2>/dev/null | grep -q '8889/tcp' \
    && docker port vms-mediamtx 2>/dev/null | grep -q '8888/tcp'
}
if docker inspect vms-mediamtx >/dev/null 2>&1; then
  # DEBOUNCE: um recreate do mediamtx + restart da api PISCA todos os viewers. Então só
  # age se as portas estiverem REALMENTE ausentes — reconfirma após 5s p/ descartar um
  # soluço transiente do `docker port`. Sem isto, o próprio watchdog poderia virar fonte
  # de piscar ao reiniciar a api por um falso-positivo momentâneo.
  if ! mediamtx_ports_ok; then
    sleep 5
  fi
  if ! mediamtx_ports_ok; then
    # AUTO-CURA: recria o mediamtx pelo compose base (que agora carrega as portas).
    (cd "$INFRA_DIR" && docker compose -f docker-compose.yml up -d mediamtx >/dev/null 2>&1) && sleep 3
    # Fallback: se ainda sem portas (ex.: container órfão/fora do compose segurando o
    # nome), força remoção e recria limpo pelo compose.
    if ! mediamtx_ports_ok; then
      docker rm -f vms-mediamtx >/dev/null 2>&1
      (cd "$INFRA_DIR" && docker compose -f docker-compose.yml up -d mediamtx >/dev/null 2>&1) && sleep 3
    fi
    if mediamtx_ports_ok; then
      actions+=("religou-portas-mediamtx")
      # MediaMTX novo perde os paths dinâmicos; a API os re-injeta no boot (warmCameraPaths).
      docker restart vms-api >/dev/null 2>&1 && actions+=("reaqueceu-paths-api")
    else
      issues+=("live:mediamtx-sem-portas")
    fi
  fi
  # Confirma o caminho ponta-a-ponta: host consegue falar HLS/WebRTC do MediaMTX?
  # (000 = conexão recusada = porta morta; qualquer HTTP = vivo). Só checa se as portas existem.
  if mediamtx_ports_ok; then
    hls_code="$(curl -s -o /dev/null -m 4 -w '%{http_code}' http://127.0.0.1:8888/ 2>/dev/null || echo 000)"
    rtc_code="$(curl -s -o /dev/null -m 4 -w '%{http_code}' http://127.0.0.1:8889/ 2>/dev/null || echo 000)"
    [ "$hls_code" = "000" ] && issues+=("live:hls-porta-morta")
    [ "$rtc_code" = "000" ] && issues+=("live:webrtc-porta-morta")
  fi
fi

# ── 4) DISCO ─────────────────────────────────────────────────────────────────
disk_used="$(df -P "$INFRA_DIR/storage" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
if [ "${disk_used:-100}" -ge 90 ]; then issues+=("disk:CRITICO:${disk_used}%")
elif [ "${disk_used:-100}" -ge 85 ]; then issues+=("disk:${disk_used}%"); fi

# ── 5) BACKUP fresco ─────────────────────────────────────────────────────────
latest_backup="$(find "$INFRA_DIR/backups/postgres" -type f -name 'drac-postgres-*.dump' -printf '%T@\n' 2>/dev/null | sort -nr | head -n1 | cut -d. -f1)"
now_epoch="$(date +%s)"
if [ -z "$latest_backup" ] || [ $((now_epoch - latest_backup)) -gt 129600 ]; then issues+=("backup:mais-velho-que-36h"); fi

# ── 6) SEGURANÇA: credencial vazando em log ──────────────────────────────────
credential_lines="$(for name in vms-api vms-ai-service; do docker logs --since 10m "$name" 2>&1 || true; done | grep -Eic 'rtsp(s)?://[^/@[:space:]:]+:[^/@[:space:]]+@' || true)"
if [ "${credential_lines:-0}" -gt 0 ]; then issues+=("security:credencial-em-log:$credential_lines"); fi

# ── 7) SITES DE CÂMERAS remotos (link do cliente caiu?) ──────────────────────
# Agrupa câmeras HABILITADAS por IP e testa TCP em até 3 portas RTSP do site.
# Só acusa quando NENHUMA porta responde (site inteiro fora), com reconfirmação
# após 3s para não alertar num soluço de rede. Uma câmera isolada fora não dispara.
site_rows="$(docker exec vms-postgres psql -U vms -d vms_db -tAc \
  "SELECT ip || '|' || string_agg(DISTINCT \"rtspPort\"::text, ',') FROM \"Camera\" WHERE enabled IS DISTINCT FROM false GROUP BY ip;" 2>/dev/null || true)"
if [ -n "$site_rows" ]; then
  while IFS='|' read -r site_ip site_ports; do
    [ -n "$site_ip" ] || continue
    site_reachable=0
    for attempt in 1 2; do
      port_idx=0
      for port in $(echo "$site_ports" | tr ',' ' '); do
        port_idx=$((port_idx + 1)); [ "$port_idx" -gt 3 ] && break
        if timeout 4 bash -c "echo > /dev/tcp/$site_ip/$port" 2>/dev/null; then site_reachable=1; break; fi
      done
      [ "$site_reachable" = "1" ] && break
      [ "$attempt" = "1" ] && sleep 3
    done
    [ "$site_reachable" = "1" ] || issues+=("site-cameras:${site_ip}:inacessivel")
  done <<< "$site_rows"
fi

# ── STATUS JSON (consumível pela Central / painel) ───────────────────────────
ISSUES="$(printf '%s\n' "${issues[@]:-}" | sed '/^$/d')" \
ACTIONS="$(printf '%s\n' "${actions[@]:-}" | sed '/^$/d')" \
DISK_USED="${disk_used:-null}" \
INSTANCE="$INSTANCE_NAME" \
node - "$STATUS_FILE.tmp" <<'NODE'
const fs = require('node:fs');
const issues = String(process.env.ISSUES || '').split('\n').filter(Boolean);
const actions = String(process.env.ACTIONS || '').split('\n').filter(Boolean);
const payload = {
  instance: process.env.INSTANCE || null,
  status: issues.length ? 'degraded' : 'ok',
  checkedAt: new Date().toISOString(),
  diskUsedPercent: Number(process.env.DISK_USED),
  selfHealed: actions,
  issues,
};
fs.writeFileSync(process.argv[2], JSON.stringify(payload, null, 2) + '\n');
NODE
mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"

# ── ALERTA (só na mudança de estado) ─────────────────────────────────────────
send_alert() {
  local text="$1"
  if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
    curl -s -m 10 -o /dev/null \
      --data-urlencode "chat_id=${TG_CHAT}" \
      --data-urlencode "text=${text}" \
      "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" || true
  fi
  if [ -n "$ALERT_WEBHOOK" ]; then
    curl -s -m 10 -o /dev/null -H 'Content-Type: application/json' \
      --data "$(printf '{"text":%s}' "$(printf '%s' "$text" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')")" \
      "$ALERT_WEBHOOK" || true
  fi
}

new_hash="$(printf '%s\n' "${issues[@]:-ok}" "${actions[@]:-}" | sha256sum | awk '{print $1}')"
old_hash="$(cat "$HASH_FILE" 2>/dev/null || true)"
if [ "$new_hash" != "$old_hash" ]; then
  heal_note=""
  [ "${#actions[@]}" -gt 0 ] && heal_note=" | auto-cura: $(IFS=,; echo "${actions[*]}")"
  if [ "${#issues[@]}" -eq 0 ]; then
    logger -t drac-watchdog "status=ok${heal_note}"
    # avisa recuperação só se houve auto-cura (evita ruído de "voltou ao normal" trivial)
    [ "${#actions[@]}" -gt 0 ] && send_alert "✅ DRAC ${INSTANCE_NAME}: recuperado.${heal_note}"
  else
    msg="status=degraded issues=$(IFS=,; echo "${issues[*]}")${heal_note}"
    logger -t drac-watchdog "$msg"
    send_alert "⚠️ DRAC ${INSTANCE_NAME} com problema: $(IFS=', '; echo "${issues[*]}")${heal_note}"
  fi
  printf '%s' "$new_hash" > "$HASH_FILE"
fi

[ "${#issues[@]}" -eq 0 ]
