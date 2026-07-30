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
export const GRID_LIVE_MAX_WIDTH = 640;
export const GRID_LIVE_MAX_HEIGHT = 360;
export const GRID_LIVE_TARGET_FPS = 15;
/** Bitrate do tile de mosaico, em kbps. Ver comentário acima. */
export const GRID_LIVE_BITRATE_KBPS = 700;

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
