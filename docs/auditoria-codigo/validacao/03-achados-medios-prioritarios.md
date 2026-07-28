# Validação dos achados médios prioritários

Data da validação: 2026-07-28  
Commit: `fdc7588488108e5db60787f828cd7f65e76ec7f1`

Foram incluídos todos os onze achados originalmente classificados como
MÉDIA. Embora alguns sejam principalmente de hardening ou dependam de um
profile opcional, todos podem afetar integridade, autorização,
disponibilidade ou o alcance de um comprometimento. Nenhum código do produto
foi alterado. As reproduções usaram processos efêmeros, arquivos temporários,
mocks e inspeção dos containers já existentes.

## DRAC-AUD-011 — Permissão de câmera sem unicidade no banco

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-011 |
| Título | Permissão de câmera não tem unicidade no banco |
| Severidade/confiança originais | MÉDIA / ALTO |
| Arquivos e linhas | `apps/api/prisma/schema.prisma:512-526`; `apps/api/src/camera-permissions/camera-permissions.service.ts:85-129,146-150` |
| Fluxo completo | Um administrador chama `grant`; o service executa `findFirst`; dois pedidos concorrentes podem observar ausência; ambos executam `create`; `revoke(id)` exclui somente uma linha; a linha restante continua sendo considerada pelo controle de acesso. |
| Pré-condições | Pedidos concorrentes, retry não idempotente ou duplicata preexistente para o mesmo usuário e alvo. |
| Ator | Administrador legítimo, integração administrativa ou cliente que repita uma requisição autorizada. |
| Evidência original | O schema tem índices, mas não uma constraint única; o fluxo é check-then-create sem transação serializável. |
| Evidência adicional | A leitura do service confirmou que a verificação e a criação são operações distintas e que a revogação é por ID. Não foi encontrada migration posterior adicionando a unicidade. |
| Proteções em outras camadas | DTO e autorização limitam quem concede; `getMaxAccessLevel` reduz ambiguidade durante o uso. Essas proteções não tornam a concessão idempotente nem garantem revogação completa. |
| Testes existentes | Testes de matriz de acesso e bloqueio por grupo passaram, mas não há barreira concorrente nem caso com duas linhas equivalentes. |
| Tentativa segura | Não foi criado banco paralelo porque o ambiente PostgreSQL disponível contém dados do runtime. O interleaving foi demonstrado por análise das duas operações, sem mutação do banco. |
| Resultado | A condição estrutural foi confirmada; a manifestação concorrente não foi reproduzida nesta etapa. |
| Impacto e alcance | Revogação incompleta e permissão residual para usuários/câmeras/grupos envolvidos; não afeta pares sem duplicata. |
| Ambiente afetado | Qualquer instalação com PostgreSQL e concessões concorrentes/repetidas. |
| Falso positivo | Baixo para a corrida estrutural; a frequência operacional depende dos clientes e retries. |
| Severidade/confiança revisadas | MÉDIA / ALTO |
| Decisão final | **PROVÁVEL** |

## DRAC-AUD-012 — `ownerUserId` sem integridade referencial

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-012 |
| Título | `ownerUserId` de câmera privada não possui FK |
| Severidade/confiança originais | MÉDIA / ALTO |
| Arquivos e linhas | `apps/api/prisma/schema.prisma:126-145`; `apps/api/prisma/migrations/20260723160000_add_private_camera/migration.sql:1-4` |
| Fluxo completo | A câmera privada recebe um ID de proprietário como texto; o usuário é excluído; permissões relacionadas podem sofrer cascade, mas a coluna da câmera permanece; consultas passam a avaliar um proprietário inexistente. |
| Pré-condições | Exclusão de um usuário que seja proprietário de câmera privada. |
| Ator | Administrador que exclua o usuário ou rotina futura equivalente. |
| Evidência original | Coluna e índice existem sem relação/FK. |
| Evidência adicional | Não há workflow obrigatório de transferência encontrado no service de usuários/câmeras, nem migration que repare órfãos. |
| Proteções em outras camadas | A lógica de acesso compara o ID do usuário atual e administradores mantêm capacidade administrativa; isso não resolve a propriedade órfã. |
| Testes existentes | Há cobertura de acesso privado, mas não de exclusão ou transferência do proprietário. |
| Tentativa segura | Apenas análise do schema e dos chamadores; não foi excluído usuário do banco ativo. |
| Resultado | A ausência de integridade é objetiva; se `Restrict`, `SetNull`, transferência ou exclusão da câmera é o comportamento correto depende do produto. |
| Impacto e alcance | Metadado órfão, gestão ambígua e possível perda lógica de acesso do proprietário; limitado às câmeras privadas do usuário removido. |
| Ambiente afetado | Instalações que usam câmera privada e exclusão de usuário. |
| Falso positivo | Baixo quanto ao órfão; impacto e correção dependem da política de propriedade. |
| Severidade/confiança revisadas | MÉDIA / ALTO |
| Decisão final | **DEPENDE DE REGRA DE NEGÓCIO** |

## DRAC-AUD-013 — Bootstrap da API preso por Redis

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-013 |
| Título | Redis indisponível pode prender bootstrap da API |
| Severidade/confiança originais | MÉDIA / ALTO |
| Arquivos e linhas | `apps/api/src/jobs/jobs.module.ts:38-45,59-104`; `infra/docker-compose.yml:253-262` |
| Fluxo completo | Nest inicia `JobsModule`; `onModuleInit` aguarda três `Queue.add`; BullMQ/ioredis tenta alcançar Redis; uma conexão que aceita e não responde mantém a Promise pendente; o bootstrap não conclui e a API não fica pronta. |
| Pré-condições | Redis blackhole/lento durante o boot, em vez de uma recusa rápida de conexão. |
| Ator | Falha de rede/Redis; indiretamente, atacante com capacidade de afetar essa dependência. |
| Evidência original | Três `await Queue.add` sem prazo ou caminho degradado; `depends_on` não garante readiness. |
| Evidência adicional | Com uma porta TCP local que aceitava conexão e não respondia, `Queue.add` continuou `pending` após 400 ms. O processo de teste foi encerrado explicitamente depois da observação. |
| Proteções em outras camadas | O health service tem verificação Redis e Docker pode reiniciar processos. Isso não é alcançado enquanto o lifecycle hook permanece pendente. IDs estáveis evitam jobs repetidos, mas não limitam o tempo de conexão. |
| Testes existentes | Não foi encontrado teste de boot com Redis refused, blackhole ou recuperação. |
| Tentativa segura | BullMQ apontou para blackhole local efêmero, sem acessar o Redis do DRAC. Nenhum serviço real foi iniciado ou parado. |
| Resultado | A operação necessária ao bootstrap permaneceu pendente além do prazo de controle. |
| Impacto e alcance | Indisponibilidade de toda a API em boot/restart; não implica perda direta de dados. |
| Ambiente afetado | Instalações em que Redis fica parcialmente acessível ou a rede descarta respostas. |
| Falso positivo | Baixo após reprodução do estado pendente; o tempo real até retry/falha varia com a versão/configuração. |
| Severidade/confiança revisadas | MÉDIA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

## DRAC-AUD-014 — JWT web em `localStorage`

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-014 |
| Título | JWT web de 8h fica acessível a JavaScript |
| Severidade/confiança originais | MÉDIA / CONFIRMADO |
| Arquivos e linhas | `apps/web/src/store/authStore.ts:70-103,119-122`; `apps/api/src/auth/auth.module.ts:30-37`; `apps/web/nginx.conf:14-39` |
| Fluxo completo | Login retorna bearer access token; o store persiste o token em `localStorage`; toda execução JavaScript na origem pode lê-lo; um XSS/extensão maliciosa poderia exfiltrar e reutilizar o token até expiração/revogação. |
| Pré-condições | Execução de JavaScript não confiável na origem ou extensão com acesso à página. Nenhum XSS atual foi demonstrado. |
| Ator | Atacante capaz de obter execução no navegador da vítima. |
| Evidência original | Chamada direta a `localStorage.setItem` e TTL default de 8 h. |
| Evidência adicional | O web não mantém refresh token e seu logout é local; a API, porém, revalida `authVersion` e usuário ativo em cada access token. |
| Proteções em outras camadas | React escapa conteúdo por padrão; não foi encontrado `dangerouslySetInnerHTML` ativo; Helmet e revogação por `authVersion` reduzem a janela. A CSP do Nginx não define uma política estrita de scripts. |
| Testes existentes | Testes do store verificam persistência/sessão, não resistência a XSS, CSP ou migração de contrato. |
| Tentativa segura | Inspeção do store e contrato; nenhuma carga XSS ou exfiltração foi executada. |
| Resultado | A acessibilidade a JavaScript está confirmada; uma cadeia de exploração remota atual não. |
| Impacto e alcance | Roubo de sessão web, inclusive administrativa, condicionado a outra primitiva no cliente. |
| Ambiente afetado | Navegadores web; o mobile usa SecureStore e não compartilha este armazenamento. |
| Falso positivo | Baixo para exposição do token; médio se interpretado como vulnerabilidade explorável isolada. |
| Severidade/confiança revisadas | MÉDIA / CONFIRMADO |
| Decisão final | **CONFIRMADO POR ANÁLISE** |

## DRAC-AUD-015 — Código de IA bind-mounted em produção

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-015 |
| Título | Produção de IA executa fonte bind-mounted, não imagem imutável |
| Severidade/confiança originais | MÉDIA / CONFIRMADO |
| Arquivos e linhas | `infra/docker-compose.yml:325-336,430-433`; `infra/docker-compose.prod.yml:1-24` |
| Fluxo completo | Compose constrói a imagem; o volume base monta `services/ai-service-python` sobre `/app`; o override de produção preserva esse volume; Python executa os arquivos do checkout do host, não a cópia validada na imagem. |
| Pré-condições | Uso da composição base + prod oficial. |
| Ator | Operador, updater ou comprometimento com escrita no checkout do host. |
| Evidência original | Merge de Compose preserva o bind mount. |
| Evidência adicional | `docker compose config` com configuração de exemplo manteve o bind. O container `vms-ai-service` atualmente ativo mostra `/home/flashnet/Drac/services/ai-service-python -> /app` em modo read-write. |
| Proteções em outras camadas | Imagem ainda fixa dependências; acesso ao host é necessário para alterar o fonte. Não há `read_only` no mount nem verificação do checkout no start. |
| Testes existentes | CI testa o código, mas não há assert de que o artefato executado em produção seja o conteúdo da imagem. |
| Tentativa segura | Somente merge de configuração e `docker inspect`; nenhum container foi recriado. |
| Resultado | O runtime atual e a configuração resolvida confirmam a sobreposição. |
| Impacto e alcance | Drift, update parcial, indisponibilidade de IA e ampliação da cadeia de suprimento; limitado ao serviço IA, com reflexos em eventos/gravações inteligentes. |
| Ambiente afetado | Deploys Compose que herdam o volume base, inclusive o atual. |
| Falso positivo | Baixo. |
| Severidade/confiança revisadas | MÉDIA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

## DRAC-AUD-016 — Escrita concorrente por múltiplas Centrais

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-016 |
| Título | Serialização da Central não protege múltiplas instâncias |
| Severidade/confiança originais | MÉDIA / ALTO |
| Arquivos e linhas | `apps/central/src/server.js:217-223,2177-2189,2213-2228`; `apps/central/src/datastore/pg-store.js:158-193` |
| Fluxo completo | Cada processo tem `_dbGate` próprio; duas instâncias carregam snapshots A e B; cada uma altera seu snapshot; `writeAll` grava seu conjunto e remove linhas ausentes; o último writer pode apagar a alteração do primeiro. O backend JSON também não tem CAS/lock cross-process. |
| Pré-condições | Mais de uma instância ou outro writer sobre o mesmo datastore. |
| Ator | Topologia HA, reinício sobreposto ou erro operacional; não requer atacante. |
| Evidência original | Gate em memória e load-modify-save do dataset completo sem versão/lock distribuído. |
| Evidência adicional | O Compose versionado não declara Central, e o container atual é externo/manual. Não foi encontrada garantia executável de singleton. |
| Proteções em outras camadas | Dentro de um processo, `runSerialized` e `_dbGate` serializam mutações; o write JSON usa rename atômico. Nenhum deles coordena dois processos. |
| Testes existentes | Testes cobrem serialização no mesmo processo; treze testes PostgreSQL ficaram pulados no ambiente. Não há teste cross-process. |
| Tentativa segura | Análise dos dois backends; não foi iniciada segunda Central contra o datastore real. |
| Resultado | A vulnerabilidade do algoritmo a múltiplos writers está demonstrada, mas não foi comprovado que a topologia suportada permita mais de uma instância. |
| Impacto e alcance | Perda de heartbeat, sessão, usuário, licença ou auditoria no datastore compartilhado. |
| Ambiente afetado | Somente topologias multi-instância/overlap; singleton não manifesta a corrida. |
| Falso positivo | Médio para o deploy atual; baixo se HA/múltiplos processos forem permitidos. |
| Severidade/confiança revisadas | MÉDIA / ALTO |
| Decisão final | **DEPENDE DE CONFIGURAÇÃO** |

## DRAC-AUD-017 — Confiança em `X-Real-IP` na Central

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-017 |
| Título | Exposição direta da Central permite forjar IP de auditoria/rate limit |
| Severidade/confiança originais | MÉDIA / ALTO |
| Arquivos e linhas | `apps/central/src/server.js:29-51,339-361,1219-1228`; `apps/central/README.md:20-25,176-180` |
| Fluxo completo | Cliente envia `X-Real-IP`; a definição efetiva de `clientIp` aceita o header; login usa `IP:email` como chave de limite e auditoria registra o mesmo IP; headers variados criam buckets/atribuições diferentes. |
| Pré-condições | Porta 9765 acessível diretamente ou proxy que preserve header do cliente. |
| Ator | Cliente remoto que alcance a Central sem o Nginx confiável. |
| Evidência original | Header é usado sem allowlist de proxy; README descreve publicação direta e bind em `0.0.0.0`. |
| Evidência adicional | No servidor local efêmero, um `X-Real-IP` arbitrário apareceu no registro de auditoria. O Nginx fornecido sobrescreve o header, e a porta atual está publicada apenas em loopback. |
| Proteções em outras camadas | Nginx versionado define `X-Real-IP $remote_addr`; topologia atual restringe a porta ao host. Rate limit por e-mail ainda limita tentativas dentro de cada IP, mas pode ser fragmentado. |
| Testes existentes | Não há matriz proxy confiável/não confiável; testes de login não cobrem spoofing de header. |
| Tentativa segura | Request para Central efêmera em loopback com IP fictício; não houve brute force. |
| Resultado | A confiança no header e a falsificação em acesso direto foram reproduzidas; a exposição externa não está presente na topologia observada. |
| Impacto e alcance | Auditoria incorreta e bypass parcial de rate limit administrativo em publicação direta. |
| Ambiente afetado | Central exposta sem proxy sanitizador; topologia atual observada está protegida. |
| Falso positivo | Alto quando o Nginx oficial é o único caminho; baixo em exposição direta. |
| Severidade/confiança revisadas | MÉDIA / ALTO |
| Decisão final | **DEPENDE DE CONFIGURAÇÃO** |

## DRAC-AUD-018 — Build-agent sem timeout

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-018 |
| Título | Build-agent sem timeout bloqueia fila global da Central |
| Severidade/confiança originais | MÉDIA / CONFIRMADO |
| Arquivos e linhas | `apps/central/src/server.js:1186-1205,1337-1349,2177-2222` |
| Fluxo completo | Endpoint administrativo entra em `runSerialized`; `agentFetch` conecta ao build-agent sem `AbortSignal`; o peer aceita e nunca responde; a Promise ocupa a fila; health, heartbeat e demais `/api/` aguardam o mesmo gate. |
| Pré-condições | Build-agent configurado que aceite TCP/HTTP, mas não conclua resposta. |
| Ator | Falha/comprometimento do agente ou rede intermediária. |
| Evidência original | Ausência de timeout no `fetch`; `artifactFetch` vizinho usa 15 s. |
| Evidência adicional | Blackhole TCP local bloqueou `/api/admin/apk/clients`; `/api/health` não respondeu dentro de 350 ms. Depois de destruir o socket, health voltou a 200. |
| Proteções em outras camadas | Erros completos são tratados quando a Promise rejeita; não há proteção contra Promise que nunca resolve. O teste usou timeout externo apenas para não prender a auditoria. |
| Testes existentes | Há testes do build-agent e da serialização, mas nenhum blackhole concorrente com heartbeat/health. |
| Tentativa segura | Central efêmera e servidor TCP em loopback, sem build nem dados reais. |
| Resultado | Bloqueio global foi observado e liberado ao encerrar o socket. |
| Impacto e alcance | Indisponibilidade total da Central apesar de o processo continuar vivo. |
| Ambiente afetado | Centrais com build-agent habilitado/consultado. |
| Falso positivo | Baixo. |
| Severidade/confiança revisadas | MÉDIA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

## DRAC-AUD-019 — Escape por symlink no storage

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-019 |
| Título | Symlink sob storage escapa da raiz lexical |
| Severidade/confiança originais | MÉDIA / ALTO |
| Arquivos e linhas | `apps/api/src/recordings/helpers/safe-file.helper.ts:1-13`; chamadores em `recordings.service.ts` e `retention.service.ts` |
| Fluxo completo | Um symlink é colocado sob a raiz de storage e aponta a arquivo externo; `resolve/startsWith` aceita o caminho lexical; leitura/download ou remoção segue o link; a operação alcança fora da raiz. |
| Pré-condições | Capacidade prévia de criar/trocar symlink no volume: host, restore, worker ou container comprometido. |
| Ator | Operador/restore malicioso ou atacante com primitiva de filesystem; nenhum endpoint remoto que crie symlink foi identificado. |
| Evidência original | Helper não usa `lstat`, `realpath`, `O_NOFOLLOW` ou percurso por descriptor. |
| Evidência adicional | Em duas raízes temporárias, o helper aceitou o caminho do link e a leitura retornou o sentinela localizado fora da raiz. Nenhum arquivo do repositório foi usado. |
| Proteções em outras camadas | Controle de acesso da gravação e checagem lexical bloqueiam IDs alheios e `..`; mounts limitam os processos que escrevem. Não bloqueiam symlink já presente. |
| Testes existentes | Cobrem traversal lexical/prefixos, não symlink, troca TOCTOU ou diretório linkado. |
| Tentativa segura | `mktemp`, sentinela e symlink locais; somente leitura e descarte automático da área temporária. |
| Resultado | Escape lexical e leitura fora da raiz foram reproduzidos. |
| Impacto e alcance | Leitura ou deleção de arquivos alcançáveis pelo UID do processo; remoto apenas quando combinado com outra primitiva. |
| Ambiente afetado | Filesystems que suportam symlink e storage gravável por mais de um componente. |
| Falso positivo | Baixo para o bypass; médio para exploração remota isolada. |
| Severidade/confiança revisadas | MÉDIA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

## DRAC-AUD-020 — Worker Go legado

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-020 |
| Título | Worker Go opt-in fica unhealthy e pode travar sem timeout |
| Severidade/confiança originais | MÉDIA / CONFIRMADO |
| Arquivos e linhas | `infra/docker-compose.yml:296-323`; `services/camera-worker-go/main.go:103-177`; `services/camera-worker-go/recorder.go:125-150` |
| Fluxo completo | Profile `legacy-worker` inicia binário; healthcheck consulta `:8000/health`, mas não existe listener; `fetchCameras` usa `http.Client{}` sem timeout; um blackhole prende a iteração; FFmpeg usa `exec.Command` sem contexto e pode sobreviver ao cancelamento esperado. |
| Pré-condições | Profile habilitado; para os travamentos, API/FFmpeg sem resposta. |
| Ator | Operador que habilite o profile, dependência travada ou processo FFmpeg defeituoso. |
| Evidência original | Ausência de HTTP listener; cliente sem timeout e subprocesso sem context. |
| Evidência adicional | `go.mod` e Dockerfile exigem Go 1.22. O ambiente não possui Go, não há `_test.go` e o CI não tem job para o worker. O profile não está ativo nos containers observados. |
| Proteções em outras camadas | O profile é opt-in e o runtime padrão TypeScript não depende dele. Algumas chamadas de report/register têm timeout, mas o fetch principal não. |
| Testes existentes | Nenhum teste Go encontrado. |
| Tentativa segura | Inspeção integral dos cinco arquivos Go e do Compose; não foi habilitado o profile nem iniciado FFmpeg. |
| Resultado | Os defeitos estáticos são objetivos quando o profile é usado; não houve reprodução executável por falta do toolchain e por o recurso ser opcional. |
| Impacto e alcance | Health permanentemente negativo, câmera sem atualização/gravação e shutdown problemático apenas no worker legado. |
| Ambiente afetado | Instalações que habilitem `legacy-worker`. |
| Falso positivo | Baixo se o profile for suportado; se oficialmente abandonado, deve ser removido/documentado em vez de corrigido. |
| Severidade/confiança revisadas | MÉDIA / CONFIRMADO |
| Decisão final | **DEPENDE DE CONFIGURAÇÃO** |

## DRAC-AUD-022 — Containers executando como root

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-022 |
| Título | Containers ativos executam como root sem redução de privilégios |
| Severidade/confiança originais | MÉDIA / CONFIRMADO |
| Arquivos e linhas | `apps/api/Dockerfile:25-41`; `apps/central/Dockerfile:1-16`; `services/ai-service-python/Dockerfile:1-37`; `services/camera-worker-go/Dockerfile:15-25`; Compose e Dockerfiles relacionados |
| Fluxo completo | Imagem não define `USER`; Compose não aplica UID, `read_only`, `cap_drop` ou `no-new-privileges`; processo inicia como UID 0 no container; eventual exploração alcança mounts e recursos com esse privilégio. |
| Pré-condições | Comprometimento prévio do processo/dependência ou ação acidental do próprio processo. |
| Ator | Atacante que explore API, parser de mídia, IA ou dependência; também erro operacional. |
| Evidência original | Ausência de hardening em Dockerfiles/Compose. |
| Evidência adicional | `docker inspect` dos containers ativos API, web, IA, Central, MediaMTX, PostgreSQL e Redis mostrou usuário vazio/default root. Nenhum estava `Privileged`, mas rootfs não era read-only. |
| Proteções em outras camadas | Isolamento padrão do container, `Privileged=false`, redes e portas majoritariamente em loopback reduzem alcance. Root no container não equivale automaticamente a root no host. |
| Testes existentes | Não há teste de UID/capabilities ou smoke sob non-root. |
| Tentativa segura | Somente inspeção de configuração e containers existentes. |
| Resultado | Execução como root foi observada; não foi alegado nem tentado container escape. |
| Impacto e alcance | Amplia dano em volumes, serviço e eventual escape; não é uma exploração autônoma. |
| Ambiente afetado | Deploy atual e imagens sem override de usuário. |
| Falso positivo | Baixo como lacuna de hardening; médio se tratada como vulnerabilidade remota isolada. |
| Severidade/confiança revisadas | MÉDIA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

## Síntese

| Decisão | IDs |
|---|---|
| CONFIRMADO E REPRODUZIDO | 013, 015, 018, 019, 022 |
| CONFIRMADO POR ANÁLISE | 014 |
| PROVÁVEL | 011 |
| DEPENDE DE CONFIGURAÇÃO | 016, 017, 020 |
| DEPENDE DE REGRA DE NEGÓCIO | 012 |
| NÃO REPRODUZIDO / FALSO POSITIVO / DUPLICADO | nenhum |

As prioridades práticas entre estes achados são 013 e 018 para
disponibilidade, 019 para confinamento de arquivos e 011/012 para integridade
da autorização. DRAC-AUD-014 e DRAC-AUD-022 devem ser tratados como defesa em
profundidade, sem alegar exploração autônoma.
