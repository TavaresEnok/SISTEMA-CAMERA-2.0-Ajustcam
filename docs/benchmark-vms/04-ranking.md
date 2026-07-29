# 04 — Ranking

## Fórmula (idêntica à declarada em [00-metodologia.md](00-metodologia.md), reproduzida aqui)

```
pontuação ponderada observada = soma(nota × peso) / soma(5 × pesos_verificados) × 100
cobertura = soma(pesos_verificados) / 24 × 100
pontuação ajustada = pontuação_observada × (cobertura/100) + 50 × (1 − cobertura/100)
```

Pesos: Ingestão=3, Gravação=3, IA=3, Playback=2, Multi-tenancy/RBAC=3,
Mobile=2, Operação=2, Escalabilidade=2, Maturidade=2, White-label=2 — soma=24.

A fórmula ajustada empurra sistemas com cobertura baixa em direção a 50
(ponto neutro), para que uma inspeção incompleta nunca produza nem uma nota
artificialmente alta (por ausência de contra-evidência) nem uma nota
artificialmente baixa (por N/V contado como zero). **Esta fórmula foi
definida antes de qualquer nota ser calculada e é a mesma para todos os 14
sistemas do escopo original — não foi ajustada para favorecer o DRAC.**

Nos 8 sistemas presentes no repositório local, todas as 10 dimensões
receberam nota numérica (nenhuma ficou N/V) — logo **cobertura = 100% para
todos os 8**, e a pontuação ajustada é numericamente idêntica à observada.
A distinção ajustada/observada só passa a importar para os 6 sistemas
ausentes, cuja cobertura é 0% (ver §4).

## 1. Ranking por pontuação observada (= ajustada, cobertura 100%)

| Posição | Sistema | Pontuação | Cobertura | Confiança geral |
|---|---|---|---|---|
| 1 | **DRAC** | **78,3** | 100% | Alta/média |
| 2 | Frigate | 63,3 | 100% | Alta |
| 3 | Viseron | 58,3 | 100% | Alta |
| 4 | ZoneMinder | 56,7 | 100% | Alta |
| 5 | Shinobi | 49,2 | 100% | Alta |
| 6 (empate) | Scrypted | 41,7 | 100% | Alta |
| 6 (empate) | Moonfire NVR | 41,7 | 100% | Alta |
| 8 | Bluecherry | 39,2 | 100% | Alta |

## 2. Ranking ajustado por cobertura

Idêntico ao ranking acima para os 8 sistemas presentes, pois todos têm
cobertura de 100%. A tabela não é repetida — a distinção só é observável
incluindo os sistemas ausentes (§4), cuja pontuação ajustada cai para 50,0
(ponto neutro), não para 0.

## 3. Por que o DRAC lidera: amplitude, não pico isolado

O placar do DRAC não vem de um único diferencial espetacular — em 7 das 10
dimensões ele empata numericamente com o líder do cluster (nota 4, ao lado
de Frigate/ZoneMinder/Viseron). O que o separa é que **nenhum concorrente
consegue nota acima de 3 nas três dimensões de peso comercial mais direto
para o modelo de revenda white-label** (Multi-tenancy/RBAC, Mobile,
White-label — juntas, 7 dos 24 pontos de peso total). Todo concorrente
tecnicamente maduro (Frigate, ZoneMinder, Viseron) é, por desenho, um
produto **single-tenant self-hosted**: RBAC forte dentro de uma instalação,
zero app mobile próprio, zero mecanismo de branding. Isso não é uma lacuna
de implementação nesses projetos — é uma diferença de proposta de produto,
registrada explicitamente em cada dossiê (Passo A/D) e não usada para
penalizar ocultamente esses sistemas nas dimensões onde o escopo deles é
equivalente ou superior ao do DRAC (streaming, gravação, IA, engenharia).

Dito de outro forma: se o critério fosse "melhor NVR/VMS tecnicamente",
Frigate e Viseron disputariam a liderança com o DRAC dimensão a dimensão.
Como o critério declarado é **adequação ao modelo comercial** (provedor
revendendo a múltiplos clientes finais sob marca própria), as três
dimensões onde o DRAC é estruturalmente único pesam a diferença.

## 4. Sistemas com inspeção insuficiente para ranking confiável

Os 6 sistemas abaixo constavam do escopo solicitado mas **não estão
presentes** em `/home/flashnet/Drac/concorrentes/`, e a tarefa proíbe
download/acesso à internet para obtê-los. Cobertura = 0% para todos —
nenhuma dimensão foi verificada, nenhuma nota foi atribuída, e nenhuma nota
foi tratada como zero.

| Sistema | Pontuação ajustada (fórmula) | Motivo |
|---|---|---|
| Motion | 50,0 (neutro, não avaliável) | Ausente do repositório local |
| Motioneye | 50,0 (neutro, não avaliável) | Ausente do repositório local |
| LightNVR | 50,0 (neutro, não avaliável) | Ausente do repositório local |
| Valkka-core | 50,0 (neutro, não avaliável) | Ausente do repositório local |
| VibeNVR | 50,0 (neutro, não avaliável) | Ausente do repositório local |
| Agent | 50,0 (neutro, não avaliável) | Ausente do repositório local |

Estes 6 sistemas **não devem ser lidos como "medianos"** apesar do valor
numérico neutro da fórmula — o número 50,0 é um artefato deliberado da
fórmula para não distorcer médias, não uma avaliação de qualidade. Eles
estão fora de qualquer ranking conclusivo. Ver [08-limitacoes.md](08-limitacoes.md).

---

## 5. Veredito por sistema

### DRAC — 1º lugar (78,3)
- **Principal força**: única combinação, entre os 8 sistemas inspecionados, de RBAC backend-enforced com privacidade real (câmera privada com inversão de privilégio de admin), app mobile nativo funcional e pipeline de white-label operacional (build de APK assinado por cliente + painel central de frota).
- **Principal fraqueza**: não é multi-tenant no sentido de plataforma SaaS compartilhada (sem `Organization`/`Tenant`) — isolamento entre revendedores é por instalação Docker separada; testes do subsistema de autorização (o mais crítico) rodam contra Prisma mockado, não Postgres real.
- **Adequação ao modelo comercial**: alta — é o único sistema do conjunto desenhado desde a origem para o cenário provedor→múltiplos clientes finais com marca própria.
- **Confiança na avaliação**: alta/média (algumas dimensões com leitura por amostragem em arquivos muito grandes, ex. `mediamtx-proxy.service.ts` de 1407 linhas).
- **Evidências-chave**: `access-control.service.ts`, `apps/mobile/scripts/build-client.sh`, `apps/central/src/server.js`, `apps/api/tests/access-matrix.test.ts`.

### Frigate — 2º lugar (63,3)
- **Principal força**: engenharia de maior maturidade do conjunto — único com e2e real (Playwright) em CI, 13 backends de aceleração de hardware para IA, RBAC backend-enforced que cobre até mídia estática servida por nginx.
- **Principal fraqueza**: zero multi-tenancy, zero app mobile nativo (só PWA/web-push), zero white-label — estruturalmente um NVR single-install.
- **Adequação ao modelo comercial**: baixa como está; alta como base tecnológica se fosse usado como motor de streaming/IA embutido dentro de outra camada de produto (ver [07-recomendacoes.md](07-recomendacoes.md)).
- **Confiança na avaliação**: alta.
- **Evidências-chave**: `frigate/api/auth.py`, `frigate/api/media_auth.py`, `.github/workflows/pull_request.yml`.

### Viseron — 3º lugar (58,3)
- **Principal força**: playback sincronizado multi-câmera com correção de drift <0,5s — mecanismo não encontrado em nenhum outro sistema do conjunto, incluindo o DRAC; amplitude de motores de IA (6+, incluindo face e placa).
- **Principal fraqueza**: mesma limitação estrutural do Frigate (single-tenant, zero mobile, zero white-label); cobertura de teste desigual (watchdog de 724 linhas sem nenhum teste).
- **Adequação ao modelo comercial**: baixa como está.
- **Confiança na avaliação**: alta.
- **Evidências-chave**: `frontend/src/components/events/SyncManager.tsx`, `viseron/components/webserver/api/handlers.py`.

### ZoneMinder — 4º lugar (56,7)
- **Principal força**: duas camadas independentes de watchdog/auto-cura (supervisor de processo + heartbeat), maturidade operacional de 20+ anos em produção real.
- **Principal fraqueza**: zero detecção de objetos/faces no core (só motion detection clássico — IA real depende de projeto externo não incluído); zero testes automatizados de PHP/API (só C++ testado).
- **Adequação ao modelo comercial**: baixa — arquitetura C++/PHP monolítica sem qualquer conceito de tenant.
- **Confiança na avaliação**: alta.
- **Evidências-chave**: `scripts/zmdc.pl.in`, `scripts/zmwatch.pl.in`, `src/zm_zone.cpp`.

### Shinobi — 5º lugar (49,2)
- **Principal força**: o mecanismo mais próximo de multi-tenancy real encontrado fora do DRAC — isolamento por conta (`ke`) com cota de disco e exclusão em cascata (incluindo disco); branding por domínio real e funcional.
- **Principal fraqueza**: zero CI de testes automatizados; um arquivo de checagem de licença fortemente ofuscado; modelo de negócio acopla o revendedor ao fornecedor original (registro/pagamento à Shinobi Systems para mobile e serviço central).
- **Adequação ao modelo comercial**: média — tecnicamente o mais próximo do DRAC em intenção de isolamento multi-cliente, mas dependente comercialmente de terceiro para as peças que faltam (mobile, central hospedado).
- **Confiança na avaliação**: alta.
- **Evidências-chave**: `sql/postgresql/framework.sql` (coluna `ke`), `libs/branding.js`, `libs/webServerSuperPaths.js`.

### Scrypted — 6º lugar empatado (41,7)
- **Principal força**: profundidade de integração com hardware de IA (ONNX/CoreML/RKNN/OpenVINO/NCNN com aceleração real) e engenharia de robustez de streaming (backoff, redação de credenciais, kill escalonado de processo).
- **Principal fraqueza**: **não é um VMS/NVR completo** — gravação contínua real vive em plugin comercial fechado fora do repositório; zero testes automatizados reais em todo o código aberto.
- **Adequação ao modelo comercial**: baixa, e a nota reflete diretamente essa diferença de categoria de produto (plataforma de integração vs. VMS), não uma penalização oculta.
- **Confiança na avaliação**: alta.
- **Evidências-chave**: `plugins/prebuffer-mixin/src/main.ts`, `server/src/plugin/acl.ts`, ausência confirmada de testes reais.

### Moonfire NVR — 6º lugar empatado (41,7)
- **Principal força**: rigor de integridade de gravação sem paralelo no conjunto — pipeline zero-copy com doutrina de fsync-abort documentada e testada sob condições de corrida real.
- **Principal fraqueza**: escopo deliberadamente estreito — zero IA, zero multi-tenancy, zero mobile, por desenho de produto (não é uma falha de implementação).
- **Adequação ao modelo comercial**: baixa — não é a categoria de produto (NVR de gravação eficiente vs. VMS comercial completo); nota reflete diferença de escopo declarada, não penalização.
- **Confiança na avaliação**: alta.
- **Evidências-chave**: `server/db/dir/writer.rs`, `server/db/check.rs`.

### Bluecherry — 8º lugar (39,2)
- **Principal força**: suporte funcional a hardware proprietário (Solo6x10/TW5864) somado a caminho RTSP/IP genérico funcional, com VAAPI real para decode/encode/scale.
- **Principal fraqueza**: **achado de segurança confirmado, não hipotético** — endpoints de download/stream de gravação não checam permissão por câmera (IDOR real); CI não compila o código do próprio repositório (baixa `.deb` pré-compilado externo); zero testes automatizados.
- **Adequação ao modelo comercial**: muito baixa — o achado de IDOR por si só é incompatível com um produto que promete isolar clientes finais.
- **Confiança na avaliação**: alta.
- **Evidências-chave**: `www/ajax/media/mediaStreamMp4.php`, `www/ajax/media/mediaRequest.php`, `.github/workflows/deb-build.yml`.

### Motion, Motioneye, LightNVR, Valkka-core, VibeNVR, Agent — inspeção insuficiente
Não presentes no repositório local; não avaliados; sem nota; ver §4 acima e
[08-limitacoes.md](08-limitacoes.md).
