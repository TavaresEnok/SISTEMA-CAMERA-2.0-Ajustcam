# Remediação dos achados da auditoria

Data da consolidação: 2026-07-28
Branch de trabalho: `fix/auditoria-completa`
Commit de partida da implementação ampla: `ea6d31213783ee91e76bf71abc240ea175a677ad`
Estado: implementação e validação concluídas localmente; implantação em
produção ainda não realizada.

## Resultado

O inventário original contém 25 registros numerados (não existe
`DRAC-AUD-021`):

- 24 registros exigiam ação no repositório;
- 23 receberam correção funcional ou hardening direto;
- `DRAC-AUD-026` recebeu um bloqueio preventivo de upgrade, sem reescrever a
  migration histórica já distribuída;
- `DRAC-AUD-025` permanece corretamente descartado/informativo: o
  `google-services.json` é configuração de cliente e não foi demonstrado como
  credencial privada.

As evidências históricas em `docs/auditoria-codigo/` não foram reescritas. Este
documento registra o estado posterior às correções.

## Estado por achado

| ID | Estado da remediação | Resultado principal |
|---|---|---|
| DRAC-AUD-001 | implementada, requer configuração de release | Instalador pinado por commit completo, artefato HTTPS baixado em arquivo temporário, SHA-256 obrigatório comparado antes da execução, sem `curl \| bash`, sem redirect, com limpeza e auditoria. |
| DRAC-AUD-002 | implementada | Exclusão de gravações/clips usa journal durável, quarentena por rename, transação de banco, rollback e recuperação idempotente no boot. |
| DRAC-AUD-003 | implementada, requer configuração de rede | Política de egress por CIDR, IP literal, portas válidas, bloqueio explícito de loopback/link-local/metadata/reservados e produção fail-closed sem allowlist. A guarda alcança cadastro, edição, teste, preview, RTSP, ONVIF e PTZ. |
| DRAC-AUD-004 | implementada | ZIP, clips, VOD, tokens, downloads e consultas de histórico passaram a exigir o gate de playback; grupo `RESTRICTED` não extrai acervo. |
| DRAC-AUD-005 | implementada | Sessões da Central carregam versão de autenticação e são invalidadas em exclusão, troca de senha e alteração relevante do usuário. |
| DRAC-AUD-006 | implementada e validada em laboratório descartável | Update faz backup validado, constrói antes do quiesce, para writers antes da migration, usa execução isolada e mantém rollback transacional. O preflight foi testado também sem `_prisma_migrations`. |
| DRAC-AUD-007 | implementada e validada em laboratório descartável | Restore valida dump em banco descartável e archive em staging antes do alvo, cria ponto de segurança, para escritores, faz cutover por rename e restaura conjuntamente banco/storage quando o healthcheck falha. |
| DRAC-AUD-008 | implementada | Token do instalador tem apenas digest em repouso, TTL padrão de 15 minutos, no máximo três downloads, rotação, expiração, comparação timing-safe e auditoria sem bearer. |
| DRAC-AUD-009 | implementada | `drac-central` foi incluído no Compose base com healthcheck, rede, persistência e proxy coerente. |
| DRAC-AUD-010 | implementada | PTZ, relé e gravação de câmera privada exigem autorização de conteúdo. Papel global não eleva uma concessão direta `VIEW`; dono e delegados respeitam níveis explícitos. |
| DRAC-AUD-011 | implementada, requer rollout da migration | Migration normaliza alvos inválidos, deduplica pelo menor privilégio, cria check de alvo exclusivo e índices únicos parciais; corrida `P2002` vira update idempotente. |
| DRAC-AUD-012 | implementada, requer rollout da migration | `ownerUserId` possui FK `RESTRICT`; exclusão de dono é recusada até transferência transacional e auditada da câmera privada. |
| DRAC-AUD-013 | implementada | Redis/BullMQ possuem connect timeout, retries limitados, prazo para agendamento inicial e dependência Compose por health; a política adotada é fail-fast/restart. |
| DRAC-AUD-014 | implementada | Web mantém access token curto somente em memória, remove tokens legados do storage e usa refresh rotativo em cookie HttpOnly/SameSite/Secure em produção; mobile preserva o contrato por corpo. |
| DRAC-AUD-015 | implementada | Bind mount do fonte de IA existe apenas no override de desenvolvimento; produção executa o conteúdo imutável da imagem. |
| DRAC-AUD-016 | implementada | Central assume singleton explicitamente: lock de arquivo para JSON e advisory lock de sessão para PostgreSQL impedem segundo writer concorrente. |
| DRAC-AUD-017 | implementada, requer topologia configurada | Headers de IP só são aceitos de proxies em CIDRs confiáveis; conexão direta usa o endereço do socket. |
| DRAC-AUD-018 | implementada | Build-agent possui timeout/abort e limite de resposta, impedindo bloqueio ilimitado da fila da Central. |
| DRAC-AUD-019 | implementada | Acesso a arquivos resolve caminho canônico e rejeita alvo ou componente symlink fora da raiz de storage. |
| DRAC-AUD-020 | implementada | Worker Go expõe health, usa deadlines HTTP, cancelamento por contexto/sinal e `CommandContext` com timeout para FFmpeg. |
| DRAC-AUD-022 | implementada, requer smoke no host de produção | API, Web, Central, IA e worker usam usuários não-root; Compose adiciona rootfs read-only, `no-new-privileges`, `cap_drop`, `init` e tmpfs onde necessário. |
| DRAC-AUD-023 | implementada | Cookie Secure da Central passa a ser padrão em produção e o modo HTTP fica restrito ao desenvolvimento/configuração explícita. |
| DRAC-AUD-024 | implementada, requer aparelho/emulador | A decisão adotada foi proteger toda UI autenticada: captura/gravação de tela e snapshot do app switcher são bloqueados. |
| DRAC-AUD-025 | descartado/informativo, sem alteração | Nenhuma chave privada foi demonstrada; remover a configuração Firebase quebraria o build sem corrigir vulnerabilidade comprovada. Restrições Firebase/GCP continuam sendo verificação externa. |
| DRAC-AUD-026 | mitigada com bloqueio preventivo | A migration histórica não foi alterada. O updater detecta se ela ainda será aplicada e recusa prosseguir quando há `filePath` duplicado, exigindo reconciliação explícita em vez de deleção arbitrária por `ctid`. |

## Achado suplementar — segredo RTSP em `argv`

O risco sanitizado que não possuía número no inventário passa a ser identificado
neste relatório como **DRAC-AUD-027**. A correção foi implementada depois da
remediação dos 25 registros originais:

- API e worker Go não entregam mais URL autenticada diretamente no `argv` de
  FFmpeg/ffprobe;
- a URL segue por descritor herdado privado (`fd 3`) em um documento ffconcat
  mantido apenas em memória;
- opções de entrada RTSP permitidas são transportadas no mesmo documento;
- protocolo local, controles de linha, URL ausente/duplicada e opções ambíguas
  são recusados;
- o `runOnDemand` do MediaMTX lê um path interno oculto e publica num path
  público via loopback, ambos sem credencial no comando;
- o callback de autenticação do MediaMTX usa token dedicado, comparação segura
  e autoriza o worker somente em loopback e nos paths esperados;
- teste funcional inspecionou `/proc/<pid>/cmdline` com credenciais fictícias e
  confirmou ausência de usuário, senha e URL, preservando `rtsp_transport`.

## Modelo de confiança do instalador

A primeira raiz de confiança é a configuração administrativa da Central, fora
do artefato baixado:

- quem publica a versão escolhe um commit Git completo e calcula o SHA-256 do
  script aprovado;
- o operador autorizado grava o par
  `DRAC_CENTRAL_INSTALLER_COMMIT`/`DRAC_CENTRAL_INSTALLER_SHA256` na
  configuração protegida da Central;
- a URL é derivada de um template HTTPS contendo obrigatoriamente o commit;
- o artefato e um hash oferecido pelo mesmo servidor não formam uma raiz de
  confiança; nenhum hash lateral é baixado;
- a instalação persiste o vínculo commit + URL + SHA-256 aprovado no momento da
  emissão, de modo que mudar a configuração depois não altera um comando já
  emitido;
- o bearer autoriza somente o download do wrapper, não aparece na URL nem no
  comando, expira e possui uso limitado;
- o script verificado faz checkout detached do mesmo commit e confirma `HEAD`;
- rollback usa o ponto de segurança e o commit anterior, com falha explícita se
  a recuperação não for validada.

Essa raiz resiste à troca isolada do artefato/repositório/CDN. Comprometimento
simultâneo da Central e de sua configuração continua fora do alcance de um hash
simétrico; a evolução prevista é assinatura offline do manifesto/artefato com
chave pública pinada.

## Validações executadas

Nenhum instalador foi executado. Update e restore foram executados somente em
raízes temporárias, com PostgreSQL e storage descartáveis; as ações Compose
foram interceptadas por um shim para não tocar nos serviços do DRAC.

| Verificação | Resultado |
|---|---|
| API | 748/748 testes aprovados; build TypeScript aprovado |
| Web | 109/109 testes aprovados; typecheck e build Vite aprovados |
| Mobile | 35/35 testes aprovados; typecheck aprovado |
| Central sem banco | 195 aprovados, 13 testes PostgreSQL pulados |
| Central com PostgreSQL 16 descartável | 208/208 aprovados, nenhum skip |
| Python no host | 237 descobertos: 144 aprovados e 93 pulados por dependências ML ausentes |
| Python na imagem de produção, sem rede | 237/237 aprovados, nenhum skip |
| Go 1.22 na etapa Docker | `go test -race ./...`, `go vet ./...` e build aprovados |
| Prisma | schema válido; 39 migrations aplicadas do zero. A migration nova também foi repetida sobre permissões duplicadas/ambíguas e dono órfão, normalizando os dados e ativando check, unicidade e FK. |
| Canal privado FFmpeg | Testes unitários e execução funcional aprovados; credencial fictícia ausente de `/proc/<pid>/cmdline`. |
| Update descartável | Fast-forward, dump/validação, preflight, ordem build→quiesce→migration→start e healthchecks aprovados. |
| Restore descartável | Caminho de sucesso e falha pós-cutover aprovados; no segundo, banco e storage anteriores foram restaurados automaticamente. |
| Compose | base, dev, prod e GPU renderizados com `config --quiet` |
| Shell | `bash -n` aprovado para install, update e restore |
| Imagens | API, Web, Central, IA e worker construídas; usuários finais não-root confirmados |
| Diff | `git diff --check` aprovado |

Todos os containers PostgreSQL de validação foram efêmeros, não possuíam volume
e foram removidos ao término. Nenhum serviço ou volume da instalação ativa foi
parado, recriado ou usado nos testes.

## Limitações e rollout obrigatório

O código-fonte está corrigido, mas não foi implantado. Antes de produção:

1. Publicar um commit/release aprovado e configurar o SHA-256 calculado por um
   canal independente para habilitar o instalador.
2. Configurar `CAMERA_ALLOWED_CIDRS` e, se necessário,
   `CAMERA_DENIED_CIDRS` para a VLAN real de câmeras.
3. Configurar os CIDRs de proxy confiável da Central e validar a topologia TLS.
4. Fazer backup e ensaiar a migration de permissões/proprietários numa cópia do
   banco.
5. Repetir update/restore com snapshot numa VM que replique exatamente volumes,
   proxy, filesystem e tempos da instalação de produção; os caminhos lógicos e
   rollback já passaram no laboratório descartável.
6. Validar câmera/ONVIF/RTSP, PTZ/relé, GPU/NPU e permissões dos volumes em
   hardware de laboratório.
7. Validar bloqueio de captura em Android/iOS e o fluxo de cookie em navegador
   atrás do proxy HTTPS.

`shellcheck` e `hadolint` não estavam instalados no host. Suas ausências não
foram contornadas com instalação global; sintaxe shell, builds reais e testes
estáticos específicos cobrem os caminhos alterados.

## Encerramento técnico

Não permanece correção de código conhecida e verificável dentre os 25 registros
originais nem no achado suplementar DRAC-AUD-027. O que resta é rollout:
configuração de segredos/CIDRs/proxies, publicação do commit e hash do
instalador, ensaio numa cópia representativa e validação em hardware real.
Essas etapas não podem ser simuladas como se fossem uma implantação concluída.
