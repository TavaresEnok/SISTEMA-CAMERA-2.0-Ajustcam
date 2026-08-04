// ── GRAVAR POR MOVIMENTO DO SISTEMA EXIGE O DETECTOR LIGADO ──────────────────
//
// `motionTrigger` diz QUEM detecta o movimento:
//   · `SYSTEM` — o MOG2 do DRAC, analisando o vídeo aqui;
//   · `CAMERA` — a própria câmera, que avisa por evento.
//
// Com `SYSTEM` e o detector desligado (`aiEnabled=false`), a configuração é
// contraditória: a câmera está armada por um detector que ninguém ligou. O
// resultado não é um erro visível — é a câmera NUNCA gravar. O gerenciador
// tenta subir a análise, recebe "câmera desabilitada", não lança exceção, e
// desiste. A cada 5 minutos, indefinidamente.
//
// MEDIDO em produção: 7 câmeras nesse estado, 5 delas ONLINE e mudas por 10
// horas, com o log repetindo "religando análise" e nada na tela indicando
// problema.
//
// Por que uma função e não um `if` no serviço: a mesma regra vale na criação, na
// edição e no cadastro em lote. Escrita em três lugares, ela diverge no primeiro
// ajuste — e o modo de falha é silencioso, que é o pior tipo para depender de
// disciplina.

export type EstadoDeteccao = {
  recordingMode: string | null | undefined;
  motionTrigger: string | null | undefined;
  aiEnabled: boolean | null | undefined;
};

/**
 * O detector é OBRIGATÓRIO para esta combinação?
 *
 * Só quando a gravação é por movimento E quem detecta é o sistema. Gravação
 * contínua não depende de detector, e `CAMERA` usa o da própria câmera — forçar
 * o MOG2 nesses casos gastaria CPU sem nada em troca.
 */
export function detectorObrigatorio(estado: EstadoDeteccao): boolean {
  return estado.recordingMode === 'motion' && estado.motionTrigger === 'SYSTEM';
}

/**
 * O valor que `aiEnabled` deve ter ao gravar.
 *
 * Quando obrigatório, `true` — independentemente do que veio do formulário.
 * Fora disso, respeita a escolha; `undefined` continua significando "não
 * mexer", que é como o Prisma trata campo ausente.
 */
export function aiEnabledEfetivo(estado: EstadoDeteccao): boolean | undefined {
  if (detectorObrigatorio(estado)) return true;
  return estado.aiEnabled ?? undefined;
}
