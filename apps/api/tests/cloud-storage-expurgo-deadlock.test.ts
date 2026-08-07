import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudStorageResolverService } from '../src/cloud-storage/cloud-storage-resolver.service';

// ─────────────────────────────────────────────────────────────────────────────
// DEADLOCK DO EXPURGO (incidente de 07/08/2026).
//
// O dono excluiu o storage na Central. O provisionamento sumiu e a lápide
// chegou — mas a exclusão nunca se concretizava na instalação:
//
//   · sem provisionamento, o fallback promovia "a linha mais recente da
//     tabela" a destino ativo — o PRÓPRIO storage excluído, que ainda estava
//     na tabela justamente porque o expurgo não tinha rodado;
//   · e o expurgo pulava linha ativa ("se está ativa, a exclusão foi
//     desfeita").
//
// O excluído se reelegia para sempre, e o offload seguia batendo na credencial
// morta a cada ciclo. Estes testes reproduzem o cenário com os dados reais do
// incidente.
// ─────────────────────────────────────────────────────────────────────────────

const EVEO = {
  id: 'st-eveo',
  name: 'Teste do storage Eveo',
  endpoint: 'https://object.sp2.eveo.com.br',
  bucket: 'grupo-flash-01',
  prefix: 'drac-local',
  isActive: true,
  createdAt: new Date('2026-08-04'),
  accessKeyId: 'AKIA-MORTA',
  secretAccessKeyEncrypted: 'enc:xxx',
};

function montar(opcoes: {
  linhas: any[];
  lapides?: any[];
  provisionado?: any | null;
  estado?: string;
}) {
  const acoes: string[] = [];
  const svc: any = Object.create(CloudStorageResolverService.prototype);
  svc.logger = { warn: () => {}, log: () => {}, error: () => {} };
  svc.cloudConnector = {
    getCloudStorageRemovals: async () => opcoes.lapides ?? [],
    getCloudStorageState: async () => opcoes.estado ?? 'absent',
    getCloudStorageConfig: async () => opcoes.provisionado ?? null,
  };
  svc.crypto = { decrypt: () => 'segredo' };
  svc.prisma = {
    cloudStorage: {
      findFirst: async ({ where }: any) => {
        if (where?.isActive) return opcoes.linhas.find((l) => l.isActive) ?? null;
        return opcoes.linhas.find(
          (l) => l.endpoint === where.endpoint && l.bucket === where.bucket && (l.prefix ?? '') === (where.prefix ?? ''),
        ) ?? null;
      },
      findMany: async () => [...opcoes.linhas].sort((a, b) => b.createdAt - a.createdAt),
      delete: async ({ where }: any) => {
        acoes.push(`delete:${where.id}`);
        const i = opcoes.linhas.findIndex((l) => l.id === where.id);
        if (i >= 0) opcoes.linhas.splice(i, 1);
        return {};
      },
      updateMany: async () => { acoes.push('deactivate'); return { count: 1 }; },
      update: async ({ where }: any) => { acoes.push(`activate:${where.id}`); return {}; },
    },
    recording: {
      deleteMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: any) => fn(svc.prisma),
  };
  return { svc, acoes };
}

const LAPIDE_EVEO = { endpoint: EVEO.endpoint, bucket: EVEO.bucket, prefix: EVEO.prefix };

test('storage excluído na Central é expurgado MESMO estando marcado como ativo', async () => {
  // O cenário exato do deadlock: linha ativa + lápide + provisionamento ausente.
  const { svc, acoes } = montar({ linhas: [{ ...EVEO }], lapides: [LAPIDE_EVEO], provisionado: null });

  const feitos = await svc.expurgarStoragesRemovidos();

  assert.equal(feitos.length, 1, 'o expurgo pulou o storage — deadlock de volta');
  assert.equal(feitos[0].bucket, 'grupo-flash-01');
  assert.ok(acoes.includes('delete:st-eveo'), 'a linha tem de sair da tabela');
});

test('se a Central voltou a PROVISIONAR o mesmo endereço, a exclusão foi desfeita e nada é expurgado', async () => {
  // Este é o caso que o portão antigo (isActive) tentava proteger — e a
  // proteção continua, só que pelo sinal certo: o provisionamento.
  const { svc, acoes } = montar({
    linhas: [{ ...EVEO }],
    lapides: [LAPIDE_EVEO],
    provisionado: { enabled: true, endpoint: EVEO.endpoint, bucket: EVEO.bucket, prefix: EVEO.prefix, name: 'Eveo' },
  });

  const feitos = await svc.expurgarStoragesRemovidos();

  assert.equal(feitos.length, 0);
  assert.ok(!acoes.some((a) => a.startsWith('delete:')), 'não pode apagar o que voltou a valer');
});

test('endereço com lápide NÃO concorre a destino no fallback', async () => {
  // A outra metade do círculo: o excluído era "a linha mais recente" e
  // assumia o lugar de si mesmo.
  const antigo = { ...EVEO, id: 'st-antigo', name: 'meu-storage', bucket: 'meu-storage', isActive: false, createdAt: new Date('2026-07-01') };
  const { svc } = montar({
    linhas: [{ ...EVEO, isActive: false }, antigo],
    lapides: [LAPIDE_EVEO],
    estado: 'absent',
  });
  svc.materializar = (c: any) => ({ ...c });

  const destino = await (svc as any).semStorageProvisionado();

  assert.notEqual(destino?.bucket, 'grupo-flash-01', 'o excluído se reelegeu — deadlock de volta');
  assert.equal(destino?.bucket, 'meu-storage', 'o sobrevivente legítimo é quem assume');
});

test('sem sobrevivente sem lápide, fica só o disco local', async () => {
  const { svc } = montar({ linhas: [{ ...EVEO, isActive: false }], lapides: [LAPIDE_EVEO], estado: 'absent' });
  svc.materializar = (c: any) => ({ ...c });

  const destino = await (svc as any).semStorageProvisionado();

  assert.equal(destino, null, 'não há para onde enviar — e isso é o correto');
});
