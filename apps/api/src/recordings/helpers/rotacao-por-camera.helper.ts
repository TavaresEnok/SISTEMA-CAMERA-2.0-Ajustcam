// ── DISCO CHEIO ROTACIONA, NÃO PARA ─────────────────────────────────────────
//
// O comportamento anterior tinha dois mecanismos que não conversavam:
//
//   · o GUARDIÃO (retention) rodava a cada 1 HORA, disparava a 90% e apagava a
//     gravação mais antiga do sistema INTEIRO — de qualquer câmera;
//   · a GUARDA (process manager) rodava a cada poucos segundos e, a 92%,
//     SUSPENDIA a gravação de todas as câmeras.
//
// Entre 90% e 92% havia até uma hora de janela. Se o disco cruzasse os 92%
// nesse intervalo — o que acontece rápido com 24 câmeras — a gravação PARAVA e
// só voltava na próxima varredura. Medido em produção: 100 paradas em 2 horas,
// com ZERO câmeras gravando.
//
// E apagar "a mais antiga do sistema" faz uma câmera movimentada consumir o
// histórico das outras: quem grava muito empurra para fora a imagem de quem
// grava pouco, sem que ninguém tenha pedido isso.
//
// A regra correta, e a que o dono definiu: cada câmera é um ANEL. Ao faltar
// espaço, a gravação nova de uma câmera sobrescreve a MAIS ANTIGA DELA MESMA.
// Nenhuma câmera perde histórico por causa da vizinha, e a gravação nunca para.

export type CandidataARotacao = {
  id: string;
  cameraId: string;
  startedAt: Date | string;
  /** Tamanho em disco. String porque o Prisma serializa BigInt assim. */
  sizeBytes: bigint | number | string | null;
  /** Preservada por investigação/legal hold — nunca entra na rotação. */
  protegida?: boolean;
};

export type PlanoDeRotacao = {
  /** Gravações a apagar, na ordem (mais antiga de cada câmera primeiro). */
  aApagar: CandidataARotacao[];
  /** Soma estimada dos bytes que serão liberados. */
  bytesEstimados: number;
  /** Câmeras que não têm o que rotacionar (sem histórico próprio). */
  camerasSemFolga: string[];
};

function bytesDe(valor: CandidataARotacao['sizeBytes']): number {
  if (valor == null) return 0;
  const n = typeof valor === 'bigint' ? Number(valor) : Number(valor);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function instante(valor: Date | string): number {
  return valor instanceof Date ? valor.getTime() : new Date(valor).getTime();
}

/**
 * Escolhe o que apagar para liberar `bytesNecessarios`, respeitando o anel de
 * cada câmera.
 *
 * A distribuição é POR RODADA: apaga a mais antiga da câmera A, depois a mais
 * antiga da B, e assim por diante, voltando ao início. Isso evita que uma única
 * câmera pague sozinha a conta quando várias estão gravando — e mantém a perda
 * proporcional entre elas.
 *
 * `camerasAtivas` (quem está gravando agora) entra primeiro na fila: é dela o
 * espaço que está acabando. Câmeras paradas só são tocadas se ainda faltar.
 */
export function planejarRotacao(
  candidatas: CandidataARotacao[],
  bytesNecessarios: number,
  camerasAtivas: string[] = [],
): PlanoDeRotacao {
  if (!(bytesNecessarios > 0)) return { aApagar: [], bytesEstimados: 0, camerasSemFolga: [] };

  // Uma fila por câmera, da MAIS ANTIGA para a mais nova.
  const porCamera = new Map<string, CandidataARotacao[]>();
  for (const item of candidatas) {
    if (item.protegida) continue;
    const fila = porCamera.get(item.cameraId) ?? [];
    fila.push(item);
    porCamera.set(item.cameraId, fila);
  }
  for (const fila of porCamera.values()) {
    fila.sort((a, b) => instante(a.startedAt) - instante(b.startedAt));
  }

  // Câmeras gravando agora vêm primeiro: é o disco delas que está acabando.
  const ativas = new Set(camerasAtivas);
  const ordem = [...porCamera.keys()].sort((a, b) => {
    const pa = ativas.has(a) ? 0 : 1;
    const pb = ativas.has(b) ? 0 : 1;
    return pa !== pb ? pa - pb : a.localeCompare(b);
  });

  const aApagar: CandidataARotacao[] = [];
  let bytesEstimados = 0;
  let rodouSemPegarNada = false;

  while (bytesEstimados < bytesNecessarios && !rodouSemPegarNada) {
    rodouSemPegarNada = true;
    for (const cameraId of ordem) {
      if (bytesEstimados >= bytesNecessarios) break;
      const fila = porCamera.get(cameraId);
      if (!fila?.length) continue;
      const escolhida = fila.shift()!;
      aApagar.push(escolhida);
      bytesEstimados += bytesDe(escolhida.sizeBytes);
      rodouSemPegarNada = false;
    }
  }

  // Câmeras ATIVAS que não têm nada próprio para rotacionar: são as únicas que
  // ainda justificariam suspender a gravação, e quem chama precisa saber.
  const camerasSemFolga = camerasAtivas.filter((id) => !(porCamera.get(id)?.length) && !aApagar.some((r) => r.cameraId === id));

  return { aApagar, bytesEstimados, camerasSemFolga };
}
