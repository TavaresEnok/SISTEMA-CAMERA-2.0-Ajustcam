# Baseline de Validação

Data: 2026-07-28 UTC. Nenhuma instalação de dependência foi feita.

## Comandos executados

| Comando | Diretório | Exit | Duração | Resultado |
|---|---|---:|---:|---|
| `pnpm --filter api test` | raiz | 0 | 4,35 s | 702/702 passaram |
| `pnpm --filter mobile test:mobile` | raiz | 0 | 0,90 s | 35/35 passaram |
| `pnpm --filter web test` | raiz | 0 | 0,78 s | 109/109 passaram |
| `pnpm --filter drac-central test` | raiz | 0 | 1,96 s | 173 passaram, 13 PG pulados |
| `pnpm --filter api exec tsc --noEmit -p tsconfig.json && pnpm --filter web typecheck && pnpm --filter mobile typecheck` | raiz | 0 | 17,75 s | sem erro TypeScript |
| `python3 -m unittest discover -s services/ai-service-python/tests -t services/ai-service-python -v` | raiz | 0 | 1,73 s | 237 passaram, 93 pulados por falta de ML |
| `go test -mod=readonly ./...` | `services/camera-worker-go` | 127 | 0 s | não iniciou: `go` ausente |
| `for f in scripts/*.sh infra/*.sh apps/mobile/scripts/*.sh; do bash -n "$f" ...` | raiz | 0 | 0,02 s | sintaxe válida |
| `DATABASE_URL=postgresql://audit_invalid:...@127.0.0.1:1/audit_invalid pnpm --filter api exec prisma validate` | raiz | 0 | 0,89 s | schema válido; URL descartável mascarada aqui |
| `docker compose --env-file infra/.env.example -f infra/docker-compose.yml -f infra/docker-compose.prod.yml config --quiet` | raiz | 0 | 0,35 s | configuração resolvida |
| `find apps/central/src apps/mobile/scripts ... \| xargs ... node --check` | raiz | 0 | 0,29 s | JavaScript sintaticamente válido |

## Comandos oficiais identificados e não executados

| Comando | Motivo |
|---|---|
| `pnpm verify` | inclui builds que criam/sobrescrevem `dist/`, proibido pela restrição de criar somente em `docs/auditoria-codigo/` |
| `pnpm --filter api build` | emite `dist/`; substituído por `tsc --noEmit` |
| `pnpm --filter web build` | emite `dist/`; typecheck foi executado |
| build Android/Expo | cria projeto/artefatos nativos |
| `pnpm --filter api test:e2e` | fluxo operacional usa banco/serviços; não havia stack efêmera isolada autorizada |
| RTSP e2e | cria containers/rede e arquivos de mídia |
| Prisma migration status/deploy | exige banco real; nenhum banco foi acessado |
| Docker builds | criam imagens/caches e não cabem na política imutável |
| testes Python com stack ML completa | dependências `cv2/onnxruntime/supervision` não estavam disponíveis; não foi permitido instalar |
| scripts install/update/restore/backup/seed/reset/limpeza | explicitamente destrutivos ou operacionais |

## CI e cobertura

O workflow oficial executa sintaxe de `scripts/*.sh`, suíte Python com stack ML
pinada, `pnpm verify`, RTSP e2e obrigatório, builds Docker e Android release.
Nesta máquina não foi possível repetir os gates que geram artefatos ou alteram
containers. O verde das suítes unitárias não cobre os achados de concorrência,
filesystem/banco, deploy da Central, Redis indisponível ou restore.
