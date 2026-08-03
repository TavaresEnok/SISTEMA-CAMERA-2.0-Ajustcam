// Estatística das medições de desempenho do storage.
//
// Separado do serviço porque é aritmética pura e é onde mora o engano fácil:
// uma média esconde exatamente o que interessa. Um bucket que responde em 40ms
// quase sempre e em 3s de vez em quando tem média boa e operação ruim — é a
// cauda que estoura o upload e enche a fila.

/** Mediana. Em amostra par, a média dos dois centrais. */
export function mediana(valores: number[]): number {
  if (valores.length === 0) return 0;
  const ordenado = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  return ordenado.length % 2 === 1 ? ordenado[meio] : (ordenado[meio - 1] + ordenado[meio]) / 2;
}

/**
 * Percentil por interpolação linear (o mesmo método de `numpy.percentile`).
 *
 * Com poucas amostras, "o elemento na posição 0,95×n" salta de um valor bruto
 * para outro e dá a impressão de precisão que não existe. Interpolar não cria
 * precisão, mas evita degraus artificiais entre execuções vizinhas.
 */
export function percentil(valores: number[], p: number): number {
  if (valores.length === 0) return 0;
  if (valores.length === 1) return valores[0];
  const ordenado = [...valores].sort((a, b) => a - b);
  const posicao = (ordenado.length - 1) * p;
  const baixo = Math.floor(posicao);
  const alto = Math.ceil(posicao);
  if (baixo === alto) return ordenado[baixo];
  return ordenado[baixo] + (ordenado[alto] - ordenado[baixo]) * (posicao - baixo);
}

/**
 * Megabits por segundo — a unidade em que banda de rede é contratada e falada.
 *
 * Deliberadamente Mb/s e não MB/s: o cliente contrata "100 mega" do provedor e
 * o número tem de poder ser comparado com isso sem conta de cabeça. Um fator 8
 * de diferença é o tipo de engano que faz alguém achar que a banda está 8×
 * melhor do que está.
 */
export function throughputMbps(bytes: number, milissegundos: number): number {
  if (milissegundos <= 0) return 0;
  return (bytes * 8) / (milissegundos / 1000) / 1_000_000;
}

/**
 * Quantas câmeras a banda medida comporta gravando sem parar.
 *
 * O envio é em lote, mas a conta que importa é de regime permanente: se a
 * subida sustentada for menor que o total que as câmeras produzem, a fila
 * cresce para sempre e o disco local enche — não importa quão espaçado seja o
 * job. `bitrateMbps` é o consumo MEDIDO de uma câmera nesta frota (2,06 Mb/s),
 * não um número de catálogo.
 *
 * A margem existe porque a medição é de um instante ocioso: a mesma rede vai
 * disputar com o acesso ao vivo, o playback e o resto do escritório. Prometer
 * 100% da banda medida é prometer o que só existe no laboratório.
 */
export function camerasSuportadas(mbpsSubida: number, bitrateMbps = 2.06, margem = 0.7): number {
  if (mbpsSubida <= 0 || bitrateMbps <= 0) return 0;
  return Math.floor((mbpsSubida * margem) / bitrateMbps);
}

/**
 * Rótulo honesto para a latência medida.
 *
 * Os cortes vêm do que a operação sente, não de estética: abaixo de ~80ms o
 * upload de um segmento é dominado pela transferência; acima de ~400ms cada
 * objeto passa a pagar um pedágio que aparece na fila quando há muitas câmeras.
 */
export function classificarLatencia(medianaMs: number): 'boa' | 'aceitável' | 'ruim' {
  if (medianaMs <= 80) return 'boa';
  if (medianaMs <= 400) return 'aceitável';
  return 'ruim';
}

/**
 * A cauda importa mais que a mediana quando o assunto é fila.
 *
 * p95 muito acima da mediana significa que uma parte das requisições trava, e
 * é ela que segura o lote inteiro. Dobro é folga normal de rede; 4× já é
 * instabilidade que o operador precisa ver escrita.
 */
export function instavel(medianaMs: number, p95Ms: number): boolean {
  if (medianaMs <= 0) return false;
  return p95Ms / medianaMs >= 4;
}
