import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CamerasService } from '../cameras/cameras.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { buildRtspUrl, resolveRecordingRtspProfile } from '../cameras/helpers/rtsp-url.helper';
import { spawnWithSecretUrl } from '../common/process/secret-url-process.helper';

type ClipState = {
  clipId: string;
  cameraId: string;
  userId: string;
  filePath: string;   // MP4 final servido no download
  recordPath: string; // .ts onde o ffmpeg grava (sempre remuxado p/ MP4)
  proc: ChildProcess;
  startedAt: number;
  stderrTail: string;
  exited: boolean;
  exitCode: number | null;
  autoStop: NodeJS.Timeout;
};

/**
 * Gravação de CLIPE sob demanda (exato do start ao stop), para "gravar no
 * celular" no app. Diferente da gravação contínua por segmentos: aqui um ffmpeg
 * dedicado grava a câmera com `-c copy` (SEM transcode = baixa CPU) num arquivo
 * temporário; o stop finaliza o MP4 (parada graciosa via 'q' → moov/faststart
 * válidos) e o app baixa o arquivo. Travas: teto de duração, limite de clipes
 * simultâneos e faxina periódica (nunca deixa ffmpeg/arquivo órfão).
 */
@Injectable()
export class ClipCaptureService {
  private readonly logger = new Logger(ClipCaptureService.name);
  private readonly clips = new Map<string, ClipState>();
  private readonly dir = path.join(os.tmpdir(), 'drac-clips');
  private readonly maxMs: number;
  private readonly maxConcurrent: number;
  private readonly ttlMs = 15 * 60 * 1000; // arquivos abandonados somem em 15min
  private ffmpegOk: boolean | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly camerasService: CamerasService,
    private readonly cryptoService: CryptoService,
  ) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.maxMs = Number(this.configService.get<number>('clipMaxSeconds') ?? 300) * 1000; // 5min padrão
    this.maxConcurrent = Number(this.configService.get<number>('clipMaxConcurrent') ?? 3);
    setInterval(() => this.sweep(), 60_000).unref?.();
  }

  private checkFfmpeg(): boolean {
    if (this.ffmpegOk === null) this.ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
    return this.ffmpegOk;
  }

  private activeCount(): number {
    let n = 0;
    for (const c of this.clips.values()) if (!c.exited) n += 1;
    return n;
  }

  async start(cameraId: string, userId: string): Promise<{ clipId: string }> {
    if (!this.checkFfmpeg()) throw new ServiceUnavailableException('FFmpeg não está instalado no servidor.');
    if (this.activeCount() >= this.maxConcurrent) {
      throw new ServiceUnavailableException('Muitas gravações de clipe em andamento. Tente novamente em instantes.');
    }
    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    const password = this.cryptoService.decrypt(camera.passwordEncrypted);
    const profile = resolveRecordingRtspProfile(camera);
    const rtsp = buildRtspUrl({
      username: camera.username,
      password,
      ip: camera.ip,
      rtspPort: camera.rtspPort,
      rtspPath: camera.rtspPath ?? undefined,
      channel: profile.channel,
      subtype: profile.subtype,
    });
    const transport = camera.preferredRtspTransport ?? this.configService.get<string>('ffmpegRtspTransport') ?? 'tcp';
    const clipId = randomUUID();
    const maxSeconds = Math.ceil(this.maxMs / 1000);
    // SEM transcode (cópia do codec original) = instantâneo, CPU quase zero,
    // qualidade máxima. SEMPRE gravamos em MPEG-TS (não MP4 direto) por 2 motivos:
    //  1) HEVC: gravar direto em MP4 com `-c:v copy` gera arquivo QUEBRADO
    //     (VPS/SPS/PPS não entram no hvcC ao conectar no meio do GOP) — testado.
    //     No TS os parâmetros ficam in-band; o remux TS→MP4 os extrai p/ o hvcC.
    //  2) O TS é formato de streaming: finaliza limpo com qualquer parada (q,
    //     SIGINT, até SIGKILL), sem depender da 2ª passada do `+faststart` do MP4.
    // O remux (rápido, sem re-encode) descobre o codec REAL do TS e só marca hvc1
    // se for HEVC — assim não confiamos no rótulo do banco (que pode estar errado:
    // câmera H.264 rotulada como h265 quebraria com -tag:v hvc1).
    const filePath = path.join(this.dir, `${clipId}.mp4`);
    const recordPath = path.join(this.dir, `${clipId}.ts`);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', transport,
      '-i', rtsp,
      '-t', String(maxSeconds), // teto de segurança (auto-encerra)
      '-c:v', 'copy',
      '-c:a', 'aac', // PCM/G.711 não entra em MP4/TS; AAC é barato e universal
      '-f', 'mpegts', '-y', recordPath,
    ];
    const proc = spawnWithSecretUrl(
      'ffmpeg',
      args,
      rtsp,
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    const state: ClipState = {
      clipId, cameraId, userId, filePath, recordPath, proc,
      startedAt: Date.now(), stderrTail: '', exited: false, exitCode: null,
      autoStop: setTimeout(() => { void this.stop(clipId, userId).catch(() => undefined); }, this.maxMs + 2000),
    };
    // Sanitiza JÁ AQUI (como recording-process-manager:843): o stderr do FFmpeg imprime a
    // URL de entrada inteira ("Error opening input file rtsp://user:senha@...") e este
    // stderrTail é devolvido ao cliente numa BadRequestException lá no stop(). Sem isto,
    // um VIEWER pedindo clipe de câmera offline recebia a SENHA da câmera na resposta.
    proc.stderr?.on('data', (b: Buffer) => {
      state.stderrTail = sanitizeSensitiveText(state.stderrTail + b.toString()).slice(-1000);
    });
    proc.on('close', (code) => { state.exited = true; state.exitCode = code; });
    proc.on('error', (e) => { state.exited = true; this.logger.error(`ffmpeg clip ${clipId}: ${sanitizeSensitiveText(e)}`); });
    this.clips.set(clipId, state);
    this.logger.log(`clip start ${clipId} camera=${cameraId} user=${userId}`);
    return { clipId };
  }

  async stop(clipId: string, userId: string): Promise<{ ok: boolean; sizeBytes: number; durationMs: number }> {
    const st = this.clips.get(clipId);
    if (!st || st.userId !== userId) throw new NotFoundException('Clipe não encontrado.');
    clearTimeout(st.autoStop);
    if (!st.exited) {
      // Parada graciosa: 'q' faz o ffmpeg fechar o container (moov/faststart OK).
      try { st.proc.stdin?.write('q'); } catch { /* ignore */ }
      const closed = await this.waitExit(st, 8000);
      if (!closed) { try { st.proc.kill('SIGINT'); } catch { /* */ } await this.waitExit(st, 4000); }
      if (!st.exited) { try { st.proc.kill('SIGKILL'); } catch { /* */ } }
    }
    // Remuxa o TS gravado → MP4 (cópia, sem transcode). É aqui que, no HEVC, os
    // parâmetros do vídeo entram no hvcC, deixando o arquivo tocável no celular.
    let tsBytes = 0;
    try { tsBytes = fs.statSync(st.recordPath).size; } catch { /* */ }
    if (tsBytes > 0) await this.remux(st.recordPath, st.filePath);
    try { fs.rmSync(st.recordPath, { force: true }); } catch { /* */ }
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(st.filePath).size; } catch { /* */ }
    const durationMs = Date.now() - st.startedAt;
    if (sizeBytes <= 0) {
      this.cleanup(clipId);
      // Dupla camada: o stderrTail já entra sanitizado, mas esta message vai direto no
      // corpo da resposta (http-exception.filter serializa o getResponse() verbatim).
      throw new BadRequestException(
        `Não foi possível gravar o clipe (câmera indisponível?). ${sanitizeSensitiveText(st.stderrTail).trim().slice(0, 200)}`,
      );
    }
    return { ok: true, sizeBytes, durationMs };
  }

  private waitExit(st: ClipState, timeoutMs: number): Promise<boolean> {
    if (st.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(st.exited), timeoutMs);
      st.proc.once('close', () => { clearTimeout(t); resolve(true); });
    });
  }

  // Remux TS→MP4 SEM transcode (cópia). Rápido (~centenas de ms), não re-encoda.
  // Descobre o codec REAL gravado (não confia no rótulo do banco): só o HEVC leva
  // `-tag:v hvc1` (jeito que os players do celular abrem); H.264 usa o tag padrão
  // (avc1) — forçar hvc1 num H.264 gera arquivo quebrado/vazio.
  private remux(src: string, dest: string): Promise<boolean> {
    let isHevc = false;
    try {
      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src,
      ], { encoding: 'utf8' });
      isHevc = /hevc|265/i.test(probe.stdout ?? '');
    } catch { /* na dúvida, trata como H.264 (tag padrão) */ }
    return new Promise((resolve) => {
      const p = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', src,
        '-c:v', 'copy', '-c:a', 'copy',
        ...(isHevc ? ['-tag:v', 'hvc1'] : []),
        '-movflags', '+faststart',
        '-f', 'mp4', '-y', dest,
      ], { stdio: 'ignore' });
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(false); }, 15000);
      p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
      p.on('error', () => { clearTimeout(t); resolve(false); });
    });
  }

  /** Caminho do arquivo do clipe SE existir e for do usuário (para download). */
  getClipFile(clipId: string, userId: string): string {
    const st = this.clips.get(clipId);
    if (!st || st.userId !== userId || !fs.existsSync(st.filePath)) throw new NotFoundException('Clipe não encontrado.');
    return st.filePath;
  }

  cleanup(clipId: string) {
    const st = this.clips.get(clipId);
    if (!st) return;
    clearTimeout(st.autoStop);
    if (!st.exited) { try { st.proc.kill('SIGKILL'); } catch { /* */ } }
    try { fs.rmSync(st.filePath, { force: true }); } catch { /* */ }
    if (st.recordPath !== st.filePath) { try { fs.rmSync(st.recordPath, { force: true }); } catch { /* */ } }
    this.clips.delete(clipId);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, st] of this.clips) {
      if (now - st.startedAt > this.ttlMs) this.cleanup(id);
    }
  }
}
