// Classificação de erros do Expo Push e extração de tokens mortos dos RECEIPTS.
// Puro e testável. O envio tem 2 estágios: (1) tickets (resposta imediata) e
// (2) receipts (consultados depois — pegam erros que só aparecem no processamento
// assíncrono do Expo). Ambos usam esta mesma classificação.

export type ExpoReceipt = { status: 'ok' | 'error'; message?: string; details?: { error?: string } };

// Erros que significam que o TOKEN está MORTO → remover do banco. Os demais
// (MessageTooBig, MessageRateExceeded, InvalidCredentials, MismatchSenderId) são
// problemas de config/rate: o token continua válido, não se remove.
const REMOVE_TOKEN_ERRORS = new Set(['DeviceNotRegistered']);

export function shouldRemoveToken(errorCode: string | undefined | null): boolean {
  return !!errorCode && REMOVE_TOKEN_ERRORS.has(errorCode);
}

/** Dado receiptId→token e os receipts do Expo, devolve os tokens a remover + os erros. */
export function invalidTokensFromReceipts(
  receipts: Record<string, ExpoReceipt> | null | undefined,
  idToToken: Record<string, string>,
): { invalidTokens: string[]; errors: Array<{ token: string; error: string }> } {
  const invalidTokens: string[] = [];
  const errors: Array<{ token: string; error: string }> = [];
  for (const [id, receipt] of Object.entries(receipts ?? {})) {
    if (receipt?.status !== 'error') continue;
    const token = idToToken[id];
    if (!token) continue;
    const code = receipt.details?.error;
    errors.push({ token, error: code ?? receipt.message ?? 'unknown' });
    if (shouldRemoveToken(code)) invalidTokens.push(token);
  }
  return { invalidTokens, errors };
}
