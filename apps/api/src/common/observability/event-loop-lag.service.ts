import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { envNumber } from '../config/env-number.helper';

// ── QUANDO A API PARA DE RESPONDER, E POR QUANTO TEMPO ──────────────────────
//
// Sintoma relatado: a tela mostra "Dados operacionais temporariamente
// desatualizados", os dados somem, e minutos depois voltam sozinhos. Medido de
// fora: o `/health` — que não toca banco nem disco — chegou a levar 10 SEGUNDOS,
// com mediana de 1ms. Ou seja, não é lentidão de consulta: é o laço de eventos
// do Node parado. Enquanto ele está parado, NADA responde.
//
// Medir de fora diz QUE travou; não diz por quanto tempo nem quantas vezes,
// porque só se enxerga a travada que calha de coincidir com a amostragem. Este
// monitor mede por dentro, o tempo todo, e grita com número.
//
// `monitorEventLoopDelay` é do próprio Node e usa um temporizador em C++: ele
// continua medindo mesmo com o JS bloqueado, que é exatamente a janela que
// interessa. Um `setInterval` em JS não conseguiria — ele também ficaria preso.
//
// Custo: um histograma nativo e uma leitura por ciclo. Desprezível perto de
// ficar sem saber por que a tela esvazia.

/**
 * Marcações de trabalho pesado EM ANDAMENTO.
 *
 * O monitor sabe QUE o laço travou, mas não sabe o que o travou — depois do
 * fato, a pilha já se foi. Quem executa uma operação cara marca o nome dela
 * aqui; quando a travada é detectada, o log sai com os nomes que estavam
 * abertos naquele minuto.
 *
 * É um Map de contadores, não uma lista: a mesma operação pode estar em curso
 * várias vezes (envio em paralelo), e saber "envio ×6" é mais útil que "envio".
 */
const emAndamento = new Map<string, number>();

/** Envolve uma operação cara para ela aparecer no relatório de travada. */
export async function marcandoTrabalho<T>(nome: string, fn: () => Promise<T>): Promise<T> {
  emAndamento.set(nome, (emAndamento.get(nome) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const n = (emAndamento.get(nome) ?? 1) - 1;
    if (n <= 0) emAndamento.delete(nome);
    else emAndamento.set(nome, n);
  }
}

// ── DE QUEM É A TRAVADA ─────────────────────────────────────────────────────
//
// Saber QUE travou 11 segundos não conserta nada; é preciso o nome da função.
// Depois do fato a pilha já se foi, então quem tem de guardá-la é o amostrador
// do próprio V8: ele interrompe a thread em intervalos fixos e anota a pilha do
// momento.
//
// O truque está na assinatura de uma travada dentro do perfil. Enquanto a
// thread está presa, o amostrador NÃO consegue disparar — então em vez de N
// amostras seguidas aparece UM intervalo gigante entre duas amostras. Esse
// buraco é a travada, e a amostra que o precede diz o que estava rodando quando
// tudo parou. É a única testemunha que sobra.

interface QuadroPerfil {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
export interface PerfilCpu {
  nodes: QuadroPerfil[];
  samples?: number[];
  /** Microssegundos entre uma amostra e a anterior. */
  timeDeltas?: number[];
}

/** Um quadro legível: `função (arquivo:linha)`, sem o caminho inteiro. */
function quadroLegivel(q: QuadroPerfil): string {
  const nome = q.callFrame.functionName || '(anônimo)';
  const url = q.callFrame.url || '';
  const arquivo = url.split('/').slice(-2).join('/').replace(/\?.*$/, '');
  // `lineNumber` do V8 começa em zero; somar 1 para bater com o editor.
  return arquivo ? `${nome} (${arquivo}:${q.callFrame.lineNumber + 1})` : nome;
}

/**
 * O MAIOR buraco entre duas amostras, e a pilha que estava em execução nele.
 *
 * Devolve `null` quando o perfil não tem amostras — perfil vazio não é erro,
 * é um minuto em que nada rodou.
 */
export function maiorPausa(perfil: PerfilCpu | null | undefined): { ms: number; pilha: string[] } | null {
  const amostras = perfil?.samples;
  const deltas = perfil?.timeDeltas;
  if (!perfil || !amostras?.length || !deltas?.length) return null;

  let piorUs = 0;
  let piorNo = -1;
  for (let i = 0; i < amostras.length && i < deltas.length; i += 1) {
    const d = deltas[i];
    if (d > piorUs) {
      piorUs = d;
      // O delta do índice i é o tempo GASTO ATÉ chegar nesta amostra. Quem
      // estava rodando durante esse tempo é a amostra ANTERIOR — usar a atual
      // apontaria para quem assumiu depois que a travada já tinha passado.
      piorNo = i > 0 ? amostras[i - 1] : amostras[i];
    }
  }
  if (piorNo < 0) return null;

  const porId = new Map<number, QuadroPerfil>();
  const pai = new Map<number, number>();
  for (const no of perfil.nodes) {
    porId.set(no.id, no);
    for (const filho of no.children ?? []) pai.set(filho, no.id);
  }

  const pilha: string[] = [];
  let id: number | undefined = piorNo;
  // Teto de profundidade: uma recursão profunda encheria o log de ruído, e os
  // quadros de cima já bastam para identificar o culpado.
  while (id !== undefined && pilha.length < 12) {
    const no = porId.get(id);
    if (!no) break;
    pilha.push(quadroLegivel(no));
    id = pai.get(id);
  }

  return { ms: piorUs / 1000, pilha };
}

@Injectable()
export class EventLoopLagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopLagService.name);
  private histograma: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private piorAte: number = 0;
  private sessao: Session | null = null;

  /** Envolve o protocolo do inspetor, que é por callback, numa promessa. */
  private comando(metodo: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.sessao) return resolve(null);
      this.sessao.post(metodo as any, params as any, (erro: Error | null, r: any) =>
        erro ? reject(erro) : resolve(r),
      );
    });
  }

  /** Começa a amostrar. Silencioso ao falhar: diagnóstico não derruba a API. */
  private async iniciarAmostragem(intervaloUs: number): Promise<void> {
    try {
      if (!this.sessao) {
        this.sessao = new Session();
        this.sessao.connect();
        await this.comando('Profiler.enable');
      }
      await this.comando('Profiler.setSamplingInterval', { interval: intervaloUs });
      await this.comando('Profiler.start');
    } catch {
      this.sessao = null;
    }
  }

  private async pararAmostragem(): Promise<PerfilCpu | null> {
    try {
      const r = await this.comando('Profiler.stop');
      return (r?.profile as PerfilCpu) ?? null;
    } catch {
      return null;
    }
  }

  onModuleInit(): void {
    const intervaloMs = envNumber('EVENT_LOOP_LAG_REPORT_MS', 60_000, {
      min: 5_000,
      max: 600_000,
      integer: true,
    });
    // Acima disto o usuário PERCEBE: a tela esvazia e o painel acusa dados
    // desatualizados. Abaixo, é ruído normal de um processo ocupado.
    const limiteMs = envNumber('EVENT_LOOP_LAG_WARN_MS', 500, {
      min: 50,
      max: 60_000,
      integer: true,
    });

    // Amostrar a 2ms: fino o bastante para pegar uma travada de segundos,
    // grosso o bastante para o custo do amostrador não aparecer na conta.
    const intervaloAmostraUs = envNumber('EVENT_LOOP_PROFILE_US', 2_000, {
      min: 100,
      max: 100_000,
      integer: true,
    });
    // Ligado por padrão enquanto a travada não tem dono. Desligar é uma
    // variável de ambiente, não uma edição de código.
    const perfilar = process.env.EVENT_LOOP_PROFILE !== 'false';

    this.histograma = monitorEventLoopDelay({ resolution: 20 });
    this.histograma.enable();
    if (perfilar) void this.iniciarAmostragem(intervaloAmostraUs);

    this.timer = setInterval(() => {
      const h = this.histograma;
      if (!h) return;
      const p99 = h.percentile(99) / 1e6;
      const maximo = h.max / 1e6;
      // Reset a cada ciclo: sem isso o máximo fica gravado para sempre e o
      // relatório vira uma lápide do pior momento do dia, sem dizer se ainda
      // está acontecendo.
      h.reset();

      const travou = maximo >= limiteMs;
      if (travou) {
        this.piorAte = Math.max(this.piorAte, maximo);
        const abertos = [...emAndamento.entries()]
          .map(([nome, n]) => (n > 1 ? `${nome} ×${n}` : nome))
          .join(', ');
        this.logger.warn(
          `Laço de eventos TRAVOU ${Math.round(maximo)}ms (p99 ${Math.round(p99)}ms) no último minuto. ` +
            'Enquanto isso a API não respondeu a NADA — é o que esvazia a tela e mostra "dados desatualizados".' +
            (abertos ? ` Trabalho pesado em curso: ${abertos}.` : ' Nenhum trabalho pesado marcado estava em curso.'),
        );
      }

      // O perfil é fechado a cada ciclo mesmo sem travada: mantê-lo aberto por
      // horas acumularia amostras até virar um problema de memória por conta
      // própria — e diagnóstico que derruba o serviço não é diagnóstico.
      if (perfilar) {
        void (async () => {
          const perfil = await this.pararAmostragem();
          if (travou) {
            const pausa = maiorPausa(perfil);
            if (pausa && pausa.ms >= limiteMs) {
              this.logger.warn(
                `A travada foi AQUI (${Math.round(pausa.ms)}ms sem nenhuma amostra). ` +
                  `Pilha, de dentro para fora:\n    ${pausa.pilha.join('\n    ← ')}`,
              );
            } else {
              // Sem buraco no perfil apesar da travada: o JS estava rodando o
              // tempo todo (muitas amostras curtas) ou a thread parou onde o
              // amostrador não alcança. Dizer isso é melhor que calar.
              this.logger.warn(
                'O amostrador não achou buraco: a travada não é UMA função longa, ' +
                  'e sim muito trabalho curto empilhado, ou uma espera fora do JS.',
              );
            }
          }
          await this.iniciarAmostragem(intervaloAmostraUs);
        })();
      }
    }, intervaloMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.histograma?.disable();
    try {
      this.sessao?.disconnect();
    } catch {
      /* já desconectado no desligamento */
    }
    this.sessao = null;
  }

  /** Pior travada observada, para quem quiser expor em diagnóstico. */
  piorTravadaMs(): number {
    return Math.round(this.piorAte);
  }
}
