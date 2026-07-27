// ─────────────────────────────────────────────────────────────────────────────
// VOD CONTÍNUO (front) — a playlist de GET /recordings/vod.m3u8?format=json
// vista como UMA linha do tempo, e não como N arquivos soltos.
//
// PROBLEMA QUE ISTO RESOLVE: hoje o /playback troca de ARQUIVO a cada gravação —
// novo token (POST /recordings/:id/play-token), nova URL, <video> remontado — e
// o resultado é a "engasgada" ao rever. A playlist já traz, de uma vez só, a
// ordem dos segmentos, a duração real de cada um, o offset acumulado e um token
// de playback por segmento. Com ela o front sabe, sem ida ao servidor, QUAL
// arquivo tocar em QUALQUER instante do dia e qual é o PRÓXIMO (para aquecê-lo
// antes da virada).
//
// LIMITE REAL, MEDIDO (não é preguiça — está aqui para ninguém tentar "melhorar"
// isto sem mexer no backend): as gravações são MP4 PROGRESSIVO (ftyp/moov/free/
// mdat, gravadas com `-movflags +faststart`). O hls.js só demuxa segmento MP4
// FRAGMENTADO — `MP4Demuxer.probe()` é literalmente `hasMoofData(data)` — e o
// MSE só aceita ISOBMFF fragmentado. Ou seja: entregar essa mesma playlist ao
// hls.js falha no PRIMEIRO fragmento, em qualquer navegador. Enquanto o pipeline
// de gravação não emitir fMP4 (+ EXT-X-MAP na playlist), a continuidade no
// navegador tem de ser feita por PRÉ-CARGA do próximo arquivo e TROCA de
// elemento — que é exatamente o que estas funções alimentam. (Em players
// baseados em ffmpeg/VLC a playlist toca direto; por isso o endpoint existe.)
//
// Tudo aqui é PURO: sem React, sem rede, sem Date.now() escondido — o instante
// entra por parâmetro. Assim a decisão crítica (quando renovar o token, onde
// está o instante X, quando desistir) é determinística e testável
// (tests/vod-continuous.test.mts).
// ─────────────────────────────────────────────────────────────────────────────

/** TTL do token de playback quando não dá para ler o `exp` do JWT (auth.service: '5m'). */
export const DEFAULT_PLAY_TOKEN_TTL_SECONDS = 300;
/** Folga padrão: renova a playlist a 1 min do vencimento do token. */
export const DEFAULT_RENEW_LEAD_SECONDS = 60;
/** Nunca renova mais de uma vez neste intervalo (evita laço quente com token curto). */
export const MIN_RENEW_INTERVAL_SECONDS = 15;
/** Segundos antes do fim do segmento em que vale a pena aquecer o próximo arquivo. */
export const DEFAULT_PREFETCH_LEAD_SECONDS = 25;

export interface VodPlaylistSegment {
  recordingId: string;
  /** Instante real do início (PROGRAM-DATE-TIME do M3U8), em ms. */
  startedAtMs: number;
  /** startedAtMs + duração: o fim usado pela linha do tempo. */
  endedAtMs: number;
  durationSeconds: number;
  /** Início do segmento DENTRO da playlist (acumulado, recalculado aqui). */
  offsetSeconds: number;
  /** O backend marcou #EXT-X-DISCONTINUITY antes deste segmento. */
  discontinuity: boolean;
  /** Caminho relativo do arquivo, já com o token de playback. */
  playUrl: string;
  /** Token extraído da playUrl (para renovar a URL sem refazer a playlist). */
  token: string | null;
}

export interface VodPlaylist {
  cameraId: string;
  fromMs: number;
  toMs: number;
  segments: VodPlaylistSegment[];
  totalDurationSeconds: number;
  /** Onde o instante pedido cai dentro da playlist (seek inicial do backend). */
  startOffsetSeconds: number;
  truncated: boolean;
  /** Quando ESTA playlist chegou (base do agendamento de renovação). */
  fetchedAtMs: number;
  /** Menor `exp` entre os tokens dos segmentos; null quando ilegível. */
  tokenExpiresAtMs: number | null;
}

function toMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Segundos com precisão de ms (mesma regra do helper do backend). */
function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function readTokenFromUrl(url: string): string | null {
  const match = /[?&]token=([^&#]*)/.exec(url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return match[1] || null;
  }
}

/**
 * Lê o `exp` do JWT SEM validar assinatura — serve só para AGENDAR a renovação
 * (quem valida é o backend). Qualquer lixo devolve null e o chamador cai no TTL
 * padrão; nada aqui pode lançar.
 */
export function decodeJwtExpiryMs(token: string | null | undefined): number | null {
  const raw = String(token ?? '');
  const parts = raw.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    if (typeof atob !== 'function') return null;
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * O token da playlist ainda dá tempo de carregar o segmento? A playlist cobre
 * horas, o token dura minutos: se o que temos em mãos está por vencer (ou nem é
 * um JWT legível), NÃO arriscamos um 401 no meio do playback — o chamador emite
 * um token novo pelo caminho de sempre.
 */
export function isPlaybackTokenUsable(
  token: string | null | undefined,
  nowMs: number,
  minRemainingSeconds = 20,
): boolean {
  if (!token) return false;
  const expiresAtMs = decodeJwtExpiryMs(token);
  if (expiresAtMs === null) return false;
  return expiresAtMs - nowMs > Math.max(0, minRemainingSeconds) * 1000;
}

interface RawVodSegment {
  recordingId?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  durationSeconds?: unknown;
  discontinuity?: unknown;
  playUrl?: unknown;
}

/**
 * Converte a resposta do endpoint na linha do tempo que o player usa — ou
 * devolve `null`, que é o SINAL DE FALLBACK: sem playlist utilizável, o
 * /playback continua exatamente como antes (arquivo por arquivo).
 *
 * Segmento sem id, sem URL, sem instante de início ou sem duração positiva é
 * DESCARTADO (um EXTINF mentiroso desalinharia todo o resto). Os offsets são
 * RECALCULADOS a partir das durações, na ordem do relógio: é a mesma conta do
 * backend (`cursor += duração`) e deixa o front consistente mesmo se a resposta
 * vier fora de ordem.
 */
export function normalizeVodPlaylist(raw: unknown, fetchedAtMs: number): VodPlaylist | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as { segments?: unknown; cameraId?: unknown; from?: unknown; to?: unknown; startOffsetSeconds?: unknown; truncated?: unknown };
  if (!Array.isArray(source.segments)) return null;

  const parsed: Array<Omit<VodPlaylistSegment, 'offsetSeconds'>> = [];
  for (const item of source.segments as RawVodSegment[]) {
    if (!item || typeof item !== 'object') continue;
    const recordingId = typeof item.recordingId === 'string' ? item.recordingId.trim() : '';
    const playUrl = typeof item.playUrl === 'string' ? item.playUrl.trim() : '';
    if (!recordingId || !playUrl) continue;
    const startedAtMs = toMs(item.startedAt);
    if (startedAtMs === null) continue;
    const endedAtMs = toMs(item.endedAt);
    const declaredDuration = Number(item.durationSeconds);
    const durationSeconds = Number.isFinite(declaredDuration) && declaredDuration > 0
      ? declaredDuration
      : endedAtMs !== null && endedAtMs > startedAtMs
        ? (endedAtMs - startedAtMs) / 1000
        : 0;
    if (!(durationSeconds > 0)) continue;
    parsed.push({
      recordingId,
      startedAtMs,
      endedAtMs: startedAtMs + durationSeconds * 1000,
      durationSeconds: roundSeconds(durationSeconds),
      discontinuity: Boolean(item.discontinuity),
      playUrl,
      token: readTokenFromUrl(playUrl),
    });
  }
  if (!parsed.length) return null;

  parsed.sort((a, b) => (a.startedAtMs - b.startedAtMs) || a.recordingId.localeCompare(b.recordingId));

  const segments: VodPlaylistSegment[] = [];
  let cursorSeconds = 0;
  let tokenExpiresAtMs: number | null = null;
  for (const item of parsed) {
    segments.push({ ...item, offsetSeconds: roundSeconds(cursorSeconds) });
    cursorSeconds += item.durationSeconds;
    const expiry = decodeJwtExpiryMs(item.token);
    if (expiry !== null && (tokenExpiresAtMs === null || expiry < tokenExpiresAtMs)) {
      tokenExpiresAtMs = expiry;
    }
  }

  const totalDurationSeconds = roundSeconds(cursorSeconds);
  const declaredStartOffset = Number(source.startOffsetSeconds);
  const startOffsetSeconds = Number.isFinite(declaredStartOffset) && declaredStartOffset > 0
    ? Math.min(declaredStartOffset, totalDurationSeconds)
    : 0;

  return {
    cameraId: typeof source.cameraId === 'string' ? source.cameraId : '',
    fromMs: toMs(source.from) ?? segments[0].startedAtMs,
    toMs: toMs(source.to) ?? segments[segments.length - 1].endedAtMs,
    segments,
    totalDurationSeconds,
    startOffsetSeconds,
    truncated: Boolean(source.truncated),
    fetchedAtMs,
    tokenExpiresAtMs,
  };
}

/** Token de playback por gravação — o mapa que renova as URLs em voo. */
export function segmentTokens(playlist: VodPlaylist | null): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const segment of playlist?.segments ?? []) {
    if (segment.token) tokens[segment.recordingId] = segment.token;
  }
  return tokens;
}

const RECORDING_URL_PATTERN = /\/recordings\/([^/?#]+)\/play(?:\.mp4)?(?:[?#]|$)/;

/** Id da gravação embutido numa URL de segmento (`/recordings/:id/play[.mp4]`). */
export function recordingIdFromSegmentUrl(url: string): string | null {
  const match = RECORDING_URL_PATTERN.exec(String(url ?? ''));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return match[1] || null;
  }
}

/**
 * Troca o token de uma URL de segmento pelo token FRESCO da playlist renovada,
 * preservando todo o resto (compatible/forceDirect/ordem dos parâmetros). Sem
 * token novo para aquela gravação, devolve a URL intacta: renovação nunca pode
 * ser motivo para um pedido deixar de sair.
 */
export function refreshSegmentUrl(url: string, tokensByRecordingId: Record<string, string>): string {
  const original = String(url ?? '');
  const recordingId = recordingIdFromSegmentUrl(original);
  if (!recordingId) return original;
  const token = tokensByRecordingId?.[recordingId];
  if (!token) return original;
  const encoded = encodeURIComponent(token);
  if (/[?&]token=/.test(original)) {
    return original.replace(/([?&])token=[^&#]*/, `$1token=${encoded}`);
  }
  return `${original}${original.includes('?') ? '&' : '?'}token=${encoded}`;
}

export type VodPlacement = 'inside' | 'gap' | 'before' | 'after';

export interface VodPosition {
  /** Posição na linha do tempo CONTÍNUA da playlist. */
  seconds: number;
  placement: VodPlacement;
  segment: VodPlaylistSegment | null;
  segmentIndex: number;
  /** Deslocamento DENTRO do arquivo (o que vai no video.currentTime). */
  offsetInSegmentSeconds: number;
}

/**
 * Instante absoluto → posição contínua. Instante em um BURACO (o dia tem
 * períodos sem gravação) devolve o COMEÇO do próximo segmento: é o que o
 * operador espera ao clicar num trecho vazio da timeline — a reprodução retoma
 * no próximo conteúdo, não fica num limbo sem vídeo.
 */
export function absoluteToVodPosition(playlist: VodPlaylist | null, instant: Date | string | number): VodPosition | null {
  if (!playlist?.segments.length) return null;
  const ms = toMs(instant);
  if (ms === null) return null;

  const segments = playlist.segments;
  const first = segments[0];
  if (ms < first.startedAtMs) {
    return { seconds: 0, placement: 'before', segment: first, segmentIndex: 0, offsetInSegmentSeconds: 0 };
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (ms < segment.startedAtMs) {
      return {
        seconds: segment.offsetSeconds,
        placement: 'gap',
        segment,
        segmentIndex: index,
        offsetInSegmentSeconds: 0,
      };
    }
    if (ms < segment.endedAtMs) {
      const offsetInSegmentSeconds = roundSeconds((ms - segment.startedAtMs) / 1000);
      return {
        seconds: roundSeconds(segment.offsetSeconds + offsetInSegmentSeconds),
        placement: 'inside',
        segment,
        segmentIndex: index,
        offsetInSegmentSeconds,
      };
    }
  }
  const last = segments[segments.length - 1];
  return {
    seconds: playlist.totalDurationSeconds,
    placement: 'after',
    segment: last,
    segmentIndex: segments.length - 1,
    offsetInSegmentSeconds: last.durationSeconds,
  };
}

export interface VodSegmentLocation {
  segment: VodPlaylistSegment;
  index: number;
  offsetInSegmentSeconds: number;
}

/** Posição contínua → (arquivo, deslocamento dentro dele). Sempre dentro da playlist. */
export function locateVodSegment(playlist: VodPlaylist | null, positionSeconds: number): VodSegmentLocation | null {
  if (!playlist?.segments.length) return null;
  const segments = playlist.segments;
  const raw = Number(positionSeconds);
  const position = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), playlist.totalDurationSeconds) : 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (position < segment.offsetSeconds + segment.durationSeconds) {
      return {
        segment,
        index,
        offsetInSegmentSeconds: roundSeconds(Math.max(0, position - segment.offsetSeconds)),
      };
    }
  }
  const last = segments[segments.length - 1];
  return { segment: last, index: segments.length - 1, offsetInSegmentSeconds: last.durationSeconds };
}

/** Posição contínua → instante absoluto (ms). */
export function vodPositionToAbsoluteMs(playlist: VodPlaylist | null, positionSeconds: number): number | null {
  const located = locateVodSegment(playlist, positionSeconds);
  if (!located) return null;
  return located.segment.startedAtMs + located.offsetInSegmentSeconds * 1000;
}

export function nextVodSegment(playlist: VodPlaylist | null, index: number): VodPlaylistSegment | null {
  const segments = playlist?.segments ?? [];
  const next = segments[index + 1];
  return next ?? null;
}

export interface InitialSeekInput {
  playlist: VodPlaylist | null;
  /** Valor cru do `?at=` (link vindo da Revisão/alarmes). */
  at?: string | number | Date | null;
}

/**
 * Seek inicial: o `?at=` manda; sem ele (ou com valor impossível) vale o
 * `startOffsetSeconds` que o backend calculou para o intervalo pedido.
 */
export function resolveInitialSeekSeconds({ playlist, at }: InitialSeekInput): number {
  if (!playlist) return 0;
  if (at !== null && at !== undefined && at !== '') {
    const position = absoluteToVodPosition(playlist, at);
    if (position) return position.seconds;
  }
  return playlist.startOffsetSeconds;
}

export interface VodRenewalState {
  /** Quando a playlist em uso chegou. */
  fetchedAtMs: number;
  /** `exp` real dos tokens; null → cai no TTL padrão. */
  tokenExpiresAtMs?: number | null;
  tokenTtlSeconds?: number;
  renewLeadSeconds?: number;
  /** Última tentativa (sucesso OU falha): governa o backoff. */
  lastAttemptAtMs?: number | null;
  inFlight?: boolean;
  consecutiveFailures?: number;
  maxFailures?: number;
  retryDelaySeconds?: number;
  documentVisible?: boolean;
  playing?: boolean;
}

/** Instante a partir do qual vale a pena rebuscar a playlist. */
export function vodRenewalDueAtMs(state: VodRenewalState): number {
  const ttlSeconds = state.tokenTtlSeconds ?? DEFAULT_PLAY_TOKEN_TTL_SECONDS;
  const leadSeconds = state.renewLeadSeconds ?? DEFAULT_RENEW_LEAD_SECONDS;
  const expiresAtMs = state.tokenExpiresAtMs ?? state.fetchedAtMs + ttlSeconds * 1000;
  // Renova ANTES de expirar: a playlist cobre horas, o token dura minutos.
  const dueAtMs = expiresAtMs - leadSeconds * 1000;
  const floorMs = state.fetchedAtMs + MIN_RENEW_INTERVAL_SECONDS * 1000;
  let due = Math.max(dueAtMs, floorMs);

  const failures = Math.max(0, Number(state.consecutiveFailures ?? 0));
  if (failures > 0) {
    const retryDelayMs = (state.retryDelaySeconds ?? 20) * 1000 * failures;
    const lastAttemptAtMs = state.lastAttemptAtMs ?? state.fetchedAtMs;
    due = Math.max(due, lastAttemptAtMs + retryDelayMs);
  }
  return due;
}

/**
 * Renovar é rebuscar a MESMA playlist (endpoint idempotente e barato) só para
 * trocar os tokens, sem tocar na reprodução. Não renova: com pedido em voo, com
 * a aba escondida e o vídeo parado (não gasta rede à toa), ou depois de falhar
 * `maxFailures` vezes — aí o chamador desiste do modo contínuo e volta ao
 * caminho antigo em vez de martelar o servidor.
 */
export function shouldRenewPlaylist(state: VodRenewalState, nowMs: number): boolean {
  if (!state || !Number.isFinite(state.fetchedAtMs)) return false;
  if (state.inFlight) return false;
  const failures = Math.max(0, Number(state.consecutiveFailures ?? 0));
  const maxFailures = Math.max(1, Number(state.maxFailures ?? 3));
  if (failures >= maxFailures) return false;
  const visible = state.documentVisible ?? true;
  if (!visible && !state.playing) return false;
  return nowMs >= vodRenewalDueAtMs(state);
}

/**
 * Qual arquivo aquecer (pré-carregar no elemento escondido) — só quando a virada
 * está perto. Aquecer cedo demais desperdiça banda quando o operador fica
 * pulando pela timeline; tarde demais não elimina a engasgada.
 */
export function shouldPrefetchNextSegment(
  playlist: VodPlaylist | null,
  positionSeconds: number,
  leadSeconds: number = DEFAULT_PREFETCH_LEAD_SECONDS,
): VodPlaylistSegment | null {
  const located = locateVodSegment(playlist, positionSeconds);
  if (!located) return null;
  const next = nextVodSegment(playlist, located.index);
  if (!next) return null;
  const remaining = located.segment.durationSeconds - located.offsetInSegmentSeconds;
  if (remaining > Math.max(0, leadSeconds)) return null;
  return next;
}

export interface StalledSwapState {
  /** Quando a troca para o elemento pré-carregado começou; null = sem troca. */
  swapStartedAtMs: number | null;
  /** Último sinal de progresso (timeupdate) DEPOIS da troca. */
  lastProgressAtMs?: number | null;
  timeoutMs?: number;
}

/**
 * Rede de segurança do modo contínuo: se a troca de elemento não produzir
 * progresso a tempo, o playback está travado — pior que o comportamento antigo.
 * Nesse caso o chamador abandona o modo contínuo e recarrega pelo caminho de
 * sempre. Na dúvida, fallback.
 */
export function shouldAbortStalledSwap(state: StalledSwapState, nowMs: number): boolean {
  const startedAtMs = state?.swapStartedAtMs ?? null;
  if (startedAtMs === null || !Number.isFinite(startedAtMs)) return false;
  if (state.lastProgressAtMs != null && state.lastProgressAtMs >= startedAtMs) return false;
  const timeoutMs = Math.max(500, Number(state.timeoutMs ?? 4000));
  return nowMs - startedAtMs >= timeoutMs;
}
