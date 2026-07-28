# Auditoria Técnica DRAC VMS — Etapa 1

## Identificação

- **Commit:** `fdc7588488108e5db60787f828cd7f65e76ec7f1`
- **Branch:** `main`
- **Data:** 2026-07-28 UTC
- **Estado inicial:** árvore Git limpa
- **Alterações visíveis ao Git:** somente documentos novos em
  `docs/auditoria-codigo/`; nenhum arquivo rastreado preexistente foi modificado
  pela auditoria e nenhum commit foi criado

Durante a verificação de encerramento, artefatos ignorados em `apps/api/dist/` e
`apps/web/dist/` apresentaram horários de modificação dentro da janela da
auditoria. A trilha de comandos desta auditoria não contém build; por isso, o
evento foi tratado como atividade concorrente externa e registrado em
[00-estado-inicial.md](00-estado-inicial.md), sem tentar alterar ou restaurar
esses arquivos.

## Resultado executivo

Foram registrados 25 itens: 1 CRÍTICO, 9 ALTOS, 11 MÉDIOS, 2 BAIXOS e 2
INFORMATIVOS. Confiança: 15 CONFIRMADOS, 8 ALTOS e 2 MÉDIOS.

Os dez maiores riscos, em ordem recomendada:

1. instalador `curl | bash` a partir de `main`, sem assinatura/pin;
2. retenção não atômica entre banco e filesystem;
3. SSRF/port scan de câmera contra loopback/rede interna;
4. bypass de `RESTRICTED` em ZIP e clip;
5. sessões Central válidas após delete/troca de senha;
6. rollback de update concorrente com aplicação e falhas silenciadas;
7. restore destrutivo sem validação/cutover/rollback;
8. `installerToken` permanente e reutilizável;
9. proxy Central sem serviço correspondente no Compose;
10. admin podendo PTZ/relé/gravação em câmera privada alheia.

## Escopo ativo

API NestJS, web React/Vite, mobile Expo, Central, IA FastAPI, Prisma/Postgres,
Redis/BullMQ, MediaMTX/FFmpeg/ONVIF, infraestrutura e scripts operacionais.
Worker Go foi tratado como legacy opt-in ainda referenciado.

Excluídos da auditoria principal: `legacy/` salvo importador manual,
`archive/`, protótipos/redesigns de topo, ZIP/APKs, datasets demo,
`concorrentes/`, dependências e artefatos gerados. As telas redesign internas
do mobile são ativas e foram incluídas.

## Arquitetura

Web/mobile consomem a API; API persiste via Prisma/Postgres, agenda BullMQ/Redis
e orquestra câmeras/MediaMTX/FFmpeg/ONVIF e IA. Gravações combinam metadados SQL
e arquivos em volume. Instalações enviam heartbeat/licença à Central, que
também provisiona instalador, SSH e APK/build-agent.

## Baseline

Passaram:

- API: 702 testes;
- web: 109 testes;
- mobile: 35 testes;
- Central: 173 testes, com 13 PG pulados;
- Python: 237 testes, com 93 ML pulados;
- typecheck API/web/mobile, Prisma validate, shell/JavaScript syntax e Compose
  config.

Falhou por ambiente: `go test -mod=readonly ./...` nem iniciou (`go` ausente).

Não executados por restrição: `pnpm verify` completo e builds (gerariam
`dist/`/artefatos), API/RTSP e2e, Docker/Android builds, migration status,
install/update/restore/backup/seed/reset. Nenhum `.env` real foi lido.

## Riscos de dados, disponibilidade e segurança

**Gravações/dados:** retenção pode criar órfãos ou linhas sem arquivo; restore e
rollback podem produzir estado parcial; proprietário de câmera não tem FK;
permissões podem duplicar por corrida.

**Disponibilidade:** Central padrão retorna 502 por serviço ausente; Redis pode
prender bootstrap da API; build-agent sem timeout pode bloquear a fila global
da Central; worker legacy é sempre unhealthy.

**Segurança:** supply chain do instalador, SSRF interno, bypass de histórico,
controle físico de câmera privada, revogação incompleta da Central, JWT web em
localStorage, container root e trust de proxy direto.

## Atualização e restauração

O updater cria dump/snapshot, mas seu rollback não quiesce a aplicação e
silencia falhas. O restore não chama o verificador em banco temporário, não cria
backup do alvo e aplica DB/storage sem cutover atômico. Antes de qualquer
correção funcional, esses dois procedimentos devem ganhar ensaio destrutivo em
ambiente descartável e critérios verificáveis de sucesso.

## Divergências documentação/implementação

- Nginx promete `/central/`, Compose não fornece `drac-central`.
- README Central publica a porta diretamente, enquanto segurança de IP assume
  proxy que sobrescreve `X-Real-IP`.
- Regra `RESTRICTED` promete cortar histórico/exportação, mas ZIP/clip usam gate
  de live.
- Privacidade permite gestão técnica, mas o mesmo atalho abre PTZ, relé e
  gravação.
- Imagem IA é construída, porém runtime prod a sobrepõe com fonte do host.

## Módulos com menor cobertura

Restore/update, Redis off/recovery, Central multi-instância/PG/SSH,
filesystem/symlink/fault injection, worker Go, ML completo, mobile em aparelho,
WebRTC/RTSP de longa duração, browser e2e e segurança externa Firebase/TLS.

## Ordem de correção

1. pin/assinar instalador e revogar tokens de provisionamento;
2. fechar SSRF e capabilities privadas/histórico;
3. tornar delete/retention reconciliável;
4. revogar sessões Central e adicionar timeout;
5. corrigir serviço Central no deploy;
6. redesenhar update/restore com quiesce, validação e rollback;
7. adicionar constraints/FK após saneamento de dados;
8. definir comportamento Redis off;
9. endurecer sessão web, containers e Compose IA;
10. resolver ou remover worker legado.

Precisam de decisão de negócio: sub-redes legítimas de câmera; alcance exato de
admin em câmera privada; política de delete/transferência do owner; suporte a
múltiplas Central; screenshots mobile; manutenção do worker Go.

## Plano para a etapa 2

1. reproduzir achados 002/006/007/011/013/016/019 em laboratório;
2. executar CI completo em checkout descartável, inclusive ML/PG/Go/RTSP;
3. construir/inspecionar imagens, UIDs, mounts, SBOM e CVEs;
4. testar browser/mobile e fluxos de sessão/revogação;
5. validar backup/restore com checks de arquivos e banco;
6. transformar cada achado confirmado em teste de regressão antes da correção;
7. elaborar patches separados, sem misturar migration, auth, storage e deploy.

Detalhes: [inventário de achados](inventario-achados.md), [revisão
contraditória](17-revisao-contraditoria.md) e
[cobertura](18-cobertura.md).
