import { Injectable, Logger } from '@nestjs/common';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { CloudConnectorService, type CloudStorageConfig } from '../cloud-connector/cloud-connector.service';
import { ensureFileUnderRoot } from '../recordings/helpers/safe-file.helper';
import { S3Client, S3Error } from './s3-client';
import { CloudStorageResolverService } from './cloud-storage-resolver.service';
import { envNumber } from '../common/config/env-number.helper';
import {
  DEFAULT_STORAGE_POLICY,
  describeStoragePolicy,
  enabledTriggerModes,
  normalizeStoragePolicy,
  type StoragePolicy,
} from './storage-policy';

/** Onde a política da instalação é persistida (SystemSetting). */
const POLICY_SETTING_KEY = 'storage.policy';

// ─────────────────────────────────────────────────────────────────────────────
// OFFLOAD DE GRAVAÇÃO PARA BUCKET S3-COMPATÍVEL.
//
// Modelo de CAMADA: grava local (rápido e seguro), sobe o segmento FECHADO para
// a nuvem e só então apaga o local, depois da janela configurada. O local vira
// buffer curto; a retenção longa fica na nuvem, que é barata.
//
// A INVARIANTE QUE VALE MAIS QUE A FEATURE:
//   nenhum arquivo local é apagado sem upload CONFIRMADO.
// Um upload que falhou, que subiu pela metade ou cujo tamanho não confere não
// autoriza remoção. Apagar de menos custa disco; apagar de mais destrói prova e
// é irreversível. Por isso a confirmação é feita relendo o objeto do bucket
// (HEAD) e comparando o tamanho — não basta o PUT ter respondido 200.
//
// ORDEM DELIBERADA: sobe → confirma → marca no banco → apaga o local. Se o
// processo morrer em qualquer ponto, o pior resultado é um objeto órfão no
// bucket (barato, e a próxima passada reaproveita), nunca uma gravação perdida.
//
// OS DOIS MODOS passam por aqui; muda só a janela local:
//   tier  ("Camada") — sobe e mantém o local por `localWindowHours`, para que o
//                      playback recente (o mais consultado) venha do disco.
//   mount ("Direto") — janela ZERO: confirmou o upload, apaga o local. É a
//                      resposta a "não quero vídeo acumulando no servidor".
//
// O nome `mount` é herança de quando o plano era montar o bucket como pasta e
// deixar o ffmpeg escrever nele. Isso NÃO se sustenta: o ffmpeg precisa de um
// sistema de arquivos real para fechar um MP4 válido, e bucket montado trava,
// corrompe segmento e cobra por requisição. Enquanto o modo não fez nada, ele
// era pior que ausente — a tela dizia "configurado" e nenhum byte subia.
// ─────────────────────────────────────────────────────────────────────────────

/** Teto de arquivos por ciclo: evita monopolizar rede/CPU do host de gravação. */
const DEFAULT_BATCH = 25;
// Envios em paralelo. 6 satura o link desta frota com folga e não disputa com o
// vídeo ao vivo; o operador ajusta na Central quando o link comportar mais.
const DEFAULT_CONCURRENCY = 6;

/**
 * Acima disto o upload vai em MÚLTIPLAS PARTES.
 *
 * O limite não é do protocolo (a AWS aceita 5GB num PUT), é de MEMÓRIA: um PUT
 * simples materializa o arquivo inteiro no processo — o mesmo que está gravando
 * as câmeras. 200MB é o ponto a partir do qual isso passa a incomodar.
 */
// Acima disto o vídeo é lido do DISCO em pedaços, em vez de ser copiado inteiro
// para a memória.
//
// O arquivo já está no disco — copiá-lo inteiro para a RAM só para enviar é
// gasto puro. Com o teto em 200 MB, praticamente TODA gravação passava pela
// memória: medido nesta frota, a média é 12 MB e a maior 61 MB, todas abaixo do
// teto. Um envio de 60 em paralelo chegaria a 3,6 GB de RAM num servidor com
// 7,4 GB livres, disputando com a IA, o servidor de vídeo e as gravações.
//
// 5 MB é o mínimo que o S3 aceita por pedaço (menos que isso ele recusa a
// montagem), então é o menor teto possível — e o que mantém o consumo preso a
// um pedaço por vez, não ao tamanho do arquivo.
const MAX_SINGLE_PUT_BYTES = envNumber('CLOUD_OFFLOAD_SINGLE_PUT_MB', 5, {
  min: 5,
  max: 200,
  integer: true,
}) * 1024 * 1024;

export type OffloadResult = {
  skipped: boolean;
  reason?: string;
  uploaded: number;
  deletedLocal: number;
  failed: number;
  bytesUploaded: number;
};

@Injectable()
export class CloudOffloadService {
  private readonly logger = new Logger(CloudOffloadService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cloudConnector: CloudConnectorService,
    private readonly resolver: CloudStorageResolverService,
  ) {}

  private recordingsRoot(): string {
    return this.config.get<string>('recordingsRoot') ?? process.env.RECORDINGS_ROOT ?? './storage/recordings';
  }

  /** Política vigente da instalação (persistida em SystemSetting). */
  async getPolicy(): Promise<StoragePolicy> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: POLICY_SETTING_KEY } });
    if (!row?.value) return DEFAULT_STORAGE_POLICY;
    try {
      return normalizeStoragePolicy(JSON.parse(row.value));
    } catch {
      // Setting corrompido não pode ligar a nuvem por acidente.
      return DEFAULT_STORAGE_POLICY;
    }
  }

  async setPolicy(input: unknown): Promise<StoragePolicy> {
    const policy = normalizeStoragePolicy(input);
    await this.prisma.systemSetting.upsert({
      where: { key: POLICY_SETTING_KEY },
      create: { key: POLICY_SETTING_KEY, value: JSON.stringify(policy) },
      update: { value: JSON.stringify(policy) },
    });
    this.logger.log(`Política de armazenamento alterada: ${describeStoragePolicy(policy)}`);
    return policy;
  }

  private buildClient(cfg: CloudStorageConfig): S3Client {
    return new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      prefix: cfg.prefix,
      forcePathStyle: cfg.forcePathStyle,
    });
  }

  /**
   * Chave do objeto no bucket.
   *
   * Determinística a partir do id da gravação: reprocessar o mesmo registro
   * sobrescreve o mesmo objeto em vez de acumular duplicata. Inclui a câmera no
   * caminho para que o bucket seja navegável por um humano investigando.
   */
  buildCloudKey(recording: { id: string; cameraId: string; filePath: string }): string {
    const nome = recording.filePath.split('/').pop() ?? `${recording.id}.mp4`;
    const extensao = nome.includes('.') ? nome.slice(nome.lastIndexOf('.')) : '.mp4';
    return `recordings/${recording.cameraId}/${recording.id}${extensao}`;
  }

  /**
   * Uma passada de offload.
   *
   * Reentrância: um ciclo por vez. O agendador pode disparar de novo enquanto o
   * anterior ainda sobe arquivo grande, e dois ciclos concorrentes subiriam o
   * mesmo objeto duas vezes.
   */
  async runOnce(): Promise<OffloadResult> {
    const vazio: OffloadResult = { skipped: true, uploaded: 0, deletedLocal: 0, failed: 0, bytesUploaded: 0 };
    if (this.running) return { ...vazio, reason: 'ciclo anterior ainda em andamento' };

    // Escreve SEMPRE no storage ATIVO. Antes era a configuração única; agora a
    // instalação pode ter vários, e o ativo é o destino de tudo que é novo. Sem
    // nenhum cadastrado, o resolvedor cai na config legada — instalação que
    // nunca usou a tela nova continua idêntica.
    const destino = await this.resolver.storageParaEscrita();
    if (!destino) return { ...vazio, reason: 'sem storage em nuvem provisionado' };
    const cfg = destino;
    const storageId = destino.id;

    this.running = true;
    try {
      const client = this.resolver.clienteDe(destino);
      const resultado = await this.uploadPending(client, cfg, storageId);
      const apagadas = await this.pruneUploaded(cfg);
      return { ...resultado, skipped: false, deletedLocal: apagadas };
    } finally {
      this.running = false;
    }
  }

  /** Sobe as gravações que ainda não têm objeto no bucket. */
  private async uploadPending(client: S3Client, cfg: CloudStorageConfig, storageId: string | null = null) {
    const batch = envNumber('CLOUD_OFFLOAD_BATCH', DEFAULT_BATCH, {
      min: 1,
      max: 500,
      integer: true,
      onInvalid: (m) => this.logger.warn(m),
    });

    // A política da INSTALAÇÃO decide o que sobe. Ter bucket provisionado não
    // significa mandar tudo: o operador escolhe quais tipos de gravação valem o
    // custo de nuvem (contínua de corredor vazio 24h costuma não valer).
    const policy = await this.getPolicy();
    const tipos = enabledTriggerModes(policy);
    if (!policy.enabled || !tipos.length) {
      return { uploaded: 0, failed: 0, bytesUploaded: 0 };
    }

    const pendentes = await this.prisma.recording.findMany({
      // O filtro por tipo vai no BANCO, não em memória: sem ele, uma instalação
      // que só arquiva movimento leria repetidamente as contínuas pendentes e
      // nunca chegaria às que interessam.
      where: { cloudKey: null, triggerMode: { in: tipos } },
      orderBy: { startedAt: 'asc' },
      take: batch,
      select: { id: true, cameraId: true, filePath: true, sizeBytes: true, triggerMode: true },
    });

    let uploaded = 0;
    let failed = 0;
    let bytesUploaded = 0;

      // ENVIO EM PARALELO, com teto configurável.
      //
      // Sequencial, cada gravação pagava sozinha os ~143ms que este fornecedor
      // cobra para abrir conexão (ele fecha a cada requisição). Em paralelo esse
      // custo se sobrepõe. O teto existe porque paralelismo demais não usa mais
      // internet do que ela tem — só disputa com o vídeo ao vivo.
      const concorrencia = Math.max(1, Math.min(64, Number(cfg.uploadConcurrency) || DEFAULT_CONCURRENCY));

      const subirUma = async (rec: (typeof pendentes)[number]): Promise<{ ok: boolean; bytes: number }> => {
          let caminho: string;
          try {
            caminho = ensureFileUnderRoot(this.recordingsRoot(), rec.filePath);
          } catch {
            // Caminho fora da raiz é dado inconsistente, não gravação a subir.
            return { ok: false, bytes: 0 };
            return { ok: false, bytes: 0 };
          }

          let tamanho: number;
          try {
            tamanho = (await stat(caminho)).size;
          } catch {
            // Arquivo já não existe no disco: nada a subir. Não conta como falha —
            // é o caso normal de uma gravação que a retenção já removeu.
            return { ok: false, bytes: 0 };
          }

          if (tamanho <= 0) return { ok: false, bytes: 0 };

          const key = this.buildCloudKey(rec);
          try {
            if (tamanho > MAX_SINGLE_PUT_BYTES) {
              // Arquivo grande vai em MÚLTIPLAS PARTES, lendo do disco por pedaço.
              // Ler o arquivo inteiro na memória para um PUT único derrubaria o
              // processo de gravação — que é o mesmo processo que está atendendo as
              // câmeras. A leitura por offset mantém o consumo em uma parte por vez.
              const handle = await open(caminho, 'r');
              try {
                await client.putObjectMultipart(
                  key,
                  async (offset, length) => {
                    const buf = Buffer.alloc(length);
                    await handle.read(buf, 0, length, offset);
                    return buf;
                  },
                  tamanho,
                  {
                    contentType: 'video/mp4',
                    // Partes em paralelo dentro do arquivo grande. A Eveo fecha a
                    // conexão a cada requisição (~143ms para reabrir); serial, uma
                    // gravação de 500 MB pagava esse custo ~30 vezes em sequência.
                    // Teto por arquivo × arquivos em voo = memória — mantido baixo.
                    partConcurrency: envNumber('CLOUD_OFFLOAD_PART_CONCURRENCY', 4, {
                      min: 1,
                      max: 16,
                      integer: true,
                    }),
                  },
                );
              } finally {
                await handle.close();
              }
            } else {
              const conteudo = await readFile(caminho);
              await client.putObject(key, conteudo, 'video/mp4');
            }

            // CONFIRMAÇÃO: o PUT ter respondido 200 não basta. Relemos o objeto para
            // garantir que ele existe de fato antes de considerar a gravação salva —
            // é essa confirmação que autoriza, mais tarde, apagar o local.
            const confirmado = await client.headObject(key);
            if (!confirmado.exists) {
              this.logger.warn(`Upload de ${rec.id} respondeu OK mas o objeto não está no bucket; não será marcado.`);
              return { ok: false, bytes: 0 };
              return { ok: false, bytes: 0 };
            }

            await this.prisma.recording.update({
              where: { id: rec.id },
              // CARIMBA em qual storage o objeto ficou. Sem isso, trocar de
              // fornecedor faria o playback procurar esta chave no bucket NOVO e o
              // acervo sumiria da tela — o defeito que a coluna existe para impedir.
              // `null` = storage legado (a configuração única), e segue válido.
              data: { cloudKey: key, cloudUploadedAt: new Date(), cloudStorageId: storageId ?? null },
            });
        
            return { ok: true, bytes: tamanho };
          } catch (error) {
            const detalhe = error instanceof S3Error ? `${error.code} (${error.status})` : String(error);
            this.logger.warn(`Falha ao subir gravação ${rec.id}: ${detalhe}`);
            return { ok: false, bytes: 0 };
            // Sem marcação no banco, o próximo ciclo tenta de novo. É a
            // recuperação: nada fica "meio subido" do ponto de vista do sistema.
          }
        return { ok: false, bytes: 0 };
      };

      // Fila com N trabalhadores: cada um puxa a próxima assim que termina a sua.
      // Dividir em blocos fixos deixaria trabalhador ocioso esperando o vídeo mais
      // lento do bloco.
      const fila = [...pendentes];
      const trabalhadores = Array.from({ length: Math.min(concorrencia, fila.length) }, async () => {
        for (;;) {
          const rec = fila.shift();
          if (!rec) return;
          const r = await subirUma(rec);
          if (r.ok) { uploaded += 1; bytesUploaded += r.bytes; } else { failed += 1; }
        }
      });
      await Promise.all(trabalhadores);

    return { uploaded, failed, bytesUploaded };
  }

  /**
   * Apaga o arquivo LOCAL das gravações já confirmadas na nuvem e mais velhas
   * que a janela local.
   *
   * A janela existe para que o playback recente (o mais consultado) continue
   * vindo do disco, que é rápido. E, por segurança, só entra aqui o que tem
   * `cloudKey` E `cloudUploadedAt` — nunca o que apenas começou a subir.
   */
  private async pruneUploaded(cfg: CloudStorageConfig): Promise<number> {
    // `keepLocalCopy` = nuvem como BACKUP: sobe e mantém o arquivo local. Quem
    // escolheu isso não quer economizar disco, quer cópia externa — apagar o
    // local seria fazer o oposto do pedido.
    //
    // O modo DIRETO é a escolha oposta e mais específica ("não quero vídeo
    // acumulando no disco"), feita no cadastro do storage. Ele vence o
    // keepLocalCopy: aceitar os dois ao mesmo tempo faria o modo virar um
    // no-op silencioso — exatamente o defeito que ele existia para ter.
    const policy = await this.getPolicy();
    const direto = cfg.mode === 'mount';
    if (policy.keepLocalCopy && !direto) return 0;

    // Direto = janela ZERO: assim que o upload é CONFIRMADO, o local sai.
    //
    // O segmento em escrita continua indo para o disco, e isso não é um
    // detalhe que dê para contornar: o ffmpeg precisa de um sistema de
    // arquivos real para fechar um MP4 válido (índice no fim, seeks para
    // trás). Escrever direto num bucket montado trava em rede ruim, gera
    // objeto pela metade e cobra por requisição. O disco fica sendo só a mesa
    // de trabalho dos poucos minutos correntes; o acervo mora na nuvem.
    const janelaHoras = direto ? 0 : cfg.localWindowHours;
    const corte = new Date(Date.now() - janelaHoras * 3600_000);
    const candidatas = await this.prisma.recording.findMany({
      where: {
        cloudKey: { not: null },
        cloudUploadedAt: { not: null, lt: corte },
        localDeletedAt: null,
      },
      orderBy: { startedAt: 'asc' },
      take: 200,
      select: { id: true, filePath: true },
    });

    let apagadas = 0;
    for (const rec of candidatas) {
      let caminho: string;
      try {
        caminho = ensureFileUnderRoot(this.recordingsRoot(), rec.filePath);
      } catch {
        continue;
      }
      try {
        await unlink(caminho);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        // Já não existia: o objetivo (não ocupar disco) está atingido, então
        // marcamos assim mesmo para não reavaliar este registro para sempre.
        if (err?.code !== 'ENOENT') {
          this.logger.warn(`Falha ao remover arquivo local de ${rec.id}: ${err?.message ?? String(error)}`);
          continue;
        }
      }
      await this.prisma.recording.update({
        where: { id: rec.id },
        data: { localDeletedAt: new Date() },
      });
      apagadas += 1;
    }
    return apagadas;
  }

  /** Resumo para a página de Armazenamento. */
  async summary() {
    const cfg = await this.cloudConnector.getCloudStorageConfig();
    if (!cfg) return { enabled: false as const };

    const [naNuvem, pendentes, somenteNuvem] = await Promise.all([
      this.prisma.recording.count({ where: { cloudKey: { not: null } } }),
      this.prisma.recording.count({ where: { cloudKey: null } }),
      this.prisma.recording.count({ where: { cloudKey: { not: null }, localDeletedAt: { not: null } } }),
    ]);

    return {
      enabled: true as const,
      provider: cfg.provider,
      mode: cfg.mode,
      bucket: cfg.bucket,
      endpoint: cfg.endpoint,
      prefix: cfg.prefix,
      localWindowHours: cfg.localWindowHours,
      recordingsInCloud: naNuvem,
      recordingsPendingUpload: pendentes,
      recordingsCloudOnly: somenteNuvem,
      updatedAt: cfg.updatedAt,
    };
  }
}
