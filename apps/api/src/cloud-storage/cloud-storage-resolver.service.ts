import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
export class CloudStorageResolverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloudStorageResolverService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly cloudConnector: CloudConnectorService,
  ) {}

  /**
   * Reconcilia periodicamente, sem esperar a primeira gravação subir.
   *
   * Amarrar a reconciliação ao offload deixava um buraco perigoso: com o ENVIO
   * desligado (que é o padrão), nenhuma linha era criada — e a ancoragem do
   * acervo que JÁ está na nuvem nunca acontecia. Bastava trocar de fornecedor
   * nesse estado para as gravações antigas passarem a ser procuradas no bucket
   * novo. A janela existe entre a Central provisionar e alguém ligar o envio,
   * que pode ser meses.
   *
   * O intervalo é longo de propósito: a Central muda storage raramente, e o
   * caminho quente já reconcilia a cada upload.
   */
  onModuleInit(): void {
    const reconciliar = () => {
      void this.storageParaEscrita().catch(() => undefined);
    };
    reconciliar();
    this.timer = setInterval(reconciliar, 15 * 60 * 1000);
    // Sem `unref`, este timer segura o processo vivo e o container não desliga.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * O storage onde toda gravação NOVA é escrita.
   *
   * Quem MANDA é a configuração que a Central provisiona: ela é a fonte da
   * verdade de "qual storage está valendo". Antes de devolver, reconcilia essa
   * configuração com a tabela — é isso que faz a TROCA de fornecedor arquivar o
   * anterior em vez de apagá-lo do mapa.
   *
   * Sem storage provisionado, devolve `null` — nada novo sobe. Os storages
   * anteriores continuam na tabela e continuam LEGÍVEIS: desligar o envio não
   * pode sumir com o acervo já enviado.
   */
  async storageParaEscrita(): Promise<StorageResolvido | null> {
    const provisionado = await this.legado();
    if (provisionado) {
      const reconciliado = await this.reconciliar(provisionado).catch((error) => {
        // Reconciliar é conveniência; falhar aqui não pode parar o offload.
        this.logger.warn(`Não foi possível reconciliar o storage provisionado: ${String(error)}`);
        return null;
      });
      if (reconciliado) return reconciliado;
      return provisionado;
    }
    return this.semStorageProvisionado();
  }

  /**
   * O que fazer quando a Central não manda mais credencial.
   *
   * Antes isto caía no registro que ESTAVA ativo e continuava enviando para
   * ele — ou seja, excluir o storage na Central não parava nada. O registro só
   * é "o ativo" porque a Central um dia disse que era; quando ela para de
   * dizer, ele deixa de ser.
   *
   * A partir daí depende do MOTIVO:
   *
   *   disabled  — pausa. Nada sobe e nenhum outro storage assume, senão
   *               desligar não desligaria nada. As gravações ficam no disco
   *               local, e o que já subiu continua legível.
   *   absent    — o destino foi excluído. Se ainda houver outro storage
   *               cadastrado, ele assume; se não houver, fica só o disco local.
   *
   * Em nenhum dos dois o acervo é tocado: os registros permanecem na tabela e a
   * leitura continua resolvendo pelo storage de origem de cada gravação.
   */
  private async semStorageProvisionado(): Promise<StorageResolvido | null> {
    // `try` e não só `.catch`: um conector sem o método lança de forma SÍNCRONA,
    // e a promessa nem chega a existir para ter catch. O erro subiria até o
    // offload e derrubaria o envio inteiro por causa de um campo novo.
    let estado: string;
    try {
      estado = await this.cloudConnector.getCloudStorageState();
    } catch {
      estado = 'disabled';
    }
    const ativo = await this.prisma.cloudStorage.findFirst({ where: { isActive: true } }).catch(() => null);

    if (estado !== 'absent') {
      if (ativo) {
        await this.prisma.cloudStorage
          .updateMany({ where: { isActive: true }, data: { isActive: false } })
          .catch(() => undefined);
        this.logger.log(
          `Envio para a nuvem pausado; "${ativo.name}" deixou de receber gravações. O acervo dele continua legível.`,
        );
      }
      return null;
    }

    // Excluído: o mais recente entre os que sobraram assume. Mais recente, e não
    // o mais antigo, porque numa sequência de trocas é o penúltimo fornecedor
    // que ainda tem contrato vivo — o primeiro provavelmente já foi cancelado.
    const candidato = await this.prisma.cloudStorage
      .findFirst({ orderBy: { createdAt: 'desc' } })
      .catch(() => null);
    if (!candidato) {
      if (ativo) {
        await this.prisma.cloudStorage
          .updateMany({ where: { isActive: true }, data: { isActive: false } })
          .catch(() => undefined);
      }
      this.logger.log('Armazenamento em nuvem excluído e não há outro cadastrado; as gravações ficam no disco local.');
      return null;
    }

    const resolvido = this.materializar(candidato);
    if (!resolvido) {
      // Candidato com credencial ilegível não pode virar destino: o upload
      // falharia em laço e ninguém saberia por quê.
      this.logger.warn(
        `Armazenamento excluído; o storage "${candidato.name}" assumiria, mas a credencial dele não abre. ` +
          'As gravações ficam no disco local.',
      );
      return null;
    }

    if (!candidato.isActive) {
      await this.prisma
        .$transaction(async (tx) => {
          await tx.cloudStorage.updateMany({ where: { isActive: true }, data: { isActive: false } });
          await tx.cloudStorage.update({ where: { id: candidato.id }, data: { isActive: true } });
        })
        .catch(() => undefined);
      this.logger.log(
        `Armazenamento excluído na Central; "${candidato.name}" (${candidato.bucket}) passou a receber as gravações.`,
      );
    }
    return resolvido;
  }

  /**
   * Garante que a configuração provisionada tenha uma linha na tabela, ATIVA, e
   * que qualquer outra deixe de ser ativa.
   *
   * A identidade de um storage é `endpoint|bucket|prefixo` — o ENDEREÇO dos
   * objetos. Deliberadamente NÃO inclui a credencial: rotacionar a chave de
   * acesso do mesmo bucket é operação de rotina e não pode ser confundida com
   * "mudou de fornecedor", que arquivaria o storage e criaria um segundo
   * cadastro apontando para o mesmo lugar — duas linhas disputando os mesmos
   * objetos, e a varredura de órfãos apagando o que a outra ainda usa.
   */
  /**
   * Devolve o storage da tabela com a OPERAÇÃO que o operador escolheu.
   *
   * `materializar` monta a linha do banco, que guarda endereço e credencial —
   * não guarda `mode` nem `localWindowHours`, porque essas são decisões de
   * operação e vivem na configuração provisionada. Sem reaplicá-las aqui, o
   * offload lia sempre `tier`/24h: o operador escolhia "Direto — apaga o local
   * assim que confirma o envio", nada era liberado, e o disco enchia sem que
   * nenhum log apontasse a causa. Custou o disco chegar a 95% com o guardião
   * interrompendo gravação.
   */
  private comOperacao(linha: StorageResolvido | null, config: StorageResolvido): StorageResolvido | null {
    if (!linha) return null;
    return { ...linha, mode: config.mode, localWindowHours: config.localWindowHours, uploadConcurrency: config.uploadConcurrency };
  }

  private async reconciliar(config: StorageResolvido): Promise<StorageResolvido | null> {
    const endereco = {
      endpoint: config.endpoint,
      bucket: config.bucket,
      prefix: config.prefix ?? '',
    };
    const existente = await this.prisma.cloudStorage.findFirst({ where: endereco });

    const nomeDesejado = config.name || config.bucket;
    if (existente?.isActive && existente.accessKeyId === config.accessKeyId) {
      // Caminho quente: o ENDEREÇO e a Access Key são os mesmos. É o que roda a
      // cada gravação enviada, então não escreve à toa — mas duas coisas ainda
      // podem ter mudado e PRECISAM chegar aqui.
      //
      // O SEGREDO é a que dói. Comparar só endereço e Access Key fazia a rotação
      // de credencial nunca alcançar a tabela: o operador corrigia a chave na
      // Central, a Central passava a mandar a nova, e o offload continuava
      // assinando com a velha. Custou 16 horas e 2.286 gravações paradas, com o
      // único sintoma sendo `SignatureDoesNotMatch` num log de aviso.
      //
      // A comparação é sobre o texto em claro: AES-GCM usa nonce novo a cada
      // cifragem, então dois cifrados do MESMO segredo são diferentes byte a
      // byte — comparar os cifrados reescreveria a linha em toda passagem.
      let segredoAtual: string | null = null;
      try {
        segredoAtual = this.crypto.decrypt(existente.secretAccessKeyEncrypted);
      } catch {
        // Ilegível conta como diferente: reescrever conserta a linha.
        segredoAtual = null;
      }
      const precisaTrocarSegredo = segredoAtual !== config.secretAccessKey;
      const precisaTrocarNome = existente.name !== nomeDesejado;

      if (precisaTrocarSegredo || precisaTrocarNome) {
        const dadosNovos = {
          ...(precisaTrocarNome ? { name: nomeDesejado } : {}),
          ...(precisaTrocarSegredo ? { secretAccessKeyEncrypted: this.crypto.encrypt(config.secretAccessKey) } : {}),
        };
        await this.prisma.cloudStorage
          .update({ where: { id: existente.id }, data: dadosNovos })
          .catch(() => undefined);
        if (precisaTrocarSegredo) {
          this.logger.log(`Credencial do storage "${nomeDesejado}" atualizada a partir da Central.`);
        }
        return this.comOperacao(this.materializar({ ...existente, ...dadosNovos } as typeof existente), config);
      }
      return this.comOperacao(this.materializar(existente), config);
    }

    const dados = {
      ...endereco,
      name: nomeDesejado,
      provider: config.provider || 's3',
      region: config.region || 'us-east-1',
      accessKeyId: config.accessKeyId,
      secretAccessKeyEncrypted: this.crypto.encrypt(config.secretAccessKey),
      forcePathStyle: config.forcePathStyle !== false,
    };

    // Primeiro cadastro da instalação: as gravações que já existem moram AQUI,
    // porque até agora só havia um storage. Ancorá-las agora é a única chance —
    // depois de uma troca de fornecedor ninguém mais sabe dizer onde estavam, e
    // elas seriam procuradas no bucket novo (o defeito que esta classe existe
    // para impedir).
    const primeiroCadastro = (await this.prisma.cloudStorage.count()) === 0;

    // Desativar ANTES de ativar: o índice único parcial recusa dois ativos, e a
    // ordem inversa falharia deixando o storage novo sem receber nada.
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.cloudStorage.updateMany({ where: { isActive: true }, data: { isActive: false } });
      let alvo: string;
      if (existente) {
        await tx.cloudStorage.update({ where: { id: existente.id }, data: { ...dados, isActive: true } });
        alvo = existente.id;
      } else {
        const criado = await tx.cloudStorage.create({ data: { ...dados, isActive: true } });
        alvo = criado.id;
      }
      if (primeiroCadastro) {
        const ancoradas = await tx.recording.updateMany({
          where: { cloudStorageId: null, cloudKey: { not: null } },
          data: { cloudStorageId: alvo },
        });
        if (ancoradas.count > 0) {
          this.logger.log(`${ancoradas.count} gravações já na nuvem foram ancoradas ao storage "${dados.name}".`);
        }
      }
      return alvo;
    });

    const linha = await this.prisma.cloudStorage.findUnique({ where: { id } });
    if (!linha) return null;
    if (!existente) {
      this.logger.log(
        `Storage "${linha.name}" (${linha.bucket}) passou a receber as gravações; os anteriores viram somente-leitura.`,
      );
    }
    return this.comOperacao(this.materializar(linha), config);
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

  /** Público porque a tela de administração precisa saber se a credencial abre. */
  materializar(registro: {
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
      // Padrões seguros para storage ARQUIVADO: ele é somente-leitura, e nada
      // aqui decide apagar arquivo. Para o storage ATIVO, o modo e a janela
      // reais vêm da configuração provisionada — veja `comOperacao`.
      mode: 'tier',
      uploadConcurrency: 6,
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
    // O NOME vem da Central. Fixar 'Storage principal' aqui fazia todos os
    // storages nascerem com o mesmo rótulo: depois de uma troca, o antigo e o
    // novo ficavam lado a lado idênticos na tela, e o operador concluía que a
    // exclusão não tinha funcionado.
    return { ...cfg, id: null, name: cfg.name || 'Storage principal' };
  }
}
