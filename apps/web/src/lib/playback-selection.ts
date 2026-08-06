// ── QUAL GRAVAÇÃO TOCA NESTE INSTANTE? ──────────────────────────────────────
//
// A resposta errada aqui é O defeito que o operador descreve como "a timeline
// não seleciona o vídeo correto". As causas, todas reais e medidas:
//
//  · o fallback antigo caía em `playableRecordings[0]` — clique depois do fim
//    da última gravação (ou numa faixa ainda não carregada) tocava a PRIMEIRA
//    gravação do dia, 00:0x, do nada;
//  · `endedAt` ausente virava fim = início e a gravação sumia da seleção,
//    mesmo com `durationSeconds` disponível ao lado;
//  · fim INCLUSIVO + `find()` ascendente: na emenda entre A e B (e nas
//    sobreposições de ~5s que o pré-roll de movimento cria — medidas 848 em
//    48h nesta frota), o clique escolhia o segmento ANTIGO, fazia seek para o
//    último frame e disparava `ended` na hora;
//  · minuto-do-dia com aritmética de relógio quebrava na virada da meia-noite.
//
// Tudo aqui é tempo ABSOLUTO em ms. Regras:
//  · contém = start <= t < end (fim EXCLUSIVO); empate → o de início MAIS
//    RECENTE (o pré-roll existe para cobrir o gatilho; o segmento novo é o
//    dono do instante);
//  · nada contém → a MAIS PRÓXIMA no tempo (antes → começa do zero; depois →
//    perto do fim), NUNCA a primeira do dia;
//  · a cobertura diz que há vídeo ali mas o detalhe ainda não chegou (timeline
//    por janela) → AGUARDAR: selecionar qualquer outra coisa descartaria a
//    intenção do operador — o efeito re-roda quando a carga chegar.

export type GravacaoSelecionavel = {
  id: string;
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
};

/** Janela absoluta [startMs, endMs) de uma gravação, com fallback de duração. */
export function janelaDaGravacao(
  r: Pick<GravacaoSelecionavel, 'startedAt' | 'endedAt' | 'durationSeconds'>,
  agoraMs: number,
): { startMs: number; endMs: number } {
  const startMs = new Date(r.startedAt).getTime();
  const porEndedAt = r.endedAt ? new Date(r.endedAt).getTime() : null;
  const porDuracao = r.durationSeconds && r.durationSeconds > 0 ? startMs + r.durationSeconds * 1000 : null;
  // Gravação ainda aberta (sem fim conhecido): vale até "agora" — ela contém o
  // instante presente, em vez de sumir da régua e da seleção.
  const endMs = porEndedAt ?? porDuracao ?? Math.max(startMs, agoraMs);
  return { startMs, endMs: Math.max(endMs, startMs) };
}

export type SelecaoDeGravacao =
  | { tipo: 'exata'; id: string; offsetSeconds: number }
  | { tipo: 'proxima'; id: string; offsetSeconds: number; distanciaMs: number }
  | { tipo: 'aguardar' }
  | { tipo: 'nada' };

export function selecionarGravacaoNoInstante(
  gravacoes: GravacaoSelecionavel[],
  alvoMs: number,
  opcoes: {
    agoraMs?: number;
    /** Cobertura conhecida do dia (esqueleto), em minutos-do-dia. */
    coberturaMinutos?: Array<{ start: number; end: number }>;
    dayStartMs?: number;
    /** Distância a partir da qual "mais próxima" deixa de ser resposta boa. */
    limiteAguardarMs?: number;
  } = {},
): SelecaoDeGravacao {
  const agoraMs = opcoes.agoraMs ?? Date.now();
  let contendo: { id: string; startMs: number } | null = null;
  let proxima: { id: string; startMs: number; distanciaMs: number; offsetSeconds: number } | null = null;

  for (const r of gravacoes) {
    const { startMs, endMs } = janelaDaGravacao(r, agoraMs);
    if (endMs <= startMs) continue;
    if (alvoMs >= startMs && alvoMs < endMs) {
      if (!contendo || startMs > contendo.startMs) contendo = { id: r.id, startMs };
      continue;
    }
    const distanciaMs = alvoMs < startMs ? startMs - alvoMs : alvoMs - endMs;
    const offsetSeconds = alvoMs < startMs ? 0 : Math.max(0, (endMs - startMs) / 1000 - 1);
    const ganha = !proxima
      || distanciaMs < proxima.distanciaMs
      || (distanciaMs === proxima.distanciaMs && startMs > proxima.startMs);
    if (ganha) proxima = { id: r.id, startMs, distanciaMs, offsetSeconds };
  }

  if (contendo) {
    return { tipo: 'exata', id: contendo.id, offsetSeconds: Math.max(0, (alvoMs - contendo.startMs) / 1000) };
  }

  // O esqueleto (gaps-report) afirma que há vídeo neste instante, mas nenhuma
  // gravação CARREGADA chega perto: o detalhe da janela ainda não veio.
  const limite = opcoes.limiteAguardarMs ?? 2 * 60_000;
  if (
    opcoes.coberturaMinutos?.length
    && opcoes.dayStartMs != null
    && (!proxima || proxima.distanciaMs > limite)
  ) {
    const alvoMin = (alvoMs - opcoes.dayStartMs) / 60_000;
    const coberto = opcoes.coberturaMinutos.some((c) => alvoMin >= c.start && alvoMin < c.end);
    if (coberto) return { tipo: 'aguardar' };
  }

  if (!proxima) return { tipo: 'nada' };
  return { tipo: 'proxima', id: proxima.id, offsetSeconds: proxima.offsetSeconds, distanciaMs: proxima.distanciaMs };
}
