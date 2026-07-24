# Plano de Evolução DRAC — Ordem de Trabalho Executável

> **Status:** preparado em 2026-07-24 para execução na(s) próxima(s) sessão(ões).
> **Origem:** matriz competitiva 84/120 (DRAC vs. 13 concorrentes) → roteiro de evolução → Roteiro Mestre v2 → **verificação contra o código real** (esta passada).
> **Como usar:** execute na ordem das fases. Um item por vez. As regras da Seção 1 têm precedência sobre qualquer otimização. Marque `[x]` só com a **evidência** exigida na Seção 8. O código é a verdade; se este plano divergir do código, PARE, corrija o plano e replaneje o item.

---

## 1. Regras inegociáveis (pré-flight de todo item)

- [ ] **1.1 Licença.** Ver tabela na Seção 3. Nenhuma linha GPL entra no repo. Para itens `REIMPLEMENTAR`, protocolo clean-room: especificar o comportamento a partir da leitura, implementar a partir da especificação, **nunca transcrever**; proibido colar snippet GPL em issue/PR/commit.
- [ ] **1.2 As 5 vantagens defensáveis são INVARIANTES, não features.** Qualquer mudança que enfraqueça uma delas está errada por definição — pare e replaneje:
  - (i) câmera privada LGPD com inversão de admin — `apps/api/src/access-control/access-control.service.ts` (`canViewCamera`, `getAccessibleCameraIds`);
  - (ii) pipeline white-label multi-APK com keystore por cliente — `apps/mobile/scripts/build-client.sh`;
  - (iii) Central de provisionamento — `apps/central/src/server.js`;
  - (iv) stack de liveness mobile — `apps/mobile/src/components/WebRtcVideo.tsx`, `VideoPlayers.tsx`;
  - (v) sanitização de credencial em logs — `apps/api/src/common/security/sensitive-text.helper.ts`.
- [ ] **1.3 Fail-safe de gravação é INVARIANTE:** IA indisponível/erro ⇒ `confirmed=None` ⇒ **grava**. Nunca um subprocesso morto pode virar `confirmed=False`. Escreva o teste "IA fora ⇒ grava" **antes** de tocar o serviço de IA.
- [ ] **1.4 Produção com clientes reais.** Deploy sempre com `docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml ... --no-deps <serviço>` — **nunca** recriar o MediaMTX junto (derruba os paths dinâmicos de todas as câmeras). Após rebuild da API com mudança de schema: `pnpm db:migrate` (`prisma migrate deploy`). **Live saudável nunca pisca** — se piscar após deploy, é regressão (ver memória `live-stream-no-blink-invariant`).
- [ ] **1.5 Nada toca o núcleo** (gravação/streaming/IA) antes de a rede de testes daquele arquivo existir (Fase 0).
- [ ] **1.6 Definição de "pronto":** teste passando + verificação em produção com evidência (ou honestamente "não verificável aqui, requer X"). Conclusão é por **resultado medido** (SLO, fault test, latência, isolamento comprovado), nunca pela mera existência dos arquivos.
- [ ] **1.7 Ritmo.** As estimativas de "6–8 eng / 9–12 meses" da auditoria detalhada **não** são o plano. O ritmo é o destas fases, um item por vez, com evidência.

---

## 2. Fatos verificados no código (2026-07-24) — inclui correção de uma correção

> Todos os `arquivo:linha` abaixo foram lidos nesta passada, salvo onde marcado `⟲ reconfirmar`.

### 2.1 ⛔ A "correção" do worker-go no v2 estava ERRADA — o audit original estava certo
- `services/camera-worker-go/recorder.go:82-108`: o worker **continua transcodificando** para H.264 **baseline/ultrafast — com perda** (`-c:v libx264 -preset ultrafast -profile:v baseline`, linhas 101-108; o comentário 91-93 afirma "perda de qualidade a cada gravação").
- O "`-c copy` desde 2026-07-21" no comentário (linha 86) descreve o **caminho canônico da API**, citado só para **contraste** — não o worker.
- **Consequência:** o comentário/aviso em `apps/api/src/recordings/recording-process-manager.service.ts:107-119` está **CORRETO** — **NÃO editar**. O item "corrigir comentário obsoleto" (4.6 do v2) fica **cancelado**. O item de arquitetura permanece: **aposentar o caminho worker-go divergente** (Fase 2), agora com justificativa reforçada (é mesmo lossy).
- **Lição de processo:** a regra 1.6/8.2 vale inclusive para "correções" de documentos anteriores. Reconfirme no código antes de agir sobre qualquer claim herdado — inclusive os deste plano marcados `⟲`.

### 2.2 ✅ Confirmados nesta passada (âncoras exatas)
- `services/ai-service-python/main.py:157-211` — `confirm-motion` cria `cv2.VideoCapture` síncrono + até 5 `cap.read()` (timeout 5s) **dentro de handler async FastAPI** → bloqueia o event loop do uvicorn por evento ONVIF.
- `services/ai-service-python/main.py:16` — dict global `processors` mutado sem lock em `start` (142), `stop` (152), `stop_all` (272).
- `services/ai-service-python/main.py` — serviço loga com `print()`; **manter a redação de credencial** ao trocar por logging estruturado (invariante 1.2.v).
- `apps/api/src/camera-stream/mediamtx-proxy.service.ts:68,196,212` — recuperação de fleet serializada por um único booleano `recovering` (`if (this.recovering) return`).
- `infra/mediamtx.yml:30` — `webrtcAdditionalHosts: ['168.194.13.70']` **IP hardcoded** → instalação white-label nova nasce anunciando host ICE errado (fere invariante 1.2.iv).
- `apps/web/src/pages/ReviewPage.tsx:22,25,111-112` — o tipo tem `offsetSeconds`, mas a navegação envia só `occurredAt` como `?at=`; `offsetSeconds` é **ignorado** (precisão perdida no salto Revisão→playback).
- `apps/api/src/review/review.service.ts:84-85` — **N+1 admitido no próprio comentário** ("lote por câmera evitaria N+1…"): `Promise.all(rows.map(async event => <query por evento>))`.
- `apps/api/prisma/schema.prisma` — **não há entidade `Tenant`/`Organization`**; tenancy é emulada por `CameraGroup` + `CameraPermission`. (Relevante só para a Fase 3.) 34 migrações.
- `.github/workflows/ci.yml` — roda `pnpm verify` + docker build (api/web) + bundle Android com gate de permissões. **Testes via `tsx tests/*.ts` (não Jest/vitest).** `apps/api/tests/` tem só `phase2-critical.test.ts` (49 casos, bons) e `operational-e2e.test.ts` (auto-pula sem `DRAC_E2E=1`).
- **Higiene git:** rastreados → `DRAC app redesign.zip` (48K), `check_recordings.js`, `check_users.js`, `reset_admin.js`, `apps/api/reset_admin.js`, diretório `Drac-app-redesign/`. Os APKs (`drac-mobile.apk` 35M, `drac-web.apk` 4M) **não** estão rastreados (só no worktree) — apenas gitignorar explicitamente.

### 2.3 ⟲ Claims herdados (do backend audit e do v2) — RECONFIRMAR no código antes de executar
- ⟲ `services/ai-service-python/stream_processor.py:~777,792` — reconexão de captura com `time.sleep(5)` fixo, sem backoff.
- ⟲ `apps/api/src/recordings/recording-process-manager.service.ts:~1217,1238` — `getStatus` infere "gravando" pela idade do último segmento (<15min); pode reportar OK com FFmpeg morto.
- ⟲ **Chave-mestra MediaMTX** — `apps/api/src/camera-stream/camera-stream.controller.ts:~113-122`: verificar se a credencial global `MEDIAMTX_API_USER/PASS` no callback `@Public() mediamtx-auth` concede **read** a qualquer câmera, furando o streamToken. **Se confirmado, é P0** (fura o pilar LGPD em produção). Ver item 4.1.
- ⟲ `reviewedAt` **global** por evento (marcar visto afeta todos os operadores) — claim do v2; confirmar no schema/`review.service` antes do item 5.6.
- ⟲ Push processa tickets mas **não** consulta receipts do Expo — claim do v2; confirmar em `apps/api/src/notifications/` e `apps/mobile/src/services/push.ts` antes do item 5.8.

---

## 3. Tabela de licenças (fonte por item) — verificada

| Concorrente | Licença | Uso |
|---|---|---|
| Frigate | **MIT** (código; marca protegida em `TRADEMARK.md`) | **COPIÁVEL** — código funcional, **sem** nome/logo/branding; preservar notice MIT |
| Viseron | **MIT** | **COPIÁVEL** (com atribuição) |
| VibeNVR | **MIT** | **COPIÁVEL** (baixo valor) |
| Kerberos Agent | **MIT** | **COPIÁVEL** (baixo valor) |
| Scrypted | **ISC** (server) / **Apache-2.0** (ex.: `plugins/prebuffer-mixin`) — **varia por diretório** | **COPIÁVEL por diretório** — verificar o `package.json`/LICENSE do diretório específico antes de copiar |
| lightNVR, moonfire, ZoneMinder, Motion, Bluecherry | **GPL** (v2/v3) | **REIMPLEMENTAR** (clean-room; só a técnica) |
| Shinobi | Licença restritiva comercial | **REIMPLEMENTAR / evitar** |

---

## 4. FASE 0 — Fundação (fazer primeiro · ~2–3 sem · risco baixo · Δ maior)

> Não muda comportamento de produção; só adiciona rede de proteção. Destrava todas as fases seguintes.

- [ ] **0.1 Framework de teste real.** Adotar **vitest** (api/web) e **pytest** (ai-service). Migrar os 49 casos de `apps/api/tests/phase2-critical.test.ts` (RBAC, privacidade, sanitização) sem perder nenhum; mantê-los como **characterization tests**.
  - ⚠️ **Caveat (adição ao processo):** characterization test trava o comportamento **atual, incluindo bugs**. Ao corrigir um bug (ex.: `offsetSeconds` no item 4.3), o teste correspondente **vai ficar vermelho de propósito** — rebaselinar conscientemente **é** parte do fix, não é regressão. Documentar cada rebaseline no commit.
- [ ] **0.2 Cobrir os 3 arquivos críticos hoje sem teste** — foco nos **caminhos de erro**, não só felizes:
  - `apps/api/src/recordings/recording-process-manager.service.ts` (validação de segmento via ffprobe, promoção do pré-buffer, disk-guard, recuperação de órfãos);
  - `apps/api/src/camera-stream/mediamtx-proxy.service.ts` (recuperação de path, `chooseLiveSource`/`chooseGridSource`, prekill de ffmpeg);
  - `services/ai-service-python/` (MOG2 em `detectors/motion.py`, `confirm-motion`, **fail-safe 1.3**).
- [ ] **0.3 CI que bloqueia.** Job de teste obrigatório no `.github/workflows/ci.yml`; e2e rodando de verdade contra serviço efêmero. Remover o auto-skip: **CI falha** quando o e2e obrigatório não está configurado (hoje `operational-e2e.test.ts` se auto-pula sem `DRAC_E2E=1`).
  - ⚠️ **Adição ao processo:** e2e do pipeline de vídeo só é significativo com **fonte RTSP sintética** (ex.: `ffmpeg -re -f lavfi -i testsrc → servidor RTSP efêmero`). Sem isso, o "e2e" cobre CRUD e não o caminho de streaming/gravação — teatro, não teste. Criar a fixture RTSP como parte deste item.
- [ ] **0.4 Higiene do repo** (uma tarde). `git rm --cached` de: `DRAC app redesign.zip`, `check_recordings.js`, `check_users.js`, `reset_admin.js`, `apps/api/reset_admin.js` (movê-los para `scripts/` com máscara de hash de senha se ainda úteis), diretório `Drac-app-redesign/`. Gitignorar explicitamente `*.apk`. Verificar quais de `novo-design/`, `novo-mockup-app-drac/`, `legacy/`, `archive/` estão rastreados e decidir gitignore vs. `git rm --cached`. Ver `scripts/repo-hygiene.sh` (gerado nesta preparação — **revisar antes de rodar**; ele não commita).
- [ ] **0.5 Testes-invariante da Seção 1, escritos já** (preparam Fases 2 e 3):
  - matriz adversarial de acesso (owner, convidado, membro do grupo, admin, super-admin, outro usuário) para live, gravação, snapshot, **thumbnail**, clip, export e tokens — com o caso obrigatório "**admin/super-admin recebe 403/404 para conteúdo privado alheio**";
  - "**IA fora ⇒ grava**".

**Critério de saída:** CI vermelho bloqueia merge; os 3 arquivos críticos têm cobertura dos caminhos de erro.

---

## 5. FASE 1 — Quick wins verificados (~2 sem · paralelo parcial com Fase 0)

> Itens 4.1–4.3, 4.7, 4.8 **não** tocam os 3 arquivos críticos → podem andar em paralelo à Fase 0. Item 4.4/4.5 tocam núcleo → só **após** a cobertura de 0.2.

- [ ] **1.1 [P0 potencial] Auditoria da "chave-mestra" MediaMTX.** Mapear todos os usos de `MEDIAMTX_API_USER/PASS`; confirmar em `camera-stream.controller.ts:~113-122` se o callback aceita **read** com ela. **Se sim:** restringir a publish interno via localhost + teste de regressão; escalar como P0 (fura LGPD). **Se não:** registrar falso-positivo e apenas fechar `allowOrigins` por domínio do tenant. `⟲` (2.3).
- [ ] **1.2 Portabilidade do `mediamtx.yml`.** Parar de versionar IP fixo: `webrtcAdditionalHosts` (hoje `168.194.13.70`, mediamtx.yml:30) passa a ser renderizado por instalação pelo `scripts/install-drac.sh` (template → arquivo gerado). ✓ `INVENTAR`. Protege invariante 1.2.iv.
- [ ] **1.3 Precisão Revisão→playback (web) + N+1 no mesmo item.** Em `ReviewPage.tsx:111-112` navegar com `recordingId` + `offsetSeconds` (já retornados pela API); remover o arredondamento para minuto no handler `?at=` do `PlaybackPage.tsx` (playhead em **segundos**; minuto só como projeção visual). No mesmo PR, corrigir o N+1 de `review.service.ts:84-85` com query em lote por câmera. ✓ `INVENTAR`. **Aceite:** evento em 12:34:27 abre entre 12:34:26 e 12:34:28.
- [ ] **1.4 IA — trinca barata (mesmo serviço, sem mexer no `confirm-motion`).** Lock no dict `processors` (`main.py`); backoff exponencial com jitter na reconexão (teto ~60s, reset após período saudável) em `stream_processor.py` `⟲`; logging estruturado substituindo `print()` **mantendo a redação de credencial** (1.2.v). Fonte backoff: VibeNVR `stream_reader.py` **COPIÁVEL (MIT)**. ⚠️ `confirm-motion` fica para 5.1 (exige o teste fail-safe 0.5).
- [ ] **1.5 Status de gravação derivado do fato.** `getStatus` exige PID real do FFmpeg vivo + mtime do segmento **em escrita** (não idade do último fechado); separar "existe gravação recente" de "está gravando". `⟲` (2.3). ✓ `INVENTAR`.
- [ ] **1.6 ~~Corrigir comentário do worker-go~~ — CANCELADO.** O comentário em `recording-process-manager.service.ts:107-119` está **correto** (worker é lossy, ver 2.1). **Não editar.**
- [ ] **1.7 Branding runtime no web.** Estender logo+cores a todo o app e ao login, reusando `GET /settings/branding` com a garantia de contraste do mobile (`apps/mobile/src/services/branding.ts`). Alterar `apps/web/src/store/brandingStore.ts` + `LoginPage`. ✓ `INVENTAR`. Fecha a assimetria web↔mobile do white-label (D10).
- [ ] **1.8 Push explícito no white-label.** Trocar o `skipFirebase` silencioso (`apps/mobile/app.config.js`) por flag `pushEnabled` por cliente em `clients/<slug>/config.json` — build **falha** se push é esperado e falta `google-services.json`; UI marca "notificações indisponíveis" quando desativado. ✓ `INVENTAR`. Protege a promessa de venda (invariante 1.2.iv).

---

## 6. FASE 2 — Estruturais (~6–8 sem · ordem imposta por dependências)

- [ ] **2.1 Isolar a inferência da IA.** Tirar `cv2.VideoCapture` do event loop; `confirm-motion` enfileira e responde (`asyncio.to_thread`/pool com semáforo e deadline). **Pool por MODELO/DISPOSITIVO, não processo por câmera** (senão duplica pesos e estoura RAM/VRAM). Fonte: Viseron `child_process_worker.py`/`*_subprocess.py` **COPIÁVEL (MIT)**. **Pré-req: teste fail-safe 0.5 passando antes e depois.** Alicerce do offload 3.2.
- [ ] **2.2 Recuperação de fleet paralela.** Substituir o booleano `recovering` (`mediamtx-proxy.service.ts:196`) por recuperação por-path concorrente (Map/Set + limite de concorrência + backoff com jitter). Trocar `spawnSync('ffmpeg','-version')` por probe assíncrono cacheado no boot. Fonte técnica: Viseron `subprocess_watchdog.py` **COPIÁVEL (MIT)**. **Aceite:** MediaMTX recriado com dezenas de câmeras reconstitui todos os paths em ≤60s.
- [ ] **2.3 `/metrics` Prometheus + telemetria + watchdog provisionado.** `prom-client` na API expondo: CPU de encode por câmera, drops, profundidade da fila de IA, latência WebRTC, segundos desde o último segmento confirmado. + telemetria de qualidade do player (técnica lightNVR **REIMPLEMENTAR**). + provisionar `scripts/runtime-watchdog.sh` no `scripts/install-drac.sh` (hoje órfão). Fonte: Frigate `frigate/stats/prometheus.py` **COPIÁVEL (MIT)**. ⚠️ **Cardinalidade/PII:** sem IP/URL RTSP/e-mail/nome de câmera como label; correlação por ID na Central autenticada. Alimenta o score de saúde da Central.
- [ ] **2.4 Integridade de gravação + aposentar worker-go.** Comando `recordings:check` (reconciliação DB↔disco bidirecional — técnica moonfire `check.rs`/ZoneMinder `zmaudit.pl` **REIMPLEMENTAR**) + `fsync` no fechamento do segmento antes de registrar no Postgres (técnica moonfire `dir/writer.rs` **REIMPLEMENTAR**). **Worker-go:** consultar via Central se alguma instalação usa `RECORDING_CONTROL_MODE=worker`; se nenhuma, deprecar com aviso e remover `services/camera-worker-go/` num ciclo seguinte (é lossy, ver 2.1).
- [ ] **2.5 Tracking de objetos (reduz falso positivo).** Persistência entre frames antes de confirmar. Fonte: Frigate `frigate/track/` (norfair) **COPIÁVEL (MIT)** ou SORT próprio. Novo `services/ai-service-python/detectors/tracker.py`.
- [ ] **2.6 Revisão por usuário.** Substituir `reviewedAt` global por join `UserEventReview(userId, eventId)` — marcar visto deixa de afetar outros operadores. `⟲` confirmar o "global" antes. Definir semântica de backfill do `reviewedAt` legado (visto-por-ninguém vs. visto-por-todos). ✓ `INVENTAR`.
- [ ] **2.7 Revisão no mobile.** Nova `apps/mobile/src/screens/ReviewScreen.tsx` consumindo `/review/feed` com rótulos pessoa/carro e clique→instante exato (reusa 1.3), badge de não-vistos, deep link. **Respeitar o gate de câmera privada do backend** (invariante 1.2.i).
- [ ] **2.8 Entrega de push comprovada.** Job assíncrono consultando os receipts do Expo, com métricas accepted/delivered/erro permanente/latência e limpeza de tokens mortos. `⟲` confirmar o gap antes.
- [ ] **2.9 Scrubbing de timeline com previews.** Gerar previews low-res/low-fps dos frames que a IA **já decodifica** (sem segundo decode). Fonte: Frigate `frigate/output/preview.py` **COPIÁVEL (MIT)**. ⚠️ **Derivados de câmera privada herdam o MESMO gate de conteúdo e retenção da origem** (invariante 1.2.i) — é onde o vazamento de LGPD realmente aconteceria.
- [ ] **2.10 Keystore + Central em Postgres.** Tirar a senha de keystore do plaintext no host de build (`build-client.sh`); migrar o datastore da Central de JSON (`apps/central/src/server.js`) para Postgres com **dual-read** JSON↔Postgres por alguns ciclos, escrita só no novo após reconciliação, JSON antigo read-only como janela de rollback, **backup das identidades de assinatura ANTES** da migração.

---

## 7. FASE 3 — Liderança (CONDICIONADA — não iniciar sem gatilho comercial)

- [ ] **3.1 Tenant + RLS no Postgres.** **Gatilho:** primeiro cliente com múltiplas organizações reais, ou exigência de auditoria/compliance. RLS é a fronteira **externa** (entre tenants); a inversão de admin da câmera privada é a **interna** (dentro do tenant) — **compõem, nunca se substituem**. Migração em etapas: tenant default + colunas nullable → backfill validado → API escreve/filtra tenant → só então NOT NULL + RLS + JWT com tenant. `SUPER_ADMIN` deixa de ser bypass; break-glass só com consentimento temporário do dono, motivo, expiração e auditoria. **Os testes-invariante 0.5 devem passar intocados.** ✓ `INVENTAR` (ninguém no mercado faz).
- [ ] **3.2 Offload horizontal de transcode/inferência.** **Gatilho:** contrato >~100 câmeras ou multi-site. **Parar em "4.5":** nós-worker sem HA distribuída, primário como fonte única de verdade; leases/fencing só se/quando a gravação for externalizada — e **nunca antes** do ledger/integridade (2.4). Fonte: Scrypted `server/src/services/cluster-fork.ts` (**ISC**, verificar o diretório).
- [ ] **3.3 Refactor do `apps/mobile/App.tsx`** (god component 1651 linhas). Incremental, tela a tela, junto com features — nunca big-bang. Introduzir `react-navigation`, unificar `screens/` e `screens/redesign/`. (Dívida; não muda nota.)

---

## 8. O que este plano deliberadamente NÃO faz

- Não persegue **120/120** como meta literal (placar é bússola, não contrato). Meta operacional: **nenhuma dimensão < 4**, liderança isolada mantida em **D5/D6/D10**, e o núcleo (D1/D2/D3) com robustez **comprovada por teste**.
- Não copia nada de lightNVR/moonfire/ZoneMinder/Motion/Bluecherry (GPL) — só técnica reimplementada em clean-room.
- Não faz 2FA por enquanto (decisão do dono do produto).
- Não adota o cronograma de programa (6–8 eng/9–12 meses) — o escopo da auditoria entra como especificação; o ritmo é o daqui.
- Não inicia a Fase 3 sem gatilho comercial.
- Não persegue iOS sem demanda contratada (D6 pode parar em "Android excelente").

---

## 9. Formato de trabalho exigido

1. **Um item por vez**, com: (a) testes escritos/rodando antes e depois; (b) deploy conforme 1.4; (c) verificação em produção com evidência; (d) commit focado por item.
2. **Código é a verdade.** Ao divergir do plano (como no worker-go, 2.1), PARE, registre a correção neste `.md` e replaneje o item. Reconfirme todo claim `⟲` no código antes de agir.
3. **Rebaseline de characterization test** ao corrigir o bug que ele fixava **é** parte do fix (0.1).
4. **Relatório curto ao fim de cada fase:** o que mudou, evidências, riscos abertos, o que da fase seguinte repriorizar.

---

## 10. Scorecard-alvo (bússola)

| Dim | Peso | Hoje | Alvo | Como se prova (resultado medido) |
|---|---|---|---|---|
| D1 Streaming | 3 | 4 | 5 | Aceite 2.2 (fleet ≤60s) + origins/credencial fechados (1.1) |
| D2 Gravação | 3 | 4 | 5 | `recordings:check` verde + status por-fato (1.5) + worker-go aposentado |
| D3 IA | 3 | 3.5 | 5 | fail-safe testado + IA isolada (2.1) + tracker (2.5) |
| D4 Playback | 2 | 3.5 | 5 | aceite 1.3 (precisão ±1s) + scrubbing (2.9) |
| D5 Multi-tenant/LGPD | 3 | 3.5 | 5 | matriz adversarial 0.5 verde + RLS (3.1, condicionado) |
| D6 Mobile | 2 | 3.5 | 5 | revisão mobile (2.7) + push comprovado (2.8/1.8) |
| D7 Operação | 2 | 3.5 | 5 | `/metrics` vivo + watchdog provisionado (2.3) |
| D8 Escala | 2 | 3 | 4.5* | offload por gatilho (3.2); *5 só com contrato ISP |
| D9 Engenharia | 2 | 2 | 5 | CI bloqueante + 3 arquivos críticos cobertos (Fase 0) |
| D10 White-label | 2 | 4 | 5 | branding web (1.7) + keystore/Central (2.10) + IP portável (1.2) |

**Sequência crítica:** Fase 0 (0.1→0.2→0.3, 0.5) destrava tudo → Fase 1 quick wins em paralelo → 2.1 (IA isolada) habilita 2.9 e 3.2 → 2.3 (métricas) habilita balanceamento de 3.2 → 3.1/3.2 só sob gatilho. Nada toca núcleo antes de 0.2.
