/**
 * CRUZAMENTO DE LINHA VIRTUAL (tripwire) — a geometria, isolada e testável.
 *
 * Um objeto rastreado tem um ponto de referência que anda pelo quadro. Se o
 * trajeto entre dois instantes ATRAVESSA a linha desenhada pelo operador, houve
 * cruzamento — e o sentido diz se aquilo era proibido.
 *
 * Por que função pura: é aqui que erro silencioso vira alarme falso às 3h da
 * manhã ou, pior, perímetro cego. Separada do vídeo, do rastreamento e da rede,
 * ela pode ser provada com casos que não dependem de câmera nenhuma.
 *
 * COORDENADAS NORMALIZADAS (0..1), como as zonas de detecção: a linha continua
 * valendo se a câmera trocar de 640×360 para 1080p.
 *
 * O PONTO DE REFERÊNCIA do objeto é o meio da BASE da caixa, não o centro. Uma
 * pessoa é alta: usando o centro, ela "cruza" a linha do chão quando o tronco
 * passa por cima dela, com os pés ainda do lado de fora. A base é onde o objeto
 * toca o chão — é o que corresponde à linha que o operador desenhou no piso.
 * (É a mesma escolha que o Frigate faz para presença em zona.)
 */

export type Ponto = { x: number; y: number };

/**
 * Sentido PROIBIDO da travessia.
 *
 * `ab` e `ba` referem-se a caminhar SOBRE a linha do ponto A para o B: quem
 * cruza vindo da esquerda desse caminho está indo no sentido `ab`. Nomear pelos
 * extremos (e não "entrando"/"saindo") evita a ambiguidade de quem desenhou a
 * linha ao contrário — a seta na tela mostra qual é qual.
 */
export type SentidoDaLinha = 'ambos' | 'ab' | 'ba';

export type LinhaVirtual = {
  id: string;
  name: string;
  /** Exatamente 2 pontos: início (A) e fim (B). */
  points: number[][];
  sentido?: SentidoDaLinha;
};

export type Travessia = {
  linhaId: string;
  linhaNome: string;
  /** Sentido em que o objeto de fato atravessou. */
  sentido: 'ab' | 'ba';
  /** A travessia bate com o sentido configurado como proibido? */
  proibido: boolean;
};

/**
 * De que lado da linha o ponto está.
 *
 * Produto vetorial de (B−A) por (P−A): positivo de um lado, negativo do outro,
 * zero exatamente sobre a linha. O valor absoluto não interessa — só o sinal.
 */
function ladoDaLinha(a: Ponto, b: Ponto, p: Ponto): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

const sinal = (v: number, epsilon = 1e-9): -1 | 0 | 1 => (v > epsilon ? 1 : v < -epsilon ? -1 : 0);

/**
 * Os segmentos P→Q e A→B se cruzam de fato?
 *
 * Trocar de lado NÃO basta: quem anda longe da linha, mas do outro lado do
 * plano, também troca de sinal. É preciso que CADA segmento separe os extremos
 * do outro — senão a linha vira uma reta infinita e dispara com o objeto a
 * metros de distância do portão.
 */
function segmentosSeCruzam(p: Ponto, q: Ponto, a: Ponto, b: Ponto): boolean {
  const d1 = sinal(ladoDaLinha(a, b, p));
  const d2 = sinal(ladoDaLinha(a, b, q));
  const d3 = sinal(ladoDaLinha(p, q, a));
  const d4 = sinal(ladoDaLinha(p, q, b));
  if (d1 === 0 && d2 === 0) return false; // trajeto colinear: roçar não é cruzar
  return d1 !== d2 && d3 !== d4;
}

function comoPonto(par: number[] | undefined): Ponto | null {
  if (!Array.isArray(par) || par.length < 2) return null;
  const [x, y] = par;
  return Number.isFinite(x) && Number.isFinite(y) ? { x: Number(x), y: Number(y) } : null;
}

/** Uma linha só é utilizável com dois pontos distintos. */
export function linhaValida(linha: LinhaVirtual | null | undefined): boolean {
  if (!linha || !Array.isArray(linha.points) || linha.points.length !== 2) return false;
  const a = comoPonto(linha.points[0]);
  const b = comoPonto(linha.points[1]);
  if (!a || !b) return false;
  return Math.hypot(b.x - a.x, b.y - a.y) > 1e-6;
}

/** Ponto de referência do objeto: meio da base da caixa [x1, y1, x2, y2]. */
export function pontoDeReferencia(bbox: number[] | null | undefined): Ponto | null {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const [x1, y1, x2, y2] = bbox.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x: (x1 + x2) / 2, y: Math.max(y1, y2) };
}

/**
 * Avalia o trajeto de UM objeto contra TODAS as linhas da câmera.
 *
 * `anterior` é a posição no último quadro em que este mesmo objeto foi visto —
 * por isso o rastreamento é obrigatório na opção com IA local. Sem identidade
 * entre quadros não há trajeto, e sem trajeto não existe cruzamento: só se
 * saberia que "há alguém de cada lado", que é outra pergunta.
 */
export function avaliarTravessias(
  anterior: Ponto | null | undefined,
  atual: Ponto | null | undefined,
  linhas: LinhaVirtual[],
): Travessia[] {
  if (!anterior || !atual || !Array.isArray(linhas) || !linhas.length) return [];
  // Objeto parado não cruza nada. Sem esta guarda, o ruído de um pixel em cima
  // da linha viraria uma enxurrada de travessias no mesmo lugar.
  if (Math.hypot(atual.x - anterior.x, atual.y - anterior.y) < 1e-6) return [];

  const travessias: Travessia[] = [];
  for (const linha of linhas) {
    if (!linhaValida(linha)) continue;
    const a = comoPonto(linha.points[0])!;
    const b = comoPonto(linha.points[1])!;
    if (!segmentosSeCruzam(anterior, atual, a, b)) continue;

    // O lado de ONDE veio determina o sentido: quem estava do lado negativo e
    // passou para o positivo andou no sentido `ab`.
    const ladoAntes = sinal(ladoDaLinha(a, b, anterior));
    const sentido: 'ab' | 'ba' = ladoAntes < 0 ? 'ab' : 'ba';
    const configurado = linha.sentido ?? 'ambos';
    travessias.push({
      linhaId: linha.id,
      linhaNome: linha.name,
      sentido,
      proibido: configurado === 'ambos' || configurado === sentido,
    });
  }
  return travessias;
}

/** Só as linhas de uma lista de zonas, já validadas. */
export function linhasDe(zonas: unknown): LinhaVirtual[] {
  if (!Array.isArray(zonas)) return [];
  return zonas
    .filter((z: any) => z && z.kind === 'line')
    .map((z: any) => ({
      id: String(z.id ?? ''),
      name: String(z.name ?? 'Linha'),
      points: Array.isArray(z.points) ? z.points : [],
      sentido: (['ambos', 'ab', 'ba'] as const).includes(z.sentido) ? z.sentido : 'ambos',
    }))
    .filter(linhaValida);
}
