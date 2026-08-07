import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Crosshair,
  LoaderCircle,
  Radar,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  ExternalLink,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { toast } from '../hooks/use-toast';
import { LiveStreamPlayer } from '../components/LiveStreamPlayer';
import { getApiBaseUrl } from '../lib/api-base';
import { sendPtzCommand, type PTZDirection } from '../lib/ptz';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';

type CommandState = 'idle' | 'sending' | 'ok' | 'error';
const API_URL = getApiBaseUrl();
const DIRECTION_LABEL: Record<PTZDirection, string> = {
  Up: 'cima',
  Down: 'baixo',
  Left: 'esquerda',
  Right: 'direita',
  ZoomIn: 'aproximar',
  ZoomOut: 'afastar',
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
    onvifPort: number | null;
    onvifPath: string | null;
    onvifProfileToken: string | null;
  };
  ptzLikelyWorking: boolean;
};

function ControlButton({
  label,
  icon,
  active,
  disabled,
  onStart,
  onStop,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={label}
      aria-label={label}
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
      className={[
        'flex h-12 w-12 items-center justify-center rounded-xl border transition-all select-none',
        active
          ? 'border-[hsl(var(--primary)_/_0.55)] bg-[hsl(var(--primary)_/_0.14)] text-[hsl(var(--primary))] shadow-[0_0_0_1px_hsl(var(--primary)_/_0.18)]'
          : 'border-border bg-card/70 text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--primary)_/_0.35)] hover:bg-[hsl(var(--primary)_/_0.06)] hover:text-foreground',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
      ].join(' ')}
    >
      {icon}
    </button>
  );
}

export default function PTZPage() {
  const [location, setLocation] = useLocation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const userRole = useAuthStore((state) => state.user?.role ?? 'viewer');
  const cameras = useVmsDataStore((state) => state.cameras);
  const ptzCameras = useMemo(
    () => cameras
      .filter((camera) => camera.enabled && camera.ptzCapable)
      .sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || a.name.localeCompare(b.name, 'pt-BR')),
    [cameras],
  );
  const [selectedCamId, setSelectedCamId] = useState('');
  const [speed, setSpeed] = useState(5);
  const [activeDirection, setActiveDirection] = useState<PTZDirection | null>(null);
  const [commandState, setCommandState] = useState<CommandState>('idle');
  const [lastCommand, setLastCommand] = useState<string>('Nenhum comando enviado');
  const [lastError, setLastError] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PtzDiagnostics | null>(null);
  const activeMovementRef = useRef<{ cameraId: string; cameraName: string; direction: PTZDirection; startPromise?: ReturnType<typeof sendPtzCommand> } | null>(null);

  const requestedCameraId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('cameraId');
  }, [location]);

  useEffect(() => {
    if (!ptzCameras.length) {
      setSelectedCamId('');
      return;
    }

    if (requestedCameraId && ptzCameras.some((camera) => camera.id === requestedCameraId)) {
      setSelectedCamId((current) => (current === requestedCameraId ? current : requestedCameraId));
      return;
    }

    if (!selectedCamId || !ptzCameras.some((camera) => camera.id === selectedCamId)) {
      setSelectedCamId(ptzCameras[0].id);
    }
  }, [ptzCameras, requestedCameraId, selectedCamId]);

  const selectedCam = ptzCameras.find((camera) => camera.id === selectedCamId) ?? null;
  const controlsDisabled = !selectedCam || !selectedCam.isOnline;
  const requestedCameraUnavailable = Boolean(
    requestedCameraId && !ptzCameras.some((camera) => camera.id === requestedCameraId),
  );
  const ptzRejectedByDevice = Boolean(lastError && lastError.includes('Nenhum endpoint PTZ aceitou o comando'));

  const startMove = useCallback(
    async (direction: PTZDirection) => {
      if (!selectedCam || controlsDisabled || activeMovementRef.current) return;
      const movement = { cameraId: selectedCam.id, cameraName: selectedCam.name, direction } as { cameraId: string; cameraName: string; direction: PTZDirection; startPromise?: ReturnType<typeof sendPtzCommand> };
      activeMovementRef.current = movement;
      setActiveDirection(direction);
      setCommandState('sending');
      setLastError(null);
      setLastCommand(`Enviando comando para ${DIRECTION_LABEL[direction]} em ${selectedCam.name}`);

      try {
        movement.startPromise = sendPtzCommand(selectedCam.id, { action: 'start', direction, speed });
        await movement.startPromise;
        if (activeMovementRef.current === movement) {
          setCommandState('ok');
          setLastCommand(`Movimento para ${DIRECTION_LABEL[direction]} ativo em ${selectedCam.name}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Falha ao iniciar comando PTZ.';
        if (activeMovementRef.current === movement) {
          activeMovementRef.current = null;
          setActiveDirection(null);
        }
        setCommandState('error');
        setLastError(message);
        setLastCommand(`Falha ao mover para ${DIRECTION_LABEL[direction]} em ${selectedCam.name}`);
        toast({
          title: 'Falha no PTZ',
          description: message,
          variant: 'destructive',
        });
      }
    },
    [controlsDisabled, selectedCam, speed],
  );

  const stopMove = useCallback(async () => {
    const movement = activeMovementRef.current;
    if (!movement) return;
    activeMovementRef.current = null;
    const currentDirection = movement.direction;
    setActiveDirection(null);
    setCommandState('sending');

    try {
      await movement.startPromise?.catch(() => undefined);
      await sendPtzCommand(movement.cameraId, { action: 'stop', direction: currentDirection });
      setCommandState('ok');
      setLastError(null);
      setLastCommand(`Movimento para ${DIRECTION_LABEL[currentDirection]} finalizado em ${movement.cameraName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao parar movimento PTZ.';
      setCommandState('error');
      setLastError(message);
      setLastCommand(`Falha ao parar movimento para ${DIRECTION_LABEL[currentDirection]} em ${movement.cameraName}`);
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

  useEffect(() => stopMoveSilently, [selectedCamId, stopMoveSilently]);

  const runDiagnostics = useCallback(async () => {
    if (!selectedCam || !accessToken) return;
    setDiagnosing(true);
    try {
      const response = await fetch(`${API_URL}/ptz/${selectedCam.id}/diagnostics`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as PtzDiagnostics;
      setDiagnostics(data);
      toast({
        title: data.ptzLikelyWorking ? 'Controle PTZ pronto' : 'Controle PTZ indisponivel',
        description: data.ptzLikelyWorking
          ? 'A camera aceitou o controle externo.'
          : 'Nao foi possivel confirmar o controle externo desta camera.',
        variant: data.ptzLikelyWorking ? undefined : 'destructive',
      });
    } catch (error) {
      toast({
        title: 'Falha no diagnóstico PTZ',
        description: error instanceof Error ? error.message : 'Erro inesperado.',
        variant: 'destructive',
      });
    } finally {
      setDiagnosing(false);
    }
  }, [accessToken, selectedCam]);

  if (!ptzCameras.length) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card/85 text-center shadow-lg">
          <div className="border-b border-border bg-[radial-gradient(circle_at_top,hsl(var(--primary)_/_0.16),transparent_68%)] px-8 py-9">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[hsl(var(--primary)_/_0.28)] bg-[hsl(var(--primary)_/_0.10)] shadow-[0_12px_32px_hsl(var(--primary)_/_0.12)]">
              <Crosshair className="h-7 w-7 text-[hsl(var(--primary))]" />
            </div>
            <h2 className="text-lg font-semibold">Nenhuma câmera compatível com PTZ</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              O controle aparece somente para câmeras ativas configuradas com perfil ONVIF de movimentação.
            </p>
          </div>
          <div className="grid gap-3 px-8 py-6 text-left sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-background/55 p-4">
              <div className="text-xs font-semibold">Já possui uma câmera PTZ?</div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Confirme ONVIF, perfil e credenciais no cadastro da câmera.</p>
            </div>
            <div className="rounded-xl border border-border bg-background/55 p-4">
              <div className="text-xs font-semibold">Câmeras fixas continuam normais</div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Ao Vivo e gravação não dependem do suporte a PTZ.</p>
            </div>
          </div>
          <div className="flex justify-center gap-2 border-t border-border px-8 py-4">
            <button type="button" onClick={() => setLocation('/live')} className="btn btn-secondary btn-sm">Voltar ao Ao Vivo</button>
            {userRole !== 'viewer' && (
              <button type="button" onClick={() => setLocation('/cameras')} className="btn btn-primary btn-sm">Ver câmeras</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
      <div className="flex h-full min-h-0 flex-col">
      <div className="toolbar flex-wrap">
        <div className="w-[min(100%,340px)]">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Câmera compatível</div>
          <Select value={selectedCamId} onValueChange={setSelectedCamId}>
            <SelectTrigger className="h-10 w-full text-xs">
              <SelectValue placeholder="Selecione uma câmera PTZ" />
            </SelectTrigger>
            <SelectContent>
              {ptzCameras.map((camera) => (
                <SelectItem key={camera.id} value={camera.id} className="text-xs">
                  {camera.name} · {camera.isOnline ? 'online' : 'offline'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-full max-w-52 rounded-xl border border-border bg-background/65 px-3 py-2 sm:w-52">
          <div className="mb-2 flex items-center justify-between text-[10px] font-mono uppercase tracking-[0.18em] text-[hsl(var(--muted-foreground))]">
            <span>Velocidade</span>
            <span>{speed}</span>
          </div>
          <Slider value={[speed]} onValueChange={([value]) => setSpeed(value)} min={1} max={10} step={1} />
        </div>

        <button
          type="button"
          onClick={() => selectedCam && setLocation(`/cameras/${selectedCam.id}?tab=ptz`)}
          disabled={!selectedCam}
          className="btn btn-secondary btn-sm"
        >
          Abrir painel da câmera
          <ExternalLink className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={() => void runDiagnostics()}
          disabled={!selectedCam || diagnosing}
          className="btn btn-secondary btn-sm"
        >
          {diagnosing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
          Verificar
        </button>
      </div>

      {requestedCameraUnavailable && (
        <div className="mx-4 mt-4 rounded-lg border border-[hsl(var(--status-warning)_/_0.35)] bg-[hsl(var(--status-warning)_/_0.10)] px-4 py-3 text-xs text-[hsl(var(--status-warning))] md:mx-5">
          A câmera aberta anteriormente não está configurada para PTZ. Selecionamos uma câmera compatível disponível.
        </div>
      )}

      <div className="grid flex-1 min-h-0 gap-4 p-4 md:p-5 xl:grid-cols-[minmax(0,1.35fr)_420px]">
        <div className="flex min-h-0 flex-col gap-4">
          <div className="relative min-h-[320px] flex-1 overflow-hidden rounded-lg border border-border bg-[linear-gradient(160deg,hsl(222_22%_9%),hsl(220_18%_7%))] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            {selectedCam?.isOnline ? (
              <LiveStreamPlayer
                cameraId={selectedCam.id}
                cameraName={selectedCam.name}
                className="absolute inset-0 h-full w-full"
                muted
                showOverlay
                aiEnabled={selectedCam.aiEnabled}
                liveViewMode="selected"
              />
            ) : null}

            <div className="pointer-events-none absolute inset-0 camera-scanline opacity-60" />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative h-24 w-24 opacity-35">
                <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[hsl(var(--primary))]" />
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[hsl(var(--primary))]" />
                <div className="absolute inset-5 rounded-xl border border-[hsl(var(--primary)_/_0.7)]" />
              </div>
            </div>

            {!selectedCam?.isOnline && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                <div className="rounded-lg border border-border bg-black/45 px-5 py-4 text-center">
                  <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-[hsl(var(--muted-foreground))]" />
                  <div className="text-sm font-medium">Stream indisponível</div>
                  <div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                    A câmera selecionada está offline ou sem sinal.
                  </div>
                </div>
              </div>
            )}

            <div className="absolute left-3 top-3 flex items-center gap-2">
              <span className="rounded-md border border-white/10 bg-black/45 px-2 py-1 text-[10px] text-white/70">
                {selectedCam?.code ?? 'SEM CAMERA'}
              </span>
              <span className="rounded-md border border-white/10 bg-black/45 px-2 py-1 text-[10px] text-white/70">
                {selectedCam?.isOnline ? 'Ao vivo' : 'Offline'}
              </span>
              {activeDirection && (
                <span className="rounded-md border border-[hsl(var(--primary)_/_0.4)] bg-[hsl(var(--primary)_/_0.14)] px-2 py-1 font-mono text-[10px] text-[hsl(var(--primary-foreground))]">
                  {activeDirection}
                </span>
              )}
            </div>

            <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3">
              <div className="rounded-xl border border-white/10 bg-black/45 px-3 py-2 text-xs text-white/78 backdrop-blur-sm">
                <div className="font-semibold">{selectedCam?.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-white/55">
                  <span>{selectedCam?.ipAddress}</span>
                  <span>•</span>
                  <span>{selectedCam?.model}</span>
                  <span>•</span>
                  <span>{selectedCam?.hasAudio ? 'Áudio' : 'Sem áudio'}</span>
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-black/45 px-3 py-2 text-right font-mono text-[10px] text-white/72 backdrop-blur-sm">
                <div>{selectedCam?.zone}</div>
                <div className="mt-1 text-white/45">Velocidade {speed}/10</div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card/70 p-4 shadow-sm">
            <div className="mb-1 text-[11px] text-[hsl(var(--muted-foreground))]">Status</div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              {commandState === 'sending' ? <LoaderCircle className="h-4 w-4 animate-spin text-[hsl(var(--primary))]" /> : <Radar className="h-4 w-4 text-[hsl(var(--primary))]" />}
              {commandState === 'error' ? 'Erro operacional' : commandState === 'sending' ? 'Enviando comando' : 'Pronto'}
            </div>
            <div className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
              {commandState === 'idle' ? 'Aguardando comando.' : lastCommand}
            </div>
            {ptzRejectedByDevice && (
              <div className="mt-3 rounded-xl border border-[hsl(var(--status-warning)_/_0.3)] bg-[hsl(var(--status-warning)_/_0.1)] px-3 py-2 text-xs text-[hsl(var(--status-warning))]">
                O equipamento respondeu ao endpoint, mas rejeitou o PTZ externo. O stream segue online; o bloqueio está no protocolo de controle desta câmera.
              </div>
            )}
            {lastError && !ptzRejectedByDevice && (
              <div className="mt-3 rounded-xl border border-[hsl(var(--destructive)_/_0.28)] bg-[hsl(var(--destructive)_/_0.08)] px-3 py-2 text-xs text-[hsl(var(--destructive))]">
                {lastError}
              </div>
            )}
            {diagnostics && (
              <details className="mt-3 rounded-xl border border-border bg-background/55 px-3 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                <summary className="cursor-pointer font-semibold text-foreground">Detalhes de suporte</summary>
                <div className="mt-2">
                  <div>Config: porta {diagnostics.configured.onvifPort ?? '-'} · path {diagnostics.configured.onvifPath ?? '-'} · token {diagnostics.configured.onvifProfileToken ?? '-'}</div>
                  <div className="mt-1">Detectado: porta {diagnostics.detected.onvifPort ?? '-'} · path {diagnostics.detected.onvifPath ?? '-'} · token {diagnostics.detected.onvifProfileToken ?? '-'}</div>
                  <div className="mt-1">Resultado: {diagnostics.ptzLikelyWorking ? 'provável funcional' : 'falha de comunicação PTZ'}</div>
                </div>
              </details>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          <div className="rounded-lg border border-border bg-card/75 p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Direção</div>
              </div>
              <button
                type="button"
                onClick={() => void stopMove()}
                disabled={!activeDirection}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Parar
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!selectedCam || controlsDisabled) return;
                  setCommandState('sending');
                  setLastError(null);
                  try {
                    await sendPtzCommand(selectedCam.id, { action: 'home' });
                    setCommandState('ok');
                    setLastCommand(`Posição inicial executada em ${selectedCam.name}`);
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Falha ao enviar a posição inicial.';
                    setCommandState('error');
                    setLastError(message);
                    setLastCommand(`Falha na posição inicial em ${selectedCam.name}`);
                  }
                }}
                disabled={controlsDisabled}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Camera className="h-3.5 w-3.5" />
                Posição inicial
              </button>
            </div>

            <div className="mx-auto grid w-fit grid-cols-3 gap-2">
              <div />
              <ControlButton
                label="Mover para cima"
                icon={<ArrowUp className="h-4 w-4" />}
                active={activeDirection === 'Up'}
                disabled={controlsDisabled}
                onStart={() => void startMove('Up')}
                onStop={() => void stopMove()}
              />
              <div />
              <ControlButton
                label="Mover para a esquerda"
                icon={<ArrowLeft className="h-4 w-4" />}
                active={activeDirection === 'Left'}
                disabled={controlsDisabled}
                onStart={() => void startMove('Left')}
                onStop={() => void stopMove()}
              />
              <button
                type="button"
                onClick={() => void stopMove()}
                disabled={!activeDirection}
                className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-45"
                title="Parar movimento"
              >
                <Crosshair className="h-4 w-4" />
              </button>
              <ControlButton
                label="Mover para a direita"
                icon={<ArrowRight className="h-4 w-4" />}
                active={activeDirection === 'Right'}
                disabled={controlsDisabled}
                onStart={() => void startMove('Right')}
                onStop={() => void stopMove()}
              />
              <div />
              <ControlButton
                label="Mover para baixo"
                icon={<ArrowDown className="h-4 w-4" />}
                active={activeDirection === 'Down'}
                disabled={controlsDisabled}
                onStart={() => void startMove('Down')}
                onStop={() => void stopMove()}
              />
              <div />
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2">
              <ControlButton
                label="Aproximar zoom"
                icon={<ZoomIn className="h-4 w-4" />}
                active={activeDirection === 'ZoomIn'}
                disabled={controlsDisabled}
                onStart={() => void startMove('ZoomIn')}
                onStop={() => void stopMove()}
              />
              <ControlButton
                label="Afastar zoom"
                icon={<ZoomOut className="h-4 w-4" />}
                active={activeDirection === 'ZoomOut'}
                disabled={controlsDisabled}
                onStart={() => void startMove('ZoomOut')}
                onStop={() => void stopMove()}
              />
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
