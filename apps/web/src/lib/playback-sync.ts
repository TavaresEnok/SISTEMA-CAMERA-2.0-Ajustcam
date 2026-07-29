// ─────────────────────────────────────────────────────────────────────────────
// SINCRONIZAÇÃO DE PLAYBACK ENTRE CÂMERAS — camada de DECISÃO, pura.
//
// Para quê: seguir uma pessoa entre ambientes exige ver N câmeras no MESMO
// instante. Sem correção, dois `<video>` que começaram juntos separam-se em
// segundos (keyframe, buffer, decode) e o operador passa a comparar momentos
// diferentes achando que são o mesmo — pior que não ter a feature.
//
// Por que `currentTime` + `playbackRate` e não um player de stream: as gravações
// são MP4 PROGRESSIVO (`-movflags +faststart`), servido por byte-range. MSE só
// aceita ISOBMFF fragmentado, então hls.js não entra aqui (o motivo medido está
// em `vod-continuous.ts`). A sincronia tem que ser feita na mão.
//
// A forma da correção é a mesma já usada no ao vivo em
// `components/LiveStreamPlayer.tsx` (creditada ao Frigate): deriva pequena é
// absorvida ACELERANDO suavemente, e só deriva grande justifica o salto seco —
// salto é visível e destrói a leitura da cena. Os limiares aqui são MUITO mais
// apertados que os do ao vivo (lá o alvo é a borda do live; aqui é casar dois
// acervos no mesmo instante de parede).
//
// Este módulo é PURO de propósito: sem React, sem rede, sem relógio próprio
// (`nowMs` entra por parâmetro). É o que permite testar a regra — a parte que
// erra silenciosamente — sem navegador. Mesma disciplina de `vod-continuous.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** Abaixo disto está sincronizado: mexer só produziria oscilação. */
export const SYNC_DEAD_BAND_SECONDS = 0.15;

/** Alvo de qualidade: acima disto o operador já percebe o descasamento. */
export const SYNC_TARGET_SECONDS = 0.5;

/**
 * Acima disto, acelerar demoraria demais (ou o seguidor está adiantado além do
 * que desacelerar resolve): corrige com salto seco.
 */
export const SYNC_HARD_SEEK_SECONDS = 2;

/** Teto do fator de correção, para cima e para baixo. */
export const SYNC_MAX_RATE_FACTOR = 1.5;
export const SYNC_MIN_RATE_FACTOR = 0.5;

/** Cadência recomendada do laço de sincronia. */
export const SYNC_CHECK_INTERVAL_MS = 100;

/**
 * Um seguidor não pode ser corrigido a cada tick: `currentTime = x` reinicia o
 * decode e um seek a 100ms de distância trava a imagem. Saltos têm carência.
 */
export const SYNC_SEEK_COOLDOWN_MS = 1200;

/** `HTMLMediaElement.readyState` mínimo para confiar em `currentTime`. */
export const SYNC_MIN_READY_STATE = 1; // HAVE_METADATA

export type SyncFollowerState = {
  /** Instante de parede (ms) que o seguidor está exibindo, ou null se indeterminado. */
  absoluteMs: number | null;
  /** `readyState` do elemento — abaixo de HAVE_METADATA nada é confiável. */
  readyState: number;
  paused: boolean;
  /** Onde o instante do mestre cai no acervo DESTE seguidor. */
  placement: 'inside' | 'gap' | 'before' | 'after';
  /** Deslocamento, em segundos, dentro do segmento atual do seguidor (quando 'inside'). */
  offsetInSegmentSeconds: number | null;
  /** true se o segmento carregado no elemento é o que cobre o instante do mestre. */
  segmentLoaded: boolean;
  /** `nowMs` do último salto aplicado neste seguidor (carência). */
  lastSeekAtMs: number | null;
};

export type SyncDecisionInput = {
  /** Instante de parede (ms) que o MESTRE está exibindo. */
  masterAbsoluteMs: number | null;
  masterPaused: boolean;
  follower: SyncFollowerState;
  /** Velocidade escolhida pelo operador (1, 2, 4...). A correção multiplica isto. */
  userSpeed: number;
  nowMs: number;
};

export type SyncAction =
  /** Nada a fazer (dentro da banda morta, ou sem informação confiável). */
  | { kind: 'none'; reason: string }
  /** Ajuste fino contínuo: `playbackRate` ABSOLUTO já multiplicado por userSpeed. */
  | { kind: 'rate'; playbackRate: number; driftSeconds: number }
  /** Correção dura: posicionar o seguidor neste offset dentro do segmento atual. */
  | { kind: 'seek'; toSeconds: number; driftSeconds: number }
  /** O seguidor está com o segmento errado carregado: quem chama deve trocá-lo. */
  | { kind: 'reselect-segment'; reason: string }
  /** Não há imagem deste seguidor no instante do mestre: congelar e rotular. */
  | { kind: 'pause'; reason: string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Decide a correção de UM seguidor em relação ao mestre.
 *
 * Convenção de sinal: `drift > 0` = o seguidor está ATRASADO (precisa acelerar);
 * `drift < 0` = está ADIANTADO (precisa desacelerar).
 */
export function decideSyncAction(input: SyncDecisionInput): SyncAction {
  const { masterAbsoluteMs, masterPaused, follower, userSpeed, nowMs } = input;

  // Sem instante do mestre não há verdade para perseguir. Corrigir "no escuro"
  // seria pior que ficar parado.
  if (masterAbsoluteMs === null) return { kind: 'none', reason: 'mestre sem posição definida' };

  // Mestre pausado: o operador está examinando um quadro. Acelerar/frear um
  // seguidor aqui mexeria na imagem que ele está lendo.
  if (masterPaused) return { kind: 'none', reason: 'mestre pausado' };

  // Fora do acervo do seguidor: NÃO buscar o segmento mais próximo. Mostrar
  // outro instante com cara de sincronizado é o pior resultado possível —
  // o operador tiraria conclusão de uma cena que não é daquele momento.
  if (follower.placement !== 'inside') {
    return { kind: 'pause', reason: `sem gravação deste seguidor no instante (${follower.placement})` };
  }

  // O elemento está com OUTRO trecho carregado: nenhum ajuste de tempo resolve,
  // quem chama precisa trocar o segmento.
  if (!follower.segmentLoaded) {
    return { kind: 'reselect-segment', reason: 'segmento carregado não cobre o instante do mestre' };
  }

  if (follower.readyState < SYNC_MIN_READY_STATE || follower.absoluteMs === null) {
    return { kind: 'none', reason: 'seguidor ainda sem metadados confiáveis' };
  }

  const driftSeconds = (masterAbsoluteMs - follower.absoluteMs) / 1000;
  const magnitude = Math.abs(driftSeconds);

  if (magnitude <= SYNC_DEAD_BAND_SECONDS) {
    // Dentro da banda morta: garante que não ficou acelerado de uma correção
    // anterior. Devolve a taxa ao valor do operador.
    return { kind: 'rate', playbackRate: userSpeed, driftSeconds };
  }

  if (magnitude > SYNC_HARD_SEEK_SECONDS) {
    // Carência: saltar a cada tick trava a imagem (cada seek reinicia o decode).
    const desde = follower.lastSeekAtMs === null ? Infinity : nowMs - follower.lastSeekAtMs;
    if (desde < SYNC_SEEK_COOLDOWN_MS) {
      return { kind: 'none', reason: 'salto em carência' };
    }
    if (follower.offsetInSegmentSeconds === null) {
      return { kind: 'reselect-segment', reason: 'sem offset conhecido para o salto' };
    }
    return {
      kind: 'seek',
      toSeconds: Math.max(0, follower.offsetInSegmentSeconds),
      driftSeconds,
    };
  }

  // Zona de ajuste fino. Curva exponencial na MESMA forma do ao vivo
  // (LiveStreamPlayer), medida a partir do alvo de qualidade: perto do alvo o
  // ajuste é imperceptível e cresce conforme a deriva se aproxima do salto.
  const excesso = Math.max(0, magnitude - SYNC_DEAD_BAND_SECONDS);
  const intensidade = 0.2 * Math.exp(0.9 * (excesso - (SYNC_TARGET_SECONDS - SYNC_DEAD_BAND_SECONDS)));
  const fatorBruto = driftSeconds > 0 ? 1 + intensidade : 1 - intensidade;
  const fator = clamp(fatorBruto, SYNC_MIN_RATE_FACTOR, SYNC_MAX_RATE_FACTOR);

  // CRÍTICO: a taxa devolvida é ABSOLUTA e já embute a velocidade do operador.
  // Devolver só o fator faria a próxima escrita zerar o 2×/4× escolhido por ele.
  return { kind: 'rate', playbackRate: userSpeed * fator, driftSeconds };
}

/**
 * Vale a pena escrever esta taxa no elemento? Escrever `playbackRate` a cada
 * 100ms provoca microengasgo no decode; só mexe quando muda de verdade.
 */
export function shouldApplyRate(current: number, next: number): boolean {
  return Math.abs(current - next) > 0.02;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUÇÃO DO ALVO DE UM SEGUIDOR.
//
// Cada câmera tem o SEU acervo, com as próprias fronteiras de arquivo e os
// próprios buracos. "Instante X" vira arquivo+offset diferente em cada uma. Esta
// função faz essa tradução e é a peça que decide se o seguidor tem imagem
// naquele instante — decidir errado aqui é mostrar a cena errada com cara de
// sincronizada, que é o pior resultado possível desta feature.
//
// Mantida PURA (recebe playlist e instante, devolve descrição) justamente
// porque é a parte que erra em silêncio: um componente React não seria
// testável sem navegador, isto é.
// ─────────────────────────────────────────────────────────────────────────────

export type FollowerTarget =
  /** Há imagem: este é o segmento e o ponto dentro dele. */
  | {
    status: 'ready';
    recordingId: string;
    segmentIndex: number;
    /** Offset dentro do ARQUIVO (é o que vai em `video.currentTime`). */
    offsetInSegmentSeconds: number;
    /** Posição na linha contínua do dia (para converter de volta a instante). */
    positionSeconds: number;
  }
  /** O instante existe no dia, mas esta câmera não tem gravação nele. */
  | { status: 'gap' }
  /** O instante está antes/depois de tudo que esta câmera tem. */
  | { status: 'outside'; placement: 'before' | 'after' }
  /** Sem playlist utilizável (ainda carregando, dia sem gravação, erro). */
  | { status: 'unavailable' };

type MinimalPlaylist = {
  segments: ReadonlyArray<{ recordingId: string }>;
} | null;

/** Espelha `VodPosition` de `vod-continuous.ts` — aquele módulo é a autoridade
 *  sobre a linha do tempo contínua; aqui só se consome o resultado dele. */
type MinimalPosition = {
  placement: 'inside' | 'gap' | 'before' | 'after';
  seconds: number;
  segmentIndex: number;
  offsetInSegmentSeconds: number;
} | null;

/**
 * Traduz um instante absoluto para o alvo desta câmera.
 *
 * Recebe a posição JÁ calculada por `absoluteToVodPosition` (de
 * `vod-continuous.ts`) em vez de recalcular: aquele módulo já é a autoridade
 * sobre a linha do tempo contínua e já é testado. Aqui só se decide o que fazer
 * com o resultado.
 */
export function resolveFollowerTarget(
  playlist: MinimalPlaylist,
  position: MinimalPosition,
): FollowerTarget {
  if (!playlist || !playlist.segments.length) return { status: 'unavailable' };
  if (!position) return { status: 'unavailable' };

  if (position.placement === 'gap') return { status: 'gap' };
  if (position.placement === 'before' || position.placement === 'after') {
    return { status: 'outside', placement: position.placement };
  }

  const segment = playlist.segments[position.segmentIndex];
  // Índice fora da lista é inconsistência entre playlist e posição: tratar como
  // indisponível é melhor que indexar undefined e reproduzir qualquer coisa.
  if (!segment) return { status: 'unavailable' };

  return {
    status: 'ready',
    recordingId: segment.recordingId,
    segmentIndex: position.segmentIndex,
    offsetInSegmentSeconds: Math.max(0, position.offsetInSegmentSeconds),
    positionSeconds: position.seconds,
  };
}

/**
 * O elemento precisa TROCAR de arquivo para atender este alvo?
 *
 * Comparar por `recordingId` (e não pela URL) é deliberado: a URL muda sozinha
 * quando o token é renovado, e trocar o `src` por causa disso remontaria o vídeo
 * e piscaria a imagem sem necessidade.
 */
export function needsSourceChange(
  loadedRecordingId: string | null,
  target: FollowerTarget,
): boolean {
  if (target.status !== 'ready') return false;
  return loadedRecordingId !== target.recordingId;
}

/** Rótulo curto para a célula quando não há imagem — o operador precisa saber POR QUE. */
export function followerStatusLabel(target: FollowerTarget): string | null {
  switch (target.status) {
    case 'ready':
      return null;
    case 'gap':
      return 'Sem gravação neste instante';
    case 'outside':
      return target.placement === 'before'
        ? 'Antes da primeira gravação'
        : 'Depois da última gravação';
    case 'unavailable':
    default:
      return 'Sem playlist para este dia';
  }
}
