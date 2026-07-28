# Validação dos nove achados altos

## Resumo

| ID | Severidade revisada | Confiança revisada | Decisão |
|---|---|---|---|
| DRAC-AUD-002 | ALTA | CONFIRMADO | CONFIRMADO E REPRODUZIDO |
| DRAC-AUD-003 | ALTA | CONFIRMADO | CONFIRMADO POR ANÁLISE |
| DRAC-AUD-004 | ALTA | CONFIRMADO | CONFIRMADO E REPRODUZIDO |
| DRAC-AUD-005 | ALTA | CONFIRMADO | CONFIRMADO E REPRODUZIDO |
| DRAC-AUD-006 | ALTA | ALTO | CONFIRMADO POR ANÁLISE |
| DRAC-AUD-007 | ALTA | ALTO | CONFIRMADO POR ANÁLISE |
| DRAC-AUD-008 | ALTA | CONFIRMADO | CONFIRMADO E REPRODUZIDO |
| DRAC-AUD-009 | ALTA | ALTO | DEPENDE DE CONFIGURAÇÃO |
| DRAC-AUD-010 | ALTA | CONFIRMADO | CONFIRMADO E REPRODUZIDO |

Nenhum achado alto foi descartado ou rebaixado. DRAC-AUD-009 funciona no
host observado por causa de um container externo/manual, mas o problema
permanece no deploy versionado.

## DRAC-AUD-002 — Retenção não é atômica entre arquivos e banco

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-002 — Retenção não é atômica entre arquivos e banco |
| Severidade/confiança originais | ALTA / CONFIRMADO |
| Arquivos/linhas | `retention.service.ts:377-420`; `recordings.service.ts:2767-2804`; `recording-process-manager.service.ts:1092-1254,1380-1455` |
| Pré-condições | erro de I/O/permissão, DB indisponível, crash entre operações, disco cheio ou restore divergente |
| Ator | job de retenção/limpeza; admin em delete-all; falha operacional |
| Evidência original | retorno `false` de `removeFile` ignorado; arquivos removidos antes do `$transaction(deleteMany)` |
| Proteções em outras camadas | legal hold/evidência; lotes/tetos; `fsync` best-effort antes do INSERT; unique por `filePath`; recuperação de órfãos; quarentena; integrity check bidirecional somente relatório |
| Testes existentes | cobrem políticas, recuperação/quarentena e helpers; não há fault injection cobrindo cada fronteira DB↔FS |
| Reprodução segura | `RetentionService` com Prisma fake e raiz temporária |
| Resultado | falha simulada de remoção não impediu delete DB; falha DB posterior deixou o arquivo já removido |
| Impacto real | arquivo sem linha, linha sem arquivo, evidência/playback inacessível, consumo de disco e reconciliação manual |
| Alcance | gravação, thumbnail, sprite, compatível, sidecars e clips; delete-all é o maior raio |
| Ambiente afetado | qualquer storage local/remoto em falha; maior probabilidade com NFS, permissões ou disco degradado |
| Falso positivo | baixo; ambos os sentidos foram reproduzidos |
| Severidade/confiança revisadas | ALTA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

### Fluxo completo e ordem de persistência

| Operação | Ordem atual | Estado em falha |
|---|---|---|
| criação/captura | FFmpeg grava `.ts` fechado | `.ts` parcial/órfão em crash; recuperação tenta remux e põe falhas em quarentena |
| finalização | remux cria `.mp4` diretamente; valida vídeo/duração | MP4 ausente/inválido não é registrado; MP4 parcial é removido quando o FFmpeg falha |
| durabilidade | `fsync` do MP4 é best-effort | se `fsync` falha, ainda registra; queda de energia pode deixar linha para bytes não duráveis |
| criação do registro | probe do arquivo, `findUnique(filePath)`, update/create | DB indisponível preserva MP4; TS também permanece porque unlink vem depois |
| remoção do TS | depois do registro DB | falha deixa TS+MP4; recuperador descarta TS se o gêmeo MP4 já está registrado |
| rename | range export/arquivos compatíveis usam temp+rename; remux de segmento não usa rename temporário | segmento MP4 pode ser observado durante escrita, embora só seja registrado depois do probe |
| exportação de clip | produz arquivo, valida/probe/hash e depois cria `ExportedClip` | falha DB deixa clip órfão; falha antes do DB preserva/abandona arquivo |
| retenção de clip | remove arquivo e depois linha | unlink falho + linha apagada deixa arquivo órfão |
| retenção de gravação | remove clips/derivados/origem e depois linha | DB falho depois do unlink deixa linha sem conteúdo; unlink falho seguido de delete deixa conteúdo sem linha |
| delete-all | tenta remover cada arquivo; mesmo com falhas executa deleteMany de clips e gravações | arquivos que falharam ficam sem linha; DB falho deixa parte dos arquivos já apagada |
| integrity check | enumera DB e disco nos dois sentidos | relata, não repara nem bloqueia retenção |
| restore | DB e storage são restaurados em passos separados | snapshot de tempos diferentes produz ambos os tipos de órfão |

### Demonstração objetiva

O harness produziu:

```text
caseADeleteReturned=true
caseAFileRemovalReportedFailure=true
caseADbRowsDeleted=1
caseBDbErrorObserved=true
caseBFileStillExistsAfterDbFailure=false
```

O primeiro caso substituiu `removeFile` por falha controlada: o método retornou
sucesso e apagou a linha. O segundo criou um arquivo sentinela temporário e fez
o delete Prisma falhar: o arquivo já não existia quando a exceção foi
observada. Nada tocou `infra/storage`.

### Estados inconsistentes possíveis

| Estado | Causa típica | Recuperação atual |
|---|---|---|
| MP4 existe, DB ausente | DB cai após remux/export | segmento pode ser adotado pelo scan; clip exportado não possui reconciliação equivalente |
| DB existe, MP4 ausente | DB falha depois de delete FS; restore só DB; remoção externa | integrity check/diagnóstico detecta; não restaura |
| TS e MP4 existem | unlink TS falha após registro | scan remove o TS gêmeo se MP4 está registrado |
| TS existe sem MP4/DB | crash ou remux falho | retry limitado e quarentena, sem apagar |
| clip existe, linha ausente | create DB falha ou retenção ignora unlink | não há adoção automática do clip |
| linha de clip existe, arquivo ausente | DB falha após remoção ou restore | download retorna 404; sem reparo |
| derivados órfãos | falha entre origem e derivados | parte é limpa pela retenção/scan; não é uma transação |
| DB/storage de épocas diferentes | restore independente | check relata divergências; decisão manual |
| arquivo zero/truncado com linha | `fsync` best-effort, power loss ou filesystem mentindo | integrity sweep sinaliza; conteúdo pode ser irrecuperável |

Os testes de integração propostos para cada estado estão em
`05-plano-testes.md`.

## DRAC-AUD-003 — Cadastro/teste de câmera permite SSRF na rede de controle

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-003 — Cadastro/teste de câmera permite SSRF na rede de controle |
| Severidade/confiança originais | ALTA / CONFIRMADO |
| Arquivos/linhas | `cameras.service.ts:144-220,230-260,567-630,895-915,1617-1645`; `create-camera.dto.ts:9-29`; `safe-url.helper.ts:1-67`; `rtsp-url.helper.ts:132-150`; `cameras.controller.ts:90-168`; `port-checker.service.ts:5-30` |
| Pré-condições | admin, ou viewer com feature/cota para câmera privada; servidor alcança o alvo |
| Ator | usuário remoto autenticado; admin comprometido |
| Evidência original | draft permite loopback/link-local/privadas e sonda múltiplas portas |
| Evidência adicional | create/update não chamam a guarda; DTO aceita hostname, formas alternativas e porta 65536; provisionamento/status conecta ao valor persistido |
| Proteções existentes | autenticação/RBAC, feature/cota, throttling nos drafts, timeout no PortChecker/FFmpeg, `execFile` sem shell, username/password URL-encoded |
| Testes existentes | não foi localizado teste SSRF/allowlist cobrindo endpoints e resolução DNS |
| Reprodução segura | tabela de funções/DTO/URL sem abrir sockets externos |
| Resultado | metadata/loopback/privadas passam no draft; hostnames e IPs alternativos são bloqueados no draft, mas aceitos pelo create; `@` altera o host da URL construída |
| Impacto real | scan/conexão a localhost, rede Docker, link-local e serviços internos; alcance de dados depende do protocolo/porta |
| Alcance | teste de portas, ONVIF, RTSP/ffprobe, MediaMTX, health e pipelines após persistência |
| Ambiente afetado | especialmente servidores com metadata service, painel local, Docker bridge ou rede de gerenciamento |
| Falso positivo | baixo para capacidade de conexão; regra de quais sub-redes são câmeras legítimas depende do negócio |
| Severidade/confiança revisadas | ALTA / CONFIRMADO |
| Decisão final | **CONFIRMADO POR ANÁLISE** |

### Fluxo completo

1. `POST /cameras/mine` aceita viewer, condicionado a feature e cota; o admin
   usa `POST /cameras`.
2. `CreateCameraDto.ip` exige apenas string. As portas têm mínimo 1, sem máximo
   65535.
3. `create` persiste o valor e não chama `assertTestTargetAllowed`.
4. O controller agenda provisionamento pós-create.
5. `getStatus` chama `PortChecker.check(camera.ip, rtspPort/onvifPort)` e, se
   alcançável, constrói RTSP e chama ffprobe.
6. Live, gravação, IA, clip e MediaMTX voltam a usar o endereço persistido.

Nos endpoints draft/preview, a guarda exige IP literal e, por default, bloqueia
IP público. O predicado permitido, porém, é exatamente “privado ou reservado”:
`127/8`, `169.254/16`, RFC1918, `0/8`, multicast/reservado, `::1`, ULA e
link-local IPv6.

### Matriz segura de entradas

| Entrada | Draft | Create DTO | Consequência |
|---|---|---|---|
| `127.0.0.1` | permite | aceita | loopback alcançável |
| `10.0.0.1`, `192.168.1.1` | permite | aceita | rede privada, legítima ou control-plane |
| `169.254.169.254` | permite | aceita | endereço comum de metadata |
| `::1`, `fe80::1`, `fd00::1` | permite | aceita | PortChecker pode conectar; builder RTSP não coloca colchetes e pode falhar em etapas URL |
| `8.8.8.8` | bloqueia por default | aceita | criação persiste e etapas posteriores tentam |
| `localhost`, hostname | bloqueia | aceita | DNS/rebinding possíveis após persistência |
| `127.1`, decimal/hex/octal IPv4 | bloqueia | aceita | interpretação depende do consumidor; não há normalização única |
| `127.0.0.1@169.254.169.254` | bloqueia | aceita | URL RTSP construída é interpretada com host final `169.254.169.254` |
| porta `65536` | chega ao DTO | aceita | validação de faixa incompleta; consumidor falha ou interpreta |

### IPv4, IPv6, DNS, redirects e protocolos

- IPv4 privado, loopback, link-local e metadata são permitidos
  intencionalmente pelo draft.
- IPv6 privado/link-local/loopback também é permitido; o URL builder não
  bracketiza IPv6, criando divergência entre PortChecker e RTSP.
- Formas alternativas/hostnames são recusadas só no draft, não na criação.
- `resolveHostIps`/`isAllowedHost` existem, mas não participam desse fluxo.
- Hostnames são resolvidos no consumidor; não há pinagem do conjunto de IPs
  entre validação e conexão. DNS rebinding e mudança entre chamadas não são
  mitigados.
- PortChecker e os requests ONVIF diretos não seguem redirect HTTP por conta
  própria. Comportamento de redirect RTSP do ffprobe não foi exercitado.
- Portas são controláveis, e o teste ainda tenta listas adicionais de RTSP e
  ONVIF.
- Protocolos são montados como RTSP/HTTP ONVIF; não há esquema diretamente
  fornecido, mas caracteres de autoridade/caminho no campo `ip` confundem a
  construção.
- Credenciais legítimas são codificadas; credenciais/`@` dentro do campo `ip`
  não são validadas.

Nenhum metadata service ou host externo foi contatado.

## DRAC-AUD-004 — Estado RESTRICTED é burlado por ZIP e clip exportado

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-004 — Estado RESTRICTED é burlado por ZIP e clip exportado |
| Severidade/confiança originais | ALTA / CONFIRMADO |
| Arquivos/linhas | `access-control.service.ts:109-121,211-237`; `recordings.controller.ts:217-225,590-647,649-766`; `recordings.service.ts:1597-1680,2731-2740`; web `PlaybackPage.tsx`; mobile `App.tsx` |
| Pré-condições | usuário não privilegiado, grupo RESTRICTED, papel/permissão de export; IDs ou clip previamente criado |
| Ator | viewer/operator autenticado do grupo |
| Evidência original | ZIP e download de clip usam view, enquanto individual/export usam playback |
| Proteções existentes | RBAC/feature permissions, tokens curtos, revalidação de usuário, checks de ID/câmera, audit, regra correta em outros endpoints |
| Testes existentes | 15/15 focais passaram e provam `view=true`, `playback=false`; não incluem os dois bypasses |
| Reprodução segura | controller com services fake; playback configurado para negar |
| Resultado | token ZIP emitido, ZIP e clip chamados; 3 checks de view e **0 checks de playback** |
| Impacto real | extração de histórico durante restrição; lista também revela metadados do acervo |
| Alcance | web expõe ZIP/clipe; mobile usa download individual e é bloqueado no consumo; API é a fronteira decisiva |
| Ambiente afetado | grupos em RESTRICTED; admin/super-admin continuam permitidos por regra explícita |
| Falso positivo | baixo; comentários e testes definem a regra |
| Severidade/confiança revisadas | ALTA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

### Regra de negócio encontrada

`RESTRICTED` mantém ao vivo e corta histórico, playback e exportação.
`SUSPENDED` corta acesso concedido pelo grupo. Admin da instalação continua
com playback para administrar o cliente. Permissão direta sobre câmera
sobrevive ao status do grupo por decisão documentada.

### Matriz esperada versus atual

| Recurso/end-point | Esperado em RESTRICTED | Atual | Resultado |
|---|---|---|---|
| live/stream | permitir | permite via view | correto |
| `GET /recordings` | negar ou não revelar histórico | lista por IDs acessíveis, sem playback | **gap adicional de metadados** |
| play token + consumo | negar | consumo revalida playback | correto no acesso ao vídeo |
| VOD playlist | negar | emissão usa view, cada segmento consumido usa playback | bytes bloqueados, emissão/metadados desnecessários |
| thumbnail/sprite | negar | consumidor revalida playback | correto no consumo |
| download individual | negar | playback | correto |
| token ZIP | negar | view | **bypass reproduzido** |
| consumo ZIP | negar, inclusive após mudança de estado | view novamente | **bypass reproduzido** |
| criação de clip | negar | playback | correto |
| download de clip já criado | negar | view | **bypass reproduzido** |
| export por intervalo/status | negar | playback | correto |
| pacote de investigação | depende da regra do caso | pacote atual é JSON de metadados, sem bytes de vídeo; controla acesso à investigação, não ao grupo | decisão de negócio |

Web não interpreta `accessStatus` do grupo para autorizar; ela renderiza o que
a API lista. Mobile usa capability global de papel e também depende da API.
Isso é correto arquiteturalmente — o frontend não deve ser a barreira — mas
torna o gate incompleto da API explorável.

Papéis/câmeras diferentes:

- outro grupo/tenant sem permissão: barrado antes pelos IDs/canView;
- câmera privada: owner/delegado pode view; playback ainda deve observar
  RESTRICTED se houver grupo;
- admin/super-admin: permitido conforme regra documentada;
- acesso direto por ID: os dois endpoints vulneráveis aceitam quando view
  passa; ocultar botão não corrige.

## DRAC-AUD-005 — Sessões da Central sobrevivem a delete/troca de senha

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-005 — Sessões da Central sobrevivem a delete/troca de senha |
| Severidade/confiança originais | ALTA / CONFIRMADO |
| Arquivos/linhas | `apps/central/src/server.js:320-340,458-548,1779-1808` |
| Pré-condições | sessão válida emitida antes da mudança |
| Ator | usuário removido, dispositivo perdido ou ladrão de cookie; outro admin aciona delete/troca |
| Evidência original | sessão é aceita por hash/expiração sem consultar `db.users`; update/delete não revogam |
| Proteções existentes | token aleatório, hash em repouso, HttpOnly/SameSite, TTL absoluto default 8h, logout da sessão corrente, cookie Secure configurável |
| Testes existentes | suíte Central passou; não cobre revogação por update/delete |
| Reprodução segura | duas contas sintéticas em Central efêmera |
| Resultado | `/auth/me` permaneceu autenticado após delete e após troca de senha |
| Impacto real | administração da frota continua por até o TTL, inclusive com sessão roubada |
| Alcance | usuários adicionais da Central; política do admin builtin/token bearer precisa decisão própria |
| Ambiente afetado | JSON e mappers de sessão; a propriedade está no modelo de autenticação |
| Falso positivo | baixo |
| Severidade/confiança revisadas | ALTA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

### Sessões em cada superfície

| Superfície | Tipo/armazenamento | Duração/refresh | Revogação observada |
|---|---|---|---|
| API web | JWT access bearer em `localStorage`; sem refresh usado pela web | default 8h/config de settings | cada request consulta usuário e `authVersion`; senha/logout/desativação invalidam; logout da UI web é somente local |
| API mobile | access + refresh em Expo SecureStore; migra AsyncStorage legado | access configurável; refresh rotativo 1–30 dias, default 7 | servidor checa ativo/authVersion; logout mobile chama API best-effort e limpa local |
| Central | cookie opaco aleatório, hash no datastore | TTL absoluto default 8h; sem refresh | apenas logout/expiração; delete/troca de senha não revogam |
| Central bearer admin | segredo estático de ambiente | sem TTL | não existe revogação por usuário; rotação de configuração/restart |

Na API NestJS, o JWT não é puramente stateless: o guard consulta o usuário e
compara `authVersion`, e refresh sessions são persistidas/rotativas. Mudança de
papel é refletida porque o usuário atual é retornado do banco, mesmo quando o
token contém papel antigo. Delete/desativação e senha invalidam access/refresh.

Lacunas/requisitos ainda não implementados:

- web logout não chama `/auth/logout`; um bearer copiado continua até
  expiração ou outra revogação;
- não há revogação por dispositivo para mobile; logout server revoga todas as
  sessões do usuário;
- tokens de mídia de 5 min não carregam authVersion, embora o consumidor
  reconsulte existência/ativo e autorização do recurso;
- mudança de estado comercial da instalação não “desloga” a API local; as
  features são bloqueadas por policy. Confirmar se suspensão deve revogar
  autenticação é decisão de negócio;
- não foi encontrado comando de revogação da Central sobre sessões locais da
  instalação.

O DRAC-AUD-005 é falha de implementação da Central, não consequência
inevitável de JWT stateless.

## DRAC-AUD-006 — Rollback de update restaura DB com aplicação ativa

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-006 — Rollback de update restaura DB com aplicação ativa e engole falhas |
| Severidade/confiança originais | ALTA / ALTO |
| Arquivos/linhas | `scripts/update-drac.sh:28-68,70-124` |
| Pré-condições | falha após `ROLLBACK_NEEDED=true`, principalmente migration/health/readiness |
| Ator | operador/update automatizado; falha externa |
| Fluxo | dump → fetch/merge → build/up API+web → migration → health → em erro reset/env → `pg_restore --clean` com API ainda ativa → build/up |
| Evidência adicional | todos os passos críticos do rollback usam `|| true`; mensagem “Rollback finalizado” é incondicional |
| Proteções existentes | `set -Eeuo pipefail`, trap ERR, dirty check, dump não vazio, ff-only, health e readiness |
| Testes existentes | syntax check passa; não há laboratório concorrente/fault injection |
| Reprodução segura | apenas `bash -n` e análise de fluxo; script não executado |
| Resultado | ordem completa demonstra ausência de quiesce e perda de erro |
| Impacto real | writes concorrentes durante `--clean`, rollback parcial e falso sucesso |
| Alcance/ambiente | toda instalação atualizada; depende de tráfego e migrations |
| Falso positivo | baixo na ordem; dano específico depende da falha |
| Severidade/confiança revisadas | ALTA / ALTO |
| Decisão final | **CONFIRMADO POR ANÁLISE** |

Não há proteção externa no Compose que pare API antes do restore. Reconstruir
API/web só depois não impede conexões durante `pg_restore`. O teste destrutivo
adequado exige Postgres/stack totalmente descartáveis.

## DRAC-AUD-007 — Restore destrutivo sem validação integral/rollback

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-007 — Restore limpa banco antes de validação integral e sem rollback |
| Severidade/confiança originais | ALTA / ALTO |
| Arquivos/linhas | `scripts/restore-drac.sh:20-64`; verificador separado de backup |
| Pré-condições | dump truncado/incompatível, storage inválido, erro I/O ou health pós-restore |
| Ator | operador com arquivo de backup; arquivo malicioso/defeituoso |
| Fluxo | escolher/ver existência → confirmação → parar API/web → `pg_restore --clean` no DB ativo → extrair tar sobre storage → subir → health |
| Evidência adicional | não cria backup do estado atual, não valida restore em DB temporário, não há trap/rollback e readiness é ignorado |
| Proteções existentes | confirmação explícita, API/web paradas, `set -Eeuo`, existência dos arquivos, health final |
| Testes existentes | verificadores existem, mas não são chamados pelo restore |
| Reprodução segura | `bash -n` e análise; restore não executado |
| Resultado | fluxo demonstra ponto irreversível antes de validação completa |
| Impacto real | DB parcialmente limpo/restaurado, storage misturado e downtime |
| Alcance/ambiente | procedimento de emergência de toda instalação |
| Falso positivo | baixo; manifestação depende do arquivo/falha |
| Severidade/confiança revisadas | ALTA / ALTO |
| Decisão final | **CONFIRMADO POR ANÁLISE** |

O uso de `tar -xf` também permite symlinks e sobrescrita no storage; isso
amplifica DRAC-AUD-019. O dump e o archive podem representar instantes
diferentes, produzindo DB sem arquivo e arquivo sem DB mesmo quando ambos são
válidos individualmente.

## DRAC-AUD-008 — installerToken reutilizável indefinidamente

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-008 — installerToken da Central é reutilizável indefinidamente |
| Severidade/confiança originais | ALTA / CONFIRMADO |
| Arquivos/linhas | `server.js:437-455,1097-1169`; datastore/backup de signing |
| Pré-condições | vazamento do quick URL/token |
| Ator | qualquer possuidor da URL; não exige sessão administrativa no GET |
| Fluxo | provision cria token → consultas reutilizam → handler compara igualdade → devolve script/licença → registra download |
| Evidência adicional | dois GETs sucessivos retornaram 200 e conteúdo idêntico; nova consulta admin manteve a mesma URL |
| Proteções existentes | 24 bytes aleatórios, comparação timing-safe, 404 em mismatch, auditoria de cada download |
| Testes existentes | não cobrem TTL, consumo único ou rotação |
| Reprodução segura | Central local e script somente texto |
| Resultado | replay confirmado |
| Impacto real | capability duradoura dá acesso recorrente a script com licença/configuração |
| Alcance | uma instalação por token; backups e históricos prolongam exposição |
| Ambiente afetado | todos os backends de datastore |
| Falso positivo | baixo |
| Severidade/confiança revisadas | ALTA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

Auditoria detecta o uso, mas não o impede. Hash em repouso, `expiresAt`,
`usedAt`, rotação e revogação não existem.

## DRAC-AUD-009 — `/central/` aponta para serviço ausente no Compose

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-009 — `/central/` aponta para serviço ausente no Compose |
| Severidade/confiança originais | ALTA / CONFIRMADO |
| Arquivos/linhas | `apps/web/nginx.conf:47-64`; `infra/docker-compose.yml`; prod/dev; `apps/central/README.md:19-25` |
| Pré-condições | web inicia sem serviço externo chamado `drac-central` na mesma rede |
| Ator | deploy padrão/operador |
| Evidência original | `proxy_pass http://drac-central:9765/`; nenhum service Central |
| Evidência adicional | Compose prod lista 9 serviços e dev 10, nenhum `drac-central`; somente `central-data-backup` |
| Proteções existentes | host atual possui container externo manual na `infra_vms-net`; web atual resolve o nome; config Nginx host também aponta `127.0.0.1:9765` |
| Testes existentes | não há smoke Compose versionado para `/central/api/health` |
| Reprodução segura | `docker compose ... config --services`, inspect de rede e `getent` no web |
| Resultado | falha do artefato versionado confirmada; ambiente atual protegido fora do Compose |
| Impacto real | Nginx pode falhar ao iniciar por DNS ou `/central/` ficar indisponível |
| Alcance | web/Central administrativa; dados da Central podem continuar íntegros |
| Ambiente afetado | instalação nova sem orquestração externa |
| Falso positivo | médio para hosts com serviço externo; baixo para Compose entregue |
| Severidade/confiança revisadas | ALTA / ALTO |
| Decisão final | **DEPENDE DE CONFIGURAÇÃO** |

O README recomenda `docker run -p 9765:9765`, mas não garante nome e adesão à
rede Compose. O estado atual não é reproduzível a partir dos arquivos
versionados.

## DRAC-AUD-010 — Admin pode PTZ/relé/gravar câmera privada alheia

### Ficha de validação

| Campo | Resultado |
|---|---|
| ID/título | DRAC-AUD-010 — Admin pode PTZ/relé/gravar câmera privada alheia |
| Severidade/confiança originais | ALTA / CONFIRMADO |
| Arquivos/linhas | `access-control.service.ts:157-203,240-255`; `ptz.controller.ts:23-142`; `recordings.controller.ts:76-108`; schema `Camera:126-135` |
| Pré-condições | admin/super-admin e câmera privada de outro owner |
| Ator | admin autenticado ou conta admin comprometida |
| Evidência original | `hasLevel` retorna true para privilegiado; view tem regra especial, control/record não |
| Proteções existentes | endpoints exigem papel/permissão e auditam; conteúdo visual usa `canView`; owner/delegado direto são tratados |
| Testes existentes | matriz prova `canView=false` e `canAdmin=true`, mas não control/record/endpoints |
| Reprodução segura | AccessControlService com Prisma fake; nenhum comando de câmera |
| Resultado | admin: view=false, control=true, record=true, admin=true |
| Impacto real | movimento físico PTZ, relé e alteração da coleta de gravação sem direito de ver conteúdo |
| Alcance | PTZ, relays e start/stop; serviços que usam `assertCanControl/Record` precisam inventário antes da correção |
| Ambiente afetado | câmeras `isPrivate=true` de terceiro |
| Falso positivo | baixo para PTZ/relé; gravação exige confirmar a fronteira entre gestão e conteúdo |
| Severidade/confiança revisadas | ALTA / CONFIRMADO |
| Decisão final | **CONFIRMADO E REPRODUZIDO** |

O comentário do schema permite gerenciamento técnico, mas diz explicitamente
que o conteúdo é do dono. PTZ/relé são ação física, não simples edição de
configuração. A solução deve preservar `canAdminCamera` para metadados
técnicos, mas compor `canView` com control/record para ações que afetam o
ambiente/conteúdo.

