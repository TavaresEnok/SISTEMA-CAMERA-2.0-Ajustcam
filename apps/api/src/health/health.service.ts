import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import * as os from 'node:os';
import { readdir, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CameraStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { envNumber } from '../common/config/env-number.helper';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getReadiness() {
    const timeoutMs = envNumber('HEALTH_READINESS_TIMEOUT_MS', 3_000, { min: 500 });
    const checks: Record<string, { ok: boolean; detail?: string; optional?: boolean }> = {};

    try {
      await this.withDeadline(this.prisma.$queryRaw`SELECT 1`, timeoutMs, 'database');
      checks.database = { ok: true };
    } catch (error) {
      checks.database = { ok: false, detail: error instanceof Error ? error.message : 'database_unavailable' };
    }

    const redis = new Redis({
      host: this.config.get<string>('redisHost') ?? 'localhost',
      port: Number(this.config.get<number>('redisPort') ?? 6379),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: timeoutMs,
    });
    redis.on('error', () => undefined);
    try {
      await this.withDeadline(redis.connect(), timeoutMs, 'redis_connect');
      await this.withDeadline(redis.ping(), timeoutMs, 'redis_ping');
      checks.redis = { ok: true };
    } catch (error) {
      checks.redis = { ok: false, detail: error instanceof Error ? error.message : 'redis_unavailable' };
    } finally {
      redis.disconnect(false);
    }

    const recordingsRoot = this.config.get<string>('recordingsRoot') ?? '/storage';
    const probePath = join(recordingsRoot, `.readiness-${process.pid}-${Date.now()}.tmp`);
    try {
      await this.withDeadline(statfs(recordingsRoot), timeoutMs, 'storage_stat');
      await this.withDeadline(writeFile(probePath, 'ready'), timeoutMs, 'storage_write');
      await unlink(probePath).catch(() => undefined);
      checks.storage = { ok: true };
    } catch (error) {
      await unlink(probePath).catch(() => undefined);
      checks.storage = { ok: false, detail: error instanceof Error ? error.message : 'storage_unavailable' };
    }

    const mediaMtxEnabled = this.config.get<boolean>('mediaMtxEnabled') ?? true;
    if (mediaMtxEnabled) {
      try {
        const baseUrl = String(this.config.get<string>('mediaMtxApiBaseUrl') ?? 'http://mediamtx:9997').replace(/\/+$/, '');
        const user = this.config.get<string>('mediaMtxApiUser') ?? '';
        const pass = this.config.get<string>('mediaMtxApiPass') ?? '';
        const authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        const response = await fetch(`${baseUrl}/v3/config/global/get`, {
          headers: { authorization },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`mediamtx_http_${response.status}`);
        checks.mediamtx = { ok: true };
      } catch (error) {
        checks.mediamtx = { ok: false, detail: error instanceof Error ? error.message : 'mediamtx_unavailable' };
      }
    } else {
      checks.mediamtx = { ok: true, optional: true, detail: 'disabled' };
    }

    const aiEnabled = String(process.env.AI_AUTO_START_ENABLED ?? 'true') !== 'false';
    if (aiEnabled) {
      try {
        const baseUrl = String(this.config.get<string>('aiBaseUrl') ?? 'http://ai-service:8000').replace(/\/+$/, '');
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`ai_http_${response.status}`);
        const health = await response.json() as { status?: string };
        if (!['online', 'degraded'].includes(health.status ?? '')) {
          throw new Error(`ai_status_${health.status ?? 'unknown'}`);
        }
        // "degraded" pode significar somente uma câmera sem frame. O serviço
        // continua alcançável; a saúde por câmera é monitorada separadamente.
        checks.ai = { ok: true, ...(health.status === 'degraded' ? { detail: 'degraded_processors' } : {}) };
      } catch (error) {
        checks.ai = { ok: false, detail: error instanceof Error ? error.message : 'ai_unavailable' };
      }
    } else {
      checks.ai = { ok: true, optional: true, detail: 'disabled' };
    }

    const ready = Object.values(checks).every((check) => check.ok || check.optional);
    return {
      status: ready ? 'ready' : 'not_ready',
      ready,
      checks,
      time: new Date().toISOString(),
    };
  }

  async getSystemSummary() {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? '/storage';
    const storageBackend = process.env.STORAGE_BACKEND ?? 'local';
    const writeProbeEnabled = String(process.env.STORAGE_WRITE_PROBE_ENABLED ?? 'true') !== 'false';

    const [disk, recordings] = await Promise.all([
      statfs(recordingsRoot),
      this.prisma.recording.aggregate({
        _count: { id: true },
        _sum: { sizeBytes: true },
        _max: { startedAt: true },
      }),
    ]);

    const totalBytes = Number(disk.blocks) * Number(disk.bsize);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const usedBytes = Math.max(totalBytes - freeBytes, 0);
    let writable = null as null | boolean;
    let writeProbeError: string | null = null;
    if (writeProbeEnabled) {
      const probePath = join(recordingsRoot, `.health-write-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      try {
        await writeFile(probePath, 'health_probe');
        await unlink(probePath);
        writable = true;
      } catch (error) {
        writable = false;
        writeProbeError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      status: 'ok',
      service: 'api',
      recordingsRoot,
      storage: {
        backend: storageBackend,
        writeProbeEnabled,
        writable,
        writeProbeError,
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
      disk: {
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
      },
      recordings: {
        count: recordings._count.id,
        totalBytes: Number(recordings._sum.sizeBytes ?? 0),
        lastStartedAt: recordings._max.startedAt,
      },
      time: new Date().toISOString(),
    };
  }

  async getOperationalReadiness() {
    const now = new Date();
    const launchProfile = String(process.env.DRAC_LAUNCH_PROFILE || 'standard').trim().toLowerCase() || 'standard';
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? '/storage';
    const [system, cameraCounts, liveWebrtcCount, liveMainCount, recordingStats, aiEnabledCount, settings, latestBackup] = await Promise.all([
      this.getSystemSummary(),
      this.getCameraCounts(),
      this.prisma.camera.count({ where: { preferredLiveProtocol: 'webrtc' } }),
      this.prisma.camera.count({ where: { OR: [{ liveSubtype: 0 }, { liveSubtype: null, subtype: 0 }] } }),
      this.getRecordingProfileStats(),
      this.prisma.camera.count({ where: { aiEnabled: true } }),
      this.getCloudSettings(),
      this.getLatestPostgresBackup(),
    ]);

    const checks: Array<{ key: string; label: string; status: 'ok' | 'attention' | 'blocked'; detail: string }> = [];
    const cameraTotal = cameraCounts.total;
    const aiOptional = launchProfile === 'standard' && String(process.env.AI_AUTO_START_ENABLED ?? 'true') === 'false' && aiEnabledCount === 0;
    const continuousRecordingOptional = launchProfile === 'standard' && recordingStats.continuous === 0 && String(process.env.RECORDING_AUTO_START_ENABLED ?? 'false') !== 'true';

    checks.push({
      key: 'api',
      label: 'API',
      status: 'ok',
      detail: 'API respondendo e banco acessivel.',
    });
    checks.push({
      key: 'cameras',
      label: 'Cameras',
      status: cameraTotal > 0 && cameraCounts.online === cameraTotal ? 'ok' : cameraCounts.online > 0 ? 'attention' : 'blocked',
      detail: `${cameraCounts.online}/${cameraTotal} cameras online.`,
    });
    checks.push({
      key: 'live',
      label: 'Live WebRTC',
      status: cameraTotal > 0 && liveWebrtcCount === cameraTotal && liveMainCount === cameraTotal ? 'ok' : 'attention',
      detail: `${liveWebrtcCount}/${cameraTotal} cameras em WebRTC; ${liveMainCount}/${cameraTotal} usando perfil principal para live.`,
    });
    checks.push({
      key: 'recording',
      label: 'Gravacao',
      status: recordingStats.enabled > 0 || continuousRecordingOptional ? 'ok' : 'attention',
      detail: continuousRecordingOptional
        ? 'Gravacao continua opcional neste perfil; administrador pode ativar manual, movimento ou continua por camera.'
        : `${recordingStats.enabled}/${cameraTotal} cameras com gravacao habilitada.`,
    });
    checks.push({
      key: 'ai',
      label: 'IA',
      status: aiEnabledCount > 0 || aiOptional ? 'ok' : 'attention',
      detail: aiOptional ? 'IA desativada por perfil de lancamento standard.' : `${aiEnabledCount}/${cameraTotal} cameras com IA habilitada.`,
    });
    checks.push({
      key: 'storage',
      label: 'Storage',
      status: system.disk.usagePercent >= 85 ? 'blocked' : system.disk.usagePercent >= 75 ? 'attention' : 'ok',
      detail: `${system.disk.usagePercent}% usado em ${recordingsRoot}.`,
    });
    checks.push({
      key: 'backup',
      label: 'Backup',
      status: latestBackup && latestBackup.ageHours <= 36 ? 'ok' : 'attention',
      detail: latestBackup ? `Ultimo backup ha ${latestBackup.ageHours}h (${latestBackup.file}).` : 'Nenhum backup Postgres encontrado.',
    });
    checks.push({
      key: 'central',
      label: 'Central',
      status: settings.licenseStatus === 'ACTIVE' || settings.licenseStatus === 'GRACE' ? 'ok' : settings.licenseStatus ? 'blocked' : 'attention',
      detail: settings.lastSyncAt ? `Ultimo heartbeat ${settings.lastSyncAt}; licenca ${settings.licenseStatus || 'UNKNOWN'}.` : 'Heartbeat da Central ainda nao registrado.',
    });

    const status = checks.some((check) => check.status === 'blocked')
      ? 'blocked'
      : checks.some((check) => check.status === 'attention')
        ? 'attention'
        : 'ready';

    return {
      status,
      launchProfile,
      generatedAt: now.toISOString(),
      summary: {
        camerasOnline: cameraCounts.online,
        camerasTotal: cameraTotal,
        liveWebrtcCount,
        recordingEnabledCount: recordingStats.enabled,
        recordingContinuousCount: recordingStats.continuous,
        aiEnabledCount,
        diskUsagePercent: system.disk.usagePercent,
        centralLicenseStatus: settings.licenseStatus || 'UNKNOWN',
      },
      checks,
    };
  }

  private async getCameraCounts() {
    const grouped = await this.prisma.camera.groupBy({ by: ['status'], _count: { id: true } });
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

  private async getRecordingProfileStats() {
    const [enabled, continuous] = await Promise.all([
      this.prisma.camera.count({ where: { recordingEnabled: true } }),
      this.prisma.camera.count({ where: { recordingEnabled: true, recordingMode: 'continuous' } }),
    ]);
    return { enabled, continuous };
  }

  private async getCloudSettings() {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: ['cloud.lastSyncAt', 'cloud.licenseStatus', 'cloud.lastError'] } },
    });
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      lastSyncAt: settings['cloud.lastSyncAt'] || null,
      licenseStatus: settings['cloud.licenseStatus'] || null,
      lastError: settings['cloud.lastError'] || null,
    };
  }

  private async getLatestPostgresBackup() {
    const backupDir = process.env.POSTGRES_BACKUP_DIR || '/backups/postgres';
    try {
      const files = await readdir(backupDir);
      const candidates = await Promise.all(
        files
          .filter((file) => /^drac-postgres-.*\.dump$/.test(file))
          .map(async (file) => {
            const fileStat = await stat(join(backupDir, file));
            return { file, mtimeMs: fileStat.mtimeMs };
          }),
      );
      const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      if (!latest) return null;
      return {
        file: latest.file,
        ageHours: Math.max(0, Math.floor((Date.now() - latest.mtimeMs) / 3600000)),
      };
    } catch {
      return null;
    }
  }
}
