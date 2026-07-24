import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { AlarmInstance, AlarmRule, Prisma } from '@prisma/client';
import axios from 'axios';
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { isAllowedHost, isPrivateOrReservedIp, resolveHostIps } from '../../common/network/safe-url.helper';
import { ALARM_NOTIFICATION_QUEUE } from '../queues/alarm-notification.queue';
import { PUSH_RECEIPTS_QUEUE, pushReceiptsDelayMs } from '../queues/push-receipts.queue';
import type { PushReceiptsJob } from './push-receipts.processor';
import { PushService } from '../../notifications/push.service';
import { PushDevicesService } from '../../notifications/push-devices.service';

type NotificationChannel = 'webhook' | 'email' | 'push';

// Rótulos humanos (PT-BR) por tipo de evento — usados no corpo do push para não
// mostrar textos técnicos ("MOTION DETECTED", "motion (0.27)") ao usuário final.
const EVENT_LABELS_PT: Record<string, string> = {
  MOTION_DETECTED: 'Movimento detectado',
  MOTION_RECORDING_STARTED: 'Gravação por movimento iniciada',
  MOTION_RECORDING_STOPPED: 'Gravação por movimento encerrada',
  MOTION_RECORDING_FAILED: 'Falha na gravação por movimento',
  PERSON_DETECTED: 'Pessoa detectada',
  VEHICLE_DETECTED: 'Veículo detectado',
  FACE_DETECTED: 'Rosto detectado',
  LINE_CROSSING: 'Cruzamento de linha detectado',
  INTRUSION: 'Intrusão detectada',
  HEALTH_CAMERA_OFFLINE: 'Câmera ficou offline',
  HEALTH_CAMERA_RECOVERED: 'Câmera voltou ao normal',
  HEALTH_AUTO_RECOVERED: 'Câmera recuperada automaticamente',
};

// Corpo humano do alerta: rótulo mapeado; senão o tipo humanizado (sem
// underscores/maiúsculas cruas). Nunca vaza texto técnico interno.
function friendlyEventBody(type: string): string {
  return EVENT_LABELS_PT[type]
    ?? type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

type AlarmNotificationJob = {
  alarmId: string;
  ruleId?: string | null;
  channels?: NotificationChannel[];
};

@Injectable()
@Processor(ALARM_NOTIFICATION_QUEUE)
export class AlarmNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(AlarmNotificationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly pushService: PushService,
    private readonly pushDevices: PushDevicesService,
    @InjectQueue(PUSH_RECEIPTS_QUEUE) private readonly pushReceiptsQueue: Queue<PushReceiptsJob>,
  ) {
    super();
  }

  private buildPayload(alarm: AlarmInstance) {
    return {
      id: alarm.id,
      cameraId: alarm.cameraId,
      eventId: alarm.eventId,
      source: alarm.source,
      type: alarm.type,
      title: alarm.title,
      message: alarm.message,
      severity: alarm.severity,
      priority: alarm.priority,
      status: alarm.status,
      occurrenceCount: alarm.occurrenceCount,
      firstOccurredAt: alarm.firstOccurredAt,
      lastOccurredAt: alarm.lastOccurredAt,
      metadata: alarm.metadata,
    };
  }

  private async appendDelivery(alarmId: string, entry: Record<string, unknown>) {
    const alarm = await this.prisma.alarmInstance.findUnique({
      where: { id: alarmId },
      select: { metadata: true },
    });
    if (!alarm) return;
    const metadata = alarm.metadata && typeof alarm.metadata === 'object'
      ? ({ ...(alarm.metadata as Record<string, unknown>) })
      : {};
    const delivery = Array.isArray(metadata.notificationDelivery)
      ? ([...(metadata.notificationDelivery as Array<Record<string, unknown>>)])
      : [];
    delivery.push(entry);
    const trimmed = delivery.slice(-30);
    await this.prisma.alarmInstance.update({
      where: { id: alarmId },
      data: {
        metadata: {
          ...metadata,
          notificationDelivery: trimmed,
          lastNotificationStatus: entry.status ?? null,
          lastNotificationAt: entry.at ?? new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
  }

  private async notifyWebhook(alarm: AlarmInstance, rule: AlarmRule | null, payload: Record<string, unknown>) {
    const webhook = (rule?.webhookUrl?.trim() || this.configService.get<string>('alarmWebhookDefaultUrl') || '').trim();
    if (!webhook) {
      return { skipped: true, reason: 'webhook_not_configured' };
    }
    const parsed = new URL(webhook);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { skipped: true, reason: 'webhook_invalid_protocol' };
    }
    const explicitAllowlist = String(this.configService.get<string>('alarmWebhookAllowedHosts') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const defaultWebhook = String(this.configService.get<string>('alarmWebhookDefaultUrl') ?? '').trim();
    let allowlist = explicitAllowlist;
    if (!allowlist.length && defaultWebhook) {
      try {
        allowlist = [new URL(defaultWebhook).hostname.toLowerCase()];
      } catch {
        allowlist = [];
      }
    }
    const host = parsed.hostname.trim().toLowerCase();
    if (!allowlist.length || !isAllowedHost(host, allowlist)) {
      return { skipped: true, reason: 'webhook_host_not_allowed' };
    }
    if (isPrivateOrReservedIp(host)) {
      return { skipped: true, reason: 'webhook_private_host_blocked' };
    }
    const resolvedIps = await resolveHostIps(host);
    if (resolvedIps.some((ip) => isPrivateOrReservedIp(ip))) {
      return { skipped: true, reason: 'webhook_private_resolution_blocked' };
    }

    const signingSecret = String(this.configService.get<string>('alarmWebhookSigningSecret') ?? '').trim();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Alarm-Event': alarm.type,
      'X-Alarm-Timestamp': timestamp,
    };
    if (signingSecret) {
      headers['X-Alarm-Signature-Alg'] = 'hmac-sha256';
      headers['X-Alarm-Signature'] = createHmac('sha256', signingSecret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    }

    // maxRedirects: 0 — a allowlist e o check de IP privado acima cobrem só o PRIMEIRO
    // salto. Com o default do axios (5 redirects), um host permitido responde 302 para
    // http://169.254.169.254/... e a requisição sai para o metadata service levando junto
    // o header X-Alarm-Signature. Webhook legítimo não precisa de redirect: se o destino
    // mudou, o admin atualiza a URL.
    await axios.post(webhook, payload, { timeout: 8000, headers, maxRedirects: 0 });
    return { skipped: false };
  }

  private async notifyEmail(alarm: AlarmInstance, rule: AlarmRule | null, payload: Record<string, unknown>) {
    const emailTo = (rule?.emailTo?.trim() || '').trim();
    if (!emailTo) {
      return { skipped: true, reason: 'email_not_configured' };
    }

    const host = this.configService.get<string>('smtpHost') ?? '';
    const port = Number(this.configService.get<number>('smtpPort') ?? 587);
    const secure = Boolean(this.configService.get<boolean>('smtpSecure') ?? false);
    const user = this.configService.get<string>('smtpUser') ?? '';
    const pass = this.configService.get<string>('smtpPass') ?? '';
    const from = this.configService.get<string>('alarmEmailFrom') ?? user;

    if (!host || !from || !user || !pass) {
      return { skipped: true, reason: 'smtp_not_fully_configured' };
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    await transporter.sendMail({
      from,
      to: emailTo,
      subject: `[Alarme ${alarm.priority}] ${alarm.title} - câmera ${(alarm as any).camera?.name ?? alarm.cameraId ?? 'desconhecida'}`,
      text: [
        'Novo alarme detectado',
        '',
        `Titulo: ${alarm.title}`,
        `Mensagem: ${alarm.message}`,
        `Camera: ${(alarm as any).camera?.name ?? alarm.cameraId ?? 'desconhecida'}`,
        `Tipo: ${alarm.type}`,
        `Prioridade: ${alarm.priority}`,
        `Severidade: ${alarm.severity}`,
        `Ocorrencias: ${alarm.occurrenceCount}`,
        `Primeira ocorrencia: ${new Date(alarm.firstOccurredAt).toISOString()}`,
        `Ultima ocorrencia: ${new Date(alarm.lastOccurredAt).toISOString()}`,
        '',
        `Payload JSON: ${JSON.stringify(payload)}`,
      ].join('\n'),
    });
    return { skipped: false };
  }

  // Push para os apps móveis dos usuários que podem VER a câmera do alarme.
  private async notifyPush(alarm: AlarmInstance) {
    const tokens = await this.pushDevices.getTokensForCamera(alarm.cameraId);
    if (!tokens.length) {
      return { skipped: true, reason: 'no_registered_devices' } as const;
    }
    const cameraName = (alarm as any).camera?.name as string | undefined;
    const { invalidTokens, receiptIds } = await this.pushService.sendToTokens(tokens, {
      // Título = NOME da câmera (o que o usuário reconhece na hora).
      // Corpo = descrição humana do evento. Ex.: "Grupo Flash Cam-12" / "Movimento detectado".
      title: cameraName ?? 'Câmera',
      body: friendlyEventBody(alarm.type),
      data: {
        alarmId: alarm.id,
        cameraId: alarm.cameraId,
        type: alarm.type,
        priority: alarm.priority,
      },
      channelId: 'alarms',
      priority: 'high',
    });
    if (invalidTokens.length) {
      await this.pushDevices.pruneInvalid(invalidTokens);
    }
    // Estágio 2: agenda a conferência dos RECEIPTS ~15min depois (job atrasado). O
    // Expo só revela alguns tokens mortos no processamento assíncrono, que não
    // aparecem no ticket imediato acima. Falha ao agendar NÃO reprova a entrega já
    // feita — só perde a poda tardia daquele lote.
    const receiptCount = Object.keys(receiptIds).length;
    if (receiptCount > 0) {
      try {
        await this.pushReceiptsQueue.add(
          'fetch-receipts',
          { receiptIds },
          {
            delay: pushReceiptsDelayMs(),
            attempts: 3,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
      } catch (error) {
        this.logger.warn(`Falha ao agendar conferência de receipts (${receiptCount} ticket(s)): ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    return { skipped: false } as const;
  }

  async process(job: Job<AlarmNotificationJob>) {
    const alarm = await this.prisma.alarmInstance.findUnique({
      where: { id: job.data.alarmId },
      include: { camera: { select: { name: true } } },
    });
    if (!alarm) return;
    const rule = job.data.ruleId ? await this.prisma.alarmRule.findUnique({ where: { id: job.data.ruleId } }) : null;
    const payload = this.buildPayload(alarm);

    const channels: NotificationChannel[] = Array.isArray(job.data.channels) && job.data.channels.length
      ? job.data.channels
      : ['webhook', 'email', 'push'];
    for (const channel of channels) {
      try {
        const result = channel === 'webhook'
          ? await this.notifyWebhook(alarm, rule, payload)
          : channel === 'email'
            ? await this.notifyEmail(alarm, rule, payload)
            : await this.notifyPush(alarm);
        await this.appendDelivery(alarm.id, {
          at: new Date().toISOString(),
          channel,
          status: result.skipped ? 'SKIPPED' : 'DELIVERED',
          reason: result.skipped ? result.reason : null,
          jobId: job.id,
          attempt: job.attemptsMade + 1,
        });
        await this.auditService.log(
          null,
          'alarm.notification.delivery',
          'AlarmInstance',
          alarm.id,
          {
            channel,
            status: result.skipped ? 'SKIPPED' : 'DELIVERED',
            reason: result.skipped ? result.reason : null,
            attempt: job.attemptsMade + 1,
            jobId: String(job.id ?? ''),
          } as Prisma.JsonValue,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_error';
        await this.appendDelivery(alarm.id, {
          at: new Date().toISOString(),
          channel,
          status: 'FAILED',
          reason: message,
          jobId: job.id,
          attempt: job.attemptsMade + 1,
        });
        await this.auditService.log(
          null,
          'alarm.notification.delivery',
          'AlarmInstance',
          alarm.id,
          {
            channel,
            status: 'FAILED',
            reason: message,
            attempt: job.attemptsMade + 1,
            jobId: String(job.id ?? ''),
          } as Prisma.JsonValue,
        );
        this.logger.warn(`Notification ${channel} failed for alarm=${alarm.id}: ${message}`);
        if (channel === 'webhook') {
          // Falha em webhook reprova o job para retry global.
          throw error;
        }
      }
    }
  }
}
