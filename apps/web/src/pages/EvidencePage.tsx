import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import { CheckCircle2, Clock3, FileArchive, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';

type Investigation = { id: string; title: string; status: string };
type ExportItem = {
  id: string;
  type: 'export_request' | 'export_package' | string;
  label: string;
  notes?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
};
type VerifyResult = {
  ok: boolean;
  hashValid: boolean;
  signatureValid: boolean;
  details?: string[];
};

const API_URL = getApiBaseUrl();

function authHeaders(accessToken: string | null) {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
}

export default function EvidencePage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const client = useMemo(() => axios.create({ baseURL: API_URL, headers: authHeaders(accessToken) }), [accessToken]);

  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [investigationId, setInvestigationId] = useState('');
  const [exportsList, setExportsList] = useState<ExportItem[]>([]);
  const [reason, setReason] = useState('');
  const [formatType, setFormatType] = useState<'MP4' | 'AVI' | 'NATIVE'>('MP4');
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const load = async (targetId?: string) => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const inv = await client.get<{ items: Investigation[] }>('/investigations');
      const items = Array.isArray(inv.data.items) ? inv.data.items : [];
      setInvestigations(items);
      const active = targetId || investigationId || items[0]?.id || '';
      if (active) {
        setInvestigationId(active);
        const exp = await client.get<{ items: ExportItem[] }>(`/investigations/${active}/exports`);
        setExportsList(Array.isArray(exp.data.items) ? exp.data.items : []);
      } else {
        setExportsList([]);
      }
    } catch (error) {
      toast({ title: 'Falha ao carregar evidências', description: error instanceof Error ? error.message : 'Erro inesperado', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const requestExport = async () => {
    if (!investigationId) return;
    const clean = reason.trim();
    if (!clean) {
      toast({ title: 'Motivo obrigatório', description: 'Informe o motivo da solicitação.' , variant: 'destructive' });
      return;
    }
    try {
      await client.post(`/investigations/${investigationId}/exports/request`, { reason: clean, format: formatType });
      setReason('');
      await load(investigationId);
      toast({ title: 'Solicitação criada', description: 'Exportação enviada para aprovação.' });
    } catch (error) {
      toast({ title: 'Falha ao solicitar exportação', description: error instanceof Error ? error.message : 'Erro inesperado', variant: 'destructive' });
    }
  };

  // Diálogo de justificativa: um só, reaproveitado pelas três decisões que
  // exigem motivo registrado na cadeia de custódia.
  const [motivoAlvo, setMotivoAlvo] = useState<
    { tipo: 'review'; id: string; decision: 'APPROVED' | 'REJECTED' } | { tipo: 'execute'; id: string } | null
  >(null);
  const [motivoTexto, setMotivoTexto] = useState('');

  const review = async (id: string, decision: 'APPROVED' | 'REJECTED', why: string) => {
    try {
      await client.post(`/investigations/${investigationId}/exports/${id}/review`, { decision, reason: why });
      await load(investigationId);
      toast({ title: decision === 'APPROVED' ? 'Solicitação aprovada' : 'Solicitação rejeitada' });
    } catch (error) {
      toast({ title: 'Falha na revisão', description: error instanceof Error ? error.message : 'Erro inesperado', variant: 'destructive' });
    }
  };

  const execute = async (id: string, why: string) => {
    try {
      await client.post(`/investigations/${investigationId}/exports/${id}/execute`, { reason: why });
      await load(investigationId);
      toast({ title: 'Pacote gerado', description: 'Pacote exportado e assinado com sucesso.' });
    } catch (error) {
      toast({ title: 'Falha ao executar exportação', description: error instanceof Error ? error.message : 'Erro inesperado', variant: 'destructive' });
    }
  };

  const downloadPackage = async (packageItemId: string) => {
    if (!investigationId) return;
    try {
      const response = await client.get(`/investigations/${investigationId}/exports/${packageItemId}/download`, {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `investigation-${investigationId}-package-${packageItemId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: 'Falha no download do pacote', description: error instanceof Error ? error.message : 'Erro inesperado', variant: 'destructive' });
    }
  };

  const verifyPackageFile = async (file: File) => {
    if (!file) return;
    setVerifying(true);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const response = await client.post<VerifyResult>('/evidence/verify', {
        evidencePackage: parsed,
      });
      setVerifyResult(response.data);
      toast({
        title: response.data.ok ? 'Pacote íntegro' : 'Pacote com falha de integridade',
        description: response.data.ok ? 'Hash e assinatura válidos.' : 'Verifique os detalhes de validação.',
        variant: response.data.ok ? 'default' : 'destructive',
      });
    } catch (error) {
      setVerifyResult(null);
      toast({
        title: 'Falha ao verificar pacote',
        description: error instanceof Error ? error.message : 'Arquivo inválido ou erro inesperado',
        variant: 'destructive',
      });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-primary">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Evidências</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">Aprovação, exportação, assinatura e verificação de pacotes.</p>
            </div>
          </div>
          <button onClick={() => void load(investigationId)} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium hover:bg-accent">
            <RefreshCw className="h-3.5 w-3.5" />
            Atualizar
          </button>
        </div>
      </div>

      <div className="grid flex-1 gap-4 overflow-y-auto p-6 md:grid-cols-[340px_1fr]">
        <aside className="h-fit rounded-lg border border-border bg-card p-4 shadow-sm">
          <div>
            <div className="mb-1 text-xs font-medium">Investigação</div>
            <Select value={investigationId || '__none__'} onValueChange={(value) => { if (value !== '__none__') void load(value); }}>
              <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Selecione" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__" className="text-xs">Selecione</SelectItem>
                {investigations.map((inv) => <SelectItem key={inv.id} value={inv.id} className="text-xs">{inv.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="mb-1 text-xs font-medium">Formato</div>
            <Select value={formatType} onValueChange={(v) => setFormatType(v as 'MP4' | 'AVI' | 'NATIVE')}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MP4" className="text-xs">MP4</SelectItem>
                <SelectItem value="AVI" className="text-xs">AVI</SelectItem>
                <SelectItem value="NATIVE" className="text-xs">NATIVE</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="mb-1 text-xs font-medium">Motivo da solicitação</div>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} className="w-full rounded-md border border-border bg-background p-2 text-xs outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30" />
          </div>

          <button onClick={() => void requestExport()} disabled={!investigationId || !reason.trim()} className="h-9 w-full rounded-md bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            Solicitar Exportação
          </button>
          <button
            onClick={async () => {
              if (!investigationId) return;
              setRetrying(true);
              try {
                await client.post(`/investigations/${investigationId}/exports/retry-signatures`);
                await load(investigationId);
                toast({ title: 'Reprocessamento enfileirado' });
              } catch (error) {
                toast({ title: 'Falha no reprocessamento', description: error instanceof Error ? error.message : 'Erro inesperado', variant: 'destructive' });
              } finally {
                setRetrying(false);
              }
            }}
            disabled={!investigationId || retrying}
            className="h-8 w-full rounded-md border border-border text-xs hover:bg-accent disabled:opacity-50"
          >
            {retrying ? 'Enfileirando...' : 'Reprocessar assinaturas pendentes'}
          </button>
          <div className="space-y-2 border-t border-border pt-3">
            <div className="text-xs font-medium">Verificar pacote</div>
            <input
              type="file"
              accept="application/json,.json"
              disabled={verifying}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void verifyPackageFile(file);
                event.currentTarget.value = '';
              }}
              className="block w-full text-[11px] file:mr-2 file:h-7 file:rounded-md file:border file:border-border file:bg-background file:px-2 file:text-[11px]"
            />
            {verifyResult ? (
              <div className={`rounded border p-2 text-[11px] ${verifyResult.ok ? 'border-[hsl(var(--status-online)_/_0.4)] text-[hsl(var(--status-online))]' : 'border-[hsl(var(--destructive)_/_0.4)] text-[hsl(var(--destructive))]'}`}>
                <div className="font-semibold">{verifyResult.ok ? 'Pacote válido' : 'Pacote inválido'}</div>
                <div>Hash: {verifyResult.hashValid ? 'válido' : 'inválido'}</div>
                <div>Assinatura: {verifyResult.signatureValid ? 'válida' : 'inválida'}</div>
                {Array.isArray(verifyResult.details) && verifyResult.details.length > 0 ? (
                  <div className="text-[10px] pt-1 text-[hsl(var(--muted-foreground))]">{verifyResult.details.join(' ')}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </aside>

        <section className="min-h-0 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="text-sm font-semibold">Histórico de exportações</div>
            <div className="text-[11px] text-muted-foreground">{exportsList.length} registro(s)</div>
          </div>
          <div className="max-h-[65vh] overflow-auto divide-y divide-border">
            {loading && <div className="px-4 py-4 text-xs text-[hsl(var(--muted-foreground))]">Carregando...</div>}
            {!loading && exportsList.length === 0 && <div className="px-4 py-4 text-xs text-[hsl(var(--muted-foreground))]">Sem registros de exportação.</div>}
            {exportsList.map((entry) => {
              const meta = (entry.metadata ?? {}) as Record<string, unknown>;
              const status = String(meta.status ?? '').toUpperCase();
              const progress = Number(meta.progress ?? 0);
              return (
                <div key={entry.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold">{entry.label}</div>
                    <div className="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">{format(new Date(entry.createdAt), 'yyyy-MM-dd HH:mm:ss')}</div>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    {entry.type === 'export_package' ? <ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--status-online))]" /> : <Clock3 className="h-3.5 w-3.5 text-[hsl(var(--status-warning))]" />}
                    <span className="font-mono">{entry.type}</span>
                    {status && <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px]">{status}</span>}
                    {Number.isFinite(progress) && progress > 0 ? <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{progress}%</span> : null}
                  </div>
                  {Number.isFinite(progress) && progress > 0 && progress < 100 ? (
                    <div className="h-1.5 overflow-hidden rounded bg-muted">
                      <div className="h-full bg-[hsl(var(--primary))]" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                    </div>
                  ) : null}
                  {entry.notes ? <div className="text-xs text-[hsl(var(--muted-foreground))]">{entry.notes}</div> : null}
                  {entry.type === 'export_request' && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {user?.role === 'admin' && status === 'PENDING' && (
                        <>
                          <button onClick={() => { setMotivoTexto(''); setMotivoAlvo({ tipo: 'review', id: entry.id, decision: 'APPROVED' }); }} className="inline-flex h-7 items-center gap-1 rounded-md border border-[hsl(var(--status-online)_/_0.4)] px-2.5 text-xs text-[hsl(var(--status-online))]"><CheckCircle2 className="h-3.5 w-3.5" /> Aprovar</button>
                          <button onClick={() => { setMotivoTexto(''); setMotivoAlvo({ tipo: 'review', id: entry.id, decision: 'REJECTED' }); }} className="inline-flex h-7 items-center gap-1 rounded-md border border-[hsl(var(--destructive)_/_0.4)] px-2.5 text-xs text-[hsl(var(--destructive))]"><XCircle className="h-3.5 w-3.5" /> Rejeitar</button>
                        </>
                      )}
                      {status === 'APPROVED' && (
                        <button onClick={() => { setMotivoTexto(''); setMotivoAlvo({ tipo: 'execute', id: entry.id }); }} className="inline-flex h-7 items-center gap-1 rounded-md border border-primary/40 px-2.5 text-xs text-primary"><FileArchive className="h-3.5 w-3.5" /> Executar Exportação</button>
                      )}
                    </div>
                  )}
                  {entry.type === 'export_package' && status !== 'PROCESSING' && status !== 'QUEUED' && (
                    <div className="pt-1">
                      <button onClick={() => void downloadPackage(entry.id)} className="inline-flex h-7 items-center gap-1 rounded-md border border-primary/40 px-2.5 text-xs text-primary">
                        <FileArchive className="h-3.5 w-3.5" /> Download Pacote
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
      {/* JUSTIFICATIVA DA CADEIA DE CUSTÓDIA. Vinha de `window.prompt`: caixa
          bloqueável pelo navegador, fora do tema, sem validação, sem revisão do
          texto antes de enviar e sem acessibilidade — inaceitável no registro
          que sustenta a prova. */}
      {motivoAlvo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
            <h2 className="text-sm font-semibold">
              {motivoAlvo.tipo === 'execute'
                ? 'Motivo da execução da exportação'
                : motivoAlvo.decision === 'APPROVED' ? 'Motivo da aprovação' : 'Motivo da rejeição'}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Este texto entra na cadeia de custódia e acompanha o pacote exportado.
            </p>
            <label className="sr-only" htmlFor="motivo-custodia">Motivo</label>
            <textarea
              id="motivo-custodia"
              autoFocus
              rows={3}
              value={motivoTexto}
              onChange={(event) => setMotivoTexto(event.target.value)}
              className="input mt-3 w-full resize-y py-2"
              placeholder="Descreva o motivo (obrigatório)"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setMotivoAlvo(null)} className="btn btn-secondary btn-sm">
                Cancelar
              </button>
              <button
                type="button"
                disabled={!motivoTexto.trim()}
                onClick={() => {
                  const alvo = motivoAlvo;
                  const texto = motivoTexto.trim();
                  setMotivoAlvo(null);
                  if (alvo.tipo === 'execute') void execute(alvo.id, texto);
                  else void review(alvo.id, alvo.decision, texto);
                }}
                className="btn btn-primary btn-sm disabled:opacity-40"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
