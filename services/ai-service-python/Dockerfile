FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for OpenCV and model runtimes.
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    build-essential \
    cmake \
    wget \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# `supervision` exige `opencv-python` (NÃO-headless) e o pip acaba instalando os
# DOIS pacotes no mesmo diretório `cv2/` — o último a instalar vence. Resultado
# observado em produção (2026-07-21): requirements pinado em 4.10.0.84, mas
# `import cv2` carregava 4.11.0.86 (a build com dependências de GUI), ou seja, o
# pin era silenciosamente ignorado e o container carregava 79 MB de OpenCV
# duplicado. Aqui removemos a variante não-headless e reinstalamos a headless
# pinada, garantindo UMA versão — a mesma declarada e validada.
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y opencv-python \
    && pip install --no-cache-dir --force-reinstall --no-deps \
       "$(grep -E '^opencv-python-headless==' requirements.txt)" \
    && python -c "import cv2, sys; want='$(grep -E '^opencv-python-headless==' requirements.txt | cut -d= -f3)'; \
       sys.exit(0) if cv2.__version__ == '.'.join(want.split('.')[:3]) else \
       sys.exit(f'OpenCV divergente: import={cv2.__version__} esperado={want}')"

RUN mkdir -p /app/models

ARG AI_SERVICE_SOURCE_REV=local
COPY . .
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin drac \
    && chown -R drac:drac /app

USER drac

EXPOSE 8000

CMD ["python", "main.py"]
