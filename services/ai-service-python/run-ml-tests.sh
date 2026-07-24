#!/usr/bin/env bash
#
# Roda a suíte do ai-service DENTRO de um container com a stack de ML
# (cv2 + supervision/ByteTrack + requests) — o host não tem cv2 nem supervision.
# Cobre os testes que dependem da stack pesada (object_detector, stream_processor)
# além dos que já rodam no container leve. Usa a imagem cacheada drac-ai-test-ml
# (Dockerfile.test.ml) para iterar rápido. Item D3 / 4.4.
#
# Uso (de qualquer lugar do repo):
#   bash services/ai-service-python/run-ml-tests.sh
#   bash services/ai-service-python/run-ml-tests.sh -k ObjectDetector   # filtra
#
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

IMAGE=drac-ai-test-ml
docker build -q -t "$IMAGE" \
  -f services/ai-service-python/Dockerfile.test.ml \
  services/ai-service-python >/dev/null

docker run --rm \
  -v "$(pwd)/services/ai-service-python:/svc" \
  -w /svc \
  "$IMAGE" \
  python -m unittest discover -s tests -t . "$@"
