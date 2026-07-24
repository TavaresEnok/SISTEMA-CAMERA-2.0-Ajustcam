import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PushService } from '../../notifications/push.service';
import { PushDevicesService } from '../../notifications/push-devices.service';
import { PUSH_RECEIPTS_QUEUE } from '../queues/push-receipts.queue';

// Estágio 2 do push (2.8): job ATRASADO agendado ~15min após o envio. Recebe o
// mapa receiptId→token dos tickets aceitos, consulta os RECEIPTS do Expo e remove
// os tokens que só se revelam mortos no processamento assíncrono (DeviceNotRegistered
// que não aparece no ticket imediato). Sem isso, tokens de aparelhos desinstalados
// ficam para sempre no banco recebendo pushes que nunca chegam.
export type PushReceiptsJob = {
  // receiptId (do ticket do Expo) → token de push que o originou.
  receiptIds: Record<string, string>;
};

@Injectable()
@Processor(PUSH_RECEIPTS_QUEUE)
export class PushReceiptsProcessor extends WorkerHost {
  private readonly logger = new Logger(PushReceiptsProcessor.name);

  constructor(
    private readonly pushService: PushService,
    private readonly pushDevices: PushDevicesService,
  ) {
    super();
  }

  async process(job: Job<PushReceiptsJob>): Promise<void> {
    const receiptIds = job.data?.receiptIds ?? {};
    if (!receiptIds || Object.keys(receiptIds).length === 0) return;

    const { invalidTokens } = await this.pushService.fetchReceipts(receiptIds);
    if (invalidTokens.length) {
      await this.pushDevices.pruneInvalid(invalidTokens);
      this.logger.log(`Receipts do Expo: ${invalidTokens.length} token(s) morto(s) removido(s) (job=${job.id ?? 'unknown'}).`);
    }
  }
}
