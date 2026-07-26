import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, BadRequestException, InternalServerErrorException, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { type Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Queue } from 'bullmq';
import { RecordingSource, UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { AccessControlService } from '../access-control/access-control.service';
import { AuthService } from '../auth/auth.service';
import { type AuthUser } from '../common/types/auth-user.type';
import { THUMBNAIL_GENERATION_QUEUE } from '../jobs/queues/thumbnail-generation.queue';
import { ListRecordingsQueryDto } from './dto/list-recordings-query.dto';
import { RegisterRecordingDto } from './dto/register-recording.dto';
import { ExportClipDto } from './dto/export-clip.dto';
import { ensureFileUnderRoot } from './helpers/safe-file.helper';
import { listRecordingFilesOnDisk } from './helpers/recording-disk-scan.helper';
import { reconcileRecordingPaths, type RecordingReconciliation } from './helpers/recording-reconcile.helper';
import {
  planTimelinePreview,
  buildTimelinePreviewPath,
  buildTimelinePreviewArgs,
  type TimelinePreviewPlan,
} from './helpers/timeline-preview.helper';
import archiver from 'archiver';

const execFileAsync = promisify(execFile);
type RecordingHealthCacheEntry = {
  checkedAt: string;
  diagnostics?: Record<string, unknown>;
  integrity?: Record<string, unknown>;
};

@Injectable()
export class RecordingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordingsService.name);
  private readonly thumbnailGenerationInFlight = new Map<string, Promise<void>>();
  private readonly timelinePreviewInFlight = new Map<string, Promise<void>>();
  private readonly thumbnailGenerationWaiters: Array<() => void> = [];
  private thumbnailGenerationActive = 0;
  private integritySweepTimer: NodeJS.Timeout | null = null;
  private integritySweepRunning = false;
  private readonly thumbnailGenerationConcurrency = Math.max(
    1,
    Math.min(4, Number(process.env.RECORDING_THUMBNAIL_CONCURRENCY ?? 2)),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly accessControlService: AccessControlService,
    @InjectQueue(THUMBNAIL_GENERATION_QUEUE) private readonly thumbnailQueue: Queue,
  ) {}

  onModuleInit() {
    // Varredura periódica de INTEGRIDADE: hoje só descobrimos que uma gravação
    // está corrompida quando alguém tenta reproduzi-la — normalmente no pior
    // momento possível (precisando da prova). Aqui uma amostra pequena é
    // verificada de tempos em tempos e o problema vira evento na câmera.
    if (String(process.env.RECORDING_INTEGRITY_SWEEP_ENABLED ?? 'true') !== 'false') {
      const intervalMs = Math.max(15 * 60_000, Number(process.env.RECORDING_INTEGRITY_SWEEP_INTERVAL_MS ?? 60 * 60_000));
      this.integritySweepTimer = setInterval(() => void this.runIntegritySweep(), intervalMs);
      this.integritySweepTimer.unref?.();
      const firstRun = setTimeout(() => void this.runIntegritySweep(), 5 * 60_000);
      firstRun.unref();
    }

    if (String(process.env.RECORDING_THUMBNAIL_BACKFILL_ENABLED ?? 'true') === 'false') return;
    const timer = setTimeout(() => {
      const limit = Math.max(1, Math.min(10_000, Number(process.env.RECORDING_THUMBNAIL_BACKFILL_LIMIT ?? 2_000)));
      void this.enqueueMissingThumbnails(limit).catch((error) => {
        this.logger.warn(`Falha ao agendar backfill de thumbnails: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 15_000);
    timer.unref();
  }

  onModuleDestroy() {
    if (this.integritySweepTimer) {
      clearInterval(this.integritySweepTimer);
      this.integritySweepTimer = null;
    }
  }

  /**
   * Verifica a integridade de uma AMOSTRA pequena de gravações recentes.
   *
   * O teste (`getRecordingIntegrity`) decodifica o arquivo inteiro — é caro. Por
   * isso a amostra é pequena, SERIALIZADA (um por vez, sem pico de CPU) e o
   * resultado é cacheado, então cada gravação é conferida uma única vez por TTL.
   * Corrupção vira `HEALTH_RECORDING_CORRUPT` na timeline da câmera.
   */
  private async runIntegritySweep() {
    if (this.integritySweepRunning) return;
    this.integritySweepRunning = true;
    try {
      const sampleSize = Math.max(1, Math.min(20, Number(process.env.RECORDING_INTEGRITY_SWEEP_SAMPLE ?? 3)));
      // Gravações fechadas (endedAt != null) das últimas 24h: as recentes são as
      // que ainda podem ser salvas/reprocessadas se algo estiver errado.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const candidates = await this.prisma.recording.findMany({
        where: { endedAt: { not: null }, startedAt: { gte: since } },
        orderBy: { startedAt: 'desc' },
        take: 200,
        select: { id: true, cameraId: true, filePath: true },
      });
      if (!candidates.length) return;

      const cache = this.readDiagnosticsCache();
      const ttlMs = this.getCacheTtlMs();
      const pending = candidates.filter((item) => {
        const entry = cache[item.id];
        const checkedAt = entry?.checkedAt ? new Date(entry.checkedAt).getTime() : 0;
        return !entry?.integrity || Date.now() - checkedAt > ttlMs;
      }).slice(0, sampleSize);
      if (!pending.length) return;

      let corrupt = 0;
      for (const item of pending) {
        try {
          const integrity = await this.getRecordingIntegrity(item.id) as { integrityOk?: boolean; reason?: string | null };
          if (integrity?.integrityOk) continue;
          corrupt += 1;
          this.logger.warn(`Gravação com integridade suspeita: ${item.id} (${integrity?.reason ?? 'motivo desconhecido'})`);
          await this.prisma.cameraEvent.create({
            data: {
              cameraId: item.cameraId,
              type: 'HEALTH_RECORDING_CORRUPT',
              severity: 'ERROR',
              message: 'Gravação com falha de integridade detectada na verificação periódica.',
              metadata: { recordingId: item.id, reason: integrity?.reason ?? null, filePath: item.filePath },
              occurredAt: new Date(),
            },
          }).catch(() => undefined);
        } catch (error) {
          this.logger.warn(`Falha ao verificar integridade de ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.logger.log(`Varredura de integridade: ${pending.length} verificada(s), ${corrupt} com problema.`);
    } catch (error) {
      this.logger.warn(`Varredura de integridade falhou: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.integritySweepRunning = false;
    }
  }

  async ensureRecordingExists(recordingId: string) {
    const recording = await this.prisma.recording.findUnique({ where: { id: recordingId }, include: { camera: true } });
    if (!recording) {
      throw new NotFoundException('Gravação não encontrada.');
    }
    return recording;
  }

  private getDiagnosticsCacheFile() {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const dir = join(recordingsRoot, '.diagnostics-cache');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'recording-health.json');
  }

  private readDiagnosticsCache() {
    const file = this.getDiagnosticsCacheFile();
    if (!existsSync(file)) return {} as Record<string, RecordingHealthCacheEntry>;
    try {
      const raw = readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, RecordingHealthCacheEntry>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {} as Record<string, RecordingHealthCacheEntry>;
    }
  }

  private writeDiagnosticsCache(cache: Record<string, RecordingHealthCacheEntry>) {
    const file = this.getDiagnosticsCacheFile();
    writeFileSync(file, JSON.stringify(cache), 'utf-8');
  }

  private getCacheTtlMs() {
    const ttl = Number(process.env.RECORDING_DIAGNOSTICS_TTL_SECONDS ?? 900);
    return Math.max(60, Number.isFinite(ttl) ? ttl : 900) * 1000;
  }

  async list(query: ListRecordingsQueryDto, accessibleCameraIds?: string[]) {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    let from = query.from ? new Date(query.from) : undefined;
    let to = query.to ? new Date(query.to) : undefined;

    if (query.date && !from && !to) {
      from = new Date(query.date);
      from.setHours(0, 0, 0, 0);
      to = new Date(query.date);
      to.setHours(23, 59, 59, 999);
    }
    // Filtro de câmera. Se veio um cameraId específico ele MANDA (mas só se o
    // usuário tiver acesso a ele); senão restringe às câmeras acessíveis.
    // BUG corrigido: antes os dois filtros usavam a mesma chave `cameraId` num
    // spread e o segundo (acessíveis) SOBRESCREVIA o primeiro (câmera pedida) —
    // p/ usuário não-admin o cameraId era ignorado e vinham gravações de TODAS
    // as câmeras (selecionava a 15 e aparecia a 14).
    const cameraFilter = query.cameraId
      ? accessibleCameraIds && !accessibleCameraIds.includes(query.cameraId)
        ? { cameraId: { in: [] as string[] } } // pediu câmera sem acesso → nada
        : { cameraId: query.cameraId }
      : accessibleCameraIds
        ? { cameraId: { in: accessibleCameraIds } }
        : {};
    const where = {
      ...cameraFilter,
      ...(from || to
        ? {
            startedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const order = query.sort === 'asc' ? 'asc' : 'desc';

    const [items, total] = await Promise.all([
      this.prisma.recording.findMany({ where, orderBy: { startedAt: order }, take: limit, skip: offset }),
      this.prisma.recording.count({ where }),
    ]);

    return {
      items: items.map((item: any) => {
        const absolutePath = ensureFileUnderRoot(recordingsRoot, item.filePath);
        const extension = extname(absolutePath);
        const thumbnailBase = extension ? absolutePath.slice(0, -extension.length) : absolutePath;
        const thumbnailPath = `${thumbnailBase}.thumb.jpg`;
        const fileExists = existsSync(absolutePath);
        const thumbnailExists = existsSync(thumbnailPath) && statSync(thumbnailPath).size > 0;
        const actualSizeBytes = fileExists ? statSync(absolutePath).size : 0;
        // Uma miniatura bem-sucedida também é uma prova barata de que o MP4 é
        // decodificável. Segmentos interrompidos podem ter vários MB, mas não
        // possuem o átomo `moov`; antes eram oferecidos como reproduzíveis e o
        // app acabava numa tela cinza/erro. O backfill continua tentando gerar
        // a miniatura; quando conseguir, o item passa a utilizável sozinho.
        const fileUsable = fileExists && actualSizeBytes > 1024 && thumbnailExists;
        return {
          fileExists,
          fileUsable,
          thumbnailExists,
          actualSizeBytes,
          compatibleCached: existsSync(join(recordingsRoot, '.playback-compatible', item.cameraId, `${item.id}.mp4`)),
          id: item.id,
          cameraId: item.cameraId,
          source: item.source ?? RecordingSource.UNKNOWN,
          triggerMode: item.triggerMode ?? 'unknown',
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          durationSeconds: item.durationSeconds,
          sizeBytes: item.sizeBytes ? item.sizeBytes.toString() : null,
          playUrl: `/recordings/${item.id}/play`,
          compatiblePlayUrl: `/recordings/${item.id}/play?compatible=1`,
          thumbnailUrl: thumbnailExists ? `/recordings/${item.id}/thumbnail` : null,
        };
      }),
      total,
    };
  }

  async streamRecording(recordingId: string, res: Response, options?: { allowAutoCompat?: boolean }) {
    const recording = await this.ensureRecordingExists(recordingId);

    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(filePath)) {
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    // Auto-detect H.265 or incompatible codec and transparently transcode to H.264 for the browser.
    // The compatible file is cached in .playback-compatible/ so the transcoding only happens once.
    // forceDirect (allowAutoCompat=false) pula esta checagem: navegadores com
    // decodificador HEVC pedem o arquivo ORIGINAL explicitamente.
    if (options?.allowAutoCompat !== false) {
      const needsCompat = await this.shouldPreferCompatiblePlayback(recordingId).catch(() => false);
      if (needsCompat) {
        return this.streamRecordingCompatible(recordingId, res);
      }
    }

    const stats = statSync(filePath);
    const fileSize = stats.size;
    const range = res.req.headers.range;

    const extension = extname(filePath).toLowerCase();
    const contentType =
      extension === '.mp4'
        ? 'video/mp4'
        : extension === '.mkv'
          ? 'video/x-matroska'
          : extension === '.ts'
            ? 'video/mp2t'
            : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (!range) {
      res.setHeader('Content-Length', fileSize);
      createReadStream(filePath).pipe(res);
      return;
    }

    const [startText, endText] = range.replace(/bytes=/, '').split('-');
    const start = Number(startText);
    const end = endText ? Number(endText) : fileSize - 1;
    const validStart = Number.isNaN(start) ? 0 : Math.max(0, start);
    const validEnd = Number.isNaN(end) ? fileSize - 1 : Math.min(end, fileSize - 1);

    if (validStart >= fileSize || validStart > validEnd) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${validStart}-${validEnd}/${fileSize}`);
    res.setHeader('Content-Length', validEnd - validStart + 1);
    createReadStream(filePath, { start: validStart, end: validEnd }).pipe(res);
  }

  private async ensureCompatibleFile(recordingId: string) {
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const inputPath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(inputPath)) {
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    const cacheDir = join(recordingsRoot, '.playback-compatible', recording.cameraId);
    mkdirSync(cacheDir, { recursive: true });
    const outputPath = join(cacheDir, `${recording.id}.mp4`);
    if (existsSync(outputPath) && statSync(outputPath).size > 0) {
      return outputPath;
    }

    // Transcode H.265 (or any incompatible codec) → H.264 preserving original resolution and quality.
    // CRF 18 = visually lossless. scale=iw:ih preserves original dimensions from the camera.
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '18',
        '-profile:v',
        'high',
        '-level',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        outputPath,
      ], {
        timeout: 300000,  // 5 min max for large files
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      throw new InternalServerErrorException(error instanceof Error ? error.message : 'Falha ao gerar playback compatível.');
    }

    if (!existsSync(outputPath)) {
      throw new InternalServerErrorException('Falha ao gerar arquivo compatível para playback.');
    }
    return outputPath;
  }

  async streamRecordingCompatible(recordingId: string, res: Response) {
    const filePath = await this.ensureCompatibleFile(recordingId);
    const stats = statSync(filePath);
    const fileSize = stats.size;
    const range = res.req.headers.range;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    if (!range) {
      res.setHeader('Content-Length', fileSize);
      createReadStream(filePath).pipe(res);
      return;
    }

    const [startText, endText] = range.replace(/bytes=/, '').split('-');
    const start = Number(startText);
    const end = endText ? Number(endText) : fileSize - 1;
    const validStart = Number.isNaN(start) ? 0 : Math.max(0, start);
    const validEnd = Number.isNaN(end) ? fileSize - 1 : Math.min(end, fileSize - 1);

    if (validStart >= fileSize || validStart > validEnd) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${validStart}-${validEnd}/${fileSize}`);
    res.setHeader('Content-Length', validEnd - validStart + 1);
    createReadStream(filePath, { start: validStart, end: validEnd }).pipe(res);
  }

  async prepareCompatiblePlayback(recordingId: string) {
    const recording = await this.ensureRecordingExists(recordingId);
    const outputPath = await this.ensureCompatibleFile(recordingId);
    const stats = statSync(outputPath);
    const diagnostics = await this.getRecordingDiagnostics(recordingId, true);

    return {
      recordingId,
      cameraId: recording.cameraId,
      status: 'ready',
      compatibleCached: true,
      compatibleFileName: `${recording.id}.mp4`,
      sizeBytes: stats.size,
      diagnostics,
    };
  }

  async downloadRecording(recordingId: string, res: Response) {
    const recording = await this.ensureRecordingExists(recordingId);

    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(filePath)) {
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    const stats = statSync(filePath);
    const fileSize = stats.size;
    const range = res.req.headers.range;
    res.setHeader('Content-Disposition', `attachment; filename="recording-${recording.id}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    if (!range) {
      res.setHeader('Content-Length', fileSize);
      createReadStream(filePath).pipe(res);
      return;
    }

    const [startText, endText] = range.replace(/bytes=/, '').split('-');
    const start = Number(startText);
    const end = endText ? Number(endText) : fileSize - 1;
    const validStart = Number.isNaN(start) ? 0 : Math.max(0, start);
    const validEnd = Number.isNaN(end) ? fileSize - 1 : Math.min(end, fileSize - 1);

    if (validStart >= fileSize || validStart > validEnd) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${validStart}-${validEnd}/${fileSize}`);
    res.setHeader('Content-Length', validEnd - validStart + 1);
    createReadStream(filePath, { start: validStart, end: validEnd }).pipe(res);
  }

  // Streama um ZIP com várias gravações sem materializar nada em disco/memória.
  // store (sem compressão): vídeo já é comprimido; recomprimir só gastaria CPU.
  async downloadRecordingsZip(recordingIds: string[], res: Response) {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const uniqueIds = [...new Set(recordingIds)].slice(0, 50);

    const entries: Array<{ filePath: string; entryName: string }> = [];
    const usedNames = new Set<string>();
    for (const id of uniqueIds) {
      const recording = await this.ensureRecordingExists(id);
      const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
      if (!existsSync(filePath) || statSync(filePath).size === 0) continue;
      const cameraLabel = (recording.camera?.name || 'camera')
        .replace(/[^\p{L}\p{N}_-]+/gu, '-')
        .replace(/^-+|-+$/g, '') || 'camera';
      const startedAt = new Date(recording.startedAt);
      const stamp = Number.isNaN(startedAt.getTime())
        ? recording.id.slice(0, 8)
        : startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const extension = extname(filePath) || '.mp4';
      let entryName = `${cameraLabel}-${stamp}${extension}`;
      let suffix = 1;
      while (usedNames.has(entryName)) {
        suffix += 1;
        entryName = `${cameraLabel}-${stamp}-${suffix}${extension}`;
      }
      usedNames.add(entryName);
      entries.push({ filePath, entryName });
    }

    if (!entries.length) {
      throw new NotFoundException('Nenhuma das gravações selecionadas possui arquivo disponível no disco.');
    }

    const zipDate = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="gravacoes-${zipDate}.zip"`);

    const archive = archiver('zip', { store: true });
    archive.on('warning', (warning) => {
      this.logger.warn(`Aviso ao gerar ZIP de gravações: ${warning.message}`);
    });
    archive.on('error', (error) => {
      this.logger.error(`Falha ao gerar ZIP de gravações: ${error.message}`);
      res.destroy(error);
    });
    // Cliente cancelou o download: interrompe a leitura dos arquivos.
    res.on('close', () => {
      if (!res.writableEnded) archive.destroy();
    });
    archive.pipe(res);
    for (const entry of entries) {
      archive.file(entry.filePath, { name: entry.entryName });
    }
    await archive.finalize();
    return { files: entries.length };
  }

  async registerInternal(dto: RegisterRecordingDto) {
    const recording = await this.prisma.recording.create({
      data: {
        cameraId: dto.cameraId,
        source: RecordingSource.WORKER,
        triggerMode: 'unknown',
        filePath: dto.filePath,
        startedAt: new Date(dto.startedAt),
        endedAt: new Date(dto.endedAt),
        durationSeconds: dto.durationSeconds,
        sizeBytes: dto.sizeBytes,
      },
    });
    await this.enqueueThumbnailGeneration(recording.id, false);
    return recording;
  }

  async enqueueThumbnailGeneration(recordingId: string, force: boolean) {
    await this.thumbnailQueue.add(
      'generate-thumbnail',
      { recordingId },
      {
        jobId: force ? `thumb-${recordingId}-${Date.now()}` : `thumb-${recordingId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );
    return { status: 'thumbnail_generation_queued', recordingId };
  }

  async enqueueMissingThumbnails(limit = 2_000) {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const jobs: Array<{ name: string; data: { recordingId: string }; opts: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    let scanned = 0;
    const retryBucket = new Date().toISOString().slice(0, 10);

    while (jobs.length < boundedLimit) {
      const batch = await this.prisma.recording.findMany({
        orderBy: { id: 'asc' },
        take: 250,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, filePath: true },
      });
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;
      scanned += batch.length;

      for (const recording of batch) {
        const inputPath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
        if (!existsSync(inputPath)) continue;
        const extension = extname(inputPath);
        const thumbnailBase = extension ? inputPath.slice(0, -extension.length) : inputPath;
        const thumbPath = `${thumbnailBase}.thumb.jpg`;
        if (existsSync(`${inputPath}.invalid.json`)) continue;
        if (existsSync(thumbPath) && statSync(thumbPath).size > 0) continue;
        jobs.push({
          name: 'generate-thumbnail',
          data: { recordingId: recording.id },
          opts: {
            // Um job definitivamente falho permanece no BullMQ para diagnóstico.
            // O bucket diário permite que o backfill tente novamente no dia
            // seguinte sem criar duplicatas a cada inicialização da API.
            jobId: `thumb-backfill-${recording.id}-${retryBucket}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: true,
            removeOnFail: 200,
            priority: 10,
          },
        });
        if (jobs.length >= boundedLimit) break;
      }
      if (batch.length < 250) break;
    }

    for (let index = 0; index < jobs.length; index += 100) {
      await this.thumbnailQueue.addBulk(jobs.slice(index, index + 100) as any);
    }
    if (jobs.length) {
      this.logger.log(`Backfill de thumbnails: ${jobs.length} job(s) agendado(s), ${scanned} gravação(ões) inspecionada(s).`);
    }
    return { scanned, queued: jobs.length, limit: boundedLimit };
  }

  private async probeFileMetadata(filePath: string) {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size',
      '-of',
      'json',
      filePath,
    ], {
      timeout: Math.max(5_000, Number(process.env.RECORDING_METADATA_PROBE_TIMEOUT_MS ?? 15_000)),
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout || '{}') as { format?: { duration?: string; size?: string } };
    const duration = Number(parsed.format?.duration);
    const probedSize = Number(parsed.format?.size);
    return {
      durationSecondsExact: Number.isFinite(duration) && duration > 0 ? duration : null,
      sizeBytes: Number.isFinite(probedSize) && probedSize >= 0 ? probedSize : statSync(filePath).size,
    };
  }

  async reconcileRecordingMetadata(limit = 2_000) {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const records = await this.prisma.recording.findMany({
      orderBy: { startedAt: 'desc' },
      take: boundedLimit,
      select: {
        id: true,
        filePath: true,
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        sizeBytes: true,
      },
    });
    const result = { scanned: records.length, updated: 0, missing: 0, probeFailed: 0 };
    let nextIndex = 0;
    const concurrency = Math.max(1, Math.min(4, Number(process.env.RECORDING_METADATA_RECONCILE_CONCURRENCY ?? 2)));

    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        const recording = records[index];
        if (!recording) return;
        const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
        if (!existsSync(filePath)) {
          result.missing += 1;
          continue;
        }
        try {
          const metadata = await this.probeFileMetadata(filePath);
          if (metadata.durationSecondsExact == null) {
            result.probeFailed += 1;
            continue;
          }
          const durationSeconds = Math.max(1, Math.round(metadata.durationSecondsExact));
          const endedAt = new Date(recording.startedAt.getTime() + metadata.durationSecondsExact * 1000);
          const currentSize = Number(recording.sizeBytes ?? 0n);
          const endedDiffMs = Math.abs((recording.endedAt?.getTime() ?? 0) - endedAt.getTime());
          if (currentSize === metadata.sizeBytes && recording.durationSeconds === durationSeconds && endedDiffMs < 1_000) continue;
          await this.prisma.recording.update({
            where: { id: recording.id },
            data: { sizeBytes: BigInt(metadata.sizeBytes), durationSeconds, endedAt },
          });
          result.updated += 1;
        } catch {
          result.probeFailed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    this.logger.log(
      `Reconciliação de gravações: scanned=${result.scanned} updated=${result.updated} missing=${result.missing} probeFailed=${result.probeFailed}.`,
    );
    return result;
  }

  /**
   * `recordings:check` — reconciliação bidirecional DB↔disco (moonfire `check.rs` /
   * ZoneMinder `zmaudit.pl`). Coleta os paths que o Postgres conhece e os que
   * existem no disco e usa o helper PURO `reconcileRecordingPaths` para apontar:
   *  - `orfaosNoDisco`: arquivos no disco SEM registro (recuperáveis — a varredura
   *    de órfãos do process-manager os readota);
   *  - `orfaosNoDb`: registros cujo arquivo sumiu (linha aponta p/ nada).
   * Apenas RELATA (não apaga nem cria nada): a decisão de agir é do operador.
   */
  async checkRecordingIntegrity(limit = 100_000): Promise<RecordingReconciliation & { dbCount: number; diskCount: number }> {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const boundedLimit = Math.max(1, Math.min(1_000_000, Math.floor(limit)));

    const records = await this.prisma.recording.findMany({
      orderBy: { startedAt: 'desc' },
      take: boundedLimit,
      select: { filePath: true },
    });
    const dbPaths: string[] = [];
    for (const record of records) {
      try {
        dbPaths.push(ensureFileUnderRoot(recordingsRoot, record.filePath));
      } catch {
        // Path fora da raiz (dado legado/corrompido): trata como está, sem quebrar
        // — ele nunca casará com o disco e vira `orfaosNoDb`, que é o esperado.
        dbPaths.push(record.filePath);
      }
    }

    const diskPaths = listRecordingFilesOnDisk(recordingsRoot);
    const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(dbPaths, diskPaths);

    this.logger.log(
      `recordings:check — db=${dbPaths.length} disco=${diskPaths.length} órfãosNoDisco=${orfaosNoDisco.length} órfãosNoDb=${orfaosNoDb.length}.`,
    );
    return { orfaosNoDisco, orfaosNoDb, dbCount: dbPaths.length, diskCount: diskPaths.length };
  }

  async streamThumbnail(recordingId: string, res: Response) {
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    const extension = extname(filePath);
    const thumbnailBase = extension ? filePath.slice(0, -extension.length) : filePath;
    const thumbPath = `${thumbnailBase}.thumb.jpg`;
    await this.ensureThumbnailGenerated(recording.id, filePath, thumbPath, recording.durationSeconds);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Length', String(statSync(thumbPath).size));
    createReadStream(thumbPath).pipe(res);
  }

  private async acquireThumbnailGenerationSlot() {
    if (this.thumbnailGenerationActive < this.thumbnailGenerationConcurrency) {
      this.thumbnailGenerationActive += 1;
      return;
    }
    await new Promise<void>((resolve) => this.thumbnailGenerationWaiters.push(resolve));
    this.thumbnailGenerationActive += 1;
  }

  private releaseThumbnailGenerationSlot() {
    this.thumbnailGenerationActive = Math.max(0, this.thumbnailGenerationActive - 1);
    this.thumbnailGenerationWaiters.shift()?.();
  }

  private async ensureThumbnailGenerated(
    recordingId: string,
    inputPath: string,
    outputPath: string,
    durationSeconds: number | null,
  ) {
    if (existsSync(outputPath) && statSync(outputPath).size > 0) return;
    if (!existsSync(inputPath)) {
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    const current = this.thumbnailGenerationInFlight.get(recordingId);
    if (current) return current;

    const generation = (async () => {
      await this.acquireThumbnailGenerationSlot();
      try {
        if (existsSync(outputPath) && statSync(outputPath).size > 0) return;
        const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.jpg`;
        const configuredSecond = Math.max(0, Number(process.env.RECORDING_THUMBNAIL_SECOND ?? 2));
        const maximumSecond = Math.max(0, (durationSeconds ?? 10) - 0.25);
        const seekSeconds = Math.min(configuredSecond, maximumSecond);
        let lastError: unknown = null;
        try {
          for (const second of [...new Set([seekSeconds, 0])]) {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            try {
              await execFileAsync(
                'ffmpeg',
                [
                  '-hide_banner',
                  '-loglevel',
                  'error',
                  '-ss',
                  String(second),
                  '-i',
                  inputPath,
                  '-frames:v',
                  '1',
                  '-vf',
                  'scale=640:-2',
                  '-q:v',
                  '3',
                  '-y',
                  temporaryPath,
                ],
                { timeout: 15_000, maxBuffer: 1024 * 1024 },
              );
              const generated = await stat(temporaryPath);
              if (generated.size <= 0) throw new Error('FFmpeg não produziu uma imagem válida.');
              await rename(temporaryPath, outputPath);
              break;
            } catch (error) {
              lastError = error;
            }
          }
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
        if (!existsSync(outputPath) || statSync(outputPath).size <= 0) {
          throw lastError instanceof Error ? lastError : new Error('FFmpeg não produziu uma imagem válida.');
        }
      } catch (error) {
        throw new InternalServerErrorException(
          error instanceof Error ? `Falha ao gerar thumbnail: ${error.message}` : 'Falha ao gerar thumbnail.',
        );
      } finally {
        this.releaseThumbnailGenerationSlot();
      }
    })();

    this.thumbnailGenerationInFlight.set(recordingId, generation);
    try {
      await generation;
    } finally {
      this.thumbnailGenerationInFlight.delete(recordingId);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 2.9 — Sprite de scrubbing da timeline.
  // Gera (sob demanda, cacheado ao lado do MP4) um único mosaico low-res com 1
  // frame a cada N s. O front usa o sprite + o plano (grid/intervalo) para
  // varrer horas de vídeo sem baixar o vídeo nem decodificar em JS.
  // ───────────────────────────────────────────────────────────────────────
  private buildTimelinePreviewPlan(durationSeconds: number | null | undefined): TimelinePreviewPlan {
    const tileWidth = Math.max(16, Number(process.env.RECORDING_PREVIEW_TILE_WIDTH ?? 160));
    const maxTiles = Math.max(1, Number(process.env.RECORDING_PREVIEW_MAX_TILES ?? 120));
    return planTimelinePreview({ durationSeconds, tileWidth, maxTiles });
  }

  async getTimelinePreviewMeta(recordingId: string) {
    const recording = await this.ensureRecordingExists(recordingId);
    const plan = this.buildTimelinePreviewPlan(recording.durationSeconds);
    return {
      recordingId,
      durationSeconds: recording.durationSeconds ?? null,
      spriteUrl: `/recordings/${recordingId}/preview-sprite`,
      intervalSeconds: plan.intervalSeconds,
      frameCount: plan.frameCount,
      columns: plan.columns,
      rows: plan.rows,
      tileWidth: plan.tileWidth,
      tileHeight: plan.tileHeight,
    };
  }

  async streamTimelinePreview(recordingId: string, res: Response) {
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    const spritePath = ensureFileUnderRoot(recordingsRoot, buildTimelinePreviewPath(recording.filePath));
    const plan = this.buildTimelinePreviewPlan(recording.durationSeconds);
    await this.ensureTimelinePreviewGenerated(recording.id, filePath, spritePath, plan);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Length', String(statSync(spritePath).size));
    createReadStream(spritePath).pipe(res);
  }

  private async ensureTimelinePreviewGenerated(
    recordingId: string,
    inputPath: string,
    outputPath: string,
    plan: TimelinePreviewPlan,
  ) {
    if (existsSync(outputPath) && statSync(outputPath).size > 0) return;
    if (!existsSync(inputPath)) {
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    const current = this.timelinePreviewInFlight.get(recordingId);
    if (current) return current;

    const generation = (async () => {
      // Reusa o mesmo pool de slots do thumbnail: ambos são passes ffmpeg e não
      // devem competir sem limite pela CPU do host.
      await this.acquireThumbnailGenerationSlot();
      try {
        if (existsSync(outputPath) && statSync(outputPath).size > 0) return;
        const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.jpg`;
        try {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          await execFileAsync(
            'ffmpeg',
            buildTimelinePreviewArgs(inputPath, temporaryPath, plan),
            { timeout: 60_000, maxBuffer: 1024 * 1024 },
          );
          const generated = await stat(temporaryPath);
          if (generated.size <= 0) throw new Error('FFmpeg não produziu um sprite válido.');
          await rename(temporaryPath, outputPath);
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
        if (!existsSync(outputPath) || statSync(outputPath).size <= 0) {
          throw new Error('FFmpeg não produziu um sprite válido.');
        }
      } catch (error) {
        throw new InternalServerErrorException(
          error instanceof Error
            ? `Falha ao gerar sprite de preview: ${sanitizeSensitiveText(error.message)}`
            : 'Falha ao gerar sprite de preview.',
        );
      } finally {
        this.releaseThumbnailGenerationSlot();
      }
    })();

    this.timelinePreviewInFlight.set(recordingId, generation);
    try {
      await generation;
    } finally {
      this.timelinePreviewInFlight.delete(recordingId);
    }
  }

  async getRecordingDiagnostics(recordingId: string, force = false) {
    if (!force) {
      const cache = this.readDiagnosticsCache();
      const entry = cache[recordingId];
      const checkedAt = entry?.checkedAt ? new Date(entry.checkedAt).getTime() : 0;
      if (entry?.diagnostics && checkedAt > 0 && Date.now() - checkedAt <= this.getCacheTtlMs()) {
        return entry.diagnostics;
      }
    }
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    const fileExists = existsSync(filePath);
    if (!fileExists) {
      const result = {
        recordingId,
        fileExists: false,
        playableLikely: false,
        reason: 'file_missing',
      };
      const cache = this.readDiagnosticsCache();
      cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), diagnostics: result };
      this.writeDiagnosticsCache(cache);
      return result;
    }

    const fileSize = statSync(filePath).size;
    if (fileSize <= 0) {
      const result = {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        playableLikely: false,
        reason: 'empty_file',
      };
      const cache = this.readDiagnosticsCache();
      cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), diagnostics: result };
      this.writeDiagnosticsCache(cache);
      return result;
    }

    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=index,codec_type,codec_name,avg_frame_rate,width,height,sample_rate,channels:format=format_name,duration,bit_rate',
        '-of',
        'json',
        filePath,
      ]);
      const parsed = JSON.parse(stdout || '{}') as {
        streams?: Array<Record<string, unknown>>;
        format?: Record<string, unknown>;
      };
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      const video = streams.find((s) => String(s.codec_type ?? '') === 'video') ?? null;
      const audio = streams.find((s) => String(s.codec_type ?? '') === 'audio') ?? null;
      const vcodec = video ? String(video.codec_name ?? '') : '';
      const acodec = audio ? String(audio.codec_name ?? '') : '';
      const formatName = String(parsed.format?.format_name ?? '');
      const compatibleVideo = ['h264', 'vp8', 'vp9', 'av1'].includes(vcodec.toLowerCase());
      const compatibleAudio = !audio || ['aac', 'mp3', 'opus', 'vorbis'].includes(acodec.toLowerCase());
      const formatLower = formatName.toLowerCase();
      const fragmentedLikely = formatLower.includes('mov') || formatLower.includes('mp4');
      const compatibleRecommended = !Boolean(video) || !compatibleVideo || !compatibleAudio;
      const playableLikely = Boolean(video) && compatibleVideo && compatibleAudio;
      const hasAudioStream = Boolean(audio);
      const audioPlayableLikely = !audio || compatibleAudio;

      const result = {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        playableLikely,
        compatibleRecommended,
        hasAudioStream,
        audioPlayableLikely,
        compatibleCached: existsSync(join(recordingsRoot, '.playback-compatible', recording.cameraId, `${recording.id}.mp4`)),
        fragmentedLikely,
        reason: playableLikely ? null : (!video ? 'missing_video_stream' : !compatibleVideo ? `video_codec_${vcodec || 'unknown'}_may_fail` : `audio_codec_${acodec || 'unknown'}_may_fail`),
        format: formatName || null,
        durationSeconds: Number(parsed.format?.duration ?? 0) || null,
        bitRate: Number(parsed.format?.bit_rate ?? 0) || null,
        video: video
          ? {
              codec: vcodec || null,
              width: Number(video.width ?? 0) || null,
              height: Number(video.height ?? 0) || null,
              avgFrameRate: String(video.avg_frame_rate ?? '') || null,
            }
          : null,
        audio: audio
          ? {
              codec: acodec || null,
              channels: Number(audio.channels ?? 0) || null,
              sampleRate: Number(audio.sample_rate ?? 0) || null,
            }
          : null,
      };
      const cache = this.readDiagnosticsCache();
      cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), diagnostics: result };
      this.writeDiagnosticsCache(cache);
      return result;
    } catch (error) {
      const result = {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        playableLikely: false,
        reason: error instanceof Error ? error.message : 'ffprobe_failed',
      };
      const cache = this.readDiagnosticsCache();
      cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), diagnostics: result };
      this.writeDiagnosticsCache(cache);
      return result;
    }
  }

  async shouldPreferCompatiblePlayback(recordingId: string) {
    const recording = await this.ensureRecordingExists(recordingId);
    const extension = extname(recording.filePath).toLowerCase();
    if (extension && extension !== '.mp4') {
      return true;
    }
    const diagnostics = await this.getRecordingDiagnostics(recordingId);
    return Boolean((diagnostics as { compatibleRecommended?: boolean }).compatibleRecommended);
  }

  async getRecordingIntegrity(recordingId: string, force = false) {
    if (!force) {
      const cache = this.readDiagnosticsCache();
      const entry = cache[recordingId];
      const checkedAt = entry?.checkedAt ? new Date(entry.checkedAt).getTime() : 0;
      if (entry?.integrity && checkedAt > 0 && Date.now() - checkedAt <= this.getCacheTtlMs()) {
        return entry.integrity;
      }
    }
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(filePath)) {
      const result = {
        recordingId,
        fileExists: false,
        integrityOk: false,
        reason: 'file_missing',
        checkedAt: new Date().toISOString(),
      };
      const cache = this.readDiagnosticsCache();
      cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), integrity: result };
      this.writeDiagnosticsCache(cache);
      return result;
    }

    const fileSize = statSync(filePath).size;
    if (fileSize <= 1024) {
      const result = {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        integrityOk: false,
        reason: 'file_too_small',
        checkedAt: new Date().toISOString(),
      };
      const cache = this.readDiagnosticsCache();
      cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), integrity: result };
      this.writeDiagnosticsCache(cache);
      return result;
    }

    try {
      await execFileAsync('ffmpeg', [
        '-v',
        'error',
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-f',
        'null',
        '-',
      ], { timeout: 45000, maxBuffer: 1024 * 1024 });
      const result = {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        integrityOk: true,
        reason: null,
        checkedAt: new Date().toISOString(),
      };
      const cache = this.readDiagnosticsCache();
      cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), integrity: result };
      this.writeDiagnosticsCache(cache);
      return result;
    } catch (error: any) {
      const stderr = typeof error?.stderr === 'string' ? sanitizeSensitiveText(error.stderr.trim()) : '';
      const result = {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        integrityOk: false,
        reason: stderr || sanitizeSensitiveText(error?.message) || 'ffmpeg_integrity_check_failed',
        checkedAt: new Date().toISOString(),
      };
      const cache = this.readDiagnosticsCache();
      cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), integrity: result };
      this.writeDiagnosticsCache(cache);
      return result;
    }
  }

  async getRecordingDiagnosticsBulk(recordingIds: string[], includeIntegrity = false) {
    const uniqueIds = [...new Set(recordingIds)].slice(0, 120);
    const items: Array<Record<string, unknown>> = [];
    for (const id of uniqueIds) {
      const diagnostics = await this.getRecordingDiagnostics(id);
      if (includeIntegrity) {
        const integrity = await this.getRecordingIntegrity(id);
        items.push({ recordingId: id, diagnostics, integrity });
      } else {
        items.push({ recordingId: id, diagnostics });
      }
    }
    return {
      items,
      totalRequested: uniqueIds.length,
    };
  }

  async getRecordingHealthSummary(params: { date?: string; cameraId?: string; accessibleCameraIds?: string[]; brokenAlertThreshold?: number }) {
    const selected = params.date ? new Date(params.date) : new Date();
    selected.setHours(0, 0, 0, 0);
    const from = new Date(selected);
    const to = new Date(selected);
    to.setHours(23, 59, 59, 999);
    const where = {
      ...(params.cameraId ? { cameraId: params.cameraId } : {}),
      ...(params.accessibleCameraIds ? { cameraId: { in: params.accessibleCameraIds } } : {}),
      startedAt: { gte: from, lte: to },
    };

    const records = await this.prisma.recording.findMany({
      where,
      select: { id: true, cameraId: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
      take: 1200,
    });

    const byCamera = new Map<string, {
      cameraId: string;
      total: number;
      broken: number;
      tooSmall: number;
      compatibleRecommended: number;
      directLikely: number;
      withAudio: number;
      lastRecordingAt: string | null;
      lastRecordingAgeSeconds: number | null;
    }>();
    const minExpectedBytes = Math.max(32 * 1024, Number(process.env.RECORDING_MIN_EXPECTED_FILE_BYTES ?? 128 * 1024));

    for (const record of records) {
      const diagnostics = await this.getRecordingDiagnostics(record.id, false) as any;
      const current = byCamera.get(record.cameraId) ?? {
        cameraId: record.cameraId,
        total: 0,
        broken: 0,
        tooSmall: 0,
        compatibleRecommended: 0,
        directLikely: 0,
        withAudio: 0,
        lastRecordingAt: null,
        lastRecordingAgeSeconds: null,
      };
      current.total += 1;
      current.lastRecordingAt = record.startedAt.toISOString();
      current.lastRecordingAgeSeconds = Math.max(0, Math.floor((Date.now() - record.startedAt.getTime()) / 1000));
      const fileSize = Number(diagnostics.fileSizeBytes ?? 0);
      if (fileSize > 0 && fileSize < minExpectedBytes) current.tooSmall += 1;
      if (!diagnostics.fileExists || diagnostics.reason === 'file_missing' || diagnostics.reason === 'empty_file') {
        current.broken += 1;
      } else if (diagnostics.compatibleRecommended) {
        current.compatibleRecommended += 1;
      } else {
        current.directLikely += 1;
      }
      if (diagnostics.hasAudioStream) current.withAudio += 1;
      byCamera.set(record.cameraId, current);
    }

    const threshold = Math.max(1, Math.floor(params.brokenAlertThreshold ?? 3));
    const items = Array.from(byCamera.values()).map((item) => {
      const degradedRatio = item.total > 0 ? (item.broken + item.compatibleRecommended) / item.total : 0;
      const needsAttention =
        item.broken >= threshold ||
        degradedRatio >= 0.5 ||
        item.tooSmall >= threshold ||
        (item.lastRecordingAgeSeconds != null && item.lastRecordingAgeSeconds > 30 * 60);
      let alertReason: string | null = null;
      if (item.broken >= threshold) alertReason = `falhas=${item.broken} (limiar=${threshold})`;
      else if (item.tooSmall >= threshold) alertReason = `arquivos pequenos=${item.tooSmall} (mín ${Math.round(minExpectedBytes / 1024)}KB)`;
      else if (item.lastRecordingAgeSeconds != null && item.lastRecordingAgeSeconds > 30 * 60) alertReason = `último segmento atrasado (${Math.floor(item.lastRecordingAgeSeconds / 60)} min)`;
      else if (degradedRatio >= 0.5) alertReason = 'alta taxa de segmentos degradados';
      return {
        ...item,
        needsAttention,
        alertReason,
      };
    }).sort((a, b) => {
      const riskA = a.broken * 4 + a.compatibleRecommended;
      const riskB = b.broken * 4 + b.compatibleRecommended;
      return riskB - riskA;
    });

    return {
      date: from.toISOString(),
      totalRecordings: records.length,
      brokenAlertThreshold: threshold,
      minExpectedFileBytes: minExpectedBytes,
      camerasNeedingAttention: items.filter((item) => item.needsAttention).length,
      cameras: items,
    };
  }

  async getRecordingGapsReport(params: { date?: string; cameraId: string; accessibleCameraIds?: string[] }) {
    const selected = params.date ? new Date(params.date) : new Date();
    selected.setHours(0, 0, 0, 0);
    const dayStart = new Date(selected);
    const dayEnd = new Date(selected);
    dayEnd.setHours(23, 59, 59, 999);

    if (params.accessibleCameraIds && !params.accessibleCameraIds.includes(params.cameraId)) {
      throw new NotFoundException('Câmera não encontrada para este usuário.');
    }

    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const records = await this.prisma.recording.findMany({
      where: {
        cameraId: params.cameraId,
        startedAt: { gte: dayStart, lte: dayEnd },
      },
      select: {
        id: true,
        filePath: true,
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
      },
      orderBy: { startedAt: 'asc' },
      take: 2000,
    });

    const usableSegments = records
      .map((record) => {
        const fileExists = existsSync(ensureFileUnderRoot(recordingsRoot, record.filePath));
        if (!fileExists) return null;
        const startMs = record.startedAt.getTime();
        const endMs = record.endedAt?.getTime()
          ?? (record.durationSeconds ? startMs + record.durationSeconds * 1000 : startMs);
        if (endMs <= startMs) return null;
        return { startMs, endMs };
      })
      .filter((item): item is { startMs: number; endMs: number } => Boolean(item))
      .sort((a, b) => a.startMs - b.startMs);

    const merged: Array<{ startMs: number; endMs: number }> = [];
    for (const segment of usableSegments) {
      const last = merged[merged.length - 1];
      if (!last || segment.startMs > last.endMs) {
        merged.push({ ...segment });
      } else {
        last.endMs = Math.max(last.endMs, segment.endMs);
      }
    }

    const gaps: Array<{ startAt: string; endAt: string; durationSeconds: number }> = [];
    let cursor = dayStart.getTime();
    for (const segment of merged) {
      if (segment.startMs > cursor) {
        const durationSeconds = Math.floor((segment.startMs - cursor) / 1000);
        if (durationSeconds > 0) {
          gaps.push({
            startAt: new Date(cursor).toISOString(),
            endAt: new Date(segment.startMs).toISOString(),
            durationSeconds,
          });
        }
      }
      cursor = Math.max(cursor, segment.endMs);
    }
    if (cursor < dayEnd.getTime()) {
      const durationSeconds = Math.floor((dayEnd.getTime() - cursor) / 1000);
      if (durationSeconds > 0) {
        gaps.push({
          startAt: new Date(cursor).toISOString(),
          endAt: new Date(dayEnd.getTime()).toISOString(),
          durationSeconds,
        });
      }
    }

    const totalGapSeconds = gaps.reduce((sum, item) => sum + item.durationSeconds, 0);
    return {
      date: dayStart.toISOString(),
      cameraId: params.cameraId,
      totalSegments: records.length,
      usableSegments: merged.length,
      totalGaps: gaps.length,
      totalGapSeconds,
      gaps: gaps.slice(0, 240),
    };
  }

  async getPlaybackReadinessReport(params: { date?: string; cameraId: string; accessibleCameraIds?: string[] }) {
    const selected = params.date ? new Date(params.date) : new Date();
    selected.setHours(0, 0, 0, 0);
    const from = new Date(selected);
    const to = new Date(selected);
    to.setHours(23, 59, 59, 999);

    if (params.accessibleCameraIds && !params.accessibleCameraIds.includes(params.cameraId)) {
      throw new NotFoundException('Câmera não encontrada para este usuário.');
    }

    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const records = await this.prisma.recording.findMany({
      where: {
        cameraId: params.cameraId,
        startedAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        source: true,
        filePath: true,
      },
      orderBy: { startedAt: 'asc' },
      take: 2000,
    });

    let existingFiles = 0;
    let usableFiles = 0;
    let missingFiles = 0;
    let workerRecords = 0;
    let workerUsableFiles = 0;

    for (const record of records) {
      if (record.source === RecordingSource.WORKER) workerRecords += 1;
      const absolutePath = ensureFileUnderRoot(recordingsRoot, record.filePath);
      const fileExists = existsSync(absolutePath);
      if (!fileExists) {
        missingFiles += 1;
        continue;
      }
      existingFiles += 1;
      const size = statSync(absolutePath).size;
      const usable = size > 1024;
      if (usable) {
        usableFiles += 1;
        if (record.source === RecordingSource.WORKER) workerUsableFiles += 1;
      }
    }

    const gaps = await this.getRecordingGapsReport({
      date: from.toISOString(),
      cameraId: params.cameraId,
      accessibleCameraIds: params.accessibleCameraIds,
    });

    const passPlaybackFindsFiles = usableFiles > 0;
    const passWorkerPlaybackFindsFiles = workerRecords === 0 ? null : workerUsableFiles > 0;

    return {
      date: from.toISOString(),
      cameraId: params.cameraId,
      totals: {
        records: records.length,
        existingFiles,
        usableFiles,
        missingFiles,
      },
      source: {
        workerRecords,
        workerUsableFiles,
      },
      gaps: {
        totalGaps: gaps.totalGaps,
        totalGapSeconds: gaps.totalGapSeconds,
      },
      criteria: {
        passPlaybackFindsFiles,
        passWorkerPlaybackFindsFiles,
      },
    };
  }

  async getStorageUsageAnalytics(params: {
    from?: string;
    to?: string;
    cameraId?: string;
    accessibleCameraIds?: string[];
  }) {
    const from = params.from ? new Date(params.from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = params.to ? new Date(params.to) : new Date();
    const cameraIds = params.cameraId ? [params.cameraId] : params.accessibleCameraIds;
    const cameraWhere = cameraIds && cameraIds.length ? { in: cameraIds } : undefined;

    const [recordings, clips, cameras] = await Promise.all([
      this.prisma.recording.findMany({
        where: {
          startedAt: { gte: from, lte: to },
          ...(cameraWhere ? { cameraId: cameraWhere } : {}),
        },
        select: {
          cameraId: true,
          startedAt: true,
          sizeBytes: true,
        },
        take: 100000,
      }),
      this.prisma.exportedClip.findMany({
        where: {
          startedAt: { gte: from, lte: to },
          ...(cameraWhere ? { cameraId: cameraWhere } : {}),
        },
        select: {
          cameraId: true,
          startedAt: true,
          sizeBytes: true,
        },
        take: 100000,
      }),
      this.prisma.camera.findMany({
        where: cameraWhere ? { id: cameraWhere } : {},
        select: { id: true, name: true },
      }),
    ]);

    const cameraNameById = new Map(cameras.map((camera) => [camera.id, camera.name]));
    const dayKey = (date: Date) => date.toISOString().slice(0, 10);
    const bucket = new Map<
      string,
      {
        cameraId: string;
        cameraName: string;
        day: string;
        recordingsBytes: bigint;
        clipsBytes: bigint;
        recordingsCount: number;
        clipsCount: number;
      }
    >();

    const ensure = (cameraId: string, day: string) => {
      const key = `${cameraId}::${day}`;
      const current = bucket.get(key);
      if (current) return current;
      const created = {
        cameraId,
        cameraName: cameraNameById.get(cameraId) ?? cameraId,
        day,
        recordingsBytes: BigInt(0),
        clipsBytes: BigInt(0),
        recordingsCount: 0,
        clipsCount: 0,
      };
      bucket.set(key, created);
      return created;
    };

    for (const recording of recordings) {
      const row = ensure(recording.cameraId, dayKey(recording.startedAt));
      row.recordingsCount += 1;
      row.recordingsBytes += BigInt(recording.sizeBytes ?? BigInt(0));
    }

    for (const clip of clips) {
      const row = ensure(clip.cameraId, dayKey(clip.startedAt));
      row.clipsCount += 1;
      row.clipsBytes += BigInt(clip.sizeBytes ?? BigInt(0));
    }

    const items = [...bucket.values()]
      .map((row) => ({
        cameraId: row.cameraId,
        cameraName: row.cameraName,
        day: row.day,
        recordingsCount: row.recordingsCount,
        clipsCount: row.clipsCount,
        recordingsBytes: row.recordingsBytes.toString(),
        clipsBytes: row.clipsBytes.toString(),
        totalBytes: (row.recordingsBytes + row.clipsBytes).toString(),
      }))
      .sort((a, b) => (a.day === b.day ? a.cameraName.localeCompare(b.cameraName) : a.day < b.day ? 1 : -1));

    const totalRecordingsBytes = items.reduce((acc, item) => acc + BigInt(item.recordingsBytes), BigInt(0));
    const totalClipsBytes = items.reduce((acc, item) => acc + BigInt(item.clipsBytes), BigInt(0));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      cameraId: params.cameraId ?? null,
      summary: {
        rows: items.length,
        totalRecordingsBytes: totalRecordingsBytes.toString(),
        totalClipsBytes: totalClipsBytes.toString(),
        totalBytes: (totalRecordingsBytes + totalClipsBytes).toString(),
      },
      items,
    };
  }

  async streamSnapshotFrame(recordingId: string, seconds: number, res: Response) {
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(filePath)) {
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    try {
      const { stdout } = await execFileAsync('ffmpeg', [
        '-v',
        'error',
        '-ss',
        String(safeSeconds),
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ], { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 30000 });

      if (!stdout || stdout.length === 0) {
        throw new InternalServerErrorException('FFmpeg não retornou imagem para este frame.');
      }

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Disposition', `attachment; filename="snapshot-${recording.id}-${safeSeconds}s.jpg"`);
      res.end(stdout);
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      throw new InternalServerErrorException(error instanceof Error ? error.message : 'Falha ao gerar snapshot do frame.');
    }
  }

  async ensureExportedClipExists(clipId: string) {
    const clip = await this.prisma.exportedClip.findUnique({
      where: { id: clipId },
      include: { camera: true, sourceRecording: true },
    });
    if (!clip) {
      throw new NotFoundException('Clip exportado não encontrado.');
    }
    return clip;
  }

  private async runClipExport(inputPath: string, outputPath: string, startSeconds: number, durationSeconds: number) {
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        String(startSeconds),
        '-i',
        inputPath,
        '-t',
        String(durationSeconds),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outputPath,
      ]);
      return;
    } catch {
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-ss',
          String(startSeconds),
          '-i',
          inputPath,
          '-t',
          String(durationSeconds),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          outputPath,
        ]);
        return;
      } catch (error) {
        throw new InternalServerErrorException(error instanceof Error ? error.message : 'Falha ao exportar clip.');
      }
    }
  }

  private async transcodeClipForCompatibility(inputPath: string, outputPath: string, startSeconds: number, durationSeconds: number) {
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        String(startSeconds),
        '-i',
        inputPath,
        '-t',
        String(durationSeconds),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        outputPath,
      ]);
    } catch (error) {
      throw new InternalServerErrorException(error instanceof Error ? error.message : 'Falha ao transcodificar clip compatível.');
    }
  }

  private async inspectClipExternalPlayback(filePath: string) {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout || '{}') as {
        format?: { format_name?: string; duration?: string };
        streams?: Array<{ codec_type?: string; codec_name?: string }>;
      };

      const formatName = String(parsed.format?.format_name ?? '').toLowerCase();
      const durationSeconds = Number(parsed.format?.duration ?? 0);
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      const video = streams.find((s) => s.codec_type === 'video');
      const audio = streams.find((s) => s.codec_type === 'audio');
      const videoCodec = String(video?.codec_name ?? '').toLowerCase();
      const audioCodec = String(audio?.codec_name ?? '').toLowerCase();

      const containerOk = formatName.includes('mp4') || formatName.includes('mov');
      const videoOk = ['h264', 'hevc'].includes(videoCodec);
      const audioOk = !audioCodec || ['aac', 'mp3'].includes(audioCodec);
      const durationOk = Number.isFinite(durationSeconds) && durationSeconds > 0.1;

      const ok = containerOk && videoOk && audioOk && durationOk;
      const reasons: string[] = [];
      if (!containerOk) reasons.push(`container_incompativel:${formatName || 'desconhecido'}`);
      if (!videoOk) reasons.push(`codec_video_incompativel:${videoCodec || 'desconhecido'}`);
      if (!audioOk) reasons.push(`codec_audio_incompativel:${audioCodec}`);
      if (!durationOk) reasons.push('duracao_invalida');

      return {
        ok,
        container: formatName || null,
        videoCodec: videoCodec || null,
        audioCodec: audioCodec || null,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
        reasons,
      };
    } catch (error) {
      return {
        ok: false,
        container: null,
        videoCodec: null,
        audioCodec: null,
        durationSeconds: null,
        reasons: [error instanceof Error ? error.message : 'ffprobe_failed'],
      };
    }
  }

  private async computeFileSha256(filePath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async exportClip(user: AuthUser, recordingId: string, dto: ExportClipDto) {
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const inputPath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(inputPath)) {
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    const sourceDuration = Math.max(
      1,
      recording.durationSeconds ??
        (recording.endedAt ? Math.max(1, Math.floor((recording.endedAt.getTime() - recording.startedAt.getTime()) / 1000)) : 1),
    );

    if (dto.endSeconds <= dto.startSeconds) {
      throw new BadRequestException('endSeconds deve ser maior que startSeconds.');
    }
    if (dto.startSeconds >= sourceDuration) {
      throw new BadRequestException('startSeconds está fora da gravação.');
    }

    const clippedEnd = Math.min(dto.endSeconds, sourceDuration);
    const durationSeconds = clippedEnd - dto.startSeconds;
    if (durationSeconds <= 0) {
      throw new BadRequestException('Intervalo do clip inválido.');
    }

    const clipStartedAt = new Date(recording.startedAt.getTime() + dto.startSeconds * 1000);
    const clipEndedAt = new Date(recording.startedAt.getTime() + clippedEnd * 1000);
    const dir = join(
      recordingsRoot,
      'clips',
      recording.cameraId,
      `${clipStartedAt.getUTCFullYear()}`,
      `${String(clipStartedAt.getUTCMonth() + 1).padStart(2, '0')}`,
      `${String(clipStartedAt.getUTCDate()).padStart(2, '0')}`,
    );
    mkdirSync(dir, { recursive: true });

    const fileName = `clip-${recording.id}-${dto.startSeconds}-${clippedEnd}.mp4`;
    const outputPath = join(dir, fileName);

    await this.runClipExport(inputPath, outputPath, dto.startSeconds, durationSeconds);
    if (!existsSync(outputPath)) {
      throw new InternalServerErrorException('FFmpeg não gerou o arquivo de clip.');
    }

    let externalPlayback = await this.inspectClipExternalPlayback(outputPath);
    if (!externalPlayback.ok) {
      await this.transcodeClipForCompatibility(inputPath, outputPath, dto.startSeconds, durationSeconds);
      if (!existsSync(outputPath)) {
        throw new InternalServerErrorException('Falha ao gerar clip compatível para reprodução externa.');
      }
      externalPlayback = await this.inspectClipExternalPlayback(outputPath);
      if (!externalPlayback.ok) {
        throw new InternalServerErrorException(
          `Clip exportado incompatível para reprodução externa: ${externalPlayback.reasons.join(', ') || 'motivo desconhecido'}.`,
        );
      }
    }

    const stats = statSync(outputPath);
    const fileSha256 = await this.computeFileSha256(outputPath);
    const clip = await this.prisma.exportedClip.create({
      data: {
        cameraId: recording.cameraId,
        sourceRecordingId: recording.id,
        filePath: outputPath,
        startedAt: clipStartedAt,
        endedAt: clipEndedAt,
        durationSeconds,
        sizeBytes: BigInt(stats.size),
        fileSha256,
        createdByUserId: user.id,
        createdByUserName: user.name,
      },
    });

    return {
      id: clip.id,
      cameraId: clip.cameraId,
      sourceRecordingId: clip.sourceRecordingId,
      startedAt: clip.startedAt,
      endedAt: clip.endedAt,
      durationSeconds: clip.durationSeconds,
      sizeBytes: clip.sizeBytes?.toString() ?? null,
      fileSha256: clip.fileSha256 ?? null,
      externalPlayback: {
        validated: true,
        container: externalPlayback.container,
        videoCodec: externalPlayback.videoCodec,
        audioCodec: externalPlayback.audioCodec,
        durationSeconds: externalPlayback.durationSeconds,
      },
      downloadUrl: `/recordings/clips/${clip.id}/download`,
    };
  }

  async downloadExportedClip(clipId: string, res: Response) {
    const clip = await this.ensureExportedClipExists(clipId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, clip.filePath);
    if (!existsSync(filePath)) {
      throw new NotFoundException('Arquivo do clip não encontrado no disco.');
    }
    res.setHeader('Content-Disposition', `attachment; filename="clip-${clip.id}.mp4"`);
    createReadStream(filePath).pipe(res);
  }

  async createThumbnailTokens(user: AuthUser, recordingIds: string[]) {
    const uniqueIds = [...new Set(recordingIds)];
    const recordings = await this.prisma.recording.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, cameraId: true, camera: { select: { isPrivate: true } } },
    });

    const isPrivileged = user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
    const tokenMap: Record<string, string> = {};
    for (const rec of recordings) {
      // Gate único do conteúdo (invariante 1.2.i): o atalho de admin/super-admin
      // vale SÓ para câmera NÃO-privada. A câmera privada respeita canViewCamera
      // (admin GERENCIA mas NÃO vê) — nunca emitir token de conteúdo privado a quem
      // não pode ver, mesmo que todo consumidor de token hoje re-cheque o gate.
      const canView = isPrivileged && !rec.camera?.isPrivate
        ? true
        : await this.accessControlService.canViewCamera(user, rec.cameraId);
      if (!canView) continue;
      const token = await this.authService.createPlaybackToken(user.id, rec.id);
      tokenMap[rec.id] = token.playToken;
    }

    return tokenMap;
  }

  async deleteAllRecordings() {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const [recordings, clips] = await Promise.all([
      this.prisma.recording.findMany({ select: { id: true, filePath: true, sizeBytes: true } }),
      this.prisma.exportedClip.findMany({ select: { id: true, filePath: true, sizeBytes: true } }),
    ]);

    let deletedFiles = 0;
    let failedFiles = 0;
    let deletedBytes = BigInt(0);
    const paths = [...recordings, ...clips].map((item) => ({ filePath: item.filePath, sizeBytes: item.sizeBytes }));

    for (const item of paths) {
      try {
        const fullPath = ensureFileUnderRoot(recordingsRoot, item.filePath);
        if (existsSync(fullPath)) {
          rmSync(fullPath, { force: true });
          deletedFiles += 1;
          deletedBytes += item.sizeBytes ?? BigInt(0);
        }
      } catch {
        failedFiles += 1;
      }
    }

    for (const cacheDir of ['.playback-compatible', '.diagnostics-cache']) {
      try {
        const fullPath = ensureFileUnderRoot(recordingsRoot, cacheDir);
        if (existsSync(fullPath)) rmSync(fullPath, { recursive: true, force: true });
      } catch {
        failedFiles += 1;
      }
    }

    const [clipsDeleted, recordingsDeleted] = await this.prisma.$transaction([
      this.prisma.exportedClip.deleteMany({}),
      this.prisma.recording.deleteMany({}),
    ]);

    return {
      recordingsDeleted: recordingsDeleted.count,
      clipsDeleted: clipsDeleted.count,
      filesDeleted: deletedFiles,
      fileDeleteFailures: failedFiles,
      bytesDeleted: deletedBytes.toString(),
    };
  }
}
