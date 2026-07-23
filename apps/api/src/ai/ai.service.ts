import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

type RolloutCameraMetrics = {
  cameraId: string;
  running: boolean;
  analysisType: string | null;
  advancedAnalysisType: string | null;
  qosMode: string | null;
  qosLiveEnabled: boolean;
  adaptiveFeatureEnabled: boolean;
  adaptiveEnabledForCamera: boolean;
  activeSessions: number;
  dropRatio: number | null;
  cpuPercent: number | null;
  captureFramesEnqueued: number;
  captureFramesDropped: number;
  captureDropRatio: number;
  advancedInferRuns: number;
  advancedInferErrors: number;
  advancedInferAvgMs: number | null;
  advancedInferErrorRate: number;
  overlayPayloadRatio: number | null;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly aiBaseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.aiBaseUrl = this.configService.get<string>('aiBaseUrl') ?? 'http://ai-service:8000';
  }

  private internalHeaders() {
    const token = (this.configService.get<string>('internalServiceToken') ?? '').trim();
    return token ? { 'x-service-token': token } : undefined;
  }

  private isDisabled() {
    return String(process.env.AI_AUTO_START_ENABLED ?? 'true').trim().toLowerCase() === 'false';
  }

  async getHealth() {
    if (this.isDisabled()) {
      return { status: 'disabled', processors: {} };
    }
    try {
      const response: any = await firstValueFrom(this.httpService.get(`${this.aiBaseUrl}/health`));
      return response.data;
    } catch (error: any) {
      this.logger.error(`AI Service health check failed: ${error.message}`);
      return { status: 'offline' };
    }
  }

  async startAnalysis(cameraId: string, rtspUrl: string, analysisType = 'motion') {
    return this.startAnalysisWithConfig(cameraId, rtspUrl, analysisType);
  }

  async startAnalysisWithConfig(
    cameraId: string,
    rtspUrl: string,
    analysisType = 'motion',
    sourceInfo?: Record<string, unknown>,
  ) {
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/analyze/start`,
        {
          camera_id: cameraId,
          rtsp_url: rtspUrl,
          analysis_type: analysisType,
          source_info: sourceInfo ?? {},
        },
        { headers: this.internalHeaders() },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.error(`Failed to start AI analysis for camera ${cameraId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Confirma se um evento de movimento nativo (ONVIF) tem objeto real.
   * Retorna: true (objeto), false (frame lido, sem objeto) ou null (não sei —
   * IA fora/lenta/erro). O chamador trata null como "gravar mesmo assim".
   */
  async confirmMotion(cameraId: string, rtspUrl: string, acceptLabels?: string[]): Promise<{ confirmed: boolean | null; labels: string[]; confidence?: number; reason?: string | null }> {
    if (this.isDisabled()) return { confirmed: null, labels: [], reason: 'ai_disabled' };
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/confirm-motion`,
        { camera_id: cameraId, rtsp_url: rtspUrl, accept_labels: acceptLabels ?? null },
        { headers: this.internalHeaders(), timeout: 8000 },
      ));
      const data = response?.data ?? {};
      return {
        confirmed: typeof data.confirmed === 'boolean' ? data.confirmed : null,
        labels: Array.isArray(data.labels) ? data.labels : [],
        confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
        reason: data.reason ?? null,
      };
    } catch (error: any) {
      // Falha segura: não sei → o chamador grava.
      return { confirmed: null, labels: [], reason: `error:${error?.message ?? 'unknown'}` };
    }
  }

  async stopAnalysis(cameraId: string) {
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/analyze/stop/${cameraId}`,
        {},
        { headers: this.internalHeaders() },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.error(`Failed to stop AI analysis for camera ${cameraId}: ${error.message}`);
      throw error;
    }
  }

  async stopAll() {
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/analyze/stop-all`,
        {},
        { headers: this.internalHeaders() },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.error(`Failed to stop all AI analysis: ${error.message}`);
      throw error;
    }
  }

  async resetModels() {
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/models/reset`,
        {},
        { headers: this.internalHeaders() },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.warn(`Failed to reset AI models: ${error.message}`);
      return { status: 'unavailable' };
    }
  }

  async loadModel(analysisType: string) {
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/models/load`,
        { analysis_type: analysisType },
        { headers: this.internalHeaders() },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.warn(`Failed to load AI model ${analysisType}: ${error.message}`);
      return { status: 'unavailable', error: error.message };
    }
  }

  // Busca detecções de várias câmeras numa única chamada. A página Live faz polling
  // de overlay por câmera; sem o lote, uma grade 4x4 geraria 32 req/s e estouraria o
  // rate-limit do endpoint individual. Aqui o cliente faz 1 requisição por ciclo.
  async getLatestDetectionsBatch(cameraIds: string[], maxAgeMs = 5000, limit = 12) {
    const cameras: Record<string, any> = {};
    await Promise.all(
      cameraIds.map(async (cameraId) => {
        cameras[cameraId] = await this.getLatestDetections(cameraId, maxAgeMs, limit);
      }),
    );
    return { cameras, generatedAt: new Date().toISOString() };
  }

  async getLatestDetections(cameraId: string, maxAgeMs = 5000, limit = 12) {
    if (this.isDisabled()) {
      return { status: 'disabled', camera_id: cameraId, detections: [] };
    }
    try {
      const response: any = await firstValueFrom(this.httpService.get(
        `${this.aiBaseUrl}/detections/latest/${cameraId}`,
        {
          headers: this.internalHeaders(),
          params: { max_age_ms: maxAgeMs, limit },
        },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.warn(`Failed to fetch AI live detections for camera ${cameraId}: ${error.message}`);
      return { status: 'unavailable', camera_id: cameraId, detections: [] };
    }
  }

  async startLiveViewSession(cameraId: string, sessionId: string, ttlSeconds = 20, viewMode: 'selected' | 'grid' = 'grid') {
    if (this.isDisabled()) {
      return { status: 'disabled', camera_id: cameraId, session_id: sessionId };
    }
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/live-view/start/${cameraId}`,
        { session_id: sessionId, ttl_seconds: ttlSeconds, view_mode: viewMode },
        { headers: this.internalHeaders() },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.warn(`Failed to start live-view session for camera ${cameraId}: ${error.message}`);
      return { status: 'unavailable', camera_id: cameraId, session_id: sessionId };
    }
  }

  async heartbeatLiveViewSession(cameraId: string, sessionId: string, ttlSeconds = 20, viewMode: 'selected' | 'grid' = 'grid') {
    if (this.isDisabled()) {
      return { status: 'disabled', camera_id: cameraId, session_id: sessionId };
    }
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/live-view/heartbeat/${cameraId}`,
        { session_id: sessionId, ttl_seconds: ttlSeconds, view_mode: viewMode },
        { headers: this.internalHeaders() },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.warn(`Failed to heartbeat live-view session for camera ${cameraId}: ${error.message}`);
      return { status: 'unavailable', camera_id: cameraId, session_id: sessionId };
    }
  }

  async stopLiveViewSession(cameraId: string, sessionId: string) {
    if (this.isDisabled()) {
      return { status: 'disabled', camera_id: cameraId, session_id: sessionId };
    }
    try {
      const response: any = await firstValueFrom(this.httpService.post(
        `${this.aiBaseUrl}/live-view/stop/${cameraId}`,
        { session_id: sessionId },
        { headers: this.internalHeaders() },
      ));
      return response.data;
    } catch (error: any) {
      this.logger.warn(`Failed to stop live-view session for camera ${cameraId}: ${error.message}`);
      return { status: 'unavailable', camera_id: cameraId, session_id: sessionId };
    }
  }

  async getRolloutSummary() {
    const health = await this.getHealth();
    const generatedAt = new Date().toISOString();
    if (!health || health.status !== 'online' || typeof health.processors !== 'object' || !health.processors) {
      return {
        status: 'unavailable',
        reason: 'ai_service_offline',
        health_status: health?.status ?? 'offline',
        generated_at: generatedAt,
      };
    }

    const processors = health.processors as Record<string, any>;
    const cameras: RolloutCameraMetrics[] = Object.entries(processors).map(([cameraId, processor]) => {
      const performance = processor?.performance ?? {};
      const liveView = processor?.live_view ?? {};
      const featureFlags = liveView?.feature_flags ?? {};
      const adaptiveMetrics = liveView?.adaptive?.metrics ?? {};

      const captureFramesEnqueued = this.asNumber(processor?.capture_frames_enqueued);
      const captureFramesDropped = this.asNumber(processor?.capture_frames_dropped);
      const advancedInferRuns = this.asNumber(performance?.advanced_infer_runs);
      const advancedInferErrors = this.asNumber(performance?.advanced_infer_errors);

      return {
        cameraId,
        running: Boolean(processor?.running),
        analysisType: this.asStringOrNull(processor?.analysis_type),
        advancedAnalysisType: this.asStringOrNull(processor?.advanced_analysis_type),
        qosMode: this.asStringOrNull(liveView?.qos_mode),
        qosLiveEnabled: Boolean(featureFlags?.qos_live_enabled),
        adaptiveFeatureEnabled: Boolean(featureFlags?.adaptive_feature_enabled),
        adaptiveEnabledForCamera: Boolean(featureFlags?.adaptive_enabled_for_camera),
        activeSessions: this.asNumber(liveView?.active_sessions),
        dropRatio: this.asNullableNumber(adaptiveMetrics?.drop_ratio),
        cpuPercent: this.asNullableNumber(adaptiveMetrics?.cpu_percent),
        captureFramesEnqueued,
        captureFramesDropped,
        captureDropRatio: captureFramesEnqueued > 0 ? captureFramesDropped / captureFramesEnqueued : 0,
        advancedInferRuns,
        advancedInferErrors,
        advancedInferAvgMs: this.asNullableNumber(performance?.advanced_infer_avg_ms),
        advancedInferErrorRate: advancedInferRuns > 0 ? advancedInferErrors / advancedInferRuns : 0,
        overlayPayloadRatio: this.asNullableNumber(performance?.overlay_payload_ratio),
      };
    });

    const pilot = cameras.filter((camera) => camera.adaptiveEnabledForCamera);
    const control = cameras.filter((camera) => !camera.adaptiveEnabledForCamera);

    const pilotAgg = this.aggregateRolloutGroup(pilot);
    const controlAgg = this.aggregateRolloutGroup(control);
    return {
      status: 'ok',
      generated_at: generatedAt,
      health_status: health.status,
      total_cameras: cameras.length,
      pilot_cameras: pilot.length,
      control_cameras: control.length,
      pilot: pilotAgg,
      control: controlAgg,
      deltas: this.compareRolloutGroups(pilotAgg, controlAgg),
      cameras,
    };
  }

  private aggregateRolloutGroup(cameras: RolloutCameraMetrics[]) {
    const running = cameras.filter((camera) => camera.running);
    const withAdvancedLatency = running.filter((camera) => camera.advancedInferAvgMs !== null);
    const withCpu = running.filter((camera) => camera.cpuPercent !== null);
    const withOverlay = running.filter((camera) => camera.overlayPayloadRatio !== null);
    const totalEnqueued = running.reduce((sum, camera) => sum + camera.captureFramesEnqueued, 0);
    const totalDropped = running.reduce((sum, camera) => sum + camera.captureFramesDropped, 0);
    const totalAdvancedRuns = running.reduce((sum, camera) => sum + camera.advancedInferRuns, 0);
    const totalAdvancedErrors = running.reduce((sum, camera) => sum + camera.advancedInferErrors, 0);
    const avg = (values: number[]) => {
      if (!values.length) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };
    return {
      cameras: cameras.length,
      running: running.length,
      active_sessions: running.reduce((sum, camera) => sum + camera.activeSessions, 0),
      avg_cpu_percent: avg(withCpu.map((camera) => camera.cpuPercent as number)),
      avg_drop_ratio: avg(running.map((camera) => camera.dropRatio ?? camera.captureDropRatio)),
      aggregate_drop_ratio: totalEnqueued > 0 ? totalDropped / totalEnqueued : 0,
      avg_advanced_infer_ms: avg(withAdvancedLatency.map((camera) => camera.advancedInferAvgMs as number)),
      aggregate_advanced_error_rate: totalAdvancedRuns > 0 ? totalAdvancedErrors / totalAdvancedRuns : 0,
      avg_overlay_payload_ratio: avg(withOverlay.map((camera) => camera.overlayPayloadRatio as number)),
      total_capture_enqueued: totalEnqueued,
      total_capture_dropped: totalDropped,
      total_advanced_runs: totalAdvancedRuns,
      total_advanced_errors: totalAdvancedErrors,
    };
  }

  private compareRolloutGroups(pilot: any, control: any) {
    const delta = (left: number | null, right: number | null) => {
      if (!Number.isFinite(left as number) || !Number.isFinite(right as number)) return null;
      return (left as number) - (right as number);
    };
    return {
      cpu_percent: delta(pilot.avg_cpu_percent, control.avg_cpu_percent),
      drop_ratio: delta(pilot.avg_drop_ratio, control.avg_drop_ratio),
      aggregate_drop_ratio: delta(pilot.aggregate_drop_ratio, control.aggregate_drop_ratio),
      advanced_infer_ms: delta(pilot.avg_advanced_infer_ms, control.avg_advanced_infer_ms),
      advanced_error_rate: delta(pilot.aggregate_advanced_error_rate, control.aggregate_advanced_error_rate),
      overlay_payload_ratio: delta(pilot.avg_overlay_payload_ratio, control.avg_overlay_payload_ratio),
    };
  }

  private asNumber(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return numeric;
  }

  private asNullableNumber(value: unknown): number | null {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric;
  }

  private asStringOrNull(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
}
