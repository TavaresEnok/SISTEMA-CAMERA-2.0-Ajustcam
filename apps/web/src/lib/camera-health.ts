// Saúde POR CÂMERA na tela de Desempenho.
//
// Este módulo é 100% PURO (sem I/O, sem React, sem axios): recebe o payload do
// endpoint AUTENTICADO `GET /observability/cameras` e devolve o que a tabela
// precisa (estado, rótulos, ordem, resumo). A página só faz o fetch e desenha —
// toda a decisão de "isso é problema?" mora aqui e é coberta por teste
// (apps/web/tests/camera-health.test.mts).
//
// Nome/IP/URL de câmera NUNCA saem daqui para métrica pública: este payload é do
// endpoint autenticado e serve só à tela (o /metrics público usa camera_id).

/** Estado de apresentação de uma câmera na tabela. */
export type CameraHealthState = 'ok' | 'atencao' | 'critico';

/** Modo de gravação DESEJADO (configurado) para a câmera. */
export type RecordingDesired = 'continuous' | 'motion' | 'manual' | 'off';

export interface CameraHealthRecording {
  desired: RecordingDesired;
  active: boolean;
  lastSegmentAt: string | null;
  secondsSinceLastSegment: number | null;
  segmentsLastHour: number;
  restartsLastHour: number;
  stalled: boolean;
}

export interface CameraHealthStream {
  recoveriesLastHour: number;
  lastRecoveryAt: string | null;
}

export interface CameraHealthEntry {
  cameraId: string;
  name: string | null;
  enabled: boolean;
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  recording: CameraHealthRecording;
  stream: CameraHealthStream;
}

export interface CameraHealthPayload {
  generatedAt: string;
  cameras: CameraHealthEntry[];
  totals?: {
    cameras: number;
    recordingActive: number;
    stalled: number;
    offline: number;
  };
}

/** Linha pronta para a tabela: entrada + estado + rótulos já formatados. */
export interface CameraHealthRow extends CameraHealthEntry {
  state: CameraHealthState;
  /** Rótulo humano do tempo desde o último segmento gravado ('—' se não há). */
  sinceLabel: string;
  /** Nome exibido (cai para o id quando o backend manda name: null). */
  displayName: string;
}

/**
 * Fallback do limiar de "sem segmento recente", usado SÓ quando o servidor não
 * informa o seu (`staleThresholdSeconds` no payload).
 *
 * ⚠️ Não é constante de verdade: o limiar depende de RECORDING_SEGMENT_SECONDS,
 * que varia por instalação (a produção usa 300s, não 60s). Cravar um número aqui
 * marcava TODA câmera contínua como suspeita num ambiente de segmento maior — por
 * isso o servidor passou a mandar o valor real e este default é só rede de
 * segurança, alinhado ao pior caso do backend (max(180, segmento × 1.25)).
 */
export const STALE_SEGMENT_SECONDS = 375;

/**
 * A gravação deveria estar RODANDO o tempo todo?
 * - continuous/motion: sim (no modo motion o pipeline fica de pé escutando).
 * - manual: não (só grava quando o operador manda) — inativo NÃO é falha.
 * - off: não.
 */
export function expectsContinuousPipeline(desired: RecordingDesired): boolean {
  return desired === 'continuous' || desired === 'motion';
}

/**
 * Regra de classificação (documentada — mudou aqui, mude o teste junto):
 *
 * 1. Câmera DESATIVADA (enabled=false) → 'ok'. Foi desligada de propósito; não
 *    pode poluir o topo da tabela com problema que ninguém vai resolver.
 * 2. recording.stalled → 'critico'. O backend já concluiu que a gravação travou.
 * 3. Gravação esperada (continuous|motion) e recording.active=false → 'critico':
 *    é exatamente o caso "cliente acha que está gravando e não está".
 * 4. status OFFLINE → 'atencao'. A câmera sumiu, mas a gravação ainda não foi
 *    declarada estagnada — pode ser piscada de rede.
 * 5. Gravação CONTÍNUA sem segmento recente (null ou > STALE_SEGMENT_SECONDS)
 *    → 'atencao'. Não aplicamos a 'motion': lá é NORMAL passar horas sem
 *    segmento quando não há movimento — seria falso positivo em série.
 * 6. Resto → 'ok'.
 */
export function classifyCameraHealth(
  entry: CameraHealthEntry,
  staleThresholdSeconds: number = STALE_SEGMENT_SECONDS,
): CameraHealthState {
  if (!entry.enabled) return 'ok';

  const rec = entry.recording;
  if (rec.stalled) return 'critico';
  if (expectsContinuousPipeline(rec.desired) && !rec.active) return 'critico';

  if (entry.status === 'OFFLINE') return 'atencao';

  if (rec.desired === 'continuous') {
    // Limiar vem do SERVIDOR (que conhece a duração real do segmento); o default
    // só entra se o payload não trouxer um valor utilizável.
    const threshold = Number.isFinite(staleThresholdSeconds) && staleThresholdSeconds > 0
      ? staleThresholdSeconds
      : STALE_SEGMENT_SECONDS;
    const since = rec.secondsSinceLastSegment;
    if (since === null || !Number.isFinite(since) || since > threshold) return 'atencao';
  }

  return 'ok';
}

/**
 * "Há quanto tempo" a partir de segundos: 42s · 5min · 2h · 3d.
 * null/NaN/negativo → '—' (nunca inventa "0s" para quem nunca gravou).
 */
export function formatSinceLastSegment(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Peso de ordenação: problema PRIMEIRO. */
const STATE_WEIGHT: Record<CameraHealthState, number> = { critico: 0, atencao: 1, ok: 2 };

export function stateWeight(state: CameraHealthState): number {
  return STATE_WEIGHT[state];
}

/**
 * Ordem da tabela: crítico → atenção → ok e, dentro do grupo, por nome
 * (pt-BR, ignorando acento/caixa). Empate resolve pelo id: ordem estável entre
 * refreshes, senão as linhas dançam a cada 5s.
 */
export function compareCameraHealthRows(a: CameraHealthRow, b: CameraHealthRow): number {
  const byState = stateWeight(a.state) - stateWeight(b.state);
  if (byState !== 0) return byState;
  const byName = a.displayName.localeCompare(b.displayName, 'pt-BR', { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return a.cameraId.localeCompare(b.cameraId);
}

/** Entradas → linhas classificadas, formatadas e ORDENADAS (problemas no topo). */
export function buildCameraHealthRows(
  entries: CameraHealthEntry[],
  staleThresholdSeconds: number = STALE_SEGMENT_SECONDS,
): CameraHealthRow[] {
  return entries
    .map((entry) => ({
      ...entry,
      state: classifyCameraHealth(entry, staleThresholdSeconds),
      sinceLabel: formatSinceLastSegment(entry.recording.secondsSinceLastSegment),
      displayName: entry.name?.trim() ? entry.name.trim() : entry.cameraId,
    }))
    .sort(compareCameraHealthRows);
}

export interface CameraHealthSummary {
  total: number;
  critico: number;
  atencao: number;
  ok: number;
  recordingActive: number;
  offline: number;
}

/**
 * Resumo dos cartões. Contado A PARTIR DAS LINHAS (e não do `totals` do
 * payload) para o cartão nunca discordar da tabela que está logo abaixo.
 */
export function summarizeCameraHealth(rows: CameraHealthRow[]): CameraHealthSummary {
  const summary: CameraHealthSummary = {
    total: rows.length,
    critico: 0,
    atencao: 0,
    ok: 0,
    recordingActive: 0,
    offline: 0,
  };
  for (const row of rows) {
    summary[row.state] += 1;
    if (row.recording.active) summary.recordingActive += 1;
    if (row.status === 'OFFLINE') summary.offline += 1;
  }
  return summary;
}

const DESIRED_VALUES: RecordingDesired[] = ['continuous', 'motion', 'manual', 'off'];

function toDesired(value: unknown): RecordingDesired {
  return DESIRED_VALUES.includes(value as RecordingDesired) ? (value as RecordingDesired) : 'off';
}

function toFiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Normaliza o payload cru do endpoint. Devolve `null` para QUALQUER coisa que
 * não seja o contrato (404 vira null antes de chegar aqui, corpo estranho vira
 * null aqui) — a seção some e o resto da página continua igual. Campos soltos
 * faltando não derrubam a linha: caem em default conservador.
 */
/**
 * Extrai o limiar de estagnação que o SERVIDOR está usando. Sem ele o cliente
 * teria de adivinhar a duração do segmento (que varia por instalação) e marcaria
 * câmeras saudáveis como suspeitas. Payload sem o campo → default seguro.
 */
export function parseStaleThreshold(data: unknown): number {
  const raw = (data as { staleThresholdSeconds?: unknown } | null | undefined)?.staleThresholdSeconds;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : STALE_SEGMENT_SECONDS;
}

export function parseCameraHealthPayload(data: unknown): CameraHealthEntry[] | null {
  if (!data || typeof data !== 'object') return null;
  const cameras = (data as { cameras?: unknown }).cameras;
  if (!Array.isArray(cameras)) return null;

  const entries: CameraHealthEntry[] = [];
  for (const raw of cameras) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, any>;
    if (typeof item.cameraId !== 'string' || item.cameraId.length === 0) continue;
    const rec = (item.recording ?? {}) as Record<string, any>;
    const stream = (item.stream ?? {}) as Record<string, any>;
    entries.push({
      cameraId: item.cameraId,
      name: typeof item.name === 'string' ? item.name : null,
      enabled: item.enabled !== false,
      status: item.status === 'ONLINE' || item.status === 'OFFLINE' ? item.status : 'UNKNOWN',
      recording: {
        desired: toDesired(rec.desired),
        active: rec.active === true,
        lastSegmentAt: typeof rec.lastSegmentAt === 'string' ? rec.lastSegmentAt : null,
        secondsSinceLastSegment: toFiniteOrNull(rec.secondsSinceLastSegment),
        segmentsLastHour: toCount(rec.segmentsLastHour),
        restartsLastHour: toCount(rec.restartsLastHour),
        stalled: rec.stalled === true,
      },
      stream: {
        recoveriesLastHour: toCount(stream.recoveriesLastHour),
        lastRecoveryAt: typeof stream.lastRecoveryAt === 'string' ? stream.lastRecoveryAt : null,
      },
    });
  }
  return entries;
}

/** Rótulo em pt-BR do estado (mesmo vocabulário das recomendações da página). */
export function cameraHealthStateLabel(state: CameraHealthState): string {
  if (state === 'critico') return 'crítico';
  if (state === 'atencao') return 'atenção';
  return 'ok';
}

/** Rótulo do modo de gravação desejado. */
export function recordingDesiredLabel(desired: RecordingDesired): string {
  if (desired === 'continuous') return 'contínua';
  if (desired === 'motion') return 'movimento';
  if (desired === 'manual') return 'manual';
  return 'desligada';
}
