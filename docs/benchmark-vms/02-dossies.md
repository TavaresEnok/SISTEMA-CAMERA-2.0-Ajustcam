# 02 — Dossiês Individuais (Passo A)

Este documento consolida os 8 dossiês técnicos produzidos na primeira passagem
de análise (Passo A), um por sistema, cada um redigido por um analista
independente sem acesso ao histórico dos demais. As notas aqui são
**preliminares** — refletem o julgamento de cada análise isolada, antes da
calibração horizontal (Passo B, documentada em [03-matriz-evidencias.md](03-matriz-evidencias.md)
e [04-ranking.md](04-ranking.md)), que ajustou um pequeno número de notas do
DRAC para consistência com o restante do conjunto (ver nota de calibração no
final de cada dossiê ajustado). As tabelas de notas *finais* usadas no
ranking estão em `03-matriz-evidencias.md`; as tabelas abaixo são o
julgamento bruto de cada analista, preservado para rastreabilidade.

Cada dossiê inclui, conforme exigido pelo protocolo: arquitetura, escopo,
funcionalidades encontradas/ausentes, maturidade, principais arquivos,
limitações da análise, uma seção de busca ativa por implementações não
óbvias (Passo D) e, no caso do DRAC, uma seção adicional de revisão
adversarial (Passo C).

---

# DRAC

**Nota de calibração (Passo B):** duas notas preliminares deste dossiê foram
ajustadas na consolidação por inconsistência horizontal — ver
[03-matriz-evidencias.md](03-matriz-evidencias.md) §Calibração. Gravação
5→4 (ZoneMinder, Frigate, Moonfire e Viseron, todos com engenharia de
gravação comparável, ficaram em 4; nenhum diferencial do DRAC justificou
destacá-lo isoladamente em 5). Maturidade de engenharia 5→4 (o próprio
achado adversarial deste dossiê — testes de RBAC/access-control contra
Prisma inteiramente mockado, não integração real contra Postgres — pesa
contra colocar DRAC no mesmo patamar de Frigate, cujo e2e roda contra
instância real via Playwright). As demais 8 notas preliminares foram
mantidas sem alteração.

## 1. Arquitetura

DRAC é um sistema multi-processo/multi-linguagem organizado em monorepo pnpm:

- **`apps/api`** (NestJS/TypeScript, Prisma/PostgreSQL, Redis/BullMQ) — núcleo: câmeras, streaming, gravação, IA (orquestração), RBAC, alarmes, auditoria, filas.
- **`apps/web`** (React/TypeScript/Vite) — painel de administração e operação (SPA).
- **`apps/mobile`** (Expo/React Native) — app real para iOS/Android, build white-label por cliente.
- **`apps/central`** (Node.js puro, `server.js` de 2553 linhas) — painel mestre que monitora múltiplas instalações via heartbeat HTTP autenticado (`x-drac-installation-id` / `x-drac-license-key`).
- **`services/ai-service-python`** (Python, OpenCV, ONNXRuntime, InsightFace, supervision/ByteTrack) — processo separado de inferência (movimento, objetos, faces).
- **`services/camera-worker-go`** (Go) — worker de gravação distribuível, controlado via Redis, separado da API (permite escalar gravação para hosts adicionais).
- **`infra/`** — Docker Compose (dev/prod), MediaMTX (proxy RTSP/WebRTC/HLS), go2rtc (avaliação em profile separado), backups Postgres, GPU (NVENC/VAAPI).

Comunicação: API↔Postgres (Prisma), API↔Redis/BullMQ (filas), API↔ai-service (HTTP), API↔MediaMTX (API REST + arquivos de config), API↔camera-worker-go (Redis pub/sub + HTTP health `:8000`), mobile/web↔API (REST/JWT), Central↔instalações (heartbeat HTTP assinado).

## 2. Escopo

É uma **plataforma VMS completa** (não uma biblioteca nem um mero player): ingestão, gravação, IA, RBAC, playback, mobile, multi-instalação e white-label estão todos presentes com implementação real, não apenas API de vídeo. O escopo vai além de "VMS simples" ao incluir: bloqueio comercial por inadimplência (`GroupAccessStatus`), câmera privada com inversão de privilégio de admin (LGPD), painel central de gestão de frota de instalações, e pipeline de build de APK por cliente.

## 3. Funcionalidades encontradas (com evidência)

- **Streaming/proxy**: MediaMTX como proxy RTSP/WebRTC/HLS (`infra/docker-compose.yml:555-591`, `infra/mediamtx.yml`); `apps/api/src/camera-stream/mediamtx-proxy.service.ts` (1407 linhas) e `source-gateway.service.ts` (870 linhas) implementam dedup de conexão por câmera+perfil, backoff exponencial com jitter e circuit breaker (`source-gateway.service.ts:175-206,634-663`).
- **Gravação**: `recording-process-manager.service.ts` controla processos FFmpeg por câmera, com anel de stderr (`ffmpeg-stderr-ring.helper.ts`), guarda de disco cheio antes de iniciar e durante gravação (`recording-process-manager.service.ts:323-418`, usa `statfs`), reconciliação DB↔disco (`recording-reconcile.helper.ts`), retenção em dois níveis com quarentena de `motionScore` desconhecido (`retention.service.ts:38-60`).
- **IA**: detector de movimento MOG2 leve (`detectors/motion.py`), detector de objetos ONNX com regiões propostas por movimento (`detectors/object_detector.py`), detector de faces via InsightFace com suporte CPU/GPU (`detectors/face_detector.py:1-22`), zonas de detecção por câmera com polígonos normalizados incluir/excluir persistidas e consumidas ponta a ponta (`schema.prisma:120-129` → `ai-manager.service.ts:903` → `stream_processor.py:136`), guarda de FPS anômalo derivada do Frigate que **denuncia mas não mata** o processo (`capture_rate_guard.py:1-40`).
- **Failsafe IA→gravação**: invariante testado "IA fora ⇒ grava" — IA indisponível nunca suprime gravação, só `confirmed=false` explícito suprime (`apps/api/tests/ai-failsafe.test.ts:1-30`).
- **RBAC/privacidade**: gate único de conteúdo `AccessControlService` com inversão de privilégio de admin para câmeras privadas (`access-control.service.ts:17-322`), matriz adversarial de testes cobrindo dono/grupo/delegado/outsider/admin (`apps/api/tests/access-matrix.test.ts`), bloqueio comercial por grupo (RESTRICTED/SUSPENDED) aplicado tanto na listagem quanto no gate de conteúdo (`access-control.service.ts:59-77,257-274`).
- **Auditoria**: `AuditLog` com exportação CSV/JSON, filtros, protegido por `@Roles(ADMIN)` + `@RequirePermission('auditLogs')` (`apps/api/src/audit/audit.controller.ts`).
- **Playback/evidência**: VOD m3u8, tokens de play, diagnóstico de integridade, snapshot, exportação por range, download em lote (ZIP), fila BullMQ dedicada (`recordings.controller.ts:75-574`, `jobs/queues/recording-export.queue.ts`, `evidence-export.processor.ts`).
- **Mobile real**: telas de Live/Mosaico/Playback/Alarmes/Review/Configurações (`apps/mobile/src/screens/`), token de sessão em `expo-secure-store` (não AsyncStorage puro) com migração de sessões legadas (`sessionStore.ts:15-33`), biometria via `expo-local-authentication` (`biometrics.ts`), push via Expo com fila de recibos e reconciliação de tokens inválidos (`notifications/expo-receipts.helper.ts`, `push-devices.service.ts:33-34`).
- **White-label real**: build de APK por cliente com keystore própria persistente, config por `clients/<slug>/config.json`, validação de slug por regex (`apps/mobile/scripts/build-client.sh:1-40`); branding runtime no web (logo/cores) via `GET /settings/branding`.
- **Central multi-instalação**: heartbeat autenticado por instalação, rejeição de instalação desconhecida, sanitização de payload citada explicitamente contra XSS armazenado (`apps/central/src/server.js:1081-1164`), séries temporais por instalação, resumo de frota (`fleetSummary`).
- **Escalabilidade**: worker de gravação em Go separado da API, orientado a Redis, com `RecordingSource.WORKER` no schema permitindo saber a origem de cada gravação (`schema.prisma:66-70`, `services/camera-worker-go/main.go`); filas BullMQ dedicadas por responsabilidade (limpeza, exportação, thumbnail, health-check, push, alarme) — 7 filas/processadores especializados.
- **CI real**: pipeline com testes Python (com *gate* explícito contra skip silencioso de dependências ML — `.github/workflows/ci.yml:37-54`), suite `pnpm verify` (testes API+web+mobile+central, typecheck, build), **e2e RTSP obrigatório contra fonte sintética** (`ci.yml:111-116`), build Docker de API/Web, build Android release com checagem de permissões inseguras no manifest fundido (`ci.yml:174-179`).

## 4. Funcionalidades ausentes ou apenas mencionadas em documentação

- **go2rtc**: presente só como serviço de avaliação A/B (`--profile eval`), não integrado ao runtime de produção. Não é uma feature de produção, é um experimento.
- **Multi-tenant "SaaS" clássico** (um banco servindo N clientes com isolamento por `tenantId`) **não existe**: não há `model Organization`/`Tenant` no Prisma. O isolamento entre clientes finais é via `CameraGroup`/`CameraPermission` dentro de uma única instalação, e o isolamento entre revendedores é via **instalações Docker separadas** monitoradas pela Central. Isso é uma arquitetura white-label multi-instância válida, mas não é "multi-tenancy" no sentido de plataforma SaaS compartilhada.
- **ONVIF**: há `onvifPort`/`onvifPath`/`onvifProfileToken` no schema e um `OnvifEventsService` referenciado em testes, mas não foi lida em profundidade a implementação de descoberta/PTZ ONVIF completa — tratado como parcialmente verificado, não como ausente comprovado.
- **Tracking multi-câmera / re-identificação entre câmeras**: não encontrado nenhum código de correlação de identidade entre câmeras distintas; o que existe é tracking intra-câmera (ByteTrack via `supervision`) e face detection isolada por câmera.

## 5. Maturidade geral de engenharia

Alta para os padrões do mercado de VMS regional: TypeScript `strict: true` em API e Web, 70 arquivos de teste no backend (`apps/api/tests`) cobrindo cenários adversariais nomeados (não apenas *happy path* — nomes como `group-access-block`, `recording-crash-restart`, `secret-url-process`, `camera-visual-confirmation`), testes Python com *gate* anti-falso-positivo no CI, testes Go (`main_test.go`, `secret_input_test.go`), 40 migrations Prisma incrementais, scripts operacionais com testes próprios (`operational-scripts-safety.test.ts`, `installer-security.test.js`). Comentários de código longos e didáticos documentam decisões e invariantes de forma verificável; vários citam explicitamente técnicas derivadas (com atribuição) de Frigate/moonfire/ZoneMinder, reimplementadas.

## 6. Principais arquivos

- `apps/api/prisma/schema.prisma` — modelo de dados central
- `apps/api/src/access-control/access-control.service.ts` — gate único de autorização de conteúdo
- `apps/api/src/camera-stream/{mediamtx-proxy,source-gateway}.service.ts` — streaming/roteamento
- `apps/api/src/recordings/recording-process-manager.service.ts` — controle de processos FFmpeg
- `apps/api/src/recordings/retention.service.ts` — retenção em dois níveis
- `services/ai-service-python/detectors/{motion,object_detector,face_detector}.py` — IA
- `services/ai-service-python/capture_rate_guard.py` — guarda de FPS anômalo
- `apps/mobile/src/services/sessionStore.ts` — armazenamento seguro de token
- `apps/mobile/scripts/build-client.sh` — build white-label por cliente
- `apps/central/src/server.js` — painel mestre multi-instalação
- `.github/workflows/ci.yml` — pipeline CI completo
- `apps/api/tests/access-matrix.test.ts`, `apps/api/tests/ai-failsafe.test.ts` — testes-chave de invariantes

## 7. Limitações da análise

Análise 100% estática: não foi possível verificar latência real de streaming, throughput de IA sob carga real, número de câmeras suportadas por host, comportamento do app mobile em dispositivo físico, robustez de reconexão sob falha de rede real, nem se os testes automatizados de fato passam no ambiente atual (build/testes não foram executados, por restrição da tarefa). Não avaliado `ai-manager.service.ts` (1006 linhas) nem `mediamtx-proxy.service.ts` (1407 linhas) linha a linha — leitura por amostragem/grep dirigido.

## 8. Revisão adversarial (Passo C)

- **Dedup de conexão (source-gateway)**: comentário de topo do arquivo afirma default `FALSE`, mas `docker-compose.yml:270` sobrescreve para `true` — inconsistência entre comentário e config operacional real. Risco de manutenção, não da feature em si.
- **Failsafe IA→gravação testado**: o teste usa mocks de `HttpService`/`ConfigService` inteiramente in-memory — não testa timeout real de rede nem IA lenta (não travada) em produção. É teste unitário de lógica pura, não prova comportamento integrado sob falha real.
- **RBAC "robusto com matriz adversarial"**: `access-matrix.test.ts` usa Prisma inteiramente mockado (funções reimplementadas manualmente sobre arrays fixos) — não é teste de integração contra Postgres real, não captura bugs de query (índices, transações concorrentes, race conditions em updates de `accessStatus`).
- **"40 migrations = maturidade"**: contagem não prova qualidade de cada uma; `prisma migrate deploy` pós-rebuild é passo manual documentado como gotcha operacional, não automatizado no pipeline de deploy.
- **White-label com keystore por cliente**: script robusto na validação de input, mas sem evidência de rollback automático se um build falhar no meio; cadeia de confiança termina no host de build, sem assinatura/verificação adicional do lado do Central antes de publicar o APK.
- **Central rejeita instalação desconhecida e sanitiza XSS**: mecanismo de autenticação é header em texto simples (`x-drac-license-key`) sem evidência de rotação/expiração/anti-replay; armazenamento em arquivo JSON local sem menção de criptografia em repouso.
- **Zonas de detecção ponta-a-ponta**: confirmado que o campo é lido pelo `stream_processor.py`, mas não confirmado que o resultado é de fato aplicado corretamente na lógica de decisão de evento downstream.
- **CI e2e RTSP obrigatório**: cobre só um cenário sintético; não há evidência de matriz de câmeras reais (Intelbras/Positivo/Tapo) testada automaticamente.
- **"Multi-tenancy" como alegação comercial**: não existe modelo `Organization`/`Tenant` — qualquer alegação de "multi-tenant SaaS" seria enganosa; a arquitetura real é single-tenant por instalação + multi-instalação via Central.

## 9. Tabela de notas preliminares (do dossiê original; ver calibração no topo)

| Dimensão | Nota | Confiança | Cobertura | Evidência (arquivo:linhas) | Mecanismo | Testes relacionados? | Limitações |
|---|---|---|---|---|---|---|---|
| 1. Ingestão/streaming ao vivo | 4 | média | parcial | `source-gateway.service.ts:27-93,175-206,634-663`; `mediamtx-proxy.service.ts`; `docker-compose.yml:555-591,270` | MediaMTX como proxy RTSP/WebRTC/HLS; dedup por câmera+perfil, backoff+jitter, circuit breaker; sanitização de credenciais em erro | Sim — `source-gateway.test.ts`, `rtsp-url.test.ts`, `secret-url-process.test.ts` | Latência real não verificável; ONVIF discovery/PTZ não lido em profundidade |
| 2. Gravação | 5→**4** (calibrado) | alta | completa | `recording-process-manager.service.ts:44-80,323-418`; `recording-reconcile.helper.ts`; `retention.service.ts:38-60` | FFmpeg gerenciado por câmera, guarda de disco, anel de stderr, reconciliação DB↔disco, retenção em dois níveis com quarentena | Sim — 6 arquivos de teste dedicados | Crash do host (não só do FFmpeg filho) não verificável |
| 3. Detecção e IA | 4 | média | parcial | `detectors/{motion,object_detector,face_detector}.py`; `schema.prisma:120-129`; `capture_rate_guard.py:1-40` | MOG2, ONNX com ROI por movimento, InsightFace CPU/GPU, zonas propagadas, guarda de FPS não-destrutiva | Sim — 4 arquivos de teste Python + `ai-failsafe.test.ts` | Precisão/throughput real não verificáveis; breadth menor que Frigate/Viseron (menos backends de HW) |
| 4. Playback e revisão | 4 | média | parcial | `recordings.controller.ts:75-574`; `review.controller.ts:16-60` | VOD m3u8, tokens, diagnóstico, exportação em fila, download em lote, feed de revisão | Sim — 6 arquivos de teste | Sincronização multi-câmera não verificada a fundo |
| 5. Multi-tenancy, RBAC e privacidade | 4 | alta | completa (dentro do modelo real) | `access-control.service.ts:17-322`; `schema.prisma:120-129`; `audit.controller.ts` | Gate único no backend, inversão de privilégio para câmera privada, bloqueio comercial em 2 pontos, auditoria protegida | Sim — 4 arquivos de teste (Prisma mockado, ver Passo C) | Sem `Organization/Tenant`; Central usa header simples sem rotação |
| 6. Mobile | 4 | média | parcial | `sessionStore.ts:1-33`; `biometrics.ts:1-28`; `expo-receipts.helper.ts` | App Expo real, token em secure-store, biometria, push com fila de recibos | Sim — testes mobile + API | Qualidade real em dispositivo não verificável |
| 7. Operação e observabilidade | 4 | alta | parcial | `health.controller.ts`; `docker-compose.yml` (healthchecks); `scripts/runtime-watchdog.sh`, `restore-drac.sh` | Health/readiness, healthchecks Docker, watchdog cron com alerta Telegram, scripts de backup/restore | Sim — 4 arquivos de teste | Restore real não testado nesta análise; migration pós-rebuild manual |
| 8. Escalabilidade e eficiência | 3 | média | parcial | `camera-worker-go/main.go`; `schema.prisma:66-70`; 7 filas BullMQ especializadas | Worker de gravação Go distribuível via Redis, filas especializadas, teto de conexões por câmera | Parcial — teste Go, sem evidência de teste de carga | Sem orquestração automática multi-host; capacidade real não verificável |
| 9. Maturidade de engenharia | 5→**4** (calibrado) | alta | completa | `.github/workflows/ci.yml`; `tsconfig.json` (strict); 70 arquivos de teste; 40 migrations | TS strict, CI com 6 jobs incl. e2e RTSP, testes nomeados por cenário adversarial | Sim — CI é a evidência | Testes de RBAC/access-control mockados, não integração real (ver Passo C) |
| 10. White-label e comercialização | 4 | média | parcial | `build-client.sh:1-40`; `mobile/clients/*`; `central/src/server.js:1081-1164,805-850` | Build de APK por cliente com keystore própria, Central com heartbeat/frota/anti-XSS | Sim — testes Central + build Android no CI | Provisionamento fim-a-fim não confirmado automatizado; segurança da chave de licença não verificada |

---

# Frigate NVR

**Caminho**: `/home/flashnet/Drac/concorrentes/frigate` | **Commit**: `39a3667f` (2026-05-25) | **Branch**: `dev`

## 1. Arquitetura

Aplicação monolítica multiprocesso em Python (não microsserviços): FastAPI (`frigate/api/`), Peewee/SQLite (`frigate/db/`), um processo por câmera (`frigate/video/detect.py:56 CameraTracker(FrigateProcess)`), ZMQ para IPC interno, MQTT opcional para integração externa. **go2rtc embutido** (não MediaMTX) para restream RTSP/WebRTC/MSE de baixa latência. 13 backends de detecção de hardware plugáveis (`frigate/detectors/plugins/`). Frontend React/TS/Vite/Tailwind/Radix, PWA. nginx como reverse-proxy/auth_request na frente do FastAPI.

## 2. Escopo

VMS/NVR completo, **single-tenant, self-hosted, uma instalação por instância**. Não é biblioteca. RBAC existente restringe visibilidade de câmeras por papel **dentro da mesma instalação**, não isolamento entre clientes distintos de um revendedor. Sem app mobile nativo (só PWA + web push). Sem white-label.

## 3. Funcionalidades encontradas

RTSP/ONVIF (`config/camera/onvif.py`, `ptz/onvif.py`); go2rtc/WebRTC/MSE (`api/camera.py`, protegido por `require_go2rtc_stream_access`); watchdog de captura com reconexão/backoff (`video/ffmpeg.py:129-260 CameraWatchdog`); redação de credenciais em log **aplicada globalmente no logger** (`util/builtin.py:110`, `log.py:128`), com teste dedicado; redação de segredos na config exposta via API (`api/app.py:292-309`); gravação segmentada com validação via ffprobe e descarte de segmentos corrompidos (`record/maintainer.py:318-484`); retenção por modo/severidade (`record/cleanup.py:64-283`); sincronização arquivo↔banco com threshold de segurança contra deleção em massa (`util/media.py:222-231`); truncamento de WAL; backup de DB pré-migração; motion/object detection multi-backend, tracking (centroid + Norfair), zonas/máscaras, reconhecimento facial e de placas, 5 integrações GenAI; RBAC real **aplicado no backend**, inclusive para mídia estática servida via nginx com proteção contra path traversal (`api/media_auth.py`); CI real (ruff, mypy, unittest, E2E Playwright, build multi-arch 8 variantes de hardware).

## 4. Funcionalidades ausentes

Multi-tenancy real (zero ocorrências de `tenant`/`organization`/`multi_instance` em `frigate/*.py`); white-label/branding por cliente (logo é SVG fixo); painel central multi-instalação; app móvel nativo (só web push de navegador, não push nativo FCM/APNs); backup/restore completo automatizado (só backup pontual de DB/config, sem mídia).

## 5. Maturidade

Alta: type hints extensivos + mypy no CI, Ruff/ESLint/Prettier, 41 testes unitários + 10 de API HTTP + E2E Playwright cobrindo auth/live/replay/export/review, 35 migrações nomeadas, CI de build multi-arquitetura (amd64/arm64/RPi/Jetson/ROCm/Rockchip/Synaptics).

## 6. Principais arquivos

`frigate/api/auth.py`, `frigate/api/media_auth.py`, `frigate/config/proxy.py`, `frigate/record/maintainer.py`, `frigate/record/cleanup.py`, `frigate/util/media.py`, `frigate/video/ffmpeg.py`, `frigate/util/builtin.py`, `frigate/detectors/plugins/*.py`, `migrations/*.py`.

## 7. Limitações

Sem execução/benchmark; app mobile não existe para testar; go2rtc (binário/submódulo externo) não auditado; cobertura de "o que os testes testam" inferida por amostragem; front-end (120k linhas) não varrido por completo.

## 8. Busca por implementações não óbvias (Passo D)

Multi-tenancy sob nomes alternativos (`reseller`, `org_id`) — sem hits. `CAMERA_BRANDS` é catálogo de templates RTSP por fabricante para o wizard, não branding de produto — distinguido corretamente. App mobile sob nomes não óbvios (`capacitor`, `cordova`) — nada. Sanitização de credenciais é centralizada no logger (mais robusta que pontual). Autorização de mídia estática via nginx confirmada e testada — achado que evitou subestimar a dimensão 5.

## 9. Tabela de notas preliminares

| Dimensão | Nota | Confiança | Cobertura | Evidência | Mecanismo | Testes? | Limitações |
|---|---|---|---|---|---|---|---|
| 1. Ingestão/streaming | 4 | alta | completa | `video/ffmpeg.py:129-260`; `api/camera.py`; `util/builtin.py:110`+`log.py:128` | go2rtc embutido, watchdog com terminate→timeout→kill, redação global de credenciais | Sim | Latência não medida; go2rtc não auditado |
| 2. Gravação | 4 | alta | completa | `record/maintainer.py:318-484`; `record/cleanup.py:64-283`; `util/media.py:197-231` | Validação de segmento, retenção por severidade, sync com safety threshold | Sim | Recuperação pós-crash não testada em runtime |
| 3. Detecção e IA | 4 | média-alta | completa | `detectors/plugins/*` (13 backends); `track/*`; `data_processing/post/{face,license_plate}.py` | Processo isolado por câmera, múltiplos backends HW, tracking, face/placa, GenAI | Sim | Precisão real não verificável |
| 4. Playback e revisão | 4 | média | completa | `web/views/explore,recording`; `api/export.py`; E2E specs | Timeline, busca semântica, exportação, replay/debug | Sim (E2E) | UX real não navegada |
| 5. Multi-tenancy/RBAC | 2 | alta | parcial | `api/auth.py:435-470,1064-1166`; `api/media_auth.py`; 0 hits `tenant/organization` | RBAC real backend-enforced, mas **sem multi-tenant** | Sim, extenso | RBAC forte isoladamente não compensa ausência de isolamento entre clientes |
| 6. Mobile | 0 | alta | completa | busca exaustiva por app nativo = 0 resultados | Só PWA + web push, sem app | N/A | — |
| 7. Operação | 4 | alta | completa | `watchdog.py:42`; `video/ffmpeg.py:129`; `util/services.py:1148-1157`; 35 migrations | Watchdogs em camadas, métricas de storage, self-healing | Sim | Sem alerta externo tipo Telegram |
| 8. Escalabilidade | 4 | média-alta | completa | `video/detect.py:56`; `detectors/plugins/*`; `comms/` (ZMQ) | Processo isolado por câmera, 13 aceleradores HW | Parcial | Sem cluster nativo |
| 9. Maturidade | 5 | alta | completa | CI completo; 41+10+E2E testes; 35 migrations; convenções documentadas | Lint+tipagem+testes+E2E+build multi-arch | Sim, extenso | — |
| 10. White-label | 0 | alta | completa | busca exaustiva = só `CAMERA_BRANDS` (catálogo de câmera, não branding) | Nenhum mecanismo de personalização de marca | N/A | — |

---

# Scrypted

**Caminho**: `/home/flashnet/Drac/concorrentes/scrypted` | **Commit**: `1545790cd` (2026-05-20) | **Branch**: `main`

## 1. Arquitetura

Plataforma de runtime de plugins: núcleo de orquestração/RPC em TypeScript (`server/src/`, 80 arquivos, sem lógica de câmera/gravação própria), ~50 plugins independentes cada um em processo/thread próprio (Node ou Python), comunicação via RPC serializado. `sdk/types/src/types.input.ts` define contratos, não implementação. **UI web ausente deste checkout** (instalada via npm em runtime, fora do escopo git). **App mobile inexistente** — delega a Apple Home/Google Home/Alexa.

## 2. Escopo — determinante para as notas

Confirmado por código (READMEs de plugins de IA dizem "should only be used if you are a Scrypted NVR user", mas isso é **falso pelo código** — funcionam standalone): a gravação contínua/timeline/retenção "profissional" vive em um **plugin fechado e pago** (`@scrypted/nvr`), referenciado só por ID de dispositivo, nunca definido neste checkout. O que está implementado no OSS e funciona standalone: motion/object detection real (OpenCV/ONNX/CoreML/RKNN/OpenVINO/TFLite/NCNN), streaming (RTSP/ONVIF/WebRTC) com rebroadcast/pre-buffer/watchdog. Gravação real em disco só existe para clipes HomeKit Secure Video.

## 3. Funcionalidades encontradas

Rebroadcast RTSP com pre-buffer e retry com backoff exponencial (`prebuffer-mixin/src/main.ts:1147-1156`); kill gracioso de ffmpeg escalonado (`media-helpers.ts:11-35`); redação de credenciais em log usada em 10+ plugins; watchdog de inatividade; ONVIF PullPoint real; WebRTC nativo com TURN/STUN próprios (não proxy externo); motion detection real via OpenCV; object detection multi-backend real com aceleração de hardware; zonas poligonais com ray-casting real; scheduler de carga por FPS; ACL server-side real (não filtro de UI) no caminho de despacho RPC; auto-restart de plugin travado; gravação de clipes HKSV com pre-roll e prune sensível a disco cheio.

## 4. Funcionalidades ausentes/só em docs

Gravação contínua/NVR completo (vive no plugin fechado); alegação dos READMEs de IA "gated pelo NVR" é falsa pelo código; `ObjectTracker`/`movement` nunca escrito no OSS; 2 arquivos de teste quebrados (import de módulo inexistente, dependência não declarada); branding configurável zero; migrations de dados zero.

## 5. Maturidade

TypeScript strict; padrão de tratamento de erro replicado em 10+ plugins. Mas: **zero arquivos de teste real** no repositório inteiro (scripts sem asserção, não plugados a CI); CI só faz smoke-install, sem lint configurado; senha com SHA-256+salt simples, sem 2FA/rate-limit.

## 6. Principais arquivos

`server/src/rpc.ts`, `server/src/plugin/acl.ts`, `server/src/services/users.ts`, `plugins/prebuffer-mixin/src/main.ts`, `plugins/onvif/src/onvif-api.ts`, `plugins/webrtc/src/*.ts`, `plugins/objectdetector/src/main.ts`, `plugins/opencv/src/opencv/__init__.py`, `plugins/homekit/src/types/camera/*.ts`, `plugins/cloud/src/main.ts`.

## 7. Limitações

UI web e app mobile ausentes do checkout — não verificáveis. Plugin `@scrypted/nvr` (produto pago real) totalmente fora do código. Nenhum benchmark possível.

## 8. Busca por implementações não óbvias (Passo D)

Confirmado que object detection **não é gated** pelo NVR fechado — plugins implementam a interface completa e funcionam standalone (elevou a nota de IA vs. aceitar a alegação do README). Disk-full handling encontrado em `video-clips-provider.ts` (`checkDiskSpace`). Campos `scoreThreshold` por zona confirmados como mortos (nunca lidos). Multi-tenancy: comentário do próprio autor confirma "single user setup... revisit... when multiple users are implemented" (`scrypted-server-main.ts:320-322`). Clustering confirmado como escala horizontal de UMA instalação, não fleet management.

## 9. Tabela de notas preliminares

| Dimensão | Nota | Confiança | Cobertura | Evidência | Mecanismo | Testes? | Limitações |
|---|---|---|---|---|---|---|---|
| 1. Ingestão/streaming | 3 | alta | parcial | `prebuffer-mixin/src/main.ts:1147-1156,738-766`; `media-helpers.ts:11-96`; `webrtc/src/ice-servers.ts` | Rebroadcast com pre-buffer, retry backoff, kill escalonado, redação de credenciais, WebRTC próprio | Não | Zero testes automatizados no repo |
| 2. Gravação | 2 | alta | parcial (escopo restrito) | `homekit/src/types/camera/camera-recording-files.ts`; `video-clips-provider.ts` | Só clipe HKSV com pre-roll e prune por disco; sem gravação contínua no OSS | Não | NVR real está em plugin fechado fora do repo |
| 3. Detecção e IA | 3 | alta | completa (p/ o que existe no OSS) | `opencv/src/opencv/__init__.py:112-198`; `onnx/src/ort/__init__.py:95-157`; `objectdetector/src/polygon.ts` | Motion/object detection real multi-backend, zonas, scheduler de carga | Quebrados | Tracking não populado no OSS |
| 4. Playback e revisão | 2 | média | superficial | `homekit/src/video-clips-provider.ts:39-70` | Clipes HKSV com filtro básico por tempo | Não | UI ausente do repo; escopo restrito a HKSV |
| 5. Multi-tenancy/RBAC | 2 | alta | parcial | `plugins/core/src/user.ts`; `server/src/plugin/acl.ts`; comentário do autor confirmando single-user | ACL real server-side, mas zero conceito de tenant/organização | Não | Senha fraca, sem 2FA/rate-limit, sem audit log |
| 6. Mobile | 0 | alta | completa | busca exaustiva = nenhum app próprio, delega a terceiros | Nenhum app mobile no repositório | N/A | — |
| 7. Operação | 2 | alta | parcial | `services/backup.ts:12-75`; `plugin-host.ts:290-325`; `logger.ts:42-62` | Backup/restore manual, auto-restart de plugin, logger só em memória | Não | Sem métricas, sem migrations |
| 8. Escalabilidade | 3 | média | parcial | `cluster/cluster-setup.ts:38-49,403-461`; `onnx/src/ort/__init__.py:132-157` | Cluster multi-host real, mas para UMA instalação | Não | Não é fleet multi-cliente |
| 9. Maturidade | 2 | alta | completa | `tsconfig.json` strict; `.github/workflows/test.yml`; zero testes reais | TS strict no core, mas CI não testa nem linta | Não | — |
| 10. White-label | 1 | alta | completa | `plugins/cloud/src/main.ts,push.ts`; `server-settings.ts` | Relay fixo à marca Scrypted, push Firebase único e fixo | Não | Sem branding, sem multi-instalação |

---

# ZoneMinder

**Caminho**: `/home/flashnet/Drac/concorrentes/zoneminder` | **Commit**: `c8d47e6f3` (2026-05-24) | **Branch**: `master` | Versão 1.39.10

## 1. Arquitetura

VMS monolítico clássico: C++ (`src/`, 58.8k LOC — `zmc` captura, `zma` análise, `zms` streaming, comunicação via shared memory zero-copy), PHP (`web/`, CakePHP 2.x, console + API REST com JWT), Perl (`scripts/` — `zmdc.pl` supervisor de processo, `zmwatch.pl` watchdog, `zmaudit.pl` reconciliação, `zmrecover.pl` recuperação, `zmupdate.pl` migrations), MySQL (schema com 60+ migrações incrementais desde 0.9.7).

## 2. Escopo

VMS completo, **single-install multi-usuário robusto**, mas **sem multi-tenancy** (busca exaustiva por `tenant|reseller|organization` = zero código real). RBAC granular por usuário/role/grupo/câmera checado no backend (`web/includes/auth.php:375-506`), mas dentro de uma única instalação. `Groups` é hierarquia de câmeras (pasta), não tenant. `Servers`/multi-servidor é clustering de uma mesma instalação, não gestão de múltiplos clientes.

## 3. Funcionalidades encontradas

RTSP nativo (`zm_remote_camera_rtsp.cpp`) + FFmpeg + ONVIF completo (gSOAP, 1839 linhas) + restream go2rtc/Janus (WebRTC) real, não cosmético; watchdog de heartbeat com restart automático (`zmwatch.pl.in:99-189`) + supervisor de processo separado (`zmdc.pl.in`, 919 linhas) — duas camadas de auto-cura; gravação por evento com pré/pós-buffer, mux/remux sem retranscode (`zm_videostore.cpp`, 1700 linhas), múltiplos storages com esquema de retenção; reconciliação disco↔BD e recuperação de gravações órfãs (`zmaudit.pl`, `zmrecover.pl`); detecção de movimento por zona com blob/pixel diff madura (`zm_zone.cpp`, 1194 linhas, 16 testes Catch2); automação de eventos (auto-archive/delete/upload/email/exec); timeline/montage/export no console; RBAC real backend-enforced; CSRF protection; CI real (build multi-distro, ESLint, CodeQL).

## 4. Funcionalidades ausentes

Multi-tenancy/white-label/revenda: zero. **Detecção de objetos/faces/IA: ausente do core** — a própria documentação confirma que é serviço Python externo opcional (`zmeventnotification`/`pyzm`), fora deste repositório. App mobile nativo: ausente — a doc remete a "zmNinja", projeto de terceiros em repositório separado. Push notification: tabela só armazena token, sem pipeline de envio real (sem FCM/APNs). Docker/orquestração oficial: só Dockerfile de CI. Rate limiting de login: ausente. Mascaramento de credenciais em log/API: ausente.

## 5. Maturidade

Alta para C++/PHP de 20+ anos: migração de schema disciplinada (60+ arquivos), CI multi-distro + CodeQL, testes C++ cobrindo lógica não trivial. Mas: **zero testes automatizados de PHP/API** (só framework CakePHP vendorizado testado), zonas críticas (auth, storage, event) sem cobertura de teste, testes de integração desligados em CI.

## 6. Principais arquivos

`src/zm_monitor.cpp`, `src/zm_videostore.cpp`, `src/zm_zone.cpp`, `src/zm_eventstream.cpp`, `src/zm_monitor_onvif.cpp`, `src/zm_monitor_go2rtc.cpp`, `scripts/zmdc.pl.in`, `scripts/zmwatch.pl.in`, `scripts/zmaudit.pl.in`, `db/zm_create.sql.in`, `web/includes/auth.php`.

## 7. Limitações

Não compilado/executado; 354k linhas de PHP não lidas linha a linha (amostragem dirigida); performance real de hwaccel não avaliada; app mobile/IA externos fora do escopo verificável.

## 8. Busca por implementações não óbvias (Passo D)

`role`/`permission`: RBAC real confirmado em cascata usuário→grupo→role→role-grupo, backend-enforced. `watchdog`: duas camadas confirmadas (supervisor + heartbeat). IA: confirmado ausente tanto por grep quanto pela própria documentação do projeto. Push: confirmado que "firebase" no código é só a lib JWT, não mensageria. Docker: confirmado que não há deploy containerizado oficial no repositório.

## 9. Tabela de notas preliminares

| Dimensão | Nota | Confiança | Cobertura | Evidência | Mecanismo | Testes? | Limitações |
|---|---|---|---|---|---|---|---|
| 1. Ingestão/streaming | 4 | alta | ampla | `zm_remote_camera_rtsp.cpp`; `zm_ffmpeg_camera.cpp:490-568`; `zm_monitor_onvif.cpp`; `zm_monitor_go2rtc.cpp:44-60`; `zmwatch.pl.in:99-189` | RTSP+FFmpeg+ONVIF+restream go2rtc/Janus; watchdog com restart automático; hwaccel de decode | 4 casos ONVIF | Latência não medida; credenciais sem mascaramento na API |
| 2. Gravação | 4 | alta | ampla | `zm_videostore.cpp` (1700 linhas); `zm_event.h:585-591`; `zmaudit.pl.in`; `zmrecover.pl.in` | Pré/pós-buffer, múltiplos storages/retenção, auditoria periódica, recuperação pós-crash, ENOSPC tratado (loga, não crasha) | Nenhum teste automatizado | Sem teste de corrupção |
| 3. Detecção e IA | 2 | alta | ampla | `zm_zone.cpp:197` (16 testes); ausência confirmada de ONNX/YOLO/OpenCV DNN; doc confirma IA como 3rd-party | Motion detection nativo maduro; sem objetos/faces no core | 16 testes | IA externa não avaliável (fora do repo) |
| 4. Playback e revisão | 4 | média-alta | ampla | `zm_eventstream.cpp` (1351 linhas); `timeline.php`, `montage.php`, `export.php` | Timeline, montage multi-câmera, exportação, filtros de evento | Nenhum | UX não testada em runtime |
| 5. Multi-tenancy/RBAC | 2 | alta | ampla | `zm_create.sql.in:421-514,893-948`; `auth.php:375-506`; 0 hits tenant/reseller | RBAC granular backend-enforced, mas zero multi-tenancy | Nenhum | Sem rate-limit login, sem mascaramento de credencial |
| 6. Mobile | 0 | alta | ampla | busca confirma ausência; doc remete a zmNinja (terceiros, repo separado) | Nenhum código de app neste repositório | N/A | — |
| 7. Operação | 4 | alta | ampla | `zmdc.pl.in`; `zmwatch.pl.in`; `zmaudit.pl.in`; `zmrecover.pl.in`; `zmdbbackup/restore.in` | Supervisor + watchdog + auditoria + recuperação + backup/restore de BD | Nenhum | Sem Docker oficial de produção |
| 8. Escalabilidade | 4 | média-alta | ampla | shared memory zero-copy (`zm_monitor.h`); `Servers` multi-servidor (`zm_create.sql.in:791-825`) | Captura+análise via shared memory; clustering horizontal de uma instalação | Nenhum | Overhead real não medido |
| 9. Maturidade | 3 | alta | ampla | CI multi-distro + CodeQL; 65 testes Catch2; 60+ migrations SQL | CI real, testes de lógica não trivial, disciplina de migração | Sim (C++ only) | Zero testes de PHP/API; áreas críticas sem cobertura |
| 10. White-label | 1 | alta | ampla | 0 hits tenant/reseller/white-label; skin único; `ZM_WEB_TITLE` global | Instalação self-hosted de um único operador | N/A | — |

---

# Shinobi CCTV

**Caminho**: `/home/flashnet/Drac/concorrentes/Shinobi` | **Commit**: `f5cb53d1` (2026-01-29) | **Branch**: `master`

## 1. Arquitetura

Node.js monolítico (`camera.js` orquestra ~50 módulos de `libs/`), um processo ffmpeg por câmera gerenciado por processo Node filho (`libs/cameraThread/singleCamera.js`), MySQL/PostgreSQL via Knex, worker threads para cron de retenção e conexão central, escala horizontal via "Child Node" (mestre/filho, WebSocket), túnel WebSocket para "Central Server" hospedado pela própria Shinobi Systems (fora deste repositório).

## 2. Escopo

VMS completo e maduro (produção há anos). **Multi-tenancy real, mas não com essa nomenclatura**: isolamento via coluna `ke` ("group key") por "conta administradora" — cada `ke` tem diretório próprio, cota de disco, câmeras, usuários, logs; gerenciável só por superusuário separado (não linha em `Users`); exclusão de conta apaga em cascata (incluindo disco) — evidência real de isolamento, não cosmético. Mais primitivo que uma solução com tabela `Organizations` formal; sem hierarquia revendedor→sub-revendedor→cliente; sem console central self-hospedado (o único "central" é o serviço pago da Shinobi Systems).

## 3. Funcionalidades encontradas

RTSP/HTTP/MJPEG/ONVIF completo; HLS, MJPEG, mp4-fragmentado via WS, FLV/RTMP; hwaccel CUDA/VAAPI/QSV/VideoToolbox/Jetson; watchdog real de stream (60s sem dados → restart) e de gravação, com parser de stderr reagindo a "no space"/erros específicos; sanitização de credenciais em log e resposta de API; gravação com segmentação/retenção configurável, purge por cota com fila serial, reconciliação arquivo↔BD na inicialização e periódica, corte/merge/arquivamento; upload em nuvem (S3/B2/GDrive/SFTP/WebDAV); detecção de movimento por zonas/máscaras/tile; tracking heurístico (consome detecções de plugin externo); RBAC no backend (filtragem por permissão nas próprias queries SQL); 7 canais de notificação; migrations reais versionadas; **branding por domínio real** (`getConfigWithBranding`, 15+ pontos de uso); backup/restore de sistema via API superusuário; escala horizontal real (Child Node).

## 4. Funcionalidades ausentes

App mobile: mencionado no README como produto pago separado, **nenhum código no repositório**. WebRTC: zero ocorrências. Detecção de objetos/IA/face real: zero implementação bundlada (SDK para plugins externos apenas). Auditoria administrativa formal: ausente (log por usuário é opt-in). Console central self-hospedado: não existe (só cliente do serviço pago). Testes automatizados de CI: ausentes (`.gitlab-ci.yml` só builda Docker).

## 5. Maturidade

Funcional em produção há anos, tratamento de erro extenso em pontos críticos, migrations versionadas, suíte de testes de integração HTTP real (`test/run.js`, 661 linhas). Mas: sem framework de teste unitário/CI de testes/lint; um arquivo de checagem de licença **fortemente ofuscado** (`libs/checker/actCheck.js`); licenciamento é EULA proprietário, não OSI-permissivo, com registro obrigatório de revendedor.

## 6. Principais arquivos

`camera.js`, `libs/ffmpeg.js`, `libs/ffmpeg/builders.js`, `libs/monitor/utils.js`, `libs/webServerSuperPaths.js`, `libs/auth.js`, `libs/user.js`, `libs/cron/worker.js`, `libs/video/utils.js`, `libs/childNode.js`, `libs/connectToManagementServer/`, `sql/postgresql/framework.sql`.

## 7. Limitações

Não executado; `actCheck.js` ofuscado não foi decodificado por completo; possível fragilidade de autorização identificada em um endpoint específico (`webServerPaths.js:165-183`) **não confirmada como exploração real** (sem PoC); ecossistema de plugins de IA de terceiros não disponível para análise; portal de licenças pago não acessível.

## 8. Busca por implementações não óbvias (Passo D)

`tenant`: zero, mas mecanismo `ke` encontrado por via alternativa (schema + `webServerSuperPaths.js`). `role`: RBAC via `permissionSet`/`allmonitors` aplicado no backend, confirmado lendo função completa. `watchdog`: confirmado em `monitor/utils.js` mesmo sem classe nomeada "Watchdog". `audit`: confirmado parcial (log de ações sensíveis existe, mas não é módulo dedicado). IA/YOLO/OpenCV: confirmado ausente por grep amplo em todo o repo, cross-checado com scripts de instalação de terceiros. "central": confirmado que é cliente de serviço pago, não hub self-hosted.

## 9. Tabela de notas preliminares

| Dimensão | Nota | Confiança | Cobertura | Evidência | Mecanismo | Testes? | Limitações |
|---|---|---|---|---|---|---|---|
| 1. Ingestão/streaming | 3 | alta | ampla | `ffmpeg.js:27-136`; `ffmpeg/builders.js:19,168-370`; `monitor/utils.js:1030-1048,1422-1480`; `control/onvif.js` | ffmpeg por câmera com watchdog de stream (60s), hwaccel multi-vendor, ONVIF completo, sem WebRTC | Indireto (`test/run.js`) | Sem backoff exponencial (delay fixo) |
| 2. Gravação | 3 | alta | ampla | `video/utils.js:22-164,319-786`; `cron/worker.js:256-360`; `startup.js:110-141` | Retenção configurável, purge com fila serial, reconciliação DB↔disco, slice/merge/archive | Parcial (hook de debug, não teste real) | Sem checksum; sem teste de disco cheio real |
| 3. Detecção e IA | 2 | alta | parcial | `cameraThread/detector.js`; `events/tracking.js` (412 linhas); ausência confirmada de OpenCV/YOLO | Movimento nativo robusto; tracking depende de plugin externo | Nenhum | Sem reconhecimento facial nativo |
| 4. Playback e revisão | 3 | média | moderada | `webServerPaths.js` (listagem/pics); `video/utils.js:593-786` | Listagem com foto, download individual, corte/merge | Parcial | Sem exportação em lote/ZIP |
| 5. Multi-tenancy/RBAC | 3 | alta | ampla | `framework.sql:6-167` (coluna `ke`); `webServerSuperPaths.js:270-498`; `monitor.js:819-962` | Isolamento por `ke` com cascata de exclusão; RBAC nas queries SQL | Parcial (`test/run.js:191-380`) | Fragilidade de autorização não confirmada (ver limitações); sem hierarquia formal de tenant |
| 6. Mobile | 0 | alta | — | README menciona app pago; busca no repo = zero | Nenhum código de app neste repositório | N/A | App real não avaliável (fora do repo) |
| 7. Operação | 3 | alta | ampla | `health.js:1-146`; `database/preQueries.js:214-219`; `webServerSuperPaths.js:63-174`; 7 canais de notificação | CPU/RAM via socket, migrations automáticas, backup/restore via API, notificações | Não | Sem métricas tipo Prometheus |
| 8. Escalabilidade | 3 | média-alta | moderada | `childNode.js:1-163`; `user.js:36-72`; `monitor/utils.js:1553-1556` | Master/filho real com reconexão automática, filas para evitar picos | Nenhum | Sem orquestração automática |
| 9. Maturidade | 2 | alta | ampla | `.gitlab-ci.yml` (só build); sem devDependencies/lint; `actCheck.js` ofuscado | Sem CI de testes/análise estática; licenciamento ofuscado dificulta auditoria | `test/run.js` fora de CI | — |
| 10. White-label | 2 | alta | moderada | `branding.js:29-35` (15+ usos); `LICENSE.md:96-99,44-56`; `connectToManagementServer` | Branding por domínio real mas manual; revenda exige registro/possível pagamento à Shinobi Systems | Nenhum | Modelo de negócio acopla o revendedor ao fornecedor original |

---

# Bluecherry NVR

**Caminho**: `/home/flashnet/Drac/concorrentes/bluecherry-apps` | **Commit**: `13970c1b` (2025-12-29) | **Branch**: `master`

## 1. Arquitetura

Dois processos independentes compartilhando MySQL: `bc-server` (C++14, pthread por câmera, servidor HLS próprio via epoll — `server/hls.cpp`, 2088 linhas —, servidor RTSP próprio, status via socket Unix) e `www/` (PHP puro sem framework, MVC caseiro). Comunicação entre os dois é quase inteiramente via banco compartilhado. Placas de captura proprietárias (Solo6x10/TW5864) via V4L2/DKMS existem à parte do pipeline RTSP/IP genérico.

## 2. Escopo

VMS completo, mas **DNA histórico de hardware proprietário**; suporte a câmeras IP/RTSP genéricas foi adicionado por cima e é funcionalmente maduro. PTZ real em C++ só para Pelco-D/P serial — PTZ via ONVIF/IP é delegado a um binário externo (`onvif_tool`) sem código-fonte no repositório.

## 3. Funcionalidades encontradas

RTSP genérico via libav com fallback TCP/UDP; autenticação embutida na URL; servidor HLS próprio; substream (perfil live secundário nunca gravado); VAAPI real (decode/encode/scale); reconexão automática (delay fixo, sem backoff); reaper de threads mortas (isolamento de falha por câmera); gravação contínua e por movimento decidida por agenda; pré/pós-buffer alinhado a keyframe; segmentação por tempo; retenção por % de disco + idade máxima (FIFO, sem cota por câmera); auto-sync banco↔disco na inicialização; pool de conexões MySQL real; detecção de movimento com 3 algoritmos (diff clássico, OpenCV básico, OpenCV multiframe) e filtros de falso positivo; **backend enforça permissão por câmera em endpoints de live** (mas não em gravação — ver achado crítico); tokens de curta duração para RTSP/HLS; webhooks configuráveis; watchdog de container Docker; backup automático do banco antes de upgrade.

## 4. Funcionalidades ausentes / achados críticos

WebRTC/go2rtc/MediaMTX: zero. Detecção de objetos/faces/IA: zero (motion detection clássico apenas, análise 100% CPU). Watermarker: código completo existe mas está **morto** (flag de build nunca definida). Multi-tenancy: zero (24 tabelas flat, nenhuma `tenant/organization`). White-label: nome/logo **hardcoded** em constante PHP. App mobile: nenhum código no repositório (só um JSON com URL de endpoint externo). Testes automatizados: nenhum diretório de teste real. **CI não compila o código do repositório** — baixa um `.deb` pré-compilado de URL externa. **Achado de segurança confirmado (não hipotético)**: `mediaRequest.php`/`mediaStreamMp4.php`/`playback.php` (download/stream de gravação) **não checam permissão por câmera** — IDOR real, qualquer usuário autenticado baixa gravação de qualquer câmera por ID. Senha de usuário: MD5+salt de 4 caracteres. Senha de câmera em texto puro vazada em log nível Error, XML de status, HTML de edição.

## 5. Maturidade

15 anos de histórico (3726 commits), mas leitura revela camadas de remendos reativos: comentários `"CRITICAL FIX"`/`"SAFE ACCESS"` espalhados, documentos internos confirmam bugs de produção corrigidos (dessincronia disco↔banco, exaustão de conexão MySQL), `Makefile` morto referenciando arquivos inexistentes, bug real de `switch` sem `break` desabilitando checagem de acesso fino silenciosamente, código morto adicional (`CleanupRetryManager` não conectado).

## 6. Principais arquivos

`server/bc-thread.cpp`, `server/hls.cpp`, `server/bc-cleaner.cpp`, `server/motion_processor.cpp`, `server/bc-server.cpp`, `lib/lavf_device.cpp`, `lib/bc-db-mysql.cpp`, `www/lib/lib.php`, `www/ajax/media/{mediaRequest,mediaStreamMp4}.php`, `misc/sql/schema_mysql.sql`.

## 7. Limitações

Não compilado/executado; `onvif_tool` é binário externo não auditável; app mobile mencionado no config JSON está fora do repositório; SQL injection potencial (concatenação de string) reportado como padrão de código, não confirmado por PoC.

## 8. Tabela de notas preliminares

Nota ponderada aproximada calculada pelo próprio agente: ≈2,0/5. Ver §9 do dossiê original para a busca por implementações não óbvias (que confirmou, e não enfraqueceu, as ausências identificadas — incluindo verificação cuidadosa que separou RBAC real de live de sua ausência em gravação, evitando tanto nota 0 injusta quanto nota alta injustificada).

| Dimensão | Nota | Confiança | Cobertura | Evidência | Mecanismo | Testes? | Limitações |
|---|---|---|---|---|---|---|---|
| 1. Ingestão/streaming | 3 | alta | ampla | `lavf_device.cpp:146-188,162-163`; `hls.cpp:1516-1550`; `vaapi.cpp:22-35`; `bc-thread.cpp:637-638` | RTSP/MJPEG genérico, HLS próprio, VAAPI real, reconexão por sleep fixo | Não | Credencial em texto puro vaza em log Error; sem WebRTC |
| 2. Gravação | 3 | alta | ampla | `motion_handler.cpp:55,151`; `recorder.cpp:67-70`; `bc-cleaner.cpp:1365-1476,604-644` | Pré/pós-buffer, segmentação, retenção por %+idade, auto-sync | Não | Sem multi-qualidade gravada; sem reparo de MP4 truncado |
| 3. Detecção e IA | 2 | alta | ampla | `motion_processor.cpp:499-822,537-538` | 3 algoritmos de motion, grade de sensibilidade, filtros | Não | Zero objetos/faces/tracking real |
| 4. Playback e revisão | 2 | alta | ampla | `playback.php:30-42`; schema `EventComments/Tags` | Lista de eventos, comentários/tags, download bruto/remux | Não | **Download sem checagem de permissão por câmera (IDOR confirmado)** |
| 5. Multi-tenancy/RBAC | 1 | alta | ampla | schema 24 tabelas sem tenant; `lib.php:508-510`; `mediaRequest.php:41-56` | RBAC só em endpoints de live; **IDOR confirmado em gravação** | Não | Falha de autorização real, não hipotética |
| 6. Mobile | 0 | alta | ampla (no repo) | `mobile-app-config.json` só tem URL externa | Nenhum código de app | N/A | App comercial externo não avaliável |
| 7. Operação | 3 | alta | ampla | `entrypoint.sh`; `Dockerfile` HEALTHCHECK; `bc-database-upgrade.sh` | Watchdog de container, backup automático pré-upgrade | Não | CI não compila o código real do repo |
| 8. Escalabilidade | 3 | alta | ampla | `bc-server.cpp:487-509`; `bc-db-mysql.cpp:47-139`; `vaapi.cpp` | Thread isolada por câmera, pool MySQL, VAAPI | Não | Sem distribuição multi-host |
| 9. Maturidade | 2 | alta | ampla | zero testes; `Makefile` morto; CI não compila; `cameraaccess.php` quebrado | 15 anos de histórico, mas sem cobertura de teste e com código morto/quebrado | Não | — |
| 10. White-label | 0 | alta | ampla | `lang.php:21`; `main_admin.php:71`; `subdomainprovider.php:16-51` | Nome/logo fixos; DDNS de uma instalação, não revenda | N/A | — |

---

# Moonfire NVR

**Caminho**: `/home/flashnet/Drac/concorrentes/moonfire-nvr` | **Commit**: `60fd870` (2026-03-28) | **Branch**: `master`

## 1. Arquitetura

Binário único Rust (workspace de 3 crates): `server/src/` (CLI, HTTP, ingestão RTSP via crate `retina`, geração de MP4 sob demanda), `server/db/` (SQLite, escrita em disco, auth, migrations), `server/base/` (utilitários). UI React/MUI consumindo API JSON. Processo único, sem microsserviços, sem FFmpeg (decodificação/remux zero-copy nativo em Rust).

## 2. Escopo

**NVR de gravação eficiente + live view básico, por design** — não um VMS completo. Confirmado por código, não só pelo README: sem detecção de movimento embutida (tabela `signal` é barramento para receber estados **externos**, não calcular); sem IA/objetos/faces; ONVIF é só campo de config, nunca despachado como request real; sem multi-tenancy; sem mobile app.

## 3. Funcionalidades encontradas

Ingestão RTSP via crate `retina` com credenciais nunca embutidas na URL (checagem explícita rejeitando); **gravação contínua zero-copy** (bytes H.264 direto pro arquivo, sem decode/reencode); rotação por tempo fixo; fsync disciplinado com **política de abortar o processo inteiro** se fsync de diretório falhar (doutrina documentada "fsyncgate 2018" do Postgres); recuperação de gravações "atrasadas" sem travar o pipeline (testada); sincronização arquivo↔banco via tabela `open` com UUID; verificação de integridade offline (`moonfire-nvr check` com reparo opcional); retenção por cota de bytes com exclusão automática; live view via WebSocket fMP4 com keepalive; retry fixo de 1s (sem backoff exponencial); shutdown coordenado testado sob concorrência; auth por sessão com scrypta + cookies seguros + CSRF; **RBAC real backend-enforced, mas global (4 flags booleanas), sem granularidade por câmera**; migrations testadas v0→v7; CI real (3 toolchains Rust + fmt, 4 versões Node, release multi-arch).

## 4. Funcionalidades ausentes

Motion detection/IA: zero código (só recebe sinais externos). ONVIF real: campo armazenado, nunca despachado. Scrub bar visual: ausente (confirmado pelo próprio README e pela UI). HTTPS nativo: ausente, requer proxy externo. Multi-tenancy/organizações/papéis por câmera: zero. Mobile app: zero. Exportação em lote/thumbnails/health endpoint dedicado: ausentes.

## 5. Maturidade

Alta para o escopo assumido: tipos fortes e erros idiomáticos Rust, testes cobrindo casos de corrida real (não só happy path), decisões documentadas com justificativa técnica, schema com `check` constraints, migrations testadas v0-v7, CI multiplataforma real. Limitação: retry fixo (não backoff exponencial); projeto declaradamente pre-1.0 sem garantia de compatibilidade.

## 6. Principais arquivos

`server/src/streamer.rs`, `server/db/dir/writer.rs`, `server/db/auth.rs`, `server/src/web/{mod,live,users}.rs`, `server/db/schema.sql`+`upgrade/*.rs`, `server/db/lifecycle.rs`, `server/db/check.rs`, `server/src/mp4.rs`.

## 7. Limitações

Não executado; números do README (10% CPU em RPi2 com 6 câmeras) não verificados; ~29.000 linhas de Rust não lidas 100%; segurança avaliada superficialmente.

## 8. Busca por implementações não óbvias (Passo D)

Tabela `signal` confirmada como barramento de eventos externos, não análise própria — distinção feita corretamente antes de zerar a dimensão de IA. ONVIF confirmado negativamente via ausência de crate no `Cargo.lock` e uso do campo só para armazenamento. RBAC por câmera: confirmado ausente via ausência de tabela de associação usuário↔câmera no schema. Exportação: confirmado que é só range HTTP, não endpoint dedicado com lote.

## 9. Tabela de notas preliminares

| Dimensão | Nota | Confiança | Cobertura | Evidência | Mecanismo | Testes? | Limitações |
|---|---|---|---|---|---|---|---|
| 1. Ingestão/streaming | 3 | alta | ampla | `streamer.rs:44-158`; `web/live.rs:21-138` | RTSP via `retina`, live por WS fMP4, sem HLS/WebRTC, retry fixo 1s | Sim (`basic`) | Sem backoff exponencial; sem H.265 mencionado |
| 2. Gravação | 4 | alta | ampla | `dir/writer.rs:88-450`; `schema.sql:34-263`; `lifecycle.rs:290-360` | Escrita zero-copy vetorizada, fsync com abort de processo, sync via tabela `open`/UUID, retenção por bytes | Sim, múltiplos (`abandon_behind`, `two_streams_shutdown`) | Retenção só por bytes, não por dias; sem tratamento proativo de ENOSPC |
| 3. Detecção e IA | 0 | alta | ampla | ausência confirmada; `db/json.rs:135,263-276` (`signal` = estado recebido, não calculado) | Nenhuma análise de vídeo interna | N/A | Escopo deliberado, não falha |
| 4. Playback e revisão | 2 | alta | ampla | `ui/src/List/VideoList.tsx`; `server/src/mp4.rs` | Lista de segmentos com trimming por tempo; sem scrub bar/thumbnails | Sim (`combine()`) | Sem exportação em lote |
| 5. Multi-tenancy/RBAC | 1 | alta | ampla | `schema.proto:66-71`; `web/mod.rs:406-415`; `web/users.rs:37-60` | RBAC real backend, mas global (4 flags), sem tabela usuário↔câmera | Sim (`auth.rs:1281-1308`) | Incompatível com isolamento por cliente sem reescrita |
| 6. Mobile | 0 | alta | ampla | busca exaustiva = só menção aspiracional no README | Nenhum código de app | N/A | — |
| 7. Operação | 3 | média-alta | ampla | `db/check.rs:1-50`; `base/tracing_setup.rs`; CI multi-toolchain | Logging estruturado, ferramenta de integridade, shutdown testado, migrations versionadas | Sim, indireto | Sem health/metrics HTTP; sem alerta externo |
| 8. Escalabilidade | 4 | alta | ampla | `dir/writer.rs:20,180-207`; streams isolados por câmera (tokio) | Escrita zero-copy vetorizada, workers de I/O em pool, isolamento por câmera | Sim (concorrência testada) | Só single-host |
| 9. Maturidade | 4 | alta | ampla | 105 testes Rust; CI 3 toolchains+fmt+4 Node; migrations v0-v7 testadas | Tipagem forte, erro idiomático, CI abrangente, decisões documentadas | Sim, extenso | Pre-1.0, bus factor não avaliável |
| 10. White-label | 0 | alta | ampla | 0 hits tenant/reseller/white-label | Nenhum mecanismo de branding/multi-instalação | N/A | — |

---

# Viseron

**Caminho**: `/home/flashnet/Drac/concorrentes/viseron` | **Commit**: `bdd047a2` (2026-05-20) | **Branch**: `dev`

## 1. Arquitetura

Processo Python único por instalação (components + domains), supervisionado por s6-overlay em container junto com PostgreSQL, nginx e go2rtc (processos irmãos). `components/` (25 diretórios: ffmpeg/gstreamer/go2rtc, storage, darknet/yolo/edgetpu/hailo/dlib/compreface/deepstack/mog2, webserver, mqtt/telegram/discord/gotify/webhook). `domains/` define contratos abstratos. Barramento pub/sub interno (`data_stream`). Cada câmera roda em processo OS separado para captura; motores de IA pesados compartilhados entre câmeras em subprocesso próprio. Frontend React/MUI (Vite) via REST+WebSocket. PostgreSQL via SQLAlchemy 2.0 + Alembic (20 migrations). Watchdogs internos (`ThreadWatchDog`, `ProcessWatchDog`, `SubprocessWatchDog`, polling 15s).

## 2. Escopo

VMS completo, mas **single-tenant por construção**: onboarding cria um único admin fundador e se autobloqueia após o primeiro uso; zero ocorrências de `tenant/organization/reseller`. RBAC (Admin/Read/Write + permissão por câmera) é real e **backend-enforced** (confirmado, não é só ocultação de menu no React), mas é RBAC intra-instalação, não isolamento entre clientes de um provedor.

## 3. Funcionalidades encontradas

Captura RTSP/RTMP/MJPEG via ffmpeg (remux por padrão) + GStreamer alternativo + go2rtc para WebRTC/relay; watchdogs de processo/thread/subprocess com restart automático e limpeza de zumbis no boot; redação de credenciais em log; gravação contínua+evento coexistentes por tier, pré-buffer(lookback)/pós-buffer(idle timeout) configuráveis, segmentação fMP4 5s, retenção hierárquica por tier, recuperação de gravações "penduradas" após crash, reconciliação disco↔banco via 11 jobs cron; exportação de clipe via concat ffmpeg com token; motion (MOG2) e object detection real multi-engine (Darknet/YOLO/EdgeTPU/Hailo/DeepStack/CodeProjectAI) — funcional, não stub; reconhecimento facial (dlib/CompreFace/DeepStack/CodeProjectAI) e de placas (CodeProjectAI); zonas/máscaras com **editor visual real no frontend**; aceleração de hardware detectada de fato via subprocess no boot; **timeline multi-câmera e playback sincronizado entre câmeras com correção de drift <0.5s** (achado de maturidade de UI mais forte do dossiê); RBAC real testado (REST+WebSocket+PAT); links públicos efêmeros de imagem com token e expiração; 5 integrações de alerta funcionais; migrations Alembic testadas (20 versões); build Docker multi-arquitetura real (5 arquiteturas, 46 serviços); CI bloqueante (mypy/pylint/flake8).

## 4. Funcionalidades ausentes

Multi-tenancy/white-label/revenda: zero. App mobile nativo: zero (só PWA genérica sem service worker/push nativo). Branding runtime: logo é import estático de SVG em 4+ arquivos; "tema" é só dark/light do MUI. Gestão central/provisionamento remoto/licenciamento: ausentes. Auditoria administrativa: ausente (só logs de debug não estruturados). Verificação de integridade/checksum de vídeo: ausente. Checagem proativa de disco: ausente (só reativa a ENOSPC já ocorrido). Health check HTTP/métricas Prometheus: ausentes. Backup/restore: ausente no código (responsabilidade do operador via volumes). Tracking de objetos entre frames: campo existe na struct C do Darknet mas nunca é lido pelo Python.

## 5. Maturidade

Alta em disciplina de processo: CI real bloqueante, Alembic maduro e testado, exceções customizadas usadas consistentemente, tipagem extensiva, 40 dependências pinadas exatamente, usuário não-root no container, bcrypt+JWT com rate limiting em login/onboarding. Desigual em cobertura: `watchdog/` (724 linhas, mecanismo central) sem nenhum teste; ffmpeg/GStreamer sem testes; 4 componentes de alerta sem testes; `ruff` configurado mas não bloqueia ainda; testes de IA são 100% mockados (nenhum teste de inferência real).

## 6. Principais arquivos

`viseron/components/ffmpeg/{camera,stream,recorder}.py`, `viseron/components/storage/{tier_handler,check_tier,jobs}.py`, `viseron/domains/camera/{recorder,fragmenter}.py`, `viseron/components/webserver/{auth,request_handler}.py`, `viseron/watchdog/*.py`, `frontend/src/components/events/SyncManager.tsx`.

## 7. Limitações

100% estático; latência/CPU/throughput real não medidos; `docs/` deliberadamente excluído; análise paralelizada em 5 sub-investigações, pode ter perdido trechos muito indiretos; testes de frontend não lidos linha a linha.

## 8. Busca por implementações não óbvias (Passo D)

RBAC frontend↔backend verificado a fundo: menu escondido no React E rotas reais protegidas no servidor Tornado, testado — não foi zerado. Branding: confirmado ausência real após busca dedicada (não é lacuna de busca). Tracking: campo `track_id` confirmado nunca lido. Auditoria: confirmado ausência real de trilha estruturada (só debug log). App mobile: busca por artefatos nativos em todo o repo, não só frontend/, confirma ausência real (não PWA disfarçada). Multi-tenant: busca por padrões estruturais alternativos (`org_id`, `account_id`) sem sucesso.

## 9. Tabela de notas preliminares

| Dimensão | Nota | Confiança | Cobertura | Evidência | Mecanismo | Testes? | Limitações |
|---|---|---|---|---|---|---|---|
| 1. Ingestão/streaming | 4 | alta | ampla | `ffmpeg/stream.py:498-548,591-624`; `watchdog/subprocess_watchdog.py:23-158`; `helpers/logs.py:65-101` | Remux padrão, watchdog com grace period e restart automático, redação de credenciais | Parcial (`test_stream.py`, mas ffmpeg/camera.py e GStreamer sem testes) | go2rtc não supervisionado por watchdog Python |
| 2. Gravação | 4 | alta | ampla | `storage/tier_handler.py:536-539,717-739`; `check_tier.py:426-476`; `jobs.py:838-902` | Tiers coexistentes, lookback/idle configuráveis, retenção hierárquica, 11 jobs de reconciliação | Sim, forte | Sem checksum; sem checagem proativa de disco; move não atômico |
| 3. Detecção e IA | 4 | alta | ampla | `mog2/motion_detector.py:34-68`; `darknet/__init__.py:235-503`; `object_detector/zone.py:31-153` | Motion+objetos multi-engine funcionais reais, zonas com editor visual, hwaccel detectado de fato | Parcial (mockado, sem teste de inferência real) | Sem tracking real entre frames |
| 4. Playback e revisão | 4 | alta | ampla | `events/SyncManager.tsx:20-319`; `timeline/*.tsx`; `fragmenter.py:554-601` | Timeline multi-câmera, playback sincronizado com correção de drift, exportação server-side | Não auditado a fundo | Sem fila de "investigações"/evento protegido |
| 5. Multi-tenancy/RBAC | 2 | alta | ampla | `webserver/api/handlers.py:328-364`; `onboarding.py:37-46`; `auth.py:168-215` | RBAC real backend, mas single-tenant por construção; senha de câmera em texto puro no `/config` admin-only | Sim para RBAC | RBAC maduro não supre ausência de multi-tenancy |
| 6. Mobile | 0 | alta | ampla | busca exaustiva de artefatos nativos = zero; só PWA genérica | Nenhum app mobile | N/A | — |
| 7. Operação | 3 | alta | ampla | `watchdog/*.py`; `helpers/logs.py:37-101`; 5 componentes de alerta funcionais | Watchdogs reais com auto-restart, logs com redação, alertas funcionais | Nenhum teste do watchdog (724 linhas) | Sem health HTTP/métricas; sem backup/restore no código |
| 8. Escalabilidade | 3 | alta | ampla | `ffmpeg/camera.py:350-391`; `helpers/__init__.py:440-455`; `ThreadPoolExecutor(max_workers=100)` | Processo isolado por câmera, backpressure via descarte de frame antigo | Nenhum teste de carga | Single-node por instalação |
| 9. Maturidade | 4 | alta | ampla | CI bloqueante; 20 migrations Alembic testadas; 40 deps pinadas | CI real, migrations maduras, tipagem extensiva | 38 arquivos de teste, mas 15/24 componentes sem nenhum | Cobertura desigual (lógica bem testada, infra fraca) |
| 10. White-label | 0 | alta | ampla | logo hardcoded em 4+ arquivos; só dark/light no MUI | Branding 100% build-time (fork+recompilação) | N/A | — |
