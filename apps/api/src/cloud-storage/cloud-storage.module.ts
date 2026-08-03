import { CloudStorageResolverService } from './cloud-storage-resolver.service';
import { CloudStorageAdminService } from './cloud-storage-admin.service';
import { Module } from '@nestjs/common';
import { CryptoService } from '../common/crypto/crypto.service';
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
  // CryptoService: o resolvedor decifra o segredo de cada storage cadastrado,
  // com a mesma chave mestra das senhas de câmera.
  providers: [CloudStorageResolverService, CloudStorageAdminService, CloudOffloadService, CryptoService],
  exports: [CloudStorageResolverService, CloudOffloadService],
})
export class CloudStorageModule {}
