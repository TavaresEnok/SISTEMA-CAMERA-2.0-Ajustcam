# 03 — Matriz de Evidências (pós-calibração, Passo B)

Esta matriz consolida as notas **finais** (após calibração horizontal) usadas
no ranking. A calibração comparou, dimensão por dimensão, a evidência de
todos os 8 sistemas antes de fechar qualquer nota, conforme Passo B do
protocolo. Evidência condensada abaixo; evidência completa (arquivo:linhas,
mecanismo, testes) está nos dossiês individuais em
[02-dossies.md](02-dossies.md).

Todas as notas nesta matriz têm **cobertura "completa"** no sentido do
formulário de cálculo (nenhuma dimensão ficou N/V para nenhum dos 8 sistemas
presentes — todas as ausências foram comprovadas por busca ativa, não por
"não foi possível verificar"). Confiança varia por linha e está indicada.
Os 6 sistemas ausentes do repositório local (Motion, Motioneye, LightNVR,
Valkka-core, VibeNVR, Agent) não têm nenhuma dimensão pontuada — ver
[08-limitacoes.md](08-limitacoes.md).

## Ajustes de calibração aplicados

| Sistema | Dimensão | Nota preliminar | Nota calibrada | Razão da calibração |
|---|---|---|---|---|
| DRAC | 2. Gravação | 5 | **4** | Frigate, ZoneMinder, Moonfire e Viseron têm engenharia de gravação comparável (segmentação, retenção, reconciliação disco↔banco, recuperação pós-crash, testes dedicados) e todos ficaram em 4. Nenhuma evidência do DRAC (quarentena de `motionScore`, delete transacional) é qualitativamente superior ao conjunto — ex.: a doutrina de fsync-abort do Moonfire e a validação ffprobe+backup pré-migração do Frigate são pelo menos igualmente rigorosas. Manter DRAC em 5 isolado seria inconsistência horizontal, não mérito técnico diferenciado. |
| DRAC | 9. Maturidade de engenharia | 5 | **4** | A própria revisão adversarial do dossiê do DRAC encontrou que o teste mais crítico de segurança (`access-matrix.test.ts`, RBAC) roda contra Prisma inteiramente mockado, não contra Postgres real — uma rigor de teste estruturalmente mais fraco que o e2e Playwright do Frigate (roda contra instância real em CI) para o subsistema mais sensível do produto. Mantendo Frigate em 5 (justificado por e2e real + mypy + build multi-arch) e baixando DRAC para 4 por essa lacuna concreta e citável. |

Nenhum outro ajuste foi necessário — as notas preliminares dos demais 7
sistemas já estavam horizontalmente consistentes entre si (verificado
comparando texto de evidência de cada dimensão lado a lado antes de aceitar
os valores).

## Matriz de notas calibradas

Pesos: Ingestão=3, Gravação=3, IA=3, Playback=2, Multi-tenancy/RBAC=3,
Mobile=2, Operação=2, Escalabilidade=2, Maturidade=2, White-label=2 (soma=24).

| Sistema | 1.Ingestão(3) | 2.Gravação(3) | 3.IA(3) | 4.Playback(2) | 5.RBAC/Priv(3) | 6.Mobile(2) | 7.Operação(2) | 8.Escala(2) | 9.Maturidade(2) | 10.White-label(2) |
|---|---|---|---|---|---|---|---|---|---|---|
| **DRAC** | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 4 | 4 |
| **Frigate** | 4 | 4 | 4 | 4 | 2 | 0 | 4 | 4 | 5 | 0 |
| **ZoneMinder** | 4 | 4 | 2 | 4 | 2 | 0 | 4 | 4 | 3 | 1 |
| **Viseron** | 4 | 4 | 4 | 4 | 2 | 0 | 3 | 3 | 4 | 0 |
| **Shinobi** | 3 | 3 | 2 | 3 | 3 | 0 | 3 | 3 | 2 | 2 |
| **Scrypted** | 3 | 2 | 3 | 2 | 2 | 0 | 2 | 3 | 2 | 1 |
| **Moonfire NVR** | 3 | 4 | 0 | 2 | 1 | 0 | 3 | 4 | 4 | 0 |
| **Bluecherry** | 3 | 3 | 2 | 2 | 1 | 0 | 3 | 3 | 2 | 0 |

**Confiança por sistema** (predominante nas 10 dimensões, ver dossiês para
o detalhe por linha): DRAC = alta/média (algumas dimensões média por
dependência de leitura por amostragem em arquivos muito grandes);
Frigate = alta; ZoneMinder = alta; Viseron = alta; Shinobi = alta;
Scrypted = alta; Moonfire = alta; Bluecherry = alta.

## Leitura da matriz por dimensão (achados de calibração)

**1. Ingestão/streaming (peso 3).** Cluster de 4 (DRAC, Frigate, ZoneMinder,
Viseron) com engenharia de reconexão/watchdog/redação de credenciais
comparável; cluster de 3 (Shinobi, Scrypted, Bluecherry, Moonfire) com
streaming funcional mas com uma lacuna notável cada (Shinobi/Bluecherry sem
backoff exponencial, Scrypted sem gravação própria consolidada, Moonfire sem
HLS/WebRTC). Nenhum sistema (incluindo DRAC) tem WebRTC nativo implementado
por si — todos que oferecem WebRTC o fazem via proxy (MediaMTX/go2rtc/Janus)
ou bibliotecas de terceiros (werift no Scrypted).

**2. Gravação (peso 3).** Cluster de 4 muito equilibrado (DRAC, Frigate,
ZoneMinder, Moonfire, Viseron — cinco sistemas, não quatro) — todos com
segmentação, retenção e reconciliação disco↔banco maduras e testadas. É a
dimensão mais competitiva do conjunto. Moonfire se destaca por rigor formal
de integridade (fsync-abort), mas com escopo mais estreito (só gravação
contínua, sem eventos). Scrypted é a única exceção clara para baixo, pela
razão de escopo já registrada (gravação real vive em plugin fechado).

**3. Detecção e IA (peso 3).** Frigate e Viseron lideram com folga por
amplitude de motores (13 backends de hardware no Frigate; 6+ engines de
detecção incluindo face/placa no Viseron) — ambos com zonas/máscaras e
aceleração de hardware genuinamente detectada. DRAC empata numericamente com
eles (4) mas com amplitude sensivelmente menor — a nota reflete
robustez/integração/teste, não a mesma amplitude; isso está registrado
explicitamente para não sugerir paridade de escopo. Nuance verificada
diretamente no código: o DRAC **tem** um sistema de perfis de runtime
(`services/ai-service-python/runtime_profiles.py:65-210`, com OpenVINO CPU
como default para detecção geral, ONNXRuntime CPU/CUDA para faces e
fallback automático CUDA→CPU) e exporta modelos em **OpenVINO INT8 em 3
resoluções** (`download_models.py:39-83`) — uma alavanca real de eficiência
de CPU que a primeira leitura do dossiê não creditou. A diferença para
Frigate/Viseron é de amplitude de aceleradores (≈3 caminhos contra 13), não
de ausência de arquitetura de seleção. Moonfire é o único com IA comprovadamente zero (por design, não por
falha).

**4. Playback e revisão (peso 2).** Cluster de 4 (DRAC, Frigate, ZoneMinder,
Viseron) com timeline, busca e exportação maduras — Viseron se destaca
adicionalmente por playback sincronizado multi-câmera com correção de drift,
um mecanismo não encontrado em nenhum outro sistema do conjunto, incluindo o
DRAC.

**5. Multi-tenancy, RBAC e privacidade (peso 3).** **Esta é a dimensão de
maior diferenciação do DRAC** (nota 4, o único acima de 3 em todo o
conjunto). Todos os concorrentes têm no máximo RBAC robusto *intra-instalação*
(Frigate, ZoneMinder, Viseron, Shinobi — este último com isolamento por conta
via coluna `ke`, o mecanismo mais próximo de multi-tenancy real encontrado
fora do DRAC). Bluecherry e Moonfire ficam abaixo por RBAC granular ausente
ou (no caso do Bluecherry) por uma falha de autorização confirmada (IDOR em
download de gravação). Mesmo assim, o DRAC não tem um modelo formal
`Organization`/`Tenant` — seu isolamento entre revendedores é por instalação
Docker separada, não por linha de banco compartilhado — por isso não recebeu
5 (ver nota de calibração acima e [06-vantagens-drac.md](06-vantagens-drac.md)
para a distinção entre essa arquitetura e "multi-tenant SaaS clássico").

**6. Mobile (peso 2).** **Segunda dimensão de maior diferenciação do DRAC.**
Nenhum dos 7 concorrentes tem app mobile nativo no repositório inspecionado —
todos ficam em 0. Isso não significa que produtos comerciais associados a
esses projetos não tenham apps (Shinobi e Bluecherry mencionam apps pagos de
terceiros não incluídos nos repositórios), mas dentro do escopo desta
auditoria (só o que está no código), o DRAC é o único com app real,
testado, com armazenamento seguro de sessão e biometria.

**7. Operação e observabilidade (peso 2).** Cluster de 3-4 relativamente
parelho; DRAC, Frigate e ZoneMinder lideram com watchdogs em camadas e
scripts de backup/restore dedicados.

**8. Escalabilidade e eficiência (peso 2).** Frigate, ZoneMinder e Moonfire
lideram (4) por mecanismos de isolamento/zero-copy comprovados e maduros.
DRAC fica em 3 por dois motivos verificados: (a) o worker de gravação em Go,
inicialmente lido como mecanismo de escala horizontal, é na verdade uma
**separação de processo**, não distribuição — usa Redis pub/sub em canal
único (`camera-worker-go/main.go:277-297` + `recording-process-manager.service.ts:921`),
sem identidade de worker nem sharding, de forma que dois workers
duplicariam a gravação em vez de dividi-la (detalhamento em
[06-vantagens-drac.md](06-vantagens-drac.md) §C1); (b) ausência total de
benchmark/teste de carga no repositório. A nota 3 é, portanto, adequada e
não conservadora.

**9. Maturidade de engenharia (peso 2).** Frigate (5) é o único sistema do
conjunto com e2e real (Playwright contra instância viva) somado a tipagem
estática obrigatória (mypy) e build multi-arquitetura testado em CI. DRAC,
Moonfire e Viseron formam um cluster forte de 4 (CI real, testes nomeados
por cenário, migrations versionadas) mas cada um com uma lacuna concreta
registrada (DRAC: testes de RBAC mockados; Moonfire: pre-1.0 declarado;
Viseron: 15 de 24 componentes sem nenhum teste).

**10. White-label e comercialização (peso 2).** **Terceira dimensão de
diferenciação do DRAC** — nenhum concorrente passa de 2. Shinobi (2) tem
branding real por domínio mas depende comercialmente do fornecedor original
para revenda/mobile. O DRAC é o único com pipeline de build de app mobile
assinado por cliente e painel central de gestão de frota — por isso nota 4,
não 5 (gaps de segurança operacional identificados na revisão adversarial:
autenticação da Central por header simples sem rotação, sem verificação
adicional de integridade de build antes de publicar).
