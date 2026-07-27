import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RecordingProcessManagerService } from '../recordings/recording-process-manager.service';
import { CameraMetricsService } from './camera-metrics.service';
import {
  isRecordingStalled,
  normalizeCameraStatus,
  resolveDesiredRecording,
  type DesiredRecording,
} from './camera-health.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Contrato A — saúde POR CÂMERA na rota AUTENTICADA GET /observability/cameras.
// Aqui o nome da câmera PODE aparecer (a rota exige ADMIN + serverConfig); o que
// nunca pode é isso vazar para o /metrics público.
//
// PERFORMANCE: DUAS queries no total, independentemente do tamanho da frota —
// uma para as câmeras e UMA agregação (groupBy) para o último segmento de TODAS.
// Nada de consulta por câmera: numa instalação com 100+ câmeras um N+1 aqui
// competiria com a gravação pelo mesmo pool de conexões.
// ─────────────────────────────────────────────────────────────────────────────

export type CameraHealthItem = {
  cameraId: string;
  name: string | null;
  enabled: boolean;
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  recording: {
    desired: DesiredRecording;
    active: boolean;
    lastSegmentAt: string | null;
    secondsSinceLastSegment: number | null;
    segmentsLastHour: number;
    restartsLastHour: number;
    stalled: boolean;
  };
  stream: {
    recoveriesLastHour: number;
    lastRecoveryAt: string | null;
  };
};

export type CameraHealthReport = {
  generatedAt: string;
  cameras: CameraHealthItem[];
  totals: { cameras: number; recordingActive: number; stalled: number; offline: number };
  /**
   * Limiar de estagnação REALMENTE em uso (derivado de RECORDING_SEGMENT_SECONDS).
   * Vai no payload para o cliente não precisar adivinhar a duração do segmento:
   * um front com constante fixa marcaria toda câmera como suspeita num ambiente
   * com segmento maior que o que ele assumiu.
   */
  staleThresholdSeconds: number;
};

/** Idade máxima do último segmento para inferir "gravando" sem processo local. */
const WORKER_RECENT_SEGMENT_SECONDS = 15 * 60;

@Injectable()
export class CameraObservabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recordings: RecordingProcessManagerService,
    private readonly cameraMetrics: CameraMetricsService,
  ) {}

  /** Costura de relógio (sobrescrita nos testes). */
  private now(): number {
    return Date.now();
  }

  async getCamerasHealth(): Promise<CameraHealthReport> {
    const nowMs = this.now();
    const generatedAt = new Date(nowMs).toISOString();

    const cameras = await this.prisma.camera.findMany({
      select: {
        id: true,
        name: true,
        enabled: true,
        status: true,
        recordingMode: true,
        recordingEnabled: true,
      },
      orderBy: { name: 'asc' },
    });

    if (!cameras.length) {
      return {
        generatedAt,
        cameras: [],
        totals: { cameras: 0, recordingActive: 0, stalled: 0, offline: 0 },
        staleThresholdSeconds: this.recordings.getRecordingStaleThresholdSeconds(),
      };
    }

    // UMA agregação para a frota inteira (o índice [cameraId, startedAt] cobre).
    const lastSegmentByCamera = await this.loadLastSegmentByCamera();

    const runtime = this.recordings.getRuntimeSummary();
    const activeLocal = new Set<string>(runtime.activeCameraIds ?? []);
    const isWorkerMode = runtime.controlMode === 'worker';
    const staleThresholdSeconds = this.recordings.getRecordingStaleThresholdSeconds();

    let recordingActive = 0;
    let stalledCount = 0;
    let offlineCount = 0;

    const items: CameraHealthItem[] = cameras.map((camera) => {
      const lastSegmentAtMs = lastSegmentByCamera.get(camera.id) ?? null;
      const secondsSinceLastSegment = lastSegmentAtMs == null
        ? null
        : Math.max(0, Math.floor((nowMs - lastSegmentAtMs) / 1000));

      // Mantém o /metrics público informado do último segmento sem que ELE
      // precise consultar o banco (só AVANÇA a marca-d'água; não conta evento).
      if (lastSegmentAtMs != null) this.cameraMetrics.observeLastSegmentAt(camera.id, lastSegmentAtMs);

      const desired = resolveDesiredRecording(camera);
      // Em modo worker a gravação roda fora deste processo: não há entrada em
      // `active`, então "gravando" é inferido do segmento recente (mesma regra
      // do getStatus do RecordingProcessManagerService).
      const active = isWorkerMode
        ? Boolean(camera.recordingEnabled)
          && secondsSinceLastSegment != null
          && secondsSinceLastSegment < WORKER_RECENT_SEGMENT_SECONDS
        : activeLocal.has(camera.id);

      const stalled = isRecordingStalled({ desired, active, secondsSinceLastSegment, staleThresholdSeconds });
      const snapshot = this.cameraMetrics.snapshot(camera.id);
      const status = normalizeCameraStatus(camera.status);

      if (active) recordingActive += 1;
      if (stalled) stalledCount += 1;
      if (status === 'OFFLINE') offlineCount += 1;

      return {
        cameraId: camera.id,
        name: camera.name ?? null,
        enabled: camera.enabled !== false,
        status,
        recording: {
          desired,
          active,
          lastSegmentAt: lastSegmentAtMs == null ? null : new Date(lastSegmentAtMs).toISOString(),
          secondsSinceLastSegment,
          segmentsLastHour: snapshot.segmentsLastHour,
          restartsLastHour: snapshot.restartsLastHour,
          stalled,
        },
        stream: {
          recoveriesLastHour: snapshot.recoveriesLastHour,
          lastRecoveryAt: snapshot.lastRecoveryAt ? snapshot.lastRecoveryAt.toISOString() : null,
        },
      };
    });

    return {
      generatedAt,
      cameras: items,
      totals: { cameras: items.length, recordingActive, stalled: stalledCount, offline: offlineCount },
      staleThresholdSeconds,
    };
  }

  /** groupBy ÚNICO: cameraId → instante do último segmento (ms). */
  private async loadLastSegmentByCamera(): Promise<Map<string, number>> {
    const rows = await this.prisma.recording.groupBy({
      by: ['cameraId'],
      _max: { startedAt: true, endedAt: true },
    });
    const map = new Map<string, number>();
    for (const row of rows as Array<{ cameraId: string; _max: { startedAt: Date | null; endedAt: Date | null } }>) {
      // endedAt é o fim do segmento (mais recente que startedAt); um segmento
      // ainda aberto tem endedAt nulo, daí o fallback.
      const startedMs = row._max?.startedAt ? new Date(row._max.startedAt).getTime() : null;
      const endedMs = row._max?.endedAt ? new Date(row._max.endedAt).getTime() : null;
      const candidates = [startedMs, endedMs].filter((v): v is number => v != null && Number.isFinite(v));
      if (!candidates.length) continue;
      map.set(row.cameraId, Math.max(...candidates));
    }
    return map;
  }
}
