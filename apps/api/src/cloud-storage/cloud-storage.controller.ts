import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { CloudOffloadService } from './cloud-offload.service';
import { CloudStorageAdminService } from './cloud-storage-admin.service';
import { StorageBenchmarkService } from './storage-benchmark.service';

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
  constructor(
    private readonly offload: CloudOffloadService,
    private readonly admin: CloudStorageAdminService,
    private readonly benchmark: StorageBenchmarkService,
  ) {}

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

  // ── Storages: o ativo e os anteriores ──────────────────────────────────────
  //
  // Trocar o storage na Central não apaga o anterior: ele fica aqui como
  // somente-leitura, com o acervo ainda acessível, e some sozinho conforme a
  // retenção vence. Estas rotas existem para quem não quer esperar.

  @Roles(UserRole.ADMIN)
  @Get('storages')
  listStorages() {
    return this.admin.listar();
  }

  /**
   * ESVAZIA o bucket: apaga os objetos lá no fornecedor. Irreversível.
   *
   * POST e não DELETE porque exige corpo (a confirmação com o nome do bucket) e
   * porque não é a remoção de um recurso — o cadastro continua existindo, vazio.
   */
  @Roles(UserRole.ADMIN)
  @Post('storages/:id/purge')
  purgeStorage(@Param('id') id: string, @Body() body: { confirmacao?: string }) {
    return this.admin.esvaziar(id, String(body?.confirmacao ?? ''));
  }

  /**
   * MEDE o desempenho do storage a partir DESTA instalação.
   *
   * Aqui e não na Central de propósito: o que interessa é o caminho que o vídeo
   * percorre de verdade. POST porque não é leitura — sobe e baixa alguns MB,
   * consome banda e gera requisições cobradas.
   */
  @Roles(UserRole.ADMIN)
  @Post('storages/:id/benchmark')
  benchmarkStorage(@Param('id') id: string, @Body() body: { tamanhoMb?: number }) {
    return this.benchmark.medir(id, Number(body?.tamanhoMb) || undefined);
  }

  /** Remove só o CADASTRO. Nenhum objeto é tocado no fornecedor. */
  @Roles(UserRole.ADMIN)
  @Delete('storages/:id')
  removeStorage(@Param('id') id: string, @Query('forcar') forcar?: string) {
    return this.admin.remover(id, forcar === 'true' || forcar === '1');
  }
}
