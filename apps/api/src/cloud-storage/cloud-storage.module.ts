import { Module } from '@nestjs/common';
import { CloudConnectorModule } from '../cloud-connector/cloud-connector.module';
import { CloudOffloadService } from './cloud-offload.service';
import { CloudStorageController } from './cloud-storage.controller';

// Storage em nuvem da INSTALAÇÃO. A configuração vem provisionada pela Central
// (via heartbeat, tratado no CloudConnectorModule); aqui mora o que USA essa
// configuração: o offload das gravações e o resumo que a tela de Armazenamento
// exibe.
@Module({
  imports: [CloudConnectorModule],
  controllers: [CloudStorageController],
  providers: [CloudOffloadService],
  exports: [CloudOffloadService],
})
export class CloudStorageModule {}
