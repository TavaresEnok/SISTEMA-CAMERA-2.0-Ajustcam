# 05 — Onde o DRAC Perde Hoje

> **ERRATA (verificada na implementação).** Os itens **3** (ferramenta de
> integridade) e **5** (backup pré-migração) desta lista **não são lacunas** —
> ambos já estão implementados. E a lição de "credencial fora da URL" (item 2 de
> Ingestão) já está resolvida no DRAC de forma mais elegante que a sugerida,
> via descritor de arquivo herdado. Ver
> [09-correcoes-pos-implementacao.md](09-correcoes-pos-implementacao.md), que
> também documenta dois riscos reais que **esta** análise não viu e que foram
> corrigidos.

Lista priorizada de lacunas concretas, ordenada por impacto comercial
combinado com o peso da dimensão. Cada item cita evidência real do DRAC e do
concorrente — nenhum item se baseia em reputação externa ou documentação
promocional.

---

## 1. Multi-tenancy compartilhada em uma única instalação (isolamento por conta, não por deploy)

- **Dimensão**: 5. Multi-tenancy, RBAC e privacidade (peso 3)
- **Impacto comercial**: alto. Hoje, cada revenda do DRAC exige uma instalação Docker própria (Postgres, Redis, API, workers). Isso significa que o custo de infraestrutura por cliente-revendedor pequeno é fixo e relativamente alto, o que pressiona a margem em contratos de baixo volume (poucas câmeras) — exatamente o segmento residencial/pequeno comércio citado como público-alvo.
- **Evidência no DRAC**: `apps/api/prisma/schema.prisma` não tem `model Organization`/`Tenant`; isolamento entre clientes finais é via `CameraGroup`/`CameraPermission` **dentro de uma instalação**, e isolamento entre revendedores é via **instalações Docker separadas** monitoradas pela Central (`apps/central/src/server.js`). Confirmado no dossiê do DRAC (§4, "Multi-tenant 'SaaS' clássico não existe").
- **Concorrente que faz melhor**: Shinobi CCTV.
- **Arquivo e mecanismo do concorrente**: `sql/postgresql/framework.sql:6-167` — coluna `ke` ("group key") presente em praticamente toda tabela, particionando dados de N contas dentro de **um único banco/instalação**; `libs/webServerSuperPaths.js:270-498` — criação/edição/exclusão de conta via camada de superusuário separada (autenticada por arquivo local, não linha em `Users`), com exclusão em cascata que apaga Monitors/Events/Logs/Videos/Files/Timelapses **e o diretório de vídeos no disco** daquela conta.
- **Diferença técnica**: Shinobi implementa isolamento lógico (coluna de partição + camada de superusuário) dentro de um processo/banco compartilhado; o DRAC implementa isolamento físico (processo/banco por instalação). O modelo do DRAC é mais forte em isolamento de falha e simplicidade de segurança (uma instalação comprometida não afeta outra), mas mais caro operacionalmente por cliente pequeno.
- **Dificuldade estimada**: alta. Exige um novo nível de modelo de dados (`Organization`) acima de `CameraGroup`, migração de todas as queries e RBAC existentes para incluir esse escopo, e decisão de produto sobre quais clientes ficam no modelo compartilhado vs. dedicado (provavelmente um modelo híbrido, não substituição total).
- **Risco de copiar uma solução inadequada**: médio-alto. O mecanismo do Shinobi é mais simples que o necessário para o padrão de segurança que o DRAC já estabeleceu (RBAC backend-enforced, auditoria, inversão de privilégio de admin para câmera privada) — replicar literalmente o padrão de coluna `ke` sem os mesmos controles adicionais do DRAC regrediria a postura de segurança/privacidade atual. A licença do Shinobi (`LICENSE.md`) também é um EULA proprietário, não permissivo — não deve ser copiado diretamente, apenas usado como referência conceitual (ver [07-recomendacoes.md](07-recomendacoes.md)).

---

## 2. Amplitude de aceleração de hardware para inferência de IA

- **Dimensão**: 3. Detecção e IA (peso 3)
- **Impacto comercial**: alto. Provedores/ISPs que escalam para centenas de câmeras precisam rodar IA com custo de CPU/GPU previsível por câmera. Suporte a mais aceleradores de baixo custo (Coral EdgeTPU, Hailo, NPUs RockChip) reduz custo de hardware por instalação e amplia o público (integradores que já têm esses dispositivos).
- **Evidência no DRAC** (corrigida após verificação direta do código): existe sim um sistema de perfis de runtime — `services/ai-service-python/runtime_profiles.py:65-210` define `MOTION_PROFILE`, `FACE_PROFILE` e `GENERAL_PROFILE`, com runtime selecionável por variável de ambiente (`GENERAL_RUNTIME`, default `openvino_cpu`; `FACE_RUNTIME`, default `onnxruntime_cpu`, com opção `onnxruntime_cuda`) e fallback CUDA→CPU em `onnxruntime_providers()` (linhas 187-198). Há também exportação de modelos YOLO26n para **OpenVINO INT8 em múltiplas resoluções** (640/512/416 — `download_models.py:39-83`), que é uma alavanca real de eficiência de CPU. **A lacuna real não é ausência de abstração, é amplitude**: são ~3 caminhos (OpenVINO CPU, ONNXRuntime CPU, CUDA) contra 13 no Frigate, e nenhum acelerador dedicado de baixo custo (EdgeTPU/Coral, Hailo, NPU RockChip) — confirmado por busca: `grep -riE "edgetpu|coral|hailo|rknn|rockchip|tensorrt"` em `services/` e `apps/api/src/ai/` retorna apenas a linha de `openvino` em `requirements-gpu.txt`.
- **Concorrente que faz melhor**: Frigate (mais amplo) e Viseron (mais motores de detecção diferentes).
- **Arquivo e mecanismo do concorrente**: `frigate/detectors/plugins/` — 13 arquivos, um por backend (onnx, openvino, tensorrt, edgetpu_tfl, hailo8l, rknn, memryx, axengine, degirum, synaptics, teflon_tfl, zmq_ipc, deepstack, cpu_tfl), cada um implementando uma interface comum de detector selecionável por configuração; `viseron/components/{darknet,yolo,edgetpu,hailo,dlib,compreface,deepstack,codeprojectai}/` — 6+ motores de detecção com aceleração de hardware **detectada de fato via subprocess no boot** (`rootfs/etc/cont-init.d/40-set-env-vars`, `viseron/components/hailo/utils.py:20-51`).
- **Diferença técnica**: Frigate/Viseron têm uma camada de abstração de "detector plugável" com múltiplas implementações concretas selecionadas por config; o DRAC tem um caminho único (ONNXRuntime) sem essa camada de abstração documentada no dossiê.
- **Dificuldade estimada**: média-alta. Não é reescrever o pipeline de IA, é adicionar uma camada de abstração de backend de inferência e implementações adicionais — trabalho incremental, mas real (cada backend tem particularidades de instalação/driver).
- **Risco de copiar uma solução inadequada**: baixo. Verificado diretamente: `concorrentes/frigate/LICENSE` é **MIT** (não AGPL, ao contrário do que se poderia supor por reputação) e `concorrentes/viseron/LICENSE` também é **MIT**. Ambas as licenças permitem inspiração de arquitetura e mesmo reuso direto de código com atenção apenas à retenção do aviso de copyright — mas a abstração de "detector plugável" em si é um padrão de design comum, não um ativo protegido; o risco real é técnico (cada backend de hardware tem particularidades de driver/instalação que exigem validação própria), não jurídico.

---

## 3. Ferramenta dedicada de verificação/reparo de integridade de gravação

- **Dimensão**: 2. Gravação (peso 3)
- **Impacto comercial**: alto. Gravação é a base da promessa de evidência forense do produto — um cliente de segurança (comércio, condomínio) que perde acesso a um vídeo por corrupção silenciosa de arquivo é o pior cenário de reputação para um provedor. Uma ferramenta de diagnóstico/reparo operável pelo integrador reduz risco de suporte e de disputa contratual.
- **Evidência no DRAC**: `apps/api/src/recordings/recording-process-manager.service.ts` tem guarda de disco cheio e anel de stderr para diagnóstico pós-morte do processo; existe "diagnóstico de integridade" no controller de recordings, mas não há evidência, no dossiê, de um comando/CLI dedicado de verificação de integridade de arquivo (checksum, `pragma integrity_check` equivalente) operável fora do fluxo normal de gravação.
- **Concorrente que faz melhor**: Moonfire NVR.
- **Arquivo e mecanismo do concorrente**: `server/db/check.rs:1-50` — subcomando `moonfire-nvr check` que roda `pragma integrity_check` no SQLite, compara tamanhos de arquivo declarados vs. reais no disco, e oferece reparo opcional (remoção de linhas órfãs/corrompidas ou arquivos órfãos) via flags explícitas (`compare_lens`, `trash_orphan_sample_files`, `delete_orphan_rows`, `trash_corrupt_rows`).
- **Diferença técnica**: o DRAC reconcilia DB↔disco como parte do fluxo operacional automático (helper de reconciliação), mas não expõe uma ferramenta de auditoria/reparo sob demanda com granularidade de decisão para o operador — a reconciliação automática decide sozinha, sem opção de dry-run/relatório antes de agir.
- **Dificuldade estimada**: baixa-média. O DRAC já tem a lógica de reconciliação (`recording-reconcile.helper.ts`); o trabalho é principalmente expor um modo CLI/endpoint administrativo com dry-run e relatório antes de qualquer ação destrutiva.
- **Risco de copiar uma solução inadequada**: **atenção de licença aqui.** `concorrentes/moonfire-nvr/LICENSE.txt` mostra que Moonfire NVR é **GPLv3** (copyleft forte), não permissiva. Qualquer código do Moonfire incorporado literalmente ao DRAC (produto comercial fechado) exigiria relicenciar essa parte sob GPLv3 ou obter autorização — inviável para a maior parte do produto. A recomendação aqui é reimplementar o **padrão** (dry-run + relatório + ação explícita, `pragma integrity_check`) do zero, sem copiar o código Rust do Moonfire.

---

## 4. Teste de integração real do subsistema de autorização (não mockado)

- **Dimensão**: 9. Maturidade de engenharia (peso 2)
- **Impacto comercial**: alto (risco de segurança, não feature). O RBAC/controle de acesso é o mecanismo que impede um cliente de ver dados de outro — é o componente mais sensível do produto para o modelo comercial multi-cliente. Um teste que roda contra um Prisma mockado não captura bugs reais de query (índices ausentes, condição de corrida em `accessStatus`, comportamento sob transação concorrente).
- **Evidência no DRAC**: `apps/api/tests/access-matrix.test.ts` usa Prisma inteiramente mockado — funções `findMany`/`findUnique` reimplementadas manualmente sobre arrays fixos (achado da revisão adversarial, dossiê do DRAC §8).
- **Concorrente que faz melhor**: Frigate.
- **Arquivo e mecanismo do concorrente**: `web/e2e/specs/auth.spec.ts` e demais specs Playwright (`live`, `replay`, `export`, `review`) — testes E2E que sobem uma instância real do Frigate em CI e exercitam autenticação/autorização via browser real contra a API real, não contra mocks (`.github/workflows/pull_request.yml:86-129`).
- **Diferença técnica**: teste unitário de lógica pura (DRAC, para este caso específico) vs. teste de integração ponta-a-ponta contra sistema real (Frigate). Ambos os sistemas têm boa cobertura de teste em geral — a diferença é que o DRAC tem essa lacuna especificamente no componente mais sensível.
- **Dificuldade estimada**: média. O DRAC já tem um job de e2e RTSP no CI (`.github/workflows/ci.yml:111-116`) contra uma fonte sintética — o precedente de infraestrutura de e2e existe; falta estender esse padrão para um cenário de e2e de autorização contra Postgres real (test containers ou banco de teste dedicado).
- **Risco de copiar uma solução inadequada**: baixo. Playwright contra API real é prática padrão de mercado, sem dependência de licença de terceiro.

---

## 5. Backup de banco integrado automaticamente ao pipeline de deploy/migração

- **Dimensão**: 7. Operação e observabilidade (peso 2)
- **Impacto comercial**: médio. Reduz risco operacional durante atualizações — que acontecem com frequência crescente à medida que o número de instalações white-label cresce (cada instalação roda sua própria migração).
- **Evidência no DRAC**: a própria memória operacional do projeto registra como gotcha conhecido que `prisma migrate deploy` deve ser rodado manualmente após rebuild da API — não é automatizado no pipeline de deploy (achado confirmado na revisão adversarial do dossiê do DRAC §8).
- **Concorrente que faz melhor**: Frigate.
- **Arquivo e mecanismo do concorrente**: `frigate/app.py:200-203` — backup do arquivo de banco SQLite é disparado automaticamente pelo próprio processo **antes** de aplicar qualquer migração pendente, sem intervenção manual do operador.
- **Diferença técnica**: Frigate acopla backup+migração no boot do próprio processo (SQLite facilita isso); o DRAC usa Postgres com um passo de deploy separado do boot da API, o que é arquiteturalmente mais comum para Postgres mas exige que o passo de backup seja parte explícita do pipeline de CI/CD ou do script de deploy, não uma etapa manual lembrada pelo operador.
- **Dificuldade estimada**: baixa. O DRAC já tem `scripts/verify-backup-restore.sh` e `scripts/restore-drac.sh` — o trabalho é orquestrar um backup automático pré-migração dentro do próprio script/CI de deploy, não construir a capacidade de backup do zero.
- **Risco de copiar uma solução inadequada**: baixo — é um padrão operacional genérico (backup antes de migração), não código específico do Frigate.

---

## 6. Playback sincronizado entre múltiplas câmeras

- **Dimensão**: 4. Playback e revisão (peso 2)
- **Impacto comercial**: médio-baixo. Relevante para investigações que cruzam múltiplas câmeras (ex.: seguir uma pessoa entre ambientes), um caso de uso valorizado em contratos comerciais/condominiais maiores, mas não crítico para o segmento residencial de câmera única.
- **Evidência no DRAC**: o dossiê do DRAC não encontrou evidência de sincronização de playback entre câmeras (§7, "sincronização de playback multi-câmera... não verificados a fundo" — os componentes web de player não foram lidos em profundidade, então esta ausência tem confiança média, não alta).
- **Concorrente que faz melhor**: Viseron.
- **Arquivo e mecanismo do concorrente**: `frontend/src/components/events/SyncManager.tsx:20-319` — implementação real de correção de drift entre players de câmeras diferentes, reavaliada a cada 100ms, mantendo desvio abaixo de 0,5s.
- **Diferença técnica**: Viseron implementa um coordenador de tempo client-side que ajusta múltiplos elementos `<video>` de forma independente; não há evidência de mecanismo equivalente no DRAC.
- **Dificuldade estimada**: média. É trabalho de frontend concentrado (um componente coordenador), não exige mudança de backend além de garantir que os m3u8/tokens de múltiplas câmeras sejam solicitáveis com timestamps alinhados (que o DRAC já parece ter, dado o VOD m3u8 existente).
- **Risco de copiar uma solução inadequada**: baixo. Viseron é MIT — o padrão de sincronização (não o código React específico) pode ser usado como referência de design sem risco de licença, desde que a implementação final seja original.
