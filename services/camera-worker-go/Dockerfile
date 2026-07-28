# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY services/camera-worker-go/go.mod ./
# COPY services/camera-worker-go/go.sum ./
RUN go mod download

COPY services/camera-worker-go/*.go ./

RUN go mod tidy
RUN go test ./...
RUN go vet ./...
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
