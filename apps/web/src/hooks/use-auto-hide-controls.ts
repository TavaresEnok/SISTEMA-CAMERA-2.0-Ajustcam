import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ATRASO_PADRAO_MS,
  EVENTOS_DE_PRESENCA,
  decidirControles,
} from '@/lib/auto-hide-controls';

/**
 * Controles que somem sozinhos depois de um tempo sem interação.
 *
 * A decisão de mostrar/esconder mora em `lib/auto-hide-controls.ts` (pura e
 * testada). Aqui fica só a parte que precisa do navegador: escutar os eventos e
 * tocar o temporizador.
 *
 * Devolve `visivel` e os manipuladores para pôr NOS controles — sem eles, o
 * botão sumiria com o ponteiro em cima ou com o foco do teclado dentro.
 */
export function useAutoHideControls(ativo: boolean, atrasoMs = ATRASO_PADRAO_MS) {
  const [visivel, setVisivel] = useState(true);
  const sobreControle = useRef(false);
  const focoDentro = useRef(false);
  const timer = useRef<number | null>(null);

  const reavaliar = useCallback(
    (interagiuAgora: boolean, msDesdeInteracao = 0) => {
      const r = decidirControles({
        interagiuAgora,
        ponteiroSobreControle: sobreControle.current,
        focoNosControles: focoDentro.current,
        msDesdeInteracao,
        atrasoMs,
      });
      setVisivel(r.visivel);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current =
        r.proximoPrazoMs === null
          ? null
          : window.setTimeout(() => reavaliar(false, atrasoMs), r.proximoPrazoMs);
    },
    [atrasoMs],
  );

  useEffect(() => {
    if (!ativo) {
      // Fora do mural os controles voltam a ser permanentes. Sem isto, sair e
      // voltar deixaria a tela sem controle nenhum até o primeiro movimento.
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      setVisivel(true);
      return;
    }
    const aoInteragir = () => reavaliar(true);
    for (const evento of EVENTOS_DE_PRESENCA) {
      window.addEventListener(evento, aoInteragir, { passive: true });
    }
    reavaliar(true);
    return () => {
      for (const evento of EVENTOS_DE_PRESENCA) window.removeEventListener(evento, aoInteragir);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [ativo, reavaliar]);

  /** Vai NOS controles: segura o sumiço enquanto houver ponteiro ou foco. */
  const propsDoControle = {
    onMouseEnter: () => { sobreControle.current = true; reavaliar(true); },
    onMouseLeave: () => { sobreControle.current = false; reavaliar(true); },
    onFocus: () => { focoDentro.current = true; reavaliar(true); },
    onBlur: () => { focoDentro.current = false; reavaliar(true); },
  };

  return { visivel, propsDoControle };
}
