# Validação do achado crítico

## DRAC-AUD-001 — Instalador remoto executa branch móvel sem verificação

| Campo | Validação |
|---|---|
| ID original | DRAC-AUD-001 |
| Título | Instalador remoto executa branch móvel sem verificação |
| Severidade original | CRÍTICA |
| Confiança original | CONFIRMADO |
| Arquivos e linhas | `apps/central/src/server.js:39-40,405-455,1097-1169,1594-1608,1626-1749`; `scripts/install-drac.sh:4-10,27-45,160-205,222-269,286-368`; `apps/central/README.md` |
| Ator | admin da Central; indiretamente, invasor que comprometa Central, conta/repositório GitHub, origem configurada ou infraestrutura de distribuição |
| Pré-condições | provisionamento quick/fallback ou SSH; conexão à origem; execução com privilégios de instalação |
| Impacto real | execução arbitrária em uma instalação e, em comprometimento upstream, comprometimento de frota; perda de dados e indisponibilidade são possíveis |
| Alcance | quick installer, fallback exibido no painel e instalação remota por SSH |
| Ambiente afetado | qualquer instalação criada com o fluxo padrão ou uma URL de instalador configurada sem verificação |
| Severidade revisada | CRÍTICA |
| Confiança revisada | CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

### Fluxo completo de execução

1. Um admin provisiona uma instalação. A Central cria licença e
   `installerToken`, persiste os valores e devolve quick URL, comando rápido e
   fallback.
2. O comando rápido faz `curl` do endpoint público
   `/install/{installationId}/{installerToken}` e envia a resposta diretamente
   ao `bash`.
3. Esse endpoint devolve outro script que executa
   `DEFAULT_INSTALLER_URL` diretamente via `curl -fsSL ... | bash`.
4. O default é
   `https://raw.githubusercontent.com/TavaresEnok/DRAC/main/scripts/install-drac.sh`.
   `main` não identifica conteúdo imutável.
5. No fluxo SSH, `buildRemoteInstallCommand` também faz o download dessa URL e
   envia os bytes diretamente ao `bash` remoto. O usuário padrão é `root`.
6. O instalador usa `sudo`/root para dependências e configuração do host, faz
   clone/pull da branch `main`, grava configuração, constrói containers e
   aplica migrations. Logo, o conteúdo remoto possui alcance privilegiado.

Não há etapa intermediária que salve o artefato, calcule digest, valide
assinatura, fixe commit/tag imutável ou peça aprovação da versão efetivamente
baixada.

### Evidência original e adicional

A evidência original — URL para `main` e dois pipelines para `bash` — foi
confirmada. A reprodução local usou:

- Central efêmera em `127.0.0.1`;
- banco JSON sintético sob `/tmp`;
- origem configurada como `http://127.0.0.1:9/mutable-installer.sh`;
- download do texto gerado, sem executar qualquer linha.

Resultado objetivo:

- provisionamento: HTTP 201;
- dois downloads do mesmo quick installer: HTTP 200/200;
- script idêntico nos dois downloads;
- URL do quick installer idêntica após nova consulta administrativa;
- texto contém pipe para `bash`;
- texto contém exatamente a origem mutável configurada;
- nenhum token ou licença foi impresso.

Isso demonstra que o runtime aceita uma origem mutável e constrói a cadeia de
execução sem verificação. A reprodução não executou o instalador porque isso
não é necessário — nem seguro — para provar a transferência de confiança.

### Origem, transporte, autenticação e mutabilidade

| Propriedade | Estado atual |
|---|---|
| Origem | GitHub Raw, repositório `TavaresEnok/DRAC` |
| URL padrão | HTTPS |
| Autenticação da origem | nenhuma autenticação de artefato; confiança no TLS e no upstream |
| Branch/tag/commit | branch móvel `main` |
| Checksum | ausente |
| Assinatura | ausente |
| Manifesto/versionamento aprovado | ausente |
| Cache offline aprovado | ausente |
| Comportamento offline | `curl -f` falha e nada é executado; não há caminho de instalação offline verificado |
| Rollback do instalador | não há rollback transacional do host, banco, código e containers |

HTTPS protege o transporte naquele instante, mas não prova que o conteúdo é a
versão aprovada. Comprometimento da conta/repositório antes do download,
alteração legítima porém incompatível de `main` ou controle da variável de URL
mudam silenciosamente o programa executado.

### Token, argumentos e command injection

- O quick URL possui token aleatório e a comparação usa rotina timing-safe,
  mas o token não autentica o artefato GitHub.
- O token não expira e é reutilizável; esse é o DRAC-AUD-008.
- Valores de cliente, instalação, licença, servidor e Central passam por
  `shellQuote`. Não foi demonstrada command injection nesses valores no estado
  atual.
- Host, porta e usuário SSH controlam a conexão, não são interpolados no
  comando do instalador.
- A senha SSH é transitória e redigida do log.
- A primeira conexão SSH usa TOFU e passa a persistir fingerprint; mudanças
  posteriores abortam. Essa proteção reduz MITM SSH, mas não valida o conteúdo
  baixado após a conexão.
- O fluxo é administrativo e registra início/status, download de instalador e
  hash do texto de fallback. Ele não registra digest do artefato realmente
  baixado nem a revisão instalada.

### Modelo de ameaça

| Ameaça | Capacidade | Resultado |
|---|---|---|
| Conta GitHub/repositório comprometidos | alterar `main` | código privilegiado nas próximas instalações |
| Central comprometida/configuração alterada | mudar origem ou gerar comandos | comprometimento dirigido ou de frota |
| CDN/TLS/DNS comprometidos | fornecer bytes diferentes apesar da URL | execução se a cadeia TLS também for vencida |
| Mudança legítima incompatível de `main` | publicar código não testado para uma instalação antiga | falha parcial, migration incompatível ou indisponibilidade |
| Quick URL vazada | repetir download de script com credencial duradoura | amplifica DRAC-AUD-008; facilita reprovisionamento indevido |
| Operador enganado | copiar `curl | bash` sem ver versão | ausência de ponto de aprovação/auditoria do conteúdo |

O raio de impacto depende de quantas instalações forem provisionadas depois
da alteração. A instalação remota tem o maior impacto, pois normalmente opera
como root e a Central já possui conectividade/credencial SSH.

### Proteções existentes

- HTTPS na origem padrão;
- `curl -f` evita executar corpo de resposta HTTP com status de erro;
- autenticação administrativa para provisionamento/SSH;
- token aleatório no quick installer;
- quoting atual dos valores interpolados;
- fingerprint SSH TOFU e timeout de conexão;
- redaction da senha SSH e auditoria de início/resultado.

Essas proteções são úteis, mas nenhuma estabelece autenticidade e
imutabilidade do artefato.

### Testes existentes relacionados

A suíte da Central passou 173 testes e pulou 13 integrações Postgres. Não há
teste que rejeite URL móvel, digest incorreto, assinatura inválida, downgrade
ou divergência entre artefato aprovado e baixado.

### Possibilidade de falso positivo

Baixa. Uma exploração maliciosa exige comprometimento de uma fronteira de
confiança, mas a propriedade perigosa — bytes mutáveis executados sem
verificação — foi demonstrada. Não se trata de preferência de estilo.

## Alternativas de correção

### Alternativa A — commit imutável mais SHA-256 obrigatório

Publicar/selecionar um commit específico, baixar o arquivo primeiro, verificar
SHA-256 armazenado na Central e só então executar.

- Vantagens: mudança incremental; implementação e rollout moderados; elimina
  troca silenciosa de `main`.
- Riscos: distribuição segura do digest vira a nova raiz de confiança; não há
  identidade criptográfica do publicador; rotação e downgrade ainda precisam
  de política.
- Dificuldade: média.

### Alternativa B — release assinada e chave pública pinada

Gerar pacote/version manifest em release, assinar com chave offline ou
Sigstore/minisign/cosign, baixar pacote e assinatura, verificar localmente e
executar apenas após sucesso. O manifest deve conter versão, commit, digests,
compatibilidade mínima e política anti-downgrade.

- Vantagens: autenticidade independente do canal; auditoria clara; suporta
  mirror/offline; melhor resposta a comprometimento do repositório.
- Riscos: gestão, rotação e revogação de chaves; recuperação se a chave for
  perdida; maior mudança no pipeline.
- Dificuldade: alta.

### Alternativa C — repositório de pacotes assinado

Distribuir um pacote Debian/OCI ou bundle equivalente por repositório
assinado, com versão imutável, dependências declaradas e procedimento de
rollback. A Central apenas seleciona uma versão aprovada.

- Vantagens: usa semântica madura de instalação/upgrade/rollback; pinagem e
  inventário por versão; elimina scripts remotos ad hoc.
- Riscos: empacotamento e migração operacional maiores; compatibilidade de
  distro; banco/storage ainda exigem rollback coordenado.
- Dificuldade: alta.

### Alternativa D — Central como mirror content-addressed

A Central importa releases já assinadas, armazena por digest, libera versões
por aprovação e entrega via token curto/uso único. O host verifica
assinatura/digest antes de executar.

- Vantagens: rollout gradual, operação offline/local e auditoria de qual
  digest foi entregue a cada instalação.
- Riscos: a Central passa a ser infraestrutura de distribuição crítica;
  requer armazenamento, HA e controles de publicação rigorosos.
- Dificuldade: alta.

## Recomendação para a primeira correção

Adotar primeiro um fluxo mínimo seguro baseado em **artefato imutável,
download para arquivo, SHA-256 obrigatório e recusa de branch móvel** nos três
caminhos. Em seguida, evoluir o mesmo contrato para assinatura de release.
Essa correção deve ser um lote isolado: não misturar com refatoração do
instalador, migrations, token da Central ou atualização de dependências.

Critérios essenciais: nenhum `curl | bash`, nenhum `main`, falha fechada em
digest/assinatura, versão/digest na auditoria e teste de downgrade. Nenhuma
dessas correções foi implementada nesta etapa.

