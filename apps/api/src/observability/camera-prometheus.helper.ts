import { type CameraMetricsSnapshot } from './camera-metrics.service';
import { type Metric } from './prometheus.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Séries POR CÂMERA do /metrics (contrato B).
//
// REGRA DE PRIVACIDADE (LGPD) — INEGOCIÁVEL: o /metrics é @Public. O ÚNICO
// rótulo permitido aqui é `camera_id`. Nome da câmera identifica o CLIENTE, IP
// e URL revelam a topologia (e a URL RTSP carrega credencial). Por isso:
//  1. a função só recebe ids (o registro em memória nunca guarda nome/IP);
//  2. ids que NÃO têm forma de identificador (UUID ou 32-hex do path MediaMTX)
//     são DESCARTADOS — fail-closed: se algum dia alguém passar um nome/IP como
//     "cameraId", ele não é publicado.
// ─────────────────────────────────────────────────────────────────────────────

/** UUID canônico (id do Camera) ou 32-hex (forma usada no path do MediaMTX). */
const CAMERA_ID_RE = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32})$/;

/** Teto de câmeras publicadas por scrape (proteção de cardinalidade). */
export const CAMERA_SERIES_LIMIT = 2000;

export function isPublishableCameraId(cameraId: unknown): cameraId is string {
  return typeof cameraId === 'string' && CAMERA_ID_RE.test(cameraId);
}

export type CameraSeriesInput = {
  snapshots: CameraMetricsSnapshot[];
  /** Câmeras com processo de gravação ativo AGORA neste host. */
  activeCameraIds: Iterable<string>;
  nowMs?: number;
};

export function buildCameraSeries(input: CameraSeriesInput): Metric[] {
  const now = input.nowMs ?? Date.now();
  const active = new Set<string>();
  for (const id of input.activeCameraIds ?? []) {
    if (isPublishableCameraId(id)) active.add(id);
  }

  const byId = new Map<string, CameraMetricsSnapshot | null>();
  for (const id of active) byId.set(id, null);
  for (const snapshot of input.snapshots ?? []) {
    if (!isPublishableCameraId(snapshot?.cameraId)) continue;
    byId.set(snapshot.cameraId, snapshot);
  }

  const ids = [...byId.keys()].sort().slice(0, CAMERA_SERIES_LIMIT);

  const recordingActive: Metric[] = [];
  const secondsSince: Metric[] = [];
  const restarts: Metric[] = [];
  const recoveries: Metric[] = [];

  for (const cameraId of ids) {
    const snapshot = byId.get(cameraId) ?? null;
    // Um rótulo. Só um. Ver a regra de privacidade no topo do arquivo.
    const labels = { camera_id: cameraId };

    recordingActive.push({
      name: 'drac_camera_recording_active',
      help: 'Gravação ativa nesta câmera (1) ou não (0)',
      type: 'gauge',
      value: active.has(cameraId) ? 1 : 0,
      labels,
    });

    const lastSegmentMs = snapshot?.lastSegmentAt ? snapshot.lastSegmentAt.getTime() : null;
    if (lastSegmentMs != null && Number.isFinite(lastSegmentMs)) {
      secondsSince.push({
        name: 'drac_camera_seconds_since_last_segment',
        help: 'Segundos desde o último segmento gravado por esta câmera',
        type: 'gauge',
        // Nunca negativo: um relógio que anda para trás não pode virar valor absurdo.
        value: Math.max(0, Math.floor((now - lastSegmentMs) / 1000)),
        labels,
      });
    }

    restarts.push({
      name: 'drac_camera_recording_restarts_total',
      help: 'Reinícios/quedas não solicitadas do processo de gravação desta câmera',
      type: 'counter',
      value: snapshot?.restartsTotal ?? 0,
      labels,
    });

    recoveries.push({
      name: 'drac_camera_stream_recoveries_total',
      help: 'Recuperações de path travado (watchdog do MediaMTX) desta câmera',
      type: 'counter',
      value: snapshot?.recoveriesTotal ?? 0,
      labels,
    });
  }

  // Agrupadas por NOME: o formato exige as amostras de uma métrica contíguas
  // (HELP/TYPE únicos, emitidos pelo formatPrometheus na primeira amostra).
  return [...recordingActive, ...secondsSince, ...restarts, ...recoveries];
}
