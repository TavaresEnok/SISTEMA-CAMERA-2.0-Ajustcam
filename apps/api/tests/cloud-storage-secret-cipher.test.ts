import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudConnectorService } from '../src/cloud-connector/cloud-connector.service';

// ── A CREDENCIAL S3 NÃO VIVE MAIS EM CLARO NO BANCO ─────────────────────────
//
// A mesma secret era cifrada na tabela CloudStorage e gravada em TEXTO PURO em
// SystemSetting['cloud.storage'] — e era a cópia em claro que o offload e o
// playback realmente usavam. Qualquer dump/backup/réplica do Postgres
// entregava a chave do bucket do cliente.
//
// Regras: cifra com prefixo `enc:` ao persistir; lê legado em claro (migração
// suave); cifrado ilegível (chave mestra trocada) PARA e grita — usar o
// ciphertext como senha só geraria SignatureDoesNotMatch silencioso.

const cryptoFake = {
  encrypt: (s: string) => Buffer.from(s).toString('base64'),
  decrypt: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
};

function montar(opcoes: { raw?: string; cryptoQuebrado?: boolean } = {}) {
  const erros: string[] = [];
  const svc: any = Object.create(CloudConnectorService.prototype);
  svc.logger = { warn: () => {}, log: () => {}, error: (m: string) => erros.push(m) };
  svc.moduleRef = {
    get: () => (opcoes.cryptoQuebrado
      ? { encrypt: () => { throw new Error('sem chave'); }, decrypt: () => { throw new Error('chave errada'); } }
      : cryptoFake),
  };
  svc.readSettings = async () => ({ 'cloud.storage': opcoes.raw ?? '' });
  return { svc, erros };
}

const CONFIG_BASE = {
  enabled: true,
  name: 'Bucket Teste',
  endpoint: 'https://object.exemplo.com.br',
  region: 'us-east-1',
  bucket: 'meu-bucket',
  prefix: 'inst-1',
  accessKeyId: 'AKIA123',
  forcePathStyle: true,
  mode: 'tier',
  localWindowHours: 24,
  uploadConcurrency: 6,
};

test('cifrar → persistir → ler devolve a secret em claro para quem usa', async () => {
  const { svc } = montar();
  const cifrado = svc.cifrarSegredoStorage({ ...CONFIG_BASE, secretAccessKey: 'segredo-do-cliente' });

  assert.ok(String(cifrado.secretAccessKey).startsWith('enc:'), 'no banco só entra cifrado');
  assert.ok(!JSON.stringify(cifrado).includes('segredo-do-cliente'), 'a secret em claro não pode aparecer no JSON persistido');

  const { svc: leitor } = montar({ raw: JSON.stringify(cifrado) });
  const lido = await leitor.getCloudStorageConfig();
  assert.equal(lido?.secretAccessKey, 'segredo-do-cliente', 'o offload precisa da secret em claro para assinar');
});

test('cifrar duas vezes não embrulha o embrulho', () => {
  const { svc } = montar();
  const uma = svc.cifrarSegredoStorage({ ...CONFIG_BASE, secretAccessKey: 's3gr3d0' });
  const duas = svc.cifrarSegredoStorage(uma);
  assert.equal(duas.secretAccessKey, uma.secretAccessKey, 'enc:enc:... nunca decifraria de volta');
});

test('valor LEGADO em claro continua sendo lido (migração suave)', async () => {
  // Instalações existentes têm a secret em claro no setting; recusá-las
  // pararia o offload da frota inteira no deploy desta mudança.
  const { svc } = montar({ raw: JSON.stringify({ ...CONFIG_BASE, secretAccessKey: 'ainda-em-claro' }) });
  const lido = await svc.getCloudStorageConfig();
  assert.equal(lido?.secretAccessKey, 'ainda-em-claro');
});

test('cifrado ILEGÍVEL: para e grita, nunca usa o ciphertext como senha', async () => {
  const { svc, erros } = montar({
    raw: JSON.stringify({ ...CONFIG_BASE, secretAccessKey: 'enc:qualquercoisa' }),
    cryptoQuebrado: true,
  });
  const lido = await svc.getCloudStorageConfig();

  assert.equal(lido, null, 'assinar com o ciphertext geraria SignatureDoesNotMatch silencioso por horas');
  assert.ok(erros.some((m) => m.includes('ILEGÍVEL')), 'a causa (chave mestra trocada?) tem de estar no log');
});

test('falha ao CIFRAR não perde a config — comportamento antigo é o fallback', () => {
  // Perder a config custaria o offload inteiro; o risco em repouso é menor.
  const { svc } = montar({ cryptoQuebrado: true });
  const resultado = svc.cifrarSegredoStorage({ ...CONFIG_BASE, secretAccessKey: 'segredo' });
  assert.equal(resultado.secretAccessKey, 'segredo');
});
