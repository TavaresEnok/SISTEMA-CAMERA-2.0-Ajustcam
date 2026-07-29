import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { CloudOffloadService } from './cloud-offload.service';

// Estado do storage em nuvem DESTA instalação.
//
// Só ADMIN: o resumo revela endpoint e bucket do contrato — informação de
// infraestrutura do cliente, não de operação diária. E o disparo manual do
// offload consome rede do host de gravação.
//
// A CONFIGURAÇÃO não é editável aqui de propósito: quem provisiona é a Central.
// Ter dois lugares para configurar a mesma coisa geraria divergência, e o
// heartbeat sobrescreveria a edição local no ciclo seguinte.
@Controller('cloud-storage')
export class CloudStorageController {
  constructor(private readonly offload: CloudOffloadService) {}

  @Roles(UserRole.ADMIN)
  @Get('status')
  status() {
    return this.offload.summary();
  }

  @Roles(UserRole.ADMIN)
  @Post('offload/run')
  runOffload() {
    return this.offload.runOnce();
  }

  // A POLÍTICA é editável AQUI, não na Central: a Central provisiona o bucket
  // (infraestrutura, contratada pelo revendedor); quem decide o que mandar para
  // lá é quem opera a câmera. Ter storage configurado não pode significar que
  // tudo passa a subir automaticamente — isso geraria custo sem ninguém pedir.
  @Roles(UserRole.ADMIN)
  @Get('policy')
  getPolicy() {
    return this.offload.getPolicy();
  }

  @Roles(UserRole.ADMIN)
  @Put('policy')
  setPolicy(@Body() body: unknown) {
    return this.offload.setPolicy((body as { policy?: unknown })?.policy ?? body);
  }
}
