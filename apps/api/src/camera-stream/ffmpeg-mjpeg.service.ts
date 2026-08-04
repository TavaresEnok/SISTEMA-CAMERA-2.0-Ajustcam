import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Camera } from '@prisma/client';
import { type Request, type Response } from 'express';
import { spawnSync, type ChildProcessByStdio } from 'child_process';
import { type Readable } from 'stream';
import { CamerasService } from '../cameras/cameras.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { buildRtspUrl, resolveDeliveryRtspProfile } from '../cameras/helpers/rtsp-url.helper';
import { isPushSourced } from '../cameras/helpers/rtmp-ingest.helper';
import { CryptoService } from '../common/crypto/crypto.service';
import { MediamtxProxyService } from './mediamtx-proxy.service';
import {
  execFileWithSecretUrl,
  spawnWithSecretUrl,
} from '../common/process/secret-url-process.helper';

type FfmpegStreamConfig = {
  rtspTransport: string;
  stimeoutUs: number;
  maxDelayUs: number;
  probesize: number;
  analyzedurationUs: number;
  mjpegFps: number;
  mjpegQ: number;
};

type StreamMetrics = {
  cameraId: string;
  totalRequests: number;
  successfulStarts: number;
  failedStarts: number;
  fallbackStarts: number;
  activeStreams: number;
  lastStartAt: string | null;
  lastStartupLatencyMs: number | null;
  avgStartupLatencyMs: number | null;
  startupSamples: number;
  lastEndAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

type RtspTransport = 'tcp' | 'udp' | 'http';
type StreamAttempt = {
  url: string;
  transport: RtspTransport;
  transcodeVideo: boolean;
  label: string;
};

type PosterCacheEntry = {
  buffer: Buffer;
  generatedAt: number;
};

@Injectable()
export class FfmpegMjpegService {
  private readonly logger = new Logger(FfmpegMjpegService.name);
  private readonly config: FfmpegStreamConfig;
  private readonly metrics = new Map<string, StreamMetrics>();
  private readonly incidentCooldownMs: number;
  private readonly incidentLastByCamera = new Map<string, { code: string; at: number }>();
  private readonly posterCache = new Map<string, PosterCacheEntry>();
  private readonly posterInFlight = new Map<string, Promise<PosterCacheEntry>>();
  private readonly posterCacheTtlMs: number;
  private readonly posterMaxConcurrency: number;
  private posterActiveCaptures = 0;
  private readonly posterCaptureWaiters: Array<() => void> = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly camerasService: CamerasService,
    private readonly cryptoService: CryptoService,
    private readonly mediamtxProxyService: MediamtxProxyService,
  ) {
    this.config = {
      rtspTransport: this.configService.get<string>('ffmpegRtspTransport') ?? 'tcp',
      stimeoutUs: Number(this.configService.get<number>('ffmpegStimeoutUs') ?? 8000000),
      maxDelayUs: Number(this.configService.get<number>('ffmpegMaxDelayUs') ?? 500000),
      probesize: Number(this.configService.get<number>('ffmpegProbesize') ?? 32768),
      analyzedurationUs: Number(this.configService.get<number>('ffmpegAnalyzedurationUs') ?? 1000000),
      mjpegFps: Number(this.configService.get<number>('mjpegFps') ?? 20),
      mjpegQ: Number(this.configService.get<number>('mjpegQ') ?? 5),
    };
    this.incidentCooldownMs = (this.configService.get<number>('streamIncidentCooldownSeconds') ?? 120) * 1000;
    this.posterCacheTtlMs = Math.max(
      15000,
      Number(this.configService.get<number>('livePosterCacheTtlMs') ?? 60000),
    );
    this.posterMaxConcurrency = Math.max(
      1,
      Math.min(6, Number(this.configService.get<number>('livePosterMaxConcurrency') ?? 3)),
    );
  }

  checkFfmpegAvailable() {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  }

  private getOrCreateMetrics(cameraId: string): StreamMetrics {
    const current = this.metrics.get(cameraId);
    if (current) return current;
    const created: StreamMetrics = {
      cameraId,
      totalRequests: 0,
      successfulStarts: 0,
      failedStarts: 0,
      fallbackStarts: 0,
      activeStreams: 0,
      lastStartAt: null,
      lastStartupLatencyMs: null,
      avgStartupLatencyMs: null,
      startupSamples: 0,
      lastEndAt: null,
      lastError: null,
      lastErrorAt: null,
    };
    this.metrics.set(cameraId, created);
    return created;
  }

  getStreamStats(cameraId?: string) {
    if (cameraId) {
      const metric = this.getOrCreateMetrics(cameraId);
      return {
        ...metric,
        generatedAt: new Date().toISOString(),
      };
    }

    const items = [...this.metrics.values()];
    const totals = items.reduce(
      (acc, item) => {
        acc.totalRequests += item.totalRequests;
        acc.successfulStarts += item.successfulStarts;
        acc.failedStarts += item.failedStarts;
        acc.fallbackStarts += item.fallbackStarts;
        acc.activeStreams += item.activeStreams;
        return acc;
      },
      { totalRequests: 0, successfulStarts: 0, failedStarts: 0, fallbackStarts: 0, activeStreams: 0 },
    );

    return {
      totals,
      cameras: items.sort((a, b) => b.totalRequests - a.totalRequests),
      generatedAt: new Date().toISOString(),
    };
  }

  private async maybeRegisterStreamIncident(cameraId: string, code: string, message: string, severity = 'WARN') {
    const now = Date.now();
    const prev = this.incidentLastByCamera.get(cameraId);
    if (prev && prev.code === code && now - prev.at < this.incidentCooldownMs) {
      return;
    }

    this.incidentLastByCamera.set(cameraId, { code, at: now });
    try {
      await this.camerasService.registerEvent(cameraId, code, severity, message, {
        source: 'camera-stream',
        at: new Date(now).toISOString(),
      });
    } catch (error) {
      this.logger.warn(`Falha ao registrar incidente de stream camera=${cameraId}: ${(error as Error).message}`);
    }
  }

  sanitizeRtspUrl(url: string): string {
    return sanitizeSensitiveText(url);
  }

  private getTransportCandidates(camera?: Camera): RtspTransport[] {
    const raw = [
      camera?.preferredRtspTransport?.toLowerCase() ?? this.config.rtspTransport,
      ...(this.configService.get<string>('ffmpegRtspFallbackTransports') ?? 'tcp,udp')
        .split(',')
        .map((item) => item.trim().toLowerCase()),
    ];
    const valid = raw.filter((item): item is RtspTransport => item === 'tcp' || item === 'udp' || item === 'http');
    return Array.from(new Set(valid.length ? valid : ['tcp', 'udp', 'http']));
  }

  buildFfmpegFlvArgs(rtspUrl: string, transport: RtspTransport, transcodeVideo: boolean, camera?: Camera): string[] {
    const commonInput = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-rtsp_transport',
      transport,
      '-timeout',
      String(this.config.stimeoutUs),
      '-probesize',
      '65536',
      '-analyzeduration',
      '500000',
      '-err_detect',
      'ignore_err',
      '-i',
      rtspUrl,
    ];

    const videoArgs = transcodeVideo
      ? [
          '-c:v',
          'libx264',
          '-preset',
          'superfast',
          '-crf',
          '22',
          '-tune',
          'zerolatency',
          '-pix_fmt',
          'yuv420p',
          '-g',
          String(Math.max(10, camera?.streamFps ?? 30)),
          '-keyint_min',
          String(Math.max(10, camera?.streamFps ?? 30)),
          '-sc_threshold',
          '0',
          ...(camera?.streamWidth && camera?.streamHeight ? ['-vf', `scale=${camera.streamWidth}:${camera.streamHeight}`] : []),
          ...(camera?.streamFps ? ['-r', String(camera.streamFps)] : []),
          ...(camera?.streamBitrateKbps ? ['-b:v', `${camera.streamBitrateKbps}k`, '-maxrate', `${camera.streamBitrateKbps}k`] : []),
        ]
      : [
          '-c:v',
          'copy',
        ];

    return [
      ...commonInput,
      ...videoArgs,
      ...(transcodeVideo ? [] : []),
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '1',
      '-af',
      'aresample=async=1',
      '-bf',
      '0',
      '-flags',
      'low_delay',
      '-fflags',
      '+genpts+discardcorrupt+nobuffer',
      '-flush_packets',
      '1',
      '-f',
      'flv',
      'pipe:1',
    ];
  }

  private buildAttempts(urls: string[], camera?: Camera): StreamAttempt[] {
    const transports = this.getTransportCandidates(camera);
    const selectedCodec = (camera?.streamVideoCodec ?? '').toLowerCase();
    const detectedCodec = (camera?.detectedVideoCodec ?? '').toLowerCase();
    const passthroughOriginal = selectedCodec === '' || selectedCodec === 'original';
    const codecForDecision = passthroughOriginal ? detectedCodec : selectedCodec;
    const sourceIsHevc =
      codecForDecision.includes('h265') ||
      codecForDecision.includes('hevc') ||
      codecForDecision.includes('265');
    // FLV no navegador precisa sair em H.264; "original" com fonte HEVC não pode usar copy.
    const browserNeedsH264 = sourceIsHevc;
    const forceTranscode = Boolean(
      browserNeedsH264 ||
      camera?.streamFps ||
      camera?.streamWidth ||
      camera?.streamHeight ||
      camera?.streamBitrateKbps,
    );
    const copyAttempts: StreamAttempt[] = [];
    const transcodeAttempts: StreamAttempt[] = [];

    if (!forceTranscode) {
      for (const transport of transports) {
        for (const [urlIndex, url] of urls.entries()) {
          copyAttempts.push({
            url,
            transport,
            transcodeVideo: false,
            label: `url${urlIndex + 1}-${transport}-copy`,
          });
        }
      }
    }
    for (const transport of transports) {
      for (const [urlIndex, url] of urls.entries()) {
        transcodeAttempts.push({
          url,
          transport,
          transcodeVideo: true,
          label: `url${urlIndex + 1}-${transport}-x264`,
        });
      }
    }

    return [...copyAttempts, ...transcodeAttempts];
  }

  private getRtspPortCandidates(primaryPort: number): number[] {
    const enablePortFallback = this.configService.get<boolean>('ffmpegRtspEnablePortFallback') === true;
    if (!enablePortFallback) {
      return [primaryPort];
    }
    const configured = (this.configService.get<string>('ffmpegRtspFallbackPorts') ?? '')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
    return Array.from(new Set([primaryPort, ...configured, 51488, 51489, 51490]));
  }

  private replaceRtspPort(rtspUrl: string, port: number): string {
    try {
      const parsed = new URL(rtspUrl);
      parsed.port = String(port);
      return parsed.toString();
    } catch {
      return rtspUrl;
    }
  }

  private expandUrlsWithPortFallbacks(urls: string[], primaryPort: number): string[] {
    const ports = this.getRtspPortCandidates(primaryPort);
    const expanded: string[] = [];
    for (const url of urls) {
      for (const port of ports) {
        expanded.push(this.replaceRtspPort(url, port));
      }
    }
    return Array.from(new Set(expanded));
  }

  private buildPosterArgs(rtspUrl: string, transport: RtspTransport): string[] {
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      transport,
      '-timeout',
      String(this.config.stimeoutUs),
      '-probesize',
      String(this.config.probesize),
      '-analyzeduration',
      String(this.config.analyzedurationUs),
      '-i',
      rtspUrl,
      '-an',
      '-sn',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuvj420p',
      '-frames:v',
      '1',
      '-q:v',
      '5',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ];
  }

  async getLivePosterFrame(cameraId: string): Promise<PosterCacheEntry> {
    const now = Date.now();
    const cached = this.posterCache.get(cameraId);
    if (cached && now - cached.generatedAt < this.posterCacheTtlMs) {
      return cached;
    }

    const inFlight = this.posterInFlight.get(cameraId);
    if (cached) {
      if (!inFlight) {
        const refresh = this.withPosterCaptureSlot(() => this.generateLivePosterFrame(cameraId))
          .catch((error) => {
            this.logger.debug(`Falha ao atualizar poster live camera=${cameraId}: ${(error as Error).message}`);
            return cached;
          })
          .finally(() => {
            this.posterInFlight.delete(cameraId);
          });
        this.posterInFlight.set(cameraId, refresh);
      }
      return cached;
    }

    if (inFlight) return inFlight;

    const promise = this.withPosterCaptureSlot(() => this.generateLivePosterFrame(cameraId)).finally(() => {
      this.posterInFlight.delete(cameraId);
    });
    this.posterInFlight.set(cameraId, promise);
    return promise;
  }

  private async withPosterCaptureSlot<T>(capture: () => Promise<T>): Promise<T> {
    if (this.posterActiveCaptures < this.posterMaxConcurrency) {
      this.posterActiveCaptures += 1;
    } else {
      // O resolve transfere a vaga liberada diretamente para este waiter.
      // Não incrementa novamente para evitar ultrapassar o limite quando uma
      // nova requisição chega no mesmo tick da liberação.
      await new Promise<void>((resolve) => this.posterCaptureWaiters.push(resolve));
    }
    try {
      return await capture();
    } finally {
      const next = this.posterCaptureWaiters.shift();
      if (next) {
        next();
      } else {
        this.posterActiveCaptures -= 1;
      }
    }
  }

  private async generateLivePosterFrame(cameraId: string): Promise<PosterCacheEntry> {
    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    if (!this.checkFfmpegAvailable()) {
      throw new ServiceUnavailableException('FFmpeg não está instalado no servidor.');
    }

    const gridUrl = await this.getGridPosterSource(cameraId);
    let urls: string[];
    if (isPushSourced(camera)) {
      // Uma câmera push não possui RTSP direto: ip/usuário/senha são marcadores
      // inertes. Se ela ainda não publicou, responder 503 é o único resultado
      // correto — montar rtsp://0.0.0.0 criava FFmpeg inútil e retornava 500.
      if (!gridUrl) {
        throw new ServiceUnavailableException('Câmera RTMP ainda não está publicando vídeo.');
      }
      urls = [gridUrl];
    } else {
      const password = this.cryptoService.decrypt(camera.passwordEncrypted);
      const primaryUrl = this.buildCameraRtspUrl(camera, password);
      const fallbackUrl = camera.subtype !== 0 ? this.buildCameraRtspUrl(camera, password, 0) : null;
      const directUrls = this.expandUrlsWithPortFallbacks(
        fallbackUrl ? [primaryUrl, fallbackUrl] : [primaryUrl],
        camera.rtspPort,
      );
      // Snapshot segue a mesma escolha leve da grade e pode cair no RTSP direto
      // apenas para câmeras pull. Nunca inicializa o path selected só para um frame.
      urls = Array.from(new Set([...(gridUrl ? [gridUrl] : []), ...directUrls]));
    }
    const transports = this.getTransportCandidates(camera);
    let lastError: unknown = null;

    for (const transport of transports) {
      for (const url of urls) {
        try {
          const { stdout } = await execFileWithSecretUrl('ffmpeg', this.buildPosterArgs(url, transport), url, {
            encoding: 'buffer',
            maxBuffer: 4 * 1024 * 1024,
            timeout: Math.max(2500, Math.ceil(this.config.stimeoutUs / 1000) + 1000),
          });
          if (Buffer.isBuffer(stdout) && stdout.length > 0) {
            const entry = { buffer: stdout, generatedAt: Date.now() };
            this.posterCache.set(cameraId, entry);
            return entry;
          }
        } catch (error) {
          lastError = error;
          // A message do erro do execFile carrega o stderr CRU do FFmpeg, que imprime a
          // URL de entrada inteira ("Error opening input file rtsp://user:senha@..."):
          // sanitizar só a `url` não basta — a credencial vaza pela message.
          this.logger.debug(
            `Falha ao gerar poster live camera=${cameraId} transport=${transport} url=${this.sanitizeRtspUrl(url)}: ${sanitizeSensitiveText(error)}`,
          );
        }
      }
    }

    const stale = this.posterCache.get(cameraId);
    if (stale) return stale;

    // Idem, e aqui é PIOR: esta message vai na RESPOSTA HTTP. Sem sanitizar, a senha da
    // câmera (embutida no stderr do FFmpeg) chegaria ao cliente que pediu o poster.
    throw new ServiceUnavailableException(
      lastError instanceof Error
        ? `Falha ao gerar imagem inicial: ${sanitizeSensitiveText(lastError)}`
        : 'Falha ao gerar imagem inicial.',
    );
  }

  private async getGridPosterSource(cameraId: string) {
    try {
      const selected = await this.mediamtxProxyService.resolveGridPosterSource(cameraId);
      return selected.sourceUrl;
    } catch (error) {
      this.logger.debug(
        `Poster seguirá pelo perfil direto configurado; seleção de grid indisponível camera=${cameraId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async getMediamtxLiveSource(cameraId: string) {
    if (!this.mediamtxProxyService.isEnabled()) return null;
    try {
      const ensured = await this.mediamtxProxyService.ensurePathForCamera(cameraId);
      const internalUrl = this.mediamtxProxyService.buildInternalRtspUrl(ensured.pathName);
      if (internalUrl) {
        this.logger.debug(`FLV usando restream interno MediaMTX camera=${cameraId}: ${internalUrl}`);
      }
      return internalUrl;
    } catch (error) {
      this.logger.debug(`FLV seguirá por RTSP direto; MediaMTX indisponível camera=${cameraId}: ${(error as Error).message}`);
      return null;
    }
  }

  // Deprecated overload kept internal for compatibility with existing call sites.
  private tryStartFlvProcess(rtspUrl: string, transport: RtspTransport, transcodeVideo: boolean, camera?: Camera) {
    const ffmpegArgs = this.buildFfmpegFlvArgs(rtspUrl, transport, transcodeVideo, camera);
    return spawnWithSecretUrl(
      'ffmpeg',
      ffmpegArgs,
      rtspUrl,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ) as ChildProcessByStdio<null, Readable, Readable>;
  }

  killProcessSafely(proc: ChildProcessByStdio<null, Readable, Readable> | null) {
    if (!proc) return;
    if (proc.killed) return;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 1500).unref();
  }

  private buildCameraRtspUrl(camera: Camera, password: string, subtypeOverride?: number): string {
    const hasRtspPath = typeof camera.rtspPath === 'string' && camera.rtspPath.trim().length > 0;
    const liveProfile = resolveDeliveryRtspProfile(camera);
    return buildRtspUrl({
      username: camera.username,
      password,
      ip: camera.ip,
      rtspPort: camera.rtspPort,
      rtspPath: hasRtspPath ? camera.rtspPath : undefined,
      channel: liveProfile.channel,
      subtype: subtypeOverride ?? liveProfile.subtype,
    });
  }

  private wireStreamToResponse(
    req: Request,
    res: Response,
    ffmpegProc: ChildProcessByStdio<null, Readable, Readable>,
    onFirstChunk: (chunk: Buffer) => void,
    onEarlyFail: () => void,
  ) {
    let gotFrameData = false;
    const startedAt = Date.now();

    ffmpegProc.stdout.on('data', (chunk) => {
      if (!gotFrameData) {
        gotFrameData = true;
        onFirstChunk(chunk);
        return;
      }
      if (!res.writableEnded) {
        res.write(chunk);
      }
    });

    ffmpegProc.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (!message) return;
      this.logger.debug(`FFmpeg: ${this.sanitizeRtspUrl(message)}`);
    });

    const onClose = () => {
      this.killProcessSafely(ffmpegProc);
    };

    req.on('close', onClose);
    res.on('close', onClose);

    ffmpegProc.on('close', () => {
      req.off('close', onClose);
      res.off('close', onClose);
      if (!gotFrameData && Date.now() - startedAt < 5000) {
        onEarlyFail();
        return;
      }
      if (!res.writableEnded) {
        res.end();
      }
    });
  }

  async startFlvStream(cameraId: string, req: Request, res: Response) {
    const metric = this.getOrCreateMetrics(cameraId);
    metric.totalRequests += 1;

    const camera = await this.camerasService.getCameraOrThrow(cameraId).catch(() => {
      metric.failedStarts += 1;
      metric.lastError = 'camera_not_found';
      metric.lastErrorAt = new Date().toISOString();
      throw new NotFoundException('Camera não encontrada.');
    });

    if (!this.checkFfmpegAvailable()) {
      metric.failedStarts += 1;
      metric.lastError = 'ffmpeg_unavailable';
      metric.lastErrorAt = new Date().toISOString();
      void this.maybeRegisterStreamIncident(
        cameraId,
        'STREAM_FFMPEG_UNAVAILABLE',
        'Falha ao iniciar stream: FFmpeg indisponível no servidor.',
        'ERROR',
      );
      throw new ServiceUnavailableException('FFmpeg não está instalado no servidor.');
    }

    const password = this.cryptoService.decrypt(camera.passwordEncrypted);
    const primaryUrl = this.buildCameraRtspUrl(camera, password);
    const fallbackUrl = camera.subtype !== 0 ? this.buildCameraRtspUrl(camera, password, 0) : null;
    const directUrls = fallbackUrl ? [primaryUrl, fallbackUrl] : [primaryUrl];
    const expandedDirectUrls = this.expandUrlsWithPortFallbacks(directUrls, camera.rtspPort);
    const mediamtxUrl = await this.getMediamtxLiveSource(cameraId);
    const urls = Array.from(new Set([...(mediamtxUrl ? [mediamtxUrl] : []), ...expandedDirectUrls]));
    const attempts = this.buildAttempts(urls, camera);

    let index = 0;
    let activeProc: ChildProcessByStdio<null, Readable, Readable> | null = null;
    let closed = false;
    let streamStarted = false;
    let streamOpenedForMetrics = false;

    const closeAll = () => {
      if (closed) return;
      closed = true;
      if (streamOpenedForMetrics) {
        metric.activeStreams = Math.max(0, metric.activeStreams - 1);
        metric.lastEndAt = new Date().toISOString();
        streamOpenedForMetrics = false;
      }
      this.killProcessSafely(activeProc);
      activeProc = null;
    };

    req.on('close', closeAll);
    res.on('close', closeAll);

    const startNext = () => {
      if (closed) return;
      if (index >= attempts.length) {
        if (!streamStarted && !res.headersSent) {
          metric.failedStarts += 1;
          metric.lastError = 'all_rtsp_attempts_failed';
          metric.lastErrorAt = new Date().toISOString();
          void this.maybeRegisterStreamIncident(
            cameraId,
            'STREAM_RTSP_START_FAILED',
            'Falha ao iniciar stream FLV após tentativas com RTSP principal/fallback, transportes e transcode.',
            'ERROR',
          );
          res.status(502).json({
            status: 'error',
            message: 'Falha ao iniciar stream FLV.',
          });
          return;
        }
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      const attempt = attempts[index++];
      const attemptNumber = index;
      this.logger.log(
        `Iniciando FFmpeg FLV camera=${camera.id} attempt=${attemptNumber}/${attempts.length} mode=${attempt.label} url=${this.sanitizeRtspUrl(attempt.url)}`,
      );
      const proc = this.tryStartFlvProcess(attempt.url, attempt.transport, attempt.transcodeVideo, camera);
      activeProc = proc;
      const attemptStartedAt = Date.now();

      this.wireStreamToResponse(
        req,
        res,
        proc,
        (firstChunk) => {
          if (!streamStarted && !res.headersSent) {
            streamStarted = true;
            metric.successfulStarts += 1;
            metric.lastStartAt = new Date().toISOString();
            const startupLatencyMs = Math.max(0, Date.now() - attemptStartedAt);
            metric.lastStartupLatencyMs = startupLatencyMs;
            metric.startupSamples += 1;
            if (metric.avgStartupLatencyMs == null) {
              metric.avgStartupLatencyMs = startupLatencyMs;
            } else {
              metric.avgStartupLatencyMs = Math.round(
                (metric.avgStartupLatencyMs * (metric.startupSamples - 1) + startupLatencyMs) / metric.startupSamples,
              );
            }
            if (attemptNumber > 1) {
              metric.fallbackStarts += 1;
            }
            if (!streamOpenedForMetrics) {
              streamOpenedForMetrics = true;
              metric.activeStreams += 1;
            }
            res.writeHead(200, {
              'Content-Type': 'video/x-flv',
              'Cache-Control': 'no-cache',
              Pragma: 'no-cache',
              Connection: 'keep-alive',
              'Access-Control-Allow-Origin': '*',
            });
          }
          if (!res.writableEnded) {
            res.write(firstChunk);
          }
        },
        () => {
          if (closed) return;
          this.killProcessSafely(proc);
          activeProc = null;
          metric.lastError = `early_stream_failure_attempt_${attemptNumber}`;
          metric.lastErrorAt = new Date().toISOString();
          void this.maybeRegisterStreamIncident(
            cameraId,
            'STREAM_EARLY_FAILURE',
            `Stream interrompido cedo na tentativa ${attemptNumber} (${attempt.label}).`,
          );
          startNext();
        },
      );
    };

    startNext();
  }
}
