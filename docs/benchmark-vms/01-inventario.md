# 01 — Inventário Reproduzível

**Comandos de verificação** (reprodutíveis): `git -C <caminho> rev-parse --short HEAD`, `git -C <caminho> rev-parse --abbrev-ref HEAD`, `git -C <caminho> log -1 --format=%cd --date=short`. Executados em 2026-07-28 para os 8 sistemas presentes; todos os commits/branches abaixo foram confirmados por esses comandos nesta data (não apenas herdados de análise anterior).

## 1. DRAC

| Campo | Valor |
|-------|-------|
| **Nome** | DRAC (Sistema de monitoramento multi-tenant white-label) |
| **Caminho** | `/home/flashnet/Drac` |
| **Commit atual** | `f4fec41` (verificado via `git rev-parse --short HEAD` em 2026-07-28) |
| **Branch** | `fix/auditoria-completa` |
| **Linguagens principais** | TypeScript (NestJS API + Vite web), React Native/Expo (mobile), Python (AI service), Go (camera-worker legado) |
| **Tipo de sistema** | VMS completo: API backend, web frontend, app mobile, AI service, infra Docker |
| **Entrypoints ativos** | `apps/api/src/main.ts`, `apps/web/src/main.tsx`, `apps/mobile/App.tsx`, `services/ai-service-python/main.py` |
| **Diretórios ativos** | `apps/api/src/`, `apps/web/src/`, `apps/mobile/src/`, `apps/central/`, `services/ai-service-python/`, `services/camera-worker-go/`, `infra/` |
| **Diretórios excluídos** | `archive/`, `legacy/`, `novo-design/`, `novo-mockup-app-drac/`, `Drac-app-redesign/`, `node_modules/`, `dist/` |
| **Testes** | 70 arquivos `.ts` em `apps/api/tests/` (NestJS/Jest, diretório separado de `src/`, verificado via `find`), 17 arquivos `test_*.py` em `services/ai-service-python/` (verificado via `find`) |
| **CI** | `.github/workflows/ci.yml` (único workflow) |
| **Migrations** | 40 migrations Prisma (PostgreSQL) em `apps/api/prisma/migrations/`, de 2026-05-01 a 2026-07-28 (a mais recente, `harden_camera_ownership_permissions`, é do dia da análise) |
| **Aplicação web** | `apps/web/src/pages/` — 25 páginas (Playback, LiveView, Cameras, Alarms, Investigations, etc.) |
| **Aplicação mobile** | `apps/mobile/` — Expo React Native com biometria, push, clips, revisão |
| **Limitações** | Análise estática apenas; 1 branch fix em progresso; app-builder proxy depende de agente externo não inspecionado |

---

## 2. Frigate

| Campo | Valor |
|-------|-------|
| **Nome** | Frigate NVR |
| **Caminho** | `/home/flashnet/Drac/concorrentes/frigate` |
| **Commit atual** | `39a3667f` |
| **Branch** | `dev` |
| **Linguagens principais** | Python (backend), TypeScript/React (web frontend) |
| **Tipo de sistema** | VMS completo: backend Python multiprocesso, web frontend React, sem mobile nativo |
| **Entrypoints ativos** | `frigate/__main__.py`, `frigate/app.py`, `web/` (Vite React) |
| **Diretórios ativos** | `frigate/`, `web/src/`, `migrations/`, `config/` |
| **Diretórios excluídos** | `notebooks/`, `testing-scripts/`, `docs/` |
| **Testes** | 46 arquivos Python em `frigate/test/` |
| **CI** | `.github/workflows/ci.yml` — build multi-arch Docker (amd64, arm64, Jetson), testes Python |
| **Migrations** | 35 migrations Python (peewee) SQLite |
| **Aplicação web** | `web/src/pages/` — Events, Replay, Explore, System, Exports, Settings, FaceLibrary, Chat |
| **Aplicação mobile** | Nenhuma encontrada no repositório |
| **Limitações** | Sem mobile nativo; modelo de usuário simples (admin/viewer/roles por câmera sem multi-tenant); foco em single-install |

---

## 3. Scrypted

| Campo | Valor |
|-------|-------|
| **Nome** | Scrypted |
| **Caminho** | `/home/flashnet/Drac/concorrentes/scrypted` |
| **Commit atual** | `1545790cd` |
| **Branch** | `main` |
| **Linguagens principais** | TypeScript (Node.js) |
| **Tipo de sistema** | Plataforma de automação/integração de câmeras (plugin-based), não VMS puro |
| **Entrypoints ativos** | `server/`, `plugins/` (cada plugin é independente) |
| **Diretórios ativos** | `server/src/`, `plugins/`, `packages/`, `common/`, `sdk/` |
| **Diretórios excluídos** | `install/`, `sites/`, `external/` |
| **Testes** | Zero arquivos de teste real no repositório (2 scripts em `server/test`/`plugins/*/test` existem mas são ad-hoc sem asserção, 2 deles comprovadamente quebrados por dependência ausente — achado do dossiê profundo) |
| **CI** | `.github/workflows/test.yml` presente, mas só faz smoke-install (ação `setup-scrypted`); sem lint configurado no repo (nenhum `.eslintrc*`) |
| **Migrations** | Nenhuma migration de banco identificada (armazenamento por plugin) |
| **Aplicação web** | Interface web integrada ao servidor Scrypted; código não inspecionado a fundo |
| **Aplicação mobile** | Referenciada como app HomeKit/cloud, não encontrada neste repositório |
| **Limitações** | Escopo é plataforma de integração, não VMS comercial. Sem multi-tenancy, sem gravação centralizada gerenciada, sem RBAC empresarial. Adequação ao modelo comercial DRAC é baixa. |

---

## 4. ZoneMinder

| Campo | Valor |
|-------|-------|
| **Nome** | ZoneMinder |
| **Caminho** | `/home/flashnet/Drac/concorrentes/zoneminder` |
| **Commit atual** | `c8d47e6f3` |
| **Branch** | `master` |
| **Linguagens principais** | C++ (core), Perl (scripts), PHP (web), JavaScript (frontend legado) |
| **Tipo de sistema** | VMS completo maduro, arquitetura monolítica |
| **Entrypoints ativos** | `src/` (C++), `web/` (PHP+JS), `scripts/` (Perl) |
| **Diretórios ativos** | `src/`, `web/`, `scripts/`, `db/`, `conf.d/` |
| **Diretórios excluídos** | `docs/`, `misc/` |
| **Testes** | `tests/` — 65 casos de teste Catch2 (C++), cobrindo zonas/utils/comms/crypto/geometria; **zero testes automatizados de PHP/API** (a única suíte de teste PHP encontrada pertence ao framework CakePHP vendorizado) |
| **CI** | `.github/` com workflows Docker e CodeQL |
| **Migrations** | `db/` com schemas SQL tradicionais |
| **Aplicação web** | `web/` — PHP+JS monolítica, sem SPA moderna |
| **Aplicação mobile** | Nenhuma encontrada no repositório |
| **Limitações** | Arquitetura C++/PHP envelhecida; sem mobile nativo; multi-tenancy básico sem isolamento comercial; sem white-label verificada |

---

## 5. Shinobi

| Campo | Valor |
|-------|-------|
| **Nome** | Shinobi CCTV |
| **Caminho** | `/home/flashnet/Drac/concorrentes/Shinobi` |
| **Commit atual** | `f5cb53d1` |
| **Branch** | `master` |
| **Linguagens principais** | JavaScript (Node.js), MySQL/SQLite |
| **Tipo de sistema** | VMS completo com multi-tenant (superusuário + contas de grupo) |
| **Entrypoints ativos** | `camera.js` (entrypoint principal), `libs/` |
| **Diretórios ativos** | `libs/`, `plugins/`, `web/`, `sql/` |
| **Diretórios excluídos** | nenhum diretório de build identificado |
| **Testes** | `test/run.js` (661 linhas) — suíte de integração HTTP real cobrindo CRUD de superusuário/conta/câmera, mas não executada em CI |
| **CI** | `.gitlab-ci.yml` presente, mas só constrói/publica imagens Docker — nenhum estágio de teste |
| **Migrations** | `libs/database/preQueries.js` aplica scripts datados automaticamente na subida (`2022-08-22.js` … `2025-09-08.js`); schema base em `sql/` |
| **Aplicação web** | `web/` — templates EJS + JS, sem SPA moderna |
| **Aplicação mobile** | App mobile pago mencionado no README, nenhum código no repositório (binário distribuído separadamente) |
| **Licença** | EULA proprietário (`LICENSE.md`/`COPYING.md`), não permissiva — relevante para `07-recomendacoes.md` |
| **Limitações** | Código Node.js monolítico sem tipagem; sem CI de testes; branding por domínio é real e funcional (`libs/branding.js`) mas revenda depende comercialmente da Shinobi Systems (registro, mobile/central pagos); um arquivo de checagem de licença ofuscado |

---

## 6. Bluecherry

| Campo | Valor |
|-------|-------|
| **Nome** | Bluecherry NVR |
| **Caminho** | `/home/flashnet/Drac/concorrentes/bluecherry-apps` |
| **Commit atual** | `13970c1b` |
| **Branch** | `master` |
| **Linguagens principais** | C++ (servidor), PHP (web), C (utilitários) |
| **Tipo de sistema** | VMS profissional com suporte a hardware dedicado (placas de captura SOLO) |
| **Entrypoints ativos** | `lib/bc-server.cpp`, `www/` (PHP) |
| **Diretórios ativos** | `lib/`, `www/`, `server/`, `scripts/` |
| **Diretórios excluídos** | `experiments/`, `docs/` |
| **Testes** | `test_storage.cpp` na raiz, standalone, não integrado a nenhum framework/CI; nenhum diretório de teste real no repositório |
| **CI** | `.github/workflows/{docker-build,deb-build}.yml` presentes, mas **não compilam o código deste repositório** — baixam um `.deb` pré-compilado de `dl.bluecherrydvr.com` (achado do dossiê profundo, ver `02-dossies.md`) |
| **Migrations** | Schema único em `misc/sql/schema_mysql.sql` (24 tabelas), sem migrations incrementais versionadas |
| **Aplicação web** | `www/` — PHP monolítico sem framework |
| **Aplicação mobile** | Nenhum código no repositório; `www/mobile-app-config.json` referencia um app comercial externo não incluído |
| **Limitações** | Foco histórico em hardware proprietário; zero testes automatizados reais; CI não exercita o código-fonte atual; achado de autorização (IDOR) confirmado em endpoints de gravação (ver `02-dossies.md`/`05-onde-drac-perde.md`); sem white-label; sem mobile próprio |

---

## 7. Moonfire NVR

| Campo | Valor |
|-------|-------|
| **Nome** | Moonfire NVR |
| **Caminho** | `/home/flashnet/Drac/concorrentes/moonfire-nvr` |
| **Commit atual** | `60fd870` |
| **Branch** | `master` |
| **Linguagens principais** | Rust (servidor), TypeScript/React (UI) |
| **Tipo de sistema** | NVR leve e eficiente, foco em gravação RTSP com zero-copy |
| **Entrypoints ativos** | `server/src/main.rs`, `ui/src/` |
| **Diretórios ativos** | `server/src/`, `server/db/`, `server/base/`, `ui/src/` |
| **Diretórios excluídos** | `guide/`, `screenshots/`, `design/` |
| **Testes** | 105 funções de teste Rust (`#[test]`/`#[tokio::test]`) + 5 arquivos de teste TS na UI |
| **CI** | `.github/workflows/ci.yml` (matriz de 3 toolchains Rust + 4 versões Node) e `release.yml` (build multi-arch) |
| **Migrations** | `server/db/upgrade/` — migrations SQLite versionadas e testadas (v0→v7) |
| **Aplicação web** | `ui/src/` — React SPA básica (visualização e download) |
| **Aplicação mobile** | Nenhuma encontrada |
| **Licença** | GPLv3 (`LICENSE.txt`) — copyleft forte, relevante para `07-recomendacoes.md` |
| **Limitações** | Escopo estreito por desenho: gravação + live view; sem IA (tabela `signal` só recebe eventos externos); sem multi-tenancy; sem mobile; sem white-label; pre-1.0 declarado pelos mantenedores |

---

## 8. Viseron

| Campo | Valor |
|-------|-------|
| **Nome** | Viseron |
| **Caminho** | `/home/flashnet/Drac/concorrentes/viseron` |
| **Commit atual** | `bdd047a2` |
| **Branch** | `dev` |
| **Linguagens principais** | Python (backend), TypeScript/React (frontend) |
| **Tipo de sistema** | VMS open-source com arquitetura de componentes plugáveis |
| **Entrypoints ativos** | `viseron/__main__.py`, `viseron/components/`, `frontend/` |
| **Diretórios ativos** | `viseron/`, `frontend/`, `config/`, `rootfs/` |
| **Diretórios excluídos** | `docs/` |
| **Testes** | `tests/` — 56 arquivos Python |
| **CI** | `azure-pipelines/`, `ci.yaml`, `ci-frontend.yaml` |
| **Migrations** | Nenhuma migration formal identificada (configuração YAML) |
| **Aplicação web** | `frontend/` — React moderno com autenticação e RBAC básico |
| **Aplicação mobile** | Nenhuma encontrada |
| **Limitações** | Sem mobile nativo; multi-tenancy não verificado (single-install); sem white-label; boa base técnica mas inadequado para revenda comercial |

---

## 9–14. Sistemas ausentes

Os sistemas abaixo foram solicitados mas **não estão presentes** no diretório
de concorrentes local. Nenhuma nota foi atribuída.

- **Motion** — daemon de detecção de movimento para Linux
- **Motioneye** — interface web para Motion
- **LightNVR** — NVR leve em C para sistemas embarcados
- **Valkka-core** — biblioteca Python/C++ para vídeo em tempo real
- **VibeNVR** — NVR web moderno
- **Agent** — NVR baseado em .NET (iSpy)

Para uma análise completa destes sistemas, seria necessário clonar os
repositórios e repetir o processo de inspeção.
