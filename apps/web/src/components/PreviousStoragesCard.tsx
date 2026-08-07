import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Archive, Eraser, KeyRound, Trash2 } from 'lucide-react';
import { toast } from '../hooks/use-toast';

// ─────────────────────────────────────────────────────────────────────────────
// STORAGES DESTA INSTALAÇÃO — o que recebe agora e os anteriores
//
// Trocar de fornecedor na Central NÃO apaga o storage antigo: o acervo que está
// lá continua sendo lido de onde foi gravado, e o bucket se esvazia sozinho
// conforme a retenção vence. Esta seção existe para quem não quer esperar — e
// para deixar visível que aquele contrato ainda está sendo pago.
//
// Duas operações que PARECEM a mesma e não são, por isso nunca compartilham
// botão:
//
//   ESVAZIAR  apaga os OBJETOS no fornecedor. Irreversível. É como se para de
//             pagar por um bucket que não se usa mais.
//   REMOVER   apaga só o CADASTRO daqui. Os objetos ficam intactos lá.
//
// Trocar uma pela outra é como se perde prova (esvaziar achando que só ia
// descadastrar) ou como se paga por lixo eterno (remover achando que limpou).
// ─────────────────────────────────────────────────────────────────────────────

type Storage = {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  provider: string;
  isActive: boolean;
  credencialLegivel: boolean;
  gravacoes: number;
  bytes: number;
  maisAntiga: string | null;
  maisRecente: string | null;
};

function tamanho(bytes: number): string {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function periodo(de: string | null, ate: string | null): string {
  if (!de || !ate) return '';
  const f = (v: string) => new Date(v).toLocaleDateString('pt-BR');
  const inicio = f(de);
  const fim = f(ate);
  return inicio === fim ? inicio : `${inicio} — ${fim}`;
}

export function PreviousStoragesCard({ apiUrl, accessToken }: { apiUrl: string; accessToken: string | null }) {
  const [storages, setStorages] = useState<Storage[] | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [falhaConsulta, setFalhaConsulta] = useState(false);
  // Qual storage está com a confirmação aberta, e para qual das duas operações.
  const [confirmando, setConfirmando] = useState<{ id: string; acao: 'esvaziar' | 'remover' } | null>(null);
  const [digitado, setDigitado] = useState('');
  const [executando, setExecutando] = useState(false);

  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  const carregar = useCallback(async () => {
    if (!accessToken) return;
    setCarregando(true);
    try {
      const { data } = await axios.get<Storage[]>(`${apiUrl}/cloud-storage/storages`, { headers });
      setStorages(data);
    } catch (erro) {
      // SÓ 404/403 fazem a seção sumir (API antiga/sem permissão). Em qualquer
      // outra falha a lista sumia sem deixar rastro — e com ela o contrato
      // antigo que ainda se paga e o acervo que só existe lá.
      const codigo = axios.isAxiosError(erro) ? erro.response?.status : undefined;
      setStorages(null);
      setFalhaConsulta(!(codigo === 404 || codigo === 403));
    } finally {
      setCarregando(false);
    }
  }, [accessToken, apiUrl]);

  useEffect(() => { void carregar(); }, [carregar]);

  const fecharConfirmacao = () => { setConfirmando(null); setDigitado(''); };

  const esvaziar = async (s: Storage) => {
    setExecutando(true);
    try {
      const { data } = await axios.post(
        `${apiUrl}/cloud-storage/storages/${s.id}/purge`,
        { confirmacao: digitado },
        { headers },
      );
      toast({
        title: `${s.bucket} esvaziado`,
        description:
          `${data.objetosApagados} objetos apagados (${tamanho(data.bytesLiberados)}); ` +
          `${data.gravacoesAfetadas} gravações perderam a cópia na nuvem` +
          (data.falhas ? `. ${data.falhas} objetos resistiram e continuam lá.` : '.'),
      });
      fecharConfirmacao();
      await carregar();
    } catch (erro) {
      toast({
        title: 'Não foi possível esvaziar',
        description: axios.isAxiosError(erro) ? String(erro.response?.data?.message ?? erro.message) : undefined,
        variant: 'destructive',
      });
    } finally {
      setExecutando(false);
    }
  };

  const remover = async (s: Storage, forcar: boolean) => {
    setExecutando(true);
    try {
      const { data } = await axios.delete(
        `${apiUrl}/cloud-storage/storages/${s.id}${forcar ? '?forcar=1' : ''}`,
        { headers },
      );
      toast({
        title: `Cadastro de ${s.bucket} removido`,
        description: data.gravacoesOrfas
          ? `${data.gravacoesOrfas} gravações ficaram sem destino conhecido. Os arquivos continuam no fornecedor.`
          : 'Nenhum objeto foi tocado no fornecedor.',
      });
      fecharConfirmacao();
      await carregar();
    } catch (erro) {
      toast({
        title: 'Não foi possível remover',
        description: axios.isAxiosError(erro) ? String(erro.response?.data?.message ?? erro.message) : undefined,
        variant: 'destructive',
      });
    } finally {
      setExecutando(false);
    }
  };

  if (falhaConsulta) {
    return (
      <div className="p-5 text-sm">
        <div className="font-medium text-[hsl(var(--destructive))]">
          Não foi possível listar os armazenamentos anteriores
        </div>
        <p className="mt-1 text-muted-foreground">
          Eles continuam cadastrados — o sistema só não conseguiu consultar agora.
        </p>
        <button type="button" onClick={() => void carregar()} className="btn btn-secondary btn-sm mt-3">
          Tentar novamente
        </button>
      </div>
    );
  }
  if (carregando || !storages) return null;

  // O ativo entra na lista também, sem os botões destrutivos: ver para onde as
  // gravações estão indo agora, ao lado dos anteriores, é o que dá contexto à
  // decisão de esvaziar ou remover. Ativo primeiro — o servidor já ordena.
  if (storages.length === 0) return null;

  return (
    <div className="space-y-3 p-5">
      <div className="flex items-start gap-3">
        <Archive className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div className="text-sm">
          <div className="font-medium">Storages desta instalação</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Trocar de fornecedor não apaga o anterior: o acervo continua sendo lido de onde foi
            gravado e se esvazia sozinho conforme a retenção vence. O que está abaixo é para
            quem não quer esperar de graça por um contrato que já não se usa.
          </p>
        </div>
      </div>

      {storages.map((s) => {
        const aberto = confirmando?.id === s.id;
        return (
          <div key={s.id} className="rounded border border-border p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{s.name}</span>
                  {s.isActive && (
                    <span className="rounded-full border border-[hsl(var(--status-online)_/_0.4)] px-2 py-0.5 text-[10px] text-[hsl(var(--status-online))]">
                      Recebendo agora
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {s.endpoint}/{s.bucket}{s.prefix ? `/${s.prefix}` : ''}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {s.gravacoes > 0
                    ? <>{s.gravacoes} gravações · {tamanho(s.bytes)} · {periodo(s.maisAntiga, s.maisRecente)}</>
                    : 'Nenhuma gravação do AjustCam aponta para este storage.'}
                </div>
                {!s.credencialLegivel && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-[hsl(var(--status-warning))]">
                    <KeyRound className="h-3.5 w-3.5" />
                    Credencial ilegível — não há como apagar objetos aqui.
                  </div>
                )}
              </div>

              {!aberto && (
                <div className="flex flex-wrap justify-end gap-2">
                  {/* O ativo não recebe os botões destrutivos: está gravando
                      neste instante, e o servidor recusaria os dois. Mostrar
                      botão que só produz erro é pior que não mostrar. */}
                  {!s.isActive && (
                    <>
                      <button
                        type="button"
                        disabled={!s.credencialLegivel}
                        onClick={() => { setConfirmando({ id: s.id, acao: 'esvaziar' }); setDigitado(''); }}
                        className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs hover:bg-accent/45 disabled:opacity-40"
                        title="Apaga os arquivos no fornecedor"
                      >
                        <Eraser className="h-3.5 w-3.5" /> Esvaziar
                      </button>
                      <button
                        type="button"
                        onClick={() => { setConfirmando({ id: s.id, acao: 'remover' }); setDigitado(''); }}
                        className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs hover:bg-accent/45"
                        title="Tira daqui sem apagar nada lá"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Remover cadastro
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* A confirmação diz o que vai acontecer com ESTE storage, com os
                números dele. Um "tem certeza?" genérico não informa nada. */}
            {aberto && confirmando.acao === 'esvaziar' && (
              <div className="mt-3 rounded border border-[hsl(var(--status-critical)_/_0.4)] bg-[hsl(var(--status-critical)_/_0.08)] p-3">
                <div className="text-sm font-medium text-[hsl(var(--status-critical))]">
                  Apagar os arquivos em {s.bucket}
                </div>
                <p className="mt-1 text-xs">
                  Os objetos serão apagados no fornecedor e não há como desfazer.
                  {s.gravacoes > 0 && <> <b>{s.gravacoes} gravações</b> ({tamanho(s.bytes)}) perderão a cópia na nuvem;
                    as que não tiverem mais arquivo local ficarão indisponíveis.</>}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Para confirmar, digite o nome do bucket: <span className="font-mono font-medium">{s.bucket}</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    autoFocus
                    value={digitado}
                    onChange={(e) => setDigitado(e.target.value)}
                    placeholder={s.bucket}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs"
                  />
                  <button
                    type="button"
                    disabled={executando || digitado !== s.bucket}
                    onClick={() => void esvaziar(s)}
                    className="rounded bg-[hsl(var(--status-critical))] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    {executando ? 'Apagando…' : 'Apagar definitivamente'}
                  </button>
                  <button type="button" onClick={fecharConfirmacao} className="rounded border border-border px-3 py-1.5 text-xs">
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {aberto && confirmando.acao === 'remover' && (
              <div className="mt-3 rounded border border-border bg-background/55 p-3">
                <div className="text-sm font-medium">Remover o cadastro de {s.bucket}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Nenhum arquivo é apagado no fornecedor — só o AjustCam deixa de conhecer este storage.
                </p>
                {s.gravacoes > 0 && (
                  <p className="mt-2 text-xs text-[hsl(var(--status-warning))]">
                    Ainda há <b>{s.gravacoes} gravações</b> aqui. Sem o cadastro não há credencial, e elas
                    ficarão inalcançáveis pela tela. Esvazie antes, ou confirme abaixo que aceita perder o acesso.
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={executando}
                    onClick={() => void remover(s, s.gravacoes > 0)}
                    className="rounded border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent/45 disabled:opacity-40"
                  >
                    {executando ? 'Removendo…' : s.gravacoes > 0 ? 'Remover mesmo assim' : 'Remover cadastro'}
                  </button>
                  <button type="button" onClick={fecharConfirmacao} className="rounded border border-border px-3 py-1.5 text-xs">
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default PreviousStoragesCard;
