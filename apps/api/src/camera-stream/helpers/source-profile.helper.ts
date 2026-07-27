import { type LiveViewMode } from './live-delivery-profile.helper';

/**
 * Tradutor entre os DOIS vocabulários de perfil que coexistem no sistema:
 *
 *  - o Source Gateway fala `main` | `sub` (perfil FÍSICO da câmera: fluxo
 *    principal em alta resolução vs. substream leve);
 *  - o proxy do MediaMTX fala `selected` | `grid` | `original` (INTENÇÃO de
 *    entrega: câmera aberta em tela cheia, mosaico, ou passthrough do original).
 *
 * Sem esta tradução o gateway não consegue casar "a origem que o MediaMTX
 * publicou" com "o perfil que o consumidor pediu", e a decisão cai sempre no
 * fallback direto — que é o mesmo que ter o gateway desligado.
 *
 * Mapeamento (e o porquê):
 *  - `grid`     → `sub`  : o mosaico usa o substream de propósito (é o caminho
 *                          leve; ver resolveGridRtspProfile).
 *  - `selected` → `main` : câmera aberta sozinha usa o fluxo principal.
 *  - `original` → `main` : passthrough do bitstream original da câmera, que é o
 *                          principal — só não é transcodificado.
 */
export type SourceProfile = 'main' | 'sub';

export function liveViewModeToSourceProfile(mode: LiveViewMode): SourceProfile {
  return mode === 'grid' ? 'sub' : 'main';
}

/**
 * Volta de perfil físico para o modo de entrega CANÔNICO daquele perfil. É uma
 * relação de muitos-para-um (`selected` e `original` compartilham `main`), então
 * a volta é ambígua por natureza: devolvemos o modo mais comum de cada lado e
 * documentamos que quem precisa distinguir `selected` de `original` deve carregar
 * o modo original em vez de re-derivá-lo daqui.
 */
export function sourceProfileToLiveViewMode(profile: SourceProfile): LiveViewMode {
  return profile === 'sub' ? 'grid' : 'selected';
}

/**
 * O consumidor exige o bitstream DIRETO da câmera (não pode ser reroteado para a
 * origem republicada pelo MediaMTX)?
 *
 * A gravação é o caso central: o pilar de qualidade do DRAC é gravar em `-c copy`
 * o bitstream ORIGINAL da câmera. Se a gravação passasse a ler de um path que o
 * MediaMTX transcodificou para entrega (H.265→H.264 para o navegador), gravaríamos
 * o vídeo DEGRADADO — exatamente o defeito pelo qual o worker-go legado é
 * considerado inaceitável. Enquanto o gateway não souber distinguir path
 * passthrough de path transcodificado, gravação e clipe ficam SEMPRE no direto.
 */
export function consumerRequiresDirectSource(consumer: string): boolean {
  return consumer === 'recording' || consumer === 'prebuffer' || consumer === 'clip';
}
