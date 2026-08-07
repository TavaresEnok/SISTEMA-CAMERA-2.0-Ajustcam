import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Search, Video, VideoOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

/**
 * SELETOR DE CÂMERA — um só, para /playback, /review e /ptz.
 *
 * As três telas usavam um `<Select>` cru com a frota inteira em lista plana:
 * 27 itens sem busca, sem dizer quem está online, e com o nome truncado. Achar
 * a "Cam-21" exigia rolar a lista lendo item por item.
 *
 * O que muda:
 *   · busca por texto (nome ou código) — digitar "21" já filtra;
 *   · estado da câmera visível, com as OFFLINE agrupadas no fim, porque numa
 *     tela de reprodução ou PTZ o que se procura quase sempre está no ar;
 *   · teclado funciona (setas, Enter, Esc) — herdado do cmdk.
 *
 * O estado NÃO é escondido: câmera offline continua selecionável. Em
 * /playback ela tem gravação para rever, e em /ptz o operador pode querer
 * tentar mesmo assim. Esconder viraria o outro extremo do defeito que a lista
 * plana já causava.
 */

export type CameraDoSeletor = {
  id: string;
  name: string;
  code?: string;
  isOnline?: boolean;
};

type Props = {
  cameras: CameraDoSeletor[];
  value: string | null | undefined;
  onChange: (cameraId: string) => void;
  /** Rótulo da opção que representa "todas" (ex.: a Revisão). Omitido = sem essa opção. */
  opcaoTodas?: { valor: string; rotulo: string };
  placeholder?: string;
  className?: string;
  /** Mensagem quando a lista chega vazia — cada tela tem um motivo diferente. */
  vazio?: string;
  disabled?: boolean;
  id?: string;
};

export function SeletorDeCamera({
  cameras,
  value,
  onChange,
  opcaoTodas,
  placeholder = 'Selecione uma câmera',
  className,
  vazio = 'Nenhuma câmera encontrada.',
  disabled,
  id,
}: Props) {
  const [aberto, setAberto] = useState(false);

  const { online, offline } = useMemo(() => {
    const online: CameraDoSeletor[] = [];
    const offline: CameraDoSeletor[] = [];
    for (const camera of cameras) (camera.isOnline === false ? offline : online).push(camera);
    return { online, offline };
  }, [cameras]);

  const selecionada = cameras.find((camera) => camera.id === value);
  const ehTodas = Boolean(opcaoTodas && value === opcaoTodas.valor);

  const rotuloDoBotao = ehTodas
    ? opcaoTodas!.rotulo
    : selecionada
      ? `${selecionada.code ? `${selecionada.code} — ` : ''}${selecionada.name}`
      : placeholder;

  const renderItem = (camera: CameraDoSeletor) => (
    <CommandItem
      key={camera.id}
      // `value` é o que o cmdk filtra: nome E código, para "21" achar a Cam-21
      // e o nome achar pelo texto. Sem o id junto, duas câmeras homônimas
      // colidiriam na seleção.
      value={`${camera.name} ${camera.code ?? ''} ${camera.id}`}
      onSelect={() => { onChange(camera.id); setAberto(false); }}
      className="gap-2 text-xs"
    >
      {camera.isOnline === false
        ? <VideoOff className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--muted-foreground))]" aria-hidden />
        : <Video className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--status-online))]" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">
        {camera.code ? <span className="font-mono opacity-70">{camera.code}</span> : null}
        {camera.code ? ' — ' : ''}
        {camera.name}
      </span>
      {camera.isOnline === false && (
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">offline</span>
      )}
      {value === camera.id && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
    </CommandItem>
  );

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={aberto}
          aria-label={placeholder}
          disabled={disabled}
          className={cn(
            'flex h-9 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-xs',
            'hover:border-[hsl(var(--primary)_/_0.5)] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('min-w-0 truncate text-left', !selecionada && !ehTodas && 'text-[hsl(var(--muted-foreground))]')}>
            {rotuloDoBotao}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-[min(92vw,340px)] p-0" align="start">
        <Command
          // A busca padrão do cmdk pontua por similaridade e reordena; aqui a
          // ordem (online antes de offline) é informação, então filtra sem
          // reordenar.
          filter={(valor, busca) => (valor.toLowerCase().includes(busca.toLowerCase().trim()) ? 1 : 0)}
        >
          <div className="flex items-center border-b border-border px-2">
            <Search className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />
            <CommandInput placeholder="Buscar câmera..." className="h-9 border-0 text-xs focus:ring-0" />
          </div>
          <CommandList className="max-h-72">
            <CommandEmpty className="py-6 text-center text-xs text-[hsl(var(--muted-foreground))]">{vazio}</CommandEmpty>

            {opcaoTodas && (
              <CommandGroup>
                <CommandItem
                  value={opcaoTodas.rotulo}
                  onSelect={() => { onChange(opcaoTodas.valor); setAberto(false); }}
                  className="gap-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">{opcaoTodas.rotulo}</span>
                  {ehTodas && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                </CommandItem>
              </CommandGroup>
            )}

            {online.length > 0 && (
              <CommandGroup heading={offline.length > 0 ? `No ar (${online.length})` : undefined}>
                {online.map(renderItem)}
              </CommandGroup>
            )}
            {offline.length > 0 && (
              <CommandGroup heading={`Fora do ar (${offline.length})`}>
                {offline.map(renderItem)}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
