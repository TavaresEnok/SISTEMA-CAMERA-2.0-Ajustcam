import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import {
  Cpu, MemoryStick, HardDrive, Activity, Gauge, RefreshCw,
  Server, Video, Brain, Wifi, ArrowUp, ArrowDown, Minus, CheckCircle2, AlertTriangle,
  HeartPulse,
} from 'lucide-react';
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
import { getApiBaseUrl } from '@/lib/api-base';
import {
  buildCameraHealthRows,
  cameraHealthStateLabel,
  parseCameraHealthPayload,
  parseStaleThreshold,
  recordingDesiredLabel,
  summarizeCameraHealth,
  type CameraHealthEntry,
  type CameraHealthState,
} from '@/lib/camera-health';
import { useAuthStore } from '@/store/authStore';
import { useVmsDataStore } from '@/store/vmsDataStore';
import { toast } from '../hooks/use-toast';

const API_URL = getApiBaseUrl();
const HISTORY = 40; // samples in sparkline

type Sample = { cpu: number; ram: number; disk: number };

type OptimizationReport = {
  optimizationPlan?: { safeActionCount?: number; manualActionCount?: number; canApplySafely?: boolean };
  recommendations?: Array<{ code: string; severity: 'info' | 'warning' | 'critical'; message: string; action: string; cameras: string[] }>;
};

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <div className="h-10" />;
  const w = 100, h = 40;
  const max = 100;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (Math.min(v, max) / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${h} ${pts.join(' ')} ${w},${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-10 w-full">
      <polygon points={area} fill={color} fillOpacity="0.12" />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Trend({ now, prev }: { now: number; prev: number }) {
  const d = now - prev;
  if (Math.abs(d) < 1) return <span className="inline-flex items-center text-muted-foreground"><Minus className="h-3 w-3" /></span>;
  if (d > 0) return <span className="inline-flex items-center gap-0.5 text-[hsl(var(--status-warning))]"><ArrowUp className="h-3 w-3" />{Math.abs(d)}%</span>;
  return <span className="inline-flex items-center gap-0.5 text-[hsl(var(--status-online))]"><ArrowDown className="h-3 w-3" />{Math.abs(d)}%</span>;
}

function toneFor(pct: number) {
  if (pct >= 85) return 'hsl(var(--status-alarm))';
  if (pct >= 65) return 'hsl(var(--status-warning))';
  return 'hsl(var(--primary))';
}

function severityTone(s: 'info' | 'warning' | 'critical') {
  if (s === 'critical') return 'border-[hsl(var(--destructive)_/_0.35)] bg-[hsl(var(--destructive)_/_0.08)] text-[hsl(var(--destructive))]';
  if (s === 'warning') return 'border-[hsl(var(--status-warning)_/_0.35)] bg-[hsl(var(--status-warning)_/_0.10)] text-[hsl(var(--status-warning))]';
  return 'border-border bg-[hsl(var(--muted)_/_0.4)] text-muted-foreground';
}

/** Cor da pílula de estado da tabela de saúde por câmera (mesma paleta de severityTone). */
function healthStateTone(state: CameraHealthState) {
  if (state === 'critico') return 'border-[hsl(var(--destructive)_/_0.35)] bg-[hsl(var(--destructive)_/_0.08)] text-[hsl(var(--destructive))]';
  if (state === 'atencao') return 'border-[hsl(var(--status-warning)_/_0.35)] bg-[hsl(var(--status-warning)_/_0.10)] text-[hsl(var(--status-warning))]';
  return 'border-[hsl(var(--status-online)_/_0.30)] bg-[hsl(var(--status-online)_/_0.08)] text-[hsl(var(--status-online))]';
}

function fmtUptime(seconds?: number) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function PerformancePage() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const cameras = useVmsDataStore((s) => s.cameras);
  const system = useVmsDataStore((s) => s.system);
  const load = useVmsDataStore((s) => s.load);
  const isAdmin = user?.role === 'admin';

  const [history, setHistory] = useState<Sample[]>([]);
  const [aiHealth, setAiHealth] = useState<any>(null);
  const [report, setReport] = useState<OptimizationReport | null>(null);
  // Saúde por câmera (GET /observability/cameras). null = indisponível → a seção
  // simplesmente não aparece e o resto da página continua idêntico ao de hoje.
  const [cameraHealth, setCameraHealth] = useState<CameraHealthEntry[] | null>(null);
  // Limiar de estagnação informado pelo servidor (varia com a duração do segmento).
  const [staleThreshold, setStaleThreshold] = useState<number | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [auto, setAuto] = useState(true);
  const [applying, setApplying] = useState(false);
  const [confirmApplyOpen, setConfirmApplyOpen] = useState(false);
  const refreshRef = useRef(false);

  const cpu = system ? Math.min(100, Math.round(((system.server.loadAverage[0] ?? 0) / Math.max(system.server.cpuCount, 1)) * 100)) : 0;
  const ram = system ? Math.min(100, Math.round(((system.server.totalMemoryBytes - system.server.freeMemoryBytes) / Math.max(system.server.totalMemoryBytes, 1)) * 100)) : 0;
  const disk = system?.disk.usagePercent ?? 0;
  const onlineCams = cameras.filter((c) => c.isOnline).length;
  const aiCams = cameras.filter((c) => c.aiEnabled).length;
  const processors: Record<string, any> = aiHealth?.processors ?? {};
  const runningProc = Object.values(processors).filter((p: any) => p?.running).length;

  const refresh = async () => {
    if (refreshRef.current) return;
    refreshRef.current = true;
    setRefreshing(true);
    try {
      await load();
      if (accessToken) {
        const headers = { Authorization: `Bearer ${accessToken}` };
        const [healthRes, diagRes, obsRes] = await Promise.all([
          axios.get(`${API_URL}/ai/health`, { headers }).catch(() => null),
          axios.get(`${API_URL}/camera-stream/resource-diagnostics`, { headers }).catch(() => null),
          // 404/500/timeout aqui NÃO pode afetar nada acima: cai em null e a seção some.
          axios.get(`${API_URL}/observability/cameras`, { headers }).catch(() => null),
        ]);
        if (healthRes) setAiHealth(healthRes.data);
        if (diagRes) setReport(diagRes.data);
        setCameraHealth(obsRes ? parseCameraHealthPayload(obsRes.data) : null);
        setStaleThreshold(obsRes ? parseStaleThreshold(obsRes.data) : undefined);
        setStaleThreshold(obsRes ? parseStaleThreshold(obsRes.data) : undefined);
      }
    } finally {
      refreshRef.current = false;
      setRefreshing(false);
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    if (!system) return;
    setHistory((prev) => [...prev, { cpu, ram, disk }].slice(-HISTORY));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system]);

  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, accessToken]);

  const applySafeOptimizations = async () => {
    if (!accessToken || !isAdmin || !report?.optimizationPlan?.canApplySafely) return;
    setConfirmApplyOpen(false);
    setApplying(true);
    try {
      await axios.post(`${API_URL}/camera-stream/optimization/apply-safe`, {}, { headers: { Authorization: `Bearer ${accessToken}` } });
      toast({ title: 'Ajustes seguros aplicados', description: 'O diagnóstico foi atualizado com a nova configuração.' });
      await refresh();
    } catch (err) {
      const message = axios.isAxiosError(err) ? (err.response?.data?.message ?? err.message) : 'Falha ao aplicar otimização segura.';
      toast({ title: 'Falha ao otimizar', description: Array.isArray(message) ? message.join(' | ') : String(message), variant: 'destructive' });
    } finally {
      setApplying(false);
    }
  };

  const cpuHist = history.map((h) => h.cpu);
  const ramHist = history.map((h) => h.ram);
  const diskHist = history.map((h) => h.disk);
  const prev = history.length > 1 ? history[history.length - 2] : { cpu, ram, disk };

  const load1 = system?.server.loadAverage[0] ?? 0;
  const load5 = system?.server.loadAverage[1] ?? 0;
  const load15 = system?.server.loadAverage[2] ?? 0;
  const totalRamGB = system ? (system.server.totalMemoryBytes / 1024 / 1024 / 1024).toFixed(1) : '0';
  const usedRamGB = system ? ((system.server.totalMemoryBytes - system.server.freeMemoryBytes) / 1024 / 1024 / 1024).toFixed(1) : '0';

  const METRICS = [
    { key: 'cpu', label: 'CPU', value: cpu, sub: `${load1.toFixed(2)} carga · ${system?.server.cpuCount ?? '—'} núcleos`, hist: cpuHist, icon: Cpu },
    { key: 'ram', label: 'Memória', value: ram, sub: `${usedRamGB} / ${totalRamGB} GB`, hist: ramHist, icon: MemoryStick },
    { key: 'disk', label: 'Disco', value: disk, sub: system ? `${(system.disk.usedBytes / 1024 ** 4).toFixed(1)} / ${(system.disk.totalBytes / 1024 ** 4).toFixed(1)} TB` : '—', hist: diskHist, icon: HardDrive },
  ];

  const canApplySafely = isAdmin && Boolean(report?.optimizationPlan?.canApplySafely);
  const recommendations = report?.recommendations ?? [];

  const healthRows = cameraHealth ? buildCameraHealthRows(cameraHealth, staleThreshold) : [];
  const healthSummary = summarizeCameraHealth(healthRows);

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Desempenho</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Carga do servidor, saúde de streams e processadores de IA em tempo real.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canApplySafely && (
            <button
              onClick={() => setConfirmApplyOpen(true)}
              disabled={applying}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--primary)_/_0.35)] bg-[hsl(var(--primary)_/_0.08)] px-3 py-2 text-xs font-medium text-[hsl(var(--primary))] transition hover:bg-[hsl(var(--primary)_/_0.14)] disabled:opacity-50"
            >
              <CheckCircle2 className={`h-3.5 w-3.5 ${applying ? 'animate-pulse' : ''}`} /> Ajustar seguro
              {report?.optimizationPlan?.safeActionCount ? ` (${report.optimizationPlan.safeActionCount})` : ''}
            </button>
          )}
          <button
            onClick={() => setAuto((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${auto ? 'border-[hsl(var(--primary)_/_0.35)] bg-[hsl(var(--primary)_/_0.08)] text-[hsl(var(--primary))]' : 'border-border bg-card text-muted-foreground hover:bg-accent'}`}
          >
            <Activity className="h-3.5 w-3.5" /> {auto ? 'Ao vivo' : 'Pausado'}
          </button>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium transition hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Atualizar
          </button>
        </div>
      </div>

      {/* ── Primary metrics ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {METRICS.map((m) => {
          const Icon = m.icon;
          const tone = toneFor(m.value);
          return (
            <div key={m.key} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-background border border-border">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  </span>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{m.label}</div>
                    <div className="text-[10px] text-muted-foreground">{m.sub}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-semibold tabular-nums leading-none" style={{ color: tone }}>{m.value}<span className="text-base">%</span></div>
                  <div className="mt-1 text-[10px]"><Trend now={m.value} prev={(prev as any)[m.key]} /></div>
                </div>
              </div>
              <div className="mt-3"><Sparkline data={m.hist} color={tone} /></div>
            </div>
          );
        })}
      </div>

      {/* ── Secondary KPIs ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Streams ativos', value: `${onlineCams}/${cameras.length}`, icon: Video, hint: 'câmeras online' },
          { label: 'Processadores IA', value: `${runningProc}/${aiCams || 0}`, icon: Brain, hint: 'rodando / habilitados' },
          { label: 'Load average', value: `${load1.toFixed(1)} ${load5.toFixed(1)} ${load15.toFixed(1)}`, icon: Gauge, hint: '1m · 5m · 15m', mono: true },
          { label: 'Uptime', value: fmtUptime(system?.server.uptimeSeconds), icon: Server, hint: system?.server.hostname ?? 'servidor' },
        ].map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{k.label}</span>
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className={`mt-2 text-xl font-semibold ${k.mono ? 'font-mono text-lg' : ''}`}>{k.value}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{k.hint}</div>
            </div>
          );
        })}
      </div>

      {/* ── Recomendações de otimização (resource advisor) ── */}
      {recommendations.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-border">
            <AlertTriangle className="h-4 w-4 text-[hsl(var(--primary))]" />
            <h2 className="text-[13px] font-semibold">Recomendações de otimização</h2>
          </div>
          <div className="divide-y divide-border/60">
            {recommendations.map((r) => (
              <div key={r.code} className="px-5 py-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${severityTone(r.severity)}`}>
                    {r.severity === 'critical' ? 'crítico' : r.severity === 'warning' ? 'atenção' : 'info'}
                  </span>
                  <span className="text-[12.5px] font-medium">{r.message}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{r.action}</p>
                {r.cameras?.length ? <p className="truncate text-[10px] text-muted-foreground/80">{r.cameras.join(', ')}</p> : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Saúde por câmera (GET /observability/cameras) ──
          Aditivo: sem o endpoint (404/erro/corpo fora do contrato) healthRows
          fica vazio e a seção inteira some — a página segue como antes. */}
      {healthRows.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex flex-col gap-3 px-5 py-3.5 border-b border-border sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-[13px] font-semibold">Saúde por câmera</h2>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {([
                { state: 'critico' as CameraHealthState, count: healthSummary.critico },
                { state: 'atencao' as CameraHealthState, count: healthSummary.atencao },
                { state: 'ok' as CameraHealthState, count: healthSummary.ok },
              ]).map((c) => (
                <span
                  key={c.state}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${healthStateTone(c.state)}`}
                >
                  {cameraHealthStateLabel(c.state)}
                  <span className="font-mono text-[11px] tabular-nums">{c.count}</span>
                </span>
              ))}
              <span className="rounded-md border border-border bg-[hsl(var(--muted)_/_0.4)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                gravando <span className="font-mono text-[11px] tabular-nums">{healthSummary.recordingActive}/{healthSummary.total}</span>
              </span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {['Câmera', 'Estado', 'Gravando', 'Último segmento', 'Reinícios (1h)', 'Recuperações (1h)'].map((h) => (
                    <th key={h} className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {healthRows.map((row) => (
                  <tr key={row.cameraId} className="border-b border-border/60 last:border-0 hover:bg-accent/40 transition-colors">
                    <td className="px-5 py-3">
                      <div className="text-[12.5px] font-medium">{row.displayName}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {row.status === 'ONLINE' ? 'online' : row.status === 'OFFLINE' ? 'offline' : 'desconhecido'}
                        {row.enabled ? '' : ' · desativada'}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${healthStateTone(row.state)}`}>
                        {cameraHealthStateLabel(row.state)}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px]">
                        <span className={`h-1.5 w-1.5 rounded-full ${row.recording.active ? 'bg-[hsl(var(--status-online))]' : 'bg-muted-foreground/40'}`} />
                        {row.recording.active ? 'Sim' : 'Não'}
                        <span className="text-muted-foreground">· {recordingDesiredLabel(row.recording.desired)}</span>
                      </span>
                    </td>
                    <td className={`px-5 py-3 font-mono text-[11px] ${row.recording.stalled ? 'text-[hsl(var(--destructive))]' : 'text-muted-foreground'}`}>
                      {row.sinceLabel}
                    </td>
                    <td className={`px-5 py-3 font-mono text-[11px] tabular-nums ${row.recording.restartsLastHour > 0 ? 'text-[hsl(var(--status-warning))]' : 'text-muted-foreground'}`}>
                      {row.recording.restartsLastHour}
                    </td>
                    <td className={`px-5 py-3 font-mono text-[11px] tabular-nums ${row.stream.recoveriesLastHour > 0 ? 'text-[hsl(var(--status-warning))]' : 'text-muted-foreground'}`}>
                      {row.stream.recoveriesLastHour}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Stream health table ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-[13px] font-semibold">Saúde dos streams</h2>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground">{cameras.length} câmeras</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {['Câmera', 'Zona', 'Estado', 'Protocolo', 'IA', 'Processador'].map((h) => (
                  <th key={h} className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cameras.map((cam) => {
                const proc = processors[cam.id];
                const procState = !cam.aiEnabled ? '—' : proc?.running ? 'ativo' : 'parado';
                const procTone = procState === 'ativo' ? 'text-[hsl(var(--status-online))]' : procState === 'parado' ? 'text-[hsl(var(--status-warning))]' : 'text-muted-foreground';
                return (
                  <tr key={cam.id} className="border-b border-border/60 last:border-0 hover:bg-accent/40 transition-colors">
                    <td className="px-5 py-3">
                      <div className="text-[12.5px] font-medium">{cam.name}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{cam.code ?? cam.id}</div>
                    </td>
                    <td className="px-5 py-3 text-[11px] text-muted-foreground">{cam.zone}</td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px]">
                        <span className={`h-1.5 w-1.5 rounded-full ${cam.isOnline ? 'bg-[hsl(var(--status-online))]' : 'bg-muted-foreground/40'}`} />
                        {cam.isOnline ? 'Online' : 'Offline'}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground uppercase">
                      {(cam as any).preferredLiveProtocol ?? 'webrtc'}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-[11px] ${cam.aiEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {cam.aiEnabled ? 'Sim' : 'Não'}
                      </span>
                    </td>
                    <td className={`px-5 py-3 text-[11px] font-medium ${procTone}`}>{procState}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!system && (
        <p className="text-center text-xs text-muted-foreground py-4">
          Aguardando métricas do servidor…
        </p>
      )}

      <AlertDialog open={confirmApplyOpen} onOpenChange={setConfirmApplyOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aplicar ajustes seguros de streaming?</AlertDialogTitle>
            <AlertDialogDescription>
              O AjustCam não vai alterar IP, senha, RTSP, ONVIF, codec físico da câmera ou áudio — apenas parâmetros de entrega/streaming considerados seguros.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void applySafeOptimizations()}>Aplicar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
