# Escopo de Runtime

Base: `main`, commit `fdc7588488108e5db60787f828cd7f65e76ec7f1`.

## Classificação

| Área | Classificação | Evidência e decisão |
|---|---|---|
| `apps/api/` | runtime ativo | workspace pnpm, `AppModule`, Dockerfile, Compose, CI, 702 testes |
| `apps/web/` | runtime ativo | workspace, Vite, Docker/Nginx, Compose e CI |
| `apps/mobile/` | runtime ativo | workspace Expo, CI Android e imports a partir de `App.tsx` |
| `apps/mobile/src/screens/redesign/` | runtime ativo | cinco telas importadas diretamente por `apps/mobile/App.tsx` |
| `apps/central/` | runtime pretendido, integração de deploy incompleta | workspace, testes, Dockerfile e proxy Nginx; não existe serviço `drac-central` no Compose |
| `services/ai-service-python/` | runtime ativo | serviço sem profile no Compose, API o chama em `ai-service:8000` |
| `services/camera-worker-go/` | legacy ainda referenciado | serviço atrás do profile `legacy-worker`; a própria implementação o identifica como legado |
| `infra/` | ferramenta operacional e configuração ativa | Compose, MediaMTX, Nginx, backup e variantes de ambiente |
| `scripts/` | ferramenta operacional ativa | instalação, atualização, restore, diagnóstico, watchdog e gates de produção |
| `apps/*/tests`, `services/ai-service-python/tests` | teste | executados por pacotes e CI; e2e separado |
| `apps/api/prisma/` | runtime e evolução de dados | schema, 38 migrations, seed e utilitários; seed não foi executado |
| `legacy/` | legacy ainda referenciado, fora da auditoria principal | somente `apps/api/scripts/import-legacy-camera.ts` extrai dados de `legacy/server.js`; não participa do runtime normal |
| `archive/` | arquivo/legacy não referenciado | nenhuma referência ativa encontrada |
| `Drac-app-redesign/`, `novo-design/`, `novo-mockup-app-drac/` | protótipo/redesign | sem imports; há apenas referências textuais de proveniência visual |
| `DRAC app redesign.zip` | arquivo compactado | ignorado pelo Git e listado pelo script de higiene |
| `services/ai-service-python/datasets/` | dataset de demonstração/teste | fora do fluxo de runtime; o contexto do Docker copia a árvore, mas o serviço não o consulta |
| `concorrentes/` | material de referência externo, não runtime | ignorado pelo Git e não referenciado pelo workspace/Compose |
| `drac-mobile.apk`, `drac-web.apk` | artefatos gerados preexistentes | ignorados pelo Git; não foram criados nem lidos na auditoria |
| `node_modules/`, `dist/`, nativos Android e caches | artefato gerado | excluídos da leitura sistemática salvo resolução de dependências |
| `check_recordings.js`, `check_users.js`, `reset_admin.js` | utilitário local ignorado, status operacional desconhecido | preexistentes, ignorados pelo Git, não referenciados; não executados |

## Fontes usadas para resolver o escopo

- `pnpm-workspace.yaml` inclui `apps/*` e `services/*`.
- `package.json` raiz define `pnpm verify` para API, mobile, web e Central.
- `.github/workflows/ci.yml` adiciona Python, RTSP e2e, imagens Docker e Android.
- `infra/docker-compose.yml` sobe API, web, Postgres, Redis, backups,
  MediaMTX e IA; worker Go e go2rtc são opt-in.
- `apps/web/nginx.conf` encaminha `/central/` para `drac-central:9765`,
  porém nenhum arquivo Compose define esse serviço.

## Referências de áreas inicialmente excluídas

- `apps/api/scripts/import-legacy-camera.ts:44` depende do formato de
  `legacy/server.js`; é migração manual e não foi executada.
- `apps/web/src/index.css:457` cita `novo-design/` somente como origem visual.
- `apps/mobile/src/screens/redesign/HomeRedesign.tsx:3` cita o mockup, mas as
  telas implementadas dentro de `apps/mobile` são código ativo.
- `scripts/repo-hygiene.sh:33-47` conhece os diretórios/ZIPs para higiene, não
  para build ou runtime.

## Limites

A auditoria principal abrangeu código próprio ativo e interfaces com os
componentes externos. Dependências de `node_modules`, código de concorrentes,
arquivos binários, datasets e protótipos não foram revisados linha a linha.
Nenhum `.env` real foi lido.
