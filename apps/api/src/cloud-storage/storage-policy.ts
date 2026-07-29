// ─────────────────────────────────────────────────────────────────────────────
// POLÍTICA DE ARMAZENAMENTO DA INSTALAÇÃO.
//
// SEPARAÇÃO DELIBERADA: a Central PROVISIONA o storage (bucket, credencial,
// endpoint) — é infraestrutura, e quem contrata é o revendedor. A instalação
// decide O QUE mandar para lá — é operação, e quem sabe disso é quem opera a
// câmera. Ter o bucket configurado NÃO significa que tudo passa a subir.
//
// Sem isso, habilitar a nuvem viraria uma decisão de tudo-ou-nada: um cliente
// que só quer preservar gravação de movimento (a que vira prova) acabaria
// pagando para arquivar gravação contínua de corredor vazio 24h por dia.
//
// TRÊS EIXOS INDEPENDENTES, porque são três perguntas diferentes:
//   1. `enabled`      — usar a nuvem? (o interruptor mestre da instalação)
//   2. `triggerModes` — QUAIS gravações sobem? (contínua, movimento, manual)
//   3. `keepLocalCopy`— apagar o local depois de subir, ou manter os dois?
//
// O terceiro é o que separa "economizar disco" (tier) de "ter cópia externa"
// (backup). Misturá-los obrigaria quem quer só backup a aceitar perder o
// arquivo local, que é justamente o que ele NÃO quer.
// ─────────────────────────────────────────────────────────────────────────────

/** Modos de gatilho que uma gravação pode ter (espelha `Camera.recordingMode`). */
export const TRIGGER_MODES = ['continuous', 'motion', 'manual'] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];

export type StoragePolicy = {
  /** Interruptor mestre DA INSTALAÇÃO (independe de a Central ter provisionado). */
  enabled: boolean;
  /** Quais tipos de gravação sobem para a nuvem. */
  triggerModes: Record<TriggerMode, boolean>;
  /**
   * `true` = sobe e MANTÉM o arquivo local (nuvem como cópia de segurança).
   * `false` = sobe e apaga o local depois da janela (nuvem como armazenamento).
   */
  keepLocalCopy: boolean;
};

/**
 * Default conservador: nuvem DESLIGADA.
 *
 * Provisionar o bucket na Central não pode começar a enviar vídeo do cliente
 * sozinho — isso gera custo e movimenta dado sem ninguém ter pedido. Quem liga
 * é o operador, na instalação.
 *
 * Quando ligado, o default de tipos é só `motion` e `manual`: são as gravações
 * que viram prova. Contínua costuma ser volume alto de cena vazia, e subir isso
 * por padrão surpreenderia o cliente na fatura.
 */
export const DEFAULT_STORAGE_POLICY: StoragePolicy = {
  enabled: false,
  triggerModes: { continuous: false, motion: true, manual: true },
  keepLocalCopy: false,
};

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return fallback;
}

/** Normaliza o que veio do banco/API. Campo inválido cai no default, nunca em "ligado". */
export function normalizeStoragePolicy(input: unknown): StoragePolicy {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const modes = source.triggerModes && typeof source.triggerModes === 'object'
    ? (source.triggerModes as Record<string, unknown>)
    : {};

  const triggerModes = {} as Record<TriggerMode, boolean>;
  for (const mode of TRIGGER_MODES) {
    triggerModes[mode] = readBool(modes[mode], DEFAULT_STORAGE_POLICY.triggerModes[mode]);
  }

  return {
    enabled: readBool(source.enabled, DEFAULT_STORAGE_POLICY.enabled),
    triggerModes,
    keepLocalCopy: readBool(source.keepLocalCopy, DEFAULT_STORAGE_POLICY.keepLocalCopy),
  };
}

export type PolicyDecision =
  | { upload: true; deleteLocalAfterWindow: boolean }
  | { upload: false; reason: string };

/**
 * Esta gravação deve ir para a nuvem?
 *
 * `triggerMode` desconhecido NÃO sobe. É o estado de gravação antiga (backfill,
 * origem indeterminada), e subir o que não sabemos classificar contraria a
 * escolha explícita que o operador fez por tipo — além de gerar custo que ele
 * não previu.
 */
export function decideUpload(
  policy: StoragePolicy,
  recording: { triggerMode?: string | null },
): PolicyDecision {
  if (!policy.enabled) return { upload: false, reason: 'nuvem desligada nesta instalação' };

  const mode = String(recording.triggerMode ?? '').trim().toLowerCase();
  if (!TRIGGER_MODES.includes(mode as TriggerMode)) {
    return { upload: false, reason: `tipo de gravação não classificado (${mode || 'vazio'})` };
  }
  if (!policy.triggerModes[mode as TriggerMode]) {
    return { upload: false, reason: `tipo "${mode}" não está marcado para a nuvem` };
  }

  return { upload: true, deleteLocalAfterWindow: !policy.keepLocalCopy };
}

/** Tipos habilitados, para a consulta do que falta subir não varrer o acervo inteiro. */
export function enabledTriggerModes(policy: StoragePolicy): TriggerMode[] {
  return TRIGGER_MODES.filter((mode) => policy.triggerModes[mode]);
}

/** Resumo curto para a interface e para o log. */
export function describeStoragePolicy(policy: StoragePolicy): string {
  if (!policy.enabled) return 'Nuvem desligada — tudo fica em disco local.';
  const tipos = enabledTriggerModes(policy);
  if (!tipos.length) return 'Nuvem ligada, mas nenhum tipo de gravação selecionado — nada sobe.';
  const rotulos: Record<TriggerMode, string> = {
    continuous: 'contínua',
    motion: 'movimento',
    manual: 'manual',
  };
  const lista = tipos.map((t) => rotulos[t]).join(', ');
  return policy.keepLocalCopy
    ? `Enviando ${lista} para a nuvem e MANTENDO cópia local (backup).`
    : `Enviando ${lista} para a nuvem e liberando o disco local após a janela.`;
}
