// ── RANGE HTTP DE VERDADE, E CACHE PARA O NAVEGADOR REAPROVEITAR ────────────
//
// O parser antigo de Range tinha três mentiras que viravam vídeo errado ou
// banda desperdiçada — exatamente o que mais dói em link lento:
//
//  · `bytes=-500` (sufixo: os ÚLTIMOS 500 bytes, RFC 9110 §14.1.2) virava
//    `bytes=0-500`: o player pedia o FIM do arquivo (onde mora o índice moov
//    de um MP4) e recebia o COMEÇO, rotulado como 206 — seek quebrado sem
//    nenhum erro aparente.
//  · Multi-range (`bytes=0-99,200-299`) parseava o segundo número como NaN e
//    devolvia o arquivo INTEIRO rotulado como 206. A resposta correta ao que
//    não implementamos é IGNORAR o Range e responder 200 completo (o RFC
//    permite; mentir o status não).
//  · Malformado (`bytes=abc-def`) idem: 200 completo, nunca 206 falso.
//
// E NENHUM validador de cache era emitido: sem ETag/Last-Modified o navegador
// não pode revalidar nem reaproveitar byte nenhum — cada seek numa gravação de
// 300 MB voltava a puxar tudo do servidor. Gravação fechada é IMUTÁVEL por
// definição, o caso perfeito para cache.

export type AlcanceResolvido =
  | { tipo: 'completo' }
  | { tipo: 'parcial'; start: number; end: number }
  | { tipo: 'insatisfazivel' };

/** Interpreta o cabeçalho Range contra o tamanho real do arquivo. */
export function resolverRange(header: string | undefined | null, fileSize: number): AlcanceResolvido {
  if (!header || fileSize <= 0) return { tipo: 'completo' };
  const m = /^bytes=(.*)$/i.exec(header.trim());
  if (!m) return { tipo: 'completo' };
  const spec = m[1].trim();
  // Multi-range: não implementamos multipart/byteranges — ignorar é permitido,
  // mentir um 206 de arquivo inteiro não é.
  if (spec.includes(',')) return { tipo: 'completo' };

  const partes = /^(\d*)-(\d*)$/.exec(spec);
  if (!partes) return { tipo: 'completo' };
  const [, startText, endText] = partes;

  if (startText === '' && endText === '') return { tipo: 'completo' };

  if (startText === '') {
    // Sufixo: os últimos N bytes. N=0 é insatisfazível por definição.
    const n = Number(endText);
    if (!Number.isFinite(n) || n <= 0) return { tipo: 'insatisfazivel' };
    const start = Math.max(0, fileSize - n);
    return { tipo: 'parcial', start, end: fileSize - 1 };
  }

  const start = Number(startText);
  const end = endText === '' ? fileSize - 1 : Math.min(Number(endText), fileSize - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { tipo: 'completo' };
  if (start >= fileSize || start > end) return { tipo: 'insatisfazivel' };
  return { tipo: 'parcial', start, end };
}

/**
 * Validadores de cache de um arquivo imutável. ETag forte de tamanho+mtime:
 * gravação fechada nunca muda, então qualquer par igual É o mesmo conteúdo.
 */
export function validadoresDeCache(stats: { size: number; mtimeMs: number }): { etag: string; lastModified: string } {
  return {
    etag: `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
    lastModified: new Date(stats.mtimeMs).toUTCString(),
  };
}
