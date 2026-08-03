import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { CloudConnectorService, type CloudStorageConfig } from '../cloud-connector/cloud-connector.service';
import { S3Client } from './s3-client';

// ── DE QUAL STORAGE VEM CADA GRAVAÇÃO ───────────────────────────────────────
//
// O problema que isto resolve: até aqui existia UMA configuração de storage, e
// a gravação guardava só `cloudKey` — sem registrar em qual bucket o objeto
// está. Trocar de fornecedor apontava o playback para o bucket novo procurando
// chaves do antigo, e o acervo inteiro sumia da tela. Os dados continuavam lá,
// inacessíveis, e a retenção também deixava de alcançá-los.
//
// É o caso real do cliente que contrata 1 TB, cresce, e migra para 10 TB de
// outro fornecedor sem querer perder o histórico.
//
// A regra passa a ser:
//   · ESCRITA sempre no storage ATIVO (`storageParaEscrita`);
//   · LEITURA no storage DE ORIGEM da gravação (`storageDaGravacao`).
//
// Assim o antigo vira somente-leitura e se esvazia sozinho conforme a retenção
// vence — sem copiar terabytes entre provedores nem janela de indisponibilidade.
//
// COMPATIBILIDADE: `cloudStorageId` nulo significa "storage legado", a
// configuração única que já existia. Instalações anteriores a esta mudança não
// precisam de backfill e continuam funcionando byte a byte.

/** Storage resolvido, já com credencial em claro e pronto para virar cliente. */
export type StorageResolvido = CloudStorageConfig & { id: string | null; name: string };

@Injectable()
export class CloudStorageResolverService {
  private readonly logger = new Logger(CloudStorageResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly cloudConnector: CloudConnectorService,
  ) {}

  /**
   * O storage onde toda gravação NOVA é escrita.
   *
   * Prefere o cadastrado como ativo; se não houver nenhum, cai na configuração
   * legada — que é o estado de toda instalação que ainda não cadastrou storages
   * pela tela nova.
   */
  async storageParaEscrita(): Promise<StorageResolvido | null> {
    const ativo = await this.prisma.cloudStorage
      .findFirst({ where: { isActive: true } })
      .catch(() => null);
    if (ativo) return this.materializar(ativo);
    return this.legado();
  }

  /**
   * O storage de ONDE esta gravação deve ser lida (ou apagada).
   *
   * Nunca usa o ativo por conveniência: uma gravação feita no bucket antigo
   * continua morando lá, e procurá-la no novo é exatamente o defeito que esta
   * classe existe para impedir.
   */
  async storageDaGravacao(cloudStorageId: string | null | undefined): Promise<StorageResolvido | null> {
    if (!cloudStorageId) return this.legado();
    const registro = await this.prisma.cloudStorage
      .findUnique({ where: { id: cloudStorageId } })
      .catch(() => null);
    if (!registro) {
      // O cadastro do storage foi apagado, mas a gravação continua apontando
      // para ele. Não caímos no ativo em silêncio: buscar no bucket errado
      // devolveria "não encontrado" e pareceria arquivo corrompido.
      this.logger.warn(
        `Gravação aponta para um storage que não existe mais (${cloudStorageId}); o objeto não será alcançado.`,
      );
      return null;
    }
    return this.materializar(registro);
  }

  /**
   * TODOS os storages da instalação, para tarefas que precisam varrer o acervo
   * inteiro — como a limpeza de órfãos.
   *
   * Varrer só o ativo seria pior que não varrer: numa migração é justamente o
   * storage ANTIGO que acumula órfãos e precisa esvaziar, enquanto o novo mal
   * começou a receber. Inclui o legado para instalações que ainda não cadastraram
   * nenhum pela tela.
   */
  async todosOsStorages(): Promise<StorageResolvido[]> {
    const registros = await this.prisma.cloudStorage.findMany().catch(() => []);
    const resolvidos = registros
      .map((r) => this.materializar(r))
      .filter((r): r is StorageResolvido => r !== null);
    if (resolvidos.length > 0) return resolvidos;
    const legado = await this.legado();
    return legado ? [legado] : [];
  }

  /** Monta o cliente S3 de um storage já resolvido. */
  clienteDe(storage: StorageResolvido): S3Client {
    return new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      bucket: storage.bucket,
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
      prefix: storage.prefix,
      forcePathStyle: storage.forcePathStyle,
    });
  }

  private materializar(registro: {
    id: string; name: string; provider: string; endpoint: string; region: string;
    bucket: string; prefix: string; accessKeyId: string; secretAccessKeyEncrypted: string;
    forcePathStyle: boolean; updatedAt: Date;
  }): StorageResolvido | null {
    let secret: string;
    try {
      secret = this.crypto.decrypt(registro.secretAccessKeyEncrypted);
    } catch {
      // Credencial ilegível (chave mestra trocada) não pode virar cliente com
      // segredo vazio: falharia no S3 com um erro de autenticação confuso.
      this.logger.warn(`Credencial do storage "${registro.name}" não pôde ser decifrada.`);
      return null;
    }
    return {
      id: registro.id,
      name: registro.name,
      enabled: true,
      mode: 'tier',
      provider: registro.provider,
      endpoint: registro.endpoint,
      region: registro.region,
      bucket: registro.bucket,
      prefix: registro.prefix,
      accessKeyId: registro.accessKeyId,
      secretAccessKey: secret,
      localWindowHours: 24,
      forcePathStyle: registro.forcePathStyle,
      updatedAt: registro.updatedAt.toISOString(),
    };
  }

  /** A configuração única que existia antes desta funcionalidade. */
  private async legado(): Promise<StorageResolvido | null> {
    const cfg = await this.cloudConnector.getCloudStorageConfig().catch(() => null);
    if (!cfg?.enabled) return null;
    return { ...cfg, id: null, name: 'Storage principal' };
  }
}
