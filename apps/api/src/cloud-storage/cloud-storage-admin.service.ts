import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CloudStorageResolverService } from './cloud-storage-resolver.service';

// ── ADMINISTRAR OS STORAGES DE UMA INSTALAÇÃO ────────────────────────────────
//
// Duas operações que parecem a mesma e NÃO são. Confundi-las é como se perde
// prova, então elas nunca compartilham botão nem endpoint:
//
//   ESVAZIAR  — apaga os OBJETOS lá no fornecedor. O acervo daquele storage
//               deixa de existir. Irreversível. É o que se faz para parar de
//               pagar por um bucket que já não se usa.
//
//   REMOVER   — apaga só o CADASTRO aqui. Os objetos continuam intactos no
//               fornecedor. É o que se faz depois de esvaziar, ou quando o
//               bucket vai ser reaproveitado por outro sistema.
//
// Remover sem esvaziar deixa objetos pagos que ninguém mais alcança; esvaziar
// sem querer destrói gravação. Por isso as duas exigem confirmação explícita e
// as duas dizem, ANTES, exatamente quantas gravações estão em jogo.

/** Storage com o peso do que há nele, para a tela decidir o que mostrar. */
export type StorageComUso = {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  provider: string;
  isActive: boolean;
  credencialLegivel: boolean;
  gravacoes: number;
  bytes: number;
  maisAntiga: Date | null;
  maisRecente: Date | null;
};

export type ResultadoEsvaziamento = {
  objetosApagados: number;
  bytesLiberados: number;
  gravacoesAfetadas: number;
  falhas: number;
};

@Injectable()
export class CloudStorageAdminService {
  private readonly logger = new Logger(CloudStorageAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: CloudStorageResolverService,
  ) {}

  /**
   * Os storages da instalação, com quanto acervo há em cada um.
   *
   * O peso vem da NOSSA tabela, não de um LIST no bucket: listar milhões de
   * objetos a cada abertura de tela custaria caro e demoraria — e a pergunta
   * que o operador faz ("posso apagar isto?") é sobre as gravações que o DRAC
   * conhece, não sobre o que mais existe no bucket.
   */
  async listar(): Promise<StorageComUso[]> {
    const linhas = await this.prisma.cloudStorage.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });

    const uso = await this.prisma.recording.groupBy({
      by: ['cloudStorageId'],
      where: { cloudKey: { not: null } },
      _count: { _all: true },
      _sum: { sizeBytes: true },
      _min: { startedAt: true },
      _max: { startedAt: true },
    });
    const porId = new Map(uso.map((u) => [u.cloudStorageId, u]));

    return linhas.map((linha) => {
      const u = porId.get(linha.id);
      return {
        id: linha.id,
        name: linha.name,
        endpoint: linha.endpoint,
        bucket: linha.bucket,
        prefix: linha.prefix,
        provider: linha.provider,
        isActive: linha.isActive,
        // A tela precisa saber ANTES de oferecer "esvaziar": sem credencial
        // legível não há como apagar nada lá, e o botão só produziria erro.
        credencialLegivel: this.resolver.materializar(linha) !== null,
        gravacoes: u?._count._all ?? 0,
        bytes: Number(u?._sum.sizeBytes ?? 0),
        maisAntiga: u?._min.startedAt ?? null,
        maisRecente: u?._max.startedAt ?? null,
      };
    });
  }

  /**
   * APAGA OS OBJETOS de um storage. Irreversível.
   *
   * Recusa o storage ATIVO: ele está recebendo gravação neste instante, e
   * apagar embaixo do offload em curso produziria arquivo pela metade e
   * gravação apontando para o vazio. Para esvaziar o ativo, troque o storage
   * primeiro — ele vira anterior e aí pode ser esvaziado.
   *
   * `confirmacao` tem de ser o nome do bucket. Não é burocracia: é a diferença
   * entre um clique errado e uma frase que ninguém digita sem ler.
   */
  async esvaziar(id: string, confirmacao: string): Promise<ResultadoEsvaziamento> {
    const linha = await this.prisma.cloudStorage.findUnique({ where: { id } });
    if (!linha) throw new NotFoundException('Storage não encontrado.');
    if (linha.isActive) {
      throw new BadRequestException(
        'Este storage está recebendo as gravações agora. Troque o storage da instalação antes de esvaziá-lo.',
      );
    }
    if (confirmacao !== linha.bucket) {
      throw new BadRequestException(`Para confirmar, informe o nome do bucket: "${linha.bucket}".`);
    }

    const storage = this.resolver.materializar(linha);
    if (!storage) {
      throw new BadRequestException(
        'A credencial deste storage não pôde ser decifrada, então não há como apagar nada nele. Cadastre-a novamente antes.',
      );
    }
    const cliente = this.resolver.clienteDe(storage);

    let objetosApagados = 0;
    let bytesLiberados = 0;
    let falhas = 0;
    let token: string | null = null;

    // Paginação de verdade: sem o token de continuação a varredura pararia nas
    // primeiras 1000 chaves e relataria "esvaziado" com o bucket cheio.
    do {
      const pagina = await cliente.listObjectsPage('', token);
      for (const objeto of pagina.objects) {
        try {
          await cliente.deleteObject(objeto.key);
          objetosApagados += 1;
          bytesLiberados += objeto.size;
        } catch (error) {
          // Uma chave que resiste não pode abortar o resto: o operador ficaria
          // com o bucket parcialmente limpo e sem saber quanto sobrou.
          falhas += 1;
          this.logger.warn(`Falha ao apagar ${objeto.key} em ${linha.bucket}: ${String(error)}`);
        }
      }
      token = pagina.nextToken;
    } while (token);

    // As gravações que moravam lá deixam de ter cópia na nuvem. A LINHA
    // sobrevive: se ainda houver arquivo local, a gravação continua tocando; se
    // não houver, ela aparece como indisponível — que é a verdade. Apagar a
    // linha aqui esconderia do operador que o acervo existiu.
    const afetadas = await this.prisma.recording.updateMany({
      where: { cloudStorageId: id },
      data: { cloudKey: null, cloudUploadedAt: null },
    });

    this.logger.warn(
      `Storage "${linha.name}" (${linha.bucket}) ESVAZIADO: ${objetosApagados} objetos, ` +
        `${afetadas.count} gravações perderam a cópia na nuvem${falhas ? `, ${falhas} falhas` : ''}.`,
    );

    return { objetosApagados, bytesLiberados, gravacoesAfetadas: afetadas.count, falhas };
  }

  /**
   * Remove o CADASTRO. Não toca em nenhum objeto no fornecedor.
   *
   * Recusa por padrão quando ainda há gravação apontando para lá: sem o
   * cadastro não há credencial, e sem credencial aquele acervo fica
   * inalcançável — o operador descobriria só ao tentar assistir. `forcar`
   * existe para o caso legítimo (o bucket foi desativado do lado do
   * fornecedor), e aí o estrago é escolhido, não sofrido.
   */
  async remover(id: string, forcar = false): Promise<{ gravacoesOrfas: number }> {
    const linha = await this.prisma.cloudStorage.findUnique({ where: { id } });
    if (!linha) throw new NotFoundException('Storage não encontrado.');
    if (linha.isActive) {
      throw new BadRequestException(
        'Este storage está recebendo as gravações agora. Troque o storage da instalação antes de removê-lo.',
      );
    }

    const pendentes = await this.prisma.recording.count({ where: { cloudStorageId: id, cloudKey: { not: null } } });
    if (pendentes > 0 && !forcar) {
      throw new BadRequestException(
        `Ainda há ${pendentes} gravações neste storage. Esvazie-o primeiro, ou confirme que o acervo ficará inalcançável.`,
      );
    }

    // `ON DELETE SET NULL` no banco: as gravações não somem junto, ficam
    // apontando para o legado. Perder a prova junto com a configuração seria
    // muito pior que perder o endereço dela.
    await this.prisma.cloudStorage.delete({ where: { id } });
    this.logger.warn(
      `Cadastro do storage "${linha.name}" (${linha.bucket}) removido` +
        (pendentes > 0 ? `; ${pendentes} gravações ficaram sem destino conhecido.` : '.'),
    );
    return { gravacoesOrfas: pendentes };
  }
}
