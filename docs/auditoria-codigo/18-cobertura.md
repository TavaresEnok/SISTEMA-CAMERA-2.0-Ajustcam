# Cobertura da Auditoria

Profundidade: **profunda** = fluxos/chamadores/testes lidos; **média** =
entrypoints e hotspots; **triagem** = inventário/buscas sem leitura integral.

| Área | Arquivos aprox. | Status/profundidade | Ferramentas/testes | Limitações e próxima prioridade |
|---|---:|---|---|---|
| `apps/api/src/auth`, guards, users, roles | ~35 | analisado, profunda | `rg`, leitura, 702 testes | e2e com DB/SMTP; prioridade média |
| access control, grupos e permissões | ~18 | analisado, profunda | matriz/tests + schema | corrida grant em PG; prioridade alta |
| câmeras, ONVIF, PTZ | ~35 | analisado, profunda em auth/SSRF/processo | testes API | câmera/rede real; prioridade alta |
| camera-stream/MediaMTX | ~32 | analisado, média-profunda | buscas spawn, testes VOD/source | RTSP/WebRTC e2e/soak; alta |
| gravações/retenção/evidência | ~45 | analisado, profunda em paths/delete/download | testes API | fault injection FS/DB; crítica |
| IA/API, alarmes, notificações | ~30 | analisado, média | testes API | provedores externos/push real; média |
| demais módulos Nest | ~45 | analisado, triagem-média | controller inventory/patterns | mapas/investigações/integridade em 2ª passagem |
| Prisma/migrations | 40+ | analisado, média; hotspots profunda | `prisma validate` | migration status/upgrade real; alta |
| Redis/BullMQ | ~15 | analisado, média | testes unitários | outage/restart/locks real; alta |
| `apps/web/src` | 122 | analisado, média; auth/player profunda | 109 testes/typecheck | navegador/e2e e cleanup de players; alta |
| `apps/mobile` | 94 | analisado, média; sessão/transporte/files profunda | 35 testes/typecheck | aparelho, Gradle, push, biometria; alta |
| `apps/central/src` | 15 | analisado, profunda | 173 testes, 13 skips | duas instâncias/PG/SSH real; crítica |
| Central public UI | 2 | analisado, média para XSS/escaping | buscas de `innerHTML` | browser/CSRF/CSP e2e; média |
| IA Python | 63 | analisado, média; lifecycle/auth profunda | 237 pass/93 skip | stack ML/modelos/carga; alta |
| worker Go | 5 | analisado, média-profunda | busca/leitura; Go ausente | compilar, race detector, shutdown; alta se suportado |
| Compose/Dockerfiles/Nginx/MediaMTX | 18–21 | analisado, profunda estática | compose config | build/inspect/CVE/TLS/firewall; alta |
| scripts operacionais | 12 + infra | analisado, média-profunda | `bash -n`, leitura update/restore | laboratório destrutivo; crítica |
| `legacy/` | 7 | triagem; referência localizada | `rg` | importador manual em ambiente isolado; baixa |
| designs/mockups/archive/ZIP | 60+ | excluído, inventariado | referência global | fora do runtime |
| datasets | variável | excluído, inventariado | referência global | apenas se IA passar a consumi-los |
| `concorrentes/` | grande | excluído | somente classificação | código de terceiros/referência |
| dependências (`node_modules`, imagens, ML) | grande | não auditado | manifests/lock indiretos | SCA/SBOM/CVE na etapa 2 |

## Buscas sistemáticas

Nos escopos ativos foram pesquisados: TODO/FIXME/HACK/XXX, `any`/ts-ignore,
subprocessos/shell, operações de remoção, chamadas de rede, segredos por nome,
raw SQL, timers/listeners, CORS, IPs/portas e defaults. Ocorrências foram
analisadas por contexto; contagens brutas não viraram achados automaticamente.

Exemplos de universo em `src`: API 208 arquivos, web 122, mobile 52, Central
15, IA 63 no diretório total e worker Go 5.

## Testes não cobertos

- builds API/web/Android/Docker;
- API operational e2e e RTSP fixture;
- migrations em banco real;
- Central PG (13 skips);
- Python ML (93 skips);
- Go (toolchain ausente);
- restore/update/backup e falhas de energia/disco.

Portanto, este relatório não declara revisão linha a linha do repositório
inteiro. É uma primeira passagem sistemática com profundidade concentrada nos
limites de segurança, dados e disponibilidade.

## Limitação de Concorrência no Workspace

Artefatos ignorados em `apps/api/dist/` e `apps/web/dist/` receberam novos
horários de modificação durante a janela da auditoria, sem que a sequência de
comandos desta auditoria executasse build. O Git permaneceu sem alterações em
arquivos rastreados e mostrou como novos apenas os documentos da auditoria, mas
essa atividade concorrente impede certificar a imutabilidade de todos os
arquivos ignorados durante a janela.
