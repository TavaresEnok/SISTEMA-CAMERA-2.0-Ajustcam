import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useLocation } from 'wouter';
import { Check, Filter, LoaderCircle, User, Car, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { format } from 'date-fns';

const API_URL = getApiBaseUrl();

type ReviewItem = {
  id: string;
  cameraId: string;
  cameraName: string | null;
  type: string;
  label: string | null;
  confirmed: boolean;
  confidence: number | null;
  source: string | null;
  occurredAt: string;
  reviewed: boolean;
  recordingId: string | null;
  offsetSeconds: number | null;
};

function authHeaders(token: string | null) {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/** Miniatura do evento carregada com o token (endpoint autenticado → blob URL). */
function EventThumb({ eventId, token }: { eventId: string; token: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    void axios
      .get(`${API_URL}/review/${eventId}/thumbnail`, { headers: authHeaders(token), responseType: 'blob', timeout: 30000 })
      .then((res) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(res.data);
        setUrl(revoked);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [eventId, token]);

  if (failed) {
    return <div className="flex h-full w-full items-center justify-center bg-black/40 text-[10px] text-white/30">sem prévia</div>;
  }
  if (!url) {
    return <div className="flex h-full w-full items-center justify-center bg-black/40"><LoaderCircle className="h-4 w-4 animate-spin text-white/40" /></div>;
  }
  return <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />;
}

const LABEL_ICON: Record<string, typeof User> = { pessoa: User, carro: Car, moto: Car, onibus: Car, bicicleta: Car };

const PAGE_SIZE = 48;

export default function ReviewPage() {
  const [, setLocation] = useLocation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const cameras = useVmsDataStore((state) => state.cameras);
  const client = useMemo(() => axios.create({ baseURL: API_URL, headers: authHeaders(accessToken), timeout: 20000 }), [accessToken]);

  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [cameraId, setCameraId] = useState('__all__');
  const [label, setLabel] = useState('__all__');
  const [onlyConfirmed, setOnlyConfirmed] = useState(true);
  const [unseenOnly, setUnseenOnly] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const busy = useRef(false);

  const buildParams = useCallback((offset: number) => {
    const params: Record<string, string> = { limit: String(PAGE_SIZE) };
    if (offset > 0) params.offset = String(offset);
    if (cameraId !== '__all__') params.cameraId = cameraId;
    if (label !== '__all__') params.label = label;
    if (onlyConfirmed) params.onlyConfirmed = 'true';
    if (unseenOnly) params.unseenOnly = 'true';
    return params;
  }, [cameraId, label, onlyConfirmed, unseenOnly]);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const { data } = await client.get<{ items: ReviewItem[]; total: number }>('/review/feed', { params: buildParams(0) });
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(Number(data.total) || 0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      busy.current = false;
    }
  }, [client, buildParams]);

  /** Próxima página: ANEXA ao que já está na tela. Sem isto, só os primeiros
   *  PAGE_SIZE eventos eram alcançáveis — o resto ficava inatingível. */
  const loadMore = useCallback(async () => {
    if (busy.current || loadingMore) return;
    busy.current = true;
    setLoadingMore(true);
    try {
      const { data } = await client.get<{ items: ReviewItem[]; total: number }>(
        '/review/feed',
        { params: buildParams(items.length) },
      );
      const next = Array.isArray(data.items) ? data.items : [];
      setItems((cur) => {
        const known = new Set(cur.map((it) => it.id));
        return [...cur, ...next.filter((it) => !known.has(it.id))];
      });
      if (Number.isFinite(data.total)) setTotal(Number(data.total) || 0);
    } catch {
      // Falha ao paginar não derruba o que já está na tela.
    } finally {
      setLoadingMore(false);
      busy.current = false;
    }
  }, [client, buildParams, items.length, loadingMore]);

  useEffect(() => { void load(); }, [load]);

  const markSeen = useCallback(async (id: string, seen: boolean) => {
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, reviewed: seen } : it)));
    await client.post(`/review/${id}/seen`, { seen }).catch(() => {
      setItems((cur) => cur.map((it) => (it.id === id ? { ...it, reviewed: !seen } : it)));
    });
  }, [client]);

  const openInPlayback = useCallback((it: ReviewItem) => {
    void markSeen(it.id, true);
    const at = encodeURIComponent(it.occurredAt);
    setLocation(`/playback?cameraId=${encodeURIComponent(it.cameraId)}&at=${at}`);
  }, [markSeen, setLocation]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="page-hdr">
        <div>
          <h1 className="page-title">Revisão</h1>
          <p className="page-sub">Eventos detectados com prévia — revise sem abrir o vídeo. {total > 0 ? `${total} evento(s).` : ''}</p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm" title="Atualizar">
          <RefreshCw className="h-3.5 w-3.5" /> Atualizar
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Filter className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
        <Select value={cameraId} onValueChange={setCameraId}>
          <SelectTrigger className="h-8 w-[min(100%,220px)] text-xs"><SelectValue placeholder="Câmera" /></SelectTrigger>
          <SelectContent className="max-h-64">
            <SelectItem value="__all__" className="text-xs">Todas as câmeras</SelectItem>
            {cameras.map((c) => <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={label} onValueChange={setLabel}>
          <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Objeto" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__" className="text-xs">Qualquer objeto</SelectItem>
            <SelectItem value="pessoa" className="text-xs">Pessoa</SelectItem>
            <SelectItem value="carro" className="text-xs">Carro</SelectItem>
            <SelectItem value="moto" className="text-xs">Moto</SelectItem>
            <SelectItem value="onibus" className="text-xs">Ônibus</SelectItem>
          </SelectContent>
        </Select>
        <button type="button" onClick={() => setOnlyConfirmed((v) => !v)} className={`btn btn-sm ${onlyConfirmed ? 'btn-primary' : 'btn-secondary'}`} title="Somente eventos com objeto reconhecido pela IA">
          {onlyConfirmed ? <Check className="h-3.5 w-3.5" /> : null} Só com objeto
        </button>
        <button type="button" onClick={() => setUnseenOnly((v) => !v)} className={`btn btn-sm ${unseenOnly ? 'btn-primary' : 'btn-secondary'}`}>
          {unseenOnly ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {unseenOnly ? 'Só não vistos' : 'Todos'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading && !items.length ? (
          <div className="flex h-40 items-center justify-center text-[hsl(var(--muted-foreground))]">
            <LoaderCircle className="mr-2 h-5 w-5 animate-spin" /> Carregando eventos…
          </div>
        ) : !items.length ? (
          <div className="flex h-40 flex-col items-center justify-center text-center text-[hsl(var(--muted-foreground))]">
            <Eye className="mb-2 h-8 w-8 opacity-30" />
            <div className="text-sm">Nenhum evento para revisar</div>
            <div className="text-xs opacity-70">Ajuste os filtros ou aguarde novas detecções.</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((it) => {
              const Icon = it.label ? (LABEL_ICON[it.label] ?? User) : null;
              return (
                <div key={it.id} className={`group relative overflow-hidden rounded-lg border bg-card transition-colors ${it.reviewed ? 'border-border/60 opacity-70' : 'border-border hover:border-[hsl(var(--primary)_/_0.5)]'}`}>
                  <button type="button" onClick={() => openInPlayback(it)} className="relative block aspect-video w-full overflow-hidden bg-black">
                    {it.recordingId ? <EventThumb eventId={it.id} token={accessToken} /> : (
                      <div className="flex h-full w-full items-center justify-center text-[10px] text-white/30">sem gravação</div>
                    )}
                    {it.label && (
                      <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-[2px]">
                        {Icon && <Icon className="h-3 w-3" />} {it.label}
                        {it.confidence != null && <span className="text-white/50">{Math.round(it.confidence * 100)}%</span>}
                      </span>
                    )}
                    {it.reviewed && (
                      <span className="absolute right-1.5 top-1.5 rounded-full bg-[hsl(var(--status-online))] p-0.5"><Check className="h-2.5 w-2.5 text-black" /></span>
                    )}
                  </button>
                  <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="truncate text-[11px] font-medium">{it.cameraName ?? 'Câmera'}</div>
                      <div className="font-mono text-[9px] text-[hsl(var(--muted-foreground))]">{format(new Date(it.occurredAt), 'dd/MM HH:mm:ss')}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void markSeen(it.id, !it.reviewed)}
                      title={it.reviewed ? 'Marcar como não visto' : 'Marcar como visto'}
                      className="shrink-0 rounded border border-border p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-foreground"
                    >
                      {it.reviewed ? <EyeOff className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Sem isto, os eventos além do primeiro lote eram INATINGÍVEIS na tela. */}
        {items.length > 0 && items.length < total && (
          <div className="flex justify-center py-4">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="btn btn-secondary btn-sm"
            >
              {loadingMore
                ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Carregando…</>
                : `Carregar mais (${items.length} de ${total})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
