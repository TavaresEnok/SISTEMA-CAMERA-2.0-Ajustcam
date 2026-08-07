import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Brain, Check, Info, Loader2, RefreshCw, Square, SquareDashed } from 'lucide-react';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';
import { getRequestErrorMessage } from '../lib/request-error';
import { useAiPreferencesStore } from '../store/aiPreferencesStore';

const API_URL = getApiBaseUrl();

type AiSettings = {
  enabled: boolean;
  mode: string;
  showObjectBox?: boolean;
};

type EscopoDaCamera = {
  cameraId: string;
  nome: string;
  roda: boolean;
  explicacao: string;
  objectMode: 'auto' | 'sempre' | 'nunca';
  temLinha: boolean;
};

/**
 * Página de IA da instalação.
 *
 * A divisão que orienta esta tela: a CENTRAL decide O QUE pode ser detectado
 * (quais classes de objeto — é escopo comercial, e cada classe custa CPU no
 * servidor do cliente); a INSTALAÇÃO decide ONDE vale a pena pagar por isso e
 * COMO aparece na tela.
 *
 * Por isso aqui não existe seleção de classes: mostrar uma lista que o
 * operador não pode alterar seria pior que não mostrar — ele tentaria mudar e
 * não conseguiria. O que a tela faz é EXPLICAR o que está liberado e por quê
 * cada câmera roda ou não.
 */
export default function AiPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const client = useMemo(
    () => axios.create({ baseURL: API_URL, headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined, timeout: 20000 }),
    [accessToken],
  );

  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [classes, setClasses] = useState<string[]>([]);
  const [escopo, setEscopo] = useState<EscopoDaCamera[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [cfg, esc] = await Promise.all([
        client.get<AiSettings>('/ai/settings'),
        client.get<{ classes: string[]; cameras: EscopoDaCamera[] }>('/ai/escopo-objeto'),
      ]);
      setSettings(cfg.data);
      setClasses(Array.isArray(esc.data?.classes) ? esc.data.classes : []);
      setEscopo(Array.isArray(esc.data?.cameras) ? esc.data.cameras : []);
      setErro(null);
    } catch (e) {
      // Não zera o que já está na tela: cair no estado vazio faria o operador
      // achar que a IA foi desconfigurada, quando só a rede falhou.
      setErro(getRequestErrorMessage(e, 'Não foi possível carregar as configurações de IA.'));
    } finally {
      setCarregando(false);
    }
  }, [client]);

  useEffect(() => { void carregar(); }, [carregar]);

  const alternarCaixa = useCallback(async (valor: boolean) => {
    setSalvando(true);
    setSettings((s) => (s ? { ...s, showObjectBox: valor } : s));
    // Reflete no Ao Vivo imediatamente, sem esperar o próximo carregamento.
    useAiPreferencesStore.getState().definirCaixa(valor);
    try {
      await client.patch('/ai/settings', { showObjectBox: valor });
      toast({ title: valor ? 'Marcação ligada' : 'Marcação desligada', description: 'A mudança aparece no Ao Vivo em alguns segundos.' });
    } catch (e) {
      setSettings((s) => (s ? { ...s, showObjectBox: !valor } : s));
      useAiPreferencesStore.getState().definirCaixa(!valor);
      toast({ title: 'Não foi possível salvar', description: getRequestErrorMessage(e, 'Falha ao salvar a preferência.'), variant: 'destructive' });
    } finally {
      setSalvando(false);
    }
  }, [client]);

  const mudarModo = useCallback(async (cameraId: string, objectMode: EscopoDaCamera['objectMode']) => {
    setEscopo((atual) => atual.map((c) => (c.cameraId === cameraId ? { ...c, objectMode } : c)));
    try {
      await client.patch(`/cameras/${cameraId}`, { objectMode });
      await carregar();
    } catch (e) {
      toast({ title: 'Não foi possível salvar', description: getRequestErrorMessage(e, 'Falha ao mudar o modo.'), variant: 'destructive' });
      await carregar();
    }
  }, [client, carregar]);

  const rodando = escopo.filter((c) => c.roda).length;
  const objetoLiberado = classes.length > 0;
  const mostrarCaixa = settings?.showObjectBox !== false;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="page-hdr">
        <div>
          <h1 className="page-title">Inteligência artificial</h1>
          <p className="page-sub">
            {objetoLiberado
              ? `Detecção de objeto liberada para ${classes.length} tipo(s) · ${rodando} de ${escopo.length} câmera(s) usando.`
              : 'Detecção de objeto não liberada para esta instalação.'}
          </p>
        </div>
        <button type="button" onClick={() => void carregar()} className="btn btn-secondary btn-sm" disabled={carregando}>
          {carregando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Atualizar
        </button>
      </div>

      {erro && (
        <div className="mx-4 mt-3 rounded-lg border border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.08)] px-3 py-2 text-xs text-[hsl(var(--destructive))]">
          {erro}
        </div>
      )}

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">Onde a detecção de objeto roda</h2>
            <p className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">
              A detecção de objeto é cara. Por padrão ela liga sozinha nas câmeras que têm{' '}
              <strong className="font-medium">linha de perímetro desenhada</strong> — desenhar a linha já é o pedido.
            </p>
          </div>

          {!escopo.length ? (
            <div className="px-4 py-8 text-center text-xs text-[hsl(var(--muted-foreground))]">
              {carregando ? 'Carregando…' : 'Nenhuma câmera cadastrada.'}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {escopo.map((cam) => (
                <div key={cam.cameraId} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${cam.roda ? 'bg-[hsl(var(--status-online))]' : 'bg-[hsl(var(--muted-foreground)_/_0.4)]'}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{cam.nome}</div>
                    <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{cam.explicacao}</div>
                  </div>
                  <select
                    value={cam.objectMode}
                    onChange={(e) => void mudarModo(cam.cameraId, e.target.value as EscopoDaCamera['objectMode'])}
                    disabled={!objetoLiberado}
                    className="h-7 rounded border border-border bg-background px-2 text-[11px] disabled:opacity-45"
                    aria-label={`Modo de detecção de objeto da câmera ${cam.nome}`}
                  >
                    <option value="auto">Automático (com linha)</option>
                    <option value="sempre">Sempre ligado</option>
                    <option value="nunca">Nunca</option>
                  </select>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="space-y-4">
          <section className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">Exibição no Ao Vivo</h2>
            </div>
            <div className="px-4 py-3">
              <button
                type="button"
                onClick={() => void alternarCaixa(!mostrarCaixa)}
                disabled={salvando || !settings}
                className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left hover:bg-[hsl(var(--accent))] disabled:opacity-45"
                aria-pressed={mostrarCaixa}
              >
                {mostrarCaixa
                  ? <Square className="h-4 w-4 shrink-0 text-[hsl(var(--primary))]" aria-hidden />
                  : <SquareDashed className="h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground))]" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">Mostrar quadrado no objeto</span>
                  <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                    {mostrarCaixa ? 'A marcação aparece sobre o vídeo.' : 'O vídeo aparece limpo, sem marcação.'}
                  </span>
                </span>
                {mostrarCaixa && <Check className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--primary))]" aria-hidden />}
              </button>
              <p className="mt-2 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                Só muda o que é desenhado na tela — a detecção continua igual, e os eventos seguem sendo registrados.
              </p>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                <Brain className="h-3.5 w-3.5" aria-hidden />
                O que pode ser detectado
              </h2>
            </div>
            <div className="px-4 py-3">
              {objetoLiberado ? (
                <div className="flex flex-wrap gap-1.5">
                  {classes.map((c) => (
                    <span key={c} className="rounded-full border border-border px-2.5 py-1 text-[11px]">
                      {NOME_DA_CLASSE[c] ?? c}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                  Nenhum tipo de objeto liberado. Só a detecção de movimento está ativa.
                </p>
              )}
              {/* Explicar POR QUE isto não é editável aqui evita a frustração de
                  procurar o botão que não existe. */}
              <div className="mt-3 flex gap-2 rounded-md bg-[hsl(var(--muted)_/_0.4)] px-2.5 py-2">
                <Info className="mt-0.5 h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" aria-hidden />
                <p className="text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                  Esta lista é definida pelo provedor do sistema, no painel central — cada tipo a mais
                  consome processamento deste servidor. Para alterá-la, fale com o suporte.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const NOME_DA_CLASSE: Record<string, string> = {
  person: 'Pessoa',
  car: 'Carro',
  motorcycle: 'Moto',
  bus: 'Ônibus',
  truck: 'Caminhão',
  bicycle: 'Bicicleta',
  dog: 'Cachorro',
  cat: 'Gato',
};
