import { Activity, Camera, FileText, HardDrive, Server, Video } from 'lucide-react';
import { useVmsDataStore } from '../store/vmsDataStore';

function formatBytes(value?: number | null) {
  if (!value || value <= 0) return '0 GB';
  const gb = value / 1024 / 1024 / 1024;
  if (gb < 1024) return `${gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(2)} TB`;
}

function ReportMetric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof Camera;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
        </div>
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-primary">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-3 border-t border-border/70 pt-2 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

export default function ReportsPage() {
  const cameras = useVmsDataStore((state) => state.cameras);
  const events = useVmsDataStore((state) => state.events);
  const alarms = useVmsDataStore((state) => state.alarms);
  const recordings = useVmsDataStore((state) => state.recordings);
  const system = useVmsDataStore((state) => state.system);

  const online = cameras.filter((camera) => camera.isOnline).length;
  const activeAlarms = alarms.filter((alarm) => alarm.status === 'active').length;
  const diskUsage = system?.disk.usagePercent ?? 0;

  const rows = [
    ['Servidor', system?.server.hostname ?? 'N/D'],
    ['Sistema', system ? `${system.server.platform} ${system.server.release}` : 'N/D'],
    ['Raiz de gravações', system?.recordingsRoot ?? 'N/D'],
    ['Última gravação', system?.recordings.lastStartedAt ? new Date(system.recordings.lastStartedAt).toLocaleString('pt-BR') : 'N/D'],
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-primary">
              <FileText className="h-4 w-4" />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Relatórios</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">Resumo operacional gerado com dados reais do servidor.</p>
            </div>
          </div>
          <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
            Atualizado em {new Date().toLocaleString('pt-BR')}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <ReportMetric label="Câmeras" value={cameras.length} detail={`${online} online, ${Math.max(0, cameras.length - online)} offline`} icon={Camera} />
          <ReportMetric label="Eventos" value={events.length} detail={`${activeAlarms} alerta(s) ativo(s)`} icon={Activity} />
          <ReportMetric label="Gravações" value={recordings.length} detail={`${formatBytes(system?.recordings.totalBytes)} armazenados`} icon={Video} />
          <ReportMetric label="Disco" value={`${diskUsage}%`} detail={`${formatBytes(system?.disk.freeBytes)} livres`} icon={HardDrive} />
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-lg border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Server className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Ambiente</h2>
            </div>
            <div className="divide-y divide-border/70">
              {rows.map(([label, value]) => (
                <div key={label} className="grid gap-2 px-4 py-3 text-xs sm:grid-cols-[180px_1fr]">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono text-foreground">{value}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="text-sm font-semibold">Estado do relatório</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Esta tela consolida inventário, eventos, gravações e saúde do servidor. Exportações em PDF/CSV devem usar estes mesmos dados para evitar divergência entre painel e arquivo.
            </p>
            <div className="mt-4 rounded-md border border-border bg-background/60 p-3 text-xs">
              <div className="font-semibold text-foreground">Fonte</div>
              <div className="mt-1 text-muted-foreground">Dados operacionais do AjustCam e métricas do servidor.</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
