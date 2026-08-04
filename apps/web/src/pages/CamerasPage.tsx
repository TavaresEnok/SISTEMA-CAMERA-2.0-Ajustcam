import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import {
  LayoutGrid, List, Search, Plus, Edit, PlaySquare,
  Crosshair, RefreshCw, ChevronRight, X, Wifi,
  Camera as CameraIcon, Check, Trash2, Circle, Radar, Radio,
} from 'lucide-react';
import { format } from 'date-fns';
import { Camera, useVmsDataStore } from '../store/vmsDataStore';
import { CameraEditSheet } from '../components/CameraEditSheet';
import { AddPushCameraDialog } from '../components/AddPushCameraDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Link, useLocation } from 'wouter';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';
import {
  getRecordingModeCopy,
  normalizePreferredLiveProtocol,
  normalizeVideoCodec,
  type PreferredLiveProtocol,
  type VideoCodec,
} from '../lib/camera-format';
import {
  describePreviewSource,
  describePreviewStream,
  parsePreviewFrame,
  type PreviewFrame,
} from '../lib/camera-preview-frame';
import { CLASSE_CONEXAO, CLASSE_MODO_GRAVACAO, PONTO_CONEXAO, ROTULO_CONEXAO, estadoConexao } from '../lib/camera-status';
const STATUSES = ['all', 'online', 'recording', 'motion', 'alarm', 'offline', 'no_signal', 'maintenance'] as const;
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  all: 'Todos os status',
  online: 'Online',
  recording: 'Gravando',
  motion: 'Movimento',
  alarm: 'Alarme',
  offline: 'Offline',
  no_signal: 'Sem sinal',
  maintenance: 'Manutenção',
};

const STATUS_BADGE: Record<string, string> = {
  online: 'bg-[hsl(var(--status-online)_/_0.12)] text-[hsl(var(--status-online))] border-[hsl(var(--status-online)_/_0.3)]',
  recording: 'bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))] border-[hsl(var(--destructive)_/_0.3)]',
  motion: 'bg-[hsl(var(--chart-2)_/_0.12)] text-[hsl(var(--chart-2))] border-[hsl(var(--chart-2)_/_0.3)]',
  alarm: 'bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))] border-[hsl(var(--destructive)_/_0.3)]',
  offline: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-border',
  no_signal: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-border',
  maintenance: 'bg-[hsl(var(--chart-2)_/_0.12)] text-[hsl(var(--chart-2))] border-[hsl(var(--chart-2)_/_0.3)]',
};

const STATUS_DOT: Record<string, string> = {
  online: 'bg-[hsl(var(--status-online))]',
  recording: 'bg-[hsl(var(--status-rec))] rec-pulse',
  motion: 'bg-[hsl(var(--status-motion))]',
  alarm: 'bg-[hsl(var(--status-alarm))] rec-pulse',
  offline: 'bg-[hsl(var(--status-offline))]',
  no_signal: 'bg-[hsl(var(--status-offline))]',
  maintenance: 'bg-[hsl(var(--status-warning))]',
};

const STATUS_PILLS = ['all', 'online', 'recording', 'motion', 'alarm', 'offline'] as const;

function getRequestErrorMessage(error: unknown, fallback: string) {
  if (axios.isAxiosError(error)) {
    const message = error.response?.data?.message;
    if (Array.isArray(message)) return message.join('\n');
    if (typeof message === 'string' && message.trim()) return message;
    if (typeof error.response?.data?.error === 'string') return error.response.data.error;
    return error.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

const DEFAULT_CAMERA_CHANNEL = 1;
const MAIN_STREAM_SUBTYPE = 0;
const ANALYTICS_STREAM_SUBTYPE = 1;
const GRID_LIVE_MAX_WIDTH = 1280;
const GRID_LIVE_MAX_HEIGHT = 720;
const GRID_LIVE_TARGET_FPS = 20;

function formatLiveProtocol(protocol?: string | null) {
  switch (String(protocol ?? '').toLowerCase()) {
    case 'auto':
      return 'WebRTC';
    case 'webrtc':
      return 'WebRTC';
    case 'hls':
      return 'HLS';
    case 'llhls':
    case 'll-hls':
      return 'LL-HLS';
    case 'mjpeg':
      return 'MJPEG';
    default:
      return 'WebRTC';
  }
}

function formatCameraStatus(status: string) {
  switch (status) {
    case 'online':
      return 'Online';
    case 'recording':
      return 'Gravando';
    case 'motion':
      return 'Movimento';
    case 'alarm':
      return 'Alarme';
    case 'offline':
      return 'Offline';
    case 'no_signal':
      return 'Sem sinal';
    case 'maintenance':
      return 'Manutenção';
    default:
      return status.replace('_', ' ');
  }
}

function formatRecordingMode(mode: string) {
  switch (mode) {
    case 'continuous':
      return 'Contínua';
    case 'motion':
      return 'Movimento';
    case 'schedule':
      return 'Agenda';
    case 'manual':
      return 'Manual';
    default:
      return mode;
  }
}

type LocationOption = { id: string; name: string; siteId?: string | null };
type PosterTokenItem = { cameraId: string; streamToken: string; posterUrl: string };

/**
 * Painel de CONFIRMAÇÃO VISUAL do assistente: mostra o frame capturado da câmera
 * antes de salvar. É a única coisa que distingue a câmera do estacionamento da
 * câmera da recepção — metadado (resolução/codec/fps) é idêntico nas duas.
 */
function PreviewFramePanel({
  frame,
  loading,
  onRefresh,
  disabled,
}: {
  frame: PreviewFrame | null;
  loading: boolean;
  onRefresh: () => void;
  disabled?: boolean;
}) {
  const sourceLabel = describePreviewSource(frame?.source ?? null);
  const streamLabel = describePreviewStream(frame?.stream ?? null);
  return (
    <div className="rounded border border-border bg-background px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium text-foreground">Confirmação visual</div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || disabled}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[10px] transition-colors hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CameraIcon className="h-3 w-3" />
          {loading ? 'Capturando...' : frame ? 'Atualizar imagem' : 'Ver imagem da câmera'}
        </button>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
        Resolução e codec são iguais em câmeras diferentes. A imagem é o que confirma que este IP é a câmera certa.
      </p>
      {loading && !frame && (
        <div className="mt-2 flex h-40 items-center justify-center rounded border border-dashed border-border text-[11px] text-[hsl(var(--muted-foreground))]">
          Capturando imagem da câmera...
        </div>
      )}
      {frame?.ok && frame.imageDataUrl && (
        <div className="mt-2 space-y-1">
          <img
            src={frame.imageDataUrl}
            alt="Frame capturado da câmera para confirmação visual"
            className="w-full rounded border border-border bg-black object-contain"
          />
          <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
            {[streamLabel, sourceLabel].filter(Boolean).join(' · ') || 'Imagem capturada agora.'}
          </div>
        </div>
      )}
      {frame && !frame.ok && (
        <div className="mt-2 rounded border border-[hsl(var(--status-warning)_/_0.3)] bg-[hsl(var(--status-warning)_/_0.1)] px-2.5 py-2 text-[10px] text-[hsl(var(--status-warning))]">
          Sem imagem para conferir. {frame.reason}
        </div>
      )}
    </div>
  );
}

function WizardModal({
  onClose,
  sites,
  areas,
  onCreated,
  onTestConnection,
  onPreviewFrame,
}: {
  onClose: () => void;
  sites: LocationOption[];
  areas: LocationOption[];
  onCreated: (payload: {
    siteId?: string;
    areaId?: string;
    name: string;
    ip: string;
    rtspPort: number;
    onvifPort?: number;
    username: string;
    password: string;
    rtspPath?: string;
    onvifPath?: string;
    onvifProfileToken?: string;
    channel?: number;
    subtype?: number;
    liveChannel?: number;
    liveSubtype?: number;
    recordingChannel?: number;
    recordingSubtype?: number;
    analyticsChannel?: number;
    analyticsSubtype?: number;
    recordingEnabled: boolean;
    recordingMode: 'continuous' | 'motion' | 'schedule' | 'manual';
    retentionDays: number;
    retentionFollowsGroup?: boolean;
    preferredRtspTransport: 'tcp' | 'udp';
    preferredLiveProtocol: PreferredLiveProtocol;
    streamVideoCodec: VideoCodec;
    streamWidth?: number;
    streamHeight?: number;
    streamFps?: number;
    streamBitrateKbps?: number;
    recordingVideoCodec: VideoCodec;
    recordingWidth?: number;
    recordingHeight?: number;
    recordingFps?: number;
    recordingBitrateKbps?: number;
    audioEnabled: boolean;
  }) => Promise<void>;
  onTestConnection: (payload: {
    ip: string;
    rtspPort: number;
    onvifPort?: number;
    username?: string;
    password?: string;
    rtspPath?: string;
    onvifPath?: string;
    onvifProfileToken?: string;
    channel?: number;
    subtype?: number;
  }) => Promise<{
    rtspReachable: boolean;
    rtspReachableAny?: boolean;
    reachableRtspPorts?: number[];
    onvifReachable: boolean;
    ptzDigestOk?: boolean;
    reachableOnvifPorts?: number[];
    rtspAuthOk?: boolean;
    selectedRtspPortAuthOk?: boolean;
    detectedRtspPort?: number | null;
    detectedRtspPath?: string | null;
    suggestedRtspPath?: string;
    detectedOnvifPort?: number | null;
    detectedOnvifPath?: string | null;
    detectedOnvifProfileToken?: string | null;
    rtspProbeError?: string | null;
    status: string;
    detectedStream?: {
      codec?: string | null;
      width?: number | null;
      height?: number | null;
      fps?: number | null;
      bitrateKbps?: number | null;
    } | null;
    autoProfiles?: {
      live?: {
        channel?: number;
        subtype?: number;
        source?: string;
        rtspPath?: string | null;
        metadata?: { codec?: string | null; width?: number | null; height?: number | null; fps?: number | null; bitrateKbps?: number | null } | null;
        onvifProfileToken?: string | null;
      };
      recording?: {
        channel?: number;
        subtype?: number;
        source?: string;
        rtspPath?: string | null;
        metadata?: { codec?: string | null; width?: number | null; height?: number | null; fps?: number | null; bitrateKbps?: number | null } | null;
        codecPolicy?: string;
        onvifProfileToken?: string | null;
      };
      analytics?: {
        channel?: number;
        subtype?: number;
        source?: string;
        rtspPath?: string | null;
        metadata?: { codec?: string | null; width?: number | null; height?: number | null; fps?: number | null; bitrateKbps?: number | null } | null;
        onvifProfileToken?: string | null;
      };
    };
    probeSteps?: Array<{
      key: string;
      label: string;
      status: 'ok' | 'warning' | 'error';
      durationMs: number;
      detail?: string | null;
    }>;
    compatibility?: {
      state: 'ideal' | 'compatible' | 'attention';
      detectedFamily: string;
      confidence: 'high' | 'medium' | 'low';
      summary: string;
      automaticProfile: { live: string; recording: string; analytics: string };
      hints: Array<{
        code: string;
        severity: 'info' | 'warning' | 'critical';
        title: string;
        message: string;
        action?: string;
      }>;
    };
  }>;
  onPreviewFrame: (payload: {
    ip: string;
    rtspPort: number;
    username?: string;
    password?: string;
    rtspPath?: string;
    channel?: number;
    subtype?: number;
  }) => Promise<PreviewFrame>;
}) {
  const [step, setStep] = useState(0);
  const [detectedMax, setDetectedMax] = useState<{
    width: number | null;
    height: number | null;
    fps: number | null;
    bitrateKbps: number | null;
  } | null>(null);
  const steps = ['Conexão', 'Identidade', 'Gravação', 'Confirmar'];
  const [form, setForm] = useState({
    ip: '',
    port: '554',
    onvifPort: '',
    protocol: 'rtsp',
    username: '',
    password: '',
    rtspPath: '',
    onvifPath: '',
    onvifProfileToken: '',
    channel: '1',
    subtype: '0',
    name: '',
    siteId: '',
    areaId: '',
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
    recordingVideoCodec: 'h265' as VideoCodec,
    recordingWidth: '',
    recordingHeight: '',
    recordingFps: '',
    recordingBitrateKbps: '',
    audioEnabled: true,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testingStage, setTestingStage] = useState('');
  const [autoProfiles, setAutoProfiles] = useState<Awaited<ReturnType<typeof onTestConnection>>['autoProfiles'] | null>(null);
  const [probeSteps, setProbeSteps] = useState<NonNullable<Awaited<ReturnType<typeof onTestConnection>>['probeSteps']>>([]);
  const [compatibility, setCompatibility] = useState<Awaited<ReturnType<typeof onTestConnection>>['compatibility'] | null>(null);
  const [previewFrame, setPreviewFrame] = useState<PreviewFrame | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const updateField = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const canAdvance = (() => {
    if (step === 0) {
      return form.ip.trim().length > 0 && form.port.trim().length > 0 && form.username.trim().length > 0 && form.password.trim().length > 0;
    }
    if (step === 1) {
      return form.name.trim().length > 0;
    }
    if (step === 2) {
      return form.retentionDays.trim().length > 0;
    }
    return true;
  })();

  const handlePrimary = async () => {
    if (step < steps.length - 1) {
      if (step === 0 && !detectedMax) {
        const detected = await handleTestConnection(false);
        if (!detected) return;
      }
      setStep((current) => current + 1);
      return;
    }

    setIsSaving(true);
    try {
      const clampToDetected = (
        label: string,
        rawValue: string,
        max: number | null | undefined,
        changes: string[],
      ): number | undefined => {
        if (!rawValue.trim()) return undefined;
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return undefined;
        if (max && max > 0 && value > max) {
          changes.push(`${label}: solicitado ${value}, aplicado ${max}`);
          return max;
        }
        return value;
      };
      const parseOptionalPositive = (rawValue: string): number | undefined => {
        if (!rawValue.trim()) return undefined;
        const value = Number(rawValue);
        return Number.isFinite(value) && value > 0 ? value : undefined;
      };

      const adjusted: string[] = [];
      const streamWidth = clampToDetected('Live largura', String(GRID_LIVE_MAX_WIDTH), detectedMax?.width, adjusted);
      const streamHeight = clampToDetected('Live altura', String(GRID_LIVE_MAX_HEIGHT), detectedMax?.height, adjusted);
      const streamFps = GRID_LIVE_TARGET_FPS;
      const streamBitrateKbps = form.streamBitrateKbps.trim()
        ? clampToDetected('Live bitrate', form.streamBitrateKbps, detectedMax?.bitrateKbps, adjusted)
        : undefined;
      const recordingWidth = parseOptionalPositive(form.recordingWidth);
      const recordingHeight = parseOptionalPositive(form.recordingHeight);
      const recordingFps = detectedMax?.fps ?? parseOptionalPositive(form.recordingFps);
      const recordingBitrateKbps = parseOptionalPositive(form.recordingBitrateKbps);

      if (adjusted.length) {
        toast({
          title: 'Valores ajustados ao máximo detectado',
          description: adjusted.join(' | '),
        });
      }

      await onCreated({
        name: form.name.trim(),
        siteId: form.siteId || undefined,
        areaId: form.areaId || undefined,
        ip: form.ip.trim(),
        rtspPort: Number(form.port),
        onvifPort: form.onvifPort.trim() ? Number(form.onvifPort) : undefined,
        username: form.username.trim(),
        password: form.password,
        rtspPath: form.rtspPath.trim() || undefined,
        onvifPath: form.onvifPath.trim() || undefined,
        onvifProfileToken: form.onvifProfileToken.trim() || undefined,
        channel: Number(form.channel || DEFAULT_CAMERA_CHANNEL),
        subtype: MAIN_STREAM_SUBTYPE,
        liveChannel: Number(form.channel || DEFAULT_CAMERA_CHANNEL),
        liveSubtype: MAIN_STREAM_SUBTYPE,
        recordingChannel: Number(form.channel || DEFAULT_CAMERA_CHANNEL),
        recordingSubtype: MAIN_STREAM_SUBTYPE,
        analyticsChannel: Number(form.channel || DEFAULT_CAMERA_CHANNEL),
        analyticsSubtype: ANALYTICS_STREAM_SUBTYPE,
        recordingEnabled: form.recordingMode !== 'manual',
        recordingMode: form.recordingMode as 'continuous' | 'motion' | 'schedule' | 'manual',
        retentionDays: Number(form.retentionDays),
        retentionFollowsGroup: form.retentionFollowsGroup,
        preferredRtspTransport: form.preferredRtspTransport as 'tcp' | 'udp',
        preferredLiveProtocol: normalizePreferredLiveProtocol(form.preferredLiveProtocol),
        streamVideoCodec: normalizeVideoCodec(form.streamVideoCodec),
        streamWidth,
        streamHeight,
        streamFps,
        streamBitrateKbps,
        recordingVideoCodec: normalizeVideoCodec(form.recordingVideoCodec),
        recordingWidth,
        recordingHeight,
        recordingFps,
        recordingBitrateKbps,
        audioEnabled: form.audioEnabled,
      });
      onClose();
    } catch (error) {
      toast({
        title: 'Erro ao adicionar câmera',
        description: getRequestErrorMessage(error, 'Não foi possível adicionar a câmera.'),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Um frame vale mais que a ficha técnica inteira: é o que separa "câmera 7 do
  // estacionamento" de "câmera 3 da recepção" quando os IPs foram trocados.
  // Falhar aqui NUNCA trava o cadastro — a confirmação é um a mais, não um gate.
  const capturePreview = async (overrides?: { rtspPath?: string }) => {
    if (!form.ip.trim() || !form.port.trim() || !form.username.trim() || !form.password) return;
    setPreviewLoading(true);
    try {
      const frame = await onPreviewFrame({
        ip: form.ip.trim(),
        rtspPort: Number(form.port),
        username: form.username.trim(),
        password: form.password,
        rtspPath: overrides?.rtspPath ?? (form.rtspPath.trim() || undefined),
        channel: Number(form.channel || DEFAULT_CAMERA_CHANNEL),
        subtype: MAIN_STREAM_SUBTYPE,
      });
      setPreviewFrame(frame);
    } catch (error) {
      setPreviewFrame({
        ok: false,
        imageDataUrl: null,
        bytes: 0,
        capturedAt: null,
        source: null,
        stream: null,
        reason: getRequestErrorMessage(error, 'Não foi possível capturar a imagem da câmera.'),
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleTestConnection = async (showResult = true): Promise<boolean> => {
    if (!form.ip.trim() || !form.port.trim()) {
      toast({ title: 'Dados incompletos', description: 'Preencha IP e porta RTSP antes de testar conexão.', variant: 'destructive' });
      return false;
    }
    setIsTesting(true);
    setTestingStage('Conectando portas RTSP/ONVIF...');
    const stageTimers = [
      window.setTimeout(() => setTestingStage((current) => current || 'Lendo perfis de vídeo...'), 300),
      window.setTimeout(() => setTestingStage('Testando stream principal e substream...'), 1200),
    ];
    try {
      const result = await onTestConnection({
        ip: form.ip.trim(),
        rtspPort: Number(form.port),
        onvifPort: form.onvifPort.trim() ? Number(form.onvifPort) : undefined,
        username: form.username.trim(),
        password: form.password,
        rtspPath: form.rtspPath.trim() || undefined,
        onvifPath: form.onvifPath.trim() || undefined,
        onvifProfileToken: form.onvifProfileToken.trim() || undefined,
        channel: Number(form.channel || DEFAULT_CAMERA_CHANNEL),
        subtype: MAIN_STREAM_SUBTYPE,
      });
      setTestingStage('Aplicando configuração automática...');
      if (result.suggestedRtspPath && !form.rtspPath.trim()) updateField('rtspPath', result.suggestedRtspPath);
      if (result.detectedStream?.codec) updateField('streamVideoCodec', normalizeVideoCodec(result.detectedStream.codec));
      setAutoProfiles(result.autoProfiles ?? null);
      setProbeSteps(result.probeSteps ?? []);
      setCompatibility(result.compatibility ?? null);
      setDetectedMax({
        width: typeof result.detectedStream?.width === 'number' ? result.detectedStream.width : null,
        height: typeof result.detectedStream?.height === 'number' ? result.detectedStream.height : null,
        fps: typeof result.detectedStream?.fps === 'number' ? result.detectedStream.fps : null,
        bitrateKbps: typeof result.detectedStream?.bitrateKbps === 'number' ? result.detectedStream.bitrateKbps : null,
      });
      const selectedPort = Number(form.port);
      if (
        typeof result.detectedRtspPort === 'number' &&
        result.detectedRtspPort === selectedPort &&
        result.detectedRtspPath
      ) {
        updateField('rtspPath', result.detectedRtspPath);
      }
      if (typeof result.detectedOnvifPort === 'number') updateField('onvifPort', String(result.detectedOnvifPort));
      if (result.detectedOnvifPath) updateField('onvifPath', result.detectedOnvifPath);
      if (result.detectedOnvifProfileToken) updateField('onvifProfileToken', result.detectedOnvifProfileToken);
      if (showResult) {
        if (result.rtspAuthOk || result.rtspReachable || result.rtspReachableAny) {
          toast({ title: 'Câmera detectada', description: 'O DRAC configurou live principal, grid em 720p/20 FPS e gravação com o FPS original da câmera.' });
        } else {
          toast({ title: 'Vídeo não confirmado', description: 'Verifique IP, porta, usuário e senha.', variant: 'destructive' });
        }
      }
      // Confirmação visual logo após a detecção: sem esperar o técnico pedir,
      // porque justamente quem não pede é quem cadastra a câmera errada.
      if (result.rtspAuthOk) {
        void capturePreview({
          rtspPath: result.detectedRtspPath ?? result.suggestedRtspPath ?? (form.rtspPath.trim() || undefined),
        });
      }
      return true;
    } catch (error) {
      toast({ title: 'Falha ao testar conexão', description: getRequestErrorMessage(error, 'Falha ao testar conexão.'), variant: 'destructive' });
      return false;
    } finally {
      stageTimers.forEach((timer) => window.clearTimeout(timer));
      setIsTesting(false);
      setTestingStage('');
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="w-full max-w-[560px] overflow-hidden rounded-lg border border-border bg-card shadow-sm"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border bg-background/40">
          <div>
            <h3 className="text-sm font-semibold">Assistente de Nova Câmera</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">Informe o básico. O DRAC detecta perfis, paths e origem automaticamente.</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-[hsl(var(--accent))] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* Step indicators */}
        <div className="flex items-center px-5 py-3 border-b border-border">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center">
              <div className={`flex items-center justify-center w-6 h-6 rounded-full border text-[10px] font-bold transition-colors ${i === step ? 'border-[hsl(var(--primary)_/_0.45)] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : i < step ? 'border-[hsl(var(--status-online)_/_0.35)] bg-[hsl(var(--status-online)_/_0.14)] text-[hsl(var(--status-online))]' : 'border-border bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'}`}>
                {i < step ? <Check className="w-3 h-3" /> : i + 1}
              </div>
              <span className={`ml-1.5 text-[11px] ${i === step ? 'text-foreground font-medium' : 'text-[hsl(var(--muted-foreground))]'}`}>{s}</span>
              {i < steps.length - 1 && <div className="w-8 h-px bg-border mx-2" />}
            </div>
          ))}
        </div>

        <div className="p-5 min-h-48">
          {step === 0 && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Endereço IP</label>
                <input value={form.ip} onChange={(e) => updateField('ip', e.target.value)} className="w-full h-9 px-3 rounded border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" placeholder="192.168.20.149" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Porta RTSP</label>
                  <input value={form.port} onChange={(e) => updateField('port', e.target.value)} className="w-full h-9 px-3 rounded border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" placeholder="554" />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Usuário</label>
                  <input value={form.username} onChange={(e) => updateField('username', e.target.value)} className="w-full h-9 px-3 rounded border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" placeholder="admin" />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Senha</label>
                  <input type="password" value={form.password} onChange={(e) => updateField('password', e.target.value)} className="w-full h-9 px-3 rounded border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" placeholder="********" />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Canal</label>
                  <input value={form.channel} onChange={(e) => updateField('channel', e.target.value)} className="w-full h-9 px-3 rounded border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" placeholder="1" />
                </div>
              </div>
              <details className="rounded border border-border bg-background/60 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-[hsl(var(--muted-foreground))]">Avançado para técnico</summary>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Porta ONVIF opcional</label>
                    <input value={form.onvifPort} onChange={(e) => updateField('onvifPort', e.target.value)} className="w-full h-9 px-3 rounded border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" placeholder="Automático" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Protocolo</label>
                    <Select value={form.protocol} onValueChange={(value) => updateField('protocol', value)}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rtsp" className="text-xs">RTSP</SelectItem>
                        <SelectItem value="onvif" className="text-xs">ONVIF</SelectItem>
                        <SelectItem value="http" className="text-xs">HTTP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </details>
              <button onClick={() => void handleTestConnection()} disabled={isTesting} className="flex items-center gap-2 px-3 py-1.5 rounded border border-border text-xs hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <Wifi className="w-3.5 h-3.5" />
                {isTesting ? 'Detectando...' : 'Detectar câmera'}
              </button>
              {isTesting && (
                <div className="rounded border border-border bg-background px-3 py-2 text-[11px] text-[hsl(var(--muted-foreground))]">
                  {testingStage || 'Detectando câmera...'}
                </div>
              )}
              {!isTesting && probeSteps.length > 0 && (
                <details className="rounded border border-border bg-background px-3 py-2 text-[11px] text-[hsl(var(--muted-foreground))]">
                  <summary className="cursor-pointer text-xs font-medium">Diagnóstico automático</summary>
                  <div className="mt-2 space-y-1.5">
                    {probeSteps.map((item) => (
                      <div key={item.key} className="flex items-start justify-between gap-3">
                        <span className={item.status === 'error' ? 'text-[hsl(var(--destructive))]' : item.status === 'warning' ? 'text-[hsl(var(--status-warning))]' : 'text-[hsl(var(--status-online))]'}>
                          {item.label}
                        </span>
                        <span className="min-w-0 flex-1 text-right">
                          {item.detail || item.status} · {item.durationMs}ms
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {(detectedMax || previewFrame || previewLoading) && (
                <PreviewFramePanel
                  frame={previewFrame}
                  loading={previewLoading}
                  onRefresh={() => void capturePreview()}
                  disabled={isTesting || !form.username.trim() || !form.password}
                />
              )}
              {detectedMax && (
                <div className="rounded border border-[hsl(var(--status-online)_/_0.25)] bg-[hsl(var(--status-online)_/_0.1)] px-3 py-2 text-[11px] text-[hsl(var(--status-online))]">
                  Câmera detectada. Grid em até 720p / 20 FPS, câmera individual em resolução original e gravação com FPS da câmera.
                  <details className="mt-1 text-[hsl(var(--muted-foreground))]">
                    <summary className="cursor-pointer text-[10px]">Detalhes</summary>
                    <div className="mt-1 grid gap-1">
                      <span>Principal: {detectedMax.width && detectedMax.height ? `${detectedMax.width}x${detectedMax.height}` : 'detectado'} · {detectedMax.fps ?? '-'} FPS</span>
                      {autoProfiles?.live?.onvifProfileToken && <span>ONVIF live: {autoProfiles.live.onvifProfileToken}</span>}
                      <span>Bitrate: {detectedMax.bitrateKbps ? `${detectedMax.bitrateKbps} kbps` : '-'}</span>
                    </div>
                  </details>
                </div>
              )}
              {compatibility && (
                <div className={`rounded border px-3 py-2 text-[11px] ${
                  compatibility.state === 'ideal'
                    ? 'border-[hsl(var(--status-online)_/_0.25)] bg-[hsl(var(--status-online)_/_0.1)]'
                    : compatibility.state === 'attention'
                      ? 'border-[hsl(var(--destructive)_/_0.25)] bg-[hsl(var(--destructive)_/_0.1)]'
                      : 'border-[hsl(var(--status-warning)_/_0.25)] bg-[hsl(var(--status-warning)_/_0.1)]'
                }`}>
                  <div className="font-medium text-foreground">{compatibility.summary}</div>
                  <div className="mt-1 text-[hsl(var(--muted-foreground))]">
                    Família detectada: <span className="uppercase text-foreground">{compatibility.detectedFamily}</span>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer font-medium text-[hsl(var(--muted-foreground))]">Perfis escolhidos e recomendações</summary>
                    <div className="mt-2 space-y-2 border-t border-border pt-2 text-[hsl(var(--muted-foreground))]">
                      <div>Live: <span className="text-foreground">{compatibility.automaticProfile.live}</span></div>
                      <div>Gravação: <span className="text-foreground">{compatibility.automaticProfile.recording}</span></div>
                      <div>Análise: <span className="text-foreground">{compatibility.automaticProfile.analytics}</span></div>
                      {compatibility.hints.map((hint) => (
                        <div key={hint.code} className="border-t border-border pt-2">
                          <div className={hint.severity === 'critical' ? 'text-[hsl(var(--destructive))]' : hint.severity === 'warning' ? 'text-[hsl(var(--status-warning))]' : 'text-[hsl(var(--primary))]'}>
                            {hint.title}
                          </div>
                          <div>{hint.message}</div>
                          {hint.action && <div className="mt-0.5 text-foreground">{hint.action}</div>}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </div>
          )}
          {step === 1 && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Nome da câmera</label>
                <input value={form.name} onChange={(e) => updateField('name', e.target.value)} className="w-full h-9 px-3 rounded border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" placeholder="Ex.: Legacy Camera - Canal 1" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Unidade</label>
                  <Select
                    value={form.siteId || '__none__'}
                    onValueChange={(value) => {
                      const nextSiteId = value === '__none__' ? '' : value;
                      setForm((current) => ({ ...current, siteId: nextSiteId, areaId: '' }));
                    }}
                  >
                    <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Selecionar unidade..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" className="text-xs">Sem unidade</SelectItem>
                      {sites.map((site) => <SelectItem key={site.id} value={site.id} className="text-xs">{site.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Área</label>
                  <Select
                    value={form.areaId || '__none__'}
                    onValueChange={(value) => updateField('areaId', value === '__none__' ? '' : value)}
                  >
                    <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Selecionar área..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" className="text-xs">Sem área</SelectItem>
                      {areas
                        .filter((area) => !form.siteId || area.siteId === form.siteId)
                        .map((area) => <SelectItem key={area.id} value={area.id} className="text-xs">{area.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-background p-3 space-y-3">
                <div className="text-xs font-semibold">Gravação</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Modo</label>
                    <Select value={form.recordingMode} onValueChange={(value) => updateField('recordingMode', value)}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="continuous" className="text-xs">Contínua</SelectItem>
                        <SelectItem value="motion" className="text-xs">Por movimento</SelectItem>
                        <SelectItem value="schedule" className="text-xs">Agenda</SelectItem>
                        <SelectItem value="manual" className="text-xs">Manual</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Retenção</label>
                    <input value={form.retentionDays} onChange={(e) => updateField('retentionDays', e.target.value)} disabled={form.retentionFollowsGroup} className="w-full h-9 px-3 disabled:opacity-45 rounded border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" />
                    {/* Seguir o grupo é o padrão. O campo de dias só faz sentido quando a
                        câmera é exceção — deixá-lo editável seguindo o grupo faria o
                        operador digitar um número que o sistema ignora. */}
                    <label className="col-span-2 flex cursor-pointer items-start gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={form.retentionFollowsGroup}
                        onChange={(e) => updateField('retentionFollowsGroup', e.target.checked)}
                      />
                      <span>
                        Seguir a retenção do grupo
                        <span className="mt-0.5 block text-[hsl(var(--muted-foreground))]">
                          Desligue para esta câmera guardar por um prazo próprio.
                        </span>
                      </span>
                    </label>
                  </div>
                  <div className="col-span-2 rounded border border-border bg-card px-3 py-2 text-[11px] text-[hsl(var(--muted-foreground))]">
                    O grid usa no máximo 720p em 20 FPS. Ao abrir a câmera sozinha, o DRAC mostra a resolução original do perfil live. A gravação usa o perfil principal da câmera e preserva o FPS da origem.
                  </div>
                </div>
              </div>

              <details className="rounded-lg border border-border bg-background p-3">
                <summary className="cursor-pointer text-xs font-medium text-[hsl(var(--muted-foreground))]">Avançado</summary>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Codec da origem</label>
                    <Select value={form.streamVideoCodec} onValueChange={(value) => updateField('streamVideoCodec', value)}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="original" className="text-xs">Detectar automaticamente</SelectItem>
                        <SelectItem value="h264" className="text-xs">H.264</SelectItem>
                        <SelectItem value="h265" className="text-xs">H.265</SelectItem>
                        <SelectItem value="mjpeg" className="text-xs">MJPEG</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Protocolo ao vivo</label>
                    <Select value={form.preferredLiveProtocol} onValueChange={(value) => updateField('preferredLiveProtocol', value as PreferredLiveProtocol)}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="webrtc" className="text-xs">WebRTC</SelectItem>
                        <SelectItem value="llhls" className="text-xs">LL-HLS</SelectItem>
                        <SelectItem value="hls" className="text-xs">HLS</SelectItem>
                        <SelectItem value="mjpeg" className="text-xs">MJPEG</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Perfil de gravação</label>
                    <Select value="main" disabled>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="main" className="text-xs">Principal da câmera</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Arquivo</label>
                    <Select value="copy" disabled>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="copy" className="text-xs">Original da câmera (cópia)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </details>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-3">
              {/* Última chance de perceber que este IP é a câmera errada — antes
                  de salvar, e não meses depois quando o cliente pedir a gravação. */}
              <PreviewFramePanel
                frame={previewFrame}
                loading={previewLoading}
                onRefresh={() => void capturePreview()}
                disabled={!form.username.trim() || !form.password}
              />
              <div className="rounded-lg border border-border bg-background p-4 space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Endereço IP</span><span className="font-mono">{form.ip || '-'}</span></div>
                <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Nome</span><span>{form.name || '-'}</span></div>
                <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Unidade</span><span>{sites.find((s) => s.id === form.siteId)?.name ?? '-'}</span></div>
                <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Área</span><span>{areas.find((a) => a.id === form.areaId)?.name ?? '-'}</span></div>
                <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Live</span><span>Grid até 720p / 20 FPS · individual original</span></div>
                <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Gravação</span><span>{formatRecordingMode(form.recordingMode)}</span></div>
                <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Retenção</span><span className="font-mono">{form.retentionDays || '-'} dias</span></div>
                {detectedMax && (
                  <div className="mt-2 rounded border border-border bg-card px-3 py-2 text-[11px] text-[hsl(var(--muted-foreground))]">
                    Detectado: <span className="font-mono text-foreground">{detectedMax.width && detectedMax.height ? `${detectedMax.width}x${detectedMax.height}` : '-'}</span>
                    <span className="mx-2">|</span>
                    <span className="font-mono text-foreground">{detectedMax.fps ?? '-'} FPS</span>
                  </div>
                )}
                <details className="pt-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-[hsl(var(--muted-foreground))]">Detalhes avançados</summary>
                  <div className="mt-2 space-y-2 border-t border-border pt-2">
                    <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Porta RTSP</span><span className="font-mono">{form.port || '-'}</span></div>
                    <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Porta de controle</span><span className="font-mono">{form.onvifPort || '-'}</span></div>
                    <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Canal</span><span className="font-mono">{form.channel || '-'}</span></div>
                    <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Origem live</span><span className="font-mono uppercase">{form.streamVideoCodec}</span></div>
                    <div className="flex justify-between"><span className="text-[hsl(var(--muted-foreground))]">Entrega live</span><span className="font-mono">{formatLiveProtocol(form.preferredLiveProtocol)}</span></div>
                  </div>
                </details>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-border">
          <button
            onClick={() => setStep(s => Math.max(0, s - 1))}
            disabled={step === 0}
            className="px-4 py-2 rounded border border-border text-xs hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >Voltar</button>
          <button
            onClick={() => void handlePrimary()}
            disabled={!canAdvance || isSaving}
            className="px-4 py-2 rounded bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >{isSaving ? 'Adicionando...' : step < steps.length - 1 ? 'Próximo' : 'Adicionar Câmera'}</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function CamerasPage() {
  const API_URL = getApiBaseUrl();
  const [, setLocation] = useLocation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const cameras = useVmsDataStore((state) => state.cameras);
  const loadData = useVmsDataStore((state) => state.load);
  const [viewMode, setViewMode] = useState<'table' | 'card'>(() => {
    try {
      const saved = localStorage.getItem('drac:camerasViewMode');
      return saved === 'card' || saved === 'table' ? saved : 'table';
    } catch {
      return 'table';
    }
  });
  useEffect(() => {
    try { localStorage.setItem('drac:camerasViewMode', viewMode); } catch { /* ignore */ }
  }, [viewMode]);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUSES)[number]>('all');
  const [showWizard, setShowWizard] = useState(false);
  const [showPushDialog, setShowPushDialog] = useState(false);
  const [selectedCam, setSelectedCam] = useState<Camera | null>(null);
  const [editCamera, setEditCamera] = useState<Camera | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Camera | null>(null);
  const [wizardSites, setWizardSites] = useState<LocationOption[]>([]);
  const [wizardAreas, setWizardAreas] = useState<LocationOption[]>([]);
  const [locationOptionsLoaded, setLocationOptionsLoaded] = useState(false);
  const [reconnectingSingleCameraId, setReconnectingSingleCameraId] = useState<string | null>(null);
  const [manualRecordingLoading, setManualRecordingLoading] = useState<{ cameraId: string; action: 'start' | 'stop' } | null>(null);
  const [motionRecordingLoadingCameraId, setMotionRecordingLoadingCameraId] = useState<string | null>(null);
  const [recordingOverrides, setRecordingOverrides] = useState<Record<string, boolean>>({});
  const [diagnosingPtzCameraId, setDiagnosingPtzCameraId] = useState<string | null>(null);
  const [posterUrls, setPosterUrls] = useState<Record<string, string>>({});
  const lastPosterRetryAtRef = useRef(0);
  const [recordingHealthByCamera, setRecordingHealthByCamera] = useState<Record<string, {
    total: number;
    broken: number;
    tooSmall: number;
    compatibleRecommended: number;
    directLikely: number;
    withAudio: number;
    lastRecordingAgeSeconds: number | null;
    needsAttention?: boolean;
    alertReason?: string | null;
  }>>({});
  const groups = useMemo(() => ['all', ...Array.from(new Set(cameras.map((c) => c.floor).filter((f) => f && f !== '-')))], [cameras]);
  const posterCameraIdsKey = useMemo(
    () => cameras.filter((camera) => camera.isOnline).map((camera) => camera.id).sort().join(','),
    [cameras],
  );
  const loadPosterTokens = useCallback(async () => {
    if (!accessToken) return;
    const cameraIds = useVmsDataStore.getState().cameras.filter((camera) => camera.isOnline).map((camera) => camera.id);
    if (!cameraIds.length) {
      setPosterUrls({});
      return;
    }
    try {
      const { data } = await axios.post<{ items: PosterTokenItem[] }>(
        `${API_URL}/camera-stream/poster-tokens`,
        { cameraIds },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const next: Record<string, string> = {};
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const separator = item.posterUrl.includes('?') ? '&' : '?';
        next[item.cameraId] = `${item.posterUrl}${separator}token=${encodeURIComponent(item.streamToken)}&v=${Date.now()}`;
      }
      setPosterUrls(next);
    } catch {
      // Preserva a última amostra válida durante uma falha transitória.
    }
  }, [API_URL, accessToken]);

  useEffect(() => {
    void loadPosterTokens();
    const renew = () => {
      if (document.visibilityState === 'visible') void loadPosterTokens();
    };
    const timer = window.setInterval(renew, 4 * 60 * 1000);
    window.addEventListener('focus', renew);
    document.addEventListener('visibilitychange', renew);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', renew);
      document.removeEventListener('visibilitychange', renew);
    };
  }, [loadPosterTokens, posterCameraIdsKey]);

  const retryPoster = useCallback((cameraId: string) => {
    setPosterUrls((current) => {
      if (!current[cameraId]) return current;
      const next = { ...current };
      delete next[cameraId];
      return next;
    });
    const now = Date.now();
    if (now - lastPosterRetryAtRef.current < 5_000) return;
    lastPosterRetryAtRef.current = now;
    void loadPosterTokens();
  }, [loadPosterTokens]);
  const isRecordingAutoRecovering = useCallback((camera: Camera | null | undefined) => (
    camera?.recordingStatusDetail === 'auto_reconnecting'
  ), []);
  const isCameraRecording = useCallback((camera: Camera | null | undefined) => {
    if (!camera) return false;
    const override = recordingOverrides[camera.id];
    if (typeof override === 'boolean') return override;
    return camera.status === 'recording';
  }, [recordingOverrides]);
  const isMotionRecordingMode = useCallback((camera: Camera | null | undefined) => camera?.recordingMode === 'motion', []);
  const isMotionRecordingActive = useCallback((camera: Camera | null | undefined) => Boolean(camera && isMotionRecordingMode(camera) && isCameraRecording(camera)), [isCameraRecording, isMotionRecordingMode]);
  const selectedCamLive = useMemo(
    () => (selectedCam ? cameras.find((camera) => camera.id === selectedCam.id) ?? selectedCam : null),
    [cameras, selectedCam],
  );
  useEffect(() => {
    if (!accessToken) return;
    const today = format(new Date(), 'yyyy-MM-dd');
    void axios.get(`${API_URL}/recordings/health-summary?date=${encodeURIComponent(today)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then(({ data }) => {
      const map: Record<string, { total: number; broken: number; tooSmall: number; compatibleRecommended: number; directLikely: number; withAudio: number; lastRecordingAgeSeconds: number | null; needsAttention?: boolean; alertReason?: string | null }> = {};
      for (const item of Array.isArray(data?.cameras) ? data.cameras : []) {
        if (!item?.cameraId) continue;
        map[item.cameraId] = {
          total: Number(item.total ?? 0),
          broken: Number(item.broken ?? 0),
          tooSmall: Number(item.tooSmall ?? 0),
          compatibleRecommended: Number(item.compatibleRecommended ?? 0),
          directLikely: Number(item.directLikely ?? 0),
          withAudio: Number(item.withAudio ?? 0),
          lastRecordingAgeSeconds: typeof item.lastRecordingAgeSeconds === 'number' ? item.lastRecordingAgeSeconds : null,
          needsAttention: Boolean(item.needsAttention),
          alertReason: null,
        };
        map[item.cameraId].needsAttention = false;
      }
      setRecordingHealthByCamera(map);
    }).catch(() => setRecordingHealthByCamera({}));
  }, [API_URL, accessToken]);

  // Carrega unidades (sites) e áreas para o assistente de nova câmera, sob demanda.
  useEffect(() => {
    if (!showWizard || !accessToken || locationOptionsLoaded) return;
    const headers = { Authorization: `Bearer ${accessToken}` };
    void Promise.all([
      axios.get(`${API_URL}/sites`, { headers }).then(({ data }) => (Array.isArray(data) ? data : [])).catch(() => []),
      axios.get(`${API_URL}/areas`, { headers }).then(({ data }) => (Array.isArray(data) ? data : [])).catch(() => []),
    ]).then(([sites, areas]) => {
      setWizardSites(sites.map((s: any) => ({ id: s.id, name: s.name })));
      setWizardAreas(areas.map((a: any) => ({ id: a.id, name: a.name, siteId: a.siteId ?? null })));
      setLocationOptionsLoaded(true);
    });
  }, [API_URL, accessToken, showWizard, locationOptionsLoaded]);

  // Reconcilia o override otimista de gravação com o estado real do servidor: quando
  // camera.status passa a refletir o valor esperado, o override é descartado (senão
  // ele teria precedência permanente e mostraria "Gravando" indefinidamente).
  useEffect(() => {
    setRecordingOverrides((current) => {
      if (!Object.keys(current).length) return current;
      let changed = false;
      const next = { ...current };
      for (const camera of cameras) {
        if (camera.id in next && next[camera.id] === (camera.status === 'recording')) {
          delete next[camera.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [cameras]);

  const filtered = useMemo(() => cameras.filter(c => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.code.toLowerCase().includes(search.toLowerCase()) && !c.ipAddress.toLowerCase().includes(search.toLowerCase())) return false;
    if (groupFilter !== 'all' && c.floor !== groupFilter) return false;
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    return true;
  }), [cameras, search, groupFilter, statusFilter]);

  const confirmDeleteCamera = async () => {
    if (!accessToken || !deleteTarget) return;
    const camera = deleteTarget;
    setDeleteTarget(null);
    try {
      await axios.delete(`${API_URL}/cameras/${camera.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (selectedCam?.id === camera.id) setSelectedCam(null);
      await loadData();
      toast({ title: 'Câmera excluída', description: `${camera.name} (${camera.code})` });
    } catch {
      toast({ title: 'Erro ao excluir câmera', description: 'Não foi possível excluir a câmera.', variant: 'destructive' });
    }
  };

  const createCamera = async (payload: {
    name: string;
    siteId?: string;
    areaId?: string;
    ip: string;
    rtspPort: number;
    onvifPort?: number;
    username: string;
    password: string;
    rtspPath?: string;
    onvifPath?: string;
    onvifProfileToken?: string;
    channel?: number;
    subtype?: number;
    liveChannel?: number;
    liveSubtype?: number;
    recordingChannel?: number;
    recordingSubtype?: number;
    analyticsChannel?: number;
    analyticsSubtype?: number;
    recordingEnabled: boolean;
    recordingMode: 'continuous' | 'motion' | 'schedule' | 'manual';
    retentionDays: number;
    preferredRtspTransport: 'tcp' | 'udp';
    preferredLiveProtocol: PreferredLiveProtocol;
    streamVideoCodec: VideoCodec;
    streamWidth?: number;
    streamHeight?: number;
    streamFps?: number;
    streamBitrateKbps?: number;
    recordingVideoCodec: VideoCodec;
    recordingWidth?: number;
    recordingHeight?: number;
    recordingFps?: number;
    recordingBitrateKbps?: number;
    audioEnabled: boolean;
  }) => {
    if (!accessToken) throw new Error('Sessão inválida. Faça login novamente.');
    await axios.post(`${API_URL}/cameras`, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    await loadData();
  };

  const testConnectionDraft = async (payload: {
    ip: string;
    rtspPort: number;
    onvifPort?: number;
    username?: string;
    password?: string;
    rtspPath?: string;
    onvifPath?: string;
    onvifProfileToken?: string;
    channel?: number;
    subtype?: number;
  }) => {
    if (!accessToken) throw new Error('Sessão inválida. Faça login novamente.');
    const { data } = await axios.post(`${API_URL}/cameras/test-connection-draft`, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data as {
      rtspReachable: boolean;
      rtspReachableAny?: boolean;
      reachableRtspPorts?: number[];
      onvifReachable: boolean;
      ptzDigestOk?: boolean;
      reachableOnvifPorts?: number[];
      rtspAuthOk?: boolean;
      selectedRtspPortAuthOk?: boolean;
      detectedRtspPort?: number | null;
      detectedRtspPath?: string | null;
      suggestedRtspPath?: string;
      detectedOnvifPort?: number | null;
      detectedOnvifPath?: string | null;
      detectedOnvifProfileToken?: string | null;
      rtspProbeError?: string | null;
      status: string;
      detectedStream?: {
        codec?: string | null;
        width?: number | null;
        height?: number | null;
        fps?: number | null;
        bitrateKbps?: number | null;
      } | null;
      compatibility?: {
        state: 'ideal' | 'compatible' | 'attention';
        detectedFamily: string;
        confidence: 'high' | 'medium' | 'low';
        summary: string;
        automaticProfile: { live: string; recording: string; analytics: string };
        hints: Array<{ code: string; severity: 'info' | 'warning' | 'critical'; title: string; message: string; action?: string }>;
      };
    };
  };

  /**
   * CONFIRMAÇÃO VISUAL — pega UM frame da câmera antes de salvar.
   *
   * Metadado (1920x1080 · H.264) não distingue a câmera 7 do estacionamento da
   * câmera 3 da recepção. Com o IP trocado, o erro só aparece quando o cliente
   * pede a gravação de um evento e alguém precisa VOLTAR AO LOCAL.
   */
  const previewFrameDraft = async (payload: {
    ip: string;
    rtspPort: number;
    username?: string;
    password?: string;
    rtspPath?: string;
    channel?: number;
    subtype?: number;
  }): Promise<PreviewFrame> => {
    if (!accessToken) throw new Error('Sessão inválida. Faça login novamente.');
    const { data } = await axios.post(`${API_URL}/cameras/preview-frame`, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return parsePreviewFrame(data);
  };

  const reconnectSingleCamera = async (cameraId: string) => {
    if (!accessToken || reconnectingSingleCameraId) return;
    setReconnectingSingleCameraId(cameraId);
    try {
      const { data } = await axios.post(
        `${API_URL}/recordings/reconnect-stale`,
        { cameraIds: [cameraId] },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      toast({ title: 'Reconexão concluída', description: `Reiniciadas: ${data.restarted ?? 0} | Ignoradas: ${data.skipped ?? 0}` });
      await loadData();
      const today = format(new Date(), 'yyyy-MM-dd');
      const summary = await axios.get(`${API_URL}/recordings/health-summary?date=${encodeURIComponent(today)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const map: Record<string, { total: number; broken: number; tooSmall: number; compatibleRecommended: number; directLikely: number; withAudio: number; lastRecordingAgeSeconds: number | null; needsAttention?: boolean; alertReason?: string | null }> = {};
      for (const item of Array.isArray(summary.data?.cameras) ? summary.data.cameras : []) {
        if (!item?.cameraId) continue;
        map[item.cameraId] = {
          total: Number(item.total ?? 0),
          broken: Number(item.broken ?? 0),
          tooSmall: Number(item.tooSmall ?? 0),
          compatibleRecommended: Number(item.compatibleRecommended ?? 0),
          directLikely: Number(item.directLikely ?? 0),
          withAudio: Number(item.withAudio ?? 0),
          lastRecordingAgeSeconds: typeof item.lastRecordingAgeSeconds === 'number' ? item.lastRecordingAgeSeconds : null,
          needsAttention: false,
          alertReason: null,
        };
      }
      setRecordingHealthByCamera(map);
    } catch (error) {
      toast({ title: 'Falha ao reconectar', description: error instanceof Error ? error.message : 'Falha ao reconectar a câmera.', variant: 'destructive' });
    } finally {
      setReconnectingSingleCameraId(null);
    }
  };

  const diagnosePtzCamera = async (camera: Camera) => {
    if (!accessToken) return;
    if (!camera.ptzCapable) {
      toast({ title: 'PTZ indisponível', description: 'Esta câmera não possui PTZ habilitado.' });
      return;
    }
    if (diagnosingPtzCameraId) return;
    setDiagnosingPtzCameraId(camera.id);
    try {
      const { data } = await axios.get<{
        configured?: { onvifPort?: number | null; onvifPath?: string | null; onvifProfileToken?: string | null };
        detected?: { onvifPort?: number | null; onvifPath?: string | null; onvifProfileToken?: string | null };
        ptzLikelyWorking?: boolean;
      }>(`${API_URL}/ptz/${camera.id}/diagnostics`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      toast(data?.ptzLikelyWorking
        ? { title: 'Controle PTZ pronto', description: camera.name }
        : { title: 'PTZ não confirmado', description: `Não foi possível confirmar o controle PTZ de ${camera.name}.`, variant: 'destructive' });
    } catch (error) {
      toast({ title: 'Falha no diagnóstico PTZ', description: error instanceof Error ? error.message : 'Falha no diagnóstico PTZ.', variant: 'destructive' });
    } finally {
      setDiagnosingPtzCameraId(null);
    }
  };

  const runManualRecording = async (camera: Camera, action: 'start' | 'stop') => {
    if (!accessToken) return;
    setManualRecordingLoading({ cameraId: camera.id, action });
    setRecordingOverrides((current) => ({ ...current, [camera.id]: action === 'start' }));
    try {
      await axios.post(`${API_URL}/cameras/${camera.id}/recording/${action}`, {}, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      await loadData();
      toast({ title: action === 'start' ? 'Gravação iniciada' : 'Gravação parada', description: camera.name });
    } catch (error) {
      setRecordingOverrides((current) => ({ ...current, [camera.id]: camera.status === 'recording' }));
      toast({ title: 'Falha na gravação manual', description: error instanceof Error ? error.message : `Falha ao ${action === 'start' ? 'iniciar' : 'parar'} gravação manual.`, variant: 'destructive' });
    } finally {
      setManualRecordingLoading(null);
    }
  };

  const runMotionRecording = async (camera: Camera) => {
    if (!accessToken || motionRecordingLoadingCameraId) return;
    setMotionRecordingLoadingCameraId(camera.id);
    try {
      if (isMotionRecordingActive(camera)) {
        setRecordingOverrides((current) => ({ ...current, [camera.id]: false }));
        await axios.post(`${API_URL}/cameras/${camera.id}/recording/stop`, {}, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        toast({ title: 'Clipe por movimento parado', description: `${camera.name} — a câmera continua armada para o próximo movimento.` });
      } else if (!isMotionRecordingMode(camera)) {
        setRecordingOverrides((current) => ({ ...current, [camera.id]: false }));
        await axios.post(`${API_URL}/cameras/${camera.id}/recording/motion`, { enabled: true }, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        toast({ title: 'Gravação por movimento ativada', description: `${camera.name} — grava ao detectar movimento e para após 60s sem novo movimento.` });
      } else {
        toast({ title: 'Gravação por movimento já armada', description: `${camera.name} — o botão fica vermelho quando estiver gravando um movimento.` });
      }
      await loadData();
    } catch (error) {
      setRecordingOverrides((current) => ({ ...current, [camera.id]: camera.status === 'recording' }));
      toast({ title: 'Falha na gravação por movimento', description: error instanceof Error ? error.message : 'Falha ao atualizar gravação por movimento.', variant: 'destructive' });
    } finally {
      setMotionRecordingLoadingCameraId(null);
    }
  };

  const onlineCount = cameras.filter((c) => c.isOnline).length;
  const alarmCount = cameras.filter((c) => c.status === 'alarm').length;
  const countFor = (s: (typeof STATUS_PILLS)[number]) => (s === 'all' ? cameras.length : cameras.filter((c) => c.status === s).length);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Page actions toolbar */}
        <div className="px-6 py-3 border-b border-border shrink-0 flex items-center justify-end gap-2">
          <div className="ops-segment flex items-center gap-0.5">
            <button onClick={() => setViewMode('table')} className={`w-7 h-7 flex items-center justify-center rounded-[6px] transition-colors ${viewMode === 'table' ? 'ops-segment-active' : 'text-[hsl(var(--muted-foreground))] hover:text-foreground'}`} title="Tabela"><List className="w-3.5 h-3.5" /></button>
            <button onClick={() => setViewMode('card')} className={`w-7 h-7 flex items-center justify-center rounded-[6px] transition-colors ${viewMode === 'card' ? 'ops-segment-active' : 'text-[hsl(var(--muted-foreground))] hover:text-foreground'}`} title="Cards"><LayoutGrid className="w-3.5 h-3.5" /></button>
          </div>
          <button
            onClick={() => setShowPushDialog(true)}
            className="btn btn-secondary btn-sm"
            data-testid="button-add-push-camera"
            title="Para câmera ou DVR que envia o vídeo para o servidor — funciona atrás de CGNAT, 4G e redes sem porta aberta"
          >
            <Radio className="w-3.5 h-3.5" />
            Câmera que envia (RTMP)
          </button>
          <button
            onClick={() => setShowWizard(true)}
            className="btn btn-primary btn-sm"
            data-testid="button-add-camera"
          >
            <Plus className="w-3.5 h-3.5" />
            Adicionar câmera
          </button>
        </div>

        {/* Filters */}
        <div className="px-6 py-3 border-b border-border shrink-0 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {STATUS_PILLS.map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`ops-pill ${statusFilter === s ? 'ops-pill-active' : ''}`}>
                {STATUS_LABEL[s]}
                <span className="font-mono text-[9px] opacity-60">{countFor(s)}</span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{groups.map(g => <SelectItem key={g} value={g} className="text-xs">{g === 'all' ? 'Todos os grupos' : g}</SelectItem>)}</SelectContent>
            </Select>
            <div className="input-wrap w-56">
              <span className="input-icon"><Search className="w-3.5 h-3.5" /></span>
              <input
                className="input"
                style={{ height: 32, fontSize: 12 }}
                placeholder="Buscar câmera ou IP..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {viewMode === 'table' ? (
            <div className="p-5">
            <div className="ops-card overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b border-border">
                  {['Câmera', 'IP', 'Status', 'Gravação', 'Ações'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-medium text-[hsl(var(--muted-foreground))] whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(cam => {
                  const recordingModeCopy = getRecordingModeCopy(cam.recordingMode);
                  return (
                  <tr
                    key={cam.id}
                    className="hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
                    onClick={() => setEditCamera(cam)}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="relative h-9 w-16 shrink-0 overflow-hidden rounded bg-[hsl(220_18%_8%)]">
                          {posterUrls[cam.id] ? (
                            <img src={posterUrls[cam.id]} onError={() => retryPoster(cam.id)} alt={`Amostra de ${cam.name}`} loading="lazy" className="h-full w-full object-cover" />
                          ) : (
                            <CameraIcon className="absolute inset-0 m-auto h-4 w-4 text-white/25" aria-hidden="true" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium max-w-72 truncate">{cam.name}</div>
                          <div className="mt-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">{cam.code}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-[hsl(var(--muted-foreground))] whitespace-nowrap">{cam.ipAddress}</td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${STATUS_BADGE[cam.status] ?? STATUS_BADGE.offline}`}>
                        {ROTULO_CONEXAO[estadoConexao(cam.status)]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-1">
                        <span className={`inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 text-[10px] ${CLASSE_MODO_GRAVACAO}`}>
                          {recordingModeCopy.label}
                        </span>
                        <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{cam.retentionDays} dias</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setEditCamera(cam)} className="w-6 h-6 flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--chart-2))] hover:bg-[hsl(var(--accent))] transition-colors" title="Editar câmera"><Edit className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setDeleteTarget(cam)} className="w-6 h-6 flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] transition-colors" title="Excluir câmera"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground py-20">
              <Wifi className="w-10 h-10 opacity-20" />
              <p className="text-sm">Nenhuma câmera encontrada</p>
            </div>
          ) : (
            <div className="grid gap-4 p-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
              {filtered.map(cam => {
                const isOffline = ['offline', 'no_signal'].includes(cam.status);
                const isDisabled = cam.enabled === false;
                return (
                <div
                  key={cam.id}
                  className={`ops-card overflow-hidden hover:-translate-y-px transition-transform cursor-pointer ${isDisabled ? 'opacity-70' : ''}`}
                  onClick={() => setEditCamera(cam)}
                >
                  <div className="relative h-36 overflow-hidden bg-[hsl(220_18%_8%)]">
                    {posterUrls[cam.id] && !isOffline && (
                      <img
                        src={posterUrls[cam.id]}
                        onError={() => retryPoster(cam.id)}
                        alt={`Amostra de ${cam.name}`}
                        loading="lazy"
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    )}
                    <div className={`absolute top-0 inset-x-0 h-[2.5px] ${PONTO_CONEXAO[estadoConexao(cam.status)]}`} />
                    <div className="absolute top-2 left-2 z-10">
                      <span className="rounded border border-white/10 bg-black/35 px-1.5 py-px font-mono text-[9px] text-white/65">{cam.code}</span>
                    </div>
                    {cam.status === 'recording' && (
                      <div className="absolute top-2 right-2 z-10">
                        <span className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--status-rec))] rec-pulse inline-block" />
                      </div>
                    )}
                    <div className={`absolute inset-0 flex items-center justify-center ${posterUrls[cam.id] && !isOffline ? 'opacity-0' : ''}`}>
                      <CameraIcon className="h-8 w-8 text-white/25" />
                    </div>
                    {isDisabled ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65">
                        <CameraIcon className="w-5 h-5 text-white/35" />
                        <span className="text-[9px] text-amber-400/90 font-mono uppercase tracking-widest">Desativada</span>
                      </div>
                    ) : isOffline ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55">
                        <CameraIcon className="w-5 h-5 text-white/35" />
                        <span className="text-[9px] text-muted-foreground/60 font-mono uppercase tracking-widest">
                          {cam.status === 'no_signal' ? 'Sem sinal' : 'Offline'}
                        </span>
                      </div>
                    ) : (
                      <div className="absolute inset-0 camera-scanline opacity-45" />
                    )}
                    <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/60 to-transparent" />
                  </div>
                  <div className="p-3.5 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold truncate">{cam.name}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PONTO_CONEXAO[estadoConexao(cam.status)]}`} />
                          <span className="text-[10px] text-muted-foreground">{ROTULO_CONEXAO[estadoConexao(cam.status)]}</span>
                        </div>
                      </div>
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${isDisabled ? 'border-amber-500/40 bg-amber-500/10 text-amber-500' : CLASSE_CONEXAO[estadoConexao(cam.status)]}`}>
                        {isDisabled ? 'Desativada' : ROTULO_CONEXAO[estadoConexao(cam.status)]}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                      <span>{cam.ipAddress}</span>
                    </div>
                    <div className="flex items-center gap-2 pt-0.5" onClick={(e) => e.stopPropagation()}>
                      <Link href={`/playback?cameraId=${cam.id}`} className="flex-1 h-7 rounded-md text-[11px] flex items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors">
                        <PlaySquare className="w-3.5 h-3.5" /> Playback
                      </Link>
                      <button onClick={() => setEditCamera(cam)} className="flex-1 h-7 rounded-md text-[11px] flex items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors">
                        <Edit className="w-3.5 h-3.5" /> Editar
                      </button>
                      <button onClick={() => setDeleteTarget(cam)} title="Excluir" className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Camera detail panel */}
      <AnimatePresence>
        {selectedCam && (() => {
          const liveCam = selectedCamLive ?? selectedCam;
          const recordingModeCopy = getRecordingModeCopy(liveCam.recordingMode);
          const recordingActive = isCameraRecording(liveCam);
          const motionActive = isMotionRecordingActive(liveCam);
          return (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="ml-4 ops-card flex flex-col overflow-hidden shrink-0"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <h3 className="text-sm font-semibold truncate">{liveCam.code}</h3>
              <button onClick={() => setSelectedCam(null)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-[hsl(var(--accent))] transition-colors shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              <div className="relative h-28 overflow-hidden rounded border border-border bg-[hsl(220_18%_8%)] flex items-center justify-center">
                {posterUrls[liveCam.id] ? (
                  <img src={posterUrls[liveCam.id]} onError={() => retryPoster(liveCam.id)} alt={`Amostra de ${liveCam.name}`} className="h-full w-full object-cover" />
                ) : (
                  <CameraIcon className="w-10 h-10 text-white/25" />
                )}
              </div>
              <div>
                <div className="text-sm font-semibold mb-0.5">{liveCam.name}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${STATUS_BADGE[liveCam.status] ?? STATUS_BADGE.offline}`}>
                    {formatCameraStatus(liveCam.status)}
                  </span>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${CLASSE_MODO_GRAVACAO}`}>
                    {recordingModeCopy.label}
                  </span>
                </div>
              </div>
              <div className="space-y-2 text-xs">
                {[
                  ['Código', liveCam.code],
                  ['Unidade', liveCam.building],
                  ['Andar', liveCam.floor],
                  ['Gravação', recordingModeCopy.label],
                  ['Retenção', `${liveCam.retentionDays} dias`],
                  ['PTZ', liveCam.ptzCapable ? 'Sim' : 'Não'],
                  ['Áudio', liveCam.hasAudio ? 'Sim' : 'Não'],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span className="text-[hsl(var(--muted-foreground))]">{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
              <details className="rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium text-[hsl(var(--muted-foreground))]">Informações da câmera</summary>
                <div className="mt-2 space-y-2 border-t border-border pt-2">
                  {[
                    ['Endereço IP', liveCam.ipAddress],
                    ['Modelo', liveCam.model],
                    ['Resolução', liveCam.resolution],
                    ['FPS', liveCam.fps.toString()],
                    ['Codec', liveCam.streamVideoCodec ?? liveCam.detectedVideoCodec ?? '-'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-[hsl(var(--muted-foreground))]">{k}</span>
                      <span className="font-mono">{v}</span>
                    </div>
                  ))}
                </div>
              </details>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => void reconnectSingleCamera(selectedCam.id)}
                    className="w-full h-9 rounded border border-border text-xs flex items-center justify-center gap-2 hover:bg-[hsl(var(--accent))] transition-colors text-[hsl(var(--destructive))] disabled:opacity-45"
                    disabled={reconnectingSingleCameraId === selectedCam.id || !recordingHealthByCamera[selectedCam.id]?.needsAttention || isRecordingAutoRecovering(selectedCam)}
                    title="Reconectar gravação"
                  >
                    <RefreshCw className={`w-4 h-4 ${reconnectingSingleCameraId === selectedCam.id ? 'animate-spin' : ''}`} />
                    {reconnectingSingleCameraId === selectedCam.id ? '...' : 'Reconectar'}
                  </button>
                  <button
                    onClick={() => void runManualRecording(liveCam, recordingActive ? 'stop' : 'start')}
                    className={`w-full h-9 rounded border text-xs flex items-center justify-center hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-45 ${
                      recordingActive
                        ? 'border-[hsl(var(--destructive)_/_0.55)] text-[hsl(var(--destructive))]'
                        : 'border-[hsl(var(--status-online)_/_0.55)] text-[hsl(var(--status-online))]'
                    }`}
                    disabled={manualRecordingLoading?.cameraId === selectedCam.id}
                    title={recordingActive ? 'Parar gravação manual' : 'Iniciar gravação manual'}
                  >
                    {manualRecordingLoading?.cameraId === selectedCam.id ? (
                      <span className="text-[10px]">...</span>
                    ) : (
                      <Circle className={`w-4 h-4 ${recordingActive ? 'fill-current' : ''}`} />
                    )}
                  </button>
                  <button
                    onClick={() => void runMotionRecording(liveCam)}
                    className={`w-full h-9 rounded border text-xs flex items-center justify-center gap-1.5 transition-colors disabled:opacity-45 ${
                      motionActive
                        ? 'border-[hsl(var(--destructive)_/_0.55)] bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.15)]'
                        : 'border-[hsl(var(--status-online)_/_0.55)] bg-[hsl(var(--status-online)_/_0.1)] text-[hsl(var(--status-online))] hover:bg-[hsl(var(--status-online)_/_0.15)]'
                    }`}
                    disabled={motionRecordingLoadingCameraId === selectedCam.id}
                    title={motionActive ? 'Parar clipe atual por movimento' : 'Armar gravação por movimento'}
                  >
                    <Radar className={`w-4 h-4 ${motionRecordingLoadingCameraId === selectedCam.id ? 'animate-pulse' : ''}`} />
                    Movimento
                  </button>
                </div>
                <div className="rounded-lg border border-border bg-background/60 px-3 py-2 text-[10px] text-[hsl(var(--muted-foreground))]">
                  <span className="font-semibold text-foreground">Regra atual:</span> {recordingModeCopy.detail}
                  {recordingActive ? ' Está gravando agora.' : ' Não está gravando agora.'}
                </div>
                <Link href={`/cameras/${selectedCam.id}?tab=settings`} className="w-full h-9 rounded border border-border text-xs flex items-center justify-center gap-2 hover:bg-[hsl(var(--accent))] transition-colors">
                  <Edit className="w-4 h-4" /> Editar Câmera
                </Link>
                <button onClick={() => setDeleteTarget(selectedCam)} className="w-full h-9 rounded border border-border text-xs flex items-center justify-center gap-2 hover:bg-[hsl(var(--accent))] transition-colors text-[hsl(var(--destructive))]">
                  <Trash2 className="w-4 h-4" /> Excluir Câmera
                </button>
                <Link href="/playback" className="w-full h-9 rounded border border-border text-xs flex items-center justify-center gap-2 hover:bg-[hsl(var(--accent))] transition-colors">
                  <PlaySquare className="w-4 h-4" /> Abrir Reprodução
                </Link>
                {selectedCam.ptzCapable && (
                  <Link href={`/ptz?cameraId=${encodeURIComponent(selectedCam.id)}`} className="w-full h-9 rounded border border-border text-xs flex items-center justify-center gap-2 hover:bg-[hsl(var(--accent))] transition-colors">
                    <Crosshair className="w-4 h-4" /> Controle PTZ
                  </Link>
                )}
                {selectedCam.ptzCapable && (
                  <button
                    onClick={() => void diagnosePtzCamera(selectedCam)}
                    className="w-full h-9 rounded border border-border text-xs flex items-center justify-center gap-2 hover:bg-[hsl(var(--accent))] transition-colors"
                    disabled={diagnosingPtzCameraId === selectedCam.id}
                  >
                    <Wifi className={`w-4 h-4 ${diagnosingPtzCameraId === selectedCam.id ? 'animate-pulse' : ''}`} />
                    {diagnosingPtzCameraId === selectedCam.id ? 'Diagnosticando PTZ...' : 'Diagnosticar PTZ'}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
          );
        })()}
      </AnimatePresence>

      <CameraEditSheet
        camera={editCamera}
        open={!!editCamera}
        onClose={() => setEditCamera(null)}
        onDeleted={(id) => { if (selectedCam?.id === id) setSelectedCam(null); }}
      />

      <AddPushCameraDialog
        open={showPushDialog}
        onClose={() => setShowPushDialog(false)}
        onCreated={loadData}
      />
      {showWizard && <WizardModal onClose={() => setShowWizard(false)} sites={wizardSites} areas={wizardAreas} onCreated={createCamera} onTestConnection={testConnectionDraft} onPreviewFrame={previewFrameDraft} />}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir câmera</AlertDialogTitle>
            <AlertDialogDescription>
              Excluir a câmera "{deleteTarget?.name}" ({deleteTarget?.code})? Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteCamera()}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
