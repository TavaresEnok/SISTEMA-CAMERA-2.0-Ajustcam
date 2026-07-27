// ─────────────────────────────────────────────────────────────────────────────
// Saúde POR CÂMERA dentro do heartbeat que a instalação manda para a DRAC
// Central (a cada 60s, e a Central ARMAZENA). Regras puras aqui de propósito:
// é o único jeito de provar o corte/prioridade sem banco, sem rede e sem relógio.
//
// Três decisões que são contrato, não estilo:
//
// 1) ECONOMIA. O relatório autenticado (GET /observability/cameras) tem muito
//    mais campo do que o painel de frota usa. Cada campo extra aqui é tráfego a
//    cada 60s e linha em disco na Central, para sempre, vezes N instalações.
//    Só sai o que o painel desenha: identificação, status e o mínimo de gravação.
//
// 2) TETO COM PRIORIDADE. Uma instalação de 400 câmeras não pode estourar o
//    heartbeat. Mas truncar a lista "como veio" (o relatório vem ordenado por
//    NOME) esconderia justamente as câmeras quebradas — o único motivo do painel
//    existir. Então o corte é por GRAVIDADE: travadas primeiro, depois gravação
//    esperada e inativa, depois as que não estão ONLINE, e as saudáveis por
//    último. O que não coube vira um contador (`omitted`).
//
// 3) TOTAIS E ALERTAS SÃO DA FROTA INTEIRA. Eles são calculados ANTES do corte:
//    se encolhessem junto com a lista, a Central acionaria suporte com o número
//    errado numa instalação grande — exatamente onde isso mais importa.
// ─────────────────────────────────────────────────────────────────────────────

/** Teto padrão de câmeras no payload (ajustável por CLOUD_HEARTBEAT_CAMERA_LIMIT). */
export const HEARTBEAT_CAMERA_LIMIT_DEFAULT = 250;

/**
 * A partir de quantas câmeras travadas o alerta vira `critical`. Mesmo degrau do
 * `stream_high_cpu_risk` que já existe no heartbeat: 1–2 é incidente isolado,
 * 3+ é frota caindo (falha de storage/rede/worker, não de uma câmera).
 */
export const HEARTBEAT_CAMERAS_STALLED_CRITICAL = 3;

export type HeartbeatAlert = { level: 'warning' | 'critical'; code: string; message: string };

type DesiredRecording = 'continuous' | 'motion' | 'manual' | 'off';

/**
 * Entrada = o relatório do CameraObservabilityService. Declarado de forma
 * ESTRUTURAL e só com o que é lido: o relatório real (que tem campos a mais)
 * continua atribuível, e este módulo não passa a depender do formato completo
 * de um serviço de outra área.
 */
export type HeartbeatCameraHealthInput = {
  cameras?: Array<{
    cameraId: string;
    name: string | null;
    status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
    recording: {
      desired: DesiredRecording;
      active: boolean;
      stalled: boolean;
      secondsSinceLastSegment: number | null;
      restartsLastHour: number;
    };
  }>;
  staleThresholdSeconds?: number;
};

export type HeartbeatCameraItem = {
  cameraId: string;
  name: string | null;
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  recording: {
    desired: DesiredRecording;
    active: boolean;
    stalled: boolean;
    secondsSinceLastSegment: number | null;
    restartsLastHour: number;
  };
};

export type HeartbeatCamerasBlock = {
  /** Da frota INTEIRA — não encolhe quando a lista é truncada. */
  totals: { cameras: number; recordingActive: number; stalled: number; offline: number };
  /** Limiar de estagnação em uso, para a Central ler `secondsSinceLastSegment` sem adivinhar. */
  staleThresholdSeconds: number;
  /** Quantas câmeras não couberam no teto (as menos graves). */
  omitted: number;
  items: HeartbeatCameraItem[];
};

/** Menor = mais grave = entra primeiro no payload. */
function severityRank(item: HeartbeatCameraItem): number {
  if (item.recording.stalled) return 0;
  if (item.recording.desired !== 'off' && !item.recording.active) return 1;
  if (item.status !== 'ONLINE') return 2;
  return 3;
}

function project(camera: NonNullable<HeartbeatCameraHealthInput['cameras']>[number]): HeartbeatCameraItem {
  const recording = camera?.recording ?? ({} as HeartbeatCameraItem['recording']);
  const seconds = recording.secondsSinceLastSegment;
  return {
    cameraId: String(camera?.cameraId ?? ''),
    name: camera?.name ?? null,
    status: camera?.status ?? 'UNKNOWN',
    recording: {
      desired: recording.desired ?? 'off',
      active: Boolean(recording.active),
      stalled: Boolean(recording.stalled),
      secondsSinceLastSegment: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null,
      restartsLastHour: Number.isFinite(recording.restartsLastHour) ? Number(recording.restartsLastHour) : 0,
    },
  };
}

/**
 * Monta o bloco `cameras` do heartbeat e os alertas derivados, no MESMO esquema
 * {level, code, message} dos alertas que a Central já exibe e historia.
 */
export function buildHeartbeatCameras(
  report: HeartbeatCameraHealthInput,
  limit: number,
): { cameras: HeartbeatCamerasBlock; alerts: HeartbeatAlert[] } {
  const source = Array.isArray(report?.cameras) ? report.cameras : [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HEARTBEAT_CAMERA_LIMIT_DEFAULT;

  const totals = { cameras: source.length, recordingActive: 0, stalled: 0, offline: 0 };
  let expectedInactive = 0;

  const ranked = source.map((camera, index) => {
    const item = project(camera);
    if (item.recording.active) totals.recordingActive += 1;
    if (item.recording.stalled) totals.stalled += 1;
    if (item.status === 'OFFLINE') totals.offline += 1;
    // Travada já é denunciada pelo alerta mais forte: contar de novo aqui daria
    // dois alertas para o mesmo defeito.
    if (!item.recording.stalled && item.recording.desired !== 'off' && !item.recording.active) {
      expectedInactive += 1;
    }
    return { item, index, rank: severityRank(item) };
  });

  // `index` no desempate: o corte precisa ser determinístico entre heartbeats.
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);

  const items = ranked.slice(0, cap).map((entry) => entry.item);

  const staleThresholdSeconds = Number.isFinite(report?.staleThresholdSeconds)
    ? Number(report.staleThresholdSeconds)
    : 0;

  const alerts: HeartbeatAlert[] = [];
  if (totals.stalled > 0) {
    alerts.push({
      level: totals.stalled >= HEARTBEAT_CAMERAS_STALLED_CRITICAL ? 'critical' : 'warning',
      code: 'cameras_stalled',
      message: `${totals.stalled} camera(s) com gravacao estagnada (sem segmento novo).`,
    });
  }
  if (expectedInactive > 0) {
    alerts.push({
      level: 'warning',
      code: 'camera_recording_expected_inactive',
      message: `${expectedInactive} camera(s) com gravacao esperada e nenhum processo ativo.`,
    });
  }

  return {
    cameras: { totals, staleThresholdSeconds, omitted: Math.max(source.length - items.length, 0), items },
    alerts,
  };
}
