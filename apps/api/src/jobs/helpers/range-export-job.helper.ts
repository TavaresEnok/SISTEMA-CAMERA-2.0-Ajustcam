// ─────────────────────────────────────────────────────────────────────────────
// FILA DE EXPORTAÇÃO POR INTERVALO — decisões puras.
//
// Hoje o transcode/exportação roda SÍNCRONO no request: três operadores clicando
// "Exportar" disparam três FFmpeg competindo com a GRAVAÇÃO das câmeras, e um
// restart do servidor perde o trabalho no meio. O Frigate resolve com fila
// (`frigate/jobs/export.py`) — mas EM MEMÓRIA: some no restart do mesmo jeito.
//
// Aqui a fila é BullMQ (Redis), que o projeto já usa. O que este módulo guarda é
// o que precisa ser DETERMINÍSTICO e testável sem Redis:
//   * a IDENTIDADE da exportação — (câmera, intervalo, perfil) → jobId e nome de
//     arquivo estáveis, para que clicar duas vezes não gere duas provas;
//   * o mapa de PROGRESSO, para a tela poder dizer "copiando" × "reencodando";
//   * o plano de RECUPERAÇÃO DE ÓRFÃOS: job que ficou ACTIVE porque o processo
//     morreu (deploy, OOM, queda) e não tem ninguém trabalhando nele.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { parseFiniteNumber } from '../../common/config/env-number.helper';

export type RangeExportProfile = 'auto' | 'compatible';

export interface RangeExportIdentity {
  cameraId: string;
  fromMs: number;
  toMs: number;
  profile: RangeExportProfile;
}

function toMs(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError(`Data inválida na identidade da exportação: ${String(value)}`);
  }
  return Math.trunc(ms);
}

/**
 * Normaliza a identidade da exportação. Duas formas do MESMO instante
 * ("...T10:00:00Z" e um `Date`) têm de gerar a mesma identidade — senão o
 * clique duplo do operador vira dois FFmpeg sobre a mesma prova.
 */
export function normalizeRangeExportIdentity(input: {
  cameraId: string;
  from: Date | string | number;
  to: Date | string | number;
  profile?: RangeExportProfile | string | null;
}): RangeExportIdentity {
  const cameraId = String(input.cameraId ?? '').trim();
  if (!cameraId) throw new RangeError('cameraId é obrigatório na identidade da exportação.');
  const profile: RangeExportProfile = input.profile === 'compatible' ? 'compatible' : 'auto';
  return { cameraId, fromMs: toMs(input.from), toMs: toMs(input.to), profile };
}

function identityKey(identity: RangeExportIdentity): string {
  const canonical = [identity.cameraId, identity.fromMs, identity.toMs, identity.profile].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Id do job na fila. Sem `:` de propósito: o BullMQ recusa id com dois-pontos
 * (ele monta as chaves do Redis com esse separador). O prefixo `rex-` deixa o
 * job reconhecível num `redis-cli KEYS`.
 */
export function buildRangeExportJobId(identity: RangeExportIdentity): string {
  return `rex-${identityKey(identity)}`;
}

/**
 * Nome do arquivo exportado — derivado da MESMA identidade, então a
 * idempotência vale também em disco: re-exportar o mesmo intervalo encontra o
 * arquivo pronto em vez de gerar um segundo (e `ExportedClip.filePath` é UNIQUE
 * no banco, o que fecha a porta de vez).
 */
export function buildRangeExportFileName(identity: RangeExportIdentity): string {
  return `range-${identityKey(identity)}.mp4`;
}

// ── Progresso ────────────────────────────────────────────────────────────────

export const RANGE_EXPORT_STEPS = [
  'queued',
  'planning',
  'copying',
  'encoding',
  'validating',
  'hashing',
  'done',
] as const;

export type RangeExportStep = (typeof RANGE_EXPORT_STEPS)[number];

const STEP_PERCENT: Record<RangeExportStep, number> = {
  queued: 0,
  planning: 5,
  // Copiar é ordens de grandeza mais rápido que reencodar: o operador precisa
  // enxergar em qual dos dois caminhos ele caiu.
  copying: 20,
  encoding: 40,
  validating: 75,
  hashing: 90,
  done: 100,
};

export function rangeExportProgress(step: RangeExportStep): { step: RangeExportStep; percent: number } {
  return { step, percent: STEP_PERCENT[step] };
}

// ── Recuperação de órfãos ────────────────────────────────────────────────────

export interface ActiveExportJobView {
  id: string;
  /** Momento em que o worker pegou o job (BullMQ: `job.processedOn`). */
  processedOn?: number | null;
  /** Último progresso publicado — o batimento cardíaco do job. */
  heartbeatAt?: number | null;
  attemptsMade?: number | null;
}

export type OrphanAction = 'keep' | 'requeue' | 'abandon';

export interface OrphanRecoveryDecision {
  id: string;
  action: OrphanAction;
  reason: string;
  staleForMs: number;
}

export interface OrphanRecoveryOptions {
  now: number;
  staleAfterMs: number;
  maxAttempts: number;
}

const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Decide o que fazer com cada job que o Redis ainda lista como ACTIVE.
 *
 * Regras (uma por modo de falha real):
 *  * batimento recente ⇒ `keep`: tem gente trabalhando, mexer aborta exportação boa;
 *  * batimento velho (ou nenhum) ⇒ `requeue`: o processo que segurava o job morreu;
 *  * já gastou as tentativas ⇒ `abandon`: job que derruba o processo e volta para
 *    a fila vira crash-loop da API inteira — a exportação some, o VMS fica de pé.
 *
 * Limite inválido (NaN vindo de env mal escrito) NÃO desarma a guarda: cai no
 * padrão seguro, que é não mexer em job vivo.
 */
export function planOrphanRecovery(
  jobs: ActiveExportJobView[],
  options: OrphanRecoveryOptions,
): OrphanRecoveryDecision[] {
  const now = parseFiniteNumber(options?.now) ?? Date.now();
  const staleAfterMs = Math.max(0, parseFiniteNumber(options?.staleAfterMs) ?? DEFAULT_STALE_AFTER_MS);
  const maxAttempts = Math.max(1, Math.trunc(parseFiniteNumber(options?.maxAttempts) ?? DEFAULT_MAX_ATTEMPTS));

  return (jobs ?? []).map((job) => {
    const heartbeat = parseFiniteNumber(job.heartbeatAt) ?? parseFiniteNumber(job.processedOn);
    const staleForMs = heartbeat === null ? Number.POSITIVE_INFINITY : Math.max(0, now - heartbeat);
    if (staleForMs <= staleAfterMs) {
      return { id: job.id, action: 'keep', reason: 'batimento_recente', staleForMs };
    }
    const attemptsMade = Math.max(0, Math.trunc(parseFiniteNumber(job.attemptsMade) ?? 0));
    if (attemptsMade + 1 >= maxAttempts) {
      return {
        id: job.id,
        action: 'abandon',
        reason: `tentativas_esgotadas:${attemptsMade}/${maxAttempts}`,
        staleForMs,
      };
    }
    return {
      id: job.id,
      action: 'requeue',
      reason: heartbeat === null ? 'sem_batimento' : 'batimento_expirado',
      staleForMs,
    };
  });
}
