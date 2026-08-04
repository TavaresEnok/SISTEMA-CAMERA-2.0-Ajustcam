import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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

@Injectable()
export class EventLoopLagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopLagService.name);
  private histograma: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private piorAte: number = 0;

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

    this.histograma = monitorEventLoopDelay({ resolution: 20 });
    this.histograma.enable();

    this.timer = setInterval(() => {
      const h = this.histograma;
      if (!h) return;
      const p99 = h.percentile(99) / 1e6;
      const maximo = h.max / 1e6;
      // Reset a cada ciclo: sem isso o máximo fica gravado para sempre e o
      // relatório vira uma lápide do pior momento do dia, sem dizer se ainda
      // está acontecendo.
      h.reset();

      if (maximo >= limiteMs) {
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
    }, intervaloMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.histograma?.disable();
  }

  /** Pior travada observada, para quem quiser expor em diagnóstico. */
  piorTravadaMs(): number {
    return Math.round(this.piorAte);
  }
}
