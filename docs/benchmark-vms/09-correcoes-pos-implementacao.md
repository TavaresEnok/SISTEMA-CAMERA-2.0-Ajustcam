# 09 — Correções ao Benchmark, Descobertas na Implementação

Este documento registra erros do próprio benchmark (arquivos 00–08),
descobertos ao tentar **implementar** as recomendações. A causa raiz é sempre a
mesma: a análise original leu por amostragem dirigida (grep + leitura de
trechos) em vez de exaustivamente, e amostragem produz falsos negativos —
conclui-se "não existe" quando o certo seria "não encontrei".

Todas as correções abaixo foram verificadas lendo o código completo do caminho
em questão, e várias foram confirmadas em execução.

---

## 1. Recomendações que partiam de premissa FALSA

### 1.1 Recomendação nº2 — "backup automático antes de migração"

**O benchmark disse**: `prisma migrate deploy` pós-rebuild é passo manual, sem
backup automático.

**A verdade**: `scripts/update-drac.sh:211` executa
`pg_dump -Fc > "$BACKUP_DIR/postgres-before.dump"` **antes** do
`prisma migrate deploy` da linha 238. O backup pré-migração já é automático no
caminho de atualização.

**Como o erro aconteceu**: a análise apoiou-se numa memória operacional do
projeto ("rodar migrate deploy após rebuild") e tratou como ausência de
automação, sem abrir o script de atualização. Nenhuma ação foi tomada — não
havia o que implementar.

### 1.2 Recomendação nº3 — "ferramenta de integridade com dry-run"

**O benchmark disse**: a reconciliação do DRAC decide sozinha, sem modo de
auditoria/dry-run operável.

**A verdade**: já existe `POST /recordings/maintenance/check-integrity`
(`recordings.controller.ts:253-271`), servido por
`RecordingsService.checkRecordingIntegrity()` (`recordings.service.ts:910-937`),
sobre o helper **puro** `reconcileRecordingPaths()`
(`recording-reconcile.helper.ts:18-40`) — que **só reporta**, nunca apaga, e tem
6 testes. O comentário de cabeçalho do helper já credita explicitamente
`moonfire check.rs` e `zmaudit.pl` como origem da técnica.

**Consequência para o ranking**: a dimensão 2 (Gravação) do DRAC foi avaliada
sem contar essa peça. Não altera a nota final (4), mas a justificativa de
"lacuna vs. Moonfire" estava errada.

---

## 2. Capacidades que o benchmark subestimou

### 2.1 Credencial fora da URL — já resolvido, e de forma mais elegante

**O benchmark disse** (05, item 2 de Ingestão): adotar o padrão Moonfire de
manter credencial fora da string de URL.

**A verdade**: `apps/api/src/common/process/secret-url-process.helper.ts` já faz
isso, e num contexto mais difícil que o do Moonfire. Moonfire fala RTSP por
biblioteca própria (`retina`) e passa credencial em struct; o DRAC precisa
atravessar a fronteira do **CLI do ffmpeg**, onde tudo vira argv. A solução:
a URL secreta nunca entra em argv — é substituída por `pipe:3`
(`replaceSecretUrlWithPipe`) e entregue por um **descritor de arquivo herdado**
como documento `ffconcat`, que nunca toca o disco. Há validação de protocolo,
rejeição de `\0`/`\r`/`\n` e teto de tamanho.

Isso é uma solução melhor do que a recomendação que o benchmark fez.

### 2.2 Aceleração de IA — existe seleção de runtime (já corrigido em 03/05)

Há `runtime_profiles.py:65-210` (perfis MOTION/FACE/GENERAL, runtime por env,
fallback CUDA→CPU) e export YOLO26n em **OpenVINO INT8 em 3 resoluções**. A
lacuna real é **amplitude** (≈3 caminhos vs. 13 do Frigate), não ausência de
arquitetura.

### 2.3 Retenção — já tinha teto e dry-run

`RETENTION_MAX_DELETIONS_PER_CYCLE` (default 20.000) e a política de dois níveis
com `dryRun` já existiam, além de exclusão transacional com journal
crash-safe e advisory lock (`transactional-file-delete.helper.ts`).

---

## 3. Riscos que o benchmark NÃO viu (e que a implementação encontrou)

### 3.0 Um risco que o recon apontou e que se mostrou FALSO

Vale registrar também o inverso, porque quase virou uma correção indevida: o
reconhecimento profundo afirmou que os arquivos do worker seriam invisíveis à
manutenção da API (layout `<root>/<cameraId>/` vs. `<root>/camera-<cameraId>/`),
o que implicaria disco enchendo para sempre sem retenção conseguir apagar.

**Não procede.** `ensureFileUnderRoot(root, filePath)`
(`helpers/safe-file.helper.ts:31-35`) resolve caminho **relativo contra a raiz**,
e é exatamente isso que o worker grava; `RECORDINGS_ROOT` e `STORAGE_ROOT` são
ambos `/storage` no compose. E `listRecordingFilesOnDisk` varre a raiz inteira
**sem exigir** o prefixo `camera-`. Ou seja: retenção apaga e a checagem de
integridade enxerga. Só `cleanupOrphanDerivedArtifacts` não varre essas pastas,
e ela cuida de derivados órfãos — os derivados do caminho normal já são
removidos junto da gravação (`retention.service.ts:460`).

Nenhuma alteração foi feita por conta desse item. Fica como lembrete de que
relatório de análise — inclusive o desta própria auditoria — precisa ser
verificado no código antes de virar código.

### 3.1 O guardião de disco podia triturar o acervo — CORRIGIDO

`RetentionService.checkDiskUsage()` apaga por **pressão de disco**, sem filtro
de data, da mais velha para a mais nova, em até 100 lotes de 20 = **2000
gravações por passagem**. Ele assume que apagar gravação reduz o uso do disco.

Quando essa premissa é falsa — o volume de gravações não monta e
`recordingsRoot` cai num disco cheio por outro motivo — nenhuma exclusão move o
percentual, e o laço destrói prova sem conseguir nada.

**Corrigido** com um freio de "apagar sem adiantar": se N lotes seguidos
apagarem de fato e o disco não ceder, aborta com ERROR apontando a causa
provável (mount). Medido: pior caso cai de 2000 para 60 exclusões.
Arquivo: `retention.service.ts`; testes: `retention-disk-guard-progress.test.ts`
(5 casos, incluindo o que garante que limpeza legítima **não** dispara o freio).

### 3.2 Duplicação de gravação com UM único worker — CORRIGIDO

O benchmark (e a primeira correção dele) apontou o Redis pub/sub como vetor de
duplicação entre múltiplos workers. **Estava incompleto nos dois sentidos**:

- O vetor dominante não é o pub/sub: o **ticker de 60s** do worker
  (`main.go`) inicia gravação para toda câmera com `recordingEnabled=true`, sem
  consultar Redis nem a API. Bloquear só o canal não resolveria nada.
- E o risco não exigia dois workers: o worker **nunca lia
  `RECORDING_CONTROL_MODE`**. Como o default da API é `local` (a API grava
  sozinha) e o compose não passava a variável a ninguém, subir o profile
  `legacy-worker` fazia **API e worker gravarem as mesmas câmeras em paralelo** —
  dobro de CPU e disco, linhas duplicadas e duas sessões RTSP numa câmera que o
  resto do sistema trata como limitada a 2–4 sessões.

**Corrigido**: o worker agora **recusa subir** fora de `RECORDING_CONTROL_MODE=worker`
(fail-closed, mensagem dizendo como corrigir), e o compose passa a variável aos
**dois** serviços a partir da mesma fonte, tornando-os consistentes por
construção. Testes: `control_mode_test.go` (4 casos), `go vet` limpo.

O banner do worker já mandava "use apenas com RECORDING_CONTROL_MODE=worker" —
mas era **texto impresso, não regra**. Exatamente a categoria
"documentação sem implementação" que o próprio protocolo do benchmark manda
caçar, e que passou despercebida na análise original.

### 3.2-b Worker gravava câmera DESATIVADA — CORRIGIDO

`Camera.enabled = false` é uma decisão deliberada do operador (cliente
desligado, câmera em área sensível, pedido de LGPD). A API respeita: recusa
gravar (`recording-process-manager.service.ts:663`) e esconde a câmera de
não-admins. O worker **não tinha sequer o campo na struct** (`main.go`), e
`findAllInternal()` não filtra — então ele continuava gravando **e sondando por
RTSP** uma câmera que a interface já mostrava como desligada.

**Corrigido** nos três pontos que iniciam gravação (laço de 60s, comando Redis e
o laço de segmentos em `recorder.go`, que agora para no segmento seguinte em vez
de esperar o ticker). O campo é `*bool` de propósito: com `bool` puro, um payload
sem `enabled` desserializaria como `false` e pararia a gravação de **todo o
parque** em silêncio — o campo ausente é tratado como ativo (fail-open), e só o
`false` explícito desliga, exatamente como a API faz (`enabled === false`, não
`!enabled`). Testes: `camera_enabled_test.go` (5 casos, incluindo o do campo
ausente).

### 3.2-c Build do worker sem verificação de dependências — CORRIGIDO

Não havia `go.sum` no repositório, o `COPY` dele estava comentado no Dockerfile
e o build rodava `go mod tidy`. Consequências: nenhuma verificação de checksum
das dependências (risco de supply chain), versões resolvidas na hora do build
(duas builds da mesma commit podiam gerar binários diferentes) e reescrita do
`go.mod` dentro da imagem, escondendo o drift do diff.

**Corrigido**: `go.sum` versionado, `go mod download && go mod verify` no lugar
do `tidy`. Agora um `go.sum` faltando ou desatualizado **falha o build** em vez
de ser "consertado" silenciosamente. Verificado com `docker build` completo e
`go mod verify` (all modules verified). Ressalva registrada no próprio
Dockerfile: isso **não** torna o build offline — baixar módulo ainda exige rede;
o que muda é que o que se baixa passa a ser verificado e fixo.

### 3.2-d Bloqueio comercial não alcançava o worker — CORRIGIDO

A restrição `localRecording:false` vinda da Central chamava
`RecordingProcessManagerService.stopAll()`, que percorre `this.active` — vazio em
modo `worker`, porque nesse modo a API não segura processo nenhum. Resultado: uma
instalação inadimplente continuava gravando pelo worker.

**A solução óbvia estaria errada.** Publicar um comando "stop" seria desfeito em
até 60s: o laço do worker relê `/cameras/internal/list` e reinicia tudo que tenha
`recordingEnabled=true`. E zerar `recordingEnabled` no banco destruiria a
intenção do operador — quando o cliente voltasse a pagar, ninguém saberia quais
câmeras deviam gravar.

**Corrigido** aplicando a política como **máscara na resposta** dos endpoints
internos: sob restrição, `recordingEnabled` é reportado como `false`, e o laço do
worker desliga a gravação pelo caminho de parada que já existia e já era testado.
A restrição sai → a máscara some → a gravação retoma exatamente o que estava
configurado. O caminho de comando já era barrado por `assertFeature` antes de
publicar, então os dois motores ficam cobertos. `stopAll()` deixou de ser um
no-op silencioso em modo worker: agora registra o que está acontecendo, para que
o silêncio nunca seja lido como sucesso. Testes:
`worker-commercial-policy-mask.test.ts` (6 casos).

### 3.2-e N+1 no worker: lista inteira por câmera, por segmento — CORRIGIDO

`fetchCameraByID` baixava o parque **completo** (com joins de site/área/grupo) e
filtrava em memória — uma vez por segmento, por câmera. Num parque de 200
câmeras: 200 respostas de 200 registros a cada virada de segmento, custo
crescendo ao quadrado.

**Corrigido** com `GET /cameras/internal/:id` (mesmo guard de service-token,
mesma máscara comercial do endpoint de lista, para os dois caminhos não
divergirem). O worker cai de volta para a lista completa se receber 404, de modo
que um worker novo contra uma API antiga degrada em eficiência em vez de parar de
gravar. A rota é declarada **depois** de `internal/list` de propósito: as duas
têm dois segmentos e o Express casa na ordem de declaração.

### 3.3 Vazamento de credencial no `unhandledRejection` — CORRIGIDO

`main.ts:41-43` logava `reason.stack` **cru** no console. A rotina de fundo que
mais rejeita sem catch é a de mídia, e a mensagem do FFmpeg carrega a URL RTSP
inteira. A rede de segurança que mantém a API viva era, ela própria, um vetor de
vazamento da senha da câmera do cliente.

**Corrigido** com redação explícita nesse handler (ele escreve direto no
console, não passa pelo logger do Nest).

### 3.4 `stopPreBuffer` matava sem escalonamento — CORRIGIDO

O caminho principal de gravação já escalona (`killProcessSafely`:
SIGTERM → 1,5s → SIGKILL), mas o ring do pré-evento fazia `kill('SIGTERM')` seco.
Um ffmpeg encravado em I/O de rede ignora SIGTERM e segue vivo segurando o lock
do path — o modo de falha conhecido de "Reconectando" eterno. Agora usa a mesma
escada.

---

## 4. O que foi construído de fato novo

| Item | Arquivos | Verificação |
|---|---|---|
| Redação de credencial **no logger** (padrão Frigate `log.py`), substituindo a dependência de 54 pontos de chamada lembrarem de sanitizar | `common/logging/redacting-logger.ts`, `sensitive-text.helper.ts`, `main.ts` | 7 testes + prova em execução de que `new Logger(ctx)` de serviço é interceptado |
| Freio anti-trituração no guardião de disco | `retention.service.ts` | 5 testes; medido 2000 → 60 |
| e2e de RBAC contra **Postgres real** | `tests/access-control-postgres.e2e.ts`, `scripts/e2e-postgres-fixture.sh`, job `rbac-e2e` no CI | 8 testes executados contra Postgres real, com as 40 migrations aplicadas |
| Guard fail-closed do worker legado | `camera-worker-go/main.go`, `infra/docker-compose.yml` | 4 testes Go, `go vet` limpo |
| Camada pura de sincronia de playback | `apps/web/src/lib/playback-sync.ts` | 12 testes |
| Escalonamento no `stopPreBuffer` | `recording-process-manager.service.ts` | suíte existente mantida verde |

O e2e de RBAC merece destaque porque cobre o que o teste com Prisma falso
**estruturalmente não consegue**: `select:` é honrado pelo Prisma real e ignorado
pelo fake, e as constraints do banco (CHECK `cameraId` XOR `groupId`, `ON DELETE
RESTRICT` do dono de câmera privada) só existem no Postgres. Dois dos 8 testes
verificam exatamente essas constraints.

---

## 5. Playback sincronizado multi-câmera — CONCLUÍDO

O modo multi-câmera **já existia** em `PlaybackPage.tsx` (estado, busca por
câmera e réguas), mas sem nenhum `<video>` e com o botão dentro de um
`<div className="hidden">` — inalcançável pelo operador.

**Entregue**: componente `SyncedCameraPlayer.tsx` (um `<video>` ancorado em
tempo de parede), montado em cada célula do grid, e o botão revelado na barra.

Decisão de arquitetura: o componente é **auto-contido**, não reusa o motor VOD
de câmera única. Aquele caminho carrega estado global de player único
(`videoRef`, `pendingSeekSeconds`, `autoResumeRef`) e um `vodFallback` *sticky*
que, ao ser acionado, derruba a continuidade da página inteira — reaproveitá-lo
para N câmeras cruzaria os seeks e faria uma câmera ruim desligar as outras. O
preço é não ter pré-aquecimento do próximo segmento (troca de arquivo visível na
virada), aceitável numa tela de comparação.

Toda a lógica que erra em silêncio ficou em módulos **puros e testados**
(`playback-sync.ts`: decisão de correção + tradução de instante para
arquivo/offset; `vod-continuous.ts`: linha do tempo contínua, já existente). O
componente React é cola fina. 20 testes no total.

Invariantes travadas por teste: seguidor sem gravação no instante **congela e
rotula** em vez de pular para o segmento vizinho (mostrar outro momento com cara
de sincronizado é o pior resultado da feature); a velocidade do operador é
multiplicada, nunca substituída; salto tem carência; troca de fonte compara por
`recordingId`, não por URL (senão a renovação de token piscaria a imagem).

Câmera privada de terceiro é excluída da comparação — o gate de playback do
backend já barra, isto só evita oferecer o que seria negado e rotular
"sem gravação" o que é "sem permissão".

**Limitação declarada**: validado por typecheck, build e testes das partes
puras, e confirmado presente no bundle gerado — **não** foi exercitado em
navegador com câmeras reais. A qualidade de sincronia percebida e o
comportamento na virada de segmento precisam de validação em campo.

## 6. Capacidade de gravação — MEDIDA

`scripts/benchmark-capacity.sh` + [capacidade-gravacao.md](../capacidade-gravacao.md).
Números medidos neste host (10 núcleos, 7,7 GB): **1,6 % de CPU, 53 MB de RAM e
2,1 Mbps por câmera**, com capacidade de **~100 câmeras limitada por RAM** (não
por CPU, que daria ~434 — projetar por CPU é o erro clássico, porque em modo
`copy` não há decode).

Custo por câmera estável de 4 para 8 câmeras, o que sustenta a extrapolação. A
escrita medida (22,6 GB/dia) coincide com a medição de armazenamento
independente já registrada no projeto (22,2 GB/dia) — duas rotas diferentes
chegando ao mesmo número.

## 7. O que segue em aberto

Do roteiro "chegar a 5" continuam intocados: aceleradores de IA de baixo custo,
matriz de teste contra câmeras reais das marcas-alvo, modelo `Organization`
(multi-tenancy compartilhada), build iOS em CI, endurecimento da auth da
Central, rollback de build white-label e drill de restore em CI.

**Nota de escopo**: nada aqui altera o ranking de 04-ranking.md. As correções
afetam a *justificativa* de itens específicos e a lista de lacunas (05) e
recomendações (07), não as notas por dimensão — as duas recomendações
invalidadas (backup pré-migração e ferramenta de integridade) já estavam
implementadas, o que reforça, e não enfraquece, a posição do DRAC.
