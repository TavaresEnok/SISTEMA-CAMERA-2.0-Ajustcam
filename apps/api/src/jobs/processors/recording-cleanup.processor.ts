import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RecordingsService } from '../../recordings/recordings.service';
import { RetentionService } from '../../recordings/retention.service';
import { RECORDING_CLEANUP_QUEUE } from '../queues/recording-cleanup.queue';
import { envNumber } from '../../common/config/env-number.helper';

@Processor(RECORDING_CLEANUP_QUEUE)
@Injectable()
export class RecordingCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(RecordingCleanupProcessor.name);

  constructor(
    private readonly retentionService: RetentionService,
    private readonly recordingsService: RecordingsService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Iniciando manutenção diária de gravações (job=${job.id ?? 'unknown'}).`);
    const cleanup = await this.retentionService.handleRetention('bullmq');
    const reconcileLimit = envNumber('RECORDING_METADATA_RECONCILE_LIMIT', 2_000, { min: 1, max: 10_000 });
    const metadata = await this.recordingsService.reconcileRecordingMetadata(reconcileLimit);
    const thumbnails = await this.recordingsService.enqueueMissingThumbnails(reconcileLimit);
    this.logger.log(`Manutenção diária concluída: cleanup=${JSON.stringify(cleanup)} metadata=${JSON.stringify(metadata)} thumbnails=${JSON.stringify(thumbnails)}.`);
  }
}
