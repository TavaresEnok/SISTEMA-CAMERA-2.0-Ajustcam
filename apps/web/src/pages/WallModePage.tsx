import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useGridStore } from '../store/gridStore';

/**
 * /wall — ponte para o modo mural REAL.
 *
 * Esta página era uma maquete do protótipo: 16 retângulos pretos com nome de
 * câmera e um ícone cinza, sem `LiveStreamPlayer`, sem `<img>`, sem `<video>`.
 * Quem a abria pela paleta de comandos via a tela toda apagada e concluía que
 * a frota inteira tinha caído. Somava a isso um relógio em UTC e congelado
 * (avaliado no render, sem `setInterval`), pontos vermelhos pulsantes para
 * câmera SAUDÁVEL — o mesmo tratamento do alarme, que sumia por saturação — e
 * duas classes CSS que não existem.
 *
 * O mural de verdade já existe dentro do /live (`wallMode` do gridStore):
 * mesma grade, players reais, e sem desmontar nenhum stream ao alternar. Em
 * vez de manter duas implementações — uma delas falsa —, esta rota liga o
 * mural real e leva o operador para lá.
 */
export default function WallModePage() {
  const [, setLocation] = useLocation();
  const wallMode = useGridStore((state) => state.wallMode);
  const toggleWallMode = useGridStore((state) => state.toggleWallMode);

  useEffect(() => {
    if (!wallMode) toggleWallMode();
    setLocation('/live', { replace: true });
  }, [setLocation, toggleWallMode, wallMode]);

  return (
    <div className="flex h-full items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
      Abrindo o modo mural…
    </div>
  );
}
