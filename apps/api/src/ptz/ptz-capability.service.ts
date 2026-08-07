import { Injectable, Logger } from '@nestjs/common';
import { type Camera } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { OnvifPtzService } from './onvif-ptz.service';
import { envNumber } from '../common/config/env-number.helper';

/**
 * DESCOBERTA DE PTZ — sonda, guarda, e não atrapalha.
 *
 * O problema que isto resolve: até 07/08/2026 ninguém perguntava à câmera se
 * ela tem PTZ. O front DEDUZIA de "tem caminho ONVIF configurado", então a
 * tela de PTZ listava câmera fixa — e a que tem PTZ de verdade, estando
 * offline no momento do cadastro, nunca era descoberta.
 *
 * Três garantias que orientam o desenho:
 *
 * 1. A SONDA NÃO MEXE NA CÂMERA. Ela manda `stop`, um comando neutro: se o
 *    equipamento aceita, tem PTZ; se recusa, não tem. Nenhuma câmera se move
 *    por causa de uma varredura — condição para poder rodar sozinha.
 *
 * 2. O QUE FOI APRENDIDO É GUARDADO. Quando a sonda acha o endpoint que
 *    funciona (porta, caminho, perfil), esses campos são gravados na câmera.
 *    Sem isso, TODO comando PTZ recomeça a tentativa às cegas — que é a
 *    origem daquele erro com quatro tentativas concatenadas na tela.
 *
 * 3. A DECISÃO DO OPERADOR VENCE. Marcou à mão no editor avançado
 *    (`ptzCapableSource = 'manual'`), a sonda automática nunca sobrescreve.
 *    É a saída para equipamento que ela não sabe ler.
 */
@Injectable()
export class PtzCapabilityService {
  private readonly logger = new Logger(PtzCapabilityService.name);

  /** Não re-sondar quem já foi sondado há pouco: câmera que oscila online/offline
   *  o dia todo dispararia uma sonda a cada volta. */
  private readonly intervaloMinimoHoras = envNumber('PTZ_PROBE_MIN_INTERVAL_HOURS', 24, { min: 1 });

  /** Teto de sondas simultâneas. Mesma razão do reteste de saúde: disparar
   *  tudo de uma vez contra o mesmo DVR esgota as sessões do equipamento. */
  private readonly concorrencia = envNumber('PTZ_PROBE_CONCURRENCY', 3, { min: 1, max: 8, integer: true });

  constructor(
    private readonly prisma: PrismaService,
    private readonly onvifPtz: OnvifPtzService,
  ) {}

  /** Decisão manual do operador — a partir daqui a sonda não encosta mais. */
  async definirManualmente(cameraId: string, temPtz: boolean) {
    await this.prisma.camera.update({
      where: { id: cameraId },
      data: {
        ptzCapable: temPtz,
        ptzCapableSource: 'manual',
        ptzProbedAt: new Date(),
      },
    });
    this.logger.log(`PTZ definido à mão camera=${cameraId} temPtz=${temPtz}`);
  }

  /** Devolve o controle à sonda automática (limpa o override). */
  async voltarAoAutomatico(cameraId: string) {
    await this.prisma.camera.update({
      where: { id: cameraId },
      data: { ptzCapableSource: null, ptzProbedAt: null },
    });
  }

  private sondadaRecentemente(camera: Pick<Camera, 'ptzProbedAt'>) {
    if (!camera.ptzProbedAt) return false;
    const idadeHoras = (Date.now() - camera.ptzProbedAt.getTime()) / 3_600_000;
    return idadeHoras < this.intervaloMinimoHoras;
  }

  /**
   * Sonda UMA câmera e persiste o resultado.
   *
   * `forcar` ignora o intervalo mínimo (usado pelo botão de re-sondar), mas
   * NUNCA ignora o override manual — nem o operador pedindo re-sonda deve ver
   * sua própria decisão apagada sem querer; para isso existe
   * `voltarAoAutomatico`.
   */
  async sondar(cameraId: string, opcoes: { forcar?: boolean } = {}) {
    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) return { sondou: false, motivo: 'camera-inexistente' as const };

    if (camera.ptzCapableSource === 'manual') {
      return { sondou: false, motivo: 'definido-manualmente' as const, ptzCapable: camera.ptzCapable };
    }
    if (!opcoes.forcar && this.sondadaRecentemente(camera)) {
      return { sondou: false, motivo: 'sondada-recentemente' as const, ptzCapable: camera.ptzCapable };
    }
    if (camera.enabled === false) {
      return { sondou: false, motivo: 'camera-desativada' as const, ptzCapable: camera.ptzCapable };
    }

    let resultado: Awaited<ReturnType<OnvifPtzService['diagnoseCamera']>>;
    try {
      resultado = await this.onvifPtz.diagnoseCamera(camera);
    } catch (erro) {
      // Falha de rede NÃO é "não tem PTZ". Deixar `ptzCapable` como está (o
      // provável é `null`) mantém a câmera na fila da próxima varredura, em vez
      // de carimbá-la como fixa para sempre por causa de um cabo solto.
      this.logger.warn(
        `Sonda de PTZ falhou camera=${cameraId}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      return { sondou: false, motivo: 'falha-na-sonda' as const, ptzCapable: camera.ptzCapable };
    }

    const temPtz = Boolean(resultado.ptzLikelyWorking);
    const detectado = resultado.detected as Record<string, unknown> | null;

    await this.prisma.camera.update({
      where: { id: cameraId },
      data: {
        ptzCapable: temPtz,
        ptzCapableSource: 'auto',
        ptzProbedAt: new Date(),
        // Guarda o endpoint que RESPONDEU. É o que faz o próximo comando PTZ
        // acertar de primeira em vez de tentar quatro caminhos e falhar em
        // todos. Só grava o que a sonda de fato descobriu — nunca apaga uma
        // configuração existente com null.
        ...(temPtz && detectado
          ? {
              ...(typeof detectado.onvifPort === 'number' ? { onvifPort: detectado.onvifPort } : {}),
              ...(typeof detectado.onvifPath === 'string' ? { onvifPath: detectado.onvifPath } : {}),
              ...(typeof detectado.onvifProfileToken === 'string'
                ? { onvifProfileToken: detectado.onvifProfileToken }
                : {}),
            }
          : {}),
      },
    });

    if (temPtz !== camera.ptzCapable) {
      this.logger.log(
        `PTZ ${temPtz ? 'DETECTADO' : 'ausente'} camera=${camera.name} (${cameraId})`
        + (temPtz && detectado ? ` via ${String(detectado.protocol ?? '?')}` : ''),
      );
    }

    return { sondou: true, motivo: 'ok' as const, ptzCapable: temPtz };
  }

  /**
   * Varredura das que ainda não sabemos. Chamada pelo health-check; é
   * best-effort por natureza — quem falhar volta na próxima rodada, porque
   * continua com `ptzCapable = null`.
   */
  async varrerDesconhecidas(limite = 12) {
    const pendentes = await this.prisma.camera.findMany({
      where: {
        enabled: true,
        ptzCapable: null,
        // Sondar câmera offline é jogar tempo fora: nenhuma porta responde e o
        // resultado seria "não tem PTZ" por engano. Ela volta na varredura
        // quando o health-check a marcar online de novo.
        status: 'ONLINE',
        OR: [{ ptzCapableSource: null }, { ptzCapableSource: 'auto' }],
      },
      select: { id: true, name: true },
      take: limite,
    });
    if (!pendentes.length) return { sondadas: 0, comPtz: 0 };

    let comPtz = 0;
    for (let i = 0; i < pendentes.length; i += this.concorrencia) {
      const lote = pendentes.slice(i, i + this.concorrencia);
      const resultados = await Promise.all(
        lote.map((c) => this.sondar(c.id).catch(() => ({ sondou: false, ptzCapable: null }))),
      );
      comPtz += resultados.filter((r) => r.ptzCapable === true).length;
    }
    this.logger.log(`Varredura de PTZ: ${pendentes.length} câmera(s) sondada(s), ${comPtz} com PTZ.`);
    return { sondadas: pendentes.length, comPtz };
  }
}
