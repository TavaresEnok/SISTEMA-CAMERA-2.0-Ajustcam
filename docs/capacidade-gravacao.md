# Capacidade de gravação — números MEDIDOS

"Quantas câmeras por servidor?" é a primeira pergunta de todo integrador. Até
agora o repositório não tinha como responder: nenhum benchmark, nenhum teste de
carga. Este documento traz o número **medido**, a metodologia para reproduzi-lo
e — o mais importante — o que ele **não** cobre.

Reproduza com:

```bash
BENCH_CAMERAS=8 BENCH_SECONDS=60 bash scripts/benchmark-capacity.sh run
```

## Resultado (host de referência: 10 núcleos, 7,7 GB RAM)

Perfil do stream: 1280×720 @ 15 fps, alvo 2 Mbps, gravação em modo `copy`
(o padrão do produto — arquiva o stream da câmera sem re-encodar o vídeo).

| Custo por câmera | Medido |
|---|---|
| CPU | **1,6 %** de um núcleo |
| RAM | **53 MB** (RSS) |
| Escrita | **2,1 Mbps** (~22,6 GB/dia) |

| Teto por recurso (a 70 % de utilização) | Câmeras |
|---|---|
| por CPU | ~434 |
| **por RAM** | **~101** ← limitante |
| por disco (100 MB/s sustentados) | ~382 |

> **Capacidade neste host: ~100 câmeras, limitada por RAM.**

### Por que a RAM é o gargalo (e por que projetar por CPU engana)

Em modo `copy` o vídeo **não é decodificado** — o processo só demuxa, remuxa e
encoda o áudio. Isso torna a CPU barata (1,6 % por câmera) e faz a conta por CPU
render um número irreal (~434). Cada processo de gravação carrega ~53 MB de
buffers e do próprio runtime do ffmpeg, e é isso que esgota primeiro.

Consequência prática de compra: **para gravação, RAM vale mais que núcleos.**
Dobrar a RAM aproxima de dobrar a capacidade; dobrar os núcleos não muda nada.

### Linearidade — por que a extrapolação é defensável

O custo por câmera foi medido em duas cargas e ficou estável:

| Câmeras simultâneas | CPU/câmera | RAM/câmera | Escrita/câmera |
|---|---|---|---|
| 4 | 1,56 % | 53,4 MB | 2,10 Mbps |
| 8 | 1,61 % | 53,2 MB | 2,09 Mbps |

Diferença dentro do ruído de amostragem. Ainda assim, a extrapolação de 8 para
~100 é uma **projeção**, não uma medição: antes de virar promessa contratual,
rode com um N maior no hardware de destino.

### Validação cruzada da metodologia

A escrita medida (2,1 Mbps ≈ 22,6 GB/dia por câmera) coincide com a medição
independente de armazenamento já registrada no projeto (2,06 Mbps ≈ 22,2 GB/dia).
Duas medições feitas por caminhos diferentes chegando ao mesmo lugar é o melhor
indício de que o harness está medindo o que diz medir.

## O que este número NÃO inclui

Ler esta lista é obrigatório antes de usar o número comercialmente:

- **IA / detecção** — o serviço de IA roda em processo separado e consome do
  mesmo orçamento. Uma instalação com detecção ativa em todas as câmeras terá
  capacidade de gravação **substancialmente menor**.
- **Transcode ao vivo** — o modo `copy` medido aqui não re-encoda. Streaming ao
  vivo com transcode (navegador sem HEVC, por exemplo) é outra ordem de custo.
- **API, Postgres, MediaMTX** — no mesmo host, dividem RAM e CPU com a gravação.
- **Pico de reconexão** — N câmeras reconectando ao mesmo tempo (queda de rede,
  reinício de switch) custa mais que o regime permanente.
- **Disco real** — o teto de 100 MB/s é um piso conservador para HDD 7200 rpm
  com fluxos concorrentes. SSD/NVMe muda a conta; HDD lento também.
- **Retenção** — capacidade de *gravar* não é capacidade de *guardar*. A 22,6
  GB/dia por câmera, 100 câmeras geram ~2,3 TB/dia.

## Como usar isso numa proposta

1. Rode o benchmark **no hardware que será vendido**, com o perfil de stream
   real do cliente (resolução/bitrate mudam a conta de disco linearmente).
2. Comece pelo teto de RAM — é o limitante no modo padrão.
3. Se houver IA, meça de novo com a IA ligada; não estime.
4. Dimensione o armazenamento por `câmeras × GB/dia × dias de retenção`.

## Metodologia

`scripts/benchmark-capacity.sh` sobe, em containers isolados
(`drac-bench-*`, rede e portas próprias — não toca a instalação viva):

1. Um MediaMTX de teste;
2. N publicadores sintéticos (`ffmpeg testsrc` + áudio) no perfil configurado;
3. N processos de gravação com os **mesmos argumentos** que a API usa em
   produção (`buildArgs` em `recording-process-manager.service.ts`): `-c:v copy`,
   `-c:a aac -ar 44100 -ac 1`, `-f segment -segment_format mpegts`.

Depois de um aquecimento (o startup distorce a média), amostra CPU e RSS a cada
2 s e mede os bytes efetivamente escritos.

**Os publicadores são excluídos da medição.** Eles gastam CPU encodando, o que em
campo é trabalho da câmera, não do servidor — contá-los inflaria o custo por
câmera em várias vezes. O script também aborta se qualquer gravador morrer
durante a janela: medir com processo morto daria um custo baixo e mentiroso.
