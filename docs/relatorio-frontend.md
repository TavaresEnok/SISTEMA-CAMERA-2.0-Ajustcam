# Relatório de Front-end — DRAC VMS

Análise somente-leitura de 25 páginas, 4 rotas sem menu, 5 páginas órfãs e 11 componentes de tela.
Nenhum arquivo de código foi alterado. Data: 07/08/2026.

**Método.** Cinco analistas percorreram lotes de páginas em paralelo; em cima disso rodei uma análise
comparativa entre todas as telas (o que só aparece olhando o conjunto). Todo achado marcado como
**CRÍTICO** neste relatório foi verificado por mim, linha a linha, no código — não é inferência.

---

## 1. Resumo executivo

O sistema tem **duas metades de qualidade muito diferente**, e isso é o achado mais importante.

As telas trabalhadas recentemente — Reprodução, Ao Vivo, o cartão de nuvem, a lista de câmeras — estão
num padrão alto: mensagens que explicam a consequência antes de aplicar, estados de erro com saída,
confirmação proporcional ao risco, decisões documentadas no próprio código. Existe ali um vocabulário
de produto maduro, com frases como *"Desligado, tudo permanece apenas no disco local. Instalar o storage
não liga o envio sozinho."*

A outra metade não recebeu a mesma atenção, e nela há **defeitos que fazem a interface afirmar coisas
falsas**. Não são problemas de estética: um relógio em UTC sobre imagem de câmera, uma tela de auditoria que
carimba "Sucesso" em toda linha, interruptores de permissão que não salvam nada, "Minha conta" listando
os grupos de outras pessoas. Num sistema usado como prova, interface que mente é a falha mais cara que
existe — pior que interface feia e pior que interface quebrada, porque não avisa que errou.

Três padrões estruturais explicam boa parte do resto:

1. **Três sistemas de botão convivem** (classes caseiras `.btn`, kit `<Button>` e `<button>` cru com
   Tailwind inline). Daí nascem as divergências de altura, raio, foco e estado desabilitado entre telas.
2. **Não há um "casco" de página compartilhado.** Cada tela decide sua própria rolagem, seu próprio
   cabeçalho e seu próprio espaçamento — e quatro delas erram a rolagem, deixando botões inalcançáveis.
3. **Acessibilidade é ilha.** Reprodução e Configurações fazem certo (rótulos, foco, contraste);
   Alarmes tem 24 botões e 1 rótulo acessível. O padrão bom existe no projeto — só não foi propagado.

**Números.** 20 rotas registradas, das quais 4 não aparecem no menu. 5 páginas (1.441 linhas) sem rota
nenhuma. 22 achados críticos, 71 importantes, ~60 desejáveis.

---

## 2. Análise por página

### 2.1 Reprodução (`/playback`) — **a referência do sistema**

**Pontos fortes.** Régua de tempo em três níveis com granularidade adaptativa; minimapa do dia que só
aparece quando acrescenta informação; seleção de gravação extraída como biblioteca pura e testada;
origem do armazenamento como canal visual independente; 25 rótulos acessíveis para 24 botões; estados
de carregamento, erro e vazio completos. É a única tela com cobertura de testes de comportamento.

**Problemas.** Nenhum crítico. Restam pontos de polimento: a página tem 3.829 linhas e mistura
`<Button>` do kit com `<button>` cru (14 ocorrências).

| Severidade | Sugestão |
|---|---|
| Desejável | Extrair a régua e o painel de multi-câmera em componentes próprios; padronizar em um sistema de botão. |

---

### 2.2 Ao Vivo (`/live`)

**Pontos fortes.** Árvore única para o modo mural (nenhum player desmonta ao alternar); `key` por id de
câmera preserva o stream ao mover de quadro; feedback por aviso em todas as operações com desfazimento
otimista; aviso honesto de degradação ("Layout salvo somente neste navegador").

**Problemas.**

| # | Achado | Severidade |
|---|---|---|
| L1 | Grade cheia + nenhum quadro selecionado: clicar numa câmera **substitui a do último quadro sem avisar** (`LiveViewPage:432`, `newIds[… : count - 1]`). O operador perde a câmera que monitorava. | **Crítico** |
| L2 | "Trocar" e "Remover" câmera só existem no *hover* — **inalcançáveis em tela sensível ao toque**, que é o hardware típico de sala de operação. | **Crítico** |
| L3 | Rótulo de status da lista com contraste ≈2,9:1 em 9px e truncado em 42px ("Manutenção" → "Manut…"). | **Crítico (a11y)** |
| L4 | Presets 3x3 e 4x4 usam **o mesmo ícone**; abaixo de 1060px o rótulo some e os botões ficam idênticos. | Importante |
| L5 | Modo mural não sai com `Esc`. | Importante |
| L6 | Lista de câmeras sem estado vazio nem de carregamento — busca sem resultado deixa o painel em branco. | Importante |
| L7 | Aviso de sobrecarga de CPU tem `hidden sm:` — some justamente na tela pequena, onde a grade grande é mais nociva. | Importante |
| L8 | Três nomes para a mesma coisa: "Slot vazio" (usuário), "quadro" (aria-label), "quadrado" (título). | Importante |
| L9 | Três controles para a mesma ação de mostrar/ocultar o painel lateral. | Desejável |

**Sugestão principal:** ao clicar numa câmera com a grade cheia, pedir o quadro de destino (ou avisar
qual foi substituída, com desfazer); revelar as ações do quadro também quando o tile estiver selecionado.

---

### 2.3 Modo Mural (`/wall`) — **a tela mais problemática do sistema**

Rota registrada, acessível pela paleta de comandos, com título próprio no cabeçalho. **Não é o mural que
funciona** — esse vive dentro do `/live`.

| # | Achado | Severidade |
|---|---|---|
| W1 | **Não renderiza vídeo nenhum.** Zero ocorrências de player, `<video>` ou `<img>` no arquivo — são retângulos pretos com nome de câmera. Quem abre pela paleta conclui que a frota inteira caiu. | **Crítico** |
| W2 | **`online`, `recording` e `motion` recebem o mesmo ponto vermelho pulsante do alarme** (`WallModePage:15`). Num mural de 16 câmeras saudáveis, 16 pontos vermelhos piscam e o alarme real fica invisível por saturação. | **Crítico** |
| W3 | **Relógio congelado e em UTC** (`:75` e `:125`): `new Date().toISOString()` avaliado no render, **zero `setInterval`**. Mostra a hora em que a página abriu, 3 horas adiantada. | **Crítico** |
| W4 | `h-screen` dentro de um casco que já consome 72px: última linha cortada, sem rolagem. E o "mural" aparece com menu lateral, cabeçalho e barra de status. | **Crítico** |
| W5 | Duas classes CSS inexistentes: `alarm-blink` e `scan-line-overlay` (os nomes reais são `.alarm-glow` e `.camera-scanline`). | Importante |
| W6 | Convenção de grade invertida em relação ao `/live`: "2x3" produz grades diferentes nas duas telas. | Importante |
| W7 | Contrastes de 3,0:1 a 4,4:1 em textos de 8-10px. | **Crítico (a11y)** |

**Sugestão:** decidir entre (a) apontar `/wall` para o mural real do `/live` e apagar esta página, ou
(b) renderizar `CameraTile` aqui. Enquanto não se decide, tirar da paleta de comandos — hoje ela oferece
ao operador uma tela que finge estar com tudo offline.

---

### 2.4 Revisão (`/review`)

**Pontos fortes.** O melhor estado vazio do sistema (ícone + frase + o que fazer a seguir); paginação
com contagem no próprio botão ("Carregar mais (48 de 312)"); atualização otimista com desfazimento; a
grade mais responsiva do projeto (4 breakpoints).

| # | Achado | Severidade |
|---|---|---|
| V1 | **Falha de rede vira "não há eventos"**: o `catch` faz `setItems([])` e a tela mostra o estado vazio. API fora do ar e "realmente não há eventos" ficam indistinguíveis. | **Crítico** |
| V2 | O cabeçalho usa `page-hdr`, `page-title` e `page-sub` — **três classes que não existem no CSS**. O título fica do tamanho do texto comum, colado na borda, e o botão "Atualizar" cai para a linha de baixo. | **Crítico** |
| V3 | O botão principal do card (abrir no playback) não tem nome acessível — leitor de tela anuncia só "botão". | **Crítico (a11y)** |
| V4 | Texto de 10px com contraste ≈2,5:1 nas legendas "sem prévia"/"sem gravação". | **Crítico (a11y)** |
| V5 | "Atualizar" não dá retorno nenhum com a grade já preenchida — o operador clica várias vezes. | Importante |
| V6 | Falha ao marcar "visto" é silenciosa: o ✓ volta sozinho. | Importante |
| V7 | Duas toggles vizinhas com gramáticas diferentes (um muda de nome, o outro usa ✓). | Importante |

---

### 2.5 Câmeras (`/cameras`) — lista e assistente

**Pontos fortes.** A confirmação visual do assistente ("Resolução e codec são iguais em câmeras
diferentes — confirme pela imagem") resolve um problema real de campo. `camera-status.ts` é um dos
melhores trechos do repositório: separa conexão/atividade/configuração e proíbe verde-vermelho em estado
intermediário. Detecção automática reduz o cadastro de 20 campos para 4.

| # | Achado | Severidade |
|---|---|---|
| C1 | **Painel lateral de detalhe é inalcançável**: `setSelectedCam` só recebe `null` em todo o arquivo. "Reconectar gravação", "Gravação manual", "Movimento (armar)", "Controle PTZ" e "Diagnosticar PTZ" existem, funcionam e **não têm entrada em lugar nenhum da tela** (150 linhas). | **Crítico** |
| C2 | O modal do assistente não rola: em notebook de 768px o botão "Próximo" fica cortado **e inalcançável** depois da detecção. | **Crítico** |
| C3 | "Próximo" dispara uma sondagem de vários segundos **sem nenhum feedback** e aceita clique duplo. | **Crítico** |
| C4 | Essa sondagem é silenciosa: **senha errada avança sem avisar** e a câmera é salva sem nunca transmitir. | **Crítico** |
| C5 | Nenhum `<label>` associado ao campo em todo o assistente — o formulário mais importante do sistema. | **Crítico (a11y)** |
| C6 | A tabela (visão padrão) **não tem estado vazio** e **não marca câmera desativada** — o cartão marca. | Importante |
| C7 | Filtrar por "Gravando" devolve linhas rotuladas "Online" (o helper `atividadeAgora` existe e não é usado). | Importante |
| C8 | Lista inacessível por teclado: `<tr onClick>` sem `tabIndex`/`role`. | Importante |
| C9 | O botão de confirmar exclusão é **azul**, não vermelho — peso visual invertido em relação ao risco. | Importante |
| C10 | "Grupos" (filtro) = "Andar" (painel) = campo `floor`: três nomes na mesma tela. | Importante |
| C11 | Chamada a `/recordings/health-summary` a cada montagem para alimentar **só o painel inalcançável** — é o endpoint que já congelou a API por 11s. | Importante |

---

### 2.6 Detalhe da Câmera (`/cameras/:id`)

**Pontos fortes.** A melhor arquitetura de formulário do sistema (`SettingsCard`/`SettingsField`, com o
input **dentro** do `<label>` — a única associação correta do lote); cartão de diagnóstico
"Configurado × Detectado agora" com tom por divergência; rodapé fixo com resumo em linguagem de negócio.

| # | Achado | Severidade |
|---|---|---|
| D1 | **Relógio do vídeo ao vivo e horário dos eventos em UTC** (`:486` e `:1684`, `toISOString()`): 3 horas adiantados. Hora errada sobre imagem de câmera contamina qualquer conferência. | **Crítico** |
| D2 | Zero proteção contra perder o que foi digitado: ~25 campos, salvamento só no botão, e trocar de aba descarta tudo sem aviso. | Importante |
| D3 | "Detectar automaticamente" diz *"os dados foram aplicados automaticamente"* — mas nada foi persistido. Somado ao D2, sair da tela desfaz a detecção. | Importante |
| D4 | "Resolução no grid" mostra um valor e **salva outro** (constantes 1280×720). | Importante |
| D5 | Onze `catch` mostram `error.message` do axios ("Request failed with status code 400") descartando a mensagem real do backend. O helper correto existe na tela vizinha. | Importante |
| D6 | A aba não acompanha a URL (lida uma única vez) — voltar pelo navegador não volta a aba. | Importante |
| D7 | Aba "Eventos" inacabada: sem estado vazio, tipo cru em inglês, sem foto e sem link para o instante. | Importante |
| D8 | Barra com 4 ações de mesmo peso visual, três delas parecidas ("testar"/"diagnosticar"/"detectar"). | Importante |
| D9 | Acentuação: "conexao", "Deteccao concluida", "indisponivel", "disponivel", "validacao"; botão "Stop". | Importante |

---

### 2.7 Editar Câmera (painel lateral) e Adicionar Câmera Push

| # | Achado | Severidade |
|---|---|---|
| E1 | **Trocar "Como o vídeo chega" apaga a chave de publicação sem confirmar** (`CameraEditSheet:357` → `DELETE .../rtmp-ingest`). Os dois cartões parecem um seletor inofensivo; uma câmera 4G em campo para de transmitir na hora e a chave não volta. | **Crítico** |
| E2 | O asterisco de obrigatório é decorativo — nada é validado, e salvar com nome vazio devolve erro cru. | Importante |
| E3 | Esc e clique no fundo descartam tudo sem guarda de alterações pendentes. | Importante |
| E4 | Confirmação de exclusão **inline**, enquanto a lista usa diálogo modal para a mesma ação — e com verbos diferentes ("Remover" × "Excluir"). | Importante |
| E5 | Largura fixa de 460px estoura a tela do celular. | Importante |

**Ponto forte a preservar:** a explicação de RTSP × RTMP em dois cartões diz o que muda *para quem
instala* ("porta liberada ou VPN" × "funciona atrás de CGNAT e 4G") — não o que a sigla significa. E o
diálogo de câmera push é a melhor tela de formulário do sistema: um campo obrigatório, foco automático,
Enter envia, botão com estado de salvamento.

---

### 2.8 Zonas de Detecção (dentro do Detalhe da Câmera)

| # | Achado | Severidade |
|---|---|---|
| Z1 | **"Desfazer alterações" reverte para um estado que o servidor não tem mais.** O pai não recarrega após salvar: desenha 3 zonas → salva → desfaz → a tela volta a zero e o botão desabilita, **mas o servidor continua com as 3 zonas**. O operador sai convencido de que reverteu. | **Crítico** |
| Z2 | Excluir zona sem confirmação e sem desfazer — um clique apaga um polígono de 20 pontos desenhado à mão. | Importante |
| Z3 | Impossível desenhar sem mouse; e não há como corrigir um ponto (nem apagar o último, nem mover vértice). | Importante |
| Z4 | Usa um sistema visual (`.segment`/`.seg-btn`) que a página hospedeira não usa — botões de 30px ao lado de botões de 36px. | Importante |

**Ponto forte:** coordenadas normalizadas 0..1 com o motivo documentado (a zona sobrevive à troca de
resolução), e o aviso de que uma zona "monitorar" faz todo o resto ser ignorado — antecipa o erro mais
caro do recurso.

---

### 2.9 Alarmes (`/alarms`)

**Pontos fortes.** O painel "Entrega de notificações" (canal, status, tentativa, motivo) é transparência
que nenhuma outra tela tem. Agrupamento por ocorrência evita enxurrada de duplicados. O link para
`/playback?cameraId=…&at=…` leva ao instante exato — o fluxo mais valioso da tela.

| # | Achado | Severidade |
|---|---|---|
| A1 | **O estado vazio mente quando a API cai.** No modo Operação (padrão) o único texto possível é "Nenhum alarme neste status"; o erro só é renderizado dentro de um acordeão recolhido **da outra tela**. Às 2h da manhã o operador conclui que a noite está tranquila. | **Crítico** |
| A2 | A atualização de 5s engole erros: a lista **fica estagnada com dados antigos** por tempo indeterminado, sem "atualizado há X". | **Crítico** |
| A3 | **"Apagar todos" apaga mais do que a tela mostra.** O botão é habilitado pela lista *filtrada*, mas o `DELETE /cameras/alarms` apaga **todos os alarmes do sistema** — e é confirmado por uma caixa nativa do navegador. Filtrar "Câmera 3" e clicar destrói o histórico de todas as câmeras. | **Crítico** |
| A4 | Filtros continuam ativos ao voltar ao modo Operação, onde **não há indicador nem forma de limpar**. O operador passa o turno vendo tela vazia. | **Crítico** |
| A5 | Selo de prioridade, data/hora do alarme e colunas da tabela em 9px (a data ainda com opacidade 60%). | **Crítico (a11y)** |
| A6 | Os contadores das abas zeram sozinhos ao filtrar — o operador perde a noção de pendências. | Importante |
| A7 | Nenhuma aba nasce marcada e não existe "Todos". | Importante |
| A8 | Botão "Ver Câmera" **sem `onClick`** — morto. | Importante |
| A9 | O painel "Resumo" renderiza empilhado embaixo da página, com uma borda solta no meio do nada (era para ser coluna direita). | Importante |
| A10 | Três truncamentos silenciosos: `limit 300`, "Reconhecidos (37)" mostra 5, "Resolvidos (120)" mostra 10. | Importante |
| A11 | "Simular" dispara alarme real em produção com um clique, sem avisar que envia notificação aos destinatários. | Importante |
| A12 | `window.alert` como canal de erro (o resto do sistema usa avisos no tema). | Importante |
| A13 | "Alertas" × "alarmes"; e o mesmo status como "Ativo", "Aberto" e "Abertos" na mesma tela. | Importante |
| A14 | Enum cru na tela: "camera_tampering", "perimeter_breach", "FAILED", "PUSH · SKIPPED". | Importante |
| A15 | A coluna "Resolvido por" mostra **quem reconheceu** — atribuição errada em auditoria de plantão. | Importante |
| A16 | Modal de regra feito à mão: não fecha no Esc, não prende foco, sem `role="dialog"`. | Importante |
| A17 | Paleta de prioridade em HSL literal calibrada para o tema escuro; no claro, P1 vira vermelho-claro sobre card branco. | Importante |

---

### 2.10 Armazenamento (`/storage`) — à luz do incidente do bucket apagado

**Pontos fortes.** O tratamento de storages anteriores é **o melhor padrão de ação destrutiva do
repositório**: separa ESVAZIAR de REMOVER, nomeia o bucket, informa quantas gravações e quantos bytes
perdem a cópia, e exige digitar o nome do bucket. O cartão de nuvem tem o melhor texto de UX do sistema.

| # | Achado | Severidade |
|---|---|---|
| S1 | **O número do risco está escondido.** A faixa nobre mostra três cartões do disco local; "Só na nuvem" — quantas gravações somem se o fornecedor sumir — está três seções abaixo, dentro de um acordeão, como o terceiro de três quadradinhos neutros. Depois do incidente, é o único número que responde à pergunta que importa. | **Crítico** |
| S2 | O rótulo "Só na nuvem" pode ser lido como **boa** notícia ("já está salvo na nuvem"), quando significa "não existe em mais lugar nenhum". | **Crítico** |
| S3 | **O atrito está invertido**: "Apagar vídeos" (todas as gravações de todas as câmeras) é um clique com diálogo genérico; esvaziar um bucket já desativado exige digitar o nome do bucket. | **Crítico** |
| S4 | Quando os dados do sistema não carregam, a tela mostra **"0.0 TB" como se fosse verdade** e a tabela de volumes fica só com o cabeçalho. Não há estado de carregando nem de erro. | **Crítico** |
| S5 | **A janela de datas é montada em UTC** (`:100`): escolher "07/08" consulta de 06/08 21:00 a 07/08 20:59 local. O consumo relatado ao cliente está sistematicamente errado. | **Crítico** |
| S6 | **Três limiares diferentes para o mesmo percentual de disco** na mesma página (≥95/≥80, ≥95/≥80, >82/>62) e um anel que é sempre azul. A 85%: anel azul calmo, barra vermelha e coluna "Aviso" — simultaneamente. | **Crítico** |
| S7 | **`--status-critical` não existe no CSS.** É usado em três lugares do cartão de storages anteriores, inclusive no fundo do botão "Apagar definitivamente" — que fica **texto branco sobre card branco no tema claro: invisível**. O painel de aviso perde a borda e o fundo vermelhos. | **Crítico** |
| S8 | Qualquer falha ao consultar a nuvem vira **"Nenhum armazenamento em nuvem instalado"** — a afirmação mais perigosa possível numa instalação que já perdeu 12.443 gravações. | **Crítico** |
| S9 | A lista de storages anteriores **some inteira** quando a consulta falha (`catch` → `null` → `return null`). O contrato antigo que ainda se paga fica invisível justamente quando há problema. | **Crítico** |
| S10 | "Remover mesmo assim" é um clique só e é a opção em destaque — remover o cadastro apaga a credencial e o acervo fica permanentemente inalcançável. É a receita exata do incidente vivido. | **Crítico** |
| S11 | Tabela de volumes sem rolagem horizontal; `display:flex` aplicado em `<td>` (quebra o alinhamento das colunas). | Importante |
| S12 | `slice(0, 200)` contradiz o resumo que anuncia "1.842 linha(s)". | Importante |
| S13 | Erro do axios exibido cru e com a **mesma classe visual** do resumo de sucesso — parece rodapé informativo. | Importante |
| S14 | Duas formatadores de bytes diferentes; um força GB sempre ("0.03 GB") e usa ponto decimal sem separador de milhar. | Importante |
| S15 | "vídeos" × "gravações" × "clipes" para a mesma coisa; e o diálogo **não diz se as cópias na nuvem também são apagadas** — a dúvida que mais importa hoje. | Importante |

---

### 2.11 Usuários, Grupos, Funções, Perfil e Configurações

**Pontos fortes.** O diálogo de retenção de grupo é modelo de "explicar antes de aplicar": quantifica
"vale para 4 de 17", diz o que acontece com as exceções e avisa da varredura horária. As Configurações
são a única tela longa com navegação interna, e seu botão Salvar tem os três estados completos. A prévia
do app móvel com verificação automática de contraste é excelente.

| # | Achado | Severidade |
|---|---|---|
| P1 | **"Minha conta" mostra os grupos errados.** O comentário diz *"Filtra apenas as permissões do usuário atual"* e o código filtra só por ter `groupId` — **nunca por usuário**. Um visualizador com acesso a 15 câmeras lê "Nenhum grupo atribuído"; um admin vê os grupos de todo mundo como se fossem dele. | **Crítico** |
| P2 | O mesmo erro libera indevidamente o bloco "Usuários do grupo", que então carrega e exibe a lista de **todos** os usuários. | **Crítico** |
| P3 | **Interruptores de permissão que não fazem nada**: `<Switch checked={p.allowed} disabled={!isAdmin} />` sem `onCheckedChange`, sobre uma lista fixa em código. O admin configura "Controle PTZ", "Exportar evidências" e sai convencido de que salvou. | **Crítico** |
| P4 | **O botão "Salvar" das Funções fica fora da tela e não há rolagem** (`SheetContent` sem `overflow-y-auto`): com 11 permissões, em notebook de 768px o admin edita e não alcança o botão. | **Crítico** |
| P5 | **Exclusão permanente de usuário via `window.confirm`** nativo, enquanto excluir um *grupo* tem diálogo completo. Um Enter distraído apaga a conta. | **Crítico** |
| P6 | Bloquear/desbloquear usuário **não trata erro nem dá retorno**: a chamada rejeita sem tratamento, nada muda na tela, e o admin acredita que bloqueou. | **Crítico** |
| P7 | Reduzir a retenção global apaga gravações e **a tela não avisa** — a mesma decisão um nível abaixo (grupo) é explicada muito bem. | **Crítico** |
| P8 | Reescrever a matriz de permissões: sem confirmação, sem dizer quantos usuários são afetados, e sem impedir que o admin se tranque para fora. | **Crítico** |
| P9 | **Quatro políticas de senha diferentes** anunciadas para a mesma senha (4, 10, 12, e "12 com maiúscula/minúscula/número"). | Importante |
| P10 | Trocar a própria senha **sem campo de confirmação** e sem revelar o que foi digitado. | Importante |
| P11 | Operador vê (e pode tentar) excluir e bloquear qualquer usuário; a variável de permissão já existe e não é usada. | Importante |
| P12 | Revogar acesso a grupo, tirar câmera de grupo e bloquear usuário: **imediatos, irreversíveis e mudos** — dentro de modais onde o resto só vale ao salvar. | Importante |
| P13 | Cinco palavras para três conceitos: "Perfil", "Funções", "Funções e Permissões", "Perfis e Permissões", "Nível de acesso". O texto manda ir a uma tela que não existe com esse nome. | Importante |
| P14 | A mesma enumeração de nível de acesso escrita de duas formas em telas diferentes. | Importante |
| P15 | Estado parcial de alarmes do grupo aparece como "desligado": com 9 de 10 ligadas, desligar o interruptor apaga as 9. | Importante |
| P16 | `--warning` (token inexistente) no aviso de perda de dias — o "−7 dias" que deveria gritar sai na cor do texto normal. | Importante |
| P17 | Retenção com valor inválido é **corrigida em silêncio para 7 dias**. | Importante |
| P18 | A tela de Funções usa uma paleta paralela (`--surf-*`, `--tx-*`) que nenhuma outra tela do lote usa. | Importante |
| P19 | Nenhum campo dos cinco arquivos tem rótulo programaticamente associado. | **Crítico (a11y)** |
| P20 | Sliders de 1–365 e 5–1440 sem entrada numérica: acertar 60 minutos exige mirar 1 de 1436 posições. | Importante |

---

### 2.12 Mapa (`/map`) e Investigação (`/investigation`) — fora do menu

**Mapa.** Constrói a planta a partir de dados reais e *diz isso ao usuário* — honestidade rara. Mas:
não tem **nenhum** breakpoint (inutilizável abaixo de ~900px); o SVG é **completamente inacessível**
(sem `role`, sem teclado, sem alternativa em lista); os marcadores têm 14px de alvo; e o mapa **esconde
câmeras e zonas silenciosamente** quando passam de 12 por zona ou ~13 zonas. Promete três vezes um
upload de planta que não existe em lugar nenhum. **Crítico** nos quatro primeiros itens.

**Investigação.** O modelo de domínio é sério e raro (ciclo de 5 estados, cadeia de custódia,
preservação legal, relatório com motivo obrigatório). Mas a área central é **uma maquete que finge ser
prova**: selo vermelho "Gravação", relógio que parece contar, barra de progresso fixa em 72%, régua com
blocos em posições codificadas e um botão ▶ **sem `onClick`**. Numa tela de investigação, isso sugere
que um vídeo foi revisado quando não foi.

| # | Achado | Severidade |
|---|---|---|
| I1 | Maquete de vídeo com aparência de prova revisada. | **Crítico** |
| I2 | **Evidência pode ser anexada ao caso errado**: depois do `await`, o código lê `investigations[0]?.id` de um array obsoleto e anexa a evidência a *outra* investigação, com aviso de sucesso. Contaminação de acervo. | **Crítico** |
| I3 | **A coluna direita não rola** — "Cadeia de custódia", a razão de existir da tela, é inalcançável em 1080p. | **Crítico** |
| I4 | Cada tecla digitada na busca recarrega e **apaga a tela inteira** (o spinner substitui tudo), perdendo o foco do campo. | **Crítico** |
| I5 | O recarregamento **sobrescreve o que o usuário está escrevendo**. | **Crítico** |
| I6 | A preservação legal é ativada **visualmente sem ser aplicada** — o material vence e é apagado pela retenção. | **Crítico** |
| I7 | "{N} ocorrências encontradas" anuncia o número **já cortado** por `slice(0, 40)`. Afirmação factualmente errada num contexto que pode ir a juízo. | **Crítico** |
| I8 | Três marcações de tempo com significados diferentes para a mesma variável: clicar num evento das 14h35 põe o cursor em 61% da régua e o relógio anuncia 01:35 do dia seguinte. | **Crítico** |
| I9 | Cores fixas ignorando o tema (laje escura no meio de um app claro) e textos em `text-white/55` a 10px. | Importante |
| I10 | Nenhuma das cinco listas distingue vazio de erro — cadeia de custódia vazia significa "ninguém tocou nesta prova". | Importante |
| I11 | `window.prompt` para o motivo do relatório; três botões "Salvar" com escopos diferentes e nenhum indicador de pendência. | Importante |

---

### 2.13 Login, Redefinir Senha, 404 e o casco da aplicação

**Pontos fortes.** O login distingue de verdade rede × 401 × outros erros, tem rótulos corretamente
associados (raro no projeto), estado "Autenticando…" e limpa o erro ao digitar. O `lazyWithReload`
resolve o erro de chunk após deploy — problema real que a maioria dos apps ignora. Itens sem permissão
**somem** do menu em vez de aparecerem desabilitados: decisão correta para um VMS.

| # | Achado | Severidade |
|---|---|---|
| N1 | **A conta bloqueada é informada de que errou a senha.** A API responde 401 com *"Conta temporariamente bloqueada… tente em X min"*, e o front descarta essa mensagem e mostra "Credenciais inválidas". O operador continua tentando e **estende o próprio bloqueio**. (A tela de redefinir senha já faz certo.) | **Crítico** |
| N2 | HTTP 429 (limite de tentativas) vira "Falha no servidor de autenticação" — o usuário abre chamado reportando servidor fora do ar. | **Crítico** |
| N3 | No celular com o teclado aberto, **o botão "Entrar" fica inalcançável**: `min-h-screen` + `overflow-hidden`, e o foco automático abre o teclado sozinho. | **Crítico** |
| N4 | A mensagem de erro do login tem **2,6:1 de contraste no tema claro** (passa no escuro — por isso não foi notado). | **Crítico (a11y)** |
| N5 | Rótulo sem `htmlFor` e campo sem `id` na redefinição de senha. | **Crítico (a11y)** |
| N6 | Sem `autocomplete` nos campos de login: gerenciadores de senha não preenchem nem oferecem salvar. | Importante |
| N7 | O modal "Esqueci minha senha" afirma "enviamos um link" **mesmo com a API fora do ar**. | Importante |
| N8 | Redefinição sem campo de confirmação e sem detectar link sem token antes de digitar a senha. | Importante |
| N9 | **A sidebar é inutilizável no celular**: trilho de 56px forçado, botão de expandir escondido, e os tooltips dependem de hover. | Importante |
| N10 | O papel do usuário aparece em inglês ("Admin", "Operator", "Viewer"). | Importante |
| N11 | Falta de permissão **redireciona em silêncio** — o usuário conclui que o link está quebrado. | Importante |
| N12 | A tela de login **pisca a cada recarga** (o estado de autenticação começa `false` e ignora o carregamento inicial). | Importante |
| N13 | Não existe barreira de erro global: uma exceção no login, no menu ou no casco resulta em **tela branca**. | Importante |
| N14 | `/profile` e `/app-builder` não estão no mapa de títulos: o cabeçalho de "Minha conta" lê "DRAC VMS". | Importante |
| N15 | Na página 404, um `<a>` dentro de outro `<a>`: o elemento com aparência de botão **não é o link**, e o foco do teclado sai deslocado. Além disso o 404 fica fora do casco — o usuário logado perde menu e cabeçalho. | Importante |
| N16 | Sair da conta: um clique, alvo de 28px, sem confirmação — num monitoramento 24/7 derruba todos os players. | Importante |

---

### 2.14 Páginas sem rota (1.441 linhas inalcançáveis) — veredito

| Página | Veredito | Justificativa |
|---|---|---|
| **Evidência** (317) | **Ligar** — a mais valiosa | Fluxo completo solicitar → aprovar → executar → baixar → **verificar hash e assinatura**, contra endpoints que existem. É a companheira natural da Investigação, que já está roteada: hoje o operador abre um caso e não tem como exportar a evidência. *Antes de ligar:* trocar os dois `window.prompt()` que colhem a justificativa de aprovação — em cadeia de custódia isso é inaceitável. |
| **Desempenho** (470) | **Ligar com ressalva** | Consome três endpoints existentes, usa biblioteca compartilhada e degrada com segurança. *Antes:* corrigir a rolagem (a página é longa e seria cortada) e **revisar o auto-refresh de 5s** disparando 3 requisições — o histórico de `/recordings/health-summary` congelando a API por 11s recomenda cautela. Sem design novo. |
| **Auditoria** (138) | **Ligar depois de um conserto** | A store já busca os dados de verdade. Mas a coluna **"Resultado" é falsa**: a função de cor não recebe argumento e o selo é literalmente "Sucesso" em toda linha. Uma tela de auditoria que carimba sucesso numa ação que falhou é pior que não existir. |
| **Relatórios** (113) | **Remover** | Só reagrega dados que já estão na store, e o próprio texto denuncia: "Exportações em PDF/CSV **devem** usar estes mesmos dados" — a exportação não existe. Uma tela de relatórios que não gera relatório. |
| **Eventos** (403) | **Remover** — a mais enganosa | "Reconhecer" **não chama API nenhuma**: grava num conjunto local e some ao recarregar. Os dois "players" são gradiente com ícone e overlays falsos "REC"/"Ao vivo". A "linha do evento" são três frases fixas em código. Link para uma rota que não existe. Concorre com Alarmes e Revisão, ambas vivas. |

---

## 3. Achados transversais (só aparecem comparando as telas)

| # | Achado | Severidade |
|---|---|---|
| T1 | **Três sistemas de botão convivendo**: classes caseiras `.btn`, kit `<Button>` e `<button>` cru com Tailwind inline. Grupos usa os três; Alarmes e Investigação não usam nenhum dos dois padrões formais. Daí nascem as divergências de altura (30/32/34/36/40px), raio, foco e estado desabilitado (`opacity-40/45/50/60` na mesma tela). | Importante |
| T2 | **Quatro alturas de campo** para o mesmo input (32, 36, 36 e 40px), em quatro implementações diferentes. | Importante |
| T3 | **Não existe casco de página compartilhado**: cada tela decide sua rolagem. Quatro erram e deixam botões inalcançáveis (Funções, AppBuilder, Desempenho, assistente de câmera). | **Crítico** |
| T4 | **Confirmação destrutiva sem escada coerente**: excluir usuário → caixa nativa do navegador; excluir grupo → diálogo completo; revogar acesso, bloquear usuário, tirar câmera de grupo, reescrever permissões, reduzir retenção global, ativar GPU → **nada**. As ações mais destrutivas são as que menos perguntam. | **Crítico** |
| T5 | **Rótulos acessíveis são ilha**: Reprodução 25/24 e Configurações 14/8; Alarmes 1/24, Investigação 1/16, Perfil 1/8, Funções 0/3, Mapa 0/3. | **Crítico (a11y)** |
| T6 | **Nenhum campo de formulário tem rótulo associado**, exceto o `SettingsField` do Detalhe da Câmera e o `Field` do AppBuilder. | **Crítico (a11y)** |
| T7 | **Responsividade em duas velocidades**: Configurações 14 breakpoints, Detalhe 19, Reprodução 12; **zero** em Câmeras (1.764 linhas), Grupos (833), Investigação (888), Usuários (535), Perfil (466), Mapa (298) e Login. | Importante |
| T8 | **Tipografia abaixo de 11px espalhada** — cerca de 150 ocorrências de `text-[9px]`/`text-[10px]`. Grave onde se soma a contraste baixo ou informação crítica (selos de prioridade, hora do alarme, aviso de offline, cadeia de custódia). | Importante |
| T9 | **Três tokens de cor usados e inexistentes**: `--status-critical` (botão invisível no tema claro), `--warning` (aviso sem cor). Mais duas classes CSS inexistentes (`alarm-blink`, `scan-line-overlay`) e três de cabeçalho (`page-hdr`, `page-title`, `page-sub`). | **Crítico** |
| T10 | **Âmbar cru do Tailwind** como cor de aviso em pelo menos 6 arquivos, em paralelo ao token `--status-warning` que existe. | Importante |
| T11 | **Duas formatações de data** (sete telas com `format()`, três com `toLocaleString`) e nenhuma com locale pt-BR explícito; uma tela usa `yyyy-MM-dd` numa interface que usa `dd/MM/yyyy` na linha de cima. | Importante |
| T12 | **Duas tabelas sem rolagem horizontal** (Usuários e Funções): colunas cortadas sem alcance em tela estreita. | Importante |
| T13 | **Enum cru em inglês exposto ao operador** em pelo menos 5 telas ("camera_tampering", "PENDING_APPROVAL", "No signal", "Continuous", "FAILED"). | Importante |
| T14 | **`window.confirm`/`window.alert`/`window.prompt`** usados em 5 pontos, fora do tema e sem foco preso — inclusive para justificativa de cadeia de custódia. | Importante |
| T15 | **Código morto com funcionalidade real**: painel de câmera inalcançável, `handleMotionRecording`, `atividadeAgora`, `STATUS_DOT`, dois `setLocation` não usados. | Importante |
| T16 | **Ponto forte a preservar:** ícones 100% de uma biblioteca só (lucide), avisos em um único sistema, e os atalhos `Alt+1..6` anunciados **realmente existem** e respeitam o papel do usuário. | — |

---

## 4. Observações (confirmar antes de agir)

Itens em que a decisão é sua e muda a correção:

1. **`/wall`, `/map`, `/investigation` e `/app-builder` estão fora do menu.** São 1.500+ linhas
   alcançáveis só por URL ou pela paleta de comandos. São experimentais a esconder, funcionalidades a
   lançar, ou código a remover? Isso muda radicalmente a prioridade de dezenas de achados.
2. **A Investigação deve exibir vídeo?** Se sim, a maquete é bloqueadora. Se ela é só o *dossiê*
   (evidências + custódia + relatório) e o vídeo vive na Reprodução, basta remover a maquete e a tela
   fica honesta com pouco trabalho.
3. **`--status-critical`** era para existir como token novo (mais grave que `--status-alarm`), ou foi
   engano por `--destructive`?
4. **Codec de gravação:** três telas dizem coisas incompatíveis (duas travam em "cópia", uma oferece
   escolha livre, e as três enviam o codec do banco). Qual é a regra correta?
5. **O relógio em UTC** sobre o vídeo é requisito (alinhar com o carimbo do arquivo) ou defeito? Se for
   requisito, precisa dizer "UTC" ao lado do número.
6. **O painel lateral de câmeras foi desativado de propósito** quando o painel de edição entrou, ou o
   religamento se perdeu? As ações órfãs precisam de casa nova em qualquer dos casos.
7. **Tema claro é oficialmente suportado?** Vários achados de contraste só existem nele.
8. **A sidebar precisa funcionar no celular**, ou o app móvel dedicado cobre esse caso?
9. **Piso de senha de 4 caracteres** é intencional ou herança de desenvolvimento?
10. **Tipografia de 9-10px** parece decisão estética de VMS nos chips monoespaçados. Listei apenas os
    casos em que o tamanho se soma a contraste ruim ou informação crítica.

---

## 5. Lista priorizada — o que vale fazer primeiro

Ordenada por **dano ao usuário ÷ esforço**. Os cinco primeiros blocos são o que eu faria antes de
qualquer coisa cosmética.

### Bloco 1 — A interface está afirmando coisas falsas (fazer primeiro)

| # | O quê | Onde | Esforço |
|---|---|---|---|
| 1 | **Relógio em UTC sobre imagem de câmera** — 3h adiantado no detalhe e no mural; no mural ainda está congelado | `CameraDetailPage:486,1684`, `WallModePage:75,125` | Baixo |
| 2 | **"Minha conta" mostra os grupos de outras pessoas** e libera indevidamente a lista de usuários | `ProfilePage:94` | Baixo |
| 3 | **Coluna "Resultado" da auditoria carimba "Sucesso" em toda linha** (se a página for ligada) | `AuditLogsPage:8,121` | Baixo |
| 4 | **Interruptores de permissão que não salvam nada** | `GroupsPage:560` | Médio |
| 5 | **"Desfazer" nas zonas de detecção reverte para um estado que o servidor não tem** | `DetectionZonesEditor` + pai | Baixo |
| 6 | **Falha de rede vira "não há nada"** em Revisão, Alarmes, Grupos, Perfil e no cartão de nuvem | 5 telas | Médio |
| 7 | **"{N} ocorrências encontradas" anuncia número já truncado**; três outras contagens mentem | `InvestigationPage`, `AlarmsPage`, `StoragePage` | Baixo |

### Bloco 2 — Ação destrutiva com atrito invertido

| # | O quê | Onde | Esforço |
|---|---|---|---|
| 8 | **"Apagar todos os alarmes" apaga o sistema inteiro** mas é habilitado pela lista filtrada, com caixa nativa | `AlarmsPage:529` | Baixo |
| 9 | **"Apagar vídeos" (todas as câmeras) com um clique**, enquanto esvaziar bucket exige digitar o nome | `StoragePage:171` | Baixo |
| 10 | **Trocar o modo de conexão apaga a chave de publicação sem perguntar** | `CameraEditSheet:357` | Baixo |
| 11 | **Excluir usuário permanentemente via `window.confirm`** | `UsersPage:189` | Baixo |
| 12 | **Escada de confirmação coerente** — revogar acesso, bloquear usuário, tirar câmera de grupo, reduzir retenção global e reescrever permissões hoje não perguntam nada | 5 telas | Médio |

### Bloco 3 — Botões inalcançáveis (o usuário não consegue concluir a tarefa)

| # | O quê | Onde | Esforço |
|---|---|---|---|
| 13 | **Definir o contrato de rolagem da página** e aplicar nas 4 telas que erram | Funções, AppBuilder, Desempenho, assistente de câmera | Baixo |
| 14 | **Painel lateral de câmeras inalcançável** — 5 ações operacionais sem entrada na interface | `CamerasPage:1585` | Médio |
| 15 | **Coluna da cadeia de custódia não rola** | `InvestigationPage:701` | Baixo |
| 16 | **"Trocar/Remover" câmera só no hover** — impossível em tela sensível ao toque | `LiveViewPage:851` | Baixo |
| 17 | **Login sem rolagem no celular com teclado aberto** | `LoginPage:131` | Baixo |

### Bloco 4 — Erro que impede o usuário de se resolver sozinho

| # | O quê | Onde | Esforço |
|---|---|---|---|
| 18 | **Conta bloqueada é informada de que "errou a senha"** — e cada nova tentativa estende o bloqueio | `LoginPage:106` | Baixo |
| 19 | **429 vira "falha no servidor"** | `LoginPage:107` | Baixo |
| 20 | **Sondagem silenciosa no assistente**: senha errada avança e salva câmera que nunca transmite | `CamerasPage:386` | Baixo |
| 21 | **Mensagem real do backend descartada** em 11 pontos (helper já existe na tela vizinha) | `CameraDetailPage` | Baixo |
| 22 | **Filtros ativos e invisíveis** no modo Operação de alarmes | `AlarmsPage:323` | Baixo |

### Bloco 5 — Acessibilidade com barreira real

| # | O quê | Onde | Esforço |
|---|---|---|---|
| 23 | **Rótulos acessíveis nos botões só-ícone** das telas que estão em 1-para-24 | Alarmes, Investigação, Perfil, Funções, Mapa | Médio |
| 24 | **Associar `<label>` aos campos** (padrão bom já existe em duas telas) | Todos os formulários | Médio |
| 25 | **Contrastes abaixo de 3:1** em texto de estado — offline, sem prévia, erro do login no tema claro | 6 telas | Baixo |
| 26 | **Tokens e classes CSS inexistentes** — inclui o botão "Apagar definitivamente" invisível no tema claro | `--status-critical`, `--warning`, 5 classes | Baixo |
| 27 | **Listas e mapas inacessíveis por teclado** | Câmeras, Usuários, Funções, Mapa | Médio |

### Bloco 6 — Decisões que destravam o resto

| # | O quê | Esforço |
|---|---|---|
| 28 | **Decidir o destino de `/wall`, `/map`, `/investigation`, `/app-builder`** e das 5 páginas órfãs (ligar Evidência e Desempenho; remover Relatórios e Eventos) | Decisão |
| 29 | **Escolher um sistema de botão** e um casco de página; migrar tela a tela | Alto (incremental) |
| 30 | **Unificar vocabulário**: alarme/alerta, perfil/função, quadro/slot, grupo/andar, gravações/vídeos | Baixo |
| 31 | **Padronizar data em pt-BR** e extrair um formatador de bytes único | Baixo |

---

### Se eu tivesse um dia só

Os itens **1, 2, 8, 9, 10, 18 e 26**. São todos de esforço baixo, todos verificados no código, e cada um
elimina uma situação em que o sistema ou mente para o operador ou destrói dados com um clique.
