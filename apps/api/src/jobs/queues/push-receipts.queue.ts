export const PUSH_RECEIPTS_QUEUE = 'push-receipts';

// Atraso padrão entre o envio (estágio 1: tickets) e a conferência dos RECEIPTS
// (estágio 2). O Expo processa a entrega de forma assíncrona; ~15min é o intervalo
// recomendado para os receipts já estarem prontos. Ajustável por env.
export function pushReceiptsDelayMs(): number {
  const raw = Number(process.env.PUSH_RECEIPTS_DELAY_MS ?? 15 * 60_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15 * 60_000;
}
