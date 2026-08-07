import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Check, Loader2, Plus, Trash2, Undo2 } from 'lucide-react';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';

export type DetectionZone = {
  id: string;
  name: string;
  kind: 'include' | 'exclude';
  points: number[][];
  color?: string;
};

type Props = {
  cameraId: string;
  cameraName: string;
  initialZones?: DetectionZone[] | null;
  onSaved?: (zones: DetectionZone[]) => void;
};

const API_URL = getApiBaseUrl();
const MAX_ZONES = 12;
const MAX_POINTS = 40;

// Cores fixas por tipo: excluir = vermelho (não monitorado), incluir = verde.
const ZONE_COLOR = {
  exclude: { stroke: 'hsl(0,72%,55%)', fill: 'hsl(0,72%,55%,0.22)' },
  include: { stroke: 'hsl(150,60%,45%)', fill: 'hsl(150,60%,45%,0.20)' },
} as const;

/**
 * Editor visual de zonas de detecção.
 *
 * O operador desenha polígonos SOBRE a imagem real da câmera (snapshot), e as
 * coordenadas são gravadas NORMALIZADAS (0..1) — assim a zona continua correta
 * se a resolução do stream de análise mudar.
 *
 * - Excluir: o movimento ali é ignorado (árvore, rua pública, céu).
 * - Incluir: havendo ao menos uma, só o interior delas é monitorado.
 */
export function DetectionZonesEditor({ cameraId, cameraName, initialZones, onSaved }: Props) {
  // BASE do "Desfazer alterações": o último estado CONFIRMADO pelo servidor.
  // Antes o botão revertia para `initialZones`, que vem do pai e não é
  // recarregado após salvar — desenhar 3 zonas, salvar e clicar em "Desfazer"
  // devolvia a tela a zero e desabilitava o Salvar, enquanto o servidor seguia
  // com as 3 zonas. O operador saía convencido de que havia revertido.
  const baseRef = useRef<DetectionZone[]>(initialZones ?? []);
  const accessToken = useAuthStore((state) => state.accessToken);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [zones, setZones] = useState<DetectionZone[]>(initialZones ?? []);
  const [drawing, setDrawing] = useState<number[][] | null>(null);
  const [drawKind, setDrawKind] = useState<'include' | 'exclude'>('exclude');
  const [saving, setSaving] = useState(false);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setZones(initialZones ?? []);
    baseRef.current = initialZones ?? [];
    setDirty(false);
  }, [initialZones, cameraId]);

  // Snapshot da câmera como pano de fundo (mesmo poster usado no live).
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void axios
      .post<{ streamToken: string }>(`${API_URL}/camera-stream/${cameraId}/token`, {}, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .then(({ data }) => {
        if (cancelled || !data?.streamToken) return;
        setPosterUrl(`${API_URL}/camera-stream/${cameraId}/poster?token=${encodeURIComponent(data.streamToken)}&v=${Date.now()}`);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accessToken, cameraId]);

  const toNormalized = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return [Number(x.toFixed(4)), Number(y.toFixed(4))];
  }, []);

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!drawing) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    setDrawing((current) => {
      if (!current) return current;
      if (current.length >= MAX_POINTS) {
        toast({ title: 'Limite de pontos', description: `Máximo de ${MAX_POINTS} pontos por zona.`, variant: 'destructive' });
        return current;
      }
      return [...current, point];
    });
  }, [drawing, toNormalized]);

  const finishDrawing = useCallback(() => {
    if (!drawing) return;
    if (drawing.length < 3) {
      toast({ title: 'Zona incompleta', description: 'Marque pelo menos 3 pontos para fechar a área.', variant: 'destructive' });
      return;
    }
    const kindLabel = drawKind === 'exclude' ? 'Ignorar' : 'Monitorar';
    const sameKind = zones.filter((z) => z.kind === drawKind).length + 1;
    setZones((current) => [
      ...current,
      {
        id: `zone-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: `${kindLabel} ${sameKind}`,
        kind: drawKind,
        points: drawing,
      },
    ]);
    setDrawing(null);
    setDirty(true);
  }, [drawing, drawKind, zones]);

  const save = useCallback(async () => {
    if (!accessToken) return;
    setSaving(true);
    try {
      await axios.patch(`${API_URL}/cameras/${cameraId}`, { detectionZones: zones }, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setDirty(false);
      // O que acabou de ser gravado passa a ser a base do desfazer.
      baseRef.current = zones;
      onSaved?.(zones);
      toast({
        title: 'Zonas salvas',
        description: zones.length
          ? `${zones.length} zona(s) ativas. A detecção já está usando as novas áreas.`
          : 'Sem zonas: a câmera inteira volta a ser monitorada.',
      });
    } catch (error) {
      toast({
        title: 'Falha ao salvar zonas',
        description: error instanceof Error ? error.message : 'Não foi possível salvar as zonas.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }, [accessToken, cameraId, onSaved, zones]);

  const polygonPoints = useCallback((points: number[][]) => (
    points.map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(' ')
  ), []);

  const hasInclude = useMemo(() => zones.some((z) => z.kind === 'include'), [zones]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="segment">
          <button
            type="button"
            onClick={() => setDrawKind('exclude')}
            className={`seg-btn ${drawKind === 'exclude' ? 'active' : ''}`}
          >
            Ignorar área
          </button>
          <button
            type="button"
            onClick={() => setDrawKind('include')}
            className={`seg-btn ${drawKind === 'include' ? 'active' : ''}`}
          >
            Monitorar só aqui
          </button>
        </div>

        {drawing ? (
          <>
            <button type="button" onClick={finishDrawing} className="btn btn-primary btn-sm">
              <Check className="h-3.5 w-3.5" />
              Fechar área ({drawing.length} pontos)
            </button>
            <button type="button" onClick={() => setDrawing(null)} className="btn btn-secondary btn-sm">
              Cancelar
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (zones.length >= MAX_ZONES) {
                toast({ title: 'Limite de zonas', description: `Máximo de ${MAX_ZONES} zonas por câmera.`, variant: 'destructive' });
                return;
              }
              setDrawing([]);
            }}
            className="btn btn-secondary btn-sm"
          >
            <Plus className="h-3.5 w-3.5" />
            Nova zona
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-[10px] text-[hsl(var(--status-warning))]">alterações não salvas</span>}
          <button type="button" onClick={() => void save()} disabled={saving || !dirty} className="btn btn-primary btn-sm disabled:opacity-45">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Salvar zonas
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onClick={handleClick}
        className={`relative w-full overflow-hidden rounded-lg border border-border bg-black ${drawing ? 'cursor-crosshair' : 'cursor-default'}`}
        style={{ aspectRatio: '16 / 9' }}
        aria-label={`Editor de zonas de ${cameraName}`}
      >
        {posterUrl ? (
          <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" draggable={false} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-white/40">Carregando imagem da câmera…</div>
        )}

        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {zones.map((zone) => (
            <polygon
              key={zone.id}
              points={polygonPoints(zone.points)}
              fill={ZONE_COLOR[zone.kind].fill}
              stroke={ZONE_COLOR[zone.kind].stroke}
              strokeWidth={0.4}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {drawing && drawing.length > 0 && (
            <>
              <polyline
                points={polygonPoints(drawing)}
                fill="none"
                stroke={ZONE_COLOR[drawKind].stroke}
                strokeWidth={0.4}
                strokeDasharray="2 1"
                vectorEffect="non-scaling-stroke"
              />
              {drawing.map(([x, y], index) => (
                <circle key={index} cx={x * 100} cy={y * 100} r={0.8} fill={ZONE_COLOR[drawKind].stroke} />
              ))}
            </>
          )}
        </svg>

        {drawing && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/70 px-2 py-1 text-[10px] text-white/80">
            Clique para marcar os cantos da área · mínimo 3 pontos
          </div>
        )}
      </div>

      {zones.length ? (
        <div className="space-y-1.5">
          {zones.map((zone) => (
            <div key={zone.id} className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ZONE_COLOR[zone.kind].stroke }} />
              <input
                value={zone.name}
                onChange={(event) => {
                  const name = event.target.value.slice(0, 64);
                  setZones((current) => current.map((z) => (z.id === zone.id ? { ...z, name } : z)));
                  setDirty(true);
                }}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
              />
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                {zone.kind === 'exclude' ? 'ignorada' : 'monitorada'} · {zone.points.length} pontos
              </span>
              <button
                type="button"
                onClick={() => {
                  setZones((current) => current.filter((z) => z.id !== zone.id));
                  setDirty(true);
                }}
                className="rounded p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--destructive)_/_0.12)] hover:text-[hsl(var(--destructive))]"
                title="Remover zona"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              setZones(initialZones ?? []);
    baseRef.current = initialZones ?? [];
              setDrawing(null);
              setDirty(false);
            }}
            className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:text-foreground"
          >
            <Undo2 className="h-3 w-3" />
            Desfazer alterações
          </button>
        </div>
      ) : (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Sem zonas: a câmera inteira é monitorada. Use <strong>Ignorar área</strong> para excluir rua, árvores ou céu —
          áreas que costumam gerar alarme falso.
        </p>
      )}

      {hasInclude && (
        <p className="rounded-md border border-[hsl(var(--status-warning)_/_0.3)] bg-[hsl(var(--status-warning)_/_0.08)] px-2.5 py-1.5 text-[11px] text-[hsl(var(--status-warning))]">
          Há zona do tipo <strong>monitorar</strong>: apenas o interior dela será analisado — todo o resto da imagem passa a ser ignorado.
        </p>
      )}
    </div>
  );
}
