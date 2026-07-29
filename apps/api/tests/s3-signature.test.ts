import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeS3Path,
  joinS3Key,
  parseListObjects,
  parseS3ErrorCode,
  signS3Request,
  type S3Config,
} from '../src/cloud-storage/s3-client';

// Partes PURAS do cliente S3 — rodam no CI, que não tem storage. O ciclo contra
// servidor real vive em `s3-client.e2e.ts`.
//
// Assinatura V4 erra em silêncio: o sintoma é um 403 opaco, longe da causa.
// Estes testes travam as três fontes clássicas desse 403 — codificação de
// caminho, ordenação da query e conjunto de headers assinados.

const CONFIG: S3Config = {
  endpoint: 'http://storage.local:9000',
  region: 'us-east-1',
  bucket: 'meu-storage',
  accessKeyId: 'AKIAEXEMPLO',
  secretAccessKey: 'segredo-de-teste',
};

const FIXED = new Date('2026-07-29T12:00:00.000Z');

test('assinatura é determinística para a mesma entrada', () => {
  const a = signS3Request(CONFIG, { method: 'GET', key: 'x.ts', now: FIXED });
  const b = signS3Request(CONFIG, { method: 'GET', key: 'x.ts', now: FIXED });
  assert.equal(a.headers.Authorization, b.headers.Authorization);
});

test('mudar a chave secreta muda a assinatura (senão não estaríamos assinando)', () => {
  const a = signS3Request(CONFIG, { method: 'GET', key: 'x.ts', now: FIXED });
  const b = signS3Request({ ...CONFIG, secretAccessKey: 'outro' }, { method: 'GET', key: 'x.ts', now: FIXED });
  assert.notEqual(a.headers.Authorization, b.headers.Authorization);
});

test('a chave secreta NUNCA aparece na URL nem nos headers', () => {
  const assinado = signS3Request(CONFIG, { method: 'PUT', key: 'a/b.ts', payload: Buffer.from('x'), now: FIXED });
  const tudo = `${assinado.url} ${JSON.stringify(assinado.headers)}`;
  assert.ok(!tudo.includes('segredo-de-teste'), 'credencial não pode trafegar em claro');
  assert.ok(assinado.headers.Authorization.includes('AKIAEXEMPLO'), 'o access key id, sim, é público');
});

test('path-style coloca o bucket no caminho (exigido por MinIO em IP puro)', () => {
  const assinado = signS3Request(CONFIG, { method: 'GET', key: 'cam/1.ts', now: FIXED });
  assert.equal(assinado.url, 'http://storage.local:9000/meu-storage/cam/1.ts');
});

test('virtual-host coloca o bucket no host', () => {
  const assinado = signS3Request(
    { ...CONFIG, forcePathStyle: false },
    { method: 'GET', key: 'cam/1.ts', now: FIXED },
  );
  assert.equal(assinado.url, 'http://meu-storage.storage.local:9000/cam/1.ts');
});

test('encodeS3Path preserva a barra e codifica o resto', () => {
  assert.equal(encodeS3Path('cam 1/gravação.ts'), 'cam%201/grava%C3%A7%C3%A3o.ts');
  // `!'()*` passam batido no encodeURIComponent e derrubam a assinatura na AWS.
  assert.equal(encodeS3Path("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
});

test('query canônica sai ORDENADA (ordem errada = 403)', () => {
  const assinado = signS3Request(CONFIG, {
    method: 'GET',
    query: { prefix: 'cam', 'list-type': '2', 'max-keys': '10' },
    now: FIXED,
  });
  const query = assinado.url.split('?')[1];
  assert.equal(query, 'list-type=2&max-keys=10&prefix=cam');
});

test('headers assinados incluem host, data e hash do corpo', () => {
  const assinado = signS3Request(CONFIG, { method: 'GET', key: 'x', now: FIXED });
  const assinatura = assinado.headers.Authorization;
  assert.match(assinatura, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});

test('corpo vazio usa o hash canônico de string vazia', () => {
  const assinado = signS3Request(CONFIG, { method: 'GET', key: 'x', now: FIXED });
  assert.equal(
    assinado.headers['x-amz-content-sha256'],
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('joinS3Key evita barra dupla e barra inicial', () => {
  assert.equal(joinS3Key('inst-1', 'cam/a.ts'), 'inst-1/cam/a.ts');
  assert.equal(joinS3Key('/inst-1/', '/cam/a.ts'), 'inst-1/cam/a.ts');
  assert.equal(joinS3Key(undefined, 'cam/a.ts'), 'cam/a.ts');
  assert.equal(joinS3Key('', 'cam/a.ts'), 'cam/a.ts');
});

test('prefixo isola instalações que dividem o mesmo bucket', () => {
  // Sem isso, duas instalações no mesmo bucket se enxergariam — e a limpeza de
  // uma apagaria a gravação da outra.
  assert.notEqual(joinS3Key('inst-A', 'cam/1.ts'), joinS3Key('inst-B', 'cam/1.ts'));
});

test('parseS3ErrorCode extrai o código do XML de erro', () => {
  assert.equal(
    parseS3ErrorCode('<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>x</Message></Error>'),
    'SignatureDoesNotMatch',
  );
  assert.equal(parseS3ErrorCode('resposta sem xml'), 'Unknown', 'sem código conhecido não inventa');
});

test('parseListObjects lê chave, tamanho e data', () => {
  const xml = `<ListBucketResult>
    <Contents><Key>inst/cam/a.ts</Key><Size>1024</Size><LastModified>2026-07-29T10:00:00.000Z</LastModified></Contents>
    <Contents><Key>inst/cam/b.ts</Key><Size>2048</Size><LastModified>2026-07-29T11:00:00.000Z</LastModified></Contents>
  </ListBucketResult>`;
  const itens = parseListObjects(xml);
  assert.equal(itens.length, 2);
  assert.equal(itens[0].key, 'inst/cam/a.ts');
  assert.equal(itens[0].size, 1024);
  assert.equal(itens[1].size, 2048);
});

test('parseListObjects em bucket vazio devolve lista vazia, não erro', () => {
  assert.deepEqual(parseListObjects('<ListBucketResult></ListBucketResult>'), []);
});
