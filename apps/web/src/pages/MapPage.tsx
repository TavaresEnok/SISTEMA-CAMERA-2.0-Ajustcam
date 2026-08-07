import { useMemo, useState } from 'react';
import { Camera, Eye, Info, PlaySquare, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useVmsDataStore, type Camera as VmsCamera } from '../store/vmsDataStore';

const STATUS_COLORS: Record<string, string> = {
  online: 'hsl(var(--status-online))',
  recording: 'hsl(var(--destructive))',
  motion: 'hsl(var(--status-warning))',
  alarm: 'hsl(var(--destructive))',
  offline: 'hsl(var(--muted-foreground))',
  no_signal: 'hsl(var(--muted-foreground))',
  maintenance: 'hsl(var(--status-warning))',
};

// Modo de gravação em português: o painel mostrava o enum cru ("continuous"),
// enquanto as pílulas de filtro logo acima já traduziam o status.
const RECORDING_MODE_LABELS: Record<string, string> = {
  continuous: 'Contínua', motion: 'Por movimento', manual: 'Manual', schedule: 'Agenda', none: 'Desligada',
};

const STATUS_FILTER_LABELS: Record<string, string> = {
  all: 'Todos',
  online: 'Online',
  recording: 'Gravando',
  alarm: 'Alarme',
  offline: 'Offline',
};

type ZonaLayout = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cameras: VmsCamera[];
};

type FloorLayout = {
  id: string;
  name: string;
  zones: ZonaLayout[];
};

function buildFloors(cameras: VmsCamera[]): FloorLayout[] {
  const grouped = new Map<string, VmsCamera[]>();
  for (const camera of cameras) {
    const floorKey = [camera.building, camera.floor].filter(Boolean).join(' / ') || 'Instalação principal';
    const current = grouped.get(floorKey) ?? [];
    current.push(camera);
    grouped.set(floorKey, current);
  }

  return [...grouped.entries()].map(([name, floorCameras], floorIndex) => {
    const zoneMap = new Map<string, VmsCamera[]>();
    for (const camera of floorCameras) {
      const zoneKey = camera.zone || 'Sem zona';
      const current = zoneMap.get(zoneKey) ?? [];
      current.push(camera);
      zoneMap.set(zoneKey, current);
    }

    const zoneEntries = [...zoneMap.entries()];
    const cols = Math.max(1, Math.ceil(Math.sqrt(zoneEntries.length || 1)));
    const cardWidth = 210;
    const cardHeight = 120;
    const gapX = 24;
    const gapY = 22;
    const baseX = 42;
    const baseY = 42;

    const zones = zoneEntries.map(([label, zoneCameras], zoneIndex) => {
      const col = zoneIndex % cols;
      const row = Math.floor(zoneIndex / cols);
      return {
        id: `${floorIndex}-${zoneIndex}`,
        label,
        x: baseX + col * (cardWidth + gapX),
        y: baseY + row * (cardHeight + gapY),
        w: cardWidth,
        h: cardHeight,
        cameras: zoneCameras,
      };
    });

    return {
      id: `floor-${floorIndex}`,
      name,
      zones,
    };
  });
}

function cameraMarkerPosition(index: number, zone: ZonaLayout) {
  const cols = 4;
  const spacingX = 34;
  const spacingY = 28;
  const offsetX = 26;
  const offsetY = 36;
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: zone.x + offsetX + col * spacingX,
    y: zone.y + offsetY + row * spacingY,
  };
}

export default function MapPage() {
  const [, setLocation] = useLocation();
  const cameras = useVmsDataStore((state) => state.cameras);
  const [selectedCamera, setSelectedCamera] = useState<VmsCamera | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const floors = useMemo(() => buildFloors(cameras), [cameras]);
  const [activeFloorId, setActiveFloorId] = useState<string | null>(floors[0]?.id ?? null);
  const activeFloor = floors.find((floor) => floor.id === activeFloorId) ?? floors[0] ?? null;

  const floorZonaCount = activeFloor?.zones.length ?? 0;
  const floorCameraCount = activeFloor?.zones.reduce((sum, zone) => sum + zone.cameras.length, 0) ?? 0;

  return (
    // Abaixo de `lg` empilha: antes era `flex` fixo com painel de 320px, e o
    // mapa era esmagado a poucas centenas de pixels — no celular, inutilizável.
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:overflow-hidden lg:p-6">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {floors.map((floor) => (
            <button
              key={floor.id}
              onClick={() => setActiveFloorId(floor.id)}
              className={`h-9 rounded-md px-4 text-xs font-medium transition-colors ${activeFloor?.id === floor.id ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'}`}
            >
              {floor.name}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {['all', 'online', 'recording', 'alarm', 'offline'].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`h-8 rounded-md px-2.5 text-[10px] font-mono transition-colors ${statusFilter === status ? 'border border-border bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
              >
                {STATUS_FILTER_LABELS[status] ?? status}
              </button>
            ))}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          {!activeFloor ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Nenhuma planta operacional disponível. Cadastre uma imagem de planta para posicionar as câmeras sobre o desenho real do local.
            </div>
          ) : (
            <svg viewBox="0 0 980 560" className="h-full w-full" style={{ background: 'hsl(var(--card))' }}>
              {Array.from({ length: 22 }, (_, i) => (
                <line key={`h-${i}`} x1="0" y1={i * 26} x2="980" y2={i * 26} stroke="hsl(var(--border))" strokeWidth="1" opacity="0.45" />
              ))}
              {Array.from({ length: 38 }, (_, i) => (
                <line key={`v-${i}`} x1={i * 26} y1="0" x2={i * 26} y2="560" stroke="hsl(var(--border))" strokeWidth="1" opacity="0.45" />
              ))}

              <rect x="24" y="24" width="932" height="512" rx="8" fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
              <text x="48" y="54" fill="hsl(var(--foreground))" fontSize="16" fontWeight="600">{activeFloor.name}</text>
              <text x="48" y="76" fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="'JetBrains Mono', monospace">
                {floorZonaCount} zonas · {floorCameraCount} câmeras mapeadas
              </text>
              <text x="48" y="96" fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="'Plus Jakarta Sans', sans-serif">
                Planta real ainda não configurada; exibindo mapa esquemático gerado pelas zonas.
              </text>

              {activeFloor.zones.map((zone) => (
                <g key={zone.id}>
                  <rect
                    x={zone.x}
                    y={zone.y}
                    width={zone.w}
                    height={zone.h}
                    rx="8"
                    fill="hsl(var(--background))"
                    stroke="hsl(var(--border))"
                    strokeWidth="1.2"
                  />
                  <text
                    x={zone.x + 16}
                    y={zone.y + 18}
                    fill="hsl(var(--foreground))"
                    fontSize="10"
                    fontFamily="'Plus Jakarta Sans', sans-serif"
                    fontWeight="600"
                  >
                    {zone.label}
                  </text>
                  <text
                    x={zone.x + zone.w - 16}
                    y={zone.y + 18}
                    textAnchor="end"
                    fill="hsl(var(--primary))"
                    opacity="0.8"
                    fontSize="9"
                    fontFamily="'JetBrains Mono', monospace"
                  >
                    {zone.cameras.length} câmeras
                  </text>

                  {zone.cameras
                    .filter((camera) => statusFilter === 'all' || camera.status === statusFilter)
                    .map((camera, index) => {
                      const position = cameraMarkerPosition(index, zone);
                      const color = STATUS_COLORS[camera.status] ?? 'hsl(var(--muted-foreground))';
                      const selected = selectedCamera?.id === camera.id;
                      return (
                        <g
                          key={camera.id}
                          transform={`translate(${position.x}, ${position.y})`}
                          onClick={() => setSelectedCamera((current) => current?.id === camera.id ? null : camera)}
                          // Focável e operável por teclado: eram `<g onClick>` puros,
                          // sem role, sem tabIndex e sem nome acessível — quem não
                          // usa mouse não conseguia selecionar câmera nenhuma.
                          role="button"
                          tabIndex={0}
                          aria-label={`${camera.name} — ${STATUS_FILTER_LABELS[camera.status] ?? camera.status}`}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedCamera((current) => current?.id === camera.id ? null : camera);
                            }
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          {/* Área de toque de 24px: o marcador visível tem 14px de
                              diâmetro, abaixo do mínimo, e é o ÚNICO jeito de
                              selecionar uma câmera no mapa. */}
                          <circle r="12" fill="transparent" />
                          <circle r={selected ? 9 : 7} fill="hsl(var(--card))" stroke={color} strokeWidth={selected ? 2.2 : 1.6} />
                          <circle r="2.2" fill={color} />
                          {camera.status === 'alarm' && (
                            <circle r="12" fill="none" stroke={color} strokeWidth="1" opacity="0.4">
                              <animate attributeName="r" values="7;14;7" dur="1.5s" repeatCount="indefinite" />
                              <animate attributeName="opacity" values="0.4;0;0.4" dur="1.5s" repeatCount="indefinite" />
                            </circle>
                          )}
                        </g>
                      );
                    })}
                </g>
              ))}
            </svg>
          )}
        </div>
      </div>

      <div className="w-full shrink-0 overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:w-80">
        <div className="border-b border-border px-4 py-3">
          <div className="text-xs font-semibold">Detalhes da Câmera</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {selectedCamera ? 'Selecione uma ação para a câmera atual.' : 'Selecione um marcador no mapa.'}
          </div>
        </div>

        {selectedCamera ? (
          <div className="p-4 space-y-4">
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-border bg-background">
              <Camera className="h-8 w-8 text-muted-foreground/40" />
              <div className="absolute left-2 top-2 rounded-md border border-border bg-card/85 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {selectedCamera.code}
              </div>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">Nome</span><span className="text-right">{selectedCamera.name}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">Zona</span><span className="text-right">{selectedCamera.zone}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">Endereço IP</span><span className="font-mono text-right">{selectedCamera.ipAddress}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">Status</span><span className="capitalize">{selectedCamera.status.replace('_', ' ')}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">Gravação</span><span className="capitalize">{RECORDING_MODE_LABELS[selectedCamera.recordingMode] ?? selectedCamera.recordingMode}</span></div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <Link href={`/cameras/${selectedCamera.id}`} className="h-9 rounded border border-border bg-background hover:bg-accent flex items-center justify-center">
                    <Eye className="w-4 h-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="text-xs">Abrir câmera</TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  {/* Leva a câmera junto: sem o parâmetro, o operador selecionava
                      a câmera do alarme e caía numa tela genérica. */}
                  <Link href={`/playback?cameraId=${encodeURIComponent(selectedCamera.id)}`} className="h-9 rounded border border-border bg-background hover:bg-accent flex items-center justify-center">
                    <PlaySquare className="w-4 h-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="text-xs">Abrir reprodução</TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <button onClick={() => setSelectedCamera(null)} className="h-9 rounded border border-border bg-background hover:bg-accent flex items-center justify-center">
                    <X className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">Limpar seleção</TooltipContent>
              </Tooltip>
            </div>

            <div className="rounded-md border border-border bg-background/60 p-3 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-2 mb-1">
                <Info className="w-3.5 h-3.5" />
                <span className="font-medium text-foreground">Operacional</span>
              </div>
              <div>Mapa gerado a partir de unidade, andar e zona reais das câmeras cadastradas. Quando uma imagem de planta for enviada, os marcadores passam a ser posicionados sobre o desenho real.</div>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center p-6 text-sm text-muted-foreground text-center">
            Nenhuma câmera selecionada neste andar.
          </div>
        )}
      </div>
    </div>
  );
}
