import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { CAMERA_HEALTH_CHECK_QUEUE } from './queues/camera-health-check.queue';
import { ALARM_NOTIFICATION_QUEUE } from './queues/alarm-notification.queue';
import { RECORDING_CLEANUP_QUEUE } from './queues/recording-cleanup.queue';
import { THUMBNAIL_GENERATION_QUEUE } from './queues/thumbnail-generation.queue';
import { EVIDENCE_EXPORT_QUEUE } from './queues/evidence-export.queue';
import { RECORDING_EXPORT_QUEUE } from './queues/recording-export.queue';
import { PUSH_RECEIPTS_QUEUE } from './queues/push-receipts.queue';
import { AlarmNotificationProcessor } from './processors/alarm-notification.processor';
import { CameraHealthCheckProcessor } from './processors/camera-health-check.processor';
import { EvidenceExportProcessor } from './processors/evidence-export.processor';
import { RecordingCleanupProcessor } from './processors/recording-cleanup.processor';
import { RecordingExportProcessor } from './processors/recording-export.processor';
import { ThumbnailGenerationProcessor } from './processors/thumbnail-generation.processor';
import { PushReceiptsProcessor } from './processors/push-receipts.processor';
import { OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CamerasModule } from '../cameras/cameras.module';
import { CameraStreamModule } from '../camera-stream/camera-stream.module';
import { AuditModule } from '../audit/audit.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AlarmsModule } from '../alarms/alarms.module';
import { envNumber } from '../common/config/env-number.helper';

export async function withStartupTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} excedeu o prazo de ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Module({
  imports: [
    CamerasModule,
    CameraStreamModule,
    AuditModule,
    EvidenceModule,
    RecordingsModule,
    NotificationsModule,
    AlarmsModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redisHost') ?? process.env.REDIS_HOST ?? 'localhost',
          port: Number(configService.get<string | number>('redisPort') ?? process.env.REDIS_PORT ?? 6379),
          connectTimeout: envNumber('REDIS_CONNECT_TIMEOUT_MS', 5_000, {
            min: 500,
            max: 60_000,
            integer: true,
          }),
          retryStrategy: (attempt: number) => (
            attempt > 5 ? null : Math.min(250 * 2 ** (attempt - 1), 2_000)
          ),
        },
      }),
    }),
    BullModule.registerQueue(
      { name: ALARM_NOTIFICATION_QUEUE },
      { name: CAMERA_HEALTH_CHECK_QUEUE },
      { name: RECORDING_CLEANUP_QUEUE },
      { name: THUMBNAIL_GENERATION_QUEUE },
      { name: EVIDENCE_EXPORT_QUEUE },
      { name: RECORDING_EXPORT_QUEUE },
      { name: PUSH_RECEIPTS_QUEUE },
    ),
  ],
  providers: [AlarmNotificationProcessor, CameraHealthCheckProcessor, RecordingCleanupProcessor, ThumbnailGenerationProcessor, EvidenceExportProcessor, RecordingExportProcessor, PushReceiptsProcessor],
})
export class JobsModule implements OnModuleInit {
  constructor(
    @InjectQueue(CAMERA_HEALTH_CHECK_QUEUE) private readonly healthCheckQueue: Queue,
    @InjectQueue(RECORDING_CLEANUP_QUEUE) private readonly cleanupQueue: Queue,
    @InjectQueue(EVIDENCE_EXPORT_QUEUE) private readonly evidenceExportQueue: Queue,
  ) {}

  async onModuleInit() {
    const timeoutMs = envNumber('REDIS_STARTUP_TIMEOUT_MS', 10_000, {
      min: 1_000,
      max: 120_000,
      integer: true,
    });
    // Agendar verificação de saúde a cada 1 minuto
    await withStartupTimeout(this.healthCheckQueue.add(
      'check',
      {},
      {
        jobId: 'health-check-cron',
        repeat: { pattern: '*/1 * * * *' },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    ), timeoutMs, 'Agendamento do health-check no Redis');

    // Agendar limpeza a cada dia à meia-noite (se habilitada via BullMQ)
    if (String(process.env.RETENTION_USE_BULLMQ ?? 'true') !== 'false') {
      await withStartupTimeout(this.cleanupQueue.add(
        'cleanup',
        {},
        {
          jobId: 'recording-cleanup-cron',
          repeat: { pattern: '0 0 * * *' },
          removeOnComplete: true,
          removeOnFail: 50,
        },
      ), timeoutMs, 'Agendamento da retenção no Redis');
    }

    // Reprocessar assinaturas pendentes de pacotes de evidência a cada 5 minutos
    await withStartupTimeout(this.evidenceExportQueue.add(
      'retry-all-pending-signatures',
      {},
      {
        jobId: 'evidence-retry-signatures-cron',
        repeat: { pattern: '*/5 * * * *' },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    ), timeoutMs, 'Agendamento de evidências no Redis');
  }
}
