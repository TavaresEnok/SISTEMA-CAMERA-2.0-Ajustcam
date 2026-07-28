# Ambiente da segunda etapa

Data da preparação: 2026-07-28, a partir de 16:12 UTC.

## Estado Git inicial

| Verificação | Resultado |
|---|---|
| `git status --short` | `?? docs/auditoria-codigo/` |
| `git branch --show-current` | `main` |
| `git rev-parse HEAD` | `fdc7588488108e5db60787f828cd7f65e76ec7f1` |

O diretório não rastreado já era a saída autorizada da primeira etapa. Antes
de criar `validacao/`, nenhum arquivo sob `docs/auditoria-codigo/` tinha
timestamp posterior ao início desta etapa. Não havia diferença rastreada,
staged ou alteração de branch.

Nenhum `.env` real foi aberto ou impresso. Os comandos Compose que precisaram
resolver variáveis usaram explicitamente `infra/.env.example`; inspeções de
containers foram limitadas a mounts, usuário, rede, portas, restart e
health, sem ler `Config.Env`.

## Investigação de atividade concorrente

Foram inspecionados processos, diretórios de trabalho em `/proc`, arquivos
abertos, containers e mounts.

- Havia um ambiente de desenvolvimento mobile ativo: `node`, shell, logger,
  `tail` e ADB com diretório sob `apps/mobile`.
- Havia processos de editor/automação com o repositório como diretório de
  trabalho.
- Não foi encontrado watcher, servidor Vite ou processo Node com arquivo
  aberto em `apps/api/dist/` ou `apps/web/dist/`.
- `lsof` não encontrou descritores abertos nos dois diretórios `dist`.
- Metadados de nome, tamanho e mtime dos dois `dist` permaneceram estáveis em
  três amostras durante dez segundos. Os digests de metadados observados
  foram `b9d4210…bb7abe` para API e `cf5c8cf…63f99cc` para web.
- Nenhum teste desta etapa consumiu ou reconstruiu esses artefatos.

Containers DRAC estavam ativos, incluindo `vms-api`, `vms-web`,
`vms-ai-service`, `drac-central`, `vms-mediamtx`, `vms-postgres` e
`vms-redis`. A inspeção de mounts mostrou:

- API: `infra/storage` gravável em `/storage`;
- IA: o fonte `services/ai-service-python` gravável em `/app`, além de
  storage e modelos;
- web: somente o diretório de APK em modo somente leitura;
- Central: bind de `/home/flashnet/drac-central` em `/app`, fora deste
  checkout;
- nenhum container montava `apps/api/dist` ou `apps/web/dist`.

O runtime ativo continuou criando segmentos, MP4, thumbnails e estado de
monitoramento sob `infra/storage/` durante toda a auditoria. Essa escrita
concorrente é atribuível aos processos de gravação/monitor já existentes e
não aos harnesses, que trabalharam somente em diretórios temporários. Portanto
não é possível certificar que **todos os arquivos ignorados** fora de
`validacao/` ficaram inalterados; é possível certificar que nenhuma mudança
Git rastreada/staged foi feita e que nenhum teste usou esse storage.

A listagem de processos também mostrou URL RTSP com credencial embutida no
`argv` de FFmpeg. O valor não é reproduzido neste relatório. Trata-se de dado
do runtime, não de segredo versionado identificado; a exposição local por
lista de processos merece inventário próprio numa próxima etapa.

O `drac-central` externo está manualmente conectado à rede `infra_vms-net`;
por isso o `vms-web` atual resolve o hostname `drac-central`. Essa é uma
proteção do ambiente corrente, não uma declaração presente nos arquivos
Compose versionados.

## Decisão de isolamento

Não foram feitas requisições funcionais aos serviços DRAC ativos, não foi
usado o Postgres/Redis real e não foram tocados storage, câmeras ou
MediaMTX. As reproduções usaram:

- servidores HTTP/TCP apenas em `127.0.0.1`, portas efêmeras dedicadas;
- bancos JSON sintéticos sob diretórios criados por `mkdtemp`;
- arquivos e symlinks sentinela sob `/tmp`;
- objetos Prisma/services falsos em memória;
- inspeção estática para update, restore e instalador;
- destruição apenas dos próprios processos/arquivos temporários criados pelos
  testes.

Um teste BullMQ local intencionalmente simulou um Redis que aceita TCP e não
responde. A operação permaneceu pendente mesmo após o prazo externo e os três
processos sintéticos foram encerrados explicitamente; nenhuma porta ou
processo do teste permaneceu ativo.

Na amostra final, o digest conjunto de metadados de `apps/api/dist` e
`apps/web/dist` foi idêntico antes e depois de três segundos
(`018058dd…eac99a`). Não apareceu watcher desses diretórios. Processos de
FFmpeg/MediaMTX/go2rtc do runtime permaneceram ativos e explicam a atividade
de storage; eles não foram interrompidos.

## Ferramentas disponíveis

| Ferramenta | Versão/estado |
|---|---|
| Node.js | `v22.21.1` |
| pnpm | `9.15.0` |
| Python | `3.12.3` |
| Go | ausente do `PATH` |
| Docker/Compose | disponível; usado somente para inspeção e `config` |

## Comandos seguros relevantes

| Comando | Diretório | Saída | Duração aproximada |
|---|---|---:|---:|
| `bash -n scripts/update-drac.sh scripts/restore-drac.sh scripts/install-drac.sh` | raiz | 0 | < 0,01 s |
| testes focais `access-matrix` e `group-access-block` | `apps/api` | 15 passaram | 0,34 s |
| `pnpm test` | `apps/central` | 173 passaram, 13 pulados | 1,73 s |
| `python3 -m unittest discover ... -v` | raiz | 237 total: 144 passaram, 93 pulados, 0 falhas | 1,57 s |
| Compose prod `config --services` com `.env.example` | raiz | 9 serviços; sem Central | < 1 s |
| Compose dev `config --services` com `.env.example` | raiz | 10 serviços; sem Central | < 1 s |

Também foram executados harnesses locais para Central, autorização,
retenção, symlink, SSRF sem rede, BullMQ blackhole e build-agent blackhole.
Seus resultados estão associados aos achados nos relatórios seguintes.

## Limitações ambientais

- Não houve laboratório Postgres descartável para fault injection de
  migration/update/restore.
- Não houve câmera/ONVIF/RTSP real ou rede de controle isolada.
- Não foram simulados disco cheio, perda de energia ou filesystem remoto.
- A stack ML Python não está instalada no host; construir a imagem de testes
  implicaria instalação/build, proibidos nesta etapa.
- Go 1.22 não está instalado.
- Não houve aparelho mobile, navegador instrumentado, HSM/chave de assinatura
  ou infraestrutura de release.

## Encerramento do repositório

- `git diff --name-only` e `git diff --cached --name-only` permaneceram
  vazios.
- O status curto permaneceu `?? docs/auditoria-codigo/`, pois toda a
  documentação da primeira etapa já era não rastreada no início.
- Nenhum arquivo preexistente no nível anterior
  `docs/auditoria-codigo/*.md` recebeu mtime desta etapa.
- As únicas saídas atribuíveis à auditoria foram os doze arquivos em
  `docs/auditoria-codigo/validacao/` (dez saídas numeradas, README e o índice
  pelo nome alternativo solicitado).
- Nenhum commit, stage, checkout, reset, rebase, push ou alteração de branch
  foi feito.

Essa confirmação se refere a Git, fonte e documentação. Os arquivos ignorados
de `infra/storage/` continuaram sendo modificados pelo runtime concorrente,
como registrado acima.
