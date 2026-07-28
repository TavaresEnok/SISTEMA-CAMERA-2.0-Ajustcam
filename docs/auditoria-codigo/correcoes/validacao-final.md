# Validação final da remediação

Data: 2026-07-28
Branch: `fix/auditoria-completa`
HEAD usado na validação pré-commit:
`fe6f6c416af3da6388915b8a8d1d991ee900738b`

O commit `fe6f6c4` já existia no HEAD durante a conclusão desta etapa e foi
preservado. Os testes abaixo não usaram banco, storage, câmeras ou serviços da
instalação ativa.

## Suítes e builds

| Área | Comando/ambiente | Resultado |
|---|---|---|
| API | `pnpm --filter api test` | 748 aprovados, 0 falhas |
| Mobile | `pnpm test:mobile` | 35 aprovados, 0 falhas |
| Web | `pnpm --filter web test` | 109 aprovados, 0 falhas |
| Central padrão | `pnpm --filter drac-central test` | 195 aprovados, 13 condicionais pulados |
| Central + PG | mesma suíte com PostgreSQL 16 efêmero | 208 aprovados, 0 pulos |
| API | `pnpm --filter api build` | aprovado |
| Web | typecheck + build Vite | aprovados |
| Mobile | typecheck | aprovado |
| Python | imagem de produção, `unittest discover` | 237 aprovados |
| Go | Go 1.22 em cópia temporária | test com race, vet e build aprovados |
| Docker | Compose build de API/Web/Central/IA/worker | cinco imagens aprovadas |
| Compose | base, dev, prod e GPU | quatro configs válidas |
| Shell | install/update/restore/shim | sintaxe aprovada |

O módulo Go ainda não versiona `go.sum`. Para não alterar a resolução declarada,
os comandos diretos foram executados numa cópia temporária após `go mod tidy`;
a própria imagem faz o mesmo antes de test, vet e build.

## PostgreSQL e migration

Num PostgreSQL 16 sem volume:

1. as 39 migrations foram aplicadas do zero por `prisma migrate deploy`;
2. as constraints da migration nova foram removidas apenas dentro do banco
   descartável;
3. foram inseridas permissões sem alvo, com dois alvos e duplicadas em níveis
   diferentes, além de uma câmera com dono inexistente;
4. a migration foi executada novamente;
5. foi confirmado que o menor privilégio sobrevive, linhas inválidas somem,
   dono órfão vira `NULL`, duplicata é recusada, alvo ausente é recusado e um
   usuário ainda proprietário não pode ser excluído.

O container foi removido sem volume ao final.

## Update e restore

O shim em `scripts/tests/ops-lab-shim.sh` encaminha `docker exec/cp/inspect` ao
Docker real, mas intercepta exclusivamente `docker compose` e `curl`. Assim os
scripts puderam ser exercitados sem parar ou recriar o DRAC.

Update:

- repositório Git e origin descartáveis;
- atualização real por fetch + fast-forward;
- PostgreSQL real efêmero para `pg_dump`, `pg_restore --list` e preflight;
- ordem confirmada: backup, fetch, build, preflight, quiesce, migration, start,
  healthcheck;
- o primeiro ensaio revelou que um `CASE` ainda resolvia a relação
  `_prisma_migrations` ausente; o preflight foi corrigido e o ensaio completo
  passou novamente com `set -e`.

Restore:

- dump de origem e banco-alvo diferentes, ambos descartáveis;
- storage antigo e archive novo em diretórios temporários;
- caminho de sucesso confirmou banco e storage novos;
- numa segunda raiz, o primeiro healthcheck foi forçado a falhar após o
  cutover;
- o script terminou com erro e confirmou banco e storage antigos restaurados.

Nenhum script de instalação foi executado.

## Segredo RTSP fora de `argv`

Além dos testes de estrutura, foi executado FFmpeg real contra MediaMTX
descartável com credenciais fictícias:

- entrada fornecida por ffconcat em `fd 3`;
- `rtsp_transport=tcp` preservado como opção do demuxer;
- `/proc/<pid>/cmdline` inspecionado durante a execução;
- nome de usuário, senha e URL completa ausentes;
- nenhum valor real foi lido, copiado ou registrado.

## Limitações honestas

Ainda dependem de ambiente externo, não de código pendente:

- publicação de release/commit e SHA-256 aprovado do instalador;
- CIDRs reais da rede de câmeras e dos proxies confiáveis;
- certificados, DNS e proxy TLS de produção;
- câmera/ONVIF/PTZ/relé e codecs específicos;
- GPU/NPU e drivers do host;
- Android/iOS físico para bloqueio de captura e ciclo background/foreground;
- ensaio final numa cópia representativa dos volumes e tempos de produção.

Não foi feita implantação, push ou alteração de dados reais.
