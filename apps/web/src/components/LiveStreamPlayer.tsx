import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import axios from 'axios';
import { AlertTriangle, LoaderCircle, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { streamUrlsCache } from '../lib/stream-urls-cache';
import { liveDetectionsPoller } from '../lib/live-detections-poller';

type LiveStreamPlayerProps = {
  cameraId: string;
  cameraName: string;
  className?: string;
  autoPlay?: boolean;
  muted?: boolean;
  showOverlay?: boolean;
  aiEnabled?: boolean;
  liveViewMode?: 'selected' | 'grid';
  startDelayMs?: number;
  onStatusChange?: (status: LivePlayerStatus) => void;
};

const API_URL = getApiBaseUrl();
const HLS_FIRST_FRAME_TIMEOUT_MS = 7000;
const WEBRTC_FIRST_FRAME_TIMEOUT_MS = 8000;
const WEBRTC_WHEP_NEGOTIATION_TIMEOUT_MS = 9500;
// Depois que a conexão WebRTC ESTABELECE (ICE connected) mas o primeiro frame ainda
// não chegou, quase sempre é o FFmpeg do path fazendo cold start: o runOnDemand foi
// encerrado após runOnDemandCloseAfter (5 min sem espectador) e precisa reabrir o RTSP,
// fazer probe e aguardar um keyframe. O timeout normal de 8s estoura no meio desse
// arranque, faz o cliente desistir do WebRTC, cair para HLS (+7s) e entrar em backoff —
// é esse empilhamento que levava a reconexão ao voltar para a aba a ~20s. Quando
// detectamos "conectou, mas sem frame", estendemos o prazo para o publisher esquentar
// e o vídeo volta no MESMO WebRTC, sem thrashing.
const WEBRTC_COLD_START_FRAME_TIMEOUT_MS = 17000;
const WEBRTC_DISCONNECT_GRACE_MS = 6000;
const LIVE_RESUME_GRACE_MS = 1200;
const LIVE_SOFT_ONLY_RESUME_MS = 120000;
// Após este tempo com a aba oculta, derruba o WebRTC para parar o transcode no
// servidor e o tráfego de rede de uma aba que ninguém está vendo. Como o MediaMTX
// mantém o FFmpeg aquecido por runOnDemandCloseAfter (5 min), voltar dentro dessa
// janela reconecta quase instantaneamente, sem boot frio.
const LIVE_HIDDEN_SUSPEND_MS = 45000;
const LIVE_STALL_CHECK_INTERVAL_MS = 4000;
const LIVE_STALL_SOFT_RECOVER_MS = 8000;
const LIVE_STALL_RECONNECT_MS = 16000;
const LIVE_RECONNECT_DEBOUNCE_MS = 2500;
const LIVE_FAST_RETRY_BASE_MS = 1200;
const LIVE_FAST_RETRY_MAX_MS = 7000;
const LIVE_EDGE_OFFSET_SECONDS = 0.35;
// Recuperação de latência sem salto (técnica do Frigate): acima de 1,2s de
// deriva a reprodução acelera suavemente (teto 1,5×) até reencostar no ao vivo;
// só deriva grande (8s+, ex.: volta de aba oculta) justifica o salto seco.
const LIVE_DRIFT_CATCHUP_SECONDS = 1.2;
const LIVE_DRIFT_HARD_SEEK_SECONDS = 8;
const LIVE_DRIFT_MAX_RATE = 1.5;
// Tempo sem NENHUM frame novo apresentado (rVFC) antes de reconectar. É o único
// detector de congelamento real agora, então precisa tolerar câmeras com "smart
// codec" que reduzem muito a taxa de quadros em cena 100% estática (alguns enviam
// ~1 frame a cada vários segundos). 10s era apertado demais e podia reconectar uma
// câmera saudável de baixa atividade. 20s cobre congelamento real sem falso-positivo.
const LIVE_RENDER_STALL_RECONNECT_MS = 20000;
const LIVE_BLACK_FRAME_FAILOVER_MS = 6000;
const LIVE_VIEW_LEASE_TTL_SECONDS = 20;
const LIVE_VIEW_HEARTBEAT_MS = 7000;
const LIVE_PROTOCOL_STORAGE_PREFIX = 'drac-live-protocol';
const LIVE_QUALITY_STORAGE_PREFIX = 'drac-live-quality';
const STREAM_URL_CACHE_TTL_MS = 60 * 1000;
type ActiveLiveProtocol = 'WEBRTC' | 'LL-HLS' | 'HLS';
type LiveProtocol = 'auto' | 'flv' | 'hls' | 'webrtc' | 'mjpeg' | 'llhls';
// Qualidade escolhida pelo operador na visualização de câmera única (1x1):
//  - instant  → sub-stream (mesmo da grade): latência mínima, zero CPU, imagem reduzida
//  - balanced → principal transcodificado H.264: latência mínima, 1080p, ~0,6 núcleo
//  - max      → principal ORIGINAL sem transcode (HEVC incluso): zero CPU, qualidade
//               idêntica à câmera; WebRTC quando o navegador decodifica H.265, senão
//               LL-HLS/HLS (~1–3s de atraso); sem suporte nenhum → volta a balanced.
type LiveQualityMode = 'instant' | 'balanced' | 'max';
type LiveDeliveryMode = 'selected' | 'grid' | 'original';

function getStoredLiveQuality(cameraId: string): LiveQualityMode {
  try {
    const stored = window.localStorage.getItem(`${LIVE_QUALITY_STORAGE_PREFIX}:${cameraId}`);
    return stored === 'instant' || stored === 'max' ? stored : 'balanced';
  } catch {
    return 'balanced';
  }
}

function storeLiveQuality(cameraId: string, quality: LiveQualityMode) {
  try {
    window.localStorage.setItem(`${LIVE_QUALITY_STORAGE_PREFIX}:${cameraId}`, quality);
  } catch {
  }
}

// Suporte do navegador a H.265 para o modo "Máxima qualidade" (avaliado uma vez).
const WEBRTC_DECODES_HEVC = (() => {
  try {
    const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? [];
    return codecs.some((codec) => /h265|hevc/i.test(codec.mimeType));
  } catch {
    return false;
  }
})();
const MSE_DECODES_HEVC = (() => {
  try {
    return typeof MediaSource !== 'undefined' && (
      MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L123.B0"')
      || MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L123.B0"')
    );
  } catch {
    return false;
  }
})();
// Este navegador consegue exibir H.265 por ALGUM caminho? Se não, o modo "Máxima"
// (H.265 original) cai automaticamente para "Equilibrado" (H.264) — o seletor avisa.
const BROWSER_DECODES_HEVC = WEBRTC_DECODES_HEVC || MSE_DECODES_HEVC;
export type LivePlayerStatus = {
  activeProtocol: ActiveLiveProtocol | null;
  state: 'loading' | 'playing' | 'fallback' | 'error';
  reason: string | null;
};
type HlsController = {
  destroy: () => void;
  startLoad?: (startPosition?: number) => void;
  recoverMediaError?: () => void;
  liveSyncPosition?: number | null;
};

type CommercialRestrictionError = {
  error?: string;
  userMessage?: string;
  adminMessage?: string;
};

type LiveDiagnostics = {
  generatedAt?: string;
  mediamtxEnabled?: boolean;
  pathReady?: boolean;
  pathName?: string | null;
  publicAppUrl?: string | null;
  apiPublicUrl?: string | null;
  mediaMtxPublicHost?: string | null;
  mediaMtxPublicScheme?: string | null;
  mediaMtxPublicWebrtcUrl?: string | null;
  mediaMtxPublicHlsUrl?: string | null;
  mediaMtxWebrtcAllowOrigin?: string | null;
  mediaMtxHlsAllowOrigin?: string | null;
  sourceVideoCodec?: string | null;
  liveTranscodedForBrowser?: boolean;
  readiness?: {
    state?: 'ready' | 'degraded' | 'blocked';
    readyForWebrtc?: boolean;
    fallbackAvailable?: boolean;
    userMessage?: string | null;
    recommendedAction?: string | null;
  } | null;
};

type PlaybackProgress = {
  wallTime: number;
  mediaTime: number;
};

type LiveDetection = {
  id: string;
  type: string;
  label: string;
  confidence: number | null;
  similarity: number | null;
  bbox: [number, number, number, number];
  frameWidth: number | null;
  frameHeight: number | null;
  occurredAt: string;
  overlayMode?: string | null;
  trackId?: number | null;
};

// Mensagens internas de falha citam protocolo/infra (WebRTC, WHEP, MediaMTX…).
// Isso é útil em log/diagnóstico, mas NUNCA deve ser a mensagem principal para o
// operador — ele não é técnico. Na UI mostramos um texto humano e o detalhe
// técnico fica recolhido em "Detalhes técnicos".
const TECHNICAL_LIVE_MESSAGE_REGEX = /protocolo|webrtc|whep|hls|mediamtx|codec|sdp|token|stream|ffmpeg|ice|manifesto/i;

function friendlyLiveText(raw: string | null, fallback: string) {
  if (!raw) return fallback;
  return TECHNICAL_LIVE_MESSAGE_REGEX.test(raw) ? fallback : raw;
}

function normalizeCodec(codec?: string | null) {
  return String(codec ?? '').trim().toLowerCase();
}

function prefersModernBridge(codec?: string | null) {
  const normalized = normalizeCodec(codec);
  return normalized.includes('h265') || normalized.includes('hevc') || normalized.includes('hvc1') || normalized.includes('265');
}

function getStoredProtocol(cameraId: string): LiveProtocol | null {
  try {
    const stored = window.localStorage.getItem(`${LIVE_PROTOCOL_STORAGE_PREFIX}:${cameraId}`);
    const normalized = stored === 'll-hls' ? 'llhls' : stored;
    return normalized === 'webrtc' || normalized === 'hls' || normalized === 'llhls' ? normalized : null;
  } catch {
    return null;
  }
}

function storeProtocol(cameraId: string, protocol: ActiveLiveProtocol) {
  try {
    const normalized = protocol === 'LL-HLS' ? 'llhls' : protocol.toLowerCase();
    window.localStorage.setItem(`${LIVE_PROTOCOL_STORAGE_PREFIX}:${cameraId}`, normalized);
  } catch {
  }
}

function getRenderedVideoRect(
  video: HTMLVideoElement | null,
  containerWidth: number,
  containerHeight: number,
) {
  if (!video || containerWidth <= 0 || containerHeight <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }

  const videoWidth = video.videoWidth || 0;
  const videoHeight = video.videoHeight || 0;
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }

  const objectFit = window.getComputedStyle(video).objectFit || 'contain';
  if (objectFit === 'fill') {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }

  const scale = objectFit === 'cover'
    ? Math.max(containerWidth / videoWidth, containerHeight / videoHeight)
    : Math.min(containerWidth / videoWidth, containerHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}

function normalizeActiveProtocol(protocol: ActiveLiveProtocol): LiveProtocol {
  if (protocol === 'WEBRTC') return 'webrtc';
  if (protocol === 'LL-HLS') return 'llhls';
  return 'hls';
}

function buildProtocolOrder(
  cameraId: string,
  preferred: LiveProtocol | null | undefined,
  codec?: string | null,
  smartOrder?: LiveProtocol[] | null,
): LiveProtocol[] {
  const stored = getStoredProtocol(cameraId);
  const order: LiveProtocol[] = [];
  const push = (protocol?: LiveProtocol | null) => {
    if (!protocol || protocol === 'mjpeg' || protocol === 'auto' || protocol === 'flv') return;
    if (!order.includes(protocol)) order.push(protocol);
  };

  if (smartOrder && smartOrder.length) {
    // O QUE JÁ FUNCIONOU NESTA CÂMERA VEM PRIMEIRO.
    //
    // `smartOrder` é o palpite do servidor a partir do codec; `stored` é o
    // protocolo que REALMENTE entregou vídeo aqui da última vez. Colocar o
    // palpite antes do fato observado fazia toda montagem repetir a mesma
    // tentativa fracassada — câmera que nunca fecha WebRTC pagava o timeout
    // dele em cada abertura, em cada tile, para sempre. Fato observado ganha
    // de heurística; o smartOrder continua logo atrás como plano B.
    push(stored);
    for (const protocol of smartOrder) push(protocol);
    if (!order.includes('hls')) push('hls');
    if (!order.includes('webrtc')) push('webrtc');
    return order;
  }
  const normalizedPreferred = preferred === 'flv' ? 'auto' : preferred;
  if (normalizedPreferred === 'webrtc') return ['webrtc', 'llhls', 'hls'];
  if (normalizedPreferred === 'hls') return ['hls', 'llhls', 'webrtc'];
  if (normalizedPreferred === 'llhls') return ['llhls', 'hls', 'webrtc'];

  if (stored === 'llhls' || stored === 'hls') {
    push(stored);
    push('llhls');
    push('hls');
    push('webrtc');
    return order;
  }
  if (prefersModernBridge(codec)) {
    return ['webrtc', 'llhls', 'hls'];
  }
  return ['webrtc', 'llhls', 'hls'];
}

function seekVideoToLiveEdge(element: HTMLVideoElement) {
  const ranges = element.seekable;
  if (!ranges.length) return false;

  const liveEdge = ranges.end(ranges.length - 1);
  if (!Number.isFinite(liveEdge) || liveEdge <= 0) return false;

  const target = Math.max(ranges.start(ranges.length - 1), liveEdge - LIVE_EDGE_OFFSET_SECONDS);
  const drift = liveEdge - element.currentTime;

  if (Number.isFinite(drift) && drift > LIVE_EDGE_OFFSET_SECONDS) {
    element.currentTime = target;
    return true;
  }

  return false;
}

function getPlaybackProgress(element: HTMLVideoElement): PlaybackProgress {
  return {
    wallTime: Date.now(),
    mediaTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
  };
}

function createLiveViewSessionId(cameraId: string) {
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `live-${cameraId}-${Date.now().toString(36)}-${randomPart}`;
}

export function LiveStreamPlayer({
  cameraId,
  cameraName,
  className,
  autoPlay = true,
  muted = true,
  showOverlay = true,
  aiEnabled = true,
  liveViewMode = 'selected',
  startDelayMs = 0,
  onStatusChange,
}: LiveStreamPlayerProps) {
  const aiOverlayEnabled = showOverlay && aiEnabled;
  const accessToken = useAuthStore((state) => state.accessToken);
  const authUserId = useAuthStore((state) => state.user?.id ?? 'anonymous');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsController | null>(null);
  const webrtcPcRef = useRef<RTCPeerConnection | null>(null);
  const webrtcSessionUrlRef = useRef<string | null>(null);
  const webrtcStreamRef = useRef<MediaStream | null>(null);
  const webrtcAbortControllerRef = useRef<AbortController | null>(null);
  const webrtcDisconnectTimerRef = useRef<number | null>(null);
  const hasFrameRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const activeProtocolRef = useRef<ActiveLiveProtocol | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const liveReloadAtRef = useRef(0);
  const preserveFrameOnReloadRef = useRef(false);
  const lastProgressRef = useRef<PlaybackProgress>({ wallTime: Date.now(), mediaTime: 0 });
  const lastRenderedFrameRef = useRef<PlaybackProgress & { presentedFrames: number }>({
    wallTime: Date.now(),
    mediaTime: 0,
    presentedFrames: 0,
  });
  const blackFrameSinceRef = useRef<number | null>(null);
  const failedProtocolsRef = useRef<Set<LiveProtocol>>(new Set());
  const visualCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveViewSessionIdRef = useRef<string>(createLiveViewSessionId(cameraId));
  // viewMode atual lido pelo heartbeat do lease sem recriar a sessão a cada
  // alternância grid/selected (evita stop+start de lease a cada clique na grade).
  const liveViewModeRef = useRef(liveViewMode);
  liveViewModeRef.current = liveViewMode;
  const previousLiveViewModeRef = useRef(liveViewMode);
  // Timer to proactively renew the stream token before it expires (avoids black screen)
  const streamTokenRenewTimerRef = useRef<number | null>(null);
  const mediaAuthTokenRef = useRef<string>('');
  const lastBitrateSampleRef = useRef<{ at: number; bytes: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(muted);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [activeProtocol, setActiveProtocol] = useState<ActiveLiveProtocol | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  const [detections, setDetections] = useState<LiveDetection[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [protocolReason, setProtocolReason] = useState<string | null>(null);
  // Aviso VISÍVEL e temporário para o usuário (ex.: "Máxima caiu p/ H.264 — sem HEVC").
  // Diferente do protocolReason (que só sobe pro pai); este aparece na tela e some só.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);
  const [displayFps, setDisplayFps] = useState<number | null>(null);
  const [sourceVideoCodec, setSourceVideoCodec] = useState<string | null>(null);
  const [isTranscodedForBrowser, setIsTranscodedForBrowser] = useState(false);
  const [measuredBitrateKbps, setMeasuredBitrateKbps] = useState<number | null>(null);
  const [liveLatencySeconds, setLiveLatencySeconds] = useState<number | null>(null);
  // Suspende a transmissão quando a aba fica oculta por tempo suficiente, para
  // não gastar CPU de transcode nem banda com quem não está vendo.
  const [suspended, setSuspended] = useState(false);
  const suspendedRef = useRef(false);
  const suspendTimerRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  // Qualidade da câmera única (1x1): persistida por câmera; na grade é sempre 'grid'.
  const [qualityMode, setQualityMode] = useState<LiveQualityMode>(() => getStoredLiveQuality(cameraId));
  useEffect(() => {
    setQualityMode(getStoredLiveQuality(cameraId));
  }, [cameraId]);
  const deliveryMode: LiveDeliveryMode = liveViewMode === 'selected'
    ? (qualityMode === 'instant' ? 'grid' : qualityMode === 'max' ? 'original' : 'selected')
    : 'grid';

  const changeQuality = useCallback((next: LiveQualityMode) => {
    // Guard: "Máxima" numa câmera H.265 + navegador sem HEVC não pode funcionar.
    // Evita o "pulo" do botão e uma reconexão inútil — avisa e mantém o modo atual.
    if (
      next === 'max'
      && !BROWSER_DECODES_HEVC
      && /h265|hevc|hvc1|265/i.test(String(sourceVideoCodec ?? ''))
    ) {
      setNotice('Máxima indisponível neste navegador (não reproduz H.265). Mantido em H.264. No Safari, a Máxima mostra o H.265 original.');
      return;
    }
    setQualityMode((current) => {
      if (current === next) return current;
      storeLiveQuality(cameraId, next);
      failedProtocolsRef.current.clear();
      retryAttemptRef.current = 0;
      setRetryMessage(next === 'max' ? 'Abrindo vídeo original da câmera…' : 'Ajustando qualidade…');
      // Mantém o último frame na tela durante a renegociação (sem tela preta).
      if (hasFrameRef.current) preserveFrameOnReloadRef.current = true;
      return next;
    });
  }, [cameraId, sourceVideoCodec]);

  const compactLiveOverlay = liveViewMode === 'grid';
  const loadingLabel = compactLiveOverlay
    ? 'Conectando…'
    : retryMessage
      ? friendlyLiveText(retryMessage, 'Reconectando à câmera…')
      : 'Aguardando vídeo';
  const compactErrorLabel = error && TECHNICAL_LIVE_MESSAGE_REGEX.test(error)
    ? 'Reconectando…'
    : 'Sem vídeo';
  const errorIsTechnical = Boolean(error && TECHNICAL_LIVE_MESSAGE_REGEX.test(error));

  const tokenHeaders = useMemo(
    () => (accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined),
    [accessToken],
  );

  useEffect(() => {
    setIsMuted(muted);
  }, [muted]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.deltaY > 0 ? -0.15 : 0.15;
      setZoom((prev) => Math.min(4, Math.max(1, parseFloat((prev + step).toFixed(2)))));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    failedProtocolsRef.current.clear();
    blackFrameSinceRef.current = null;
    mediaAuthTokenRef.current = '';
    lastBitrateSampleRef.current = null;
    setProtocolReason(null);
    setSourceVideoCodec(null);
    setIsTranscodedForBrowser(false);
    setMeasuredBitrateKbps(null);
    setLiveLatencySeconds(null);
    liveViewSessionIdRef.current = createLiveViewSessionId(cameraId);
  }, [cameraId]);

  useEffect(() => {
    onStatusChange?.({
      activeProtocol,
      state: error ? 'error' : isLoading ? 'loading' : protocolReason ? 'fallback' : 'playing',
      reason: error ?? protocolReason ?? retryMessage,
    });
  }, [activeProtocol, error, isLoading, onStatusChange, protocolReason, retryMessage]);

  const requestFreshLiveBoot = useCallback((
    message = 'Atualizando transmissão ao vivo...',
    preserveExistingFrame = true,
    bypassDebounce = false,
  ) => {
    const now = Date.now();
    if (!bypassDebounce && now - liveReloadAtRef.current < LIVE_RECONNECT_DEBOUNCE_MS) return;

    const alreadyHadFrame = hasFrameRef.current;
    liveReloadAtRef.current = now;
    setRetryMessage(message);
    setError(null);
    if (!alreadyHadFrame || !preserveExistingFrame) {
      setActiveProtocol(null);
      activeProtocolRef.current = null;
      setIsLoading(true);
      setHasLiveFrame(false);
      hasFrameRef.current = false;
    } else {
      preserveFrameOnReloadRef.current = true;
      setIsLoading(false);
    }
    setReloadNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (previousLiveViewModeRef.current === liveViewMode) return;
    previousLiveViewModeRef.current = liveViewMode;
    failedProtocolsRef.current.clear();
    // O reboot do stream acontece pelo próprio effect de boot (deliveryMode nas
    // dependências). Aqui só preparamos a transição: mensagem amigável e
    // preservação do último frame — sem bump de nonce, senão o boot rodaria DUAS
    // vezes na troca grade↔individual (piscada).
    setRetryMessage(liveViewMode === 'selected' ? 'Abrindo câmera individual…' : 'Ajustando para a grade…');
    setError(null);
    if (hasFrameRef.current) {
      preserveFrameOnReloadRef.current = true;
      setIsLoading(false);
    }
  }, [liveViewMode]);

  const isLikelyBlackFrame = useCallback((element: HTMLVideoElement) => {
    if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.videoWidth <= 0 || element.videoHeight <= 0) {
      return false;
    }
    try {
      const canvas = visualCanvasRef.current ?? document.createElement('canvas');
      visualCanvasRef.current = canvas;
      canvas.width = 16;
      canvas.height = 9;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      let brightest = 0;
      const samples = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const value = ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
        sum += value;
        brightest = Math.max(brightest, value);
      }
      return sum / samples < 3 && brightest < 12;
    } catch {
      return false;
    }
  }, []);

  const getFastRetryDelay = useCallback(() => {
    const attempt = retryAttemptRef.current;
    const delayMs = Math.min(LIVE_FAST_RETRY_MAX_MS, LIVE_FAST_RETRY_BASE_MS * Math.max(1, 2 ** attempt));
    retryAttemptRef.current = attempt + 1;
    return delayMs;
  }, []);

  const scheduleFastRetry = useCallback((message: string, preserveExistingFrame = true) => {
    if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
    const delayMs = getFastRetryDelay();
    const alreadyHadFrame = hasFrameRef.current && preserveExistingFrame;
    setError(null);
    setRetryMessage(message);
    if (!alreadyHadFrame) {
      setActiveProtocol(null);
      activeProtocolRef.current = null;
      setIsLoading(true);
      setHasLiveFrame(false);
      hasFrameRef.current = false;
    } else {
      preserveFrameOnReloadRef.current = true;
      setIsLoading(false);
    }
    retryTimerRef.current = window.setTimeout(() => {
      failedProtocolsRef.current.clear();
      retryTimerRef.current = null;
      setReloadNonce((value) => value + 1);
    }, delayMs);
  }, [getFastRetryDelay]);

  const failActiveProtocol = useCallback((reason: string) => {
    const active = activeProtocolRef.current;
    if (active) {
      failedProtocolsRef.current.add(normalizeActiveProtocol(active));
      const transitionReason = `${active} falhou: ${reason}. Alternando para o próximo protocolo.`;
      setProtocolReason(transitionReason);
      if (failedProtocolsRef.current.has('webrtc') && failedProtocolsRef.current.has('llhls') && failedProtocolsRef.current.has('hls')) {
        scheduleFastRetry('Reconectando transmissão...', true);
        return;
      }
      requestFreshLiveBoot('Reconectando transmissão...', true);
      return;
    }
    scheduleFastRetry('Reconectando transmissão...', true);
  }, [requestFreshLiveBoot, scheduleFastRetry]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !accessToken) return;

    let cancelled = false;
    let noFrameTimeout: number | null = null;
    let bootDelayTimeout: number | null = null;

    const clearRetryTimer = () => {
      if (retryTimerRef.current == null) return;
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };

    const markHealthy = (protocol: ActiveLiveProtocol) => {
      retryAttemptRef.current = 0;
      setRetryMessage(null);
      setError(null);
      setActiveProtocol(protocol);
      activeProtocolRef.current = protocol;
      lastProgressRef.current = getPlaybackProgress(element);
      lastRenderedFrameRef.current = {
        wallTime: Date.now(),
        mediaTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
        presentedFrames: lastRenderedFrameRef.current.presentedFrames,
      };
      hasFrameRef.current = true;
      setIsLoading(false);
      setHasLiveFrame(true);
      storeProtocol(cameraId, protocol);
    };

    const scheduleReconnect = (message: string) => {
      if (cancelled) return;
      clearRetryTimer();
      const delayMs = getFastRetryDelay();
      const alreadyHadFrame = hasFrameRef.current;
      setError(null);
      const warmupMessage = /Nenhum protocolo de live conseguiu iniciar|Aguardando vídeo/i.test(message);
      setRetryMessage(warmupMessage
        ? 'Aguardando vídeo da câmera'
        : `${message} Reconectando...`);
      if (!alreadyHadFrame) {
        setActiveProtocol(null);
        activeProtocolRef.current = null;
        setIsLoading(true);
        setHasLiveFrame(false);
      } else {
        preserveFrameOnReloadRef.current = true;
        setIsLoading(false);
      }
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        setReloadNonce((value) => value + 1);
      }, delayMs);
    };

    const boot = async () => {
      const alreadyHadFrame = hasFrameRef.current;
      setIsLoading(!alreadyHadFrame);
      setError(null);
      if (!alreadyHadFrame) {
        setActiveProtocol(null);
        activeProtocolRef.current = null;
        setHasLiveFrame(false);
        hasFrameRef.current = false;
      }

      try {
        // Use cache to deduplicate concurrent requests for the same camera
        // This prevents overwhelming the backend when multiple cameras load simultaneously.
        // A chave usa câmera + modo de visualização. Grid e câmera individual
        // precisam perfis diferentes, mas ainda evitamos incluir o JWT para não
        // deixar entradas órfãs no cache.
        const cacheKey = `stream-urls:${authUserId}:${cameraId}:${deliveryMode}`;
        const data = await streamUrlsCache.getOrFetch(
          cacheKey,
          () => axios.get<{
            preferredLiveProtocol?: 'auto' | 'flv' | 'hls' | 'llhls' | 'webrtc' | 'mjpeg' | null;
            detectedVideoCodec?: string | null;
            sourceVideoCodec?: string | null;
            deliveryMode?: 'selected' | 'grid';
            deliveryTarget?: Record<string, unknown> | null;
            smartLive?: {
              enabled?: boolean;
              recommendedProtocol?: LiveProtocol;
              protocolOrder?: LiveProtocol[];
            } | null;
            liveDiagnostics?: LiveDiagnostics | null;
            protocols?: {
              posterUrl?: string | null;
              hlsUrl?: string | null;
              webrtcUrl?: string | null;
              whepUrl?: string | null;
            };
            streamToken?: string;
            streamTokenExpiresAt?: string | null;
          }>(
            `${API_URL}/camera-stream/${cameraId}/urls`,
            {
              headers: tokenHeaders,
              params: { viewMode: deliveryMode },
            },
          ).then(res => res.data),
          STREAM_URL_CACHE_TTL_MS,
        );

        if (cancelled) return;

        const streamToken = data?.streamToken ?? '';
        const rawPosterUrl = data?.protocols?.posterUrl ?? `${API_URL}/camera-stream/${cameraId}/poster`;
        const hlsUrl = data?.protocols?.hlsUrl ?? null;
        const whepUrl =
          data?.protocols?.whepUrl
          ?? (data?.protocols?.webrtcUrl ? `${data.protocols.webrtcUrl.replace(/\/+$/, '')}/whep` : null);
        const preferredLiveProtocol = data?.preferredLiveProtocol ?? 'webrtc';
        const sourceCodec = data?.sourceVideoCodec ?? data?.detectedVideoCodec;
        const liveDiagnostics = data?.liveDiagnostics ?? null;
        mediaAuthTokenRef.current = streamToken;
        setSourceVideoCodec(sourceCodec ?? null);
        setIsTranscodedForBrowser(Boolean(liveDiagnostics?.liveTranscodedForBrowser));
        const orderedProtocols = buildProtocolOrder(
          cameraId,
          preferredLiveProtocol,
          sourceCodec,
          data?.smartLive?.protocolOrder ?? null,
        );
        let protocolOrder: LiveProtocol[] = orderedProtocols.filter((protocol) => !failedProtocolsRef.current.has(protocol));
        if (!protocolOrder.length) {
          failedProtocolsRef.current.clear();
          protocolOrder = orderedProtocols;
          setProtocolReason('Reconectando transmissão.');
        }

        // Modo "Máxima qualidade" com fonte H.265: só protocolos que este navegador
        // decodifica (WebRTC-HEVC quando disponível — latência mínima; senão
        // LL-HLS/HLS via MSE). Sem nenhum suporte → volta sozinho ao equilibrado.
        if (deliveryMode === 'original' && /h265|hevc/i.test(String(sourceCodec ?? ''))) {
          const capable: LiveProtocol[] = [];
          if (WEBRTC_DECODES_HEVC) capable.push('webrtc');
          if (MSE_DECODES_HEVC) capable.push('llhls', 'hls');
          if (!capable.length) {
            storeLiveQuality(cameraId, 'balanced');
            setQualityMode('balanced');
            failedProtocolsRef.current.clear();
            setProtocolReason('Este navegador não decodifica H.265 — usando o modo equilibrado (H.264).');
            setNotice('Máxima indisponível neste navegador (não reproduz H.265). Exibindo em H.264. No Safari, a Máxima mostra o H.265 original.');
            return;
          }
          protocolOrder = capable.filter((protocol) => !failedProtocolsRef.current.has(protocol));
          if (!protocolOrder.length) {
            failedProtocolsRef.current.clear();
            protocolOrder = capable;
          }
        }

        if (rawPosterUrl && streamToken) {
          const separator = rawPosterUrl.includes('?') ? '&' : '?';
          setPosterUrl(`${rawPosterUrl}${separator}token=${encodeURIComponent(streamToken)}&v=${Date.now()}`);
        }

        if (!streamToken) {
          throw new Error('Token de stream inválido retornado pela API.');
        }

        if (streamTokenRenewTimerRef.current != null) {
          window.clearTimeout(streamTokenRenewTimerRef.current);
          streamTokenRenewTimerRef.current = null;
        }
        const renewMediaToken = async () => {
          try {
            const response = await axios.post<{ streamToken: string; expiresAt?: string | null }>(
              `${API_URL}/camera-stream/${cameraId}/token`,
              {},
              { headers: tokenHeaders },
            );
            if (cancelled) return;
            mediaAuthTokenRef.current = response.data.streamToken;
            if (rawPosterUrl && response.data.streamToken) {
              const separator = rawPosterUrl.includes('?') ? '&' : '?';
              setPosterUrl(`${rawPosterUrl}${separator}token=${encodeURIComponent(response.data.streamToken)}&v=${Date.now()}`);
            }
            scheduleMediaTokenRenewal(response.data.expiresAt ?? null);
          } catch {
            if (!cancelled) {
              streamTokenRenewTimerRef.current = window.setTimeout(() => {
                void renewMediaToken();
              }, 30_000);
            }
          }
        };
        const scheduleMediaTokenRenewal = (expiresAt?: string | null) => {
          if (streamTokenRenewTimerRef.current != null) {
            window.clearTimeout(streamTokenRenewTimerRef.current);
          }
          const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
          const delayMs = Number.isFinite(expiresAtMs)
            ? Math.max(30_000, expiresAtMs - Date.now() - 60_000)
            : 4 * 60_000;
          streamTokenRenewTimerRef.current = window.setTimeout(() => {
            void renewMediaToken();
          }, delayMs);
        };
        scheduleMediaTokenRenewal(data?.streamTokenExpiresAt ?? null);

        const cleanupHls = () => {
          if (!hlsRef.current) return;
          try {
            hlsRef.current.destroy();
          } catch {
          }
          hlsRef.current = null;
        };

        const abortWebrtcNegotiation = () => {
          if (!webrtcAbortControllerRef.current) return;
          try {
            webrtcAbortControllerRef.current.abort();
          } catch {
          }
          webrtcAbortControllerRef.current = null;
        };

        const clearWebrtcDisconnectTimer = () => {
          if (webrtcDisconnectTimerRef.current == null) return;
          window.clearTimeout(webrtcDisconnectTimerRef.current);
          webrtcDisconnectTimerRef.current = null;
        };

        const cleanupWebrtc = async (preserveVideo = false) => {
          abortWebrtcNegotiation();
          clearWebrtcDisconnectTimer();
          if (webrtcPcRef.current) {
            try {
              webrtcPcRef.current.ontrack = null;
              webrtcPcRef.current.onconnectionstatechange = null;
              webrtcPcRef.current.oniceconnectionstatechange = null;
              webrtcPcRef.current.close();
            } catch {
            }
            webrtcPcRef.current = null;
          }
          if (webrtcStreamRef.current) {
            try {
              for (const track of webrtcStreamRef.current.getTracks()) {
                track.stop();
              }
            } catch {
            }
            webrtcStreamRef.current = null;
          }
          // Clear srcObject so HLS can take control — per the HTML media spec,
          // srcObject takes strict priority over src.  If left non-null,
          // hls.js's MediaSource object URL assigned via element.src is silently
          // ignored and the video element never renders HLS content.
          // Skipped when reconnecting WebRTC-to-WebRTC so the last decoded frame
          // stays visible during reconnect instead of flashing black.
          if (!preserveVideo) {
            try {
              element.srcObject = null;
              element.removeAttribute('src');
              element.load();
            } catch {
            }
          }
          if (webrtcSessionUrlRef.current) {
            try {
              await fetch(webrtcSessionUrlRef.current, {
                method: 'DELETE',
                mode: 'cors',
                headers: { Authorization: `Bearer ${mediaAuthTokenRef.current}` },
              });
            } catch {
            }
            webrtcSessionUrlRef.current = null;
          }
        };

        const waitForVisibleFrame = (protocol: ActiveLiveProtocol, timeoutMs: number) => new Promise<void>((resolve, reject) => {
          let interval: number | null = null;
          let blackFrameObserved = false;
          let done = false;
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            if (interval != null) window.clearInterval(interval);
            window.clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
          };
          const check = () => {
            if (cancelled) {
              finish(new Error('Inicialização cancelada.'));
              return;
            }
            if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.videoWidth <= 0 || element.videoHeight <= 0) {
              return;
            }
            if (isLikelyBlackFrame(element)) {
              blackFrameObserved = true;
              return;
            }
            finish();
          };
          const timeout = window.setTimeout(() => {
            finish(new Error(blackFrameObserved
              ? `${protocol} conectou, mas entregou apenas imagem preta.`
              : `${protocol} não entregou vídeo válido dentro do tempo limite.`));
          }, timeoutMs);
          interval = window.setInterval(check, 200);
          check();
        });

        const waitIceGatheringComplete = (pc: RTCPeerConnection, timeoutMs = 2500) => {
          return new Promise<void>((resolve) => {
            if (pc.iceGatheringState === 'complete') {
              resolve();
              return;
            }
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              window.clearTimeout(timeout);
              pc.removeEventListener('icegatheringstatechange', onStateChange);
              resolve();
            };
            const onStateChange = () => {
              if (pc.iceGatheringState === 'complete') {
                finish();
              }
            };
            const timeout = window.setTimeout(finish, timeoutMs);
            pc.addEventListener('icegatheringstatechange', onStateChange);
          });
        };

        const startWebrtc = async (whepUrl: string) => {
          cleanupHls();
          // Pass preserveVideo=true when a live frame is already visible so the
          // last decoded frame stays on screen while the new connection negotiates.
          const preserveVideoOnReconnect = preserveFrameOnReloadRef.current && hasFrameRef.current;
          await cleanupWebrtc(preserveVideoOnReconnect);

          if (typeof RTCPeerConnection === 'undefined') {
            throw new Error('Navegador sem suporte WebRTC.');
          }

          if (!preserveVideoOnReconnect) {
            element.removeAttribute('src');
            element.srcObject = null;
            element.load();
          }

          // Segunda barreira contra sessão órfã: se por qualquer caminho ainda
          // houver um `pc` na ref, ele é fechado ANTES de ser substituído.
          // Perder a referência sem fechar deixa a conexão viva no navegador e
          // o leitor vivo no servidor — foi assim que um tile acumulou três
          // sessões da mesma câmera.
          if (webrtcPcRef.current) {
            try { webrtcPcRef.current.close(); } catch { /* já encerrado */ }
          }
          const pc = new RTCPeerConnection({
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
          });
          webrtcPcRef.current = pc;

          pc.addTransceiver('video', { direction: 'recvonly' });
          pc.addTransceiver('audio', { direction: 'recvonly' });
          const abortController = new AbortController();
          webrtcAbortControllerRef.current = abortController;

          await new Promise<void>((resolve, reject) => {
            let videoTrackReceived = false;
            let visibleFrameReceived = false;
            let settled = false;
            let whepTimeout: number | null = null;
            // Poll do primeiro frame visível, sem prazo próprio: o startupTimeout
            // abaixo é o único deadline da inicialização (antes havia dois timers de
            // 8s sobrepostos, com mensagens concorrentes e até ~16s de espera real).
            let visibleFramePoll: number | null = null;
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(startupTimeout);
              if (visibleFramePoll != null) {
                window.clearInterval(visibleFramePoll);
                visibleFramePoll = null;
              }
              if (whepTimeout != null) {
                window.clearTimeout(whepTimeout);
                whepTimeout = null;
              }
              if (webrtcAbortControllerRef.current === abortController) {
                webrtcAbortControllerRef.current = null;
              }
              if (error) reject(error);
              else resolve();
            };
            let coldStartExtended = false;
            let startupTimeout = window.setTimeout(() => {
              abortController.abort();
              finish(new Error(videoTrackReceived
                ? 'WebRTC conectou, mas não entregou imagem (vídeo preto ou sem frames) dentro do tempo limite.'
                : 'WebRTC não conectou ou não entregou track de vídeo dentro do tempo limite.'));
            }, WEBRTC_FIRST_FRAME_TIMEOUT_MS);
            // Conexão WebRTC pronta, mas sem frame ainda → publisher (FFmpeg) em cold
            // start. Em vez de estourar em 8s e ir para o próximo protocolo, estende o
            // prazo do primeiro frame UMA vez para o publisher esquentar no mesmo WebRTC.
            const extendDeadlineForColdStart = () => {
              if (coldStartExtended || settled || visibleFrameReceived) return;
              coldStartExtended = true;
              window.clearTimeout(startupTimeout);
              startupTimeout = window.setTimeout(() => {
                abortController.abort();
                finish(new Error('WebRTC conectou, mas o stream demorou demais para entregar o primeiro frame (cold start do FFmpeg).'));
              }, WEBRTC_COLD_START_FRAME_TIMEOUT_MS);
            };
            const failOrRetryWebrtc = (reason: string, transient: boolean) => {
              if (cancelled || webrtcPcRef.current !== pc) return;
              if (activeProtocolRef.current === 'WEBRTC' && hasFrameRef.current) {
                if (transient) {
                  requestFreshLiveBoot(`${reason}. Retomando WebRTC...`, true);
                } else {
                  failActiveProtocol(reason);
                }
                return;
              }
              finish(new Error('Stream indisponível via WebRTC.'));
            };
            const scheduleDisconnectRecovery = (reason: string) => {
              if (webrtcDisconnectTimerRef.current != null) return;
              webrtcDisconnectTimerRef.current = window.setTimeout(() => {
                webrtcDisconnectTimerRef.current = null;
                if (cancelled || webrtcPcRef.current !== pc) return;
                if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                  return;
                }
                failOrRetryWebrtc(reason, true);
              }, WEBRTC_DISCONNECT_GRACE_MS);
            };

            pc.ontrack = (event) => {
              if (cancelled || webrtcPcRef.current !== pc) return;
              const stream = event.streams[0] ?? (() => {
                const fallback = webrtcStreamRef.current ?? new MediaStream();
                fallback.addTrack(event.track);
                return fallback;
              })();
              webrtcStreamRef.current = stream;
              if (element.srcObject !== stream) {
                element.srcObject = stream;
              }
              if (autoPlay) void element.play().catch(() => {});
              if (event.track.kind !== 'video') return;
              videoTrackReceived = true;
              clearWebrtcDisconnectTimer();
              // Espera um frame visível (não preto). Sem timer próprio: se não chegar,
              // o startupTimeout dispara com a mensagem de "conectou, mas sem imagem".
              const checkVisibleFrame = () => {
                if (cancelled || webrtcPcRef.current !== pc) {
                  finish(new Error('Inicialização WebRTC cancelada.'));
                  return;
                }
                if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || element.videoWidth <= 0 || element.videoHeight <= 0) {
                  return;
                }
                if (isLikelyBlackFrame(element)) return;
                visibleFrameReceived = true;
                markHealthy('WEBRTC');
                finish();
              };
              visibleFramePoll = window.setInterval(checkVisibleFrame, 200);
              checkVisibleFrame();
            };

            pc.onconnectionstatechange = () => {
              if (cancelled || webrtcPcRef.current !== pc) return;
              if (pc.connectionState === 'connected') {
                clearWebrtcDisconnectTimer();
                if (videoTrackReceived && visibleFrameReceived) {
                  markHealthy('WEBRTC');
                } else {
                  // Transporte pronto, mas ainda sem frame visível: provável cold
                  // start do FFmpeg do path. Espera o publisher esquentar.
                  extendDeadlineForColdStart();
                }
                return;
              }
              if (pc.connectionState === 'disconnected') {
                scheduleDisconnectRecovery('WebRTC desconectou temporariamente');
                return;
              }
              if (pc.connectionState === 'failed') {
                clearWebrtcDisconnectTimer();
                failOrRetryWebrtc('conexão WebRTC falhou', false);
                return;
              }
              if (pc.connectionState === 'closed') {
                clearWebrtcDisconnectTimer();
              }
            };

            pc.oniceconnectionstatechange = () => {
              if (cancelled || webrtcPcRef.current !== pc) return;
              if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                clearWebrtcDisconnectTimer();
                if (visibleFrameReceived) {
                  markHealthy('WEBRTC');
                } else {
                  // ICE pronto, mas sem frame ainda: dá tempo para o cold start do
                  // publisher em vez de cair para HLS + backoff.
                  extendDeadlineForColdStart();
                }
                return;
              }
              if (pc.iceConnectionState === 'disconnected') {
                scheduleDisconnectRecovery('ICE WebRTC desconectou temporariamente');
                return;
              }
              if (pc.iceConnectionState === 'failed') {
                clearWebrtcDisconnectTimer();
                failOrRetryWebrtc('ICE WebRTC falhou', false);
              }
            };

            void (async () => {
              try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await waitIceGatheringComplete(pc);
                if (cancelled || webrtcPcRef.current !== pc) {
                  throw new Error('Inicialização WebRTC cancelada.');
                }

                const localSdp = pc.localDescription?.sdp;
                if (!localSdp) {
                  throw new Error('Falha ao gerar SDP local do WebRTC.');
                }

                whepTimeout = window.setTimeout(() => {
                  abortController.abort();
                }, WEBRTC_WHEP_NEGOTIATION_TIMEOUT_MS);
                const response = await fetch(whepUrl, {
                  method: 'POST',
                  mode: 'cors',
                  headers: {
                    'Content-Type': 'application/sdp',
                    Authorization: `Bearer ${mediaAuthTokenRef.current}`,
                  },
                  body: localSdp,
                  signal: abortController.signal,
                });
                if (whepTimeout != null) {
                  window.clearTimeout(whepTimeout);
                  whepTimeout = null;
                }

                if (!response.ok) {
                  throw new Error(`Falha ao conectar WebRTC (${response.status}).`);
                }

                // VAZAMENTO DE SESSÃO (medido em produção): um tile chegou a ter
                // TRÊS sessões WebRTC vivas para a MESMA câmera. Cada uma baixa e
                // decodifica o mesmo vídeo, competindo entre si — o MediaMTX
                // registrava "reader is too slow, discarding N frames" e o
                // operador via fps baixo e travamento, com o SERVIDOR ocioso.
                //
                // A causa: a URL da sessão ia direto para uma ref COMPARTILHADA
                // entre tentativas. Quando esta tentativa já tinha sido
                // superada (timeout → retry criou outro `pc`), ela sobrescrevia
                // a URL da tentativa nova e o `pc` antigo ficava sem dono: nunca
                // fechado, sessão nunca deletada, leitor eterno no servidor.
                //
                // Agora a URL é LOCAL da tentativa. Só vira a oficial se esta
                // tentativa ainda for a corrente; caso contrário ela mesma se
                // encerra — fecha o `pc` e apaga a sessão no servidor.
                const location = response.headers.get('location');
                const sessionUrl = location ? new URL(location, whepUrl).toString() : null;
                const superada = cancelled || webrtcPcRef.current !== pc || abortController.signal.aborted;
                if (superada) {
                  try { pc.close(); } catch { /* já encerrado */ }
                  if (sessionUrl) {
                    void fetch(sessionUrl, {
                      method: 'DELETE',
                      mode: 'cors',
                      headers: { Authorization: `Bearer ${mediaAuthTokenRef.current}` },
                    }).catch(() => undefined);
                  }
                  throw new Error('Inicialização WebRTC cancelada.');
                }
                if (sessionUrl) webrtcSessionUrlRef.current = sessionUrl;

                const remoteSdp = await response.text();
                if (cancelled || webrtcPcRef.current !== pc || abortController.signal.aborted) {
                  throw new Error('Inicialização WebRTC cancelada.');
                }
                await pc.setRemoteDescription({
                  type: 'answer',
                  sdp: remoteSdp,
                });
              } catch (error) {
                const message = abortController.signal.aborted
                  ? 'WebRTC excedeu o tempo de negociação com o servidor.'
                  : error instanceof Error ? error.message : 'Falha desconhecida no WebRTC.';
                finish(new Error(message));
              }
            })();
          });
        };

        const reportProtocolFailure = (protocol: LiveProtocol, reason: string) => {
          if (!tokenHeaders) return;
          void axios.post(`${API_URL}/camera-stream/${cameraId}/live-failure`, {
            protocol,
            stage: 'startup',
            reason,
            state: activeProtocolRef.current ?? 'not-playing',
          }, { headers: tokenHeaders, timeout: 5000 }).catch(() => undefined);
        };

        const startHls = async (lowLatencyMode: boolean, protocolName: ActiveLiveProtocol) => {
          if (!hlsUrl) {
            throw new Error('Stream HLS indisponível.');
          }
          cleanupHls();
          await cleanupWebrtc();

          const HlsModule = await import('hls.js/dist/hls.mjs');
          const Hls = HlsModule.default;

          if (Hls.isSupported()) {
            const hls = new Hls({
              lowLatencyMode,
              liveSyncDurationCount: 1,
              liveMaxLatencyDurationCount: 3,
              maxLiveSyncPlaybackRate: 1.5,
              backBufferLength: 30,
              xhrSetup: (xhr) => {
                xhr.withCredentials = true;
                xhr.setRequestHeader('Authorization', `Bearer ${mediaAuthTokenRef.current}`);
              },
            });
            hlsRef.current = hls;
            const hlsFailure = new Promise<void>((_resolve, reject) => {
              hls.attachMedia(element);
              hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                hls.loadSource(hlsUrl);
              });
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                if (autoPlay) void element.play().catch(() => {});
              });
              hls.on(Hls.Events.ERROR, (_event, dataError) => {
                if (cancelled) return;
                if (dataError?.fatal) {
                  if (activeProtocolRef.current === protocolName && hasFrameRef.current) {
                    failActiveProtocol('erro fatal do manifesto ou mídia HLS');
                  } else {
                    reject(new Error('Stream indisponível via HLS.'));
                  }
                }
              });
            });
            await Promise.race([waitForVisibleFrame(protocolName, HLS_FIRST_FRAME_TIMEOUT_MS), hlsFailure]);
            markHealthy(protocolName);
            return;
          }

          if (element.canPlayType('application/vnd.apple.mpegurl')) {
            throw new Error('HLS nativo sem suporte a token seguro; use um navegador com MediaSource/WebRTC.');
          }

          throw new Error('Navegador sem suporte para HLS.');
        };

        for (const protocol of protocolOrder) {
          try {
            if (protocol === 'webrtc' && whepUrl) {
              await startWebrtc(whepUrl);
              return;
            }
            if (protocol === 'llhls' && hlsUrl) {
              await startHls(true, 'LL-HLS');
              return;
            }
            if (protocol === 'hls' && hlsUrl) {
              await startHls(false, 'HLS');
              return;
            }
          } catch (protocolError) {
            const protocolName = protocol === 'webrtc' ? 'WebRTC' : protocol === 'llhls' ? 'LL-HLS' : 'HLS';
            const failureReason = protocolError instanceof Error ? protocolError.message : 'falha desconhecida';
            failedProtocolsRef.current.add(protocol);
            reportProtocolFailure(protocol, failureReason);
            setProtocolReason(`${protocolName} falhou: ${failureReason}. Testando o próximo protocolo.`);
            console.warn(`[LiveStreamPlayer:${cameraId}] ${protocolName} falhou: ${failureReason}`);
            if (noFrameTimeout != null) window.clearTimeout(noFrameTimeout);
            noFrameTimeout = null;
            cleanupHls();
            await cleanupWebrtc();
            if (!hasFrameRef.current) {
              setActiveProtocol(null);
              activeProtocolRef.current = null;
            }
          }
        }

        failedProtocolsRef.current.clear();
        streamUrlsCache.clear(cacheKey);
        if (liveDiagnostics?.readiness?.state === 'blocked') {
          const action = liveDiagnostics.readiness.recommendedAction
            ? ` ${liveDiagnostics.readiness.recommendedAction}`
            : '';
          throw new Error(`${liveDiagnostics.readiness.userMessage ?? 'A transmissão não está pronta.'}${action}`);
        }
        if (liveDiagnostics && !liveDiagnostics.pathReady) {
          throw new Error('O MediaMTX ainda não publicou o caminho desta câmera. Verifique se a câmera está online e se o RTSP responde.');
        }
        throw new Error('Nenhum protocolo iniciou. Verifique WebRTC/WHEP, HLS, codec da câmera e conectividade com o MediaMTX.');
      } catch (streamError) {
        if (cancelled) return;
        if (axios.isAxiosError<CommercialRestrictionError>(streamError) && streamError.response?.status === 423) {
          const friendlyMessage =
            streamError.response.data?.userMessage
            ?? 'Transmissão temporariamente indisponível. Entre em contato com o administrador do sistema.';
          setError(friendlyMessage);
          setRetryMessage(null);
          setIsLoading(false);
          setActiveProtocol(null);
          activeProtocolRef.current = null;
          return;
        }
        const message = streamError instanceof Error ? streamError.message : 'Falha ao iniciar stream.';
        if (/401|403|unauthorized|forbidden|auth|credencial|senha/i.test(message)) {
          setError('Falha de autenticação da câmera: valide usuário/senha RTSP/ONVIF.');
          setRetryMessage(null);
          setIsLoading(false);
        } else {
          if (/Nenhum protocolo iniciou|MediaMTX|WebRTC|WHEP|HLS|codec/i.test(message) && !hasFrameRef.current) {
            setError(message);
            setRetryMessage('Tentaremos novamente automaticamente.');
            setIsLoading(false);
            scheduleReconnect(message);
          } else {
            scheduleReconnect(message);
          }
        }
      }
    };

    // Quando suspenso (aba oculta há muito tempo), o cleanup do ciclo anterior
    // já derrubou o WebRTC e deu DELETE na sessão; aqui apenas não rebootamos.
    // Ao voltar a ficar visível, `suspended` volta a false e o effect reexecuta,
    // disparando um boot fresco que re-anexa ao FFmpeg ainda aquecido no servidor.
    if (!suspended) {
      bootDelayTimeout = window.setTimeout(() => {
        void boot();
      }, Math.max(0, startDelayMs));
    }

    return () => {
      cancelled = true;
      if (bootDelayTimeout != null) window.clearTimeout(bootDelayTimeout);
      clearRetryTimer();
      if (noFrameTimeout != null) window.clearTimeout(noFrameTimeout);
      if (streamTokenRenewTimerRef.current != null) {
        window.clearTimeout(streamTokenRenewTimerRef.current);
        streamTokenRenewTimerRef.current = null;
      }
      if (webrtcAbortControllerRef.current) {
        try {
          webrtcAbortControllerRef.current.abort();
        } catch {
        }
        webrtcAbortControllerRef.current = null;
      }
      if (webrtcDisconnectTimerRef.current != null) {
        window.clearTimeout(webrtcDisconnectTimerRef.current);
        webrtcDisconnectTimerRef.current = null;
      }
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
        }
        hlsRef.current = null;
      }
      if (webrtcPcRef.current) {
        try {
          webrtcPcRef.current.ontrack = null;
          webrtcPcRef.current.onconnectionstatechange = null;
          webrtcPcRef.current.oniceconnectionstatechange = null;
          webrtcPcRef.current.close();
        } catch {
        }
        webrtcPcRef.current = null;
      }
      if (webrtcStreamRef.current) {
        try {
          for (const track of webrtcStreamRef.current.getTracks()) {
            track.stop();
          }
        } catch {
        }
        webrtcStreamRef.current = null;
      }
      if (webrtcSessionUrlRef.current) {
        void fetch(webrtcSessionUrlRef.current, {
          method: 'DELETE',
          mode: 'cors',
          headers: { Authorization: `Bearer ${mediaAuthTokenRef.current}` },
        }).catch(() => undefined);
        webrtcSessionUrlRef.current = null;
      }
      const preserveFrame = preserveFrameOnReloadRef.current && hasFrameRef.current;
      preserveFrameOnReloadRef.current = false;
      if (!preserveFrame) {
        element.srcObject = null;
        element.removeAttribute('src');
        element.load();
      }
    };
  }, [accessToken, authUserId, autoPlay, cameraId, deliveryMode, failActiveProtocol, getFastRetryDelay, isLikelyBlackFrame, requestFreshLiveBoot, startDelayMs, tokenHeaders, reloadNonce, suspended]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    const markProgress = () => {
      if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      lastProgressRef.current = getPlaybackProgress(element);
    };

    element.addEventListener('timeupdate', markProgress);
    element.addEventListener('playing', markProgress);
    element.addEventListener('loadeddata', markProgress);
    element.addEventListener('canplay', markProgress);
    return () => {
      element.removeEventListener('timeupdate', markProgress);
      element.removeEventListener('playing', markProgress);
      element.removeEventListener('loadeddata', markProgress);
      element.removeEventListener('canplay', markProgress);
    };
  }, []);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || typeof element.requestVideoFrameCallback !== 'function') return;

    let callbackId: number | null = null;
    let cancelled = false;
    let fpsWindowStartedAt = performance.now();
    let fpsWindowFrames = 0;
    const onFrame = (_now: number, metadata: { mediaTime?: number; presentedFrames?: number }) => {
      if (cancelled) return;
      lastRenderedFrameRef.current = {
        wallTime: Date.now(),
        mediaTime: typeof metadata.mediaTime === 'number' && Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : element.currentTime,
        presentedFrames: metadata.presentedFrames ?? lastRenderedFrameRef.current.presentedFrames + 1,
      };
      fpsWindowFrames += 1;
      const elapsedMs = performance.now() - fpsWindowStartedAt;
      if (elapsedMs >= 1200) {
        setDisplayFps(Math.max(0, Math.round((fpsWindowFrames * 1000) / elapsedMs)));
        fpsWindowStartedAt = performance.now();
        fpsWindowFrames = 0;
      }
      callbackId = element.requestVideoFrameCallback(onFrame);
    };

    callbackId = element.requestVideoFrameCallback(onFrame);
    return () => {
      cancelled = true;
      setDisplayFps(null);
      if (callbackId != null && typeof element.cancelVideoFrameCallback === 'function') {
        element.cancelVideoFrameCallback(callbackId);
      }
    };
  }, []);

  useEffect(() => {
    if (liveViewMode !== 'selected' || activeProtocol !== 'WEBRTC') {
      lastBitrateSampleRef.current = null;
      setMeasuredBitrateKbps(null);
      return;
    }

    const sample = async () => {
      const pc = webrtcPcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let bytes = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video' && !report.isRemote) {
            bytes += Number(report.bytesReceived ?? 0);
          }
        });
        const now = performance.now();
        const previous = lastBitrateSampleRef.current;
        lastBitrateSampleRef.current = { at: now, bytes };
        if (previous && bytes >= previous.bytes && now > previous.at) {
          const kbps = ((bytes - previous.bytes) * 8) / (now - previous.at);
          setMeasuredBitrateKbps(Math.max(0, Math.round(kbps)));
        }
      } catch {
        setMeasuredBitrateKbps(null);
      }
    };

    void sample();
    const interval = window.setInterval(() => void sample(), 2000);
    return () => window.clearInterval(interval);
  }, [activeProtocol, liveViewMode]);

  useEffect(() => {
    if (activeProtocol !== 'HLS' && activeProtocol !== 'LL-HLS') {
      setLiveLatencySeconds(null);
      return;
    }
    const updateLatency = () => {
      const element = videoRef.current;
      if (!element?.seekable.length) return;
      const liveEdge = element.seekable.end(element.seekable.length - 1);
      const drift = liveEdge - element.currentTime;
      setLiveLatencySeconds(Number.isFinite(drift) ? Math.max(0, drift) : null);
    };
    updateLatency();
    const interval = window.setInterval(updateLatency, 1000);
    return () => window.clearInterval(interval);
  }, [activeProtocol]);

  useEffect(() => {
    const softResumeAtLiveEdge = () => {
      const element = videoRef.current;
      if (!element || !hasFrameRef.current) return;

      const protocol = activeProtocolRef.current;

      if (protocol === 'HLS') {
        try {
          hlsRef.current?.startLoad?.(-1);
          const liveSyncPosition = hlsRef.current?.liveSyncPosition;
          if (typeof liveSyncPosition === 'number' && Number.isFinite(liveSyncPosition)) {
            element.currentTime = Math.max(0, liveSyncPosition - LIVE_EDGE_OFFSET_SECONDS);
          } else {
            seekVideoToLiveEdge(element);
          }
        } catch {
          try {
            hlsRef.current?.recoverMediaError?.();
            hlsRef.current?.startLoad?.(-1);
          } catch {
          }
        }
      } else if (protocol === 'LL-HLS') {
        try {
          hlsRef.current?.startLoad?.(-1);
          seekVideoToLiveEdge(element);
        } catch {
        }
      }

      if (autoPlay) {
        void element.play().catch(() => {});
      }
    };

    const markHidden = () => {
      if (hiddenAtRef.current == null) {
        hiddenAtRef.current = Date.now();
      }
      // Agenda a suspensão: se a aba seguir oculta além do limite, derruba o
      // WebRTC para parar o transcode/banda no servidor.
      if (suspendTimerRef.current == null && !suspendedRef.current) {
        suspendTimerRef.current = window.setTimeout(() => {
          suspendTimerRef.current = null;
          if (!document.hidden) return;
          suspendedRef.current = true;
          setSuspended(true);
        }, LIVE_HIDDEN_SUSPEND_MS);
      }
    };

    const resumeFromBrowserLifecycle = (forceReconnect = false) => {
      const hiddenForMs = hiddenAtRef.current == null ? 0 : Date.now() - hiddenAtRef.current;
      hiddenAtRef.current = null;

      // Cancela qualquer suspensão pendente ao voltar à aba.
      if (suspendTimerRef.current != null) {
        window.clearTimeout(suspendTimerRef.current);
        suspendTimerRef.current = null;
      }

      // Se chegamos a suspender, basta retomar: o effect principal reexecuta e
      // faz um boot fresco que re-anexa ao FFmpeg ainda quente no servidor.
      if (suspendedRef.current) {
        suspendedRef.current = false;
        setSuspended(false);
        return;
      }

      if (forceReconnect) {
        softResumeAtLiveEdge();
        window.setTimeout(() => {
          const element = videoRef.current;
          if (!element || document.hidden) return;
          if (element.paused || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            requestFreshLiveBoot('Retomando câmera em tempo real...');
          }
        }, 900);
        return;
      }

      if (hiddenForMs > 0 && hiddenForMs < LIVE_RESUME_GRACE_MS) return;
      softResumeAtLiveEdge();

      if (hiddenForMs >= LIVE_SOFT_ONLY_RESUME_MS) {
        const before = lastProgressRef.current;
        window.setTimeout(() => {
          const element = videoRef.current;
          if (!element || document.hidden) return;
          const currentMediaTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
          const progressed = Math.abs(currentMediaTime - before.mediaTime) > 0.05;
          if (!progressed && element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            requestFreshLiveBoot('Retomando câmera em tempo real...');
          }
        }, 1200);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        markHidden();
        return;
      }
      resumeFromBrowserLifecycle();
    };

    const onFocus = () => resumeFromBrowserLifecycle();
    const onPageShow = (event: PageTransitionEvent) => resumeFromBrowserLifecycle(event.persisted);
    const onPageHide = () => markHidden();
    const onFreeze = () => markHidden();
    const onResume = () => resumeFromBrowserLifecycle();

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);
    window.addEventListener('blur', markHidden);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
      window.removeEventListener('blur', markHidden);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      if (suspendTimerRef.current != null) {
        window.clearTimeout(suspendTimerRef.current);
        suspendTimerRef.current = null;
      }
    };
  }, [autoPlay, requestFreshLiveBoot]);

  useEffect(() => {
    const softRecoverStalledPlayer = () => {
      const element = videoRef.current;
      if (!element) return;

      const protocol = activeProtocolRef.current;
      if (protocol === 'HLS') {
        try {
          hlsRef.current?.startLoad?.(-1);
          seekVideoToLiveEdge(element);
        } catch {
          try {
            hlsRef.current?.recoverMediaError?.();
          } catch {
          }
        }
      } else if (protocol === 'LL-HLS') {
        try {
          hlsRef.current?.startLoad?.(-1);
          seekVideoToLiveEdge(element);
        } catch {
        }
      }

      if (autoPlay) {
        void element.play().catch(() => {});
      }
    };

    const interval = window.setInterval(() => {
      if (document.hidden || isLoading || error || !hasFrameRef.current) return;

      const element = videoRef.current;
      if (!element) return;

      if (autoPlay && element.paused) {
        void element.play().catch(() => {});
      }

      const now = Date.now();
      const renderedFrame = lastRenderedFrameRef.current;
      // Only trigger the rVFC stall watchdog when the video is actually playing.
      // rVFC stops firing when the element is paused (e.g. autoplay blocked by
      // the browser policy), which would otherwise cause a spurious reconnect
      // after LIVE_RENDER_STALL_RECONNECT_MS even though nothing is wrong.
      if (
        typeof element.requestVideoFrameCallback === 'function'
        && !element.paused
        && now - renderedFrame.wallTime >= LIVE_RENDER_STALL_RECONNECT_MS
      ) {
        failActiveProtocol('imagem congelada sem novos frames');
        return;
      }

      // Detecção de frame PRETO persistente (readback de GPU custoso → só no tile
      // em destaque). Mede ausência real de vídeo, não falta de movimento.
      //
      // IMPORTANTE: NÃO usamos mais detecção de "congelamento" por mudança de pixels.
      // Cena estática (corredor vazio, parede, portão parado) entrega frames idênticos
      // o tempo todo numa câmera 100% saudável — reconectar nesse caso é falso-positivo
      // e fazia a tela piscar a cada ~45s sem motivo. O sinal correto de vivacidade é o
      // watchdog de render (rVFC) acima: se frames novos continuam sendo apresentados,
      // o stream está vivo, com ou sem movimento na cena.
      if (liveViewMode === 'selected') {
        if (isLikelyBlackFrame(element)) {
          if (blackFrameSinceRef.current == null) blackFrameSinceRef.current = now;
          if (now - blackFrameSinceRef.current >= LIVE_BLACK_FRAME_FAILOVER_MS) {
            blackFrameSinceRef.current = null;
            failActiveProtocol('imagem preta persistente');
            return;
          }
        } else {
          blackFrameSinceRef.current = null;
        }
      }

      // O watchdog de progresso por `video.currentTime` SÓ vale para HLS/LL-HLS.
      // No WebRTC (srcObject = MediaStream) o currentTime é um sinal de vida não
      // confiável: em vários navegadores ele fica congelado mesmo com os frames
      // renderizando normalmente. Confiar nele fazia TODOS os tiles do grid
      // reconectarem em lote a cada ~16s (tela piscando). Para WebRTC, a vivacidade
      // já é garantida pelo watchdog de render (rVFC) acima; só caímos no stall por
      // currentTime quando o rVFC não existe no navegador.
      const protocol = activeProtocolRef.current;
      const rvfcSupported = typeof element.requestVideoFrameCallback === 'function';
      const useCurrentTimeStall = protocol !== 'WEBRTC' || !rvfcSupported;

      if (useCurrentTimeStall) {
        const currentMediaTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
        const lastProgress = lastProgressRef.current;
        if (Math.abs(currentMediaTime - lastProgress.mediaTime) > 0.05) {
          lastProgressRef.current = { wallTime: now, mediaTime: currentMediaTime };
          return;
        }

        const stalledForMs = now - lastProgress.wallTime;
        if (stalledForMs >= LIVE_STALL_RECONNECT_MS) {
          failActiveProtocol('transmissão sem progresso');
          return;
        }

        if (stalledForMs >= LIVE_STALL_SOFT_RECOVER_MS) {
          softRecoverStalledPlayer();
          return;
        }
      } else {
        // WebRTC: mantém o marcador de progresso sincronizado para evitar um
        // disparo espúrio caso o protocolo volte a HLS depois.
        lastProgressRef.current = {
          wallTime: now,
          mediaTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
        };
      }

      // Recuperação de latência (HLS/LL-HLS). Antes: SALTO seco para a borda ao
      // vivo sempre que a deriva passava de 3,5s — visível como "pulo" na imagem.
      // Agora, técnica do Frigate: deriva moderada é absorvida ACELERANDO a
      // reprodução suavemente (curva exponencial, teto 1,5×) até reencostar no
      // ao vivo — o operador não percebe o ajuste. O salto seco fica só para
      // deriva grande (ex.: aba oculta), onde acelerar demoraria demais.
      if (protocol === 'HLS' || protocol === 'LL-HLS') {
        const ranges = element.seekable;
        if (ranges.length > 0) {
          const liveEdge = ranges.end(ranges.length - 1);
          const drift = liveEdge - element.currentTime;
          if (Number.isFinite(drift)) {
            if (drift > LIVE_DRIFT_HARD_SEEK_SECONDS) {
              element.playbackRate = 1;
              seekVideoToLiveEdge(element);
            } else if (drift > LIVE_DRIFT_CATCHUP_SECONDS) {
              const rate = Math.min(
                LIVE_DRIFT_MAX_RATE,
                1 + 0.2 * Math.exp(0.5 * (drift - LIVE_DRIFT_CATCHUP_SECONDS)),
              );
              if (Math.abs(element.playbackRate - rate) > 0.02) element.playbackRate = rate;
            } else if (element.playbackRate !== 1) {
              element.playbackRate = 1; // reencostou: volta ao tempo normal
            }
          }
        }
      } else if (element.playbackRate !== 1) {
        // WebRTC não acumula buffer: nunca deve ficar acelerado.
        element.playbackRate = 1;
      }
    }, LIVE_STALL_CHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [autoPlay, error, failActiveProtocol, isLikelyBlackFrame, isLoading, liveViewMode]);

  useEffect(() => {
    if (!aiOverlayEnabled || !accessToken || !tokenHeaders) return;
    const sessionId = liveViewSessionIdRef.current;

    const postLease = async (action: 'start' | 'heartbeat' | 'stop') => {
      try {
        await axios.post(
          `${API_URL}/ai/live-view/${action}/${cameraId}`,
          { sessionId, ttlSeconds: LIVE_VIEW_LEASE_TTL_SECONDS, viewMode: liveViewModeRef.current },
          { headers: tokenHeaders },
        );
      } catch {
      }
    };

    void postLease('start');
    const heartbeat = window.setInterval(() => {
      void postLease('heartbeat');
    }, LIVE_VIEW_HEARTBEAT_MS);

    return () => {
      window.clearInterval(heartbeat);
      void postLease('stop');
    };
  }, [accessToken, aiOverlayEnabled, cameraId, tokenHeaders]);

  useEffect(() => {
    if (!aiOverlayEnabled || !accessToken || error) {
      setDetections([]);
      return;
    }

    // Assina o poller compartilhado: todos os tiles são agregados em uma única
    // requisição em lote por ciclo, em vez de uma requisição por câmera.
    const unsubscribe = liveDetectionsPoller.subscribe(cameraId, setDetections);
    return () => {
      unsubscribe();
      setDetections([]);
    };
  }, [accessToken, aiOverlayEnabled, cameraId, error]);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden bg-black ${className ?? ''}`}
      aria-label={`Live ${cameraName}`}
      onDoubleClick={() => setZoom(1)}
    >
      <div
        className="absolute inset-0 w-full h-full"
        style={{
          transform: zoom !== 1 ? `scale(${zoom})` : undefined,
          transformOrigin: 'center',
          transition: zoom === 1 ? 'transform 0.2s ease-out' : 'none',
        }}
      >
        {posterUrl && !hasLiveFrame && (
          <img
            src={posterUrl}
            alt=""
            onError={() => requestFreshLiveBoot('Atualizando amostra da câmera...', false)}
            className={`absolute inset-0 h-full w-full opacity-80 ${liveViewMode === 'grid' ? 'object-cover' : 'object-contain'}`}
            draggable={false}
          />
        )}

        <video
          ref={videoRef}
          // Na GRADE preenche a célula (object-cover) — some a borda preta e as
          // imagens encaixam melhor. Na câmera selecionada/1x1 mantém o frame
          // inteiro (object-contain, sem cortar — requisito CCTV). O cálculo do
          // overlay de IA lê o objectFit computado, então se adapta sozinho.
          className={`relative z-10 h-full w-full pointer-events-none transition-opacity duration-300 ${
            liveViewMode === 'grid' ? 'object-cover' : 'object-contain'
          } ${
            posterUrl && !hasLiveFrame ? 'opacity-0' : 'opacity-100'
          }`}
          muted={isMuted}
          playsInline
          autoPlay={autoPlay}
        />
      </div>

      {aiOverlayEnabled && detections.map((detection) => {
        // MOVIMENTO NUNCA desenha caixa. O MOG2 existe para ARMAR a gravação,
        // não para virar overlay: a "confiança" dele é a área alterada
        // (satura em 100% com qualquer mudança grande — luz, IR, pessoa
        // perto), então a caixa "motion 100%" cobria a tela e parecia uma IA
        // avançada alucinando. Pedido explícito do dono: detector segue
        // funcionando, quadrado não aparece em câmera nenhuma. Caixas de
        // OBJETO/FACE (quando habilitadas) continuam passando por aqui.
        if (detection.label === 'motion' || detection.type.startsWith('MOTION')) return null;
        const [x1, y1, x2, y2] = detection.bbox;
        const fallbackVideoWidth = videoRef.current?.videoWidth || 320;
        const fallbackVideoHeight = videoRef.current?.videoHeight || 180;
        const frameWidth = detection.frameWidth && detection.frameWidth > 0 ? detection.frameWidth : fallbackVideoWidth;
        const frameHeight = detection.frameHeight && detection.frameHeight > 0 ? detection.frameHeight : fallbackVideoHeight;
        const containerWidth = containerRef.current?.clientWidth ?? 0;
        const containerHeight = containerRef.current?.clientHeight ?? 0;
        let style: CSSProperties;
        if (containerWidth > 0 && containerHeight > 0) {
          const videoRect = getRenderedVideoRect(videoRef.current, containerWidth, containerHeight);
          const leftPx = videoRect.left + (x1 / frameWidth) * videoRect.width;
          const topPx = videoRect.top + (y1 / frameHeight) * videoRect.height;
          const rightPx = videoRect.left + (x2 / frameWidth) * videoRect.width;
          const bottomPx = videoRect.top + (y2 / frameHeight) * videoRect.height;
          const visibleLeft = Math.max(0, Math.min(containerWidth, leftPx));
          const visibleTop = Math.max(0, Math.min(containerHeight, topPx));
          const visibleRight = Math.max(visibleLeft + 1, Math.min(containerWidth, rightPx));
          const visibleBottom = Math.max(visibleTop + 1, Math.min(containerHeight, bottomPx));
          style = {
            left: `${visibleLeft}px`,
            top: `${visibleTop}px`,
            width: `${visibleRight - visibleLeft}px`,
            height: `${visibleBottom - visibleTop}px`,
          };
        } else {
          const left = Math.max(0, Math.min(100, (x1 / frameWidth) * 100));
          const top = Math.max(0, Math.min(100, (y1 / frameHeight) * 100));
          const width = Math.max(1, Math.min(100 - left, ((x2 - x1) / frameWidth) * 100));
          const height = Math.max(1, Math.min(100 - top, ((y2 - y1) / frameHeight) * 100));
          style = { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` };
        }
        const isFace = detection.type.startsWith('FACE');
        const isTriangle = !isFace && detection.overlayMode === 'triangle';
        const label = detection.similarity != null
          ? `${detection.label} ${(detection.similarity * 100).toFixed(0)}%`
          : detection.confidence != null
            ? `${detection.label} ${(detection.confidence * 100).toFixed(0)}%`
            : detection.label;
        if (isTriangle) {
          return (
            <div key={detection.id} className="pointer-events-none absolute z-30" style={style}>
              <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full">
                <span className="mx-auto block h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-[hsl(var(--status-warning)_/_0.9)] drop-shadow-[0_1px_1px_rgba(0,0,0,0.65)]" />
              </div>
            </div>
          );
        }
        return (
          <div
            key={detection.id}
            className={`pointer-events-none absolute z-30 rounded-sm border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.45)] ${
              isFace ? 'border-[hsl(var(--status-online))]' : 'border-[hsl(var(--status-warning))]'
            }`}
            style={style}
          >
            <span
              className={`absolute -top-6 left-0 max-w-40 truncate rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black ${
                isFace ? 'bg-[hsl(var(--status-online))]' : 'bg-[hsl(var(--status-warning))]'
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}

      {showOverlay && isLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className={`flex items-center gap-2 rounded-md border border-white/10 bg-black/45 text-white/75 ${
            compactLiveOverlay ? 'px-2 py-1 text-[10px]' : 'px-3 py-2 text-xs'
          }`}>
            <LoaderCircle className={`${compactLiveOverlay ? 'h-3 w-3' : 'h-4 w-4'} animate-spin`} />
            {loadingLabel}
          </div>
        </div>
      )}

      {showOverlay && error && compactLiveOverlay && (
        <div className="absolute inset-x-1 bottom-1 z-20 flex justify-center">
          <div className="flex max-w-[92%] items-center gap-1.5 rounded border border-white/10 bg-black/68 px-2 py-1 text-[10px] text-white/75 backdrop-blur-[2px]">
            <AlertTriangle className="h-3 w-3 shrink-0 text-[hsl(var(--status-warning))]" />
            <span className="truncate">{compactErrorLabel}</span>
          </div>
        </div>
      )}

      {showOverlay && error && !compactLiveOverlay && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
          <div className="max-w-[85%] rounded-lg border border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.1)] px-4 py-3 text-center text-xs text-[hsl(var(--destructive))]">
            <div className="mb-2 flex items-center justify-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Sem imagem da câmera
            </div>
            <div>{friendlyLiveText(error, 'Não foi possível conectar à câmera agora. A reconexão é automática — verifique se a câmera está ligada e com rede.')}</div>
            {errorIsTechnical && (
              <details className="mt-2 text-left text-[10px] text-[hsl(var(--destructive))]/70">
                <summary className="cursor-pointer select-none">Detalhes técnicos</summary>
                <div className="mt-1 break-words font-mono text-[9px]">{error}</div>
              </details>
            )}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setIsLoading(true);
                setReloadNonce((value) => value + 1);
              }}
              className="mt-3 inline-flex h-8 items-center justify-center rounded border border-[hsl(var(--destructive)_/_0.35)] bg-black/30 px-3 text-[11px] text-[hsl(var(--destructive))] hover:bg-black/45"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      {notice && !error && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-4">
          <div
            role="status"
            className="pointer-events-auto flex max-w-[92%] items-start gap-2 rounded-lg border border-amber-400/40 bg-black/80 px-3 py-2 text-[11.5px] leading-snug text-amber-100 shadow-lg backdrop-blur-sm"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>{notice}</span>
            <button
              type="button"
              aria-label="Fechar aviso"
              onClick={() => setNotice(null)}
              className="ml-1 shrink-0 rounded px-1 text-amber-200/70 hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-300"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {zoom > 1 && (
        <div className="absolute top-2 left-2 z-30 rounded-sm border border-white/10 bg-black/45 px-1.5 py-0.5 text-[9px] font-mono text-white/70">
          {zoom.toFixed(1)}×
        </div>
      )}

      {showOverlay && (activeProtocol || displayFps != null || liveViewMode === 'selected') && (
        <div className="absolute top-2 right-2 z-30 flex max-w-[78%] flex-wrap items-center justify-end gap-1.5 opacity-85 transition-opacity hover:opacity-100">
          {liveViewMode === 'selected' && (
            <span
              role="group"
              aria-label="Qualidade da transmissão ao vivo"
              className="inline-flex items-center gap-0.5 rounded-md border border-white/15 bg-black/60 p-0.5 backdrop-blur-sm shadow-sm"
            >
              {([
                ['instant', 'Instantâneo', 'Substream da câmera: imagem menor, menor latência e menos banda. Use em redes lentas ou muitas câmeras.'],
                ['balanced', 'Equilibrado', 'Resolução original convertida para H.264 — compatível com todos os navegadores. Padrão recomendado.'],
                [
                  'max',
                  'Máxima',
                  BROWSER_DECODES_HEVC
                    ? 'Vídeo original da câmera sem conversão (preserva o H.265 quando a câmera usa esse codec). Pode ter 1–3 s de atraso.'
                    : 'Vídeo original sem conversão. Este navegador NÃO reproduz H.265 — em câmeras H.265 a exibição volta automaticamente ao Equilibrado (H.264). No Safari, mostra o H.265 real.',
                ],
              ] as const).map(([mode, label, hint]) => {
                const isActive = qualityMode === mode;
                // Máxima só "degrada" quando a câmera ATUAL é H.265 E o navegador não a
                // decodifica → aí a Máxima cai para H.264. Numa câmera H.264, a Máxima
                // (passthrough) funciona em qualquer navegador, então não marca nada.
                const cameraIsHevc = /h265|hevc|hvc1|265/i.test(String(sourceVideoCodec ?? ''));
                const maxDegraded = mode === 'max' && !BROWSER_DECODES_HEVC && cameraIsHevc;
                return (
                  <button
                    key={mode}
                    type="button"
                    title={hint}
                    aria-pressed={isActive}
                    aria-label={`Qualidade ${label}`}
                    onClick={() => changeQuality(mode)}
                    className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[10.5px] font-semibold tracking-wide transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${
                      isActive
                        ? 'bg-[hsl(var(--primary))] text-white shadow'
                        : 'text-white/75 hover:bg-white/15 hover:text-white'
                    }`}
                  >
                    {label}
                    {maxDegraded ? <span className="text-[8px] font-normal opacity-70" aria-hidden="true">H.265</span> : null}
                  </button>
                );
              })}
            </span>
          )}
          {!compactLiveOverlay && videoRef.current?.videoWidth ? (
            <span className="inline-flex h-6 items-center rounded border border-white/15 bg-black/55 px-2 text-[10px] font-semibold tracking-wide text-white/80">
              {videoRef.current.videoWidth}×{videoRef.current.videoHeight}
            </span>
          ) : null}
          {!compactLiveOverlay && sourceVideoCodec ? (
            <span className="inline-flex h-6 items-center rounded border border-white/15 bg-black/55 px-2 text-[10px] font-semibold uppercase tracking-wide text-white/80">
              {sourceVideoCodec}{isTranscodedForBrowser ? ' → H.264' : ''}
            </span>
          ) : null}
          {!compactLiveOverlay && measuredBitrateKbps != null ? (
            <span className="inline-flex h-6 items-center rounded border border-white/15 bg-black/55 px-2 text-[10px] font-semibold tracking-wide text-white/80">
              {measuredBitrateKbps >= 1000
                ? `${(measuredBitrateKbps / 1000).toFixed(1)} Mbps`
                : `${measuredBitrateKbps} kbps`}
            </span>
          ) : null}
          {displayFps != null && (
            <span className="inline-flex h-4 items-center rounded-sm border border-white/10 bg-black/40 px-1.5 text-[8px] font-medium tracking-wider text-white/65">
              {displayFps} FPS
            </span>
          )}
          {activeProtocol && (
          <span
            className={`inline-flex h-4 items-center rounded-sm border px-1.5 text-[8px] font-medium tracking-wider ${
              activeProtocol === 'WEBRTC'
                ? 'border-[hsl(var(--status-online)_/_0.25)] bg-black/40 text-[hsl(var(--status-online))]/85'
                : activeProtocol === 'HLS'
                  ? 'border-[hsl(var(--status-warning)_/_0.25)] bg-black/40 text-[hsl(var(--status-warning))]/85'
                  : 'border-[hsl(var(--primary)_/_0.25)] bg-black/40 text-[hsl(var(--primary))]/85'
            }`}
          >
            {activeProtocol === 'WEBRTC'
              ? 'WEBRTC'
              : activeProtocol === 'LL-HLS'
                ? 'LL-HLS'
                : 'HLS'}
          </span>
          )}
        </div>
      )}

      {showOverlay && !compactLiveOverlay && (activeProtocol === 'HLS' || activeProtocol === 'LL-HLS') && (
        <button
          type="button"
          onClick={() => {
            const element = videoRef.current;
            if (element) seekVideoToLiveEdge(element);
          }}
          className="absolute bottom-2 left-2 z-30 inline-flex h-7 items-center gap-1.5 rounded-full border border-[hsl(var(--status-online)_/_0.35)] bg-black/60 px-2.5 text-[9px] font-semibold text-[hsl(var(--status-online))] hover:bg-black/75"
          title="Voltar para a borda ao vivo"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Ao vivo{liveLatencySeconds != null ? ` · ${liveLatencySeconds.toFixed(1)}s` : ''}
        </button>
      )}

      {showOverlay && !isLoading && !error && (
        <button
          type="button"
          onClick={() => {
            const nextMuted = !isMuted;
            setIsMuted(nextMuted);
            const element = videoRef.current;
            if (element) {
              element.muted = nextMuted;
              element.volume = nextMuted ? element.volume : 1;
              if (!nextMuted) {
                void element.play().catch(() => {
                  // Alguns navegadores exigem novo gesto se a aba perdeu foco; o botão continua disponível.
                });
              }
            }
          }}
          className="absolute bottom-2 right-2 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/55 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
          title={isMuted ? 'Ativar áudio' : 'Mutar áudio'}
        >
          {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      )}

      {!cameraId && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
          <div className="flex items-center gap-2 text-xs text-white/60">
            <VideoOff className="h-4 w-4" />
            Nenhuma câmera selecionada
          </div>
        </div>
      )}
    </div>
  );
}
