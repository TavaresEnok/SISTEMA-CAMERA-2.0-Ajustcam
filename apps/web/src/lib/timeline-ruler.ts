// ── A RÉGUA DE TEMPO ────────────────────────────────────────────────────────
//
// A timeline antiga tinha CINCO rótulos em posições fixas (0/25/50/75/100%) e
// nenhuma marcação. Isso quebra de duas formas: com zoom, os rótulos caem em
// horários quebrados ("06:37", "09:14") que não ajudam a mirar nada; e sem
// ticks o operador não tem escala nenhuma — a barra vira um retângulo colorido.
//
// Todo VMS sério (Milestone, Genetec, Avigilon, Axis, Frigate) desenha uma
// régua com marcações em TRÊS níveis, em horários REDONDOS, cuja granularidade
// acompanha o zoom. É isso que estas funções produzem.
//
// A escolha do passo segue a escala 1-2-5-10-15-30-60 (a mesma heurística de
// eixo do D3/Grafana): o menor passo cujo rótulo ainda tenha ~80px de folga —
// abaixo disso `HH:MM` começa a colidir e a régua fica ilegível.

/** Passos permitidos, em minutos. Só horários que um humano considera redondo. */
const PASSOS_MINUTOS = [1 / 60, 5 / 60, 10 / 60, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720];

export type Granularidade = {
  /** Passo do tick COM rótulo, em minutos. */
  maior: number;
  /** Passo do tick médio (sem rótulo). */
  medio: number;
  /** Passo do tick fino. */
  menor: number;
  /** Formato do rótulo, escolhido pela escala. */
  formato: 'HH' | 'HH:mm' | 'HH:mm:ss';
};

/**
 * Granularidade dos ticks para uma janela visível e uma largura em pixels.
 *
 * @param janelaMinutos Quantos minutos cabem na tela agora.
 * @param larguraPx     Largura da régua.
 * @param minPxPorRotulo Folga mínima entre rótulos (80px = `HH:mm` a 11px).
 */
export function escolherGranularidade(
  janelaMinutos: number,
  larguraPx: number,
  folgaBase = 80,
): Granularidade {
  const janela = Math.max(0.1, janelaMinutos);
  const largura = Math.max(1, larguraPx);
  // A folga exigida depende do TAMANHO do rótulo daquele passo: "06h" ocupa
  // bem menos que "06:35:20". Usar um número único fazia a visão de 24h pular
  // para marcações de 3h — esparso demais para mirar a hora do fato.
  const folgaDe = (passo: number) => (passo >= 60 ? folgaBase * 0.7 : passo >= 1 ? folgaBase : folgaBase * 1.2);
  const maior = PASSOS_MINUTOS.find((passo) => (largura / (janela / passo)) >= folgaDe(passo))
    ?? PASSOS_MINUTOS[PASSOS_MINUTOS.length - 1];
  const indice = PASSOS_MINUTOS.indexOf(maior);
  const medio = indice > 0 ? PASSOS_MINUTOS[indice - 1] : maior / 2;
  const menor = indice > 1 ? PASSOS_MINUTOS[indice - 2] : medio / 2;
  // O formato acompanha a escala: hora cheia em visão de dia, segundos só
  // quando o passo é menor que um minuto (senão o rótulo mente precisão).
  const formato: Granularidade['formato'] = maior >= 60 ? 'HH' : maior >= 1 ? 'HH:mm' : 'HH:mm:ss';
  return { maior, medio, menor, formato };
}

export type Tick = { minuto: number; nivel: 'maior' | 'medio' | 'menor' };

/**
 * Ticks visíveis, em horários REDONDOS (múltiplos do passo desde a meia-noite).
 *
 * Ancorar no início da janela produziria marcações em "06:37" que deslizam
 * durante o pan — o efeito de régua quebrada que o operador percebe como bug.
 */
export function gerarTicks(
  viewStart: number,
  viewEnd: number,
  granularidade: Granularidade,
  tetoDeTicks = 400,
): Tick[] {
  const ticks: Tick[] = [];
  const vistos = new Set<number>();
  const niveis: Array<['maior' | 'medio' | 'menor', number]> = [
    ['maior', granularidade.maior],
    ['medio', granularidade.medio],
    ['menor', granularidade.menor],
  ];
  for (const [nivel, passo] of niveis) {
    if (!(passo > 0)) continue;
    // Guarda de densidade: uma janela grande com passo fino geraria milhares de
    // nós de DOM e travaria o pan.
    if ((viewEnd - viewStart) / passo > tetoDeTicks) continue;
    const primeiro = Math.ceil(viewStart / passo) * passo;
    for (let m = primeiro; m <= viewEnd + 1e-9; m += passo) {
      const chave = Math.round(m * 3600); // décimos de segundo: evita duplicar por float
      if (vistos.has(chave)) continue;    // o tick maior vence o médio no mesmo ponto
      vistos.add(chave);
      ticks.push({ minuto: m, nivel });
    }
  }
  return ticks.sort((a, b) => a.minuto - b.minuto);
}

export type BucketMinimapa = {
  /** Índice do bucket (0..quantidade-1). */
  indice: number;
  /** Severidade dominante — é ela que dá a cor. */
  tipo: 'alarm' | 'motion' | 'recorded_broken' | 'recorded';
};

type SpanDoMinimapa = { start: number; end: number; type: string };

/**
 * Agrega o dia inteiro em buckets para o minimapa.
 *
 * Por bucket, e não por segmento: 12.000 gravações viram 12.000 nós de DOM e o
 * pan trava. 720 buckets (2 min cada) renderizam em menos de 2ms.
 *
 * A cor do bucket é a MAIOR severidade nele — um alarme de 3 segundos não pode
 * desaparecer sob uma hora de gravação normal. É o mesmo princípio do
 * `min-h-[0.5px]` do Frigate: no resumo do dia, o raro é o que importa.
 */
export function agregarMinimapa(
  spans: SpanDoMinimapa[],
  totalMinutos: number,
  quantidadeDeBuckets = 720,
): BucketMinimapa[] {
  const buckets = Math.max(1, Math.floor(quantidadeDeBuckets));
  const largura = totalMinutos / buckets;
  const prioridade: Record<string, number> = { recorded: 1, recorded_broken: 2, motion: 3, alarm: 4 };
  const melhor = new Map<number, { peso: number; tipo: BucketMinimapa['tipo'] }>();

  for (const span of spans) {
    const peso = prioridade[span.type];
    if (!peso) continue; // 'gap' e desconhecidos não pintam nada
    const de = Math.max(0, Math.floor(span.start / largura));
    const ate = Math.min(buckets - 1, Math.ceil(span.end / largura) - 1);
    for (let i = de; i <= ate; i += 1) {
      const atual = melhor.get(i);
      if (!atual || peso > atual.peso) melhor.set(i, { peso, tipo: span.type as BucketMinimapa['tipo'] });
    }
  }

  return [...melhor.entries()]
    .map(([indice, { tipo }]) => ({ indice, tipo }))
    .sort((a, b) => a.indice - b.indice);
}
