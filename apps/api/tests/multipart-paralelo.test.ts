import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '../src/cloud-storage/s3-client';

// ─────────────────────────────────────────────────────────────────────────────
// PARTES EM PARALELO DENTRO DE UM ARQUIVO GRANDE
//
// O offload já sobe gravações DIFERENTES em paralelo. Mas UMA gravação contínua
// grande (500 MB ≈ 30 partes) subia suas partes uma a uma — e o fornecedor
// (Eveo) FECHA a conexão a cada requisição, cobrando ~143ms para reabrir. Serial,
// são ~30 × 143ms = ~4s de puro handshake por arquivo, além do transporte. Com o
// link a 45ms de latência (São Paulo), o gargalo NÃO é banda (o servidor usa 1,25%
// dela) — é a soma de idas e voltas sequenciais.
//
// Paralelizar as partes sobrepõe esses handshakes. Invariantes que estes testes
// travam: (1) o teto de partes em voo é RESPEITADO — memória = teto × tamanho da
// parte, num servidor de RAM finita; (2) a ORDEM das partes no fechamento é
// correta mesmo quando terminam fora de ordem (senão o objeto sai corrompido);
// (3) uma parte que falha ABORTA o upload inteiro (nada de objeto meio-enviado).
// ─────────────────────────────────────────────────────────────────────────────

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  const c: any = Object.create(S3Client.prototype);
  c.config = { prefix: '', bucket: 'b', endpoint: 'http://x', region: 'r', accessKeyId: 'a', secretAccessKey: 's', forcePathStyle: true };
  return c;
}

test('partes sobem em PARALELO, respeitando o teto de partes em voo', async () => {
  const c = fakeClient();
  let emVoo = 0, pico = 0;
  const teto = 4;
  c.request = async ({ query }: any) => {
    if (query?.uploads !== undefined) return { body: Buffer.from('<UploadId>u1</UploadId>') };
    if (query?.partNumber) {
      emVoo += 1; pico = Math.max(pico, emVoo);
      await new Promise((r) => setTimeout(r, 15));
      emVoo -= 1;
      return { body: Buffer.from(''), etag: `"e${query.partNumber}"` };
    }
    return { body: Buffer.from('') };
  };

  const total = 20 * 16 * 1024 * 1024; // 20 partes de 16 MB
  await c.putObjectMultipart('v.mp4', async (_o: number, l: number) => Buffer.alloc(l), total, { partConcurrency: teto });

  assert.ok(pico > 1, `paralelizou de verdade (pico em voo = ${pico})`);
  assert.ok(pico <= teto, `NUNCA pode passar do teto: pico ${pico} > ${teto} estoura memória`);
});

test('a ordem das partes no fechamento é correta mesmo terminando fora de ordem', async () => {
  const c = fakeClient();
  let completeBody = '';
  c.request = async ({ query, payload }: any) => {
    if (query?.uploads !== undefined) return { body: Buffer.from('<UploadId>u1</UploadId>') };
    if (query?.partNumber) {
      const n = Number(query.partNumber);
      // parte 1 é a MAIS LENTA de propósito: se a ordem seguisse o término,
      // ela cairia por último no XML e o objeto sairia embaralhado.
      await new Promise((r) => setTimeout(r, n === 1 ? 40 : 5));
      return { body: Buffer.from(''), etag: `"etag-${n}"` };
    }
    if (query?.uploadId !== undefined && payload) { completeBody = payload.toString('utf8'); return { body: Buffer.from('') }; }
    return { body: Buffer.from('') };
  };

  const total = 5 * 16 * 1024 * 1024;
  await c.putObjectMultipart('v.mp4', async (_o: number, l: number) => Buffer.alloc(l), total, { partConcurrency: 5 });

  const ordem = [...completeBody.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
  assert.deepEqual(ordem, [1, 2, 3, 4, 5], 'as partes têm de sair em ordem CRESCENTE no CompleteMultipartUpload');
  const etags = [...completeBody.matchAll(/<ETag>([^<]+)<\/ETag>/g)].map((m) => m[1]);
  assert.deepEqual(etags, ['"etag-1"', '"etag-2"', '"etag-3"', '"etag-4"', '"etag-5"'], 'cada ETag casa com a sua parte');
});

test('uma parte que FALHA aborta o upload inteiro (DELETE) e propaga o erro', async () => {
  const c = fakeClient();
  let abortou = false;
  c.request = async ({ method, query }: any) => {
    if (query?.uploads !== undefined) return { body: Buffer.from('<UploadId>u1</UploadId>') };
    if (query?.partNumber) {
      if (Number(query.partNumber) === 3) throw new Error('parte 3 caiu no meio');
      return { body: Buffer.from(''), etag: `"e${query.partNumber}"` };
    }
    if (method === 'DELETE') { abortou = true; return { body: Buffer.from('') }; }
    return { body: Buffer.from('') };
  };

  const total = 6 * 16 * 1024 * 1024;
  await assert.rejects(
    () => c.putObjectMultipart('v.mp4', async (_o: number, l: number) => Buffer.alloc(l), total, { partConcurrency: 3 }),
    /parte 3 caiu/,
    'a falha de uma parte não pode ser engolida — objeto meio-enviado é pior que erro',
  );
  assert.equal(abortou, true, 'o multipart tem de ser abortado no storage (DELETE), senão vira lixo cobrado');
});

test('teto respeitado também limita a MEMÓRIA em voo (teto × tamanho da parte)', async () => {
  const c = fakeClient();
  let bytesEmVoo = 0, picoBytes = 0;
  const teto = 3, parte = 16 * 1024 * 1024;
  c.request = async ({ query }: any) => {
    if (query?.uploads !== undefined) return { body: Buffer.from('<UploadId>u1</UploadId>') };
    if (query?.partNumber) {
      bytesEmVoo += parte; picoBytes = Math.max(picoBytes, bytesEmVoo);
      await new Promise((r) => setTimeout(r, 10));
      bytesEmVoo -= parte;
      return { body: Buffer.from(''), etag: `"e${query.partNumber}"` };
    }
    return { body: Buffer.from('') };
  };
  const total = 12 * parte;
  await c.putObjectMultipart('v.mp4', async (_o: number, l: number) => Buffer.alloc(l), total, { partConcurrency: teto, partSizeBytes: parte });
  assert.ok(picoBytes <= teto * parte, `memória em voo (${Math.round(picoBytes/1048576)}MB) não pode passar de ${teto*parte/1048576}MB`);
});

test('arquivo de UMA parte continua funcionando (o caso comum do clipe de movimento)', async () => {
  const c = fakeClient();
  let partes = 0, completou = false;
  c.request = async ({ query, payload }: any) => {
    if (query?.uploads !== undefined) return { body: Buffer.from('<UploadId>u1</UploadId>') };
    if (query?.partNumber) { partes += 1; return { body: Buffer.from(''), etag: '"só"' }; }
    if (query?.uploadId !== undefined && payload) { completou = true; return { body: Buffer.from('') }; }
    return { body: Buffer.from('') };
  };
  await c.putObjectMultipart('clip.mp4', async (_o: number, l: number) => Buffer.alloc(l), 8 * 1024 * 1024, { partConcurrency: 4 });
  assert.equal(partes, 1, 'arquivo menor que uma parte sobe em 1 pedaço');
  assert.equal(completou, true);
});
