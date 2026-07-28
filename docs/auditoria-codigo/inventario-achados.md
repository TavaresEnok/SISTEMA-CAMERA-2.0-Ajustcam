# Inventário de Achados

Base: `fdc7588488108e5db60787f828cd7f65e76ec7f1`.

## Resumo

| Severidade | Quantidade |
|---|---:|
| CRÍTICA | 1 |
| ALTA | 9 |
| MÉDIA | 11 |
| BAIXA | 2 |
| INFORMATIVA | 2 |
| **Total** | **25** |

Confiança: 15 CONFIRMADO, 8 ALTO, 2 MÉDIO.

## DRAC-AUD-001 — Instalador remoto executa branch móvel sem verificação

- **Categoria / severidade / confiança / status:** supply chain; CRÍTICA;
  CONFIRMADO; ABERTO.
- **Subsistema:** Central, instalação e SSH.
- **Arquivo / linhas:** `apps/central/src/server.js:39-40,405-419,1594-1608`.
- **Código relacionado:** `DEFAULT_INSTALLER_URL`,
  `buildLegacyInstallCommand`, `buildRemoteInstallCommand`.
- **Descrição:** o default aponta para `raw.githubusercontent.com/.../main/`
  e os fluxos local/remoto enviam o conteúdo diretamente ao `bash`, sem commit,
  digest, assinatura ou revisão local.
- **Evidência:** URL móvel e dois pipelines `curl -fsSL ... | bash` estão no
  runtime da Central.
- **Cenário necessário:** comprometimento da conta/repositório/DNS/CDN,
  alteração maliciosa de `main`, ou configuração de URL controlada.
- **Impacto:** execução arbitrária nos servidores dos clientes, normalmente
  com privilégios de instalação; comprometimento de frota.
- **Perda de dados / indisponibilidade / exploração remota:** sim / sim / sim.
- **Usuário/perfil afetado:** operador Central e todas as instalações
  provisionadas.
- **Reprodução segura:** em teste unitário, substituir a URL por servidor local
  que retorna marcador inofensivo e provar que o comando o executaria; não
  executar em host real.
- **Correção recomendada:** publicar artefato imutável, pinado por commit,
  validar SHA-256/assinatura antes de executar e exigir aprovação de versão.
- **Testes recomendados:** rejeitar hash/assinatura incorretos, URL móvel e
  downgrade; provar pinagem no instalador SSH e quick installer.
- **Arquivos relacionados:** `scripts/install-drac.sh`,
  `apps/central/README.md`.
- **Dependências da correção:** pipeline de release/chaves de assinatura e
  política de rotação.
- **Risco de regressão:** alto no provisionamento; requer rollout compatível.
- **Possibilidade de falso positivo:** baixa; a execução sem verificação é
  objetiva, embora a exploração dependa de comprometimento upstream.

## DRAC-AUD-002 — Retenção não é atômica entre arquivos e banco

- **Categoria / severidade / confiança / status:** integridade/perda de dados;
  ALTA; CONFIRMADO; ABERTO.
- **Subsistema:** gravações, clips e retenção.
- **Arquivo / linhas:** `apps/api/src/recordings/retention.service.ts:377-420`;
  `apps/api/src/recordings/recordings.service.ts:2767-2804`.
- **Código relacionado:** `removeFile`, `deleteClip`, `deleteRecording`,
  `deleteAllRecordings`.
- **Descrição:** falhas de remoção são ignoradas antes de apagar a linha; no
  sentido inverso, arquivos são apagados antes de operações DB que podem
  falhar. A exclusão total apaga todas as linhas mesmo com `failedFiles > 0`.
- **Evidência:** `removeFile` retorna `false`, chamadores não o verificam, e o
  `$transaction(deleteMany)` ocorre após o loop destrutivo de filesystem.
- **Cenário necessário:** permissão/I/O falha, DB indisponível, crash ou disco
  problemático durante retenção/limpeza.
- **Impacto:** arquivo órfão ocupando disco ou banco apontando para arquivo
  inexistente; clips/evidências inacessíveis.
- **Perda de dados / indisponibilidade / exploração remota:** sim / sim /
  indireta, por operador/job autenticado.
- **Usuário/perfil afetado:** todos que dependem de playback/evidência.
- **Reprodução segura:** filesystem temporário e Prisma fake que falha em cada
  passo; verificar invariantes sem tocar storage real.
- **Correção recomendada:** tombstone/outbox durável, duas fases idempotentes,
  só remover DB após unlink confirmado e reconciliar ambos os sentidos.
- **Testes recomendados:** fault injection em cada unlink/query/crash e retry
  idempotente.
- **Arquivos relacionados:** safe-file helper, disk scan, processors de
  cleanup.
- **Dependências da correção:** desenho de estado de deleção e observabilidade.
- **Risco de regressão:** alto; retenção e disco cheio são críticos.
- **Possibilidade de falso positivo:** baixa; os ramos de erro são explícitos.

## DRAC-AUD-003 — Cadastro/teste de câmera permite SSRF na rede de controle

- **Categoria / severidade / confiança / status:** SSRF/isolamento de rede;
  ALTA; CONFIRMADO; ABERTO.
- **Subsistema:** câmeras, RTSP, ONVIF e ffprobe.
- **Arquivo / linhas:** `apps/api/src/cameras/cameras.service.ts:144-155,567-590,908-915`;
  `apps/api/src/common/network/safe-url.helper.ts:12-46`;
  `apps/api/src/cameras/cameras.controller.ts:116-168`.
- **Código relacionado:** `assertTestTargetAllowed`,
  `isPrivateOrReservedIp`, `createMine`, `testConnectionDraft`,
  `capturePreviewFrame`.
- **Descrição:** a regra default bloqueia IP público e permite exatamente
  loopback, link-local, RFC1918, `0/8` e multicast/reservado. Usuário com
  feature/cota pode criar câmera privada; admin pode testar/preview.
- **Evidência:** `127.0.0.1`, `169.254.0.0/16`, redes Docker e privadas
  retornam `true` e seguem para conexões de porta/ONVIF/RTSP.
- **Cenário necessário:** conta autenticada com cadastro privado liberado ou
  conta admin.
- **Impacto:** enumeração de portas/serviços internos, acesso protocolar a
  localhost, containers e endpoints de metadata compatíveis.
- **Perda de dados / indisponibilidade / exploração remota:** possível /
  possível / sim, autenticada.
- **Usuário/perfil afetado:** servidor e serviços da instalação; demais
  tenants.
- **Reprodução segura:** testar somente a função com tabela de IPs e mocks de
  `PortChecker`; não sondar a rede real.
- **Correção recomendada:** allowlist de sub-redes de câmeras por instalação,
  negar loopback/link-local/metadata/control-plane e limitar portas/protocolos.
- **Testes recomendados:** IPv4/IPv6, Docker, metadata, ranges configurados,
  rebinding e cada endpoint/chamador.
- **Arquivos relacionados:** DTOs de câmera, ONVIF/PTZ, port checker.
- **Dependências da correção:** regra de negócio para redes legítimas/WAN.
- **Risco de regressão:** alto para instalações com câmeras em sub-redes
  diversas.
- **Possibilidade de falso positivo:** baixa para capacidade de varredura;
  alcance de dados depende do protocolo do serviço alvo.

## DRAC-AUD-004 — Estado RESTRICTED é burlado por ZIP e clip exportado

- **Categoria / severidade / confiança / status:** autorização por recurso;
  ALTA; CONFIRMADO; ABERTO.
- **Subsistema:** playback/exportação.
- **Arquivo / linhas:** `apps/api/src/recordings/recordings.controller.ts:603-647,744-766`;
  `apps/api/src/access-control/access-control.service.ts:211-237`.
- **Código relacionado:** `createDownloadBatchToken`,
  `downloadRecordingsZip`, `downloadExportedClip`, `canPlaybackCamera`.
- **Descrição:** a regra declara que `RESTRICTED` mantém live e corta
  histórico/exportação. Os três pontos de ZIP/clip usam somente
  `assertCanViewCamera`.
- **Evidência:** download individual usa corretamente playback nas linhas
  588-600; lote e clip divergem. Teste de grupo prova `canView=true` e
  `canPlayback=false`.
- **Cenário necessário:** operador com `exportEvidence`, grupo `RESTRICTED` e
  IDs de gravação/clip acessíveis.
- **Impacto:** cliente bloqueado continua extraindo acervo.
- **Perda de dados / indisponibilidade / exploração remota:** não / não / sim,
  autenticada.
- **Usuário/perfil afetado:** operador/viewer de grupo restrito e provedor.
- **Reprodução segura:** controller com services fake: `canView` permite e
  `canPlayback` lança; provar que rotas atuais não chamam o segundo.
- **Correção recomendada:** usar `assertCanPlaybackCamera` na emissão e consumo
  do ZIP e no download de clip.
- **Testes recomendados:** ACTIVE/RESTRICTED/SUSPENDED, admin, câmera privada e
  revogação entre emissão/consumo.
- **Arquivos relacionados:** `access-matrix.test.ts`,
  `group-access-block.test.ts`.
- **Dependências da correção:** nenhuma além da regra já documentada.
- **Risco de regressão:** baixo a médio; clientes bloqueados perderão acesso
  que hoje ocorre por bug.
- **Possibilidade de falso positivo:** baixa; testes/comentários estabelecem a
  regra contrária.

## DRAC-AUD-005 — Sessões da Central sobrevivem a delete/troca de senha

- **Categoria / severidade / confiança / status:** autenticação/revogação;
  ALTA; CONFIRMADO; ABERTO.
- **Subsistema:** Central.
- **Arquivo / linhas:** `apps/central/src/server.js:467-485,1780-1808`.
- **Código relacionado:** `getAuthenticatedUser`, `handleUpsertUser`,
  `handleDeleteUser`.
- **Descrição:** autenticação aceita qualquer sessão não expirada sem
  consultar `db.users`; update/delete não removem sessões do e-mail.
- **Evidência:** delete remove somente `db.users[email]`; a sessão continua
  retornando papel ADMIN por até 8h.
- **Cenário necessário:** usuário Central já logado e depois removido ou com
  senha trocada por outro admin.
- **Impacto:** acesso administrativo persiste após revogação esperada.
- **Perda de dados / indisponibilidade / exploração remota:** possível /
  possível / sim, com sessão previamente válida/roubada.
- **Usuário/perfil afetado:** administradores Central e instalações geridas.
- **Reprodução segura:** teste com DB em memória, criar sessão, excluir usuário
  e chamar `getAuthenticatedUser`.
- **Correção recomendada:** revogar todas as sessões no update/delete e
  revalidar usuário ativo a cada request ou usar `authVersion`.
- **Testes recomendados:** delete, troca de senha, conta desativada, builtin
  admin e múltiplas sessões.
- **Arquivos relacionados:** login/logout/me e datastore session mappers.
- **Dependências da correção:** definir política de revogação para admin
  builtin.
- **Risco de regressão:** baixo; usuários precisarão relogar após mudança.
- **Possibilidade de falso positivo:** baixa.

## DRAC-AUD-006 — Rollback de update restaura DB com aplicação ativa e engole falhas

- **Categoria / severidade / confiança / status:** atualização/recuperação;
  ALTA; ALTO; ABERTO.
- **Subsistema:** script operacional.
- **Arquivo / linhas:** `scripts/update-drac.sh:28-65,95-119`.
- **Código relacionado:** `rollback`, trap `ERR`, migration e healthcheck.
- **Descrição:** após subir API/web novos e aplicar migration, uma falha chama
  `pg_restore --clean` sem parar a API. Todos os passos do rollback usam
  `|| true`, mas a mensagem final afirma sucesso.
- **Evidência:** ordem objetiva do script; serviços só são reconstruídos após a
  restauração concorrente.
- **Cenário necessário:** health/readiness ou migration falha depois de `up`.
- **Impacto:** writes concorrentes, restore parcial, schema/código mistos e
  falsa indicação de recuperação.
- **Perda de dados / indisponibilidade / exploração remota:** sim / sim / não
  diretamente.
- **Usuário/perfil afetado:** toda a instalação durante atualização.
- **Reprodução segura:** laboratório descartável com API gerando writes e
  healthcheck forçado a falhar.
- **Correção recomendada:** quiesce/maintenance, validar dump, restaurar banco
  isolado ou recriado, verificar cada passo e falhar alto se rollback falhar.
- **Testes recomendados:** falha em build, migration, health, restore e
  interrupção por sinal.
- **Arquivos relacionados:** `verify-backup-restore.sh`,
  `production-readiness.sh`.
- **Dependências da correção:** janela de manutenção e estratégia de migration
  backward-compatible.
- **Risco de regressão:** alto no updater.
- **Possibilidade de falso positivo:** baixa na ordem; corrupção efetiva
  depende de tráfego/tipo da migration.

## DRAC-AUD-007 — Restore limpa banco antes de validação integral e sem rollback

- **Categoria / severidade / confiança / status:** restore/perda de dados;
  ALTA; ALTO; ABERTO.
- **Subsistema:** script operacional.
- **Arquivo / linhas:** `scripts/restore-drac.sh:20-64`.
- **Código relacionado:** seleção do dump, `pg_restore --clean`, extração de
  storage e healthchecks.
- **Descrição:** existência do arquivo é a única validação antes de `--clean`.
  Dump incompatível/corrompido pode falhar depois de remover objetos. Não há
  snapshot atual nem restauração automática; storage e DB são aplicados
  sequencialmente.
- **Evidência:** o verificador em banco temporário existe em outro script, mas
  não é invocado.
- **Cenário necessário:** dump inválido, erro de I/O/schema, archive de storage
  ruim ou healthcheck posterior falho.
- **Impacto:** banco parcialmente restaurado, downtime e divergência
  banco/storage.
- **Perda de dados / indisponibilidade / exploração remota:** sim / sim / não,
  salvo arquivo malicioso fornecido ao operador.
- **Usuário/perfil afetado:** toda a instalação.
- **Reprodução segura:** container Postgres descartável com dump truncado e
  dados sentinela.
- **Correção recomendada:** validar/restaurar em DB temporário, criar backup do
  alvo, fazer cutover transacional/atômico e planejar rollback conjunto de
  storage.
- **Testes recomendados:** dump truncado, versão incompatível, storage ausente,
  falha pós-restore e rollback.
- **Arquivos relacionados:** `scripts/verify-backup-restore.sh`,
  `infra/verify-postgres-backup.sh`.
- **Dependências da correção:** espaço duplicado e janela operacional.
- **Risco de regressão:** alto no procedimento de emergência.
- **Possibilidade de falso positivo:** baixa; falha parcial do `pg_restore` é
  cenário conhecido, embora não reproduzido aqui.

## DRAC-AUD-008 — installerToken da Central é reutilizável indefinidamente

- **Categoria / severidade / confiança / status:** segredo/capability URL;
  ALTA; CONFIRMADO; ABERTO.
- **Subsistema:** Central/provisionamento.
- **Arquivo / linhas:** `apps/central/src/server.js:437-455,1097-1135,1139-1169`.
- **Código relacionado:** `buildInstallerResponse`,
  `handleGetInstallerCommand`, `handleQuickInstaller`.
- **Descrição:** token é criado uma vez, persistido e aceito sem `expiresAt`,
  consumo único ou rotação. O download devolve script com licença.
- **Evidência:** visualizações reutilizam `item.installerToken`; handler apenas
  compara igualdade e registra auditoria.
- **Cenário necessário:** URL vaza em histórico do shell, chat, log, browser ou
  backup.
- **Impacto:** recuperação permanente do instalador/credencial de uma
  instalação.
- **Perda de dados / indisponibilidade / exploração remota:** possível /
  possível / sim.
- **Usuário/perfil afetado:** instalação correspondente e operador Central.
- **Reprodução segura:** dois GETs consecutivos em servidor de teste com mesmo
  token, sem executar o script.
- **Correção recomendada:** TTL curto, uso único, hash em repouso, rotação e
  revogação explícita; não embutir licença duradoura.
- **Testes recomendados:** expiração, replay, consumo concorrente, rotação e
  auditoria sem segredo.
- **Arquivos relacionados:** signing backup e README Central.
- **Dependências da correção:** UX de reprovisionamento.
- **Risco de regressão:** médio para links já emitidos.
- **Possibilidade de falso positivo:** baixa.

## DRAC-AUD-009 — `/central/` aponta para serviço ausente no Compose

- **Categoria / severidade / confiança / status:** deploy/disponibilidade;
  ALTA; CONFIRMADO; ABERTO.
- **Subsistema:** Central, Nginx e Compose.
- **Arquivo / linhas:** `apps/web/nginx.conf:47-64`;
  `infra/docker-compose.yml:7-523`; `apps/central/README.md:20-25`.
- **Código relacionado:** `proxy_pass http://drac-central:9765/`.
- **Descrição:** nenhum Compose define `drac-central`. O README sugere
  `docker run ... -p 9765:9765` sem nome/rede que resolvam o hostname do proxy.
- **Evidência:** busca em todos os YAMLs encontra somente backup de dados da
  Central, não o serviço.
- **Cenário necessário:** deploy padrão e acesso a `/central/`.
- **Impacto:** 502/DNS failure; Central não integrada ao TLS/caminho prometido.
- **Perda de dados / indisponibilidade / exploração remota:** não / sim / não.
- **Usuário/perfil afetado:** administradores Central.
- **Reprodução segura:** `docker compose config`/teste estático que exige
  destino para cada `proxy_pass`; não subir produção.
- **Correção recomendada:** declarar serviço com volume, env, healthcheck e
  rede, ou remover proxy e documentar reverse proxy externo coerente.
- **Testes recomendados:** smoke `/central/api/health` no Compose prod.
- **Arquivos relacionados:** Dockerfile Central, compose prod e instalador.
- **Dependências da correção:** política de dados/segredos da Central.
- **Risco de regressão:** médio.
- **Possibilidade de falso positivo:** baixa para Compose entregue; pode haver
  orquestração externa não versionada.

## DRAC-AUD-010 — Admin pode PTZ/relé/gravar câmera privada alheia

- **Categoria / severidade / confiança / status:** privacidade/autorização;
  ALTA; CONFIRMADO; ABERTO.
- **Subsistema:** access control, PTZ, IA e gravação.
- **Arquivo / linhas:** `apps/api/src/access-control/access-control.service.ts:157-203,240-255`;
  `apps/api/src/ptz/ptz.controller.ts:23-142`;
  `apps/api/src/recordings/recordings.controller.ts:76-108`.
- **Código relacionado:** `hasLevel`, `canControlCamera`, `canRecordCamera`,
  comandos PTZ/relé e start/stop recording.
- **Descrição:** `canViewCamera` inverte privilégio em privada, mas control e
  record chamam `hasLevel`, que retorna `true` imediatamente para admin. Isso
  autoriza movimento físico, acionamento de relé e mudança de gravação.
- **Evidência:** schema limita conteúdo privado e enumera gerenciamento técnico,
  não PTZ/relé; matriz testa `canAdmin=true`, mas não control/record.
- **Cenário necessário:** ADMIN/SUPER_ADMIN autenticado e câmera privada de
  terceiro.
- **Impacto:** intrusão física/privacidade e alteração da coleta de evidência.
- **Perda de dados / indisponibilidade / exploração remota:** possível /
  possível / sim, autenticada.
- **Usuário/perfil afetado:** dono da câmera privada.
- **Reprodução segura:** service/controller mocks, sem conectar a câmera,
  provando `canView=false`, `canControl=true`, `canRecord=true`.
- **Correção recomendada:** exigir `canViewCamera` como pré-condição para
  control/record, preservando `canAdmin` apenas para gestão técnica explícita.
- **Testes recomendados:** owner/delegado/admin em PTZ, relé, gravação e IA.
- **Arquivos relacionados:** `access-matrix.test.ts`, schema Prisma e
  `cameras.controller.ts`.
- **Dependências da correção:** confirmar se algum gerenciamento legítimo exige
  start de gravação sem visualizar.
- **Risco de regressão:** médio.
- **Possibilidade de falso positivo:** baixa para capability; a classificação
  de start recording como conteúdo requer decisão de negócio, PTZ/relé não.

## DRAC-AUD-011 — Permissão de câmera não tem unicidade no banco

- **Categoria / severidade / confiança / status:** concorrência/integridade de
  autorização; MÉDIA; ALTO; ABERTO.
- **Subsistema:** Prisma e camera-permissions.
- **Arquivo / linhas:** `apps/api/prisma/schema.prisma:512-526`;
  `apps/api/src/camera-permissions/camera-permissions.service.ts:85-129,146-150`.
- **Código relacionado:** check-then-create de `grant` e `remove` por ID.
- **Descrição:** não há unique para `(userId,cameraId)` ou
  `(userId,groupId)`. Grants concorrentes podem criar duas linhas; revoke
  remove uma e deixa autorização residual.
- **Evidência:** schema contém somente índices; `findFirst` e `create` não
  estão em transação/constraint.
- **Cenário necessário:** duas concessões concorrentes/retry ou duplicata
  histórica.
- **Impacto:** revogação incompleta, níveis ambíguos e listas duplicadas.
- **Perda de dados / indisponibilidade / exploração remota:** não / não /
  possível por corrida autenticada.
- **Usuário/perfil afetado:** usuários cuja permissão é alterada.
- **Reprodução segura:** Postgres efêmero, barreira entre dois `grant`, depois
  remover apenas um ID.
- **Correção recomendada:** constraints parciais únicas ou chave canônica,
  migration de dedupe consciente e `upsert`.
- **Testes recomendados:** grant concorrente, níveis distintos, revoke e
  migration.
- **Arquivos relacionados:** migration inicial de permissões, access control.
- **Dependências da correção:** regra para escolher nível em duplicatas.
- **Risco de regressão:** médio na limpeza de dados.
- **Possibilidade de falso positivo:** baixa estruturalmente; exige
  concorrência/dado existente para manifestar.

## DRAC-AUD-012 — ownerUserId de câmera privada não possui FK

- **Categoria / severidade / confiança / status:** integridade referencial;
  MÉDIA; ALTO; ABERTO.
- **Subsistema:** Prisma/câmeras/usuários.
- **Arquivo / linhas:** `apps/api/prisma/schema.prisma:126-145`;
  migration `20260723160000_add_private_camera/migration.sql:1-4`.
- **Código relacionado:** `Camera.ownerUserId`.
- **Descrição:** proprietário é `String?` sem relation/foreign key. Permissões
  do usuário têm cascade, mas a câmera pode manter ID de usuário excluído.
- **Evidência:** schema e migration adicionam apenas coluna/índice.
- **Cenário necessário:** excluir usuário que possui câmera privada.
- **Impacto:** câmera/conteúdo órfão, dono inexistente e política de acesso
  incoerente.
- **Perda de dados / indisponibilidade / exploração remota:** lógica, sim /
  parcial / não.
- **Usuário/perfil afetado:** dono/delegados/admin.
- **Reprodução segura:** teste de schema em Postgres efêmero com delete de
  owner e consulta posterior.
- **Correção recomendada:** relação com política explícita `Restrict`,
  `SetNull` + workflow de transferência, ou cascade aprovado.
- **Testes recomendados:** delete/transferência e acessos após cada política.
- **Arquivos relacionados:** users service, cameras service e access control.
- **Dependências da correção:** decisão de negócio sobre propriedade.
- **Risco de regressão:** alto em dados existentes.
- **Possibilidade de falso positivo:** baixa para ausência de FK; impacto
  depende do fluxo de exclusão.

## DRAC-AUD-013 — Redis indisponível pode prender bootstrap da API

- **Categoria / severidade / confiança / status:** disponibilidade;
  MÉDIA; ALTO; PRECISA DE AMBIENTE.
- **Subsistema:** BullMQ/Compose/API.
- **Arquivo / linhas:** `apps/api/src/jobs/jobs.module.ts:38-45,59-104`;
  `infra/docker-compose.yml:253-262`.
- **Código relacionado:** `JobsModule.onModuleInit` e três `Queue.add` com
  `await`.
- **Descrição:** bootstrap depende de registrar repeat jobs. A conexão não tem
  prazo/fail-fast explícito, e `depends_on` não aguarda Redis saudável.
- **Evidência:** awaits bloqueantes no lifecycle; nenhum catch/degradação e
  nenhum teste de Redis off.
- **Cenário necessário:** Redis ausente/lento durante boot ou reconexão.
- **Impacto:** API não fica ready/healthy; restart pode permanecer pendente.
- **Perda de dados / indisponibilidade / exploração remota:** não diretamente /
  sim / possível como DoS se Redis for afetado.
- **Usuário/perfil afetado:** todos.
- **Reprodução segura:** Compose efêmero, Redis blackhole e prazo externo;
  observar bootstrap sem produção.
- **Correção recomendada:** política explícita fail-fast com exit/restart ou
  startup degradado, timeout e health detalhado.
- **Testes recomendados:** Redis refused/blackhole/recovery e repeat jobs
  idempotentes.
- **Arquivos relacionados:** processors, health service, Compose.
- **Dependências da correção:** decidir se API pode operar sem filas.
- **Risco de regressão:** médio.
- **Possibilidade de falso positivo:** média até medir comportamento da versão
  BullMQ/ioredis no ambiente.

## DRAC-AUD-014 — JWT web de 8h fica acessível a JavaScript

- **Categoria / severidade / confiança / status:** sessão web/XSS;
  MÉDIA; CONFIRMADO; ABERTO.
- **Subsistema:** web, auth e Nginx.
- **Arquivo / linhas:** `apps/web/src/store/authStore.ts:70-103,119-122`;
  `apps/api/src/auth/auth.module.ts:30-37`;
  `apps/web/nginx.conf:14-39`.
- **Código relacionado:** `persistSession`, `TOKEN_STORAGE_KEY`, CSP.
- **Descrição:** access token é salvo em `localStorage`; TTL default é 8h. CSP
  não possui `default-src`/`script-src`, logo qualquer XSS futuro pode
  exfiltrá-lo.
- **Evidência:** chamadas diretas a `window.localStorage.setItem`; token é
  bearer, não cookie HttpOnly.
- **Cenário necessário:** XSS, extensão maliciosa ou JavaScript terceiro
  comprometido.
- **Impacto:** sequestro de sessão até expiração/revogação do usuário.
- **Perda de dados / indisponibilidade / exploração remota:** possível /
  possível / sim, condicionada a execução de script.
- **Usuário/perfil afetado:** qualquer usuário web, inclusive admin.
- **Reprodução segura:** teste de unidade/JSDOM confirma leitura do token;
  nenhuma exfiltração real.
- **Correção recomendada:** cookie HttpOnly/Secure/SameSite ou token apenas em
  memória com refresh cookie rotativo; CSP estrito com nonce/hash.
- **Testes recomendados:** refresh, logout/revogação, CSRF e CSP report-only.
- **Arquivos relacionados:** auth service/controller, API base.
- **Dependências da correção:** contrato de autenticação web e proxy TLS.
- **Risco de regressão:** alto no login.
- **Possibilidade de falso positivo:** baixa para exposição; não foi
  confirmado XSS explorável atual.

## DRAC-AUD-015 — Produção de IA executa fonte bind-mounted, não imagem imutável

- **Categoria / severidade / confiança / status:** integridade de deploy;
  MÉDIA; CONFIRMADO; ABERTO.
- **Subsistema:** IA/Compose.
- **Arquivo / linhas:** `infra/docker-compose.yml:325-336,430-433`;
  `infra/docker-compose.prod.yml:1-24`.
- **Código relacionado:** volume `../services/ai-service-python:/app`.
- **Descrição:** mount base sobrepõe todo `/app` copiado pelo Dockerfile. O
  override prod não o remove; checkout do host vira código executado.
- **Evidência:** merge de Compose preserva volumes base.
- **Cenário necessário:** deploy prod oficial e alteração/incompletude do
  checkout host.
- **Impacto:** drift entre imagem testada e runtime, restart com código parcial,
  escrita acidental no fonte e supply chain ampliada.
- **Perda de dados / indisponibilidade / exploração remota:** possível /
  possível / indireta.
- **Usuário/perfil afetado:** análise IA e gravação por eventos.
- **Reprodução segura:** `docker compose config` e inspeção de mounts, sem
  iniciar container.
- **Correção recomendada:** mover bind de fonte para override dev; produção
  monta apenas modelos/storage necessários, preferencialmente read-only.
- **Testes recomendados:** smoke da revisão da imagem e assert de mounts prod.
- **Arquivos relacionados:** Dockerfile/Dockerfile.gpu e installer.
- **Dependências da correção:** fluxo de modelos e hot development.
- **Risco de regressão:** médio.
- **Possibilidade de falso positivo:** baixa.

## DRAC-AUD-016 — Serialização da Central não protege múltiplas instâncias

- **Categoria / severidade / confiança / status:** concorrência/dados;
  MÉDIA; ALTO; PRECISA DE AMBIENTE.
- **Subsistema:** Central datastore.
- **Arquivo / linhas:** `apps/central/src/server.js:217-223,2177-2189,2213-2228`;
  `apps/central/src/datastore/pg-store.js:158-193`.
- **Código relacionado:** `_dbGate`, load-modify-`writeAll`.
- **Descrição:** o gate é memória local. Duas instâncias carregam snapshots
  independentes; cada `writeAll` upserta e deleta tudo que falta, sem versão ou
  lock global. JSON também usa rename sem CAS cross-process.
- **Evidência:** nenhuma advisory lock/version/serializable transaction envolve
  load + mutate + save.
- **Cenário necessário:** duas Central apontando para o mesmo JSON/PG ou overlap
  com outro writer.
- **Impacto:** heartbeat, sessão, auditoria, licença ou usuário perdido por
  last-writer-wins.
- **Perda de dados / indisponibilidade / exploração remota:** sim / possível /
  não diretamente.
- **Usuário/perfil afetado:** admins e instalações.
- **Reprodução segura:** duas instâncias/objects datastore efêmeros,
  sincronizando loads antes de saves distintos.
- **Correção recomendada:** operações incrementais transacionais, optimistic
  version/CAS ou advisory lock; declarar singleton até corrigir.
- **Testes recomendados:** concorrência cross-process em JSON e PG.
- **Arquivos relacionados:** datastore index/dual-read e testes.
- **Dependências da correção:** modelo de persistência.
- **Risco de regressão:** alto em refactor de datastore.
- **Possibilidade de falso positivo:** média no deploy atual singleton; foi
  descartado para concorrência dentro de um processo.

## DRAC-AUD-017 — Exposição direta da Central permite forjar IP de auditoria/rate limit

- **Categoria / severidade / confiança / status:** proxy/rate limiting;
  MÉDIA; ALTO; PRECISA DE AMBIENTE.
- **Subsistema:** Central.
- **Arquivo / linhas:** `apps/central/src/server.js:29-51,339-361,1219-1228`;
  `apps/central/README.md:20-25,176-180`.
- **Código relacionado:** `clientIp`, `loginAttemptKey`, `loginAttempts`.
- **Descrição:** implementação efetiva confia cegamente em `X-Real-IP`. O Nginx
  fornecido sobrescreve o header, mas o README publica `9765` diretamente e o
  host default é `0.0.0.0`. Nesse modo, atacante rotaciona o header e o bucket.
- **Evidência:** mapa é por `clientIp:email` e fica em memória.
- **Cenário necessário:** porta Central diretamente acessível sem proxy
  confiável que remova/sobrescreva o header.
- **Impacto:** brute force menos limitado e auditoria com IP forjado.
- **Perda de dados / indisponibilidade / exploração remota:** possível /
  possível / sim.
- **Usuário/perfil afetado:** admins Central.
- **Reprodução segura:** request fake com dois `X-Real-IP` em servidor de teste
  e inspeção das chaves; não brute-forcear credencial real.
- **Correção recomendada:** confiar header apenas por allowlist/hops de proxy,
  usar socket em exposição direta e rate limit compartilhado.
- **Testes recomendados:** proxy confiável/não confiável, IPv6, restart e
  múltiplas instâncias.
- **Arquivos relacionados:** Nginx web e configuração allowed origins.
- **Dependências da correção:** topologia oficial de publicação.
- **Risco de regressão:** baixo a médio.
- **Possibilidade de falso positivo:** alta atrás do Nginx fornecido; por isso
  status depende do ambiente.

## DRAC-AUD-018 — Build-agent sem timeout bloqueia fila global da Central

- **Categoria / severidade / confiança / status:** disponibilidade;
  MÉDIA; CONFIRMADO; ABERTO.
- **Subsistema:** Central/app builder.
- **Arquivo / linhas:** `apps/central/src/server.js:1186-1205,1337-1349,2177-2222`.
- **Código relacionado:** `agentFetch`, `runSerialized`.
- **Descrição:** `fetch` do agent não recebe `AbortSignal`. Como rotas `/api/`
  são serializadas globalmente, conexão aceita que nunca responde impede
  heartbeat, login e administração seguintes.
- **Evidência:** `artifactFetch` logo abaixo usa 15s, mostrando a omissão; o
  gate aguarda a Promise.
- **Cenário necessário:** build-agent blackhole/travado.
- **Impacto:** indisponibilidade total da Central apesar do processo vivo.
- **Perda de dados / indisponibilidade / exploração remota:** não / sim /
  indireta por agente comprometido.
- **Usuário/perfil afetado:** todos os clientes/admins Central.
- **Reprodução segura:** servidor TCP local que aceita e não responde, com
  AbortSignal externo no teste.
- **Correção recomendada:** timeout/abort, separar rotas longas da seção crítica
  e persistir job assíncrono.
- **Testes recomendados:** blackhole, reset de conexão, resposta grande e
  concorrência com heartbeat.
- **Arquivos relacionados:** build-agent mobile e artifact fetch.
- **Dependências da correção:** contrato de job/polling.
- **Risco de regressão:** médio.
- **Possibilidade de falso positivo:** baixa.

## DRAC-AUD-019 — Symlink sob storage escapa da raiz lexical

- **Categoria / severidade / confiança / status:** path traversal/filesystem;
  MÉDIA; ALTO; ABERTO.
- **Subsistema:** gravações/retenção/download.
- **Arquivo / linhas:** `apps/api/src/recordings/helpers/safe-file.helper.ts:1-13`;
  diversos chamadores em `recordings.service.ts` e `retention.service.ts`.
- **Código relacionado:** `ensureFileUnderRoot`.
- **Descrição:** `resolve/startsWith` bloqueia `..`, mas não resolve
  `realpath`/symlinks. Um link dentro da raiz pode apontar para arquivo externo
  que será lido, enviado ou removido.
- **Evidência:** helper não usa `lstat`, `realpath` ou `O_NOFOLLOW`; testes só
  cobrem prefixo lexical.
- **Cenário necessário:** capacidade prévia de criar/substituir symlink no
  volume (host, worker comprometido ou restore malicioso).
- **Impacto:** leitura/deleção fora do storage.
- **Perda de dados / indisponibilidade / exploração remota:** sim / possível /
  não sem primitiva de filesystem.
- **Usuário/perfil afetado:** host e todos os usuários.
- **Reprodução segura:** raiz temporária e symlink para arquivo sentinela
  temporário.
- **Correção recomendada:** `lstat/realpath` de raiz/alvo, negar componentes
  symlink e usar abertura segura por descriptor quando possível.
- **Testes recomendados:** symlink de arquivo/diretório, troca TOCTOU e
  deleção/download.
- **Arquivos relacionados:** disk scan, restore storage e registro interno.
- **Dependências da correção:** compatibilidade de filesystem.
- **Risco de regressão:** médio.
- **Possibilidade de falso positivo:** média quanto à explorabilidade remota;
  bypass lexical por symlink é real.

## DRAC-AUD-020 — Worker Go opt-in fica unhealthy e pode travar sem timeout

- **Categoria / severidade / confiança / status:** legacy/disponibilidade;
  MÉDIA; CONFIRMADO; ABERTO.
- **Subsistema:** camera-worker Go.
- **Arquivo / linhas:** `infra/docker-compose.yml:296-323`;
  `services/camera-worker-go/main.go:103-177`;
  `services/camera-worker-go/recorder.go:125-150`.
- **Código relacionado:** healthcheck, `fetchCameras`, loop e `exec.Command`.
- **Descrição:** Compose testa HTTP `:8000/health`, mas o binário não cria
  servidor. Cliente da API não tem timeout e gravação FFmpeg não usa
  `CommandContext`/sinal de shutdown.
- **Evidência:** busca integral nos cinco arquivos Go não encontra listener
  HTTP; `http.Client{}` e `exec.Command` são explícitos.
- **Cenário necessário:** profile `legacy-worker`; API blackhole ou FFmpeg
  travado.
- **Impacto:** container sempre unhealthy, loop/goroutine presa e shutdown
  lento; gravação legado afetada.
- **Perda de dados / indisponibilidade / exploração remota:** possível /
  parcial / não diretamente.
- **Usuário/perfil afetado:** instalações que habilitam modo worker legado.
- **Reprodução segura:** teste unitário/HTTP blackhole com timeout externo;
  não iniciar gravação real.
- **Correção recomendada:** remover profile se não suportado ou implementar
  health/readiness, timeouts, context e signal handling.
- **Testes recomendados:** healthcheck, API blackhole, SIGTERM e FFmpeg preso.
- **Arquivos relacionados:** Dockerfile/go.mod e recording mode da API.
- **Dependências da correção:** decidir suporte ao worker.
- **Risco de regressão:** baixo no runtime padrão, alto para usuários legacy.
- **Possibilidade de falso positivo:** baixa quando o profile é habilitado.

## DRAC-AUD-022 — Containers ativos executam como root sem redução de privilégios

- **Categoria / severidade / confiança / status:** hardening/isolamento;
  MÉDIA; CONFIRMADO; ABERTO.
- **Subsistema:** Docker.
- **Arquivo / linhas:** `apps/api/Dockerfile:25-41`,
  `apps/central/Dockerfile:1-16`,
  `services/ai-service-python/Dockerfile:1-37`,
  `services/camera-worker-go/Dockerfile:15-25`.
- **Código relacionado:** ausência de `USER`, `read_only`, `cap_drop` e
  `no-new-privileges`.
- **Descrição:** processos que analisam mídia/rede não confiável rodam como
  root do container; API/IA escrevem em bind mounts do host.
- **Evidência:** Dockerfiles não trocam UID e Compose não impõe hardening.
- **Cenário necessário:** exploração de FFmpeg, runtime, dependência ou código
  da aplicação.
- **Impacto:** maior alcance dentro do container/volumes e maior impacto de
  container escape.
- **Perda de dados / indisponibilidade / exploração remota:** sim / sim /
  condicionada a outra vulnerabilidade.
- **Usuário/perfil afetado:** host/instalação.
- **Reprodução segura:** inspeção estática ou `docker image inspect` em CI.
- **Correção recomendada:** usuários dedicados, ownership mínimo, read-only
  rootfs, tmpfs e capabilities mínimas.
- **Testes recomendados:** gravação/modelos/FFmpeg sob UID não-root.
- **Arquivos relacionados:** Compose volumes e MediaMTX.
- **Dependências da correção:** permissões de storage/modelos.
- **Risco de regressão:** alto em permissões de arquivos.
- **Possibilidade de falso positivo:** média como vulnerabilidade isolada; é
  defesa em profundidade.

## DRAC-AUD-023 — Cookie Secure da Central é desativado por padrão

- **Categoria / severidade / confiança / status:** sessão/TLS; BAIXA;
  CONFIRMADO; PRECISA DE AMBIENTE.
- **Subsistema:** Central.
- **Arquivo / linhas:** `apps/central/src/server.js:324-330`;
  `apps/central/README.md:45,176`.
- **Código relacionado:** `DRAC_CENTRAL_COOKIE_SECURE`.
- **Descrição:** cookie é HttpOnly/SameSite, mas só recebe `Secure` se env for
  explicitamente `true`; a documentação delega a configuração ao operador.
- **Evidência:** default literal `false`.
- **Cenário necessário:** publicação HTTPS sem flag ou acesso HTTP/downgrade.
- **Impacto:** cookie pode ser enviado por canal não TLS no host.
- **Perda de dados / indisponibilidade / exploração remota:** possível / não /
  possível em rede.
- **Usuário/perfil afetado:** admin Central.
- **Reprodução segura:** testar header `Set-Cookie` com env ausente em servidor
  local.
- **Correção recomendada:** default seguro em produção, inferência confiável de
  HTTPS e fail-fast quando URL pública HTTPS não combina.
- **Testes recomendados:** HTTP dev, HTTPS proxy, prefixo `/central`.
- **Arquivos relacionados:** Nginx e public URL.
- **Dependências da correção:** topologia TLS.
- **Risco de regressão:** médio em desenvolvimento HTTP.
- **Possibilidade de falso positivo:** alta quando o env já está correto.

## DRAC-AUD-024 — Mobile não protege telas sensíveis contra captura

- **Categoria / severidade / confiança / status:** privacidade mobile; BAIXA;
  MÉDIO; PRECISA DE REGRA DE NEGÓCIO.
- **Subsistema:** Expo/Android.
- **Arquivo / linhas:** `apps/mobile/App.tsx:1-1400`;
  `apps/mobile/app.base.json:55-72`.
- **Código relacionado:** telas live/playback/review; plugins Android.
- **Descrição:** não há `expo-screen-capture`/`FLAG_SECURE` nem blur explícito
  para app switcher em telas com vídeo privado.
- **Evidência:** busca no mobile não encontrou as APIs; configuração lista
  plugins/permissões sem essa proteção.
- **Cenário necessário:** usuário/terceiro tira screenshot ou o sistema captura
  preview recente.
- **Impacto:** cópia local não auditada de imagem/vídeo sensível.
- **Perda de dados / indisponibilidade / exploração remota:** vazamento, não /
  não / não.
- **Usuário/perfil afetado:** donos e pessoas filmadas.
- **Reprodução segura:** aparelho de teste com câmera sintética.
- **Correção recomendada:** decidir por tela; ativar proteção em live/playback
  privado e blur no background, com aviso de UX.
- **Testes recomendados:** Android/iOS screenshot e recent-app snapshot.
- **Arquivos relacionados:** telas redesign/live e app lifecycle.
- **Dependências da correção:** regra LGPD/uso operacional.
- **Risco de regressão:** médio para compartilhamento/suporte.
- **Possibilidade de falso positivo:** alta; screenshots podem ser recurso
  aceito pelo produto.

## DRAC-AUD-025 — google-services.json versionado não foi tratado como segredo privado

- **Categoria / severidade / confiança / status:** inventário de segredo;
  INFORMATIVA; MÉDIO; DESCARTADO.
- **Subsistema:** mobile/Firebase.
- **Arquivo / linhas:** `apps/mobile/google-services.json:1-fim`.
- **Código relacionado:** plugin Firebase do Expo.
- **Descrição:** arquivo cliente é versionado e pode conter identificadores/API
  key cliente. Nenhum valor foi reproduzido nesta auditoria.
- **Evidência:** `git ls-files` confirma rastreamento; não foi encontrada chave
  privada pelo nome do arquivo.
- **Cenário necessário:** restrições Firebase/API incorretas.
- **Impacto:** abuso de quota/projeto, não autenticação administrativa por si
  só.
- **Perda de dados / indisponibilidade / exploração remota:** improvável /
  possível por quota / possível se regras externas forem fracas.
- **Usuário/perfil afetado:** push/mobile.
- **Reprodução segura:** console Firebase/GCP, conferir restrições sem imprimir
  chave.
- **Correção recomendada:** restringir key a package/signing/API e auditar
  regras; não mover automaticamente para segredo.
- **Testes recomendados:** App Check/regras e pacote release.
- **Arquivos relacionados:** app config e google-services de clientes.
- **Dependências da correção:** configuração externa não disponível.
- **Risco de regressão:** alto se remover arquivo necessário ao build.
- **Possibilidade de falso positivo:** alta; configuração cliente Firebase é
  normalmente pública. Por isso o achado foi descartado como vulnerabilidade.

## DRAC-AUD-026 — Migration escolhe duplicata de Recording por ctid

- **Categoria / severidade / confiança / status:** migration/integridade;
  INFORMATIVA; CONFIRMADO; ABERTO.
- **Subsistema:** Prisma/Postgres.
- **Arquivo / linhas:** `apps/api/prisma/migrations/20260501042000_recordings_indexes/migration.sql:1-9`.
- **Código relacionado:** `DELETE ... USING ... a.ctid < b.ctid`.
- **Descrição:** antes do unique por `filePath`, qualquer duplicata é removida
  por posição física, sem comparar duração, integridade ou relações.
- **Evidência:** SQL explícito.
- **Cenário necessário:** upgrade de base pré-migration contendo duplicatas.
- **Impacto:** perda de metadado da linha arbitrariamente descartada.
- **Perda de dados / indisponibilidade / exploração remota:** sim, metadado /
  não / não.
- **Usuário/perfil afetado:** instalações antigas em upgrade.
- **Reprodução segura:** banco efêmero com duas linhas sintéticas divergentes.
- **Correção recomendada:** em futuras migrations, pré-check/report, escolher
  canônica e reconciliar relações/arquivo; documentar backup.
- **Testes recomendados:** fixture de upgrade com duplicatas.
- **Arquivos relacionados:** schema `@@unique([filePath])`, updater.
- **Dependências da correção:** migration já aplicada não deve ser reescrita;
  usar nova ferramenta/gate.
- **Risco de regressão:** alto se migration histórica for alterada.
- **Possibilidade de falso positivo:** baixa para comportamento, mas alcance é
  histórico e depende de duplicatas.
