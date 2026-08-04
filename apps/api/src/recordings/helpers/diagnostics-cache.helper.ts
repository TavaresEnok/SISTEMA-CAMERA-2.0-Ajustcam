import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

// ── O CACHE QUE CONGELAVA A API ─────────────────────────────────────────────
//
// Este cache causou a pior falha visível do produto: a API parava de responder
// por ~11 segundos, a tela do operador esvaziava e voltava sozinha minutos
// depois. A conta que explica o número inteiro:
//
//   O resumo de saúde percorre até 1.200 gravações e, para CADA uma, relia o
//   arquivo do disco e fazia `JSON.parse` do conteúdo TODO. Com 3.776 entradas
//   o arquivo tem 1,6 MB e cada leitura+interpretação custa 8,5ms.
//   1.200 × 8,5ms = 10,2s. Medido na ponta: 11,4s. Fecha.
//
// E `JSON.parse` é síncrono: enquanto roda, o Node não atende NADA — nem o
// `/health`, que não toca banco nem disco. Por isso o sintoma era a aplicação
// inteira congelar, e não a tela de gravações ficar lenta.
//
// A saída é ler o arquivo UMA vez e manter o objeto em memória. A memória é a
// verdade: um único processo escreve aqui, então a cópia em RAM nunca fica
// atrás do disco. `mtime`+tamanho existem só para perceber edição externa —
// alguém apagando o arquivo para forçar recontagem, por exemplo.

export class CacheDeDiagnostico<T> {
  private memo: { mtimeMs: number; size: number; dados: Record<string, T> } | null = null;
  private sujo = false;

  /**
   * @param caminho Função, e não texto: o destino depende de `RECORDINGS_ROOT`,
   *                que só é conhecido na primeira chamada.
   * @param aoFalhar Recebe falhas de gravação. Cache é conveniência — perder
   *                 uma escrita custa recomputar, então nada aqui lança.
   */
  constructor(
    private readonly caminho: () => string,
    private readonly aoFalhar: (mensagem: string) => void = () => {},
  ) {}

  ler(): Record<string, T> {
    const arquivo = this.caminho();
    let mtimeMs = 0;
    let size = 0;
    try {
      const st = statSync(arquivo);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      // Arquivo ainda não existe, ou sumiu. O que está em memória continua
      // valendo — devolver vazio aqui descartaria diagnósticos ainda não
      // gravados e mandaria o ffprobe refazer todos eles.
      return this.memo?.dados ?? {};
    }

    if (this.memo && this.memo.mtimeMs === mtimeMs && this.memo.size === size) {
      return this.memo.dados;
    }

    try {
      const lido = JSON.parse(readFileSync(arquivo, 'utf-8')) as Record<string, T>;
      const dados = lido && typeof lido === 'object' ? lido : {};
      this.memo = { mtimeMs, size, dados };
      return dados;
    } catch {
      // Arquivo corrompido: memoriza o vazio para não reinterpretar o mesmo
      // lixo a cada chamada. A primeira gravação boa o substitui.
      this.memo = { mtimeMs, size, dados: {} };
      return {};
    }
  }

  /**
   * Passa a valer AGORA, em memória; o disco vem depois.
   *
   * Sem isso, a volta seguinte do laço releria o estado anterior e o trabalho
   * recém-feito seria refeito.
   */
  gravar(dados: Record<string, T>): void {
    this.memo = { mtimeMs: this.memo?.mtimeMs ?? 0, size: this.memo?.size ?? 0, dados };
    this.sujo = true;
  }

  precisaGravar(): boolean {
    return this.sujo;
  }

  /**
   * Leva o cache ao disco. Devolve se chegou a escrever.
   *
   * Agrupar as escritas é metade da correção: antes, cada gravação
   * diagnosticada reescrevia 1,6 MB inteiros — num lote de 1.200 isso é 1,9 GB
   * gravados para persistir alguns kilobytes de novidade.
   */
  descarregar(): boolean {
    if (!this.sujo || !this.memo) return false;
    const arquivo = this.caminho();
    const temporario = `${arquivo}.tmp`;
    const dados = this.memo.dados;
    try {
      // Escreve com outro nome e renomeia: uma queda no meio da escrita
      // deixaria um JSON pela metade, e o arquivo pela metade leva embora
      // TODOS os diagnósticos de uma vez.
      writeFileSync(temporario, JSON.stringify(dados), 'utf-8');
      renameSync(temporario, arquivo);
      this.sujo = false;
      const st = statSync(arquivo);
      this.memo = { mtimeMs: st.mtimeMs, size: st.size, dados };
      return true;
    } catch (error) {
      this.aoFalhar(`Falha ao gravar cache de diagnóstico: ${(error as Error).message}`);
      return false;
    }
  }
}
