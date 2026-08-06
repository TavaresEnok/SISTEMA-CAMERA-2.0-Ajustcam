import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from 'react';
import axios from 'axios';
import { useLocation } from 'wouter';
import { Camera as CameraIcon, ChevronLeft, ChevronRight, Download, FastForward, FolderArchive, LoaderCircle, Maximize2, Minimize2, Pause, Play, Scissors, SkipBack, SkipForward, StepBack, StepForward, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { addMinutes, format, startOfDay } from 'date-fns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '../hooks/use-toast';
import { SyncedCameraPlayer } from '../components/SyncedCameraPlayer';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { localDayRange } from '../lib/web-operational';
import { minuteOfDay, hmsToMinute } from '../lib/timeline-time';
import { recordingOffsetSeconds, spriteTileStyle, type TimelinePreviewMeta } from '../lib/timeline-preview';
import {
  absoluteToVodPosition,
  isPlaybackTokenUsable,
  locateVodSegment,
  normalizeVodPlaylist,
  refreshSegmentUrl,
  resolveInitialSeekSeconds,
  segmentTokens,
  shouldAbortStalledSwap,
  shouldPrefetchNextSegment,
  shouldRenewPlaylist,
  vodPositionToAbsoluteMs,
  type VodPlaylist,
  type VodPlaylistSegment,
} from '../lib/vod-continuous';
import { janelaDaGravacao, selecionarGravacaoNoInstante } from '../lib/playback-selection';
import { agregarMinimapa, escolherGranularidade, gerarTicks } from '../lib/timeline-ruler';
import {
  TIMELINE_MAX_ZOOM,
  TIMELINE_TOTAL_MINUTES,
  chunkRanges,
  computeListWindow,
  computeVisibleWindow,
  coverageFromGaps,
  limitWindowAround,
  mergeByIdSorted,
  mergeRanges,
  orderRangesByDistance,
  planNextPage,
  planWindowFetch,
  selectThumbnailTargets,
  sliceVisibleSpans,
  subtractRanges,
  type PagePlan,
  type TimeRange,
} from '../lib/timeline-window';

type TimelineSegment = {
  recordingId?: string;
  start: number;
  end: number;
  type: 'recorded' | 'recorded_broken' | 'gap' | 'motion' | 'alarm';
};

type RecordingItem = {
  id: string;
  cameraId: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  sizeBytes: string;
  fileExists: boolean;
  fileUsable?: boolean;
  actualSizeBytes?: number;
  compatibleCached?: boolean;
  playUrl: string;
  compatiblePlayUrl: string;
  thumbnailUrl: string | null;
};

type RecordingDiagnostics = {
  recordingId: string;
  fileExists: boolean;
  fileSizeBytes?: number;
  playableLikely: boolean;
  hasAudioStream?: boolean;
  audioPlayableLikely?: boolean;
  compatibleRecommended?: boolean;
  compatibleCached?: boolean;
  fragmentedLikely?: boolean;
  reason: string | null;
  format?: string | null;
  durationSeconds?: number | null;
  bitRate?: number | null;
  video?: {
    codec?: string | null;
    width?: number | null;
    height?: number | null;
    avgFrameRate?: string | null;
  } | null;
  audio?: {
    codec?: string | null;
    channels?: number | null;
    sampleRate?: number | null;
  } | null;
};

type RecordingDiagnosticsSummary = {
  recordingId: string;
  diagnostics: RecordingDiagnostics;
};

type RecordingHealthCamera = {
  cameraId: string;
  total: number;
  broken: number;
  tooSmall: number;
  compatibleRecommended: number;
  directLikely: number;
  withAudio: number;
  lastRecordingAt: string | null;
  lastRecordingAgeSeconds: number | null;
  needsAttention: boolean;
  alertReason: string | null;
};

type InvestigationOption = {
  id: string;
  title: string;
};

type ExportedClip = {
  id: string;
  sourceRecordingId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  sizeBytes: string | null;
  downloadUrl: string;
  investigationItemId: string | null;
};

type PlaybackEvent = {
  // O id vem do feed e serve para deduplicar janelas que se sobrepõem — sem ele,
  // o mesmo evento entraria duas vezes na régua ao mover a faixa visível.
  id: string;
  timestamp: string;
  severity: string;
};

type PaginatedResponse<T> = {
  items: T[];
  total: number;
};

// Modo VOD contínuo: DOIS elementos <video> ("slots"). Um toca; o outro
// pré-carrega o próximo segmento em silêncio. Na virada trocamos qual deles está
// visível — sem recarregar nada, que é o que elimina a engasgada. Fora do modo
// contínuo nada disso existe: o player segue com um <video> só, como sempre.
type VodSlot = 'a' | 'b';
type VodSlotSource = { recordingId: string; url: string } | null;

const API_URL = getApiBaseUrl();
const SPEEDS = ['0.25x', '0.5x', '1x', '2x', '4x', '8x'];
// Mesmo limite do backend (tamanho do token JWT na URL do download).
const ZIP_MAX_RECORDINGS = 50;

// ── TIMELINE POR JANELA (ADITIVO) ──────────────────────────────────────────
// A régua deixa de esperar o DIA INTEIRO: um resumo barato desenha o esqueleto,
// o detalhe vem só da faixa visível (paginada por CURSOR, não por offset
// profundo) e o resto do dia entra em segundo plano. Toda a matemática está em
// ../lib/timeline-window (pura e testada). QUALQUER falha aqui devolve a página
// ao caminho antigo — o playback não pode ficar pior do que já é.
const WINDOW_PAGE_SIZE = 200; // teto do backend em GET /recordings
const EVENTS_PAGE_SIZE = 500; // teto do backend em GET /cameras/events-feed
const WINDOW_PAD_MINUTES = 30; // margem além da janela visível
// Gravação que COMEÇOU antes da janela e termina dentro dela: o backend filtra
// por startedAt, então a consulta precisa recuar ou o trecho some da régua.
const WINDOW_LOOKBACK_MINUTES = 120;
// Orçamento de DETALHE por carga. No zoom padrão a janela é o dia inteiro; quem
// desenha o resto é o esqueleto do resumo, e o detalhe fino (segmento a segmento,
// com miniatura) vem em volta de onde o operador está.
const WINDOW_MAX_DETAIL_MINUTES = 240;
const WINDOW_FETCH_DEBOUNCE_MS = 250;
const WINDOW_BACKGROUND_CHUNK_MINUTES = 180;
const WINDOW_MAX_PAGES = 60; // trava do laço de paginação (nunca pendura a página)
const THUMBNAIL_BATCH = 100; // mesmo lote de /recordings/thumbnail-tokens
const RECORDING_ROW_HEIGHT_PX = 65; // linha da lista: miniatura 44 + padding 20 + borda
const RECORDING_LIST_VIRTUALIZE_MIN = 60; // abaixo disso renderiza tudo, como sempre

// Válvula de escape sem redeploy: localStorage 'drac.playback.windowed' = off/on.
function windowedTimelineEnabled() {
  try {
    const flag = typeof window !== 'undefined' ? window.localStorage?.getItem('drac.playback.windowed') : null;
    if (flag === 'off') return false;
    if (flag === 'on') return true;
  } catch {
    // localStorage bloqueado (modo privado/política): segue o padrão.
  }
  return true;
}
const WINDOWED_TIMELINE = windowedTimelineEnabled();

// O navegador decodifica H.265/HEVC? (Safari nativamente; Chrome/Edge quando o
// SO/GPU tem decodificador de HEVC.) Quando sim, tocamos a gravação HEVC DIRETO
// (forceDirect=1), sem transcodificar; senão o servidor serve a versão
// compatível sob demanda como antes. Falsos positivos ("maybe") são cobertos
// pelo fallback automático de erro/timeout → modo compatível.
function detectHevcPlayback(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const probe = document.createElement('video');
    return Boolean(
      probe.canPlayType('video/mp4; codecs="hvc1.1.6.L123.B0"') ||
      probe.canPlayType('video/mp4; codecs="hev1.1.6.L123.B0"'),
    );
  } catch {
    return false;
  }
}
const BROWSER_PLAYS_HEVC = detectHevcPlayback();
const TOTAL_MINS = TIMELINE_TOTAL_MINUTES;
const API_TIMEOUT_MS = 20000;
const PLAYBACK_TIMEOUT_DIRECT_MS = 15000;
const PLAYBACK_TIMEOUT_COMPAT_MS = 150000; // 150s: FFmpeg HEVC→H264 pode levar até 120s na primeira execução
// Teto da espera pela playlist VOD antes de o playback seguir pelo caminho antigo.
// Com o contrato da playlist reparado ela responde rápido; 2,5s de teto só
// puniam o primeiro play quando a API estava lenta.
const VOD_PROBE_GRACE_MS = 1000;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildTimelineSegments(
  recordings: RecordingItem[],
  events: Array<{ timestamp: string; severity: string }>,
  dayStartMs: number,
) {
  // Tempo ABSOLUTO recortado pelo dia, nunca hora-do-relógio: `minuteOfDay`
  // fazia a gravação que cruza a meia-noite virar end < start (sumia da
  // régua), e `endedAt ?? startedAt` fazia gravação sem fim conhecido virar
  // largura zero mesmo com durationSeconds ao lado.
  const dayEndMs = dayStartMs + TOTAL_MINS * 60_000;
  const agoraMs = Date.now();
  const recorded: TimelineSegment[] = recordings
    .map((recording) => {
      const janela = janelaDaGravacao(recording, agoraMs);
      const startMs = Math.max(janela.startMs, dayStartMs);
      const endMs = Math.min(janela.endMs, dayEndMs);
      return {
        recordingId: recording.id,
        start: clamp((startMs - dayStartMs) / 60_000, 0, TOTAL_MINS),
        end: clamp((endMs - dayStartMs) / 60_000, 0, TOTAL_MINS),
        type: (recording.fileUsable ?? recording.fileExists) ? 'recorded' as const : 'recorded_broken' as const,
      };
    })
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  const gaps: TimelineSegment[] = [];
  let cursor = 0;
  for (const segment of recorded) {
    if (segment.start > cursor) gaps.push({ start: cursor, end: segment.start, type: 'gap' });
    cursor = Math.max(cursor, segment.end);
  }
  if (cursor < TOTAL_MINS) gaps.push({ start: cursor, end: TOTAL_MINS, type: 'gap' });

  const eventMarkers: TimelineSegment[] = events.map((event) => {
    const point = clamp(minuteOfDay(event.timestamp), 0, TOTAL_MINS);
    return {
      start: Math.max(0, point - 0.6),
      end: Math.min(TOTAL_MINS, point + 0.6),
      type: event.severity === 'critical' ? 'alarm' : 'motion',
    };
  });

  return [...gaps, ...recorded, ...eventMarkers].sort((a, b) => a.start - b.start);
}

/**
 * O <video> só entrega "onError", sem status nem corpo — e o backend passou a
 * responder 404/503 EXPLICADOS ("arquivada na nuvem, mas o bucket não a
 * devolveu (NoSuchKey)"). Uma sonda de 2 bytes recupera essa explicação; sem
 * ela o operador via "Request failed" genérico e a página "curava" erro de
 * servidor com transcodificação, que não cura nada.
 */
async function explicarFalhaDoVideo(url: string | null): Promise<{ mensagem: string; preparando: boolean } | null> {
  if (!url) return null;
  try {
    const resposta = await fetch(url, { headers: { Range: 'bytes=0-1' } });
    if (resposta.ok) return null;
    const corpo = await resposta.json().catch(() => null) as { message?: string; preparing?: boolean } | null;
    return {
      mensagem: corpo?.message
        ? (corpo.preparing ? corpo.message : `O servidor recusou o vídeo: ${corpo.message}`)
        : `O servidor recusou o vídeo (HTTP ${resposta.status}).`,
      preparando: Boolean(corpo?.preparing),
    };
  } catch {
    return null;
  }
}

function authHeaders(accessToken: string | null) {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
}

async function fetchAllPages<T>(
  client: ReturnType<typeof axios.create>,
  path: string,
  params: Record<string, string | number>,
  pageSize: number,
) {
  const items: T[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const { data } = await client.get<PaginatedResponse<T>>(path, {
      params: { ...params, limit: pageSize, offset },
      timeout: API_TIMEOUT_MS,
    });
    const page = Array.isArray(data.items) ? data.items : [];
    total = Number.isFinite(Number(data.total)) ? Number(data.total) : offset + page.length;
    items.push(...page);
    offset += page.length;
    if (!page.length || page.length < pageSize) break;
  }

  return items;
}

async function createPlaybackToken(recordingId: string, accessToken: string) {
  const { data } = await axios.post<{ playToken: string; expiresAt?: string | null }>(
    `${API_URL}/recordings/${recordingId}/play-token`,
    {},
    { headers: authHeaders(accessToken), withCredentials: true },
  );
  return data;
}

async function downloadRecording(recordingId: string, cameraCode: string, accessToken: string) {
  // Token curto + link direto (o MESMO mecanismo do ZIP): o navegador baixa em
  // streaming nativo, com barra de progresso. O XHR com responseType blob
  // materializava o MP4 INTEIRO na memória da aba — um segmento grande travava
  // o navegador do operador — e ainda escondia a mensagem de erro do servidor
  // dentro de um Blob ilegível.
  const { data } = await axios.post<{ downloadToken: string }>(
    `${API_URL}/recordings/download-batch-token`,
    { recordingIds: [recordingId] },
    { headers: authHeaders(accessToken), withCredentials: true },
  );
  const anchor = document.createElement('a');
  anchor.href = `${API_URL}/recordings/${recordingId}/download-file?token=${encodeURIComponent(data.downloadToken)}`;
  anchor.download = `${cameraCode}-${recordingId}.mp4`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function downloadClip(downloadUrl: string, clipId: string, reason: string, accessToken: string) {
  const sep = downloadUrl.includes('?') ? '&' : '?';
  const response = await axios.get(`${API_URL}${downloadUrl}${sep}reason=${encodeURIComponent(reason)}`, {
    headers: authHeaders(accessToken),
    responseType: 'blob',
  });
  const url = window.URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `clip-${clipId}.mp4`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

export default function PlaybackPage() {
  const [location] = useLocation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const cameras = useVmsDataStore((state) => state.cameras);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const client = useMemo(() => axios.create({ baseURL: API_URL, headers: authHeaders(accessToken), timeout: API_TIMEOUT_MS }), [accessToken]);

  const [selectedCamId, setSelectedCamId] = useState('');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [speed, setSpeed] = useState('1x');
  const [playhead, setPlayhead] = useState(480);
  const [zoom, setZoom] = useState(1);
  const [viewCenter, setViewCenter] = useState(480);
  const timelineTrackRef = useRef<HTMLDivElement | null>(null);
  const timelinePanRef = useRef<{ startX: number; startCenter: number; windowMins: number; moved: boolean } | null>(null);
  const timelineDraggedRef = useRef(false);
  // Prévia ao passar o mouse na timeline: miniatura + hora do trecho sob o cursor.
  const [timelineHover, setTimelineHover] = useState<{ x: number; minute: number; recordingId: string | null } | null>(null);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [loadingPlayback, setLoadingPlayback] = useState(false);
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const [downloadingRecordingId, setDownloadingRecordingId] = useState<string | null>(null);
  const [selectedForZip, setSelectedForZip] = useState<Set<string>>(new Set());
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [pendingSeekSeconds, setPendingSeekSeconds] = useState<number | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [compatMode, setCompatMode] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);
  const [playbackEvents, setPlaybackEvents] = useState<PlaybackEvent[]>([]);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  // Token bruto de playback por gravação (o MESMO que a miniatura usa): reaproveitado
  // para montar a URL do sprite de preview (2.9). O gate do sprite é idêntico ao do
  // /thumbnail (token da própria gravação), então derivado de câmera privada não vaza.
  const [thumbnailTokens, setThumbnailTokens] = useState<Record<string, string>>({});
  // Cache do meta do sprite (grid/intervalo) por gravação. `null` = sem sprite (404
  // ou erro): cai no fallback da miniatura estática, NUNCA quebra o playback.
  const [previewMetaByRecordingId, setPreviewMetaByRecordingId] = useState<Record<string, TimelinePreviewMeta | null>>({});
  const previewMetaRef = useRef<Record<string, TimelinePreviewMeta | null>>({});
  const previewMetaInFlightRef = useRef<Set<string>>(new Set());
  const [thumbnailRefreshNonce, setThumbnailRefreshNonce] = useState(0);
  const [diagnosticsByRecordingId, setDiagnosticsByRecordingId] = useState<Record<string, RecordingDiagnostics>>({});
  const [preparingCompatibleId, setPreparingCompatibleId] = useState<string | null>(null);
  const [investigations, setInvestigations] = useState<InvestigationOption[]>([]);
  const [selectedInvestigationId, setSelectedInvestigationId] = useState('__none__');
  const [clipStartSeconds, setClipStartSeconds] = useState<number | null>(null);
  const [clipEndSeconds, setClipEndSeconds] = useState<number | null>(null);
  const [exportingClip, setExportingClip] = useState(false);
  const [lastExportedClip, setLastExportedClip] = useState<ExportedClip | null>(null);
  const [savingBookmark, setSavingBookmark] = useState(false);
  const [videoZoom, setVideoZoom] = useState(1);
  const [videoPan, setVideoPan] = useState({ x: 0, y: 0 });
  const [draggingVideo, setDraggingVideo] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [jumpTime, setJumpTime] = useState('12:00:00');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareCameraIds, setCompareCameraIds] = useState<string[]>([]);
  const [compareRecordingsByCamera, setCompareRecordingsByCamera] = useState<Record<string, RecordingItem[]>>({});
  const playbackReadyRef = useRef(false);
  const autoSkipTriedRef = useRef<Set<string>>(new Set());
  // Continuidade: retoma a reprodução automaticamente após navegação/troca de segmento.
  const autoResumeRef = useRef(false);
  // Último playhead escrito pelo próprio vídeo (onTimeUpdate). Serve para distinguir
  // movimento do playhead causado pela reprodução (não deve re-navegar) de navegação
  // feita pelo usuário (deve trocar segmento/fazer seek).
  const lastVideoPlayheadRef = useRef<number | null>(null);
  const playerColumnRef = useRef<HTMLDivElement | null>(null);
  // Estado do player (controles nativos do <video> ficam ocultos; usamos barra própria)
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoVolume, setVideoVolume] = useState(1);
  const [videoMuted, setVideoMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [clipDownload, setClipDownload] = useState<{ url: string; clipId: string } | null>(null);
  const [clipDownloadReason, setClipDownloadReason] = useState('');
  const lastThumbnailRetryRef = useRef(0);

  // ── TIMELINE POR JANELA (ADITIVO) ─────────────────────────────────────────
  // `dayCoverage` é o esqueleto vindo do resumo barato do dia (onde HÁ vídeo);
  // `loadedRanges` são as faixas cujo DETALHE já está em memória. O esqueleto só
  // aparece onde ainda não há detalhe. `windowedFallback` liga o caminho antigo.
  const [dayCoverage, setDayCoverage] = useState<TimeRange[]>([]);
  // Incrementado a cada navegação explícita do usuário (clique/atalho): força a
  // re-seleção de gravação mesmo quando o minuto não mudou.
  const [navNonce, setNavNonce] = useState(0);
  // Vigias de rede: uma retentativa por fonte no timeout (rede lenta) e uma no
  // stall do meio do vídeo (token vencido num buffer longo, Wi-Fi caindo) —
  // antes, as duas situações deixavam o spinner girando para sempre.
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const minimapDragRef = useRef(false);
  // O minimapa tem 20px de altura: arrastando, o mouse escorrega para fora
  // dele o tempo todo. Com o listener no próprio elemento o arraste morria no
  // meio — capturar na JANELA é o que todo scrubber sério faz.
  useEffect(() => {
    const aoMover = (event: globalThis.MouseEvent) => {
      if (!minimapDragRef.current || !minimapRef.current) return;
      const rect = minimapRef.current.getBoundingClientRect();
      const minuto = ((event.clientX - rect.left) / Math.max(1, rect.width)) * TOTAL_MINS;
      setViewCenterFromMinimap(minuto);
    };
    const aoSoltar = () => { minimapDragRef.current = false; };
    window.addEventListener('mousemove', aoMover);
    window.addEventListener('mouseup', aoSoltar);
    return () => {
      window.removeEventListener('mousemove', aoMover);
      window.removeEventListener('mouseup', aoSoltar);
    };
  }, []);
  const slowRetryRef = useRef<string | null>(null);
  const stallRetryRef = useRef<string | null>(null);
  /** Tentativas de recarga por gravação enquanto o transcode prepara (503). */
  const preparandoRetryRef = useRef<Map<string, number>>(new Map());
  const [loadedRanges, setLoadedRanges] = useState<TimeRange[]>([]);
  const [windowedFallback, setWindowedFallback] = useState(!WINDOWED_TIMELINE);
  const loadKeyRef = useRef('');
  const recordingsRef = useRef<RecordingItem[]>([]);
  const playbackEventsRef = useRef<PlaybackEvent[]>([]);
  // Faixas "reservadas" = já carregadas OU em voo. Evita pedir duas vezes o mesmo
  // pedaço quando a carga de segundo plano e a panorâmica do operador se cruzam.
  const reservedRangesRef = useRef<TimeRange[]>([]);
  const loadedRangesRef = useRef<TimeRange[]>([]);
  const reservedEventRangesRef = useRef<TimeRange[]>([]);
  const loadedEventRangesRef = useRef<TimeRange[]>([]);
  const zoomRef = useRef(1);
  // Último recurso dos eventos: se a busca por janela falhar, cai no dia inteiro.
  const eventsFallbackRef = useRef<(() => void) | null>(null);
  // Quando cada token de miniatura foi emitido (para reemitir só o que venceu).
  const thumbnailIssuedAtRef = useRef<Record<string, number>>({});
  // Gravações cujo diagnóstico já foi pedido (o endpoint dispara ffprobe: nunca
  // peça duas vezes o mesmo id).
  const diagnosticsRequestedRef = useRef<Set<string>>(new Set());
  const recordingListRef = useRef<HTMLDivElement | null>(null);
  const listScrollFrameRef = useRef<number | null>(null);
  const [listMetrics, setListMetrics] = useState({ scrollTopPx: 0, viewportHeightPx: 0 });

  // ── VOD CONTÍNUO (ADITIVO) ────────────────────────────────────────────────
  // UMA playlist por câmera+dia (GET /recordings/vod.m3u8?format=json) descreve o
  // dia inteiro: ordem dos segmentos, duração real, offset acumulado e um token
  // de playback por segmento. Com ela o front (a) monta a URL do próximo arquivo
  // SEM ir ao servidor pedir token e (b) pré-carrega esse arquivo no segundo
  // <video> para trocar na virada sem recarregar — o que mata a "engasgada".
  //
  // Sem playlist utilizável (404, erro, formato inesperado) ou depois de
  // QUALQUER falha do modo contínuo, `vodActive` fica falso e o playback volta a
  // ser exatamente o de sempre: arquivo por arquivo, token por token.
  const [vodReady, setVodReady] = useState(false);
  const [vodFallback, setVodFallback] = useState(false);
  // Enquanto a playlist do dia está sendo buscada, o caminho antigo ESPERA (no
  // máximo VOD_PROBE_GRACE_MS). Sem essa espera os dois carregariam o mesmo
  // segmento e o operador veria o vídeo recomeçar do zero quando a playlist
  // chegasse — pior que não ter modo contínuo nenhum.
  const [vodProbing, setVodProbing] = useState(false);
  const vodPlaylistRef = useRef<VodPlaylist | null>(null);
  const vodTokensRef = useRef<Record<string, string>>({});
  const vodRenewRef = useRef<{ inFlight: boolean; failures: number; lastAttemptAtMs: number | null }>({
    inFlight: false,
    failures: 0,
    lastAttemptAtMs: null,
  });
  const vodInitialSeekRef = useRef(false);
  const [vodSlots, setVodSlots] = useState<{ a: VodSlotSource; b: VodSlotSource }>({ a: null, b: null });
  const [activeSlot, setActiveSlot] = useState<VodSlot>('a');
  const activeSlotRef = useRef<VodSlot>('a');
  const slotRefs = useRef<Record<VodSlot, HTMLVideoElement | null>>({ a: null, b: null });
  // Vigia da troca: se o elemento novo não render progresso a tempo, desistimos
  // do modo contínuo em vez de deixar o operador com a tela parada.
  const swapStartedAtRef = useRef<number | null>(null);
  const lastProgressAtRef = useRef<number | null>(null);
  const vodActive = vodReady && !vodFallback;
  const idleSlot: VodSlot = activeSlot === 'a' ? 'b' : 'a';
  const activeVodSource = vodActive ? vodSlots[activeSlot] : null;
  // Fonte que o elemento visível está tocando, venha ela do modo contínuo ou do
  // caminho antigo. Fora do modo contínuo é literalmente `playbackUrl`.
  const activeSourceUrl = activeVodSource?.url ?? playbackUrl;
  // "Há vídeo carregado no player?" — vale para os dois modos.
  const playerActive = Boolean(activeSourceUrl);

  // URL do segmento com o token MAIS FRESCO que temos (a renovação periódica
  // atualiza o mapa). `forceDirect` repete a regra do caminho antigo: navegador
  // que decodifica HEVC pede o arquivo original em vez da versão transcodada.
  const vodSegmentUrl = useCallback((segment: VodPlaylistSegment) => {
    const path = refreshSegmentUrl(segment.playUrl, vodTokensRef.current);
    const suffix = BROWSER_PLAYS_HEVC ? `${path.includes('?') ? '&' : '?'}forceDirect=1` : '';
    return `${API_URL}${path}${suffix}`;
  }, []);

  const vodSegmentToken = useCallback((segment: VodPlaylistSegment) => (
    vodTokensRef.current[segment.recordingId] ?? segment.token
  ), []);

  // `videoRef` continua apontando para o elemento QUE ESTÁ TOCANDO — todo o resto
  // da página (controles, clipes, seek) fala com ele e não precisa saber que
  // existem dois. Ao desmontar, só zera se o ponteiro era mesmo aquele elemento.
  const bindSlotA = useCallback((element: HTMLVideoElement | null) => {
    if (element) {
      slotRefs.current.a = element;
      if (activeSlotRef.current === 'a') videoRef.current = element;
      return;
    }
    if (videoRef.current === slotRefs.current.a) videoRef.current = null;
    slotRefs.current.a = null;
  }, []);

  const bindSlotB = useCallback((element: HTMLVideoElement | null) => {
    if (element) {
      slotRefs.current.b = element;
      if (activeSlotRef.current === 'b') videoRef.current = element;
      return;
    }
    if (videoRef.current === slotRefs.current.b) videoRef.current = null;
    slotRefs.current.b = null;
  }, []);

  const legacyVideoElRef = useRef<HTMLVideoElement | null>(null);
  const bindLegacyVideo = useCallback((element: HTMLVideoElement | null) => {
    if (element) {
      legacyVideoElRef.current = element;
      videoRef.current = element;
      return;
    }
    if (videoRef.current === legacyVideoElRef.current) videoRef.current = null;
    legacyVideoElRef.current = null;
  }, []);

  const requestedContext = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return {
      cameraId: params.get('cameraId'),
      at: params.get('at'),
    };
  }, [location]);
  const requestedCameraId = requestedContext?.cameraId ?? null;
  const requestedAt = requestedContext?.at ?? null;

  useEffect(() => {
    if (!cameras.length) return;
    if (requestedCameraId && cameras.some((camera) => camera.id === requestedCameraId)) {
      setSelectedCamId((current) => (current === requestedCameraId ? current : requestedCameraId));
      return;
    }
    if (!selectedCamId || !cameras.some((camera) => camera.id === selectedCamId)) {
      setSelectedCamId(cameras[0].id);
    }
  }, [cameras, requestedCameraId, selectedCamId]);

  useEffect(() => {
    if (!requestedAt) return;
    const target = new Date(requestedAt);
    if (Number.isNaN(target.getTime())) return;
    setSelectedDate(format(target, 'yyyy-MM-dd'));
    setPlayhead(clamp(minuteOfDay(target), 0, TOTAL_MINS));
  }, [requestedAt]);

  useEffect(() => {
    if (!accessToken) return;
    void client.get<{ items: InvestigationOption[] }>('/investigations')
      .then(({ data }) => setInvestigations(Array.isArray(data.items) ? data.items.map((item) => ({ id: item.id, title: item.title })) : []))
      .catch(() => setInvestigations([]));
  }, [accessToken, client]);

  useEffect(() => {
    if (!accessToken || !selectedCamId || requestedAt) return;
    let cancelled = false;
    void client.get<{ items: RecordingItem[] }>(`/recordings?cameraId=${encodeURIComponent(selectedCamId)}&limit=1&sort=desc`, { timeout: API_TIMEOUT_MS })
      .then(({ data }) => {
        if (cancelled) return;
        const latest = Array.isArray(data.items) ? data.items[0] : null;
        if (latest) {
          const nextDate = format(new Date(latest.startedAt), 'yyyy-MM-dd');
          setSelectedDate((current) => current === nextDate ? current : nextDate);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accessToken, client, requestedAt, selectedCamId]);

  // ── CARGA POR JANELA ──────────────────────────────────────────────────────
  // Busca UMA faixa de tempo paginando por CURSOR (o carimbo do último item),
  // em vez de offset profundo. A trava de páginas fecha o laço mesmo se o
  // backend responder algo inesperado — a página nunca fica pendurada.
  const fetchRangeItems = useCallback(async <T,>(
    path: string,
    params: Record<string, string | number>,
    range: TimeRange,
    dayStartMs: number,
    pageSize: number,
    getTimestamp: (item: T) => string | null,
    direction: 'asc' | 'desc',
  ): Promise<T[]> => {
    const dayEndMs = dayStartMs + TOTAL_MINS * 60_000 - 1;
    const toIso = (minute: number) => new Date(Math.min(dayStartMs + minute * 60_000, dayEndMs)).toISOString();
    let plan: PagePlan | null = { from: toIso(range.start), to: toIso(range.end), offset: 0 };
    const collected: T[] = [];
    for (let page = 0; plan && page < WINDOW_MAX_PAGES; page += 1) {
      const { data } = await client.get<PaginatedResponse<T>>(path, {
        params: { ...params, from: plan.from, to: plan.to, limit: pageSize, offset: plan.offset },
        timeout: API_TIMEOUT_MS,
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      collected.push(...items);
      const lastTimestamp = items.length ? getTimestamp(items[items.length - 1]) : null;
      plan = planNextPage({ plan, pageLength: items.length, pageSize, lastTimestamp, direction });
    }
    return collected;
  }, [client]);

  // Carrega faixas de GRAVAÇÃO e funde no que já existe. Cada faixa que chega já
  // aparece na régua (não espera as outras). Falha devolve a reserva para que a
  // faixa possa ser tentada de novo.
  const loadRecordingRanges = useCallback(async (
    ranges: TimeRange[],
    key: string,
    dayStartMs: number,
    cameraId: string,
  ) => {
    if (!ranges.length) return;
    reservedRangesRef.current = mergeRanges([...reservedRangesRef.current, ...ranges]);
    try {
      for (const range of ranges) {
        const items = await fetchRangeItems<RecordingItem>(
          '/recordings',
          { cameraId, sort: 'asc' },
          range,
          dayStartMs,
          WINDOW_PAGE_SIZE,
          (item) => item.startedAt,
          'asc',
        );
        if (loadKeyRef.current !== key) return;
        recordingsRef.current = mergeByIdSorted(recordingsRef.current, items, (item) => item.id, (item) => item.startedAt);
        setRecordings(recordingsRef.current);
        loadedRangesRef.current = mergeRanges([...loadedRangesRef.current, range]);
        setLoadedRanges(loadedRangesRef.current);
      }
    } catch (error) {
      if (loadKeyRef.current === key) reservedRangesRef.current = [...loadedRangesRef.current];
      throw error;
    }
  }, [fetchRangeItems]);

  // Eventos (marcadores de movimento/alarme na régua). São PONTOS no tempo, então
  // não precisam de recuo. Falhar aqui é cosmético: a régua fica sem marcador
  // naquela faixa, nunca sem gravação.
  const loadEventRanges = useCallback(async (
    ranges: TimeRange[],
    key: string,
    dayStartMs: number,
    cameraId: string,
  ) => {
    if (!ranges.length) return;
    reservedEventRangesRef.current = mergeRanges([...reservedEventRangesRef.current, ...ranges]);
    try {
      for (const range of ranges) {
        const items = await fetchRangeItems<{ id: string; occurredAt: string; severity?: string }>(
          '/cameras/events-feed',
          { cameraId },
          range,
          dayStartMs,
          EVENTS_PAGE_SIZE,
          (item) => item.occurredAt,
          'desc',
        );
        if (loadKeyRef.current !== key) return;
        playbackEventsRef.current = mergeByIdSorted(
          playbackEventsRef.current,
          items.map((event) => ({
            id: String(event.id),
            timestamp: event.occurredAt,
            severity: String(event.severity ?? 'info').toLowerCase(),
          })),
          (event) => event.id,
          (event) => event.timestamp,
        );
        setPlaybackEvents(playbackEventsRef.current);
        loadedEventRangesRef.current = mergeRanges([...loadedEventRangesRef.current, range]);
      }
    } catch (error) {
      if (loadKeyRef.current === key) reservedEventRangesRef.current = [...loadedEventRangesRef.current];
      throw error;
    }
  }, [fetchRangeItems]);

  useEffect(() => {
    if (!accessToken || !selectedCamId || !selectedDate) return;
    let cancelled = false;
    const key = `${selectedCamId}|${selectedDate}`;
    loadKeyRef.current = key;
    recordingsRef.current = [];
    reservedRangesRef.current = [];
    loadedRangesRef.current = [];
    setLoadedRanges([]);
    setDayCoverage([]);
    setWindowedFallback(!WINDOWED_TIMELINE);
    setLoadingRecordings(true);
    setLastExportedClip(null);
    setDiagnosticsByRecordingId({});

    const range = localDayRange(selectedDate);
    const dayStartMs = new Date(`${selectedDate}T00:00:00`).getTime();

    // Regra de posicionamento inicial — a MESMA de sempre: o instante pedido
    // (?at= / fila de Revisão) manda; senão, a última gravação do dia.
    const applyInitialPlayhead = (items: RecordingItem[]) => {
      const requestedTarget = requestedAt ? new Date(requestedAt) : null;
      const useRequestedTarget = requestedTarget
        && !Number.isNaN(requestedTarget.getTime())
        && format(requestedTarget, 'yyyy-MM-dd') === selectedDate;
      const minute = clamp(
        useRequestedTarget ? minuteOfDay(requestedTarget) : minuteOfDay(items[items.length - 1].startedAt),
        0,
        TOTAL_MINS,
      );
      setPlayhead(minute);
      setViewCenter(minute);
    };

    // Caminho ANTIGO, intacto: dia inteiro de uma vez. É para onde qualquer
    // falha do caminho por janela cai.
    const loadWholeDay = () => fetchAllPages<RecordingItem>(client, '/recordings', {
      cameraId: selectedCamId,
      from: range.from,
      to: range.to,
      sort: 'asc',
    }, 200)
      .then((items) => {
        if (cancelled || loadKeyRef.current !== key) return;
        recordingsRef.current = items;
        loadedRangesRef.current = [{ start: 0, end: TOTAL_MINS }];
        reservedRangesRef.current = [...loadedRangesRef.current];
        setLoadedRanges(loadedRangesRef.current);
        setRecordings(items);
        if (!items.length) {
          setSelectedRecordingId(null);
          setPlaybackUrl(null);
          setVideoError(null);
          return;
        }
        if (!items.some((item) => item.fileUsable ?? item.fileExists)) {
          setSelectedRecordingId(null);
          setPlaybackUrl(null);
          setVideoError('As gravações deste dia foram listadas, mas os arquivos estão ausentes, vazios ou incompletos no disco.');
          return;
        }
        applyInitialPlayhead(items);
      })
      .catch((error) => {
        if (cancelled || loadKeyRef.current !== key) return;
        setRecordings([]);
        recordingsRef.current = [];
        toast({
          title: 'Falha ao carregar gravações',
          description: error instanceof Error ? error.message : 'Não foi possível carregar as gravações desta câmera.',
          variant: 'destructive',
        });
      })
      .finally(() => {
        if (!cancelled && loadKeyRef.current === key) setLoadingRecordings(false);
      });

    if (!WINDOWED_TIMELINE) {
      void loadWholeDay();
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        // 1) Resumo BARATO do dia (1 requisição): onde há vídeo, para desenhar a
        //    régua antes de qualquer detalhe chegar.
        const { data } = await client.get<{
          gaps?: Array<{ startAt: string; endAt: string }>;
          totalGaps?: number;
        }>('/recordings/gaps-report', {
          // from/to ISO do dia LOCAL do navegador. Só `date` deixava o servidor
          // montar o dia no fuso DELE (UTC nos containers): a janela escorregava
          // 3h, os últimos minutos do dia viravam "coberto" fantasma e o clique
          // ali caía no vídeo errado.
          params: { cameraId: selectedCamId, date: selectedDate, from: dayStart.toISOString(), to: addMinutes(dayStart, TOTAL_MINS).toISOString() },
          timeout: API_TIMEOUT_MS,
        });
        if (cancelled || loadKeyRef.current !== key) return;
        const gaps = Array.isArray(data?.gaps) ? data.gaps : [];
        const totalGaps = Number(data?.totalGaps ?? gaps.length);
        const coverage = coverageFromGaps({
          gaps,
          dayStartMs,
          truncated: Number.isFinite(totalGaps) && gaps.length < totalGaps,
        });
        if (!coverage.spans.length || coverage.lastCoveredMinute == null) {
          // Resumo sem cobertura utilizável (dia vazio, fuso divergente, endpoint
          // antigo): não dá para confiar nele — vai pelo caminho antigo.
          throw new Error('resumo do dia sem cobertura utilizável');
        }
        setDayCoverage(coverage.spans);

        // 2) Detalhe SÓ da faixa onde o operador vai cair.
        const requestedTarget = requestedAt ? new Date(requestedAt) : null;
        const useRequestedTarget = requestedTarget
          && !Number.isNaN(requestedTarget.getTime())
          && format(requestedTarget, 'yyyy-MM-dd') === selectedDate;
        const center = clamp(
          useRequestedTarget ? minuteOfDay(requestedTarget) : coverage.lastCoveredMinute,
          0,
          TOTAL_MINS,
        );
        setViewCenter(center);
        const firstWindow = limitWindowAround({
          window: computeVisibleWindow({ zoom: zoomRef.current, viewCenter: center }),
          center,
          maxMinutes: WINDOW_MAX_DETAIL_MINUTES,
        });
        await loadRecordingRanges(
          planWindowFetch({
            window: firstWindow,
            loaded: [],
            padMinutes: WINDOW_PAD_MINUTES,
            lookbackMinutes: WINDOW_LOOKBACK_MINUTES,
          }),
          key,
          dayStartMs,
          selectedCamId,
        );
        if (cancelled || loadKeyRef.current !== key) return;
        if (!recordingsRef.current.length) {
          // O resumo prometeu vídeo e a consulta detalhada não trouxe nada: não
          // deixe o operador com régua vazia — refaz pelo caminho antigo.
          throw new Error('janela inicial vazia apesar do resumo');
        }
        applyInitialPlayhead(recordingsRef.current);
        setLoadingRecordings(false);

        // 3) Resto do dia em SEGUNDO PLANO, do mais perto da janela para o mais
        //    longe. O estado final é idêntico ao de hoje (lista completa para
        //    ZIP, seleção de segmento, comparação) — só que depois do 1º pixel.
        void loadRecordingRanges(
          orderRangesByDistance(
            chunkRanges(
              subtractRanges({ start: 0, end: TOTAL_MINS }, reservedRangesRef.current),
              WINDOW_BACKGROUND_CHUNK_MINUTES,
            ),
            center,
          ),
          key,
          dayStartMs,
          selectedCamId,
        ).catch(() => {
          // Segundo plano: a janela do operador já está desenhada. O que faltar
          // é buscado de novo quando ele mover a régua para lá.
        });
      } catch {
        if (cancelled || loadKeyRef.current !== key) return;
        setWindowedFallback(true);
        setDayCoverage([]);
        void loadWholeDay();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, client, loadRecordingRanges, requestedAt, selectedCamId, selectedDate]);

  useEffect(() => {
    if (!accessToken || !selectedCamId || !selectedDate) {
      setPlaybackEvents([]);
      playbackEventsRef.current = [];
      return;
    }
    let cancelled = false;
    const key = `${selectedCamId}|${selectedDate}`;
    playbackEventsRef.current = [];
    reservedEventRangesRef.current = [];
    loadedEventRangesRef.current = [];
    setPlaybackEvents([]);
    const range = localDayRange(selectedDate);

    // Caminho antigo: o dia inteiro de eventos de uma vez.
    const loadWholeDayEvents = () => fetchAllPages<any>(client, '/cameras/events-feed', {
      cameraId: selectedCamId,
      from: range.from,
      to: range.to,
    }, EVENTS_PAGE_SIZE)
      .then((items) => {
        if (cancelled || loadKeyRef.current !== key) return;
        playbackEventsRef.current = items.map((event) => ({
          id: String(event.id ?? event.occurredAt),
          timestamp: event.occurredAt,
          severity: String(event.severity ?? 'info').toLowerCase(),
        }));
        setPlaybackEvents(playbackEventsRef.current);
        loadedEventRangesRef.current = [{ start: 0, end: TOTAL_MINS }];
        reservedEventRangesRef.current = [...loadedEventRangesRef.current];
      })
      .catch(() => {
        if (!cancelled) setPlaybackEvents(playbackEventsRef.current);
      });

    if (!WINDOWED_TIMELINE || windowedFallback) {
      void loadWholeDayEvents();
      return () => {
        cancelled = true;
      };
    }

    // Marcador de evento só é DESENHADO dentro da janela: buscar o dia inteiro é
    // trabalho jogado fora. Quem pede a faixa visível (e as seguintes, conforme o
    // operador move a régua) é o efeito de janela mais abaixo.
    eventsFallbackRef.current = () => {
      if (!cancelled) void loadWholeDayEvents();
    };

    return () => {
      cancelled = true;
    };
  }, [accessToken, client, selectedCamId, selectedDate, windowedFallback]);

  // O diagnóstico em lote também virou por JANELA — procure por "DIAGNÓSTICO".
  // (Ele dispara ffprobe no servidor para o que ainda não está em cache: pedir a
  // lista inteira a cada pedaço de dia que chega seria uma enxurrada.)
  useEffect(() => {
    setDiagnosticsByRecordingId({});
    diagnosticsRequestedRef.current = new Set();
  }, [selectedCamId, selectedDate]);

  // A emissão de token de miniatura mora mais abaixo (precisa saber o que está
  // VISÍVEL na régua e na lista) — procure por "TOKEN DE MINIATURA".
  useEffect(() => {
    // Troca de câmera/data zera as miniaturas: token de gravação de outra câmera
    // não serve, e o mapa antigo esconderia que a nova ainda não carregou.
    setThumbnailUrls({});
    setThumbnailTokens({});
    thumbnailIssuedAtRef.current = {};
  }, [selectedCamId, selectedDate]);

  useEffect(() => {
    if (!accessToken || !recordings.length) return;
    const renew = () => {
      if (document.visibilityState === 'visible') setThumbnailRefreshNonce((value) => value + 1);
    };
    const timer = window.setInterval(renew, 4 * 60 * 1000);
    window.addEventListener('focus', renew);
    document.addEventListener('visibilitychange', renew);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', renew);
      document.removeEventListener('visibilitychange', renew);
    };
  }, [accessToken, recordings.length]);

  const retryExpiredThumbnails = useCallback(() => {
    const now = Date.now();
    if (now - lastThumbnailRetryRef.current < 5_000) return;
    lastThumbnailRetryRef.current = now;
    // Miniatura quebrada = token vencido. Esquecer a hora de emissão força a
    // reemissão de TODOS os visíveis (era o que o caminho antigo fazia).
    thumbnailIssuedAtRef.current = {};
    setThumbnailRefreshNonce((value) => value + 1);
  }, []);

  // 2.9 — busca (sob demanda, no hover) o meta do sprite de uma gravação e cacheia.
  // Deduplica por ref (in-flight + já-conhecido) para não refazer request a cada
  // pixel do mousemove. Erro/404 marca `null` → fallback gracioso na miniatura.
  const ensurePreviewMeta = useCallback((recordingId: string) => {
    if (!recordingId || !accessToken) return;
    if (recordingId in previewMetaRef.current) return;
    if (previewMetaInFlightRef.current.has(recordingId)) return;
    previewMetaInFlightRef.current.add(recordingId);
    void client
      .get<TimelinePreviewMeta>(`/recordings/${encodeURIComponent(recordingId)}/preview-meta`)
      .then(({ data }) => {
        previewMetaRef.current = { ...previewMetaRef.current, [recordingId]: data };
        setPreviewMetaByRecordingId(previewMetaRef.current);
      })
      .catch(() => {
        previewMetaRef.current = { ...previewMetaRef.current, [recordingId]: null };
        setPreviewMetaByRecordingId(previewMetaRef.current);
      })
      .finally(() => {
        previewMetaInFlightRef.current.delete(recordingId);
      });
  }, [accessToken, client]);

  // Troca de câmera/data invalida o cache de metas (ids diferentes; evita crescer sem fim).
  useEffect(() => {
    previewMetaRef.current = {};
    previewMetaInFlightRef.current.clear();
    setPreviewMetaByRecordingId({});
  }, [selectedCamId, selectedDate]);

  // O resumo de saúde era buscado a cada troca de câmera/data (até 24 ffprobe
  // no servidor por chamada) e renderizado num bloco `hidden` — custo real,
  // informação invisível. A busca sai; quando o cartão de saúde ganhar UI
  // visível, volta com ela.

  // Busca a playlist do dia. Falhar aqui é NORMAL e SILENCIOSO (404 = dia sem
  // gravação reproduzível, erro de rede, endpoint antigo): o playback segue no
  // caminho de sempre, sem aviso nem tela de erro.
  const fetchVodPlaylist = useCallback(async () => {
    const range = localDayRange(selectedDate);
    const { data } = await client.get('/recordings/vod.m3u8', {
      params: { cameraId: selectedCamId, from: range.from, to: range.to, format: 'json' },
      timeout: API_TIMEOUT_MS,
    });
    return normalizeVodPlaylist(data, Date.now());
  }, [client, selectedCamId, selectedDate]);

  useEffect(() => {
    vodPlaylistRef.current = null;
    vodTokensRef.current = {};
    vodRenewRef.current = { inFlight: false, failures: 0, lastAttemptAtMs: null };
    vodInitialSeekRef.current = false;
    swapStartedAtRef.current = null;
    setVodSlots({ a: null, b: null });
    setVodReady(false);
    setVodFallback(false);
    if (!accessToken || !selectedCamId || !selectedDate) {
      setVodProbing(false);
      return;
    }
    let cancelled = false;
    setVodProbing(true);
    const stopProbing = () => {
      if (!cancelled) setVodProbing(false);
    };
    // Teto da espera: playlist lenta NUNCA pode atrasar o playback além disto.
    const graceTimer = window.setTimeout(stopProbing, VOD_PROBE_GRACE_MS);
    void fetchVodPlaylist()
      .then((playlist) => {
        if (cancelled || !playlist) return;
        vodPlaylistRef.current = playlist;
        vodTokensRef.current = segmentTokens(playlist);
        setVodReady(true);
      })
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(graceTimer);
        stopProbing();
      });
    return () => {
      cancelled = true;
      window.clearTimeout(graceTimer);
    };
  }, [accessToken, fetchVodPlaylist, selectedCamId, selectedDate]);

  // Renovação: os tokens da playlist duram minutos e o dia dura horas. Rebuscar a
  // MESMA playlist (endpoint idempotente) só troca o mapa de tokens em memória —
  // a reprodução em curso não é tocada, porque a URL do elemento ativo não muda:
  // o token novo só é usado no PRÓXIMO segmento carregado.
  useEffect(() => {
    if (!vodActive) return;
    const tick = () => {
      const playlist = vodPlaylistRef.current;
      if (!playlist) return;
      const video = videoRef.current;
      const state = {
        fetchedAtMs: playlist.fetchedAtMs,
        tokenExpiresAtMs: playlist.tokenExpiresAtMs,
        inFlight: vodRenewRef.current.inFlight,
        consecutiveFailures: vodRenewRef.current.failures,
        lastAttemptAtMs: vodRenewRef.current.lastAttemptAtMs,
        documentVisible: typeof document === 'undefined' || document.visibilityState === 'visible',
        playing: Boolean(video && !video.paused && !video.ended),
      };
      if (!shouldRenewPlaylist(state, Date.now())) return;
      vodRenewRef.current.inFlight = true;
      vodRenewRef.current.lastAttemptAtMs = Date.now();
      void fetchVodPlaylist()
        .then((next) => {
          if (!next) {
            vodRenewRef.current.failures += 1;
            return;
          }
          vodRenewRef.current.failures = 0;
          vodPlaylistRef.current = next;
          vodTokensRef.current = segmentTokens(next);
        })
        .catch(() => {
          vodRenewRef.current.failures += 1;
        })
        .finally(() => {
          vodRenewRef.current.inFlight = false;
        });
    };
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, [fetchVodPlaylist, vodActive]);

  useEffect(() => {
    if (!compareEnabled || !accessToken || !selectedDate || !cameras.length) {
      setCompareRecordingsByCamera({});
      return;
    }
    const ids = Array.from(new Set([selectedCamId, ...compareCameraIds].filter(Boolean))).slice(0, 4);
    if (!ids.length) return;
    let cancelled = false;
    void Promise.all(ids.map(async (cameraId) => {
      const range = localDayRange(selectedDate);
      const items = await fetchAllPages<RecordingItem>(client, '/recordings', {
        cameraId,
        from: range.from,
        to: range.to,
        sort: 'asc',
      }, 200);
      return [cameraId, items] as const;
    }))
      .then((entries) => {
        if (cancelled) return;
        setCompareRecordingsByCamera(Object.fromEntries(entries));
      })
      .catch(() => {
        if (!cancelled) setCompareRecordingsByCamera({});
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, cameras.length, client, compareCameraIds, compareEnabled, selectedCamId, selectedDate]);

  const selectedCam = useMemo(() => cameras.find((camera) => camera.id === selectedCamId) ?? cameras[0] ?? null, [cameras, selectedCamId]);
  const selectedDay = useMemo(() => new Date(`${selectedDate}T00:00:00`), [selectedDate]);
  const dayStart = useMemo(() => startOfDay(selectedDay), [selectedDay]);

  // Largura real da régua: a granularidade dos ticks depende dela (rótulo que
  // não cabe vira régua ilegível). Medida uma vez e a cada resize.
  const [timelineWidthPx, setTimelineWidthPx] = useState(900);
  useEffect(() => {
    const el = timelineTrackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const medir = () => setTimelineWidthPx(Math.max(200, el.getBoundingClientRect().width));
    medir();
    const observer = new ResizeObserver(medir);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const timelineSegments = useMemo(() => buildTimelineSegments(recordings, playbackEvents, dayStart.getTime()), [recordings, playbackEvents, dayStart]);
  const compareCameraItems = useMemo(() => (
    Array.from(new Set([selectedCamId, ...compareCameraIds].filter(Boolean)))
      .slice(0, 4)
      .map((cameraId) => cameras.find((camera) => camera.id === cameraId))
      .filter((camera): camera is NonNullable<typeof camera> => Boolean(camera))
      // Câmera privada de terceiro fica FORA da comparação. O backend já barra
      // (o gate de playback é server-side, não cosmético), então isto não é o
      // controle de acesso — é não oferecer o que seria negado e não rotular
      // "sem gravação" o que na verdade é "sem permissão". Mesma regra do
      // CameraTile no ao vivo.
      .filter((camera) => !(camera.isPrivate === true && camera.canViewContent === false))
  ), [cameras, compareCameraIds, selectedCamId]);

  // ───────────────────────────────────────────────────────────────────────────
  // SINCRONIA MULTI-CÂMERA.
  //
  // O `playhead` (minuto do dia, float) é a posição que o operador manipula e
  // que o player da câmera principal já dirige. Aqui ele vira INSTANTE DE PAREDE
  // — a única linguagem em que faz sentido falar com câmeras diferentes, porque
  // cada uma tem fronteiras de arquivo e buracos próprios.
  //
  // Os seguidores NUNCA escrevem `playhead`. Só o player principal escreve (via
  // onTimeUpdate); se um seguidor também escrevesse, a guarda de
  // `lastVideoPlayheadRef` não distinguiria mais "o vídeo moveu" de "o usuário
  // moveu", e a seleção de segmento entraria em laço.
  // ───────────────────────────────────────────────────────────────────────────
  const compareTargetMs = useMemo(() => {
    if (!compareEnabled) return null;
    const dayStartMs = startOfDay(new Date(`${selectedDate}T00:00:00`)).getTime();
    return dayStartMs + playhead * 60_000;
  }, [compareEnabled, playhead, selectedDate]);

  // `speed` é rótulo de UI ('1x', '2x'…); o player precisa do número, e a
  // correção de sincronia MULTIPLICA este valor (nunca o substitui).
  const compareUserSpeed = useMemo(() => {
    const parsed = Number(speed.replace('x', ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }, [speed]);

  const fetchComparePlaylist = useCallback(async (cameraId: string) => {
    const range = localDayRange(selectedDate);
    const { data } = await client.get('/recordings/vod.m3u8', {
      params: { cameraId, from: range.from, to: range.to, format: 'json' },
      timeout: API_TIMEOUT_MS,
    });
    return data;
  }, [client, selectedDate]);

  const compareRows = useMemo(() => compareCameraItems.map((camera) => {
    const items = compareRecordingsByCamera[camera.id] ?? (camera.id === selectedCamId ? recordings : []);
    const eventsForCamera = camera.id === selectedCamId ? playbackEvents : [];
    const segments = buildTimelineSegments(items, eventsForCamera, dayStart.getTime());
    const current = items.find((recording) => {
      const start = minuteOfDay(recording.startedAt);
      const end = minuteOfDay(recording.endedAt ?? recording.startedAt);
      return playhead >= start && playhead <= end;
    });
    return { camera, items, segments, current };
  }), [compareCameraItems, compareRecordingsByCamera, playbackEvents, playhead, recordings, selectedCamId]);
  useEffect(() => {
    if (!recordings.length) {
      setSelectedRecordingId(null);
      setPlaybackUrl(null);
      setVideoError(null);
      return;
    }
    const playableRecordings = recordings.filter((recording) => recording.fileUsable ?? recording.fileExists);
    if (!playableRecordings.length) {
      setSelectedRecordingId(null);
      setPlaybackUrl(null);
      setVideoError('Nenhuma gravação utilizável foi encontrada no disco para esta data.');
      return;
    }
    // Movimento do playhead vindo da própria reprodução (onTimeUpdate): não re-navegar.
    // O arredondamento por minuto fazia o efeito trocar de segmento até ~30s antes do
    // fim do trecho, remontando o player e derrubando a reprodução no meio do vídeo.
    if (lastVideoPlayheadRef.current === playhead) return;
    const minuteTarget = playhead;
    // Modo contínuo: quem responde "que arquivo toca neste instante e a partir de
    // que segundo" é a PLAYLIST — ela traz a duração real de cada segmento (e o
    // recorte por buraco), em vez do palpite por minuto-do-dia. Instante dentro de
    // um buraco cai no começo do próximo segmento, que é o que o operador espera.
    const vodPlaylist = vodActive ? vodPlaylistRef.current : null;
    if (vodPlaylist) {
      const position = absoluteToVodPosition(vodPlaylist, addMinutes(dayStart, minuteTarget));
      if (position?.segment) {
        const target = position.segment;
        setSelectedRecordingId((current) => (current === target.recordingId ? current : target.recordingId));
        setPendingSeekSeconds(position.offsetInSegmentSeconds);
        return;
      }
    }
    // Seleção em tempo ABSOLUTO (../lib/playback-selection, pura e testada).
    // O fallback antigo caía em playableRecordings[0]: clique depois do fim da
    // última gravação — ou numa faixa cujo detalhe ainda não carregou — tocava
    // a PRIMEIRA gravação do dia. E sobreposição/emenda escolhia o segmento
    // antigo, com seek no último frame e `ended` imediato.
    const alvoMs = dayStart.getTime() + minuteTarget * 60_000;
    const selecao = selecionarGravacaoNoInstante(playableRecordings, alvoMs, {
      coberturaMinutos: dayCoverage,
      dayStartMs: dayStart.getTime(),
    });
    if (selecao.tipo === 'aguardar') return; // detalhe a caminho; este efeito re-roda quando `recordings` crescer
    if (selecao.tipo === 'nada') return;
    setSelectedRecordingId((current) => (current === selecao.id ? current : selecao.id));
    setPendingSeekSeconds(selecao.offsetSeconds);
  }, [dayStart, dayCoverage, recordings, playhead, vodActive, navNonce]);

  const selectedRecording = useMemo(() => recordings.find((recording) => recording.id === selectedRecordingId) ?? null, [recordings, selectedRecordingId]);
  const selectedThumbnailUrl = selectedRecordingId ? thumbnailUrls[selectedRecordingId] ?? null : null;
  const standbyThumbnailUrl = selectedThumbnailUrl ?? (recordings.length ? thumbnailUrls[recordings[recordings.length - 1].id] ?? null : null);
  const selectedDiagnostics = useMemo(() => (selectedRecordingId ? diagnosticsByRecordingId[selectedRecordingId] ?? null : null), [diagnosticsByRecordingId, selectedRecordingId]);
  const playbackMayUseCompatible = compatMode || (Boolean(selectedDiagnostics?.compatibleRecommended) && !BROWSER_PLAYS_HEVC);
  const recordingById = useMemo(() => new Map(recordings.map((recording) => [recording.id, recording] as const)), [recordings]);

  useEffect(() => {
    if (!selectedRecordingId || !accessToken) {
      setPlaybackUrl(null);
      return;
    }
    // Modo contínuo: a fonte do <video> vem dos slots (efeito logo abaixo), com o
    // token que já veio na playlist — sem POST /play-token a cada segmento, que é
    // uma das idas ao servidor que faziam a virada engasgar.
    if (vodActive && vodPlaylistRef.current?.segments.some((segment) => segment.recordingId === selectedRecordingId)) {
      setPlaybackUrl(null);
      setLoadingPlayback(false);
      return;
    }
    // Playlist do dia ainda em voo: espera (com teto) em vez de carregar o mesmo
    // segmento duas vezes e fazer o vídeo recomeçar quando ela chegar.
    if (vodProbing) {
      setLoadingPlayback(true);
      return;
    }
    if (!selectedRecording) {
      // Selecionada pela playlist/auto-avanço mas ainda fora da janela
      // carregada da lista: é carregamento, não perda — o erro de "arquivo não
      // existe" aqui condenava gravação perfeitamente boa.
      setPlaybackUrl(null);
      setLoadingPlayback(true);
      return;
    }
    if (!selectedRecording.fileExists) {
      setPlaybackUrl(null);
      setVideoError('O arquivo desta gravação não existe mais no disco nem na nuvem.');
      return;
    }
    if (selectedRecording.fileUsable === false) {
      setPlaybackUrl(null);
      setVideoError('O arquivo desta gravação existe, mas está vazio ou incompleto e não pode ser reproduzido.');
      return;
    }

    let cancelled = false;
    setLoadingPlayback(true);
    setVideoError(null);
    playbackReadyRef.current = false;

    void createPlaybackToken(selectedRecordingId, accessToken)
      .then((token) => {
        if (cancelled) return;
        const params = new URLSearchParams();
        if (compatMode) params.set('compatible', '1');
        // Navegador com decodificador HEVC: pede o arquivo ORIGINAL (o servidor
        // auto-preferiria a versão transcodada para gravações H.265).
        else if (BROWSER_PLAYS_HEVC) params.set('forceDirect', '1');
        if (token.playToken) params.set('token', token.playToken);
        params.set('v', String(reloadNonce));
        setPlaybackUrl(`${API_URL}/recordings/${selectedRecordingId}/play?${params.toString()}`);
      })
      .catch((error) => {
        if (cancelled) return;
        setPlaybackUrl(null);
      setVideoError(error instanceof Error ? error.message : 'Falha ao preparar reprodução.');
      })
      .finally(() => {
        if (!cancelled) setLoadingPlayback(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRecordingId, accessToken, compatMode, selectedRecording?.fileExists, selectedRecording?.fileUsable, reloadNonce, vodActive, vodProbing]);

  // Coração do modo contínuo: decide QUAL elemento toca o segmento selecionado.
  // Se o segmento já está PRÉ-CARREGADO no elemento ocioso, apenas TROCAMOS de
  // slot — nenhum <video> recarrega, não há tela preta nem novo handshake. Se não
  // está, carregamos no elemento ativo, que é o comportamento de hoje (menos o
  // pedido de token). Token por vencer → devolve ao caminho antigo antes de
  // arriscar um 401 no meio da reprodução.
  useEffect(() => {
    if (!vodActive || !selectedRecordingId) return;
    const playlist = vodPlaylistRef.current;
    const index = playlist?.segments.findIndex((item) => item.recordingId === selectedRecordingId) ?? -1;
    // Gravação fora da playlist (ex.: nasceu depois dela): o modo contínuo não
    // sabe tocar isso. Devolve TUDO ao caminho antigo — deixar como estava faria
    // o player continuar exibindo o segmento anterior.
    if (!playlist || index < 0) {
      setVodFallback(true);
      return;
    }
    const segment = playlist.segments[index];
    if (vodSlots[activeSlot]?.recordingId === selectedRecordingId) return;
    if (!isPlaybackTokenUsable(vodSegmentToken(segment), Date.now())) {
      setVodFallback(true);
      return;
    }

    const idleElement = slotRefs.current[idleSlot];
    const idleHoldsSegment = vodSlots[idleSlot]?.recordingId === selectedRecordingId;
    // readyState >= 3 (HAVE_FUTURE_DATA): dá para começar a tocar agora.
    if (idleHoldsSegment && idleElement && idleElement.readyState >= 3) {
      const outgoing = videoRef.current;
      const rate = Number(speed.replace('x', ''));
      idleElement.playbackRate = Number.isFinite(rate) ? rate : 1;
      idleElement.volume = videoVolume;
      idleElement.muted = videoMuted;
      if (pendingSeekSeconds != null) {
        idleElement.currentTime = pendingSeekSeconds;
        setPendingSeekSeconds(null);
      } else if (idleElement.currentTime > 0.5) {
        idleElement.currentTime = 0;
      }
      if (outgoing && outgoing !== idleElement) outgoing.pause();
      activeSlotRef.current = idleSlot;
      videoRef.current = idleElement;
      setActiveSlot(idleSlot);
      setVideoDuration(Number.isFinite(idleElement.duration) ? idleElement.duration : 0);
      setVideoCurrentTime(idleElement.currentTime);
      // O elemento já provou que carrega: nada de cronômetro de "demorou demais".
      playbackReadyRef.current = true;
      setVideoError(null);
      setLoadingPlayback(false);
      const shouldResume = autoResumeRef.current || Boolean(outgoing && !outgoing.paused);
      autoResumeRef.current = false;
      if (shouldResume) {
        swapStartedAtRef.current = Date.now();
        lastProgressAtRef.current = null;
        void idleElement.play().catch(() => {});
      }
      return;
    }

    // Sem pré-carga aproveitável: carrega no elemento ativo (o que o playback já
    // fazia hoje). O <video> nasce parado, então zera o estado da barra como o
    // reset que existe para o caminho antigo.
    setVideoError(null);
    setLoadingPlayback(false);
    setPlaying(false);
    setBuffering(false);
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setVodSlots((current) => ({ ...current, [activeSlot]: { recordingId: segment.recordingId, url: vodSegmentUrl(segment) } }));
  }, [
    activeSlot,
    idleSlot,
    pendingSeekSeconds,
    selectedRecordingId,
    speed,
    videoMuted,
    videoVolume,
    vodActive,
    vodSegmentToken,
    vodSegmentUrl,
    vodSlots,
  ]);

  // Vigia da troca: elemento novo que não anda em alguns segundos é pior que o
  // comportamento antigo — abandona o modo contínuo e recarrega como sempre.
  useEffect(() => {
    if (!vodActive) return;
    const timer = window.setInterval(() => {
      if (!shouldAbortStalledSwap({
        swapStartedAtMs: swapStartedAtRef.current,
        lastProgressAtMs: lastProgressAtRef.current,
        timeoutMs: 4000,
      }, Date.now())) return;
      swapStartedAtRef.current = null;
      lastVideoPlayheadRef.current = null;
      autoResumeRef.current = true;
      setVodFallback(true);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [vodActive]);

  // Link ?at= (fila de Revisão, alarme): a playlist sabe exatamente em que
  // arquivo e em que segundo aquele instante caiu — inclusive quando ele cai num
  // buraco. Aplica UMA vez por câmera+dia; sem ?at= o padrão de hoje (última
  // gravação do dia) continua valendo.
  useEffect(() => {
    if (!vodActive || vodInitialSeekRef.current) return;
    const playlist = vodPlaylistRef.current;
    if (!playlist || !requestedAt) return;
    const position = absoluteToVodPosition(playlist, requestedAt);
    if (!position?.segment || position.placement === 'before' || position.placement === 'after') return;
    vodInitialSeekRef.current = true;
    const seekSeconds = resolveInitialSeekSeconds({ playlist, at: requestedAt });
    const located = locateVodSegment(playlist, seekSeconds);
    if (!located) return;
    lastVideoPlayheadRef.current = null;
    setSelectedRecordingId((current) => (current === located.segment.recordingId ? current : located.segment.recordingId));
    setPendingSeekSeconds(located.offsetInSegmentSeconds);
    setPlayhead(clamp(minuteOfDay(new Date(located.segment.startedAtMs + located.offsetInSegmentSeconds * 1000)), 0, TOTAL_MINS));
  }, [requestedAt, vodActive]);

  useEffect(() => {
    setCompatMode(false);
    setReloadNonce(0);
    autoSkipTriedRef.current.clear();
  }, [selectedRecordingId]);

  // Modo compatível (servidor transcodifica HEVC→H.264 sob demanda) é assunto do
  // caminho antigo: quando ele entra, o modo contínuo sai — senão o botão
  // "Preparar versão compatível" não teria efeito nenhum na tela.
  useEffect(() => {
    if (compatMode) setVodFallback(true);
  }, [compatMode]);

  // O <video> remonta a cada URL (key). O elemento novo nasce PAUSADO — sem este
  // reset, o botão play/pause ficava mostrando o estado da gravação anterior
  // enquanto o vídeo novo ainda nem começou a andar.
  useEffect(() => {
    setPlaying(false);
    setBuffering(false);
    setVideoCurrentTime(0);
    setVideoDuration(0);
  }, [playbackUrl]);

  useEffect(() => {
    if (!activeSourceUrl) return;
    // Troca para um elemento JÁ pré-carregado não tem o que cronometrar: ele
    // provou que carrega. (Só no modo contínuo — o caminho antigo remonta o
    // <video> a cada URL e continua exatamente como era.)
    const preloadedVideo = videoRef.current;
    if (vodActive && preloadedVideo && preloadedVideo.readyState >= 3) {
      playbackReadyRef.current = true;
      return;
    }
    playbackReadyRef.current = false;
    const timeout = window.setTimeout(() => {
      if (playbackReadyRef.current) return;
      // No modo contínuo, demora demais = devolve o segmento ao caminho antigo,
      // que sabe negociar a versão compatível.
      if (vodActive) {
        lastVideoPlayheadRef.current = null;
        autoResumeRef.current = true;
        setVodFallback(true);
        return;
      }
      if (!playbackMayUseCompatible) {
        // Estourar o prazo é sintoma de REDE, não de codec: transcodificar um
        // arquivo bom multiplicava o custo (CPU do servidor + download novo) e
        // o operador esperava minutos. Rede lenta ganha UMA retentativa da
        // mesma fonte; codec incompatível continua indo para o compatível
        // pela via certa (diagnóstico/erro de decodificação).
        if (slowRetryRef.current !== activeSourceUrl) {
          slowRetryRef.current = activeSourceUrl;
          setVideoError('A conexão está lenta — tentando carregar de novo…');
          lastVideoPlayheadRef.current = null;
          autoResumeRef.current = true;
          setReloadNonce((current) => current + 1);
          return;
        }
        setVideoError('A conexão continua lenta demais para este vídeo. Ele segue tentando carregar; verifique a rede.');
        return;
      }
      setVideoError('A transcodificação para modo compatível demorou mais que o esperado. Isso ocorre na primeira reprodução de vídeos HEVC (H.265). Aguarde e tente novamente — o arquivo já pode estar sendo processado.');
    }, playbackMayUseCompatible ? PLAYBACK_TIMEOUT_COMPAT_MS : PLAYBACK_TIMEOUT_DIRECT_MS);

    return () => window.clearTimeout(timeout);
  }, [activeSourceUrl, playbackMayUseCompatible, vodActive]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const rate = Number(speed.replace('x', ''));
    video.playbackRate = Number.isFinite(rate) ? rate : 1;
  }, [speed, activeSourceUrl]);

  // Vigia de STALL: reprodução em curso cujo relógio parou de andar por 20s é
  // rede/token morto, não pausa. Uma retentativa automática por fonte, pelo
  // mesmo caminho do botão "Tentar novamente" (token novo, elemento remontado,
  // posição preservada pelo playhead); persiste o problema, o botão continua lá.
  useEffect(() => {
    let ultimo = { tempo: -1, em: Date.now() };
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || !activeSourceUrl) return;
      if (video.paused || video.ended || video.seeking) {
        ultimo = { tempo: video.currentTime, em: Date.now() };
        return;
      }
      if (video.currentTime !== ultimo.tempo) {
        ultimo = { tempo: video.currentTime, em: Date.now() };
        return;
      }
      if (Date.now() - ultimo.em < 20_000) return;
      if (stallRetryRef.current === activeSourceUrl) return;
      stallRetryRef.current = activeSourceUrl;
      ultimo = { tempo: video.currentTime, em: Date.now() };
      setVideoError('O vídeo parou de receber dados — reconectando…');
      lastVideoPlayheadRef.current = null;
      autoResumeRef.current = true;
      setVodFallback(true);
      setReloadNonce((current) => current + 1);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeSourceUrl]);

  const syncVideoToPlayhead = useCallback(() => {
    if (!videoRef.current || pendingSeekSeconds == null) return;
    videoRef.current.currentTime = pendingSeekSeconds;
    setPendingSeekSeconds(null);
  }, [pendingSeekSeconds]);

  // Seek dentro do MESMO segmento: quando o clique na timeline não troca de gravação,
  // não há novo onLoadedMetadata — aplica o seek pendente direto no vídeo já carregado.
  // GUARDA: ao trocar de gravação, o <video> antigo ainda está montado enquanto a URL
  // nova é buscada; sem conferir se o vídeo atual É a gravação selecionada, o seek era
  // aplicado no vídeo ERRADO e consumia o auto-resume antes da hora (segmento novo
  // carregava pausado).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || pendingSeekSeconds == null) return;
    // Mesma guarda nos dois modos: só busca no vídeo que JÁ é o da gravação
    // selecionada (no modo contínuo quem diz isso é o slot ativo).
    const sourceMatchesSelection = vodActive
      ? activeVodSource?.recordingId === selectedRecordingId
      : Boolean(playbackUrl && selectedRecordingId && playbackUrl.includes(selectedRecordingId));
    if (!sourceMatchesSelection) return;
    if (video.readyState < 1) return; // vídeo novo: onLoadedMetadata aplica via syncVideoToPlayhead
    video.currentTime = pendingSeekSeconds;
    setPendingSeekSeconds(null);
    if (autoResumeRef.current) {
      autoResumeRef.current = false;
      void video.play().catch(() => {});
    }
  }, [activeVodSource?.recordingId, pendingSeekSeconds, playbackUrl, selectedRecordingId, vodActive]);

  const currentTime = addMinutes(dayStart, playhead);
  // A janela visível da timeline é independente do playhead: centrada em viewCenter,
  // que o usuário controla (scroll = zoom ancorado no cursor, arrastar = mover) e que
  // volta a seguir o playhead quando ele sai da área visível.
  // Mesma conta de sempre, agora em ../lib/timeline-window (pura e testada): é
  // ela que define o que a régua desenha E o que a página precisa buscar.
  const visibleWindow = computeVisibleWindow({ zoom, viewCenter });
  const zoomedWindow = visibleWindow.windowMins;
  const viewStart = visibleWindow.start;
  const viewEnd = visibleWindow.end;

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // A janela mudou (zoom/panorâmica/salto): busca o DETALHE do que falta nela.
  // Debounce para o arraste não pedir dados a cada pixel; faixa já carregada ou
  // em voo não é pedida de novo. Falhar aqui não estraga a régua — o esqueleto
  // do resumo continua desenhado e a próxima mexida tenta outra vez.
  useEffect(() => {
    if (!WINDOWED_TIMELINE || windowedFallback) return;
    if (!accessToken || !selectedCamId || !selectedDate) return;
    // Enquanto a carga inicial do dia não terminou, quem manda é ela (senão
    // pediríamos a janela da câmera ANTERIOR, que ainda está na tela).
    if (loadingRecordings || !dayCoverage.length) return;
    const key = `${selectedCamId}|${selectedDate}`;
    if (loadKeyRef.current !== key) return;
    const dayStartMs = new Date(`${selectedDate}T00:00:00`).getTime();
    // O detalhe segue o CENTRO do que está na tela, com orçamento — numa visão de
    // 24h ninguém distingue segmento de 5 min, e o esqueleto já mostra onde há vídeo.
    const visible = limitWindowAround({
      window: { start: viewStart, end: viewEnd },
      center: (viewStart + viewEnd) / 2,
      maxMinutes: WINDOW_MAX_DETAIL_MINUTES,
    });
    const timer = globalThis.setTimeout(() => {
      const recordingPlan = planWindowFetch({
        window: visible,
        loaded: reservedRangesRef.current,
        padMinutes: WINDOW_PAD_MINUTES,
        lookbackMinutes: WINDOW_LOOKBACK_MINUTES,
      });
      if (recordingPlan.length) {
        void loadRecordingRanges(recordingPlan, key, dayStartMs, selectedCamId).catch(() => {
          // A faixa volta a ficar livre; o operador tenta de novo só mexendo a régua.
        });
      }
      const eventPlan = planWindowFetch({
        window: visible,
        loaded: reservedEventRangesRef.current,
        padMinutes: WINDOW_PAD_MINUTES,
      });
      if (eventPlan.length) {
        void loadEventRanges(eventPlan, key, dayStartMs, selectedCamId).catch(() => {
          eventsFallbackRef.current?.();
        });
      }
    }, WINDOW_FETCH_DEBOUNCE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [
    accessToken,
    dayCoverage.length,
    loadEventRanges,
    loadRecordingRanges,
    loadingRecordings,
    selectedCamId,
    selectedDate,
    viewEnd,
    viewStart,
    windowedFallback,
  ]);

  useEffect(() => {
    setViewCenter((center) => {
      const windowMins = TOTAL_MINS / zoom;
      const start = clamp(center - windowMins / 2, 0, TOTAL_MINS - windowMins);
      const margin = windowMins * 0.05;
      if (playhead >= start + margin && playhead <= start + windowMins - margin) return center;
      return playhead;
    });
  }, [playhead, zoom]);

  // Zoom com a roda do mouse, sempre centrado no PONTEIRO de reprodução: ao
  // aproximar/afastar, o indicador continua no centro e as gravações não "fogem"
  // para o lado. Listener manual não-passivo: o onWheel do React não garante
  // preventDefault (a página rolaria junto).
  const handleTimelineWheelZoom = useCallback((event: globalThis.WheelEvent) => {
    const el = timelineTrackRef.current;
    if (!el) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.35 : 1 / 1.35;
    const nextZoom = clamp(zoom * factor, 1, TIMELINE_MAX_ZOOM);
    // Âncora no CURSOR: o minuto sob o mouse fica parado enquanto a escala
    // muda — é o que o title da régua sempre prometeu. Recentrar no playhead
    // fazia o trecho que o operador estava mirando "fugir" da tela.
    const rect = el.getBoundingClientRect();
    const janelaAtual = TOTAL_MINS / zoom;
    const janelaNova = TOTAL_MINS / nextZoom;
    const fracao = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0.5;
    const cursorMin = viewCenter - janelaAtual / 2 + fracao * janelaAtual;
    const novoCentro = cursorMin + (0.5 - fracao) * janelaNova;
    setZoom(nextZoom);
    setViewCenter(clamp(novoCentro, janelaNova / 2, TOTAL_MINS - janelaNova / 2));
  }, [viewCenter, zoom]);

  useEffect(() => {
    const el = timelineTrackRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleTimelineWheelZoom, { passive: false });
    return () => el.removeEventListener('wheel', handleTimelineWheelZoom);
  }, [handleTimelineWheelZoom]);

  const onTimelinePanStart = useCallback((event: MouseEvent<HTMLDivElement>) => {
    timelinePanRef.current = { startX: event.clientX, startCenter: viewCenter, windowMins: zoomedWindow, moved: false };
    timelineDraggedRef.current = false;
  }, [viewCenter, zoomedWindow]);

  useEffect(() => {
    const onMove = (event: globalThis.MouseEvent) => {
      const pan = timelinePanRef.current;
      const el = timelineTrackRef.current;
      if (!pan || !el) return;
      const dx = event.clientX - pan.startX;
      if (!pan.moved && Math.abs(dx) < 5) return;
      pan.moved = true;
      timelineDraggedRef.current = true;
      const deltaMins = (dx / el.getBoundingClientRect().width) * pan.windowMins;
      setViewCenter(clamp(pan.startCenter - deltaMins, pan.windowMins / 2, TOTAL_MINS - pan.windowMins / 2));
    };
    const onUp = () => {
      if (timelinePanRef.current?.moved) {
        // O click dispara logo após o mouseup; limpa a flag só no próximo tick para
        // que o clique que encerrou o arraste não seja tratado como seek.
        window.setTimeout(() => {
          timelineDraggedRef.current = false;
        }, 0);
      }
      timelinePanRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const setViewCenterFromMinimap = useCallback((minuto: number) => {
    setViewCenter((atual) => {
      const janela = TOTAL_MINS / Math.max(1, zoomRef.current);
      const limite = janela / 2;
      const alvo = clamp(minuto, limite, TOTAL_MINS - limite);
      return Math.abs(alvo - atual) < 0.01 ? atual : alvo;
    });
  }, []);

  const setPlayheadFromMinute = useCallback((minute: number) => {
    // Navegação explícita do usuário: libera a re-seleção de segmento e retoma a
    // reprodução assim que o vídeo estiver pronto (comportamento padrão de VMS).
    lastVideoPlayheadRef.current = null;
    autoResumeRef.current = true;
    // O nonce garante a re-seleção mesmo quando o minuto clicado É o atual:
    // setPlayhead(mesmo valor) não re-renderiza e o efeito de seleção nunca
    // rodava — clique "no lugar onde estou" não fazia nada.
    setNavNonce((n) => n + 1);
    setPlayhead(clamp(minute, 0, TOTAL_MINS));
  }, []);

  const jumpToExactTime = useCallback(() => {
    const raw = jumpTime.trim();
    const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
      toast({ title: 'Hora inválida', description: 'Use o formato HH:mm ou HH:mm:ss.', variant: 'destructive' });
      return;
    }
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    const ss = Number(match[3] ?? '0');
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) {
      toast({ title: 'Hora inválida', description: 'Valores fora do intervalo válido.', variant: 'destructive' });
      return;
    }
    const minute = hmsToMinute(hh, mm, ss);
    setPlayheadFromMinute(minute);
  }, [jumpTime, setPlayheadFromMinute]);

  const toggleCompareCamera = useCallback((cameraId: string) => {
    if (cameraId === selectedCamId) return;
    setCompareCameraIds((current) => {
      if (current.includes(cameraId)) return current.filter((id) => id !== cameraId);
      return [...current, cameraId].slice(0, 3);
    });
  }, [selectedCamId]);

  const onTimelineClick = (clientX: number, rect: DOMRect) => {
    if (timelineDraggedRef.current) return; // fim de arraste (pan), não é seek
    const pct = (clientX - rect.left) / rect.width;
    const minute = viewStart + pct * (viewEnd - viewStart);
    setPlayheadFromMinute(minute);
  };

  const onTimelineHover = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (timelinePanRef.current?.moved) { setTimelineHover(null); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const pct = clamp(x / rect.width, 0, 1);
    const minute = viewStart + pct * (viewEnd - viewStart);
    // Encontra a gravação sob o cursor (para mostrar a miniatura daquele trecho).
    const rec = recordings.find((item) => {
      const start = minuteOfDay(item.startedAt);
      const end = minuteOfDay(item.endedAt ?? item.startedAt);
      return minute >= start && minute <= end && (item.fileUsable ?? item.fileExists);
    });
    // Aquece o meta do sprite da gravação sob o cursor (varredura fina no hover).
    if (rec?.id) ensurePreviewMeta(rec.id);
    setTimelineHover({ x, minute, recordingId: rec?.id ?? null });
  }, [viewStart, viewEnd, recordings, ensurePreviewMeta]);

  // 2.9 — o tile do sprite correspondente ao instante sob o cursor. Só existe
  // quando temos meta (sprite disponível) E token da gravação; senão o render cai
  // no fallback da miniatura estática (comportamento anterior).
  const hoverSpriteTile = useMemo(() => {
    const recordingId = timelineHover?.recordingId;
    if (!recordingId) return null;
    const meta = previewMetaByRecordingId[recordingId];
    const token = thumbnailTokens[recordingId];
    if (!meta || !token) return null;
    const rec = recordings.find((item) => item.id === recordingId);
    if (!rec) return null;
    const offset = recordingOffsetSeconds(timelineHover.minute, minuteOfDay(rec.startedAt));
    const { backgroundSize, backgroundPosition } = spriteTileStyle(meta, offset);
    const url = `${API_URL}/recordings/${encodeURIComponent(recordingId)}/preview-sprite?token=${encodeURIComponent(token)}`;
    return { backgroundImage: `url(${url})`, backgroundSize, backgroundPosition, backgroundRepeat: 'no-repeat' as const };
  }, [timelineHover, previewMetaByRecordingId, thumbnailTokens, recordings]);

  // VIRTUALIZAÇÃO DA RÉGUA: só os trechos que caem na janela vão para o DOM.
  // Trecho PARCIALMENTE visível ENTRA (a lib garante) — sumir com gravação da
  // linha do tempo esconderia prova.
  const visibleTimelineSegments = useMemo(
    () => sliceVisibleSpans(timelineSegments, { start: viewStart, end: viewEnd }),
    [timelineSegments, viewStart, viewEnd],
  );

  // ESQUELETO: onde o resumo do dia diz que HÁ vídeo mas o detalhe ainda não
  // chegou. Desenhado apagado, sem captura de clique (o clique na faixa continua
  // sendo "posicionar aqui"). Sem resumo utilizável, a lista é vazia e a régua
  // fica exatamente como era.
  const skeletonSpans = useMemo(() => {
    if (!WINDOWED_TIMELINE || windowedFallback || !dayCoverage.length) return [];
    const pending = dayCoverage
      .flatMap((span) => subtractRanges(span, loadedRanges))
      .sort((a, b) => a.start - b.start);
    return sliceVisibleSpans(pending, { start: viewStart, end: viewEnd }).items;
  }, [dayCoverage, loadedRanges, viewEnd, viewStart, windowedFallback]);

  // VIRTUALIZAÇÃO DA LISTA (painel da direita): linhas de altura fixa, só as que
  // cabem na área rolável vão para o DOM. Abaixo do limiar (ou enquanto a altura
  // não foi medida) a lib devolve a lista inteira — o render de hoje.
  const orderedRecordings = useMemo(() => [...recordings].reverse(), [recordings]);
  const listWindow = useMemo(() => computeListWindow({
    itemCount: orderedRecordings.length,
    rowHeightPx: RECORDING_ROW_HEIGHT_PX,
    scrollTopPx: listMetrics.scrollTopPx,
    viewportHeightPx: listMetrics.viewportHeightPx,
    overscanRows: 6,
    minItemsToVirtualize: RECORDING_LIST_VIRTUALIZE_MIN,
  }), [listMetrics.scrollTopPx, listMetrics.viewportHeightPx, orderedRecordings.length]);
  const visibleRecordingRows = useMemo(
    () => orderedRecordings.slice(listWindow.startIndex, listWindow.endIndex),
    [listWindow.endIndex, listWindow.startIndex, orderedRecordings],
  );

  const syncRecordingListMetrics = useCallback(() => {
    const element = recordingListRef.current;
    if (!element) return;
    setListMetrics((current) => (
      current.scrollTopPx === element.scrollTop && current.viewportHeightPx === element.clientHeight
        ? current
        : { scrollTopPx: element.scrollTop, viewportHeightPx: element.clientHeight }
    ));
  }, []);

  // A rolagem dispara dezenas de eventos por segundo: mede uma vez por quadro
  // (mesma disciplina do virtualizador do Frigate).
  const onRecordingListScroll = useCallback(() => {
    if (listScrollFrameRef.current != null) return;
    listScrollFrameRef.current = window.requestAnimationFrame(() => {
      listScrollFrameRef.current = null;
      syncRecordingListMetrics();
    });
  }, [syncRecordingListMetrics]);

  useEffect(() => {
    syncRecordingListMetrics();
    window.addEventListener('resize', syncRecordingListMetrics);
    return () => {
      window.removeEventListener('resize', syncRecordingListMetrics);
      if (listScrollFrameRef.current != null) {
        window.cancelAnimationFrame(listScrollFrameRef.current);
        listScrollFrameRef.current = null;
      }
    };
  }, [orderedRecordings.length, syncRecordingListMetrics]);

  // ── TOKEN DE MINIATURA (só para o que está visível) ───────────────────────
  // Antes a página emitia token para TODAS as gravações do dia (lotes de 100)
  // antes de mostrar qualquer coisa. Agora: régua visível + lista visível + os
  // fixos (selecionada, última do dia para o pôster, a que está sob o cursor).
  const thumbnailCandidateIds = useMemo(() => {
    const ids: string[] = [];
    for (const segment of visibleTimelineSegments.items) {
      if (segment.recordingId) ids.push(segment.recordingId);
    }
    for (const item of visibleRecordingRows) ids.push(item.id);
    if (selectedRecordingId) ids.push(selectedRecordingId);
    if (timelineHover?.recordingId) ids.push(timelineHover.recordingId);
    const lastOfDay = recordings.length ? recordings[recordings.length - 1].id : null;
    if (lastOfDay) ids.push(lastOfDay);
    return [...new Set(ids)];
  }, [recordings, selectedRecordingId, timelineHover?.recordingId, visibleRecordingRows, visibleTimelineSegments]);

  useEffect(() => {
    if (!accessToken || !thumbnailCandidateIds.length) return;
    let cancelled = false;
    // Debounce: durante o arraste da régua o conjunto visível muda a cada quadro;
    // sem isso sairia um POST por pixel.
    const timer = globalThis.setTimeout(() => {
      const targets = selectThumbnailTargets({
        visibleIds: thumbnailCandidateIds,
        issuedAtMs: thumbnailIssuedAtRef.current,
        nowMs: Date.now(),
        max: THUMBNAIL_BATCH,
      });
      if (!targets.length) return;
      void client.post<Record<string, string>>('/recordings/thumbnail-tokens', { recordingIds: targets })
        .then(({ data }) => {
          if (cancelled) return;
          const tokens = data && typeof data === 'object' ? data : {};
          const issuedAt = Date.now();
          const nextIssued = { ...thumbnailIssuedAtRef.current };
          const urls: Record<string, string> = {};
          for (const [recordingId, token] of Object.entries(tokens)) {
            urls[recordingId] = `${API_URL}/recordings/${encodeURIComponent(recordingId)}/thumbnail?token=${encodeURIComponent(token)}`;
            nextIssued[recordingId] = issuedAt;
          }
          thumbnailIssuedAtRef.current = nextIssued;
          // Funde: quem já tinha miniatura não a perde ao sair da janela.
          setThumbnailTokens((current) => ({ ...current, ...tokens }));
          setThumbnailUrls((current) => ({ ...current, ...urls }));
        })
        .catch(() => {
          // Mantém as URLs anteriores durante falhas transitórias. Se expirarem,
          // o onError da <img> agenda uma nova emissão.
        });
    }, 150);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [accessToken, client, thumbnailCandidateIds, thumbnailRefreshNonce]);

  // ── DIAGNÓSTICO (só do que está visível, e uma vez por gravação) ──────────
  // Serve para dois cliques: o segmento na régua e a linha na lista — os dois só
  // acontecem sobre item VISÍVEL. Antes pedia as 80 PRIMEIRAS gravações do dia,
  // que numa câmera movimentada nem eram as que o operador estava vendo.
  useEffect(() => {
    if (!accessToken || !thumbnailCandidateIds.length) return;
    const pending = thumbnailCandidateIds.filter((id) => !diagnosticsRequestedRef.current.has(id)).slice(0, 80);
    if (!pending.length) return;
    let cancelled = false;
    const timer = globalThis.setTimeout(() => {
      for (const id of pending) diagnosticsRequestedRef.current.add(id);
      void client.post<{ items: RecordingDiagnosticsSummary[] }>('/recordings/diagnostics/bulk', { recordingIds: pending, includeIntegrity: false })
        .then(({ data }) => {
          if (cancelled) return;
          const map: Record<string, RecordingDiagnostics> = {};
          for (const entry of Array.isArray(data.items) ? data.items : []) {
            if (entry?.recordingId && entry?.diagnostics) {
              map[entry.recordingId] = entry.diagnostics;
            }
          }
          setDiagnosticsByRecordingId((current) => ({ ...current, ...map }));
        })
        .catch(() => {
          // Sem diagnóstico o playback segue: o modo compatível ainda é ligado
          // pelo fallback automático de erro/timeout do player.
          for (const id of pending) diagnosticsRequestedRef.current.delete(id);
        });
    }, 300);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [accessToken, client, thumbnailCandidateIds]);

  // PALETA. Regra que vale mais que gosto: VERMELHO É SÓ ALARME. O "defeito"
  // era `hsl(0,48%,36%)` — vermelho escuro que, no canto do olho, o operador lê
  // como alarme e vai conferir à toa. Vira cinza-arroxeado com hachura (a
  // textura carrega o significado mesmo para quem não distingue a cor: ~8% dos
  // homens têm alguma deficiência de visão de cor).
  // Verde para gravação segue a escola Dahua/Synology, já é o hábito da equipe,
  // e deixa toda a família quente livre para severidade (âmbar → vermelho).
  const getSegmentColor = (type: TimelineSegment['type']) => {
    if (type === 'recorded') return 'hsl(152,55%,34%)';
    if (type === 'recorded_broken') return 'hsl(280,12%,34%)';
    if (type === 'motion') return 'hsl(38,92%,50%)';
    if (type === 'alarm') return 'hsl(0,75%,52%)';
    return 'hsl(222,14%,15%)';
  };
  const HACHURA_DEFEITO = 'repeating-linear-gradient(45deg, hsl(0,35%,42%) 0 3px, hsl(280,12%,30%) 3px 6px)';

  // Lê a posição atual do vídeo no momento da ação (evita ler o ref durante o render).
  const ticksDaRegua = useMemo(() => {
    const granularidade = escolherGranularidade(viewEnd - viewStart, timelineWidthPx);
    return { granularidade, ticks: gerarTicks(viewStart, viewEnd, granularidade) };
  }, [viewStart, viewEnd, timelineWidthPx]);

  // Minimapa: o dia INTEIRO, sempre na mesma escala — é a âncora estável que
  // diz "onde estou" quando a faixa detalhada está com zoom de 7 minutos.
  // Agregado em buckets (não por segmento): 12.000 gravações viram 12.000 nós
  // de DOM e o pan trava.
  const minimapaBuckets = useMemo(
    () => agregarMinimapa(timelineSegments as Array<{ start: number; end: number; type: string }>, TOTAL_MINS, 720),
    [timelineSegments],
  );

  // Instantes de evento (movimento/alarme) para o salto ‹ › e as teclas N/P.
  const instantesDeEvento = useMemo(
    () => timelineSegments
      .filter((s) => s.type === 'motion' || s.type === 'alarm')
      .map((s) => (s.start + s.end) / 2)
      .sort((a, b) => a - b),
    [timelineSegments],
  );
  const irParaEvento = useCallback((direcao: 1 | -1) => {
    if (!instantesDeEvento.length) {
      toast({ title: 'Sem eventos neste dia', description: 'Não há movimento ou alarme registrado para navegar.' });
      return;
    }
    const alvo = direcao > 0
      ? instantesDeEvento.find((m) => m > playhead + 0.05)
      : [...instantesDeEvento].reverse().find((m) => m < playhead - 0.05);
    if (alvo == null) {
      toast({ title: direcao > 0 ? 'Último evento do dia' : 'Primeiro evento do dia' });
      return;
    }
    setPlayheadFromMinute(alvo);
  }, [instantesDeEvento, playhead, setPlayheadFromMinute]);

  // Atalhos JKL — a convenção de TODO software de vídeo profissional (e do
  // Milestone/Genetec). Sem eles, revisar horas de gravação é só mouse.
  // Ignorados enquanto o foco está num campo, senão digitar "n" numa busca
  // saltaria de evento.
  useEffect(() => {
    const aoTeclar = (event: globalThis.KeyboardEvent) => {
      const alvo = event.target as HTMLElement | null;
      if (alvo && /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const video = videoRef.current;
      const tecla = event.key.toLowerCase();
      const passoMin = event.shiftKey ? 1 : 1 / 6; // Shift = 1 min, senão 10s
      if (tecla === ' ' || tecla === 'k') {
        event.preventDefault();
        if (video) { if (video.paused) void video.play().catch(() => {}); else video.pause(); }
      } else if (tecla === 'arrowleft' || tecla === 'j') {
        event.preventDefault();
        setPlayheadFromMinute(playhead - (tecla === 'j' ? 1 : passoMin));
      } else if (tecla === 'arrowright' || tecla === 'l') {
        event.preventDefault();
        setPlayheadFromMinute(playhead + (tecla === 'l' ? 1 : passoMin));
      } else if (tecla === 'n') {
        event.preventDefault(); irParaEvento(1);
      } else if (tecla === 'p') {
        event.preventDefault(); irParaEvento(-1);
      } else if (tecla === 'home') {
        event.preventDefault(); setPlayheadFromMinute(0);
      } else if (tecla === 'end') {
        event.preventDefault(); setPlayheadFromMinute(TOTAL_MINS - 1);
      } else if (tecla === '+' || tecla === '=') {
        event.preventDefault(); setZoom((z) => clamp(z * 1.5, 1, TIMELINE_MAX_ZOOM));
      } else if (tecla === '-') {
        event.preventDefault(); setZoom((z) => clamp(z / 1.5, 1, TIMELINE_MAX_ZOOM));
      }
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [irParaEvento, playhead, setPlayheadFromMinute]);

  const getCurrentVideoSeconds = useCallback(
    () => videoRef.current?.currentTime ?? pendingSeekSeconds ?? 0,
    [pendingSeekSeconds],
  );
  const selectedRecordingDuration = selectedRecording?.durationSeconds ?? 0;
  const selectedRecordingStartLabel = selectedRecording ? format(new Date(selectedRecording.startedAt), 'HH:mm:ss') : '--';
  const selectedRecordingEndLabel = selectedRecording?.endedAt ? format(new Date(selectedRecording.endedAt), 'HH:mm:ss') : '--';

  const usableRecordingIds = useMemo(
    () => recordings.filter((item) => item.fileUsable ?? item.fileExists).map((item) => item.id),
    [recordings],
  );
  const allUsableSelected = usableRecordingIds.length > 0 && usableRecordingIds.every((id) => selectedForZip.has(id));

  const toggleZipSelection = useCallback((recordingId: string) => {
    setSelectedForZip((current) => {
      const next = new Set(current);
      if (next.has(recordingId)) next.delete(recordingId);
      else if (next.size >= ZIP_MAX_RECORDINGS) {
        toast({ title: 'Limite de seleção', description: `Máximo de ${ZIP_MAX_RECORDINGS} gravações por ZIP.`, variant: 'destructive' });
        return current;
      } else next.add(recordingId);
      return next;
    });
  }, []);

  const toggleSelectAllForZip = useCallback(() => {
    setSelectedForZip((current) => {
      if (usableRecordingIds.length && usableRecordingIds.every((id) => current.has(id))) return new Set();
      const capped = usableRecordingIds.slice(0, ZIP_MAX_RECORDINGS);
      if (usableRecordingIds.length > ZIP_MAX_RECORDINGS) {
        toast({ title: 'Seleção limitada', description: `Selecionadas as ${ZIP_MAX_RECORDINGS} primeiras gravações (limite por ZIP).` });
      }
      return new Set(capped);
    });
  }, [usableRecordingIds]);

  // Limpa a seleção ao trocar câmera/data e remove ids que saíram da lista.
  useEffect(() => {
    setSelectedForZip(new Set());
  }, [selectedCamId, selectedDate]);
  useEffect(() => {
    setSelectedForZip((current) => {
      if (!current.size) return current;
      const valid = new Set(recordings.map((item) => item.id));
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [recordings]);

  const downloadSelectedAsZip = useCallback(async () => {
    if (!accessToken || !selectedForZip.size) return;
    setDownloadingZip(true);
    try {
      const recordingIds = [...selectedForZip].slice(0, ZIP_MAX_RECORDINGS);
      const { data } = await client.post<{ downloadUrl: string; count: number }>(
        '/recordings/download-batch-token',
        { recordingIds },
      );
      // Link direto com token: o navegador baixa em streaming, com progresso nativo,
      // sem montar o ZIP inteiro na memória da página.
      const anchor = document.createElement('a');
      anchor.href = `${API_URL}${data.downloadUrl}`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast({ title: 'Download iniciado', description: `Baixando ${data.count} gravação(ões) em um único arquivo ZIP.` });
    } catch (error) {
      const forbidden = axios.isAxiosError(error) && error.response?.status === 403;
      toast({
        title: 'Falha ao baixar ZIP',
        description: forbidden
          ? 'Seu usuário não tem permissão para exportar gravações (exportar evidências).'
          : error instanceof Error ? error.message : 'Não foi possível preparar o download em lote.',
        variant: 'destructive',
      });
    } finally {
      setDownloadingZip(false);
    }
  }, [accessToken, client, selectedForZip]);

  const handleDownload = async (recording = selectedRecording) => {
    if (!recording || !selectedCam || !accessToken) return;
    setDownloadingRecordingId(recording.id);
    try {
      await downloadRecording(recording.id, selectedCam.code, accessToken);
    } catch (error) {
      toast({
        title: 'Falha no download',
        description: error instanceof Error ? error.message : 'Não foi possível baixar a gravação selecionada.',
        variant: 'destructive',
      });
    } finally {
      setDownloadingRecordingId(null);
    }
  };

  const prepareCompatiblePlayback = useCallback(async () => {
    if (!selectedRecording || !accessToken) return;
    setPreparingCompatibleId(selectedRecording.id);
    try {
      const { data } = await client.post<{ diagnostics?: RecordingDiagnostics }>(
        `/recordings/${selectedRecording.id}/compatible/prepare`,
        {},
        { timeout: 180000 },
      );
      if (data.diagnostics) {
        setDiagnosticsByRecordingId((current) => ({
          ...current,
          [selectedRecording.id]: data.diagnostics!,
        }));
      }
      setRecordings((current) => current.map((item) => (
        item.id === selectedRecording.id ? { ...item, compatibleCached: true } : item
      )));
      setCompatMode(true);
      setReloadNonce((current) => current + 1);
      toast({ title: 'Reprodução compatível pronta', description: 'A gravação foi preparada para reprodução no navegador.' });
    } catch (error) {
      toast({
        title: 'Falha ao preparar reprodução',
        description: error instanceof Error ? error.message : 'Não foi possível preparar a gravação compatível.',
        variant: 'destructive',
      });
    } finally {
      setPreparingCompatibleId(null);
    }
  }, [accessToken, client, selectedRecording]);

  const exportClip = useCallback(async () => {
    if (!selectedRecording || !accessToken) return;
    if (clipStartSeconds == null || clipEndSeconds == null) {
      toast({ title: 'Marque o intervalo', description: 'Defina o início e o fim do clipe antes de exportar.', variant: 'destructive' });
      return;
    }
    if (clipEndSeconds <= clipStartSeconds) {
      toast({ title: 'Intervalo inválido', description: 'O fim do clipe precisa ser maior que o início.', variant: 'destructive' });
      return;
    }

    setExportingClip(true);
    try {
      const { data } = await client.post<ExportedClip>(`/recordings/${selectedRecording.id}/clips/export`, {
        startSeconds: Math.floor(clipStartSeconds),
        endSeconds: Math.ceil(clipEndSeconds),
        investigationId: selectedInvestigationId === '__none__' ? undefined : selectedInvestigationId,
        label: `Clipe - ${selectedCam?.name ?? 'Câmera'}`,
        notes: `Exportado da reprodução em ${new Date().toISOString()}`,
      });
      setLastExportedClip(data);
      toast({
        title: 'Clipe exportado',
        description: data.investigationItemId ? 'O clipe foi exportado e anexado ao caso.' : 'O clipe foi exportado com sucesso.',
      });
    } catch (error) {
      toast({
        title: 'Falha ao exportar clipe',
        description: error instanceof Error ? error.message : 'Não foi possível exportar o clipe.',
        variant: 'destructive',
      });
    } finally {
      setExportingClip(false);
    }
  }, [accessToken, clipEndSeconds, clipStartSeconds, client, selectedCam?.name, selectedInvestigationId, selectedRecording]);

  const saveBookmark = useCallback(async () => {
    if (selectedInvestigationId === '__none__') {
      toast({ title: 'Selecione um caso', description: 'Escolha um caso para salvar o marcador.', variant: 'destructive' });
      return;
    }
    if (!selectedRecording || !selectedCam) return;
    const ts = new Date(new Date(selectedRecording.startedAt).getTime() + Math.floor(getCurrentVideoSeconds()) * 1000);
    setSavingBookmark(true);
    try {
      await client.post(`/investigations/${selectedInvestigationId}/bookmarks`, {
        label: `Marcador ${selectedCam.name} @ ${format(ts, 'HH:mm:ss')}`,
        timestamp: ts.toISOString(),
        cameraId: selectedCam.id,
        cameraName: selectedCam.name,
        notes: 'Marcador criado na reprodução',
      });
      toast({ title: 'Marcador salvo', description: 'O marcador foi anexado à investigação.' });
    } catch (error) {
      toast({
        title: 'Falha ao salvar marcador',
        description: error instanceof Error ? error.message : 'Não foi possível salvar o marcador.',
        variant: 'destructive',
      });
    } finally {
      setSavingBookmark(false);
    }
  }, [client, getCurrentVideoSeconds, selectedCam, selectedInvestigationId, selectedRecording]);

  const resetVideoView = useCallback(() => {
    setVideoZoom(1);
    setVideoPan({ x: 0, y: 0 });
    setDraggingVideo(false);
    setDragStart(null);
  }, []);

  useEffect(() => {
    resetVideoView();
  }, [selectedRecordingId, resetVideoView]);

  const handleVideoWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaY < 0 ? 0.12 : -0.12;
    setVideoZoom((current) => clamp(Number((current + delta).toFixed(2)), 1, 6));
    if (videoZoom <= 1 && delta < 0) {
      setVideoPan({ x: 0, y: 0 });
    }
  }, [videoZoom]);

  const lockPageScroll = useCallback(() => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = 'hidden';
  }, []);

  const unlockPageScroll = useCallback(() => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = '';
  }, []);

  // Só trava o scroll da página quando há zoom (>1), para permitir o pan/arraste do
  // vídeo. Sem zoom, passar o mouse sobre o vídeo não deve impedir rolar a página.
  useEffect(() => {
    if (videoZoom > 1) lockPageScroll();
    else unlockPageScroll();
  }, [videoZoom, lockPageScroll, unlockPageScroll]);

  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = '';
      }
    };
  }, []);

  const formatClock = useCallback((totalSeconds: number) => {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
    const s = Math.floor(totalSeconds % 60);
    const m = Math.floor((totalSeconds / 60) % 60);
    const h = Math.floor(totalSeconds / 3600);
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, []);

  const seekVideoTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const clamped = clamp(seconds, 0, Number.isFinite(video.duration) ? video.duration : seconds);
    video.currentTime = clamped;
    setVideoCurrentTime(clamped);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    const next = !videoMuted;
    setVideoMuted(next);
    if (video) video.muted = next;
  }, [videoMuted]);

  const changeVolume = useCallback((value: number) => {
    const next = clamp(value, 0, 1);
    setVideoVolume(next);
    const video = videoRef.current;
    if (video) {
      video.volume = next;
      const muted = next === 0;
      video.muted = muted;
      setVideoMuted(muted);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = playerColumnRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const onVideoDragStart = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (videoZoom <= 1) return;
    setDraggingVideo(true);
    setDragStart({ x: event.clientX - videoPan.x, y: event.clientY - videoPan.y });
  }, [videoPan.x, videoPan.y, videoZoom]);

  const onVideoDragMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!draggingVideo || !dragStart || videoZoom <= 1) return;
    setVideoPan({
      x: event.clientX - dragStart.x,
      y: event.clientY - dragStart.y,
    });
  }, [dragStart, draggingVideo, videoZoom]);

  const onVideoDragEnd = useCallback(() => {
    setDraggingVideo(false);
    setDragStart(null);
  }, []);

  const selectNextUsableRecording = useCallback((failedRecordingId: string) => {
    const idx = recordings.findIndex((item) => item.id === failedRecordingId);
    if (idx < 0) return false;

    for (let next = idx + 1; next < recordings.length; next += 1) {
      const item = recordings[next];
      if (!(item.fileUsable ?? item.fileExists)) continue;
      setSelectedRecordingId(item.id);
      setPlayheadFromMinute(minuteOfDay(item.startedAt));
      setPendingSeekSeconds(0);
      return true;
    }
    for (let prev = idx - 1; prev >= 0; prev -= 1) {
      const item = recordings[prev];
      if (!(item.fileUsable ?? item.fileExists)) continue;
      setSelectedRecordingId(item.id);
      setPlayheadFromMinute(minuteOfDay(item.startedAt));
      setPendingSeekSeconds(0);
      return true;
    }
    return false;
  }, [recordings, setPlayheadFromMinute]);

  const jumpToAdjacentUsableRecording = useCallback((direction: 'prev' | 'next') => {
    if (!recordings.length || !selectedRecordingId) return;
    const idx = recordings.findIndex((item) => item.id === selectedRecordingId);
    if (idx < 0) return;
    const step = direction === 'next' ? 1 : -1;
    for (let i = idx + step; i >= 0 && i < recordings.length; i += step) {
      const item = recordings[i];
      if (!(item.fileUsable ?? item.fileExists)) continue;
      setSelectedRecordingId(item.id);
      setPlayheadFromMinute(minuteOfDay(item.startedAt));
      setPendingSeekSeconds(0);
      return;
    }
    toast({
      title: 'Sem outro segmento válido',
      description: direction === 'next' ? 'Não há próximo segmento reproduzível.' : 'Não há segmento anterior reproduzível.',
      variant: 'destructive',
    });
  }, [recordings, selectedRecordingId, setPlayheadFromMinute]);

  const confirmClipDownload = useCallback(async () => {
    if (!clipDownload || !accessToken) return;
    const reason = clipDownloadReason.trim();
    if (!reason) return;
    const target = clipDownload;
    setClipDownload(null);
    try {
      await downloadClip(target.url, target.clipId, reason, accessToken);
    } catch (error) {
      toast({
        title: 'Falha no download do clipe',
        description: error instanceof Error ? error.message : 'Não foi possível baixar o clipe.',
        variant: 'destructive',
      });
    }
  }, [accessToken, clipDownload, clipDownloadReason]);

  // O elemento ocioso (pré-carga) dispara os MESMOS eventos do que está tocando —
  // ended, error, timeupdate. Sem esta guarda, o vídeo escondido comandaria o
  // player: trocaria de segmento sozinho e jogaria a página no modo compatível.
  const isActiveVideoElement = (element: HTMLVideoElement) => element === videoRef.current;

  const renderPlayerVideo = (options: {
    elementKey: string;
    bindRef: (element: HTMLVideoElement | null) => void;
    src: string | null;
    slot: VodSlot | null;
  }) => {
    const isActive = options.slot === null || options.slot === activeSlot;
    return (
      <video
        key={options.elementKey}
        ref={options.bindRef}
        playsInline
        src={options.src ?? undefined}
        poster={isActive ? selectedThumbnailUrl ?? undefined : undefined}
        crossOrigin="use-credentials"
        // O slot ocioso existe para AQUECER o próximo arquivo: preload='auto'.
        preload={isActive ? 'metadata' : 'auto'}
        // O slot ocioso fica FORA DA VISTA, mas RENDERIZADO: `display:none` pode
        // fazer o navegador tratar a mídia como descartável e adiar a pré-carga.
        className={isActive ? 'h-full w-full bg-black object-contain' : 'pointer-events-none absolute left-0 top-0 h-px w-px opacity-0'}
        style={isActive ? { transform: `translate(${videoPan.x}px, ${videoPan.y}px) scale(${videoZoom})`, transformOrigin: 'center center' } : undefined}
        onClick={togglePlay}
        onLoadedMetadata={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          playbackReadyRef.current = true;
          const video = videoRef.current;
          if (video) {
            setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
            video.volume = videoVolume;
            video.muted = videoMuted;
          }
          syncVideoToPlayhead();
        }}
        onDurationChange={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          const video = videoRef.current;
          if (video) setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
        }}
        onVolumeChange={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          const video = videoRef.current;
          if (!video) return;
          setVideoVolume(video.volume);
          setVideoMuted(video.muted);
        }}
        onCanPlay={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          playbackReadyRef.current = true;
          setVideoError(null);
          if (autoResumeRef.current) {
            autoResumeRef.current = false;
            void videoRef.current?.play().catch(() => {});
          }
        }}
        onPlay={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          setPlaying(true);
        }}
        onPlaying={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          setPlaying(true);
          setBuffering(false);
        }}
        onWaiting={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          setBuffering(true);
        }}
        onStalled={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          setBuffering(true);
        }}
        onPause={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          // Pausa é decisão do operador: não há troca travada para vigiar.
          swapStartedAtRef.current = null;
          setPlaying(false);
          setBuffering(false);
        }}
        onEnded={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          setPlaying(false);
          // Modo contínuo: o PRÓXIMO segmento vem da playlist (ordem e duração
          // reais, já conferidas no disco). Se ele estiver pré-carregado, o efeito
          // de slots só troca de elemento — sem recarregar, sem tela preta.
          const playlist = vodActive ? vodPlaylistRef.current : null;
          const activeRecordingId = activeVodSource?.recordingId ?? null;
          if (playlist && activeRecordingId) {
            const index = playlist.segments.findIndex((item) => item.recordingId === activeRecordingId);
            const upcoming = index >= 0 ? playlist.segments[index + 1] ?? null : null;
            if (upcoming) {
              lastVideoPlayheadRef.current = null;
              autoResumeRef.current = true;
              setSelectedRecordingId(upcoming.recordingId);
              setPendingSeekSeconds(0);
              setPlayhead(clamp(minuteOfDay(new Date(upcoming.startedAtMs)), 0, TOTAL_MINS));
              return;
            }
          }
          // Continuidade: ao terminar o segmento, avança para o próximo trecho
          // utilizável do dia e continua reproduzindo automaticamente.
          const idx = recordings.findIndex((item) => item.id === selectedRecordingId);
          if (idx < 0) return;
          for (let i = idx + 1; i < recordings.length; i += 1) {
            const item = recordings[i];
            if (!(item.fileUsable ?? item.fileExists)) continue;
            lastVideoPlayheadRef.current = null;
            autoResumeRef.current = true;
            setSelectedRecordingId(item.id);
            setPendingSeekSeconds(0);
            setPlayhead(clamp(minuteOfDay(item.startedAt), 0, TOTAL_MINS));
            break;
          }
        }}
        onTimeUpdate={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          const video = videoRef.current;
          if (!video) return;
          setVideoCurrentTime(video.currentTime);
          lastProgressAtRef.current = Date.now();
          if (swapStartedAtRef.current !== null && video.currentTime > 0) swapStartedAtRef.current = null;
          const playlist = vodActive ? vodPlaylistRef.current : null;
          const activeRecordingId = activeVodSource?.recordingId ?? null;
          const index = playlist && activeRecordingId
            ? playlist.segments.findIndex((item) => item.recordingId === activeRecordingId)
            : -1;
          if (playlist && index >= 0) {
            const position = playlist.segments[index].offsetSeconds + video.currentTime;
            const absoluteMs = vodPositionToAbsoluteMs(playlist, position);
            if (absoluteMs !== null) {
              const minute = clamp(minuteOfDay(new Date(absoluteMs)), 0, TOTAL_MINS);
              lastVideoPlayheadRef.current = minute;
              setPlayhead(minute);
            }
            // Perto da virada: aquece o próximo arquivo no slot ocioso. É esta
            // pré-carga que permite a troca instantânea no fim do segmento.
            const upcoming = shouldPrefetchNextSegment(playlist, position);
            if (upcoming && isPlaybackTokenUsable(vodSegmentToken(upcoming), Date.now())) {
              setVodSlots((current) => (
                current[idleSlot]?.recordingId === upcoming.recordingId
                  ? current
                  : { ...current, [idleSlot]: { recordingId: upcoming.recordingId, url: vodSegmentUrl(upcoming) } }
              ));
            }
            return;
          }
          if (!selectedRecording) return;
          const base = minuteOfDay(selectedRecording.startedAt);
          const minute = clamp(base + video.currentTime / 60, 0, TOTAL_MINS);
          lastVideoPlayheadRef.current = minute;
          setPlayhead(minute);
        }}
        onError={(event) => {
          if (!isActiveVideoElement(event.currentTarget)) return;
          // No modo contínuo, erro devolve o segmento ao caminho antigo: é ele que
          // sabe negociar versão compatível e pular gravação quebrada.
          if (vodActive) {
            swapStartedAtRef.current = null;
            lastVideoPlayheadRef.current = null;
            autoResumeRef.current = true;
            setVodFallback(true);
            return;
          }
          void (async () => {
            // Erro do SERVIDOR (404 da nuvem, 401 de token) tem explicação no
            // corpo — e transcodificar não cura nenhum deles.
            const falha = await explicarFalhaDoVideo(activeSourceUrl);
            const falhou = selectedRecordingId ? recordingById.get(selectedRecordingId) : null;
            const quando = falhou ? format(new Date(falhou.startedAt), 'HH:mm:ss') : null;
            if (falha?.preparando) {
              // Transcode em preparo no servidor (assíncrono): mostra o aviso e
              // tenta de novo sozinho — o vídeo começa quando ficar pronto.
              setVideoError(falha.mensagem);
              const tentativas = (preparandoRetryRef.current.get(selectedRecordingId ?? '') ?? 0) + 1;
              preparandoRetryRef.current.set(selectedRecordingId ?? '', tentativas);
              if (tentativas <= 40) {
                window.setTimeout(() => setReloadNonce((current) => current + 1), 4000);
              } else {
                setVideoError('A preparação da versão compatível está demorando além do normal. Tente novamente mais tarde.');
              }
              return;
            }
            if (falha) {
              const detalhe = falha.mensagem;
              if (selectedRecordingId && !autoSkipTriedRef.current.has(selectedRecordingId)) {
                autoSkipTriedRef.current.add(selectedRecordingId);
                if (selectNextUsableRecording(selectedRecordingId)) {
                  setVideoError(`${detalhe} Avançando para o próximo trecho válido${quando ? ` (falhou o segmento das ${quando})` : ''}.`);
                  return;
                }
              }
              setVideoError(detalhe);
              return;
            }
            if (!playbackMayUseCompatible) {
              setVideoError('Falha na decodificação do vídeo. Preparando versão compatível...');
              setCompatMode(true);
              return;
            }
            if (selectedRecordingId && !autoSkipTriedRef.current.has(selectedRecordingId)) {
              autoSkipTriedRef.current.add(selectedRecordingId);
              if (selectNextUsableRecording(selectedRecordingId)) {
                setVideoError(`Segmento${quando ? ` das ${quando}` : ' atual'} falhou. Avançando automaticamente para o próximo trecho válido.`);
                return;
              }
            }
            setVideoError('Falha ao carregar a gravação selecionada, mesmo em modo compatível.');
          })();
        }}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto xl:overflow-hidden">
      <div className="toolbar">
        <Select value={selectedCamId} onValueChange={setSelectedCamId}>
          <SelectTrigger className="h-9 w-[min(100%,300px)] text-xs">
            <SelectValue placeholder="Selecione uma câmera" />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {cameras.map((camera) => (
              <SelectItem key={camera.id} value={camera.id} className="text-xs">
                {camera.code} — {camera.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <input
          type="date"
          value={selectedDate}
          onChange={(event) => setSelectedDate(event.target.value)}
          className="input"
          style={{ width: 170, height: 34, fontSize: 12 }}
        />

        <div style={{ flex: 1 }} />

        {/* Janela de zoom da timeline (presets + zoom livre pela roda do mouse) */}
        <div className="segment">
          {[
            { value: 1, label: '24h' },
            { value: 2, label: '12h' },
            { value: 4, label: '6h' },
            { value: 24, label: '1h' },
            { value: 96, label: '15m' },
          ].map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setZoom(value);
                setViewCenter(playhead);
              }}
              className={`seg-btn ${Math.abs(zoom - value) < 0.01 ? 'active' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="hidden font-mono text-[10px] text-[hsl(var(--muted-foreground))] sm:inline" title="Role o mouse sobre a timeline para dar zoom; arraste para mover">
          {zoomedWindow >= 60 ? `${(zoomedWindow / 60).toFixed(zoomedWindow % 60 === 0 ? 0 : 1)}h` : `${Math.round(zoomedWindow)}min`}
        </span>

        {/* "Ir para hora" resgatado do bloco oculto (mesmo caminho do
            Multi-câmera): operador de VMS pensa em carimbo de hora — digitar
            14:32:05 é mais rápido que caçar o instante na régua com zoom. */}
        <div className="flex items-center gap-1">
          <input
            value={jumpTime}
            onChange={(event) => setJumpTime(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') jumpToExactTime(); }}
            placeholder="HH:mm:ss"
            className="h-8 w-24 rounded-md border border-input bg-background px-2 font-mono text-xs"
            title="Ir direto para um horário exato do dia selecionado"
          />
          <Button type="button" variant="outline" size="sm" onClick={jumpToExactTime}>
            Ir para hora
          </Button>
        </div>
        {/* Estava dentro do bloco oculto acima: o modo multi-câmera existia, com
            estado e réguas, mas sem forma de o operador chegar nele. */}
        <Button
          type="button"
          variant={compareEnabled ? 'default' : 'outline'}
          size="sm"
          onClick={() => setCompareEnabled((value) => !value)}
          title="Compara até 4 câmeras no mesmo instante"
        >
          Multi-câmera
        </Button>
      </div>

      {compareEnabled && (
        <div className="rounded-lg border border-border bg-card/70 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">Reprodução multi-câmera</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))]">Até 4 câmeras sincronizadas por data e horário.</div>
            </div>
            <div className="text-xs text-[hsl(var(--muted-foreground))]">{compareCameraItems.length}/4 selecionadas</div>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            {cameras.map((camera) => {
              const active = compareCameraItems.some((item) => item.id === camera.id);
              const locked = camera.id === selectedCamId;
              return (
                <button
                  key={camera.id}
                  type="button"
                  onClick={() => toggleCompareCamera(camera.id)}
                  disabled={!locked && !active && compareCameraItems.length >= 4}
                  className={`rounded border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 ${active ? 'border-[hsl(var(--primary)_/_0.45)] bg-[hsl(var(--primary)_/_0.10)] text-[hsl(var(--primary))]' : 'border-border text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-foreground'}`}
                >
                  {camera.code || camera.name}{locked ? ' · principal' : ''}
                </button>
              );
            })}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {compareRows.map(({ camera, segments, current }) => (
              <div key={camera.id} className="rounded-lg border border-border bg-background/55 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">{camera.name}</div>
                    <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{current ? `${format(new Date(current.startedAt), 'HH:mm:ss')} - ${current.endedAt ? format(new Date(current.endedAt), 'HH:mm:ss') : '--'}` : 'Sem gravação neste horário'}</div>
                  </div>
                  <span className={`rounded px-2 py-1 text-[10px] ${current ? 'bg-[hsl(var(--status-online)_/_0.1)] text-[hsl(var(--status-online))]' : 'bg-white/5 text-[hsl(var(--muted-foreground))]'}`}>{current ? 'Disponível' : 'Vazio'}</span>
                </div>
                {/* O vídeo de cada câmera segue o mesmo instante do playhead. */}
                <div className="mb-2 aspect-video">
                  <SyncedCameraPlayer
                    cameraId={camera.id}
                    cameraName={camera.name}
                    targetAbsoluteMs={compareTargetMs}
                    masterPaused={!playing}
                    userSpeed={compareUserSpeed}
                    fetchPlaylist={fetchComparePlaylist}
                    apiUrl={API_URL}
                    forceDirect={BROWSER_PLAYS_HEVC}
                  />
                </div>
                <div className="relative h-8 overflow-hidden rounded bg-[hsl(var(--muted))]" onClick={(event) => onTimelineClick(event.clientX, event.currentTarget.getBoundingClientRect())}>
                  {sliceVisibleSpans(segments, { start: viewStart, end: viewEnd }).items.map((segment, index) => {
                    const segStart = Math.max(segment.start, viewStart);
                    const segEnd = Math.min(segment.end, viewEnd);
                    const windowSize = viewEnd - viewStart;
                    const isEventMarker = segment.type === 'motion' || segment.type === 'alarm';
                    return (
                      <div
                        key={`${camera.id}-${segment.type}-${index}-${segStart}`}
                        className={`absolute top-0 ${isEventMarker ? 'h-[35%]' : 'h-full'}`}
                        style={{
                          left: `${((segStart - viewStart) / windowSize) * 100}%`,
                          width: `${((segEnd - segStart) / windowSize) * 100}%`,
                          background: getSegmentColor(segment.type),
                          zIndex: isEventMarker ? 2 : 1,
                        }}
                      />
                    );
                  })}
                  <div className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white" style={{ left: `${((playhead - viewStart) / (viewEnd - viewStart)) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cartões de resumo removidos: referenciavam o resumo de saúde,
          cuja busca saiu da página (24 ffprobe por troca para um bloco que o
          mock escondia). Quando o cartão de saúde ganhar lugar no design, os
          dados voltam com ele. */}

      <div className="flex flex-1 flex-col gap-4 min-h-0 p-3 sm:p-4 xl:flex-row">
        <div ref={playerColumnRef} className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="relative min-h-[320px] sm:min-h-[50vh] xl:min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-[hsl(210,18%,7%)]">
            <div className="camera-scanline absolute inset-0 overflow-hidden pointer-events-none" />

            <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
              <span className="rounded bg-black/50 px-2 py-1 font-mono text-[10px] text-white/60">{selectedCam?.code ?? '—'}</span>
              <span className="rounded bg-black/50 px-2 py-1 text-[10px] text-white/65">Reprodução</span>
              {playing && <span className="rec-pulse h-2 w-2 rounded-full bg-[hsl(var(--destructive))]" />}
            </div>

            {playerActive ? (
              <div
                className={`h-full w-full overflow-hidden ${videoZoom > 1 ? (draggingVideo ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
                onWheel={handleVideoWheel}
                onWheelCapture={handleVideoWheel}
                onMouseDown={onVideoDragStart}
                onMouseMove={onVideoDragMove}
                onMouseUp={onVideoDragEnd}
                onMouseLeave={onVideoDragEnd}
                style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
              >
                {/* Modo contínuo: dois elementos vivos (um toca, o outro aquece o
                    próximo segmento). Caminho antigo: UM elemento, remontado por
                    URL, exatamente como sempre foi. */}
                {vodActive
                  ? renderPlayerVideo({ elementKey: 'vod-slot-a', bindRef: bindSlotA, src: vodSlots.a?.url ?? null, slot: 'a' })
                  : renderPlayerVideo({ elementKey: playbackUrl ?? 'legacy', bindRef: bindLegacyVideo, src: playbackUrl, slot: null })}
                {vodActive
                  ? renderPlayerVideo({ elementKey: 'vod-slot-b', bindRef: bindSlotB, src: vodSlots.b?.url ?? null, slot: 'b' })
                  : null}
              </div>
            ) : null}

            {!playerActive && !loadingPlayback && !loadingRecordings && (
              <div className="absolute inset-0 flex items-center justify-center">
                {standbyThumbnailUrl ? <img src={standbyThumbnailUrl} onError={retryExpiredThumbnails} alt="Prévia da gravação" className="absolute inset-0 h-full w-full object-cover opacity-60" /> : null}
                {standbyThumbnailUrl ? <div className="absolute inset-0 bg-black/35" /> : null}
                <div className="text-center">
                  {recordings.length ? <CameraIcon className="mx-auto mb-2 h-10 w-10 text-white/10" /> : <VideoOff className="mx-auto mb-2 h-10 w-10 text-white/10" />}
                  <div className="text-xs text-white/30">
                    {recordings.length ? 'Selecione um ponto da timeline' : 'Sem gravações nesta data'}
                  </div>
                </div>
              </div>
            )}

            {buffering && playerActive && !videoError && !loadingPlayback && !loadingRecordings && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/55 px-3 py-2 text-xs text-white/80">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Carregando vídeo…
                </div>
              </div>
            )}

            {(loadingPlayback || loadingRecordings) && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/55 px-3 py-2 text-xs text-white/80">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  {loadingRecordings ? 'Carregando gravações do dia' : compatMode && selectedRecording && !selectedRecording.compatibleCached ? 'Preparando gravação compatível' : 'Carregando gravação'}
                </div>
              </div>
            )}

            {videoError && !loadingPlayback && !loadingRecordings && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/55">
                <div className="rounded-lg border border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.1)] px-4 py-3 text-center text-xs text-[hsl(var(--destructive))]">
                  <div>{videoError}</div>
                  <button
                    type="button"
                    onClick={() => {
                      playbackReadyRef.current = false;
                      setVideoError(null);
                      // Retentar é sempre pelo caminho antigo (token novo, URL
                      // nova, elemento remontado) — inclusive saindo do contínuo.
                      lastVideoPlayheadRef.current = null;
                      setVodFallback(true);
                      setReloadNonce((current) => current + 1);
                    }}
                    className="mt-2 rounded border border-[hsl(var(--destructive)_/_0.4)] px-2.5 py-1 text-[10px] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.2)]"
                  >
                    Tentar novamente este segmento
                  </button>
                </div>
              </div>
            )}

            <div className="pointer-events-none absolute bottom-3 left-3 z-10">
              <span className="rounded bg-black/50 px-2 py-1 text-sm text-white/75">{format(currentTime, 'dd/MM/yyyy HH:mm:ss')}</span>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-3">
            {/* Envólucro sem clip: deixa a prévia (miniatura) escapar acima da faixa. */}
            <div className="relative">
            {timelineHover && (
              <div
                className="pointer-events-none absolute bottom-full z-30 mb-2 -translate-x-1/2"
                style={{ left: `${clamp(timelineHover.x, 60, (timelineTrackRef.current?.clientWidth ?? 600) - 60)}px` }}
              >
                <div className="overflow-hidden rounded-md border border-white/15 bg-black/90 shadow-xl">
                  <div className="h-[68px] w-[120px] bg-black">
                    {hoverSpriteTile ? (
                      <div className="h-full w-full" style={hoverSpriteTile} />
                    ) : timelineHover.recordingId && thumbnailUrls[timelineHover.recordingId] ? (
                      <img src={thumbnailUrls[timelineHover.recordingId]} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[9px] text-white/30">
                        {timelineHover.recordingId ? '…' : 'sem gravação'}
                      </div>
                    )}
                  </div>
                  <div className="px-1.5 py-0.5 text-center font-mono text-[10px] text-white/80">
                    {format(addMinutes(dayStart, timelineHover.minute), 'HH:mm:ss')}
                  </div>
                </div>
              </div>
            )}
            {/* ── MINIMAPA DO DIA ────────────────────────────────────────
                O dia INTEIRO, sempre 00:00→24:00, sem nunca dar zoom. É a
                âncora que responde "onde eu estou" quando a faixa detalhada
                está mostrando 7 minutos — sem ele, o operador com zoom se
                perde no dia. Retângulo = janela visível: clique centra,
                arraste move. Padrão de Milestone/Frigate. */}
            <div
              ref={minimapRef}
              className="relative mb-1.5 h-5 cursor-pointer select-none overflow-hidden rounded-sm border border-[hsl(var(--border))] bg-[hsl(222,14%,12%)]"
              title="Dia inteiro — clique para ir, arraste a janela para navegar"
              onMouseDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                minimapDragRef.current = true;
                setViewCenterFromMinimap(((event.clientX - rect.left) / Math.max(1, rect.width)) * TOTAL_MINS);
              }}
            >
              {minimapaBuckets.map((bucket) => (
                <div
                  key={bucket.indice}
                  className="pointer-events-none absolute top-0 h-full"
                  style={{
                    left: `${(bucket.indice / 720) * 100}%`,
                    // Largura MÍNIMA de 2px: um alarme de 3 segundos ocupa
                    // 0,003% do dia — renderizado com fidelidade, some.
                    width: 'max(2px, 0.1389%)',
                    background: getSegmentColor(bucket.tipo),
                    opacity: bucket.tipo === 'recorded' ? 0.75 : 1,
                  }}
                />
              ))}
              {/* Janela visível */}
              <div
                className="pointer-events-none absolute top-0 h-full rounded-[2px] border-[1.5px] border-white/70 bg-white/10"
                style={{
                  left: `${(viewStart / TOTAL_MINS) * 100}%`,
                  width: `max(8px, ${((viewEnd - viewStart) / TOTAL_MINS) * 100}%)`,
                }}
              />
              <div
                className="pointer-events-none absolute top-0 h-full w-px bg-white/90"
                style={{ left: `${(playhead / TOTAL_MINS) * 100}%` }}
              />
            </div>

            {/* ── RÉGUA DE TICKS ────────────────────────────────────────────
                Três níveis em horários REDONDOS, com granularidade que
                acompanha o zoom (../lib/timeline-ruler). Antes eram cinco
                rótulos em posição fixa, que com zoom caíam em "06:37" e não
                serviam para mirar nada. */}
            <div className="relative mb-0.5 h-4 select-none overflow-hidden">
              {ticksDaRegua.ticks.map((tick) => {
                const pct = ((tick.minuto - viewStart) / (viewEnd - viewStart)) * 100;
                if (pct < -2 || pct > 102) return null;
                const altura = tick.nivel === 'maior' ? 'h-2.5' : tick.nivel === 'medio' ? 'h-1.5' : 'h-1';
                const cor = tick.nivel === 'maior' ? 'bg-white/45' : tick.nivel === 'medio' ? 'bg-white/25' : 'bg-white/15';
                return (
                  <div key={`${tick.nivel}-${tick.minuto}`} className="pointer-events-none absolute bottom-0" style={{ left: `${pct}%` }}>
                    <div className={`${altura} ${cor} w-px`} />
                  </div>
                );
              })}
              {/* Limites EXATOS da janela nas bordas (ideia do Rhombus): os
                  rótulos internos ficam em horários redondos, mas o operador
                  também precisa saber "estou vendo de quando até quando" —
                  sobretudo com zoom, quando nenhuma hora cheia aparece. */}
              <div className="pointer-events-none absolute top-0 left-0 rounded-sm bg-[hsl(222,14%,12%)] px-1 font-mono text-[9px] tabular-nums text-white/70">
                {format(addMinutes(dayStart, viewStart), 'HH:mm')}
              </div>
              <div className="pointer-events-none absolute top-0 right-0 rounded-sm bg-[hsl(222,14%,12%)] px-1 font-mono text-[9px] tabular-nums text-white/70">
                {format(addMinutes(dayStart, viewEnd), 'HH:mm')}
              </div>
              {ticksDaRegua.ticks.filter((t) => t.nivel === 'maior').map((tick) => {
                const pct = ((tick.minuto - viewStart) / (viewEnd - viewStart)) * 100;
                // Margem: rótulo interno colado na borda brigaria com o rótulo
                // de limite da janela e sairia sobreposto.
                if (pct < 6 || pct > 94) return null;
                const rotulo = ticksDaRegua.granularidade.formato === 'HH'
                  ? format(addMinutes(dayStart, tick.minuto), 'HH') + 'h'
                  : format(addMinutes(dayStart, tick.minuto), ticksDaRegua.granularidade.formato === 'HH:mm' ? 'HH:mm' : 'HH:mm:ss');
                return (
                  <div
                    key={`rot-${tick.minuto}`}
                    // tabular-nums: sem isso os dígitos mudam de largura e a
                    // régua "vibra" durante o pan.
                    className="pointer-events-none absolute top-0 font-mono text-[10px] tabular-nums text-white/55"
                    style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}
                  >
                    {rotulo}
                  </div>
                );
              })}
            </div>

            <div
              ref={timelineTrackRef}
              className="relative mb-2 h-9 cursor-pointer select-none overflow-hidden rounded-sm border border-[hsl(var(--border))] bg-[hsl(222,14%,15%)]"
              title="Clique para posicionar · role para dar zoom · arraste para mover"
              onMouseDown={onTimelinePanStart}
              onMouseMove={onTimelineHover}
              onMouseLeave={() => setTimelineHover(null)}
              onClick={(event) => onTimelineClick(event.clientX, event.currentTarget.getBoundingClientRect())}
            >
              {skeletonSpans.map((span, index) => {
                const spanStart = Math.max(span.start, viewStart);
                const spanEnd = Math.min(span.end, viewEnd);
                const windowSize = viewEnd - viewStart;
                return (
                  <div
                    key={`skeleton-${index}-${spanStart}`}
                    className="pointer-events-none absolute top-0 h-full opacity-35"
                    title="Há vídeo neste trecho — carregando o detalhe"
                    style={{
                      left: `${((spanStart - viewStart) / windowSize) * 100}%`,
                      width: `${((spanEnd - spanStart) / windowSize) * 100}%`,
                      background: getSegmentColor('recorded'),
                      // Acima do "sem gravação" (z=1) — enquanto o detalhe não
                      // chega, o buraco desenhado ali é ignorância, não ausência
                      // de vídeo. Marcadores de evento (z=2, desenhados depois)
                      // continuam por cima.
                      zIndex: 2,
                    }}
                  />
                );
              })}
              {visibleTimelineSegments.items.map((segment, visibleIndex) => {
                const index = visibleTimelineSegments.indices[visibleIndex];
                const segStart = Math.max(segment.start, viewStart);
                const segEnd = Math.min(segment.end, viewEnd);
                const windowSize = viewEnd - viewStart;
                // Movimento/alarme são EVENTOS dentro de uma gravação, não trechos:
                // desenhados como marcador fino no topo, sobre a faixa verde.
                const isEventMarker = segment.type === 'motion' || segment.type === 'alarm';
                const segmentTitle = segment.type === 'recorded'
                  ? `Gravação ${format(addMinutes(dayStart, segment.start), 'HH:mm')}–${format(addMinutes(dayStart, segment.end), 'HH:mm')}`
                  : segment.type === 'recorded_broken'
                    ? 'Trecho com arquivo ausente/corrompido'
                    : segment.type === 'motion'
                      ? `Evento de movimento ${format(addMinutes(dayStart, segment.start), 'HH:mm')}`
                      : segment.type === 'alarm'
                        ? `Evento de alarme ${format(addMinutes(dayStart, segment.start), 'HH:mm')}`
                        : 'Sem gravação';
                return (
                  <div
                    key={`${segment.type}-${index}-${segStart}`}
                    className={`absolute top-0 ${isEventMarker ? 'h-[35%] rounded-b-sm' : 'h-full'}`}
                    title={segmentTitle}
                    onClick={(event) => {
                      // ANTES de qualquer return: deixar o clique borbulhar até a
                      // trilha movia o playhead para dentro de um trecho quebrado
                      // e disparava a seleção errada por tabela.
                      event.stopPropagation();
                      if (timelineDraggedRef.current) return; // fim de arraste (pan), não é seek
                      if ((segment.type !== 'recorded' && segment.type !== 'recorded_broken') || !segment.recordingId) return;
                      const rec = recordingById.get(segment.recordingId);
                      if (segment.type === 'recorded_broken' || !(rec?.fileUsable ?? rec?.fileExists)) {
                        toast({
                          title: 'Segmento indisponível',
                          description: 'Este trecho está ausente, incompleto ou corrompido no disco.',
                          variant: 'destructive',
                        });
                        return;
                      }
                      const recDiag = diagnosticsByRecordingId[segment.recordingId];
                      if (recDiag?.compatibleRecommended && !BROWSER_PLAYS_HEVC) {
                        setCompatMode(true);
                      }
                      // O PONTO clicado dentro do bloco vale: pular sempre para o
                      // início custava até uma hora de arrasto em segmento longo.
                      const rect = event.currentTarget.parentElement?.getBoundingClientRect();
                      const windowSizeMin = viewEnd - viewStart;
                      const minuteFromClick = rect && rect.width > 0
                        ? clamp(viewStart + ((event.clientX - rect.left) / rect.width) * windowSizeMin, segment.start, Math.max(segment.start, segment.end - 1 / 60))
                        : segment.start;
                      setSelectedRecordingId(segment.recordingId);
                      setPendingSeekSeconds(Math.max(0, (minuteFromClick - segment.start) * 60));
                      setPlayheadFromMinute(minuteFromClick);
                    }}
                    style={{
                      left: `${((segStart - viewStart) / windowSize) * 100}%`,
                      // Largura MÍNIMA de 2px: um alarme de 3 segundos numa
                      // visão de 24h ocupa 0,003% da largura — desenhado com
                      // fidelidade, ele simplesmente não existe na tela.
                      width: `max(${isEventMarker ? 3 : 2}px, ${((segEnd - segStart) / windowSize) * 100}%)`,
                      background: segment.type === 'recorded_broken' ? HACHURA_DEFEITO : getSegmentColor(segment.type),
                      cursor: segment.type === 'recorded' || segment.type === 'recorded_broken' ? 'pointer' : 'default',
                      zIndex: isEventMarker ? 3 : 1,
                      borderRadius: isEventMarker ? '0 0 2px 2px' : '1px',
                    }}
                  />
                );
              })}
              {/* Playhead: linha + pílula com a hora exata. Os rótulos fixos
                  de 0/25/50/75/100% saíram — quem dá a escala agora é a régua
                  de ticks acima, em horários redondos. */}
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-[4] w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]"
                style={{ left: `${((playhead - viewStart) / (viewEnd - viewStart)) * 100}%` }}
              >
                <div className="absolute top-0 left-1/2 h-0 w-0 -translate-x-1/2 border-l-[5px] border-r-[5px] border-t-[7px] border-transparent border-t-white" />
                <div className="absolute -top-[19px] left-1/2 -translate-x-1/2 rounded bg-white px-1 py-px font-mono text-[9px] font-semibold tabular-nums leading-tight text-black shadow">
                  {format(addMinutes(dayStart, playhead), 'HH:mm:ss')}
                </div>
              </div>
            </div>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-3">
              {/* Salto entre eventos: em 24h com 5 eventos, achar no olho é
                  tortura. Padrão Verkada (setas nas bordas) + teclas N/P. */}
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => irParaEvento(-1)}
                  title="Evento anterior (P)"
                  className="rounded border border-border px-1.5 py-1 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="px-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                  {instantesDeEvento.length ? `${instantesDeEvento.length} evento(s)` : 'sem eventos'}
                </span>
                <button
                  type="button"
                  onClick={() => irParaEvento(1)}
                  title="Próximo evento (N)"
                  className="rounded border border-border px-1.5 py-1 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              <span className="h-4 w-px bg-[hsl(var(--border))]" />
              {/* Legenda SEMPRE visível: sem ela o operador adivinha o que é
                  âmbar vs laranja. A forma acompanha a cor (barra alta =
                  trecho, marcador baixo = evento) porque cor sozinha exclui
                  quem tem deficiência de visão de cor. */}
              {[
                ['Gravação', 'recorded', 'Trecho com vídeo disponível (disco ou nuvem)'],
                ['Movimento', 'motion', 'Marcador no topo: movimento detectado dentro da gravação'],
                ['Alarme', 'alarm', 'Marcador no topo: alarme dentro da gravação'],
                ['Indisponível', 'recorded_broken', 'Arquivo ausente, incompleto ou corrompido — hachurado'],
              ].map(([label, type, hint]) => (
                <div key={type} className="flex items-center gap-1" title={hint}>
                  <span
                    className={type === 'recorded' || type === 'recorded_broken' ? 'h-2.5 w-2.5 rounded-sm' : 'h-1 w-2.5 rounded-sm'}
                    style={{ background: type === 'recorded_broken' ? HACHURA_DEFEITO : getSegmentColor(type as TimelineSegment['type']) }}
                  />
                  <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{label}</span>
                </div>
              ))}
              <span className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))]" title="Atalhos: Espaço/K play · J/L retroceder-avançar · ←/→ 10s · Shift+←/→ 1min · N/P evento · Home/End início-fim">
                <span className="h-2.5 w-2.5 rounded-sm border border-[hsl(var(--border))] bg-[hsl(222,14%,15%)]" />
                Sem gravação
              </span>
              <button type="button" onClick={() => void handleDownload()} disabled={!selectedRecording || downloadingRecordingId === selectedRecording?.id} className="ml-auto flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45">
                {downloadingRecordingId === selectedRecording?.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Baixar
              </button>
              {selectedDiagnostics?.compatibleRecommended && !BROWSER_PLAYS_HEVC && !selectedRecording?.compatibleCached && (
                <button
                  type="button"
                  onClick={() => void prepareCompatiblePlayback()}
                  disabled={!selectedRecording || preparingCompatibleId === selectedRecording.id}
                  className="flex items-center gap-1.5 rounded border border-[hsl(var(--primary)_/_0.35)] bg-[hsl(var(--primary)_/_0.08)] px-3 py-1.5 text-xs text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--primary)_/_0.14)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {preparingCompatibleId === selectedRecording?.id && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                  Preparar compatível
                </button>
              )}
            </div>

            <details className="hidden mb-3 rounded-lg border border-border bg-background/55 p-3">
              <summary className="cursor-pointer text-xs font-semibold">
                <span className="inline-flex items-center gap-2">
                  <Scissors className="h-3.5 w-3.5 text-[hsl(var(--primary))]" />
                  Exportar trecho
                </span>
              </summary>
              <div className="mt-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                <Scissors className="h-3.5 w-3.5 text-[hsl(var(--primary))]" />
                Intervalo do clipe
              </div>
              <div className="grid gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))_240px_auto]">
                <button type="button" onClick={() => setClipStartSeconds(Math.floor(getCurrentVideoSeconds()))} disabled={!selectedRecording} className="rounded border border-border px-3 py-2 text-left text-xs hover:bg-[hsl(var(--accent))] disabled:opacity-45">
                  <div className="font-medium">Marcar início</div>
                  <div className="mt-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{clipStartSeconds == null ? '--' : `${clipStartSeconds}s`}</div>
                </button>
                <button type="button" onClick={() => setClipEndSeconds(Math.ceil(getCurrentVideoSeconds()))} disabled={!selectedRecording} className="rounded border border-border px-3 py-2 text-left text-xs hover:bg-[hsl(var(--accent))] disabled:opacity-45">
                  <div className="font-medium">Marcar fim</div>
                  <div className="mt-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{clipEndSeconds == null ? '--' : `${clipEndSeconds}s`}</div>
                </button>
                <div className="rounded border border-border px-3 py-2 text-xs">
                  <div className="font-medium">Janela de origem</div>
                  <div className="mt-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{selectedRecordingStartLabel} — {selectedRecordingEndLabel}</div>
                </div>
                <div className="rounded border border-border px-3 py-2 text-xs">
                  <div className="font-medium">Duração do clipe</div>
                  <div className="mt-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{clipStartSeconds != null && clipEndSeconds != null && clipEndSeconds > clipStartSeconds ? `${clipEndSeconds - clipStartSeconds}s` : '--'}</div>
                </div>
                <Select value={selectedInvestigationId} onValueChange={setSelectedInvestigationId}>
                  <SelectTrigger className="h-full min-h-[44px] text-xs">
                    <SelectValue placeholder="Anexar ao caso" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" className="text-xs">Sem caso</SelectItem>
                    {investigations.map((item) => <SelectItem key={item.id} value={item.id} className="text-xs">{item.title}</SelectItem>)}
                  </SelectContent>
                </Select>
                <button type="button" onClick={() => void exportClip()} disabled={!selectedRecording || exportingClip || selectedRecordingDuration <= 0} className="rounded border border-[hsl(var(--primary)_/_0.35)] bg-[hsl(var(--primary)_/_0.08)] px-3 py-2 text-xs text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary)_/_0.12)] disabled:opacity-45">
                  {exportingClip ? <span className="inline-flex items-center gap-1.5"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Exportando</span> : 'Exportar'}
                </button>
                <button type="button" onClick={() => void saveBookmark()} disabled={!selectedRecording || selectedInvestigationId === '__none__' || savingBookmark} className="rounded border border-border px-3 py-2 text-xs hover:bg-[hsl(var(--accent))] disabled:opacity-45">
                  {savingBookmark ? <span className="inline-flex items-center gap-1.5"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Salvando</span> : 'Salvar marcador'}
                </button>
              </div>
              {lastExportedClip && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-xs">
                  <span className="font-medium">Clipe pronto:</span>
                  <span className="font-mono text-[hsl(var(--muted-foreground))]">{lastExportedClip.id.slice(0, 8)}</span>
                  <button type="button" onClick={() => { setClipDownloadReason(''); setClipDownload({ url: lastExportedClip.downloadUrl, clipId: lastExportedClip.id }); }} className="rounded border border-border px-2.5 py-1 hover:bg-[hsl(var(--accent))]">Baixar clipe</button>
                  {lastExportedClip.investigationItemId && <span className="rounded bg-[hsl(var(--primary)_/_0.08)] px-2 py-1 text-[hsl(var(--primary))]">Anexado à investigação</span>}
                </div>
              )}
              </div>
            </details>

            {/* Barra de reprodução do segmento atual: scrubber + tempo */}
            <div className="mb-2 flex items-center gap-3">
              <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-[hsl(var(--muted-foreground))]">{formatClock(videoCurrentTime)}</span>
              <input
                type="range"
                min={0}
                max={videoDuration || selectedRecordingDuration || 0}
                step={0.1}
                value={Math.min(videoCurrentTime, videoDuration || selectedRecordingDuration || 0)}
                onChange={(event) => seekVideoTo(Number(event.target.value))}
                disabled={!playerActive}
                aria-label="Posição no segmento"
                className="playback-scrubber h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-[hsl(var(--muted))] accent-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-50"
              />
              <span className="w-14 shrink-0 font-mono text-[11px] tabular-nums text-[hsl(var(--muted-foreground))]">{formatClock(videoDuration || selectedRecordingDuration)}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Navegação entre segmentos */}
              <button type="button" onClick={() => jumpToAdjacentUsableRecording('prev')} disabled={!selectedRecordingId} title="Segmento anterior" className="flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground disabled:opacity-45">
                <SkipBack className="h-3.5 w-3.5" /> Seg.
              </button>

              {/* Transporte central */}
              <div className="mx-auto flex items-center gap-1.5">
                <button type="button" onClick={() => setPlayheadFromMinute(playhead - 15)} title="Voltar 15 min" className="flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground"><SkipBack className="h-4 w-4" /></button>
                <button type="button" onClick={() => seekVideoTo(getCurrentVideoSeconds() - 10)} disabled={!playerActive} title="Voltar 10s" className="flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground disabled:opacity-45"><StepBack className="h-4 w-4" /></button>
                <button
                  type="button"
                  onClick={togglePlay}
                  disabled={!playerActive}
                  title={playing ? 'Pausar' : 'Reproduzir'}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-45"
                >
                  {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
                </button>
                <button type="button" onClick={() => seekVideoTo(getCurrentVideoSeconds() + 10)} disabled={!playerActive} title="Avançar 10s" className="flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground disabled:opacity-45"><StepForward className="h-4 w-4" /></button>
                <button type="button" onClick={() => setPlayheadFromMinute(playhead + 15)} title="Avançar 15 min" className="flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground"><SkipForward className="h-4 w-4" /></button>
              </div>

              {/* Volume */}
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={toggleMute} title={videoMuted ? 'Ativar som' : 'Silenciar'} className="flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground">
                  {videoMuted || videoVolume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={videoMuted ? 0 : videoVolume}
                  onChange={(event) => changeVolume(Number(event.target.value))}
                  aria-label="Volume"
                  className="hidden h-1 w-20 cursor-pointer appearance-none rounded-full bg-[hsl(var(--muted))] accent-[hsl(var(--primary))] sm:block"
                />
              </div>

              {/* Velocidade */}
              <div className="ops-segment flex items-center gap-0.5">
                <FastForward className="ml-1 h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
                {SPEEDS.map((item) => (
                  <button key={item} type="button" onClick={() => setSpeed(item)} className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition-colors ${speed === item ? 'ops-segment-active' : 'text-[hsl(var(--muted-foreground))] hover:text-foreground'}`}>
                    {item}
                  </button>
                ))}
              </div>

              {/* Tela cheia */}
              <button type="button" onClick={toggleFullscreen} title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'} className="flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground">
                {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="flex max-h-80 w-full shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card xl:max-h-none xl:w-80">
          <div className="border-b border-border px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">Gravações do dia</span>
              {usableRecordingIds.length > 0 && (
                <button
                  type="button"
                  onClick={toggleSelectAllForZip}
                  className="text-[10px] text-[hsl(var(--muted-foreground))] underline-offset-2 hover:text-foreground hover:underline"
                >
                  {allUsableSelected ? 'Limpar seleção' : 'Selecionar todas'}
                </button>
              )}
            </div>
            {selectedForZip.size > 0 && (
              <button
                type="button"
                onClick={() => void downloadSelectedAsZip()}
                disabled={downloadingZip}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-[hsl(var(--primary)_/_0.35)] bg-[hsl(var(--primary)_/_0.08)] px-3 py-1.5 text-xs text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--primary)_/_0.14)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {downloadingZip ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderArchive className="h-3.5 w-3.5" />}
                Baixar {selectedForZip.size} em ZIP
              </button>
            )}
          </div>
          <div
            ref={recordingListRef}
            onScroll={onRecordingListScroll}
            className="relative flex-1 overflow-y-auto"
          >
            {orderedRecordings.length ? (
              <div
                className="relative"
                style={listWindow.virtualized ? { height: `${listWindow.totalHeightPx}px` } : undefined}
              >
            {visibleRecordingRows.map((item, rowOffset) => {
              const rowIndex = listWindow.startIndex + rowOffset;
              const isSelected = item.id === selectedRecordingId;
              const usable = item.fileUsable ?? item.fileExists;
              const startLabel = format(new Date(item.startedAt), 'HH:mm:ss');
              const endLabel = item.endedAt ? format(new Date(item.endedAt), 'HH:mm:ss') : '--';
              const recDiag = diagnosticsByRecordingId[item.id];
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    if (!usable) return;
                    if (recDiag?.compatibleRecommended && !BROWSER_PLAYS_HEVC) setCompatMode(true);
                    setSelectedRecordingId(item.id);
                    setPendingSeekSeconds(0);
                    setPlayheadFromMinute(minuteOfDay(item.startedAt));
                  }}
                  className={`w-full px-3 py-2.5 text-left transition-colors ${rowIndex > 0 ? 'border-t border-border' : ''} ${
                    !usable ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'
                  } ${
                    isSelected
                      ? 'bg-[hsl(var(--primary)_/_0.1)]'
                      : 'hover:bg-[hsl(var(--accent))]'
                  }`}
                  style={listWindow.virtualized ? {
                    position: 'absolute',
                    top: `${rowIndex * RECORDING_ROW_HEIGHT_PX}px`,
                    left: 0,
                    right: 0,
                    height: `${RECORDING_ROW_HEIGHT_PX}px`,
                  } : undefined}
                >
                  <div className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={selectedForZip.has(item.id)}
                      disabled={!usable}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleZipSelection(item.id)}
                      title="Selecionar para baixar em ZIP"
                      aria-label={`Selecionar gravação de ${startLabel}`}
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[hsl(var(--primary))] disabled:cursor-not-allowed"
                    />
                    <div className="relative h-11 w-[72px] shrink-0 overflow-hidden rounded-md bg-black/50">
                      {thumbnailUrls[item.id] ? (
                        <img src={thumbnailUrls[item.id]} onError={retryExpiredThumbnails} alt={`Prévia de ${startLabel}`} loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center"><CameraIcon className="h-4 w-4 text-white/25" /></div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/15"><Play className="h-3.5 w-3.5 fill-white text-white" /></div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[11px] font-medium ${isSelected ? 'text-[hsl(var(--primary))]' : ''}`}>
                          {startLabel} - {endLabel}
                        </span>
                        <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDownload(item);
                        }}
                        disabled={!usable || downloadingRecordingId === item.id}
                        title="Baixar gravação"
                        className="flex h-6 w-6 items-center justify-center rounded border border-border text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {downloadingRecordingId === item.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      </button>
                      <span className={`h-2 w-2 rounded-full ${usable ? 'bg-[hsl(var(--status-online)_/_0.8)]' : 'bg-[hsl(var(--destructive)_/_0.8)]'}`} />
                        </div>
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                        {item.durationSeconds ? `${item.durationSeconds}s` : '--'} · {Math.round(Number(item.actualSizeBytes ?? item.sizeBytes ?? 0) / 1024 / 1024)} MB
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-xs text-[hsl(var(--muted-foreground))]">
                Sem gravações nesta data.
              </div>
            )}
          </div>
        </div>

      </div>

      <Dialog open={clipDownload !== null} onOpenChange={(open) => { if (!open) setClipDownload(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Baixar clipe</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Informe o motivo do download. Esta ação é registrada na auditoria.
          </p>
          <Input
            autoFocus
            value={clipDownloadReason}
            onChange={(event) => setClipDownloadReason(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void confirmClipDownload(); }}
            placeholder="Motivo do download (obrigatório)"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setClipDownload(null)}>Cancelar</Button>
            <Button onClick={() => void confirmClipDownload()} disabled={!clipDownloadReason.trim()}>Baixar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
