import { Injectable, Logger } from '@nestjs/common';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { CloudConnectorService, type CloudStorageConfig } from '../cloud-connector/cloud-connector.service';
import { ensureFileUnderRoot } from '../recordings/helpers/safe-file.helper';
import { S3Client, S3Error } from './s3-client';
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
// O modo `mount` não passa por aqui: lá o ffmpeg já escreve direto no bucket
// montado, e não há o que offloadar.
// ─────────────────────────────────────────────────────────────────────────────

/** Teto de arquivos por ciclo: evita monopolizar rede/CPU do host de gravação. */
const DEFAULT_BATCH = 25;

/**
 * Acima disto o upload vai em MÚLTIPLAS PARTES.
 *
 * O limite não é do protocolo (a AWS aceita 5GB num PUT), é de MEMÓRIA: um PUT
 * simples materializa o arquivo inteiro no processo — o mesmo que está gravando
 * as câmeras. 200MB é o ponto a partir do qual isso passa a incomodar.
 */
const MAX_SINGLE_PUT_BYTES = 200 * 1024 * 1024;

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

    const cfg = await this.cloudConnector.getCloudStorageConfig();
    if (!cfg) return { ...vazio, reason: 'sem storage em nuvem provisionado' };
    if (cfg.mode !== 'tier') return { ...vazio, reason: `modo ${cfg.mode} não usa offload` };

    this.running = true;
    try {
      const client = this.buildClient(cfg);
      const resultado = await this.uploadPending(client, cfg);
      const apagadas = await this.pruneUploaded(cfg);
      return { ...resultado, skipped: false, deletedLocal: apagadas };
    } finally {
      this.running = false;
    }
  }

  /** Sobe as gravações que ainda não têm objeto no bucket. */
  private async uploadPending(client: S3Client, cfg: CloudStorageConfig) {
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

    for (const rec of pendentes) {
      let caminho: string;
      try {
        caminho = ensureFileUnderRoot(this.recordingsRoot(), rec.filePath);
      } catch {
        // Caminho fora da raiz é dado inconsistente, não gravação a subir.
        failed += 1;
        continue;
      }

      let tamanho: number;
      try {
        tamanho = (await stat(caminho)).size;
      } catch {
        // Arquivo já não existe no disco: nada a subir. Não conta como falha —
        // é o caso normal de uma gravação que a retenção já removeu.
        continue;
      }

      if (tamanho <= 0) continue;

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
              { contentType: 'video/mp4' },
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
          failed += 1;
          continue;
        }

        await this.prisma.recording.update({
          where: { id: rec.id },
          data: { cloudKey: key, cloudUploadedAt: new Date() },
        });
        uploaded += 1;
        bytesUploaded += tamanho;
      } catch (error) {
        failed += 1;
        const detalhe = error instanceof S3Error ? `${error.code} (${error.status})` : String(error);
        this.logger.warn(`Falha ao subir gravação ${rec.id}: ${detalhe}`);
        // Sem marcação no banco, o próximo ciclo tenta de novo. É a
        // recuperação: nada fica "meio subido" do ponto de vista do sistema.
      }
    }

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
    const policy = await this.getPolicy();
    if (policy.keepLocalCopy) return 0;

    const corte = new Date(Date.now() - cfg.localWindowHours * 3600_000);
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
