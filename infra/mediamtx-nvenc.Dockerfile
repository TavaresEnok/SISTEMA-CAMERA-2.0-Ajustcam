# MediaMTX + ffmpeg com NVENC (aceleração NVIDIA) — substitui a imagem padrão do
# serviço `mediamtx` quando o servidor tem GPU. É um drop-in: mesmo binário do
# MediaMTX, mesma config (/mediamtx.yml), só que o ffmpeg usado pelo runOnDemand
# passa a ter os encoders h264_nvenc/hevc_nvenc disponíveis.
#
# Roda igual em servidor SEM GPU (o nvenc só é chamado quando o admin liga a
# aceleração na UI E há GPU presente). Mas só faz sentido construir esta imagem
# em quem tem placa — o gpu-setup.sh cuida disso automaticamente.
ARG CUDA_TAG=12.4.1-runtime-ubuntu22.04
FROM nvidia/cuda:${CUDA_TAG}

# ⚠️ TEM de acompanhar a versão do MediaMTX de PRODUÇÃO (bluenviron/mediamtx:1-ffmpeg).
# A v1.9.3 que ficou aqui REJEITA o infra/mediamtx.yml atual (`hlsAllowOrigins`,
# linha 19, é chave mais nova): o container subia e morria, então ligar a GPU
# derrubava a live de TODAS as câmeras. Ao atualizar a imagem de produção,
# atualize esta linha junto — o gpu-setup.sh tem um smoke test que pega isso.
ARG MEDIAMTX_VERSION=v1.18.2
ARG TARGETARCH=amd64

# ffmpeg do Ubuntu 22.04 já traz h264_nvenc/hevc_nvenc (carrega libnvidia-encode
# em runtime, fornecida pelo NVIDIA Container Toolkit). netcat p/ o healthcheck.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates wget netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*

# Binário oficial do MediaMTX (mesmo do bluenviron/mediamtx).
RUN wget -qO /tmp/mediamtx.tar.gz \
      "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx \
 && rm /tmp/mediamtx.tar.gz

# As libs de encode da NVIDIA são injetadas pelo runtime; declaramos as capabilities.
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

ENTRYPOINT ["/usr/local/bin/mediamtx"]
CMD ["/mediamtx.yml"]
