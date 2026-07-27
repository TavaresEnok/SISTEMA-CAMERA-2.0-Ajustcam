import {
  type CameraMetricsSnapshot,
  type CameraProcessUsage,
  type HostProcessUsage,
} from './camera-metrics.service';
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
  const brakes: Metric[] = [];

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

    // Freio anti-tempestade armado = o watchdog DESISTIU desta câmera por um
    // tempo. É o sinal de "manda alguém no local": vale alerta, não só gráfico.
    brakes.push({
      name: 'drac_camera_stream_recovery_brakes_total',
      help: 'Vezes que o freio anti-tempestade pausou a recuperação desta câmera (fonte não volta sozinha)',
      type: 'counter',
      value: snapshot?.brakesTotal ?? 0,
      labels,
    });
  }

  // Agrupadas por NOME: o formato exige as amostras de uma métrica contíguas
  // (HELP/TYPE únicos, emitidos pelo formatPrometheus na primeira amostra).
  return [...recordingActive, ...secondsSince, ...restarts, ...recoveries, ...brakes];
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTO (CPU/memória) por câmera e agregado do host.
//
// Mesma regra de privacidade do topo do arquivo, com um agravante: o PID e o
// `kind` do processo NÃO viram rótulo. O PID porque é alta cardinalidade que
// muda a cada reinício de FFmpeg (série nova a cada queda de câmera = TSDB
// inchado sem informação nova); o detalhe por processo vive na rota AUTENTICADA
// GET /observability/cameras. E NADA que descreva o processo (nome do binário,
// cmdline) chega aqui — a linha de comando do FFmpeg de gravação carrega a URL
// RTSP com senha.
// ─────────────────────────────────────────────────────────────────────────────

export type ProcessSeriesInput = {
  usages: CameraProcessUsage[];
  totals: HostProcessUsage;
};

export function buildProcessSeries(input: ProcessSeriesInput): Metric[] {
  const usages = (input?.usages ?? [])
    .filter((usage) => isPublishableCameraId(usage?.cameraId))
    .sort((a, b) => a.cameraId.localeCompare(b.cameraId))
    .slice(0, CAMERA_SERIES_LIMIT);

  const cpu: Metric[] = [];
  const memory: Metric[] = [];
  const count: Metric[] = [];

  for (const usage of usages) {
    // Um rótulo. Só um.
    const labels = { camera_id: usage.cameraId };
    cpu.push({
      name: 'drac_camera_process_cpu_percent',
      help: 'CPU somada dos processos desta câmera (100 = um núcleo saturado)',
      type: 'gauge',
      value: usage.cpuPercent,
      labels,
    });
    memory.push({
      name: 'drac_camera_process_memory_bytes',
      help: 'Memória residente somada dos processos desta câmera',
      type: 'gauge',
      value: usage.memoryBytes,
      labels,
    });
    count.push({
      name: 'drac_camera_process_count',
      help: 'Processos rastreados desta câmera (gravação, pré-buffer, transcode)',
      type: 'gauge',
      value: usage.processes,
      labels,
    });
  }

  const totals = input?.totals;
  const host: Metric[] = [];
  if (totals) {
    host.push({
      name: 'drac_host_camera_process_cpu_percent',
      help: 'CPU do host atribuída a câmeras (100 = um núcleo saturado)',
      type: 'gauge',
      value: totals.cpuPercent,
    });
    host.push({
      name: 'drac_host_camera_process_memory_bytes',
      help: 'Memória residente do host atribuída a câmeras',
      type: 'gauge',
      value: totals.memoryBytes,
    });
    host.push({
      name: 'drac_host_cpu_budget_cores',
      help: 'Núcleos REALMENTE disponíveis (cota do cgroup quando há container)',
      type: 'gauge',
      value: totals.cpuBudgetCores,
    });
    host.push({
      name: 'drac_host_camera_process_cameras',
      help: 'Câmeras com custo medido neste host',
      type: 'gauge',
      value: totals.cameras,
    });
    // Este é o número de alerta: >0.8 sustentado = o host está no limite.
    if (totals.cpuSaturation != null) {
      host.push({
        name: 'drac_host_camera_process_cpu_saturation',
        help: 'Fração do orçamento de CPU consumida pelas câmeras (1 = esgotado)',
        type: 'gauge',
        value: totals.cpuSaturation,
      });
    }
    // Extrapolação da média medida com 20% de folga. Só existe com base real.
    if (totals.estimatedCameraCapacity != null) {
      host.push({
        name: 'drac_host_camera_capacity_estimate',
        help: 'Câmeras que este host suporta pela média medida (20% de folga reservada)',
        type: 'gauge',
        value: totals.estimatedCameraCapacity,
      });
    }
  }

  return [...cpu, ...memory, ...count, ...host];
}
