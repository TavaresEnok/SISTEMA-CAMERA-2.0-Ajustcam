# Inventário de Arquivos

Contagem aproximada por `rg --files`, excluindo dependências e artefatos
gerados. A contagem indica universo, não leitura integral.

| Área | Arquivos aprox. | Detalhamento |
|---|---:|---|
| `apps/api/` | 317 | 208 em `src`, 61 testes, schema/scripts e 38 migrations |
| `apps/web/` | 152 | 122 em `src`, 25 páginas, 67 componentes, 9 testes |
| `apps/mobile/` | 94 | 52 em `src`, 14 telas, 12 componentes, 8 serviços, 3 testes |
| `apps/central/` | 38 | 15 em `src`, 2 públicos, 17 testes, Docker/script |
| `services/ai-service-python/` | 63 | 26 arquivos não-test/dataset e 18 arquivos de teste |
| `services/camera-worker-go/` | 5 | `main.go`, `recorder.go`, Dockerfile e módulo |
| `infra/` | 18–21 | Compose, MediaMTX, go2rtc, Nginx e scripts |
| `scripts/` | 12 | operação, validação, diagnóstico e e2e |
| `legacy/` | 7 | fora do runtime; uma referência de importação manual |
| `archive/` | 1 | não referenciado |
| `Drac-app-redesign/` | 20 | protótipo |
| `novo-design/` | 34 | protótipo |
| `novo-mockup-app-drac/` | 5 | protótipo |

## Inventário estrutural da API

- módulos: 32;
- controllers: 28;
- services: 44;
- DTOs: 46;
- guards: 4;
- filas/processors: 7;
- migrations: 38.

Controllers revisados por inventário: auth, users, role-permissions,
camera-permissions/groups, cameras, camera-stream, recordings, PTZ, IA,
evidence, investigations, alarms, notifications, settings, maps, sites/areas,
integrity, GPU, app-builder, cloud-connector, health e observabilidade.

## Arquivos sensíveis e artefatos locais

- Nenhum `.env` real foi lido ou impresso.
- `apps/mobile/google-services.json` é versionado. Seu conteúdo não foi
  reproduzido; trata-se de configuração cliente Firebase, que deve ser
  conferida por restrições de API/projeto, mas não foi classificada
  automaticamente como segredo.
- `secrets/drac-admin.initial`, `infra/.env` e
  `infra/build-agent.env` são ignorados pelo Git; foram identificados apenas
  pelo caminho/regra de ignore e não tiveram valores lidos.
- APKs, ZIP e helpers raiz citados no escopo já existiam antes da auditoria,
  estão ignorados e não foram alterados.
