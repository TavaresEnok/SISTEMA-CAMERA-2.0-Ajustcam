import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { type Response } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccessControlService } from '../access-control/access-control.service';
import { RecordingsService } from '../recordings/recordings.service';
import { type AuthUser } from '../common/types/auth-user.type';

// Tipos de evento que valem REVISÃO (algo aconteceu, não ruído de saúde/status).
const REVIEWABLE_TYPES = [
  'MOTION_DETECTED',
  'OBJECT_DETECTED',
  'FACE_DETECTED',
  'FACE_RECOGNIZED',
  'FACE_UNKNOWN',
];

type ReviewFilters = {
  cameraId?: string;
  label?: string;        // 'pessoa' | 'carro' | ...
  onlyConfirmed?: boolean; // só eventos com objeto reconhecido pela IA
  unseenOnly?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
    private readonly recordings: RecordingsService,
  ) {}

  /**
   * Fila de revisão: eventos relevantes (movimento/objeto/rosto), mais recentes
   * primeiro, já enriquecidos com o rótulo semântico e um ponteiro para a
   * gravação que cobre o momento (recordingId + offset), para o frontend montar
   * a miniatura e o link de reprodução naquele instante.
   *
   * Respeita a privacidade: `getAccessibleCameraIds` já exclui câmeras privadas
   * que o usuário não pode ver, então a fila nunca mostra evento de câmera alheia.
   */
  async feed(user: AuthUser, filters: ReviewFilters) {
    const accessible = await this.accessControl.getAccessibleCameraIds(user);
    if (!accessible.length) return { items: [], total: 0, limit: 0, offset: 0 };

    const cameraIds = filters.cameraId
      ? (accessible.includes(filters.cameraId) ? [filters.cameraId] : [])
      : accessible;
    if (!cameraIds.length) return { items: [], total: 0, limit: 0, offset: 0 };

    const limit = Math.max(1, Math.min(100, filters.limit ?? 40));
    const offset = Math.max(0, filters.offset ?? 0);
    const from = filters.from ? new Date(filters.from) : undefined;
    const to = filters.to ? new Date(filters.to) : undefined;

    const where: any = {
      cameraId: { in: cameraIds },
      type: { in: REVIEWABLE_TYPES },
      ...(filters.unseenOnly ? { userReviews: { none: { userId: user.id } } } : {}),
      ...(from || to ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(filters.onlyConfirmed
        ? { metadata: { path: ['semanticConfirmed'], equals: true } }
        : {}),
      ...(filters.label
        ? { metadata: { path: ['semanticLabel'], equals: filters.label } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.cameraEvent.findMany({
        where,
        include: { camera: { select: { name: true } } },
        orderBy: { occurredAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.cameraEvent.count({ where }),
    ]);

    // Uma única query em lote das gravações que cobrem a janela desta página de
    // eventos (evita o N+1 de uma findFirst por evento). O casamento evento→gravação
    // é feito em memória com a MESMA semântica: a gravação mais recente cujo intervalo
    // [startedAt, endedAt|∞) contém o instante do evento.
    const recordingsByCamera = new Map<string, Array<{ id: string; startedAt: Date; endedAt: Date | null }>>();
    if (rows.length) {
      const times = rows.map((event) => event.occurredAt.getTime());
      const candidates = await this.prisma.recording.findMany({
        where: {
          cameraId: { in: [...new Set(rows.map((event) => event.cameraId))] },
          startedAt: { lte: new Date(Math.max(...times)) },
          OR: [{ endedAt: null }, { endedAt: { gte: new Date(Math.min(...times)) } }],
        },
        orderBy: { startedAt: 'desc' },
        select: { id: true, cameraId: true, startedAt: true, endedAt: true },
      });
      for (const rec of candidates) {
        const list = recordingsByCamera.get(rec.cameraId) ?? [];
        list.push({ id: rec.id, startedAt: rec.startedAt, endedAt: rec.endedAt });
        recordingsByCamera.set(rec.cameraId, list);
      }
    }

    const findRecording = (cameraId: string, occurredAt: Date) => {
      const list = recordingsByCamera.get(cameraId);
      if (!list) return null;
      const t = occurredAt.getTime();
      // list já vem ordenada por startedAt desc → o primeiro match é o mais recente.
      return list.find((r) => r.startedAt.getTime() <= t && (r.endedAt == null || r.endedAt.getTime() >= t)) ?? null;
    };

    // "visto" é POR USUÁRIO (UserEventReview), não global — uma query em lote.
    const reviewedEventIds = new Set(
      rows.length
        ? (await this.prisma.userEventReview.findMany({
            where: { userId: user.id, eventId: { in: rows.map((e) => e.id) } },
            select: { eventId: true },
          })).map((r) => r.eventId)
        : [],
    );

    const items = rows.map((event) => {
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      const recording = findRecording(event.cameraId, event.occurredAt);
      const offsetSeconds = recording
        ? Math.max(0, Math.floor((event.occurredAt.getTime() - recording.startedAt.getTime()) / 1000))
        : null;
      return {
        id: event.id,
        cameraId: event.cameraId,
        cameraName: event.camera?.name ?? null,
        type: event.type,
        severity: event.severity,
        label: (meta.semanticLabel as string) ?? null,
        confirmed: meta.semanticConfirmed === true,
        confidence: typeof meta.semanticConfidence === 'number' ? meta.semanticConfidence : null,
        source: (meta.source as string) ?? null,
        occurredAt: event.occurredAt,
        reviewed: reviewedEventIds.has(event.id),
        recordingId: recording?.id ?? null,
        offsetSeconds,
      };
    });

    return { items, total, limit, offset };
  }

  async markSeen(user: AuthUser, eventId: string, seen: boolean) {
    const event = await this.prisma.cameraEvent.findUnique({
      where: { id: eventId },
      select: { cameraId: true },
    });
    if (!event) throw new NotFoundException('Evento não encontrado.');
    // Marcar como visto é ação sobre CONTEÚDO — respeita a privacidade.
    if (!(await this.accessControl.canViewCamera(user, event.cameraId))) {
      throw new ForbiddenException('Sem acesso a este evento.');
    }
    if (seen) {
      await this.prisma.userEventReview.upsert({
        where: { userId_eventId: { userId: user.id, eventId } },
        create: { userId: user.id, eventId },
        update: {},
      });
    } else {
      await this.prisma.userEventReview.deleteMany({ where: { userId: user.id, eventId } });
    }
    return { id: eventId, reviewed: seen };
  }

  /** Contagem de eventos NÃO revisados (para o badge do menu). */
  async unseenCount(user: AuthUser) {
    const accessible = await this.accessControl.getAccessibleCameraIds(user);
    if (!accessible.length) return { count: 0 };
    const count = await this.prisma.cameraEvent.count({
      where: { cameraId: { in: accessible }, type: { in: REVIEWABLE_TYPES }, userReviews: { none: { userId: user.id } } },
    });
    return { count };
  }

  /**
   * Miniatura do evento: um frame da gravação no instante em que ele ocorreu.
   * Gate de CONTEÚDO (canViewCamera) — respeita a privacidade da câmera. O
   * cache do próprio streamSnapshotFrame evita reprocessar o mesmo frame.
   */
  async streamThumbnail(user: AuthUser, eventId: string, res: Response) {
    const event = await this.prisma.cameraEvent.findUnique({
      where: { id: eventId },
      select: { cameraId: true, occurredAt: true },
    });
    if (!event) throw new NotFoundException('Evento não encontrado.');
    if (!(await this.accessControl.canViewCamera(user, event.cameraId))) {
      throw new ForbiddenException('Sem acesso a este evento.');
    }
    const recording = await this.prisma.recording.findFirst({
      where: {
        cameraId: event.cameraId,
        startedAt: { lte: event.occurredAt },
        OR: [{ endedAt: null }, { endedAt: { gte: event.occurredAt } }],
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    });
    if (!recording) throw new NotFoundException('Sem gravação para este evento.');
    const seconds = Math.max(0, Math.floor((event.occurredAt.getTime() - recording.startedAt.getTime()) / 1000));
    return this.recordings.streamSnapshotFrame(recording.id, seconds, res);
  }
}
