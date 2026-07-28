# Matriz de risco revisada

Data: 2026-07-28  
Commit: `fdc7588488108e5db60787f828cd7f65e76ec7f1`

Escalas qualitativas: capacidade de exploração, impacto e probabilidade usam
alta, média ou baixa; perda, indisponibilidade e exposição indicam o máximo
efeito plausível demonstrado. A ordem considera primeiro redução de risco
sistêmico e exposição remota, depois integridade/disponibilidade e hardening.
Ela não autoriza implementar antes das decisões listadas.

| Ordem | ID | Severidade revisada | Confiança revisada | Capacidade de exploração | Impacto | Probabilidade | Perda de dados | Indisponibilidade | Exposição de dados | Complexidade da correção | Risco de regressão | Testes necessários | Dependências |
|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | DRAC-AUD-001 | CRÍTICA | CONFIRMADO | Alta se Central/repositório/canal for comprometido; token admin para provisionar | Crítico, root nas instalações | Média | Sim | Sim | Sim, segredos/host | Média no mínimo seguro; alta com assinatura | Alto | digest incorreto, conteúdo trocado, downgrade, offline, rollback | política de release, raiz de confiança e versionamento |
| 2 | DRAC-AUD-003 | ALTA | CONFIRMADO | Alta para operador autenticado que possa cadastrar/testar câmera | Alto, acesso da rede de controle | Média | Não direto | Sim | Sim | Alta | Alto | matriz IP/IPv6/DNS/redirect/TOCTOU e regressão de câmeras | política de destinos, DNS e proxy/egress |
| 3 | DRAC-AUD-004 | ALTA | CONFIRMADO | Média; usuário autenticado em instalação RESTRICTED | Alto, obtenção de histórico proibido | Alta durante restrição | Possível por exportação | Não | Sim, vídeo histórico | Média | Médio | matriz estado×papel×recurso, emissão e consumo de token | regra exata de licença/restrição |
| 4 | DRAC-AUD-005 | ALTA | CONFIRMADO | Alta após roubo de cookie/sessão Central | Alto, administração persistente | Média | Sim | Sim | Sim | Média | Alto | delete, senha, papel, TTL, multi-sessão, concorrência | política de revogação Central/admin bearer |
| 5 | DRAC-AUD-002 | ALTA | CONFIRMADO | Baixa remotamente; falha operacional/disco | Alto, banco/arquivos divergentes | Média | Sim | Parcial | Possível | Alta | Alto | matriz completa de crash, FS/DB e reconciliação | modelo de estados e política de reparo |
| 6 | DRAC-AUD-006 | ALTA | ALTO | Operacional; update com falha | Alto, rollback destrutivo/incompleto | Média por atualização | Sim | Sim | Possível por backup/log | Alta | Muito alto | laboratório descartável, falha em cada etapa, readiness | janela de manutenção, compatibilidade e backup |
| 7 | DRAC-AUD-007 | ALTA | ALTO | Operacional; restore inválido/parcial | Alto, destruição do estado atual | Média por restauração | Sim | Sim | Possível | Alta | Muito alto | preflight, checksum, espaço, restore paralelo e rollback | RPO/RTO, formato/versionamento do backup |
| 8 | DRAC-AUD-008 | ALTA | CONFIRMADO | Alta para quem obtiver quick URL | Alto, replay duradouro da capability | Média | Possível | Possível | Sim, configuração/licença | Média | Médio | TTL, one-time, rotação, concorrência e backup | validade/reuso/offline do instalador |
| 9 | DRAC-AUD-010 | ALTA | CONFIRMADO | Média; exige admin ou conta admin comprometida | Alto, ação física/coleta privada | Média | Possível | Parcial | Sim | Média | Alto | matriz privada por ação e endpoints PTZ/relay/record | fronteira negócio entre administrar e acessar |
| 10 | DRAC-AUD-018 | MÉDIA | CONFIRMADO | Baixa direta; agente/rede pode provocar | Alto, Central inteira bloqueada | Média quando builder é usado | Não | Sim | Não | Média | Médio | blackhole, timeout, heartbeat concorrente, fila separada | contrato síncrono/assíncrono do builder |
| 11 | DRAC-AUD-013 | MÉDIA | CONFIRMADO | Baixa direta; depende de Redis/rede | Alto, API não inicia | Média | Não direto | Sim | Não | Média | Médio | refused, blackhole, recovery e repeat jobs | decisão fail-fast versus modo degradado |
| 12 | DRAC-AUD-019 | MÉDIA | CONFIRMADO | Baixa isolada; requer escrita/symlink no volume | Alto no alcance do UID | Baixa | Sim | Possível | Sim | Alta | Médio/alto | symlink arquivo/diretório, TOCTOU, download/delete | filesystems suportados e ownership do storage |
| 13 | DRAC-AUD-009 | ALTA | ALTO | Operacional/configuração | Alto, Central indisponível no deploy | Alta em instalação somente pelo Compose versionado | Não | Sim | Não | Baixa/média | Médio | smoke de DNS/rede/health em prod e dev | topologia oficial da Central |
| 14 | DRAC-AUD-011 | MÉDIA | ALTO | Baixa; corrida autenticada/retry | Médio, revogação residual | Baixa/média | Lógica | Não | Sim, câmera | Alta pela migration/dedupe | Alto | concorrência, dedupe, níveis e revoke | regra para duplicatas existentes |
| 15 | DRAC-AUD-012 | MÉDIA | ALTO | Operacional | Médio, propriedade órfã | Média quando owner é excluído | Lógica | Parcial | Possível | Média/alta | Alto | delete/transfer/set-null/restrict e migration | política de propriedade |
| 16 | DRAC-AUD-015 | MÉDIA | CONFIRMADO | Indireta; escrita no checkout host | Médio/alto, drift de produção | Média | Possível | Parcial | Possível | Baixa/média | Médio | assert de mounts e smoke da imagem | fluxo dev, modelos e storage |
| 17 | DRAC-AUD-014 | MÉDIA | CONFIRMADO | Depende de XSS/extensão | Alto por sessão roubada | Baixa sem XSS conhecido | Possível | Possível | Sim | Alta | Alto | cookie/refresh, CSRF, CSP, logout e migração | contrato auth web e TLS/proxy |
| 18 | DRAC-AUD-016 | MÉDIA | ALTO | Operacional/topologia multi-writer | Alto, last-writer-wins | Baixa no singleton | Sim | Possível | Possível | Alta | Alto | concorrência cross-process JSON/PG | suporte a HA e datastore futuro |
| 19 | DRAC-AUD-017 | MÉDIA | ALTO | Alta apenas em exposição direta | Médio, brute force/auditoria | Baixa na topologia atual | Possível | Possível | Possível | Baixa/média | Baixo/médio | proxy trust, IPv6, restart, múltiplas instâncias | topologia e proxies confiáveis |
| 20 | DRAC-AUD-020 | MÉDIA | CONFIRMADO | Operacional, profile opt-in | Médio, worker travado/unhealthy | Baixa no runtime padrão | Sim, gravação legado | Parcial | Não | Média | Alto para usuários legacy | Go test/race/vet, blackhole, SIGTERM, FFmpeg | decisão de suporte e Go 1.22 |
| 21 | DRAC-AUD-022 | MÉDIA | CONFIRMADO | Requer comprometimento prévio | Amplifica outro ataque | Dependente de outra falha | Sim | Sim | Sim | Alta pelas permissões | Alto | smoke non-root de todos os mounts/FFmpeg | mapa de UID/GID e volumes |

## Agrupamento por decisão final

| Decisão final | IDs |
|---|---|
| CONFIRMADO E REPRODUZIDO | 001, 002, 004, 005, 008, 010, 013, 015, 018, 019, 022 |
| CONFIRMADO POR ANÁLISE | 003, 006, 007, 014 |
| PROVÁVEL | 011 |
| DEPENDE DE CONFIGURAÇÃO | 009, 016, 017, 020 |
| DEPENDE DE REGRA DE NEGÓCIO | 012 |
| NÃO REPRODUZIDO | nenhum |
| FALSO POSITIVO | nenhum |
| DUPLICADO DE OUTRO ACHADO | nenhum |

## Contagens revisadas

- Severidade: 1 CRÍTICA, 9 ALTAS e 11 MÉDIAS.
- Confiança: 15 CONFIRMADOS e 6 ALTOS.
- Decisão: 11 reproduzidos, 4 confirmados por análise, 1 provável, 4
  dependentes de configuração e 1 dependente de regra de negócio.

As severidades não foram rebaixadas apenas por uma camada externa proteger o
host atual: quando o artefato versionado permite outra topologia documentada,
a condição foi mantida e explicitamente marcada como dependente de
configuração.
