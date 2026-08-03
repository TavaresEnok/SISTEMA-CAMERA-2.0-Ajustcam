import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudStorageAdminService } from '../src/cloud-storage/cloud-storage-admin.service';
import { CloudStorageResolverService } from '../src/cloud-storage/cloud-storage-resolver.service';

// ─────────────────────────────────────────────────────────────────────────────
// ESVAZIAR × REMOVER — duas operações que parecem a mesma e não são
//
//   ESVAZIAR  apaga os OBJETOS no fornecedor. O acervo daquele storage deixa de
//             existir. Irreversível. É como se para de pagar por um bucket.
//
//   REMOVER   apaga só o CADASTRO aqui. Os objetos ficam intactos lá.
//
// Trocar uma pela outra é como se perde prova (esvaziar achando que só ia
// descadastrar) ou como se paga por lixo eterno (remover achando que limpou).
// Estes testes travam as barreiras que impedem cada um dos dois enganos.
//
// Trava também a ARQUIVAÇÃO AUTOMÁTICA na troca de fornecedor: sem ela não
// existe "storage anterior" para esvaziar nem para remover, e "migrar" volta a
// significar "perder".
// ─────────────────────────────────────────────────────────────────────────────

const ANTIGO = {
  id: 'st-antigo', name: 'Eveo 1T', provider: 's3',
  endpoint: 'http://antigo:9000', region: 'us-east-1', bucket: 'acervo-1t',
  prefix: '', accessKeyId: 'AK', secretAccessKeyEncrypted: 'cifrado:SEGREDO',
  forcePathStyle: true, isActive: false, createdAt: new Date(), updatedAt: new Date(),
};

function makeAdmin(over: Record<string, unknown> = {}) {
  const svc: any = Object.create(CloudStorageAdminService.prototype);
  svc.logger = { warn() {}, log() {} };
  svc.resolver = {
    materializar: (r: any) => ({ ...r, secretAccessKey: 'SEGREDO', enabled: true, mode: 'tier' }),
    clienteDe: () => ({ listObjectsPage: async () => ({ objects: [], nextToken: null }), deleteObject: async () => {} }),
  };
  svc.prisma = {
    cloudStorage: { findUnique: async () => ANTIGO, findMany: async () => [ANTIGO], delete: async () => ANTIGO },
    recording: { count: async () => 0, updateMany: async () => ({ count: 0 }), groupBy: async () => [] },
  };
  Object.assign(svc, over);
  return svc;
}

// ── ESVAZIAR ────────────────────────────────────────────────────────────────

test('esvaziar EXIGE o nome do bucket como confirmação', async () => {
  const svc = makeAdmin();
  await assert.rejects(() => svc.esvaziar('st-antigo', ''), /nome do bucket/);
  await assert.rejects(() => svc.esvaziar('st-antigo', 'acervo-1'), /nome do bucket/);
  await assert.doesNotReject(() => svc.esvaziar('st-antigo', 'acervo-1t'));
});

test('esvaziar RECUSA o storage que está recebendo gravação agora', async () => {
  const svc = makeAdmin({
    prisma: {
      cloudStorage: { findUnique: async () => ({ ...ANTIGO, isActive: true }) },
      recording: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
    },
  });
  await assert.rejects(
    () => svc.esvaziar('st-antigo', 'acervo-1t'),
    /recebendo as gravações/,
    'apagar embaixo do offload em curso deixaria arquivo pela metade',
  );
});

test('esvaziar PAGINA até o fim — o teto de 1000 chaves não pode virar "pronto"', async () => {
  const apagadas: string[] = [];
  const paginas = [
    { objects: [{ key: 'a', size: 10 }, { key: 'b', size: 20 }], nextToken: 't1' },
    { objects: [{ key: 'c', size: 30 }], nextToken: 't2' },
    { objects: [{ key: 'd', size: 40 }], nextToken: null },
  ];
  let i = 0;
  const svc = makeAdmin({
    resolver: {
      materializar: (r: any) => ({ ...r, secretAccessKey: 'S' }),
      clienteDe: () => ({
        listObjectsPage: async (_p: string, token: string | null) => {
          assert.equal(token, i === 0 ? null : paginas[i - 1].nextToken, 'a página seguinte tem de usar o token da anterior');
          return paginas[i++];
        },
        deleteObject: async (k: string) => { apagadas.push(k); },
      }),
    },
  });
  const r = await svc.esvaziar('st-antigo', 'acervo-1t');
  assert.deepEqual(apagadas, ['a', 'b', 'c', 'd']);
  assert.equal(r.objetosApagados, 4);
  assert.equal(r.bytesLiberados, 100);
});

test('uma chave que resiste não aborta o resto, e a falha é contada', async () => {
  const svc = makeAdmin({
    resolver: {
      materializar: (r: any) => ({ ...r, secretAccessKey: 'S' }),
      clienteDe: () => ({
        listObjectsPage: async () => ({ objects: [{ key: 'a', size: 1 }, { key: 'trava', size: 1 }, { key: 'c', size: 1 }], nextToken: null }),
        deleteObject: async (k: string) => { if (k === 'trava') throw new Error('AccessDenied'); },
      }),
    },
  });
  const r = await svc.esvaziar('st-antigo', 'acervo-1t');
  assert.equal(r.objetosApagados, 2, 'as outras duas foram apagadas');
  assert.equal(r.falhas, 1, 'e o operador fica sabendo que sobrou uma');
});

test('esvaziar TIRA a cópia na nuvem das gravações, mas não apaga a linha', async () => {
  let update: any = null;
  const svc = makeAdmin({
    prisma: {
      cloudStorage: { findUnique: async () => ANTIGO },
      recording: {
        count: async () => 0,
        updateMany: async (args: any) => { update = args; return { count: 7 }; },
      },
    },
  });
  const r = await svc.esvaziar('st-antigo', 'acervo-1t');
  assert.equal(r.gravacoesAfetadas, 7);
  assert.deepEqual(update.where, { cloudStorageId: 'st-antigo' });
  assert.deepEqual(update.data, { cloudKey: null, cloudUploadedAt: null });
  // Apagar a LINHA esconderia do operador que aquele acervo existiu; e se ainda
  // houver arquivo local, a gravação continua tocando.
});

test('esvaziar recusa quando a credencial não abre — o botão não pode só dar erro no meio', async () => {
  const svc = makeAdmin({ resolver: { materializar: () => null, clienteDe: () => { throw new Error('não devia chegar aqui'); } } });
  await assert.rejects(() => svc.esvaziar('st-antigo', 'acervo-1t'), /não pôde ser decifrada/);
});

// ── REMOVER ─────────────────────────────────────────────────────────────────

test('remover RECUSA enquanto houver gravação lá', async () => {
  const svc = makeAdmin({
    prisma: {
      cloudStorage: { findUnique: async () => ANTIGO, delete: async () => { throw new Error('não devia apagar'); } },
      recording: { count: async () => 42 },
    },
  });
  await assert.rejects(() => svc.remover('st-antigo'), /42 gravações/);
});

test('remover FORÇADO passa, e devolve quantas ficaram órfãs', async () => {
  let apagou = false;
  const svc = makeAdmin({
    prisma: {
      cloudStorage: { findUnique: async () => ANTIGO, delete: async () => { apagou = true; return ANTIGO; } },
      recording: { count: async () => 42 },
    },
  });
  const r = await svc.remover('st-antigo', true);
  assert.ok(apagou);
  assert.equal(r.gravacoesOrfas, 42, 'o número é o custo da decisão, e tem de voltar para a tela');
});

test('remover NÃO apaga nenhum objeto no fornecedor', async () => {
  const svc = makeAdmin({
    resolver: {
      materializar: (r: any) => r,
      clienteDe: () => { throw new Error('remover não pode tocar no bucket'); },
    },
  });
  await assert.doesNotReject(() => svc.remover('st-antigo'));
});

test('remover recusa o storage ativo', async () => {
  const svc = makeAdmin({
    prisma: {
      cloudStorage: { findUnique: async () => ({ ...ANTIGO, isActive: true }) },
      recording: { count: async () => 0 },
    },
  });
  await assert.rejects(() => svc.remover('st-antigo'), /recebendo as gravações/);
});

// ── ARQUIVAÇÃO AUTOMÁTICA NA TROCA ──────────────────────────────────────────

function makeResolver(over: Record<string, unknown> = {}) {
  const svc: any = Object.create(CloudStorageResolverService.prototype);
  svc.logger = { warn() {}, log() {} };
  svc.crypto = { decrypt: (v: string) => v.replace(/^cifrado:/, ''), encrypt: (v: string) => `cifrado:${v}` };
  svc.prisma = {
    cloudStorage: { findFirst: async () => null, findUnique: async () => null, findMany: async () => [], count: async () => 0 },
    $transaction: async (fn: any) => fn(svc.prisma),
  };
  svc.cloudConnector = { getCloudStorageConfig: async () => null };
  Object.assign(svc, over);
  return svc;
}

const NOVO_PROVISIONADO = {
  enabled: true, mode: 'tier', name: 'Backblaze 10T', provider: 's3',
  endpoint: 'http://novo:9000', region: 'us-east-1', bucket: 'acervo-10t',
  prefix: '', accessKeyId: 'AK2', secretAccessKey: 'SEGREDO2',
  localWindowHours: 24, forcePathStyle: true, updatedAt: new Date().toISOString(),
};

test('trocar de fornecedor DESATIVA o anterior antes de ativar o novo', async () => {
  const ordem: string[] = [];
  const criado = { ...ANTIGO, id: 'st-novo', bucket: 'acervo-10t', endpoint: 'http://novo:9000', isActive: true };
  const svc = makeResolver({
    cloudConnector: { getCloudStorageConfig: async () => NOVO_PROVISIONADO },
  });
  svc.prisma = {
    cloudStorage: {
      findFirst: async () => null,
      findUnique: async () => criado,
      count: async () => 1,
      updateMany: async () => { ordem.push('desativa-todos'); return { count: 1 }; },
      create: async () => { ordem.push('cria-ativo'); return criado; },
    },
    recording: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (fn: any) => fn(svc.prisma),
  };

  const r = await svc.storageParaEscrita();
  assert.equal(r.bucket, 'acervo-10t');
  assert.deepEqual(ordem, ['desativa-todos', 'cria-ativo'],
    'a ordem inversa esbarraria no índice único parcial e deixaria o storage novo sem receber nada');
});

test('rotacionar a credencial do MESMO bucket não cria um segundo cadastro', async () => {
  let criou = false;
  const mesmoEndereco = { ...ANTIGO, isActive: true, accessKeyId: 'AK-VELHA' };
  const svc = makeResolver({
    cloudConnector: {
      getCloudStorageConfig: async () => ({
        ...NOVO_PROVISIONADO, endpoint: ANTIGO.endpoint, bucket: ANTIGO.bucket, prefix: '', accessKeyId: 'AK-NOVA',
      }),
    },
  });
  svc.prisma = {
    cloudStorage: {
      findFirst: async () => mesmoEndereco,
      findUnique: async () => ({ ...mesmoEndereco, accessKeyId: 'AK-NOVA' }),
      count: async () => 1,
      updateMany: async () => ({ count: 1 }),
      update: async () => mesmoEndereco,
      create: async () => { criou = true; return mesmoEndereco; },
    },
    recording: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (fn: any) => fn(svc.prisma),
  };

  await svc.storageParaEscrita();
  assert.equal(criou, false,
    'dois cadastros no mesmo endereço disputariam os mesmos objetos, e a varredura de órfãos apagaria o que o outro ainda usa');
});

test('no PRIMEIRO cadastro, as gravações que já estão na nuvem são ancoradas ali', async () => {
  let ancoragem: any = null;
  const criado = { ...ANTIGO, isActive: true };
  const svc = makeResolver({ cloudConnector: { getCloudStorageConfig: async () => NOVO_PROVISIONADO } });
  svc.prisma = {
    cloudStorage: {
      findFirst: async () => null,
      findUnique: async () => criado,
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
      create: async () => criado,
    },
    recording: { updateMany: async (args: any) => { ancoragem = args; return { count: 12 }; } },
    $transaction: async (fn: any) => fn(svc.prisma),
  };

  await svc.storageParaEscrita();
  assert.deepEqual(ancoragem.where, { cloudStorageId: null, cloudKey: { not: null } });
  assert.equal(ancoragem.data.cloudStorageId, ANTIGO.id,
    'é a ÚNICA chance de saber onde elas moram: depois de uma troca ninguém mais sabe dizer');
});

test('a partir do SEGUNDO cadastro NÃO ancora nada — seria roubar acervo do outro storage', async () => {
  let ancorou = false;
  const criado = { ...ANTIGO, id: 'st-novo', isActive: true };
  const svc = makeResolver({ cloudConnector: { getCloudStorageConfig: async () => NOVO_PROVISIONADO } });
  svc.prisma = {
    cloudStorage: {
      findFirst: async () => null,
      findUnique: async () => criado,
      count: async () => 1,
      updateMany: async () => ({ count: 1 }),
      create: async () => criado,
    },
    recording: { updateMany: async () => { ancorou = true; return { count: 0 }; } },
    $transaction: async (fn: any) => fn(svc.prisma),
  };

  await svc.storageParaEscrita();
  assert.equal(ancorou, false);
});

test('sem storage provisionado nada novo sobe, mas os anteriores continuam legíveis', async () => {
  const svc = makeResolver({
    cloudConnector: { getCloudStorageConfig: async () => null },
    prisma: {
      cloudStorage: {
        findFirst: async () => null,
        findUnique: async () => ANTIGO,
        findMany: async () => [ANTIGO],
        count: async () => 1,
      },
    },
  });
  assert.equal(await svc.storageParaEscrita(), null, 'desligar o envio para de escrever');
  const leitura = await svc.storageDaGravacao('st-antigo');
  assert.equal(leitura.bucket, 'acervo-1t', 'mas o que já subiu continua alcançável');
});

// ── EXCLUIR NA CENTRAL: PARA ONDE VÃO AS GRAVAÇÕES ──────────────────────────
//
// Antes, sem storage provisionado, isto caía no registro que ESTAVA ativo e
// continuava enviando para ele — excluir na Central não parava nada. O registro
// só é "o ativo" porque a Central um dia disse que era; quando ela para de
// dizer, ele deixa de ser.

function comEstado(estado: string, storages: any[], over: Record<string, unknown> = {}) {
  const svc = makeResolver({ cloudConnector: { getCloudStorageConfig: async () => null, getCloudStorageState: async () => estado } });
  const desativados: string[] = [];
  const ativados: string[] = [];
  svc.prisma = {
    cloudStorage: {
      findFirst: async (args: any) => (args?.where?.isActive ? storages.find((s) => s.isActive) ?? null : storages[0] ?? null),
      findUnique: async () => storages[0] ?? null,
      updateMany: async () => { desativados.push('todos'); return { count: 1 }; },
      update: async (args: any) => { ativados.push(args.where.id); return storages[0]; },
      count: async () => storages.length,
    },
    recording: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (fn: any) => fn(svc.prisma),
  };
  Object.assign(svc, over);
  return { svc, desativados, ativados };
}

test('excluído COM outro storage: o outro assume as gravações novas', async () => {
  const outro = { ...ANTIGO, id: 'st-outro', name: 'Backblaze 10T', bucket: 'acervo-10t', isActive: false };
  const { svc, ativados } = comEstado('absent', [outro]);
  const r = await svc.storageParaEscrita();
  assert.equal(r.bucket, 'acervo-10t');
  assert.deepEqual(ativados, ['st-outro'], 'assumir significa virar o ativo, não só ser devolvido uma vez');
});

test('excluído SEM outro storage: nada sobe e as gravações ficam no disco local', async () => {
  const { svc, desativados } = comEstado('absent', []);
  assert.equal(await svc.storageParaEscrita(), null);
  assert.deepEqual(desativados, [], 'sem registro nenhum não há o que desativar');
});

test('excluído, mas o candidato tem credencial ilegível: disco local, sem laço de erro', async () => {
  const quebrado = { ...ANTIGO, secretAccessKeyEncrypted: 'ilegivel' };
  const { svc } = comEstado('absent', [quebrado], {
    crypto: { decrypt: () => { throw new Error('chave mestra trocada'); }, encrypt: (v: string) => v },
  });
  assert.equal(await svc.storageParaEscrita(), null,
    'promover um storage que não abre faria o upload falhar em laço sem ninguém saber por quê');
});

test('DESABILITADO não promove ninguém — pausa não é exclusão', async () => {
  const outro = { ...ANTIGO, id: 'st-outro', bucket: 'acervo-10t', isActive: false };
  const { svc, ativados } = comEstado('disabled', [outro]);
  assert.equal(await svc.storageParaEscrita(), null);
  assert.deepEqual(ativados, [], 'se outro assumisse, desligar o envio não desligaria nada');
});

test('pausado, o storage que estava ativo DEIXA de receber', async () => {
  const ativo = { ...ANTIGO, isActive: true };
  const { svc, desativados } = comEstado('disabled', [ativo]);
  assert.equal(await svc.storageParaEscrita(), null);
  assert.deepEqual(desativados, ['todos'],
    'antes isto continuava devolvendo o ativo, e excluir/desligar na Central não parava o envio');
});

test('Central antiga (sem o campo) é tratada como PAUSA, nunca como exclusão', async () => {
  const outro = { ...ANTIGO, id: 'st-outro', isActive: false };
  const { svc, ativados } = comEstado('', [outro]);
  assert.equal(await svc.storageParaEscrita(), null);
  assert.deepEqual(ativados, [],
    'promover storage sozinho ressuscitaria contrato cancelado e voltaria a gerar custo — o erro caro é esse');
});

test('excluir NÃO torna o acervo ilegível: a leitura continua resolvendo pela origem', async () => {
  const { svc } = comEstado('absent', []);
  svc.prisma.cloudStorage.findUnique = async () => ANTIGO;
  const leitura = await svc.storageDaGravacao('st-antigo');
  assert.equal(leitura.bucket, 'acervo-1t',
    'excluir tira o DESTINO das gravações novas, não o acesso ao que já foi gravado');
});
