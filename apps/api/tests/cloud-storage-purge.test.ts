import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudStorageResolverService } from '../src/cloud-storage/cloud-storage-resolver.service';

// ── EXCLUIR O STORAGE NA CENTRAL LIMPA O SISTEMA ────────────────────────────
//
// Decisão do dono: excluir na Central significa "não usamos mais este storage,
// e o conteúdo dele já foi embora". Manter as linhas apontando para ele faz o
// banco MENTIR — a régua pinta verde onde não há vídeo nenhum, e o operador
// descobre no pior momento possível.
//
// A regra depende de a gravação ter, ou não, cópia local:
//   · sem cópia local → o vídeo não existe em lugar nenhum: linha REMOVIDA;
//   · com cópia local → o vídeo está no disco: linha FICA, campos de nuvem
//     limpos, e ela volta a ser uma gravação local comum.

type Chamada = { op: string; where?: any; data?: any };

function montar(opcoes: {
  remocoes: Array<{ endpoint: string; bucket: string; prefix: string }>;
  storage: any | null;
}) {
  const chamadas: Chamada[] = [];
  const logs: string[] = [];
  const svc: any = Object.create(CloudStorageResolverService.prototype);
  svc.logger = { warn: (m: string) => logs.push(m), log: (m: string) => logs.push(m), error: () => {} };
  svc.cloudConnector = { getCloudStorageRemovals: async () => opcoes.remocoes };
  svc.prisma = {
    cloudStorage: {
      findFirst: async ({ where }: any) => {
        chamadas.push({ op: 'buscaStorage', where });
        return opcoes.storage;
      },
      delete: async ({ where }: any) => { chamadas.push({ op: 'apagaStorage', where }); },
    },
    recording: {
      deleteMany: async ({ where }: any) => { chamadas.push({ op: 'apagaGravacoes', where }); return { count: 12443 }; },
      updateMany: async ({ where, data }: any) => { chamadas.push({ op: 'limpaCampos', where, data }); return { count: 57 }; },
    },
  };
  return { svc, chamadas, logs };
}

const STORAGE = { id: 'st-1', name: 'Eveo', bucket: 'grupo-flash-01', isActive: false };
const REMOCAO = { endpoint: 'https://object.sp2.eveo.com.br', bucket: 'grupo-flash-01', prefix: 'inst-1' };

test('gravação SEM cópia local tem a linha REMOVIDA; com cópia local, só os campos de nuvem', async () => {
  const { svc, chamadas } = montar({ remocoes: [REMOCAO], storage: STORAGE });
  const feitos = await svc.expurgarStoragesRemovidos();

  const apaga = chamadas.find((c) => c.op === 'apagaGravacoes');
  assert.ok(apaga, 'as gravações sem lastro precisam sair do banco');
  assert.deepEqual(apaga!.where.localDeletedAt, { not: null }, 'só as que NÃO têm arquivo local');

  const limpa = chamadas.find((c) => c.op === 'limpaCampos');
  assert.ok(limpa, 'as que têm arquivo local continuam existindo');
  assert.equal(limpa!.data.cloudKey, null);
  assert.equal(limpa!.data.cloudStorageId, null);
  assert.equal(limpa!.data.cloudUploadedAt, null);

  assert.deepEqual(feitos, [{ bucket: 'grupo-flash-01', linhasRemovidas: 12443, linhasLocais: 57 }]);
});

test('ORDEM: gravações ANTES do storage — senão cloudStorageId vira null e elas seguem o bucket ativo', async () => {
  // A relação é onDelete: SetNull. Apagar o storage primeiro transformaria
  // cada gravação em "storage legado", que segue o bucket ATIVO — trocar um
  // registro obsoleto por um ponteiro errado.
  const { svc, chamadas } = montar({ remocoes: [REMOCAO], storage: STORAGE });
  await svc.expurgarStoragesRemovidos();
  const ordem = chamadas.map((c) => c.op);
  assert.ok(ordem.indexOf('apagaGravacoes') < ordem.indexOf('apagaStorage'), ordem.join(' → '));
  assert.ok(ordem.indexOf('limpaCampos') < ordem.indexOf('apagaStorage'), ordem.join(' → '));
});

test('storage ATIVO nunca é expurgado — a Central voltou a provisioná-lo', async () => {
  const { svc, chamadas } = montar({ remocoes: [REMOCAO], storage: { ...STORAGE, isActive: true } });
  const feitos = await svc.expurgarStoragesRemovidos();
  assert.deepEqual(feitos, []);
  assert.ok(!chamadas.some((c) => c.op === 'apagaGravacoes'), 'expurgar o destino em uso destruiria o acervo vivo');
});

test('lápide de storage que esta instalação nunca teve é ignorada', async () => {
  const { svc, chamadas } = montar({ remocoes: [REMOCAO], storage: null });
  assert.deepEqual(await svc.expurgarStoragesRemovidos(), []);
  assert.ok(!chamadas.some((c) => c.op === 'apagaGravacoes'));
});

test('lápide incompleta (sem bucket) não vira expurgo às cegas', async () => {
  const { svc, chamadas } = montar({ remocoes: [{ endpoint: 'https://x', bucket: '', prefix: '' }], storage: STORAGE });
  await svc.expurgarStoragesRemovidos();
  assert.deepEqual(chamadas, [], 'sem endereço completo não há o que casar — e apagar por engano é irreversível');
});

test('a identidade casada é endpoint+bucket+prefixo', async () => {
  const { svc, chamadas } = montar({ remocoes: [REMOCAO], storage: STORAGE });
  await svc.expurgarStoragesRemovidos();
  assert.deepEqual(chamadas[0].where, {
    endpoint: REMOCAO.endpoint, bucket: REMOCAO.bucket, prefix: REMOCAO.prefix,
  });
});

test('sem exclusões, não toca em nada', async () => {
  const { svc, chamadas } = montar({ remocoes: [], storage: STORAGE });
  assert.deepEqual(await svc.expurgarStoragesRemovidos(), []);
  assert.deepEqual(chamadas, []);
});

test('o expurgo é REGISTRADO com os números — perda de registro não pode ser silenciosa', async () => {
  const { svc, logs } = montar({ remocoes: [REMOCAO], storage: STORAGE });
  await svc.expurgarStoragesRemovidos();
  const aviso = logs.find((m) => m.includes('EXCLUÍDO'));
  assert.ok(aviso, 'sem log, ninguém sabe que 12 mil registros sumiram');
  assert.ok(aviso!.includes('12443') && aviso!.includes('57'), aviso);
});
