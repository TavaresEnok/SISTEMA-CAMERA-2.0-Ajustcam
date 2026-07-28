# Revisão Contraditória

Segunda passagem dos achados CRÍTICO/ALTO, tentando invalidá-los por guards,
testes, regra de negócio, chamadores, escopo e infraestrutura.

| ID | Evidência contrária procurada | Resultado |
|---|---|---|
| 001 | quoting, URL configurável, testes e pin de imagem | `shellQuote` evita injeção por parâmetros, mas não autentica o script baixado. URL configurável não torna o default pinado. Mantido CRÍTICO. |
| 002 | transações, reconcile, retorno de unlink e proteção de evidências | Proteções impedem deletar itens sob hold, mas não tratam falha parcial. `removeFile=false` é ignorado e DB/filesystem não compartilham transação. Mantido ALTO. |
| 003 | allowlist, DNS revalidation, roles, throttle e necessidade de LAN | Exige autenticação/cota/feature e há throttle. Câmera legítima normalmente está em LAN; ainda assim loopback/link-local/control-plane são permitidos sem subnet allowlist. Mantido ALTO. |
| 004 | gate no token e no consumo, teste de grupo e regra admin | ZIP revalida, mas repete o gate errado. `RESTRICTED` é explicitamente “corta histórico/exportação”; download individual usa playback. Mantido ALTO. |
| 005 | sessão vinculada ao usuário, authVersion, revoke no delete/update | Nenhuma dessas proteções existe na Central. Expiração absoluta limita a 8h, mas não revoga imediatamente. Mantido ALTO. |
| 006 | backup, trap, stop de serviços e validação de restore | Há dump/snapshot e trap, porém rollback ocorre após a nova API subir, não a para e engole todos os erros. Mantido ALTO, confiança ALTO por não ter sido reproduzido. |
| 007 | prompt, verificador temporário e backup automático | O prompt existe e há verificador separado, mas restore não o chama nem cria ponto atual. `pg_restore --clean` pode falhar parcial. Mantido ALTO. |
| 008 | expiração, rotação, uso único, hashing e auditoria | Só há token aleatório/timing-safe/auditoria. O mesmo valor persiste e é incluído em backup. Mantido ALTO. |
| 009 | todos os Compose/overrides, README e resolução externa | Nenhum define o serviço. Um container externo poderia ser manualmente anexado/nomeado, mas o comando documentado não faz isso. Mantido ALTO para o deploy versionado. |
| 010 | regra de gerenciamento privado, `canView`, tests e todos os callers | A regra permite admin gerenciar config/status e o teste espera `canAdmin=true`. Isso justifica update/delete técnico, não PTZ/relé físico. `canControl`/`canRecord` não chamam `canView`. Mantido ALTO; correção deve preservar `canAdmin`. |

## Hipóteses rebaixadas ou descartadas

### Concorrência da Central em processo único

A leitura inicial sugeria lost-update em qualquer request porque JSON/PG
persistem documento inteiro. `apps/central/src/server.js:2177-2222` aplica
`runSerialized` a `/api/` e `/install/`; teste `operações de banco concorrentes
são executadas em ordem` passou. O caso foi rebaixado para DRAC-AUD-016,
somente múltiplos processos/hosts.

### X-Forwarded-For na Central

Existe uma função antiga em `server.js:333-337`, mas outra declaração em
`1219-1228` a substitui por hoisting. O Nginx sobrescreve `X-Real-IP` com
`$remote_addr`, invalidando spoof no caminho padrão. Restou DRAC-AUD-017 apenas
para porta 9765 direta, compatível com o README.

### XSS no gráfico web

`dangerouslySetInnerHTML` gera custom properties de chart. Não foi demonstrada
origem remota/controlada chegando a `ChartConfig`; não foi aberto achado de
XSS. O CSP fraco/localStorage foi mantido como impacto de um XSS futuro
(DRAC-AUD-014), não como XSS confirmado.

### Comandos FFmpeg

Buscas por `spawn/exec/execFile/shell` e inspeção de chamadores mostraram argv
separado nos fluxos ativos. Interpolações de shell do MediaMTX são construídas
internamente, e testes de redaction cobrem URLs. Não foi confirmado command
injection.

### Segredo Firebase

`google-services.json` versionado foi revisado somente por tipo/caminho. Chaves
cliente Firebase não são segredo privado por si sós; DRAC-AUD-025 ficou
DESCARTADO, condicionado a revisar regras/restrições externas.
