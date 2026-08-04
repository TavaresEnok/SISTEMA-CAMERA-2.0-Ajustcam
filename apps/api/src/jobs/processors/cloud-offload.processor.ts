import { marcandoTrabalho } from '../../common/observability/event-loop-lag.service';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CloudOffloadService } from '../../cloud-storage/cloud-offload.service';
import { CLOUD_OFFLOAD_QUEUE } from '../queues/cloud-offload.queue';

// Envio periódico das gravações para a nuvem.
//
// Cadência CURTA (padrão 15 min) e não diária como a retenção: o offload é o
// que libera disco, e um host que enche entre duas execuções perde gravação. A
// própria janela local (`localWindowHours`) já garante que nada sobe cedo
// demais, então rodar com frequência não antecipa nada — só encurta a fila.
//
// O serviço é reentrante por conta própria (um ciclo por vez), então uma
// execução que demore mais que o intervalo não gera dois envios do mesmo
// objeto.
@Processor(CLOUD_OFFLOAD_QUEUE)
@Injectable()
export class CloudOffloadProcessor extends WorkerHost {
  private readonly logger = new Logger(CloudOffloadProcessor.name);

  constructor(private readonly offload: CloudOffloadService) {
    super();
  }

  async process(job: Job): Promise<void> {
    // Marcado para o monitor de travada conseguir NOMEAR o culpado: sem isso
    // ele diz que o laço parou 11s e não diz por causa de quê.
    const resultado = await marcandoTrabalho('envio para a nuvem', () => this.offload.runOnce());
    if (resultado.skipped) {
      // Sem storage, sem política ou ciclo em andamento: nível DEBUG de
      // propósito. A cada 15 minutos, isso viraria ruído em INFO e esconderia
      // as execuções que importam.
      this.logger.debug(`Offload ignorado (job=${job.id ?? '?'}): ${resultado.reason ?? 'sem motivo'}`);
      return;
    }
    if (resultado.uploaded || resultado.deletedLocal || resultado.failed) {
      const mb = Math.round(resultado.bytesUploaded / 1024 / 1024);
      this.logger.log(
        `Offload: ${resultado.uploaded} enviada(s) (${mb}MB), `
        + `${resultado.deletedLocal} liberada(s) do disco, ${resultado.failed} falha(s).`,
      );
    }
  }
}
