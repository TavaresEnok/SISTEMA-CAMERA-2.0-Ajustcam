import { useState } from 'react';
import axios from 'axios';
import { Plus, Copy, Check, Radio, LoaderCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';
import { getApiBaseUrl } from '../lib/api-base';

// ── CADASTRO DE CÂMERA QUE PUBLICA ─────────────────────────────────────────
//
// Por que não é um passo dentro do assistente normal: aquele fluxo existe para
// TESTAR A CONEXÃO — descobre perfis, sonda o stream, mede codec e resolução.
// No modo push não há nada disso para fazer, porque a câmera ainda não falou
// conosco e talvez só vá falar amanhã, quando o instalador terminar o serviço.
//
// São dois fluxos genuinamente diferentes, e forçá-los na mesma tela obrigaria
// o instalador a inventar IP, porta, usuário e senha só para vencer a validação
// — cadastro sujo por desenho, que ninguém saberia interpretar meses depois.
//
// Aqui só se pede o nome. Local, área e o resto da configuração ficam para a
// edição da câmera, depois que ela existir — no momento do cadastro o que o
// instalador precisa é da chave, e ela sai pronta na mesma tela.

export function AddPushCameraDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [nome, setNome] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [copiado, setCopiado] = useState<string | null>(null);
  const [alvo, setAlvo] = useState<{ serverUrl: string; streamKey: string; fullUrl: string } | null>(null);

  const fechar = () => {
    setNome(''); setAlvo(null); setCopiado(null);
    onClose();
  };

  const copiar = async (texto: string, marca: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(marca);
      window.setTimeout(() => setCopiado((c) => (c === marca ? null : c)), 1800);
    } catch {
      toast({ title: 'Não foi possível copiar', description: 'Selecione e copie manualmente.', variant: 'destructive' });
    }
  };

  const criar = async () => {
    if (!accessToken || !nome.trim()) return;
    setSalvando(true);
    try {
      const { data } = await axios.post(
        `${getApiBaseUrl()}/cameras`,
        {
          name: nome.trim(),
          sourceMode: 'rtmp_push',
          recordingEnabled: true,
          recordingMode: 'continuous',
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!data?.rtmpIngest?.streamKey) {
        throw new Error('A câmera foi criada, mas a chave não veio. Abra a câmera e gere pela edição.');
      }
      setAlvo(data.rtmpIngest);
      await onCreated();
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.message ?? err.message)
        : err instanceof Error ? err.message : 'Tente novamente.';
      toast({ title: 'Falha ao cadastrar', description: String(msg), variant: 'destructive' });
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) fechar(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Radio className="h-4 w-4" />
            {alvo ? 'Câmera cadastrada — configure o equipamento' : 'Nova câmera que envia vídeo (RTMP)'}
          </DialogTitle>
        </DialogHeader>

        {!alvo ? (
          <div className="space-y-4 py-1">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Use quando a câmera ou o DVR <strong className="text-foreground">manda o vídeo para o servidor</strong>.
              Funciona atrás de CGNAT, 4G e redes sem porta aberta, porque a conexão nasce do lado de lá.
              Não pedimos endereço nem senha, porque não há nada que o servidor precise acessar.
            </p>

            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground">
                Nome da câmera<span className="ml-0.5 text-destructive">*</span>
              </Label>
              <Input
                autoFocus
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && nome.trim()) void criar(); }}
                placeholder="Portaria — Loja Centro"
                className="text-sm"
              />
            </div>

            <p className="text-[10px] leading-relaxed text-amber-500/90">
              O RTMP transporta H.264. Equipamento que só sai em H.265 não serve para este modo.
            </p>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Cole estes campos no equipamento, normalmente em{' '}
              <span className="font-medium text-foreground">Rede → RTMP</span> (ou <em>Push Stream</em>).
              Assim que ele começar a publicar, a câmera aparece na grade.
            </p>
            <Campo rotulo="Servidor / URL" valor={alvo.serverUrl} copiado={copiado === 's'} onCopiar={() => copiar(alvo.serverUrl, 's')} />
            <Campo rotulo="Chave / Stream key" valor={alvo.streamKey} copiado={copiado === 'k'} onCopiar={() => copiar(alvo.streamKey, 'k')} />
            <Campo rotulo="URL completa" hint="para equipamento com um campo só" valor={alvo.fullUrl} copiado={copiado === 'f'} onCopiar={() => copiar(alvo.fullUrl, 'f')} />
            <Separator />
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              A chave é uma senha de publicação — quem a tiver pode enviar vídeo como se fosse esta câmera.
              Dá para trocá-la depois, na edição da câmera.
            </p>
          </div>
        )}

        <DialogFooter>
          {!alvo ? (
            <>
              <Button variant="ghost" onClick={fechar} disabled={salvando} className="text-sm">Cancelar</Button>
              <Button onClick={() => void criar()} disabled={salvando || !nome.trim()} className="gap-1.5 text-sm">
                {salvando ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Cadastrar e gerar chave
              </Button>
            </>
          ) : (
            <Button onClick={fechar} className="text-sm">Concluir</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Campo({
  rotulo, valor, hint, copiado, onCopiar,
}: { rotulo: string; valor: string; hint?: string; copiado: boolean; onCopiar: () => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">
        {rotulo}
        {hint && <span className="ml-1 text-[10px] font-normal opacity-60">({hint})</span>}
      </Label>
      <div className="flex items-center gap-1.5">
        <Input value={valor} readOnly onFocus={(e) => e.currentTarget.select()} className="h-9 flex-1 font-mono text-[11px]" />
        <Button type="button" variant="outline" size="sm" onClick={onCopiar} className="h-9 w-9 shrink-0 p-0" aria-label={`Copiar ${rotulo}`}>
          {copiado ? <Check className="h-3.5 w-3.5 text-[hsl(var(--status-online))]" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
