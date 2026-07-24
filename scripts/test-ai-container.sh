#!/usr/bin/env bash
#
# Roda a suíte de testes do ai-service DENTRO de um container com cv2 (opencv
# pinado), para os testes que dependem de cv2 (MOG2) rodarem de verdade — o host
# não tem cv2. Usa uma imagem cacheada (drac-ai-test) para iterar rápido. Item 0.3.
#
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

IMAGE=drac-ai-test
docker build -q -t "$IMAGE" -f services/ai-service-python/Dockerfile.test services/ai-service-python >/dev/null

docker run --rm \
  -v "$(pwd)/services/ai-service-python:/svc" \
  -w /svc \
  "$IMAGE" \
  python -m unittest discover -s tests -t . "$@"
