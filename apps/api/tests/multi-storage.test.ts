import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudStorageResolverService } from '../src/cloud-storage/cloud-storage-resolver.service';

// ─────────────────────────────────────────────────────────────────────────────
// VÁRIOS STORAGES POR INSTALAÇÃO
//
// O caso real: cliente contrata 1 TB, cresce, e migra para 10 TB de outro
// fornecedor sem querer perder o histórico.
//
// Antes, existia UMA configuração e a gravação guardava só `cloudKey` — sem
// registrar em qual bucket o objeto está. Trocar de fornecedor apontava o
// playback para o bucket novo procurando chaves do antigo: o acervo inteiro
// sumia da tela, os dados ficavam inalcançáveis, e a retenção também deixava de
// limpá-los.
//
// A regra que resolve, e que estes testes travam:
//   ESCRITA → sempre no storage ATIVO
//   LEITURA → sempre no storage DE ORIGEM da gravação
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRO = {
  id: 'st-antigo', name: 'Eveo 1T', provider: 's3',
  endpoint: 'http://antigo:9000', region: 'us-east-1', bucket: 'acervo-1t',
  prefix: '', accessKeyId: 'AK', secretAccessKeyEncrypted: 'cifrado:SEGREDO',
  forcePathStyle: true, updatedAt: new Date(),
};

function makeResolver(over: Record<string, unknown> = {}) {
  const svc: any = Object.create(CloudStorageResolverService.prototype);
  svc.logger = { warn() {}, log() {} };
  svc.crypto = { decrypt: (v: string) => v.replace(/^cifrado:/, '') };
  svc.prisma = { cloudStorage: { findFirst: async () => null, findUnique: async () => null, findMany: async () => [] } };
  svc.cloudConnector = { getCloudStorageConfig: async () => null };
  Object.assign(svc, over);
  return svc;
}

test('a ESCRITA vai para o storage que a Central provisiona', async () => {
  // A versão antiga deste teste montava só uma linha `isActive` e nem
  // provisionava nada — codificando a precedência que deixava a EXCLUSÃO sem
  // efeito: sem configuração da Central, o registro que estava ativo continuava
  // recebendo, e excluir o storage no painel não parava o envio. Um registro só
  // é "o ativo" porque a Central um dia disse que era.
  const novo = { ...REGISTRO, id: 'st-novo', name: 'Contabo 10T', bucket: 'acervo-10t', isActive: true };
  const svc = makeResolver({
    cloudConnector: {
      getCloudStorageConfig: async () => ({
        enabled: true, mode: 'tier', name: 'Contabo 10T', provider: 's3',
        endpoint: novo.endpoint, region: 'us-east-1', bucket: 'acervo-10t', prefix: '',
        accessKeyId: 'AK', secretAccessKey: 'SEGREDO', localWindowHours: 24,
        forcePathStyle: true, updatedAt: null,
      }),
      getCloudStorageState: async () => 'configured',
    },
    prisma: { cloudStorage: { findFirst: async () => novo, findUnique: async () => novo, count: async () => 1 } },
  });
  const destino = await svc.storageParaEscrita();
  assert.equal(destino.id, 'st-novo');
  assert.equal(destino.bucket, 'acervo-10t');
});

test('a LEITURA vai para o storage de ORIGEM, nunca para o ativo', async () => {
  // Esta é a garantia central da migração: uma gravação feita no bucket de 1 TB
  // continua sendo lida de lá, mesmo com o de 10 TB já ativo.
  const svc = makeResolver({
    prisma: { cloudStorage: {
      findFirst: async () => ({ ...REGISTRO, id: 'st-novo', bucket: 'acervo-10t' }),
      findUnique: async ({ where }: any) => (where.id === 'st-antigo' ? REGISTRO : null),
    }},
  });
  const origem = await svc.storageDaGravacao('st-antigo');
  assert.equal(origem.bucket, 'acervo-1t', 'ler do ativo faria o acervo antigo sumir da tela');
});

test('gravação sem storage vinculado cai no LEGADO, sem backfill', async () => {
  // Instalações anteriores a esta funcionalidade têm cloudStorageId NULL em todo
  // o acervo. Elas precisam continuar funcionando byte a byte.
  const svc = makeResolver({
    cloudConnector: { getCloudStorageConfig: async () => ({ enabled: true, bucket: 'legado', endpoint: 'http://x', region: 'us-east-1', prefix: '', accessKeyId: 'a', secretAccessKey: 'b', forcePathStyle: true, mode: 'tier', provider: 's3', localWindowHours: 24, updatedAt: null }) },
  });
  const origem = await svc.storageDaGravacao(null);
  assert.equal(origem.bucket, 'legado');
  assert.equal(origem.id, null, 'o legado não tem id — é a configuração única');
});

test('storage apagado do cadastro NÃO cai no ativo em silêncio', async () => {
  // Buscar no bucket errado devolveria "não encontrado" e pareceria arquivo
  // corrompido. Devolver null deixa a causa explícita no log.
  const svc = makeResolver({
    prisma: { cloudStorage: {
      findFirst: async () => ({ ...REGISTRO, id: 'st-novo' }),
      findUnique: async () => null,
    }},
  });
  assert.equal(await svc.storageDaGravacao('st-que-nao-existe'), null);
});

test('credencial ilegível não vira cliente com segredo vazio', async () => {
  // Chave mestra trocada: falharia no S3 com erro de autenticação confuso.
  const svc = makeResolver({
    crypto: { decrypt: () => { throw new Error('chave inválida'); } },
    prisma: { cloudStorage: { findUnique: async () => REGISTRO } },
  });
  assert.equal(await svc.storageDaGravacao('st-antigo'), null);
});

test('sem nenhum storage cadastrado, a escrita cai no legado', async () => {
  const svc = makeResolver({
    cloudConnector: { getCloudStorageConfig: async () => ({ enabled: true, bucket: 'legado', endpoint: 'http://x', region: 'us-east-1', prefix: '', accessKeyId: 'a', secretAccessKey: 'b', forcePathStyle: true, mode: 'tier', provider: 's3', localWindowHours: 24, updatedAt: null }) },
  });
  const destino = await svc.storageParaEscrita();
  assert.equal(destino.bucket, 'legado');
});

test('todosOsStorages devolve os cadastrados; sem eles, o legado', async () => {
  const comCadastro = makeResolver({
    prisma: { cloudStorage: { findMany: async () => [REGISTRO, { ...REGISTRO, id: 'st-novo', name: '10T' }] } },
  });
  assert.equal((await comCadastro.todosOsStorages()).length, 2);

  const semCadastro = makeResolver({
    cloudConnector: { getCloudStorageConfig: async () => ({ enabled: true, bucket: 'legado', endpoint: 'http://x', region: 'us-east-1', prefix: '', accessKeyId: 'a', secretAccessKey: 'b', forcePathStyle: true, mode: 'tier', provider: 's3', localWindowHours: 24, updatedAt: null }) },
  });
  assert.equal((await semCadastro.todosOsStorages()).length, 1);
});

test('o banco garante UM ativo só — não a disciplina do código', () => {
  // Dois ativos fariam gravações irem para buckets diferentes de forma
  // imprevisível, e ninguém descobriria até precisar da prova.
  const sql = require('fs').readFileSync(
    'prisma/migrations/20260803180000_multi_cloud_storage/migration.sql', 'utf8');
  assert.ok(/CREATE UNIQUE INDEX[^;]*"isActive"[^;]*WHERE "isActive" = true/s.test(sql),
    'a unicidade do ativo precisa ser garantida pelo banco');
});

test('apagar um storage NÃO apaga as gravações em cascata', () => {
  // A linha precisa sobreviver apontando para o legado; descobrir depois que a
  // prova sumiu do banco junto com a configuração seria irreversível.
  const sql = require('fs').readFileSync(
    'prisma/migrations/20260803180000_multi_cloud_storage/migration.sql', 'utf8');
  assert.ok(/ON DELETE SET NULL/.test(sql), 'a FK precisa ser SET NULL, nunca CASCADE');
});
