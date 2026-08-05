// ── O RESUMO DE SAÚDE NÃO PODE VIRAR UMA TEMPESTADE DE ffprobe ──────────────
//
// O resumo percorre as gravações do dia e, para cada uma, quer um diagnóstico.
// O caminho unitário (`getRecordingDiagnostics`) é caro por natureza: quando a
// entrada não está no cache ele consulta o banco e roda `ffprobe` no arquivo.
// Isso é correto para UMA gravação pedida na tela; num laço de 1.200 vira
// 1.200 consultas e até 1.200 subprocessos EM SÉRIE.
//
// Hoje isso não aparece porque o envio para a nuvem apaga a cópia local e o
// teste de existência corta o caminho antes do ffprobe. Ou seja: o que segura
// a bomba é uma configuração, não o código. Basta o modo virar "Direto"/local,
// ou o cache esfriar depois de um deploy, para o resumo custar minutos de CPU —
// e ele é chamado a cada troca de aba.
//
// Estas funções decidem O QUE fazer com cada gravação ANTES de gastar: quem já
// tem diagnóstico fresco no cache não custa nada; quem não tem entra numa fila
// com ORÇAMENTO. O que não couber no orçamento volta como "indeterminado" — e
// indeterminado NÃO é defeito: contar como quebrado inventaria alarme, contar
// como saudável esconderia um. É reportado à parte, para a tela poder dizer
// "faltou medir N".

export type EntradaDeCache = { checkedAt?: string; diagnostics?: unknown } | undefined;

export type PlanoDeVarredura<T> = {
  /** Já resolvidos pelo cache — custo zero. */
  cacheados: Array<{ registro: T; diagnostico: any }>;
  /** Precisam ir ao disco; até `orcamento`, na ordem recebida. */
  aMedir: T[];
  /** Ficaram de fora do orçamento nesta chamada. */
  adiados: T[];
};

/**
 * Divide as gravações entre "o cache responde" e "precisa medir", respeitando
 * um orçamento de medições caras.
 *
 * @param registros    Gravações do período, na ordem em que devem ser tratadas.
 * @param cache        Mapa lido UMA vez pelo chamador. Ler dentro do laço era
 *                     o defeito que congelava a API por 11 segundos.
 * @param idDe         Como extrair o id da gravação.
 * @param ttlMs        Idade máxima de um diagnóstico para ainda valer.
 * @param agora        Injetado para o teste não depender do relógio.
 * @param orcamento    Máximo de medições caras nesta requisição.
 */
export function planejarVarredura<T>(
  registros: T[],
  cache: Record<string, EntradaDeCache>,
  idDe: (registro: T) => string,
  ttlMs: number,
  agora: number,
  orcamento: number,
): PlanoDeVarredura<T> {
  const cacheados: Array<{ registro: T; diagnostico: any }> = [];
  const candidatos: T[] = [];

  for (const registro of registros) {
    const entrada = cache[idDe(registro)];
    const checkedAt = entrada?.checkedAt ? new Date(entrada.checkedAt).getTime() : 0;
    const fresco = Boolean(entrada?.diagnostics) && checkedAt > 0 && agora - checkedAt <= ttlMs;
    if (fresco) cacheados.push({ registro, diagnostico: entrada!.diagnostics });
    else candidatos.push(registro);
  }

  // Orçamento negativo ou zero = não mede nada nesta chamada (tudo adiado).
  const teto = Math.max(0, Math.floor(orcamento));
  return { cacheados, aMedir: candidatos.slice(0, teto), adiados: candidatos.slice(teto) };
}

/**
 * Executa `tarefa` sobre `itens` com no máximo `limite` em voo.
 *
 * Em série, 24 ffprobe de ~120ms são ~3s de espera; todos de uma vez seriam 24
 * subprocessos disputando a CPU com a GRAVAÇÃO, que é o que não pode falhar.
 * A ordem do resultado acompanha a da entrada — o chamador cruza por índice.
 */
export async function emLotes<T, R>(
  itens: T[],
  limite: number,
  tarefa: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const emVoo = Math.max(1, Math.floor(limite));
  const resultados = new Array<R>(itens.length);
  let proximo = 0;
  const trabalhadores = Array.from({ length: Math.min(emVoo, itens.length) }, async () => {
    for (;;) {
      const indice = proximo;
      proximo += 1;
      if (indice >= itens.length) return;
      resultados[indice] = await tarefa(itens[indice], indice);
    }
  });
  await Promise.all(trabalhadores);
  return resultados;
}

export type ContagemDeCamera = {
  cameraId: string;
  total: number;
  broken: number;
  tooSmall: number;
  compatibleRecommended: number;
  directLikely: number;
  withAudio: number;
  /** Sem diagnóstico nesta chamada: nem defeito, nem saúde confirmada. */
  pending: number;
  lastRecordingAt: string | null;
  lastRecordingAgeSeconds: number | null;
};

export function contagemZerada(cameraId: string): ContagemDeCamera {
  return {
    cameraId,
    total: 0,
    broken: 0,
    tooSmall: 0,
    compatibleRecommended: 0,
    directLikely: 0,
    withAudio: 0,
    pending: 0,
    lastRecordingAt: null,
    lastRecordingAgeSeconds: null,
  };
}

/**
 * Soma UMA gravação na contagem da câmera dela.
 *
 * `diagnostico` nulo = indeterminado: só entra em `pending`. Antes isso nem
 * existia como conceito — o que faltasse medir era classificado como defeito
 * porque `fileExists` vinha `undefined`, e o operador via alarme inventado.
 */
export function somarGravacao(
  atual: ContagemDeCamera,
  diagnostico: any | null,
  minExpectedBytes: number,
): ContagemDeCamera {
  atual.total += 1;
  if (!diagnostico) {
    atual.pending += 1;
    return atual;
  }
  const fileSize = Number(diagnostico.fileSizeBytes ?? 0);
  if (fileSize > 0 && fileSize < minExpectedBytes) atual.tooSmall += 1;
  if (!diagnostico.fileExists || diagnostico.reason === 'file_missing' || diagnostico.reason === 'empty_file') {
    atual.broken += 1;
  } else if (diagnostico.compatibleRecommended) {
    atual.compatibleRecommended += 1;
  } else {
    atual.directLikely += 1;
  }
  if (diagnostico.hasAudioStream) atual.withAudio += 1;
  return atual;
}

/**
 * A câmera precisa de atenção?
 *
 * As proporções usam o que foi MEDIDO (`total - pending`), não o total bruto:
 * com metade do dia por medir, dividir pelo total afunda a taxa e esconde a
 * câmera quebrada. Sem nada medido, não há como afirmar — e "não sei" nunca
 * vira alarme.
 */
export function avaliarAtencao(
  item: ContagemDeCamera,
  limiar: number,
  minExpectedBytes: number,
): { needsAttention: boolean; alertReason: string | null } {
  const medidos = item.total - item.pending;
  const degradedRatio = medidos > 0 ? (item.broken + item.compatibleRecommended) / medidos : 0;
  const atrasado = item.lastRecordingAgeSeconds != null && item.lastRecordingAgeSeconds > 30 * 60;
  const needsAttention =
    item.broken >= limiar ||
    degradedRatio >= 0.5 ||
    item.tooSmall >= limiar ||
    atrasado;
  let alertReason: string | null = null;
  if (item.broken >= limiar) alertReason = `falhas=${item.broken} (limiar=${limiar})`;
  else if (item.tooSmall >= limiar) alertReason = `arquivos pequenos=${item.tooSmall} (mín ${Math.round(minExpectedBytes / 1024)}KB)`;
  else if (atrasado) alertReason = `último segmento atrasado (${Math.floor((item.lastRecordingAgeSeconds ?? 0) / 60)} min)`;
  else if (degradedRatio >= 0.5) alertReason = 'alta taxa de segmentos degradados';
  return { needsAttention, alertReason };
}
