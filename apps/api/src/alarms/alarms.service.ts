import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlarmPriority, AlarmSource, AlarmStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isAllowedHost, isPrivateOrReservedIp, resolveHostIps } from '../common/network/safe-url.helper';
import { AlarmNotificationsService } from './alarm-notifications.service';
import { AlarmMuteService } from './alarm-mute.service';
import { CreateAlarmRuleDto } from './dto/create-alarm-rule.dto';
import { SetAlarmRuleEnabledDto } from './dto/set-alarm-rule-enabled.dto';
import { SimulateAlarmRuleDto } from './dto/simulate-alarm-rule.dto';
import { UpdateAlarmRuleDto } from './dto/update-alarm-rule.dto';
import { envNumber } from '../common/config/env-number.helper';

function inferSource(type: string): AlarmSource | null {
  if (type.startsWith('STREAM_')) return AlarmSource.STREAM;
  if (type.startsWith('HEALTH_')) return AlarmSource.HEALTH;
  if (type === 'MOTION_DETECTED') return AlarmSource.MOTION;
  if (type.startsWith('MOTION_')) return AlarmSource.MOTION;
  if (type.startsWith('AI_') || type.startsWith('ANALYTICS_')) return AlarmSource.ANALYTICS;
  return null;
}

function defaultPriorityFor(type: string, severity: string): AlarmPriority {
  if (type === 'MOTION_DETECTED') return AlarmPriority.P3;
  if (severity === 'CRITICAL' || severity === 'ERROR') return AlarmPriority.P1;
  if (severity === 'WARNING' || severity === 'WARN') return AlarmPriority.P2;
  if (severity === 'INFO') return AlarmPriority.P3;
  return AlarmPriority.P4;
}

function defaultDedupWindow(source: AlarmSource): number {
  // Movimento é naturalmente ruidoso. Um único episódio deve aparecer como um
  // alarme com várias ocorrências, em vez de dezenas de cartões independentes.
  if (source === AlarmSource.MOTION) return 300;
  if (source === AlarmSource.STREAM || source === AlarmSource.HEALTH) return 120;
  return 60;
}

function isRecoveryEvent(type: string): boolean {
  return (
    type === 'HEALTH_AUTO_RECOVERED' ||
    type === 'HEALTH_RECORDING_RECOVERED' ||
    type === 'STREAM_RESUMED' ||
    type === 'STREAM_RECOVERED'
  );
}

@Injectable()
export class AlarmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly notifications: AlarmNotificationsService,
    private readonly muteService: AlarmMuteService,
  ) {}

  async resolveStaleMotionAlarms(now = new Date()) {
    const rule = await this.getRule(AlarmSource.MOTION, 'MOTION_DETECTED');
    const configuredQuietSeconds = envNumber('MOTION_ALARM_QUIET_SECONDS', 300);
    const quietSeconds = Math.max(30, configuredQuietSeconds, rule?.dedupWindowSeconds ?? 0);
    const quietBefore = new Date(now.getTime() - quietSeconds * 1000);

    const result = await this.prisma.alarmInstance.updateMany({
      where: {
        source: AlarmSource.MOTION,
        type: 'MOTION_DETECTED',
        status: { in: [AlarmStatus.OPEN, AlarmStatus.ACKED] },
        lastOccurredAt: { lte: quietBefore },
      },
      data: {
        status: AlarmStatus.RESOLVED,
        resolvedAt: now,
        resolvedByUserName: 'SYSTEM_MOTION_QUIET',
        note: `Resolvido automaticamente após ${quietSeconds}s sem novo movimento.`,
      },
    });

    return { resolved: result.count, quietSeconds, quietBefore };
  }

  private getWebhookAllowlist() {
    const explicit = String(this.configService.get<string>('alarmWebhookAllowedHosts') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (explicit.length) return explicit;
    const defaultWebhook = String(this.configService.get<string>('alarmWebhookDefaultUrl') ?? '').trim();
    if (!defaultWebhook) return [];
    try {
      return [new URL(defaultWebhook).hostname.toLowerCase()];
    } catch {
      return [];
    }
  }

  private async validateWebhookUrl(raw: string | undefined | null) {
    const clean = raw?.trim();
    if (!clean) return null;
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      throw new BadRequestException('Webhook URL inválida.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('Webhook URL deve usar http ou https.');
    }

    const host = parsed.hostname.trim().toLowerCase();
    const allowlist = this.getWebhookAllowlist();
    if (!allowlist.length || !isAllowedHost(host, allowlist)) {
      throw new BadRequestException('Webhook host fora da allowlist.');
    }

    if (isPrivateOrReservedIp(host)) {
      throw new BadRequestException('Webhook para IP privado/reservado não é permitido.');
    }

    const resolvedIps = await resolveHostIps(host);
    if (resolvedIps.some((ip) => isPrivateOrReservedIp(ip))) {
      throw new BadRequestException('Webhook resolve para IP privado/reservado.');
    }

    return parsed.toString();
  }

  private async getRule(source: AlarmSource, eventType: string) {
    return this.prisma.alarmRule.findUnique({
      where: {
        source_eventType: {
          source,
          eventType,
        },
      },
    });
  }

  private appendTransition(
    metadata: unknown,
    entry: {
      at?: string;
      action: string;
      byUserId?: string | null;
      byUserName?: string | null;
      note?: string | null;
      extra?: Record<string, unknown>;
    },
  ): Prisma.InputJsonValue {
    const base = metadata && typeof metadata === 'object' ? ({ ...(metadata as Record<string, unknown>) }) : {};
    const history = Array.isArray((base as any).transitionHistory) ? ([...(base as any).transitionHistory] as Array<Record<string, unknown>>) : [];
    history.push({
      at: entry.at ?? new Date().toISOString(),
      action: entry.action,
      byUserId: entry.byUserId ?? null,
      byUserName: entry.byUserName ?? null,
      note: entry.note ?? null,
      ...(entry.extra ?? {}),
    });
    return {
      ...base,
      transitionHistory: history,
    } as Prisma.InputJsonValue;
  }

  async processEvent(input: {
    eventId: string;
    cameraId: string;
    type: string;
    severity: string;
    message: string;
    metadata?: unknown;
    occurredAt: Date;
  }) {
    const source = inferSource(input.type);
    if (!source) return null;

    if (input.type === 'MOTION_DETECTED') {
      await this.resolveStaleMotionAlarms(input.occurredAt);
    }

    if (isRecoveryEvent(input.type)) {
      return this.autoResolveForCamera(input.cameraId, source, input.eventId, input.occurredAt, input.message);
    }

    // Respeita o liga/desliga de alarme por câmera (definido pelo admin). Câmera com
    // alarmes desligados não abre novos alarmes (eventos de recuperação acima ainda
    // fecham alarmes antigos normalmente).
    const cameraAlarmConfig = await this.prisma.camera.findUnique({
      where: { id: input.cameraId },
      select: { alarmsEnabled: true },
    });
    if (cameraAlarmConfig && cameraAlarmConfig.alarmsEnabled === false) return null;

    const rule = await this.getRule(source, input.type);
    // Regra explícita é obrigatória para abrir alarme operacional real.
    if (!rule) return null;
    if (!rule.isEnabled) return null;
    if (rule && await this.muteService.isRuleMuted(rule.id)) return null;
    if (await this.muteService.isCameraEventMuted(input.cameraId, input.type)) return null;

    const dedupWindowSeconds = rule?.dedupWindowSeconds ?? defaultDedupWindow(source);
    const priority = rule?.priority ?? defaultPriorityFor(input.type, input.severity);
    const dedupThreshold = new Date(input.occurredAt.getTime() - dedupWindowSeconds * 1000);

    const existing = await this.prisma.alarmInstance.findFirst({
      where: {
        cameraId: input.cameraId,
        source,
        type: input.type,
        status: { in: [AlarmStatus.OPEN, AlarmStatus.ACKED] },
        lastOccurredAt: { gte: dedupThreshold },
      },
      orderBy: { lastOccurredAt: 'desc' },
    });

    const metadata =
      typeof input.metadata === 'object' && input.metadata
        ? (input.metadata as Prisma.InputJsonValue)
        : ({} as Prisma.InputJsonValue);

    if (existing) {
      const updated = await this.prisma.alarmInstance.update({
        where: { id: existing.id },
        data: {
          eventId: input.eventId,
          message: input.message,
          severity: input.severity,
          priority,
          metadata,
          lastOccurredAt: input.occurredAt,
          occurrenceCount: { increment: 1 },
          ...(existing.status === AlarmStatus.RESOLVED ? { status: AlarmStatus.OPEN, resolvedAt: null, resolvedByUserId: null, resolvedByUserName: null } : {}),
        },
      });
      if (rule?.notifyOnOpen && existing.status === AlarmStatus.RESOLVED) {
        void this.notifications.notifyOnOpen(updated, rule).catch(() => undefined);
      }
      return updated;
    }

    const created = await this.prisma.alarmInstance.create({
      data: {
        cameraId: input.cameraId,
        eventId: input.eventId,
        source,
        type: input.type,
        title: input.type.replace(/_/g, ' '),
        message: input.message,
        severity: input.severity,
        priority,
        metadata,
        firstOccurredAt: input.occurredAt,
        lastOccurredAt: input.occurredAt,
      },
    });
    if (rule.notifyOnOpen) {
      void this.notifications.notifyOnOpen(created, rule).catch(() => undefined);
    }
    return created;
  }

  private async autoResolveForCamera(cameraId: string, source: AlarmSource, eventId: string, occurredAt: Date, message: string) {
    const targets = await this.prisma.alarmInstance.findMany({
      where: {
        cameraId,
        status: { in: [AlarmStatus.OPEN, AlarmStatus.ACKED] },
        source: source === AlarmSource.HEALTH ? { in: [AlarmSource.HEALTH, AlarmSource.STREAM] } : source,
      },
      select: { id: true, occurrenceCount: true },
    });

    if (!targets.length) return null;

    await this.prisma.alarmInstance.updateMany({
      where: { id: { in: targets.map((item) => item.id) } },
      data: {
        status: AlarmStatus.RESOLVED,
        resolvedAt: occurredAt,
        resolvedByUserName: 'SYSTEM_AUTO_RECOVERY',
        note: message,
        eventId,
      },
    });

    return { resolved: targets.length };
  }

  async list(params: {
    accessibleCameraIds: string[];
    cameraId?: string;
    from?: string;
    to?: string;
    status?: AlarmStatus;
    severity?: string;
    priority?: AlarmPriority;
    source?: AlarmSource;
    type?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.max(1, Math.min(200, params.limit ?? 100));
    const offset = Math.max(0, params.offset ?? 0);
    const from = params.from ? new Date(params.from) : undefined;
    const to = params.to ? new Date(params.to) : undefined;
    const cameraIds = params.cameraId ? [params.cameraId] : params.accessibleCameraIds;

    const where = {
      ...(cameraIds.length ? { cameraId: { in: cameraIds } } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.priority ? { priority: params.priority } : {}),
      ...(params.source ? { source: params.source } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(from || to
        ? {
            lastOccurredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.alarmInstance.findMany({
        where,
        include: { camera: { select: { name: true } } },
        orderBy: [{ status: 'asc' }, { priority: 'asc' }, { lastOccurredAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.alarmInstance.count({ where }),
    ]);

    return {
      items: items.map((alarm) => ({
        ...(function () {
          const metadataObj =
            alarm.metadata && typeof alarm.metadata === 'object'
              ? (alarm.metadata as Record<string, unknown>)
              : {};
          const snoozeRaw =
            metadataObj.snooze && typeof metadataObj.snooze === 'object'
              ? (metadataObj.snooze as Record<string, unknown>)
              : null;
          const until = typeof snoozeRaw?.until === 'string' ? snoozeRaw.until : null;
          const active = Boolean(snoozeRaw?.active);
          const isSnoozed = Boolean(active && until && new Date(until).getTime() > Date.now());
          const history = Array.isArray(metadataObj.transitionHistory) ? metadataObj.transitionHistory : [];
          const notificationDelivery = Array.isArray(metadataObj.notificationDelivery) ? metadataObj.notificationDelivery : [];
          const lastNotificationStatus =
            typeof metadataObj.lastNotificationStatus === 'string' ? metadataObj.lastNotificationStatus : null;
          return {
            isSnoozed,
            snoozedUntil: until,
            transitionHistory: history,
            notificationDelivery,
            lastNotificationStatus,
          };
        })(),
        id: alarm.id,
        cameraId: alarm.cameraId,
        cameraName: alarm.camera?.name ?? null,
        eventId: alarm.eventId,
        source: alarm.source,
        type: alarm.type,
        title: alarm.title,
        message: alarm.message,
        severity: alarm.severity,
        priority: alarm.priority,
        status: alarm.status,
        metadata: alarm.metadata,
        note: alarm.note,
        occurrenceCount: alarm.occurrenceCount,
        firstOccurredAt: alarm.firstOccurredAt,
        occurredAt: alarm.lastOccurredAt,
        acknowledgedAt: alarm.acknowledgedAt,
        acknowledgedByUserId: alarm.acknowledgedByUserId,
        acknowledgedByUserName: alarm.acknowledgedByUserName,
        resolvedAt: alarm.resolvedAt,
        resolvedByUserId: alarm.resolvedByUserId,
        resolvedByUserName: alarm.resolvedByUserName,
      })),
      total,
      limit,
      offset,
    };
  }

  async ensureExists(id: string) {
    const alarm = await this.prisma.alarmInstance.findUnique({ where: { id } });
    if (!alarm) throw new NotFoundException('Alarme não encontrado.');
    return alarm;
  }

  async acknowledge(id: string, user: { id: string; name: string }, note?: string) {
    const existing = await this.ensureExists(id);
    return this.prisma.alarmInstance.update({
      where: { id },
      data: {
        status: AlarmStatus.ACKED,
        acknowledgedAt: new Date(),
        acknowledgedByUserId: user.id,
        acknowledgedByUserName: user.name,
        note: note?.trim() || undefined,
        metadata: this.appendTransition(existing.metadata, {
          action: 'ACKNOWLEDGED',
          byUserId: user.id,
          byUserName: user.name,
          note: note?.trim() || null,
        }),
      },
      include: { camera: { select: { name: true } } },
    });
  }

  async resolve(id: string, user: { id: string; name: string }, note?: string) {
    const existing = await this.ensureExists(id);
    return this.prisma.alarmInstance.update({
      where: { id },
      data: {
        status: AlarmStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedByUserId: user.id,
        resolvedByUserName: user.name,
        ...(note?.trim() ? { note: note.trim() } : {}),
        metadata: this.appendTransition(existing.metadata, {
          action: 'RESOLVED',
          byUserId: user.id,
          byUserName: user.name,
          note: note?.trim() || null,
        }),
      },
      include: { camera: { select: { name: true } } },
    });
  }

  async addNote(id: string, user: { id: string; name: string }, note: string) {
    const existing = await this.ensureExists(id);
    const trimmed = note.trim();
    if (!trimmed) return existing;
    return this.prisma.alarmInstance.update({
      where: { id },
      data: {
        note: existing.note?.trim() ? `${existing.note}\n${trimmed}` : trimmed,
        metadata: this.appendTransition(existing.metadata, {
          action: 'NOTE_ADDED',
          byUserId: user.id,
          byUserName: user.name,
          note: trimmed,
        }),
      },
      include: { camera: { select: { name: true } } },
    });
  }

  async snooze(id: string, user: { id: string; name: string }, minutes: number, note?: string) {
    const existing = await this.ensureExists(id);
    const safeMinutes = Math.max(1, Math.min(1440, Math.floor(minutes)));
    const snoozedUntil = new Date(Date.now() + safeMinutes * 60 * 1000).toISOString();
    const base = existing.metadata && typeof existing.metadata === 'object' ? ({ ...(existing.metadata as Record<string, unknown>) }) : {};
    const metadataWithSnooze = {
      ...base,
      snooze: {
        active: true,
        until: snoozedUntil,
        byUserId: user.id,
        byUserName: user.name,
        note: note?.trim() || null,
      },
    } as Prisma.InputJsonValue;

    return this.prisma.alarmInstance.update({
      where: { id },
      data: {
        status: AlarmStatus.ACKED,
        acknowledgedAt: existing.acknowledgedAt ?? new Date(),
        acknowledgedByUserId: existing.acknowledgedByUserId ?? user.id,
        acknowledgedByUserName: existing.acknowledgedByUserName ?? user.name,
        note: note?.trim() || existing.note || undefined,
        metadata: this.appendTransition(metadataWithSnooze, {
          action: 'SNOOZED',
          byUserId: user.id,
          byUserName: user.name,
          note: note?.trim() || null,
          extra: { minutes: safeMinutes, until: snoozedUntil },
        }),
      },
      include: { camera: { select: { name: true } } },
    });
  }

  async unsnooze(id: string, user: { id: string; name: string }, note?: string) {
    const existing = await this.ensureExists(id);
    const base = existing.metadata && typeof existing.metadata === 'object' ? ({ ...(existing.metadata as Record<string, unknown>) }) : {};
    const snooze = (base as any).snooze && typeof (base as any).snooze === 'object' ? { ...((base as any).snooze as Record<string, unknown>) } : {};
    const metadataWithoutSnooze = {
      ...base,
      snooze: {
        ...snooze,
        active: false,
        clearedAt: new Date().toISOString(),
        clearedByUserId: user.id,
        clearedByUserName: user.name,
        clearNote: note?.trim() || null,
      },
    } as Prisma.InputJsonValue;

    return this.prisma.alarmInstance.update({
      where: { id },
      data: {
        metadata: this.appendTransition(metadataWithoutSnooze, {
          action: 'UNSNOOZED',
          byUserId: user.id,
          byUserName: user.name,
          note: note?.trim() || null,
        }),
      },
      include: { camera: { select: { name: true } } },
    });
  }

  async bulkAction(
    action: 'ack' | 'resolve' | 'snooze' | 'unsnooze',
    eventIds: string[],
    user: { id: string; name: string },
    opts?: { note?: string; snoozeMinutes?: number },
  ) {
    const uniqueIds = [...new Set(eventIds)].slice(0, 200);
    const results: Array<{ eventId: string; status: 'ok' | 'skipped'; reason?: string }> = [];
    for (const id of uniqueIds) {
      try {
        if (action === 'ack') await this.acknowledge(id, user, opts?.note);
        if (action === 'resolve') await this.resolve(id, user, opts?.note);
        if (action === 'snooze') await this.snooze(id, user, opts?.snoozeMinutes ?? 15, opts?.note);
        if (action === 'unsnooze') await this.unsnooze(id, user, opts?.note);
        results.push({ eventId: id, status: 'ok' });
      } catch (error) {
        results.push({ eventId: id, status: 'skipped', reason: (error as Error).message });
      }
    }
    return {
      action,
      totalRequested: uniqueIds.length,
      ok: results.filter((r) => r.status === 'ok').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      results,
    };
  }

  async deleteAll() {
    const result = await this.prisma.alarmInstance.deleteMany({});
    return {
      deleted: result.count,
    };
  }

  async listRules() {
    const items = await this.prisma.alarmRule.findMany({
      orderBy: [{ source: 'asc' }, { eventType: 'asc' }],
    });
    return { items };
  }

  async createRule(dto: CreateAlarmRuleDto) {
    const safeWebhookUrl = await this.validateWebhookUrl(dto.webhookUrl);
    return this.prisma.alarmRule.upsert({
      where: {
        source_eventType: {
          source: dto.source,
          eventType: dto.eventType,
        },
      },
      create: {
        name: dto.name.trim(),
        source: dto.source,
        eventType: dto.eventType.trim(),
        priority: dto.priority ?? AlarmPriority.P3,
        isEnabled: dto.isEnabled ?? true,
        dedupWindowSeconds: dto.dedupWindowSeconds ?? defaultDedupWindow(dto.source),
        autoResolveOnRecovery: dto.autoResolveOnRecovery ?? false,
        notifyOnOpen: dto.notifyOnOpen ?? true,
        webhookUrl: safeWebhookUrl,
        emailTo: dto.emailTo?.trim() || null,
      },
      update: {
        name: dto.name.trim(),
        priority: dto.priority ?? AlarmPriority.P3,
        isEnabled: dto.isEnabled ?? true,
        dedupWindowSeconds: dto.dedupWindowSeconds ?? defaultDedupWindow(dto.source),
        autoResolveOnRecovery: dto.autoResolveOnRecovery ?? false,
        notifyOnOpen: dto.notifyOnOpen ?? true,
        webhookUrl: safeWebhookUrl,
        emailTo: dto.emailTo?.trim() || null,
      },
    });
  }

  async updateRule(id: string, dto: UpdateAlarmRuleDto) {
    const existing = await this.prisma.alarmRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Regra de alarme não encontrada.');
    const safeWebhookUrl = dto.webhookUrl !== undefined
      ? await this.validateWebhookUrl(dto.webhookUrl)
      : undefined;
    return this.prisma.alarmRule.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
        ...(dto.dedupWindowSeconds !== undefined ? { dedupWindowSeconds: dto.dedupWindowSeconds } : {}),
        ...(dto.autoResolveOnRecovery !== undefined ? { autoResolveOnRecovery: dto.autoResolveOnRecovery } : {}),
        ...(dto.notifyOnOpen !== undefined ? { notifyOnOpen: dto.notifyOnOpen } : {}),
        ...(dto.webhookUrl !== undefined ? { webhookUrl: safeWebhookUrl } : {}),
        ...(dto.emailTo !== undefined ? { emailTo: dto.emailTo.trim() || null } : {}),
      },
    });
  }

  async setRuleEnabled(id: string, dto: SetAlarmRuleEnabledDto) {
    const existing = await this.prisma.alarmRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Regra de alarme não encontrada.');
    return this.prisma.alarmRule.update({
      where: { id },
      data: { isEnabled: dto.isEnabled },
    });
  }

  async simulateRule(id: string, dto: SimulateAlarmRuleDto) {
    const rule = await this.prisma.alarmRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Regra de alarme não encontrada.');

    const now = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    const eventType = dto.eventType.trim();
    const cameraId = dto.cameraId.trim();
    const eventMatches = rule.eventType === eventType;
    const sourceMatches = inferSource(eventType) === rule.source;

    if (!rule.isEnabled) {
      return {
        ruleId: rule.id,
        wouldTrigger: false,
        reason: 'rule_disabled',
        details: 'A regra está desativada.',
      };
    }
    if (!eventMatches) {
      return {
        ruleId: rule.id,
        wouldTrigger: false,
        reason: 'event_type_mismatch',
        details: `A regra espera ${rule.eventType}, mas recebeu ${eventType}.`,
      };
    }
    if (!sourceMatches) {
      return {
        ruleId: rule.id,
        wouldTrigger: false,
        reason: 'source_mismatch',
        details: `A regra espera source ${rule.source}.`,
      };
    }

    const threshold = new Date(now.getTime() - rule.dedupWindowSeconds * 1000);
    const existing = await this.prisma.alarmInstance.findFirst({
      where: {
        cameraId,
        source: rule.source,
        type: eventType,
        status: { in: [AlarmStatus.OPEN, AlarmStatus.ACKED] },
        lastOccurredAt: { gte: threshold },
      },
      orderBy: { lastOccurredAt: 'desc' },
      select: { id: true, lastOccurredAt: true, occurrenceCount: true, status: true },
    });

    if (existing) {
      return {
        ruleId: rule.id,
        wouldTrigger: false,
        reason: 'dedup_window_active',
        details: `Já existe alarme ${existing.id} dentro da janela de deduplicação.`,
        existingAlarm: existing,
      };
    }

    return {
      ruleId: rule.id,
      wouldTrigger: true,
      reason: 'match',
      details: 'Evento compatível e fora da janela de deduplicação.',
      preview: {
        cameraId,
        type: eventType,
        severity: dto.severity,
        message: dto.message?.trim() || `${eventType} simulated`,
        priority: rule.priority,
        dedupWindowSeconds: rule.dedupWindowSeconds,
      },
    };
  }
}
