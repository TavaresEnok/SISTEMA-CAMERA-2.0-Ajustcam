import { useCallback, useState } from 'react';
import { Activity, Camera, Download, FileText, HardDrive, Server, Video } from 'lucide-react';
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
  // O carimbo era `new Date()` avaliado NO RENDER: mudava a cada repintura e
  // dizia "atualizado agora" mesmo com dado velho. Fixado na montagem.
  const [atualizadoEm] = useState(() => new Date().toLocaleString('pt-BR'));

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

  // ── EXPORTAÇÃO REAL, NO NAVEGADOR ─────────────────────────────────────
  //
  // A tela se chamava "Relatórios" e não gerava relatório nenhum — o próprio
  // texto admitia que a exportação "deve" usar estes dados. Não existe módulo
  // de relatórios no backend, mas o CSV não precisa dele: os números já estão
  // aqui, e gerar no cliente garante que arquivo e tela nunca divirjam.
  //
  // `;` como separador e BOM no início: é o que faz o Excel em português
  // abrir o arquivo com as colunas separadas e os acentos corretos.
  const exportarCsv = useCallback(() => {
    const escapar = (valor: unknown) => `"${String(valor ?? '').replace(/"/g, '""')}"`;
    const linhas: string[][] = [
      ['Relatório operacional AjustCam'],
      ['Gerado em', atualizadoEm],
      [],
      ['Resumo'],
      ['Câmeras cadastradas', String(cameras.length)],
      ['Câmeras online', String(online)],
      ['Câmeras offline', String(Math.max(0, cameras.length - online))],
      ['Eventos', String(events.length)],
      ['Alertas ativos', String(activeAlarms)],
      ['Gravações', String(recordings.length)],
      ['Uso do disco (%)', String(diskUsage)],
      [],
      ['Ambiente'],
      ...rows.map(([rotulo, valor]) => [rotulo, valor]),
      [],
      ['Câmeras'],
      ['Nome', 'Código', 'Zona', 'Status', 'Modo de gravação'],
      ...cameras.map((camera) => [
        camera.name, camera.code ?? '', camera.zone ?? '', camera.status ?? '', camera.recordingMode ?? '',
      ]),
    ];
    const csv = '\uFEFF' + linhas.map((linha) => linha.map(escapar).join(';')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const ancora = document.createElement('a');
    ancora.href = url;
    ancora.download = `relatorio-ajustcam-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(ancora);
    ancora.click();
    ancora.remove();
    URL.revokeObjectURL(url);
  }, [activeAlarms, atualizadoEm, cameras, diskUsage, events.length, online, recordings.length, rows]);

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
          <div className="flex items-center gap-2">
            <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
              Atualizado em {atualizadoEm}
            </div>
            <button type="button" onClick={exportarCsv} className="btn btn-primary btn-sm">
              <Download className="h-3.5 w-3.5" /> Exportar CSV
            </button>
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
            <div className="text-sm font-semibold">Sobre este relatório</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Consolida inventário de câmeras, eventos, gravações e saúde do servidor a partir dos
              mesmos dados que alimentam os painéis — o arquivo exportado nunca diverge da tela.
            </p>
            <div className="mt-4 rounded-md border border-border bg-background/60 p-3 text-xs">
              <div className="font-semibold text-foreground">Formato</div>
              <div className="mt-1 text-muted-foreground">
                CSV com separador ponto e vírgula e acentuação preservada, pronto para abrir no Excel.
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
