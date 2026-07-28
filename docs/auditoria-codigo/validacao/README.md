# Segunda etapa da auditoria técnica do DRAC VMS

Data: 2026-07-28  
Branch: `main`  
Commit analisado: `fdc7588488108e5db60787f828cd7f65e76ec7f1`

## Resultado executivo

Foram reavaliados o achado CRÍTICO, os nove ALTOS e os onze MÉDIOS com
potencial de segurança, perda/integridade de dados ou indisponibilidade. Não
houve correção de código, alteração de teste existente, instalação,
update/restore real, commit ou acesso funcional aos dados/serviços DRAC
ativos.

| Severidade revisada | Quantidade |
|---|---:|
| CRÍTICA | 1 |
| ALTA | 9 |
| MÉDIA | 11 |
| **Total validado** | **21** |

| Decisão final | Quantidade |
|---|---:|
| CONFIRMADO E REPRODUZIDO | 11 |
| CONFIRMADO POR ANÁLISE | 4 |
| PROVÁVEL | 1 |
| DEPENDE DE CONFIGURAÇÃO | 4 |
| DEPENDE DE REGRA DE NEGÓCIO | 1 |
| NÃO REPRODUZIDO | 0 |
| FALSO POSITIVO | 0 |
| DUPLICADO | 0 |

Confiança revisada: 15 CONFIRMADOS e 6 ALTOS. Nenhum achado validado foi
descartado. DRAC-AUD-009, 016, 017 e 020 foram explicitamente condicionados à
topologia/profile; DRAC-AUD-012 aguarda política de propriedade.

## Achados priorizados

| Ordem | ID | Resultado principal |
|---:|---|---|
| 1 | DRAC-AUD-001 | Central emitiu duas vezes um script estável contendo `curl` de URL configurável/móvel para shell; fluxo alcança root. Nenhum instalador foi executado. |
| 2 | DRAC-AUD-003 | Create/update persistem destinos sem a guarda do draft; loopback, metadata, IPv6, DNS e portas arbitrárias alcançam consumidores. |
| 3 | DRAC-AUD-004 | ZIP e download de clip exportado usaram `view`, não `playback`; usuário RESTRICTED recebeu tokens e chegou aos dois handlers. |
| 4 | DRAC-AUD-005 | Cookie da Central continuou autenticado após excluir usuário e após trocar senha. |
| 5 | DRAC-AUD-002 | Foram reproduzidos os dois sentidos de divergência: linha apagada com arquivo preservado e arquivo apagado com DB falho. |
| 6 | DRAC-AUD-006 | Rollback restaura DB com aplicação ativa, tolera falhas críticas e pode declarar sucesso. Confirmado pelo fluxo, não executado. |
| 7 | DRAC-AUD-007 | Restore limpa o banco antes de validação integral e não possui rollback. Confirmado pelo fluxo, não executado. |
| 8 | DRAC-AUD-008 | Duas leituras consecutivas do mesmo installerToken retornaram 200 e conteúdo idêntico; não há expiração/consumo. |
| 9 | DRAC-AUD-010 | Em câmera privada alheia, admin obteve `view=false`, mas `control=true` e `record=true`. |
| 10 | DRAC-AUD-018 | Build-agent blackhole bloqueou a fila global; health só voltou após o socket ser destruído. |

A matriz completa, incluindo probabilidade, perda, indisponibilidade,
exposição, complexidade, regressão, testes e dependências, está em
[04-matriz-risco.md](04-matriz-risco.md).

## Primeira correção recomendada

Corrigir primeiro **DRAC-AUD-001** em um lote isolado:

1. recusar branch móvel (`main`) e selecionar commit/release imutável;
2. baixar para arquivo, nunca executar por pipe;
3. exigir SHA-256 publicado pela Central e falhar fechado;
4. registrar versão, commit e digest na auditoria;
5. testar conteúdo trocado, digest inválido, redirect, downgrade e offline;
6. evoluir o mesmo manifest para assinatura de release.

Não misturar esse lote com refatoração do instalador, migration, token,
dependências ou updater. O modelo de ameaça e quatro alternativas estão em
[01-achado-critico.md](01-achado-critico.md).

## Evidências de reprodução segura

- Central efêmera, datastore JSON sintético e URL dummy em loopback:
  confirmou replay do instalador, sessões pós-delete/pós-senha e trust direto
  de `X-Real-IP`.
- Services/Prisma falsos e arquivos temporários: confirmaram inconsistência
  DB↔filesystem, bypass RESTRICTED, capacidades de admin e symlink.
- Tabelas de DTO/helper/URL sem abrir sockets: demonstraram a cadeia SSRF.
- Blackholes TCP locais com deadline externo: confirmaram bloqueio do
  build-agent e Promise BullMQ pendente.
- `docker compose config`, `docker inspect` e resolução interna:
  confirmaram bind de fonte IA, usuário root e a proteção manual atual da
  Central.
- Scripts install/update/restore foram somente lidos e submetidos a
  `bash -n`; nenhum foi executado.

Não houve conexão com metadata, host externo, câmera, ONVIF, RTSP ou serviço
DRAC ativo. Os PIDs/portas sintéticos foram encerrados ao fim dos harnesses.

## Autorização e sessões

O bypass RESTRICTED é server-side, não mera ocultação de frontend. Download
individual usa `playback`, mas ZIP e clip exportado usavam `view`. Web alcança
esses fluxos; mobile usa endpoints individuais atualmente bloqueados.
Investigação exporta metadados JSON, não mídia bruta, e ainda requer decisão
de negócio para o estado RESTRICTED.

A API Nest não é um JWT stateless sem revogação: cada access token reconsulta
usuário ativo e `authVersion`; logout, senha, reset e delete invalidam sessão.
O web, porém, guarda access de até 8 h em `localStorage` e seu logout é apenas
local. O mobile usa SecureStore e refresh rotativo. A Central usa cookie opaco
de 8 h, mas não revalida owner nem revoga em delete/senha — falha reproduzida.
Bearer admin, suspensão da instalação e revogação por dispositivo ainda
precisam de política explícita.

As matrizes completas estão em [02-achados-altos.md](02-achados-altos.md) e
[07-dependencias-decisoes.md](07-dependencias-decisoes.md).

## Gravações e consistência

Foram mapeados captura TS, remux MP4, `fsync`, registro DB, remoção TS,
rename, exportação, retenção, delete-all, integrity check e restore. Estados
possíveis incluem:

- arquivo sem linha e linha sem arquivo;
- TS parcial, TS+MP4 e MP4 zero/truncado;
- clip/derivado órfão;
- DB e storage de epochs diferentes;
- delete declarado com unlink falho;
- bytes removidos antes de transação DB falhar.

O recovery existente adota/quarentena parte dos segmentos, mas não fecha
todos os estados nem transforma o integrity check em reparo. O plano
[05-plano-testes.md](05-plano-testes.md) define REC-01 a REC-22, cobrindo
crash, disco cheio, DB/storage indisponível, concorrência, restore, retenção e
symlink.

## Baseline executado

| Validação | Resultado | Duração aproximada |
|---|---|---:|
| API: access matrix + group block | 15 aprovados, 0 falhas | 0,34 s |
| Central: `pnpm test` | 186 total: 173 aprovados, 13 pulados, 0 falhas | 1,73 s |
| Python unittest | 237 total: 144 aprovados, 93 pulados, 0 falhas | 1,57 s |
| Shell `bash -n` | install/update/restore aprovados sintaticamente | < 0,01 s |
| Compose prod/dev `config --services` | 9/10 serviços; nenhum service Central | < 1 s cada |
| Go | não executado; toolchain ausente | — |

### Correção da contagem Python da primeira etapa

A primeira etapa reportou “237 aprovados e 93 pulados”. A saída objetiva
reexecutada foi `Ran 237 tests` e `OK (skipped=93)`: portanto são **144
aprovados e 93 pulados**, total 237. Todos os 93 foram classificados como
dependência ausente (`cv2`, `requests` carregado com stream ou `supervision`);
nenhum exige hardware, modelo ou serviço externo e todos cobrem fluxos de
produção executáveis no CI ML. Detalhes em
[09-testes-python-pulados.md](09-testes-python-pulados.md).

O Go module exige 1.22, alinhado ao Dockerfile. Como `go` não existe no
ambiente, não se instalou outra versão nem se executaram `go test`, `-race` ou
`vet`. Também não há `_test.go` nem job Go no CI. Ver [08-go.md](08-go.md).

## Ambiente e atividade concorrente

No início:

```text
git status --short        ?? docs/auditoria-codigo/
git branch --show-current main
git rev-parse HEAD        fdc7588488108e5db60787f828cd7f65e76ec7f1
```

Havia processos de desenvolvimento mobile e containers DRAC ativos. Não foi
encontrado watcher, arquivo aberto ou mount sobre `apps/api/dist` ou
`apps/web/dist`; três amostras de metadados permaneceram estáveis durante dez
segundos. Por segurança, nenhum teste dependeu desses artefatos e nenhum
request foi enviado aos serviços com dados reais. O diagnóstico completo está
em [00-ambiente.md](00-ambiente.md).

Os containers de gravação/monitoramento continuaram alterando arquivos
ignorados em `infra/storage/`. Isso impede certificar imutabilidade de todos
os artefatos ignorados, mas não do Git: não houve diferença rastreada ou
staged. A auditoria criou/alterou somente os documentos desta pasta. Uma URL
RTSP com credencial também estava visível no `argv` de processo FFmpeg; o
valor foi completamente omitido e não foi classificado como segredo
versionado.

## O que continua dependendo de ambiente ou hardware

- Go 1.22 para test/race/vet do worker.
- PostgreSQL e Redis inteiramente descartáveis para corrida, migrations,
  recovery e boot end-to-end.
- Simuladores/namespace IPv4+IPv6/DNS sem egress para SSRF e rebinding.
- VM com snapshots para update, restore, power loss e rollback.
- Loop device/disco cheio e filesystems oficialmente suportados, inclusive
  NFS se aplicável.
- Câmera/ONVIF/RTSP, PTZ/relay e GPU/NPU em laboratório.
- Browser e device/emulador para cookie/CSP, background, biometria e WebRTC.
- Duas Centrais efêmeras, build-agent fake completo e instalação Compose nova.
- Infraestrutura de release/chaves para validar assinatura e revogação.

## O que continua dependendo de regra de negócio

- Redes/hostnames de câmera permitidos e procedimento de exceção.
- Histórico/evidência/artefato prévio durante RESTRICTED.
- PTZ, relay e gravação administrativa em câmera privada.
- Revogação de todas versus uma sessão, bearer Central e device lost.
- TTL, consumo e retries do installerToken.
- Política de órfãos, estados de mídia, retenção, RPO e RTO.
- Propriedade da câmera quando owner é excluído e dedupe de permissões.
- Central integrada/externa, singleton/HA e proxies confiáveis.
- Suporte ou aposentadoria do worker Go.
- Arquitetura auth web, filesystems, modelos IA e UID/GID de volumes.

## Documentos desta etapa

- [00-ambiente.md](00-ambiente.md)
- [01-achado-critico.md](01-achado-critico.md)
- [02-achados-altos.md](02-achados-altos.md)
- [03-achados-medios-prioritarios.md](03-achados-medios-prioritarios.md)
- [04-matriz-risco.md](04-matriz-risco.md)
- [05-plano-testes.md](05-plano-testes.md)
- [06-plano-correcao.md](06-plano-correcao.md)
- [07-dependencias-decisoes.md](07-dependencias-decisoes.md)
- [08-go.md](08-go.md)
- [09-testes-python-pulados.md](09-testes-python-pulados.md)

O nome adicional solicitado no corpo da tarefa,
`testes-python-pulados.md`, é um índice para o documento canônico `09`.

## Próxima etapa proposta

Abrir o lote 1 com testes falhando primeiro e revisão de segurança do manifest.
Em paralelo, tomar as quatro decisões prioritárias: política de destinos de
câmera, regra RESTRICTED/evidências, ações admin em câmera privada e revogação
Central. Somente depois iniciar implementação dos lotes 2–5. Esta etapa termina
no plano; nenhuma correção foi iniciada.
