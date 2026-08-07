import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Cloud, CloudOff, Upload, RefreshCw } from 'lucide-react';
import { toast } from '../hooks/use-toast';

// ─────────────────────────────────────────────────────────────────────────────
// ARMAZENAMENTO EM NUVEM — o que a instalação decide.
//
// Separação que a tela precisa deixar óbvia: a Central PROVISIONA o bucket
// (infraestrutura contratada pelo revendedor) e a INSTALAÇÃO decide o que
// mandar para lá (operação). Por isso aqui não há campo de endpoint nem
// credencial: só os interruptores.
//
// Ter bucket configurado NÃO liga o envio. O interruptor mestre nasce
// desligado, porque começar a subir vídeo sozinho geraria custo que ninguém
// pediu — e é dinheiro do cliente final.
// ─────────────────────────────────────────────────────────────────────────────

type CloudStatus =
  | { enabled: false }
  | {
    enabled: true;
    provider: string;
    mode: 'tier' | 'mount';
    bucket: string;
    endpoint: string;
    prefix: string;
    localWindowHours: number;
    recordingsInCloud: number;
    recordingsPendingUpload: number;
    recordingsCloudOnly: number;
    updatedAt: string | null;
  };

type Policy = {
  enabled: boolean;
  triggerModes: { continuous: boolean; motion: boolean; manual: boolean };
  keepLocalCopy: boolean;
};

const TIPOS: Array<{ key: keyof Policy['triggerModes']; nome: string; ajuda: string }> = [
  { key: 'motion', nome: 'Gravação por movimento', ajuda: 'É a que costuma virar prova. Volume baixo, valor alto.' },
  { key: 'continuous', nome: 'Gravação contínua', ajuda: 'Volume ALTO — 24h por câmera, boa parte de cena vazia. Pesa na conta da nuvem.' },
  { key: 'manual', nome: 'Gravação manual', ajuda: 'Iniciada por um operador. Costuma ter motivo específico.' },
];

export function CloudStorageCard({ apiUrl, accessToken }: { apiUrl: string; accessToken: string | null }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [falhaConsulta, setFalhaConsulta] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  const carregar = useCallback(async () => {
    if (!accessToken) return;
    setCarregando(true);
    try {
      const [s, p] = await Promise.all([
        axios.get<CloudStatus>(`${apiUrl}/cloud-storage/status`, { headers }),
        axios.get<Policy>(`${apiUrl}/cloud-storage/policy`, { headers }),
      ]);
      setStatus(s.data);
      setPolicy(p.data);
      setFalhaConsulta(false);
    } catch (erro) {
      // SÓ 404/403 significam "não instalado" (API antiga ou sem permissão) —
      // aí a seção some, que é o comportamento desejado. Qualquer OUTRO erro
      // (500, timeout, rede) é "não consegui perguntar", e afirmar "Nenhum
      // armazenamento em nuvem instalado" nesse caso é a mensagem mais
      // perigosa possível numa instalação que já perdeu acervo para um
      // fornecedor.
      const codigo = axios.isAxiosError(erro) ? erro.response?.status : undefined;
      const naoInstalado = codigo === 404 || codigo === 403;
      setStatus(null);
      setFalhaConsulta(!naoInstalado);
    } finally {
      setCarregando(false);
    }
  }, [accessToken, apiUrl]);

  useEffect(() => { void carregar(); }, [carregar]);

  const salvar = async (proxima: Policy) => {
    setSalvando(true);
    // Otimista: o toggle responde na hora. Se o servidor recusar, recarregamos
    // e a tela volta para a verdade — que é sempre a do servidor.
    setPolicy(proxima);
    try {
      const { data } = await axios.put<Policy>(`${apiUrl}/cloud-storage/policy`, { policy: proxima }, { headers });
      setPolicy(data);
      toast({ title: 'Política de armazenamento salva' });
    } catch {
      toast({ title: 'Não foi possível salvar', variant: 'destructive' });
      void carregar();
    } finally {
      setSalvando(false);
    }
  };

  const enviarAgora = async () => {
    setEnviando(true);
    try {
      const { data } = await axios.post(`${apiUrl}/cloud-storage/offload/run`, {}, { headers });
      toast({
        title: data?.skipped ? 'Nada a enviar' : `${data.uploaded} gravação(ões) enviada(s)`,
        description: data?.reason ?? (data?.deletedLocal ? `${data.deletedLocal} liberada(s) do disco local.` : undefined),
      });
      await carregar();
    } catch {
      toast({ title: 'Falha ao enviar', variant: 'destructive' });
    } finally {
      setEnviando(false);
    }
  };

  if (carregando) {
    return <div className="p-5 text-sm text-muted-foreground">Carregando armazenamento em nuvem…</div>;
  }

  // Falhou a CONSULTA (não é "não instalado"): dizer isso, com saída. Afirmar
  // "nenhum armazenamento instalado" quando não se conseguiu perguntar levaria
  // o operador a concluir que o acervo na nuvem não existe.
  if (falhaConsulta) {
    return (
      <div className="flex items-start gap-3 p-5">
        <CloudOff className="mt-0.5 h-5 w-5 text-[hsl(var(--destructive))]" />
        <div className="text-sm">
          <div className="font-medium text-[hsl(var(--destructive))]">
            Não foi possível consultar o armazenamento em nuvem
          </div>
          <p className="mt-1 text-muted-foreground">
            Isto NÃO quer dizer que não há nuvem configurada — o sistema só não conseguiu falar com a
            API agora. As gravações já enviadas continuam onde estão.
          </p>
          <button type="button" onClick={() => void carregar()} className="btn btn-secondary btn-sm mt-3">
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  // Sem storage provisionado pela Central: explica o caminho em vez de sumir.
  if (!status || status.enabled === false) {
    return (
      <div className="flex items-start gap-3 p-5">
        <CloudOff className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div className="text-sm">
          <div className="font-medium">Nenhum armazenamento em nuvem instalado</div>
          <p className="mt-1 text-muted-foreground">
            O bucket é provisionado pela Central AjustCam, na aba
            <span className="font-medium"> Armazenamento em nuvem</span> desta instalação.
            Depois de instalado, os controles de envio aparecem aqui.
          </p>
        </div>
      </div>
    );
  }

  const p = policy ?? { enabled: false, triggerModes: { continuous: false, motion: true, manual: true }, keepLocalCopy: false };
  const nenhumTipo = !p.triggerModes.continuous && !p.triggerModes.motion && !p.triggerModes.manual;

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Cloud className="h-5 w-5 text-[hsl(var(--status-online))]" />
          <div>
            <div className="text-sm font-medium">
              {status.provider} · {status.bucket}
            </div>
            <div className="text-xs text-muted-foreground">
              {/* "antes de enviar" MENTIA: o envio acontece assim que o segmento
                  fecha (job a cada 15min); a janela controla por quanto tempo a
                  cópia local sobrevive DEPOIS do upload confirmado. */}
              {status.mode === 'tier'
                ? `Camada — envia ao fechar e mantém ${status.localWindowHours}h no disco local`
                : 'Direto — envia ao fechar e apaga o local assim que confirma'}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void carregar()}
          className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs hover:bg-accent/45"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Atualizar
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded border border-border bg-background/55 p-3">
          <div className="text-[11px] text-muted-foreground">Na nuvem</div>
          <div className="text-lg font-semibold">{status.recordingsInCloud}</div>
        </div>
        <div className="rounded border border-border bg-background/55 p-3">
          <div className="text-[11px] text-muted-foreground">Aguardando envio</div>
          <div className="text-lg font-semibold">{status.recordingsPendingUpload}</div>
        </div>
        <div className="rounded border border-border bg-background/55 p-3">
          <div className="text-[11px] text-muted-foreground">Só na nuvem</div>
          <div className="text-lg font-semibold">{status.recordingsCloudOnly}</div>
        </div>
      </div>

      {/* Interruptor mestre. Deixar explícito que instalar ≠ enviar. */}
      <label className="flex cursor-pointer items-start gap-3 rounded border border-border p-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={p.enabled}
          disabled={salvando}
          onChange={(e) => void salvar({ ...p, enabled: e.target.checked })}
        />
        <span className="text-sm">
          <span className="font-medium">Enviar gravações para a nuvem</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Desligado, tudo permanece apenas no disco local. Instalar o storage não liga o envio sozinho.
          </span>
        </span>
      </label>

      {p.enabled && (
        <>
          <div className="rounded border border-border p-3">
            <div className="mb-2 text-sm font-medium">Quais gravações vão para a nuvem</div>
            <div className="space-y-2">
              {TIPOS.map((tipo) => (
                <label key={tipo.key} className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={p.triggerModes[tipo.key]}
                    disabled={salvando}
                    onChange={(e) => void salvar({
                      ...p,
                      triggerModes: { ...p.triggerModes, [tipo.key]: e.target.checked },
                    })}
                  />
                  <span className="text-sm">
                    {tipo.nome}
                    <span className="mt-0.5 block text-xs text-muted-foreground">{tipo.ajuda}</span>
                  </span>
                </label>
              ))}
            </div>
            {nenhumTipo && (
              // Ligado sem tipo é um estado que confunde: parece configurado e
              // não envia nada. Precisa ser dito, não descoberto.
              <div className="mt-2 rounded bg-[hsl(var(--status-warning)_/_0.12)] px-2.5 py-2 text-xs text-[hsl(var(--status-warning))]">
                Nenhum tipo selecionado — nada será enviado.
              </div>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded border border-border p-3">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={p.keepLocalCopy}
              disabled={salvando}
              onChange={(e) => void salvar({ ...p, keepLocalCopy: e.target.checked })}
            />
            <span className="text-sm">
              <span className="font-medium">Manter cópia local (modo backup)</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Ligado: a nuvem é cópia de segurança e o disco local NÃO é liberado.
                Desligado: o arquivo local é removido após {status.localWindowHours}h, liberando disco.
              </span>
            </span>
          </label>

          <button
            type="button"
            onClick={() => void enviarAgora()}
            disabled={enviando || nenhumTipo}
            className="flex items-center gap-2 rounded border border-border px-3 py-2 text-sm hover:bg-accent/45 disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            {enviando ? 'Enviando…' : 'Enviar agora o que está pendente'}
          </button>
        </>
      )}
    </div>
  );
}

export default CloudStorageCard;
