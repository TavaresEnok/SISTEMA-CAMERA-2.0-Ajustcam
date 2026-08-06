// ── "SUBIU" SÓ VALE DEPOIS DE CONFERIDO — E CONFERIDO DE VERDADE ────────────
//
// A confirmação do upload é o que autoriza, mais tarde, APAGAR a cópia local.
// Dois furos tornavam essa autorização mentirosa:
//
//  1. O HEAD só checava EXISTÊNCIA. Um objeto truncado (parte que subiu com
//     cauda de zeros, PUT interrompido que o servidor aceitou) "existe" — o
//     banco marcava enviado, a poda apagava o original, e a prova corrompida
//     era tudo o que restava. A conferência agora compara o TAMANHO.
//
//  2. A leitura das partes ignorava `bytesRead`. `handle.read` pode devolver
//     menos bytes que o pedido; o resto do Buffer ia como zeros — exatamente o
//     objeto truncado do item 1, fabricado por nós mesmos.
//
// E o 403 no HEAD (credencial write-only, sem GetObject) não pode virar
// reenvio infinito: o upload até funcionou, mas é INVERIFICÁVEL — e o que não
// se verifica não autoriza poda nem pode ser pago de novo a cada ciclo.

import type { FileHandle } from 'node:fs/promises';

export type ConfirmacaoHead = { exists: boolean; contentLength: number | null; verificavel: boolean };

export type VereditoDeConfirmacao =
  | { ok: true }
  | { ok: false; motivo: 'objeto_ausente' | 'tamanho_divergente' | 'inverificavel'; detalhe: string };

/** O HEAD pós-upload autoriza marcar a gravação como enviada? */
export function avaliarConfirmacao(confirmado: ConfirmacaoHead, tamanhoEnviado: number): VereditoDeConfirmacao {
  if (!confirmado.verificavel) {
    return {
      ok: false,
      motivo: 'inverificavel',
      detalhe: 'o bucket recusou a consulta (403) — credencial sem permissão de leitura não permite confirmar o envio',
    };
  }
  if (!confirmado.exists) {
    return { ok: false, motivo: 'objeto_ausente', detalhe: 'o PUT respondeu OK mas o objeto não está no bucket' };
  }
  if (confirmado.contentLength != null && confirmado.contentLength !== tamanhoEnviado) {
    return {
      ok: false,
      motivo: 'tamanho_divergente',
      detalhe: `o bucket reporta ${confirmado.contentLength} bytes; foram enviados ${tamanhoEnviado}`,
    };
  }
  return { ok: true };
}

/**
 * Lê EXATAMENTE `length` bytes de `handle` a partir de `offset`.
 *
 * `handle.read` não garante ler tudo de uma vez; ignorar `bytesRead` deixava a
 * cauda do Buffer em zeros e fabricava a parte corrompida silenciosamente.
 * Menos bytes que o pedido depois de esgotar as tentativas = o arquivo mudou
 * embaixo de nós (rotação/poda) — e aí subir é pior que falhar.
 */
export async function lerTrechoExato(
  handle: Pick<FileHandle, 'read'>,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let lido = 0;
  while (lido < length) {
    const { bytesRead } = await handle.read(buf, lido, length - lido, offset + lido);
    if (bytesRead <= 0) {
      throw new Error(`leitura curta: ${lido}/${length} bytes no offset ${offset} — o arquivo mudou durante o envio`);
    }
    lido += bytesRead;
  }
  return buf;
}
