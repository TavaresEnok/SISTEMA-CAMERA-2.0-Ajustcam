import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useLocation } from 'wouter';
import { Save, Trash2, ExternalLink, LoaderCircle, Copy, RefreshCw, Check, Radio, ArrowRightLeft } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { Camera, useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';
import { getApiBaseUrl } from '../lib/api-base';
import { normalizeVideoCodec, normalizePreferredLiveProtocol } from '../lib/camera-format';

interface CameraEditSheetProps {
  camera: Camera | null;
  open: boolean;
  onClose: () => void;
  onDeleted?: (id: string) => void;
}

type Form = {
  name: string;
  ip: string;
  rtspPort: string;
  username: string;
  password: string;
  rtspPath: string;
  preferredRtspTransport: 'tcp' | 'udp';
  preferredLiveProtocol: string;
  streamVideoCodec: string;
  recordingVideoCodec: string;
  recordingMode: 'continuous' | 'motion' | 'schedule' | 'manual';
  retentionDays: string;
  audioEnabled: boolean;
  aiEnabled: boolean;
  alarmsEnabled: boolean;
  enabled: boolean;
};

const RECORDING_MODES = [
  { value: 'continuous', label: 'Contínua', desc: '24 h ininterrupto' },
  { value: 'motion', label: 'Por movimento', desc: 'Ativa ao detectar movimento' },
  { value: 'schedule', label: 'Agendada', desc: 'Segue janela configurada' },
  { value: 'manual', label: 'Manual', desc: 'Operador inicia / para' },
] as const;

const CODECS = ['original', 'h264', 'h265', 'mjpeg'] as const;
const LIVE_PROTOCOLS = ['webrtc', 'hls', 'llhls', 'mjpeg'] as const;

// ── COMO O VÍDEO CHEGA ATÉ NÓS ─────────────────────────────────────────────
//
// Duas formas, e a escolha muda o que o instalador precisa fazer em campo:
//
//  · NÓS CONECTAMOS (RTSP): o servidor disca para a câmera. Exige que ela seja
//    alcançável — IP público, redirecionamento de porta ou VPN. É o modo de
//    sempre, e continua sendo o padrão de toda câmera já cadastrada.
//
//  · A CÂMERA PUBLICA (RTMP): a câmera abre a conexão de saída e empurra o
//    vídeo para nós. Funciona atrás de CGNAT, 4G e qualquer rede onde ninguém
//    vai abrir porta — porque a conexão nasce de dentro.
type IngestTarget = {
  sourceMode: string;
  serverUrl: string | null;
  streamKey: string | null;
  fullUrl: string | null;
  canonicalFullUrl?: string | null;
  compactFullUrl?: string | null;
  fullUrlFitsSingleField?: boolean;
  singleFieldMaxLength?: number;
  /** Caminho próprio do equipamento, quando ele não deixa escolher. */
  ingestPath?: string | null;
};

type PendingIngest = {
  path: string;
  remoteAddr: string | null;
  lastSeenAt: number;
  attempts: number;
};

export function CameraEditSheet({ camera, open, onClose, onDeleted }: CameraEditSheetProps) {
  const [, setLocation] = useLocation();
  const accessToken = useAuthStore((s) => s.accessToken);
  const loadData = useVmsDataStore((s) => s.load);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [ingest, setIngest] = useState<IngestTarget | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [copiado, setCopiado] = useState<string | null>(null);
  const [pendentes, setPendentes] = useState<PendingIngest[]>([]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const cameraId = camera?.id ?? null;
  useEffect(() => {
    const selectedCamera = camera;
    if (!cameraId || !accessToken || !selectedCamera) return;
    let cancelled = false;
    setForm(null);
    setIngest(null);
    setConfirmDelete(false);
    setLoading(true);
    // Modo de origem vem de endpoint próprio (a chave é credencial e só
    // administrador lê). Falha aqui não pode impedir editar a câmera.
    void axios
      .get(`${getApiBaseUrl()}/cameras/${cameraId}/rtmp-ingest`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .then(({ data }) => { if (!cancelled) setIngest(data ?? null); })
      .catch(() => undefined);
    void axios
      .get(`${getApiBaseUrl()}/cameras/rtmp-ingest/pending`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .then(({ data }) => { if (!cancelled) setPendentes(data?.items ?? []); })
      .catch(() => undefined);
    void axios
      .get(`${getApiBaseUrl()}/cameras/${cameraId}`, { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(({ data }) => {
        if (cancelled) return;
        setForm({
          name: data.name ?? selectedCamera.name,
          ip: data.ip ?? selectedCamera.ipAddress,
          rtspPort: String(data.rtspPort ?? selectedCamera.rtspPort ?? 554),
          username: data.username ?? '',
          password: '',
          rtspPath: data.rtspPath ?? '',
          preferredRtspTransport: (data.preferredRtspTransport ?? 'tcp') as 'tcp' | 'udp',
          preferredLiveProtocol: normalizePreferredLiveProtocol(data.preferredLiveProtocol),
          streamVideoCodec: normalizeVideoCodec(data.streamVideoCodec),
          recordingVideoCodec: normalizeVideoCodec(data.recordingVideoCodec),
          recordingMode: (data.recordingMode ?? (data.recordingEnabled ? 'continuous' : 'manual')) as Form['recordingMode'],
          retentionDays: String(data.retentionDays ?? 7),
          audioEnabled: Boolean(data.audioEnabled),
          aiEnabled: data.aiEnabled !== false,
          alarmsEnabled: data.alarmsEnabled !== false,
          enabled: data.enabled !== false,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        toast({
          title: 'Falha ao carregar câmera',
          description: err instanceof Error ? err.message : 'Não foi possível carregar a configuração.',
          variant: 'destructive',
        });
        onCloseRef.current();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId, accessToken]);

  if (!camera) return null;
  const upd = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const modoPush = ingest?.sourceMode === 'rtmp_push';
  const usaEnderecoCompacto = Boolean(ingest?.canonicalFullUrl && ingest.fullUrl !== ingest.canonicalFullUrl);
  const urlCompletaCompativel = ingest?.fullUrlFitsSingleField !== false;
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

  const copiar = async (texto: string, marca: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(marca);
      window.setTimeout(() => setCopiado((c) => (c === marca ? null : c)), 1800);
    } catch {
      toast({ title: 'Não foi possível copiar', description: 'Selecione e copie manualmente.', variant: 'destructive' });
    }
  };

  /** Liga o modo publicação e gera a chave. Rotacionar usa o mesmo caminho. */
  const ativarPush = async (rotacionando = false) => {
    if (!accessToken) return;
    setIngestBusy(true);
    try {
      const { data } = await axios.post(`${getApiBaseUrl()}/cameras/${camera.id}/rtmp-ingest`, {}, auth);
      setIngest(data);
      toast({
        title: rotacionando ? 'Chave trocada' : 'Modo publicação ativado',
        description: rotacionando
          ? 'A chave anterior parou de valer. Atualize a câmera com a nova.'
          : 'Copie o endereço e a chave para a câmera.',
      });
    } catch (err) {
      toast({
        title: 'Falha ao gerar a chave',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIngestBusy(false);
    }
  };

  /** Assume que o equipamento que publica naquele caminho É esta câmera. */
  const vincular = async (path: string) => {
    if (!accessToken) return;
    setIngestBusy(true);
    try {
      await axios.post(`${getApiBaseUrl()}/cameras/${camera.id}/rtmp-ingest/bind`, { path }, auth);
      const [{ data: alvo }, { data: lista }] = await Promise.all([
        axios.get(`${getApiBaseUrl()}/cameras/${camera.id}/rtmp-ingest`, auth),
        axios.get(`${getApiBaseUrl()}/cameras/rtmp-ingest/pending`, auth),
      ]);
      setIngest(alvo ?? null);
      setPendentes(lista?.items ?? []);
      toast({ title: 'Equipamento vinculado', description: 'O vídeo dele passa a entrar como esta câmera.' });
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.message ?? err.message) : 'Tente novamente.';
      toast({ title: 'Falha ao vincular', description: String(msg), variant: 'destructive' });
    } finally {
      setIngestBusy(false);
    }
  };

  /** Volta ao modo tradicional e APAGA a chave (senão ela seguiria valendo). */
  const desativarPush = async () => {
    if (!accessToken) return;
    setIngestBusy(true);
    try {
      await axios.delete(`${getApiBaseUrl()}/cameras/${camera.id}/rtmp-ingest`, auth);
      setIngest({ sourceMode: 'rtsp_pull', serverUrl: null, streamKey: null, fullUrl: null });
      toast({ title: 'Voltou para conexão pelo servidor', description: 'A chave de publicação foi apagada.' });
    } catch (err) {
      toast({
        title: 'Falha ao desativar',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIngestBusy(false);
    }
  };

  const handleSave = async () => {
    if (!accessToken || !form) return;
    setSaving(true);
    try {
      await axios.patch(
        `${getApiBaseUrl()}/cameras/${camera.id}`,
        {
          name: form.name.trim(),
          ip: form.ip.trim(),
          rtspPort: Number(form.rtspPort),
          username: form.username.trim() || undefined,
          ...(form.password.trim() ? { password: form.password } : {}),
          rtspPath: form.rtspPath.trim(),
          preferredRtspTransport: form.preferredRtspTransport,
          preferredLiveProtocol: form.preferredLiveProtocol === 'mjpeg' ? 'webrtc' : form.preferredLiveProtocol,
          streamVideoCodec: 'h264',
          recordingVideoCodec: normalizeVideoCodec(form.recordingVideoCodec),
          recordingMode: form.recordingMode,
          retentionDays: Number(form.retentionDays),
          audioEnabled: form.audioEnabled,
          aiEnabled: form.aiEnabled,
          alarmsEnabled: form.alarmsEnabled,
          enabled: form.enabled,
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      await loadData();
      toast({ title: 'Câmera atualizada', description: form.name });
      onClose();
    } catch (err) {
      const message = axios.isAxiosError(err)
        ? (Array.isArray(err.response?.data?.message) ? err.response?.data?.message.join('\n') : err.response?.data?.message) ?? err.message
        : err instanceof Error ? err.message : 'Falha ao salvar.';
      toast({ title: 'Erro ao salvar', description: message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!accessToken) return;
    try {
      await axios.delete(`${getApiBaseUrl()}/cameras/${camera.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      await loadData();
      toast({ title: 'Câmera removida', description: camera.name });
      onDeleted?.(camera.id);
      onClose();
    } catch (err) {
      toast({ title: 'Erro ao remover', description: err instanceof Error ? err.message : 'Falha.', variant: 'destructive' });
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[460px] sm:max-w-[460px] flex flex-col p-0 gap-0">
        <SheetHeader className="px-5 py-4 border-b border-border shrink-0 space-y-0 text-left">
          <div className="flex items-center gap-3">
            <span className={cn('w-2 h-2 rounded-full shrink-0', camera.isOnline ? 'bg-[hsl(var(--status-online))]' : 'bg-[hsl(var(--status-offline))]')} />
            <div className="min-w-0">
              <SheetTitle className="text-[14px] font-semibold truncate">{camera.name}</SheetTitle>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">{camera.zone} · {camera.ipAddress}</p>
            </div>
          </div>
        </SheetHeader>

        {loading || !form ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <LoaderCircle className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <Tabs defaultValue="geral" className="flex flex-col">
                <TabsList className="mx-4 mt-4 grid h-10 shrink-0 grid-cols-3 gap-1 rounded-lg border border-border bg-muted/45 p-1">
                  <TabsTrigger value="geral" className="rounded-md text-xs text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">Geral</TabsTrigger>
                  <TabsTrigger value="stream" className="rounded-md text-xs text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">Stream</TabsTrigger>
                  <TabsTrigger value="gravacao" className="rounded-md text-xs text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">Gravação</TabsTrigger>
                </TabsList>

                {/* GERAL */}
                <TabsContent value="geral" className="px-5 py-4 space-y-4 mt-0">
                  {/* Liga/desliga da câmera — em destaque no topo. Desativada:
                      para de exibir e gravar, sem apagar o cadastro. */}
                  <div className={cn(
                    'flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3 transition-colors',
                    form.enabled
                      ? 'border-[hsl(var(--status-online)_/_0.35)] bg-[hsl(var(--status-online)_/_0.08)]'
                      : 'border-amber-500/40 bg-amber-500/10',
                  )}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', form.enabled ? 'bg-[hsl(var(--status-online))]' : 'bg-amber-500')} />
                        <p className="text-[13px] font-semibold">{form.enabled ? 'Câmera ativa' : 'Câmera desativada'}</p>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                        {form.enabled
                          ? 'Transmitindo e gravando normalmente. Desligue para pausar sem apagar o cadastro nem as gravações.'
                          : 'Não está transmitindo nem gravando. As gravações antigas e o cadastro continuam salvos.'}
                      </p>
                    </div>
                    <Switch checked={form.enabled} onCheckedChange={(v) => upd('enabled', v)} />
                  </div>
                  <FormField label="Nome da câmera" required>
                    <Input value={form.name} onChange={(e) => upd('name', e.target.value)} className="text-sm" />
                  </FormField>
                  <Separator />
                  <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Como o vídeo chega</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => { if (modoPush && !ingestBusy) void desativarPush(); }}
                      disabled={ingestBusy}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                        !modoPush ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40',
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
                        <span className="text-[12px] font-semibold">Buscar na câmera (RTSP)</span>
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                        O servidor busca o vídeo na câmera. Ela precisa estar acessível: porta liberada ou VPN.
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => { if (!modoPush && !ingestBusy) void ativarPush(); }}
                      disabled={ingestBusy}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                        modoPush ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40',
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <Radio className="h-3.5 w-3.5 shrink-0" />
                        <span className="text-[12px] font-semibold">Câmera envia (RTMP)</span>
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                        A câmera manda o vídeo para o servidor. Funciona atrás de CGNAT e 4G, sem liberar porta.
                      </p>
                    </button>
                  </div>

                  {modoPush ? (
                    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3.5">
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Cole este endereço na câmera ou no DVR, normalmente em
                        {' '}<span className="font-medium text-foreground">Rede → RTMP</span> (ou
                        {' '}<em>Push Stream</em>). Depois disso ela aparece na grade sozinha.
                      </p>

                      {ingest?.ingestPath ? (
                        <div className="rounded-md border border-[hsl(var(--status-online)_/_0.35)] bg-[hsl(var(--status-online)_/_0.08)] p-3">
                          <p className="text-[11px] font-semibold">Equipamento vinculado</p>
                          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{ingest.ingestPath}</p>
                          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                            Este aparelho não deixa escolher o destino — ele publica sempre neste caminho.
                            Nada a configurar nele; o vídeo já entra como esta câmera.
                          </p>
                        </div>
                      ) : null}
                      {!ingest?.ingestPath && (
                        <div className="space-y-3">
                          {usaEnderecoCompacto && (
                            <div className="rounded-md border border-[hsl(var(--status-online)_/_0.35)] bg-[hsl(var(--status-online)_/_0.08)] p-3">
                              <p className="text-[11px] font-semibold text-[hsl(var(--status-online))]">Endereço compacto selecionado</p>
                              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                                Usa o endereço público curto e a porta RTMP explícita, mantendo os 128 bits da chave e o limite de{' '}
                                {ingest?.singleFieldMaxLength ?? 63} caracteres da Intelbras.
                              </p>
                            </div>
                          )}
                          {urlCompletaCompativel ? (
                            <CampoCopiavel
                              rotulo="Endereço completo para campo único"
                              valor={ingest?.fullUrl ?? ''}
                              copiado={copiado === 'completa'}
                              onCopiar={() => copiar(ingest?.fullUrl ?? '', 'completa')}
                            />
                          ) : (
                            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                              <p className="text-[11px] font-semibold text-amber-500">URL maior que o campo da câmera</p>
                              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                                Não recorte a chave. Use servidor e chave separados ou o modo não personalizado por IP e porta.
                              </p>
                            </div>
                          )}
                          <details className="rounded-md border border-border bg-background/40 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] font-medium">Servidor e chave separados</summary>
                            <div className="mt-3 space-y-3">
                              <CampoCopiavel
                                rotulo="Servidor RTMP"
                                valor={ingest?.serverUrl ?? ''}
                                copiado={copiado === 'servidor'}
                                onCopiar={() => copiar(ingest?.serverUrl ?? '', 'servidor')}
                              />
                              <CampoCopiavel
                                rotulo="Chave do stream"
                                valor={ingest?.streamKey ?? ''}
                                copiado={copiado === 'chave'}
                                onCopiar={() => copiar(ingest?.streamKey ?? '', 'chave')}
                              />
                            </div>
                          </details>
                        </div>
                      )}

                      {pendentes.length > 0 && (
                        <>
                          <Separator />
                          <div className="space-y-2">
                            <p className="text-[11px] font-semibold">Equipamentos tentando publicar</p>
                            <p className="text-[10px] leading-relaxed text-muted-foreground">
                              Chegaram no servidor mas ainda não pertencem a nenhuma câmera. Se um deles
                              for esta, vincule — o vídeo passa a entrar por aqui.
                            </p>
                            {pendentes.map((p) => (
                              <div key={p.path} className="flex items-center gap-2 rounded-md border border-border bg-background/60 p-2">
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-mono text-[11px]">{p.path}</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {p.remoteAddr ?? 'origem desconhecida'} · {p.attempts} tentativa{p.attempts > 1 ? 's' : ''}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={ingestBusy}
                                  onClick={() => void vincular(p.path)}
                                  className="h-8 shrink-0 text-[11px]"
                                >
                                  É esta câmera
                                </Button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      <Separator />
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[10px] leading-relaxed text-muted-foreground">
                          A chave é uma senha de publicação. Troque se vazar ou ao trocar o equipamento —
                          a anterior para de valer na hora.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={ingestBusy}
                          onClick={() => void ativarPush(true)}
                          className="h-8 shrink-0 gap-1.5 text-[11px]"
                        >
                          <RefreshCw className={cn('h-3 w-3', ingestBusy && 'animate-spin')} />
                          Trocar chave
                        </Button>
                      </div>
                      <p className="text-[10px] leading-relaxed text-amber-500/90">
                        O RTMP transporta H.264. Equipamento que só sai em H.265 não serve para este modo.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <FormField label="Endereço IP" required>
                          <Input value={form.ip} onChange={(e) => upd('ip', e.target.value)} className="text-sm font-mono" />
                        </FormField>
                        <FormField label="Porta RTSP">
                          <Input value={form.rtspPort} onChange={(e) => upd('rtspPort', e.target.value)} className="text-sm font-mono" />
                        </FormField>
                        <FormField label="Usuário">
                          <Input placeholder="admin" value={form.username} onChange={(e) => upd('username', e.target.value)} className="text-sm" />
                        </FormField>
                        <FormField label="Senha">
                          <Input type="password" placeholder="Manter atual" value={form.password} onChange={(e) => upd('password', e.target.value)} className="text-sm" />
                        </FormField>
                      </div>
                      <FormField label="Caminho RTSP" hint="vazio = detectar">
                        <Input value={form.rtspPath} onChange={(e) => upd('rtspPath', e.target.value)} placeholder="/live/ch1main" className="text-sm font-mono" />
                      </FormField>
                    </>
                  )}
                </TabsContent>

                {/* STREAM */}
                <TabsContent value="stream" className="px-5 py-4 space-y-4 mt-0">
                  <div className="grid grid-cols-2 gap-3">
                    <FormField label="Codec da live">
                      <Input value="H.264" readOnly className="text-sm font-mono text-muted-foreground" />
                    </FormField>
                    <FormField label="Protocolo ao vivo">
                      <Select value={form.preferredLiveProtocol} onValueChange={(v) => upd('preferredLiveProtocol', v)}>
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {LIVE_PROTOCOLS.filter((p) => p !== 'mjpeg').map((p) => <SelectItem key={p} value={p} className="text-sm uppercase">{p}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField label="Transporte RTSP">
                      <Select value={form.preferredRtspTransport} onValueChange={(v) => upd('preferredRtspTransport', v as 'tcp' | 'udp')}>
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tcp" className="text-sm">TCP</SelectItem>
                          <SelectItem value="udp" className="text-sm">UDP</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                  </div>
                  <div className="rounded-lg border border-border bg-background/70 px-3 py-2 text-[11px] text-muted-foreground">
                    Grid padronizado em até 720p / 20 FPS. Ao abrir a câmera sozinha, o DRAC usa a resolução original do perfil live.
                  </div>
                  <Separator />
                  <ToggleRow label="Áudio" desc="Captura de áudio da câmera" value={form.audioEnabled} onChange={(v) => upd('audioEnabled', v)} />
                </TabsContent>

                {/* GRAVAÇÃO */}
                <TabsContent value="gravacao" className="px-5 py-4 space-y-4 mt-0">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Modo de gravação</p>
                  <div className="space-y-2">
                    {RECORDING_MODES.map((m) => (
                      <button key={m.value} onClick={() => upd('recordingMode', m.value)}
                        className={cn('w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors',
                          form.recordingMode === m.value ? 'border-[hsl(var(--primary)_/_0.5)] bg-[hsl(var(--primary)_/_0.06)]' : 'border-border hover:bg-[hsl(var(--accent))]')}>
                        <div className={cn('w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0',
                          form.recordingMode === m.value ? 'border-[hsl(var(--primary))]' : 'border-muted-foreground/40')}>
                          {form.recordingMode === m.value && <div className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--primary))]" />}
                        </div>
                        <div>
                          <div className="text-[12.5px] font-medium">{m.label}</div>
                          <div className="text-[10px] text-muted-foreground">{m.desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <Separator />
                  <div className="grid grid-cols-2 gap-3">
                    <FormField label="Retenção (dias)">
                      <Input value={form.retentionDays} onChange={(e) => upd('retentionDays', e.target.value)} className="text-sm font-mono" />
                    </FormField>
                    <FormField label="Codec de gravação">
                      <Select value={form.recordingVideoCodec} onValueChange={(v) => upd('recordingVideoCodec', v)}>
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CODECS.map((c) => <SelectItem key={c} value={c} className="text-sm uppercase">{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </FormField>
                  </div>
                </TabsContent>

              </Tabs>

              {/* Avançado + Danger zone */}
              <div className="px-5 pb-5 space-y-4">
                <Separator />
                <button
                  onClick={() => { onClose(); setLocation(`/cameras/${camera.id}?tab=settings`); }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-border hover:bg-[hsl(var(--accent))] transition-colors text-left"
                >
                  <div>
                    <div className="text-[12px] font-medium">Configuração avançada</div>
                    <div className="text-[10px] text-muted-foreground">Teste de conexão, canais, resolução e diagnóstico</div>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                </button>

                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Zona de perigo</p>
                {!confirmDelete ? (
                  <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="w-3.5 h-3.5 mr-2" /> Remover câmera
                  </Button>
                ) : (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-3">
                    <p className="text-[12px] font-medium text-destructive">Remover {camera.name}?</p>
                    <p className="text-[11px] text-muted-foreground">As gravações existentes seguem a política de retenção.</p>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancelar</Button>
                      <Button variant="destructive" size="sm" onClick={() => void handleDelete()}>
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Confirmar
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <SheetFooter className="px-5 py-3 border-t border-border shrink-0 flex-row gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>Cancelar</Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={saving} className="ml-auto min-w-[140px]">
                {saving ? <LoaderCircle className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-2" />}
                Salvar alterações
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function FormField({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
        {hint && <span className="ml-1 text-[10px] font-normal opacity-60">({hint})</span>}
      </Label>
      {children}
    </div>
  );
}

function ToggleRow({ label, desc, value, onChange }: { label: string; desc: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div>
        <div className="text-[12.5px] font-medium">{label}</div>
        <div className="text-[10px] text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Campo somente-leitura com botão de copiar.
 *
 * O instalador está com a câmera aberta noutra aba e precisa transportar estes
 * valores sem errar um caractere — uma chave de 32 hexadecimais digitada à mão
 * é erro garantido. Fonte monoespaçada e botão de copiar, nada além disso.
 */
function CampoCopiavel({
  rotulo,
  valor,
  hint,
  copiado,
  onCopiar,
}: {
  rotulo: string;
  valor: string;
  hint?: string;
  copiado: boolean;
  onCopiar: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">
        {rotulo}
        {hint && <span className="ml-1 text-[10px] font-normal opacity-60">({hint})</span>}
      </Label>
      <div className="flex items-center gap-1.5">
        <Input
          value={valor}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className="h-9 flex-1 text-[11px] font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCopiar}
          disabled={!valor}
          className="h-9 w-9 shrink-0 p-0"
          aria-label={`Copiar ${rotulo}`}
        >
          {copiado ? <Check className="h-3.5 w-3.5 text-[hsl(var(--status-online))]" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
