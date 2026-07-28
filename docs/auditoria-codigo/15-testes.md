# Testes

## Resultado executado

- API: 702 passaram.
- Web: 109 passaram.
- Mobile: 35 passaram.
- Central: 173 passaram; 13 Postgres pulados.
- Python: 237 passaram; 93 ML pulados.
- Go: não iniciou, toolchain ausente.
- TypeScript, Prisma, shell, JavaScript e Compose: validações passaram.

## Pontos fortes

A API possui regressões extensas de streaming, VOD, privacidade, IA, jobs,
observabilidade e falhas. Web cobre VOD, timeline, branding e parsing. Central
cobre datastore, scheduler e série temporal. Python contém testes de backoff,
watchdog, fila latest-frame e geometria.

## Lacunas vinculadas a achados

| Achado | Teste ausente |
|---|---|
| 002 | falha de unlink/DB/crash em cada passo de retenção |
| 003 | matriz de sub-redes negadas, loopback, metadata e Docker control-plane |
| 004 | `RESTRICTED` contra ZIP e download de clip |
| 005 | sessão após delete/troca de senha |
| 006/007 | update/restore destrutivo em laboratório |
| 009 | smoke do Compose com `/central/` |
| 010 | admin privado em `canControl`/`canRecord` e relé |
| 011 | duas concessões concorrentes e revogação completa |
| 013 | bootstrap com Redis indisponível |
| 016 | duas instâncias Central concorrentes |
| 019 | symlink sob storage |
| 020 | health/shutdown do worker Go |

## Falsos-verdes evitados e presentes

O CI Python exige explicitamente toda a stack ML antes dos testes. No ambiente
local, 93 skips tornam o verde parcial e isso foi registrado. A Central retorna
exit 0 com 13 skips PG; é necessário banco efêmero no próximo gate.

Builds e e2e não foram executados para preservar a restrição de escrita.
