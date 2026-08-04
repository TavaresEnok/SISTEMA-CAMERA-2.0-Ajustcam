// ── QUANTOS DIAS ESTA CÂMERA GUARDA ─────────────────────────────────────────
//
// Antes existia UM número por câmera, e a única forma de aplicar em lote era o
// botão do grupo — que SOBRESCREVIA o valor de cada uma. Toda vez que alguém
// mexia no grupo, as exceções ajustadas à mão se perdiam, sem volta.
//
// Agora o grupo guarda a política e a câmera escolhe se a segue:
//
//   segue o grupo   → usa o número do GRUPO
//   não segue       → usa o número DELA
//   sem grupo       → cai no global
//
// Todo grupo nasce com um número, nunca vazio: um toggle "seguir o grupo"
// apontando para o nada não é uma opção válida de oferecer a ninguém.
//
// Por que um helper e não um `if` no serviço: a mesma conta aparece na
// varredura de expiração, na tela da câmera e no aviso que precede a troca. Em
// três lugares ela diverge no primeiro ajuste — e aqui divergir significa apagar
// gravação com o prazo errado.

export type EntradaRetencao = {
  /** O que a câmera guarda por conta própria. */
  retentionDays: number | null | undefined;
  /** A câmera segue a política do grupo? */
  retentionFollowsGroup: boolean | null | undefined;
  /** Dias do grupo a que ela pertence — `null` quando não tem grupo. */
  grupoRetentionDays: number | null | undefined;
};

/** Piso de 1 dia. Zero apagaria TUDO na varredura seguinte. */
const PISO_DIAS = 1;

/**
 * Os dias que valem para esta câmera.
 *
 * `globalDays` é o último recurso: câmera que segue o grupo mas não tem grupo,
 * ou número ausente. Nunca devolve 0 ou negativo — um typo em qualquer camada
 * viraria exclusão total do acervo no ciclo seguinte.
 */
export function retencaoEfetiva(entrada: EntradaRetencao, globalDays: number): number {
  const global = Math.max(PISO_DIAS, Math.floor(globalDays) || PISO_DIAS);

  const escolhido = entrada.retentionFollowsGroup
    ? entrada.grupoRetentionDays
    : entrada.retentionDays;

  const dias = Number(escolhido);
  if (!Number.isFinite(dias) || dias < PISO_DIAS) return global;
  return Math.floor(dias);
}

/**
 * A troca vai APAGAR gravação? Quanto tempo do acervo desaparece?
 *
 * Existe para a tela conseguir avisar ANTES, com número em vez de susto: mudar
 * uma câmera de 10 para 3 dias apaga do 4º ao 10º dia na varredura seguinte, que
 * roda de hora em hora. Sem este aviso, o operador descobre pelo buraco.
 */
export function diasQuePerde(diasAtuais: number, diasNovos: number): number {
  if (!Number.isFinite(diasAtuais) || !Number.isFinite(diasNovos)) return 0;
  return Math.max(0, Math.floor(diasAtuais) - Math.floor(diasNovos));
}
