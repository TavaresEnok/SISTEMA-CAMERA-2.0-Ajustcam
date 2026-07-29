# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /app

# BUILD REPRODUTÍVEL E VERIFICADO.
#
# Antes: só o go.mod era copiado (o go.sum estava comentado) e o build rodava
# `go mod tidy`. Três problemas nisso, todos silenciosos:
#   1. sem go.sum não há verificação de CHECKSUM das dependências — o build
#      aceitava qualquer conteúdo que o proxy devolvesse (risco de supply chain);
#   2. `go mod tidy` RESOLVE versões na hora do build, então duas builds da mesma
#      commit podiam produzir binários diferentes;
#   3. tidy REESCREVE o go.mod dentro da imagem, então o que foi construído
#      deixa de corresponder ao que está versionado — o drift some do diff.
#
# Agora go.mod E go.sum entram juntos, `go mod download` valida os checksums e
# `go mod verify` confere o conteúdo baixado contra eles. Sem tidy: se o go.sum
# estiver faltando ou desatualizado, o build FALHA — que é o comportamento certo,
# em vez de "conserta sozinho" e embute uma dependência que ninguém revisou.
#
# Isto NÃO torna o build offline: baixar os módulos segue exigindo rede (ou um
# cache/vendor). O que muda é que agora o que se baixa é VERIFICADO e FIXO.
COPY services/camera-worker-go/go.mod services/camera-worker-go/go.sum ./
RUN go mod download && go mod verify

COPY services/camera-worker-go/*.go ./

RUN go vet ./...
RUN go test ./...
RUN go build -o camera-worker .

# Production stage
FROM alpine:latest

WORKDIR /app

# Install FFmpeg
RUN apk add --no-cache ffmpeg \
    && addgroup -g 1000 -S drac \
    && adduser -u 1000 -S -D -H -G drac drac

COPY --from=builder /app/camera-worker .
RUN chown drac:drac /app/camera-worker

USER drac

CMD ["./camera-worker"]
