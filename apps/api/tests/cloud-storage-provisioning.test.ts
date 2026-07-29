import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudConnectorService } from '../src/cloud-connector/cloud-connector.service';

// ─────────────────────────────────────────────────────────────────────────────
// A INSTALAÇÃO RECEBENDO O STORAGE PROVISIONADO PELA CENTRAL.
//
// A config desce na resposta do heartbeat — mesmo canal da política de IA. O
// que estes testes travam é o comportamento diante de config RUIM, porque é
// nele que se perde vídeo em silêncio:
//
//  · config pela METADE (sem bucket, sem credencial, endpoint sem esquema) é
//    tratada como AUSENTE. Ligar meio configurado faria a instalação tentar
//    subir gravação para lugar nenhum, falhar em laço e encher o log — enquanto
//    o operador acha que provisionou;
//  · `enabled` diferente de `true` DESLIGA. É assim que o operador remove o
//    storage pelo painel, sem entrar na instalação;
//  · o modo desconhecido cai em `tier`, nunca em `mount` — o modo direto tem
//    risco real e não pode ser ativado por um payload torto.
// ─────────────────────────────────────────────────────────────────────────────

const svc = Object.create(CloudConnectorService.prototype) as any;
const normalize = (raw: unknown) => svc.normalizeCloudStorage(raw);

const COMPLETA = {
  enabled: true,
  mode: 'tier',
  provider: 'minio',
  endpoint: 'http://168.194.13.18:9100',
  region: 'us-east-1',
  bucket: 'meu-storage',
  prefix: 'inst-1',
  accessKeyId: 'AK123',
  secretAccessKey: 'SEGREDO',
  localWindowHours: 12,
  forcePathStyle: true,
};

test('config completa é aceita e preservada', () => {
  const c = normalize(COMPLETA);
  assert.ok(c);
  assert.equal(c.bucket, 'meu-storage');
  assert.equal(c.secretAccessKey, 'SEGREDO');
  assert.equal(c.localWindowHours, 12);
  assert.equal(c.mode, 'tier');
});

test('enabled ausente/false DESLIGA (é como o painel remove o storage)', () => {
  assert.equal(normalize({ ...COMPLETA, enabled: false }), null);
  assert.equal(normalize({ ...COMPLETA, enabled: undefined }), null);
  assert.equal(normalize(null), null);
  assert.equal(normalize('lixo'), null);
});

test('config pela METADE é tratada como ausente (não tenta subir para lugar nenhum)', () => {
  assert.equal(normalize({ ...COMPLETA, bucket: '' }), null, 'sem bucket');
  assert.equal(normalize({ ...COMPLETA, accessKeyId: '' }), null, 'sem access key');
  assert.equal(normalize({ ...COMPLETA, secretAccessKey: '' }), null, 'sem segredo');
  assert.equal(normalize({ ...COMPLETA, endpoint: '' }), null, 'sem endpoint');
});

test('endpoint sem esquema é recusado (erro de digitação comum)', () => {
  assert.equal(normalize({ ...COMPLETA, endpoint: '168.194.13.18:9100' }), null);
  assert.ok(normalize({ ...COMPLETA, endpoint: 'https://s3.exemplo.com' }));
});

test('modo desconhecido cai em tier — NUNCA em mount por acidente', () => {
  assert.equal(normalize({ ...COMPLETA, mode: 'inventado' }).mode, 'tier');
  assert.equal(normalize({ ...COMPLETA, mode: undefined }).mode, 'tier');
  // Mount só quando pedido explicitamente.
  assert.equal(normalize({ ...COMPLETA, mode: 'mount' }).mode, 'mount');
});

test('janela local fora da faixa cai no default (não vira 0 nem infinita)', () => {
  assert.equal(normalize({ ...COMPLETA, localWindowHours: 0 }).localWindowHours, 24);
  assert.equal(normalize({ ...COMPLETA, localWindowHours: -5 }).localWindowHours, 24);
  assert.equal(normalize({ ...COMPLETA, localWindowHours: 99999 }).localWindowHours, 24);
  assert.equal(normalize({ ...COMPLETA, localWindowHours: 'abc' }).localWindowHours, 24);
});

test('forcePathStyle só é falso quando explicitamente falso (MinIO em IP exige path)', () => {
  assert.equal(normalize({ ...COMPLETA, forcePathStyle: undefined }).forcePathStyle, true);
  assert.equal(normalize({ ...COMPLETA, forcePathStyle: false }).forcePathStyle, false);
});

test('espaços em volta dos campos não quebram a config', () => {
  const c = normalize({ ...COMPLETA, bucket: '  meu-storage  ', accessKeyId: ' AK123 ' });
  assert.equal(c.bucket, 'meu-storage');
  assert.equal(c.accessKeyId, 'AK123');
});
