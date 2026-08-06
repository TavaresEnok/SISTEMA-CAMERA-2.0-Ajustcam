import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudOffloadService } from '../src/cloud-storage/cloud-offload.service';

// ── O BANCO NÃO PODE MENTIR SOBRE O QUE ESTÁ NA NUVEM ───────────────────────
//
// Pergunta do dono, depois do incidente Eveo: "se o S3 for apagado, o que
// acontece com os dados no banco? Como o sistema sabe que apagaram o vídeo no
// S3 — ou o S3 inteiro?" A resposta era: NÃO SABIA. O banco afirmava "12.503
// arquivadas" sobre um bucket vazio, e a mentira só aparecia no clique do
// playback.
//
// A vigilância confere o acervo remoto em lotes, com UM discriminador no
// centro — a diferença entre indisponível e apagado:
//
//   · bucket com erro  → NADA é marcado (indisponível pode voltar amanhã;
//     marcar condenaria um acervo restaurável — o caso Eveo real);
//   · bucket saudável + objeto 404 → apagado POR FORA: marca
//     `cloudMissingSince`, mantém a linha (registro da perda + mapa para o
//     objeto se for restaurado), e grita;
//   · objeto voltou → desmarca sozinho.

type Rec = { id: string; cloudKey: string; cloudStorageId: string | null; cloudMissingSince: Date | null };

function montar(opcoes: {
  candidatas: Rec[];
  bucketVivo: boolean;
  existentes: string[];
  head403?: boolean;
}) {
  const marcadas: Array<{ id: string; data: any }> = [];
  const erros: string[] = [];
  const logs: string[] = [];
  const svc: any = Object.create(CloudOffloadService.prototype);
  svc.logger = { warn: () => {}, log: (m: string) => logs.push(m), error: (m: string) => erros.push(m) };
  svc.prisma = {
    recording: {
      findMany: async () => opcoes.candidatas,
      update: async ({ where, data }: any) => { marcadas.push({ id: where.id, data }); },
    },
  };
  svc.resolver = {
    storageDaGravacao: async () => ({ id: 'st-1', name: 'Bucket Teste' }),
    clienteDe: () => ({
      listObjectsPage: async () => {
        if (!opcoes.bucketVivo) throw new Error('NoSuchBucket');
        return { objects: [], nextToken: null };
      },
      headObject: async (key: string) => (opcoes.head403
        ? { exists: false, contentLength: null, verificavel: false }
        : { exists: opcoes.existentes.includes(key), contentLength: 1000, verificavel: true }),
    }),
  };
  return { svc, marcadas, erros, logs };
}

const rec = (id: string, missing: Date | null = null): Rec =>
  ({ id, cloudKey: `recordings/cam/${id}.mp4`, cloudStorageId: 'st-1', cloudMissingSince: missing });

test('BUCKET FORA: nenhum objeto é marcado — indisponível não é apagado', async () => {
  // O caso Eveo: NoSuchBucket por horas. Marcar 12.503 como sumidas
  // condenaria um acervo que o fornecedor ainda pode restaurar.
  const { svc, marcadas } = montar({ candidatas: [rec('a'), rec('b')], bucketVivo: false, existentes: [] });
  const r = await svc.verificarAcervoNaNuvem();
  assert.deepEqual(marcadas, [], 'veredito sobre objeto exige bucket provando saúde antes');
  assert.equal(r.sumidas, 0);
});

test('bucket SAUDÁVEL + objeto ausente = apagado por fora: marca e GRITA', async () => {
  const { svc, marcadas, erros } = montar({
    candidatas: [rec('viva'), rec('apagada')],
    bucketVivo: true,
    existentes: ['recordings/cam/viva.mp4'],
  });
  const r = await svc.verificarAcervoNaNuvem();

  assert.equal(r.sumidas, 1);
  const marca = marcadas.find((m) => m.id === 'apagada');
  assert.ok(marca?.data.cloudMissingSince instanceof Date, 'a perda tem de ficar registrada no banco');
  const erro = erros.find((m) => m.includes('SUMIRAM'));
  assert.ok(erro, 'perda externa sem alarme é como o incidente começou');
  assert.match(erro!, /fora do/, 'o log tem de dizer que foi apagado POR FORA do sistema');
});

test('a linha NUNCA é apagada — ela é o mapa para o objeto restaurado', async () => {
  const { svc, marcadas } = montar({
    candidatas: [rec('apagada')],
    bucketVivo: true,
    existentes: [],
  });
  await svc.verificarAcervoNaNuvem();
  const marca = marcadas.find((m) => m.id === 'apagada');
  assert.ok(marca, 'a gravação é MARCADA…');
  assert.ok(!('cloudKey' in (marca!.data ?? {})), '…mas cloudKey fica intacto: sem ele, restauração do bucket não serve de nada');
});

test('objeto que VOLTOU (fornecedor restaurou) é desmarcado com log', async () => {
  const { svc, marcadas, logs } = montar({
    candidatas: [rec('restaurada', new Date('2026-08-05'))],
    bucketVivo: true,
    existentes: ['recordings/cam/restaurada.mp4'],
  });
  const r = await svc.verificarAcervoNaNuvem();

  assert.equal(r.recuperadas, 1);
  const marca = marcadas.find((m) => m.id === 'restaurada');
  assert.equal(marca?.data.cloudMissingSince, null, 'restauração tem de limpar a marca sozinha');
  assert.ok(logs.some((m) => m.includes('VOLTOU')));
});

test('HEAD com 403 (inverificável): sem prova, sem veredito', async () => {
  const { svc, marcadas } = montar({
    candidatas: [rec('a')],
    bucketVivo: true,
    existentes: [],
    head403: true,
  });
  const r = await svc.verificarAcervoNaNuvem();
  assert.deepEqual(marcadas, []);
  assert.equal(r.sumidas, 0);
});

test('o portão de tempo segura a vigilância entre ciclos', async () => {
  let chamadasAoBanco = 0;
  const { svc } = montar({ candidatas: [], bucketVivo: true, existentes: [] });
  const findManyOriginal = svc.prisma.recording.findMany;
  svc.prisma.recording.findMany = async (...args: any[]) => { chamadasAoBanco += 1; return findManyOriginal(...args); };

  await svc.verificarAcervoNaNuvem();
  await svc.verificarAcervoNaNuvem();
  await svc.verificarAcervoNaNuvem();
  assert.equal(chamadasAoBanco, 1, 'o offload roda a cada segmento fechado; a vigilância não pode ir junto toda vez');
});
