# Imagem para os testes do ai-service que precisam da stack de ML ALÉM de cv2:
# supervision (sv.ByteTrack) para cobrir o object_detector (pós-processamento/
# filtro/tracking com saída SINTÉTICA) e requests para importar o stream_processor.
# NÃO instala openvino/ultralytics nem baixa modelos — a inferência real é
# substituída por uma infer_request sintética nos testes. O código é montado em
# runtime; nada é COPIADO aqui, então a camada de pip fica cacheada.
FROM python:3.12-slim
# supervision arrasta opencv-python (NÃO-headless) e sequestra o `import cv2`
# (ver memória opencv-duplicado-ai-service). Instala tudo, remove a variante
# não-headless e reforça a headless pinada — UMA versão de cv2, sem depender de
# libGL no slim.
RUN pip install --no-input --no-cache-dir \
      supervision==0.27.0 \
      opencv-python-headless==4.10.0.84 \
      numpy==1.26.4 \
      requests==2.32.3 \
 && (pip uninstall -y opencv-python || true) \
 && pip install --no-input --no-cache-dir --force-reinstall --no-deps \
      opencv-python-headless==4.10.0.84 \
 && python -c "import cv2, supervision, numpy, requests; print('cv2', cv2.__version__, 'sv', supervision.__version__)"
ENV PYTHONDONTWRITEBYTECODE=1
