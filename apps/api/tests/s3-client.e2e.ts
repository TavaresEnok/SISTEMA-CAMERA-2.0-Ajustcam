import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, S3Error } from '../src/cloud-storage/s3-client';

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTE S3 CONTRA UM SERVIDOR REAL.
//
// A assinatura V4 é o tipo de código que "parece certo" e só falha em runtime,
// como um 403 opaco. Teste unitário confirma o formato; só um servidor de
// verdade confirma que a assinatura FECHA. Por isso este arquivo existe e é
// `.e2e.ts` (fora do glob de CI, que não tem storage).
//
// Vale para qualquer S3 compatível — MinIO, Backblaze B2, Eveo, AWS. Configure:
//   DRAC_E2E_S3_ENDPOINT / _REGION / _BUCKET / _ACCESS_KEY / _SECRET_KEY
//
// ANTI-TEATRO (mesma regra do e2e de RTSP e do de Postgres): sem storage
// configurado o teste PULA visivelmente; sob DRAC_E2E_REQUIRED=1 ele FALHA em
// vez de passar verde.
// ─────────────────────────────────────────────────────────────────────────────

const endpoint = process.env.DRAC_E2E_S3_ENDPOINT ?? '';
const bucket = process.env.DRAC_E2E_S3_BUCKET ?? '';
const accessKeyId = process.env.DRAC_E2E_S3_ACCESS_KEY ?? '';
const secretAccessKey = process.env.DRAC_E2E_S3_SECRET_KEY ?? '';
const region = process.env.DRAC_E2E_S3_REGION ?? 'us-east-1';
const REQUIRED = process.env.DRAC_E2E_REQUIRED === '1';

const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

if (!configured) {
  const motivo = 'defina DRAC_E2E_S3_ENDPOINT/_BUCKET/_ACCESS_KEY/_SECRET_KEY para exercitar o storage';
  if (REQUIRED) {
    test('cliente S3 contra servidor real', () => assert.fail(`DRAC_E2E_REQUIRED=1 mas ${motivo}`));
  } else {
    test('cliente S3 contra servidor real', { skip: motivo }, () => {});
  }
} else {
  const base = { endpoint, region, bucket, accessKeyId, secretAccessKey };
  // Prefixo por processo: rodadas paralelas (ou um bucket compartilhado com
  // outra instalação) não podem enxergar nem apagar objetos uma da outra.
  const prefix = `drac-e2e/${process.pid}`;
  const client = new S3Client({ ...base, prefix });

  test('ciclo completo: PUT → HEAD → GET → LIST → DELETE', async () => {
    const key = 'ciclo/objeto.txt';
    const payload = Buffer.from('conteúdo de gravação simulada');

    await client.putObject(key, payload, 'text/plain');

    assert.equal((await client.headObject(key)).exists, true, 'HEAD tem que enxergar o que o PUT gravou');

    const baixado = await client.getObject(key);
    assert.equal(baixado.toString('utf8'), payload.toString('utf8'), 'o conteúdo tem que voltar íntegro');

    const lista = await client.listObjects('ciclo/');
    assert.ok(lista.some((o) => o.key.endsWith('ciclo/objeto.txt')), 'LIST tem que trazer a chave');
    assert.equal(lista.find((o) => o.key.endsWith('ciclo/objeto.txt'))?.size, payload.length, 'tamanho confere');

    await client.deleteObject(key);
    assert.equal((await client.headObject(key)).exists, false, 'depois do DELETE não pode existir');
  });

  test('binário grande sobrevive intacto (gravação não é texto)', async () => {
    // Segmento de vídeo é binário; um cliente que corrompe bytes só apareceria
    // no dia em que alguém tentasse ver a prova.
    const key = 'binario/segmento.ts';
    const payload = Buffer.alloc(512 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7) % 256;

    await client.putObject(key, payload, 'video/mp2t');
    const baixado = await client.getObject(key);
    assert.equal(baixado.length, payload.length, 'tamanho tem que bater');
    assert.ok(baixado.equals(payload), 'byte a byte idêntico');
    await client.deleteObject(key);
  });

  test('chave com espaço e acento é codificada corretamente (assinatura fecha)', async () => {
    // Codificação errada de caminho é uma das causas clássicas de 403 no V4.
    const key = 'câmera portaria/gravação 01.ts';
    const payload = Buffer.from('x');
    await client.putObject(key, payload);
    assert.equal((await client.headObject(key)).exists, true);
    await client.deleteObject(key);
  });

  test('objeto inexistente: HEAD devolve false, GET lança S3Error', async () => {
    assert.equal((await client.headObject('nao/existe.ts')).exists, false);
    await assert.rejects(() => client.getObject('nao/existe.ts'), (error: unknown) => {
      assert.ok(error instanceof S3Error);
      assert.equal((error as S3Error).status, 404);
      return true;
    });
  });

  test('credencial INVÁLIDA é rejeitada (o teste de conexão precisa ser real)', async () => {
    const ruim = new S3Client({ ...base, secretAccessKey: 'chave-errada-de-proposito', prefix });
    await assert.rejects(() => ruim.listObjects(), (error: unknown) => {
      assert.ok(error instanceof S3Error, 'tem que ser S3Error tipado');
      assert.equal((error as S3Error).status, 403, 'servidor real responde 403');
      return true;
    });
  });

  test('mensagem de erro NÃO vaza a chave secreta', async () => {
    const ruim = new S3Client({ ...base, secretAccessKey: 'SEGREDO-QUE-NAO-PODE-VAZAR', prefix });
    try {
      await ruim.listObjects();
      assert.fail('deveria ter falhado');
    } catch (error) {
      const texto = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
      assert.ok(!texto.includes('SEGREDO-QUE-NAO-PODE-VAZAR'), 'a credencial não pode aparecer no erro');
    }
  });

  test('endpoint inalcançável vira erro de rede tipado, não exceção crua', async () => {
    const morto = new S3Client({ ...base, endpoint: 'http://127.0.0.1:9', prefix });
    await assert.rejects(() => morto.listObjects(), (error: unknown) => {
      assert.ok(error instanceof S3Error);
      assert.equal((error as S3Error).code, 'NetworkError');
      return true;
    });
  });

  test('verifyAccess confirma LEITURA e ESCRITA (credencial read-only reprova)', async () => {
    const resultado = await client.verifyAccess();
    assert.equal(resultado.ok, true);
    assert.equal(resultado.canWrite, true, 'só listar não basta: gravação é o que o produto precisa');
  });
}
