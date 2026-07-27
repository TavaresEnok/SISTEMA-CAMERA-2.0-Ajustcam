import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
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
  // Alarme que originou o envio, para PROMOVER o status ACCEPTED→DELIVERED/FAILED
  // quando o Expo confirmar (ou negar) a entrega. Opcional: jobs antigos na fila
  // (enfileirados antes desta versão) não têm o campo e seguem só podando tokens.
  alarmId?: string;
};

@Injectable()
@Processor(PUSH_RECEIPTS_QUEUE)
export class PushReceiptsProcessor extends WorkerHost {
  private readonly logger = new Logger(PushReceiptsProcessor.name);

  constructor(
    private readonly pushService: PushService,
    private readonly pushDevices: PushDevicesService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<PushReceiptsJob>): Promise<void> {
    const receiptIds = job.data?.receiptIds ?? {};
    if (!receiptIds || Object.keys(receiptIds).length === 0) return;

    const { invalidTokens, failedChunks, lastError, okCount, errorCount } =
      await this.pushService.fetchReceipts(receiptIds);
    if (invalidTokens.length) {
      await this.pushDevices.pruneInvalid(invalidTokens);
      this.logger.log(`Receipts do Expo: ${invalidTokens.length} token(s) morto(s) removido(s) (job=${job.id ?? 'unknown'}).`);
    }

    // Estágio 2 do estado do push: o ticket só dava ACCEPTED; o receipt é que PROVA
    // (ou nega) a entrega. Promove o registro do alarme para DELIVERED/FAILED.
    const alarmId = job.data?.alarmId;
    if (alarmId && (okCount > 0 || errorCount > 0)) {
      await this.appendPushOutcome(alarmId, {
        at: new Date().toISOString(),
        channel: 'push',
        status: okCount > 0 ? 'DELIVERED' : 'FAILED',
        reason: errorCount > 0 ? `${errorCount} receipt(s) com erro` : null,
        stage: 'receipt',
        jobId: job.id,
      });
    }
    // Progresso preservado acima; agora RELANÇA para o BullMQ retentar os chunks
    // que falharam. Engolir a falha fazia o job terminar "com sucesso" sem ter
    // consultado nada — as tentativas configuradas nunca aconteciam.
    if (failedChunks > 0) {
      throw new Error(`Consulta de receipts falhou em ${failedChunks} lote(s): ${lastError ?? 'unknown'}`);
    }
  }

  /** Anexa o desfecho do receipt ao histórico de entrega do alarme (mesmo formato
   * do estágio 1, em `metadata.notificationDelivery`). Best-effort: um alarme já
   * apagado (retenção) não pode derrubar a poda de tokens que já aconteceu. */
  private async appendPushOutcome(alarmId: string, entry: Record<string, unknown>) {
    try {
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
      metadata.notificationDelivery = delivery;
      await this.prisma.alarmInstance.update({
        where: { id: alarmId },
        data: { metadata: metadata as Prisma.JsonObject },
      });
    } catch (error) {
      this.logger.warn(`Falha ao registrar desfecho do receipt no alarme ${alarmId}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}
