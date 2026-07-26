// Construtores PUROS de URLs de mídia (poster/miniatura/clipe). Sem React nem
// APIs do React Native para rodar sob `node --test`. Extraídos do App.tsx, onde
// estavam repetidos inline em vários pontos.
//
// A base é SEMPRE o `apiUrl` da sessão (alcançável pelo celular). NÃO se usa o
// host que a API devolve — atrás do nginx/Docker ele pode vir interno (ex.:
// vms-api:3000), inacessível ao aparelho → tile/miniatura em branco.

/** Remove barras finais da base da API (idempotente). */
function apiBase(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

/**
 * URL do poster (snapshot) de uma câmera, com o token curto do stream e um
 * cache-buster. O `cacheBust` cai em `Date.now()` por padrão (avaliado a cada
 * chamada), replicando o `&v=${Date.now()}` que existia inline.
 */
export function cameraPosterUrl(
  apiUrl: string,
  cameraId: string,
  streamToken: string,
  cacheBust: number = Date.now(),
): string {
  return `${apiBase(apiUrl)}/camera-stream/${encodeURIComponent(cameraId)}/poster?token=${encodeURIComponent(streamToken)}&v=${cacheBust}`;
}

/**
 * URL da miniatura de uma gravação, com o token curto da miniatura e um
 * cache-buster (mesma semântica do poster).
 */
export function recordingThumbnailUrl(
  apiUrl: string,
  recordingId: string,
  thumbnailToken: string,
  cacheBust: number = Date.now(),
): string {
  return `${apiBase(apiUrl)}/recordings/${encodeURIComponent(recordingId)}/thumbnail?token=${encodeURIComponent(thumbnailToken)}&v=${cacheBust}`;
}

/** URL de download do arquivo de um clipe gravado no servidor (gravação "no celular"). */
export function clipDownloadUrl(apiUrl: string, clipId: string): string {
  return `${apiBase(apiUrl)}/camera-stream/clip/${encodeURIComponent(clipId)}/download`;
}
