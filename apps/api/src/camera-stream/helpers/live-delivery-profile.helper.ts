import { envNumber } from '../../common/config/env-number.helper';

// 'original' = "máxima qualidade": serve o stream PRINCIPAL da câmera em
// PASSTHROUGH (sem transcode, inclusive H.265) via HLS. Custo ~0 de CPU no
// servidor; o celular decodifica o HEVC no hardware. Latência maior que WebRTC.
export type LiveViewMode = 'selected' | 'grid' | 'original';

// TILE DE MOSAICO NÃO É TELA CHEIA — e o bitrate é o que chega no espectador.
//
// O tile ocupa ~300×200 px na tela; entregar 1280×720 a 1800 kbps era mandar
// resolução que o navegador joga fora no downscale e bitrate que ele não
// consegue engolir. Com 21 tiles isso são ~38 Mbps DE DESCIDA para o cliente.
// MEDIDO no MediaMTX quando o link não dá conta: "reader is too slow,
// discarding 216 frames" — o servidor descarta quadros porque o navegador não
// consome. O operador vê exatamente o que foi relatado: fps despencando,
// tela congelando e o player reconectando "infinitamente".
//
// 640×360 já é mais do que o tile mostra, e 700 kbps sustenta essa resolução
// com folga em H.264. A conta do mosaico cai de ~38 Mbps para ~15 Mbps, e
// quem abre uma câmera em tela cheia continua recebendo o perfil grande
// (`selected`), que não passa por aqui.
// FLUIDEZ x BANDA: por que o FPS voltou a 20 e a resolução NÃO.
//
// A redução acima foi feita quando o mosaico congelava. Só que a congestão
// tinha outra causa, corrigida depois: cada tile abria até 4 sessões WebRTC da
// MESMA câmera (ver "sessão WebRTC órfã"), multiplicando a descida por 4. Com
// aquilo de pé, nenhum valor aqui seria suficiente; com aquilo resolvido, o
// orçamento sobrou.
//
// O operador percebe FLUIDEZ, não pixel: num tile de ~300×200 a diferença
// entre 640 e 1280 de largura é invisível (o navegador descarta no downscale),
// mas 15 fps contra 20 aparece como movimento "picotado". FPS também é o
// parâmetro mais BARATO em banda — subir 15→20 pede ~1/3 a mais de bitrate na
// mesma resolução, enquanto dobrar a largura pediria ~4×.
//
// Daí a escolha: devolve os 20 fps (o que foi notado em produção), mantém
// 640×360 (o que de fato cortou os ~38 Mbps para o navegador) e acompanha o
// bitrate para sustentar a taxa. Mosaico de 21 tiles ≈ 19 Mbps — metade do
// que causava o "reader is too slow", com a fluidez de volta.
//
// Tudo ajustável sem deploy: se o link de algum cliente não aguentar, baixe
// GRID_LIVE_TARGET_FPS/GRID_LIVE_BITRATE_KBPS por env em vez de editar código.
export const GRID_LIVE_MAX_WIDTH = envNumber('GRID_LIVE_MAX_WIDTH', 640, {
  min: 320, max: 1920, integer: true,
});
export const GRID_LIVE_MAX_HEIGHT = envNumber('GRID_LIVE_MAX_HEIGHT', 360, {
  min: 180, max: 1080, integer: true,
});
export const GRID_LIVE_TARGET_FPS = envNumber('GRID_LIVE_TARGET_FPS', 20, {
  min: 5, max: 30, integer: true,
});
/** Bitrate do tile de mosaico, em kbps. Ver comentário acima. */
export const GRID_LIVE_BITRATE_KBPS = envNumber('GRID_LIVE_BITRATE_KBPS', 900, {
  min: 200, max: 8000, integer: true,
});

export function normalizeLiveViewMode(value?: string | null): LiveViewMode {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'grid') return 'grid';
  if (v === 'original') return 'original';
  return 'selected';
}

export function resolveGridLiveProfile(input?: {
  detectedWidth?: number | null;
  detectedHeight?: number | null;
  streamWidth?: number | null;
  streamHeight?: number | null;
}) {
  const widthCandidate = input?.detectedWidth ?? input?.streamWidth ?? GRID_LIVE_MAX_WIDTH;
  const heightCandidate = input?.detectedHeight ?? input?.streamHeight ?? GRID_LIVE_MAX_HEIGHT;

  return {
    width: Math.max(1, Math.min(GRID_LIVE_MAX_WIDTH, Number(widthCandidate) || GRID_LIVE_MAX_WIDTH)),
    height: Math.max(1, Math.min(GRID_LIVE_MAX_HEIGHT, Number(heightCandidate) || GRID_LIVE_MAX_HEIGHT)),
    fps: GRID_LIVE_TARGET_FPS,
  };
}
