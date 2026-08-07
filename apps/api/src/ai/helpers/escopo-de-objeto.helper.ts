/**
 * QUAIS CÂMERAS RODAM IA DE OBJETO — e por quê não todas.
 *
 * A detecção de objeto (YOLO) é cara. Ligá-la nas 27 câmeras da frota
 * custaria CPU o dia inteiro para responder a uma pergunta que, na maioria
 * delas, ninguém está fazendo. E o incidente de 07/08/2026 mostrou o que
 * acontece quando o servidor satura: o vídeo ao vivo cai a 0 fps e o sistema
 * parece morto por fora, mesmo gravando por dentro.
 *
 * A LÓGICA: o custo segue a NECESSIDADE DECLARADA, não uma lista paralela que
 * alguém precisa lembrar de manter.
 *
 *   auto (padrão) — roda objeto SE a câmera tem linha de perímetro desenhada.
 *                   Desenhar a linha JÁ É o pedido: ninguém desenha "não passar
 *                   por aqui" sem querer que isso seja vigiado. E apagar a
 *                   linha desliga o custo sozinho, sem uma segunda configuração
 *                   para lembrar de reverter.
 *   sempre        — roda mesmo sem linha (câmera crítica, contagem, alarme por
 *                   presença de pessoa).
 *   nunca         — não roda em hipótese alguma, nem com linha desenhada. É a
 *                   saída para a câmera que satura o servidor (cena movimentada
 *                   demais) sem obrigar a apagar a linha.
 *
 * Três portões acima disso, e a ordem importa:
 *   1. a Central liberou objeto para esta instalação? (política comercial)
 *   2. a câmera está ativa e com IA ligada?
 *   3. a regra por câmera acima.
 * Sem o portão 1, o operador poderia ampliar sozinho o que foi vendido.
 */

export type ModoDeObjeto = 'auto' | 'sempre' | 'nunca';

export type CameraParaEscopo = {
  id: string;
  name?: string | null;
  enabled?: boolean | null;
  aiEnabled?: boolean | null;
  objectMode?: string | null;
  detectionZones?: unknown;
};

export type DecisaoDeObjeto = {
  cameraId: string;
  roda: boolean;
  /** Por que sim ou por que não — vai para o log e para a tela. */
  motivo:
    | 'politica-nao-libera'
    | 'camera-desativada'
    | 'ia-desligada-na-camera'
    | 'desligado-pelo-operador'
    | 'linha-de-perimetro'
    | 'sempre-ligado'
    | 'sem-linha-desenhada';
};

export function normalizarModoDeObjeto(valor: unknown): ModoDeObjeto {
  return valor === 'sempre' || valor === 'nunca' ? valor : 'auto';
}

/** A câmera tem ao menos uma linha de perímetro utilizável? */
export function temLinhaDePerimetro(zonas: unknown): boolean {
  if (!Array.isArray(zonas)) return false;
  return zonas.some((z: any) => {
    if (!z || z.kind !== 'line' || !Array.isArray(z.points) || z.points.length !== 2) return false;
    const [a, b] = z.points;
    const ax = Number(a?.[0]); const ay = Number(a?.[1]);
    const bx = Number(b?.[0]); const by = Number(b?.[1]);
    if (![ax, ay, bx, by].every(Number.isFinite)) return false;
    // Dois pontos no mesmo lugar não são linha — e não devem custear um YOLO.
    return Math.hypot(bx - ax, by - ay) > 1e-6;
  });
}

export function decidirObjetoDaCamera(
  camera: CameraParaEscopo,
  opcoes: { politicaLiberaObjeto: boolean },
): DecisaoDeObjeto {
  const cameraId = camera.id;
  if (!opcoes.politicaLiberaObjeto) return { cameraId, roda: false, motivo: 'politica-nao-libera' };
  if (camera.enabled === false) return { cameraId, roda: false, motivo: 'camera-desativada' };
  if (camera.aiEnabled === false) return { cameraId, roda: false, motivo: 'ia-desligada-na-camera' };

  const modo = normalizarModoDeObjeto(camera.objectMode);
  if (modo === 'nunca') return { cameraId, roda: false, motivo: 'desligado-pelo-operador' };
  if (modo === 'sempre') return { cameraId, roda: true, motivo: 'sempre-ligado' };

  return temLinhaDePerimetro(camera.detectionZones)
    ? { cameraId, roda: true, motivo: 'linha-de-perimetro' }
    : { cameraId, roda: false, motivo: 'sem-linha-desenhada' };
}

/**
 * As classes que ESTA instalação pode detectar, vindas da Central.
 *
 * Lista vazia ou ausente = a política não liberou objeto. Devolver o catálogo
 * inteiro nesse caso seria o pior erro possível: a instalação passaria a
 * detectar tudo justamente quando não tinha permissão para nada.
 */
export function classesPermitidas(restricoes: unknown): string[] {
  const bruto = (restricoes as any)?.aiObjectClasses;
  if (!Array.isArray(bruto)) return [];
  return [...new Set(bruto.map((c) => String(c ?? '').trim().toLowerCase()).filter(Boolean))];
}

/** Texto curto para o operador entender por que a câmera roda (ou não). */
export function explicarDecisao(decisao: DecisaoDeObjeto): string {
  switch (decisao.motivo) {
    case 'politica-nao-libera': return 'Detecção de objetos não liberada para esta instalação.';
    case 'camera-desativada': return 'Câmera desativada.';
    case 'ia-desligada-na-camera': return 'IA desligada nesta câmera.';
    case 'desligado-pelo-operador': return 'Desligado manualmente para esta câmera.';
    case 'linha-de-perimetro': return 'Ligado automaticamente: há linha de perímetro desenhada.';
    case 'sempre-ligado': return 'Ligado manualmente para esta câmera.';
    case 'sem-linha-desenhada': return 'Sem linha de perímetro — desenhe uma linha para ativar, ou marque "sempre".';
  }
}
