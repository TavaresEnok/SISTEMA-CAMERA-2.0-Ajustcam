import axios from 'axios';
import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type MouseEvent, type ReactNode, type SelectHTMLAttributes, type WheelEvent as ReactWheelEvent } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BellRing,
  Camera,
  Circle,
  ChevronLeft,
  ChevronDown,
  Crosshair,
  ExternalLink,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Network,
  Radar,
  RotateCcw,
  SlidersHorizontal,
  Stethoscope,
  Video,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DetectionZonesEditor, type DetectionZone } from '../components/DetectionZonesEditor';
import { cn } from '@/lib/utils';
import { LiveStreamPlayer, type LivePlayerStatus } from '../components/LiveStreamPlayer';
import { toast } from '../hooks/use-toast';
import { getApiBaseUrl } from '../lib/api-base';
import { sendPtzCommand, type PTZDirection } from '../lib/ptz';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import {
  getRecordingModeCopy,
  normalizePreferredLiveProtocol,
  normalizeVideoCodec,
  type RecordingMode,
  type VideoCodec,
} from '../lib/camera-format';
import {
  diagnosticsTone,
  orderFindings,
  parseDiagnosticsReport,
  reportTone,
  summarizeTranscode,
  type CameraDiagnosticsView,
} from '../lib/camera-diagnostics';
import {
  describePreviewSource,
  describePreviewStream,
  parsePreviewFrame,
  type PreviewFrame,
} from '../lib/camera-preview-frame';

const API_URL = getApiBaseUrl();

const RESOLUTION_PRESETS = [
  { label: 'HD 720p', width: 1280, height: 720 },
  { label: 'Full HD 1080p', width: 1920, height: 1080 },
  { label: 'QHD 1440p', width: 2560, height: 1440 },
  { label: '4K UHD', width: 3840, height: 2160 },
] as const;

const GRID_LIVE_MAX_WIDTH = 1280;
const GRID_LIVE_MAX_HEIGHT = 720;
const GRID_LIVE_TARGET_FPS = 20;

type CommandState = 'idle' | 'sending' | 'ok' | 'error';
type LiveSourceMode = 'original' | 'economical' | 'advanced';

type CameraConfig = {
  name: string;
  ip: string;
  rtspPort: string;
  onvifPort: string;
  username: string;
  password: string;
  rtspPath: string;
  onvifPath: string;
  onvifProfileToken: string;
  channel: string;
  subtype: string;
  liveChannel: string;
  liveSubtype: string;
  recordingChannel: string;
  recordingSubtype: string;
  analyticsChannel: string;
  analyticsSubtype: string;
  recordingEnabled: boolean;
  recordingMode: RecordingMode;
  retentionDays: string;
  retentionFollowsGroup: boolean;
  preferredRtspTransport: 'tcp' | 'udp';
  preferredLiveProtocol: 'hls' | 'llhls' | 'webrtc' | 'mjpeg';
  streamVideoCodec: VideoCodec;
  streamWidth: string;
  streamHeight: string;
  streamFps: string;
  streamBitrateKbps: string;
  recordingVideoCodec: VideoCodec;
  recordingWidth: string;
  recordingHeight: string;
  recordingFps: string;
  recordingBitrateKbps: string;
  audioEnabled: boolean;
  alarmsEnabled: boolean;
  hasEdgeAi: boolean;
  motionTrigger: string;
};

type PtzDiagnostics = {
  cameraId: string;
  ip: string;
  configured: {
    onvifPort: number | null;
    onvifPath: string | null;
    onvifProfileToken: string | null;
    channel: number | null;
  };
  detected: {
    ok: boolean;
    protocol?: 'onvif' | 'vendor_http' | null;
    onvifPort: number | null;
    onvifPath: string | null;
    onvifProfileToken: string | null;
  };
  ptzLikelyWorking: boolean;
};

type RecordingRuntimeStatus = {
  isRecording: boolean;
  statusDetail?: string | null;
  lastSegmentAgeSeconds?: number | null;
};

type CameraPipelineSummary = {
  architecture?: {
    separated?: boolean;
    rule?: string;
  };
  live?: {
    channel?: number;
    subtype?: number;
    codec?: string | null;
    width?: number | null;
    height?: number | null;
    fps?: number | null;
    selectedWidth?: number | null;
    selectedHeight?: number | null;
    selectedFps?: number | null;
    browserProtocol?: string | null;
    browserCodec?: string | null;
    transcodeForBrowser?: boolean;
    rtspUrl?: string | null;
  };
  recording?: {
    channel?: number;
    subtype?: number;
    sourceCodec?: string | null;
    targetCodec?: string | null;
    width?: number | null;
    height?: number | null;
    fps?: number | null;
    mode?: string | null;
    enabled?: boolean;
    rtspUrl?: string | null;
  };
  analytics?: {
    channel?: number;
    subtype?: number;
    source?: string | null;
    usesMediaMtx?: boolean;
    separatedFromLive?: boolean;
    expectedCodec?: string | null;
    rtspUrl?: string | null;
  };
  notes?: string[];
};

const emptyConfig: CameraConfig = {
  name: '',
  ip: '',
  rtspPort: '554',
  onvifPort: '80',
  username: '',
  password: '',
  rtspPath: '',
  onvifPath: '',
  onvifProfileToken: '',
  channel: '1',
  subtype: '0',
  liveChannel: '',
  liveSubtype: '',
  recordingChannel: '',
  recordingSubtype: '',
  analyticsChannel: '',
  analyticsSubtype: '',
  recordingEnabled: true,
  recordingMode: 'continuous',
  retentionDays: '3',
  retentionFollowsGroup: true,
  preferredRtspTransport: 'tcp',
  preferredLiveProtocol: 'webrtc',
  streamVideoCodec: 'original',
  streamWidth: String(GRID_LIVE_MAX_WIDTH),
  streamHeight: String(GRID_LIVE_MAX_HEIGHT),
  streamFps: String(GRID_LIVE_TARGET_FPS),
  streamBitrateKbps: '',
  recordingVideoCodec: 'h265',
  recordingWidth: '',
  recordingHeight: '',
  recordingFps: '',
  recordingBitrateKbps: '',
  audioEnabled: false,
  alarmsEnabled: true,
  hasEdgeAi: false,
  motionTrigger: 'SYSTEM',
};

function resolveLiveSourceMode(liveSubtype: string, fallbackSubtype: string): LiveSourceMode {
  const selectedSubtype = Number(liveSubtype.trim() ? liveSubtype : fallbackSubtype);
  if (selectedSubtype === 0) return 'original';
  if (selectedSubtype === 1) return 'economical';
  return 'advanced';
}

function SettingsCard({
  icon: Icon,
  title,
  description,
  action,
  children,
  className,
}: {
  icon?: typeof Camera;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm', className)}>
      <header className="flex items-start gap-3 border-b border-border/70 px-5 py-3.5">
        {Icon ? (
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/60 text-muted-foreground">
            <Icon className="h-4 w-4" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className="flex-1 px-5 py-4">{children}</div>
    </section>
  );
}

function SettingsField({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cn('grid content-start gap-1.5', wide ? 'md:col-span-2' : '')}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-relaxed text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

function SettingsInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'h-10 w-full rounded-lg border border-border bg-muted/40 px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-primary/50 focus:bg-card focus:ring-2 focus:ring-primary/15 read-only:cursor-default read-only:bg-muted/30 read-only:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60',
        props.className,
      )}
    />
  );
}

function SettingsSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'h-10 w-full rounded-lg border border-border bg-muted/40 px-3 text-sm text-foreground outline-none transition focus:border-primary/50 focus:bg-card focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60',
        props.className,
      )}
    />
  );
}

function SettingsSwitch({ checked, onChange, label, description }: { checked: boolean; onChange: (value: boolean) => void; label: string; description: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'flex w-full items-center justify-between gap-4 rounded-lg border px-4 py-3 text-left transition',
        checked
          ? 'border-primary/35 bg-primary/[0.06] hover:bg-primary/[0.09]'
          : 'border-border bg-muted/30 hover:border-border hover:bg-accent/40',
      )}
      aria-pressed={checked}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted-foreground/30')}>
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
      </span>
    </button>
  );
}

function SettingsStat({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className={cn('mt-1 truncate text-sm font-semibold text-foreground', mono && 'font-mono')}>{value}</div>
    </div>
  );
}

/**
 * CONFIRMAÇÃO VISUAL na edição: o frame que prova que este IP é a câmera certa.
 * Metadado (resolução/codec/fps) é idêntico entre câmeras diferentes; a imagem não.
 */
function CameraPreviewFrameCard({ frame }: { frame: PreviewFrame }) {
  const sourceLabel = describePreviewSource(frame.source);
  const streamLabel = describePreviewStream(frame.stream);
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Confirmação visual</h3>
      </div>
      {frame.ok && frame.imageDataUrl ? (
        <div className="mt-3 space-y-2">
          <img
            src={frame.imageDataUrl}
            alt="Frame capturado da câmera para conferência"
            className="max-h-[360px] w-full rounded-lg border border-border bg-black object-contain"
          />
          <p className="text-[11px] text-muted-foreground">
            {[streamLabel, sourceLabel].filter(Boolean).join(' · ') || 'Imagem capturada agora.'}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-[hsl(var(--status-warning))]">
          Sem imagem para conferir. {frame.reason}
        </p>
      )}
    </div>
  );
}

/**
 * DIAGNÓSTICO RICO da câmera já salva: DETECTADO agora × CONFIGURADO. A
 * divergência é o diagnóstico — é ela que evita a volta ao local.
 */
function CameraDiagnosticsCard({ report }: { report: CameraDiagnosticsView }) {
  const tone = reportTone(report);
  const transcodeLines = summarizeTranscode(report.transcode);
  return (
    <div
      className={cn(
        'rounded-xl border bg-card px-5 py-4 shadow-sm',
        tone === 'bad' && 'border-[hsl(var(--destructive)_/_0.4)]',
        tone === 'warn' && 'border-[hsl(var(--status-warning)_/_0.4)]',
        tone === 'good' && 'border-[hsl(var(--status-online)_/_0.4)]',
        tone === 'neutral' && 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Diagnóstico detalhado</h3>
        </div>
        <StatusPill
          label={report.state === 'ok' ? 'Sem divergência' : report.state === 'diverged' ? 'Divergente' : 'Não confirmado'}
          tone={tone}
        />
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{report.summary}</p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <th className="pb-1.5 pr-3 font-semibold">Item</th>
              <th className="pb-1.5 pr-3 font-semibold">Configurado</th>
              <th className="pb-1.5 pr-3 font-semibold">Detectado agora</th>
            </tr>
          </thead>
          <tbody>
            {orderFindings(report.findings).map((finding) => {
              const itemTone = diagnosticsTone(finding);
              return (
                <tr key={finding.key} className="border-t border-border/60 align-top">
                  <td className="py-1.5 pr-3 text-foreground">{finding.label}</td>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{finding.configured ?? '--'}</td>
                  <td
                    className={cn(
                      'py-1.5 pr-3 font-mono',
                      itemTone === 'bad' && 'text-[hsl(var(--destructive))]',
                      itemTone === 'warn' && 'text-[hsl(var(--status-warning))]',
                      itemTone === 'good' && 'text-[hsl(var(--status-online))]',
                      itemTone === 'neutral' && 'text-muted-foreground',
                    )}
                  >
                    {finding.detected ?? 'não confirmado'}
                    {finding.state === 'diverged' && finding.message ? (
                      <span className="mt-0.5 block font-sans text-[11px] leading-relaxed">{finding.message}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Transcodificação
        </div>
        {transcodeLines.length ? (
          <ul className="mt-1 space-y-1 text-xs text-foreground">
            {transcodeLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            Nenhum pipeline está transcodificando: live e gravação seguem a fonte original.
          </p>
        )}
      </div>

      {report.error ? (
        <p className="mt-2 font-mono text-[11px] text-[hsl(var(--status-warning))]">{report.error}</p>
      ) : null}
      {report.checkedAt ? (
        <p className="mt-2 text-[10px] text-muted-foreground">
          Verificado em {new Date(report.checkedAt).toLocaleString('pt-BR')}
        </p>
      ) : null}
    </div>
  );
}

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center rounded-md border px-2.5 text-[11px] font-medium',
        tone === 'good' && 'border-[hsl(var(--status-online)_/_0.3)] bg-[hsl(var(--status-online)_/_0.1)] text-[hsl(var(--status-online))]',
        tone === 'warn' && 'border-[hsl(var(--status-warning)_/_0.3)] bg-[hsl(var(--status-warning)_/_0.1)] text-[hsl(var(--status-warning))]',
        tone === 'bad' && 'border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))]',
        tone === 'neutral' && 'border-border bg-card text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}

// Relógio do OSD isolado: atualiza a cada segundo sem re-renderizar a página inteira.
function LiveClock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className={className}>{now.toISOString().replace('T', ' ').substring(0, 19)}</span>;
}

function PtzButton({
  icon: Icon,
  label,
  active,
  disabled,
  onStart,
  onStop,
}: {
  icon: typeof ArrowUp;
  label: string;
  active: boolean;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onStart();
      }}
      onPointerUp={onStop}
      onPointerCancel={onStop}
      onLostPointerCapture={onStop}
      onKeyDown={(event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
          event.preventDefault();
          onStart();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          onStop();
        }
      }}
      onBlur={onStop}
      className={cn(
        'flex h-12 w-12 items-center justify-center rounded-xl border transition-all select-none',
        active
          ? 'border-[hsl(var(--primary)_/_0.55)] bg-[hsl(var(--primary)_/_0.14)] text-[hsl(var(--primary))] shadow-[0_0_0_1px_hsl(var(--primary)_/_0.18)]'
          : 'border-border bg-card/70 text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--primary)_/_0.35)] hover:bg-[hsl(var(--primary)_/_0.06)] hover:text-foreground',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export default function CameraDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const cameras = useVmsDataStore((state) => state.cameras);
  const events = useVmsDataStore((state) => state.events);
  const dataLoaded = useVmsDataStore((state) => state.loaded);
  const isDataLoading = useVmsDataStore((state) => state.isLoading);
  const loadData = useVmsDataStore((state) => state.load);
  const cam = cameras.find((camera) => camera.id === params.id);

  const [activeDirection, setActiveDirection] = useState<PTZDirection | null>(null);
  const activeMovementRef = useRef<{ cameraId: string; cameraName: string; direction: PTZDirection; startPromise?: ReturnType<typeof sendPtzCommand> } | null>(null);
  const [commandState, setCommandState] = useState<CommandState>('idle');
  const [lastCommand, setLastCommand] = useState('Nenhum comando PTZ enviado');
  const [lastError, setLastError] = useState<string | null>(null);

  const [videoMuted, setVideoMuted] = useState(true);
  const [videoZoom, setVideoZoom] = useState(1);
  const [videoPan, setVideoPan] = useState({ x: 0, y: 0 });
  const [draggingVideo, setDraggingVideo] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const [form, setForm] = useState<CameraConfig>(emptyConfig);
  const [cameraConfigMeta, setCameraConfigMeta] = useState<any | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [reconnectingRecording, setReconnectingRecording] = useState(false);
  const [recordingActionLoading, setRecordingActionLoading] = useState<'start' | 'stop' | null>(null);
  const [motionRecordingLoading, setMotionRecordingLoading] = useState(false);
  const [recordingRuntimeStatus, setRecordingRuntimeStatus] = useState<RecordingRuntimeStatus | null>(null);
  const [recordingOverride, setRecordingOverride] = useState<boolean | null>(null);
  const [livePlayerStatus, setLivePlayerStatus] = useState<LivePlayerStatus>({
    activeProtocol: null,
    state: 'loading',
    reason: null,
  });
  const [liveConfigRevision, setLiveConfigRevision] = useState(0);
  const [discoveringEndpoints, setDiscoveringEndpoints] = useState(false);
  const [diagnosingPtz, setDiagnosingPtz] = useState(false);
  const [triggeringAlarm, setTriggeringAlarm] = useState(false);
  const [ptzDiagnostics, setPtzDiagnostics] = useState<PtzDiagnostics | null>(null);
  const [pipelineSummary, setPipelineSummary] = useState<CameraPipelineSummary | null>(null);
  // Diagnóstico rico da câmera JÁ SALVA (detectado agora × configurado) e o
  // frame de conferência. Ambos SOB DEMANDA: cada um custa sonda na câmera.
  const [liveDiagnostics, setLiveDiagnostics] = useState<CameraDiagnosticsView | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [previewFrame, setPreviewFrame] = useState<PreviewFrame | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const initialTabs = useMemo(() => {
    if (typeof window === 'undefined') {
      return { main: 'playback' as const };
    }
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'events' || tab === 'settings' || tab === 'zones') return { main: tab };
    return { main: 'playback' as const };
  }, []);

  useEffect(() => {
    setLivePlayerStatus({ activeProtocol: null, state: 'loading', reason: null });
  }, [cam?.id]);

  useEffect(() => {
    if (!cam?.id || !accessToken) return;

    let cancelled = false;
    const loadCameraConfig = async () => {
      setConfigLoading(true);
      try {
        const [{ data }, pipelineResult] = await Promise.all([
          axios.get(`${API_URL}/cameras/${cam.id}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          axios
            .get(`${API_URL}/cameras/${cam.id}/pipelines`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            })
            .catch(() => ({ data: null })),
        ]);

        if (cancelled) return;

        setCameraConfigMeta(data);
        setPipelineSummary(pipelineResult.data);
        setForm({
          name: data.name ?? '',
          ip: data.ip ?? '',
          rtspPort: String(data.rtspPort ?? 554),
          onvifPort: data.onvifPort == null ? '' : String(data.onvifPort),
          username: data.username ?? '',
          password: '',
          rtspPath: data.rtspPath ?? '',
          onvifPath: data.onvifPath ?? '',
          onvifProfileToken: data.onvifProfileToken ?? '',
          channel: String(data.channel ?? 1),
          subtype: String(data.subtype ?? 0),
          liveChannel: data.liveChannel == null ? '' : String(data.liveChannel),
          liveSubtype: data.liveSubtype == null ? '' : String(data.liveSubtype),
          recordingChannel: data.recordingChannel == null ? '' : String(data.recordingChannel),
          recordingSubtype: data.recordingSubtype == null ? '' : String(data.recordingSubtype),
          analyticsChannel: data.analyticsChannel == null ? '' : String(data.analyticsChannel),
          analyticsSubtype: data.analyticsSubtype == null ? '' : String(data.analyticsSubtype),
          recordingEnabled: Boolean(data.recordingEnabled),
          recordingMode: data.recordingMode ?? (data.recordingEnabled ? 'continuous' : 'manual'),
          retentionDays: String(data.retentionDays ?? 3),
          retentionFollowsGroup: data.retentionFollowsGroup !== false,
          preferredRtspTransport: data.preferredRtspTransport ?? 'tcp',
          preferredLiveProtocol: normalizePreferredLiveProtocol(data.preferredLiveProtocol),
          streamVideoCodec: normalizeVideoCodec(data.streamVideoCodec),
          streamWidth: data.streamWidth == null ? '' : String(data.streamWidth),
          streamHeight: data.streamHeight == null ? '' : String(data.streamHeight),
          streamFps: data.streamFps == null ? '' : String(data.streamFps),
          streamBitrateKbps: data.streamBitrateKbps == null ? '' : String(data.streamBitrateKbps),
          recordingVideoCodec: normalizeVideoCodec(data.recordingVideoCodec),
          recordingWidth: data.recordingWidth == null ? '' : String(data.recordingWidth),
          recordingHeight: data.recordingHeight == null ? '' : String(data.recordingHeight),
          recordingFps: data.recordingFps == null ? '' : String(data.recordingFps),
          recordingBitrateKbps: data.recordingBitrateKbps == null ? '' : String(data.recordingBitrateKbps),
          audioEnabled: Boolean(data.audioEnabled),
          alarmsEnabled: data.alarmsEnabled !== false,
          hasEdgeAi: Boolean(data.hasEdgeAi),
          motionTrigger: data.motionTrigger ?? 'SYSTEM',
        });
      } catch (error) {
        if (!cancelled) {
          toast({
            title: 'Falha ao carregar configuração da câmera',
            description: error instanceof Error ? error.message : 'Não foi possível carregar os parâmetros.',
            variant: 'destructive',
          });
        }
      } finally {
        if (!cancelled) setConfigLoading(false);
      }
    };

    void loadCameraConfig();
    return () => {
      cancelled = true;
    };
  }, [accessToken, cam?.id]);

  useEffect(() => {
    setCameraConfigMeta(null);
    setPipelineSummary(null);
  }, [cam?.id]);

  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = '';
      }
    };
  }, []);

  const controlsDisabled = !cam?.ptzCapable || !cam?.isOnline;

  const startMove = useCallback(async (direction: PTZDirection) => {
    if (!cam || controlsDisabled || activeMovementRef.current) return;
    const movement = { cameraId: cam.id, cameraName: cam.name, direction } as { cameraId: string; cameraName: string; direction: PTZDirection; startPromise?: ReturnType<typeof sendPtzCommand> };
    activeMovementRef.current = movement;
    setActiveDirection(direction);
    setCommandState('sending');
    setLastError(null);
    setLastCommand(`Enviando ${direction} para ${cam.name}`);

    try {
      movement.startPromise = sendPtzCommand(cam.id, { action: 'start', direction });
      await movement.startPromise;
      if (activeMovementRef.current === movement) {
        setCommandState('ok');
        setLastCommand(`Movimento ${direction} ativo em ${cam.name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao iniciar PTZ.';
      if (activeMovementRef.current === movement) {
        activeMovementRef.current = null;
        setActiveDirection(null);
      }
      setCommandState('error');
      setLastError(message);
      setLastCommand(`Falha em ${direction} para ${cam.name}`);
      toast({
        title: 'Falha no PTZ',
        description: message,
        variant: 'destructive',
      });
    }
  }, [cam, controlsDisabled]);

  const stopMove = useCallback(async () => {
    const movement = activeMovementRef.current;
    if (!movement) return;
    activeMovementRef.current = null;
    const direction = movement.direction;
    setActiveDirection(null);
    setCommandState('sending');

    try {
      await movement.startPromise?.catch(() => undefined);
      await sendPtzCommand(movement.cameraId, { action: 'stop', direction });
      setCommandState('ok');
      setLastError(null);
      setLastCommand(`Movimento ${direction} finalizado em ${movement.cameraName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao parar PTZ.';
      setCommandState('error');
      setLastError(message);
      setLastCommand(`Falha ao parar ${direction} em ${movement.cameraName}`);
      toast({
        title: 'Falha ao parar PTZ',
        description: message,
        variant: 'destructive',
      });
    }
  }, []);

  const stopMoveSilently = useCallback(() => {
    const movement = activeMovementRef.current;
    if (!movement) return;
    activeMovementRef.current = null;
    setActiveDirection(null);
    void (async () => {
      await movement.startPromise?.catch(() => undefined);
      await sendPtzCommand(movement.cameraId, { action: 'stop', direction: movement.direction });
    })().catch(() => undefined);
  }, []);

  useEffect(() => {
    const stopOnHidden = () => {
      if (document.visibilityState === 'hidden') stopMoveSilently();
    };
    window.addEventListener('blur', stopMoveSilently);
    window.addEventListener('pagehide', stopMoveSilently);
    document.addEventListener('visibilitychange', stopOnHidden);
    return () => {
      stopMoveSilently();
      window.removeEventListener('blur', stopMoveSilently);
      window.removeEventListener('pagehide', stopMoveSilently);
      document.removeEventListener('visibilitychange', stopOnHidden);
    };
  }, [stopMoveSilently]);

  useEffect(() => stopMoveSilently, [cam?.id, stopMoveSilently]);

  const handleVideoWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaY > 0 ? -0.12 : 0.12;
    setVideoZoom((current) => {
      const next = Math.max(1, Math.min(5, Number((current + delta).toFixed(2))));
      if (next <= 1) {
        setVideoPan({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const handleVideoMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (videoZoom <= 1) return;
    event.preventDefault();
    setDraggingVideo(true);
    setDragStart({ x: event.clientX - videoPan.x, y: event.clientY - videoPan.y });
  }, [videoPan.x, videoPan.y, videoZoom]);

  const handleVideoMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!draggingVideo || !dragStart || videoZoom <= 1) return;
    const maxOffset = Math.max(0, ((videoZoom - 1) * 420) / 2);
    const nextX = event.clientX - dragStart.x;
    const nextY = event.clientY - dragStart.y;
    setVideoPan({
      x: Math.max(-maxOffset, Math.min(maxOffset, nextX)),
      y: Math.max(-maxOffset, Math.min(maxOffset, nextY)),
    });
  }, [dragStart, draggingVideo, videoZoom]);

  const handleVideoMouseUp = useCallback(() => {
    setDraggingVideo(false);
    setDragStart(null);
  }, []);

  const lockPageScroll = useCallback(() => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = 'hidden';
  }, []);

  useEffect(() => {
    const onGlobalWheel = (event: globalThis.WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const inCameraViewport = target.closest('[data-camera-viewport="true"]');
      if (!inCameraViewport) return;
      if (videoZoom <= 1) return;
      event.preventDefault();
    };
    window.addEventListener('wheel', onGlobalWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', onGlobalWheel as EventListener);
    };
  }, [videoZoom]);

  const unlockPageScroll = useCallback(() => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = '';
  }, []);

  // Só trava o scroll da página quando o vídeo está com zoom (>1), para o arrasto/pan
  // funcionar. Sem zoom, passar o mouse sobre o vídeo não deve impedir rolar a página.
  useEffect(() => {
    if (videoZoom > 1) lockPageScroll();
    else unlockPageScroll();
  }, [videoZoom, lockPageScroll, unlockPageScroll]);

  const updateField = <K extends keyof CameraConfig>(key: K, value: CameraConfig[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const getResolutionPresetValue = (width: string, height: string) => {
    if (!width.trim() || !height.trim()) return 'original';
    const w = Number(width);
    const h = Number(height);
    const matched = RESOLUTION_PRESETS.find((preset) => preset.width === w && preset.height === h);
    return matched ? `${matched.width}x${matched.height}` : '';
  };

  const applyResolutionPreset = (mode: 'stream' | 'recording', value: string) => {
    if (!value) return;
    if (value === 'original') {
      if (mode === 'stream') {
        updateField('streamWidth', '');
        updateField('streamHeight', '');
        updateField('streamFps', '');
        updateField('streamBitrateKbps', '');
        return;
      }
      updateField('recordingWidth', '');
      updateField('recordingHeight', '');
      updateField('recordingFps', '');
      updateField('recordingBitrateKbps', '');
      return;
    }
    const [w, h] = value.split('x');
    if (!w || !h) return;
    if (mode === 'stream') {
      updateField('streamWidth', w);
      updateField('streamHeight', h);
      return;
    }
    updateField('recordingWidth', w);
    updateField('recordingHeight', h);
  };

  const applyLiveSourceMode = (value: LiveSourceMode) => {
    if (value === 'advanced') return;
    setForm((current) => ({
      ...current,
      liveSubtype: value === 'original' ? '0' : '1',
      streamVideoCodec: 'original',
      streamWidth: current.streamWidth || String(GRID_LIVE_MAX_WIDTH),
      streamHeight: current.streamHeight || String(GRID_LIVE_MAX_HEIGHT),
      streamFps: String(GRID_LIVE_TARGET_FPS),
      streamBitrateKbps: '',
    }));
  };

  const saveSettings = async () => {
    if (!cam?.id || !accessToken) return;
    setConfigSaving(true);

    try {
      const detectedWidth = cam.detectedWidth ?? null;
      const detectedHeight = cam.detectedHeight ?? null;
      const detectedFps = cam.detectedFps ?? null;
      const detectedBitrate = cam.detectedBitrateKbps ?? null;

      const clampedFields: string[] = [];
      const clampToDetected = (label: string, value: string, max: number | null): number | null => {
        if (!value.trim()) return null;
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) return null;
        if (max && max > 0) {
          const clamped = Math.min(numeric, max);
          if (clamped !== numeric) {
            clampedFields.push(`${label}: solicitado ${numeric}, aplicado ${clamped} (max detectado ${max})`);
          }
          return clamped;
        }
        return numeric;
      };
      const parseOptionalPositive = (value: string): number | null => {
        if (!value.trim()) return null;
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
      };

      const { data: updatedCamera } = await axios.patch(
        `${API_URL}/cameras/${cam.id}`,
        {
          name: form.name.trim(),
          ip: form.ip.trim(),
          rtspPort: Number(form.rtspPort),
          onvifPort: form.onvifPort.trim() ? Number(form.onvifPort) : undefined,
          username: form.username.trim(),
          password: form.password.trim() ? form.password : undefined,
          rtspPath: form.rtspPath.trim(),
          onvifPath: form.onvifPath.trim(),
          onvifProfileToken: form.onvifProfileToken.trim(),
          channel: Number(form.channel),
          subtype: Number(form.subtype),
          liveChannel: form.liveChannel.trim() ? Number(form.liveChannel) : null,
          liveSubtype: form.liveSubtype.trim() ? Number(form.liveSubtype) : null,
          recordingChannel: form.recordingChannel.trim() ? Number(form.recordingChannel) : null,
          recordingSubtype: form.recordingSubtype.trim() ? Number(form.recordingSubtype) : null,
          analyticsChannel: form.analyticsChannel.trim() ? Number(form.analyticsChannel) : null,
          analyticsSubtype: form.analyticsSubtype.trim() ? Number(form.analyticsSubtype) : null,
          recordingEnabled: form.recordingEnabled,
          recordingMode: form.recordingMode,
          retentionDays: Number(form.retentionDays),
          retentionFollowsGroup: form.retentionFollowsGroup,
          preferredRtspTransport: form.preferredRtspTransport,
          preferredLiveProtocol: form.preferredLiveProtocol === 'mjpeg' ? 'webrtc' : form.preferredLiveProtocol,
          streamVideoCodec: 'h264',
          streamWidth: clampToDetected('Live largura', String(GRID_LIVE_MAX_WIDTH), detectedWidth),
          streamHeight: clampToDetected('Live altura', String(GRID_LIVE_MAX_HEIGHT), detectedHeight),
          streamFps: GRID_LIVE_TARGET_FPS,
          streamBitrateKbps: clampToDetected('Live bitrate', form.streamBitrateKbps, detectedBitrate),
          recordingVideoCodec: normalizeVideoCodec(form.recordingVideoCodec),
          recordingWidth: parseOptionalPositive(form.recordingWidth),
          recordingHeight: parseOptionalPositive(form.recordingHeight),
          recordingFps: detectedFps ?? parseOptionalPositive(form.recordingFps),
          recordingBitrateKbps: parseOptionalPositive(form.recordingBitrateKbps),
          audioEnabled: form.audioEnabled,
          alarmsEnabled: form.alarmsEnabled,
          hasEdgeAi: form.hasEdgeAi,
          motionTrigger: form.motionTrigger,
        },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      setCameraConfigMeta(updatedCamera);
      await loadData();
      setLiveConfigRevision((current) => current + 1);
      axios
        .get(`${API_URL}/cameras/${cam.id}/pipelines`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        .then(({ data }) => setPipelineSummary(data))
        .catch(() => undefined);
      setForm((current) => ({ ...current, password: '' }));
      const appliedLiveResolution = `${Math.min(GRID_LIVE_MAX_WIDTH, detectedWidth ?? GRID_LIVE_MAX_WIDTH)}x${Math.min(GRID_LIVE_MAX_HEIGHT, detectedHeight ?? GRID_LIVE_MAX_HEIGHT)}`;
      toast({
        title: 'Configuração salva',
        description: clampedFields.length
          ? `A câmera ${cam.name} foi atualizada com ajustes automáticos: ${clampedFields.join(' | ')} | Grid: ${appliedLiveResolution} / ${GRID_LIVE_TARGET_FPS} FPS · individual: original`
          : `A câmera ${cam.name} foi atualizada com sucesso. Grid: ${appliedLiveResolution} / ${GRID_LIVE_TARGET_FPS} FPS · individual: original`,
      });
    } catch (error) {
      toast({
        title: 'Falha ao salvar câmera',
        description: error instanceof Error ? error.message : 'Não foi possível salvar as alterações.',
        variant: 'destructive',
      });
    } finally {
      setConfigSaving(false);
    }
  };

  const runConnectionTest = async () => {
    if (!cam?.id || !accessToken) return;
    setTestingConnection(true);

    try {
      const { data } = await axios.post<{
        rtspReachable?: boolean;
        selectedRtspPortAuthOk?: boolean;
        rtspAuthOk?: boolean;
        onvifReachable?: boolean;
        ptzDigestOk?: boolean;
        status?: string;
      }>(
        `${API_URL}/cameras/${cam.id}/test-connection`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      const rtspAuthFailed = data.rtspReachable && data.selectedRtspPortAuthOk === false;
      const onvifAuthFailed = data.onvifReachable && data.ptzDigestOk === false;
      toast({
        title: 'Teste de conexao concluido',
        description: rtspAuthFailed
          ? 'A câmera respondeu, mas recusou usuário ou senha.'
          : onvifAuthFailed
            ? 'A câmera respondeu, mas recusou o controle externo.'
            : data.rtspReachable
              ? 'Câmera respondendo corretamente.'
              : 'Não foi possível confirmar o vídeo desta câmera.',
        variant: rtspAuthFailed || onvifAuthFailed ? 'destructive' : undefined,
      });
      await loadData();
    } catch (error) {
      toast({
        title: 'Falha no teste de conexão',
        description: error instanceof Error ? error.message : 'Não foi possível testar a câmera.',
        variant: 'destructive',
      });
    } finally {
      setTestingConnection(false);
    }
  };

  /**
   * DIAGNÓSTICO RICO da câmera já salva. Antes disto, depois de cadastrada a
   * câmera virava três booleanos e diagnosticar uma que ERA boa e degradou
   * (firmware trocou o perfil, substream sumiu, codec virou H.265) era
   * adivinhação — e adivinhar errado custa uma volta ao local.
   */
  const runLiveDiagnostics = async () => {
    if (!cam?.id || !accessToken || diagnosticsLoading) return;
    setDiagnosticsLoading(true);
    try {
      const { data } = await axios.get(`${API_URL}/cameras/${cam.id}/live-diagnostics`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const report = parseDiagnosticsReport(data);
      setLiveDiagnostics(report);
      if (report && report.state === 'diverged') {
        toast({
          title: 'Divergência encontrada',
          description: report.summary,
          variant: 'destructive',
        });
      }
    } catch (error) {
      // A tela NÃO pode quebrar: ela é aberta justamente quando a câmera está ruim.
      setLiveDiagnostics(null);
      toast({
        title: 'Falha ao diagnosticar',
        description: error instanceof Error ? error.message : 'Não foi possível diagnosticar a câmera.',
        variant: 'destructive',
      });
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  /**
   * Confirmação visual na EDIÇÃO: puxa um frame com os dados que estão NO
   * FORMULÁRIO (IP recém-digitado inclusive), antes de salvar por cima de um
   * cadastro que estava certo. Senha em branco reusa a guardada.
   */
  const capturePreviewFrame = async () => {
    if (!cam?.id || !accessToken || previewLoading) return;
    setPreviewLoading(true);
    try {
      const { data } = await axios.post(
        `${API_URL}/cameras/${cam.id}/preview-frame`,
        {
          ip: form.ip.trim() || undefined,
          rtspPort: form.rtspPort.trim() ? Number(form.rtspPort) : undefined,
          username: form.username.trim() || undefined,
          password: form.password || undefined,
          rtspPath: form.rtspPath.trim() || undefined,
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      setPreviewFrame(parsePreviewFrame(data));
    } catch (error) {
      setPreviewFrame({
        ok: false,
        imageDataUrl: null,
        bytes: 0,
        capturedAt: null,
        source: null,
        stream: null,
        reason: error instanceof Error ? error.message : 'Não foi possível capturar a imagem da câmera.',
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const discoverEndpoints = async () => {
    if (!accessToken) return;
    setDiscoveringEndpoints(true);
    try {
      const { data } = await axios.post<{
        rtspAuthOk?: boolean;
        selectedRtspPortAuthOk?: boolean;
        detectedRtspPort?: number | null;
        detectedRtspPath?: string | null;
        detectedStream?: {
          codec?: string | null;
          width?: number | null;
          height?: number | null;
          fps?: number | null;
          bitrateKbps?: number | null;
        } | null;
        detectedOnvifPort?: number | null;
        detectedOnvifPath?: string | null;
        detectedOnvifProfileToken?: string | null;
      }>(
        `${API_URL}/cameras/test-connection-draft`,
        {
          ip: form.ip.trim(),
          rtspPort: Number(form.rtspPort),
          onvifPort: form.onvifPort.trim() ? Number(form.onvifPort) : undefined,
          username: form.username.trim(),
          password: form.password.trim() || undefined,
          rtspPath: form.rtspPath.trim() || undefined,
          onvifPath: form.onvifPath.trim() || undefined,
          onvifProfileToken: form.onvifProfileToken.trim() || undefined,
          channel: Number(form.channel),
          subtype: Number(form.subtype),
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      if (data.detectedRtspPath) {
        updateField('rtspPath', data.detectedRtspPath);
      }
      if (data.detectedStream?.codec) {
        updateField('streamVideoCodec', normalizeVideoCodec(data.detectedStream.codec));
      }
      if (typeof data.detectedStream?.width === 'number') {
        updateField('streamWidth', String(Math.min(GRID_LIVE_MAX_WIDTH, data.detectedStream.width)));
      }
      if (typeof data.detectedStream?.height === 'number') {
        updateField('streamHeight', String(Math.min(GRID_LIVE_MAX_HEIGHT, data.detectedStream.height)));
      }
      updateField('streamFps', String(GRID_LIVE_TARGET_FPS));
      if (typeof data.detectedStream?.bitrateKbps === 'number') {
        updateField('streamBitrateKbps', String(data.detectedStream.bitrateKbps));
        if (!form.recordingBitrateKbps.trim()) {
          updateField('recordingBitrateKbps', String(data.detectedStream.bitrateKbps));
        }
      }
      if (typeof data.detectedOnvifPort === 'number') {
        updateField('onvifPort', String(data.detectedOnvifPort));
      }
      if (data.detectedOnvifPath) {
        updateField('onvifPath', data.detectedOnvifPath);
      }
      if (data.detectedOnvifProfileToken) {
        updateField('onvifProfileToken', data.detectedOnvifProfileToken);
      }

      toast({
        title: 'Deteccao concluida',
        description: data.rtspAuthOk || data.selectedRtspPortAuthOk
          ? 'Os dados encontrados foram aplicados automaticamente.'
          : 'Não foi possível confirmar o vídeo com os dados atuais.',
      });
    } catch (error) {
      toast({
        title: 'Falha na descoberta',
        description: error instanceof Error ? error.message : 'Não foi possível descobrir endpoints da câmera.',
        variant: 'destructive',
      });
    } finally {
      setDiscoveringEndpoints(false);
    }
  };

  const reconnectRecording = async () => {
    if (!cam?.id || !accessToken) return;
    setReconnectingRecording(true);
    try {
      const { data } = await axios.post(
        `${API_URL}/recordings/reconnect-stale`,
        { cameraIds: [cam.id] },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      toast({
        title: 'Reconexão de gravação executada',
        description: `Reiniciadas: ${data.restarted ?? 0} | Ignoradas: ${data.skipped ?? 0}`,
      });
      await loadData();
    } catch (error) {
      toast({
        title: 'Falha na reconexão de gravação',
        description: error instanceof Error ? error.message : 'Não foi possível reconectar gravação.',
        variant: 'destructive',
      });
    } finally {
      setReconnectingRecording(false);
    }
  };

  const loadRecordingStatus = useCallback(async () => {
    if (!cam?.id || !accessToken) return;
    try {
      const { data } = await axios.get<RecordingRuntimeStatus>(
        `${API_URL}/cameras/${cam.id}/recording/status`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      setRecordingRuntimeStatus(data);
      setRecordingOverride(null);
    } catch {
      setRecordingRuntimeStatus(null);
    }
  }, [accessToken, cam?.id]);

  useEffect(() => {
    void loadRecordingStatus();
  }, [loadRecordingStatus]);

  useEffect(() => {
    setRecordingOverride(null);
  }, [cam?.id]);

  const isRecordingActive = recordingOverride ?? recordingRuntimeStatus?.isRecording ?? (cam?.status === 'recording');
  const isMotionRecordingMode = form.recordingMode === 'motion' || cam?.recordingMode === 'motion';
  const isMotionRecordingActive = isMotionRecordingMode && isRecordingActive;
  const cameraMeta = cameraConfigMeta ?? cam;
  const resolutionMatch = cam?.resolution?.match(/(\d+)\s*x\s*(\d+)/i) ?? null;
  const originalWidth = cameraMeta?.recordingWidth ?? cameraMeta?.detectedWidth ?? cameraMeta?.streamWidth ?? (resolutionMatch ? Number(resolutionMatch[1]) : null);
  const originalHeight = cameraMeta?.recordingHeight ?? cameraMeta?.detectedHeight ?? cameraMeta?.streamHeight ?? (resolutionMatch ? Number(resolutionMatch[2]) : null);
  const originalFps = cameraMeta?.recordingFps ?? cameraMeta?.detectedFps ?? cam?.fps ?? null;
  const originalCodecValue = normalizeVideoCodec(cameraMeta?.recordingVideoCodec ?? cameraMeta?.detectedVideoCodec ?? cameraMeta?.streamVideoCodec);
  const originalCodec = originalCodecValue.toUpperCase();
  const originalBitrate = cameraMeta?.recordingBitrateKbps ?? cameraMeta?.detectedBitrateKbps ?? cameraMeta?.streamBitrateKbps ?? null;
  const liveSourceMode = resolveLiveSourceMode(form.liveSubtype, form.subtype);
  const liveSourceLabel = liveSourceMode === 'original'
      ? 'Original da câmera'
      : liveSourceMode === 'economical'
      ? 'Econômico'
      : `Perfil personalizado ${form.liveSubtype || form.subtype || '--'}`;
  const recordingModeCopy = getRecordingModeCopy(form.recordingMode);

  const startManualRecording = async () => {
    if (!cam?.id || !accessToken) return;
    setRecordingOverride(true);
    setRecordingActionLoading('start');
    try {
      await axios.post(
        `${API_URL}/cameras/${cam.id}/recording/start`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      toast({ title: 'Gravação iniciada', description: `A câmera ${cam.name} entrou em gravação manual.` });
      await Promise.all([loadData(), loadRecordingStatus()]);
    } catch (error) {
      setRecordingOverride(null);
      toast({
        title: 'Falha ao iniciar gravação',
        description: error instanceof Error ? error.message : 'Não foi possível iniciar a gravação manual.',
        variant: 'destructive',
      });
    } finally {
      setRecordingActionLoading(null);
    }
  };

  const stopManualRecording = async () => {
    if (!cam?.id || !accessToken) return;
    setRecordingOverride(false);
    setRecordingActionLoading('stop');
    try {
      await axios.post(
        `${API_URL}/cameras/${cam.id}/recording/stop`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      toast({ title: 'Gravação parada', description: `A gravação manual da câmera ${cam.name} foi encerrada.` });
      await Promise.all([loadData(), loadRecordingStatus()]);
    } catch (error) {
      setRecordingOverride(null);
      toast({
        title: 'Falha ao parar gravação',
        description: error instanceof Error ? error.message : 'Não foi possível parar a gravação manual.',
        variant: 'destructive',
      });
    } finally {
      setRecordingActionLoading(null);
    }
  };

  const handleMotionRecording = async (enabled: boolean) => {
    if (!cam?.id || !accessToken || motionRecordingLoading) return;
    setMotionRecordingLoading(true);
    try {
      if (enabled) {
        await axios.post(
          `${API_URL}/cameras/${cam.id}/recording/motion`,
          { enabled: true },
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        setForm((current) => ({ ...current, recordingMode: 'motion', recordingEnabled: false }));
        setRecordingOverride(false);
        toast({
          title: 'Gravação por movimento ativada',
          description: 'Ao detectar movimento, o sistema grava e mantém o clip por 60s após o último movimento.',
        });
      } else {
        if (isMotionRecordingActive) {
          setRecordingOverride(false);
          await axios.post(
            `${API_URL}/cameras/${cam.id}/recording/stop`,
            {},
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
        }
        await axios.post(
          `${API_URL}/cameras/${cam.id}/recording/motion`,
          { enabled: false },
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        setForm((current) => ({ ...current, recordingMode: 'manual', recordingEnabled: false }));
        toast({
          title: 'Gravação por movimento desativada',
          description: 'A câmera não iniciará gravação automática por detecção de movimento.',
        });
      }
      await Promise.all([loadData(), loadRecordingStatus()]);
    } catch (error) {
      setRecordingOverride(null);
      toast({
        title: 'Falha na gravação por movimento',
        description: error instanceof Error ? error.message : 'Não foi possível atualizar o modo por movimento.',
        variant: 'destructive',
      });
    } finally {
      setMotionRecordingLoading(false);
    }
  };

  const runPtzDiagnostics = async () => {
    if (!cam?.id || !accessToken) return;
    setDiagnosingPtz(true);
    try {
      const { data } = await axios.get<PtzDiagnostics>(
        `${API_URL}/ptz/${cam.id}/diagnostics`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      setPtzDiagnostics(data);
      toast({
        title: data.ptzLikelyWorking ? 'Controle PTZ pronto' : 'Controle PTZ indisponivel',
        description: data.ptzLikelyWorking
          ? 'A câmera aceitou o controle externo.'
          : 'Não foi possível confirmar o controle externo desta câmera.',
        variant: data.ptzLikelyWorking ? undefined : 'destructive',
      });
    } catch (error) {
      toast({
        title: 'Falha no diagnóstico PTZ',
        description: error instanceof Error ? error.message : 'Não foi possível diagnosticar PTZ.',
        variant: 'destructive',
      });
    } finally {
      setDiagnosingPtz(false);
    }
  };

  const triggerCameraAlarm = async () => {
    if (!cam?.id || !accessToken || triggeringAlarm) return;
    setTriggeringAlarm(true);
    try {
      const { data } = await axios.post(
        `${API_URL}/ptz/${cam.id}/relays/trigger`,
        { token: 'alarmout-0', durationMs: 1500 },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (data.status === 'error') {
        throw new Error(data.message ?? 'A câmera não aceitou o comando de alarme.');
      }
      toast({
        title: 'Alarme acionado',
        description: `Pulso de alarme enviado para ${cam.name} por 1,5s.`,
      });
    } catch (error) {
      toast({
        title: 'Falha ao acionar alarme',
        description: error instanceof Error ? error.message : 'Não foi possível acionar a saída de alarme da câmera.',
        variant: 'destructive',
      });
    } finally {
      setTriggeringAlarm(false);
    }
  };

  if (!cam) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {isDataLoading || !dataLoaded ? 'Carregando câmera...' : 'Câmera não encontrada.'}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-background/95 px-6 py-3">
        <Link
          href="/cameras"
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Câmeras
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{cam.name}</span>
            <span className="hidden text-xs text-muted-foreground md:inline">{cam.ipAddress}</span>
          </div>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <StatusPill label={cam.isOnline ? 'Online' : 'Offline'} tone={cam.isOnline ? 'good' : 'bad'} />
          <StatusPill label={isRecordingActive ? 'Gravando' : 'Sem gravação'} tone={isRecordingActive ? 'warn' : 'neutral'} />
          <StatusPill label={livePlayerStatus.activeProtocol ?? 'Live'} />
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div>
            <div
              className="relative aspect-video overflow-hidden rounded-lg border border-border bg-black"
              data-camera-viewport="true"
              onWheel={handleVideoWheel}
              onWheelCapture={handleVideoWheel}
              onMouseDown={handleVideoMouseDown}
              onMouseMove={handleVideoMouseMove}
              onMouseUp={handleVideoMouseUp}
              onMouseLeave={handleVideoMouseUp}
              style={{ cursor: videoZoom > 1 ? (draggingVideo ? 'grabbing' : 'grab') : 'default', touchAction: 'none', overscrollBehavior: 'contain' }}
            >
              {cam.isOnline ? (
                <div
                  className="absolute inset-0 h-full w-full"
                  style={{ transform: `translate(${videoPan.x}px, ${videoPan.y}px) scale(${videoZoom})`, transformOrigin: 'center center' }}
                >
                  <LiveStreamPlayer
                    key={`${cam.id}-${liveConfigRevision}`}
                    cameraId={cam.id}
                    cameraName={cam.name}
                    className="absolute inset-0 h-full w-full"
                    muted={videoMuted}
                    showOverlay={false}
                    aiEnabled={false}
                    liveViewMode="selected"
                    onStatusChange={setLivePlayerStatus}
                  />
                </div>
              ) : null}
              <div className="scan-line-overlay absolute inset-0" />
              {!cam.isOnline && <Camera className="h-12 w-12 text-muted-foreground/35" />}
              <div className="absolute left-2 top-2 z-10 flex items-center gap-2">
                <div className={cn('h-2 w-2 rounded-full', isRecordingActive ? 'rec-pulse bg-[hsl(var(--destructive))]' : 'bg-[hsl(var(--status-online))]')} />
                <span className="rounded bg-black/60 px-1.5 text-xs font-mono text-white/80">{cam.code}</span>
              </div>
              {cam.isOnline && (
                <button
                  type="button"
                  onClick={() => setVideoMuted((value) => !value)}
                  className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/55 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
                  title={videoMuted ? 'Ativar áudio' : 'Mutar áudio'}
                >
                  {videoMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
              )}
              <div className="absolute bottom-2 left-2 right-2 z-10 flex justify-between">
                <span className="rounded bg-black/60 px-1.5 text-[10px] font-mono text-white/70">{cam.ipAddress}</span>
                <LiveClock className="rounded bg-black/60 px-1.5 text-[10px] font-mono text-white/70" />
              </div>
            </div>
          </div>

          <div className="flex max-h-[calc(100vh-220px)] flex-col overflow-hidden rounded-lg border border-border bg-card/80">
            <div className="grid grid-cols-2 gap-2 p-3">
              <button
                type="button"
                onClick={() => void reconnectRecording()}
                disabled={reconnectingRecording || cam.recordingStatusDetail === 'auto_reconnecting'}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-background/55 text-xs hover:bg-[hsl(var(--accent))] disabled:opacity-50"
              >
                {reconnectingRecording ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                {reconnectingRecording || cam.recordingStatusDetail === 'auto_reconnecting' ? 'Reconectando...' : 'Reconectar'}
              </button>
              <button
                type="button"
                onClick={() => void (isRecordingActive ? stopManualRecording() : startManualRecording())}
                disabled={recordingActionLoading !== null}
                className={cn(
                  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border bg-background/55 text-xs disabled:opacity-50',
                  isRecordingActive
                    ? 'border-[hsl(var(--destructive)_/_0.45)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.1)]'
                    : 'border-[hsl(var(--status-online)_/_0.45)] text-[hsl(var(--status-online))] hover:bg-[hsl(var(--status-online)_/_0.1)]',
                )}
                title={isRecordingActive ? 'Parar gravação manual' : 'Iniciar gravação manual'}
              >
                {recordingActionLoading ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Circle className={cn('h-3.5 w-3.5', isRecordingActive && 'fill-current')} />
                )}
                {isRecordingActive ? 'Parar' : 'Gravar'}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {cam.ptzCapable ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-foreground">PTZ</p>
                    <button
                      type="button"
                      onClick={() => void stopMove()}
                      disabled={!activeDirection}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Stop
                    </button>
                  </div>
                  <div className="mx-auto grid w-fit grid-cols-3 gap-2">
                    <div />
                    <PtzButton icon={ArrowUp} label="Cima" active={activeDirection === 'Up'} disabled={controlsDisabled} onStart={() => void startMove('Up')} onStop={() => void stopMove()} />
                    <div />
                    <PtzButton icon={ArrowLeft} label="Esquerda" active={activeDirection === 'Left'} disabled={controlsDisabled} onStart={() => void startMove('Left')} onStop={() => void stopMove()} />
                    <button
                      type="button"
                      onClick={() => void stopMove()}
                      disabled={!activeDirection}
                      className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground hover:bg-[hsl(var(--accent))] disabled:opacity-40"
                      title="Parar movimento"
                    >
                      <Crosshair className="h-4 w-4" />
                    </button>
                    <PtzButton icon={ArrowRight} label="Direita" active={activeDirection === 'Right'} disabled={controlsDisabled} onStart={() => void startMove('Right')} onStop={() => void stopMove()} />
                    <div />
                    <PtzButton icon={ArrowDown} label="Baixo" active={activeDirection === 'Down'} disabled={controlsDisabled} onStart={() => void startMove('Down')} onStop={() => void stopMove()} />
                    <div />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <PtzButton icon={ZoomIn} label="Zoom In" active={activeDirection === 'ZoomIn'} disabled={controlsDisabled} onStart={() => void startMove('ZoomIn')} onStop={() => void stopMove()} />
                    <PtzButton icon={ZoomOut} label="Zoom Out" active={activeDirection === 'ZoomOut'} disabled={controlsDisabled} onStart={() => void startMove('ZoomOut')} onStop={() => void stopMove()} />
                  </div>
                  <div className="rounded-md border border-border bg-background/55 px-2.5 py-2 text-[11px] text-muted-foreground">
                    {commandState === 'error' ? 'Erro operacional' : commandState === 'sending' ? 'Enviando comando...' : 'Pronto'}
                    <div className="mt-1 font-mono text-[10px]">{lastCommand}</div>
                    {lastError ? <div className="mt-1 text-[hsl(var(--destructive))]">{lastError}</div> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => void runPtzDiagnostics()}
                    disabled={diagnosingPtz}
                    className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-border text-xs hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                  >
                    {diagnosingPtz ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
                    Verificar PTZ
                  </button>
                  {ptzDiagnostics ? (
                    <div className="rounded-md border border-border bg-background/55 px-2.5 py-2 text-[11px] text-muted-foreground">
                      {ptzDiagnostics.ptzLikelyWorking
                        ? 'Controle PTZ disponivel.'
                        : 'Controle PTZ ainda sem validacao.'}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void triggerCameraAlarm()}
                    disabled={triggeringAlarm || !cam.isOnline}
                    className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-[hsl(var(--status-warning)_/_0.35)] bg-[hsl(var(--status-warning)_/_0.1)] text-xs font-medium text-[hsl(var(--status-warning))] hover:bg-[hsl(var(--status-warning)_/_0.15)] disabled:opacity-50"
                    title="Aciona a saída de alarme por 1,5s e desliga automaticamente"
                  >
                    {triggeringAlarm ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />}
                    Acionar alarme
                  </button>
                </div>
              ) : (
                <div className="rounded-md border border-border bg-background/55 px-2.5 py-2 text-xs text-muted-foreground">
                  Esta câmera não suporta controles PTZ.
                </div>
              )}
            </div>
          </div>
        </div>

        <Tabs defaultValue={initialTabs.main} className="w-full">
          <TabsList className="h-8 border border-border bg-card">
            {[
              ['playback', 'Reprodução'],
              ['events', 'Eventos'],
              ['zones', 'Zonas'],
              ['settings', 'Configurações'],
            ].map(([tab, label]) => (
              <TabsTrigger key={tab} value={tab} className="h-6 px-3 text-xs capitalize">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="playback" className="mt-4">
            <div className="rounded-lg border border-border bg-card/60 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Reprodução</p>
                  <p className="mt-1 text-sm font-semibold">Revisão forense desta câmera</p>
                </div>
                <Link
                  href={`/playback?cameraId=${encodeURIComponent(cam.id)}`}
                  className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs hover:bg-[hsl(var(--accent))]"
                >
                  Abrir reprodução
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-border bg-background/55 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Modo de gravação</div>
                  <div className={cn('mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-semibold', recordingModeCopy.className)}>
                    {recordingModeCopy.label}
                  </div>
                  <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{recordingModeCopy.detail}</div>
                </div>
                <div className="rounded-xl border border-border bg-background/55 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Retenção</div>
                  <div className="mt-2 text-sm font-semibold">{cam.retentionDays} dias</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {cam.retentionFollowsGroup === false ? 'Prazo próprio desta câmera' : 'Herdado do grupo'}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-background/55 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Armazenamento</div>
                  <div className="mt-2 text-sm font-semibold">{cam.storage}</div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="events" className="mt-4">
            <div className="space-y-2">
              {events
                .filter((event) => event.cameraId === cam.id)
                .slice(0, 8)
                .map((event) => (
                  <div key={event.id} className="flex items-center gap-3 rounded border border-border bg-card/40 px-4 py-2 text-xs">
                    <span className="font-mono text-muted-foreground">{new Date(event.timestamp).toISOString().substring(11, 19)}</span>
                    <Badge variant="outline" className="border-border bg-muted text-[10px] text-muted-foreground">
                      {event.type}
                    </Badge>
                    <span className="font-mono text-muted-foreground">{event.description}</span>
                  </div>
                ))}
            </div>
          </TabsContent>

          <TabsContent value="zones" className="mt-4">
            <div className="rounded-lg border border-border bg-card/60 p-5">
              <div className="mb-3">
                <h3 className="text-sm font-semibold">Zonas de detecção</h3>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  Desenhe sobre a imagem as áreas que devem ser ignoradas (rua, árvores, céu) ou as únicas
                  que devem ser monitoradas. Reduz alarme falso sem perder o que importa.
                </p>
              </div>
              {cam?.id ? (
                <DetectionZonesEditor
                  cameraId={cam.id}
                  cameraName={cam.name}
                  initialZones={(cameraMeta as { detectionZones?: DetectionZone[] } | null)?.detectionZones ?? null}
                />
              ) : (
                <p className="text-xs text-[hsl(var(--muted-foreground))]">Carregando câmera…</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            {configLoading ? (
              <div className="rounded-xl border border-border bg-card py-16 text-center text-sm text-muted-foreground shadow-sm">
                Carregando parâmetros da câmera...
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSettings();
                }}
                className="space-y-5 pb-2"
              >
                {/* Barra de ações */}
                <div className="flex flex-col gap-4 rounded-xl border border-border bg-card px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <SlidersHorizontal className="h-4 w-4" />
                    </span>
                    <div>
                      <h2 className="text-[15px] font-semibold tracking-tight text-foreground">Configurações da câmera</h2>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        Identificação, transmissão ao vivo e gravação. Detalhes técnicos ficam agrupados no final.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void runConnectionTest()}
                      disabled={testingConnection}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3.5 text-xs font-semibold transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {testingConnection ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
                      {testingConnection ? 'Testando...' : 'Testar conexão'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runLiveDiagnostics()}
                      disabled={diagnosticsLoading}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3.5 text-xs font-semibold transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {diagnosticsLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Stethoscope className="h-3.5 w-3.5" />}
                      {diagnosticsLoading ? 'Diagnosticando...' : 'Diagnóstico detalhado'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void capturePreviewFrame()}
                      disabled={previewLoading}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3.5 text-xs font-semibold transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {previewLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                      {previewLoading ? 'Capturando...' : 'Conferir imagem'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void discoverEndpoints()}
                      disabled={discoveringEndpoints}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3.5 text-xs font-semibold transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {discoveringEndpoints ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      {discoveringEndpoints ? 'Detectando...' : 'Detectar automaticamente'}
                    </button>
                  </div>
                </div>

                {previewFrame && (
                  <CameraPreviewFrameCard frame={previewFrame} />
                )}

                {liveDiagnostics && (
                  <CameraDiagnosticsCard report={liveDiagnostics} />
                )}

                {/* Stream detectado da câmera */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <SettingsStat label="Codec" value={originalCodec || '--'} />
                  <SettingsStat label="Resolução" value={originalWidth && originalHeight ? `${originalWidth}×${originalHeight}` : '--'} />
                  <SettingsStat label="FPS" value={originalFps ? `${originalFps}` : '--'} />
                  <SettingsStat label="Bitrate" value={originalBitrate ? `${originalBitrate} kbps` : '--'} />
                </div>

                {/* Grid principal */}
                <div className="grid items-start gap-5 xl:grid-cols-2">
                  <SettingsCard icon={KeyRound} title="Identificação e acesso" description="Como o DRAC encontra e autentica nesta câmera.">
                    <div className="grid gap-3 md:grid-cols-2">
                      <SettingsField label="Nome da câmera" wide>
                        <SettingsInput value={form.name} onChange={(event) => updateField('name', event.target.value)} />
                      </SettingsField>
                      <SettingsField label="Endereço IP">
                        <SettingsInput value={form.ip} onChange={(event) => updateField('ip', event.target.value)} className="font-mono" />
                      </SettingsField>
                      <SettingsField label="Porta de vídeo">
                        <SettingsInput type="number" min={1} value={form.rtspPort} onChange={(event) => updateField('rtspPort', event.target.value)} className="font-mono" />
                      </SettingsField>
                      <SettingsField label="Usuário">
                        <SettingsInput value={form.username} onChange={(event) => updateField('username', event.target.value)} />
                      </SettingsField>
                      <SettingsField label="Senha" hint="Em branco mantém a senha atual.">
                        <SettingsInput type="password" value={form.password} placeholder="••••••••" onChange={(event) => updateField('password', event.target.value)} />
                      </SettingsField>
                      <SettingsField label="Porta de controle" hint="ONVIF / PTZ. Em branco para detectar." wide>
                        <SettingsInput type="number" min={1} value={form.onvifPort} onChange={(event) => updateField('onvifPort', event.target.value)} className="font-mono md:max-w-[50%]" />
                      </SettingsField>
                    </div>
                  </SettingsCard>

                  <SettingsCard icon={Video} title="Transmissão ao vivo" description="O grid entrega no máximo 720p / 20 FPS; a câmera individual usa a resolução original do perfil.">
                    <div className="grid gap-3 md:grid-cols-2">
                      <SettingsField label="Fonte da imagem" hint="Original usa o perfil principal; Econômico usa o substream.">
                        <SettingsSelect value={liveSourceMode} onChange={(event) => applyLiveSourceMode(event.target.value as LiveSourceMode)}>
                          <option value="original">Original da câmera</option>
                          <option value="economical">Econômico</option>
                          {liveSourceMode === 'advanced' ? <option value="advanced">Perfil personalizado</option> : null}
                        </SettingsSelect>
                      </SettingsField>
                      <SettingsField label="Resolução no grid" hint="Nunca ultrapassa 720p.">
                        <SettingsInput
                          value={`${form.streamWidth || GRID_LIVE_MAX_WIDTH}×${form.streamHeight || GRID_LIVE_MAX_HEIGHT}`}
                          readOnly
                          className="font-mono"
                        />
                      </SettingsField>
                      <SettingsField label="Protocolo ao vivo">
                        <SettingsSelect value={form.preferredLiveProtocol} onChange={(event) => updateField('preferredLiveProtocol', event.target.value as CameraConfig['preferredLiveProtocol'])}>
                          <option value="webrtc">WebRTC</option>
                          <option value="llhls">LL-HLS</option>
                          <option value="hls">HLS</option>
                        </SettingsSelect>
                      </SettingsField>
                      <SettingsField label="Transporte RTSP">
                        <SettingsSelect value={form.preferredRtspTransport} onChange={(event) => updateField('preferredRtspTransport', event.target.value as CameraConfig['preferredRtspTransport'])}>
                          <option value="tcp">TCP</option>
                          <option value="udp">UDP</option>
                        </SettingsSelect>
                      </SettingsField>
                      <SettingsField label="Codec da live">
                        <SettingsInput value="H.264" readOnly className="font-mono" />
                      </SettingsField>
                      <SettingsField label="Bitrate da live" hint="kbps · em branco usa o detectado.">
                        <SettingsInput type="number" min={1} value={form.streamBitrateKbps} onChange={(event) => updateField('streamBitrateKbps', event.target.value)} className="font-mono" />
                      </SettingsField>
                    </div>
                  </SettingsCard>

                  <SettingsCard icon={SlidersHorizontal} title="Operação" description="Liga ou desliga recursos desta câmera.">
                    <div className="grid gap-2.5">
                      <SettingsSwitch
                        checked={form.recordingEnabled}
                        onChange={(value) => updateField('recordingEnabled', value)}
                        label="Gravação habilitada"
                        description="Permite que o backend grave esta câmera conforme o modo abaixo."
                      />
                      <SettingsSwitch
                        checked={form.audioEnabled}
                        onChange={(value) => updateField('audioEnabled', value)}
                        label="Áudio habilitado"
                        description="Usa áudio no perfil operacional quando o stream suportar."
                      />
                      <SettingsSwitch
                        checked={form.alarmsEnabled}
                        onChange={(value) => updateField('alarmsEnabled', value)}
                        label="Alarmes habilitados"
                        description="Quando desligado, esta câmera não abre novos alarmes (eventos continuam registrados)."
                      />
                    </div>
                  </SettingsCard>

                  <SettingsCard icon={HardDrive} title="Gravação" description="Quando e por quanto tempo os vídeos são mantidos.">
                    <div className="grid gap-3 md:grid-cols-2">
                      <SettingsField label="Modo de gravação">
                        <SettingsSelect value={form.recordingMode} onChange={(event) => updateField('recordingMode', event.target.value as CameraConfig['recordingMode'])}>
                          <option value="continuous">Contínua</option>
                          <option value="motion">Movimento</option>
                          <option value="schedule">Agenda</option>
                          <option value="manual">Manual</option>
                        </SettingsSelect>
                      </SettingsField>
                      <SettingsSwitch
                        checked={form.retentionFollowsGroup}
                        onChange={(value) => updateField('retentionFollowsGroup', value)}
                        label="Seguir a retenção do grupo"
                        description="Desligue para esta câmera guardar por um prazo próprio, independente do grupo."
                      />
                      <SettingsField label="Retenção (dias)">
                        <SettingsInput type="number" min={1} disabled={form.retentionFollowsGroup} value={form.retentionDays} onChange={(event) => updateField('retentionDays', event.target.value)} className="font-mono" />
                      </SettingsField>
                      <SettingsField label="Codec de arquivo" hint="Arquiva o codec original (cópia, sem reconversão).">
                        <SettingsSelect value="copy" disabled>
                          <option value="copy">Original da câmera (cópia)</option>
                        </SettingsSelect>
                      </SettingsField>
                      <SettingsField label="Resolução do arquivo">
                        <SettingsSelect
                          value={getResolutionPresetValue(form.recordingWidth, form.recordingHeight) || 'custom'}
                          onChange={(event) => applyResolutionPreset('recording', event.target.value)}
                        >
                          <option value="custom" disabled>Personalizada</option>
                          <option value="original">Original da câmera</option>
                          {RESOLUTION_PRESETS.map((preset) => (
                            <option key={`recording-${preset.width}x${preset.height}`} value={`${preset.width}x${preset.height}`}>
                              {preset.label}
                            </option>
                          ))}
                        </SettingsSelect>
                      </SettingsField>
                      <SettingsField label="FPS do arquivo" hint="Acompanha o FPS detectado.">
                        <SettingsInput value={originalFps ? `${originalFps}` : 'Automático'} readOnly className="font-mono" />
                      </SettingsField>
                      <SettingsField label="Bitrate do arquivo" hint="kbps">
                        <SettingsInput type="number" min={1} value={form.recordingBitrateKbps} onChange={(event) => updateField('recordingBitrateKbps', event.target.value)} className="font-mono" />
                      </SettingsField>
                    </div>
                  </SettingsCard>
                </div>

                {/* Detalhes técnicos */}
                <details className="group overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5 transition hover:bg-accent/40">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/60 text-muted-foreground">
                      <Network className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold tracking-tight text-foreground">Detalhes técnicos e arquitetura</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">Perfis, canais e URLs RTSP em uso pelo pipeline.</p>
                    </div>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="grid gap-4 border-t border-border/70 px-5 py-4 md:grid-cols-2">
                    <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Perfil Live</div>
                      <div className="mt-1 text-sm font-medium text-foreground">
                        Canal {pipelineSummary?.live?.channel ?? (form.liveChannel || form.channel || '1')} · subtipo {pipelineSummary?.live?.subtype ?? (form.liveSubtype || '0')}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        Grid até {pipelineSummary?.live?.width && pipelineSummary?.live?.height ? `${pipelineSummary.live.width}×${pipelineSummary.live.height}` : `${GRID_LIVE_MAX_WIDTH}×${GRID_LIVE_MAX_HEIGHT}`} · {pipelineSummary?.live?.fps ?? GRID_LIVE_TARGET_FPS} FPS · {(pipelineSummary?.live?.browserProtocol ?? 'webrtc').toUpperCase()}
                      </div>
                      <div className="mt-2 truncate font-mono text-[10px] text-muted-foreground/80">{pipelineSummary?.live?.rtspUrl ?? 'rtsp://… main'}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Perfil Gravação</div>
                      <div className="mt-1 text-sm font-medium text-foreground">
                        Canal {pipelineSummary?.recording?.channel ?? (form.recordingChannel || form.channel || '1')} · subtipo {pipelineSummary?.recording?.subtype ?? (form.recordingSubtype || '0')}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        Arquivo {pipelineSummary?.recording?.targetCodec ? pipelineSummary.recording.targetCodec.toUpperCase() : 'cópia da fonte'} · {pipelineSummary?.recording?.enabled ? 'habilitada' : 'opcional'}
                      </div>
                      <div className="mt-2 truncate font-mono text-[10px] text-muted-foreground/80">{pipelineSummary?.recording?.rtspUrl ?? 'rtsp://… main'}</div>
                    </div>
                    {pipelineSummary?.notes?.length ? (
                      <div className="grid gap-2 md:col-span-2">
                        {pipelineSummary.notes.map((note) => (
                          <div key={note} className="rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">{note}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </details>

                {/* Rodapé fixo de salvar */}
                <div className="sticky bottom-0 z-10 flex flex-col gap-3 rounded-xl border border-border bg-card/95 px-5 py-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80 md:flex-row md:items-center md:justify-between">
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    <span className="font-semibold text-foreground">Resumo:</span> grid até 720p / {GRID_LIVE_TARGET_FPS} FPS · câmera individual em resolução original · gravação {getRecordingModeCopy(form.recordingMode).label.toLowerCase()}.
                  </div>
                  <button
                    type="submit"
                    disabled={configSaving}
                    className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {configSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                    {configSaving ? 'Salvando...' : 'Salvar configurações'}
                  </button>
                </div>
              </form>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
