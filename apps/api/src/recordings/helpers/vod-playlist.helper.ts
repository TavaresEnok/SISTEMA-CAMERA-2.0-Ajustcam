// ─────────────────────────────────────────────────────────────────────────────
// VOD CONTÍNUO — playlist HLS (M3U8, tipo VOD) cobrindo um INTERVALO arbitrário.
//
// PROBLEMA: a gravação nasce fatiada em ARQUIVOS (um MP4 por segmento). O
// playback atual troca de arquivo — nova URL, novo token, player recarrega — a
// cada troca de segmento: a "engasgada" ao rever. Uma playlist VOD lista os N
// segmentos de uma vez e o player vê UM vídeo contínuo, com seek livre.
//
// Este módulo é 100% PURO (nada de I/O, nada de token, nada de Prisma): recebe
// os segmentos e o intervalo pedido e devolve (a) o PLANO da playlist (quais
// segmentos, em que ordem, com que duração/offset e onde a linha do tempo
// quebra) e (b) o TEXTO M3U8, com a construção da URL injetada. Assim a lógica
// crítica é determinística e testável sem subir nada.
//
// REGRAS DE RECORTE (importantes para o seek funcionar):
//  * um segmento entra se ele SOBREPÕE o intervalo — quem apenas cruza a borda
//    entra INTEIRO (nunca cortamos arquivo; o player busca dentro dele);
//  * quem só encosta na borda (termina exatamente em `from` ou começa exatamente
//    em `to`) NÃO entra: não há conteúdo pedido lá dentro;
//  * `startOffsetSeconds` diz quantos segundos DEPOIS do início da playlist está
//    o instante pedido — é o seek inicial que o front aplica.
//
// DISCONTINUITY: `#EXT-X-DISCONTINUITY` é a tag que avisa o player "a partir
// daqui a linha do tempo/codificação muda, reinicialize o decoder". Emitimos em
// GAP (buraco entre o fim de um segmento e o começo do próximo), em OVERLAP
// (sobreposição) e em TROCA DE CODEC quando essa informação estiver disponível.
// Emitir a menos → player trava/pula no buraco. Emitir à toa → engasgo extra.
// ─────────────────────────────────────────────────────────────────────────────

export interface VodSourceSegment {
  /** Id da gravação (Recording.id) — vira a URL do segmento. */
  id: string;
  startedAt: Date | string | number;
  /** Fim real; quando ausente caímos em `durationSeconds`. */
  endedAt?: Date | string | number | null;
  durationSeconds?: number | null;
  /** Codec de vídeo, quando conhecido (ex.: 'h264', 'hevc'). Opcional. */
  codec?: string | null;
}

export type VodDiscontinuityReason = 'gap' | 'overlap' | 'codec';

export interface VodPlaylistSegment {
  recordingId: string;
  /** Instante real (ISO) do início do segmento — vira PROGRAM-DATE-TIME. */
  startedAt: string;
  endedAt: string;
  /** Duração real do segmento, em segundos (precisão de ms). */
  durationSeconds: number;
  /** Início do segmento na linha do tempo DA PLAYLIST (acumulado). */
  offsetSeconds: number;
  /** true quando um `#EXT-X-DISCONTINUITY` precede este segmento. */
  discontinuity: boolean;
  discontinuityReason: VodDiscontinuityReason | null;
  codec: string | null;
}

export interface VodPlaylistPlan {
  from: string;
  to: string;
  segments: VodPlaylistSegment[];
  /** Teto arredondado da MAIOR duração (nunca menor que 1). */
  targetDurationSeconds: number;
  totalDurationSeconds: number;
  /** Offset do início pedido DENTRO da playlist (i.e., dentro do 1º segmento). */
  startOffsetSeconds: number;
  discontinuities: number;
  /** Segmentos descartados por não ter duração utilizável. */
  skipped: number;
  /** true quando o corte por `maxSegments` deixou conteúdo de fora. */
  truncated: boolean;
  coverage: { startedAt: string | null; endedAt: string | null };
}

export interface PlanVodPlaylistInput {
  segments: VodSourceSegment[];
  from: Date | string | number;
  to: Date | string | number;
  /**
   * Folga (s) para considerar dois segmentos contíguos. O segmentador do FFmpeg
   * fecha/abre com diferença de milissegundos; sem tolerância toda troca de
   * arquivo viraria uma DISCONTINUITY inútil.
   */
  gapToleranceSeconds?: number;
  /** Teto de segmentos na playlist (protege contra playlist gigante). */
  maxSegments?: number;
}

const DEFAULT_GAP_TOLERANCE_SECONDS = 1;
const DEFAULT_MAX_SEGMENTS = 720;

function toMs(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Segundos com precisão de milissegundo (evita 299.9999999 no EXTINF). */
function roundSeconds(ms: number): number {
  return Math.round(ms) / 1000;
}

function normalizeCodec(codec: string | null | undefined): string | null {
  const clean = String(codec ?? '').trim().toLowerCase();
  return clean ? clean : null;
}

/**
 * Monta o PLANO da playlist VOD para o intervalo pedido.
 *
 * Não faz I/O: quem chama já filtrou o que existe no disco. Segmentos sem
 * duração conhecida (sem `endedAt` e sem `durationSeconds`) são DESCARTADOS —
 * um `#EXTINF` mentiroso desalinha todo o resto da linha do tempo.
 */
export function planVodPlaylist(input: PlanVodPlaylistInput): VodPlaylistPlan {
  const fromMs = toMs(input.from);
  const toMsValue = toMs(input.to);
  if (fromMs === null || toMsValue === null) {
    throw new TypeError('Intervalo inválido para a playlist VOD.');
  }
  const toleranceMs = Math.max(0, (input.gapToleranceSeconds ?? DEFAULT_GAP_TOLERANCE_SECONDS) * 1000);
  const maxSegments = Math.max(1, Math.floor(input.maxSegments ?? DEFAULT_MAX_SEGMENTS));

  let skipped = 0;
  const candidates: Array<{ id: string; startMs: number; endMs: number; codec: string | null }> = [];

  for (const raw of input.segments ?? []) {
    const startMs = toMs(raw.startedAt);
    if (startMs === null) continue;
    const endFromEnded = toMs(raw.endedAt);
    const durationSeconds = Number(raw.durationSeconds);
    const endMs =
      endFromEnded !== null && endFromEnded > startMs
        ? endFromEnded
        : Number.isFinite(durationSeconds) && durationSeconds > 0
          ? startMs + durationSeconds * 1000
          : null;
    if (endMs === null) {
      // Sem duração utilizável: só conta como descartado se era candidato do intervalo.
      if (startMs < toMsValue) skipped += 1;
      continue;
    }
    // Sobreposição com o intervalo: quem apenas ENCOSTA na borda fica de fora.
    if (endMs <= fromMs || startMs >= toMsValue) continue;
    candidates.push({ id: raw.id, startMs, endMs, codec: normalizeCodec(raw.codec) });
  }

  candidates.sort((a, b) => (a.startMs - b.startMs) || a.id.localeCompare(b.id));
  const truncated = candidates.length > maxSegments;
  const selected = truncated ? candidates.slice(0, maxSegments) : candidates;

  const segments: VodPlaylistSegment[] = [];
  let cursorMs = 0;
  let discontinuities = 0;
  let maxDurationSeconds = 0;

  for (let index = 0; index < selected.length; index += 1) {
    const current = selected[index];
    const previous = index > 0 ? selected[index - 1] : null;
    let reason: VodDiscontinuityReason | null = null;
    if (previous) {
      const deltaMs = current.startMs - previous.endMs;
      if (deltaMs > toleranceMs) reason = 'gap';
      else if (deltaMs < -toleranceMs) reason = 'overlap';
      else if (previous.codec && current.codec && previous.codec !== current.codec) reason = 'codec';
    }
    if (reason) discontinuities += 1;

    const durationSeconds = roundSeconds(current.endMs - current.startMs);
    if (durationSeconds > maxDurationSeconds) maxDurationSeconds = durationSeconds;

    segments.push({
      recordingId: current.id,
      startedAt: new Date(current.startMs).toISOString(),
      endedAt: new Date(current.endMs).toISOString(),
      durationSeconds,
      offsetSeconds: roundSeconds(cursorMs),
      discontinuity: Boolean(reason),
      discontinuityReason: reason,
      codec: current.codec,
    });
    cursorMs += current.endMs - current.startMs;
  }

  const first = selected[0] ?? null;
  const last = selected[selected.length - 1] ?? null;
  // O instante pedido pode cair NO MEIO do primeiro segmento (ele cruza a borda):
  // o front precisa buscar essa quantidade de segundos para começar onde pediu.
  const startOffsetSeconds = first ? Math.max(0, roundSeconds(Math.min(fromMs, first.endMs) - first.startMs)) : 0;

  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMsValue).toISOString(),
    segments,
    targetDurationSeconds: Math.max(1, Math.ceil(maxDurationSeconds)),
    totalDurationSeconds: roundSeconds(cursorMs),
    startOffsetSeconds,
    discontinuities,
    skipped,
    truncated,
    coverage: {
      startedAt: first ? new Date(first.startMs).toISOString() : null,
      endedAt: last ? new Date(last.endMs).toISOString() : null,
    },
  };
}

export interface RenderVodPlaylistOptions {
  /** Emite `#EXT-X-PROGRAM-DATE-TIME` (mapeia playback → relógio real). Padrão: true. */
  includeProgramDateTime?: boolean;
}

/**
 * Serializa o plano em M3U8. A URL de cada segmento é injetada por
 * `buildSegmentUrl` — assim o helper continua puro (nada de token aqui dentro).
 *
 * A linha `#DRAC-START-OFFSET:` é um COMENTÁRIO (não começa com `#EXT`): a RFC
 * 8216 manda o player ignorar; serve só para diagnóstico de quem lê a playlist.
 */
export function renderVodPlaylist(
  plan: VodPlaylistPlan,
  buildSegmentUrl: (segment: VodPlaylistSegment) => string,
  options?: RenderVodPlaylistOptions,
): string {
  const includePdt = options?.includeProgramDateTime !== false;
  // LIMITAÇÃO CONHECIDA E ACEITA: HLS estrito só admite MP4 como segmento na
  // forma fMP4 (EXT-X-MAP + VERSION >= 6); MP4 progressivo é fora de spec. O
  // web NÃO passa por aqui (consome format=json e troca <video> por conta
  // própria) e o VLC/ffmpeg funciona pelo alias .mp4 na URL. Migrar para fMP4
  // exigiria refragmentar cada segmento — custo real para servir um caso
  // (players HLS externos) que hoje ninguém usa. Se um dia usar, é aqui.
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${plan.targetDurationSeconds}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#DRAC-START-OFFSET:${plan.startOffsetSeconds}`,
  ];

  for (const segment of plan.segments) {
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (includePdt) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${segment.startedAt}`);
    lines.push(`#EXTINF:${segment.durationSeconds.toFixed(3)},`);
    lines.push(buildSegmentUrl(segment));
  }

  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}
