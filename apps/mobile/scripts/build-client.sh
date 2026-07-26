#!/usr/bin/env bash
# build-client.sh — gera um APK white-label assinado para um cliente.
#
#   ./scripts/build-client.sh <slug>
#
# Lê clients/<slug>/config.json, embute branding + servidor, builda em release,
# assina com a keystore PRÓPRIA do cliente (gerada na 1ª vez e reusada nas
# próximas, para que updates instalem por cima) e publica drac-<slug>.apk.
#
# Seguro para ser disparado por um worker: o slug é validado por regex e nada
# do usuário é interpolado em shell sem checagem.
set -euo pipefail
# O nginx (worker sem privilégio) precisa LER os artefatos publicados. O agente de
# build da Central roda com umask restritivo (077 → arquivos 600 = só o dono lê),
# o que faz o /apk responder 403 e a Central mostrar 404. Força artefatos legíveis.
umask 022

SLUG="${1:-}"
if [[ -z "$SLUG" ]]; then echo "uso: build-client.sh <slug>" >&2; exit 2; fi
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,38}$ ]]; then
  echo "slug inválido (use a-z 0-9 -, 2-39 chars): $SLUG" >&2; exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_DIR="$MOBILE_DIR/clients/$SLUG"
CONFIG="$CLIENT_DIR/config.json"
[[ -f "$CONFIG" ]] || { echo "config não encontrada: $CONFIG" >&2; exit 2; }

# Toolchain local (sem conta Expo). Permite override por env.
export JAVA_HOME="${JAVA_HOME:-$HOME/toolchain/jdk-17.0.19+10}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/toolchain/android-sdk}"
# apksigner/keytool chamam `java` pelo PATH — garante o JDK disponível.
export PATH="$JAVA_HOME/bin:$PATH"
BUILD_TOOLS="$ANDROID_HOME/build-tools/36.0.0"
KEYSTORE_DIR="${KEYSTORE_DIR:-$HOME/toolchain/keystores}"
BUILDS_DIR="$MOBILE_DIR/builds"
# Diretório do HOST montado no nginx (vms-web:/usr/share/nginx/html/apk:ro).
# Publicar aqui sobrevive a rebuilds do container e dispensa `docker cp`.
APK_PUBLISH_DIR="${APK_PUBLISH_DIR:-$MOBILE_DIR/../../infra/apk}"
MIN_FREE_GB="${MIN_FREE_GB:-8}"

mkdir -p "$KEYSTORE_DIR" "$BUILDS_DIR" "$APK_PUBLISH_DIR"

# Guarda de disco: não buildar se o root estiver perto de encher (protege o
# streaming/gravação que rodam no mesmo servidor).
free_gb="$(df -BG --output=avail "$MOBILE_DIR" | tail -1 | tr -dc '0-9')"
if [[ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]]; then
  echo "espaço insuficiente: ${free_gb}G livres (< ${MIN_FREE_GB}G)" >&2; exit 3
fi

PACKAGE_ID="$(node -e "process.stdout.write((require('$CONFIG').packageId||''))")"
if [[ ! "$PACKAGE_ID" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$ ]]; then
  echo "packageId inválido em config.json: '$PACKAGE_ID'" >&2; exit 2
fi
APP_NAME="$(node -e "process.stdout.write((require('$CONFIG').appName||'$SLUG'))")"

echo ">> Cliente: $SLUG  |  app: $APP_NAME  |  pacote: $PACKAGE_ID"

# Logo da tela de login: troca o asset fixo pelo do cliente (com backup p/ restaurar).
LOGO_DST="$MOBILE_DIR/assets/branding/logo.png"
LOGO_BAK="$(mktemp)"
cp "$LOGO_DST" "$LOGO_BAK"
restore_logo() { cp "$LOGO_BAK" "$LOGO_DST"; rm -f "$LOGO_BAK"; }
trap restore_logo EXIT
# O cliente pode ter enviado o logo em qualquer formato (JPEG/WebP/etc) salvo
# como .png — o AAPT do Android recusa isso ("file failed to compile"). Então
# re-codifica para PNG REAL com ffmpeg (lê pelo conteúdo, não pela extensão).
# Se a conversão falhar, mantém o logo padrão e segue (não quebra o build).
if [[ -f "$CLIENT_DIR/logo.png" ]]; then
  if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -y -loglevel error -i "$CLIENT_DIR/logo.png" -pix_fmt rgba "$LOGO_DST" 2>/dev/null; then
    echo ">> logo do cliente convertido para PNG válido"
  else
    echo ">> aviso: logo do cliente inválido/não convertível — usando o logo padrão"
  fi
fi

cd "$MOBILE_DIR"
export CLIENT="$SLUG"
export NODE_ENV="${NODE_ENV:-production}"

echo ">> prebuild (--clean: regenera android/ do zero p/ o pacote deste cliente)…"
# --clean é essencial num builder multi-cliente: sem ele, restos do build do
# cliente anterior (ex.: autolinking gerado com o pacote antigo) quebram a
# compilação ("package com.ajustconsulting.drac<outro> does not exist").
npx expo prebuild --platform android --no-install --clean >/dev/null
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

# Edge-to-edge (Android 15): remove os atributos DEPRECADOS de cor de barra que
# o prebuild gera nos styles (android:statusBarColor / navigationBarColor). Com
# edge-to-edge ligado eles são ignorados e a Play emite aviso de "APIs
# descontinuadas para exibição de ponta a ponta". Removê-los silencia o aviso
# sem mudar o visual (a barra fica transparente, controlada pelo edge-to-edge).
find android/app/src/main/res -name styles.xml -exec \
  sed -i -E '/name="android:(statusBarColor|navigationBarColor)"/d' {} + 2>/dev/null || true

# Gera APK só p/ celulares modernos (arm64-v8a). O prebuild traz 4 ABIs
# (armeabi-v7a 32-bit + x86/x86_64 de EMULADOR) que inflavam o APK ~3x (~97MB).
# Forçamos de 2 formas (à prova de falha): a property do plugin RN E o
# abiFilters do defaultConfig (controle definitivo do empacotamento de .so).
TARGET_ABIS="${TARGET_ABIS:-arm64-v8a}"
sed -i "s/^reactNativeArchitectures=.*/reactNativeArchitectures=$TARGET_ABIS/" android/gradle.properties
TARGET_ABIS="$TARGET_ABIS" node -e '
  const fs = require("fs"); const f = "android/app/build.gradle";
  let s = fs.readFileSync(f, "utf8");
  const abis = process.env.TARGET_ABIS.split(",").map(a => `"${a.trim()}"`).join(", ");
  if (!s.includes("abiFilters")) {
    s = s.replace(/defaultConfig\s*\{/, (m) => `${m}\n        ndk { abiFilters ${abis} }`);
    fs.writeFileSync(f, s);
  }
'

# versionCode auto-incremental POR CLIENTE. A Play recusa um AAB com versionCode
# igual ou menor que um já publicado — então cada build sobe +1. O contador vive
# em builds/<slug>.versionCode (fora do fluxo do agent, que reescreve
# clients/<slug>/config.json a cada geração; e sobrevive a rebuilds). Piso = o
# versionCode da configuração base. Override manual possível via env VERSION_CODE.
VC_FILE="$BUILDS_DIR/$SLUG.versionCode"
BASE_VC="$(node -e "process.stdout.write(String(require('$MOBILE_DIR/app.base.json').expo.android.versionCode||1))")"
if [[ -n "${VERSION_CODE:-}" ]]; then
  NEW_VC="$VERSION_CODE"
else
  PREV_VC=""
  if [[ -f "$VC_FILE" ]]; then
    PREV_VC="$(tr -dc '0-9' < "$VC_FILE" 2>/dev/null || true)"
  fi
  if [[ -n "$PREV_VC" ]]; then NEW_VC=$((PREV_VC + 1)); else NEW_VC="$BASE_VC"; fi
fi
[[ "$NEW_VC" -lt "$BASE_VC" ]] && NEW_VC="$BASE_VC"
sed -i -E "s/versionCode[[:space:]]+[0-9]+/versionCode $NEW_VC/" android/app/build.gradle
echo "$NEW_VC" > "$VC_FILE"
echo ">> versionCode deste build: $NEW_VC (cliente $SLUG)"

echo ">> gradle assembleRelease (baixa prioridade)…"
( cd android && nice -n 15 ionice -c3 ./gradlew assembleRelease \
    -PreactNativeArchitectures="$TARGET_ABIS" --no-daemon --console=plain >/dev/null )

UNSIGNED="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$UNSIGNED" ]] || { echo "APK não gerado" >&2; exit 1; }

# Keystore própria do cliente (cria na 1ª vez; senha aleatória guardada ao lado).
KS="$KEYSTORE_DIR/$SLUG.jks"
PASS_FILE="$KEYSTORE_DIR/$SLUG.pass"
if [[ ! -f "$KS" ]]; then
  echo ">> gerando keystore para $SLUG…"
  head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
  "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore "$KS" -alias "$SLUG" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass:file "$PASS_FILE" -keypass:file "$PASS_FILE" \
    -dname "CN=$APP_NAME, O=DRAC, C=BR" >/dev/null
fi

# A assinatura (apksigner do APK e jarsigner do AAB) exige a senha da keystore,
# guardada NUM ARQUIVO 0600 ao lado da keystore — nunca em texto claro no fonte,
# em log, nem como argumento visível no `ps`. Se esse arquivo sumiu (keystore
# pré-existente sem .pass, remoção manual), falha CEDO e claro em vez de assinar
# com senha vazia/errada ou publicar um artefato sem assinatura.
if [[ ! -s "$PASS_FILE" ]]; then
  echo "senha da keystore ausente/vazia: $PASS_FILE" >&2
  echo "  esperado: arquivo 0600 gerado junto da keystore ($KS)." >&2
  exit 5
fi

OUT="$BUILDS_DIR/drac-$SLUG.apk"
echo ">> assinando com a keystore do cliente…"
# Sem --key-pass: a senha da chave é a mesma do store (apksigner assume).
# Passar o mesmo arquivo nos dois faria o apksigner ler 2x e bater EOF.
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KS" --ks-key-alias "$SLUG" \
  --ks-pass "file:$PASS_FILE" \
  --out "$OUT" "$UNSIGNED"
"$BUILD_TOOLS/apksigner" verify "$OUT" >/dev/null && echo ">> assinatura OK"

# Gate de segurança do artefato FINAL. Validar somente app.json não basta:
# plugins Android podem reinserir permissões durante o merge do manifest.
APK_PERMISSIONS="$("$BUILD_TOOLS/aapt" dump permissions "$OUT")"
for forbidden in android.permission.SYSTEM_ALERT_WINDOW android.permission.WRITE_EXTERNAL_STORAGE; do
  if grep -Fq "name='$forbidden'" <<<"$APK_PERMISSIONS"; then
    echo "permissão proibida no APK final: $forbidden" >&2
    exit 4
  fi
done
APK_MANIFEST="$("$BUILD_TOOLS/aapt" dump xmltree "$OUT" AndroidManifest.xml)"
grep -Eq 'android:allowBackup.*0x0$' <<<"$APK_MANIFEST" || { echo "APK final permite backup de dados internos" >&2; exit 4; }
grep -Eq 'android:usesCleartextTraffic.*0x0$' <<<"$APK_MANIFEST" || { echo "APK final permite tráfego sem TLS" >&2; exit 4; }
grep -Eq 'android:requestLegacyExternalStorage.*0x0$' <<<"$APK_MANIFEST" || { echo "APK final usa armazenamento legado" >&2; exit 4; }
echo ">> manifest final validado (sem overlay/storage legado, backup e cleartext bloqueados)"

# Publica no diretório do host servido pelo nginx (sobrevive a rebuilds) +
# mantém a cópia em builds/.
cp -f "$OUT" "$APK_PUBLISH_DIR/drac-$SLUG.apk"
chmod 0644 "$APK_PUBLISH_DIR/drac-$SLUG.apk"

VERSION="$($BUILD_TOOLS/aapt dump badging "$OUT" 2>/dev/null | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
echo "OK_APK=$OUT"
echo "OK_VERSION=$VERSION"
echo "OK_URL=/apk/drac-$SLUG.apk"

# ── AAB (Android App Bundle) — formato exigido pela Google Play Store ─────────
# O APK acima serve p/ instalação direta (sideload); a Play só aceita AAB.
# Gera o bundle, assina com a MESMA keystore do cliente (vira a "upload key" no
# Play App Signing — updates futuros usam a mesma) e publica p/ download.
echo ">> gradle bundleRelease (AAB para a Play Store)…"
( cd android && nice -n 15 ionice -c3 ./gradlew bundleRelease \
    -PreactNativeArchitectures="$TARGET_ABIS" --no-daemon --console=plain >/dev/null )
AAB_UNSIGNED="$MOBILE_DIR/android/app/build/outputs/bundle/release/app-release.aab"
if [[ -f "$AAB_UNSIGNED" ]]; then
  AAB_OUT="$BUILDS_DIR/drac-$SLUG.aab"
  # O gradle bundleRelease JÁ assina o AAB com a keystore de DEBUG (config
  # padrão do Expo). Se só rodássemos o jarsigner por cima, o AAB ficaria com
  # DUAS cadeias de certificado (debug + cliente) e a Play recusa ("mais de uma
  # cadeia de certificados"). Então primeiro REMOVEMOS qualquer assinatura
  # existente (META-INF/*.SF|RSA|DSA|EC) e só depois assinamos com a do cliente
  # — o jarsigner ADICIONA assinatura (não substitui como o apksigner).
  AAB_CLEAN="$(mktemp --suffix=.aab)"
  python3 - "$AAB_UNSIGNED" "$AAB_CLEAN" <<'PY'
import sys, zipfile, re
src, dst = sys.argv[1], sys.argv[2]
sig = re.compile(r'^META-INF/.*\.(SF|RSA|DSA|EC)$', re.I)
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
    for it in zin.infolist():
        if not sig.match(it.filename):
            zout.writestr(it, zin.read(it.filename))
PY
  # AAB é assinado com jarsigner (JAR signing), não com apksigner. A senha é lida
  # DIRETO do arquivo 0600 pelo próprio jarsigner (-storepass:file / -keypass:file),
  # igual ao keytool e ao apksigner acima — nunca cai numa variável de shell nem
  # vira argumento de linha de comando visível no `ps`/`/proc/<pid>/cmdline` para
  # outros usuários do host.
  echo ">> assinando o AAB (cadeia única do cliente)…"
  "$JAVA_HOME/bin/jarsigner" -keystore "$KS" \
    -storepass:file "$PASS_FILE" -keypass:file "$PASS_FILE" \
    -sigalg SHA256withRSA -digestalg SHA-256 \
    -signedjar "$AAB_OUT" "$AAB_CLEAN" "$SLUG" >/dev/null
  rm -f "$AAB_CLEAN"
  # Upload keys locais são autoassinadas; `-strict` retorna 4 nesse caso mesmo
  # quando a assinatura é íntegra. A verificação normal valida a integridade e
  # a checagem abaixo garante que não há um segundo signer.
  "$JAVA_HOME/bin/jarsigner" -verify "$AAB_OUT" >/dev/null
  # Depois da limpeza deve existir exatamente um bloco de assinatura. Isso
  # detecta regressões que deixariam debug + cliente no mesmo AAB.
  python3 - "$AAB_OUT" <<'PY'
import re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as bundle:
    blocks = [n for n in bundle.namelist() if re.match(r'^META-INF/.*\.(RSA|DSA|EC)$', n, re.I)]
if len(blocks) != 1:
    raise SystemExit(f'AAB deve conter uma única assinatura; encontradas {len(blocks)}: {blocks}')
PY
  echo ">> assinatura única do AAB validada"
  APK_SHA256="$(sha256sum "$OUT" | awk '{print $1}')"
  AAB_SHA256="$(sha256sum "$AAB_OUT" | awk '{print $1}')"
  SOURCE_COMMIT="$(git -C "$MOBILE_DIR" rev-parse HEAD 2>/dev/null || printf unknown)"
  SOURCE_DIRTY=false
  [[ -n "$(git -C "$MOBILE_DIR" status --porcelain 2>/dev/null)" ]] && SOURCE_DIRTY=true
  BUILD_INFO="$BUILDS_DIR/drac-$SLUG-build-info.json"
  export SLUG APP_NAME PACKAGE_ID VERSION NEW_VC SOURCE_COMMIT SOURCE_DIRTY APK_SHA256 AAB_SHA256
  node - "$BUILD_INFO" <<'NODE'
const fs = require('node:fs');
const out = process.argv[2];
fs.writeFileSync(out, JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  client: process.env.SLUG,
  appName: process.env.APP_NAME,
  packageId: process.env.PACKAGE_ID,
  versionName: process.env.VERSION,
  versionCode: Number(process.env.NEW_VC),
  sourceCommit: process.env.SOURCE_COMMIT,
  sourceDirty: process.env.SOURCE_DIRTY === 'true',
  artifacts: {
    apk: { file: `drac-${process.env.SLUG}.apk`, sha256: process.env.APK_SHA256 },
    aab: { file: `drac-${process.env.SLUG}.aab`, sha256: process.env.AAB_SHA256 },
  },
}, null, 2) + '\n');
NODE
  cp -f "$AAB_OUT" "$APK_PUBLISH_DIR/drac-$SLUG.aab"
  cp -f "$BUILD_INFO" "$APK_PUBLISH_DIR/drac-$SLUG-build-info.json"
  printf '%s  %s\n' "$APK_SHA256" "drac-$SLUG.apk" > "$APK_PUBLISH_DIR/drac-$SLUG.sha256"
  printf '%s  %s\n' "$AAB_SHA256" "drac-$SLUG.aab" >> "$APK_PUBLISH_DIR/drac-$SLUG.sha256"
  chmod 0644 "$APK_PUBLISH_DIR/drac-$SLUG.aab" "$APK_PUBLISH_DIR/drac-$SLUG-build-info.json" "$APK_PUBLISH_DIR/drac-$SLUG.sha256"
  echo "OK_AAB=$AAB_OUT"
  echo "OK_AAB_URL=/apk/drac-$SLUG.aab"
else
  echo ">> aviso: AAB não gerado (bundleRelease falhou) — só o APK ficou disponível" >&2
fi

# ── Kit de publicação Play Store ─────────────────────────────────────────────
# Junta num .zip tudo que dá p/ AUTOMATIZAR do que a Play pede: o AAB + ícone
# 512×512 + URL da política + o checklist + um LEIA-ME com os dados do app. O
# resto (screenshots, questionários de Data safety/classificação) é preenchido à
# mão no Play Console. Best-effort num subshell (set +e): NUNCA derruba o build.
if [[ -f "$APK_PUBLISH_DIR/drac-$SLUG.aab" ]] && KIT_STAGE="$(mktemp -d)"; then
  echo ">> montando kit Play Store…"
  (
    set +e
    # APP_NAME vem do cadastro do cliente e vira NOME DE ARQUIVO — sanitiza para não
    # escapar do staging via '../' (o build-agent também valida na entrada).
    APP_NAME_FILE="${APP_NAME//[^A-Za-z0-9._-]/_}"
    cp "$APK_PUBLISH_DIR/drac-$SLUG.aab" "$KIT_STAGE/${APP_NAME_FILE:-app}.aab"
    ICON_SRC="$CLIENT_DIR/icon.png"; [[ -f "$ICON_SRC" ]] || ICON_SRC="$MOBILE_DIR/assets/icon.png"
    [[ -f "$ICON_SRC" ]] && command -v ffmpeg >/dev/null 2>&1 && \
      ffmpeg -y -loglevel error -i "$ICON_SRC" -vf "scale=512:512:flags=lanczos" "$KIT_STAGE/icone-512.png" 2>/dev/null
    CHECKLIST="$MOBILE_DIR/../../docs/play-store-checklist.md"
    [[ -f "$CHECKLIST" ]] && cp "$CHECKLIST" "$KIT_STAGE/checklist-play-store.md"
    [[ -f "$BUILDS_DIR/drac-$SLUG-build-info.json" ]] && cp "$BUILDS_DIR/drac-$SLUG-build-info.json" "$KIT_STAGE/build-info.json"
    [[ -f "$APK_PUBLISH_DIR/drac-$SLUG.sha256" ]] && cp "$APK_PUBLISH_DIR/drac-$SLUG.sha256" "$KIT_STAGE/SHA256SUMS.txt"
    # Os valores vão por ENV, nunca costurados no FONTE do `node -e`. Antes, o apiUrl do
    # cliente era interpolado dentro de um literal JS ('$API_URL'): uma aspa simples no
    # valor fechava a string e o resto executava como JavaScript — e este script roda no
    # HOST (build-agent fora do container), com acesso às keystores de assinatura.
    API_URL="$(DRAC_CONFIG_PATH="$CONFIG" node -e 'process.stdout.write((require(process.env.DRAC_CONFIG_PATH).apiUrl||""))' 2>/dev/null)"
    PRIV_URL="$(DRAC_API_URL="$API_URL" node -e 'const a=(process.env.DRAC_API_URL||"").replace(/\/api\/*$/,"").replace(/\/+$/,""); process.stdout.write(a?a+"/privacidade.html":"(defina o dominio HTTPS do servidor)")' 2>/dev/null)"
    cat > "$KIT_STAGE/LEIA-ME.txt" <<EOF
Kit de publicação — $APP_NAME
Gerado em: $(date '+%Y-%m-%d %H:%M')

ARQUIVOS DESTE KIT
- ${APP_NAME}.aab ............ suba ESTE arquivo no Play Console (é o app).
- icone-512.png ............. ícone 512x512 p/ a listagem.
- checklist-play-store.md ... passo a passo + Data safety.

DADOS DO APP
- Nome ....... $APP_NAME
- Pacote ..... $PACKAGE_ID
- Versão ..... ${VERSION:-?} (versionCode ${NEW_VC:-?} — auto-incrementa a cada build)

PREENCHER NO PLAY CONSOLE (não são arquivos, é formulário):
- Política de privacidade (URL): $PRIV_URL
- Data safety: criptografado em trânsito = Sim (servidor usa HTTPS).
- Screenshots do celular (2+) e feature graphic 1024x500.
- Classificação de conteúdo (questionário).

Sugestão: comece por TESTE INTERNO, valide num celular real, depois PRODUÇÃO.
EOF
    python3 - "$KIT_STAGE" "$BUILDS_DIR/drac-$SLUG-playstore-kit.zip" <<'PY'
import sys, os, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in sorted(os.listdir(stage)):
        z.write(os.path.join(stage, name), name)
PY
  )
  if [[ -f "$BUILDS_DIR/drac-$SLUG-playstore-kit.zip" ]]; then
    cp -f "$BUILDS_DIR/drac-$SLUG-playstore-kit.zip" "$APK_PUBLISH_DIR/drac-$SLUG-playstore-kit.zip"
    chmod 0644 "$APK_PUBLISH_DIR/drac-$SLUG-playstore-kit.zip"
    echo "OK_KIT_URL=/apk/drac-$SLUG-playstore-kit.zip"
  else
    echo ">> aviso: kit Play Store não gerado" >&2
  fi
  rm -rf "$KIT_STAGE"
fi
