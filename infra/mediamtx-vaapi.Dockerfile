# MediaMTX + ffmpeg com DRIVERS VA-API/QSV instalados (Intel e AMD).
#
# ⚠️ NÃO ESTÁ LIGADA EM PRODUÇÃO — de propósito.
# Nenhum docker-compose referencia esta imagem. Ela existe pronta para o dia em
# que quisermos acelerar em host Intel/AMD; ligar é um passo consciente, não um
# efeito colateral de um `up`. Ver "COMO USAR" no fim deste arquivo.
#
# ── O PROBLEMA QUE ELA RESOLVE ───────────────────────────────────────────────
# A imagem de produção (bluenviron/mediamtx:1-ffmpeg) é Alpine + `apk add ffmpeg`.
# Esse ffmpeg TEM h264_vaapi/h264_qsv COMPILADOS, mas a imagem NÃO tem nenhum
# driver VA instalado. Resultado no container: o encoder aparece em
# `ffmpeg -encoders` e falha na hora de abrir o dispositivo —
#   "No VA display found for device /dev/dri/renderD128"
# Exatamente o falso positivo que a detecção honesta da API (hwaccel-presets.
# helper.ts) passou a rejeitar. Aqui instalamos o que faltava.
#
# Referência do que instalar: concorrentes/frigate/docker/main/install_deps.sh:74-160
# (Frigate, MIT — Copyright (c) Frigate, Inc.). Lá a base é Debian; aqui é Alpine,
# então os nomes de pacote mudam mas o conjunto é o mesmo:
#   Debian (Frigate)                     →  Alpine (aqui)
#   libva-drm2                           →  libva
#   intel-media-va-driver-non-free (iHD) →  intel-media-driver
#   i965-va-driver-shaders (Gen7 e ant.) →  libva-intel-driver
#   mesa-va-drivers (AMD radeonsi)       →  mesa-va-gallium
#   vainfo (do intel-gpu-tools)          →  libva-utils
#   libmfx1 / libvpl2 (QSV)              →  libvpl (best-effort, ver abaixo)

# Mesma imagem, mesmo digest de PRODUÇÃO (docker-compose.yml:453). É um drop-in:
# mesmo binário do MediaMTX, mesmo mediamtx.yml, mesmo ffmpeg — só ganha drivers.
# ⚠️ Ao atualizar a imagem em docker-compose.yml, atualize este digest junto.
ARG MEDIAMTX_IMAGE=bluenviron/mediamtx:1-ffmpeg@sha256:65a3d7fff1debd4a33846eb0f3c28326ecb871d1359b6ad951848ace91ea1b20
FROM ${MEDIAMTX_IMAGE}

USER root

# Drivers VA-API. `libva-utils` traz o `vainfo`, que é como o Frigate
# (util/services.py:870-882) e a nossa detecção validam um render node.
RUN apk add --no-cache \
      libva \
      libva-utils \
      mesa-va-gallium \
      intel-media-driver \
      libva-intel-driver

# QSV (oneVPL) é BEST-EFFORT: o pacote não existe em toda release do Alpine e a
# ausência dele não pode quebrar o build — o VAAPI, que é o caminho principal em
# Intel, já está garantido acima. Quem decide se QSV funciona é o teste REAL da
# API (encode+decode curtos), nunca a presença do pacote.
RUN apk add --no-cache libvpl || echo "libvpl indisponível nesta release do Alpine: QSV ficará sem runtime (VAAPI continua funcionando)."

# Deixe o VA escolher sozinho. Force apenas se o auto-detect errar:
#   iHD       → Intel Gen8+ (Broadwell em diante) e Arc/Battlemage
#   i965      → Intel Gen7 e anteriores
#   radeonsi  → AMD
# ENV LIBVA_DRIVER_NAME=iHD

# ── COMO USAR (passo consciente, fora do compose de produção) ────────────────
# 1) Construir:
#      docker build -f infra/mediamtx-vaapi.Dockerfile -t drac-mediamtx-vaapi:local infra/
# 2) Conferir que o driver subiu (é o teste que separa "compilado" de "funciona"):
#      docker run --rm --device /dev/dri drac-mediamtx-vaapi:local \
#        vainfo --display drm --device /dev/dri/renderD128
#    Sem saída de perfis = a GPU não chegou ao container (falta --device /dev/dri
#    ou o usuário não está no grupo render/video do host).
# 3) Só então apontar o serviço `mediamtx` para esta imagem, num override
#    próprio (nunca editando docker-compose.yml direto), passando o dispositivo:
#      services:
#        mediamtx:
#          image: drac-mediamtx-vaapi:local
#          devices: ["/dev/dri:/dev/dri"]
#          group_add: ["video", "render"]
# 4) A live só passa a usar VAAPI quando isso for explicitamente ligado — o
#    transcode offline do playback (recordings.service.ts) é o campo de provas e
#    já cai sozinho para CPU se o hardware falhar.
