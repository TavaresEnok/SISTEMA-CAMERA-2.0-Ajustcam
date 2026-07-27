// DIAGNÓSTICO RICO DA CÂMERA JÁ SALVA — camada de tela.
//
// Módulo 100% PURO (sem React, sem axios): recebe o payload de
// `GET /cameras/:id/live-diagnostics` e devolve o que a aba de configurações
// desenha. Toda a decisão "o que o técnico lê primeiro" e "de que cor" mora aqui
// e é coberta por teste (apps/web/tests/camera-diagnostics-view.test.mts).
//
// O relatório compara o que foi DETECTADO agora com o que está CONFIGURADO; a
// divergência é o diagnóstico. Duas regras não negociáveis desta camada:
//  1. A tela NÃO PODE QUEBRAR — payload truncado/antigo/nulo vira relatório
//     vazio, nunca exceção. É a tela que o técnico abre justamente quando a
//     câmera está ruim.
//  2. O que NÃO foi confirmado nunca é pintado de verde. Verde falso faria o
//     técnico ir embora deixando a câmera quebrada no local.

export type DiagnosticsState = 'ok' | 'diverged' | 'unreachable';
export type FindingState = 'match' | 'diverged' | 'unknown';
export type FindingSeverity = 'info' | 'warning' | 'critical';
export type DiagnosticsTone = 'good' | 'warn' | 'bad' | 'neutral';

export type DiagnosticsFinding = {
  key: string;
  label: string;
  configured: string | null;
  detected: string | null;
  state: FindingState;
  severity: FindingSeverity;
  message: string;
};

export type TranscodeVerdict = {
  pipeline: string;
  label: string;
  transcoding: boolean;
  code: string;
  reason: string;
  certainty: 'measured' | 'assumed';
};

export type CameraDiagnosticsView = {
  cameraId: string | null;
  cameraName: string | null;
  state: DiagnosticsState;
  reachable: boolean;
  summary: string;
  checkedAt: string | null;
  findings: DiagnosticsFinding[];
  transcode: TranscodeVerdict[];
  detected: { main: string | null; sub: string | null };
  error: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length ? value.trim() : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function parseFinding(raw: unknown): DiagnosticsFinding | null {
  const data = record(raw);
  const key = data ? str(data.key) : null;
  if (!data || !key) return null;
  return {
    key,
    label: str(data.label) ?? key,
    configured: str(data.configured),
    detected: str(data.detected),
    state: oneOf(data.state, ['match', 'diverged', 'unknown'] as const, 'unknown'),
    severity: oneOf(data.severity, ['info', 'warning', 'critical'] as const, 'info'),
    message: str(data.message) ?? '',
  };
}

function parseVerdict(raw: unknown): TranscodeVerdict | null {
  const data = record(raw);
  const pipeline = data ? str(data.pipeline) : null;
  if (!data || !pipeline) return null;
  return {
    pipeline,
    label: str(data.label) ?? pipeline,
    transcoding: data.transcoding === true,
    code: str(data.code) ?? 'passthrough',
    reason: str(data.reason) ?? '',
    certainty: oneOf(data.certainty, ['measured', 'assumed'] as const, 'assumed'),
  };
}

function list<T>(raw: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parse).filter((item): item is T => item !== null);
}

export function parseDiagnosticsReport(raw: unknown): CameraDiagnosticsView | null {
  const data = record(raw);
  if (!data) return null;
  const detected = record(data.detected);
  return {
    cameraId: str(data.cameraId),
    cameraName: str(data.cameraName),
    // Estado desconhecido não pode virar 'ok': o relatório jamais afirma que
    // está tudo certo por não ter entendido a resposta.
    state: oneOf(data.state, ['ok', 'diverged', 'unreachable'] as const, 'unreachable'),
    reachable: data.reachable === true,
    summary: str(data.summary) ?? 'Diagnóstico sem resumo.',
    checkedAt: str(data.checkedAt),
    findings: list(data.findings, parseFinding),
    transcode: list(data.transcode, parseVerdict),
    detected: {
      main: detected ? str(detected.main) : null,
      sub: detected ? str(detected.sub) : null,
    },
    error: str(data.error),
  };
}

const STATE_WEIGHT: Record<FindingState, number> = { diverged: 0, unknown: 1, match: 2 };
const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Crítico → divergente → não confirmado → igual ao configurado. */
export function orderFindings(findings: DiagnosticsFinding[]): DiagnosticsFinding[] {
  return [...findings].sort((a, b) => {
    const byState = STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state];
    if (byState !== 0) return byState;
    return SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
  });
}

export function diagnosticsTone(finding: Pick<DiagnosticsFinding, 'state' | 'severity'>): DiagnosticsTone {
  if (finding.state === 'unknown') return 'neutral';
  if (finding.state === 'match') return 'good';
  return finding.severity === 'critical' ? 'bad' : 'warn';
}

export function reportTone(report: CameraDiagnosticsView | null): DiagnosticsTone {
  if (!report) return 'neutral';
  if (report.state === 'unreachable') return 'neutral';
  if (report.state === 'ok') return 'good';
  return report.findings.some((item) => item.state === 'diverged' && item.severity === 'critical')
    ? 'bad'
    : 'warn';
}

/**
 * Linhas do "por que está transcodificando". Só quem transcoda aparece: listar
 * pipeline em passthrough como se fosse notícia é alarme falso, e alarme falso
 * treina o técnico a ignorar a tela.
 */
export function summarizeTranscode(verdicts: TranscodeVerdict[]): string[] {
  return verdicts
    .filter((item) => item.transcoding)
    .map((item) => {
      const suffix = item.certainty === 'assumed' ? ' (codec não confirmado agora — suposição)' : '';
      return `${item.label}: ${item.reason}${suffix}`;
    });
}
