import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { CloudStorageResolverService } from './cloud-storage-resolver.service';
import {
  camerasSuportadas,
  classificarLatencia,
  instavel,
  mediana,
  percentil,
  throughputMbps,
} from './helpers/benchmark-stats.helper';

// ── DESEMPENHO DO STORAGE, MEDIDO DE ONDE O VÍDEO SOBE ───────────────────────
//
// A medição roda na INSTALAÇÃO, não na Central. É deliberado: o que interessa é
// o caminho que o vídeo percorre de verdade — o link do cliente até o bucket.
// Medir da Central responderia outra pergunta (o link da Central até o bucket)
// e daria um número bonito que não se realiza em produção.
//
// O QUE SE MEDE, e por que cada um:
//
//   latência     tempo de ida e volta de uma operação pequena. É o pedágio que
//                CADA objeto paga; com muitas câmeras, é ele que forma fila.
//   subida       a que importa: se for menor que o total que as câmeras
//                produzem, a fila cresce para sempre e o disco local enche.
//   descida      o que o operador sente ao abrir uma gravação já enviada.
//   operações/s  o análogo de IOPS aqui. Storage de objeto NÃO tem IOPS: não há
//                disco exposto, não há fila de bloco. Inventar o número seria
//                mentir com aparência técnica; o que existe é quantas operações
//                pequenas o serviço aceita por segundo.
//
// CUSTA DINHEIRO E BANDA: sobe e baixa alguns MB e faz ~20 requisições. Por isso
// é um botão, nunca algo automático.

const PREFIXO_TESTE = '__drac_perf__';
const AMOSTRAS_LATENCIA = 7;
const OPERACOES_PEQUENAS = 10;
const TAMANHO_PADRAO_MB = 8;
const TAMANHO_MAXIMO_MB = 64;
// Abaixo disto a transferência não sai do TCP slow-start e o número medido é o
// tempo de estabelecer a conexão, não a banda. Foi o que aconteceu num link
// rápido: 4 MB em 0,08s viraram "414 Mb/s" — ruído, não capacidade sustentada.
const DURACAO_MINIMA_CONFIAVEL_MS = 1500;

export type MedicaoDesempenho = {
  storageId: string;
  nome: string;
  bucket: string;
  endpoint: string;
  medidoEm: string;
  amostraMb: number;
  latencia: { medianaMs: number; p95Ms: number; minMs: number; maxMs: number; amostras: number; classe: string };
  subida: { mbps: number; segundos: number };
  descida: { mbps: number; segundos: number };
  operacoesPorSegundo: number;
  camerasSuportadas: number;
  falhas: number;
  observacoes: string[];
};

@Injectable()
export class StorageBenchmarkService {
  private readonly logger = new Logger(StorageBenchmarkService.name);
  // Uma medição por vez: duas em paralelo disputariam a mesma banda e as duas
  // relatariam metade da velocidade real. O resultado errado seria consistente
  // e ninguém desconfiaria.
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: CloudStorageResolverService,
  ) {}

  async medir(storageId: string, tamanhoMb?: number): Promise<MedicaoDesempenho> {
    if (this.rodando) {
      throw new BadRequestException('Já há uma medição em andamento. Duas ao mesmo tempo dividiriam a banda e mediriam errado.');
    }

    const linha = await this.prisma.cloudStorage.findUnique({ where: { id: storageId } });
    if (!linha) throw new NotFoundException('Storage não encontrado.');

    const storage = this.resolver.materializar(linha);
    if (!storage) {
      throw new BadRequestException('A credencial deste storage não pôde ser decifrada; não há como medir nada nele.');
    }

    // Teto de 64 MB: acima disso o custo do teste começa a competir com o envio
    // real das gravações. Tamanho informado pelo operador é respeitado sem
    // ajuste — quem escolheu sabe o que quer medir.
    const tamanhoExplicito = Number.isFinite(tamanhoMb) && Number(tamanhoMb) > 0;
    const mb = Math.min(TAMANHO_MAXIMO_MB, Math.max(1, Math.round(Number(tamanhoMb)) || TAMANHO_PADRAO_MB));
    const cliente = this.resolver.clienteDe(storage);
    const criadas: string[] = [];
    const observacoes: string[] = [];
    let falhas = 0;

    this.rodando = true;
    try {
      // Conteúdo ALEATÓRIO, nunca zeros: alguns storages e proxies comprimem, e
      // um bloco de zeros mediria a compressão, não a rede — devolvendo uma
      // banda fantástica que nenhum vídeo real alcança.
      const subir = async (bytes: Buffer, chave: string) => {
        const inicio = Date.now();
        await cliente.putObject(chave, bytes, 'application/octet-stream');
        criadas.push(chave);
        return Date.now() - inicio;
      };

      let carga = randomBytes(mb * 1024 * 1024);
      let chaveGrande = `${PREFIXO_TESTE}/${Date.now()}-${randomBytes(4).toString('hex')}.bin`;
      let msSubida = await subir(carga, chaveGrande);
      let mbEfetivo = mb;

      // AJUSTE À VELOCIDADE DO LINK. Uma amostra fixa mede bem um link lento e
      // mente num rápido: se a transferência acaba antes do TCP acelerar, o que
      // se cronometrou foi a conexão. Aqui, quando a primeira sobe rápido demais,
      // o tamanho necessário é extrapolado e a medição refeita UMA vez — no
      // máximo duas subidas, para não gastar banda e requisição do cliente à toa.
      if (!tamanhoExplicito && msSubida < DURACAO_MINIMA_CONFIAVEL_MS && mb < TAMANHO_MAXIMO_MB) {
        const proporcao = DURACAO_MINIMA_CONFIAVEL_MS / Math.max(1, msSubida);
        const alvo = Math.min(TAMANHO_MAXIMO_MB, Math.ceil(mb * proporcao));
        if (alvo > mb) {
          observacoes.push(
            `A primeira amostra de ${mb} MB subiu em ${(msSubida / 1000).toFixed(2)}s — rápido demais para ser confiável. ` +
              `Repetido com ${alvo} MB.`,
          );
          carga = randomBytes(alvo * 1024 * 1024);
          chaveGrande = `${PREFIXO_TESTE}/${Date.now()}-${randomBytes(4).toString('hex')}.bin`;
          msSubida = await subir(carga, chaveGrande);
          mbEfetivo = alvo;
        }
      }

      const t1 = Date.now();
      const baixado = await cliente.getObject(chaveGrande);
      const msDescida = Date.now() - t1;
      if (baixado.length !== carga.length) {
        observacoes.push(`O objeto voltou com ${baixado.length} bytes em vez de ${carga.length} — a medição de descida não é confiável.`);
        falhas += 1;
      }

      // Latência: HEAD é a operação mais barata que ainda percorre autenticação
      // e roteamento inteiros — o pedágio real de cada objeto.
      const amostras: number[] = [];
      for (let i = 0; i < AMOSTRAS_LATENCIA; i += 1) {
        const inicio = Date.now();
        try {
          await cliente.headObject(chaveGrande);
          amostras.push(Date.now() - inicio);
        } catch {
          falhas += 1;
        }
      }

      // Operações por segundo com objetos minúsculos: aqui o que se mede é o
      // serviço aceitando requisição, não a rede movendo bytes.
      const pequeno = randomBytes(1024);
      const tOps = Date.now();
      let ops = 0;
      for (let i = 0; i < OPERACOES_PEQUENAS; i += 1) {
        const chave = `${PREFIXO_TESTE}/op-${i}-${randomBytes(3).toString('hex')}.bin`;
        try {
          await cliente.putObject(chave, pequeno, 'application/octet-stream');
          criadas.push(chave);
          ops += 1;
        } catch {
          falhas += 1;
        }
      }
      const msOps = Date.now() - tOps;

      const medianaMs = mediana(amostras);
      const p95Ms = percentil(amostras, 0.95);
      const mbpsSubida = throughputMbps(carga.length, msSubida);
      const cameras = camerasSuportadas(mbpsSubida);

      if (amostras.length && instavel(medianaMs, p95Ms)) {
        observacoes.push(
          `A cauda está longe da mediana (p95 ${Math.round(p95Ms)}ms contra ${Math.round(medianaMs)}ms): parte das requisições trava, ` +
            'e é ela que segura o lote inteiro quando há muitas câmeras.',
        );
      }
      if (falhas > 0) {
        observacoes.push(`${falhas} operações falharam durante a medição — os números abaixo são otimistas.`);
      }
      observacoes.push(
        `Medido a partir desta instalação, que é o caminho real do vídeo. ` +
          `Com margem de 30% para o tráfego que disputa a mesma rede, a subida comporta ~${cameras} câmeras gravando sem parar a 2 Mb/s.`,
      );

      const medicao: MedicaoDesempenho = {
        storageId: linha.id,
        nome: linha.name,
        bucket: linha.bucket,
        endpoint: linha.endpoint,
        medidoEm: new Date().toISOString(),
        amostraMb: mbEfetivo,
        latencia: {
          medianaMs: Math.round(medianaMs),
          p95Ms: Math.round(p95Ms),
          minMs: amostras.length ? Math.min(...amostras) : 0,
          maxMs: amostras.length ? Math.max(...amostras) : 0,
          amostras: amostras.length,
          classe: classificarLatencia(medianaMs),
        },
        subida: { mbps: Number(mbpsSubida.toFixed(2)), segundos: Number((msSubida / 1000).toFixed(2)) },
        descida: {
          mbps: Number(throughputMbps(baixado.length, msDescida).toFixed(2)),
          segundos: Number((msDescida / 1000).toFixed(2)),
        },
        operacoesPorSegundo: msOps > 0 ? Number(((ops / msOps) * 1000).toFixed(1)) : 0,
        camerasSuportadas: cameras,
        falhas,
        observacoes,
      };

      this.logger.log(
        `Desempenho de "${linha.name}": subida ${medicao.subida.mbps} Mb/s, descida ${medicao.descida.mbps} Mb/s, ` +
          `latência ${medicao.latencia.medianaMs}ms (p95 ${medicao.latencia.p95Ms}ms), ${medicao.operacoesPorSegundo} ops/s.`,
      );
      return medicao;
    } finally {
      this.rodando = false;
      // Limpeza SEMPRE, inclusive quando a medição falha no meio: o teste não
      // pode deixar lixo pago no bucket do cliente. Nem uma falha aqui pode
      // mascarar o erro original que trouxe o fluxo até este `finally`.
      for (const chave of criadas) {
        await cliente.deleteObject(chave).catch((error: unknown) => {
          this.logger.warn(`Objeto de teste ${chave} não pôde ser removido: ${String(error)}`);
        });
      }
    }
  }
}
