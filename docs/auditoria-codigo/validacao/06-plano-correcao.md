# Plano seguro de correção

Nenhuma correção foi implementada. Os lotes abaixo são deliberadamente
pequenos; a numeração indica ordem recomendada, não autorização automática.
Cada lote deve ter branch/PR, testes e rollback próprios.

## Lote 1 — tornar a origem do instalador imutável

| Campo | Plano |
|---|---|
| Objetivo | Eliminar execução root de conteúdo móvel ou não verificado. |
| Achados | DRAC-AUD-001 |
| Arquivos prováveis | `apps/central/src/server.js`; `apps/central/src/datastore/*`; `install-drac.sh`; configuração/CI de release |
| Testes primeiro | hash incorreto, troca após emissão, redirect, downgrade, offline e argumentos shell do plano 05 |
| Critérios de aceite | Sem `curl \| bash`; sem `main`; download para arquivo; commit/release imutável; SHA-256 obrigatório; falha fechada; versão+digest auditados |
| Riscos | Bloquear instalações se manifest/digest não for publicado; incompatibilidade com fluxo offline |
| Rollback | Manter artefato anterior assinado/pinado e selecionar sua versão; nunca reativar URL móvel |
| Dependências | Política de release, armazenamento do digest, compatibilidade e raiz de confiança |
| Complexidade | Média para pin+digest; alta para assinatura completa |
| Decisão de negócio | Escolher mínimo pin+digest versus release assinada e política de downgrade |

É a primeira correção recomendada. Evoluir depois para assinatura não deve
atrasar o bloqueio imediato de branch móvel.

## Lote 2 — política única de destinos de câmera

| Campo | Plano |
|---|---|
| Objetivo | Bloquear SSRF em todos os pontos que conectam a destinos fornecidos por usuário. |
| Achados | DRAC-AUD-003 |
| Arquivos prováveis | DTOs e `cameras.service.ts`; `safe-url.helper.ts`; `rtsp-url.helper.ts`; `port-checker.service.ts`; ONVIF/MediaMTX/IA |
| Testes primeiro | matriz IPv4/IPv6/DNS/rebinding/redirect/porta/autoridade e cadeia de consumidores |
| Critérios de aceite | Mesma decisão em create/update/draft/status/runtime; porta 1–65535; resolução e redirects revalidados; destino real registrado sem credenciais |
| Riscos | Bloquear câmeras legítimas em sub-redes privadas; divergência IPv6/SNI |
| Rollback | Feature flag de política por instalação com allowlist explícita, nunca retorno a “qualquer privado” |
| Dependências | Definir redes de câmeras permitidas, DNS, IPv6 e egress |
| Complexidade | Alta |
| Decisão de negócio | Câmeras podem estar em quais CIDRs/hostnames e quem pode autorizar exceção? |

## Lote 3 — fechar todos os caminhos de histórico em RESTRICTED

| Campo | Plano |
|---|---|
| Objetivo | Aplicar a licença/feature no consumo de toda mídia histórica. |
| Achados | DRAC-AUD-004 |
| Arquivos prováveis | controllers/services de recordings, ZIP, exported clips, evidence/export; web e mobile apenas para UX |
| Testes primeiro | estado×papel×recurso, emissão+consumo, ID direto e tokens emitidos antes da restrição |
| Critérios de aceite | ZIP, clip, range, thumbnail, download/export e playback usam a mesma decisão server-side; web/mobile não são a barreira |
| Riscos | Bloquear evidência legal ou fluxo explicitamente permitido |
| Rollback | Reverter somente por policy flag documentada/auditada, não por bypass de endpoint |
| Dependências | Regra para evidências e artefatos já exportados |
| Complexidade | Média |
| Decisão de negócio | Evidência/clip produzido antes de RESTRICTED continua acessível? |

## Lote 4 — revogação de sessões da Central

| Campo | Plano |
|---|---|
| Objetivo | Invalidar sessão quando usuário deixa de ser válido ou credencial muda. |
| Achados | DRAC-AUD-005 |
| Arquivos prováveis | `apps/central/src/server.js`; datastores JSON/PG; autenticação/cookies; testes Central |
| Testes primeiro | delete, troca/reset de senha, papel, bloqueio, TTL, duas sessões e requests concorrentes |
| Critérios de aceite | Cada request revalida versão/usuário ou sessão é revogada atomicamente; cookie antigo recebe 401; auditoria preservada |
| Riscos | Logout em massa; corrida na troca de senha; custo de datastore |
| Rollback | Reverter schema mantendo campos novos; não restaurar sessões invalidadas |
| Dependências | Política multi-dispositivo e tratamento do bearer admin estático |
| Complexidade | Média |
| Decisão de negócio | Revogar todas as sessões ou somente a atual em cada evento? |

## Lote 5 — modelo recuperável de gravação/arquivo

| Campo | Plano |
|---|---|
| Objetivo | Tornar criação, retenção, delete e export recuperáveis entre DB e filesystem. |
| Achados | DRAC-AUD-002 |
| Arquivos prováveis | `retention.service.ts`; `recordings.service.ts`; process manager; schema/migration; integrity/recovery |
| Testes primeiro | REC-01 a REC-21, começando por REC-08/09/10/11 |
| Critérios de aceite | Falha de unlink não apaga linha silenciosamente; DB failure não produz sucesso; estados pending/retry observáveis; recovery idempotente; restore usa manifest |
| Riscos | Migration e mudança de retenção; disco cresce se retries falharem; corrida com playback |
| Rollback | Migração compatível para trás, worker novo desativável e nenhum delete automático de estado desconhecido |
| Dependências | Máquina de estados, política de órfãos, retenção e RPO/RTO |
| Complexidade | Alta |
| Decisão de negócio | Adotar órfão, apagar, quarentenar ou exigir intervenção em cada estado? |

Não misturar esse lote com hardening de symlink: os testes e a semântica de
recuperação devem ficar claros antes.

## Lote 6 — updater transacional e fail-closed

| Campo | Plano |
|---|---|
| Objetivo | Evitar rollback de DB com writers ativos e sucesso falso. |
| Achados | DRAC-AUD-006 |
| Arquivos prováveis | `update-drac.sh`; helpers de health/backup; documentação operacional nova |
| Testes primeiro | laboratório com falha após cada passo, migration incompatível, health falho e SIGTERM |
| Critérios de aceite | Writers parados; sem `|| true` crítico; cada erro aborta; backup validado; readiness real; rollback compatível e auditado |
| Riscos | Downtime maior; migrations irreversíveis; shell parcialmente reentrante |
| Rollback | Snapshot pré-update validado e procedimento de recuperação testado na mesma versão |
| Dependências | Política de migrations, janela e armazenamento de backup |
| Complexidade | Alta |
| Decisão de negócio | Downtime máximo e suporte oficial a downgrade |

## Lote 7 — restore com preflight e staging

| Campo | Plano |
|---|---|
| Objetivo | Nunca limpar o estado atual antes de provar que o backup é íntegro/compatível. |
| Achados | DRAC-AUD-007 |
| Arquivos prováveis | `restore-drac.sh`; formato/manifest do backup; health/integrity tools |
| Testes primeiro | backup truncado, versão errada, espaço insuficiente, DB/storage de epochs distintos e falha por etapa |
| Critérios de aceite | Checksum/manifest/preflight antes de mutar; writers parados; staging quando possível; verificação pós-restore; caminho de retorno |
| Riscos | Espaço de pico e tempo; compatibilidade de versões; segredo de backup |
| Rollback | Snapshot do estado corrente, preservado até aceite; restauração reversa testada |
| Dependências | Formato versionado, RPO/RTO, criptografia e ownership |
| Complexidade | Alta |
| Decisão de negócio | Retenção de snapshots e janela aceitável |

## Lote 8 — capability curta do instalador

| Campo | Plano |
|---|---|
| Objetivo | Impedir replay indefinido da quick URL. |
| Achados | DRAC-AUD-008 |
| Arquivos prováveis | `apps/central/src/server.js`; datastores; provisioning UI/API |
| Testes primeiro | TTL, uso único concorrente, revogação, rotação, backup antigo e relógio |
| Critérios de aceite | Token armazenado por hash, `expiresAt`, `usedAt`/limite, rotação e auditoria; resposta após consumo não revela script |
| Riscos | Download interrompido consumir token; hosts offline |
| Rollback | Admin pode emitir nova capability curta; token anterior segue revogado |
| Dependências | Duração e número de downloads; relação com artefato do lote 1 |
| Complexidade | Média |
| Decisão de negócio | Uso único estrito ou janela curta com N retries? |

## Lote 9 — separar administração técnica de ações privadas

| Campo | Plano |
|---|---|
| Objetivo | Impedir PTZ/relay/record privado sem direito ao conteúdo. |
| Achados | DRAC-AUD-010 |
| Arquivos prováveis | `access-control.service.ts`; PTZ/relay/recording controllers; testes de matriz |
| Testes primeiro | admin×private×ação, owner/delegado, endpoints indiretos e auditoria |
| Critérios de aceite | Metadados técnicos preservam `canAdminCamera`; ações físicas/conteúdo exigem decisão explícita composta |
| Riscos | Impedir manutenção legítima e auto-record operacional |
| Rollback | Policy flag por ação, auditada; não regra admin global |
| Dependências | Classificar PTZ, relay e start/stop na política de privacidade |
| Complexidade | Média |
| Decisão de negócio | Quais ações admin podem executar sem consentimento do owner? |

## Lote 10 — timeout e isolamento do build-agent

| Campo | Plano |
|---|---|
| Objetivo | Evitar que uma chamada externa bloqueie toda a Central. |
| Achados | DRAC-AUD-018 |
| Arquivos prováveis | `apps/central/src/server.js`; cliente/build job; testes |
| Testes primeiro | blackhole, reset, resposta grande/lenta e health/heartbeat concorrentes |
| Critérios de aceite | Deadline configurado; cancelamento fecha socket; operação longa fora do gate global; health continua responsivo |
| Riscos | Timeout interromper build legítimo; mudança de API síncrona |
| Rollback | Manter endpoint assíncrono antigo temporariamente atrás de flag, com timeout obrigatório |
| Dependências | SLA e modelo de job/polling do build-agent |
| Complexidade | Média |
| Decisão de negócio | Duração máxima e semântica síncrona/assíncrona |

## Lote 11 — política de bootstrap com Redis

| Campo | Plano |
|---|---|
| Objetivo | Bootstrap terminar em prazo definido quando Redis falha. |
| Achados | DRAC-AUD-013 |
| Arquivos prováveis | `jobs.module.ts`; conexão BullMQ; health; Compose |
| Testes primeiro | refused, auth error, blackhole, recovery e repeat job idempotente |
| Critérios de aceite | API fica ready degradada ou sai para restart dentro do SLA; estado é inequívoco; sem jobs duplicados |
| Riscos | API aceitar requests sem jobs necessários; restart storm |
| Rollback | Configuração conservadora fail-fast com backoff no orquestrador |
| Dependências | Decidir serviços que podem funcionar sem fila |
| Complexidade | Média |
| Decisão de negócio | Fail-fast ou modo degradado? |

## Lote 12 — confinamento de paths contra symlink

| Campo | Plano |
|---|---|
| Objetivo | Impedir leitura/deleção fora do storage por links e TOCTOU. |
| Achados | DRAC-AUD-019 |
| Arquivos prováveis | `safe-file.helper.ts`; todos os chamadores de read/delete/export; restore |
| Testes primeiro | REC-22, symlink de diretório, troca TOCTOU e filesystems suportados |
| Critérios de aceite | Abertura/remoção valida identidade por descriptor/realpath seguro; sentinela externo nunca é tocado |
| Riscos | Quebrar storage com symlinks legítimos/NFS; diferenças de plataforma |
| Rollback | Modo somente leitura/negação segura para filesystem incompatível, não helper lexical antigo |
| Dependências | Lista de filesystems e layout oficial |
| Complexidade | Alta |
| Decisão de negócio | Symlinks são suportados em algum layout oficial? |

## Lote 13 — declarar a Central no deploy oficial

| Campo | Plano |
|---|---|
| Objetivo | Tornar `/central/` reproduzível sem container manual oculto. |
| Achados | DRAC-AUD-009 |
| Arquivos prováveis | Compose prod/dev; Nginx; documentação de deployment; health |
| Testes primeiro | render de configs, DNS/rede e smoke `/central/api/health` |
| Critérios de aceite | Uma topologia oficial única; service/rede/volume/health versionados ou requisito externo validado no preflight |
| Riscos | Duplicar a Central atual ou apontar dois datastores |
| Rollback | Voltar ao serviço externo documentado, preservando volume/datastore e health |
| Dependências | Escolher Central integrada ou externa e migrar o container manual |
| Complexidade | Média |
| Decisão de negócio | Topologia oficial e ownership do datastore |

## Lote 14 — unicidade de permissões

| Campo | Plano |
|---|---|
| Objetivo | Tornar grant/revoke canônicos e concorrentes seguros. |
| Achados | DRAC-AUD-011 |
| Arquivos prováveis | schema/migration Prisma; `camera-permissions.service.ts`; access control |
| Testes primeiro | grant concorrente, fixture duplicada/conflitante, revoke por alvo |
| Critérios de aceite | Constraint adequada; dedupe auditado; upsert/idempotência; nenhuma autorização residual |
| Riscos | Escolha incorreta entre níveis conflitantes; lock/migration |
| Rollback | Backup lógico da tabela e migration reversível sem recriar duplicatas |
| Dependências | Regra de precedência para duplicatas |
| Complexidade | Alta |
| Decisão de negócio | Nível máximo, mais recente ou erro para duplicatas conflitantes? |

## Lote 15 — propriedade referencial de câmera privada

| Campo | Plano |
|---|---|
| Objetivo | Impedir proprietário inexistente. |
| Achados | DRAC-AUD-012 |
| Arquivos prováveis | schema/migration; users/cameras/access-control services |
| Testes primeiro | exclusão, transferência concorrente e migration de órfãos |
| Critérios de aceite | FK/política explícita; nenhum órfão; mensagens e auditoria coerentes |
| Riscos | Bloquear exclusão ou apagar câmera/conteúdo indevidamente |
| Rollback | Preservar IDs/relatório de migração e reverter constraint sem perder câmera |
| Dependências | Decisão `Restrict`, transferência ou `SetNull` |
| Complexidade | Média/alta |
| Decisão de negócio | Destino de câmera e gravações quando owner é removido |

## Lote 16 — imagem IA imutável em produção

| Campo | Plano |
|---|---|
| Objetivo | Executar exatamente o código construído/testado na imagem. |
| Achados | DRAC-AUD-015 |
| Arquivos prováveis | Compose base/dev/prod; Dockerfile IA; fluxo de modelos |
| Testes primeiro | assert de mounts e smoke por revision/digest |
| Critérios de aceite | Bind `/app` somente em dev; produção monta apenas dados/modelos necessários e com modos mínimos |
| Riscos | Quebrar hot reload, modelos/cache ou permissões |
| Rollback | Imagem anterior por digest; nunca reintroduzir fonte RW em prod |
| Dependências | Separar volumes de código, modelos, cache e storage |
| Complexidade | Baixa/média |
| Decisão de negócio | Modelos são baked, volume read-only ou gerenciados externamente? |

## Lote 17 — sessão web resistente a exfiltração

| Campo | Plano |
|---|---|
| Objetivo | Remover access token duradouro de armazenamento legível por JS. |
| Achados | DRAC-AUD-014 |
| Arquivos prováveis | web auth store/client; API auth controller/service; Nginx CSP/cookies |
| Testes primeiro | refresh rotativo, CSRF, cookie flags, CSP report-only, logout e migração |
| Critérios de aceite | Access curto em memória ou cookie HttpOnly; refresh seguro; CSP estrita; revogação funcional |
| Riscos | Regressão ampla de login, CORS/CSRF e múltiplas abas |
| Rollback | Rollout gradual de contrato dual com TTL reduzido, sem voltar a token de 8 h persistente |
| Dependências | TLS, domínio/proxy e estratégia CSRF |
| Complexidade | Alta |
| Decisão de negócio | Cookie HttpOnly versus access em memória + refresh cookie |

## Lote 18 — concorrência do datastore Central

| Campo | Plano |
|---|---|
| Objetivo | Evitar lost update cross-process. |
| Achados | DRAC-AUD-016 |
| Arquivos prováveis | datastore JSON/PG; `server.js`; schema/lock/version |
| Testes primeiro | duas instâncias com barreira em JSON e PG |
| Critérios de aceite | Operações incrementais/CAS/lock global; conflito observado e reexecutado; nenhuma deleção por snapshot antigo |
| Riscos | Refactor de persistência e deadlocks |
| Rollback | Declarar/enforçar singleton antes e durante rollout; backup do datastore |
| Dependências | Suporte oficial a HA e backend primário |
| Complexidade | Alta |
| Decisão de negócio | Central será estritamente singleton ou HA? |

## Lote 19 — cadeia de proxy confiável

| Campo | Plano |
|---|---|
| Objetivo | Não confiar em IP fornecido por cliente direto. |
| Achados | DRAC-AUD-017 |
| Arquivos prováveis | `apps/central/src/server.js`; Nginx/Compose; rate limiter |
| Testes primeiro | proxy confiável/não confiável, IPv6, hops, restart e multi-instância |
| Critérios de aceite | Socket é fonte default; forwarded headers só de proxies allowlisted; rate limit compartilhado conforme topologia |
| Riscos | Registrar IP do proxy ou bloquear admins atrás de NAT |
| Rollback | Ajustar allowlist/hops, nunca confiança global no header |
| Dependências | Topologia oficial do lote 13 |
| Complexidade | Baixa/média |
| Decisão de negócio | Proxies/hops oficiais e escopo do rate limit |

## Lote 20 — decidir o worker Go

| Campo | Plano |
|---|---|
| Objetivo | Remover componente abandonado ou torná-lo operável. |
| Achados | DRAC-AUD-020 |
| Arquivos prováveis | Go source/tests; Compose/profile; docs/CI |
| Testes primeiro | Go 1.22 test/race/vet, health, blackhole, SIGTERM e FFmpeg preso |
| Critérios de aceite | Se suportado: CI, health real, timeouts/context e shutdown limpo. Se não: profile/referências removidos com migration operacional |
| Riscos | Quebrar instalações legacy desconhecidas |
| Rollback | Imagem/profile versionados temporariamente para usuários identificados |
| Dependências | Inventário de instalações e decisão de suporte |
| Complexidade | Média/alta |
| Decisão de negócio | Manter ou aposentar |

## Lote 21 — execução non-root por serviço

| Campo | Plano |
|---|---|
| Objetivo | Reduzir alcance de eventual comprometimento. |
| Achados | DRAC-AUD-022 |
| Arquivos prováveis | Dockerfiles e Compose de cada serviço; entrypoints; permissões dos volumes |
| Testes primeiro | UID/GID/capabilities e smokes de cada path gravável |
| Critérios de aceite | UID não zero; rootfs read-only quando possível; capabilities mínimas; nenhum `chmod 777`; FFmpeg/storage/modelos funcionais |
| Riscos | Falhas de permissão, upgrade de volumes e hardware GPU |
| Rollback | Reverter serviço por serviço para imagem anterior enquanto corrige ownership; não mudança global de uma vez |
| Dependências | Mapa de volumes, UID/GID e GPU/device access |
| Complexidade | Alta, mas divisível por serviço |
| Decisão de negócio | UIDs fixos e suporte a volumes preexistentes |

## Portões entre lotes

- Lotes 1–4 podem começar em paralelo conceitualmente, mas cada PR continua
  independente.
- Lote 5 requer decisão da máquina de estados antes de migration.
- Lotes 6 e 7 compartilham formato de backup, mas não devem ser um único
  patch.
- Lote 8 reutiliza o manifest/artefato do lote 1 sem bloquear a primeira
  mitigação.
- Lote 19 deve seguir a decisão topológica do lote 13.
- Lotes 14 e 15 são migrations distintas e não devem compartilhar deploy.
- Lote 21 deve ser dividido por imagem para reduzir regressão.
