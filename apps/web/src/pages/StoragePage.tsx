import { useEffect, useMemo, useState, type ReactNode } from 'react';
import axios from 'axios';
import { HardDrive, Thermometer, RefreshCw, Cpu, MemoryStick, Activity, Trash2, Server, ShieldAlert, ChevronDown } from 'lucide-react';
import { useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';
import { CloudStorageCard } from '../components/CloudStorageCard';
import { PreviousStoragesCard } from '../components/PreviousStoragesCard';
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

function Ring({ value }: { value: number }) {
  return (
    <div className="relative h-40 w-40 rounded-full" style={{ background: `conic-gradient(hsl(var(--primary)) ${value}%, hsl(var(--border)) 0)` }}>
      <div className="absolute inset-4 rounded-full bg-card border border-border flex flex-col items-center justify-center">
        <div className="text-3xl font-semibold">{value}%</div>
        <div className="text-[11px] text-[hsl(var(--muted-foreground))]">Uso</div>
      </div>
    </div>
  );
}

function Bar({ value }: { value: number }) {
  const tone = value >= 95 ? 'bg-[hsl(var(--destructive))]' : value >= 80 ? 'bg-[hsl(var(--chart-4))]' : 'bg-[hsl(var(--primary))]';
  return <div className="h-1.5 rounded-full bg-[hsl(var(--border))] overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${value}%` }} /></div>;
}

function StorageSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-accent/45"
      >
        <span className="text-sm font-semibold">{title}</span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="border-t border-border">{children}</div> : null}
    </section>
  );
}

export default function MonitoramentoPage() {
  const API_URL = getApiBaseUrl();
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUser = useAuthStore((state) => state.user);
  const isAdmin = currentUser?.role === 'admin';
  const cameras = useVmsDataStore((state) => state.cameras);
  const system = useVmsDataStore((state) => state.system);
  const load = useVmsDataStore((state) => state.load);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmApagarVideos, setConfirmApagarVideos] = useState('');
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reloadNonce, setReloadNonce] = useState(0);
  const [deletingVideos, setDeletingVideos] = useState(false);
  const [analytics, setAnalytics] = useState<{
    summary: { rows: number; totalRecordingsBytes: string; totalClipsBytes: string; totalBytes: string };
    items: Array<{
      cameraId: string;
      cameraName: string;
      day: string;
      recordingsCount: number;
      clipsCount: number;
      recordingsBytes: string;
      clipsBytes: string;
      totalBytes: string;
    }>;
  } | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [openStorageSections, setOpenStorageSections] = useState({
    health: true,
    volumes: true,
    cameras: true,
    cloud: true,
  });

  const toggleStorageSection = (key: keyof typeof openStorageSections) => {
    setOpenStorageSections((current) => ({ ...current, [key]: !current[key] }));
  };

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    void axios.get(`${API_URL}/recordings/storage-usage`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        from: new Date(`${fromDate}T00:00:00.000Z`).toISOString(),
        to: new Date(`${toDate}T23:59:59.999Z`).toISOString(),
      },
    }).then(({ data }) => {
      if (cancelled) return;
      setAnalytics(data);
    }).catch((error) => {
      if (cancelled) return;
      setAnalytics(null);
      setAnalyticsError(error instanceof Error ? error.message : 'Falha ao carregar análise de armazenamento.');
    }).finally(() => {
      if (!cancelled) setAnalyticsLoading(false);
    });
    return () => { cancelled = true; };
  }, [API_URL, accessToken, fromDate, toDate, reloadNonce]);

  async function handleDeleteAllVideos() {
    if (!accessToken) return;
    setConfirmDeleteOpen(false);
    setDeletingVideos(true);
    try {
      await axios.delete(`${API_URL}/recordings`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setReloadNonce((value) => value + 1);
      await load();
      toast({ title: 'Gravações apagadas', description: 'Todas as gravações e clipes exportados foram removidos.' });
    } catch (error) {
      const msg = axios.isAxiosError(error) ? (error.response?.data?.message || error.message) : 'Falha ao apagar vídeos.';
      toast({
        title: 'Falha ao apagar vídeos',
        description: Array.isArray(msg) ? msg.join(' | ') : String(msg),
        variant: 'destructive',
      });
    } finally {
      setDeletingVideos(false);
    }
  }

  const toGB = (raw: string | number | bigint) => (Number(raw) / 1024 / 1024 / 1024).toFixed(2);
  const volumes = useMemo(() => system ? [
    {
      server: system.server.hostname,
      volume: system.recordingsRoot,
      type: 'Local FS',
      use: system.disk.usagePercent,
      health: system.disk.usagePercent >= 95 ? 'Crítico' : system.disk.usagePercent >= 80 ? 'Aviso' : 'OK',
      temp: 0,
    },
  ] : [], [system]);
  const total = system ? system.disk.totalBytes / 1024 / 1024 / 1024 / 1024 : 0;
  const used = system ? system.disk.usedBytes / 1024 / 1024 / 1024 / 1024 : 0;
  const free = system ? system.disk.freeBytes / 1024 / 1024 / 1024 / 1024 : 0;
  const percent = system?.disk.usagePercent ?? 0;
  const cpuUsage = system ? Math.min(100, Math.round(((system.server.loadAverage[0] ?? 0) / Math.max(system.server.cpuCount, 1)) * 100)) : 0;
  const ramUsage = system ? Math.min(100, Math.round(((system.server.totalMemoryBytes - system.server.freeMemoryBytes) / Math.max(system.server.totalMemoryBytes, 1)) * 100)) : 0;
  const streamCount = cameras.filter((camera) => camera.isOnline).length;
  // Retenção real das câmeras acessíveis (antes era um "90 dias" fixo e falso).
  const retentionLabel = useMemo(() => {
    const days = Array.from(new Set(
      cameras.map((camera) => camera.retentionDays).filter((value): value is number => typeof value === 'number' && value > 0),
    ));
    if (!days.length) return '—';
    if (days.length === 1) return `${days[0]} dias`;
    return `${Math.min(...days)}–${Math.max(...days)} dias`;
  }, [cameras]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {isAdmin && (
        <div className="px-6 py-3 border-b border-border shrink-0 flex items-center justify-end">
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deletingVideos}
            className="btn btn-sm border-[hsl(var(--destructive)_/_0.35)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.08)] disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" /> {deletingVideos ? 'Apagando...' : 'Apagar vídeos'}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div className="bg-card border border-border rounded-xl p-5 flex items-center justify-center">
          <Ring value={percent} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="bg-card border border-border rounded-xl p-4"><div className="text-[10px] uppercase text-[hsl(var(--muted-foreground))]">Total</div><div className="mt-2 text-2xl font-semibold">{total.toFixed(1)} TB</div></div>
          <div className="bg-card border border-border rounded-xl p-4"><div className="text-[10px] uppercase text-[hsl(var(--muted-foreground))]">Utilizado</div><div className="mt-2 text-2xl font-semibold">{used.toFixed(1)} TB</div></div>
          <div className="bg-card border border-border rounded-xl p-4"><div className="text-[10px] uppercase text-[hsl(var(--muted-foreground))]">Livre</div><div className="mt-2 text-2xl font-semibold">{free.toFixed(1)} TB</div></div>
        </div>
      </div>
      <StorageSection title="Saúde do servidor" open={openStorageSections.health} onToggle={() => toggleStorageSection('health')}>
        <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-foreground">Uso atual</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Carga consolidada do servidor neste momento.</p>
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="space-y-3">
            {[
              { label: 'CPU', value: cpuUsage, unit: '%', icon: Cpu },
              { label: 'RAM', value: ramUsage, unit: '%', icon: MemoryStick },
              { label: 'Disco', value: percent, unit: '%', icon: HardDrive },
              { label: 'Streams', value: streamCount, unit: '', icon: Activity },
            ].map((metric) => {
              const Icon = metric.icon;
              const pct = metric.unit === '%' ? metric.value : Math.min(100, (metric.value / 200) * 100);
              const barColor = pct > 82 ? 'hsl(354,52%,52%)' : pct > 62 ? 'hsl(38,58%,54%)' : 'hsl(213,68%,57%)';
              return (
                <div key={metric.label} className="grid grid-cols-[18px_56px_1fr_58px] items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[10px] text-muted-foreground">{metric.label}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-border/70">
                    <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${Math.min(100, pct)}%`, background: barColor }} />
                  </div>
                  <span className="text-right font-mono text-[10px] tabular-nums">{metric.value.toFixed(0)}{metric.unit}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-4 rounded-xl border border-border/80 bg-background px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold">{system?.server.hostname ?? 'Servidor'}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{system?.recordingsRoot ?? '/storage'} · {cameras.length} câmeras</div>
              </div>
              <div className="text-right">
                <div className="text-[11px] font-semibold">{cpuUsage}% CPU</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{ramUsage}% RAM</div>
              </div>
            </div>
          </div>
        </div>
      </StorageSection>
      <StorageSection title="Volumes" open={openStorageSections.volumes} onToggle={() => toggleStorageSection('volumes')}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">Detalhes de armazenamento</div>
          </div>
          <button onClick={() => { setReloadNonce((value) => value + 1); void load(); }} className="text-xs flex items-center gap-2 text-[hsl(var(--muted-foreground))] hover:text-foreground transition-colors"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-[10px] text-[hsl(var(--muted-foreground))]">
            <tr className="border-b border-border">
              <th className="text-left px-5 py-3">Servidor</th>
              <th className="text-left px-5 py-3">Volume</th>
              <th className="text-left px-5 py-3">Tipo</th>
              <th className="text-left px-5 py-3">Uso</th>
              <th className="text-left px-5 py-3">Saúde</th>
              <th className="text-left px-5 py-3">Temp</th>
            </tr>
          </thead>
          <tbody>
            {volumes.map(row => (
              <tr key={row.volume} className="border-b border-border last:border-0">
                <td className="px-5 py-4 font-mono text-xs">{row.server}</td>
                <td className="px-5 py-4 flex items-center gap-2"><HardDrive className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />{row.volume}</td>
                <td className="px-5 py-4 text-xs text-[hsl(var(--muted-foreground))]">{row.type}</td>
                <td className="px-5 py-4 w-72"><div className="space-y-2"><Bar value={row.use} /><div className="text-xs text-[hsl(var(--muted-foreground))]">{row.use}%</div></div></td>
                <td className="px-5 py-4 text-xs"><span className={`px-2 py-1 rounded-full border ${row.health === 'Crítico' ? 'border-[hsl(var(--destructive)_/_0.35)] text-[hsl(var(--destructive))]' : row.health === 'Aviso' ? 'border-[hsl(var(--chart-4)_/_0.35)] text-[hsl(var(--chart-4))]' : 'border-border text-[hsl(var(--primary))]'}`}>{row.health}</span></td>
                <td className="px-5 py-4 text-xs font-mono flex items-center gap-1"><Thermometer className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />{row.temp ? `${row.temp}°C` : 'N/D'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </StorageSection>
      <StorageSection title="Armazenamento em nuvem" open={openStorageSections.cloud} onToggle={() => toggleStorageSection('cloud')}>
        <CloudStorageCard apiUrl={API_URL} accessToken={accessToken} />
        {/* Só aparece quando existe storage anterior — é o que sobra de uma
            troca de fornecedor, e continua sendo pago até alguém esvaziá-lo. */}
        <PreviousStoragesCard apiUrl={API_URL} accessToken={accessToken} />
      </StorageSection>

      <StorageSection title="Uso por câmera" open={openStorageSections.cameras} onToggle={() => toggleStorageSection('cameras')}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">Gravações e clipes exportados no período selecionado</div>
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-8 rounded border border-border bg-background px-2 text-xs" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-8 rounded border border-border bg-background px-2 text-xs" />
          </div>
        </div>
        <div className="px-5 py-3 text-xs text-[hsl(var(--muted-foreground))]">
          {analyticsLoading && 'Carregando uso por câmera...'}
          {!analyticsLoading && analyticsError && analyticsError}
          {!analyticsLoading && analytics && (
            <span>
              {analytics.summary.rows} linha(s) · gravações: {toGB(analytics.summary.totalRecordingsBytes)} GB · clipes: {toGB(analytics.summary.totalClipsBytes)} GB · total: {toGB(analytics.summary.totalBytes)} GB
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] text-[hsl(var(--muted-foreground))]">
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3">Dia</th>
                <th className="text-left px-5 py-3">Câmera</th>
                <th className="text-left px-5 py-3">Gravações</th>
                <th className="text-left px-5 py-3">Clipes</th>
                <th className="text-left px-5 py-3">Total</th>
              </tr>
            </thead>
            <tbody>
              {(analytics?.items ?? []).slice(0, 200).map((row) => (
                <tr key={`${row.day}-${row.cameraId}`} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 font-mono text-xs">{row.day}</td>
                  <td className="px-5 py-3 text-xs">{row.cameraName}</td>
                  <td className="px-5 py-3 text-xs">
                    {row.recordingsCount} arquivo(s) · {toGB(row.recordingsBytes)} GB
                  </td>
                  <td className="px-5 py-3 text-xs">
                    {row.clipsCount} arquivo(s) · {toGB(row.clipsBytes)} GB
                  </td>
                  <td className="px-5 py-3 text-xs font-semibold">{toGB(row.totalBytes)} GB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StorageSection>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-[hsl(var(--muted-foreground))]">Retenção</div>
          <div className="mt-3 text-2xl font-semibold">{retentionLabel}</div>
          <div className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">Configurada por câmera (gravações e eventos).</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-[hsl(var(--muted-foreground))]">Câmeras</div>
          <div className="mt-3 text-2xl font-semibold">{cameras.length}</div>
          <div className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">Base para cálculo de retenção por carga.</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-[hsl(var(--muted-foreground))]">Saúde operacional</div>
          <div className="mt-3 flex items-center gap-2 text-xs"><ShieldAlert className="w-4 h-4 text-[hsl(var(--chart-4))]" /> {volumes.filter((volume) => volume.health !== 'OK').length} volumes em atenção</div>
          <div className="mt-3 flex items-center gap-2 text-xs"><Server className="w-4 h-4 text-[hsl(var(--primary))]" /> {system ? 1 : 0} servidor monitorado</div>
        </div>
      </div>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          {/* ATRITO PROPORCIONAL. Esta é a ação mais destrutiva do sistema —
              apaga o acervo inteiro — e era um clique com texto genérico,
              enquanto esvaziar um bucket JÁ DESATIVADO exige digitar o nome do
              bucket. O atrito estava invertido. */}
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar todas as gravações?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Isto remove <strong>todas</strong> as gravações e clipes exportados de{' '}
                  <strong>todas as câmeras</strong>. Não pode ser desfeito.
                </p>
                {analytics?.summary ? (
                  <p className="rounded border border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.08)] px-2 py-1.5 text-[hsl(var(--destructive))]">
                    No período consultado são <strong>{analytics.summary.rows}</strong> registro(s),{' '}
                    <strong>{toGB(analytics.summary.totalBytes)} GB</strong> de vídeo.
                  </p>
                ) : null}
                <p>
                  As cópias já enviadas para a <strong>nuvem não são apagadas</strong> por esta ação —
                  para removê-las, use “Esvaziar” no armazenamento correspondente.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6">
            <label className="block text-[11px] text-muted-foreground" htmlFor="confirmar-apagar-videos">
              Para confirmar, digite <b className="font-mono text-foreground">APAGAR</b>:
            </label>
            <input
              id="confirmar-apagar-videos"
              value={confirmApagarVideos}
              onChange={(event) => setConfirmApagarVideos(event.target.value)}
              className="input mt-1 w-full"
              placeholder="APAGAR"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmApagarVideos.trim().toUpperCase() !== 'APAGAR'}
              onClick={() => void handleDeleteAllVideos()}
              className="bg-[hsl(var(--destructive))] text-white hover:bg-[hsl(var(--destructive)_/_0.9)] disabled:opacity-40"
            >
              Apagar definitivamente
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </div>
  );
}
