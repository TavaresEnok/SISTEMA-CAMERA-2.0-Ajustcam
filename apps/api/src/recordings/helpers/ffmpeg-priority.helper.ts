// ─────────────────────────────────────────────────────────────────────────────
// PRIORIDADE REBAIXADA PARA OS FFMPEG NÃO-CRÍTICOS.
//
// Derivado do Frigate (`frigate/util/ffmpeg.py`, licença MIT — Copyright (c)
// Blake Blackshear e contribuidores). Lá o ffmpeg auxiliar (exportação/concat) é
// prefixado com `nice -n PROCESS_PRIORITY_LOW` (19) "so concat doesn't starve
// detection". Aqui a coisa a não deixar morrer de fome é a GRAVAÇÃO: um cliente
// clicando "exportar 1 hora" dispara um libx264 que rouba CPU de todas as
// câmeras, e o modo de falha não é a exportação lenta — é a gravação furar.
//
// Regra de ouro deste módulo: rebaixar é BÔNUS, nunca requisito. Se `nice` não
// existir (imagem enxuta, outro SO, PATH diferente), o comando roda EXATAMENTE
// como rodava antes. Nenhuma exportação pode falhar por causa de prioridade.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';

/** Mesmo valor do `PROCESS_PRIORITY_LOW` do Frigate: o máximo de "cede a vez". */
export const FFMPEG_LOW_PRIORITY_NICENESS = 19;

export type LowPriorityPlan = {
  command: string;
  args: string[];
  /** true = o comando saiu rebaixado; false = segue em prioridade normal. */
  lowered: boolean;
};

// Sondagem cara (um subprocesso) feita UMA vez por processo e memorizada.
// `null` = ainda não sondado.
let niceAvailable: boolean | null = null;

/**
 * Zera (ou força) o cache da sondagem. `null` faz a próxima chamada sondar de
 * novo. Usado pelos testes e pelo caminho de recuperação em produção.
 */
export function resetNiceAvailabilityCache(value: boolean | null = null): void {
  niceAvailable = value;
}

/** Produção: `nice` sumiu na hora H — não tente rebaixar de novo neste processo. */
export function markNiceUnavailable(): void {
  niceAvailable = false;
}

/** O sistema tem `nice` E aceita a opção `-n`? Nunca lança. */
export function isNiceAvailable(): boolean {
  if (niceAvailable !== null) return niceAvailable;
  niceAvailable = probeNice();
  return niceAvailable;
}

function probeNice(): boolean {
  // `nice` é POSIX; no Windows não existe (e o equivalente teria outra sintaxe).
  if (process.platform === 'win32') return false;
  try {
    // Sonda o comando E a opção de uma vez: `nice -n 19 true`. Aumentar a
    // niceness (valor positivo) nunca exige privilégio, então status 0 aqui
    // significa que o prefixo vai funcionar de verdade.
    const result = spawnSync('nice', ['-n', String(FFMPEG_LOW_PRIORITY_NICENESS), 'true'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    if (result.error) return false;
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Monta o comando a executar. Com `nice` disponível devolve o comando
 * prefixado; sem ele, devolve o comando original INTACTO.
 */
export function planLowPriorityCommand(
  command: string,
  args: string[],
  niceness: number = FFMPEG_LOW_PRIORITY_NICENESS,
): LowPriorityPlan {
  if (!isNiceAvailable()) return { command, args, lowered: false };
  return { command: 'nice', args: ['-n', String(niceness), command, ...args], lowered: true };
}

/**
 * O erro é "binário não encontrado"? Distingue `nice` ausente (fallback) de um
 * erro REAL do ffmpeg (que precisa continuar subindo).
 */
export function isMissingCommandError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}
