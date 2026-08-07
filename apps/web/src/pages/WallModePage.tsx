import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useLocation } from 'wouter';
import { Camera, Bell, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVmsDataStore } from '../store/vmsDataStore';

const layouts = [
  { label: '4x4', cols: 4, count: 16 },
  { label: '3x3', cols: 3, count: 9 },
  { label: '2x3', cols: 3, count: 6 },
  { label: '2x2', cols: 2, count: 4 },
];

/**
 * Relógio da barra e dos quadros.
 *
 * Antes era `new Date().toISOString()` avaliado no render: (a) UTC, três horas
 * adiantado no Brasil, e (b) SEM `setInterval`, ou seja, congelado na hora em
 * que a página abriu. Num mural, um relógio parado é pior que nenhum — ele
 * afirma um horário.
 */
function useRelogio() {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setAgora(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return agora;
}

const statusDot = (s: string) => {
  // VERMELHO PULSANTE É SÓ ALARME. Antes `online`, `recording` e `motion`
  // recebiam o MESMO tratamento do alarme: num mural de 16 câmeras saudáveis,
  // 16 pontos vermelhos piscavam e o alarme real sumia por saturação.
  if (s === 'alarm') return 'bg-[hsl(var(--destructive))] rec-pulse';
  if (s === 'recording') return 'bg-[hsl(var(--status-rec))]';
  if (s === 'motion') return 'bg-[hsl(var(--status-motion))]';
  if (s === 'online') return 'bg-[hsl(var(--status-online))]';
  if (s === 'offline' || s === 'no_signal') return 'bg-white/25';
  return 'bg-[hsl(var(--status-warning))]';
};

const statusOverlay = (s: string) => {
  if (s === 'offline' || s === 'no_signal') return { label: 'SEM SINAL', cls: 'bg-[hsl(var(--destructive)_/_0.2)] text-[hsl(var(--destructive))] border-[hsl(var(--destructive)_/_0.4)]' };
  if (s === 'maintenance') return { label: 'MANUTENÇÃO', cls: 'bg-[hsl(var(--status-warning)_/_0.2)] text-[hsl(var(--status-warning))] border-[hsl(var(--status-warning)_/_0.4)]' };
  return null;
};

export default function WallModePage() {
  const agora = useRelogio();
  const [, setLocation] = useLocation();
  const allCameras = useVmsDataStore((state) => state.cameras);
  const cameras = useMemo(() => allCameras.filter((camera) => camera.enabled !== false), [allCameras]);
  const [layout, setLayout] = useState(layouts[0]);
  const [showBar, setShowBar] = useState(true);

  const displayCams = cameras.slice(0, layout.count);
  const activeAlertas = cameras.filter(c => c.status === 'alarm').length;

  return (
    <div className="h-screen w-full bg-black flex flex-col overflow-hidden">
      {showBar && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-black border-b border-white/10 z-20 flex-shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setLocation('/live')}
              className="flex items-center gap-1.5 text-xs text-white/60 hover:text-white transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Sair do Modo Mural
            </button>
            <span className="text-white/20">|</span>
            <div className="flex items-center gap-1">
              {layouts.map(l => (
                <button
                  key={l.label}
                  onClick={() => setLayout(l)}
                  className={cn(
                    'h-6 px-2 rounded text-[10px] font-mono border transition-colors',
                    layout.label === l.label
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-white/15 text-white/55 hover:text-white hover:border-white/35'
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            {activeAlertas > 0 && (
              <div className="flex items-center gap-1.5 alarm-blink">
                <Bell className="h-3.5 w-3.5 text-[hsl(var(--destructive))]" />
                <span className="text-xs text-[hsl(var(--destructive))]">{activeAlertas} alerta{activeAlertas === 1 ? '' : 's'} ativo{activeAlertas === 1 ? '' : 's'}</span>
              </div>
            )}
            <span className="text-xs font-mono text-white/40">
              {format(agora, 'dd/MM/yyyy HH:mm:ss')}
            </span>
            <button
              onClick={() => setShowBar(false)}
              className="text-[10px] text-white/35 hover:text-white/70"
            >
              Ocultar
            </button>
          </div>
        </div>
      )}

      {!showBar && (
        <button
          onClick={() => setShowBar(true)}
          className="absolute top-2 left-1/2 -translate-x-1/2 z-30 h-5 px-4 rounded-full bg-black/80 border border-white/15 text-[10px] text-white/45 hover:text-white hover:bg-black/90 transition-colors"
        >
          Mostrar controles
        </button>
      )}

      <div
        className="flex-1 grid gap-0.5 p-0.5 bg-black"
        style={{ gridTemplateColumns: `repeat(${layout.cols}, 1fr)` }}
      >
        {displayCams.map(cam => {
          const overlay = statusOverlay(cam.status);
          return (
            <div key={cam.id} className="relative bg-black overflow-hidden group">
              <div className="absolute inset-0 scan-line-overlay opacity-40" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Camera className="h-8 w-8 text-white/10" />
              </div>

              <div className="absolute top-1.5 left-1.5 flex items-center gap-1.5 z-10">
                <div className={cn('h-1.5 w-1.5 rounded-full', statusDot(cam.status))} />
                <span className="max-w-[180px] truncate rounded bg-black/70 px-1 text-[9px] text-white/80">{cam.name}</span>
              </div>

              {overlay && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                  <span className={cn('text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border', overlay.cls)}>
                    {overlay.label}
                  </span>
                </div>
              )}

              <div className="absolute bottom-1 left-1 right-1 flex justify-between items-center z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="max-w-[160px] truncate rounded bg-black/70 px-1 text-[8px] text-white/60">{cam.zone}</span>
                <span className="text-[8px] font-mono text-white/40 bg-black/70 px-1 rounded">
                  {format(agora, 'HH:mm:ss')}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
