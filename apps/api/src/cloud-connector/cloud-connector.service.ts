import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AlarmStatus, CameraStatus } from '@prisma/client';
import axios from 'axios';
import * as os from 'node:os';
import { statfs, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../common/prisma/prisma.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { AiService } from '../ai/ai.service';
import { RecordingProcessManagerService } from '../recordings/recording-process-manager.service';
import { StreamResourceAdvisorService } from '../camera-stream/stream-resource-advisor.service';
import { CameraObservabilityService } from '../observability/camera-observability.service';
import {
  buildHeartbeatCameras,
  HEARTBEAT_CAMERA_LIMIT_DEFAULT,
  type HeartbeatAlert,
  type HeartbeatCamerasBlock,
} from './heartbeat-cameras.helper';

type LicenseStatus = 'UNKNOWN' | 'ACTIVE' | 'GRACE' | 'RESTRICTED' | 'SUSPENDED';

/**
 * POR QUE não há storage provisionado. `disabled` é PAUSA (nada assume o
 * lugar); `absent` é EXCLUSÃO (a instalação segue com outro storage que ainda
 * tenha, ou volta a gravar só no disco local).
 */
export type CloudStorageState = 'configured' | 'disabled' | 'absent';

/**
 * Storage em nuvem provisionado pela Central. Carrega a credencial porque é a
 * instalação que fala com o bucket — a Central só a repassa.
 */
export type CloudStorageConfig = {
  enabled: true;
  /** Nome que o operador deu na Central. Sem ele, todo storage vira "Storage principal". */
  name: string;
  /** Quantos envios em paralelo. Escolha do operador, feita na Central. */
  uploadConcurrency: number;
  /** `tier` = grava local e envia; `mount` = grava direto no bucket montado. */
  mode: 'tier' | 'mount';
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  localWindowHours: number;
  forcePathStyle: boolean;
  updatedAt: string | null;
};

const SETTING_KEYS = [
  'cloud.lastSyncAt',
  'cloud.lastError',
  'cloud.licenseStatus',
  'cloud.licenseMessage',
  'cloud.restrictions',
  'cloud.lastPayloadSummary',
  // Storage em nuvem provisionado pela Central. Guardado como setting (e não em
  // variável de ambiente) justamente para poder mudar sem recriar container —
  // que é o ponto do provisionamento remoto.
  'cloud.storage',
  // POR QUE não há storage. Sem isto a instalação não distingue "o operador
  // desligou o envio" de "o storage foi EXCLUÍDO" — reações opostas.
  'cloud.storageState',
  // CONFIRMAÇÃO DE APLICAÇÃO. Sem isto, a Central só sabe que a instalação
  // esteve online depois da mudança — não que ela APLICOU a mudança. Uma
  // instalação antiga que ignore um campo desconhecido sumiria da lista de
  // pendências sem nunca ter aplicado nada.
  'cloud.appliedConfigRevision',
  'cloud.configApplyStatus',
  'cloud.configApplyError',
];

@Injectable()
export class CloudConnectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloudConnectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    if (!this.isEnabled()) return;

    const intervalMs = this.getIntervalMs();
    this.timer = setInterval(() => void this.syncHeartbeat(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    const firstRun = setTimeout(() => void this.syncHeartbeat(), 5000);
    if (typeof firstRun.unref === 'function') firstRun.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async getStatus() {
    const settings = await this.readSettings();

    return {
      ...this.getPublicConfig(),
      lastSyncAt: settings['cloud.lastSyncAt'] ?? null,
      lastError: settings['cloud.lastError'] ?? null,
      licenseStatus: (settings['cloud.licenseStatus'] as LicenseStatus | undefined) ?? 'UNKNOWN',
      licenseMessage: settings['cloud.licenseMessage'] ?? null,
      restrictions: this.parseJsonSetting(settings['cloud.restrictions'], {}),
      lastPayloadSummary: this.parseJsonSetting(settings['cloud.lastPayloadSummary'], null),
    };
  }

  async syncHeartbeat() {
    const config = this.getConfig();
    if (!config.enabled) return { skipped: true, reason: 'disabled' };
    if (!config.configured) {
      await this.writeSetting('cloud.lastError', 'Cloud connector sem CLOUD_API_URL, CLOUD_INSTALLATION_ID ou CLOUD_LICENSE_KEY.');
      return { skipped: true, reason: 'missing_config' };
    }
    if (this.syncing) return { skipped: true, reason: 'already_running' };

    this.syncing = true;
    try {
      const payload = await this.collectPayload();
      const response = await axios.post(`${config.apiUrl}/api/agent/heartbeat`, payload, {
        timeout: config.timeoutMs,
        headers: {
          'x-drac-installation-id': config.installationId,
          'x-drac-license-key': config.licenseKey,
        },
      });

      const licenseStatus = this.normalizeLicenseStatus(response.data?.licenseStatus);
      const restrictions = this.applyStatusCaps(licenseStatus, response.data?.restrictions ?? {});
      const licenseMessage = String(response.data?.licenseMessage ?? '');

      // Storage em nuvem: a Central manda `null` quando não há nada configurado
      // (ou quando a instalação está suspensa). `null` DESLIGA — é assim que o
      // operador remove o storage sem precisar entrar na instalação.
      const cloudStorage = this.normalizeCloudStorage(response.data?.cloudStorage);

      // Revisão que a Central diz ser a desejada. Guardamos DEPOIS de aplicar,
      // e só se aplicar der certo: marcar antes transformaria uma falha em
      // "aplicado" e a Central passaria a mentir.
      const desiredRevision = Number(response.data?.configRevision ?? 0) || 0;
      let applyStatus = 'APPLIED';
      let applyError = '';

      try {
        await Promise.all([
          this.writeSetting('cloud.lastSyncAt', new Date().toISOString()),
          this.writeSetting('cloud.lastError', ''),
          this.writeSetting('cloud.licenseStatus', licenseStatus),
          this.writeSetting('cloud.licenseMessage', licenseMessage),
          this.writeSetting('cloud.restrictions', JSON.stringify(restrictions)),
          this.writeSetting('cloud.lastPayloadSummary', JSON.stringify(payload.summary)),
          this.writeSetting('cloud.storage', cloudStorage ? JSON.stringify(cloudStorage) : ''),
          // POR QUE não desceu credencial. `disabled` é pausa (o operador
          // desligou, ou a licença suspendeu) e nada deve assumir o lugar;
          // `absent` é exclusão, e a instalação segue com outro storage que
          // ainda tenha, ou volta a gravar só no disco local. Central antiga não
          // manda o campo: nesse caso `disabled` é o palpite conservador —
          // promover storage sozinho é o erro caro.
          this.writeSetting('cloud.storageState', this.normalizeStorageState(response.data?.cloudStorageState)),
        ]);
        await this.enforceRuntimeRestrictions(restrictions);
      } catch (applyFailure) {
        applyStatus = 'FAILED';
        applyError = sanitizeSensitiveText(applyFailure).slice(0, 500);
        this.logger.error(`Falha ao APLICAR configuração da Central: ${applyError}`);
      }

      // A Central recebe isto no próximo heartbeat e para de adivinhar por data.
      await Promise.all([
        this.writeSetting('cloud.configApplyStatus', applyStatus),
        this.writeSetting('cloud.configApplyError', applyError),
        ...(applyStatus === 'APPLIED'
          ? [this.writeSetting('cloud.appliedConfigRevision', String(desiredRevision))]
          : []),
      ]);

      return {
        skipped: false,
        synced: true,
        licenseStatus,
        restrictions,
        configRevision: desiredRevision,
        applyStatus,
        central: {
          acknowledged: Boolean(response.data?.ok ?? response.data?.accepted),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeSetting('cloud.lastError', message);
      this.logger.warn(`Falha ao enviar heartbeat para DRAC Central: ${message}`);
      return { skipped: false, synced: false, error: message };
    } finally {
      this.syncing = false;
    }
  }

  private isEnabled() {
    return String(process.env.CLOUD_CONNECTOR_ENABLED ?? 'false').toLowerCase() === 'true';
  }

  private getConfig() {
    const apiUrl = this.trimTrailingSlash(process.env.CLOUD_API_URL ?? '');
    const installationId = String(process.env.CLOUD_INSTALLATION_ID ?? '').trim();
    const licenseKey = String(process.env.CLOUD_LICENSE_KEY ?? '').trim();

    return {
      enabled: this.isEnabled(),
      configured: Boolean(apiUrl && installationId && licenseKey),
      apiUrl,
      installationId,
      licenseKey,
      timeoutMs: this.getPositiveInt(process.env.CLOUD_CONNECTOR_TIMEOUT_MS, 8000),
    };
  }

  private getPublicConfig() {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      configured: config.configured,
      apiUrl: config.apiUrl || null,
      installationId: config.installationId || null,
      heartbeatIntervalSeconds: Math.round(this.getIntervalMs() / 1000),
      customerName: process.env.CLOUD_CUSTOMER_NAME || null,
    };
  }

  private getIntervalMs() {
    return Math.max(this.getPositiveInt(process.env.CLOUD_HEARTBEAT_INTERVAL_SECONDS, 60), 15) * 1000;
  }

  /**
   * Lê o status do watchdog de infra (scripts/runtime-watchdog.sh grava em
   * <storage>/.monitor/runtime-status.json). Traz p/ o heartbeat os problemas de
   * INFRA (portas do MediaMTX/502 no /live, container morto, auto-cura) que a API,
   * sozinha, não enxerga — assim a Central mostra verde/vermelho por instalação.
   * Se o arquivo não existe (watchdog não instalado) ou está velho (>15min = watchdog
   * parado), devolve null / marca stale sem derrubar o heartbeat.
   */
  private async getInfraWatchdogHealth(recordingsRoot: string): Promise<{
    status: string;
    issues: string[];
    selfHealed: string[];
    checkedAt: string | null;
    stale: boolean;
  } | null> {
    const file = join(recordingsRoot, '.monitor', 'runtime-status.json');
    try {
      const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const data = JSON.parse(raw) as {
        status?: string;
        issues?: unknown;
        selfHealed?: unknown;
        checkedAt?: string;
      };
      const ageMs = Date.now() - st.mtimeMs;
      return {
        status: String(data.status ?? 'unknown'),
        issues: Array.isArray(data.issues) ? data.issues.map(String) : [],
        selfHealed: Array.isArray(data.selfHealed) ? data.selfHealed.map(String) : [],
        checkedAt: data.checkedAt ?? null,
        stale: ageMs > 15 * 60 * 1000,
      };
    } catch {
      return null; // watchdog não instalado / arquivo ausente — silencioso
    }
  }

  private async collectPayload() {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? '/storage';
    const now = new Date();
    const launchProfile = this.getLaunchProfile();

    const [disk, cameraCounts, cameraOperational, streamPerformance, recordings, recentRecordings, activeRecordings, openAlarms, activeUsers, cameraHealth] = await Promise.all([
      this.getDiskStats(recordingsRoot),
      this.getCameraCounts(),
      this.getCameraOperationalStats(),
      this.getStreamPerformanceSummary(),
      this.prisma.recording.aggregate({
        _count: { id: true },
        _sum: { sizeBytes: true },
        _max: { startedAt: true },
      }),
      this.prisma.recording.count({
        where: { startedAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
      }),
      this.prisma.recording.count({ where: { endedAt: null } }),
      this.prisma.alarmInstance.count({ where: { status: AlarmStatus.OPEN } }),
      this.prisma.user.count({ where: { isActive: true } }),
      this.getCameraHealthForHeartbeat(),
    ]);

    const alerts: Array<{ level: 'warning' | 'critical'; code: string; message: string }> = [];
    if (disk?.usagePercent !== null && disk?.usagePercent !== undefined && disk.usagePercent >= 85) {
      alerts.push({ level: 'critical', code: 'disk_usage_high', message: `Uso de disco em ${disk.usagePercent}%.` });
    } else if (disk?.usagePercent !== null && disk?.usagePercent !== undefined && disk.usagePercent >= 75) {
      alerts.push({ level: 'warning', code: 'disk_usage_attention', message: `Uso de disco em ${disk.usagePercent}%.` });
    }
    if (cameraCounts.offline + cameraCounts.error > 0) {
      alerts.push({
        level: 'warning',
        code: 'cameras_unavailable',
        message: `${cameraCounts.offline + cameraCounts.error} camera(s) indisponivel(is).`,
      });
    }
    if (cameraCounts.total > 0 && cameraCounts.online === 0) {
      alerts.push({ level: 'critical', code: 'no_online_cameras', message: 'Nenhuma camera online.' });
    }
    if (streamPerformance?.summary?.highCpuRiskCameras > 0) {
      alerts.push({
        level: streamPerformance.summary.highCpuRiskCameras >= 3 ? 'critical' : 'warning',
        code: 'stream_high_cpu_risk',
        message: `${streamPerformance.summary.highCpuRiskCameras} camera(s) com risco alto de CPU/transcode.`,
      });
    }
    if (streamPerformance?.summary?.liveFailuresLast24h > 0) {
      alerts.push({
        level: streamPerformance.summary.liveFailuresLast24h >= 10 ? 'critical' : 'warning',
        code: 'live_failures_recent',
        message: `${streamPerformance.summary.liveFailuresLast24h} falha(s) de live nas ultimas 24h.`,
      });
    }
    if (recordings._count.id > 0 && !recordings._max.startedAt) {
      alerts.push({ level: 'warning', code: 'recording_without_last_segment', message: 'Gravacoes sem ultimo segmento detectado.' });
    }

    const mediamtxOriginsRestricted =
      String(process.env.MEDIAMTX_HLS_ALLOW_ORIGIN ?? '*') !== '*' &&
      String(process.env.MEDIAMTX_WEBRTC_ALLOW_ORIGIN ?? '*') !== '*';
    const recordingRuntime = this.getRecordingRuntimeSummary();
    const recordingCapacity = await this.getRecordingCapacityEstimate(disk);
    const continuousRecordingConfigured = cameraOperational.recordingContinuous > 0;
    const recordingAutoStartEnabled = String(process.env.RECORDING_AUTO_START_ENABLED ?? 'false') === 'true';
    const recordingCapacityEnforced = continuousRecordingConfigured || recordingAutoStartEnabled;
    const recordingOptionalByProfile = launchProfile === 'standard' && !recordingCapacityEnforced;

    if (!recordingOptionalByProfile && cameraCounts.total > 0 && cameraOperational.recordingEnabled === 0) {
      alerts.push({
        level: 'warning',
        code: 'recording_disabled_all',
        message: 'Nenhuma camera esta com gravacao habilitada. O administrador pode ativar gravacao continua, por movimento ou manual conforme o contrato.',
      });
    }
    if (recordingCapacityEnforced && recordingCapacity.status === 'blocked') {
      alerts.push({
        level: 'critical',
        code: 'recording_storage_capacity_insufficient',
        message: `Storage insuficiente para ${recordingCapacity.retentionDays}d de retencao: estimado ${recordingCapacity.estimatedRequiredGb}GB, capacidade segura ${recordingCapacity.safeCapacityGb}GB.`,
      });
    } else if (recordingCapacityEnforced && recordingCapacity.status === 'attention') {
      alerts.push({
        level: 'warning',
        code: 'recording_storage_capacity_attention',
        message: `Storage apertado para ${recordingCapacity.retentionDays}d de retencao: estimado ${recordingCapacity.estimatedRequiredGb}GB, capacidade segura ${recordingCapacity.safeCapacityGb}GB.`,
      });
    }
    // Saúde POR CÂMERA → alerts derivados (mesmo esquema level/code/message).
    // Se a observabilidade falhou, `cameraHealth` é null e o heartbeat segue
    // exatamente como antes: métrica nova não pode custar o heartbeat.
    if (cameraHealth) alerts.push(...cameraHealth.alerts);

    // Saúde de INFRA do watchdog → vira alerts (a Central já os exibe/historia).
    const infraHealth = await this.getInfraWatchdogHealth(recordingsRoot);
    if (infraHealth) {
      for (const issue of infraHealth.issues) {
        if (issue.startsWith('disk:')) continue; // disco já coberto pelos alerts acima
        const critical = /^(live:|container:|api:|web:|build-agent:)/.test(issue);
        alerts.push({
          level: critical ? 'critical' : 'warning',
          code: `infra_${issue.split(':')[0]}`,
          message: `Infra: ${issue}`,
        });
      }
      if (infraHealth.stale) {
        alerts.push({
          level: 'warning',
          code: 'infra_watchdog_stale',
          message: 'Watchdog de infra sem atualizar há >15min (pode estar parado).',
        });
      }
    }

    const appReadinessStatus = alerts.some((alert) => alert.level === 'critical')
      ? 'blocked'
      : alerts.length > 0 || !mediamtxOriginsRestricted
        ? 'attention'
        : 'ready';

    // Estado de aplicação, defensivo: se a leitura falhar (banco em recuperação,
    // tabela ausente numa instalação antiga), o heartbeat SEGUE. Ele é a linha
    // de vida com a Central — deixar de reportar por causa de um setting seria
    // trocar um problema pequeno por perder a visibilidade da instalação.
    const applied = await this.readSettings().catch(() => ({} as Record<string, string>));
    return {
      installation: {
        id: process.env.CLOUD_INSTALLATION_ID,
        customerName: process.env.CLOUD_CUSTOMER_NAME || os.hostname(),
        version: process.env.DRAC_VERSION || process.env.npm_package_version || 'local',
        launchProfile,
      },
      // O que ESTA instalação de fato aplicou. É o que permite a Central dizer
      // a verdade ("aplicou a revisão 42") em vez de inferir por data.
      configState: {
        appliedRevision: Number(applied['cloud.appliedConfigRevision'] ?? 0) || 0,
        applyStatus: applied['cloud.configApplyStatus'] || 'UNKNOWN',
        applyError: applied['cloud.configApplyError'] || null,
        // Campos que ESTA versão entende. A Central usa isto para não marcar
        // como "pendente para sempre" uma config que a instalação nem conhece.
        supports: ['licenseStatus', 'restrictions', 'aiPolicy', 'cloudStorage'],
      },
      summary: {
        status: appReadinessStatus === 'blocked' ? 'blocked' : appReadinessStatus === 'attention' ? 'attention' : 'ok',
        productionReadiness: appReadinessStatus,
        launchProfile,
        cameraTotal: cameraCounts.total,
        cameraOnline: cameraCounts.online,
        cameraOffline: cameraCounts.offline,
        cameraError: cameraCounts.error,
        openAlarms,
        recordingCount: recordings._count.id,
        recordingBytes: Number(recordings._sum.sizeBytes ?? 0),
        lastRecordingStartedAt: recordings._max.startedAt,
        recentRecordingCountLastHour: recentRecordings,
        activeRecordingCount: recordingRuntime?.activeCount ?? activeRecordings,
        recordingCapacityStatus: recordingCapacity.status,
        recordingCapacityEnforced,
        streamHighCpuRiskCameras: streamPerformance?.summary?.highCpuRiskCameras ?? 0,
        streamLiveTranscodeLikely: streamPerformance?.summary?.liveTranscodeLikely ?? 0,
        streamLiveFailuresLast24h: streamPerformance?.summary?.liveFailuresLast24h ?? 0,
        streamMediaMtxReaders: streamPerformance?.summary?.mediaMtxReaders ?? 0,
        streamOptimizationSafeActions: streamPerformance?.optimizationPlan?.safeActionCount ?? 0,
        recordingGapSecondsLast24h: streamPerformance?.summary?.recordingGapSecondsLast24h ?? 0,
        recordingAttentionCameras: streamPerformance?.summary?.camerasWithRecordingAttention ?? 0,
        // Detector de movimento cego com gravação de emergência ligada. Zero é
        // o normal; qualquer valor > 0 é a instalação se defendendo de um
        // detector que parou — e o operador da Central PRECISA ver isso.
        motionFailsafeCameras: this.getMotionFailsafeCount(),
        activeUsers,
        diskUsagePercent: disk?.usagePercent ?? null,
        infraHealth: infraHealth
          ? {
              status: infraHealth.status,
              issues: infraHealth.issues,
              selfHealed: infraHealth.selfHealed,
              checkedAt: infraHealth.checkedAt,
              stale: infraHealth.stale,
            }
          : null,
        alerts,
      },
      server: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        uptimeSeconds: os.uptime(),
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        cpuCount: os.cpus().length,
        loadAverage: os.loadavg(),
      },
      storage: {
        recordingsRoot,
        disk,
      },
      // Bloco novo: saúde por câmera para o painel de frota da Central. Sai do
      // payload por completo quando indisponível (a Central trata como "esta
      // instalação ainda não reporta por câmera", não como frota vazia).
      ...(cameraHealth ? { cameras: cameraHealth.cameras } : {}),
      production: {
        launchProfile,
        readiness: {
          status: appReadinessStatus,
          generatedAt: now.toISOString(),
          alerts,
        },
        cameras: cameraOperational,
        recordings: {
          totalCount: recordings._count.id,
          totalBytes: Number(recordings._sum.sizeBytes ?? 0),
          activeCount: recordingRuntime?.activeCount ?? activeRecordings,
          activeDatabaseSegments: activeRecordings,
          recentCountLastHour: recentRecordings,
          lastStartedAt: recordings._max.startedAt,
          runtime: recordingRuntime,
          capacity: recordingCapacity,
          capacityEnforced: recordingCapacityEnforced,
        },
        streams: streamPerformance,
        ai: {
          autoStartEnabled: String(process.env.AI_AUTO_START_ENABLED ?? 'true') !== 'false',
          usesMediamtx: String(process.env.AI_USE_MEDIAMTX ?? 'false') === 'true',
          rtspSubtype: process.env.AI_RTSP_SUBTYPE ?? 'auto',
          analyticsSource: process.env.AI_ANALYTICS_SOURCE ?? 'direct_camera',
        },
        security: {
          cameraTestAllowPublicIp: String(process.env.CAMERA_TEST_ALLOW_PUBLIC_IP ?? 'false') === 'true',
          mediamtxOriginsRestricted,
          hlsAllowOrigin: process.env.MEDIAMTX_HLS_ALLOW_ORIGIN ?? '*',
          webrtcAllowOrigin: process.env.MEDIAMTX_WEBRTC_ALLOW_ORIGIN ?? '*',
          dockerSocketMountedInApi: false,
        },
      },
      time: now.toISOString(),
    };
  }

  private async getCameraCounts() {
    const grouped = await this.prisma.camera.groupBy({
      by: ['status'],
      _count: { id: true },
    });
    const counts = { total: 0, online: 0, offline: 0, error: 0, unknown: 0 };

    for (const row of grouped) {
      const count = row._count.id;
      counts.total += count;
      if (row.status === CameraStatus.ONLINE) counts.online += count;
      if (row.status === CameraStatus.OFFLINE) counts.offline += count;
      if (row.status === CameraStatus.ERROR) counts.error += count;
      if (row.status === CameraStatus.UNKNOWN) counts.unknown += count;
    }

    return counts;
  }

  /**
   * Saúde por câmera para o heartbeat. NUNCA lança: a Central dá por morta a
   * instalação que para de bater, então uma falha aqui (banco lento, serviço
   * ausente no container) só pode custar o bloco novo — jamais o heartbeat.
   */
  private async getCameraHealthForHeartbeat(): Promise<{ cameras: HeartbeatCamerasBlock; alerts: HeartbeatAlert[] } | null> {
    try {
      const observability = this.moduleRef.get(CameraObservabilityService, { strict: false });
      const report = await observability.getCamerasHealth();
      return buildHeartbeatCameras(report, this.getHeartbeatCameraLimit());
    } catch (error) {
      this.logger.warn(
        `Heartbeat sem bloco de saude por camera: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private getHeartbeatCameraLimit() {
    return this.getPositiveInt(process.env.CLOUD_HEARTBEAT_CAMERA_LIMIT, HEARTBEAT_CAMERA_LIMIT_DEFAULT);
  }

  private getRecordingRuntimeSummary() {
    try {
      const manager = this.moduleRef.get(RecordingProcessManagerService, { strict: false }) as RecordingProcessManagerService & {
        getRuntimeSummary?: () => unknown;
      };
      return typeof manager.getRuntimeSummary === 'function' ? manager.getRuntimeSummary() : null;
    } catch {
      return null;
    }
  }

  /**
   * Quantas câmeras estão gravando por FAIL-SAFE agora (detector de movimento
   * cego). Este número precisa viajar no heartbeat: o episódio real ficou
   * invisível — 9 câmeras cegas por horas e a Central mostrando tudo normal,
   * porque nenhuma métrica carregava essa informação. O dono só fica sabendo
   * de um defeito que a Central consegue enxergar.
   */
  private getMotionFailsafeCount(): number {
    try {
      const manager = this.moduleRef.get(RecordingProcessManagerService, { strict: false }) as RecordingProcessManagerService & {
        camerasEmFailsafeCego?: () => string[];
      };
      return typeof manager.camerasEmFailsafeCego === 'function' ? manager.camerasEmFailsafeCego().length : 0;
    } catch {
      return 0;
    }
  }

  private async getStreamPerformanceSummary() {
    try {
      const advisor = this.moduleRef.get(StreamResourceAdvisorService, { strict: false });
      const report = await advisor.getFleetReport();
      return {
        generatedAt: report.generatedAt,
        summary: report.summary,
        recommendations: report.recommendations.slice(0, 8).map((item: any) => ({
          code: item.code,
          severity: item.severity,
          message: item.message,
          action: item.action,
          cameras: Array.isArray(item.cameras) ? item.cameras.slice(0, 8) : [],
        })),
        optimizationPlan: {
          safeActionCount: report.optimizationPlan.safeActionCount,
          manualActionCount: report.optimizationPlan.manualActionCount,
          canApplySafely: report.optimizationPlan.canApplySafely,
        },
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        summary: {
          highCpuRiskCameras: 0,
          liveTranscodeLikely: 0,
          liveFailuresLast24h: 0,
          mediaMtxReaders: 0,
          recordingGapSecondsLast24h: 0,
          camerasWithRecordingAttention: 0,
        },
        recommendations: [],
        optimizationPlan: {
          safeActionCount: 0,
          manualActionCount: 0,
          canApplySafely: false,
        },
      };
    }
  }

  private async getCameraOperationalStats() {
    const [
      total,
      recordingEnabled,
      recordingContinuous,
      aiEnabled,
      audioEnabled,
      byLiveProtocol,
      byLiveSubtype,
      byRecordingSubtype,
      byAnalyticsSubtype,
      byDetectedCodec,
    ] = await Promise.all([
      this.prisma.camera.count(),
      this.prisma.camera.count({ where: { recordingEnabled: true } }),
      this.prisma.camera.count({ where: { recordingEnabled: true, recordingMode: 'continuous' } }),
      this.prisma.camera.count({ where: { aiEnabled: true } }),
      this.prisma.camera.count({ where: { audioEnabled: true } }),
      this.prisma.camera.groupBy({ by: ['preferredLiveProtocol'], _count: { id: true } }),
      this.prisma.camera.groupBy({ by: ['liveSubtype'], _count: { id: true } }),
      this.prisma.camera.groupBy({ by: ['recordingSubtype'], _count: { id: true } }),
      this.prisma.camera.groupBy({ by: ['analyticsSubtype'], _count: { id: true } }),
      this.prisma.camera.groupBy({ by: ['detectedVideoCodec'], _count: { id: true } }),
    ]);

    return {
      total,
      recordingEnabled,
      recordingContinuous,
      aiEnabled,
      audioEnabled,
      byLiveProtocol: this.groupRowsToRecord(byLiveProtocol, 'preferredLiveProtocol'),
      byLiveSubtype: this.groupRowsToRecord(byLiveSubtype, 'liveSubtype'),
      byRecordingSubtype: this.groupRowsToRecord(byRecordingSubtype, 'recordingSubtype'),
      byAnalyticsSubtype: this.groupRowsToRecord(byAnalyticsSubtype, 'analyticsSubtype'),
      byDetectedCodec: this.groupRowsToRecord(byDetectedCodec, 'detectedVideoCodec'),
    };
  }

  private groupRowsToRecord(rows: Array<Record<string, unknown> & { _count: { id: number } }>, field: string) {
    return Object.fromEntries(
      rows.map((row) => {
        const rawValue = row[field];
        const key = rawValue === null || rawValue === undefined || rawValue === '' ? 'unset' : String(rawValue);
        return [key, row._count.id];
      }),
    );
  }

  private async getRecordingCapacityEstimate(disk: { totalBytes: number | null }) {
    const retentionDays = this.getPositiveInt(process.env.RECORDING_RETENTION_DAYS ?? process.env.RETENTION_DAYS, 7);
    const safeCapacityBytes = disk.totalBytes == null ? null : disk.totalBytes * 0.8;
    let estimatedRequiredBytes = 0;
    let source = 'indisponivel';

    const recordingStats = await this.prisma.recording.aggregate({
      _sum: { sizeBytes: true },
      _min: { startedAt: true },
      _max: { startedAt: true },
    });
    const totalRecordingBytes = Number(recordingStats._sum.sizeBytes ?? 0);
    const minStartedAt = recordingStats._min.startedAt?.getTime() ?? null;
    const maxStartedAt = recordingStats._max.startedAt?.getTime() ?? null;
    const historySeconds = minStartedAt != null && maxStartedAt != null ? Math.max((maxStartedAt - minStartedAt) / 1000, 0) : 0;

    if (totalRecordingBytes > 0 && historySeconds >= 900) {
      estimatedRequiredBytes = (totalRecordingBytes / historySeconds) * 86400 * retentionDays;
      source = 'historical_recording_rate';
    } else {
      const [cameraCount, knownBitrateCount, bitrate] = await Promise.all([
        this.prisma.camera.count(),
        this.prisma.camera.count({ where: { recordingBitrateKbps: { gt: 0 } } }),
        this.prisma.camera.aggregate({ _sum: { recordingBitrateKbps: true } }),
      ]);
      const fallbackKbps = this.getPositiveInt(process.env.RECORDING_CAPACITY_FALLBACK_CAMERA_KBPS, 4096);
      const knownKbps = Number(bitrate._sum.recordingBitrateKbps ?? 0);
      const missingCount = Math.max(cameraCount - knownBitrateCount, 0);
      const estimatedKbps = knownKbps + missingCount * fallbackKbps;
      estimatedRequiredBytes = (estimatedKbps * 1000 * 86400 * retentionDays) / 8;
      source = `configured_bitrate_with_${fallbackKbps}kbps_fallback`;
    }

    const status =
      safeCapacityBytes == null || safeCapacityBytes <= 0
        ? 'unknown'
        : estimatedRequiredBytes > safeCapacityBytes
          ? 'blocked'
          : estimatedRequiredBytes > safeCapacityBytes * 0.7
            ? 'attention'
            : 'ready';

    return {
      status,
      source,
      retentionDays,
      estimatedRequiredBytes: Math.round(estimatedRequiredBytes),
      estimatedRequiredGb: Math.round((estimatedRequiredBytes / 1024 / 1024 / 1024) * 10) / 10,
      safeCapacityBytes: safeCapacityBytes == null ? null : Math.round(safeCapacityBytes),
      safeCapacityGb: safeCapacityBytes == null ? null : Math.round((safeCapacityBytes / 1024 / 1024 / 1024) * 10) / 10,
    };
  }

  private async getDiskStats(path: string) {
    try {
      const disk = await statfs(path);
      const totalBytes = Number(disk.blocks) * Number(disk.bsize);
      const freeBytes = Number(disk.bavail) * Number(disk.bsize);
      const usedBytes = Math.max(totalBytes - freeBytes, 0);
      return {
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
      };
    } catch (error) {
      return {
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        usagePercent: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readSettings() {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: SETTING_KEYS } },
    });

    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  private async writeSetting(key: string, value: string) {
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  private parseJsonSetting(value: string | undefined, fallback: unknown) {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  private normalizeLicenseStatus(value: unknown): LicenseStatus {
    if (value === 'ACTIVE' || value === 'GRACE' || value === 'RESTRICTED' || value === 'SUSPENDED') return value;
    return 'UNKNOWN';
  }

  /**
   * Valida o storage vindo da Central antes de persistir.
   *
   * Config pela metade é tratada como AUSENTE: aceitar um bucket sem credencial
   * (ou sem endpoint) faria a instalação tentar subir gravação para lugar
   * nenhum, falhando em laço e enchendo o log — enquanto o operador acha que
   * provisionou. Melhor não ligar do que ligar quebrado.
   */
  private normalizeCloudStorage(raw: unknown): CloudStorageConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    if (source.enabled !== true) return null;

    const text = (key: string) => String(source[key] ?? '').trim();
    const endpoint = text('endpoint');
    const bucket = text('bucket');
    const accessKeyId = text('accessKeyId');
    const secretAccessKey = text('secretAccessKey');
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
    if (!/^https?:\/\//i.test(endpoint)) return null;

    const mode = source.mode === 'mount' ? 'mount' : 'tier';
    const windowHours = Number(source.localWindowHours);
    return {
      enabled: true,
      // Preservado do payload da Central: era descartado aqui, e por isso o
      // resolvedor rotulava TODOS os storages de "Storage principal" — depois
      // de uma troca, o antigo e o novo ficavam idênticos na tela.
      name: text('name'),
      // Paralelismo do envio, escolhido na Central. Fora da faixa cai no padrão:
      // valor absurdo vindo de fora não pode virar pico de memória nem afogar o
      // link do cliente.
      uploadConcurrency: (() => {
        const n = Number(source.uploadConcurrency);
        return Number.isFinite(n) && n >= 1 && n <= 64 ? Math.round(n) : 6;
      })(),
      mode,
      provider: text('provider') || 's3',
      endpoint,
      region: text('region') || 'us-east-1',
      bucket,
      prefix: text('prefix'),
      accessKeyId,
      secretAccessKey,
      localWindowHours: Number.isFinite(windowHours) && windowHours >= 1 && windowHours <= 720
        ? Math.round(windowHours)
        : 24,
      forcePathStyle: source.forcePathStyle !== false,
      updatedAt: text('updatedAt') || null,
    };
  }

  /** Config vigente, para quem precisa falar com o bucket. */
  /**
   * Valor do estado, com o padrão CONSERVADOR para Central antiga.
   *
   * Central que não manda o campo cai em `disabled`: sem storage provisionado,
   * a instalação para de enviar e ninguém assume o lugar. O erro caro seria o
   * inverso — promover um storage arquivado sozinho, ressuscitando um contrato
   * que o cliente já cancelou e voltando a gerar custo.
   */
  private normalizeStorageState(raw: unknown): CloudStorageState {
    const valor = String(raw ?? '').trim();
    return valor === 'configured' || valor === 'absent' ? valor : 'disabled';
  }

  /** Por que não há storage provisionado — veja `normalizeStorageState`. */
  async getCloudStorageState(): Promise<CloudStorageState> {
    const settings = await this.readSettings();
    return this.normalizeStorageState(settings['cloud.storageState']);
  }

  async getCloudStorageConfig(): Promise<CloudStorageConfig | null> {
    const settings = await this.readSettings();
    const raw = settings['cloud.storage'];
    if (!raw) return null;
    try {
      return this.normalizeCloudStorage(JSON.parse(raw));
    } catch {
      // Setting corrompido não pode derrubar quem consulta: tratar como
      // "sem storage" é o comportamento seguro.
      return null;
    }
  }

  private async enforceRuntimeRestrictions(restrictions: Record<string, unknown>) {
    if (restrictions.localRecording === false) {
      try {
        const manager = this.moduleRef.get(RecordingProcessManagerService, { strict: false });
        await manager.stopAll();
      } catch (error) {
        this.logger.warn(`Falha ao parar gravacoes por restricao comercial: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.enforceAiRestrictions(restrictions);
  }

  /**
   * Aplica a política de IA vinda da Central.
   *
   * ⚠️ ARMADILHA que este método existe para evitar: antes, QUALQUER
   * `aiAdvanced:false` derrubava TODA a IA via stopAll(). Com a política
   * granular, "somente movimento" (o estado desejado e mais comum) produz
   * `aiAdvanced:false` — e o stopAll cego mataria também o MOG2, que é o que ARMA
   * a gravação por movimento. Resultado: câmeras armadas parariam de gravar
   * silenciosamente. Por isso a decisão é tomada por CAPACIDADE, não pelo campo
   * legado.
   *
   * COMPATIBILIDADE: uma Central antiga não envia as chaves granulares. Nesse
   * caso preservamos o comportamento histórico (aiAdvanced:false ⇒ para tudo),
   * senão uma restrição comercial legítima deixaria de ser aplicada.
   */
  private async enforceAiRestrictions(restrictions: Record<string, unknown>) {
    const hasGranular = 'aiMotion' in restrictions || 'aiObject' in restrictions || 'aiFace' in restrictions;

    const mustStopEverything = hasGranular
      // Movimento é a base: sem ele, nenhuma análise deve rodar.
      ? restrictions.aiMotion === false
      // Central antiga: comportamento histórico.
      : restrictions.aiAdvanced === false;

    if (!mustStopEverything) {
      if (hasGranular && restrictions.aiObject !== true && restrictions.aiFace !== true) {
        this.logger.log('Política da Central: somente detecção de MOVIMENTO habilitada (objeto/face desligados).');
      }
      return;
    }

    try {
      const aiService = this.moduleRef.get(AiService, { strict: false });
      await aiService.stopAll();
      this.logger.warn('Toda a IA foi parada por política da Central (movimento desabilitado).');
    } catch (error) {
      this.logger.warn(`Falha ao parar IA por restricao comercial: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private applyStatusCaps(status: LicenseStatus, restrictions: Record<string, unknown>) {
    if (status === 'SUSPENDED') {
      return {
        ...restrictions,
        localLive: false,
        localRecording: false,
        addCameras: false,
        aiAdvanced: false,
        cloudSupport: false,
        updates: false,
      };
    }
    if (status === 'RESTRICTED') {
      return {
        ...restrictions,
        addCameras: false,
        aiAdvanced: false,
        updates: false,
      };
    }
    return restrictions;
  }

  private getPositiveInt(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private getLaunchProfile() {
    const value = String(process.env.DRAC_LAUNCH_PROFILE || 'standard').trim().toLowerCase();
    return value || 'standard';
  }

  private trimTrailingSlash(value: string) {
    return value.trim().replace(/\/+$/, '');
  }
}
