import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AlarmStatus, CameraStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CAMERA_HEALTH_CHECK_QUEUE } from '../queues/camera-health-check.queue';
import { CamerasService } from '../../cameras/cameras.service';
import { RecordingProcessManagerService } from '../../recordings/recording-process-manager.service';
import { FfmpegMjpegService } from '../../camera-stream/ffmpeg-mjpeg.service';
import { GRID_LIVE_TARGET_FPS } from '../../camera-stream/helpers/live-delivery-profile.helper';
import { AlarmsService } from '../../alarms/alarms.service';
import { envNumber } from '../../common/config/env-number.helper';

@Processor(CAMERA_HEALTH_CHECK_QUEUE)
@Injectable()
export class CameraHealthCheckProcessor extends WorkerHost {
  private readonly logger = new Logger(CameraHealthCheckProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly camerasService: CamerasService,
    private readonly recordingManager: RecordingProcessManagerService,
    private readonly streamService: FfmpegMjpegService,
    private readonly alarmsService: AlarmsService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    this.logger.log(`Iniciando verificação de saúde das câmeras...`);

    // Câmeras que não reportaram dentro da janela configurada são marcadas como OFFLINE
    const offlineMinutes = this.configService.get<number>('healthCheckOfflineMinutes') ?? 5;
    const staleThreshold = new Date();
    staleThreshold.setMinutes(staleThreshold.getMinutes() - offlineMinutes);

    const staleCameras = await this.prisma.camera.findMany({
      where: {
        status: CameraStatus.ONLINE,
        lastSeenAt: {
          lt: staleThreshold,
        },
      },
    });

    if (staleCameras.length > 0) {
      this.logger.warn(`${staleCameras.length} câmera(s) sem heartbeat recente; executando reteste ativo antes de marcar offline.`);

      // ── RETESTE EM PARALELO, COM TETO ───────────────────────────────────────
      //
      // Este laço era SEQUENCIAL (`for...await`), e cada reteste custa ~11 s de
      // sonda RTSP+ONVIF. Medido em simulação de capacidade (2026-08-03): com 25
      // câmeras, 10 entraram em reteste = 110 s de fila dentro de um ciclo que
      // roda a cada 60 s. A fila não fechava, e o efeito prático não é CPU — é
      // DEMORA PARA PERCEBER CÂMERA CAÍDA: extrapolado, ~7 minutos numa
      // instalação de 200 câmeras. Num sistema de segurança, esse é o número que
      // define a promessa comercial.
      //
      // O teto existe porque o oposto também quebra: disparar N sondas de uma vez
      // contra o mesmo DVR esgota as sessões RTSP do equipamento do cliente e
      // derruba justamente as câmeras que se queria testar — foi o que aconteceu
      // com a tempestade de ffprobe em 30/07. Quatro por vez é o mesmo valor já
      // usado em `recoverStuckPaths`, pelo mesmo motivo.
      const CONCURRENCY = envNumber('HEALTH_RETEST_CONCURRENCY', 4, {
        min: 1,
        max: 16,
        integer: true,
      });

      const retestar = async (cam: (typeof staleCameras)[number]) => {
        try {
          const result = await this.camerasService.getStatus(cam.id);
          if (result.status === CameraStatus.ONLINE) {
            this.logger.debug(`Heartbeat renovado por reteste ativo: ${cam.name} (${cam.id})`);
            return;
          }
        } catch (error) {
          this.logger.warn(`Reteste ativo falhou camera=${cam.id}: ${(error as Error).message}`);
        }

        await this.prisma.camera.update({
          where: { id: cam.id },
          data: { status: CameraStatus.OFFLINE },
        });
        await this.camerasService.registerEvent(
          cam.id,
          'HEALTH_CAMERA_OFFLINE',
          'WARNING',
          'Câmera marcada como offline após falha no reteste ativo de saúde.',
          {
            staleThreshold: staleThreshold.toISOString(),
            offlineMinutes,
          },
        );
        this.logger.debug(`Status atualizado para OFFLINE: ${cam.name} (${cam.id})`);
      };

      const inicio = Date.now();
      for (let i = 0; i < staleCameras.length; i += CONCURRENCY) {
        // `allSettled` e não `all`: uma câmera que estoure de forma inesperada não
        // pode abortar o lote e deixar as demais sem reteste — elas seriam
        // marcadas offline no ciclo seguinte sem nunca terem sido testadas.
        await Promise.allSettled(staleCameras.slice(i, i + CONCURRENCY).map(retestar));
      }
      this.logger.log(
        `Reteste ativo concluído: ${staleCameras.length} câmera(s) em ${Math.round((Date.now() - inicio) / 1000)}s `
        + `(concorrência ${CONCURRENCY}).`,
      );
    } else {
      this.logger.log('Todas as câmeras online estão reportando normalmente.');
    }

    await this.checkRecordingStaleness();
    await this.checkMotionDetectorHealth();
    await this.checkLiveStreamHealth();
    await this.alarmsService.resolveStaleMotionAlarms();

    const autoRemediationEnabled = this.configService.get<boolean>('healthAutoRemediationEnabled') ?? true;
    if (!autoRemediationEnabled) {
      return;
    }

    const maxPerRun = Math.max(1, this.configService.get<number>('healthAutoRemediationMaxPerRun') ?? 5);
    const degraded = await this.prisma.camera.findMany({
      where: {
        status: {
          in: [CameraStatus.OFFLINE, CameraStatus.ERROR, CameraStatus.UNKNOWN],
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: maxPerRun,
      select: { id: true, name: true },
    });

    if (degraded.length === 0) return;

    this.logger.log(`Auto-remediação: executando reteste ativo em ${degraded.length} câmeras degradadas.`);
    for (const cam of degraded) {
      try {
        const result = await this.camerasService.getStatus(cam.id);
        if (result.status === CameraStatus.ONLINE) {
          await this.camerasService.registerEvent(
            cam.id,
            'HEALTH_AUTO_RECOVERED',
            'INFO',
            'Câmera recuperada por reteste automático de saúde.',
            { checkedAt: result.checkedAt },
          );
        }
      } catch (error) {
        this.logger.warn(`Auto-remediação falhou camera=${cam.id}: ${(error as Error).message}`);
      }
    }
  }

  private async checkRecordingStaleness() {
    const configuredThresholdSeconds = envNumber('RECORDING_STALE_THRESHOLD_SECONDS', 180);
    const defaultSegmentSeconds = Number(this.configService.get<number>('recordingSegmentSeconds') ?? 300);
    const staleThresholdSeconds = Math.max(
      configuredThresholdSeconds,
      defaultSegmentSeconds + Math.max(60, Math.round(defaultSegmentSeconds * 0.25)),
    );
    // DETECÇÃO RÁPIDA (opt-in): o limiar acima só enxerga o ÚLTIMO SEGMENTO
    // FECHADO — com segmento de 300s ele só acusa após ~375s, e com o job a cada
    // 60s uma gravação parada podia ficar ~7min sem reinício. O progresso do
    // ARQUIVO EM ESCRITA acusa em ~1 ciclo. Default DESLIGADO: ligar troca o
    // comportamento de produção (reinício mais agressivo), então é decisão
    // explícita do dono via HEALTH_RECORDING_WRITE_STALL_ENABLED=true.
    const writeStallEnabled = String(process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED ?? 'false') === 'true';
    const staleCooldownSeconds = envNumber('HEALTH_RECORDING_STALE_COOLDOWN_SECONDS', 300);
    const envAutoReconnectEnabled = String(process.env.HEALTH_RECORDING_STALE_AUTO_RECONNECT_ENABLED ?? 'true') !== 'false';
    const autoReconnectEnabled = envAutoReconnectEnabled;
    const autoReconnectCooldownSeconds = envNumber('HEALTH_RECORDING_STALE_RECONNECT_COOLDOWN_SECONDS', 180);
    const staleAt = new Date(Date.now() - staleThresholdSeconds * 1000);
    const cooldownAt = new Date(Date.now() - staleCooldownSeconds * 1000);
    const reconnectCooldownAt = new Date(Date.now() - autoReconnectCooldownSeconds * 1000);

    const cameras = await this.prisma.camera.findMany({
      // Em modo motion, recordingEnabled representa processo ATIVO, não o
      // armamento. Esse modo possui health próprio baseado em frames da IA.
      where: { recordingEnabled: true, recordingMode: { not: 'motion' } },
      select: { id: true, name: true, status: true },
    });
    if (!cameras.length) return;

    const recordingByCamera = await this.prisma.recording.groupBy({
      by: ['cameraId'],
      where: { cameraId: { in: cameras.map((camera) => camera.id) } },
      _max: { endedAt: true, startedAt: true },
    });
    const latestByCamera = new Map<string, Date>();
    for (const item of recordingByCamera) {
      const latest = item._max.endedAt ?? item._max.startedAt;
      if (latest) latestByCamera.set(item.cameraId, latest);
    }

    for (const camera of cameras) {
      const latest = latestByCamera.get(camera.id);
      const segmentStale = !latest || latest < staleAt;
      // O detector rápido NÃO substitui o limiar antigo: ele só antecipa o mesmo
      // veredito. O limiar por último segmento continua valendo como rede (ele
      // cobre também o caso "processo nem existe", em que não há arquivo a medir).
      const writeProgress = writeStallEnabled && !segmentStale ? this.readRecordingWriteProgress(camera.id) : null;
      const writeStalled = Boolean(writeProgress?.stalled);
      const stale = segmentStale || writeStalled;
      const detectedBy = segmentStale ? 'last_segment' : 'write_progress';
      const staleAgeSeconds = latest ? Math.max(0, Math.floor((Date.now() - latest.getTime()) / 1000)) : null;
      const lastStaleEvent = await this.prisma.cameraEvent.findFirst({
        where: {
          cameraId: camera.id,
          type: 'HEALTH_RECORDING_STALE',
        },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      });
      const hasRecentStaleEvent = Boolean(lastStaleEvent && lastStaleEvent.occurredAt >= cooldownAt);

      if (stale) {
        if (!hasRecentStaleEvent) {
          await this.camerasService.registerEvent(
            camera.id,
            'HEALTH_RECORDING_STALE',
            'WARNING',
            'Gravação habilitada sem segmento recente detectado.',
            {
              staleThresholdSeconds,
              latestSegmentAt: latest ? latest.toISOString() : null,
              cameraStatus: camera.status,
              detectedBy,
              writeStalled,
              writeProgress,
            },
          );
        }
        const shouldEmitStopped = await this.shouldEmitWithCooldown(camera.id, 'HEALTH_RECORDING_STOPPED', staleCooldownSeconds);
        if (shouldEmitStopped) {
          await this.camerasService.registerEvent(
            camera.id,
            'HEALTH_RECORDING_STOPPED',
            camera.status === CameraStatus.ONLINE ? 'ERROR' : 'WARNING',
            'Gravação parou ou não gerou segmento dentro da janela esperada.',
            {
              staleThresholdSeconds,
              staleAgeSeconds,
              latestSegmentAt: latest ? latest.toISOString() : null,
              cameraStatus: camera.status,
              detectedBy,
              writeStalled,
              writeProgress,
              diagnosis: {
                recordingEnabled: true,
                lastSegmentMissing: !latest,
                staleBeyondThreshold: segmentStale,
                writeStalled,
              },
            },
          );
        }
        if (autoReconnectEnabled) {
          const lastReconnectAttempt = await this.prisma.cameraEvent.findFirst({
            where: {
              cameraId: camera.id,
              type: { in: ['HEALTH_RECORDING_RECONNECT_REQUESTED', 'HEALTH_RECORDING_RECONNECT_SUCCESS', 'HEALTH_RECORDING_RECONNECT_FAILED'] },
            },
            orderBy: { occurredAt: 'desc' },
            select: { occurredAt: true },
          });
          const canReconnect = !lastReconnectAttempt || lastReconnectAttempt.occurredAt < reconnectCooldownAt;
          if (canReconnect) {
            await this.camerasService.registerEvent(
              camera.id,
              'HEALTH_RECORDING_RECONNECT_REQUESTED',
              'INFO',
              'Auto-reconexão de gravação iniciada pelo health-check.',
              { autoReconnectCooldownSeconds, staleThresholdSeconds, detectedBy, writeStalled, writeProgress },
            );
            try {
              const defaultSegment = envNumber('RECORDING_SEGMENT_SECONDS', 300, { min: 5, max: 3600, integer: true });
              await this.recordingManager.stop(camera.id);
              await this.recordingManager.start(camera.id, defaultSegment);
              await this.camerasService.registerEvent(
                camera.id,
                'HEALTH_RECORDING_RECONNECT_SUCCESS',
                'INFO',
                'Auto-reconexão de gravação concluída com sucesso.',
                { defaultSegment, staleThresholdSeconds },
              );
            } catch (error) {
              await this.camerasService.registerEvent(
                camera.id,
                'HEALTH_RECORDING_RECONNECT_FAILED',
                'WARNING',
                'Falha na auto-reconexão da gravação.',
                {
                  error: error instanceof Error ? error.message : 'unknown_error',
                  staleThresholdSeconds,
                },
              );
            }
          }
        }
        continue;
      }

      const openAlarm = await this.prisma.alarmInstance.findFirst({
        where: {
          cameraId: camera.id,
          type: { in: ['HEALTH_RECORDING_STALE', 'HEALTH_RECORDING_STOPPED'] },
          status: { in: [AlarmStatus.OPEN, AlarmStatus.ACKED] },
        },
        select: { id: true },
      });
      if (!openAlarm) continue;
      await this.camerasService.registerEvent(
        camera.id,
        'HEALTH_RECORDING_RECOVERED',
        'INFO',
        'Gravação voltou a gerar segmentos recentes.',
        {
          staleThresholdSeconds,
          latestSegmentAt: latest ? latest.toISOString() : null,
          cameraStatus: camera.status,
        },
      );
    }
  }

  /**
   * Consulta o progresso do arquivo em escrita no gerenciador de gravação.
   * Blindado: qualquer falha (I/O, gerenciador em modo worker, versão antiga sem o
   * método) devolve `null` e o health-check segue exatamente como antes.
   */
  private readRecordingWriteProgress(cameraId: string) {
    try {
      const manager = this.recordingManager as Partial<RecordingProcessManagerService>;
      return manager.getRecordingWriteProgress?.(cameraId) ?? null;
    } catch (error) {
      this.logger.warn(`Progresso de gravação indisponível camera=${cameraId}: ${(error as Error).message}`);
      return null;
    }
  }

  private async shouldEmitWithCooldown(cameraId: string, eventType: string, cooldownSeconds: number) {
    const threshold = new Date(Date.now() - cooldownSeconds * 1000);
    const recent = await this.prisma.cameraEvent.findFirst({
      where: { cameraId, type: eventType, occurredAt: { gte: threshold } },
      orderBy: { occurredAt: 'desc' },
      select: { id: true },
    });
    return !recent;
  }

  private async checkMotionDetectorHealth() {
    const cameras = await this.prisma.camera.findMany({
      where: { recordingMode: 'motion', motionTrigger: 'SYSTEM' },
      select: { id: true, name: true, status: true },
      take: 500,
    });
    if (!cameras.length) return;

    const staleSeconds = envNumber('HEALTH_MOTION_FRAME_STALE_SECONDS', 45, { min: 15 });
    const cooldownSeconds = envNumber('HEALTH_MOTION_EVENT_COOLDOWN_SECONDS', 300, { min: 60 });
    let processors: Record<string, any> = {};
    let serviceReachable = false;
    let serviceStatus: string | null = null;
    try {
      const baseUrl = String(process.env.AI_BASE_URL ?? 'http://ai-service:8000').replace(/\/+$/, '');
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const health = await response.json() as { status?: string; processors?: Record<string, any> };
        serviceReachable = Boolean(health && typeof health === 'object');
        serviceStatus = typeof health.status === 'string' ? health.status : null;
        processors = health.processors && typeof health.processors === 'object' ? health.processors : {};
      }
    } catch {
      serviceReachable = false;
    }

    const nowSeconds = Date.now() / 1000;
    for (const camera of cameras) {
      const processor = processors[camera.id];
      const lastFrameSeconds = Number(processor?.last_seen ?? 0);
      const frameAgeSeconds = lastFrameSeconds > 0 ? Math.max(0, Math.floor(nowSeconds - lastFrameSeconds)) : null;
      const running = Boolean(processor?.running);
      const readiness = processor?.readiness && typeof processor.readiness === 'object'
        ? processor.readiness as { ready?: unknown; reason?: unknown }
        : null;
      const processorReady = typeof readiness?.ready === 'boolean' ? readiness.ready : null;
      const readinessReason = typeof readiness?.reason === 'string' ? readiness.reason : null;
      // `health.status=degraded` é agregado: uma câmera ruim não deve degradar
      // todas as demais. Serviço alcançável e estado individual são avaliados
      // separadamente; versões antigas sem `readiness` usam running/last_seen.
      const stale = !serviceReachable
        || !processor
        || !running
        || processorReady === false
        || frameAgeSeconds == null
        || frameAgeSeconds > staleSeconds;

      if (stale) {
        if (await this.shouldEmitWithCooldown(camera.id, 'HEALTH_MOTION_DETECTOR_STALE', cooldownSeconds)) {
          await this.camerasService.registerEvent(
            camera.id,
            'HEALTH_MOTION_DETECTOR_STALE',
            camera.status === CameraStatus.ONLINE ? 'ERROR' : 'WARNING',
            'Câmera armada por movimento sem frames recentes no detector.',
            {
              aiServiceOnline: serviceReachable,
              aiServiceStatus: serviceStatus,
              processorRunning: running,
              processorReady,
              readinessReason,
              frameAgeSeconds,
              staleThresholdSeconds: staleSeconds,
              captureFramesEnqueued: Number(processor?.capture_frames_enqueued ?? 0),
            },
          );
        }
        continue;
      }

      const [lastStale, lastRecovery] = await Promise.all([
        this.prisma.cameraEvent.findFirst({
          where: { cameraId: camera.id, type: 'HEALTH_MOTION_DETECTOR_STALE' },
          orderBy: { occurredAt: 'desc' },
          select: { occurredAt: true },
        }),
        this.prisma.cameraEvent.findFirst({
          where: { cameraId: camera.id, type: 'HEALTH_MOTION_DETECTOR_RECOVERED' },
          orderBy: { occurredAt: 'desc' },
          select: { occurredAt: true },
        }),
      ]);
      if (lastStale && (!lastRecovery || lastRecovery.occurredAt < lastStale.occurredAt)) {
        await this.camerasService.registerEvent(
          camera.id,
          'HEALTH_MOTION_DETECTOR_RECOVERED',
          'INFO',
          'Detector de movimento voltou a receber frames.',
          { frameAgeSeconds, staleThresholdSeconds: staleSeconds },
        );
      }
    }
  }

  private async checkLiveStreamHealth() {
    const maxPerRun = envNumber('HEALTH_STREAM_CHECK_MAX_PER_RUN', 40, { min: 1 });
    const cooldownSeconds = envNumber('HEALTH_STREAM_EVENT_COOLDOWN_SECONDS', 300, { min: 30 });
    const latencyThresholdMs = envNumber('HEALTH_STREAM_LATENCY_THRESHOLD_MS', 5000, { min: 500 });
    const fpsDriftEnabled = String(process.env.HEALTH_STREAM_FPS_DRIFT_ENABLED ?? 'true') !== 'false';
    const fpsDriftRatioThreshold = envNumber('HEALTH_STREAM_FPS_DRIFT_RATIO', 0.25, { min: 0.05 });
    const fpsDriftAbsThreshold = envNumber('HEALTH_STREAM_FPS_DRIFT_ABS', 2, { min: 1 });
    const fpsAutoRemediationEnabled = String(process.env.HEALTH_STREAM_FPS_AUTO_REMEDIATION_ENABLED ?? 'true') !== 'false';
    const fpsAutoRemediationCooldownSeconds = envNumber('HEALTH_STREAM_FPS_REMEDIATION_COOLDOWN_SECONDS', 900, { min: 60 });
    const fpsRemediationCooldownAt = new Date(Date.now() - fpsAutoRemediationCooldownSeconds * 1000);
    const cameras = await this.prisma.camera.findMany({
      where: { OR: [{ recordingEnabled: true }, { recordingMode: 'motion' }] },
      select: { id: true, name: true, preferredLiveProtocol: true, streamFps: true, recordingEnabled: true },
      take: maxPerRun,
      orderBy: { updatedAt: 'asc' },
    });
    if (!cameras.length) return;

    for (const camera of cameras) {
      try {
        const status = await this.camerasService.getStatus(camera.id);
        const liveUnavailable = !status.rtspReachable || !status.rtspAuthOk || status.status !== CameraStatus.ONLINE;
        if (liveUnavailable) {
          if (await this.shouldEmitWithCooldown(camera.id, 'HEALTH_STREAM_UNAVAILABLE', cooldownSeconds)) {
            await this.camerasService.registerEvent(
              camera.id,
              'HEALTH_STREAM_UNAVAILABLE',
              'WARNING',
              'Stream live indisponível para a câmera.',
              {
                rtspReachable: status.rtspReachable,
                rtspAuthOk: status.rtspAuthOk,
                onvifReachable: status.onvifReachable,
                status: status.status,
              },
            );
          }
        } else {
          const openUnavailable = await this.prisma.alarmInstance.findFirst({
            where: {
              cameraId: camera.id,
              type: 'HEALTH_STREAM_UNAVAILABLE',
              status: { in: [AlarmStatus.OPEN, AlarmStatus.ACKED] },
            },
            select: { id: true },
          });
          if (openUnavailable) {
            await this.camerasService.registerEvent(
              camera.id,
              'HEALTH_STREAM_RECOVERED',
              'INFO',
              'Stream live voltou a ficar disponível.',
              {
                rtspReachable: status.rtspReachable,
                rtspAuthOk: status.rtspAuthOk,
                onvifReachable: status.onvifReachable,
                status: status.status,
              },
            );
          }
        }

        const codec = String(status.detectedVideoCodec ?? '').toLowerCase();
        const liveProtocol = String(status.preferredLiveProtocol ?? camera.preferredLiveProtocol ?? 'webrtc').toLowerCase();
        const incompatibleCodecForFlv = liveProtocol === 'flv' && (codec.includes('h265') || codec.includes('hevc') || codec.includes('265'));
        if (incompatibleCodecForFlv && await this.shouldEmitWithCooldown(camera.id, 'HEALTH_STREAM_CODEC_INCOMPATIBLE', cooldownSeconds)) {
          await this.camerasService.registerEvent(
            camera.id,
            'HEALTH_STREAM_CODEC_INCOMPATIBLE',
            'WARNING',
            'Codec detectado com alta chance de incompatibilidade no modo live atual.',
            {
              codec,
              preferredLiveProtocol: liveProtocol,
            },
          );
        }

        const probeLatency = Number(status.liveProbeLatencyMs ?? 0);
        const streamStats = this.streamService.getStreamStats(camera.id) as any;
        const startupLatency = Number(streamStats?.lastStartupLatencyMs ?? 0);
        const latencyMs = Math.max(probeLatency, startupLatency);
        if (latencyMs > latencyThresholdMs) {
          if (await this.shouldEmitWithCooldown(camera.id, 'HEALTH_STREAM_LATENCY_HIGH', cooldownSeconds)) {
            await this.camerasService.registerEvent(
              camera.id,
              'HEALTH_STREAM_LATENCY_HIGH',
              'WARNING',
              'Latência de stream acima do limiar configurado.',
              {
                probeLatencyMs: probeLatency,
                startupLatencyMs: startupLatency,
                thresholdMs: latencyThresholdMs,
              },
            );
          }
        } else {
          const openLatency = await this.prisma.alarmInstance.findFirst({
            where: {
              cameraId: camera.id,
              type: 'HEALTH_STREAM_LATENCY_HIGH',
              status: { in: [AlarmStatus.OPEN, AlarmStatus.ACKED] },
            },
            select: { id: true },
          });
          if (openLatency && await this.shouldEmitWithCooldown(camera.id, 'HEALTH_STREAM_LATENCY_RECOVERED', cooldownSeconds)) {
            await this.camerasService.registerEvent(
              camera.id,
              'HEALTH_STREAM_LATENCY_RECOVERED',
              'INFO',
              'Latência do stream voltou ao patamar esperado.',
              {
                probeLatencyMs: probeLatency,
                startupLatencyMs: startupLatency,
                thresholdMs: latencyThresholdMs,
              },
            );
          }
        }

        if (fpsDriftEnabled) {
          const configuredFps = Number(status.configuredFps ?? camera.streamFps ?? 0);
          const detectedFps = Number(status.detectedFps ?? 0);
          const usesIntentionalGridCap = configuredFps === GRID_LIVE_TARGET_FPS && Number(camera.streamFps ?? 0) === GRID_LIVE_TARGET_FPS;
          if (usesIntentionalGridCap) {
            continue;
          }
          const hasComparableFps = configuredFps > 0 && detectedFps > 0;
          if (hasComparableFps) {
            const absDiff = Math.abs(configuredFps - detectedFps);
            const ratioDiff = absDiff / configuredFps;
            const drifted = absDiff >= fpsDriftAbsThreshold && ratioDiff >= fpsDriftRatioThreshold;
            if (drifted) {
              if (await this.shouldEmitWithCooldown(camera.id, 'HEALTH_STREAM_FPS_DRIFT', cooldownSeconds)) {
                await this.camerasService.registerEvent(
                  camera.id,
                  'HEALTH_STREAM_FPS_DRIFT',
                  'WARNING',
                  'Diferença relevante entre FPS configurado e FPS detectado no stream.',
                  {
                    configuredFps,
                    detectedFps,
                    absDiff,
                    ratioDiff,
                    fpsDriftAbsThreshold,
                    fpsDriftRatioThreshold,
                  },
                );
              }

              if (fpsAutoRemediationEnabled && camera.recordingEnabled) {
                const lastRemediation = await this.prisma.cameraEvent.findFirst({
                  where: {
                    cameraId: camera.id,
                    type: {
                      in: [
                        'HEALTH_STREAM_FPS_REMEDIATION_REQUESTED',
                        'HEALTH_STREAM_FPS_REMEDIATION_SUCCESS',
                        'HEALTH_STREAM_FPS_REMEDIATION_FAILED',
                      ],
                    },
                  },
                  orderBy: { occurredAt: 'desc' },
                  select: { occurredAt: true },
                });
                const canRemediate = !lastRemediation || lastRemediation.occurredAt < fpsRemediationCooldownAt;
                if (canRemediate) {
                  await this.camerasService.registerEvent(
                    camera.id,
                    'HEALTH_STREAM_FPS_REMEDIATION_REQUESTED',
                    'INFO',
                    'Auto-correção de FPS iniciada pelo health-check.',
                    {
                      configuredFps,
                      detectedFps,
                      absDiff,
                      ratioDiff,
                    },
                  );
                  try {
                    const defaultSegment = envNumber('RECORDING_SEGMENT_SECONDS', 300, { min: 5, max: 3600, integer: true });
                    await this.recordingManager.stop(camera.id);
                    await this.recordingManager.start(camera.id, defaultSegment);
                    await this.camerasService.registerEvent(
                      camera.id,
                      'HEALTH_STREAM_FPS_REMEDIATION_SUCCESS',
                      'INFO',
                      'Auto-correção de FPS concluída com sucesso.',
                      {
                        defaultSegment,
                        configuredFps,
                        detectedFps,
                      },
                    );
                  } catch (error) {
                    await this.camerasService.registerEvent(
                      camera.id,
                      'HEALTH_STREAM_FPS_REMEDIATION_FAILED',
                      'WARNING',
                      'Falha na auto-correção de FPS.',
                      {
                        configuredFps,
                        detectedFps,
                        error: error instanceof Error ? error.message : 'unknown_error',
                      },
                    );
                  }
                }
              }
            } else {
              const openFpsDrift = await this.prisma.alarmInstance.findFirst({
                where: {
                  cameraId: camera.id,
                  type: 'HEALTH_STREAM_FPS_DRIFT',
                  status: { in: [AlarmStatus.OPEN, AlarmStatus.ACKED] },
                },
                select: { id: true },
              });
              if (openFpsDrift && await this.shouldEmitWithCooldown(camera.id, 'HEALTH_STREAM_FPS_RECOVERED', cooldownSeconds)) {
                await this.camerasService.registerEvent(
                  camera.id,
                  'HEALTH_STREAM_FPS_RECOVERED',
                  'INFO',
                  'FPS detectado voltou ao patamar esperado.',
                  {
                    configuredFps,
                    detectedFps,
                    absDiff,
                    ratioDiff,
                  },
                );
              }
            }
          }
        }
      } catch (error) {
        this.logger.warn(`checkLiveStreamHealth falhou camera=${camera.id}: ${(error as Error).message}`);
      }
    }
  }
}
