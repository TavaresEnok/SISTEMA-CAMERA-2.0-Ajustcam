// ── FONTES QUENTES DA GRADE: por RELEVÂNCIA, com orçamento ──────────────────
//
// O problema que isto resolve: manter a fonte da grade sempre conectada dá
// abertura instantânea, mas "sempre conectada PARA TODAS" não escala — 500
// câmeras seriam ~275 Mbps contínuos e 500 sessões RTSP permanentes contra os
// DVRs dos clientes; 2.000 seria um ataque de negação de serviço contra a
// própria frota. A regra burra (env liga/desliga global) obrigava a escolher
// entre "tudo quente" e "tudo frio".
//
// A regra inteligente: quente é quem os OPERADORES realmente olham.
//   · cada visualização de grade marca a câmera (lastViewedAt);
//   · ficam quentes as `budget` câmeras vistas mais recentemente, dentro de
//     uma janela (visto há mais de N horas não conta — turno que acabou não
//     reserva banda);
//   · o resto fica sob demanda e paga ~5s de frio UMA vez — e entra no quente
//     na hora, porque acabou de ser visto.
//
// Numa instalação de 21 câmeras com orçamento 64, TODAS cabem: comportamento
// idêntico ao "sempre quente" de antes. Em 2.000 câmeras, o custo para de
// acompanhar o tamanho do cadastro e passa a acompanhar o uso real.
//
// Funções PURAS de propósito: a política inteira é testável sem MediaMTX, sem
// banco e sem relógio de verdade.

export type GridViewEntry = { cameraId: string; lastViewedAt: number };

export const DEFAULT_HOT_GRID_BUDGET = 64;
export const DEFAULT_HOT_GRID_WINDOW_HOURS = 168; // 7 dias: cobre o ciclo de turnos de uma semana

/**
 * O conjunto de câmeras cuja fonte de grade merece ficar conectada agora.
 *
 * Empate de recência é desempatado pelo id (ordem estável): dois candidatos
 * idênticos não podem alternar entre quente/frio a cada reconciliação — cada
 * flip é uma reconexão RTSP contra a câmera do cliente.
 */
export function computeHotGridSet(
  entries: Iterable<GridViewEntry>,
  budget: number,
  windowMs: number,
  now: number,
): Set<string> {
  if (budget <= 0) return new Set();
  const corte = now - windowMs;
  const vivos = [...entries].filter((e) => Number.isFinite(e.lastViewedAt) && e.lastViewedAt >= corte);
  vivos.sort((a, b) => (b.lastViewedAt - a.lastViewedAt) || a.cameraId.localeCompare(b.cameraId));
  return new Set(vivos.slice(0, budget).map((e) => e.cameraId));
}

/**
 * Semente para histórico VAZIO (primeiro boot com esta política, ou instalação
 * nova): trata todas as câmeras habilitadas como "vistas agora".
 *
 * Sem isto, o primeiro boot deixaria a grade inteira fria e o operador leria a
 * atualização como regressão ("ontem abria na hora"). Com orçamento menor que
 * a frota, o próprio computeHotGridSet corta no teto — uma instalação de
 * 2.000 câmeras recém-migrada aquece `budget`, nunca 2.000.
 */
export function seedEmptyHistory(cameraIds: string[], now: number): GridViewEntry[] {
  return cameraIds.map((cameraId) => ({ cameraId, lastViewedAt: now }));
}

/**
 * Poda do histórico persistido: fora da janela, a entrada não influencia mais
 * nada — guardar seria acumular lixo para sempre no SystemSetting (2.000
 * câmeras × meses de rotação de frota).
 */
export function pruneHistory(
  entries: Iterable<GridViewEntry>,
  windowMs: number,
  now: number,
): GridViewEntry[] {
  const corte = now - windowMs;
  return [...entries].filter((e) => Number.isFinite(e.lastViewedAt) && e.lastViewedAt >= corte);
}
