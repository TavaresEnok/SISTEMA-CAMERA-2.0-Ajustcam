import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// O TRAVA-LÍNGUA QUE DESLIGOU A RETENÇÃO INTEIRA POR SEMANAS.
//
// `stageFileDeletion` roda dentro de uma transação que primeiro pega um lock
// consultivo do Postgres, para que duas instâncias da API não apaguem o mesmo
// arquivo. A chamada estava assim:
//
//     await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(...)")
//
// `pg_advisory_xact_lock` devolve `void`. O Prisma tenta desserializar a coluna
// e levanta P2010 — "Failed to deserialize column of type 'void'". Ou seja: a
// primeira linha de TODA exclusão de gravação lançava exceção.
//
// O estrago não apareceu como erro de retenção, apareceu como DISCO CHEIO. O
// guardião varria as gravações mais antigas, cada `deleteRecording` estourava,
// o catch registrava a falha e o job terminava anunciando "0 removida(s), uso
// 92% → 92%". Em produção o disco chegou a 92% com a retenção nominalmente
// ligada e nenhum arquivo jamais removido.
//
// Nenhum teste com Prisma FAKE pega isso: o fake resolve `$queryRawUnsafe` com
// um array vazio e passa verde. O erro mora no serializador do Prisma real
// falando com um Postgres real — só um teste contra banco de verdade o vê.
//
// POR QUE `.e2e.ts`: o glob de CI é `tests/**/*.test.ts` e o job `pnpm-verify`
// não tem Postgres. Roda por `pnpm --filter api test:e2e:pg-lock`, com a
// fixture `scripts/e2e-postgres-fixture.sh`.

const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('drac:recordings:file-delete'))";

function prisma() {
  return new PrismaClient();
}

test('$executeRawUnsafe pega o lock consultivo sem estourar', async () => {
  const db = prisma();
  try {
    // Se isto lançar, TODA exclusão de gravação está quebrada em produção —
    // inclusive o guardião de disco, que é a última linha antes do disco lotar.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(LOCK_SQL);
    });
  } finally {
    await db.$disconnect();
  }
});

test('$queryRawUnsafe REALMENTE falha nesse lock (é o bug, não paranoia)', async () => {
  // Este teste é o que dá sentido ao anterior. Sem ele, alguém "simplifica" a
  // chamada de volta para $queryRawUnsafe achando que tanto faz — as duas APIs
  // parecem intercambiáveis para quem lê `SELECT ...` no começo da string.
  const db = prisma();
  try {
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(LOCK_SQL);
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(
          message,
          /deserialize column of type 'void'|P2010/,
          `esperava a falha de desserialização de void, veio: ${message}`,
        );
        return true;
      },
      'se isto parar de rejeitar, o Prisma passou a suportar `void` e o comentário no código ficou obsoleto',
    );
  } finally {
    await db.$disconnect();
  }
});

test('o lock é reentrante na MESMA transação e serializa entre transações', async () => {
  // Duas propriedades que o código depende sem dizer:
  //  1. pegar o lock duas vezes na mesma transação não trava (o journal chama
  //     stageFileDeletion uma vez, mas retries de Prisma podem repetir);
  //  2. o lock é liberado no fim da transação — se vazasse, a segunda instância
  //     da API ficaria pendurada para sempre e a retenção morreria em silêncio,
  //     que é exatamente o modo de falha que este arquivo existe para impedir.
  const db = prisma();
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(LOCK_SQL);
      await tx.$executeRawUnsafe(LOCK_SQL);
    });

    // Se a transação anterior não tivesse liberado, esta ficaria bloqueada até
    // o timeout do teste em vez de completar.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(LOCK_SQL);
    });
  } finally {
    await db.$disconnect();
  }
});
