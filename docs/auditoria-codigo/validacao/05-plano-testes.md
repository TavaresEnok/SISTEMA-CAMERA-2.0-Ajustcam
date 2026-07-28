# Plano de testes orientado aos achados

Este é um plano, não uma implementação. Os testes com banco, Redis, filesystem,
Docker, FFmpeg, rede ou scripts destrutivos devem rodar somente em laboratório
descartável, com dados sintéticos, namespace/rede isolados e prazos externos.
Nenhum teste proposto autoriza usar o ambiente DRAC atualmente ativo.

## Controles obrigatórios do laboratório

1. PostgreSQL, Redis e storage efêmeros, com nomes/volumes exclusivos e
   confirmação automática de que não são os endpoints de produção.
2. Egress negado por default. Metadata, loopback, IPv4/IPv6 privados e DNS
   devem ser simulados dentro de um namespace de rede descartável.
3. Instalador, updater e restore nunca devem obter `sudo`, Docker socket,
   credenciais reais ou acesso ao checkout principal.
4. Todo teste blackhole/subprocesso deve ter prazo externo e teardown que
   confira portas, PIDs, filhos e arquivos temporários.
5. Fixtures não podem conter tokens, senhas, RTSP ou backups reais.
6. Testes de crash devem matar apenas processos do namespace efêmero e
   preservar logs/manifestos para inspeção.

## Baseline e testes já executados nesta etapa

| Comando/ensaio | Resultado |
|---|---|
| `node --import tsx --test tests/access-matrix.test.ts tests/group-access-block.test.ts` em `apps/api` | 15 aprovados, 0 falhas |
| `pnpm test` em `apps/central` | 186 descobertos; 173 aprovados, 13 pulados, 0 falhas |
| `python3 -m unittest discover -s services/ai-service-python/tests -t services/ai-service-python -v` | 237 total: 144 aprovados, 93 pulados, 0 falhas |
| `bash -n` em install/update/restore | sintaxe aprovada; sem execução |
| harnesses locais documentados nos relatórios 01–03 | confirmaram 001, 002, 004, 005, 008, 010, 013, 015, 017 condicional, 018, 019 e 022 |
| testes Go | não executados: Go não existe no ambiente |

## DRAC-AUD-001 — distribuição e instalador

| Teste | Nível | Resultado esperado seguro |
|---|---|---|
| branch móvel/URL sem digest | contrato | provisionamento recusa gerar comando executável |
| arquivo alterado após emissão | integração com servidor HTTP local | hash diverge e nada é executado |
| digest/assinatura incorreta ou ausente | integração | falha fechada, código de saída não zero e auditoria |
| redirect para host diferente | integração de rede isolada | redirect é recusado ou revalidado por política |
| replay/downgrade de versão | integração | versão antiga/revogada é recusada |
| token expirado/usado/revogado | Central e datastore | resposta não entrega artefato/licença |
| argumento contendo aspas, newline, `$()`, backtick e opção iniciada por `-` | property/fuzz | argumento chega literalmente, nunca como sintaxe shell |
| instalação interrompida em cada fronteira | sandbox descartável | estado anterior permanece ou rollback verificável ocorre |
| mirror/offline | integração | somente artefato já verificado por digest/assinatura é aceito |
| comprometimento simulado do repositório | ameaça/test fixture | conteúdo não assinado não passa pela raiz de confiança |

Antes de executar qualquer conteúdo, o teste deve substituir o comando final
por um stub que apenas registre `argv`, UID esperado e digest. Um teste real de
instalação só deve existir em VM descartável criada para isso.

## DRAC-AUD-002 — matriz de consistência de gravações

Cada estado precisa de um teste de integração específico; não basta mockar
apenas o retorno de `unlink`. O oracle deve comparar banco, diretório físico,
hash/tamanho, status da gravação e relatório de integridade.

| ID de teste | Ponto de falha/estado induzido | Estado seguro esperado após recuperação |
|---|---|---|
| REC-01 | crash durante criação do `.ts` | parcial não é publicado; retry/quarentena determinísticos |
| REC-02 | FFmpeg falha durante remux | MP4 parcial não é registrado e é removido/quarentenado |
| REC-03 | `fsync` falha | operação falha ou registro indica não durável; nunca sucesso silencioso |
| REC-04 | MP4 final existe e DB cai antes do INSERT | scan adota exatamente uma vez ou quarentena com motivo |
| REC-05 | INSERT conclui e processo cai antes de remover TS | MP4 segue disponível e TS redundante é limpo com segurança |
| REC-06 | dois recuperadores adotam o mesmo arquivo | unique/idempotency gera uma linha, sem perda do arquivo |
| REC-07 | rename temporário interrompido | nome final nunca referencia bytes incompletos |
| REC-08 | unlink da origem/derivado falha na retenção | linha permanece ou entra em estado `DELETE_PENDING`; retry observável |
| REC-09 | arquivos removidos e transação DB falha | operação compensada ou estado explícito impede playback fantasma |
| REC-10 | delete-all com uma falha entre N arquivos | relatório individual e consistência de cada item; nada é declarado totalmente removido |
| REC-11 | clip criado e DB falha | arquivo é removido/reconciliado; não permanece órfão indefinido |
| REC-12 | linha de clip existe, arquivo ausente | estado é detectado e API retorna erro consistente/auditado |
| REC-13 | DB aponta a arquivo zero/truncado | integrity check detecta antes de evidência/export; não serve conteúdo inválido |
| REC-14 | disco cheio durante captura/remux/export | processo não reinicia infinitamente, health alerta e arquivos parciais são tratados |
| REC-15 | storage indisponível/read-only | sem remoção de linha nem loop de retry ilimitado |
| REC-16 | DB indisponível | mídia fechada é preservada para retry, com limite e telemetria |
| REC-17 | reinício abrupto em cada fronteira | recovery converge e é idempotente após duas execuções |
| REC-18 | retenção concorrente com playback/export/evidence hold | arquivo protegido não some; locks/estados evitam TOCTOU |
| REC-19 | backup DB no instante A e storage no instante B | restore preflight detecta epoch/manifest incompatível |
| REC-20 | restore consistente | contagens, hashes, FKs, paths e amostra de playback coincidem com manifest |
| REC-21 | arquivo físico sem linha e linha sem arquivo | reconciliador apresenta ação segura separada, nunca apaga automaticamente sem política |
| REC-22 | symlink em arquivo ou componente de diretório | leitura/delete recusados sem tocar sentinela externo |

Executar REC-08/09 também para thumbnail, sprite, compatível, sidecar e
`ExportedClip`. Repetir REC-14/15 em filesystem local e, se oficialmente
suportado, NFS/volume remoto.

## DRAC-AUD-003 — SSRF e normalização de destinos

Criar um único validador de política exercitado por todos os endpoints e
consumidores. O teste deve verificar o destino realmente conectado, não só o
texto aceito no DTO.

| Classe | Casos mínimos |
|---|---|
| IPv4 | `127.0.0.1`, RFC1918, `169.254.169.254`, `0/8`, multicast/reservado, público permitido e não permitido |
| IPv4 alternativo | `127.1`, inteiro decimal, hexadecimal, octal, zeros à esquerda e IPv4-mapped |
| IPv6 | `::1`, `fe80::1%zone`, ULA, global, IPv4-mapped, formas comprimidas e bracketizadas |
| Hostnames | `localhost`, nome Docker, FQDN, maiúsculas/ponto final, IDN e resolução para conjunto misto público/privado |
| DNS temporal | resposta muda entre validação e conexão; rebinding; TTL zero; dois A/AAAA com um bloqueado |
| Redirect | ONVIF/HTTP local redireciona para destino proibido e para protocolo diferente |
| Autoridade URL | `user:pass@host`, `allowed@blocked`, `host/path`, `host#fragment`, `%40`, newline e espaços |
| Portas | 0, 1, 80, 443, 554, 65535, 65536, negativa, string e portas administrativas internas |
| Protocolos | somente RTSP/HTTP(S) explicitamente necessários; `file:`, `gopher:`, `ftp:` e esquemas mistos recusados |
| Cadeia de consumidores | draft, create, update, status, ONVIF, ffprobe, MediaMTX, IA, gravação e reconexão |

O namespace deve conter stubs locais que registram conexão. Nunca apontar
para metadata real. A política deve revalidar toda resolução e todo redirect
na hora da conexão, ou conectar ao IP já validado preservando SNI/Host de modo
seguro.

## DRAC-AUD-004 e DRAC-AUD-010 — matriz de autorização

Para cada célula, testar emissão **e consumo** de token, acesso por ID direto,
listagem, download, range, thumbnail, ZIP, clip, evidência, exportação,
playback, PTZ, relay e start/stop de gravação.

| Estado/perfil | Live | Histórico individual | ZIP | Clip exportado | Evidência | PTZ/relay | Start/stop |
|---|---:|---:|---:|---:|---:|---:|---:|
| ACTIVE owner | permitir | permitir | permitir | permitir | por ACL | permitir | permitir |
| ACTIVE delegado `VIEW` | permitir | conforme nível | conforme playback | conforme playback | por ACL | negar | negar |
| ACTIVE delegado `CONTROL` | permitir | conforme política | conforme playback | conforme playback | por ACL | permitir | negar |
| ACTIVE delegado `RECORD` | permitir | permitir | permitir | permitir | por ACL | conforme nível | permitir |
| ACTIVE sem grupo/permissão | negar | negar | negar | negar | negar | negar | negar |
| RESTRICTED com view | permitir live | negar | negar | negar | decisão explícita | negar histórico | negar se causar histórico |
| SUSPENDED qualquer não-admin Central | negar | negar | negar | negar | negar | negar | negar |
| Admin, câmera privada alheia | conforme regra de conteúdo | conforme regra | conforme regra | conforme regra | auditado | **decisão necessária** | **decisão necessária** |
| Owner removido/papel alterado | reavaliar no servidor | reavaliar | reavaliar | reavaliar | reavaliar | reavaliar | reavaliar |

Repetir por câmera própria, outro grupo e ID não enumerado. Web e mobile devem
ser testes de contrato: esconder botão não conta como bloqueio. O oracle é
sempre a decisão da API.

## DRAC-AUD-005, DRAC-AUD-008 e DRAC-AUD-014 — sessão e capabilities

| Evento | API Nest access/refresh | Web | Mobile | Central cookie | Bearer admin | installerToken |
|---|---|---|---|---|---|---|
| logout | access inválido por `authVersion`; refresh revogado | limpa memória/storage e chama servidor | limpa SecureStore mesmo offline e tenta servidor | sessão atual revogada | política explícita | não aplicável |
| troca/reset de senha | todos os access/refresh anteriores inválidos | força relogin | força relogin | todas as sessões do usuário inválidas | rotação definida | não aplicável |
| bloqueio/exclusão | validação server-side nega | UI limpa após 401 | SecureStore limpo após 401 | sessão nega imediatamente | política definida | token da instalação conforme política |
| alteração de papel/permissão | papel atual do DB prevalece | UI refaz `/me` | idem | sessão reavalia usuário/papel | escopo definido | não aplicável |
| expiração | limites de access e refresh | tratamento único sem loop | refresh rotativo/offline | cookie 8 h ou configuração | rotação/expiração | TTL curto |
| roubo de dispositivo | revogação por sessão/dispositivo | capacidade de revogar | idem | painel de sessões | rotação emergencial | revogação imediata |
| suspensão da instalação | feature policy aplicada em todos os recursos | UI reflete API | idem | decisão se admin continua | decisão | download/uso bloqueados |
| replay concorrente | refresh rotaciona atomicamente | uma recuperação | uma recuperação | sessão antiga revogada | conforme política | somente um download/uso vence |

Adicionar teste de cookie `HttpOnly`, `Secure`, `SameSite`, CSRF e rotação se o
web migrar de `localStorage`. O comportamento stateless intencional deve ser
escrito como contrato; não omitir revogação silenciosamente.

## DRAC-AUD-006 e DRAC-AUD-007 — update e restore

Executar apenas em VM/namespace descartável com fixture pequena e manifest:

1. validar assinatura/digest, versão, espaço, permissões e compatibilidade
   antes de parar serviços ou limpar banco;
2. injetar falha após cada comando relevante, inclusive backup, pull,
   build/pull de imagem, migration, restore DB, extração e health;
3. verificar que aplicação e writers estão parados durante restore;
4. provar que nenhum `|| true` converte falha crítica em sucesso;
5. comparar DB/storage/config por manifest e hash antes de liberar tráfego;
6. testar migration forward-only e impossibilidade de downgrade;
7. testar interrupção SIGTERM/queda de energia e reentrada idempotente;
8. medir RPO/RTO e espaço de pico; preservar backup anterior até aceite;
9. testar backup inválido, truncado, path traversal, symlink e versão futura;
10. exigir rollback verificável ou instrução de recuperação bloqueante.

## DRAC-AUD-009 e DRAC-AUD-015 — configuração de deploy

- Renderizar todas as combinações oficiais de Compose sem segredos.
- Assertar exatamente um serviço/nome/rede para Central ou contrato externo
  documentado e testável.
- Subir stack descartável e consultar `/central/api/health` pelo Nginx.
- Assertar que produção não tem bind de fonte em `/app`, e que dev tem apenas
  os binds esperados.
- Comparar revision/digest reportado pelo serviço IA com o digest da imagem.

## DRAC-AUD-011 e DRAC-AUD-012 — banco/autorização

- Em PostgreSQL efêmero, sincronizar duas transações `grant` após a leitura e
  antes da escrita; esperar uma linha canônica ou conflito tratado.
- Rodar migration sobre fixture com duplicatas iguais e níveis conflitantes;
  verificar política escolhida e relatório.
- Revogar por alvo e comprovar ausência de permissão residual.
- Criar câmera privada e testar exclusão do owner sob cada política candidata:
  `Restrict`, transferência obrigatória ou `SetNull`; cascade só se aprovada.
- Testar concorrência entre transferência, exclusão e acesso.

## DRAC-AUD-013 — Redis no bootstrap

Testar separadamente conexão recusada, DNS falho, autenticação errada,
blackhole e recuperação tardia. Em cada caso, medir tempo para ready/exit,
verificar status de health e garantir uma única definição de cada repeat job.
O teste só pode ser escrito depois da decisão “fail-fast” versus “modo
degradado”.

## DRAC-AUD-016 a DRAC-AUD-018 — Central

- Duas instâncias JSON: barreira após load, mutations distintas e saves
  invertidos; nenhuma alteração pode sumir.
- Duas instâncias PG: repetir com processos/transações reais e deadlock retry.
- Proxy: socket direto ignora headers encaminhados; proxy allowlisted aceita
  cadeia normalizada; cobrir IPv4/IPv6 e múltiplos hops.
- Rate limit: vários processos/restart não apagam estado relevante.
- Build-agent: refused, reset, blackhole, resposta lenta/grande e JSON
  inválido; health/heartbeat devem continuar respondendo.

## DRAC-AUD-019 — filesystem

Além de REC-22, testar symlink de diretório, hardlink quando relevante,
troca do alvo entre validação e abertura, case-folding, mount/bind e path
apagado/recriado. O teste precisa usar descritores/identidade de inode como
oracle quando o filesystem permitir; `realpath` isolado não elimina TOCTOU.

## DRAC-AUD-020 — Go

Quando Go 1.22 compatível estiver disponível:

```text
go test ./...
go test -race ./...
go vet ./...
```

Escrever primeiro testes de health/readiness, `http.Client` blackhole,
cancelamento de context, SIGTERM, subprocesso FFmpeg preso, retry limitado e
ausência de goroutine/processo após shutdown.

## DRAC-AUD-022 — non-root

Para cada imagem, assertar UID/GID não zero, capabilities mínimas, rootfs
read-only e mounts graváveis explicitamente allowlisted. Smokes devem cobrir
FFmpeg, HLS/gravações, uploads, modelos IA, cache, temporários, logs, health,
backup e rotação. A correção só passa quando nenhum operador precisa aplicar
`chmod 777`.

## Critério global de conclusão

Um lote só pode avançar para produção se seus testes negativos falharem na
versão atual, passarem com a correção proposta, não exigirem segredo/dado real
e forem executáveis de forma repetível em CI ou em um job de laboratório
documentado. Testes flakey, sem timeout ou que dependam de ordem externa não
servem como evidência de aceite.
