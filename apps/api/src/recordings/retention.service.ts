import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ensureFileUnderRoot } from './helpers/safe-file.helper';
import { buildTimelinePreviewPath } from './helpers/timeline-preview.helper';

type ProtectionSets = {
  recordingIds: Set<string>;
  clipIds: Set<string>;
  eventIds: Set<string>;
};

type CleanupResult = {
  skipped: boolean;
  reason?: string;
  recordingsDeleted: number;
  clipsDeleted: number;
  eventsDeleted: number;
  orphanThumbnailsDeleted: number;
  orphanCompatibleFilesDeleted: number;
};

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    this.logger.log('Retention Service inicializado.');
    const useBullmq = this.config.get<boolean>('retentionUseBullmq');
    if (useBullmq) {
      this.logger.log('Retenção por idade delegada ao BullMQ; guardião de disco permanece ativo.');
      void this.checkDiskUsage();
      this.interval = setInterval(() => void this.checkDiskUsage(), 60 * 60 * 1000);
      this.interval.unref();
      return;
    }
    void this.handleRetention('local_timer');
    this.interval = setInterval(() => void this.handleRetention('local_timer'), 60 * 60 * 1000);
    this.interval.unref();
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async getProtectionSets(): Promise<ProtectionSets> {
    const recordingIds = new Set<string>();
    const clipIds = new Set<string>();
    const eventIds = new Set<string>();

    // Somente o estado mais recente do hold por investigação é efetivo. Isso
    // permite desabilitar um hold sem que um registro histórico antigo o reative.
    const holdRows = await this.prisma.investigationItem.findMany({
      where: { type: 'legal_hold' },
      orderBy: { createdAt: 'desc' },
      select: { investigationId: true, metadata: true },
    });
    const latestHoldByInvestigation = new Map<string, unknown>();
    for (const row of holdRows) {
      if (!latestHoldByInvestigation.has(row.investigationId)) {
        latestHoldByInvestigation.set(row.investigationId, row.metadata);
      }
    }
    for (const metadata of latestHoldByInvestigation.values()) {
      if (!metadata || typeof metadata !== 'object') continue;
      const value = metadata as Record<string, unknown>;
      const enabled = value.enabled === true || value.enabled === 1 || value.enabled === 'true';
      if (!enabled) continue;
      if (Array.isArray(value.recordingIds)) {
        for (const id of value.recordingIds) if (typeof id === 'string') recordingIds.add(id);
      }
      if (Array.isArray(value.clipIds)) {
        for (const id of value.clipIds) if (typeof id === 'string') clipIds.add(id);
      }
      if (Array.isArray(value.eventIds)) {
        for (const id of value.eventIds) if (typeof id === 'string') eventIds.add(id);
      }
    }

    // Itens efetivamente adicionados a uma investigação são evidência, mesmo
    // quando não existe um legal_hold explícito.
    const evidenceItems = await this.prisma.investigationItem.findMany({
      where: { NOT: { type: 'legal_hold' } },
      select: { recordingId: true, eventId: true, metadata: true },
    });
    for (const item of evidenceItems) {
      if (item.recordingId) recordingIds.add(item.recordingId);
      if (item.eventId) eventIds.add(item.eventId);
      if (!item.metadata || typeof item.metadata !== 'object') continue;
      const value = item.metadata as Record<string, unknown>;
      if (typeof value.clipId === 'string') clipIds.add(value.clipId);
      if (typeof value.recordingId === 'string') recordingIds.add(value.recordingId);
      if (typeof value.eventId === 'string') eventIds.add(value.eventId);
      if (Array.isArray(value.clipIds)) {
        for (const id of value.clipIds) if (typeof id === 'string') clipIds.add(id);
      }
      if (Array.isArray(value.recordingIds)) {
        for (const id of value.recordingIds) if (typeof id === 'string') recordingIds.add(id);
      }
    }

    if (clipIds.size) {
      const protectedClips = await this.prisma.exportedClip.findMany({
        where: { id: { in: [...clipIds] } },
        select: { sourceRecordingId: true },
      });
      for (const clip of protectedClips) recordingIds.add(clip.sourceRecordingId);
    }
    return { recordingIds, clipIds, eventIds };
  }

  private derivedThumbnailPath(filePath: string) {
    const extension = extname(filePath);
    return `${extension ? filePath.slice(0, -extension.length) : filePath}.thumb.jpg`;
  }

  private removeFile(filePath: string) {
    try {
      rmSync(filePath, { force: true });
      return true;
    } catch (error) {
      this.logger.warn(`Falha ao remover artefato ${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async deleteClip(clip: { id: string; filePath: string }) {
    const root = this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const fullPath = ensureFileUnderRoot(root, clip.filePath);
    this.removeFile(fullPath);
    await this.prisma.exportedClip.delete({ where: { id: clip.id } });
  }

  private async deleteRecording(
    recording: { id: string; cameraId: string; filePath: string },
    protection: ProtectionSets,
  ) {
    if (protection.recordingIds.has(recording.id)) return false;
    const clips = await this.prisma.exportedClip.findMany({
      where: { sourceRecordingId: recording.id },
      select: { id: true, filePath: true },
    });
    if (clips.some((clip) => protection.clipIds.has(clip.id))) return false;
    for (const clip of clips) await this.deleteClip(clip);

    const root = this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const fullPath = ensureFileUnderRoot(root, recording.filePath);
    this.removeFile(fullPath);
    this.removeFile(this.derivedThumbnailPath(fullPath));
    // Sprite de scrubbing (2.9): mora ao lado do MP4 e DEVE morrer com ele — senão
    // sobra derivado de conteúdo no disco após a retenção apagar a origem.
    this.removeFile(buildTimelinePreviewPath(fullPath));
    this.removeFile(`${fullPath}.invalid.json`);
    this.removeFile(join(root, '.playback-compatible', recording.cameraId, `${recording.id}.mp4`));
    await this.prisma.recording.delete({ where: { id: recording.id } });
    return true;
  }

  async handleRetention(source = 'manual'): Promise<CleanupResult> {
    const result: CleanupResult = {
      skipped: false,
      recordingsDeleted: 0,
      clipsDeleted: 0,
      eventsDeleted: 0,
      orphanThumbnailsDeleted: 0,
      orphanCompatibleFilesDeleted: 0,
    };
    const autoCleanup = await this.settings.isAutoCleanupEnabled().catch(() => true);
    if (!autoCleanup) {
      this.logger.warn(`Retenção ignorada (${source}): limpeza automática desativada nas configurações.`);
      return { ...result, skipped: true, reason: 'auto_cleanup_disabled' };
    }

    const configuredDays = await this.settings.getDefaultRetentionDays().catch(() => 0);
    const globalDays = configuredDays > 0
      ? configuredDays
      : Number(this.config.get<number>('retentionDays') ?? process.env.RECORDING_RETENTION_DAYS ?? 7);
    const protection = await this.getProtectionSets();
    const now = Date.now();
    this.logger.log(`Iniciando retenção (${source}, global=${globalDays} dias, holds=${protection.recordingIds.size}).`);

    // Clips vêm primeiro: excluir a gravação causaria cascade no banco e deixaria
    // o arquivo exportado órfão no disco.
    const clips = await this.prisma.exportedClip.findMany({
      include: { sourceRecording: { include: { camera: { select: { retentionDays: true } } } } },
      orderBy: { startedAt: 'asc' },
    });
    for (const clip of clips) {
      const retentionDays = clip.sourceRecording?.camera?.retentionDays ?? globalDays;
      if (clip.startedAt.getTime() >= now - retentionDays * 86_400_000) continue;
      if (protection.clipIds.has(clip.id)) continue;
      try {
        await this.deleteClip(clip);
        result.clipsDeleted += 1;
      } catch (error) {
        this.logger.error(`Falha ao remover clip ${clip.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const recordings = await this.prisma.recording.findMany({
      include: { camera: { select: { retentionDays: true } } },
      orderBy: { startedAt: 'asc' },
    });
    for (const recording of recordings) {
      const retentionDays = recording.camera?.retentionDays ?? globalDays;
      if (recording.startedAt.getTime() >= now - retentionDays * 86_400_000) continue;
      try {
        if (await this.deleteRecording(recording, protection)) result.recordingsDeleted += 1;
      } catch (error) {
        this.logger.error(`Falha ao remover gravação ${recording.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const eventCutoff = new Date(now - Math.max(1, Number(process.env.CAMERA_EVENT_RETENTION_DAYS ?? 30)) * 86_400_000);
    const deletedEvents = await this.prisma.cameraEvent.deleteMany({
      where: {
        occurredAt: { lt: eventCutoff },
        ...(protection.eventIds.size ? { id: { notIn: [...protection.eventIds] } } : {}),
      },
    });
    result.eventsDeleted = deletedEvents.count;

    const derived = await this.cleanupOrphanDerivedArtifacts();
    result.orphanThumbnailsDeleted = derived.orphanThumbnailsDeleted;
    result.orphanCompatibleFilesDeleted = derived.orphanCompatibleFilesDeleted;
    this.cleanEmptyDirs(this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings');
    await this.checkDiskUsage(protection);
    this.logger.log(`Retenção concluída: ${JSON.stringify(result)}.`);
    return result;
  }

  private async cleanupOrphanDerivedArtifacts() {
    const root = this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const rows = await this.prisma.recording.findMany({ select: { id: true, cameraId: true, filePath: true } });
    const expectedThumbnails = new Set<string>();
    const expectedPreviews = new Set<string>();
    const expectedCompatible = new Set<string>();
    const validIds = new Set<string>();
    for (const row of rows) {
      const filePath = ensureFileUnderRoot(root, row.filePath);
      expectedThumbnails.add(this.derivedThumbnailPath(filePath));
      expectedPreviews.add(buildTimelinePreviewPath(filePath));
      expectedCompatible.add(join(root, '.playback-compatible', row.cameraId, `${row.id}.mp4`));
      validIds.add(row.id);
    }

    let orphanThumbnailsDeleted = 0;
    let orphanCompatibleFilesDeleted = 0;
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (entry.name.endsWith('.thumb.jpg') && !expectedThumbnails.has(fullPath)) {
          if (this.removeFile(fullPath)) orphanThumbnailsDeleted += 1;
        } else if (entry.name.endsWith('.preview.jpg') && !expectedPreviews.has(fullPath)) {
          if (this.removeFile(fullPath)) orphanThumbnailsDeleted += 1;
        } else if (fullPath.includes(`${join(root, '.playback-compatible')}/`) && entry.name.endsWith('.mp4') && !expectedCompatible.has(fullPath)) {
          if (this.removeFile(fullPath)) orphanCompatibleFilesDeleted += 1;
        }
      }
    };
    walk(root);

    const diagnosticsPath = join(root, '.diagnostics-cache', 'recording-health.json');
    if (existsSync(diagnosticsPath)) {
      try {
        const cache = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as Record<string, unknown>;
        let changed = false;
        for (const id of Object.keys(cache)) {
          if (validIds.has(id)) continue;
          delete cache[id];
          changed = true;
        }
        if (changed) writeFileSync(diagnosticsPath, JSON.stringify(cache), 'utf8');
      } catch {
        // Cache diagnóstico é best effort; não interrompe retenção.
      }
    }
    return { orphanThumbnailsDeleted, orphanCompatibleFilesDeleted };
  }

  private async diskUsagePercent(root: string) {
    const disk = await statfs(root);
    const total = Number(disk.blocks) * Number(disk.bsize);
    const free = Number(disk.bavail) * Number(disk.bsize);
    return total > 0 ? Math.round(((total - free) / total) * 100) : 0;
  }

  private async checkDiskUsage(existingProtection?: ProtectionSets) {
    const root = this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings';
    try {
      const initialPercent = await this.diskUsagePercent(root);
      const triggerPercent = Math.max(50, Math.min(99, Number(process.env.RETENTION_DISK_TRIGGER_PERCENT ?? 90)));
      if (initialPercent <= triggerPercent) return;
      const autoCleanup = await this.settings.isAutoCleanupEnabled().catch(() => true);
      if (!autoCleanup) {
        this.logger.warn(`Espaço em disco crítico: ${initialPercent}%; limpeza automática desativada.`);
        return;
      }
      const protection = existingProtection ?? await this.getProtectionSets();
      const target = Math.max(40, Math.min(triggerPercent - 1, Number(process.env.RETENTION_DISK_TARGET_PERCENT ?? 85)));
      let current = initialPercent;
      let totalDeleted = 0;
      this.logger.warn(`Espaço em disco crítico: ${initialPercent}%. Removendo apenas gravações sem hold até ${target}%.`);
      for (let iteration = 0; iteration < 100 && current > target; iteration += 1) {
        const oldest = await this.prisma.recording.findMany({
          where: protection.recordingIds.size ? { id: { notIn: [...protection.recordingIds] } } : {},
          orderBy: { startedAt: 'asc' },
          take: 20,
          select: { id: true, cameraId: true, filePath: true },
        });
        if (!oldest.length) break;
        let batchDeleted = 0;
        for (const recording of oldest) {
          try {
            if (await this.deleteRecording(recording, protection)) {
              totalDeleted += 1;
              batchDeleted += 1;
            }
          } catch (error) {
            this.logger.error(`Falha no guardião de disco recording=${recording.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!batchDeleted) break;
        current = await this.diskUsagePercent(root);
      }
      this.logger.log(`Guardião de disco concluído: ${totalDeleted} removida(s), uso ${initialPercent}% → ${current}%.`);
    } catch (error) {
      this.logger.error(`Erro ao verificar espaço em disco: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private cleanEmptyDirs(dir: string) {
    if (!existsSync(dir)) return;
    const stats = statSync(dir);
    if (!stats.isDirectory()) return;
    for (const file of readdirSync(dir)) this.cleanEmptyDirs(join(dir, file));
    if (readdirSync(dir).length === 0 && dir !== (this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings')) {
      try {
        rmdirSync(dir);
      } catch {
        // Outro processo pode ter recriado o diretório.
      }
    }
  }
}
