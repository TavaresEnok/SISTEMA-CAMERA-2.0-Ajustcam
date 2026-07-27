import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { envNumber } from '../../common/config/env-number.helper';
import { RecordingsService } from '../../recordings/recordings.service';
import {
  RANGE_EXPORT_JOB_NAME,
  RANGE_EXPORT_RECOVERY_JOB_NAME,
  RECORDING_EXPORT_QUEUE,
} from '../queues/recording-export.queue';

/**
 * LIMITE DE CONCORRÊNCIA — o ponto do item.
 *
 * Sem fila, três operadores clicando "Exportar" disparavam três FFmpeg ao mesmo
 * tempo, todos competindo com a GRAVAÇÃO das câmeras do host. O modo de falha
 * não é a exportação lenta: é a gravação furar. Padrão 1 = as exportações
 * andam em fila indiana. (O `nice` já rebaixado no `execFfmpegLowPriority`
 * continua valendo; são camadas complementares.)
 */
const EXPORT_CONCURRENCY = envNumber('RECORDING_EXPORT_CONCURRENCY', 1, {
  min: 1,
  max: 4,
  integer: true,
});

type RangeExportJobData = {
  cameraId: string;
  from: string;
  to: string;
  profile?: 'auto' | 'compatible';
  reason?: string;
  label?: string | null;
  requestedByUserId: string;
};

@Injectable()
@Processor(RECORDING_EXPORT_QUEUE, { concurrency: EXPORT_CONCURRENCY })
export class RecordingExportProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(RecordingExportProcessor.name);

  constructor(
    private readonly recordingsService: RecordingsService,
    @InjectQueue(RECORDING_EXPORT_QUEUE) private readonly exportQueue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    // Varredura periódica de ÓRFÃOS: job que ficou `active` porque o processo
    // que o executava morreu (deploy, OOM, queda de energia). Sem ela a tela do
    // operador mostra "exportando" para sempre e o trabalho nunca sai.
    await this.exportQueue.add(
      RANGE_EXPORT_RECOVERY_JOB_NAME,
      {},
      {
        jobId: 'range-export-recovery-cron',
        repeat: { pattern: '*/5 * * * *' },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }

  async process(job: Job<RangeExportJobData | Record<string, never>>) {
    if (job.name === RANGE_EXPORT_RECOVERY_JOB_NAME) {
      return this.recordingsService.recoverOrphanRangeExports();
    }
    if (job.name !== RANGE_EXPORT_JOB_NAME) return;

    const data = job.data as RangeExportJobData;
    this.logger.log(`Exportando intervalo da câmera ${data.cameraId}: ${data.from} → ${data.to}`);
    return this.recordingsService.runRangeExportJob(data, {
      // `at` é o BATIMENTO do job: é por ele que a recuperação de órfãos sabe
      // distinguir "travou o processo" de "está reencodando há 8 minutos".
      onProgress: async (progress) => {
        await job.updateProgress({ ...progress, at: Date.now() });
      },
    });
  }
}
