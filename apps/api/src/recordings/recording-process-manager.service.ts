import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma, RecordingSource, type Camera } from '@prisma/client';
import { type Queue } from 'bullmq';
import { execFile, spawnSync, type ChildProcessByStdio } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { planejarRotacao } from './helpers/rotacao-por-camera.helper';
import { ensureFileUnderRoot } from './helpers/safe-file.helper';
import { open, rename, readFile, statfs, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type Readable } from 'stream';
import { promisify } from 'node:util';
import Redis from 'ioredis';
import { CamerasService } from '../cameras/cameras.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { buildRtspUrl, resolveRecordingRtspProfile } from '../cameras/helpers/rtsp-url.helper';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { envNumber } from '../common/config/env-number.helper';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { spawnWithSecretUrl } from '../common/process/secret-url-process.helper';
// Registro de métricas por câmera. Importado como SINGLETON de módulo (e não por
// DI) de propósito: instrumentar não pode exigir mexer no construtor deste
// serviço crítico. Toda chamada é síncrona, trivial e envolvida em try/catch —
// observabilidade JAMAIS pode derrubar uma gravação.
import { cameraMetrics } from '../observability/camera-metrics.service';
import { buildCameraRootDir, buildRecordingOutputDir, buildRecordingOutputPattern } from './helpers/recording-path.helper';
import {
  appendStderrChunk,
  createStderrRing,
  drainStderrRing,
  DEFAULT_STDERR_RING_LINES,
  type FfmpegStderrRing,
} from './helpers/ffmpeg-stderr-ring.helper';
import { CLOUD_OFFLOAD_QUEUE } from '../jobs/queues/cloud-offload.queue';
import { THUMBNAIL_GENERATION_QUEUE } from '../jobs/queues/thumbnail-generation.queue';

const execFileAsync = promisify(execFile);

export type RecordingProcessState = {
  cameraId: string;
  process: ChildProcessByStdio<null, null, Readable>;
  startedAt: Date;
  outputDir: string;
  cameraRootDir: string;
  outputPattern: string;
  segmentSeconds: number;
  pid: number;
  watcher: NodeJS.Timeout;
  knownFiles: Set<string>;
  scanInFlight: Promise<void> | null;
  finalizePromise: Promise<void> | null;
  /**
   * Marcado quando a parada foi PEDIDA (stop/stopAll/rollback do start). Serve
   * para a métrica não contar uma parada normal como "reinício": o handler
   * `proc.on('close')` dispara ANTES do stop() retornar, então a intenção
   * precisa estar registrada no estado antes do kill. Não altera o fluxo.
   */
  stopRequested?: boolean;
  /**
   * Última observação do arquivo de segmento EM ESCRITA (detecção de gravação
   * travada por progresso de arquivo). Opcional: nasce indefinida e só é
   * preenchida quando alguém consulta o progresso.
   */
  writeSample?: { filePath: string; sizeBytes: number; mtimeMs: number; observedAtMs: number };
  /**
   * Últimas N linhas do stderr deste processo (teto rígido). Só é despejado no
   * log quando o processo morre ANORMALMENTE — em saída normal, nada é logado.
   * Opcional porque estados antigos/sintéticos podem não ter ring.
   */
  stderrRing?: FfmpegStderrRing;
};

/**
 * Diagnóstico de PROGRESSO DE ARQUIVO da gravação em andamento.
 *
 * Por que existe: o único sinal de "gravação viva" que tínhamos era o ÚLTIMO
 * SEGMENTO FECHADO, e um segmento só fecha a cada `segmentSeconds` (300s em
 * produção). Com o limiar de estagnação em `max(180s, segmento×1,25)` = 375s e o
 * health-check rodando a cada 60s, uma gravação parada ficava até ~7min sem
 * ninguém perceber. Mas o FFmpeg escreve CONTINUAMENTE no arquivo do segmento em
 * andamento — se esse arquivo para de crescer, a gravação travou AGORA.
 */
export type RecordingWriteProgress = {
  /** Existe processo local de gravação para avaliar? (false ⇒ a regra não se aplica) */
  applicable: boolean;
  /** Arquivo .ts observado como "em escrita" (o de mtime mais recente na pasta do processo). */
  filePath: string | null;
  sizeBytes: number | null;
  /** Segundos desde a última escrita observada no arquivo em andamento. */
  secondsSinceLastWrite: number | null;
  stallThresholdSeconds: number;
  graceSeconds: number;
  /** VEREDITO: o processo está vivo mas parou de escrever bytes. */
  stalled: boolean;
  reason:
    | 'no_active_process'
    | 'startup_grace'
    | 'no_segment_file'
    | 'probe_failed'
    | 'growing'
    | 'writing'
    | 'stalled';
};

type WorkerRecordingCommand = {
  action: 'start' | 'stop';
  cameraId: string;
  segmentSeconds?: number;
  requestedAt: string;
};

// Limites CANÔNICOS do segmento — os mesmos declarados em env.config.ts
// (RECORDING_SEGMENT_SECONDS: min 5, max 3600, inteiro).
export const SEGMENT_SECONDS_MIN = 5;
export const SEGMENT_SECONDS_MAX = 3600;
export const SEGMENT_SECONDS_FALLBACK = 300;

/**
 * Normaliza o segmento ANTES de virar argumento do ffmpeg.
 *
 * `-segment_time` recebia `String(segmentSeconds)` cru, vindo do CHAMADOR — e os
 * chamadores liam RECORDING_SEGMENT_SECONDS com pisos inconsistentes: env.config
 * exige 5..3600, o manager exigia 1, e o health-check, o recordings.controller e
 * o cameras.controller não exigiam NADA. Cinco caminhos entregavam o valor cru.
 *
 * `-segment_time 0` faz o ffmpeg rotacionar a cada pacote: milhares de arquivos
 * por segundo, disco cheio, gravação destruída. Negativo mata o processo em laço
 * de reinício. E o pior chamador é o health-check, que REINICIA a câmera — o
 * caminho de auto-cura viraria o de destruição.
 *
 * A guarda mora aqui, no estreitamento, e não em cada chamador: assim qualquer
 * chamador futuro nasce protegido sem precisar lembrar da regra.
 */
export function normalizeSegmentSeconds(requested: unknown): number {
  const numeric = Math.trunc(Number(requested));
  if (!Number.isFinite(numeric)) return SEGMENT_SECONDS_FALLBACK;
  if (numeric < SEGMENT_SECONDS_MIN) return SEGMENT_SECONDS_MIN;
  if (numeric > SEGMENT_SECONDS_MAX) return SEGMENT_SECONDS_MAX;
  return numeric;
}

@Injectable()
export class RecordingProcessManagerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RecordingProcessManagerService.name);
  private readonly active = new Map<string, RecordingProcessState>();
  private readonly recordingsRoot: string;
  private readonly recordingFormat: string;
  private readonly copyCodec: boolean;
  private readonly recordingCodecMode: 'copy' | 'h265' | 'h264';
  private readonly audioCodec: string;
  private readonly controlMode: 'local' | 'worker';
  private readonly workerCommandChannel: string;
  private readonly storageBackend: string;
  private readonly storageWriteProbeEnabled: boolean;
  private readonly minFreeBytes: number;
  private readonly minFreePercent: number;
  private redisPublisher: Redis | null = null;
  private readonly motionStopTimers = new Map<string, NodeJS.Timeout>();
  private diskGuardTimer: NodeJS.Timeout | null = null;
  private orphanRecoveryTimer: NodeJS.Timeout | null = null;
  private orphanRecoveryInterval: NodeJS.Timeout | null = null;
  private readonly preEventSeconds: number;
  private readonly preBufferProcs = new Map<string, { process: ChildProcessByStdio<null, null, Readable>; dir: string }>();
  private preBufferPruneTimer: NodeJS.Timeout | null = null;
  /**
   * Tentativas de remux JÁ GASTAS por arquivo .ts (chave = caminho absoluto).
   * Não persiste entre reinícios de propósito — quem persiste é o marcador de
   * quarentena em disco. Entradas somem no sucesso ou na quarentena, então o
   * mapa é limitado ao punhado de segmentos falhando agora.
   */
  private readonly segmentRemuxFailures = new Map<string, number>();
  // ── Reinício imediato após queda do FFmpeg de gravação ──────────────────────
  // Histórico de reinícios por câmera (janela DESLIZANTE) e o timer do reinício
  // agendado. `shuttingDown` impede que o desligamento da API dispare gravações.
  private readonly restartAttempts = new Map<string, number[]>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private shuttingDown = false;
  /** Freio anti-tempestade, mesmo espírito dos BRAKE_ do mediamtx-proxy. */
  private static readonly RESTART_BRAKE_MAX_ATTEMPTS = 5;
  private static readonly RESTART_BRAKE_WINDOW_MS = 10 * 60_000;
  private static readonly RESTART_BASE_DELAY_MS = 1_000;
  private static readonly RESTART_MAX_DELAY_MS = 30_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly camerasService: CamerasService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
    private readonly commercialPolicy: CommercialPolicyService,
    @InjectQueue(THUMBNAIL_GENERATION_QUEUE) private readonly thumbnailQueue: Queue,
    @InjectQueue(CLOUD_OFFLOAD_QUEUE) private readonly cloudOffloadQueue: Queue,
  ) {
    this.recordingsRoot = this.configService.get<string>('recordingsRoot') ?? './storage/recordings';
    this.recordingFormat = this.configService.get<string>('ffmpegRecordingFormat') ?? 'mp4';
    this.copyCodec = String(this.configService.get<string>('ffmpegRecordingCopyCodec') ?? 'true') !== 'false';
    const rawCodecMode = String(this.configService.get<string>('recordingCodecMode') ?? 'copy').toLowerCase();
    this.recordingCodecMode = rawCodecMode === 'h265' || rawCodecMode === 'h264' ? rawCodecMode : 'copy';
    this.audioCodec = this.configService.get<string>('ffmpegRecordingAudioCodec') ?? 'aac';
    this.controlMode = (this.configService.get<string>('recordingControlMode') ?? 'local') === 'worker' ? 'worker' : 'local';
    this.workerCommandChannel = this.configService.get<string>('workerCommandChannel') ?? 'camera:commands';
    this.storageBackend = this.configService.get<string>('storageBackend') ?? 'local';
    this.storageWriteProbeEnabled = this.configService.get<boolean>('storageWriteProbeEnabled') ?? true;
    this.minFreeBytes = Number(this.configService.get<number>('recordingMinFreeBytes') ?? 2147483648);
    this.minFreePercent = Number(this.configService.get<number>('recordingMinFreePercent') ?? 5);
    // Buffer PRÉ-EVENTO: segundos ANTES do gatilho de movimento a preservar. 0 =
    // desligado (padrão — produção intocada). Quando >0, câmeras armadas por
    // movimento mantêm uma captura contínua LEVE (cópia) numa pasta ring; ao
    // disparar, os segmentos anteriores viram gravação, para a pessoa não
    // "nascer" já dentro do quadro. É opt-in porque troca o perfil de recursos
    // (RTSP sempre aberto) por esse ganho probatório.
    this.preEventSeconds = envNumber('MOTION_PRE_EVENT_SECONDS', 0, { min: 0, max: 30 });
  }

  onModuleInit() {
    // Delegar a gravação ao worker Go troca a política de arquivamento sem que
    // nada na interface indique isso: o worker é LEGADO e transcodifica para
    // H.264 baseline/ultrafast (com perda), enquanto o caminho local desta classe
    // grava em CÓPIA (TS→remux MP4, sem reencode). Avisa alto no boot para que a
    // divergência nunca passe despercebida em produção.
    if (this.controlMode === 'worker') {
      this.logger.warn(
        'RECORDING_CONTROL_MODE=worker: gravação delegada ao camera-worker-go (LEGADO). '
        + 'Esse caminho TRANSCODIFICA para H.264 baseline/ultrafast — há PERDA de qualidade e uso contínuo de CPU. '
        + 'O pipeline oficial (cópia sem reencode) é o modo "local".',
      );
    }

    const diskGuardEnabled = String(process.env.RECORDING_DISK_GUARD_ENABLED ?? 'true') !== 'false';
    if (diskGuardEnabled) {
      const intervalMs = envNumber('RECORDING_DISK_GUARD_INTERVAL_MS', 30_000, {
        min: 10_000,
        integer: true,
        onInvalid: (m) => this.logger.warn(m),
      });
      this.diskGuardTimer = setInterval(() => void this.enforceDiskGuard(), intervalMs);
      if (typeof this.diskGuardTimer.unref === 'function') this.diskGuardTimer.unref();
    }

    // Buffer pré-evento: poda periódica do ring + sobe o ring das câmeras já
    // armadas (só quando MOTION_PRE_EVENT_SECONDS > 0 — senão nada disso roda).
    if (this.preEventSeconds > 0 && this.controlMode === 'local') {
      this.preBufferPruneTimer = setInterval(() => this.prunePreBuffers(), 3000);
      this.preBufferPruneTimer.unref?.();
      setTimeout(() => {
        void this.prisma.camera.findMany({ where: { recordingMode: 'motion', enabled: true }, select: { id: true } })
          .then((cams) => Promise.all(cams.map((c) => this.startPreBuffer(c.id).catch(() => undefined))))
          .catch(() => undefined);
      }, 20_000).unref?.();
      this.logger.log(`Buffer pré-evento HABILITADO: ${this.preEventSeconds}s antes do gatilho de movimento.`);
    }

    if (this.controlMode === 'local' && String(process.env.RECORDING_ORPHAN_RECOVERY_ENABLED ?? 'true') !== 'false') {
      const recoveryDelayMs = envNumber('RECORDING_ORPHAN_RECOVERY_DELAY_MS', 30_000, { min: 5_000 });
      const recoveryIntervalMs = envNumber('RECORDING_ORPHAN_RECOVERY_INTERVAL_MS', 6 * 60 * 60 * 1000, {
        min: 60 * 60 * 1000,
        onInvalid: (m) => this.logger.warn(m),
      });
      this.orphanRecoveryTimer = setTimeout(() => {
        this.orphanRecoveryTimer = null;
        void this.recoverOrphanedSegments();
      }, recoveryDelayMs);
      this.orphanRecoveryTimer.unref();
      this.orphanRecoveryInterval = setInterval(() => void this.recoverOrphanedSegments(), recoveryIntervalMs);
      this.orphanRecoveryInterval.unref();
    }

    const autoStart = String(process.env.RECORDING_AUTO_START_ENABLED ?? 'false') === 'true';
    if (!autoStart) {
      this.logger.log('Auto-start de gravacao continua desativado. Defina RECORDING_AUTO_START_ENABLED=true para religar no boot.');
      return;
    }

    const delayMs = envNumber('RECORDING_AUTO_START_DELAY_MS', 10000, { min: 0 });
    const timer = setTimeout(() => void this.startEnabledContinuousRecordings(), delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  private async startEnabledContinuousRecordings() {
    // Mesma rede do irmão acima: roda sob `void` num setTimeout de boot, e uma
    // rejeição aqui mataria a API justamente enquanto ela tenta religar as
    // gravações — o pior momento possível.
    try {
      await this.startEnabledContinuousRecordingsInner();
    } catch (error) {
      this.logger.warn(`Falha ao religar gravações contínuas no boot: ${sanitizeSensitiveText(error)}`);
    }
  }

  private async startEnabledContinuousRecordingsInner() {
    const cameras = await this.prisma.camera.findMany({
      where: {
        enabled: true,
        recordingEnabled: true,
        recordingMode: 'continuous',
      },
      select: { id: true, name: true },
      take: 500,
    });

    if (!cameras.length) {
      this.logger.log('Auto-start de gravacao continua: nenhuma camera habilitada.');
      return;
    }

    const defaultSegment = envNumber('RECORDING_SEGMENT_SECONDS', 300, { min: SEGMENT_SECONDS_MIN, max: SEGMENT_SECONDS_MAX, integer: true });
    this.logger.log(`Auto-start de gravacao continua para ${cameras.length} camera(s).`);
    for (const camera of cameras) {
      try {
        await this.start(camera.id, defaultSegment);
      } catch (error) {
        this.logger.warn(`Auto-start de gravacao falhou camera=${camera.name} (${camera.id}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async assertMinimumStorageFree() {
    const { totalBytes, freeBytes, freePercent } = await this.getStorageUsage();
    if (freeBytes < this.minFreeBytes || freePercent < this.minFreePercent) {
      throw new ServiceUnavailableException(
        `Espaço livre insuficiente para iniciar gravação (livre=${Math.round(freeBytes / (1024 * 1024))}MB, mínimo=${Math.round(this.minFreeBytes / (1024 * 1024))}MB, livre%=${freePercent.toFixed(2)}%, mínimo%=${this.minFreePercent}%).`,
      );
    }
  }

  private async getStorageUsage() {
    const disk = await statfs(this.recordingsRoot);
    const totalBytes = Number(disk.blocks) * Number(disk.bsize);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
    const usedPercent = totalBytes > 0 ? 100 - freePercent : 100;
    return { totalBytes, freeBytes, freePercent, usedPercent };
  }

  private async enforceDiskGuard() {
    if (this.active.size === 0 || this.controlMode !== 'local') return;

    try {
      const { freeBytes, freePercent, usedPercent } = await this.getStorageUsage();
      // NaN aqui DESARMAVA a guarda (o isFinite abaixo virava false) e o disco
      // enchia a 100% com todas as câmeras parando, sem erro nenhum no log.
      const maxUsedPercent = envNumber('RECORDING_DISK_GUARD_MAX_USED_PERCENT', 92, {
        min: 1,
        max: 100,
        onInvalid: (m) => this.logger.warn(m),
      });
      const critical =
        freeBytes < this.minFreeBytes ||
        freePercent < this.minFreePercent ||
        (Number.isFinite(maxUsedPercent) && usedPercent >= maxUsedPercent);

      if (!critical) return;

      const activeCameraIds = [...this.active.keys()];

      // ── ROTACIONAR ANTES DE PARAR ─────────────────────────────────────────
      //
      // Parar de gravar era a PRIMEIRA reação a disco cheio, e o guardião que
      // libera espaço só roda de HORA em hora: entre um e outro havia uma
      // janela em que a instalação simplesmente não registrava nada. Medido em
      // produção: 100 paradas em 2 horas, com ZERO câmeras gravando.
      //
      // Câmera de segurança é um ANEL: quando falta espaço, a gravação nova
      // sobrescreve a MAIS ANTIGA DA MESMA CÂMERA — e segue gravando. Parar só
      // se sobrar câmera sem absolutamente nada próprio para rotacionar.
      const liberou = await this.rotacionarParaLiberarEspaco(activeCameraIds, freeBytes).catch((error) => {
        this.logger.error(`Falha na rotação por câmera: ${(error as Error).message}`);
        return 0;
      });

      if (liberou > 0) {
        const depois = await this.getStorageUsage();
        const aindaCritico =
          depois.freeBytes < this.minFreeBytes ||
          depois.freePercent < this.minFreePercent ||
          (Number.isFinite(maxUsedPercent) && depois.usedPercent >= maxUsedPercent);
        this.logger.warn(
          `Rotação por câmera liberou ${Math.round(liberou / (1024 * 1024))}MB — gravação CONTINUA `
          + `(uso ${usedPercent.toFixed(1)}% → ${depois.usedPercent.toFixed(1)}%).`,
        );
        if (!aindaCritico) return;
      }

      // A rotação não deu conta (câmera sem histórico próprio, ou o espaço é de
      // outra coisa que não gravação). Aí sim, suspender é o menor dos danos.
      this.logger.error(
        `Guarda de disco parou ${activeCameraIds.length} gravacao(oes): usado=${usedPercent.toFixed(2)}%, livre=${Math.round(
          freeBytes / (1024 * 1024),
        )}MB. A rotação por câmera não encontrou o que liberar.`,
      );

      for (const cameraId of activeCameraIds) {
        await this.suspendRecordingForDiskGuard(cameraId, usedPercent, freeBytes).catch((error) => {
          this.logger.warn(`Falha ao parar gravacao por guarda de disco camera=${cameraId}: ${(error as Error).message}`);
        });
      }
    } catch (error) {
      this.logger.warn(`Falha ao executar guarda de disco de gravacao: ${(error as Error).message}`);
    }
  }

  /**
   * Libera espaço rotacionando o histórico de CADA câmera.
   *
   * Regra do anel: a gravação nova sobrescreve a mais antiga DA MESMA CÂMERA.
   * Nenhuma perde histórico por causa da vizinha — antes o guardião apagava a
   * mais antiga do sistema inteiro, então a câmera movimentada empurrava para
   * fora a imagem de quem grava pouco.
   *
   * Devolve os bytes efetivamente liberados. Gravação com hold de investigação
   * e a que só existe na nuvem nunca entram (apagar a segunda não libera disco
   * nenhum e destruiria a única cópia).
   */
  private async rotacionarParaLiberarEspaco(camerasAtivas: string[], freeBytes: number): Promise<number> {
    // Meta: voltar para a folga mínima com uma margem, para não ficar
    // rotacionando a cada ciclo por causa de alguns megabytes.
    const alvo = Math.max(this.minFreeBytes * 1.25, 512 * 1024 * 1024);
    const faltam = Math.max(0, alvo - freeBytes);
    if (faltam <= 0) return 0;

    const holds = await this.prisma.investigationItem
      .findMany({ where: { recordingId: { not: null } }, select: { recordingId: true } })
      .catch(() => [] as Array<{ recordingId: string | null }>);
    const protegidas = new Set(holds.map((h) => h.recordingId).filter((id): id is string => Boolean(id)));

    // Só o que ocupa disco AGORA: `localDeletedAt: null`.
    const candidatas = await this.prisma.recording.findMany({
      where: { localDeletedAt: null, endedAt: { not: null } },
      select: { id: true, cameraId: true, startedAt: true, sizeBytes: true, filePath: true },
      orderBy: { startedAt: 'asc' },
      take: 5000,
    });
    if (!candidatas.length) return 0;

    const plano = planejarRotacao(
      candidatas.map((c) => ({ ...c, protegida: protegidas.has(c.id) })),
      faltam,
      camerasAtivas,
    );
    if (!plano.aApagar.length) return 0;

    let liberados = 0;
    for (const alvoDaVez of plano.aApagar) {
      const original = candidatas.find((c) => c.id === alvoDaVez.id);
      if (!original) continue;
      try {
        const caminho = ensureFileUnderRoot(this.recordingsRoot, original.filePath);
        let tamanho = 0;
        if (existsSync(caminho)) {
          tamanho = statSync(caminho).size;
          await unlink(caminho);
        }
        await this.prisma.recording.delete({ where: { id: original.id } }).catch(() => undefined);
        liberados += tamanho;
      } catch (error) {
        this.logger.warn(`Rotação: falha ao apagar recording=${original.id}: ${(error as Error).message}`);
      }
    }

    if (plano.camerasSemFolga.length) {
      this.logger.warn(
        `Rotação: ${plano.camerasSemFolga.length} câmera(s) gravando sem histórico próprio para rotacionar.`,
      );
    }
    return liberados;
  }

  /**
   * Suspensão por disco cheio: derruba o PROCESSO e deixa o DESEJADO intacto.
   *
   * Antes isto era `this.stop(cameraId)` — e `stop()` grava
   * `recordingEnabled: false`, que neste projeto é o estado DESEJADO pelo
   * cliente, não o de runtime. O efeito em cadeia era uma parada DEFINITIVA:
   *
   *   · o health-check varre `where: { recordingEnabled: true }` → a câmera
   *     desaparece da varredura e nunca é reavaliada;
   *   · `restartRecordingAfterCrash` exige `recordingEnabled === true` → não religa
   *     (e nem houve queda: foi parada PEDIDA, com `stopRequested`);
   *   · `startEnabledContinuousRecordings` só roda no boot, e só com
   *     RECORDING_AUTO_START_ENABLED=true, que é `false` por padrão.
   *
   * Resultado medido no raciocínio da revisão: um pico de disco às 03h derruba
   * as 24 câmeras; às 04h a retenção libera espaço; e NENHUMA volta a gravar até
   * alguém reabilitar câmera por câmera na tela. Numa instalação de
   * videomonitoramento isso é a noite inteira sem imagem.
   *
   * Também emite evento POR CÂMERA. Antes existia só um `logger.error` no
   * stdout do container: a parada não aparecia na linha do tempo da câmera e o
   * watchdog de infra (que alerta o dono) não tinha o que ver.
   */
  private async suspendRecordingForDiskGuard(cameraId: string, usedPercent: number, freeBytes: number) {
    const state = this.active.get(cameraId);
    if (!state) return;

    // Marca ANTES do kill: o handler de 'close' chama finalize primeiro, e sem
    // isto uma suspensão pedida viraria "queda" na métrica — e dispararia o
    // reinício automático contra o disco cheio que acabamos de detectar.
    state.stopRequested = true;
    clearInterval(state.watcher);
    await this.stopProcessAndWait(state);
    await this.finalizeRecordingState(cameraId, state, state.process.exitCode);

    await this.camerasService
      .registerEvent(
        cameraId,
        'RECORDING_SUSPENDED_DISK_GUARD',
        'ERROR',
        `Gravação suspensa pela guarda de disco (usado=${usedPercent.toFixed(2)}%, livre=${Math.round(freeBytes / (1024 * 1024))}MB). `
        + 'A câmera segue ARMADA e volta a gravar assim que houver espaço.',
        { usedPercent, freeBytes, reason: 'disk_guard' },
      )
      .catch(() => undefined);
  }

  private async assertStorageWritable() {
    if (!this.storageWriteProbeEnabled) return;
    const now = Date.now();
    const probePath = join(this.recordingsRoot, `.write-probe-${now}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      await writeFile(probePath, `probe:${now}`);
      await unlink(probePath);
    } catch (error) {
      throw new ServiceUnavailableException(
        `Storage (${this.storageBackend}) indisponível para escrita em ${this.recordingsRoot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Público (era private) para que a observabilidade por câmera use EXATAMENTE
  // o mesmo limiar de "gravação travada" que o status/health já usam — duas
  // fórmulas divergentes acusariam defeitos diferentes na mesma câmera.
  // Comportamento e chamadas existentes: inalterados.
  getRecordingStaleThresholdSeconds(segmentSeconds?: number | null) {
    const configuredThreshold = envNumber('RECORDING_STALE_THRESHOLD_SECONDS', 180);
    const defaultSegmentSeconds = Number(this.configService.get<number>('recordingSegmentSeconds') ?? 300);
    const effectiveSegmentSeconds = Number(segmentSeconds && segmentSeconds > 0 ? segmentSeconds : defaultSegmentSeconds);
    const graceSeconds = Math.max(60, Math.round(effectiveSegmentSeconds * 0.25));
    return Math.max(configuredThreshold, effectiveSegmentSeconds + graceSeconds);
  }

  // ── GRAVAÇÃO TRAVADA POR PROGRESSO DE ARQUIVO ────────────────────────────────
  // Regra de OURO desta seção: FALSO POSITIVO AQUI MATA GRAVAÇÃO BOA — é pior que
  // o problema original (demorar a reiniciar uma gravação já morta). Toda dúvida
  // resolve para "saudável". As escolhas conservadoras estão documentadas caso a
  // caso abaixo.

  /**
   * Segundos sem NENHUMA escrita no segmento em andamento para considerar travado.
   *
   * Default 45s (piso duro de 20s, mesmo se alguém configurar menos): o FFmpeg
   * esvazia o buffer de I/O do muxer (~32KB) a cada poucos segundos mesmo em cena
   * estática de bitrate baixíssimo (32KB a 64kbps ≈ 4s; a 16kbps ≈ 16s), então 45s
   * é ~3x a pior janela plausível de uma câmera viva — sobra folga para jitter de
   * filesystem, contenção de disco e granularidade de mtime.
   */
  private getWriteStallSeconds() {
    const configured = envNumber('RECORDING_WRITE_STALL_SECONDS', 45);
    return Number.isFinite(configured) ? Math.max(20, configured) : 45;
  }

  /**
   * Janela de graça DEPOIS do start, na qual nunca acusamos travamento.
   *
   * Logo após o spawn o arquivo do segmento pode simplesmente não existir ainda
   * (conexão RTSP, negociação, cabeçalho do container). Acusar aqui reiniciaria em
   * loop uma câmera que só está lenta para conectar. Nunca menor que o limiar de
   * travamento.
   */
  private getWriteStallGraceSeconds(stallThresholdSeconds: number) {
    const configured = envNumber('RECORDING_WRITE_STALL_GRACE_SECONDS', 90);
    const base = Number.isFinite(configured) ? configured : 90;
    return Math.max(30, stallThresholdSeconds, base);
  }

  /**
   * Lista os `.ts` da pasta de saída DESTE processo com tamanho e mtime.
   * Seam de I/O (sobrescrevível nos testes). Não recursivo de propósito: o padrão
   * de saída é fixado no spawn (`camera-<id>/YYYY/MM/DD/HH`), então todo segmento
   * do processo cai nessa única pasta — varrer a árvore inteira da câmera seria
   * caro e traria arquivos de outros processos.
   */
  private listSegmentWriteCandidates(outputDir: string) {
    const candidates: Array<{ filePath: string; sizeBytes: number; mtimeMs: number }> = [];
    for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const filePath = join(outputDir, entry.name);
      try {
        const stat = statSync(filePath);
        candidates.push({ filePath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Corrida com a rotação/remoção do segmento: ignora este arquivo.
      }
    }
    return candidates;
  }

  /**
   * Detecta gravação TRAVADA pelo progresso do arquivo em escrita — em ~1 ciclo do
   * health-check, e não depois de um segmento inteiro + folga.
   *
   * Decisões conservadoras (cada uma evita um falso positivo real):
   * - sem processo local ativo → NÃO se aplica (quem cobra isso é o limiar antigo);
   * - dentro da janela de graça pós-start → NUNCA acusa;
   * - nenhum `.ts` na pasta → NÃO acusa (pode ser o intervalo entre o remux do
   *   segmento anterior e a criação do próximo, ou o start ainda escrevendo o 1º);
   * - o "arquivo em escrita" é o de MTIME MAIS RECENTE, não o de nome mais novo:
   *   se qualquer `.ts` da pasta recebeu bytes agora, a gravação está viva. Escolher
   *   pelo nome deixaria um `.ts` residual (remux que falhou, pré-roll promovido)
   *   mascarar o arquivo vivo e acusar travamento numa gravação sadia;
   * - se o arquivo CRESCEU desde a observação anterior, é prova direta de progresso
   *   e vence o mtime (blinda contra filesystem com mtime preguiçoso);
   * - mtime no futuro (relógio torto) vira idade 0 → saudável.
   */
  getRecordingWriteProgress(cameraId: string, nowMs = Date.now()): RecordingWriteProgress {
    const stallThresholdSeconds = this.getWriteStallSeconds();
    const graceSeconds = this.getWriteStallGraceSeconds(stallThresholdSeconds);
    const base = {
      filePath: null,
      sizeBytes: null,
      secondsSinceLastWrite: null,
      stallThresholdSeconds,
      graceSeconds,
      stalled: false,
    };

    const state = this.active.get(cameraId);
    if (!state) return { ...base, applicable: false, reason: 'no_active_process' };

    const uptimeSeconds = (nowMs - new Date(state.startedAt).getTime()) / 1000;
    // Negado de propósito: NaN cai na graça (não acusa) em vez de acusar.
    if (!(uptimeSeconds >= graceSeconds)) {
      return { ...base, applicable: true, reason: 'startup_grace' };
    }

    let candidates: Array<{ filePath: string; sizeBytes: number; mtimeMs: number }>;
    try {
      candidates = this.listSegmentWriteCandidates(state.outputDir);
    } catch {
      return { ...base, applicable: true, reason: 'probe_failed' };
    }
    if (!candidates.length) return { ...base, applicable: true, reason: 'no_segment_file' };

    const current = candidates.reduce((newest, item) => (item.mtimeMs > newest.mtimeMs ? item : newest));
    const previous = state.writeSample;
    state.writeSample = {
      filePath: current.filePath,
      sizeBytes: current.sizeBytes,
      mtimeMs: current.mtimeMs,
      observedAtMs: nowMs,
    };

    const secondsSinceLastWrite = Math.max(0, (nowMs - current.mtimeMs) / 1000);
    const observed = {
      applicable: true,
      filePath: current.filePath,
      sizeBytes: current.sizeBytes,
      secondsSinceLastWrite: Math.round(secondsSinceLastWrite),
      stallThresholdSeconds,
      graceSeconds,
    };

    const grew = Boolean(previous && previous.filePath === current.filePath && current.sizeBytes > previous.sizeBytes);
    if (grew) return { ...observed, stalled: false, reason: 'growing' };
    if (secondsSinceLastWrite >= stallThresholdSeconds) return { ...observed, stalled: true, reason: 'stalled' };
    return { ...observed, stalled: false, reason: 'writing' };
  }

  /** Igual ao anterior, mas JAMAIS lança: observabilidade não derruba gravação. */
  private safeRecordingWriteProgress(cameraId: string): RecordingWriteProgress {
    try {
      return this.getRecordingWriteProgress(cameraId);
    } catch {
      const stallThresholdSeconds = this.getWriteStallSeconds();
      return {
        applicable: false,
        filePath: null,
        sizeBytes: null,
        secondsSinceLastWrite: null,
        stallThresholdSeconds,
        graceSeconds: this.getWriteStallGraceSeconds(stallThresholdSeconds),
        stalled: false,
        reason: 'probe_failed',
      };
    }
  }

  private getMotionPostRollSeconds() {
    const configured = envNumber('MOTION_RECORDING_POST_ROLL_SECONDS', 60);
    return Number.isFinite(configured) && configured > 0 ? configured : 60;
  }

  private getMotionSegmentSeconds() {
    const configured = envNumber('MOTION_RECORDING_SEGMENT_SECONDS', 60);
    return Number.isFinite(configured) && configured > 0 ? configured : 60;
  }

  private clearMotionStopTimer(cameraId: string) {
    const timer = this.motionStopTimers.get(cameraId);
    if (timer) {
      clearTimeout(timer);
      this.motionStopTimers.delete(cameraId);
    }
  }

  private scheduleMotionStop(cameraId: string, postRollSeconds: number) {
    this.clearMotionStopTimer(cameraId);
    const timer = setTimeout(() => {
      void this.stopMotionRecordingAfterQuiet(cameraId, postRollSeconds);
    }, postRollSeconds * 1000);
    timer.unref();
    this.motionStopTimers.set(cameraId, timer);
  }

  // ── FAIL-SAFE DO DETECTOR CEGO ──────────────────────────────────────────────
  //
  // Em modo movimento, "não detectar" e "não haver movimento" produzem o MESMO
  // resultado na tela: nenhuma gravação. A diferença é que o segundo é correto e
  // o primeiro é o pior defeito possível num sistema de segurança — a câmera
  // está de pé, o operador vê "gravação por movimento ativa", e não existe
  // imagem nenhuma do que aconteceu.
  //
  // Medido em produção (2026-08-05): 9 de 9 câmeras armadas com o detector em
  // `no_frame_received`, 10+ falhas consecutivas de captura, backoff no teto de
  // 60s — cegas por mais de meia hora. O health-check JÁ sabia disso (emitia
  // HEALTH_MOTION_DETECTOR_STALE), mas ninguém ligava o aviso à gravação: o
  // evento ia para o histórico e a câmera seguia sem gravar.
  //
  // A regra passa a ser a de qualquer sistema de segurança: NA DÚVIDA, GRAVA.
  // Detector cego → gravação contínua até ele voltar. Custa disco (e a retenção
  // já sabe liberar espaço); não custar nada é ficar sem a imagem do fato.
  // Sob demanda, não inicializador de campo: parte da suíte monta este serviço
  // com `Object.create` do protótipo, onde inicializador de campo não roda. Um
  // `undefined` aqui faria `stopMotionRecordingAfterQuiet` lançar no meio do
  // caminho — ou seja, quebraria a parada normal por post-roll.
  private blindFailsafeInterno: Set<string> | null = null;
  private get blindFailsafe(): Set<string> {
    if (!this.blindFailsafeInterno) this.blindFailsafeInterno = new Set();
    return this.blindFailsafeInterno;
  }

  /** Câmeras gravando por fail-safe agora (o detector delas está cego). */
  camerasEmFailsafeCego(): string[] {
    return [...this.blindFailsafe];
  }

  /**
   * Liga/desliga a gravação contínua de emergência de uma câmera cujo detector
   * de movimento parou de receber frames. Idempotente: o health-check chama a
   * cada ciclo com o estado atual, e só a TRANSIÇÃO faz trabalho.
   */
  async definirFailsafeDetectorCego(cameraId: string, cego: boolean): Promise<'ligado' | 'desligado' | 'inalterado'> {
    const jaEstava = this.blindFailsafe.has(cameraId);
    if (cego === jaEstava) return 'inalterado';

    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      select: { id: true, name: true, recordingMode: true, enabled: true },
    });
    // Só vale para câmera habilitada e armada por movimento. Fora disso não há
    // o que compensar: quem grava contínuo já grava, e quem está desabilitada
    // não deve ganhar gravação por um detector cego.
    if (!camera || camera.enabled === false || camera.recordingMode !== 'motion') {
      this.blindFailsafe.delete(cameraId);
      return 'inalterado';
    }

    if (cego) {
      this.blindFailsafe.add(cameraId);
      // O post-roll pendente mataria a gravação de emergência no meio.
      this.clearMotionStopTimer(cameraId);
      try {
        const alreadyRecording = this.controlMode === 'local'
          ? this.active.has(cameraId)
          : (await this.getStatus(cameraId).catch(() => ({ isRecording: false }))).isRecording;
        if (!alreadyRecording) await this.start(cameraId, this.getMotionSegmentSeconds());
        await this.camerasService.registerEvent(
          cameraId,
          'MOTION_FAILSAFE_RECORDING_STARTED',
          'WARNING',
          'Detector de movimento sem frames: gravando de forma contínua até ele voltar.',
          { motivo: 'detector_cego' },
        );
        this.logger.warn(
          `FAIL-SAFE: detector de ${camera.name} está cego — gravando CONTÍNUO até voltar. `
          + 'Sem isto a câmera não registraria nada.',
        );
      } catch (error) {
        // Não conseguiu subir a gravação (câmera fora, disco cheio): mantém a
        // marca para tentar de novo no próximo ciclo do health-check.
        this.logger.error(
          `FAIL-SAFE: detector de ${camera.name} cego e a gravação de emergência NÃO subiu: `
          + `${error instanceof Error ? error.message : 'erro desconhecido'}. A câmera está sem registrar.`,
        );
      }
      return 'ligado';
    }

    this.blindFailsafe.delete(cameraId);
    // Detector voltou: devolve à disciplina do movimento. Não corta na hora —
    // usa o mesmo post-roll do fluxo normal, senão o instante da recuperação
    // ficaria sem imagem justamente quando o detector volta a enxergar.
    this.scheduleMotionStop(cameraId, this.getMotionPostRollSeconds());
    await this.camerasService.registerEvent(
      cameraId,
      'MOTION_FAILSAFE_RECORDING_STOPPED',
      'INFO',
      'Detector de movimento voltou: gravação contínua de emergência encerrada.',
      { postRollSeconds: this.getMotionPostRollSeconds() },
    ).catch(() => undefined);
    this.logger.log(`FAIL-SAFE encerrado: detector de ${camera.name} voltou a enxergar.`);
    return 'desligado';
  }

  private async stopMotionRecordingAfterQuiet(cameraId: string, postRollSeconds: number) {
    this.motionStopTimers.delete(cameraId);
    // Enquanto o detector estiver cego, NINGUÉM para esta gravação. Um post-roll
    // agendado antes da cegueira (ou o de um movimento que ainda pingou) cairia
    // aqui e desligaria justamente a cobertura de emergência.
    if (this.blindFailsafe.has(cameraId)) return;
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      select: { recordingMode: true, recordingEnabled: true },
    });
    if (!camera || camera.recordingMode !== 'motion' || !camera.recordingEnabled) return;

    // A câmera continua ARMADA: o ring de pré-evento volta a ser a cobertura.
    // ORDEM É INVARIANTE — sobe o ring ANTES de parar a gravação. Os dois se
    // sobrepõem por instantes (aceitável); um buraco em que nem o ring nem a
    // gravação estão de pé, não. (Com MOTION_PRE_EVENT_SECONDS=0 isto é no-op.)
    if (this.preEventSeconds > 0) {
      await this.startPreBuffer(cameraId).catch(() => undefined);
    }

    try {
      await this.stop(cameraId);
      await this.camerasService.registerEvent(
        cameraId,
        'MOTION_RECORDING_STOPPED',
        'INFO',
        `Gravação por movimento encerrada após ${postRollSeconds}s sem novo movimento.`,
        { postRollSeconds },
      );
    } catch (error) {
      this.logger.warn(`Falha ao parar gravação por movimento camera=${cameraId}: ${(error as Error).message}`);
    }
  }

  async handleMotionDetected(cameraId: string, metadata?: Record<string, unknown>) {
    // Instante do GATILHO, capturado antes de qualquer I/O: a janela do pré-roll
    // é medida a partir do movimento, não de quando as consultas terminaram.
    const triggeredAtMs = Date.now();
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      select: { id: true, name: true, recordingMode: true, recordingEnabled: true, enabled: true },
    });
    if (!camera) throw new NotFoundException('Camera não encontrada.');
    if (camera.enabled === false) {
      return { status: 'ignored', reason: 'camera_disabled', cameraId };
    }
    if (camera.recordingMode !== 'motion') {
      return { status: 'ignored', reason: 'motion_recording_not_enabled', cameraId };
    }

    const postRollSeconds = this.getMotionPostRollSeconds();
    const segmentSeconds = this.getMotionSegmentSeconds();

    // AUTORIDADE ≠ INFERÊNCIA. `getStatus` responde para TELA: no modo local,
    // sem estado em memória, ele INFERE "gravando" a partir de um segmento
    // recente (<15 min). Ótimo para o painel, péssimo como decisão.
    //
    // Depois de um restart da API, `this.active` está vazio — nenhum ffmpeg
    // sobreviveu — mas o último segmento ainda é recente. A câmera se declarava
    // gravando, este método devolvia `already_recording` e o movimento NÃO
    // gerava gravação nenhuma até a janela vencer. Medido em produção em
    // 2026-07-28: 15 minutos de imagem perdidos por reinício, em silêncio.
    //
    // No modo local quem manda é o processo que ESTE nó tem. No modo worker o
    // ffmpeg vive em outro nó, `active` está vazio por definição, e a
    // inferência é a única informação disponível.
    const alreadyRecording = this.controlMode === 'local'
      ? this.active.has(cameraId)
      : (await this.getStatus(cameraId).catch(() => ({ isRecording: false }))).isRecording;
    let startStatus = 'already_recording';

    if (!alreadyRecording) {
      // PRÉ-EVENTO: promove os segundos ANTERIORES ao gatilho (se habilitado). Best
      // effort e isolado: se falhar, a gravação normal do movimento segue igual.
      // Só faz sentido com o ring de pé — um ring criado AGORA não tem passado
      // nenhum para promover, e subi-lo aqui seria só um ffmpeg extra na câmera.
      if (this.preEventSeconds > 0 && this.preBufferProcs.has(cameraId)) {
        await this.promotePreRoll(cameraId, triggeredAtMs).catch(() => undefined);
      }
      try {
        const result = await this.start(cameraId, segmentSeconds);
        startStatus = result.status;
        // UMA sessão RTSP de arquivamento por vez: o ring já cumpriu o papel (o
        // pré-roll foi promovido) e a gravação cobre daqui para a frente. Manter
        // os dois era um SEGUNDO ffmpeg concorrente na mesma câmera — as baratas
        // travam em 2-4 sessões RTSP no total, e ainda faltam live e IA.
        // ORDEM É INVARIANTE: derruba o ring SÓ DEPOIS de a gravação estar de pé;
        // o inverso abriria uma janela sem NENHUMA cobertura.
        //
        // SEGUNDA PROMOÇÃO, e ela não é redundante: `start()` não é instantâneo
        // (probe RTSP com timeout de 12s, write-probe, statfs, queries) e o ring
        // CONTINUA gravando esse tempo todo. Esses segundos são o COMEÇO DO
        // EVENTO. A primeira promoção só alcança até `gatilho + 2s`, e logo
        // abaixo `stopPreBuffer` apaga INCONDICIONALMENTE o que sobrou — ou
        // seja, o material do fato era destruído depois de já existir em disco.
        // `promotePreRoll` MOVE os arquivos, então chamar de novo não duplica
        // nada: só alcança o que nasceu enquanto a gravação subia.
        if (this.preEventSeconds > 0 && this.preBufferProcs.has(cameraId)) {
          await this.promotePreRoll(cameraId, Date.now()).catch(() => undefined);
        }
        await this.stopPreBuffer(cameraId).catch(() => undefined);
        await this.camerasService.registerEvent(
          cameraId,
          'MOTION_RECORDING_STARTED',
          'INFO',
          `Gravação por movimento iniciada. Ela será mantida até ${postRollSeconds}s após o último movimento.`,
          { postRollSeconds, segmentSeconds, trigger: metadata ?? {} },
        );
      } catch (error) {
        // A gravação NÃO subiu: o ring é a única cobertura possível. Garante que
        // ele esteja de pé (auto-cura, idempotente) e JAMAIS o derruba aqui.
        if (this.preEventSeconds > 0) {
          await this.startPreBuffer(cameraId).catch(() => undefined);
        }
        await this.camerasService.registerEvent(
          cameraId,
          'MOTION_RECORDING_FAILED',
          'WARNING',
          'Falha ao iniciar gravação por movimento.',
          { error: error instanceof Error ? error.message : 'unknown_error', trigger: metadata ?? {} },
        );
        throw error;
      }
    }

    this.scheduleMotionStop(cameraId, postRollSeconds);
    return {
      status: startStatus,
      cameraId,
      mode: 'motion',
      postRollSeconds,
      segmentSeconds,
    };
  }

  async setMotionRecording(cameraId: string, enabled: boolean) {
    await this.camerasService.getCameraOrThrow(cameraId).catch(() => {
      throw new NotFoundException('Camera não encontrada.');
    });

    if (enabled) {
      this.clearMotionStopTimer(cameraId);
      await this.stop(cameraId).catch(() => undefined);
      await this.prisma.camera.update({
        where: { id: cameraId },
        data: { recordingMode: 'motion', recordingEnabled: false },
      });
      // Câmera armada → liga o ring de pré-evento (se habilitado por flag).
      void this.startPreBuffer(cameraId).catch(() => undefined);
      return { status: 'motion_recording_armed', cameraId };
    }

    this.clearMotionStopTimer(cameraId);
    await this.stop(cameraId).catch(() => undefined);
    void this.stopPreBuffer(cameraId).catch(() => undefined);
    await this.prisma.camera.update({
      where: { id: cameraId },
      data: { recordingMode: 'manual', recordingEnabled: false },
    });
    return { status: 'motion_recording_disabled', cameraId };
  }

  // ── BUFFER PRÉ-EVENTO (ring de captura contínua para câmeras armadas) ───────
  private preBufferDir(cameraId: string) {
    return join(this.recordingsRoot, '.pre-buffer', `camera-${cameraId}`);
  }

  /** Sobe (se ainda não) o ring de captura leve da câmera. Idempotente. */
  private async startPreBuffer(cameraId: string) {
    if (this.preEventSeconds <= 0 || this.controlMode !== 'local') return;
    if (this.preBufferProcs.has(cameraId)) return;
    if (!this.checkFfmpegAvailable()) return;
    const camera = await this.camerasService.getCameraOrThrow(cameraId).catch(() => null);
    if (!camera || (camera as { enabled?: boolean }).enabled === false) return;

    const password = this.cryptoService.decrypt(camera.passwordEncrypted);
    const rtspUrl = this.buildRtsp(camera, password);
    const transport = camera.preferredRtspTransport ?? this.configService.get<string>('ffmpegRtspTransport') ?? 'tcp';
    const dir = this.preBufferDir(cameraId);
    mkdirSync(dir, { recursive: true });

    // Segmentos curtos (2s) em cópia → granularidade fina do pré-roll a custo ~0.
    // strftime no nome permite reusar o remux/registro por nome de arquivo.
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', transport,
      '-timeout', String(this.configService.get<number>('ffmpegStimeoutUs') ?? 8000000),
      '-i', rtspUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-f', 'segment', '-segment_format', 'mpegts',
      '-segment_time', '2', '-reset_timestamps', '1', '-strftime', '1',
      join(dir, '%Y-%m-%d_%H-%M-%S.ts'),
    ];
    const proc = spawnWithSecretUrl(
      'ffmpeg',
      args,
      rtspUrl,
      { stdio: ['ignore', 'ignore', 'pipe'] },
    ) as ChildProcessByStdio<null, null, Readable>;
    proc.stderr!.on('data', () => {});
    proc.on('close', () => {
      if (this.preBufferProcs.get(cameraId)?.process === proc) this.preBufferProcs.delete(cameraId);
    });
    proc.on('error', () => {
      if (this.preBufferProcs.get(cameraId)?.process === proc) this.preBufferProcs.delete(cameraId);
    });
    this.preBufferProcs.set(cameraId, { process: proc, dir });
    this.logger.log(`Buffer pré-evento iniciado camera=${cameraId} (${this.preEventSeconds}s).`);
  }

  private async stopPreBuffer(cameraId: string) {
    const entry = this.preBufferProcs.get(cameraId);
    if (!entry) return;
    this.preBufferProcs.delete(cameraId);
    // SIGTERM SOZINHO NÃO É GARANTIA DE MORTE. Um ffmpeg encravado (I/O de rede
    // pendurado no RTSP) ignora o SIGTERM e continua vivo segurando o lock do
    // path — o modo de falha que aparece como "Reconectando" eterno numa câmera.
    // O caminho da gravação principal já escalona (killProcessSafely: SIGTERM →
    // 1,5s → SIGKILL); o ring do pré-evento ficava de fora e podia vazar
    // processo. Mesma escada aqui, pelo mesmo motivo.
    try { this.killProcessSafely(entry.process); } catch { /* já morto */ }
    // Limpa o ring: sem gatilho pendente, esses segmentos não viram gravação.
    for (const file of readdirSync(entry.dir, { withFileTypes: true }).filter((f) => f.name.endsWith('.ts'))) {
      await unlink(join(entry.dir, file.name)).catch(() => undefined);
    }
  }

  /** Poda os segmentos do ring mais velhos que o pré-roll (mantém só a janela útil). */
  private prunePreBuffers() {
    if (this.preEventSeconds <= 0) return;
    const keepMs = (this.preEventSeconds + 6) * 1000;
    const now = Date.now();
    for (const { dir } of this.preBufferProcs.values()) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.name.endsWith('.ts')) continue;
        const full = join(dir, entry.name);
        try {
          // Não apaga o segmento MAIS novo (o ffmpeg ainda pode estar escrevendo).
          if (now - statSync(full).mtimeMs > keepMs) void unlink(full).catch(() => undefined);
        } catch { /* corrida com o ffmpeg */ }
      }
    }
  }

  /**
   * No gatilho de movimento, promove os segmentos do ring que caem na janela
   * [gatilho - preRoll, gatilho] a gravações permanentes — o "antes" do evento.
   * Cada .ts é copiado para a pasta de gravação e remuxado/registrado (reusa o
   * pipeline existente). Falha aqui NUNCA impede a gravação normal do movimento.
   */
  private async promotePreRoll(cameraId: string, triggerAt: number) {
    const entry = this.preBufferProcs.get(cameraId);
    if (!entry || this.preEventSeconds <= 0) return;
    const windowStart = triggerAt - this.preEventSeconds * 1000;
    let promoted = 0;
    try {
      const files = readdirSync(entry.dir, { withFileTypes: true })
        .filter((f) => f.name.endsWith('.ts'))
        .map((f) => join(entry.dir, f.name))
        .sort();
      // Ignora o último (pode estar sendo escrito). Promove os que terminam
      // dentro/depois do início da janela e antes do gatilho.
      const candidates = files.slice(0, -1).filter((full) => {
        try {
          const mtime = statSync(full).mtimeMs;
          return mtime >= windowStart && mtime <= triggerAt + 2000;
        } catch { return false; }
      });
      for (const src of candidates) {
        try {
          const startDate = new Date(statSync(src).mtimeMs - 2000); // ~início do segmento de 2s
          const destDir = buildRecordingOutputDir(this.recordingsRoot, cameraId, startDate);
          mkdirSync(destDir, { recursive: true });
          const p2 = (n: number) => String(n).padStart(2, '0');
          const destName = `${startDate.getUTCFullYear()}-${p2(startDate.getUTCMonth() + 1)}-${p2(startDate.getUTCDate())}_${p2(startDate.getUTCHours())}-${p2(startDate.getUTCMinutes())}-${p2(startDate.getUTCSeconds())}.ts`;
          const destTs = join(destDir, destName);
          if (existsSync(destTs)) continue;
          await rename(src, destTs).catch(async () => {
            // rename entre dispositivos falha: copia+apaga.
            await writeFile(destTs, await readFile(src));
            await unlink(src).catch(() => undefined);
          });
          await this.remuxAndRegisterTsSegment(cameraId, destTs, Math.max(1, this.getMotionSegmentSeconds()));
          promoted += 1;
        } catch (error) {
          this.logger.warn(`Falha ao promover pré-roll ${basename(src)}: ${sanitizeSensitiveText(error)}`);
        }
      }
      if (promoted) this.logger.log(`Pré-evento: ${promoted} segmento(s) anteriores preservados camera=${cameraId}.`);
    } catch (error) {
      this.logger.warn(`Falha ao promover pré-roll camera=${cameraId}: ${sanitizeSensitiveText(error)}`);
    }
  }

  private async getRedisPublisher() {
    if (this.redisPublisher) return this.redisPublisher;
    const host = this.configService.get<string>('redisHost') ?? 'localhost';
    const port = Number(this.configService.get<number>('redisPort') ?? 6379);
    this.redisPublisher = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 2 });
    await this.redisPublisher.connect();
    return this.redisPublisher;
  }

  private async publishWorkerCommand(command: WorkerRecordingCommand) {
    const redis = await this.getRedisPublisher();
    await redis.publish(this.workerCommandChannel, JSON.stringify(command));
  }

  checkFfmpegAvailable(): boolean {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  }

  sanitizeRtspUrl(url: string): string {
    return sanitizeSensitiveText(url);
  }

  private buildRtsp(camera: Camera, password: string): string {
    const recordingProfile = resolveRecordingRtspProfile(camera);
    return buildRtspUrl({
      username: camera.username,
      password,
      ip: camera.ip,
      rtspPort: camera.rtspPort,
      rtspPath: camera.rtspPath ?? undefined,
      channel: recordingProfile.channel,
      subtype: recordingProfile.subtype,
    });
  }

  private async probeSourceCodec(rtspUrl: string, transport: string): Promise<string | null> {
    return await new Promise((resolve) => {
      const proc = spawnWithSecretUrl('ffprobe', [
        '-v', 'error',
        '-rtsp_transport', transport,
        '-i', rtspUrl,
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=1',
      ], rtspUrl);
      let stdout = '';
      let settled = false;
      const finish = (codec: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(codec);
      };
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        finish(null);
      }, 12000);
      timeout.unref();
      proc.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => {
        const codec = stdout.trim().split('\n')[0]?.trim().toLowerCase() || null;
        finish(code === 0 ? codec : null);
      });
    });
  }

  private sourceIsHevcWithProbe(probedCodec: string | null): boolean {
    return Boolean(probedCodec && (probedCodec.includes('h265') || probedCodec.includes('hevc')));
  }

  private sourceIsH264WithProbe(probedCodec: string | null): boolean {
    return Boolean(probedCodec && (probedCodec.includes('h264') || probedCodec.includes('avc')));
  }

  // Decide o codec de vídeo de saída da gravação a partir do modo configurado.
  // 'copy' arquiva o bitstream original (sem reencode); 'h265'/'h264' só transcodam
  // quando a fonte difere do alvo. Retorna também se a saída final é HEVC, para
  // aplicar a tag hvc1 (obrigatória para HEVC em MP4, inclusive ao copiar).
  private resolveOutputVideoCodec(probedCodec: string | null): { videoCodec: string; transcode: boolean; outputIsHevc: boolean } {
    const sourceIsHevc = this.sourceIsHevcWithProbe(probedCodec);
    const sourceIsH264 = this.sourceIsH264WithProbe(probedCodec);

    if (this.recordingCodecMode === 'h265') {
      return sourceIsHevc
        ? { videoCodec: 'copy', transcode: false, outputIsHevc: true }
        : { videoCodec: 'libx265', transcode: true, outputIsHevc: true };
    }
    if (this.recordingCodecMode === 'h264') {
      return sourceIsH264
        ? { videoCodec: 'copy', transcode: false, outputIsHevc: false }
        : { videoCodec: 'libx264', transcode: true, outputIsHevc: false };
    }
    // 'copy' (padrão): copia a fonte SEMPRE — inclusive HEVC. A captura agora é
    // em MPEG-TS segmentado (Annex-B nativo, tolera cortes sem reinjetar
    // VPS/SPS/PPS) e cada segmento fechado é remuxado para MP4 sem re-encode
    // (hvc1 quando HEVC), o mesmo pipeline provado dos clipes. Isso arquiva o
    // bitstream ORIGINAL da câmera (zero perda, zero CPU de encode); o playback
    // no navegador toca HEVC direto quando suportado ou usa a transcodificação
    // compatível sob demanda (cacheada).
    return { videoCodec: 'copy', transcode: false, outputIsHevc: sourceIsHevc };
  }

  private buildArgs(camera: Camera, rtspUrl: string, outputPattern: string, segmentSeconds: number, probedCodec: string | null): string[] {
    const transport = camera.preferredRtspTransport ?? this.configService.get<string>('ffmpegRtspTransport') ?? 'tcp';
    const stimeout = String(this.configService.get<number>('ffmpegStimeoutUs') ?? 8000000);
    // O codec de saída segue o modo configurado (padrão 'copy': arquiva a fonte
    // original sem reencode). HEVC em MP4 sempre recebe a tag hvc1, inclusive no
    // copy, senão o arquivo fica com tag hev1/ausente e quebra seek/compat.
    const { videoCodec, transcode: shouldTranscode, outputIsHevc: isH265Output } =
      this.resolveOutputVideoCodec(probedCodec);

    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-rtsp_transport',
      transport,
      '-timeout',
      stimeout,
      '-i',
      rtspUrl,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      videoCodec,
      // H.265: use slower preset (medium) for better compression vs H.264 ultrafast
      ...(shouldTranscode && isH265Output ? ['-preset', 'medium', '-crf', '28'] : []),
      // H.264 (modo 'h264' com fonte não-H.264): preset rápido e qualidade alta.
      ...(shouldTranscode && !isH265Output ? ['-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'] : []),
      // A tag hvc1 NÃO se aplica ao MPEG-TS da captura; ela é aplicada no remux
      // TS→MP4 de cada segmento fechado (remuxTsSegment).
      ...(shouldTranscode && camera.recordingWidth && camera.recordingHeight
        ? ['-vf', `scale=${camera.recordingWidth}:${camera.recordingHeight}`]
        : []),
      ...(shouldTranscode && camera.recordingFps ? ['-r', String(camera.recordingFps)] : []),
      ...(shouldTranscode && camera.recordingBitrateKbps
        ? ['-b:v', `${camera.recordingBitrateKbps}k`, '-maxrate', `${camera.recordingBitrateKbps}k`]
        : []),
      '-c:a',
      this.audioCodec,
      '-ar',
      '44100',
      '-ac',
      '1',
      '-f',
      'segment',
      // MPEG-TS: container de captura tolerante a cortes/quedas (não depende de
      // moov nem de reinjetar parameter sets), suporta H.264 e HEVC em copy.
      // Cada segmento fechado vira MP4 via remux sem re-encode (remuxTsSegment).
      '-segment_format',
      'mpegts',
      // Normalizado no estreitamento: nenhum chamador consegue entregar 0,
      // negativo ou absurdo ao ffmpeg. Ver normalizeSegmentSeconds.
      '-segment_time',
      String(normalizeSegmentSeconds(segmentSeconds)),
      '-reset_timestamps',
      '1',
      '-strftime',
      '1',
      outputPattern,
    ];
    return args;
  }


  private async probeRecordedFileMetadata(filePath: string) {
    try {
      // Pede também os STREAMS: duração sozinha não prova que há vídeo. Um arquivo
      // só-áudio, ou com a trilha de vídeo estruturalmente quebrada, tem duração e
      // passaria como gravação boa — virando uma linha READY que não reproduz.
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration,size:stream=codec_type,codec_name',
        '-of',
        'json',
        filePath,
      ], {
        timeout: envNumber('RECORDING_METADATA_PROBE_TIMEOUT_MS', 15_000, { min: 5_000 }),
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(stdout || '{}') as {
        format?: { duration?: string; size?: string };
        streams?: Array<{ codec_type?: string; codec_name?: string }>;
      };
      const duration = Number(parsed.format?.duration);
      const size = Number(parsed.format?.size);
      const hasVideoStream = Array.isArray(parsed.streams)
        && parsed.streams.some((s) => s?.codec_type === 'video' && Boolean(s?.codec_name));
      return {
        durationSecondsExact: Number.isFinite(duration) && duration > 0 ? duration : null,
        sizeBytes: Number.isFinite(size) && size >= 0 ? size : statSync(filePath).size,
        hasVideoStream,
      };
    } catch {
      // Probe falhou: não afirmamos que há vídeo (o registro exige a prova).
      return { durationSecondsExact: null, sizeBytes: statSync(filePath).size, hasVideoStream: false };
    }
  }

  /** Duração que o segmento DEVERIA ter (a que o FFmpeg foi mandado produzir). */
  private getExpectedSegmentSeconds(segmentSeconds?: number | null) {
    const requested = Number(segmentSeconds);
    if (Number.isFinite(requested) && requested > 0) return requested;
    const configured = Number(this.configService.get<number>('recordingSegmentSeconds') ?? 300);
    return Number.isFinite(configured) && configured > 0 ? configured : 300;
  }

  /**
   * TETO de duração de UM segmento.
   *
   * Referência: Frigate (MIT) — Copyright (c) Frigate, Inc. — `MAX_SEGMENT_DURATION
   * = 600` em frigate/const.py; lá, duração fora de (0, 600) DESCARTA o segmento.
   * Aqui o teto existe, mas o desfecho é outro (ver o clamp em registerSegment).
   *
   * Nunca desce abaixo de 2× o segmento esperado: o FFmpeg fecha o segmento no
   * próximo keyframe, então passar um pouco do alvo é NORMAL e não pode ser
   * tratado como defeito (instalações com segmento longo ficariam clampadas
   * indevidamente por um teto fixo).
   */
  private getMaxSegmentDurationSeconds(segmentSeconds?: number | null) {
    const configured = envNumber('RECORDING_MAX_SEGMENT_DURATION_SECONDS', 600);
    const base = Number.isFinite(configured) && configured > 0 ? configured : 600;
    return Math.max(base, this.getExpectedSegmentSeconds(segmentSeconds) * 2);
  }

  /**
   * Marcador de auditoria do clamp de duração (seam de I/O). Best-effort: falhar
   * aqui NUNCA impede o registro do segmento.
   *
   * Nome próprio, `.duration-clamped.json`, e NÃO `.invalid.json`: este arquivo é
   * BOM (só o timestamp mentiu), enquanto `.invalid.json` é lido por outras áreas
   * como "não dá para usar" (pula miniatura, morre junto na retenção).
   */
  private async markSegmentDurationClamped(
    cameraId: string,
    filePath: string,
    probedDurationSeconds: number,
    appliedDurationSeconds: number,
  ) {
    await writeFile(
      `${filePath}.duration-clamped.json`,
      JSON.stringify(
        { cameraId, filePath, probedDurationSeconds, appliedDurationSeconds, clampedAt: new Date().toISOString() },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    ).catch((error) => {
      this.logger.warn(`Falha ao gravar marcador de duração clampada ${basename(filePath)}: ${sanitizeSensitiveText(error)}`);
    });
  }

  private async registerSegment(cameraId: string, filePath: string, segmentSeconds: number) {
    const fileName = basename(filePath);
    const match = fileName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\./);
    if (!match) return;

    const startedAt = new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ),
    );
    const metadata = await this.probeRecordedFileMetadata(filePath);
    if (metadata.durationSecondsExact == null) {
      throw new Error('segmento_mp4_invalido_ou_incompleto');
    }
    // Duração não é prova de vídeo: sem trilha de vídeo decodificável o arquivo
    // nunca vira linha READY (senão o playback ganha um item que não reproduz).
    if (!metadata.hasVideoStream) {
      throw new Error('segmento_mp4_sem_stream_de_video');
    }
    // TETO DE DURAÇÃO. Um salto de PTS (câmera que reinicia o relógio, RTSP com
    // timestamp maluco) faz o ffprobe reportar HORAS para um segmento de minutos.
    // Registrar isso vira #EXTINF mentiroso na playlist VOD: todos os segmentos
    // seguintes passam a "sobrepor" este e o playback TRAVA em cima de gravação
    // boa.
    //
    // CLAMPAMOS em vez de DESCARTAR (o Frigate descarta): o VÍDEO provavelmente
    // está íntegro — quem mentiu foi o timestamp. Descartar destruiria gravação
    // boa por causa de um metadado, exatamente o pior desfecho num VMS com valor
    // probatório. O clamp usa a duração ESPERADA do segmento, fica no log e deixa
    // marcador ao lado do arquivo para auditoria.
    let durationSecondsExact = metadata.durationSecondsExact;
    const maxSegmentDurationSeconds = this.getMaxSegmentDurationSeconds(segmentSeconds);
    if (durationSecondsExact > maxSegmentDurationSeconds) {
      const expectedSeconds = this.getExpectedSegmentSeconds(segmentSeconds);
      this.logger.warn(
        `Duração absurda no segmento camera=${cameraId} arquivo=${basename(filePath)}: `
        + `${durationSecondsExact.toFixed(2)}s > teto ${maxSegmentDurationSeconds}s (salto de PTS). `
        + `CLAMPADA para ${expectedSeconds}s — o vídeo é preservado, só o timestamp era inválido.`,
      );
      await this.markSegmentDurationClamped(cameraId, filePath, durationSecondsExact, expectedSeconds);
      durationSecondsExact = expectedSeconds;
    }
    const durationSeconds = Math.max(1, Math.round(durationSecondsExact));
    const endedAt = new Date(startedAt.getTime() + durationSecondsExact * 1000);
    const sizeBytes = BigInt(metadata.sizeBytes);
    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { recordingMode: true } });
    const triggerMode = camera?.recordingMode ?? 'unknown';

    let recording: { id: string };
    let created = false;
    try {
      const existing = await this.prisma.recording.findUnique({ where: { filePath }, select: { id: true } });
      if (existing) {
        recording = await this.prisma.recording.update({
          where: { id: existing.id },
          data: { endedAt, durationSeconds, sizeBytes, triggerMode },
          select: { id: true },
        });
      } else {
        recording = await this.prisma.recording.create({
          data: {
            cameraId,
            source: RecordingSource.LOCAL,
            triggerMode,
            startedAt,
            endedAt,
            durationSeconds,
            sizeBytes,
            filePath,
          },
          select: { id: true },
        });
        created = true;
      }
    } catch (error) {
      this.logger.warn(`Falha ao registrar segmento camera=${cameraId} arquivo=${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    if (!created) return;
    // Métrica (aditiva): segmento NOVO registrado. Só depois do commit no banco,
    // e nunca para uma re-registração do mesmo arquivo.
    try {
      cameraMetrics.recordSegment(cameraId);
    } catch { /* observabilidade nunca interrompe a gravação */ }
    try {
      await this.thumbnailQueue.add(
        'generate-thumbnail',
        { recordingId: recording.id },
        {
          jobId: `thumb-${recording.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: 200,
        },
      );
    } catch (error) {
      // A miniatura também será recuperada sob demanda quando a gravação for listada.
      this.logger.warn(`Falha ao enfileirar thumbnail recording=${recording.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

      // ENVIO PARA A NUVEM ASSIM QUE O SEGMENTO FECHA.
      //
      // Antes o vídeo esperava a próxima rodada do relógio — até 15 minutos
      // parado no disco, sendo um arquivo que já estava pronto. Numa frota que
      // produz ~312 gravações por hora, isso é fila permanente e disco cheio.
      //
      // `jobId` por janela de 10s faz o BullMQ descartar pedidos repetidos: 26
      // câmeras fechando segmento juntas enfileiravam 26 varreduras idênticas.
      // Uma basta — ela pega tudo que estiver pronto.
      //
      // A rodada periódica CONTINUA existindo como rede de segurança, para o que
      // falhou, o que chegou durante uma queda e o que este gatilho perdeu.
      // Trocar uma pela outra deixaria buraco.
      try {
        await this.cloudOffloadQueue.add(
          'offload',
          {},
          { jobId: `offload-${Math.floor(Date.now() / 10_000)}`, removeOnComplete: true, removeOnFail: 20 },
        );
      } catch (error) {
        // Falhar aqui não pode atrapalhar a gravação: a rodada periódica pega.
        this.logger.warn(`Falha ao enfileirar envio recording=${recording.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
  }

  private async probeLocalVideoCodec(filePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      return stdout.trim().split('\n')[0]?.trim().toLowerCase() || null;
    } catch {
      return null;
    }
  }

  // Remuxa um segmento .ts fechado para .mp4 SEM re-encode (mesmo pipeline dos
  // clipes): HEVC recebe a tag hvc1 obrigatória em MP4; +faststart deixa o moov
  // no início (seek imediato no navegador). Registra o MP4 no banco e apaga o
  // .ts de origem. Lança em caso de remux/registro inválido para a varredura
  // tentar de novo no próximo ciclo.
  private async remuxAndRegisterTsSegment(cameraId: string, tsPath: string, segmentSeconds: number) {
    // SEGMENTO VAZIO: descarta em vez de tentar remuxar.
    //
    // O ffmpeg cria o arquivo antes de escrever o primeiro byte. Se ele morre
    // nessa fresta — reinício da API, câmera que cai ao iniciar — sobra um .ts
    // de 0 byte. Medido: 4 de uma vez, mesmo minuto, 4 câmeras diferentes, num
    // reinício.
    //
    // Sem esta guarda, cada um desses gastava um ffprobe e um ffmpeg para
    // descobrir o óbvio, imprimia "Invalid data found" no log como se fosse
    // defeito, e ainda queimava tentativas até a quarentena. Não há vídeo ali:
    // não existe remux que salve 0 byte.
    try {
      if (statSync(tsPath).size === 0) {
        await unlink(tsPath).catch(() => undefined);
        this.logger.log(`Segmento vazio descartado (gravação interrompida ao iniciar): ${basename(tsPath)}`);
        return null;
      }
    } catch {
      // Sem stat não dá para decidir; segue o fluxo normal, que já trata falha.
    }
    const mp4Path = tsPath.replace(/\.ts$/i, '.mp4');
    if (!existsSync(mp4Path) || statSync(mp4Path).size === 0) {
      const codec = await this.probeLocalVideoCodec(tsPath);
      const isHevc = Boolean(codec && (codec.includes('hevc') || codec.includes('h265')));
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel', 'error',
          '-i', tsPath,
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-c', 'copy',
          ...(isHevc ? ['-tag:v', 'hvc1'] : []),
          '-movflags', '+faststart',
          mp4Path,
        ], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      } catch (error) {
        await unlink(mp4Path).catch(() => undefined);
        throw new Error(`remux_ts_falhou: ${sanitizeSensitiveText(error)}`);
      }
    }
    // fsync ANTES de registrar no Postgres (técnica moonfire `dir/writer.rs`): força
    // os bytes do MP4 para o disco enquanto a linha do banco ainda NÃO existe. Sem
    // isso, um corte de energia logo após o INSERT deixa um registro apontando para
    // um arquivo cujo conteúdo o kernel ainda não persistiu (0 byte/truncado). É
    // best-effort: se o fsync falhar, registramos mesmo assim (não fica pior que
    // hoje) e apenas avisamos.
    await this.fsyncFile(mp4Path).catch((error) => {
      this.logger.warn(`fsync do segmento falhou (registrando mesmo assim) ${basename(mp4Path)}: ${sanitizeSensitiveText(error)}`);
    });
    await this.registerSegment(cameraId, mp4Path, segmentSeconds);
    await unlink(tsPath).catch(() => undefined);
    return mp4Path;
  }

  /**
   * fsync de um arquivo pelo caminho. Abre em leitura (fsync no Linux opera sobre o
   * inode e persiste as escritas pendentes independentemente do modo de abertura) e
   * garante o `fdatasync`/`fsync` do handle antes de fechar.
   */
  private async fsyncFile(filePath: string): Promise<void> {
    const handle = await open(filePath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  // ── QUARENTENA DE SEGMENTO (.ts que se recusa a virar MP4) ───────────────────
  // Antes: o .ts que falhava no remux ficava FORA de `knownFiles` "para nova
  // tentativa" — sem contador e sem teto. A varredura roda a cada 5s enquanto a
  // câmera grava e `recoverOrphanedSegments` PULA câmera ativa (o caso normal
  // 24/7), então ninguém nunca resolvia: um único arquivo envenenado gerava
  // ffmpeg/ffprobe nascendo em LOOP para sempre, queimando CPU e inundando o log.
  //
  // Agora: teto de tentativas por arquivo e, estourado o teto, QUARENTENA —
  // marcador `<arquivo>.invalid.json` ao lado (mesma convenção já usada pelo
  // processador de miniaturas e pela retenção) e o arquivo sai do rodízio.
  //
  // DIVERGÊNCIA DELIBERADA DO FRIGATE: lá o segmento problemático é APAGADO
  // (`drop_segment`, frigate/record/maintainer.py). Aqui NÃO se apaga. O DRAC é
  // VMS com valor PROBATÓRIO: um .ts que o NOSSO remux não abre ainda pode ser
  // recuperável por perícia com outra ferramenta, e um falso positivo que destrói
  // gravação boa é pior que o problema original. Quarentena = para de custar CPU,
  // continua no disco, com o motivo registrado ao lado.

  private getSegmentRemuxMaxAttempts(): number {
    const configured = envNumber('RECORDING_SEGMENT_REMUX_MAX_ATTEMPTS', 3);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 3;
  }

  /**
   * Marcador de quarentena. O nome DEPENDE da extensão, e isso é deliberado:
   *
   *  - `.ts`  → `<arquivo>.invalid.json` — convenção já em produção; ninguém
   *    mais escreve marcador ao lado de um `.ts`, então não há colisão.
   *  - demais → `<arquivo>.orphan-quarantine.json` — porque
   *    `<arquivo>.mp4.invalid.json` JÁ TEM DONO: o processador de miniaturas o
   *    escreve para dizer "não consegui gerar a miniatura", caso em que o vídeo
   *    está BOM. Reusar o nome faria um MP4 perfeitamente reproduzível sair do
   *    rodízio de recuperação por uma falha que não é dele — e faria a retenção
   *    e o `recordings.service` lerem quarentena como falha de miniatura.
   */
  private segmentQuarantineMarkerPath(filePath: string) {
    return /\.ts$/i.test(filePath) ? `${filePath}.invalid.json` : `${filePath}.orphan-quarantine.json`;
  }

  /** Seam de I/O: há marcador de quarentena ao lado deste arquivo? Nunca lança. */
  private isSegmentQuarantined(filePath: string): boolean {
    try {
      return existsSync(this.segmentQuarantineMarkerPath(filePath));
    } catch {
      return false;
    }
  }

  /**
   * Contabiliza UMA falha de remux/registro do .ts.
   * Devolve `true` quando o teto estourou e o arquivo foi posto em QUARENTENA
   * (a partir daí ele não deve mais ser retentado).
   */
  private async registerSegmentRemuxFailure(
    cameraId: string,
    filePath: string,
    error: unknown,
    stage: 'remux' | 'leitura' = 'remux',
  ): Promise<boolean> {
    const attempts = (this.segmentRemuxFailures.get(filePath) ?? 0) + 1;
    const maxAttempts = this.getSegmentRemuxMaxAttempts();
    // sanitizeSensitiveText NÃO é decoração aqui: o texto vem do stderr do FFmpeg,
    // que carrega a URL RTSP INTEIRA (com senha da câmera), e este motivo vai para
    // o DISCO dentro do marcador.
    const reason = sanitizeSensitiveText(error).slice(0, 2_000) || 'remux_ts_falhou';

    if (attempts < maxAttempts) {
      this.segmentRemuxFailures.set(filePath, attempts);
      this.logger.warn(
        `Falha de ${stage} do segmento (tentativa ${attempts}/${maxAttempts}) camera=${cameraId} arquivo=${basename(filePath)}: ${reason}`,
      );
      return false;
    }

    this.segmentRemuxFailures.delete(filePath);
    try {
      await writeFile(
        this.segmentQuarantineMarkerPath(filePath),
        JSON.stringify({ cameraId, filePath, stage, attempts, reason, quarantinedAt: new Date().toISOString() }, null, 2) + '\n',
        { mode: 0o600 },
      );
    } catch (writeError) {
      // Sem marcador a quarentena não sobrevive a um reinício, mas o contador em
      // memória já cortou o loop nesta execução: avisa e segue.
      this.logger.warn(`Falha ao gravar marcador de quarentena ${basename(filePath)}: ${sanitizeSensitiveText(writeError)}`);
    }
    this.logger.error(
      `Segmento em QUARENTENA após ${attempts} tentativa(s) camera=${cameraId} arquivo=${basename(filePath)}: ${reason}. `
      + 'O arquivo NÃO foi apagado (VMS probatório) e não será mais retentado.',
    );
    return true;
  }

  private async recoverOrphanedSegments() {
    // try/catch de TOPO, como o irmão `enforceDiskGuard`. Esta rotina roda sob
    // `void this.recoverOrphanedSegments()` num setInterval: sem isto, uma
    // rejeição do Prisma (banco reiniciando, "too many connections") ou um
    // readdirSync/statSync que explode viram UNHANDLED REJECTION — e em Node 22
    // o default é derrubar o processo. A API morrendo não é só indisponibilidade:
    // RECORDING_AUTO_START_ENABLED é `false` por padrão, então a gravação
    // CONTÍNUA não volta sozinha depois do restart do container.
    try {
      await this.recoverOrphanedSegmentsInner();
    } catch (error) {
      this.logger.warn(`Falha na recuperação de segmentos órfãos: ${sanitizeSensitiveText(error)}`);
    }
  }

  private async recoverOrphanedSegmentsInner() {
    if (!this.checkFfmpegAvailable()) return;
    const graceSeconds = envNumber('RECORDING_ORPHAN_RECOVERY_GRACE_SECONDS', 300, { min: 60 });
    // RECORDING_ORPHAN_INVALID_DELETE_SECONDS foi APOSENTADO junto com o `unlink`
    // que ele governava — ver o bloco (D) logo abaixo. Deixar a variável inerte é
    // proposital: instalação que a tenha no .env não quebra, apenas não apaga mais.
    const limit = envNumber('RECORDING_ORPHAN_RECOVERY_LIMIT', 2_000, { min: 1, max: 10_000 });
    const cameras = await this.prisma.camera.findMany({ select: { id: true } });
    const registeredPaths = new Set((await this.prisma.recording.findMany({ select: { filePath: true } })).map((row) => row.filePath));
    const candidates: Array<{ cameraId: string; filePath: string; ageSeconds: number; kind: 'mp4' | 'ts' }> = [];
    const now = Date.now();

    for (const camera of cameras) {
      if (this.active.has(camera.id)) continue;
      const cameraRoot = buildCameraRootDir(this.recordingsRoot, camera.id);
      if (!existsSync(cameraRoot)) continue;
      const walk = (dir: string) => {
        if (candidates.length >= limit || this.active.has(camera.id)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.name.endsWith(`.${this.recordingFormat}`) && !registeredPaths.has(fullPath)) {
            const ageSeconds = Math.max(0, (now - statSync(fullPath).mtimeMs) / 1000);
            if (ageSeconds >= graceSeconds) candidates.push({ cameraId: camera.id, filePath: fullPath, ageSeconds, kind: 'mp4' });
          } else if (entry.name.endsWith('.ts')) {
            // Sobras de captura (queda do processo/da API). O .ts é reproduzível
            // até o ponto do corte: remuxa e recupera; inválidos antigos são
            // apagados. Se o .mp4 gêmeo já foi registrado, o .ts é só lixo.
            const ageSeconds = Math.max(0, (now - statSync(fullPath).mtimeMs) / 1000);
            if (ageSeconds >= graceSeconds) candidates.push({ cameraId: camera.id, filePath: fullPath, ageSeconds, kind: 'ts' });
          }
          if (candidates.length >= limit) return;
        }
      };
      walk(cameraRoot);
    }

    let recovered = 0;
    let quarantined = 0;
    const defaultSegmentSeconds = envNumber('RECORDING_SEGMENT_SECONDS', 300, { min: SEGMENT_SECONDS_MIN, max: SEGMENT_SECONDS_MAX, integer: true });

    // ── (D) UMA ÚNICA POLÍTICA PARA A MESMA FALHA ────────────────────────────
    // Antes, "não consegui recuperar este segmento" tinha DUAS respostas neste
    // mesmo arquivo: `performSegmentScan` (câmera ativa) contava tentativas e
    // punha em quarentena, preservando o vídeo; aqui, um `unlink` depois de 1h,
    // sem contador e sem marcador.
    //
    // A assimetria era perversa porque este laço PULA câmera ativa: a única
    // política que destruía era a que só alcança gravação de câmera que parou —
    // justamente o material que ninguém está olhando e que tem mais chance de
    // ser o incidente que importava. Um soluço de ffprobe bastava.
    //
    // Agora ambos os ramos passam pelo mesmo `registerSegmentRemuxFailure`:
    // teto de tentativas, marcador com o motivo e o arquivo INTACTO no disco.
    for (const candidate of candidates) {
      if (this.active.has(candidate.cameraId)) continue;
      // Teto já gasto: sai do rodízio sem custar ffmpeg/ffprobe de novo.
      if (this.isSegmentQuarantined(candidate.filePath)) continue;

      if (candidate.kind === 'ts') {
        // .mp4 gêmeo já registrado → o .ts é só lixo de captura, não gravação.
        const mp4Twin = candidate.filePath.replace(/\.ts$/i, '.mp4');
        if (registeredPaths.has(mp4Twin)) {
          await unlink(candidate.filePath).catch(() => undefined);
          continue;
        }
        try {
          const mp4Path = await this.remuxAndRegisterTsSegment(candidate.cameraId, candidate.filePath, defaultSegmentSeconds);
          // `null` = segmento vazio, já descartado. Não é recuperação nem falha:
          // contá-lo como recuperado inflaria o número da varredura.
          if (mp4Path) {
            registeredPaths.add(mp4Path);
            recovered += 1;
          }
          this.segmentRemuxFailures.delete(candidate.filePath);
        } catch (error) {
          if (await this.registerSegmentRemuxFailure(candidate.cameraId, candidate.filePath, error)) quarantined += 1;
        }
        continue;
      }

      try {
        const metadata = await this.probeRecordedFileMetadata(candidate.filePath);
        if (metadata.durationSecondsExact == null) throw new Error('mp4_orfao_ilegivel: ffprobe não devolveu duração');
        await this.registerSegment(candidate.cameraId, candidate.filePath, defaultSegmentSeconds);
        registeredPaths.add(candidate.filePath);
        this.segmentRemuxFailures.delete(candidate.filePath);
        recovered += 1;
      } catch (error) {
        if (await this.registerSegmentRemuxFailure(candidate.cameraId, candidate.filePath, error, 'leitura')) quarantined += 1;
      }
    }
    if (candidates.length || recovered || quarantined) {
      this.logger.log(`Recuperação de segmentos órfãos: inspecionados=${candidates.length}, recuperados=${recovered}, em quarentena=${quarantined} (nenhum arquivo apagado).`);
    }
  }

  private async performSegmentScan(state: RecordingProcessState, finalize: boolean) {
    const { cameraId, cameraRootDir, segmentSeconds, knownFiles } = state;
    const files: string[] = [];
    const walk = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (entry.name.endsWith('.ts')) files.push(fullPath);
      }
    };

    walk(cameraRootDir);
    files.sort((left, right) => left.localeCompare(right));
    // O arquivo lexicograficamente mais novo é o segmento que o FFmpeg ainda
    // pode estar escrevendo. Ele só é processado depois da rotação, ou no close.
    const candidates = finalize ? files : files.slice(0, -1);
    for (const fullPath of candidates) {
      if (knownFiles.has(fullPath)) continue;
      // Quarentena persistida em disco: sobrevive ao reinício do processo (o
      // contador em memória, não) e impede o loop de ffmpeg de renascer.
      if (this.isSegmentQuarantined(fullPath)) {
        knownFiles.add(fullPath);
        continue;
      }
      // Vazio aqui é lixo CONFIRMADO: o segmento que o ffmpeg ainda pode estar
      // escrevendo é o mais novo, e ele já ficou de fora de `candidates`. O que
      // sobra com 0 byte é de uma gravação que morreu ao iniciar.
      //
      // Antes isto era `continue`, e o arquivo ficava no disco PARA SEMPRE: esta
      // varredura o pulava, e a varredura de órfãos pula câmera ativa. Ninguém
      // mais passava por ele.
      if (statSync(fullPath).size <= 0) {
        await unlink(fullPath).catch(() => undefined);
        knownFiles.add(fullPath);
        this.logger.log(`Segmento vazio descartado (gravação interrompida ao iniciar): ${basename(fullPath)}`);
        continue;
      }
      try {
        await this.remuxAndRegisterTsSegment(cameraId, fullPath, segmentSeconds);
        knownFiles.add(fullPath);
        this.segmentRemuxFailures.delete(fullPath);
      } catch (error) {
        // Continua fora de knownFiles para uma nova tentativa na próxima
        // varredura — MAS agora com teto: estourado, vai para quarentena e para
        // de custar CPU (o arquivo permanece no disco).
        if (await this.registerSegmentRemuxFailure(cameraId, fullPath, error)) {
          knownFiles.add(fullPath);
        }
      }
    }
  }

  private async scanAndRegister(state: RecordingProcessState, finalize = false) {
    if (state.scanInFlight) {
      await state.scanInFlight;
      if (!finalize) return;
    }
    const operation = this.performSegmentScan(state, finalize);
    state.scanInFlight = operation;
    try {
      await operation;
    } catch (error) {
      this.logger.warn(`Falha ao varrer segmentos camera=${state.cameraId}: ${(error as Error).message}`);
    } finally {
      if (state.scanInFlight === operation) state.scanInFlight = null;
    }
  }

  private finalizeRecordingState(cameraId: string, state: RecordingProcessState, exitCode?: number | null) {
    if (state.finalizePromise) return state.finalizePromise;
    // A morte foi ANORMAL (queda) ou a parada foi PEDIDA (stop/post-roll/
    // shutdown/rollback)? Tudo que é reação a queda pendura aqui — e só aqui,
    // depois do guard acima, então cada morte é tratada UMA vez.
    const abnormal = !state.stopRequested;
    if (abnormal) {
      // Métrica (aditiva).
      try {
        cameraMetrics.recordRecordingRestart(cameraId);
      } catch { /* observabilidade nunca interrompe a finalização */ }
      // Diagnóstico: despeja o stderr acumulado deste processo, de uma vez.
      this.dumpStderrRing(cameraId, state, exitCode ?? null);
    }
    state.finalizePromise = (async () => {
      clearInterval(state.watcher);
      await this.scanAndRegister(state, true);
      if (this.active.get(cameraId) === state) this.active.delete(cameraId);
      this.logger.log(`Gravação encerrada camera=${cameraId} code=${exitCode ?? 'null'}`);
      // Depois de soltar a câmera do mapa `active`: quem for reiniciar precisa
      // enxergar que não há mais gravação de pé.
      if (abnormal) this.scheduleRecordingRestart(cameraId, state, exitCode ?? null);
    })();
    return state.finalizePromise;
  }

  /**
   * Despeja no log as últimas linhas de stderr do processo que MORREU.
   * Só na morte anormal (o chamador garante) e uma única vez (o ring esvazia).
   * Já vem sanitizado do ring; sanitiza o bloco de novo por garantia — este
   * texto vem do FFmpeg e carrega a URL RTSP com a senha da câmera.
   */
  private dumpStderrRing(cameraId: string, state: RecordingProcessState, exitCode: number | null) {
    try {
      const ring = state.stderrRing;
      if (!ring) return;
      const lines = drainStderrRing(ring);
      if (!lines.length) return;
      this.logger.error(
        `FFmpeg de gravação MORREU camera=${cameraId} code=${exitCode ?? 'null'} — `
        + `últimas ${lines.length} linha(s) de stderr:\n${sanitizeSensitiveText(lines.join('\n'))}`,
      );
    } catch { /* diagnóstico JAMAIS derruba a finalização da gravação */ }
  }

  // ── REINÍCIO IMEDIATO DA GRAVAÇÃO MORTA ─────────────────────────────────────
  // Antes: a morte do processo só era notada pelo health-check (limiar de
  // estagnação + cron de 60s) — até ~7 MINUTOS de gravação perdida por câmera,
  // por morte. O Frigate supervisiona DENTRO do processo, num laço de 1s
  // (frigate/video/ffmpeg.py: `if not self.capture_thread.is_alive()` →
  // `reset_capture_thread()`, com pacing por `last_restart_time`). Aqui o
  // gatilho é a própria saída do processo, então a detecção é instantânea.
  //
  // O health-check CONTINUA existindo como rede de segurança (ele cobre o caso
  // "processo vivo mas parado de escrever", que este caminho não vê).

  private isAutoRestartEnabled(): boolean {
    return String(process.env.RECORDING_AUTO_RESTART_ENABLED ?? 'true') !== 'false';
  }

  private nowMs(): number {
    return Date.now();
  }

  // Delega ao helper único do projeto: uma porta de entrada só para leitura de
  // configuração numérica, para o comportamento (piso, aviso, NUNCA-NaN) não
  // divergir entre implementações.
  private readEnvNumber(nome: string, padrao: number, minimo: number): number {
    return envNumber(nome, padrao, { min: minimo, integer: true, onInvalid: (m) => this.logger.warn(m) });
  }

  private getRestartMaxAttempts(): number {
    return this.readEnvNumber(
      'RECORDING_AUTO_RESTART_MAX_ATTEMPTS',
      RecordingProcessManagerService.RESTART_BRAKE_MAX_ATTEMPTS,
      1,
    );
  }

  private getRestartWindowMs(): number {
    return this.readEnvNumber(
      'RECORDING_AUTO_RESTART_WINDOW_MS',
      RecordingProcessManagerService.RESTART_BRAKE_WINDOW_MS,
      1_000,
    );
  }

  private getRestartBaseDelayMs(): number {
    return this.readEnvNumber(
      'RECORDING_AUTO_RESTART_BASE_DELAY_MS',
      RecordingProcessManagerService.RESTART_BASE_DELAY_MS,
      1,
    );
  }

  private getRestartMaxDelayMs(): number {
    return this.readEnvNumber(
      'RECORDING_AUTO_RESTART_MAX_DELAY_MS',
      RecordingProcessManagerService.RESTART_MAX_DELAY_MS,
      1,
    );
  }

  /**
   * Decide SE e QUANDO reiniciar. Backoff exponencial (1s, 2s, 4s… até o teto) e
   * janela DESLIZANTE: quedas antigas não contam, senão uma câmera que oscila de
   * vez em quando acabaria freada para sempre.
   */
  private planRecordingRestart(cameraId: string) {
    const now = this.nowMs();
    const windowMs = this.getRestartWindowMs();
    const maxAttempts = this.getRestartMaxAttempts();
    const previous = (this.restartAttempts.get(cameraId) ?? []).filter((at) => at > now - windowMs);

    if (previous.length >= maxAttempts) {
      this.restartAttempts.set(cameraId, previous);
      return { allowed: false, attempt: previous.length, delayMs: 0, maxAttempts, windowMs };
    }

    const delayMs = Math.min(this.getRestartMaxDelayMs(), this.getRestartBaseDelayMs() * 2 ** previous.length);
    previous.push(now);
    this.restartAttempts.set(cameraId, previous);
    return { allowed: true, attempt: previous.length, delayMs, maxAttempts, windowMs };
  }

  /**
   * Cancela o reinício pendente e zera o histórico (o desejado mudou).
   * NUNCA lança: a contabilidade do reinício não pode impedir uma PARADA.
   */
  private cancelPendingRestart(cameraId: string) {
    try {
      const timer = this.restartTimers?.get(cameraId);
      if (timer) {
        clearTimeout(timer);
        this.restartTimers.delete(cameraId);
      }
      this.restartAttempts?.delete(cameraId);
    } catch { /* parar a gravação vem antes de qualquer bookkeeping */ }
  }

  private scheduleRecordingRestart(cameraId: string, state: RecordingProcessState, exitCode: number | null) {
    try {
      // INVARIANTE: parada PEDIDA (stop, post-roll de movimento, shutdown,
      // rollback do start) JAMAIS reinicia. Reiniciar o que o operador mandou
      // parar seria pior que o bug original.
      if (state.stopRequested) return;
      if (this.shuttingDown) return;
      if (this.controlMode !== 'local') return;
      if (!this.isAutoRestartEnabled()) return;
      if (this.restartTimers.has(cameraId)) return; // já há um reinício no forno
      if (this.active.has(cameraId)) return; // outra gravação já assumiu a câmera

      const plan = this.planRecordingRestart(cameraId);
      if (!plan.allowed) {
        this.logger.error(
          `Gravação camera=${cameraId} caiu de novo (code=${exitCode ?? 'null'}) e o FREIO ANTI-TEMPESTADE está armado: `
          + `${plan.maxAttempts} reinícios em ${Math.round(plan.windowMs / 60_000)} min sem estabilizar. `
          + 'Novas tentativas automáticas ficam suspensas até a janela deslizar — o health-check segue como rede de '
          + 'segurança. A câmera provavelmente está offline de verdade: verifique link/energia/credenciais no local.',
        );
        return;
      }

      const timer = setTimeout(() => {
        void this.restartRecordingAfterCrash(cameraId, state.segmentSeconds, plan.attempt, plan.maxAttempts);
      }, plan.delayMs);
      timer.unref?.();
      this.restartTimers.set(cameraId, timer);
      this.logger.warn(
        `Gravação camera=${cameraId} MORREU sem pedido de parada (code=${exitCode ?? 'null'}). `
        + `Reiniciando em ${plan.delayMs}ms (tentativa ${plan.attempt}/${plan.maxAttempts}).`,
      );
    } catch (error) {
      // Agendar reinício é melhoria: se falhar, o health-check continua sendo a
      // rede de segurança — mas nunca pode derrubar a finalização.
      this.logger.warn(`Falha ao agendar reinício da gravação camera=${cameraId}: ${sanitizeSensitiveText(error)}`);
    }
  }

  private async restartRecordingAfterCrash(
    cameraId: string,
    segmentSeconds: number,
    attempt: number,
    maxAttempts: number,
  ) {
    try {
      this.restartTimers.delete(cameraId);
      if (this.shuttingDown) return;
      if (this.active.has(cameraId)) return; // alguém já retomou (health-check/operador)

      // SEGUNDA barreira contra ressuscitar parada pedida: o estado DESEJADO
      // mora no banco. `stop()` (e o post-roll de movimento, que passa por ele)
      // grava recordingEnabled=false ANTES de matar o processo.
      const camera = await this.prisma.camera.findUnique({
        where: { id: cameraId },
        select: { recordingEnabled: true, enabled: true },
      });
      if (!camera || camera.recordingEnabled !== true || camera.enabled === false) {
        this.logger.log(`Reinício de gravação camera=${cameraId} cancelado: o estado desejado não é gravar.`);
        return;
      }

      const seconds = Number.isFinite(segmentSeconds) && segmentSeconds > 0
        ? segmentSeconds
        : envNumber('RECORDING_SEGMENT_SECONDS', 300, { min: SEGMENT_SECONDS_MIN, max: SEGMENT_SECONDS_MAX, integer: true });
      await this.start(cameraId, seconds);
      this.logger.log(`Gravação camera=${cameraId} REINICIADA após queda (tentativa ${attempt}/${maxAttempts}).`);
    } catch (error) {
      // Não reagenda aqui de propósito: `start()` só lança por motivo
      // ESTRUTURAL (disco cheio, política comercial, câmera sumida) — insistir
      // em ciclo seria a tempestade que o freio existe para evitar. Se o ffmpeg
      // subir e morrer de novo, o caminho normal de queda cuida do resto.
      this.logger.error(`Falha ao reiniciar gravação camera=${cameraId} após queda: ${sanitizeSensitiveText(error)}`);
    }
  }

  private async stopProcessAndWait(state: RecordingProcessState) {
    const proc = state.process;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(giveUpTimer);
        resolve();
      };
      proc.once('close', finish);
      proc.once('error', finish);
      proc.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      }, 2_500);
      const giveUpTimer = setTimeout(finish, 7_500);
      forceTimer.unref();
      giveUpTimer.unref();
    });
  }

  // Resolve o que gravar em `recordingMode` num start/stop. Uma gravação MANUAL
  // ad-hoc NÃO pode desarmar uma câmera configurada para 'motion' — senão clicar
  // "Gravar" numa câmera com gravação por movimento a deixa em 'manual' para
  // sempre. Então um pedido 'manual' sobre uma câmera 'motion' é ignorado
  // (preserva o armamento). Os demais modos seguem o pedido normalmente.
  private async resolveRecordingModeUpdate(
    cameraId: string,
    requested?: Camera['recordingMode'],
  ): Promise<{ recordingMode?: Camera['recordingMode'] }> {
    if (!requested) return {};
    if (requested === 'manual') {
      const cam = await this.prisma.camera.findUnique({
        where: { id: cameraId },
        select: { recordingMode: true },
      });
      if (cam?.recordingMode === 'motion') return {};
    }
    return { recordingMode: requested };
  }

  async start(cameraId: string, segmentSeconds: number, options?: { recordingMode?: Camera['recordingMode'] }) {
    const enabledRow = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { enabled: true } });
    if (enabledRow && enabledRow.enabled === false) {
      throw new BadRequestException('Câmera desativada — reative-a para gravar.');
    }
    await this.commercialPolicy.assertFeature('localRecording');
    await this.assertStorageWritable();
    await this.assertMinimumStorageFree();

    if (this.controlMode === 'worker') {
      await this.camerasService.getCameraOrThrow(cameraId).catch(() => {
        throw new NotFoundException('Camera não encontrada.');
      });
      await this.prisma.camera.update({
        where: { id: cameraId },
        data: { recordingEnabled: true, ...(await this.resolveRecordingModeUpdate(cameraId, options?.recordingMode)) },
      });
      await this.publishWorkerCommand({
        action: 'start',
        cameraId,
        segmentSeconds,
        requestedAt: new Date().toISOString(),
      });
      return {
        status: 'recording_start_requested',
        cameraId,
        segmentSeconds,
        mode: 'worker',
      };
    }

    const camera = await this.camerasService.getCameraOrThrow(cameraId).catch(() => {
      throw new NotFoundException('Camera não encontrada.');
    });

    if (this.active.has(cameraId)) {
      const state = this.active.get(cameraId)!;
      await this.prisma.camera.update({
        where: { id: cameraId },
        data: { recordingEnabled: true, ...(await this.resolveRecordingModeUpdate(cameraId, options?.recordingMode)) },
      });
      return {
        status: 'already_recording',
        cameraId,
        segmentSeconds: state.segmentSeconds,
      };
    }

    if (!this.checkFfmpegAvailable()) {
      throw new ServiceUnavailableException('FFmpeg não está instalado no servidor.');
    }

    const password = this.cryptoService.decrypt(camera.passwordEncrypted);
    const rtspUrl = this.buildRtsp(camera, password);
    const recordingTransport = camera.preferredRtspTransport ?? this.configService.get<string>('ffmpegRtspTransport') ?? 'tcp';
    const sourceCodec = await this.probeSourceCodec(rtspUrl, recordingTransport);
    const startDate = new Date();
    const outputDir = buildRecordingOutputDir(this.recordingsRoot, cameraId, startDate);
    const cameraRootDir = buildCameraRootDir(this.recordingsRoot, cameraId);
    // Captura sempre em .ts; o .mp4 final (this.recordingFormat) nasce no remux.
    const outputPattern = buildRecordingOutputPattern(outputDir, 'ts');

    mkdirSync(outputDir, { recursive: true });

    const args = this.buildArgs(camera, rtspUrl, outputPattern, segmentSeconds, sourceCodec);
    const resolvedOutput = this.resolveOutputVideoCodec(sourceCodec);
    const outputVideoCodec = resolvedOutput.transcode
      ? resolvedOutput.videoCodec
      : `copy-${resolvedOutput.outputIsHevc ? 'hevc' : sourceCodec ?? 'source'}`;
    this.logger.log(`Iniciando gravação camera=${cameraId} mode=${this.recordingCodecMode} sourceCodec=${sourceCodec ?? 'unknown'} output=${outputVideoCodec} rtsp=${this.sanitizeRtspUrl(rtspUrl)}`);

    // A GRAVAÇÃO é o caminho crítico: spawn DIRETO do ffmpeg, em prioridade
    // NORMAL. Quem cede a vez (nice) são os ffmpeg auxiliares do recordings.service.
    const proc = spawnWithSecretUrl(
      'ffmpeg',
      args,
      rtspUrl,
      { stdio: ['ignore', 'ignore', 'pipe'] },
    ) as ChildProcessByStdio<null, null, Readable>;
    let state: RecordingProcessState | null = null;
    // Ring do stderr: teto rígido de linhas, despejado só se o processo MORRER
    // anormalmente. Em produção o nível DEBUG abaixo fica desligado — sem o ring
    // não sobra nada para responder "por que a câmera parou de gravar às 3h?".
    const stderrRing = createStderrRing(
      envNumber('RECORDING_STDERR_RING_LINES', DEFAULT_STDERR_RING_LINES, {
        min: 1,
        max: 2_000,
        integer: true,
        onInvalid: (m) => this.logger.warn(m),
      }),
    );
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      try {
        appendStderrChunk(stderrRing, text);
      } catch { /* diagnóstico nunca atrapalha a captura */ }
      const msg = sanitizeSensitiveText(text.trim());
      if (msg) this.logger.debug(`FFmpeg REC camera=${cameraId}: ${msg}`);
    });

    proc.on('close', (code) => {
      const current = state ?? this.active.get(cameraId);
      if (current) void this.finalizeRecordingState(cameraId, current, code);
    });
    proc.on('error', (error) => {
      this.logger.error(`Falha no processo FFmpeg de gravação camera=${cameraId}: ${sanitizeSensitiveText(error)}`);
      // NÃO tocar em `recordingEnabled` aqui. Esse campo é o ESTADO DESEJADO do
      // cliente (lido como `intendedRecording` no getStatus) — uma falha de RUNTIME
      // do FFmpeg (câmera fora, link caído, binário ocupado) não pode desarmar a
      // gravação de forma permanente: a câmera pararia de gravar e não voltaria
      // sozinha nunca mais, nem após reinício. Só uma ação explícita (stop/modo)
      // muda o desejado; a falha é tratada como estado de runtime abaixo.
      const current = state ?? this.active.get(cameraId);
      if (current) void this.finalizeRecordingState(cameraId, current, proc.exitCode);
    });

    const watcher = setInterval(() => {
      const current = this.active.get(cameraId);
      if (current) {
        void this.scanAndRegister(current);
      }
    }, 5000);
    watcher.unref();

    state = {
      cameraId,
      process: proc,
      startedAt: startDate,
      outputDir,
      cameraRootDir,
      outputPattern,
      segmentSeconds,
      pid: proc.pid ?? -1,
      watcher,
      knownFiles: new Set<string>(),
      scanInFlight: null,
      finalizePromise: null,
      stderrRing,
    };

    this.active.set(cameraId, state);
    try {
      await this.prisma.camera.update({
        where: { id: cameraId },
        data: { recordingEnabled: true, ...(await this.resolveRecordingModeUpdate(cameraId, options?.recordingMode)) },
      });
    } catch (error) {
      state.stopRequested = true; // rollback do start: parada PEDIDA, não queda
      await this.stopProcessAndWait(state);
      await this.finalizeRecordingState(cameraId, state, state.process.exitCode);
      throw error;
    }

    return {
      status: 'recording_started',
      cameraId,
      segmentSeconds,
    };
  }

  async stop(cameraId: string, options?: { recordingMode?: Camera['recordingMode'] }) {
    if (this.controlMode === 'worker') {
      await this.camerasService.getCameraOrThrow(cameraId).catch(() => {
        throw new NotFoundException('Camera não encontrada.');
      });
      await this.prisma.camera.update({
        where: { id: cameraId },
        data: { recordingEnabled: false, ...(await this.resolveRecordingModeUpdate(cameraId, options?.recordingMode)) },
      });
      await this.publishWorkerCommand({
        action: 'stop',
        cameraId,
        requestedAt: new Date().toISOString(),
      });
      return {
        status: 'recording_stop_requested',
        cameraId,
        mode: 'worker',
      };
    }

    await this.camerasService.getCameraOrThrow(cameraId).catch(() => {
      throw new NotFoundException('Camera não encontrada.');
    });
    await this.prisma.camera.update({
      where: { id: cameraId },
      data: { recordingEnabled: false, ...(await this.resolveRecordingModeUpdate(cameraId, options?.recordingMode)) },
    });

    // O desejado agora é NÃO gravar: mata qualquer reinício automático que tenha
    // sido agendado por uma queda anterior (a parada vence a corrida).
    this.cancelPendingRestart(cameraId);

    const state = this.active.get(cameraId);
    if (!state) {
      return {
        status: 'not_recording',
        cameraId,
      };
    }

    clearInterval(state.watcher);
    // ANTES do kill: o handler `proc.on('close')` chama finalize primeiro, e sem
    // esta marca toda parada normal viraria "reinício" na métrica.
    state.stopRequested = true;
    await this.stopProcessAndWait(state);
    await this.finalizeRecordingState(cameraId, state, state.process.exitCode);

    return {
      status: 'recording_stopped',
      cameraId,
    };
  }

  /** Nº de gravações locais ativas (gauge de /metrics — agregado, sem PII). */
  getActiveRecordingCount(): number {
    return this.active.size;
  }

  private isPidAlive(pid: number | null | undefined): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // ESRCH = processo não existe (morto); EPERM = existe mas não é nosso (vivo).
      return err?.code === 'EPERM';
    }
  }

  /**
   * Dados de banco de que o status precisa, pré-buscados em LOTE.
   *
   * O caminho antigo fazia 3 consultas POR CÂMERA (última gravação, flag da
   * câmera, último evento de reconexão) — e /recordings/statuses é chamado a
   * cada ciclo do painel: 27 câmeras = 81 consultas por poll; 500 = 1.500.
   * `DISTINCT ON` resolve "a última por câmera" numa consulta só por tipo.
   */
  private async contextoDeStatus(cameraIds: string[]): Promise<{
    cams: Map<string, { recordingEnabled: boolean | null }>;
    ultimasGravacoes: Map<string, { startedAt: Date; endedAt: Date | null; filePath: string }>;
    ultimasReconexoes: Map<string, { type: string; occurredAt: Date }>;
  }> {
    if (!cameraIds.length) {
      return { cams: new Map(), ultimasGravacoes: new Map(), ultimasReconexoes: new Map() };
    }
    const [cams, ultimas, reconexoes] = await Promise.all([
      this.prisma.camera.findMany({ where: { id: { in: cameraIds } }, select: { id: true, recordingEnabled: true } }),
      this.prisma.$queryRaw<Array<{ cameraId: string; startedAt: Date; endedAt: Date | null; filePath: string }>>(
        Prisma.sql`SELECT DISTINCT ON ("cameraId") "cameraId", "startedAt", "endedAt", "filePath"
          FROM "Recording" WHERE "cameraId" IN (${Prisma.join(cameraIds)})
          ORDER BY "cameraId", "startedAt" DESC`,
      ),
      this.prisma.$queryRaw<Array<{ cameraId: string; type: string; occurredAt: Date }>>(
        Prisma.sql`SELECT DISTINCT ON ("cameraId") "cameraId", "type", "occurredAt"
          FROM "CameraEvent" WHERE "cameraId" IN (${Prisma.join(cameraIds)})
            AND "type" IN ('HEALTH_RECORDING_RECONNECT_REQUESTED', 'HEALTH_RECORDING_RECONNECT_SUCCESS', 'HEALTH_RECORDING_RECONNECT_FAILED')
          ORDER BY "cameraId", "occurredAt" DESC`,
      ),
    ]);
    return {
      cams: new Map(cams.map((c) => [c.id, { recordingEnabled: c.recordingEnabled }])),
      ultimasGravacoes: new Map(ultimas.map((r) => [r.cameraId, r])),
      ultimasReconexoes: new Map(reconexoes.map((e) => [e.cameraId, e])),
    };
  }

  async getStatus(cameraId: string) {
    return this.montarStatus(cameraId, await this.contextoDeStatus([cameraId]));
  }

  private montarStatus(cameraId: string, contexto: Awaited<ReturnType<RecordingProcessManagerService['contextoDeStatus']>>) {
    const nowMs = Date.now();
    const latestRecording = contexto.ultimasGravacoes.get(cameraId) ?? null;
    const cam = contexto.cams.get(cameraId) ?? null;
    const lastSegmentAtMs = latestRecording ? new Date(latestRecording.endedAt ?? latestRecording.startedAt).getTime() : null;
    const lastSegmentAgeSeconds = lastSegmentAtMs == null ? null : Math.max(0, Math.floor((nowMs - lastSegmentAtMs) / 1000));
    const inferredRecentRecording = lastSegmentAgeSeconds != null && lastSegmentAgeSeconds < 15 * 60;
    const staleThresholdSeconds = this.getRecordingStaleThresholdSeconds();
    const reconnectGraceSeconds = Math.max(staleThresholdSeconds, 180);
    const reconnectGraceAt = new Date(nowMs - reconnectGraceSeconds * 1000);
    const latestReconnectEvent = contexto.ultimasReconexoes.get(cameraId) ?? null;
    // ADITIVO: diagnóstico de progresso do arquivo em escrita. Só faz I/O quando
    // existe processo local ativo; nos demais casos devolve applicable=false.
    // NENHUM campo existente muda por causa dele — em especial `stale` continua
    // significando exatamente o que significava antes.
    const writeProgress = this.safeRecordingWriteProgress(cameraId);

    if (this.controlMode === 'worker') {
      const intended = Boolean(cam?.recordingEnabled);
      const isRecording = intended && inferredRecentRecording;
      const staleCandidate = intended && (lastSegmentAgeSeconds == null ? true : lastSegmentAgeSeconds > staleThresholdSeconds);
      const autoRecovering = Boolean(
        staleCandidate &&
        latestReconnectEvent &&
        latestReconnectEvent.occurredAt >= reconnectGraceAt &&
        (latestReconnectEvent.type === 'HEALTH_RECORDING_RECONNECT_REQUESTED' ||
          latestReconnectEvent.type === 'HEALTH_RECORDING_RECONNECT_SUCCESS'),
      );
      const stale = staleCandidate && !autoRecovering;
      return {
        cameraId,
        isRecording,
        intendedRecording: intended,
        startedAt: latestRecording?.startedAt?.toISOString() ?? null,
        lastSegmentAt: lastSegmentAtMs == null ? null : new Date(lastSegmentAtMs).toISOString(),
        lastSegmentAgeSeconds,
        hasRecentSegment: inferredRecentRecording,
        staleThresholdSeconds,
        stale,
        statusDetail: !intended ? 'disabled' : autoRecovering ? 'auto_reconnecting' : isRecording ? 'recording_ok' : 'worker_enabled_but_no_recent_segment',
        pid: null,
        currentOutputPattern: latestRecording?.filePath ?? null,
        mode: 'worker',
        writeStalled: writeProgress.stalled,
        writeProgress,
      };
    }

    const state = this.active.get(cameraId);
    if (!state) {
      const intended = Boolean(cam?.recordingEnabled);
      const isRecording = intended && inferredRecentRecording;
      const staleCandidate = intended && (lastSegmentAgeSeconds == null ? true : lastSegmentAgeSeconds > staleThresholdSeconds);
      const autoRecovering = Boolean(
        staleCandidate &&
        latestReconnectEvent &&
        latestReconnectEvent.occurredAt >= reconnectGraceAt &&
        (latestReconnectEvent.type === 'HEALTH_RECORDING_RECONNECT_REQUESTED' ||
          latestReconnectEvent.type === 'HEALTH_RECORDING_RECONNECT_SUCCESS'),
      );
      const stale = staleCandidate && !autoRecovering;
      return {
        cameraId,
        isRecording,
        intendedRecording: intended,
        startedAt: latestRecording?.startedAt?.toISOString() ?? null,
        lastSegmentAt: lastSegmentAtMs == null ? null : new Date(lastSegmentAtMs).toISOString(),
        lastSegmentAgeSeconds,
        hasRecentSegment: inferredRecentRecording,
        staleThresholdSeconds,
        stale,
        statusDetail: !intended ? 'disabled' : autoRecovering ? 'auto_reconnecting' : isRecording ? 'recording_ok' : 'enabled_but_idle',
        pid: null,
        currentOutputPattern: latestRecording?.filePath ?? null,
        writeStalled: writeProgress.stalled,
        writeProgress,
      };
    }

    const processAlive = this.isPidAlive(state.pid);
    return {
      cameraId,
      isRecording: processAlive,
      intendedRecording: true,
      startedAt: state.startedAt.toISOString(),
      lastSegmentAt: lastSegmentAtMs == null ? null : new Date(lastSegmentAtMs).toISOString(),
      lastSegmentAgeSeconds,
      hasRecentSegment: inferredRecentRecording,
      staleThresholdSeconds,
      stale: !processAlive,
      statusDetail: processAlive ? 'recording_ok_local_process' : 'local_process_dead',
      pid: state.pid,
      currentOutputPattern: state.outputPattern,
      // ADITIVO: processo VIVO que parou de escrever bytes. Deliberadamente fora de
      // `stale` — quem decide reiniciar é o health-check (com cooldown e grace),
      // e mudar `stale` aqui alteraria o comportamento de quem já consome o status.
      writeStalled: writeProgress.stalled,
      writeProgress,
    };
  }

  async getStatuses(cameraIds: string[]) {
    const uniqueIds = [...new Set(cameraIds)].filter((id) => id.trim().length > 0).slice(0, 500);
    const contexto = await this.contextoDeStatus(uniqueIds);
    const items = uniqueIds.map((cameraId) => this.montarStatus(cameraId, contexto));
    const staleCount = items.filter((item: any) => item.stale).length;
    const recordingCount = items.filter((item: any) => item.isRecording).length;
    return {
      items,
      total: items.length,
      staleCount,
      recordingCount,
      generatedAt: new Date().toISOString(),
    };
  }

  getRuntimeSummary() {
    return {
      activeCount: this.active.size,
      activeCameraIds: Array.from(this.active.keys()),
      controlMode: this.controlMode,
      storageBackend: this.storageBackend,
      recordingFormat: this.recordingFormat,
      copyCodec: this.copyCodec,
      recordingCodecMode: this.recordingCodecMode,
      diskGuardEnabled: String(process.env.RECORDING_DISK_GUARD_ENABLED ?? 'true') !== 'false',
    };
  }

  async stopAll() {
    // ARMADILHA DOCUMENTADA: em modo `worker` a API não segura processo nenhum,
    // então `this.active` está VAZIO e este método não para coisa alguma — quem
    // grava é o worker. Quem chama isto esperando "parar tudo" (a restrição
    // comercial da Central é o caso real) precisa saber que, nesse modo, o
    // desligamento acontece pela máscara de `recordingEnabled` no endpoint
    // `/cameras/internal/*`, que o laço do worker relê a cada 60s.
    //
    // O log existe para que um silêncio aqui nunca seja confundido com sucesso.
    if (this.controlMode === 'worker') {
      this.logger.warn(
        'stopAll() em modo worker: a API não controla os processos de gravação. '
        + 'O desligamento efetivo vem da política aplicada em /cameras/internal/* '
        + '(o worker relê e para em até 60s).',
      );
      return;
    }
    const cameraIds = [...this.active.keys()];
    for (const cameraId of cameraIds) {
      await this.stop(cameraId);
    }
  }

  killProcessSafely(proc: ChildProcessByStdio<null, null, Readable>) {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
    }, 1500).unref();
  }

  async onApplicationShutdown() {
    // ANTES de qualquer kill: desligar a API não pode disparar gravação nova.
    this.shuttingDown = true;
    for (const cameraId of [...this.restartTimers.keys()]) {
      this.cancelPendingRestart(cameraId);
    }
    for (const timer of this.motionStopTimers.values()) {
      clearTimeout(timer);
    }
    this.motionStopTimers.clear();
    if (this.diskGuardTimer) {
      clearInterval(this.diskGuardTimer);
      this.diskGuardTimer = null;
    }
    if (this.orphanRecoveryTimer) {
      clearTimeout(this.orphanRecoveryTimer);
      this.orphanRecoveryTimer = null;
    }
    if (this.preBufferPruneTimer) {
      clearInterval(this.preBufferPruneTimer);
      this.preBufferPruneTimer = null;
    }
    for (const cameraId of [...this.preBufferProcs.keys()]) {
      void this.stopPreBuffer(cameraId);
    }
    if (this.orphanRecoveryInterval) {
      clearInterval(this.orphanRecoveryInterval);
      this.orphanRecoveryInterval = null;
    }
    if (this.controlMode === 'local') {
      await this.stopAll();
    }
    if (this.redisPublisher) {
      await this.redisPublisher.quit();
      this.redisPublisher = null;
    }
  }
}
