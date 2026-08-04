import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '../src/cloud-storage/s3-client';

// O envio de arquivo grande NÃO pode segurar o arquivo inteiro na memória.
//
// O vídeo já está no disco; copiá-lo inteiro para a RAM só para enviar é gasto
// puro, e com envios em paralelo vira pico de gigabytes num servidor de 9,9 GB.
// Este teste mede o MAIOR pedaço que o cliente pede de uma vez.

test('envio grande lê o disco em pedaços, nunca o arquivo inteiro', async () => {
  const total = 60 * 1024 * 1024;
  let maiorPedido = 0;
  let pedacos = 0;

  const cliente: any = Object.create(S3Client.prototype);
  (cliente as any).config = { prefix: '', bucket: 'b', endpoint: 'http://x', region: 'r', accessKeyId: 'a', secretAccessKey: 's', forcePathStyle: true };
  (cliente as any).request = async ({ query }: any) => {
    if (query?.uploads !== undefined) return { body: Buffer.from('<UploadId>u1</UploadId>') };
    if (query?.partNumber) { pedacos += 1; return { body: Buffer.from(''), etag: '"e"' }; }
    return { body: Buffer.from('') };
  };

  await cliente.putObjectMultipart(
    'v.mp4',
    async (_offset: number, length: number) => { maiorPedido = Math.max(maiorPedido, length); return Buffer.alloc(length); },
    total,
    { contentType: 'video/mp4' },
  );

  assert.ok(pedacos > 1, 'um arquivo de 60 MB tem de ir em vários pedaços');
  assert.ok(maiorPedido < total, 'nenhum pedido pode ser do tamanho do arquivo — seria o mesmo que carregar tudo');
  assert.ok(maiorPedido <= 16 * 1024 * 1024, `pedaço grande demais (${Math.round(maiorPedido / 1048576)} MB) volta a ser risco de memória`);
});
