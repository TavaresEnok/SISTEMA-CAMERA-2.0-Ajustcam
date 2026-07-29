import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ensureFileUnderRoot } from './helpers/safe-file.helper';
import { envBool, envNumber } from '../common/config/env-number.helper';
import { buildTimelinePreviewPath } from './helpers/timeline-preview.helper';
import { buildCameraRootDir, parseCameraIdFromDirName } from './helpers/recording-path.helper';
import {
  type DeletionGuard,
  stageFileDeletion,
  type StagedFileDeletion,
} from './helpers/transactional-file-delete.helper';

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
  // Campos da retenção em dois níveis: só aparecem quando a feature está ATIVA,
  // para que o resultado (e o JSON que vai ao log) continue idêntico ao atual
  // enquanto a flag estiver desligada.
  recordingsWouldDelete?: number;
  wouldFreeBytes?: number;
  motionRetained?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Retenção em DOIS NÍVEIS — ideia derivada do Frigate (MIT), Copyright (c)
// Frigate, Inc. (`frigate/record/cleanup.py::expire_existing_camera_recordings`
// mantém dois cortes por câmera, `continuous_expire_date` e `motion_expire_date`,
// e só expira cedo o segmento cujo `motion == 0`). Nenhuma linha de código foi
// copiada; a regra foi reescrita e ENDURECIDA para VMS com valor probatório.
//
// DIFERENÇA DELIBERADA DO DRAC: o Frigate trata ausência de sinal como zero.
// Aqui, `motionScore == -1` significa DESCONHECIDO (backfill, IA desligada, erro
// ao contar) e entra em QUARENTENA: é tratado como se TIVESSE movimento e nunca
// expira no corte curto. Apagar de menos custa disco; apagar de mais é
// irreversível e pode destruir prova.
// ─────────────────────────────────────────────────────────────────────────────

/** Atividade desconhecida: quarentena, nunca expira no corte curto. */
export const MOTION_SCORE_UNKNOWN = -1;

export type TwoTierPolicy = {
  /** Feature inteira; desligada por padrão. */
  enabled: boolean;
  /** Quando true, apenas CONTA o que apagaria. Padrão true mesmo com a flag on. */
  dryRun: boolean;
  /** Corte curto — "N dias de tudo". 0 = herda `Camera.retentionDays`. */
  allDays: number;
  /** Corte longo — "M dias do que teve movimento". 0 = herda `Camera.retentionDays`. */
  motionDays: number;
};

export type RetentionWindow = { allDays: number; motionDays: number };

/**
 * Recorte de câmeras que compartilham o MESMO corte de retenção. Existe para
 * que a expiração vire "uma query por corte", em vez de "uma varredura pelo
 * acervo inteiro decidindo linha a linha em memória".
 */
type RetentionGroup = {
  /** Dias de retenção base (o `Camera.retentionDays`, ou o global herdado). */
  days: number;
  /** Filtro Prisma sobre `cameraId` — `in` para o grupo, `notIn` para as órfãs. */
  filter: { cameraId?: { in: string[] } | { notIn: string[] } };
};

/** Teto e tamanho de lote de UMA passagem de expiração. */
type BatchLimits = { batchSize: number; maxPerCycle: number };

/** Linha mínima que a expiração precisa — nada de hidratar o registro inteiro. */
type ExpiringRecording = {
  id: string;
  cameraId: string;
  filePath: string;
  startedAt: Date;
  sizeBytes: bigint | number | null;
  /** Ausente quando o cliente Prisma é anterior à migração ⇒ DESCONHECIDO. */
  motionScore?: number;
};

/**
 * Acesso ao delegate de `Recording` com tipo AFROUXADO, e só para a expiração.
 *
 * Motivo, não preguiça: `Recording.motionScore` pode não existir no cliente
 * gerado (é o mesmo cenário "pré-migração" que `readMotionScore` já trata). O
 * tipo estrito do cliente antigo recusaria a query em tempo de compilação
 * mesmo quando o cliente NOVO a aceita em produção; o que decide de fato é a
 * checagem de capacidade em `hasMotionScoreColumn()`.
 */
type RecordingExpiryDelegate = {
  findMany(args: unknown): Promise<ExpiringRecording[]>;
  count(args: unknown): Promise<number>;
};

const DAY_MS = 86_400_000;

function requireStagedDeletion(value: StagedFileDeletion | null): StagedFileDeletion {
  if (!value) throw new Error('Exclusão física não foi preparada dentro da transação.');
  return value;
}

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private interval: NodeJS.Timeout | null = null;
  /** Cache da checagem de capacidade do cliente Prisma (ver `hasMotionScoreColumn`). */
  private motionScoreSupported: boolean | null = null;

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

  /**
   * Lê a política do ambiente. Desligada por padrão e, mesmo ligada, em DRY-RUN
   * até alguém escrever `RETENTION_TWO_TIER_DRY_RUN=false` — ninguém liga isso
   * no escuro. Qualquer valor inválido cai no lado seguro (desligado/herdado).
   */
  private readTwoTierPolicy(): TwoTierPolicy {
    const onInvalid = (message: string) => this.logger.warn(message);
    // 0 = "herda o corte da câmera". Lixo no ambiente vira 0 (herda) e AVISA —
    // antes virava NaN silencioso e o operador achava que tinha configurado.
    const days = (name: string) => envNumber(name, 0, { min: 0, max: 3650, integer: true, onInvalid });
    return {
      enabled: envBool('RETENTION_TWO_TIER_ENABLED', false, { onInvalid }),
      dryRun: envBool('RETENTION_TWO_TIER_DRY_RUN', true, { onInvalid }),
      allDays: days('RETENTION_ALL_DAYS'),
      motionDays: days('RETENTION_MOTION_DAYS'),
    };
  }

  /**
   * Tamanho do lote e teto por ciclo. O teto existe para que uma instalação com
   * acervo represado não tente apagar centenas de milhares de arquivos numa
   * única passagem, dentro do mesmo processo que segura os ffmpeg de gravação:
   * o que sobra sai no ciclo seguinte (de hora em hora).
   */
  private readBatchLimits(): BatchLimits {
    const onInvalid = (message: string) => this.logger.warn(message);
    return {
      batchSize: envNumber('RETENTION_EXPIRY_BATCH_SIZE', 500, { min: 1, max: 5_000, integer: true, onInvalid }),
      maxPerCycle: envNumber('RETENTION_MAX_DELETIONS_PER_CYCLE', 20_000, {
        min: 1,
        max: 1_000_000,
        integer: true,
        onInvalid,
      }),
    };
  }

  /**
   * Agrupa as câmeras por corte de retenção. São poucas linhas (uma por câmera)
   * e é o ÚNICO ponto onde o custo depende do cadastro — não do acervo.
   */
  private async loadRetentionGroups(globalDays: number): Promise<RetentionGroup[]> {
    const cameras = await this.prisma.camera.findMany({ select: { id: true, retentionDays: true } });
    const byDays = new Map<number, string[]>();
    for (const camera of cameras) {
      const days = camera.retentionDays ?? globalDays;
      const bucket = byDays.get(days);
      if (bucket) bucket.push(camera.id);
      else byDays.set(days, [camera.id]);
    }
    const groups: RetentionGroup[] = [...byDays.entries()].map(([days, cameraIds]) => ({
      days,
      filter: { cameraId: { in: cameraIds } },
    }));
    // Gravação cuja câmera saiu do cadastro continua ocupando disco. A varredura
    // antiga a tratava pelo corte GLOBAL (`recording.camera?.retentionDays ??
    // globalDays`); sem este grupo ela viraria IMORTAL.
    groups.push({
      days: globalDays,
      filter: cameras.length ? { cameraId: { notIn: cameras.map((camera) => camera.id) } } : {},
    });
    return groups;
  }

  /**
   * Traduz a MESMA regra de `isExpiredByAge` para o banco. Ela precisa ser
   * idêntica, e por isso continua sendo reavaliada em memória linha a linha:
   * se um dia o filtro ficar mais LARGO que a política, a regra pura ainda
   * segura a exclusão.
   *
   *   expira ⇔ startedAt < corteDeTudo
   *            E (startedAt < corteDeMovimento OU motionScore = 0)
   *
   * `lt` (e não `lte`) reproduz a fronteira histórica: idade == corte NÃO expira.
   */
  private buildExpiryWhere(group: RetentionGroup, window: RetentionWindow, now: number) {
    const where: Record<string, unknown> = {
      ...group.filter,
      startedAt: { lt: new Date(now - window.allDays * DAY_MS) },
    };
    if (window.motionDays > window.allDays) {
      if (!this.hasMotionScoreColumn()) {
        // Sem a coluna, TODO segmento é DESCONHECIDO — e desconhecido fica em
        // quarentena até o corte longo. É exatamente o que a varredura antiga
        // fazia com um cliente pré-migração.
        return { ...group.filter, startedAt: { lt: new Date(now - window.motionDays * DAY_MS) } };
      }
      where.OR = [
        { startedAt: { lt: new Date(now - window.motionDays * DAY_MS) } },
        // Só o que SABEMOS estar vazio morre cedo. -1 (DESCONHECIDO) fica em
        // quarentena até o corte longo — apagar de menos custa disco, apagar de
        // mais destrói prova.
        { motionScore: 0 },
      ];
    }
    return where;
  }

  /**
   * O cliente Prisma gerado pode ser ANTERIOR à migração que criou
   * `Recording.motionScore`. Filtrar por uma coluna que ele não conhece não
   * devolve "nada": o Prisma RECUSA a query inteira — e a retenção pararia de
   * rodar, com o disco enchendo em silêncio. Por isso a capacidade é checada
   * antes, uma vez só.
   */
  private hasMotionScoreColumn(): boolean {
    // `typeof` e não `=== null`: a checagem precisa valer também quando ainda
    // não foi determinada (undefined), senão o "não sei" vira "não tem".
    if (typeof this.motionScoreSupported !== 'boolean') {
      const fields = (this.prisma as unknown as { recording?: { fields?: Record<string, unknown> } })
        .recording?.fields;
      this.motionScoreSupported = Boolean(fields && 'motionScore' in fields);
      if (!this.motionScoreSupported) {
        this.logger.warn(
          'Cliente Prisma sem `Recording.motionScore`: a retenção trata todo segmento como atividade '
          + 'DESCONHECIDA (quarentena até o corte longo). Rode `prisma generate` após a migração.',
        );
      }
    }
    return this.motionScoreSupported;
  }

  /** Ver `RecordingExpiryDelegate`: o afrouxamento é deliberado e local. */
  private get recordingExpiry(): RecordingExpiryDelegate {
    return this.prisma.recording as unknown as RecordingExpiryDelegate;
  }

  /**
   * Os dois cortes efetivos de UMA câmera. Com a flag desligada os dois cortes
   * colapsam no corte histórico (`Camera.retentionDays`), o que torna a regra
   * nova byte a byte equivalente à antiga.
   */
  private resolveRetentionWindow(baseDays: number, policy: TwoTierPolicy): RetentionWindow {
    if (!policy.enabled) return { allDays: baseDays, motionDays: baseDays };
    const allDays = policy.allDays > 0 ? policy.allDays : baseDays;
    const motionDays = policy.motionDays > 0 ? policy.motionDays : baseDays;
    // INVARIANTE: o corte de movimento nunca fica ABAIXO do corte de tudo, senão
    // uma gravação COM movimento morreria antes de uma sem movimento.
    return { allDays, motionDays: Math.max(allDays, motionDays) };
  }

  /**
   * Normaliza `Recording.motionScore`. Campo ausente (banco/cliente anterior à
   * migração), nulo, negativo ou não-inteiro ⇒ DESCONHECIDO.
   */
  private readMotionScore(recording: unknown): number {
    const raw = (recording as { motionScore?: unknown } | null)?.motionScore;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return MOTION_SCORE_UNKNOWN;
    return raw;
  }

  /**
   * Veredito por gravação. A comparação é estritamente `>` para reproduzir a
   * fronteira histórica (`startedAt < now - dias`).
   */
  private isExpiredByAge(startedAt: Date, motionScore: number, now: number, window: RetentionWindow): boolean {
    const ageMs = now - startedAt.getTime();
    // Corte longo: passou daqui, expira independente da atividade.
    if (ageMs > window.motionDays * 86_400_000) return true;
    // Dentro do corte curto: intocável.
    if (ageMs <= window.allDays * 86_400_000) return false;
    // Entre os dois cortes só morre o que SABEMOS ter ficado vazio. -1 (e
    // qualquer valor > 0) fica em quarentena até o corte longo.
    return motionScore === 0;
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

  private async deleteRowsWithFiles<T>(
    root: string,
    paths: string[],
    guards: DeletionGuard[],
    deleteRows: (tx: any) => Promise<T>,
  ): Promise<T> {
    let staged: StagedFileDeletion | null = null;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Uma única exclusão DB↔FS por instalação. O lock também coordena duas
        // instâncias da API apontando para o mesmo PostgreSQL/storage.
        await tx.$queryRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtext('drac:recordings:file-delete'))",
        );
        staged = await stageFileDeletion(root, paths, guards);
        return deleteRows(tx);
      });
      const cleanup = await requireStagedDeletion(staged).commit();
      if (cleanup.cleanupDeferred) {
        this.logger.warn('Limpeza física confirmada ficou pendente no journal para o próximo boot.');
      }
      return result;
    } catch (error) {
      if (staged) {
        try {
          await requireStagedDeletion(staged).rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Falha no banco e na restauração dos arquivos de retenção.',
          );
        }
      }
      throw error;
    }
  }

  private async deleteClip(clip: { id: string; filePath: string }) {
    const root = this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const fullPath = ensureFileUnderRoot(root, clip.filePath);
    await this.deleteRowsWithFiles(
      root,
      [fullPath],
      [{ model: 'exportedClip', id: clip.id }],
      (tx) => tx.exportedClip.delete({ where: { id: clip.id } }),
    );
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
    const root = this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const fullPath = ensureFileUnderRoot(root, recording.filePath);
    const paths = [
      ...clips.map((clip) => ensureFileUnderRoot(root, clip.filePath)),
      fullPath,
      this.derivedThumbnailPath(fullPath),
      buildTimelinePreviewPath(fullPath),
      `${fullPath}.invalid.json`,
      `${fullPath}.orphan-quarantine.json`,
      join(root, '.playback-compatible', recording.cameraId, `${recording.id}.mp4`),
    ];
    await this.deleteRowsWithFiles(
      root,
      paths,
      [
        { model: 'recording', id: recording.id },
        ...clips.map((clip) => ({ model: 'exportedClip' as const, id: clip.id })),
      ],
      async (tx) => {
        if (clips.length) {
          await tx.exportedClip.deleteMany({ where: { id: { in: clips.map((clip) => clip.id) } } });
        }
        await tx.recording.delete({ where: { id: recording.id } });
      },
    );
    return true;
  }

  /**
   * Clips exportados que passaram do corte da câmera de ORIGEM (é a regra
   * histórica: o clip herda a retenção da gravação que o gerou, não a sua).
   * Vêm antes das gravações porque excluir a gravação faz CASCADE no banco e
   * deixaria o arquivo exportado órfão no disco.
   */
  private async expireClipsInBatches(
    groups: RetentionGroup[],
    now: number,
    protection: ProtectionSets,
    result: CleanupResult,
    limits: BatchLimits,
  ) {
    let budget = limits.maxPerCycle;
    for (const group of groups) {
      const cutoff = new Date(now - group.days * DAY_MS);
      // `skip` conta o que FICOU para trás (protegido ou com erro). O que é
      // apagado some do resultado sozinho; sem esse avanço, uma linha protegida
      // no topo devolveria a mesma página para sempre.
      let skip = 0;
      for (;;) {
        if (budget <= 0) return;
        const take = Math.min(limits.batchSize, budget);
        const clips = await this.prisma.exportedClip.findMany({
          // O clip herda a retenção da câmera de ORIGEM (regra histórica), por
          // isso o filtro desce pela relação em vez de olhar `ExportedClip.cameraId`.
          where: {
            startedAt: { lt: cutoff },
            ...(group.filter.cameraId ? { sourceRecording: group.filter } : {}),
          },
          orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
          select: { id: true, filePath: true },
        });
        if (!clips.length) break;
        for (const clip of clips) {
          if (protection.clipIds.has(clip.id)) {
            skip += 1;
            continue;
          }
          try {
            await this.deleteClip(clip);
            result.clipsDeleted += 1;
            budget -= 1;
          } catch (error) {
            this.logger.error(`Falha ao remover clip ${clip.id}: ${error instanceof Error ? error.message : String(error)}`);
            skip += 1;
          }
        }
        if (clips.length < take) break;
      }
    }
  }

  /**
   * Expiração por idade em LOTES, com o filtro de data no BANCO.
   *
   * O custo passa a acompanhar o que EXPIRA, não o acervo: antes esta passagem
   * hidratava todas as gravações (100 câmeras × 30 dias × 288 segmentos ≈ 864
   * mil linhas) no heap do MESMO processo que segura os ffmpeg de gravação.
   * A política é a de sempre — inclusive proteções e os dois níveis.
   */
  private async expireRecordingsInBatches(
    groups: RetentionGroup[],
    now: number,
    protection: ProtectionSets,
    policy: TwoTierPolicy,
    result: CleanupResult,
    limits: BatchLimits,
  ) {
    let budget = limits.maxPerCycle;
    let hitCap = false;
    for (const group of groups) {
      if (budget <= 0) {
        hitCap = true;
        break;
      }
      const window = this.resolveRetentionWindow(group.days, policy);
      if (policy.enabled) {
        // O que sobreviveu ao corte curto POR TER (ou poder ter) movimento é o
        // ganho que a feature vende. Uma contagem no banco substitui a varredura
        // que existia só para produzir este número.
        result.motionRetained = (result.motionRetained ?? 0) + await this.recordingExpiry.count({
          where: {
            ...group.filter,
            startedAt: {
              lt: new Date(now - window.allDays * DAY_MS),
              gte: new Date(now - window.motionDays * DAY_MS),
            },
            // Sem a coluna, tudo na faixa é DESCONHECIDO — e desconhecido é
            // retido, então a contagem é a faixa inteira.
            ...(this.hasMotionScoreColumn() ? { NOT: { motionScore: 0 } } : {}),
          },
        });
      }
      const where = this.buildExpiryWhere(group, window, now);
      let skip = 0;
      for (;;) {
        if (budget <= 0) {
          hitCap = true;
          break;
        }
        const take = Math.min(limits.batchSize, budget);
        const recordings = await this.recordingExpiry.findMany({
          where,
          // Ordem TOTAL: sem o desempate por id, duas gravações com o mesmo
          // `startedAt` podem trocar de lugar entre páginas e uma delas escapar
          // da janela de `skip/take`.
          orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
          // Só as colunas que a exclusão usa: o custo por linha também importa
          // quando o acervo é grande.
          select: {
            id: true,
            cameraId: true,
            filePath: true,
            startedAt: true,
            sizeBytes: true,
            ...(this.hasMotionScoreColumn() ? { motionScore: true } : {}),
          },
        });
        if (!recordings.length) break;
        for (const recording of recordings) {
          // Cinto e suspensórios: a regra PURA decide de novo, em memória. Se um
          // dia o filtro do banco ficar mais largo que a política, nada é apagado
          // a mais — no máximo deixa de apagar.
          if (!this.isExpiredByAge(recording.startedAt, this.readMotionScore(recording), now, window)) {
            skip += 1;
            continue;
          }
          if (policy.enabled && policy.dryRun) {
            // Proteções continuam acima de tudo, inclusive na simulação.
            if (protection.recordingIds.has(recording.id)) {
              skip += 1;
              continue;
            }
            result.recordingsWouldDelete = (result.recordingsWouldDelete ?? 0) + 1;
            result.wouldFreeBytes = (result.wouldFreeBytes ?? 0) + Number(recording.sizeBytes ?? 0);
            skip += 1;
            budget -= 1;
            continue;
          }
          try {
            if (await this.deleteRecording(recording, protection)) {
              result.recordingsDeleted += 1;
              budget -= 1;
            } else {
              skip += 1;
            }
          } catch (error) {
            this.logger.error(`Falha ao remover gravação ${recording.id}: ${error instanceof Error ? error.message : String(error)}`);
            skip += 1;
          }
        }
        if (recordings.length < take) break;
      }
    }
    if (hitCap) {
      this.logger.warn(
        `Retenção atingiu o teto de ${limits.maxPerCycle} exclusão(ões) neste ciclo; o restante sai no próximo. `
        + 'Se isso repetir, aumente RETENTION_MAX_DELETIONS_PER_CYCLE ou investigue o acúmulo.',
      );
    }
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
      // Dias de retenção NUNCA podem virar NaN/0 por typo: 0 apagaria TUDO na
      // varredura seguinte. Piso de 1 dia, e valor inválido cai no default.
      : envNumber('RECORDING_RETENTION_DAYS', Number(this.config.get<number>('retentionDays')) || 7, {
        min: 1,
        integer: true,
        onInvalid: (m) => this.logger.warn(m),
      });
    const protection = await this.getProtectionSets();
    const now = Date.now();
    this.logger.log(`Iniciando retenção (${source}, global=${globalDays} dias, holds=${protection.recordingIds.size}).`);

    const policy = this.readTwoTierPolicy();
    if (policy.enabled) {
      result.recordingsWouldDelete = 0;
      result.wouldFreeBytes = 0;
      result.motionRetained = 0;
      this.logger.log(
        `Retenção em dois níveis ATIVA: tudo=${policy.allDays || 'herdado'} dia(s), movimento=${policy.motionDays || 'herdado'} dia(s).`,
      );
      if (policy.dryRun) {
        this.logger.warn(
          'Retenção em dois níveis em DRY-RUN: nenhuma gravação será apagada por idade nesta passagem (o guardião de disco continua ativo).',
        );
      }
    }

    // Um "grupo" por corte de retenção: as câmeras que compartilham o mesmo
    // `retentionDays` viram UMA query com filtro de data no banco, em lotes.
    const limits = this.readBatchLimits();
    const groups = await this.loadRetentionGroups(globalDays);

    // Clips vêm primeiro: excluir a gravação causaria cascade no banco e deixaria
    // o arquivo exportado órfão no disco.
    await this.expireClipsInBatches(groups, now, protection, result, limits);
    await this.expireRecordingsInBatches(groups, now, protection, policy, result, limits);

    // Dias de evento: NaN aqui produzia `new Date(NaN)` e derrubava a passagem
    // INTEIRA de retenção no `deleteMany` (Prisma recusa data inválida).
    const eventRetentionDays = envNumber('CAMERA_EVENT_RETENTION_DAYS', 30, {
      min: 1,
      max: 3650,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    });
    const eventCutoff = new Date(now - eventRetentionDays * DAY_MS);
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

  /**
   * Varredura de derivados órfãos (thumbnail, sprite de scrubbing, MP4 de
   * compatibilidade) — POR CÂMERA.
   *
   * Antes, montava três Sets com o acervo INTEIRO de Recording para depois
   * varrer o disco. Correto, mas o pico de memória crescia com câmeras ×
   * retenção e o job é periódico: 100 câmeras a 30 dias são ~800 mil linhas
   * viradas em três conjuntos de caminhos longos. Agora cada câmera é resolvida
   * e descartada antes da próxima — mesmo resultado, pico de UMA câmera.
   *
   * O laço é dirigido pelos DIRETÓRIOS do disco, não pela tabela Camera: a pasta
   * de uma câmera EXCLUÍDA é justamente onde há mais derivado órfão para limpar,
   * e iterar pela tabela a deixaria intocada para sempre.
   */
  private async cleanupOrphanDerivedArtifacts() {
    const root = this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings';
    const compatibleRoot = join(root, '.playback-compatible');

    const listDirs = (dir: string) => {
      if (!existsSync(dir)) return [] as string[];
      try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [] as string[];
      }
    };

    // Toda câmera com rastro no disco, venha do acervo (`camera-<id>/`) ou do
    // cache de compatibilidade (`.playback-compatible/<id>/`).
    const cameraIds = new Set<string>();
    for (const name of listDirs(root)) {
      const cameraId = parseCameraIdFromDirName(name);
      if (cameraId) cameraIds.add(cameraId);
    }
    for (const name of listDirs(compatibleRoot)) cameraIds.add(name);

    let orphanThumbnailsDeleted = 0;
    let orphanCompatibleFilesDeleted = 0;

    for (const cameraId of cameraIds) {
      const rows = await this.prisma.recording.findMany({
        where: { cameraId },
        select: { id: true, filePath: true },
      });
      const expectedThumbnails = new Set<string>();
      const expectedPreviews = new Set<string>();
      const expectedCompatible = new Set<string>();
      for (const row of rows) {
        const filePath = ensureFileUnderRoot(root, row.filePath);
        expectedThumbnails.add(this.derivedThumbnailPath(filePath));
        expectedPreviews.add(buildTimelinePreviewPath(filePath));
        expectedCompatible.add(join(compatibleRoot, cameraId, `${row.id}.mp4`));
      }

      const walk = (dir: string, compatible: boolean) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath, compatible);
            continue;
          }
          if (entry.name.endsWith('.thumb.jpg') && !expectedThumbnails.has(fullPath)) {
            if (this.removeFile(fullPath)) orphanThumbnailsDeleted += 1;
          } else if (entry.name.endsWith('.preview.jpg') && !expectedPreviews.has(fullPath)) {
            if (this.removeFile(fullPath)) orphanThumbnailsDeleted += 1;
          } else if (compatible && entry.name.endsWith('.mp4') && !expectedCompatible.has(fullPath)) {
            if (this.removeFile(fullPath)) orphanCompatibleFilesDeleted += 1;
          }
        }
      };
      walk(buildCameraRootDir(root, cameraId), false);
      walk(join(compatibleRoot, cameraId), true);
    }

    await this.pruneDiagnosticsCache(root);
    return { orphanThumbnailsDeleted, orphanCompatibleFilesDeleted };
  }

  /**
   * Poda o cache diagnóstico das gravações que já não existem.
   *
   * Consulta pelas CHAVES DO CACHE (`id in [...]`) em vez de carregar todos os
   * ids do acervo: o custo passa a ser o tamanho do cache — que é o que está
   * sendo podado — e não o do banco.
   */
  private async pruneDiagnosticsCache(root: string) {
    const diagnosticsPath = join(root, '.diagnostics-cache', 'recording-health.json');
    if (!existsSync(diagnosticsPath)) return;
    try {
      const cache = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as Record<string, unknown>;
      const ids = Object.keys(cache);
      if (!ids.length) return;
      const alive = new Set(
        (await this.prisma.recording.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
      );
      let changed = false;
      for (const id of ids) {
        if (alive.has(id)) continue;
        delete cache[id];
        changed = true;
      }
      if (changed) writeFileSync(diagnosticsPath, JSON.stringify(cache), 'utf8');
    } catch {
      // Cache diagnóstico é best effort; não interrompe retenção.
    }
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
      // Guarda de disco: NaN aqui é a guarda DESARMADA (comparação com NaN é
      // sempre falsa) — disco a 100%, todas as câmeras paradas, zero erro no log.
      const triggerPercent = envNumber('RETENTION_DISK_TRIGGER_PERCENT', 90, {
        min: 50,
        max: 99,
        integer: true,
        onInvalid: (m) => this.logger.warn(m),
      });
      if (initialPercent <= triggerPercent) return;
      const autoCleanup = await this.settings.isAutoCleanupEnabled().catch(() => true);
      if (!autoCleanup) {
        this.logger.warn(`Espaço em disco crítico: ${initialPercent}%; limpeza automática desativada.`);
        return;
      }
      const protection = existingProtection ?? await this.getProtectionSets();
      // O alvo tem que ficar ABAIXO do gatilho, senão o laço nunca converge.
      const target = envNumber('RETENTION_DISK_TARGET_PERCENT', 85, {
        min: 40,
        max: Math.max(40, triggerPercent - 1),
        integer: true,
        onInvalid: (m) => this.logger.warn(m),
      });
      let current = initialPercent;
      let totalDeleted = 0;
      // ───────────────────────────────────────────────────────────────────────
      // FREIO DE "APAGAR SEM ADIANTAR".
      //
      // Este laço apaga por PRESSÃO DE DISCO, não por idade: sem filtro de data,
      // da mais velha para a mais nova, até 100 lotes de 20 = 2000 gravações.
      // Ele confia que apagar gravação reduz `diskUsagePercent(root)`.
      //
      // Quando essa premissa é falsa, o laço vira uma trituradora de acervo. O
      // caso real: o volume das gravações NÃO monta, `recordingsRoot` cai no
      // disco do sistema (cheio por outro motivo), e aí nenhuma exclusão move o
      // percentual — o laço segue apagando prova até acabar o acervo, sem nunca
      // atingir o alvo. É o mesmo perigo que o Frigate trava em
      // `util/media.py` antes de sincronizar disco↔banco: contagem anormal de
      // exclusão é sintoma de configuração/mount errado, não de acervo velho.
      //
      // O sinal aqui é mais preciso que um limiar de contagem: se um lote
      // apagou de fato e MESMO ASSIM o uso do disco não caiu, o espaço não está
      // sendo ocupado pelo que estamos apagando. Uma limpeza legítima sempre
      // libera espaço, então este freio não dispara em operação normal.
      // ───────────────────────────────────────────────────────────────────────
      const maxNoProgressBatches = envNumber('RETENTION_DISK_MAX_NOPROGRESS_BATCHES', 3, {
        min: 1,
        max: 20,
        integer: true,
        onInvalid: (m) => this.logger.warn(m),
      });
      let noProgressBatches = 0;
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
        const before = current;
        current = await this.diskUsagePercent(root);
        if (current < before) {
          noProgressBatches = 0;
          continue;
        }
        // Apagou de verdade e o disco não cedeu: o espaço não é das gravações.
        noProgressBatches += 1;
        if (noProgressBatches >= maxNoProgressBatches) {
          this.logger.error(
            `Guardião de disco ABORTADO: ${noProgressBatches} lote(s) seguidos apagaram gravação sem reduzir o uso do disco `
            + `(${before}% → ${current}%, alvo ${target}%). O espaço NÃO está sendo ocupado pelas gravações — `
            + `verifique se o volume de "${root}" está montado e se outra coisa encheu o disco. `
            + `${totalDeleted} gravação(ões) já foram removidas nesta passagem; o laço parou para não destruir o acervo à toa.`,
          );
          break;
        }
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
