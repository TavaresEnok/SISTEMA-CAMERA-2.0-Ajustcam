# 06 — Vantagens Defensáveis do DRAC

Esta lista inclui apenas vantagens para as quais **não foi encontrada
implementação equivalente nos repositórios e escopos inspecionados**
(os 7 concorrentes presentes localmente). Isso não é uma afirmação de que
nenhum concorrente no mercado possui o recurso — apenas que, dentro do
escopo desta auditoria, nenhum dos 7 códigos-fonte disponíveis demonstrou
mecanismo equivalente. Cada item é classificado como vantagem real e madura,
vantagem presente mas frágil, ou vantagem comercial ainda dependente de
evolução técnica — conforme evidência de teste, tratamento de erro e
integração operacional encontrada (ou não) no código.

---

## A. Vantagens reais e maduras

### A1. Controle de acesso a conteúdo com inversão de privilégio de admin para câmeras privadas
**Dimensão 5 (peso 3).** `access-control.service.ts:17-322` implementa um
gate único de autorização, aplicado no backend, que **inverte** o privilégio
padrão de administrador quando uma câmera é marcada como privada — o
próprio admin da instalação perde acesso ao conteúdo, restrito ao dono
(`schema.prisma:120-129`, campos `isPrivate`/`ownerUserId`). Esse mecanismo
é testado por uma matriz de cenários (dono/grupo/delegado/outsider/admin —
`apps/api/tests/access-matrix.test.ts`), ainda que o teste rode contra
Prisma mockado (ver ressalva na revisão adversarial, [02-dossies.md](02-dossies.md)).
Nenhum dos 7 concorrentes implementa uma inversão de privilégio equivalente:
Frigate, ZoneMinder, Viseron e Shinobi têm RBAC real backend-enforced, mas
em nenhum deles o administrador da instalação é estruturalmente impedido de
ver o conteúdo de uma câmera específica por decisão do dono. Este é o
mecanismo mais diretamente relevante para LGPD encontrado no conjunto.

### A2. App mobile nativo funcional, com armazenamento seguro de sessão e biometria
**Dimensão 6 (peso 2).** `apps/mobile/src/services/sessionStore.ts:15-33`
usa `expo-secure-store` (não `AsyncStorage` puro) com rotina de migração de
sessões legadas; `biometrics.ts` integra `expo-local-authentication`;
`notifications/expo-receipts.helper.ts` implementa fila de recibos de push
com reconciliação de tokens inválidos, testada em
`apps/api/tests/{push-delivery-state,expo-receipts,push-receipts}.test.ts`.
**Nenhum dos 7 concorrentes tem código de app mobile nativo no
repositório inspecionado** — Frigate e Viseron oferecem apenas PWA com web
push (não push nativo); Shinobi e Bluecherry mencionam apps pagos de
terceiros que não estão incluídos nos respectivos repositórios e, portanto,
não puderam ser avaliados. Esta é a vantagem mais unânime do conjunto: 0 em
7 concorrentes têm qualquer código de app próprio.

### A3. Invariante de segurança "IA indisponível nunca suprime gravação"
**Dimensão 3 (peso 3).** `apps/api/tests/ai-failsafe.test.ts:1-30` testa
explicitamente que a indisponibilidade do serviço de IA não interrompe a
gravação — apenas uma resposta explícita de `confirmed=false` da IA pode
suprimir uma gravação por movimento. Esse é um invariante arquitetural que
prioriza a garantia de evidência (gravar sempre, na dúvida) sobre a
otimização de armazenamento — uma escolha de design coerente com um produto
de segurança comercial. Nenhum dos 7 concorrentes documenta ou testa uma
relação equivalente entre disponibilidade do subsistema de IA e a decisão
de gravar; nos sistemas com IA (Frigate, Viseron, Scrypted, Shinobi via
plugin externo), a gravação e a detecção são mais fortemente acopladas ou a
relação de fallback não foi encontrada no código.

---

## B. Vantagens presentes, mas frágeis

### B1. Pipeline de build de app mobile assinado por cliente (white-label real)
**Dimensão 10 (peso 2).** `apps/mobile/scripts/build-client.sh` gera um APK
assinado com keystore própria persistente por cliente, a partir de
`clients/<slug>/config.json`, com validação de slug por regex. Nenhum
concorrente tem um pipeline equivalente — mas a revisão adversarial
identificou que a cadeia de confiança termina no host de build, sem
evidência de rollback automático em caso de falha parcial (assinatura
incompleta, artefato corrompido) nem de verificação adicional do lado do
Central antes de publicar o APK. É uma vantagem real (nenhum concorrente
chega perto), mas operacionalmente imatura para escala — um erro de
processo no host de build hoje não tem uma rede de segurança automatizada.

### B2. Painel Central de gestão de frota multi-instalação
**Dimensão 10 (peso 2).** `apps/central/src/server.js:1081-1164` implementa
heartbeat autenticado por instalação (`x-drac-installation-id`/
`x-drac-license-key`), rejeição de instalação desconhecida, sanitização de
payload contra XSS armazenado, resumo de frota (`fleetSummary`). Nenhum dos
7 concorrentes tem um hub self-hospedado equivalente para gerenciar
múltiplas instalações — o mais próximo é o "Central Server" do Shinobi, que
é um serviço **pago e hospedado pela própria Shinobi Systems**, não uma
peça de software que o revendedor possa operar. A fragilidade: a
autenticação é por header em texto simples, sem evidência de rotação de
chave ou expiração, e o armazenamento de estado é um arquivo JSON local sem
menção de criptografia em repouso — adequado para a escala atual, mas não
para uma gestão central "de nível enterprise" sem evolução.

### B3. Bloqueio comercial por inadimplência aplicado no gate de conteúdo
**Dimensão 5 (peso 3).** `access-control.service.ts:59-77,257-274` aplica
o status de grupo (`RESTRICTED`/`SUSPENDED`) tanto na listagem de câmeras
quanto no gate de conteúdo — ou seja, um cliente inadimplente perde acesso
de forma coerente, não apenas cosmética. Nenhum concorrente implementa uma
noção de suspensão comercial de acesso. A fragilidade: a análise confirmou
enforcement em dois pontos específicos, não uma varredura de todos os
endpoints de acesso a mídia/streaming/exportação que poderiam também
precisar desse gate — não há evidência de teste cobrindo, por exemplo, se
um token de VOD já emitido antes da suspensão continua válido depois dela.

---

## C. Vantagens comerciais ainda dependentes de evolução técnica

### C1. Worker de gravação como processo separado (Go + Redis)
**Dimensão 8 (peso 2).** `services/camera-worker-go/` é um processo
separado da API, comandado via Redis, que tira a carga de gravação do
processo da API (`schema.prisma:66-70`, `RecordingSource.WORKER` identifica
a origem de cada gravação). Isso é uma vantagem real de **separação de
processo**: um travamento no pipeline de gravação não derruba a API.

**Correção importante em relação à leitura inicial deste benchmark:** uma
verificação posterior do código mostrou que este mecanismo **não é, hoje,
uma capacidade de escala horizontal entre hosts**, como a primeira leitura
sugeria. As evidências:

- `services/camera-worker-go/main.go:277-297` usa `rdb.Subscribe` — Redis
  **pub/sub**, não fila de trabalho (sem `BRPOP`, sem consumer group).
  Todo worker inscrito recebe **todos** os comandos.
- `apps/api/src/recordings/recording-process-manager.service.ts:921`
  publica em um **canal único** (`workerCommandChannel`, default
  `camera:commands` — `apps/api/src/config/env.config.ts:89`), sem
  roteamento por câmera ou por worker.
- `fetchCameras` (`main.go:236`) retorna **todas** as câmeras para
  qualquer worker; não há `WORKER_ID`, shard key, nem filtro de escopo
  (as únicas variáveis de ambiente são `API_URL`, `REDIS_ADDR`,
  `WORKER_COMMAND_CHANNEL`).
- A guarda de duplicação `activeRecordings` (`main.go:311-318`) é um mapa
  **local ao processo**, protegido por mutex local.

Consequência prática: subir um segundo worker apontando para a mesma
API/Redis faria os **dois** gravarem as **mesmas** câmeras — duplicação de
CPU, disco e registros, não divisão de carga. A distribuição exigiria hoje
um sharding manual por canal (`WORKER_COMMAND_CHANNEL` distinto por host)
**mais** uma mudança na API para publicar cada comando no canal certo —
mudança que não existe no código atual.

Nenhum concorrente do conjunto tem escala horizontal *de gravação* madura
(ZoneMinder tem `Servers` via replicação de configuração; Shinobi tem
"Child Node"), então isto não é uma desvantagem relativa — mas **não deve
ser comunicado comercialmente como "escala entre hosts"** até que o
sharding/claim distribuído exista. É a razão principal da nota 3 (e não 4)
na dimensão 8, junto com a ausência total de benchmark no repositório
(busca por `benchmark|load.?test|stress` em `apps/api/tests/`, `services/`,
`scripts/` e `.github/` não retorna nenhum arquivo).

### C2. Arquitetura white-label multi-instância como alternativa ao SaaS compartilhado
**Dimensão 5 e 10 combinadas.** A combinação de instalação Docker isolada
por revendedor + Central de monitoramento é uma proposta de isolamento
mais forte que qualquer forma de multi-tenancy compartilhada encontrada nos
concorrentes (nenhum deles tem outra opção clara de instalação
isolada gerenciada centralmente). Mas, como registrado em
[05-onde-drac-perde.md](05-onde-drac-perde.md) item 1, esse modelo tem custo
operacional por cliente mais alto que uma alternativa de multi-tenancy
compartilhada — a vantagem comercial (isolamento/segurança superior) só se
sustenta plenamente para clientes de porte médio/grande; para o segmento de
cliente muito pequeno (poucas câmeras), a proposta de valor depende de
evoluir para um modelo híbrido (ver recomendações).
