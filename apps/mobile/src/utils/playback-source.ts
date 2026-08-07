// ── QUAL FONTE PEDIR AO SERVIDOR ────────────────────────────────────────────
//
// O app pedia `compatible=1` em TODA reprodução. Isso custava caro dos dois
// lados:
//
//   · SERVIDOR — `compatible=1` entra em `streamRecordingCompatible`, que NÃO
//     verifica o codec: reencoda tudo (até gravação que já é H.264) com FFmpeg
//     de até 5 minutos, e guarda uma segunda cópia em disco. Cada vídeo
//     assistido no app disputava CPU com a gravação contínua da frota.
//
//   · USUÁRIO — sem cache pronto, o servidor responde `503 { preparing: true }`
//     e transcodifica em segundo plano. Como a frota grava H.265, a PRIMEIRA
//     reprodução de quase toda gravação caía nesse 503 — e o player mostrava
//     "Não foi possível reproduzir".
//
// O Android decodifica H.265 por hardware (ExoPlayer). Então a ordem correta é
// a inversa: pedir o arquivo ORIGINAL (`forceDirect=1`, pass-through, zero CPU
// de servidor e início imediato — inclusive streaming direto do bucket quando a
// gravação só existe na nuvem) e só cair para a versão compatível se o player
// realmente não conseguir decodificar.
//
// `compatibleCached` vem na lista de gravações: quando a versão compatível JÁ
// existe em cache, pedi-la não custa transcode nenhum — mas ainda assim
// preferimos o original, que dispensa o segundo arquivo. O campo entra aqui
// para o degrau de erro saber que a troca será instantânea.

export type FonteDeReproducao = 'direta' | 'compativel';

export type OpcoesDeFonte = {
  /** Passa a valer depois que o player falha ao decodificar o original. */
  forcarCompativel?: boolean;
};

/**
 * Monta a URL de reprodução. `direta` é o padrão; `compativel` é o degrau.
 */
export function montarUrlDeReproducao(
  apiUrl: string,
  recordingId: string,
  playToken: string,
  fonte: FonteDeReproducao = 'direta',
): string {
  const base = `${apiUrl}/recordings/${encodeURIComponent(recordingId)}/play`;
  const parametros = new URLSearchParams({ token: playToken });
  // Um OU outro: `compatible` vence `forceDirect` no backend, então mandar os
  // dois juntos seria pedir transcode sem querer.
  if (fonte === 'compativel') parametros.set('compatible', '1');
  else parametros.set('forceDirect', '1');
  return `${base}?${parametros.toString()}`;
}

/** A próxima fonte a tentar depois de um erro, ou `null` se não há degrau. */
export function proximaFonte(atual: FonteDeReproducao): FonteDeReproducao | null {
  return atual === 'direta' ? 'compativel' : null;
}

/**
 * O erro veio do servidor dizendo que a versão compatível está sendo
 * preparada? Nesse caso não é falha: é espera, e o player deve tentar de novo
 * sozinho depois de `Retry-After`.
 */
export function ehPreparoEmAndamento(status: number | null | undefined): boolean {
  return status === 503;
}

/** Segundos até a próxima tentativa, respeitando o `Retry-After` do servidor. */
export function esperaAteRetentar(retryAfter: string | null | undefined, tentativa: number): number {
  const doServidor = Number(retryAfter);
  if (Number.isFinite(doServidor) && doServidor > 0) return Math.min(30, doServidor);
  // Sem cabeçalho: escada curta, com teto — o transcode leva de segundos a
  // poucos minutos, e insistir a cada 1s só geraria requisição à toa.
  return Math.min(30, 4 + tentativa * 2);
}
