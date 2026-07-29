# 07 — Recomendações

> **ERRATA (verificada na implementação).** As recomendações **nº2** (backup
> antes de migração) e **nº3** (ferramenta de integridade com dry-run) partiam
> de premissa **falsa**: ambas as capacidades **já existem** no DRAC
> (`scripts/update-drac.sh:211` e `POST /recordings/maintenance/check-integrity`).
> A recomendação nº4 também precisa de ajuste: existe sim uma camada de seleção
> de runtime de IA; a lacuna é de amplitude, não de arquitetura. Ver
> [09-correcoes-pos-implementacao.md](09-correcoes-pos-implementacao.md).

As cinco recomendações de maior impacto comercial, derivadas diretamente
das lacunas documentadas em [05-onde-drac-perde.md](05-onde-drac-perde.md).
Nenhuma recomenda copiar código com licença incompatível — as licenças de
cada projeto citado foram verificadas diretamente nos arquivos
`LICENSE`/`LICENSE.txt`/`LICENSE.md` de cada repositório antes de qualquer
menção (ver rodapé de cada item).

---

## 1. Teste de integração real para o subsistema de autorização (RBAC)

- **Problema**: o teste mais crítico de segurança do DRAC (`access-matrix.test.ts`) roda contra um Prisma inteiramente mockado — não captura bugs reais de query, condição de corrida em `accessStatus`, ou comportamento sob transação concorrente contra Postgres real.
- **Dimensão**: 9. Maturidade de engenharia (peso 2), com implicação direta na dimensão 5 (RBAC/privacidade, peso 3).
- **Concorrente de referência**: Frigate.
- **Evidência**: `frigate/web/e2e/specs/auth.spec.ts` e demais specs Playwright rodam em CI contra uma instância real (`.github/workflows/pull_request.yml:86-129`), não contra mocks.
- **Resultado esperado**: suíte de e2e que sobe API+Postgres reais (test containers ou banco de teste dedicado) e exercita a matriz dono/grupo/delegado/outsider/admin ponta-a-ponta via HTTP, substituindo (ou complementando) o teste unitário mockado atual.
- **Impacto comercial**: alto — reduz risco de vazamento de dados entre clientes, o incidente mais caro (reputacional e contratual) que este produto pode sofrer.
- **Dificuldade**: média. O precedente de infraestrutura de e2e já existe no DRAC (job e2e RTSP contra fonte sintética no CI).
- **Dependências**: ambiente de teste com Postgres efêmero no CI (test containers ou serviço Docker no próprio workflow).
- **Riscos**: nenhum de licença — Playwright é MIT/Apache, padrão de mercado. Risco técnico: e2e mais lento que unitário, pode exigir paralelização no CI para não estourar tempo de pipeline.
- **Métrica de sucesso**: 100% dos cenários hoje cobertos por `access-matrix.test.ts` (mockado) replicados como e2e contra Postgres real, rodando em todo PR que toque `access-control.service.ts` ou `schema.prisma`.
- **Horizonte**: **imediato** (é a recomendação de menor dificuldade relativa e maior risco de segurança se não endereçada).

---

## 2. Backup automático de banco integrado ao pipeline de deploy/migração

- **Problema**: `prisma migrate deploy` pós-rebuild é hoje um passo manual, não automatizado — risco operacional real a cada atualização, que se multiplica pelo número de instalações white-label conforme a base de revendedores cresce.
- **Dimensão**: 7. Operação e observabilidade (peso 2).
- **Concorrente de referência**: Frigate.
- **Evidência**: `frigate/frigate/app.py:200-203` dispara backup do banco automaticamente, no próprio boot do processo, antes de aplicar qualquer migração pendente.
- **Resultado esperado**: o script/pipeline de deploy do DRAC (ou o boot da API) dispara um backup do Postgres automaticamente antes de `prisma migrate deploy` ser executado, com falha do deploy se o backup falhar.
- **Impacto comercial**: médio — reduz o pior cenário de uma atualização malsucedida (perda de dados) para todas as instalações, sem exigir mudança de arquitetura.
- **Dificuldade**: baixa. O DRAC já tem `scripts/restore-drac.sh` e `scripts/verify-backup-restore.sh` — falta orquestrar a chamada automática no momento certo do pipeline.
- **Dependências**: nenhuma nova — reaproveita scripts existentes.
- **Riscos**: nenhum de licença (é um padrão operacional genérico). Risco técnico: aumento do tempo de deploy proporcional ao tamanho do banco; mitigável com backup incremental se necessário no futuro.
- **Métrica de sucesso**: 100% dos deploys em produção (e no processo de build-and-push de cada instalação white-label) executam backup verificável antes da migração, com log/alerta se o passo for pulado.
- **Horizonte**: **imediato**.

---

## 3. Ferramenta dedicada de verificação/reparo de integridade de gravação

- **Problema**: a reconciliação disco↔banco do DRAC é automática e decide sozinha; não há um modo de auditoria/dry-run operável pelo integrador antes de uma ação potencialmente destrutiva (remoção de registro órfão, marcação de arquivo corrompido).
- **Dimensão**: 2. Gravação (peso 3).
- **Concorrente de referência**: Moonfire NVR (padrão de design, **não código** — ver ressalva de licença abaixo).
- **Evidência**: `moonfire-nvr/server/db/check.rs:1-50` implementa subcomando `check` com `pragma integrity_check`, comparação de tamanhos declarados vs. reais, e reparo opcional via flags explícitas (dry-run implícito ao rodar sem as flags de ação).
- **Resultado esperado**: endpoint administrativo (ou comando CLI operável via script já existente) que roda um relatório de integridade sob demanda — arquivos órfãos, registros sem arquivo correspondente, tamanhos divergentes — **sem agir**, com uma segunda chamada explícita para aplicar correções escolhidas pelo operador.
- **Impacto comercial**: alto — evidência de vídeo é a promessa central do produto; uma ferramenta de auditoria operável pelo integrador reduz risco de disputa contratual sobre "por que esse vídeo sumiu".
- **Dificuldade**: baixa-média. A lógica de reconciliação (`recording-reconcile.helper.ts`) já existe; o trabalho é principalmente separar "detectar e reportar" de "agir", e expor isso como endpoint/CLI administrativo.
- **Dependências**: nenhuma externa.
- **Riscos de licença**: **atenção** — Moonfire NVR é licenciado sob **GPLv3** (`concorrentes/moonfire-nvr/LICENSE.txt`), copyleft forte. Esta recomendação é explicitamente para reimplementar o **padrão de design** (dry-run + relatório + ação explícita) do zero em TypeScript/Prisma, **não copiar o código Rust do Moonfire**, o que exigiria relicenciar a porção correspondente do DRAC sob GPLv3.
- **Métrica de sucesso**: relatório de integridade disponível sob demanda, com tempo de execução aceitável (a definir por volume de gravações) e zero ações destrutivas automáticas sem confirmação explícita.
- **Horizonte**: **próximo ciclo**.

---

## 4. Camada de abstração de backend de aceleração de hardware para IA

- **Problema**: o pipeline de IA do DRAC (ONNXRuntime + InsightFace) não demonstra, no código analisado, uma camada de seleção plugável entre múltiplos aceleradores de hardware — limitando o custo-benefício de IA em escala (muitas câmeras) a CPU ou GPU genérica via CUDA.
- **Dimensão**: 3. Detecção e IA (peso 3).
- **Concorrentes de referência**: Frigate e Viseron.
- **Evidência**: `frigate/frigate/detectors/plugins/` — 13 implementações de detector (onnx, openvino, tensorrt, edgetpu_tfl, hailo8l, rknn, memryx, axengine, degirum, synaptics, teflon_tfl, zmq_ipc, deepstack, cpu_tfl) atrás de uma interface comum selecionável por config; `viseron/viseron/components/hailo/utils.py:20-51` — detecção real de hardware disponível via subprocess no boot.
- **Resultado esperado**: interface de detector com pelo menos 2-3 backends adicionais de baixo custo (prioridade: Coral EdgeTPU e/ou RockChip NPU, por serem comuns em hardware embarcado usado por integradores de pequeno porte), selecionáveis por configuração de instalação, sem mudança na lógica de negócio de zonas/thresholds já existente.
- **Impacto comercial**: alto — reduz custo de hardware por câmera em instalações de maior escala, ampliando a margem em contratos de ISP/condomínio com centenas de câmeras.
- **Dificuldade**: média-alta — cada backend tem particularidades reais de driver/instalação/empacotamento Docker; não é apenas código Python, envolve validação de hardware físico.
- **Dependências**: acesso a hardware físico de teste (EdgeTPU/Hailo/RockChip) para validação — não é possível apenas com leitura de código.
- **Riscos**: **licença verificada** — Frigate é **MIT** (`concorrentes/frigate/LICENSE`) e Viseron é **MIT** (`concorrentes/viseron/LICENSE`), ambas permissivas, sem impedimento a inspiração de arquitetura ou mesmo reuso direto de trechos (mantendo aviso de copyright). O risco real é técnico/operacional (suporte a múltiplos drivers de hardware aumenta a superfície de manutenção), não jurídico.
- **Métrica de sucesso**: pelo menos 1 backend adicional de hardware em produção, com redução mensurável de uso de CPU por câmera em relação ao caminho ONNXRuntime/CPU atual, em pelo menos uma instalação piloto.
- **Horizonte**: **próximo ciclo**.

---

## 5. Modelo de multi-tenancy compartilhada como alternativa opcional à instalação dedicada

- **Problema**: cada revenda do DRAC hoje exige uma instalação Docker própria (Postgres/Redis/API/workers) — custo de infraestrutura fixo por cliente-revendedor, que pressiona a margem em contratos de baixo volume (residencial/pequeno comércio, exatamente parte do público-alvo declarado).
- **Dimensão**: 5. Multi-tenancy, RBAC e privacidade (peso 3), com efeito colateral positivo em 10. White-label (peso 2) ao reduzir custo de onboarding de clientes pequenos.
- **Concorrente de referência**: Shinobi CCTV (padrão conceitual — ver ressalva de licença abaixo).
- **Evidência**: `Shinobi/sql/postgresql/framework.sql:6-167` — coluna `ke` particionando N contas dentro de uma única instalação/banco; `Shinobi/libs/webServerSuperPaths.js:270-498` — camada de superusuário separada com exclusão de conta em cascata (incluindo diretório de vídeos no disco).
- **Resultado esperado**: um novo nível de modelo de dados (`Organization`) acima de `CameraGroup`, permitindo que uma única instalação DRAC sirva múltiplos clientes finais pequenos com isolamento lógico equivalente (não físico) ao que a Central oferece hoje entre instalações — mantendo a opção de instalação dedicada para clientes maiores. Modelo híbrido, não substituição.
- **Impacto comercial**: **o mais alto de todas as recomendações** — é a mudança estrutural que mais diretamente amplia o público-alvo declarado (provedores atendendo clientes residenciais/pequeno comércio) ao reduzir o custo marginal de cada novo cliente pequeno.
- **Dificuldade**: **alta** — exige migrar todo o RBAC e queries existentes para incluir um novo escopo de isolamento acima do atual, decisão de produto sobre quais dados ficam realmente na malha compartilhada, e revalidação completa da revisão adversarial já aplicada ao modelo atual (o novo nível não pode reabrir as classes de bug que o modelo atual já fecha, como a inversão de privilégio de admin).
- **Dependências**: recomendação 1 (teste de integração real de RBAC) deveria preceder esta mudança — um novo nível de isolamento sobre uma base de teste ainda mockada aumenta o risco de regressão de segurança não detectada.
- **Riscos**: **licença verificada** — Shinobi é distribuído sob EULA proprietário (`Shinobi/LICENSE.md`, `COPYING.md`), não uma licença open-source permissiva; a licença explicitamente impõe restrições de uso comercial (registro de revendedor, regra de monitores ativos). **Não copiar código do Shinobi** — esta recomendação é estritamente sobre o padrão conceitual (partição lógica dentro de uma instalação compartilhada + camada de superusuário), a ser reimplementado do zero sobre a base de RBAC já existente do DRAC, preservando os controles que o DRAC já tem e o Shinobi não tem (inversão de privilégio de admin, auditoria, testes adversariais).
- **Métrica de sucesso**: pelo menos uma instalação piloto rodando 2+ clientes finais pequenos na mesma instância compartilhada, com a mesma matriz de teste adversarial de acesso (dono/grupo/delegado/outsider/admin) aplicada e passando — agora com o novo escopo de organização incluído — de preferência já como e2e real (não mockado), incorporando a recomendação 1.
- **Horizonte**: **estratégico**.
