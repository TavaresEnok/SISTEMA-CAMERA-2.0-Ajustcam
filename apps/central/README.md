# DRAC Central

Painel central para monitorar instalacoes DRAC VMS em servidores de clientes.

## Rodar a central

Nao ha dependencias externas obrigatorias; basta Node 20+. Em producao, rode atras de HTTPS/reverse proxy.

```bash
cd apps/central
cp .env.example .env
nano .env
npm start
```

Tambem pode rodar em container:

```bash
docker build -f apps/central/Dockerfile -t drac-central .
docker run --env-file apps/central/.env -p 9765:9765 -v drac-central-data:/app/data drac-central
```

Padrao local:

- Painel: `http://SERVIDOR:9765`
- Heartbeat: `POST /api/agent/heartbeat`

## Login administrativo

O painel humano usa apenas e-mail/senha e sessao por cookie.

Gere o hash da senha antes de preencher o `.env`:

```bash
npm run hash-password -- 'SENHA_FORTE_AQUI'
```

Variaveis:

```bash
DRAC_CENTRAL_ADMIN_EMAIL=admin@drac.local
DRAC_CENTRAL_ADMIN_PASSWORD_HASH=pbkdf2_sha256$...
DRAC_CENTRAL_SESSION_HOURS=8
DRAC_CENTRAL_ALLOWED_ORIGINS=https://central.seudominio.com.br
DRAC_CENTRAL_COOKIE_SECURE=true
```

`DRAC_CENTRAL_ADMIN_TOKEN` e opcional e serve somente para automacao/API interna. Deixe vazio se nao houver integracao tecnica consumindo os endpoints administrativos.

## Datastore: JSON ou Postgres (item 2.10)

Por padrao o datastore e o arquivo JSON (`DRAC_CENTRAL_DATA_FILE`). Para migrar para Postgres com seguranca, defina `DRAC_CENTRAL_DATABASE_URL`. A camada de dados vive em `src/datastore/` (mapeamento registro<->linha, resolucao dual-read, reconciliacao e store `pg` — logica pura testada em `tests/datastore-*.test.js`).

Fluxo de migracao segura:

1. **Backup das identidades de assinatura ANTES de migrar.** Na primeira subida em modo Postgres, a Central grava `signing-backup-<timestamp>.json` em `DRAC_CENTRAL_BACKUP_DIR` (default `<dir do data file>/backups`) com `licenseKey`, `installerToken`, `sshHostKeys` de cada instalacao e os hashes de senha admin — sem senha em claro. E durável (fsync).
2. **Reconciliacao (backfill).** Copia para o Postgres tudo que existe no JSON legado e falta no banco. Idempotente (o marker `migration` na tabela `central_meta` impede repetir).
3. **Dual-read (`DRAC_CENTRAL_STORE_MODE=dual`, default quando ha URL).** Le do Postgres e cai para o JSON legado (read-only) quando um registro ainda nao existe no banco. Escreve SO no Postgres; o JSON nunca e reescrito — e a **janela de rollback**.
4. **Cutover (`pg`).** Depois de validar alguns ciclos, mude para `DRAC_CENTRAL_STORE_MODE=pg` (so Postgres).

Variaveis:

```bash
DRAC_CENTRAL_DATABASE_URL=postgres://usuario:senha@host:5432/central
DRAC_CENTRAL_STORE_MODE=dual        # json | dual | pg
DRAC_CENTRAL_BACKUP_DIR=./data/backups
```

Testes do pacote (`pnpm --filter drac-central test`) rodam a logica pura sempre; os testes de integracao Postgres so rodam quando `DRAC_CENTRAL_DATABASE_URL` aponta para um banco (ex.: um Postgres efemero em docker), senao sao pulados.

## Heartbeat do DRAC local

Cada instalacao DRAC envia conexao outbound para o central. Nao precisa abrir porta no cliente.

Headers:

- `x-drac-installation-id`
- `x-drac-license-key`

## Gerador oficial de instalacao

No painel, use a aba `Instalação`.

A central:

- cria a instalacao como `Aguardando instalação`;
- gera a chave/licenca no servidor;
- grava auditoria;
- entrega um comando unico `curl ... | bash` para executar no servidor do cliente;
- usa `https://github.com/TavaresEnok/DRAC.git` por padrao, sem exigir chave SSH no cliente;
- detecta automaticamente o IP local quando o campo de servidor nao for preenchido;
- publica o instalador temporario em `/install/:installationId/:installerToken`;
- permite copiar novamente o instalador oficial pela instalacao selecionada;
- permite cancelar uma instalacao pendente antes do primeiro heartbeat.

API usada pelo painel:

```text
POST /api/admin/provision
GET /api/admin/installations/:id/installer
GET /api/admin/installations/:id/diagnostics
DELETE /api/admin/installations/:id
```

O `DELETE` remove apenas instalacoes que ainda nao enviaram heartbeat.

O diagnostico sanitizado nao inclui chave de licenca, token de instalador nem segredos. Ele consolida estado da instalacao, readiness, cameras, armazenamento, servidor, alertas ativos e ultimos heartbeats.

Estados comerciais suportados:

- `ACTIVE`
- `GRACE`
- `RESTRICTED`
- `SUSPENDED`

## Configurar uma instalacao DRAC local

No `infra/.env` do cliente:

```bash
CLOUD_CONNECTOR_ENABLED=true
CLOUD_API_URL=http://IP_OU_DOMINIO_DA_CENTRAL:9765
CLOUD_INSTALLATION_ID=cliente-001
CLOUD_LICENSE_KEY=chave-do-cliente
CLOUD_CUSTOMER_NAME=Nome do Cliente
CLOUD_HEARTBEAT_INTERVAL_SECONDS=60
DRAC_VERSION=local
```

Depois reinicie a API do cliente.

## Restricoes comerciais

Politica atual:

- `ACTIVE`: tudo normal.
- `GRACE`: tudo operacional, usado como periodo de tolerancia.
- `RESTRICTED`: bloqueia cadastro de novas cameras, IA avancada e atualizacoes; mantem live, gravacao, playback e exportacao.
- `SUSPENDED`: bloqueia live, novas gravacoes e IA; mantem login admin, playback e exportacao.

O operador ve mensagem generica na camera. Administradores podem consultar o motivo real via painel/estado da licenca.

Isso e intencional: `RESTRICTED` deve ser tratado como modo comercial degradado, nao como desligamento brusco de seguranca. Qualquer bloqueio futuro precisa preservar acesso minimo, evidencias e gravacao critica.

## Auditoria

A central registra em `data/installations.json`:

- login aceito, falha de login e bloqueio por excesso de tentativas;
- logout;
- alteracao de contrato;
- heartbeat recusado por chave invalida.

O painel exibe os ultimos eventos na aba `Auditoria`.

## Historico operacional

A Central guarda historico por instalacao para operacao real:

- ultimas amostras de heartbeat com cameras online/offline, disco, memoria, carga, alarmes e gravacoes;
- graficos compactos de tendencia da frota na tela principal;
- graficos por cliente no detalhe da instalacao;
- historico persistente de alertas com primeiro visto, ultimo visto, resolucao e quantidade de ocorrencias.

O tamanho do historico pode ser ajustado por:

```bash
DRAC_CENTRAL_HISTORY_LIMIT=100
DRAC_CENTRAL_ALERT_HISTORY_LIMIT=500
```

## Seguranca minima para producao

- Usar HTTPS na frente da central.
- Definir `DRAC_CENTRAL_ALLOWED_ORIGINS` com o dominio real.
- Definir `DRAC_CENTRAL_COOKIE_SECURE=true` quando estiver em HTTPS.
- Manter `DRAC_CENTRAL_ADMIN_TOKEN` vazio, exceto se houver automacao interna.
- Usar uma senha forte e armazenar somente `DRAC_CENTRAL_ADMIN_PASSWORD_HASH`.
- Fazer backup do arquivo definido em `DRAC_CENTRAL_DATA_FILE`.
- Proteger a porta `9765` por firewall/reverse proxy.
- Monitorar logs do container e alertar falhas de heartbeat.
