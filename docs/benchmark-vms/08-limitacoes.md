# 08 — Limitações da Análise

Este documento lista, de forma explícita, tudo que não pôde ser verificado
de forma responsável nesta auditoria, seguindo a condição de encerramento
do protocolo. Nenhuma nota atribuída nos demais documentos deve ser lida
como mais precisa do que o que está registrado aqui.

## 1. Sistemas fora do escopo verificável

**6 dos 13 concorrentes solicitados não estão presentes** em
`/home/flashnet/Drac/concorrentes/`: Motion, Motioneye, LightNVR,
Valkka-core, VibeNVR e Agent. A tarefa proíbe explicitamente download e
acesso à internet, então não havia forma de obtê-los dentro das regras
desta auditoria. Eles não receberam nota em nenhuma dimensão, não foram
incluídos no ranking conclusivo, e o valor numérico neutro (50,0) atribuído
pela fórmula de ajuste de cobertura não deve ser lido como avaliação de
qualidade — é um artefato deliberado da fórmula (ver
[04-ranking.md](04-ranking.md) §4).

## 2. Natureza estática da análise

Nenhum dos 8 sistemas presentes foi compilado, executado, ou testado em
runtime, por restrição explícita da tarefa. Isso significa que, para todos
os 8 sistemas (DRAC incluído), os seguintes aspectos **não foram e não
podem ser verificados** por este método:

- Latência real de streaming (RTSP/HLS/WebRTC) em qualquer sistema.
- Throughput real de detecção de IA sob carga (câmeras simultâneas).
- Número real de câmeras suportadas por host em qualquer sistema.
- Precisão real de detecção de movimento/objetos/faces (nenhum benchmark
  com dataset foi ou poderia ser executado).
- Comportamento de reconexão sob falha de rede real (só o código de
  tratamento foi avaliado, não o comportamento observado).
- Se a suíte de testes automatizados de qualquer um dos 8 sistemas de fato
  passa no estado atual do código (os testes foram lidos, não executados).
- Qualidade real de UI/UX de qualquer aplicação web ou mobile — apenas
  presença/ausência de código e mecanismos foi avaliada.
- Comportamento de app mobile em dispositivo físico (background/foreground
  real, qualidade de stream real, comportamento de bateria) — aplicável
  apenas ao DRAC, único com app mobile no repositório.
- Compatibilidade real com câmeras específicas das marcas citadas no
  público-alvo do DRAC (Intelbras, Positivo, Tapo). **Nenhum dos 8
  sistemas** — incluindo o DRAC — teve essa compatibilidade confirmada por
  execução; o CI do DRAC testa e2e apenas contra uma fonte RTSP sintética,
  não contra hardware real dessas marcas.

## 3. Falhas de execução dos agentes de análise (transparência de processo)

Dois dos processos de análise falharam por erro de conexão de API a meio da
execução e foram relançados do zero até completar com sucesso: o dossiê do
DRAC (1ª tentativa interrompida antes de produzir qualquer conteúdo
utilizável) e o dossiê do Moonfire NVR (1ª tentativa interrompida). Os
dossiês finais usados em todos os documentos são das execuções bem-sucedidas
(2ª tentativa em ambos os casos). Isso não introduz viés direcional
conhecido, mas é registrado por transparência do processo.

## 4. Cobertura por amostragem em arquivos muito grandes

Vários arquivos centrais foram lidos por amostragem dirigida (grep +
leitura de trechos relevantes) em vez de integralmente, dado seu tamanho:

- DRAC: `apps/api/src/camera-stream/mediamtx-proxy.service.ts` (1407
  linhas) e `apps/api/src/ai/ai-manager.service.ts` (1006 linhas) não foram
  lidos linha a linha.
- ZoneMinder: `web/` (~354 mil linhas de PHP) e a totalidade do C++ não
  foram lidos por completo — cobertura por amostragem dirigida a
  arquivos-chave.
- Frigate: `web/src/` (~120 mil linhas de frontend) não foi varrido por
  completo — foco em RBAC, streaming, branding.
- Scrypted: `server/src/` (80 arquivos) foi lido com mais profundidade que
  os ~50 plugins, que foram amostrados por relevância (streaming, ONVIF,
  detecção, HomeKit, cloud).

Onde a confiança de uma nota foi rebaixada para "média" em vez de "alta" nos
documentos anteriores, essa é frequentemente a razão.

## 5. Ambiguidade de classificação em um caso (Scrypted, dimensão Mobile)

O dossiê original do Scrypted classificou a dimensão Mobile como "N/V
(tratado como ausente comprovado)", uma formulação internamente
inconsistente (N/V e "comprovado" são conceitos opostos no protocolo). Na
calibração (Passo B), isso foi resolvido como nota 0 — consistente com o
tratamento dado a todos os outros 6 sistemas sem app mobile próprio no
repositório (Frigate, ZoneMinder, Shinobi, Bluecherry, Moonfire, Viseron
também receberam 0, não N/V, pela mesma razão: ausência comprovada por
busca ativa, não impossibilidade de verificação). Essa decisão de
calibração está documentada em [03-matriz-evidencias.md](03-matriz-evidencias.md).

## 6. Verificação de licenças

Licenças foram verificadas diretamente nos arquivos `LICENSE*`/`COPYING*`
de cada repositório **apenas para os projetos citados nas recomendações**
([07-recomendacoes.md](07-recomendacoes.md)): Frigate (MIT), Viseron (MIT),
Moonfire NVR (GPLv3), Shinobi (EULA proprietário), ZoneMinder (GPLv2),
Bluecherry (GPLv2), Scrypted (mista, varia por plugin/dependência,
conforme o próprio `LICENSE.md` do projeto declara). Não foi feita uma
auditoria de licença de **todas** as dependências transitivas de nenhum
projeto (ex.: bibliotecas de terceiros usadas pelos plugins do Scrypted ou
pelos detectores do Frigate) — a verificação cobriu apenas a licença
declarada do projeto principal citado.

## 7. Achados de segurança não confirmados por prova de conceito

Dois achados potenciais de falha de autorização foram documentados nos
dossiês mas com graus de confirmação diferentes:

- **Bluecherry** (`www/ajax/media/{mediaRequest,mediaStreamMp4}.php`,
  `playback.php`): a ausência de checagem de permissão por câmera nesses
  endpoints foi **confirmada por leitura direta do código** (comparação
  explícita com os endpoints de live, que checam permissão, e os de
  gravação, que não checam) — tratado como achado confirmado, não
  hipotético, nos documentos anteriores.
- **Shinobi** (`libs/webServerPaths.js:165-183`): uma possível fragilidade
  de autorização (uso de `ke` da URL em vez de exclusivamente da sessão)
  foi identificada mas **não confirmada por prova de conceito** — exigiria
  um ambiente vivo e um `uid`/`ke` de outro tenant para testar. Não foi
  usada para rebaixar a nota de RBAC do Shinobi além do que a evidência
  positiva (isolamento por `ke`, RBAC nas queries) já sustentava; é
  registrada como um risco a investigar, não como fato estabelecido.

## 8. Confirmação de rigor equivalente aplicado ao DRAC

O dossiê do DRAC foi produzido pelo mesmo protocolo aplicado aos 7
concorrentes (mesma rubrica de notas, mesma exigência de evidência
arquivo:linhas, mesma proibição de aceitar README/documentação como prova),
**com uma etapa adicional obrigatória** que nenhum concorrente recebeu: a
revisão adversarial (Passo C), que exigiu tentar refutar ativamente cada
ponto forte identificado. Essa etapa produziu 9 achados adversariais
específicos (listados em [02-dossies.md](02-dossies.md) §8), dois dos quais
resultaram em rebaixamento de nota na calibração horizontal (Gravação 5→4,
Maturidade 5→4 — ver [03-matriz-evidencias.md](03-matriz-evidencias.md)).
Nenhuma nota do DRAC foi aceita apenas por comentário de código ou
documentação interna — inclusive um caso (dedup de conexão) em que um
comentário do próprio código do DRAC foi identificado como inconsistente
com a configuração real de produção, e essa inconsistência foi registrada
como achado, não ignorada.

## 9. O que permanece genuinamente não verificável (N/V), não obstante o exposto

Apesar de nenhuma dimensão das 10 ter sido classificada como N/V para
nenhum dos 8 sistemas presentes (todas tiveram evidência suficiente para
uma nota numérica defensável), os seguintes pontos específicos, citados ao
longo dos dossiês, permanecem genuinamente indeterminados por análise
estática e não devem ser tratados como resolvidos:

- Se o `OnvifEventsService` do DRAC implementa descoberta/PTZ ONVIF
  completos ou apenas parcialmente (dossiê do DRAC, §4).
- Se as zonas de detecção do DRAC, confirmadas como lidas pelo
  `stream_processor.py`, são de fato aplicadas corretamente na lógica de
  decisão final de evento, ou apenas lidas e potencialmente ignoradas a
  jusante (achado adversarial do dossiê do DRAC, §8).
- O conteúdo exato do arquivo ofuscado `libs/checker/actCheck.js` do
  Shinobi além do que ficou visível no código não-ofuscado que o invoca.
- Se o Bluecherry tem uma vulnerabilidade de SQL injection explorável
  (padrão de código de risco identificado via concatenação de string em
  `www/lib/lib.php:975`, não confirmado por prova de conceito).
- O escopo exato do plugin fechado `@scrypted/nvr` do Scrypted, que está
  inteiramente fora dos repositórios inspecionados.

## 10. git status ao final da análise

Verificado antes da entrega — apenas `docs/benchmark-vms/` foi criado ou
alterado nesta sessão; nenhum outro diretório do repositório foi
modificado; nenhum commit foi criado.
