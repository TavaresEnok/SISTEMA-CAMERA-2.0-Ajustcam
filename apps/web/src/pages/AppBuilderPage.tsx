/**
 * AppBuilderPage — Central white-label: cadastra clientes e gera o APK de cada
 * um (1 app por cliente, com logo/servidor próprios). Fala com /app-builder na
 * API, que faz proxy para o agente de build no host.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';

const API_URL = getApiBaseUrl();

interface ClientInfo {
  slug: string;
  appName: string;
  apiUrl: string;
  packageId: string;
  primaryColor: string | null;
  hasLogo: boolean;
  apkExists: boolean;
  apkUrl: string | null;
  lastBuild: { status: string; version: string | null; finishedAt: string | null } | null;
}

interface BuildJob {
  id: string;
  slug: string;
  status: 'queued' | 'building' | 'done' | 'failed';
  version?: string | null;
  url?: string | null;
  error?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Na fila', building: 'Buildando…', done: 'Pronto', failed: 'Falhou',
};

export default function AppBuilderPage() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${accessToken}` }), [accessToken]);

  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [jobs, setJobs] = useState<BuildJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ slug: '', appName: '', apiUrl: '', packageId: '', primaryColor: '#3b82f6', logoBase64: '' });
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [c, b] = await Promise.all([
        axios.get(`${API_URL}/app-builder/clients`, { headers: authHeaders }),
        axios.get(`${API_URL}/app-builder/builds`, { headers: authHeaders }),
      ]);
      setClients(c.data.clients ?? []);
      setJobs(b.data.jobs ?? []);
    } catch (e) {
      const msg = axios.isAxiosError(e) ? e.response?.data?.error ?? e.message : 'Erro ao carregar';
      toast({ title: 'Falha ao carregar', description: String(msg), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => { void reload(); }, [reload]);

  // Revalida enquanto houver build em andamento.
  useEffect(() => {
    const active = jobs.some((j) => j.status === 'queued' || j.status === 'building');
    if (!active) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [jobs, reload]);

  const onLogo = (file: File | undefined) => {
    if (!file) { setForm((f) => ({ ...f, logoBase64: '' })); return; }
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, logoBase64: String(reader.result) }));
    reader.readAsDataURL(file);
  };

  const createClient = async () => {
    if (!form.slug || !form.appName || !form.apiUrl) {
      toast({ title: 'Campos obrigatórios', description: 'Preencha identificador, nome e servidor.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await axios.post(`${API_URL}/app-builder/clients`, form, { headers: authHeaders });
      toast({ title: 'Cliente salvo', description: `${form.appName} pronto para gerar o APK.` });
      setForm({ slug: '', appName: '', apiUrl: '', packageId: '', primaryColor: '#3b82f6', logoBase64: '' });
      await reload();
    } catch (e) {
      const msg = axios.isAxiosError(e) ? e.response?.data?.error ?? e.message : 'Erro';
      toast({ title: 'Falha ao salvar', description: String(msg), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const build = async (slug: string) => {
    try {
      await axios.post(`${API_URL}/app-builder/clients/${slug}/build`, {}, { headers: authHeaders });
      toast({ title: 'Build iniciado', description: `Gerando o APK de ${slug}. Acompanhe o status.` });
      await reload();
    } catch (e) {
      const msg = axios.isAxiosError(e) ? e.response?.data?.error ?? e.message : 'Erro';
      toast({ title: 'Falha ao iniciar build', description: String(msg), variant: 'destructive' });
    }
  };

  const jobFor = (slug: string) => jobs.find((j) => j.slug === slug);

  return (
    // CONTRATO DE ROLAGEM: o casco (AppLayout) é `overflow-hidden` e cada
    // página fornece a própria rolagem. Sem `h-full overflow-y-auto`, o
    // formulário de novo cliente mais 3–4 clientes cadastrados já cortavam a
    // lista — e os botões "Gerar APK" ficavam inalcançáveis.
    <div className="h-full overflow-y-auto">
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Apps white-label</h1>
        <p className="text-sm text-muted-foreground">Cadastre um cliente e gere o APK com a logo e o servidor dele.</p>
      </div>

      {/* Novo cliente */}
      <div className="rounded-xl border p-5 space-y-4">
        <h2 className="font-semibold">Novo cliente</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Identificador (slug)" hint="a-z, 0-9, hífen (ex: acme)">
            <input className="input" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))} placeholder="acme" />
          </Field>
          <Field label="Nome do app">
            <input className="input" value={form.appName} onChange={(e) => setForm((f) => ({ ...f, appName: e.target.value }))} placeholder="Acme VMS" />
          </Field>
          <Field label="Servidor (URL da API)">
            <input className="input" value={form.apiUrl} onChange={(e) => setForm((f) => ({ ...f, apiUrl: e.target.value }))} placeholder="http://1.2.3.4:5173/api" />
          </Field>
          <Field label="Package ID (opcional)" hint="default: com.ajustconsulting.drac<slug>">
            <input className="input" value={form.packageId} onChange={(e) => setForm((f) => ({ ...f, packageId: e.target.value }))} placeholder="com.ajustconsulting.dracacme" />
          </Field>
          <Field label="Cor de destaque">
            <input type="color" className="h-10 w-20 rounded border" value={form.primaryColor} onChange={(e) => setForm((f) => ({ ...f, primaryColor: e.target.value }))} />
          </Field>
          <Field label="Logo (PNG)">
            <input type="file" accept="image/png" onChange={(e) => onLogo(e.target.files?.[0])} />
          </Field>
        </div>
        <button className="btn btn-primary" disabled={saving} onClick={() => void createClient()}>
          {saving ? 'Salvando…' : 'Salvar cliente'}
        </button>
      </div>

      {/* Lista de clientes */}
      <div className="space-y-3">
        <h2 className="font-semibold">Clientes ({clients.length})</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum cliente cadastrado ainda.</p>
        ) : clients.map((c) => {
          const job = jobFor(c.slug);
          const building = job?.status === 'queued' || job?.status === 'building';
          return (
            <div key={c.slug} className="rounded-xl border p-4 flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg" style={{ backgroundColor: c.primaryColor ?? '#3b82f6' }} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{c.appName} <span className="text-xs text-muted-foreground">· {c.slug}</span></div>
                <div className="text-xs text-muted-foreground truncate">{c.packageId} · {c.apiUrl}</div>
                {job ? (
                  <div className={`text-xs mt-1 ${job.status === 'failed' ? 'text-red-500' : job.status === 'done' ? 'text-green-600' : 'text-amber-600'}`}>
                    {STATUS_LABEL[job.status] ?? job.status}{job.version ? ` · v${job.version}` : ''}{job.error ? ` · ${job.error}` : ''}
                  </div>
                ) : null}
              </div>
              {c.apkUrl ? (
                <a className="btn btn-ghost" href={c.apkUrl} target="_blank" rel="noreferrer">Baixar APK</a>
              ) : null}
              <button className="btn btn-primary" disabled={building} onClick={() => void build(c.slug)}>
                {building ? 'Gerando…' : c.apkExists ? 'Rebuild' : 'Gerar APK'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
