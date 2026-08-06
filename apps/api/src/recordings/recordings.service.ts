import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, BadRequestException, InternalServerErrorException, Logger, OnModuleInit, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdirSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { type Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Queue } from 'bullmq';
import { RecordingSource, UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { AccessControlService } from '../access-control/access-control.service';
import { CloudConnectorService } from '../cloud-connector/cloud-connector.service';
import { S3Client, S3Error } from '../cloud-storage/s3-client';
import { resolverRange, validadoresDeCache } from './helpers/http-range.helper';
import { montarManifestoZip } from './helpers/zip-manifest.helper';
import { CloudStorageResolverService } from '../cloud-storage/cloud-storage-resolver.service';
import { AuthService } from '../auth/auth.service';
import { type AuthUser } from '../common/types/auth-user.type';
import { THUMBNAIL_GENERATION_QUEUE } from '../jobs/queues/thumbnail-generation.queue';
import { RANGE_EXPORT_JOB_NAME, RECORDING_EXPORT_QUEUE } from '../jobs/queues/recording-export.queue';
import {
  buildRangeExportFileName,
  buildRangeExportJobId,
  normalizeRangeExportIdentity,
  planOrphanRecovery,
  rangeExportProgress,
  type RangeExportIdentity,
  type RangeExportProfile,
  type RangeExportStep,
} from '../jobs/helpers/range-export-job.helper';
import { envNumber, parseFiniteNumber } from '../common/config/env-number.helper';
import {
  buildConcatManifest,
  buildRangeExportAttempts,
  planRangeExport,
  type RangeSourceSegment,
} from './helpers/range-export.helper';
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
import { planVodPlaylist, renderVodPlaylist, type VodSourceSegment } from './helpers/vod-playlist.helper';
import { CacheDeDiagnostico } from './helpers/diagnostics-cache.helper';
import {
  planejarVarredura,
  emLotes,
  contagemZerada,
  somarGravacao,
  avaliarAtencao,
  mesclarDiagnosticoComNuvem,
  type ContagemDeCamera,
  type EntradaDeCache,
} from './helpers/health-summary-scan.helper';
import {
  isMissingCommandError,
  markNiceUnavailable,
  planLowPriorityCommand,
} from './helpers/ffmpeg-priority.helper';
import {
  buildCompatibleTranscodeArgs,
  detectTranscodeHwaccel,
  reportHwaccelFailure,
  reportHwaccelSuccess,
  type HwaccelDecision,
  type HwaccelPreset,
} from '../camera-stream/helpers/hwaccel-presets.helper';
import archiver from 'archiver';
import {
  recoverPendingFileDeletions,
  stageFileDeletion,
  type StagedFileDeletion,
} from './helpers/transactional-file-delete.helper';

const execFileAsync = promisify(execFile);

function requireStagedDeletion(value: StagedFileDeletion | null): StagedFileDeletion {
  if (!value) throw new Error('Exclusão física não foi preparada dentro da transação.');
  return value;
}

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
  // Transcode de playback compatível é CARO (até 5 min de FFmpeg). Sem dedup, N
  // requisições simultâneas da MESMA gravação disparavam N transcodes do mesmo
  // arquivo — tempestade de CPU que degrada gravação e live no mesmo host.
  private readonly compatibleFileInFlight = new Map<string, Promise<string>>();
  private readonly thumbnailGenerationWaiters: Array<() => void> = [];
  private thumbnailGenerationActive = 0;
  private integritySweepTimer: NodeJS.Timeout | null = null;
  private integritySweepRunning = false;
  private readonly thumbnailGenerationConcurrency = Math.max(
    1,
    Math.min(4, envNumber('RECORDING_THUMBNAIL_CONCURRENCY', 2)),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly accessControlService: AccessControlService,
    @InjectQueue(THUMBNAIL_GENERATION_QUEUE) private readonly thumbnailQueue: Queue,
    @InjectQueue(RECORDING_EXPORT_QUEUE) private readonly rangeExportQueue: Queue,
    private readonly cloudConnector: CloudConnectorService,
    private readonly storageResolver: CloudStorageResolverService,
  ) {}

  async onModuleInit() {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    try {
      const recovery = await recoverPendingFileDeletions(recordingsRoot, async (guard) => {
        if (guard.model === 'recording') {
          return Boolean(await this.prisma.recording.findUnique({
            where: { id: guard.id },
            select: { id: true },
          }));
        }
        return Boolean(await this.prisma.exportedClip.findUnique({
          where: { id: guard.id },
          select: { id: true },
        }));
      });
      if (recovery.scanned > 0) {
        this.logger.log(
          `Recuperação do journal de exclusão: scanned=${recovery.scanned} restored=${recovery.restored} cleaned=${recovery.cleaned} failed=${recovery.failed}`,
        );
      }
    } catch (error) {
      // Falhar fechado: não remove nada sem conseguir consultar o banco.
      this.logger.error(
        `Falha ao reconciliar exclusões pendentes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Varredura periódica de INTEGRIDADE: hoje só descobrimos que uma gravação
    // está corrompida quando alguém tenta reproduzi-la — normalmente no pior
    // momento possível (precisando da prova). Aqui uma amostra pequena é
    // verificada de tempos em tempos e o problema vira evento na câmera.
    if (String(process.env.RECORDING_INTEGRITY_SWEEP_ENABLED ?? 'true') !== 'false') {
      // NaN aqui ia direto para o setInterval abaixo — rajada de ~1ms.
      const intervalMs = envNumber('RECORDING_INTEGRITY_SWEEP_INTERVAL_MS', 60 * 60_000, {
        min: 15 * 60_000,
        onInvalid: (m) => this.logger.warn(m),
      });
      this.integritySweepTimer = setInterval(() => void this.runIntegritySweep(), intervalMs);
      this.integritySweepTimer.unref?.();
      const firstRun = setTimeout(() => void this.runIntegritySweep(), 5 * 60_000);
      firstRun.unref();
    }

    if (String(process.env.RECORDING_THUMBNAIL_BACKFILL_ENABLED ?? 'true') === 'false') return;
    const timer = setTimeout(() => {
      const limit = envNumber('RECORDING_THUMBNAIL_BACKFILL_LIMIT', 2_000, { min: 1, max: 10_000 });
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
    // O que estava só em memória vai para o disco antes de desligar; senão um
    // deploy jogaria fora os diagnósticos dos últimos 2 segundos e o ffprobe
    // teria de refazê-los.
    if (this.diagnosticsFlushTimer) {
      clearTimeout(this.diagnosticsFlushTimer);
      this.diagnosticsFlushTimer = null;
    }
    this.cacheDiagnostico.descarregar();
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
      const sampleSize = envNumber('RECORDING_INTEGRITY_SWEEP_SAMPLE', 3, { min: 1, max: 20 });
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

  // O porquê de o cache viver em memória está em `diagnostics-cache.helper.ts`:
  // reler 1,6 MB do disco a cada volta de um laço de 1.200 travava a API
  // inteira por 11 segundos.
  //
  // Criado na primeira chamada, e não como campo de classe: parte da suíte
  // monta este serviço sem passar pelo construtor (`Object.create` do
  // protótipo), e inicializador de campo só roda em construtor — o campo sairia
  // `undefined` e todo teste que toca gravação quebraria.
  private cacheDiagnosticoInterno: CacheDeDiagnostico<RecordingHealthCacheEntry> | null = null;
  private get cacheDiagnostico(): CacheDeDiagnostico<RecordingHealthCacheEntry> {
    if (!this.cacheDiagnosticoInterno) {
      this.cacheDiagnosticoInterno = new CacheDeDiagnostico<RecordingHealthCacheEntry>(
        () => this.getDiagnosticsCacheFile(),
        (mensagem) => this.logger?.warn(mensagem),
      );
    }
    return this.cacheDiagnosticoInterno;
  }
  private diagnosticsCacheDir: string | null = null;
  private diagnosticsFlushTimer: NodeJS.Timeout | null = null;

  private getDiagnosticsCacheFile() {
    // `mkdirSync` uma vez por processo. Era uma chamada de sistema por volta do
    // laço — barata sozinha, absurda 1.200 vezes.
    if (!this.diagnosticsCacheDir) {
      const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
      const dir = join(recordingsRoot, '.diagnostics-cache');
      mkdirSync(dir, { recursive: true });
      this.diagnosticsCacheDir = dir;
    }
    return join(this.diagnosticsCacheDir, 'recording-health.json');
  }

  private readDiagnosticsCache(): Record<string, RecordingHealthCacheEntry> {
    return this.cacheDiagnostico.ler();
  }

  private writeDiagnosticsCache(cache: Record<string, RecordingHealthCacheEntry>) {
    this.cacheDiagnostico.gravar(cache);
    // Gravação adiada e agrupada — o auxiliar já guarda o valor em memória, e
    // quem ler em seguida enxerga o dado novo mesmo antes de ele ir ao disco.
    if (this.diagnosticsFlushTimer) return;
    this.diagnosticsFlushTimer = setTimeout(() => {
      this.diagnosticsFlushTimer = null;
      this.cacheDiagnostico.descarregar();
    }, 2000);
    this.diagnosticsFlushTimer.unref();
  }

  private getCacheTtlMs() {
    const ttl = envNumber('RECORDING_DIAGNOSTICS_TTL_SECONDS', 900);
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
      // Janela por SOBREPOSIÇÃO, não só por início: o segmento que começou
      // 23:57 e termina 00:02 pertence às duas janelas. Filtrar só por
      // startedAt abria um buraco falso nos primeiros minutos de cada janela.
      ...(to ? { startedAt: { lte: to } } : {}),
      ...(from
        ? {
            OR: [
              { startedAt: { gte: from } },
              { startedAt: { gte: new Date(from.getTime() - 2 * 3600_000) }, endedAt: { gte: from } },
            ],
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

    // Um filePath fora da raiz (linha corrompida) derrubava a LISTA INTEIRA
    // com 500 — timeline vazia por causa de uma linha. A ruim sai com aviso.
    const seguras = items.filter((item: any) => {
      try {
        ensureFileUnderRoot(recordingsRoot, item.filePath);
        return true;
      } catch {
        this.logger.warn(`Gravação ${item.id} com caminho inválido — omitida da lista.`);
        return false;
      }
    });
    return {
      items: seguras.map((item: any) => {
        const absolutePath = ensureFileUnderRoot(recordingsRoot, item.filePath);
        const extension = extname(absolutePath);
        const thumbnailBase = extension ? absolutePath.slice(0, -extension.length) : absolutePath;
        const thumbnailPath = `${thumbnailBase}.thumb.jpg`;
        const localExists = existsSync(absolutePath);
        // GRAVAÇÃO QUE JÁ SUBIU PARA A NUVEM CONTINUA EXISTINDO.
        //
        // O offload apaga a cópia local depois de CONFIRMAR o upload — é o
        // objetivo do produto de nuvem. Mas a listagem media existência só por
        // `existsSync`, então toda gravação migrada aparecia como arquivo
        // perdido e a tela se recusava a reproduzi-la. O endpoint individual
        // sempre soube buscar do bucket; a interface nunca chegava a chamá-lo.
        // Efeito prático: ligar a nuvem fazia o acervo "sumir" do playback.
        const cloudAvailable = this.nuvemDisponivel(item);
        const fileExists = localExists || cloudAvailable;
        const thumbnailExists = existsSync(thumbnailPath) && statSync(thumbnailPath).size > 0;
        const actualSizeBytes = localExists ? statSync(absolutePath).size : 0;
        // Uma miniatura bem-sucedida também é uma prova barata de que o MP4 é
        // decodificável. Segmentos interrompidos podem ter vários MB, mas não
        // possuem o átomo `moov`; antes eram oferecidos como reproduzíveis e o
        // app acabava numa tela cinza/erro. O backfill continua tentando gerar
        // a miniatura; quando conseguir, o item passa a utilizável sozinho.
        // Na nuvem, as provas locais de integridade (tamanho do arquivo e
        // miniatura) não se aplicam: o arquivo não está aqui. O upload só é
        // marcado no banco APÓS confirmação por HEAD com conferência de
        // tamanho, então `cloudUploadedAt` já é a prova de integridade
        // equivalente — exigir miniatura aqui reprovaria o acervo inteiro.
        const fileUsable = cloudAvailable
          || (localExists && actualSizeBytes > 1024 && thumbnailExists);
        return {
          fileExists,
          fileUsable,
          cloudAvailable,
          localExists,
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

  /**
   * Garante um ARQUIVO LOCAL para operações que precisam de um caminho real.
   *
   * Transcode de compatibilidade, snapshot de frame e geração de thumbnail
   * chamam ffmpeg/ffprobe apontando para um caminho — eles não sabem ler de
   * bucket. Sem isto, uma gravação já offloadada ficava assistível (o streaming
   * faz pass-through) mas não transcodável: câmera H.265 em navegador sem HEVC
   * simplesmente não abria.
   *
   * O objeto é baixado UMA vez para um cache local e reusado. O cache é
   * podado por idade — sem poda, "liberar disco" na nuvem seria desfeito
   * silenciosamente pelo próprio cache.
   *
   * Devolve `null` quando não há cópia na nuvem: quem chamou mantém o 404.
   */
  private async materializeFromCloud(
    recording: { id: string; filePath: string; cloudKey?: string | null; cloudStorageId?: string | null },
  ): Promise<string | null> {
    const cloudKey = recording.cloudKey;
    if (!cloudKey) return null;

    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const cacheDir = join(recordingsRoot, '.cloud-cache');
    const extensao = extname(recording.filePath) || '.mp4';
    const destino = join(cacheDir, `${recording.id}${extensao}`);

    // Já em cache de uma chamada anterior.
    if (existsSync(destino) && statSync(destino).size > 0) return destino;

    // Lê do storage DE ORIGEM desta gravação, não do ativo. Usar o ativo aqui
    // faria o playback procurar a chave antiga no bucket novo depois de uma
    // troca de fornecedor, e o acervo inteiro sumiria da tela — os dados
    // continuariam no bucket antigo, inalcançáveis.
    const config = await this.storageResolver
      .storageDaGravacao(recording.cloudStorageId ?? null)
      .catch(() => null);
    if (!config) return null;

    const client = this.storageResolver.clienteDe(config);
    const semPrefixo = config.prefix && cloudKey.startsWith(`${config.prefix}/`)
      ? cloudKey.slice(config.prefix.length + 1)
      : cloudKey;

    mkdirSync(cacheDir, { recursive: true });
    const parcial = `${destino}.partial`;
    try {
      // STREAM até o disco, nunca Buffer: um MP4 de 400 MB materializado na
      // RAM (e gravado com writeFileSync SÍNCRONO) congelava a API inteira —
      // a mesma classe do congelamento de 11s já documentado no cache de
      // diagnósticos. Temporário + rename: processo morto no meio não deixa
      // cache truncado que o ffmpeg leria como vídeo corrompido.
      const objeto = await client.getObjectStream(semPrefixo);
      if (!objeto.body) throw new Error('bucket devolveu corpo vazio');
      await pipeline(Readable.fromWeb(objeto.body as import('node:stream/web').ReadableStream), createWriteStream(parcial));
      renameSync(parcial, destino);
    } catch (error) {
      try { rmSync(parcial, { force: true }); } catch { /* já não existe */ }
      this.logger.warn(`Falha ao materializar gravação ${recording.id} da nuvem: ${sanitizeSensitiveText(error)}`);
      return null;
    }

    void this.pruneCloudCache(cacheDir);
    return destino;
  }

  /**
   * Poda o cache de gravações trazidas da nuvem.
   *
   * Sem isto o cache cresceria para sempre e desfaria, na prática, o objetivo
   * do offload (liberar disco). A janela é curta de propósito: o cache existe
   * para atender uma sessão de transcode/investigação, não para virar acervo.
   */
  private async pruneCloudCache(cacheDir: string) {
    const horas = envNumber('CLOUD_CACHE_TTL_HOURS', 6, {
      min: 1,
      max: 168,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    });
    const corte = Date.now() - horas * 3600_000;
    try {
      for (const nome of readdirSync(cacheDir)) {
        const caminho = join(cacheDir, nome);
        try {
          if (statSync(caminho).mtimeMs < corte) rmSync(caminho, { force: true });
        } catch { /* corrida com outra poda: ignorar */ }
      }
    } catch { /* diretório ainda não existe */ }
  }

  /**
   * Serve uma gravação que já saiu do disco e vive no bucket.
   *
   * PROXY, não redirecionamento para URL pré-assinada. Três razões, nesta ordem:
   *   1. o bucket costuma ser MinIO em rede local — o navegador de um operador
   *      remoto simplesmente não o alcança;
   *   2. o token de play e o gate de permissão continuam valendo, porque o byte
   *      passa por aqui; um redirecionamento entregaria o conteúdo fora do gate;
   *   3. nem a credencial nem a URL do bucket vazam para o cliente.
   * O custo é banda dobrada (bucket → API → navegador) — aceitável para acervo
   * antigo, que é justamente o que vai para a nuvem.
   *
   * O Range do navegador é REPASSADO ao S3 em vez de recalculado: quem conhece
   * o tamanho real do objeto é o bucket, e recomputar offset aqui introduziria
   * erro de um byte no seek. O 206/`Content-Range` do S3 é devolvido como veio.
   *
   * Devolve `false` quando a gravação não tem cópia na nuvem — aí quem chamou
   * mantém o 404 de sempre.
   */
  private async streamFromCloudIfAvailable(
    recording: { id: string; filePath: string; cloudKey?: string | null; cloudStorageId?: string | null },
    res: Response,
    options?: { download?: boolean },
  ): Promise<boolean> {
    const cloudKey = recording.cloudKey;
    if (!cloudKey) return false;

    // Lê do storage DE ORIGEM desta gravação, não do ativo — o mesmo motivo de
    // materializeFromCloud: usar o ativo faria o playback procurar a chave
    // antiga no bucket NOVO depois de qualquer troca de fornecedor, e o acervo
    // inteiro "sumiria" da tela (os dados continuariam no bucket antigo,
    // inalcançáveis). Era exatamente o defeito que a coluna `cloudStorageId` e
    // o resolver existem para impedir.
    const config = await this.storageResolver
      .storageDaGravacao(recording.cloudStorageId ?? null)
      .catch(() => null);
    if (!config) {
      // A gravação diz estar na nuvem, mas o storage foi removido do painel.
      // Sinalizar é melhor que devolver "não encontrado", que mandaria o
      // operador procurar no disco um arquivo que está no bucket.
      throw new NotFoundException(
        'Esta gravação foi arquivada na nuvem, mas o armazenamento de origem dela não está mais configurado nesta instalação.',
      );
    }

    const client = this.storageResolver.clienteDe(config);

    // A chave gravada no banco já é relativa ao prefixo do storage; este corte
    // só existe para acervo antigo que porventura a tenha gravado completa.
    const semPrefixo = config.prefix && cloudKey.startsWith(`${config.prefix}/`)
      ? cloudKey.slice(config.prefix.length + 1)
      : cloudKey;

    const range = res.req.headers.range;
    let objeto: Awaited<ReturnType<S3Client['getObjectStream']>>;
    try {
      objeto = await client.getObjectStream(semPrefixo, range);
    } catch (error) {
      // Erro do bucket não pode virar "Internal server error" mudo: o operador
      // precisa distinguir "objeto sumiu do bucket" de "API quebrada".
      if (error instanceof S3Error && (error.status === 404 || error.code === 'NoSuchKey' || error.code === 'NoSuchBucket')) {
        // NoSuchKey (bucket vivo, objeto ausente) = apagado por fora: marca na
        // hora, sem esperar a vigilância periódica chegar nesta gravação.
        // NoSuchBucket NÃO marca — indisponível não é apagado.
        if (error.code === 'NoSuchKey') {
          await this.prisma.recording.updateMany({
            where: { id: recording.id, cloudMissingSince: null },
            data: { cloudMissingSince: new Date(), cloudVerifiedAt: new Date() },
          }).catch(() => undefined);
        }
        throw new NotFoundException(
          `Esta gravação foi arquivada na nuvem, mas o bucket não a devolveu (${error.code}). `
          + 'Verifique o armazenamento em nuvem desta instalação.',
        );
      }
      if (error instanceof S3Error && error.status === 416) {
        // Range insatisfazível é resposta do protocolo, não indisponibilidade.
        res.status(416).setHeader('Content-Range', 'bytes */*').end();
        return true;
      }
      if (error instanceof S3Error) {
        throw new ServiceUnavailableException(
          `O armazenamento em nuvem respondeu ${error.status} (${error.code}) ao buscar esta gravação.`,
        );
      }
      throw error;
    }

    res.status(objeto.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', objeto.contentType || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (objeto.contentLength) res.setHeader('Content-Length', objeto.contentLength);
    if (objeto.contentRange) res.setHeader('Content-Range', objeto.contentRange);
    if (options?.download) {
      res.setHeader('Content-Disposition', `attachment; filename="${basename(recording.filePath)}"`);
    }

    if (!objeto.body) {
      res.end();
      return true;
    }

    // Stream, não Buffer: um segmento pode ter centenas de MB, e materializá-lo
    // na memória por requisição derrubaria a API com poucos operadores
    // assistindo ao mesmo tempo.
    const reader = objeto.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          // Backpressure: o navegador não está consumindo tão rápido quanto o
          // bucket entrega. Sem isto, a memória da API cresce sem limite.
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (error) {
      // Cliente desconectou no meio (fechou a aba, trocou de câmera): não é
      // erro de servidor, e insistir só desperdiça banda do bucket.
      reader.cancel().catch(() => undefined);
      if (!res.writableEnded) res.end();
    }
    return true;
  }

  /**
   * `createReadStream(...).pipe(res)` SEM handler de erro derruba o processo:
   * `pipe()` não instala listener de 'error' na ORIGEM, e um ENOENT assíncrono
   * (a retenção ou a poda da nuvem tiram o arquivo entre o `statSync` e o
   * `open` interno do stream — não há lock nenhum entre eles) vira
   * uncaughtException — que o main.ts deliberadamente NÃO engole. A API caía
   * por um clique de playback na hora errada, e a gravação contínua não volta
   * sozinha depois do restart.
   */
  private pipeArquivo(res: Response, filePath: string, range?: { start: number; end: number }) {
    const stream = range ? createReadStream(filePath, range) : createReadStream(filePath);
    stream.on('error', (error) => {
      this.logger.warn(`Stream de arquivo falhou (${filePath}): ${(error as Error).message}`);
      if (!res.headersSent) {
        res.status(404).end();
      } else {
        // Cabeçalho já foi: encerrar "com sucesso" entregaria um corpo mais
        // curto que o Content-Length prometido como se fosse o vídeo inteiro.
        res.destroy(error as Error);
      }
    });
    stream.pipe(res);
  }

  /**
   * Entrega um arquivo IMUTÁVEL (gravação fechada nunca muda) com Range
   * correto e validadores de cache. Toda a semântica de Range/ETag mora em
   * `http-range.helper.ts` — sufixo, multi-range e malformado eram tratados
   * errado em TRÊS cópias deste bloco, cada uma mentindo um 206.
   * Com ETag + If-None-Match o navegador reaproveita o que já baixou: em
   * link lento, é a diferença entre "seek instantâneo" e re-baixar o vídeo.
   */
  private entregarArquivo(res: Response, filePath: string, stats: { size: number; mtimeMs: number }) {
    const fileSize = stats.size;
    const { etag, lastModified } = validadoresDeCache(stats);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('Cache-Control', 'private, max-age=3600, immutable');
    if (res.req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const alcance = resolverRange(res.req.headers.range, fileSize);
    if (alcance.tipo === 'insatisfazivel') {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    if (alcance.tipo === 'completo') {
      res.setHeader('Content-Length', fileSize);
      this.pipeArquivo(res, filePath);
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${alcance.start}-${alcance.end}/${fileSize}`);
    res.setHeader('Content-Length', alcance.end - alcance.start + 1);
    this.pipeArquivo(res, filePath, { start: alcance.start, end: alcance.end });
  }

  /**
   * A cópia da NUVEM conta como existente? Uma única resposta para lista,
   * régua (gaps), prontidão e playlist VOD — as quatro discordavam: a lista
   * dizia "existe", a régua pintava buraco e a playlist pulava o segmento,
   * então o modo contínuo escolhia o vídeo ERRADO em cima de acervo íntegro.
   * `cloudMissingSince` exclui: objeto apagado por fora não é cópia.
   */
  private nuvemDisponivel(r: { cloudKey?: string | null; cloudUploadedAt?: Date | null; cloudMissingSince?: Date | null }) {
    return Boolean(r.cloudKey && r.cloudUploadedAt && !r.cloudMissingSince);
  }

  async streamRecording(recordingId: string, res: Response, options?: { allowAutoCompat?: boolean }) {
    const recording = await this.ensureRecordingExists(recordingId);

    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(filePath)) {
      // Não está no disco — mas pode estar na NUVEM. Este era o ponto em que uma
      // gravação já offloadada virava 404: prova salva no bucket que o operador
      // não conseguia assistir.
      const daNuvem = await this.streamFromCloudIfAvailable(recording, res);
      if (daNuvem) return;
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

    this.entregarArquivo(res, filePath, stats);
  }

  private async ensureCompatibleFile(recordingId: string): Promise<string> {
    // Dedup por gravação: quem chegar durante um transcode em andamento AGUARDA o
    // mesmo trabalho em vez de iniciar outro.
    const existing = this.compatibleFileInFlight.get(recordingId);
    if (existing) return existing;
    const work = this.generateCompatibleFile(recordingId)
      .finally(() => this.compatibleFileInFlight.delete(recordingId));
    this.compatibleFileInFlight.set(recordingId, work);
    return work;
  }

  private async generateCompatibleFile(recordingId: string) {
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    let inputPath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(inputPath)) {
      // Gravação já offloadada: o ffmpeg precisa de um caminho real, então a
      // trazemos da nuvem para o cache local. Sem isto, câmera H.265 em
      // navegador sem HEVC ficava sem transcode — assistível na teoria,
      // impossível na prática.
      const local = await this.materializeFromCloud(recording);
      if (local) inputPath = local;
    }
    if (!existsSync(inputPath)) {
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    const cacheDir = join(recordingsRoot, '.playback-compatible', recording.cameraId);
    mkdirSync(cacheDir, { recursive: true });
    const outputPath = join(cacheDir, `${recording.id}.mp4`);
    if (existsSync(outputPath) && statSync(outputPath).size > 0) {
      return outputPath;
    }
    // Escreve num TEMPORÁRIO e só then renomeia: o nome final nunca aponta para um
    // arquivo pela metade (um transcode interrompido deixava um MP4 truncado que o
    // `existsSync` seguinte aceitaria como cache válido, servindo vídeo quebrado).
    const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;

    // Transcode H.265 (or any incompatible codec) → H.264 preserving original resolution and quality.
    // CRF 18 = visually lossless. A resolução original é preservada (sem -vf).
    //
    // CAMPO DE PROVAS DA ACELERAÇÃO POR HARDWARE: este transcode é offline e
    // descartável — se falhar, nenhuma câmera cai, só refazemos em CPU. Por isso
    // é aqui que a GPU estreia. A rede de proteção é a mesma do Frigate
    // (record/export.py:749-770): comando com hwaccel falhou ⇒ refaz sem hwaccel.
    // O arquivo TEM de sair; a aceleração é um bônus, nunca um requisito.
    const hwaccel = await this.resolveTranscodeHwaccel();
    if (hwaccel.degraded) {
      // O dono precisa ENXERGAR que prometeram GPU e não há GPU.
      this.logger.warn(`Aceleração por hardware indisponível: ${hwaccel.reason}`);
    }

    const tentativas: Array<{ preset: HwaccelPreset | null; args: string[] }> = [];
    if (hwaccel.preset) {
      tentativas.push({
        preset: hwaccel.preset,
        args: buildCompatibleTranscodeArgs({
          input: inputPath,
          output: tmpPath,
          preset: hwaccel.preset,
          device: hwaccel.device,
        }),
      });
    }
    tentativas.push({
      preset: null,
      args: buildCompatibleTranscodeArgs({ input: inputPath, output: tmpPath, preset: null }),
    });

    let ultimoErro: string | null = null;
    let publicado = false;
    for (const tentativa of tentativas) {
      try {
        await this.runTranscodeAttempt(tentativa.args);
        // Código de saída 0 NÃO é prova: falhas de hwaccel costumam sair 0 e não
        // escrever nada. Só um arquivo com bytes conta como sucesso.
        if (existsSync(tmpPath) && statSync(tmpPath).size > 0) {
          if (tentativa.preset) reportHwaccelSuccess(tentativa.preset);
          publicado = true;
          break;
        }
        ultimoErro = 'o ffmpeg terminou sem produzir arquivo';
      } catch (error) {
        ultimoErro = error instanceof Error ? error.message : String(error);
      }
      // Lixo parcial não pode sobreviver entre tentativas nem no fim.
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
      if (tentativa.preset) {
        // Quarentena, não exclusão: o preset volta a ser testado sozinho depois.
        const emQuarentena = reportHwaccelFailure(tentativa.preset);
        this.logger.warn(
          `Transcode compatível com aceleração ${tentativa.preset} FALHOU (${ultimoErro}); refazendo em CPU` +
            (emQuarentena ? ` — preset colocado em QUARENTENA após falhas repetidas.` : '.'),
        );
      }
    }

    if (!publicado) {
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
      throw new InternalServerErrorException(
        `Falha ao gerar arquivo compatível para playback: ${ultimoErro ?? 'erro desconhecido'}`,
      );
    }
    renameSync(tmpPath, outputPath); // atômico no mesmo filesystem
    return outputPath;
  }

  /** Seam única para a decisão de aceleração (cache/quarentena vivem no helper). */
  private resolveTranscodeHwaccel(): Promise<HwaccelDecision> {
    return detectTranscodeHwaccel();
  }

  // ── PRIORIDADE DOS FFMPEG AUXILIARES ────────────────────────────────────────
  // Um cliente clicando "exportar 1 hora" dispara um libx264 que rouba CPU da
  // GRAVAÇÃO de todas as câmeras do host. O modo de falha não é a exportação
  // lenta — é a gravação furar. Por isso TODO ffmpeg pesado e não-crítico daqui
  // (transcode de playback, exportação de clipe, thumbnail/sprite, varredura de
  // integridade) roda com prioridade rebaixada. A gravação, que fica no
  // recording-process-manager, continua em prioridade NORMAL.
  //
  // Fica de fora de propósito: `ffprobe` (barato) e o snapshot de UM frame (o
  // usuário está parado na tela esperando aquela imagem).

  /** Seam de processo: existe para o teste observar o comando REALMENTE executado. */
  private runExecFile(command: string, args: string[], options: Record<string, unknown>): Promise<{ stdout: any; stderr: any }> {
    return (execFileAsync as any)(command, args, options);
  }

  /**
   * Executa um ffmpeg NÃO-CRÍTICO cedendo CPU para a gravação.
   * Rebaixar é BÔNUS: sem `nice` no sistema (ou se ele sumir do PATH na hora H),
   * o comando roda igual. Nenhuma exportação pode falhar por causa de prioridade.
   */
  private async execFfmpegLowPriority(
    args: string[],
    options: Record<string, unknown> = {},
  ): Promise<{ stdout: any; stderr: any }> {
    const plan = planLowPriorityCommand('ffmpeg', args);
    try {
      return await this.runExecFile(plan.command, plan.args, options);
    } catch (error) {
      if (plan.lowered && isMissingCommandError(error)) {
        markNiceUnavailable();
        this.logger.warn('`nice` indisponível neste sistema — seguindo sem rebaixar a prioridade do ffmpeg auxiliar.');
        return await this.runExecFile('ffmpeg', args, options);
      }
      throw error;
    }
  }

  /** Seam única para executar o ffmpeg do transcode compatível. */
  private async runTranscodeAttempt(args: string[]): Promise<void> {
    await this.execFfmpegLowPriority(args, {
      timeout: 300000, // 5 min max for large files
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  async streamRecordingCompatible(recordingId: string, res: Response) {
    // A PRIMEIRA reprodução de um HEVC segurava a requisição HTTP pelos até
    // 5 minutos do FFmpeg — o operador esperava com a tela travada e, se o
    // transcode estourasse o prazo, ganhava um 500 depois de tudo isso. Agora:
    // cache pronto → serve; sem cache → dispara o preparo em SEGUNDO PLANO
    // (com o dedup de sempre) e responde 503 na hora, com `preparing: true` —
    // o player mostra "preparando…" e tenta de novo sozinho.
    const recording = await this.ensureRecordingExists(recordingId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const cachedPath = join(recordingsRoot, '.playback-compatible', recording.cameraId, `${recording.id}.mp4`);
    if (!existsSync(cachedPath) || statSync(cachedPath).size <= 0) {
      void this.ensureCompatibleFile(recordingId).catch((error) => {
        this.logger.warn(`Preparo da versão compatível falhou recording=${recordingId}: ${error instanceof Error ? error.message : String(error)}`);
      });
      res.status(503)
        .setHeader('Retry-After', '5')
        .json({
          statusCode: 503,
          preparing: true,
          message: 'A versão compatível (H.265→H.264) está sendo preparada. O vídeo começa sozinho assim que ficar pronta.',
        });
      return;
    }
    const stats = statSync(cachedPath);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    this.entregarArquivo(res, cachedPath, stats);
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
      // Mesma regra do playback: gravação offloadada continua baixável.
      const daNuvem = await this.streamFromCloudIfAvailable(recording, res, { download: true });
      if (daNuvem) return;
      throw new NotFoundException('Arquivo de gravação não encontrado no disco.');
    }

    const stats = statSync(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="recording-${recording.id}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    this.entregarArquivo(res, filePath, stats);
  }

  // Streama um ZIP com várias gravações sem materializar nada em disco/memória.
  // store (sem compressão): vídeo já é comprimido; recomprimir só gastaria CPU.
  async downloadRecordingsZip(recordingIds: string[], res: Response) {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const uniqueIds = [...new Set(recordingIds)].slice(0, 50);

    const entries: Array<{ filePath: string; entryName: string }> = [];
    const puladas: Array<{ id: string; motivo: string }> = [];
    const usedNames = new Set<string>();
    for (const id of uniqueIds) {
      let recording: Awaited<ReturnType<typeof this.ensureRecordingExists>>;
      try {
        recording = await this.ensureRecordingExists(id);
      } catch {
        puladas.push({ id, motivo: 'gravação não encontrada no banco' });
        continue;
      }
      let filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
      if (!existsSync(filePath) || statSync(filePath).size === 0) {
        // Gravação já offloadada: baixa do bucket para o cache antes de
        // empacotar. Se falhar, o item entra no MANIFESTO — pedir 20 e
        // receber 3 sem explicação é inaceitável num acervo probatório.
        const materializado = await this.materializeFromCloud(recording).catch(() => null);
        if (!materializado) {
          puladas.push({ id, motivo: 'sem arquivo local e o bucket não devolveu a cópia' });
          continue;
        }
        filePath = materializado;
      }
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

    if (puladas.length) {
      this.logger.warn(`ZIP em lote: ${puladas.length} de ${uniqueIds.length} gravação(ões) fora do pacote — ver MANIFESTO.txt no próprio ZIP.`);
    }

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
    // O MANIFESTO vai SEMPRE: é a diferença entre "recebi 3 de 20 e não sei
    // por quê" e um pacote que presta contas de cada item pedido.
    archive.append(montarManifestoZip(uniqueIds.length, entries.map((e) => e.entryName), puladas), { name: 'MANIFESTO.txt' });
    for (const entry of entries) {
      archive.file(entry.filePath, { name: entry.entryName });
    }
    await archive.finalize();
    return { files: entries.length, skipped: puladas.length };
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
      timeout: envNumber('RECORDING_METADATA_PROBE_TIMEOUT_MS', 15_000, { min: 5_000 }),
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
    const concurrency = envNumber('RECORDING_METADATA_RECONCILE_CONCURRENCY', 2, { min: 1, max: 4 });

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
          // MARCADOR DE CLAMP: `registerSegment` detecta salto de PTS (a câmera
          // reinicia o relógio RTSP no meio do segmento), clampa a duração e
          // deixa `<arquivo>.duration-clamped.json` ao lado. O marcador existe
          // justamente para dizer "aqui o ffprobe MENTE".
          //
          // Sem esta checagem, este job (cron da meia-noite, 2.000 gravações
          // mais recentes) re-executava o mesmo probe, obtinha o mesmo valor
          // absurdo e desfazia o clamp: a correção durava no máximo 24h. Com
          // durationSeconds=25200 num segmento de 300s, o VOD emite
          // `#EXTINF:25200` e marca os ~84 segmentos seguintes como
          // sobreposição — o player trava em cima de gravação ÍNTEGRA. O mesmo
          // valor contamina os `outpoint` do concat da exportação para perícia.
          //
          // O TAMANHO continua sendo reconciliado: o byte no disco não mente,
          // quem mentiu foi o timestamp.
          const clamped = existsSync(`${filePath}.duration-clamped.json`);
          const currentSize = Number(recording.sizeBytes ?? 0n);

          if (clamped) {
            if (currentSize === metadata.sizeBytes) continue;
            await this.prisma.recording.update({
              where: { id: recording.id },
              data: { sizeBytes: BigInt(metadata.sizeBytes) },
            });
            result.updated += 1;
            continue;
          }

          const durationSeconds = Math.max(1, Math.round(metadata.durationSecondsExact));
          const endedAt = new Date(recording.startedAt.getTime() + metadata.durationSecondsExact * 1000);
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
    this.pipeArquivo(res, thumbPath);
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
        const configuredSecond = envNumber('RECORDING_THUMBNAIL_SECOND', 2, { min: 0 });
        const maximumSecond = Math.max(0, (durationSeconds ?? 10) - 0.25);
        const seekSeconds = Math.min(configuredSecond, maximumSecond);
        let lastError: unknown = null;
        try {
          for (const second of [...new Set([seekSeconds, 0])]) {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            try {
              await this.execFfmpegLowPriority(
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
    const tileWidth = envNumber('RECORDING_PREVIEW_TILE_WIDTH', 160, { min: 16 });
    const maxTiles = envNumber('RECORDING_PREVIEW_MAX_TILES', 120, { min: 1 });
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
    this.pipeArquivo(res, spritePath);
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
          await this.execFfmpegLowPriority(
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
    let result = await this.diagnosticarArquivo(recordingId, recording.cameraId, filePath) as Record<string, unknown>;
    const cache = this.readDiagnosticsCache();
    if (result.reason === 'file_missing' && this.nuvemDisponivel(recording)) {
      // A poda apagou a cópia local, mas o diagnóstico RICO (codec, se precisa
      // de transcode) foi medido quando ela existia. Sobrescrever com
      // "file_missing" seco cegava a decisão de compatibilidade: HEVC
      // só-na-nuvem ia CRU para navegador sem decoder — tela preta com 200.
      result = mesclarDiagnosticoComNuvem(result, cache[recordingId]?.diagnostics as Record<string, unknown> | undefined);
    }
    cache[recordingId] = { ...(cache[recordingId] ?? {}), checkedAt: new Date().toISOString(), diagnostics: result };
    this.writeDiagnosticsCache(cache);
    return result;
  }

  /**
   * Inspeciona o ARQUIVO e devolve o diagnóstico. Não toca no banco nem no
   * cache: é o miolo compartilhado entre a tela de detalhe (que chega pelo id)
   * e o resumo de saúde (que já tem o registro em mãos).
   *
   * Barato primeiro: arquivo ausente ou vazio se resolve com uma chamada de
   * sistema, e é o caso comum quando a gravação já subiu para a nuvem. O
   * `ffprobe` — um subprocesso — só roda quando há mesmo o que examinar.
   */
  private async diagnosticarArquivo(recordingId: string, cameraId: string, filePath: string): Promise<any> {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    if (!existsSync(filePath)) {
      return {
        recordingId,
        fileExists: false,
        playableLikely: false,
        reason: 'file_missing',
      };
    }

    const fileSize = statSync(filePath).size;
    if (fileSize <= 0) {
      return {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        playableLikely: false,
        reason: 'empty_file',
      };
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

      return {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        playableLikely,
        compatibleRecommended,
        hasAudioStream,
        audioPlayableLikely,
        compatibleCached: existsSync(join(recordingsRoot, '.playback-compatible', cameraId, `${recordingId}.mp4`)),
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
    } catch (error) {
      return {
        recordingId,
        fileExists: true,
        fileSizeBytes: fileSize,
        playableLikely: false,
        reason: error instanceof Error ? error.message : 'ffprobe_failed',
      };
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
      // Decodifica o arquivo INTEIRO: é o auxiliar mais pesado que existe aqui e
      // roda em varredura de fundo — jamais pode competir com a gravação.
      await this.execFfmpegLowPriority([
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
    // MESMO defeito já corrigido em list(): as duas chaves `cameraId` num
    // spread — a segunda (acessíveis) SOBRESCREVIA a primeira (câmera pedida)
    // e a "saúde da câmera 15" somava a frota inteira.
    const cameraFilter = params.cameraId
      ? params.accessibleCameraIds && !params.accessibleCameraIds.includes(params.cameraId)
        ? { cameraId: { in: [] as string[] } }
        : { cameraId: params.cameraId }
      : params.accessibleCameraIds
        ? { cameraId: { in: params.accessibleCameraIds } }
        : {};
    const where = {
      ...cameraFilter,
      startedAt: { gte: from, lte: to },
    };

    // O TETO DEIXOU DE SER MUDO. Cortar em 1.200 num dia de 8.500 gravações
    // resumia 14% do dia e apresentava o número como se fosse o dia inteiro —
    // "nenhuma câmera em atenção" podia significar "não olhei as outras 86%".
    // Agora conta-se quantas existem, corta-se com limite configurável, e a
    // resposta DIZ que cortou.
    const limiteVarredura = envNumber('RECORDING_HEALTH_SUMMARY_MAX_RECORDS', 1200, {
      min: 50,
      max: 20_000,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    });
    // Orçamento de medições CARAS (banco + ffprobe) por requisição. O resumo é
    // chamado a cada troca de aba; sem teto, um cache frio dispara um ffprobe
    // por gravação e o endpoint volta a custar minutos de CPU.
    const orcamentoProbes = envNumber('RECORDING_HEALTH_SUMMARY_PROBE_BUDGET', 24, {
      min: 0,
      max: 500,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    });
    const probesEmParalelo = envNumber('RECORDING_HEALTH_SUMMARY_PROBE_CONCURRENCY', 4, {
      min: 1,
      max: 16,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    });

    const [totalMatching, records] = await Promise.all([
      this.prisma.recording.count({ where }),
      this.prisma.recording.findMany({
        where,
        // `filePath` entra aqui de propósito: sem ele, cada gravação sem cache
        // fazia a sua PRÓPRIA consulta ao banco (via ensureRecordingExists) —
        // 1.200 idas e voltas em série para dados que esta consulta já podia
        // ter trazido de uma vez.
        select: { id: true, cameraId: true, startedAt: true, filePath: true, cloudKey: true, cloudUploadedAt: true, cloudMissingSince: true },
        orderBy: { startedAt: 'asc' },
        take: limiteVarredura,
      }),
    ]);

    const minExpectedBytes = envNumber('RECORDING_MIN_EXPECTED_FILE_BYTES', 128 * 1024, {
      min: 32 * 1024,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    });

    // O cache é lido UMA vez para a varredura inteira. Ler por gravação era o
    // defeito que parava a API por 11 segundos; mesmo com o memo em RAM, seria
    // um statSync por volta do laço à toa.
    const cache = this.readDiagnosticsCache();
    const plano = planejarVarredura(
      records,
      cache as Record<string, EntradaDeCache>,
      (registro) => registro.id,
      this.getCacheTtlMs(),
      Date.now(),
      orcamentoProbes,
    );

    const diagnosticoPorId = new Map<string, any>();
    for (const { registro, diagnostico } of plano.cacheados) diagnosticoPorId.set(registro.id, diagnostico);

    // As medições caras, com paralelismo limitado: em série somam segundos de
    // espera; todas juntas roubam CPU da GRAVAÇÃO, que é o que não pode furar.
    // `medirDiagnosticoDeGravacao` recebe o registro que a consulta já trouxe,
    // então não há uma segunda ida ao banco por gravação.
    const medidos = await emLotes(plano.aMedir, probesEmParalelo, (registro) =>
      this.medirDiagnosticoDeGravacao(registro).catch(() => null),
    );
    plano.aMedir.forEach((registro, indice) => {
      const resultado = medidos[indice];
      if (resultado) diagnosticoPorId.set(registro.id, resultado);
    });

    const byCamera = new Map<string, ContagemDeCamera>();
    for (const record of records) {
      const current = byCamera.get(record.cameraId) ?? contagemZerada(record.cameraId);
      current.lastRecordingAt = record.startedAt.toISOString();
      current.lastRecordingAgeSeconds = Math.max(0, Math.floor((Date.now() - record.startedAt.getTime()) / 1000));
      // `?? null` = indeterminado: ficou fora do orçamento ou a medição falhou.
      somarGravacao(current, diagnosticoPorId.get(record.id) ?? null, minExpectedBytes);
      byCamera.set(record.cameraId, current);
    }

    const threshold = Math.max(1, Math.floor(params.brokenAlertThreshold ?? 3));
    const items = Array.from(byCamera.values()).map((item) => ({
      ...item,
      ...avaliarAtencao(item, threshold, minExpectedBytes),
    })).sort((a, b) => {
      const riskA = a.broken * 4 + a.compatibleRecommended;
      const riskB = b.broken * 4 + b.compatibleRecommended;
      return riskB - riskA;
    });

    const pendentes = items.reduce((soma, item) => soma + item.pending, 0);
    if (plano.adiados.length) {
      this.logger.warn(
        `Resumo de saúde: ${plano.adiados.length} gravação(ões) sem diagnóstico nesta chamada ` +
          `(orçamento de ${orcamentoProbes} medições). Elas contam como "pendentes", nunca como defeito; ` +
          'as próximas chamadas vão completando conforme o cache esquenta.',
      );
    }
    return {
      date: from.toISOString(),
      totalRecordings: records.length,
      brokenAlertThreshold: threshold,
      minExpectedFileBytes: minExpectedBytes,
      camerasNeedingAttention: items.filter((item) => item.needsAttention).length,
      // ── O QUE ESTE RESUMO NÃO VIU ──────────────────────────────────────
      // Sem estes campos, 1.200 de 8.500 gravações eram apresentadas como o
      // dia inteiro. Quem lê precisa saber a diferença entre "está tudo bem"
      // e "a parte que eu olhei está bem".
      totalMatchingRecordings: totalMatching,
      scannedRecordings: records.length,
      truncated: totalMatching > records.length,
      scanLimit: limiteVarredura,
      pendingDiagnostics: pendentes,
      cameras: items,
    };
  }

  /**
   * Diagnóstico de UMA gravação a partir do registro JÁ CARREGADO.
   *
   * Existe para o resumo de saúde: `getRecordingDiagnostics` recebe só o id e
   * por isso consulta o banco para achar o `filePath` — inofensivo numa tela,
   * mas dentro de um laço de centenas vira uma consulta por volta. Aqui o
   * chamador já tem o registro, então o custo restante é só o disco.
   *
   * O resultado alimenta o MESMO cache do caminho unitário: o que for medido
   * aqui poupa o ffprobe da próxima tela de detalhe, e vice-versa.
   */
  private async medirDiagnosticoDeGravacao(registro: { id: string; cameraId: string; filePath: string; cloudKey?: string | null; cloudUploadedAt?: Date | null; cloudMissingSince?: Date | null }) {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, registro.filePath);
    let diagnostico = await this.diagnosticarArquivo(registro.id, registro.cameraId, filePath) as Record<string, unknown>;
    const cache = this.readDiagnosticsCache();
    if (diagnostico.reason === 'file_missing' && this.nuvemDisponivel(registro)) {
      diagnostico = mesclarDiagnosticoComNuvem(diagnostico, cache[registro.id]?.diagnostics as Record<string, unknown> | undefined);
    }
    cache[registro.id] = { ...(cache[registro.id] ?? {}), checkedAt: new Date().toISOString(), diagnostics: diagnostico };
    this.writeDiagnosticsCache(cache);
    return diagnostico;
  }

  async getRecordingGapsReport(params: { date?: string; from?: string; to?: string; cameraId: string; accessibleCameraIds?: string[] }) {
    // `from`/`to` ISO vindos do NAVEGADOR mandam: o dia é do operador, não do
    // servidor. Só com `date`, o servidor montava a janela no fuso DELE (UTC
    // nos containers) e ela escorregava 3h — os últimos minutos do dia local
    // viravam cobertura fantasma na régua, e o clique ali caía no vídeo errado.
    const fromParam = params.from ? new Date(params.from) : null;
    const toParam = params.to ? new Date(params.to) : null;
    const janelaValida = fromParam && toParam
      && !Number.isNaN(fromParam.getTime()) && !Number.isNaN(toParam.getTime())
      && toParam.getTime() > fromParam.getTime()
      && toParam.getTime() - fromParam.getTime() <= 48 * 3600_000;
    const selected = params.date ? new Date(params.date) : new Date();
    selected.setHours(0, 0, 0, 0);
    const dayStart = janelaValida ? fromParam! : new Date(selected);
    const dayEnd = janelaValida ? toParam! : new Date(selected);
    if (!janelaValida) dayEnd.setHours(23, 59, 59, 999);

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
        cloudKey: true,
        cloudUploadedAt: true,
        cloudMissingSince: true,
      },
      orderBy: { startedAt: 'asc' },
      take: 2000,
    });

    const usableSegments = records
      .map((record) => {
        // Nuvem conta: a régua é desenhada a partir daqui, e "buraco" em cima
        // de acervo offloadado mandava o clique para o vídeo errado.
        const fileExists = existsSync(ensureFileUnderRoot(recordingsRoot, record.filePath)) || this.nuvemDisponivel(record);
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
        cloudKey: true,
        cloudUploadedAt: true,
        cloudMissingSince: true,
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
        // Offloadada com upload confirmado NÃO é arquivo perdido: o /play a
        // serve do bucket. Contá-la como perdida fazia o relatório declarar
        // "dia inteiro sem prova" sobre acervo íntegro.
        if (this.nuvemDisponivel(record)) {
          existingFiles += 1;
          usableFiles += 1;
        } else {
          missingFiles += 1;
        }
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

  /**
   * VOD CONTÍNUO — monta UMA playlist HLS (VOD) cobrindo o intervalo pedido.
   *
   * ADITIVO: o playback atual (um arquivo por vez, `/recordings/:id/play`)
   * continua exatamente como está. Aqui apenas LISTAMOS os segmentos que já
   * existem, apontando para esse MESMO endpoint com o MESMO token de playback
   * (nenhuma autenticação nova). O gate de conteúdo por câmera (invariante da
   * câmera privada) é aplicado pelo controller ANTES de chegar aqui.
   *
   * Cuidados desta camada (o helper é puro):
   *  - janela limitada (`VOD_PLAYLIST_MAX_HOURS`, padrão 24h) e teto de segmentos;
   *  - lookback na consulta para pegar o segmento que COMEÇA antes de `from` e
   *    cruza a borda (senão o começo do intervalo ficaria de fora);
   *  - só entra segmento cujo arquivo EXISTE e tem tamanho plausível — um 404 no
   *    meio da playlist trava o player;
   *  - codec vem do cache de diagnóstico já gravado (sem ffprobe novo): quando
   *    conhecido, a troca de codec vira `#EXT-X-DISCONTINUITY`.
   */
  async buildVodPlaylist(
    user: AuthUser,
    params: { cameraId: string; from?: string; to?: string; maxSegments?: number },
  ) {
    const cameraId = String(params.cameraId ?? '').trim();
    if (!cameraId) throw new BadRequestException('cameraId é obrigatório.');

    const fromDate = params.from ? new Date(params.from) : null;
    const toDate = params.to ? new Date(params.to) : null;
    if (!fromDate || Number.isNaN(fromDate.getTime())) {
      throw new BadRequestException('Parâmetro "from" (ISO) é obrigatório e deve ser uma data válida.');
    }
    if (!toDate || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('Parâmetro "to" (ISO) é obrigatório e deve ser uma data válida.');
    }
    if (toDate.getTime() <= fromDate.getTime()) {
      throw new BadRequestException('Intervalo inválido: "to" precisa ser depois de "from".');
    }
    const maxHours = envNumber('VOD_PLAYLIST_MAX_HOURS', 24, { min: 1, max: 72 });
    if (toDate.getTime() - fromDate.getTime() > maxHours * 60 * 60 * 1000) {
      throw new BadRequestException(`Intervalo máximo da playlist VOD é de ${maxHours}h.`);
    }

    // Defesa em profundidade (mesmo princípio de createThumbnailTokens): quem
    // EMITE token de conteúdo confere o gate por conta própria — a playlist gera
    // N tokens de uma vez, então não pode depender de o chamador ter conferido.
    await this.accessControlService.assertCanPlaybackCamera(user, cameraId);

    const maxSegments = Math.max(1, Math.min(2_000, Number(params.maxSegments ?? process.env.VOD_PLAYLIST_MAX_SEGMENTS ?? 720)));
    const lookbackMinutes = envNumber('VOD_PLAYLIST_LOOKBACK_MINUTES', 60, { min: 1, max: 360 });
    const lookbackStart = new Date(fromDate.getTime() - lookbackMinutes * 60 * 1000);

    const records = await this.prisma.recording.findMany({
      where: {
        cameraId,
        startedAt: { gte: lookbackStart, lte: toDate },
        // fechada terminando depois do início pedido OU ainda aberta (gravando)
        OR: [{ endedAt: { gte: fromDate } }, { endedAt: null }],
      },
      select: { id: true, startedAt: true, endedAt: true, durationSeconds: true, filePath: true, cloudKey: true, cloudUploadedAt: true, cloudMissingSince: true },
      orderBy: { startedAt: 'asc' },
      take: 5_000,
    });

    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const diagnosticsCache = this.readDiagnosticsCache();
    const sources: VodSourceSegment[] = [];
    for (const record of records) {
      try {
        const absolutePath = ensureFileUnderRoot(recordingsRoot, record.filePath);
        if (existsSync(absolutePath)) {
          if (statSync(absolutePath).size <= 1024) continue;
        } else if (!this.nuvemDisponivel(record)) {
          // Só-na-nuvem entra: /play serve do bucket com Range. Pulá-la fazia
          // o modo contínuo classificar o instante como "gap" e SELECIONAR O
          // PRÓXIMO segmento — vídeo errado por causa do offload.
          continue;
        }
      } catch {
        continue;
      }
      const cached = diagnosticsCache[record.id]?.diagnostics as { video?: { codec?: string | null } } | undefined;
      sources.push({
        id: record.id,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationSeconds: record.durationSeconds,
        codec: cached?.video?.codec ?? null,
      });
    }

    const plan = planVodPlaylist({ segments: sources, from: fromDate, to: toDate, maxSegments });
    // Playlist vazia é RESPOSTA, não erro: "não há vídeo neste intervalo" e
    // "a API falhou" precisam ser distinguíveis pelo front — o 404 daqui era
    // engolido em silêncio e o modo contínuo simplesmente nunca ligava.

    // Token de playback JÁ EXISTENTE, um por segmento — o mesmo que /play,
    // /thumbnail e /preview-sprite verificam. Nada de autenticação nova.
    const tokenByRecording = new Map<string, string>();
    for (const segment of plan.segments) {
      const token = await this.authService.createPlaybackToken(user.id, segment.recordingId);
      tokenByRecording.set(segment.recordingId, token.playToken);
    }
    // `.mp4` ANTES da query não é enfeite: player baseado em ffmpeg >= 7 recusa
    // segmento de HLS sem extensão de mídia na URL (allowed_segment_extensions).
    // O alias `/recordings/:id/play.mp4` cai no MESMO handler de `/play`.
    // URL RELATIVA, não absoluta. A playlist é servida em
    // `<prefixo>/recordings/vod.m3u8`, e externamente esse prefixo é `/api`
    // (o nginx reescreve antes de chegar aqui, então a API não o enxerga).
    // Com `/recordings/...` absoluto, VLC e ffmpeg pediam à raiz do domínio e
    // caíam na SPA em vez da API — a playlist só funcionava por acidente
    // dentro do próprio player web. Relativo resolve contra a URL da playlist
    // e fica correto nos dois casos, sem a API precisar adivinhar o prefixo.
    const buildSegmentUrl = (segment: { recordingId: string }) =>
      `${segment.recordingId}/play.mp4?token=${encodeURIComponent(tokenByRecording.get(segment.recordingId) ?? '')}`;

    return {
      cameraId,
      from: plan.from,
      to: plan.to,
      playlist: renderVodPlaylist(plan, buildSegmentUrl),
      segmentCount: plan.segments.length,
      startOffsetSeconds: plan.startOffsetSeconds,
      totalDurationSeconds: plan.totalDurationSeconds,
      targetDurationSeconds: plan.targetDurationSeconds,
      discontinuities: plan.discontinuities,
      truncated: plan.truncated,
      skipped: plan.skipped,
      coverage: plan.coverage,
      segments: plan.segments.map((segment) => ({ ...segment, playUrl: buildSegmentUrl(segment) })),
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
    let filePath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
    if (!existsSync(filePath)) {
      // ffmpeg precisa de um caminho real: traz da nuvem para o cache local.
      const local = await this.materializeFromCloud(recording);
      if (local) filePath = local;
    }
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
      await this.execFfmpegLowPriority([
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
        await this.execFfmpegLowPriority([
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
      await this.execFfmpegLowPriority([
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

  // ── EXPORTAÇÃO POR INTERVALO (atravessando segmentos) ───────────────────────
  //
  // O `exportClip` acima recebe UM `recordingId` e offsets DENTRO daquele
  // arquivo. Com segmento de 300s (60s no modo movimento), um evento de 3
  // minutos que cruza a borda NÃO CABE num segmento — e isso é prova judicial.
  // O Frigate exporta por INTERVALO (`frigate/api/export.py`), juntando os N
  // segmentos com `-c copy` e só reencodando quando é obrigatório; é o que está
  // implementado daqui para baixo. O `exportClip` continua existindo: outros
  // consumidores (investigações, front atual) dependem dele.

  private rangeExportRoot(): string {
    return process.env.RECORDINGS_ROOT ?? './storage/recordings';
  }

  /** Janela máxima exportável de uma vez. Inválido no .env cai no padrão e AVISA. */
  private rangeExportMaxHours(): number {
    return envNumber('RECORDING_EXPORT_MAX_HOURS', 6, {
      min: 1,
      max: 72,
      onInvalid: (message) => this.logger.warn(message),
    });
  }

  /**
   * Caminho FINAL do arquivo, derivado da identidade (câmera+intervalo+perfil).
   * É o que dá idempotência em disco: repetir o pedido encontra o arquivo pronto
   * em vez de gerar uma segunda cópia da mesma prova (e `ExportedClip.filePath`
   * é UNIQUE no banco, fechando a porta de vez).
   */
  private buildRangeExportOutputPath(identity: RangeExportIdentity): string {
    const inicio = new Date(identity.fromMs);
    return join(
      this.rangeExportRoot(),
      'clips',
      identity.cameraId,
      `${inicio.getUTCFullYear()}`,
      `${String(inicio.getUTCMonth() + 1).padStart(2, '0')}`,
      `${String(inicio.getUTCDate()).padStart(2, '0')}`,
      buildRangeExportFileName(identity),
    );
  }

  private serializeExportedClip(clip: {
    id: string;
    cameraId: string;
    filePath: string;
    startedAt: Date;
    endedAt: Date;
    durationSeconds: number;
    sizeBytes?: bigint | null;
    fileSha256?: string | null;
  }) {
    return {
      id: clip.id,
      cameraId: clip.cameraId,
      filePath: clip.filePath,
      startedAt: clip.startedAt,
      endedAt: clip.endedAt,
      durationSeconds: clip.durationSeconds,
      sizeBytes: clip.sizeBytes?.toString() ?? null,
      fileSha256: clip.fileSha256 ?? null,
      downloadUrl: `/recordings/clips/${clip.id}/download`,
    };
  }

  /**
   * Codecs do segmento. Usa o diagnóstico JÁ gravado (sem ffprobe novo) e só cai
   * no probe quando o cache não sabe. Devolve também a duração medida: segmento
   * ABERTO (gravando agora) não tem `endedAt` nem `durationSeconds` no banco, e
   * sem isso o trecho mais recente — justo o do fato — ficaria de fora.
   */
  private async resolveSegmentCodecs(
    recordingId: string,
    filePath: string,
    cache?: Record<string, RecordingHealthCacheEntry>,
  ): Promise<{ videoCodec: string | null; audioCodec: string | null; durationSeconds?: number | null }> {
    const diagnostics = (cache ?? this.readDiagnosticsCache())[recordingId]?.diagnostics as
      | { video?: { codec?: string | null }; audio?: { codec?: string | null }; durationSeconds?: number | null }
      | undefined;
    if (diagnostics?.video?.codec) {
      return {
        videoCodec: diagnostics.video.codec,
        audioCodec: diagnostics.audio?.codec ?? null,
        durationSeconds: diagnostics.durationSeconds ?? null,
      };
    }
    const probe = await this.inspectClipExternalPlayback(filePath);
    return { videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, durationSeconds: probe.durationSeconds };
  }

  /** Segmentos do intervalo que EXISTEM em disco, já com codec resolvido. */
  private async collectRangeSegments(identity: RangeExportIdentity): Promise<RangeSourceSegment[]> {
    const fromDate = new Date(identity.fromMs);
    const toDate = new Date(identity.toMs);
    const lookbackMinutes = envNumber('RECORDING_EXPORT_LOOKBACK_MINUTES', 60, {
      min: 1,
      max: 360,
      integer: true,
      onInvalid: (message) => this.logger.warn(message),
    });
    const records = await this.prisma.recording.findMany({
      where: {
        cameraId: identity.cameraId,
        startedAt: { gte: new Date(identity.fromMs - lookbackMinutes * 60_000), lte: toDate },
        // fechada terminando depois do início pedido OU ainda aberta (gravando)
        OR: [{ endedAt: { gte: fromDate } }, { endedAt: null }],
      },
      select: { id: true, startedAt: true, endedAt: true, durationSeconds: true, filePath: true, cloudKey: true, cloudUploadedAt: true, cloudMissingSince: true },
      orderBy: { startedAt: 'asc' },
      take: 5_000,
    });

    const root = this.rangeExportRoot();
    const cache = this.readDiagnosticsCache();
    const segments: RangeSourceSegment[] = [];
    for (const record of records) {
      let absolutePath: string;
      try {
        absolutePath = ensureFileUnderRoot(root, record.filePath);
        // Arquivo sumido (retenção, disco trocado) NÃO entra: um buraco no meio
        // da emenda quebra o arquivo exportado inteiro.
        if (!existsSync(absolutePath) || statSync(absolutePath).size <= 0) continue;
      } catch {
        continue;
      }
      const codecs = await this.resolveSegmentCodecs(record.id, absolutePath, cache);
      segments.push({
        id: record.id,
        filePath: absolutePath,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationSeconds: record.durationSeconds ?? codecs.durationSeconds ?? null,
        videoCodec: codecs.videoCodec,
        audioCodec: codecs.audioCodec,
      });
    }
    return segments;
  }

  /** Seam única para executar o ffmpeg da exportação por intervalo. */
  private async runRangeExportAttempt(args: string[]): Promise<void> {
    await this.execFfmpegLowPriority(args, {
      timeout: envNumber('RECORDING_EXPORT_TIMEOUT_MS', 30 * 60_000, {
        min: 60_000,
        max: 6 * 60 * 60_000,
        integer: true,
        onInvalid: (message) => this.logger.warn(message),
      }),
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  /**
   * Exporta o intervalo [from, to) de uma câmera como UM arquivo contínuo.
   *
   * Roda no worker da fila (nunca no request). Mantém o que o `exportClip` já
   * garantia — gate de acesso, validação de reprodução externa e SHA-256 da
   * evidência — e acrescenta o manifesto de proveniência ao lado do vídeo.
   */
  async exportCameraRange(
    user: AuthUser,
    params: {
      cameraId: string;
      from: string | Date | number;
      to: string | Date | number;
      profile?: RangeExportProfile | string | null;
      reason: string;
      label?: string | null;
    },
    hooks?: { onProgress?: (progress: { step: RangeExportStep; percent: number }) => void | Promise<void> },
  ) {
    const identity = normalizeRangeExportIdentity(params);
    if (identity.toMs <= identity.fromMs) {
      throw new BadRequestException('Intervalo inválido: o fim precisa ser depois do início.');
    }
    const maxHours = this.rangeExportMaxHours();
    if (identity.toMs - identity.fromMs > maxHours * 60 * 60_000) {
      throw new BadRequestException(`Intervalo máximo de exportação é de ${maxHours}h.`);
    }
    // Gate de conteúdo ANTES de tocar em qualquer arquivo de câmera — o mesmo
    // do exportClip. Defesa em profundidade: o controller já conferiu, mas o job
    // roda depois, fora do request, e pode ser reprocessado.
    await this.accessControlService.assertCanPlaybackCamera(user, identity.cameraId);

    const report = async (step: RangeExportStep) => {
      const progress = rangeExportProgress(step);
      await hooks?.onProgress?.(progress);
      return progress;
    };
    await report('planning');

    const outputPath = this.buildRangeExportOutputPath(identity);
    const existing = await this.prisma.exportedClip.findUnique({ where: { filePath: outputPath } });
    if (existing && existsSync(outputPath)) {
      await report('done');
      return { ...this.serializeExportedClip(existing as any), reused: true as const };
    }

    const segments = await this.collectRangeSegments(identity);
    const plan = planRangeExport({
      segments,
      from: identity.fromMs,
      to: identity.toMs,
      forceTranscode: identity.profile === 'compatible',
      copySafetySeconds: envNumber('RECORDING_EXPORT_COPY_SAFETY_SECONDS', 2, {
        min: 0,
        max: 30,
        onInvalid: (message) => this.logger.warn(message),
      }),
      maxSegments: envNumber('RECORDING_EXPORT_MAX_SEGMENTS', 240, {
        min: 1,
        max: 2_000,
        integer: true,
        onInvalid: (message) => this.logger.warn(message),
      }),
    });
    if (!plan.parts.length) {
      throw new NotFoundException('Nenhuma gravação reproduzível neste intervalo.');
    }

    const manifestDir = join(this.rangeExportRoot(), '.range-export');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, `${buildRangeExportJobId(identity)}.txt`);
    writeFileSync(manifestPath, buildConcatManifest(plan), 'utf-8');
    mkdirSync(join(outputPath, '..'), { recursive: true });
    // Escreve num TEMPORÁRIO e só depois renomeia: o nome final nunca aponta
    // para um arquivo pela metade que alguém baixaria como prova.
    const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;

    const hwaccel = await this.resolveTranscodeHwaccel();
    if (hwaccel.degraded) {
      this.logger.warn(`Aceleração por hardware indisponível: ${hwaccel.reason}`);
    }
    const attempts = buildRangeExportAttempts({
      plan,
      manifestPath,
      output: tmpPath,
      hwaccel: hwaccel.preset ? { preset: hwaccel.preset, device: hwaccel.device } : null,
    });

    const limpar = () => {
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
      try { rmSync(manifestPath, { force: true }); } catch { /* best-effort */ }
    };

    let usada: (typeof attempts)[number] | null = null;
    let externalPlayback: Awaited<ReturnType<RecordingsService['inspectClipExternalPlayback']>> | null = null;
    let ultimoErro: string | null = null;
    try {
      for (const attempt of attempts) {
        await report(attempt.kind === 'copy' ? 'copying' : 'encoding');
        try {
          await this.runRangeExportAttempt(attempt.args);
          // Código de saída 0 NÃO é prova: falha de hwaccel costuma sair 0 sem
          // escrever nada, e um copy mal emendado sai 0 com vídeo ilegível.
          if (existsSync(tmpPath) && statSync(tmpPath).size > 0) {
            await report('validating');
            const inspecao = await this.inspectClipExternalPlayback(tmpPath);
            if (inspecao.ok) {
              if (attempt.preset) reportHwaccelSuccess(attempt.preset);
              usada = attempt;
              externalPlayback = inspecao;
              break;
            }
            ultimoErro = `arquivo gerado não reproduz fora do sistema: ${inspecao.reasons.join(', ') || 'motivo desconhecido'}`;
          } else {
            ultimoErro = 'o ffmpeg terminou sem produzir arquivo';
          }
        } catch (error) {
          ultimoErro = error instanceof Error ? sanitizeSensitiveText(error.message) : String(error);
        }
        try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
        if (attempt.preset) {
          const emQuarentena = reportHwaccelFailure(attempt.preset);
          this.logger.warn(
            `Exportação por intervalo com aceleração ${attempt.preset} FALHOU (${ultimoErro}); refazendo em CPU` +
              (emQuarentena ? ' — preset colocado em QUARENTENA após falhas repetidas.' : '.'),
          );
        } else if (attempt.kind === 'copy') {
          this.logger.warn(`Stream-copy do intervalo FALHOU (${ultimoErro}); refazendo com transcode.`);
        }
      }

      if (!usada) {
        throw new InternalServerErrorException(
          `Falha ao exportar o intervalo: ${ultimoErro ?? 'erro desconhecido'}`,
        );
      }

      await report('hashing');
      const fileSha256 = await this.computeFileSha256(tmpPath);
      const sizeBytes = statSync(tmpPath).size;
      renameSync(tmpPath, outputPath); // atômico no mesmo filesystem

      // Manifesto de PROVENIÊNCIA ao lado do vídeo: qual segmento entrou, em que
      // ponto, o que faltava em disco e quem pediu. Arquivo emendado sem isso não
      // se defende em perícia.
      const startedAt = new Date(Date.parse(plan.coveredFrom as string));
      const endedAt = new Date(Date.parse(plan.coveredTo as string));
      const proveniencia = {
        cameraId: identity.cameraId,
        profile: identity.profile,
        requestedFrom: plan.requestedFrom,
        requestedTo: plan.requestedTo,
        coveredFrom: plan.coveredFrom,
        coveredTo: plan.coveredTo,
        strategy: plan.strategy,
        strategyUsed: usada.kind,
        strategyReasons: plan.strategyReasons,
        leadInSeconds: plan.leadInSeconds,
        leadOutSeconds: plan.leadOutSeconds,
        durationSeconds: plan.totalDurationSeconds,
        continuous: plan.continuous,
        gaps: plan.gaps,
        truncated: plan.truncated,
        parts: plan.parts.map((part) => ({
          recordingId: part.recordingId,
          segmentStartedAt: part.segmentStartedAt,
          inpointSeconds: part.inpointSeconds,
          outpointSeconds: part.outpointSeconds,
          offsetSeconds: part.offsetSeconds,
          durationSeconds: part.durationSeconds,
        })),
        fileSha256,
        sizeBytes,
        generatedAt: new Date().toISOString(),
        reason: params.reason ?? null,
        requestedBy: { userId: user.id, userName: user.name },
      };
      writeFileSync(outputPath.replace(/\.mp4$/, '.json'), JSON.stringify(proveniencia, null, 2), 'utf-8');

      const clip = await this.prisma.exportedClip.create({
        data: {
          cameraId: identity.cameraId,
          // O schema exige UMA gravação de origem: fica a primeira do intervalo.
          // A lista COMPLETA vive no manifesto de proveniência e na auditoria.
          sourceRecordingId: plan.parts[0].recordingId,
          filePath: outputPath,
          startedAt,
          endedAt,
          durationSeconds: Math.max(1, Math.round(plan.totalDurationSeconds)),
          sizeBytes: BigInt(sizeBytes),
          fileSha256,
          createdByUserId: user.id,
          createdByUserName: user.name,
        },
      });

      // O job roda FORA do request, então a trilha é escrita aqui. Best-effort de
      // propósito: o arquivo e o manifesto já existem em disco — derrubar a
      // exportação pronta por causa de um insert de log seria pior.
      try {
        await this.prisma.auditLog.create({
          data: {
            userId: user.id,
            action: 'recording.range.export',
            entityType: 'ExportedClip',
            entityId: clip.id,
            metadata: proveniencia as unknown as object,
          },
        });
      } catch (error) {
        this.logger.error(
          `Falha ao registrar auditoria da exportação por intervalo ${clip.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      await report('done');
      return {
        ...this.serializeExportedClip(clip as any),
        strategy: plan.strategy,
        strategyUsed: usada.kind,
        strategyReasons: plan.strategyReasons,
        segmentCount: plan.parts.length,
        sourceRecordingIds: plan.parts.map((part) => part.recordingId),
        requestedFrom: plan.requestedFrom,
        requestedTo: plan.requestedTo,
        requestedSeconds: plan.requestedSeconds,
        coveredFrom: plan.coveredFrom,
        coveredTo: plan.coveredTo,
        coveredSeconds: plan.coveredSeconds,
        leadInSeconds: plan.leadInSeconds,
        leadOutSeconds: plan.leadOutSeconds,
        continuous: plan.continuous,
        gaps: plan.gaps,
        truncated: plan.truncated,
        externalPlayback: {
          validated: true,
          container: externalPlayback?.container ?? null,
          videoCodec: externalPlayback?.videoCodec ?? null,
          audioCodec: externalPlayback?.audioCodec ?? null,
          durationSeconds: externalPlayback?.durationSeconds ?? null,
        },
      };
    } finally {
      limpar();
    }
  }

  /**
   * Ponto de entrada do WORKER. O usuário é resolvido AQUI, não no enfileiramento:
   * entre o clique e a execução o operador pode ter sido desativado, e `me()`
   * recusa usuário inativo — a fila não pode virar porta dos fundos de quem
   * perdeu o acesso. Em seguida o gate por câmera roda de novo dentro do export.
   */
  async runRangeExportJob(
    data: {
      cameraId: string;
      from: string;
      to: string;
      profile?: RangeExportProfile | string | null;
      reason?: string;
      label?: string | null;
      requestedByUserId: string;
    },
    hooks?: { onProgress?: (progress: { step: RangeExportStep; percent: number }) => void | Promise<void> },
  ) {
    const user = await this.authService.me(data.requestedByUserId);
    return this.exportCameraRange(
      user as AuthUser,
      {
        cameraId: data.cameraId,
        from: data.from,
        to: data.to,
        profile: data.profile ?? 'auto',
        reason: data.reason ?? '',
        label: data.label ?? null,
      },
      hooks,
    );
  }

  private rangeExportJobOptions(jobId: string) {
    return {
      jobId,
      attempts: envNumber('RECORDING_EXPORT_MAX_ATTEMPTS', 3, {
        min: 1,
        max: 10,
        integer: true,
        onInvalid: (message: string) => this.logger.warn(message),
      }),
      backoff: { type: 'exponential' as const, delay: 30_000 },
      removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
      removeOnFail: { age: 30 * 24 * 3600, count: 500 },
    };
  }

  /**
   * Enfileira a exportação e volta na hora. Sem isto, três operadores clicando
   * "Exportar" disparam três FFmpeg competindo com a GRAVAÇÃO das câmeras —
   * e o modo de falha não é a exportação lenta, é a gravação furar.
   */
  async enqueueCameraRangeExport(
    user: AuthUser,
    params: {
      cameraId: string;
      from: string;
      to: string;
      profile?: RangeExportProfile | string | null;
      reason: string;
      label?: string | null;
    },
  ) {
    let identity: RangeExportIdentity;
    try {
      identity = normalizeRangeExportIdentity(params);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Intervalo inválido.');
    }
    if (identity.toMs <= identity.fromMs) {
      throw new BadRequestException('Intervalo inválido: "to" precisa ser depois de "from".');
    }
    const maxHours = this.rangeExportMaxHours();
    if (identity.toMs - identity.fromMs > maxHours * 60 * 60_000) {
      throw new BadRequestException(`Intervalo máximo de exportação é de ${maxHours}h.`);
    }
    await this.accessControlService.assertCanPlaybackCamera(user, identity.cameraId);

    const jobId = buildRangeExportJobId(identity);
    const outputPath = this.buildRangeExportOutputPath(identity);
    const pronto = await this.prisma.exportedClip.findUnique({ where: { filePath: outputPath } });
    // "Pronto" é pronto NO DISCO: linha no banco apontando para arquivo que a
    // retenção apagou não pode ser vendida como exportação concluída.
    if (pronto && existsSync(outputPath)) {
      return {
        jobId,
        cameraId: identity.cameraId,
        status: 'completed' as const,
        progress: rangeExportProgress('done'),
        clip: this.serializeExportedClip(pronto as any),
        reused: true as const,
      };
    }

    await this.rangeExportQueue.add(
      RANGE_EXPORT_JOB_NAME,
      {
        cameraId: identity.cameraId,
        from: new Date(identity.fromMs).toISOString(),
        to: new Date(identity.toMs).toISOString(),
        profile: identity.profile,
        reason: params.reason,
        label: params.label ?? null,
        requestedByUserId: user.id,
      },
      this.rangeExportJobOptions(jobId),
    );

    return {
      jobId,
      cameraId: identity.cameraId,
      status: 'queued' as const,
      progress: rangeExportProgress('queued'),
      from: new Date(identity.fromMs).toISOString(),
      to: new Date(identity.toMs).toISOString(),
      profile: identity.profile,
    };
  }

  private normalizeJobProgress(raw: unknown): { step: string; percent: number } {
    if (raw && typeof raw === 'object') {
      const value = raw as { step?: unknown; percent?: unknown };
      return {
        step: typeof value.step === 'string' ? value.step : 'queued',
        percent: parseFiniteNumber(value.percent) ?? 0,
      };
    }
    return { step: 'queued', percent: parseFiniteNumber(raw) ?? 0 };
  }

  async getCameraRangeExportStatus(user: AuthUser, jobId: string) {
    const job = await this.rangeExportQueue.getJob(jobId);
    if (!job) throw new NotFoundException('Exportação não encontrada.');
    const data = (job.data ?? {}) as { cameraId?: string; from?: string; to?: string; profile?: string };
    // O gate confere a câmera DO JOB — quem consulta pode não ter acesso a ela.
    await this.accessControlService.assertCanPlaybackCamera(user, String(data.cameraId ?? ''));
    const status = await job.getState();
    return {
      jobId,
      cameraId: data.cameraId ?? null,
      from: data.from ?? null,
      to: data.to ?? null,
      profile: data.profile ?? 'auto',
      status,
      progress: this.normalizeJobProgress(job.progress),
      attemptsMade: job.attemptsMade ?? 0,
      failedReason: (job as { failedReason?: string }).failedReason ?? null,
      result: (job as { returnvalue?: unknown }).returnvalue ?? null,
    };
  }

  /**
   * Recupera exportações ÓRFÃS: o job ficou `active` no Redis porque o processo
   * que o executava morreu (deploy, OOM, queda de energia). Sem isto a tela do
   * operador mostra "exportando" para sempre e o trabalho nunca sai.
   *
   * Job com lock ativo (worker vivo) recusa `remove()` — é assim que não
   * duplicamos um FFmpeg em cima do mesmo arquivo.
   */
  async recoverOrphanRangeExports() {
    const jobs = ((await this.rangeExportQueue.getJobs(['active'])) ?? []).filter(
      (job: { name?: string }) => !job?.name || job.name === RANGE_EXPORT_JOB_NAME,
    );
    const decisions = planOrphanRecovery(
      jobs.map((job: any) => ({
        id: String(job.id),
        processedOn: job.processedOn ?? null,
        heartbeatAt: (job.progress as { at?: number } | null)?.at ?? null,
        attemptsMade: job.attemptsMade ?? 0,
      })),
      {
        now: Date.now(),
        staleAfterMs: envNumber('RECORDING_EXPORT_ORPHAN_STALE_MS', 10 * 60_000, {
          min: 60_000,
          max: 6 * 60 * 60_000,
          integer: true,
          onInvalid: (message) => this.logger.warn(message),
        }),
        maxAttempts: envNumber('RECORDING_EXPORT_MAX_ATTEMPTS', 3, {
          min: 1,
          max: 10,
          integer: true,
          onInvalid: (message) => this.logger.warn(message),
        }),
      },
    );

    let requeued = 0;
    let abandoned = 0;
    let kept = 0;
    let skipped = 0;
    for (const decision of decisions) {
      const job: any = jobs.find((candidate: any) => String(candidate.id) === decision.id);
      if (!job) continue;
      if (decision.action === 'keep') {
        kept += 1;
        continue;
      }
      try {
        await job.remove();
      } catch (error) {
        // Lock ativo: existe worker trabalhando apesar do batimento velho.
        skipped += 1;
        this.logger.warn(
          `Exportação ${decision.id} parecia órfã (${decision.reason}) mas ainda está travada por um worker: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (decision.action === 'requeue') {
        await this.rangeExportQueue.add(
          RANGE_EXPORT_JOB_NAME,
          job.data,
          this.rangeExportJobOptions(decision.id),
        );
        requeued += 1;
        this.logger.warn(`Exportação órfã ${decision.id} (${decision.reason}) devolvida à fila.`);
      } else {
        abandoned += 1;
        this.logger.error(
          `Exportação ${decision.id} ABANDONADA (${decision.reason}): já consumiu as tentativas sem concluir.`,
        );
      }
    }

    return { scanned: decisions.length, requeued, abandoned, kept, skipped };
  }

  async downloadExportedClip(clipId: string, res: Response) {
    const clip = await this.ensureExportedClipExists(clipId);
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const filePath = ensureFileUnderRoot(recordingsRoot, clip.filePath);
    if (!existsSync(filePath)) {
      throw new NotFoundException('Arquivo do clip não encontrado no disco.');
    }
    res.setHeader('Content-Disposition', `attachment; filename="clip-${clip.id}.mp4"`);
    this.pipeArquivo(res, filePath);
  }

  async createThumbnailTokens(user: AuthUser, recordingIds: string[]) {
    const uniqueIds = [...new Set(recordingIds)];
    const recordings = await this.prisma.recording.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, cameraId: true, camera: { select: { isPrivate: true } } },
    });

    const tokenMap: Record<string, string> = {};
    for (const rec of recordings) {
      // Emissão de token é acesso ao histórico: respeita tanto privacidade
      // quanto RESTRICTED, mesmo que o consumidor revalide novamente.
      const canPlayback = await this.accessControlService.canPlaybackCamera(user, rec.cameraId);
      if (!canPlayback) continue;
      const token = await this.authService.createPlaybackToken(user.id, rec.id);
      tokenMap[rec.id] = token.playToken;
    }

    return tokenMap;
  }

  async deleteAllRecordings() {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const [recordings, clips] = await Promise.all([
      this.prisma.recording.findMany({ select: { id: true, cameraId: true, filePath: true, sizeBytes: true } }),
      this.prisma.exportedClip.findMany({ select: { id: true, filePath: true, sizeBytes: true } }),
    ]);

    let deletedBytes = BigInt(0);
    for (const item of [...recordings, ...clips]) {
      deletedBytes += item.sizeBytes ?? BigInt(0);
    }
    const filePaths = [
      ...clips.map((clip) => ensureFileUnderRoot(recordingsRoot, clip.filePath)),
      ...recordings.flatMap((recording) => {
        const fullPath = ensureFileUnderRoot(recordingsRoot, recording.filePath);
        const extension = extname(fullPath);
        const base = extension ? fullPath.slice(0, -extension.length) : fullPath;
        return [
          fullPath,
          `${base}.thumb.jpg`,
          buildTimelinePreviewPath(fullPath),
          `${fullPath}.invalid.json`,
          `${fullPath}.orphan-quarantine.json`,
          join(recordingsRoot, '.playback-compatible', recording.cameraId, `${recording.id}.mp4`),
        ];
      }),
      ensureFileUnderRoot(recordingsRoot, '.playback-compatible'),
      ensureFileUnderRoot(recordingsRoot, '.diagnostics-cache'),
    ];

    let staged: StagedFileDeletion | null = null;
    let dbResult: { clipsDeleted: number; recordingsDeleted: number };
    try {
      dbResult = await this.prisma.$transaction(async (tx) => {
        // $executeRawUnsafe: pg_advisory_xact_lock devolve `void` e o Prisma
        // levanta P2010 tentando desserializar. Ver retention.service.ts.
        await tx.$executeRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtext('drac:recordings:file-delete'))",
        );
        staged = await stageFileDeletion(
          recordingsRoot,
          filePaths,
          [
            ...recordings.map((recording) => ({ model: 'recording' as const, id: recording.id })),
            ...clips.map((clip) => ({ model: 'exportedClip' as const, id: clip.id })),
          ],
        );
        const clipsDeleted = await tx.exportedClip.deleteMany({});
        const recordingsDeleted = await tx.recording.deleteMany({});
        return {
          clipsDeleted: clipsDeleted.count,
          recordingsDeleted: recordingsDeleted.count,
        };
      });
    } catch (error) {
      if (staged) {
        try {
          await requireStagedDeletion(staged).rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Falha no banco e na restauração dos arquivos de gravação.',
          );
        }
      }
      throw error;
    }
    const committedStage = requireStagedDeletion(staged);
    const cleanup = await committedStage.commit();
    if (cleanup.cleanupDeferred) {
      this.logger.warn('Limpeza física do delete-all ficou pendente no journal para o próximo boot.');
    }

    return {
      recordingsDeleted: dbResult.recordingsDeleted,
      clipsDeleted: dbResult.clipsDeleted,
      filesDeleted: committedStage.movedFiles,
      filesMissing: committedStage.missingFiles,
      fileDeleteFailures: cleanup.cleanupDeferred ? 1 : 0,
      bytesDeleted: deletedBytes.toString(),
    };
  }
}
