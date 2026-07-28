# Arquitetura

## Visão geral

```text
Web React / Mobile Expo
        │ JWT + tokens curtos de mídia
        ▼
API NestJS ── Prisma ── PostgreSQL
   │  │
   │  └── BullMQ / Redis ── jobs de saúde, retenção, thumbnails,
   │                         evidências, exportação e notificações
   ├── MediaMTX ── RTSP/HLS/WebRTC ── câmeras/FFmpeg/ONVIF
   ├── armazenamento bind-mounted ── gravações, clips e derivados
   └── AI FastAPI ── OpenCV/OpenVINO/ONNX ── eventos internos

Instalação DRAC ── heartbeat/licença ── DRAC Central
DRAC Central ── build-agent / SSH / instalador remoto
```

## Entrypoints e limites de confiança

- API: `apps/api/src/main.ts` e `AppModule`. Helmet, CORS allowlist,
  `ValidationPipe` global com whitelist e guards globais de JWT, função,
  permissão e throttle.
- Web: `apps/web/src/main.tsx`, servido pelo Nginx de
  `apps/web/nginx.conf`.
- Mobile: `apps/mobile/App.tsx`, configuração nativa em
  `apps/mobile/app.config.js` e `app.base.json`.
- Central: `apps/central/src/server.js`, servidor HTTP Node sem framework,
  cookie de sessão e datastore JSON/Postgres.
- IA: `services/ai-service-python/main.py`, FastAPI; endpoints mutáveis exigem
  `X-Service-Token`, health/ready são internos e públicos na rede Docker.
- Worker Go: `services/camera-worker-go/main.go`, consumidor Redis legado e
  gravador FFmpeg em `recorder.go`.

## API NestJS

Foram identificados 32 módulos, 28 controllers, 44 services, 46 arquivos de
DTO e quatro guards. Módulos principais: autenticação, usuários, papéis,
câmeras, grupos/permissões, streaming, PTZ/relés, gravações, evidências,
investigações, alarmes/notificações, IA, integridade, observabilidade, cloud
connector e app builder.

Autorização ocorre em camadas:

1. JWT/role/permission globais;
2. política comercial;
3. `AccessControlService` por câmera/grupo;
4. tokens curtos de stream/playback/download, normalmente revalidados no
   consumo.

## Dados e filas

- Prisma define usuários, sessões refresh, câmera e topologia, permissões,
  gravações/clips, eventos, evidências, investigações, alarmes e configurações.
- Há 38 diretórios de migration.
- BullMQ registra sete filas: health de câmeras, alarmes, retenção,
  thumbnails, evidências, exportação de gravação e recibos push.
- Repetições usam `jobId` estável; vários produtores usam IDs idempotentes.
- Redis também é usado para mute/notificações e controle legado de gravação.

## Streaming e armazenamento

- A API constrói URLs RTSP, descobre/prova ONVIF, executa FFmpeg/ffprobe com
  vetores de argumentos e gerencia processos de stream e gravação.
- MediaMTX publica HLS/WebRTC e autentica por callback HTTP da API.
- O pipeline canônico grava em segmentos TS/cópia e remuxa para MP4.
- Banco contém metadados/caminhos; arquivos vivem em `infra/storage` montado
  em `/storage`. Thumbnails, sprites, clips e cópias compatíveis são derivados.
- Retenção combina regra temporal, proteções de evidência/investigação e guarda
  de ocupação de disco.

## Central e operação

- A instalação envia heartbeat/licença à Central.
- A Central armazena instalações, usuários, sessões e auditoria como documento
  inteiro em JSON ou o mapeia para tabelas Postgres.
- Rotas de banco são serializadas dentro de um processo Node.
- A Central gera instaladores, pode operar por SSH e aciona build-agent de APK.
- Backup Postgres, verificador, backup Central e offsite são serviços Compose.
- Atualização/restore são scripts shell explícitos e destrutivos, não
  executados nesta etapa.

## Divergências arquiteturais relevantes

- O Nginx conhece `drac-central`, mas o Compose não o define.
- O Compose base monta o código-fonte de IA sobre `/app`, inclusive no perfil
  de produção, neutralizando a imutabilidade da imagem construída.
- O worker Go permanece disponível por profile, mas diverge do gravador
  canônico e seu healthcheck aponta para um servidor HTTP inexistente.
- API e Central mantêm rate limit parcial em memória, o que não é compartilhado
  por réplicas.
