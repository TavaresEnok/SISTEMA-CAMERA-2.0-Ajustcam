# IA e Worker

## Serviço Python

O serviço é ativo, não placeholder. O Compose o sobe sem profile e a API usa
`ai-service:8000`. Endpoints mutáveis exigem token interno forte; health/ready
ficam sem token mas são apenas `expose` na rede Docker.

Pontos positivos:

- frame queue com tamanho 1/latest-frame-only;
- threads daemon com stop/join;
- open/read timeout OpenCV e backoff;
- timeout no POST de evento;
- locks para processadores/modelos;
- confirmação de movimento fail-safe;
- watchdog/readiness e perfis adaptativos.

DRAC-AUD-015: o Compose base monta
`../services/ai-service-python:/app`, inclusive junto ao override de produção.
O código executado vem do checkout do host, não necessariamente da imagem
construída e testada.

Os 237 testes disponíveis passaram, mas 93 foram pulados sem a stack
cv2/onnxruntime/supervision. O CI evita esse falso-verde instalando e exigindo a
stack completa; isso não pôde ser repetido.

## Worker Go

É legado opt-in (`legacy-worker`) e transcodifica para H.264, divergindo do
pipeline canônico em cópia/remux. DRAC-AUD-020 registra:

- healthcheck em `127.0.0.1:8000/health` sem servidor HTTP no binário;
- `fetchCameras` usa `http.Client{}` sem timeout;
- `exec.Command` da gravação depende do `-t`, mas não de context cancellation;
- shutdown/sinais não são tratados.

O teste Go não iniciou porque o toolchain não está instalado. O uso de argv
evita injeção de shell; goroutines são coordenadas por mapa/mutex, mas o
encerramento gracioso é insuficiente.
