// ── OS CONTROLES SOMEM QUANDO NINGUÉM ESTÁ MEXENDO ──────────────────────────
//
// O modo mural é feito para ficar numa TV, horas a fio. Dois elementos ficavam
// permanentemente por cima da imagem: o selo "Ao Vivo / Modo Mural" e o botão
// "Sair do Modo Mural". Numa sala de operação isso é ruído fixo em cima de
// vídeo — e em tela de plasma/OLED, imagem parada em cima de imagem parada é
// retenção de tela.
//
// A regra é a dos players de vídeo: sumir depois de um tempo sem interação,
// voltar ao primeiro movimento.
//
// Esta função existe separada do React porque a parte que erra não é o JSX — é
// a máquina de estados. Os casos que precisam estar certos:
//
//   · sumir NUNCA pode prender o operador. Aqui não prende: Esc já sai do
//     mural, e qualquer movimento traz o botão de volta;
//   · quem chegou pelo TECLADO (Tab) precisa enxergar o que focou, senão o
//     foco fica invisível e a tela vira armadilha para quem não usa mouse;
//   · com o ponteiro EM CIMA do controle, ele não pode sumir debaixo do dedo
//     no instante do clique;
//   · em tela de toque não existe "mover o mouse". Se o único gatilho fosse
//     movimento, o controle sumiria e não voltaria nunca.

export interface EstadoControles {
  /** Se os controles devem estar visíveis agora. */
  visivel: boolean;
  /** Quando o temporizador deve disparar de novo (ms), ou null se não há prazo. */
  proximoPrazoMs: number | null;
}

export interface EntradaControles {
  /** Houve interação (movimento, toque, tecla) neste instante? */
  interagiuAgora: boolean;
  /** O ponteiro está sobre um dos controles? */
  ponteiroSobreControle: boolean;
  /** O foco do teclado está dentro de um dos controles? */
  focoNosControles: boolean;
  /** Milissegundos desde a última interação. */
  msDesdeInteracao: number;
  /** Prazo configurado. */
  atrasoMs: number;
}

/**
 * Decide se os controles aparecem, e quando reavaliar.
 *
 * Pura de propósito: recebe fatos, devolve decisão. Sem timers, sem DOM, sem
 * React — dá para testar cada caso sem simular navegador.
 */
export function decidirControles(e: EntradaControles): EstadoControles {
  // Foco de teclado MANDA em tudo. Esconder o que a pessoa acabou de focar com
  // Tab deixa o foco invisível: ela não sabe mais onde está na tela.
  if (e.focoNosControles) return { visivel: true, proximoPrazoMs: null };

  // Ponteiro em cima: sumir agora tiraria o botão debaixo do clique em curso.
  if (e.ponteiroSobreControle) return { visivel: true, proximoPrazoMs: null };

  if (e.interagiuAgora) return { visivel: true, proximoPrazoMs: e.atrasoMs };

  const restante = e.atrasoMs - e.msDesdeInteracao;
  if (restante > 0) return { visivel: true, proximoPrazoMs: restante };

  return { visivel: false, proximoPrazoMs: null };
}

/**
 * Eventos que contam como "alguém está aí".
 *
 * `pointermove` cobre mouse e caneta; `pointerdown` e `touchstart` cobrem tela
 * de toque, onde não existe movimento sem contato — sem eles o controle sumiria
 * no tablet e não voltaria mais. `keydown` cobre quem opera pelo teclado.
 *
 * `scroll` está de fora de propósito: o mural não rola, e em tela cheia um
 * scroll fantasma de trackpad traria os controles de volta sozinho.
 */
export const EVENTOS_DE_PRESENCA = [
  'pointermove',
  'pointerdown',
  'touchstart',
  'keydown',
] as const;

/** Prazo padrão. Três segundos é o que o operador pediu, e o que os players usam. */
export const ATRASO_PADRAO_MS = 3000;
