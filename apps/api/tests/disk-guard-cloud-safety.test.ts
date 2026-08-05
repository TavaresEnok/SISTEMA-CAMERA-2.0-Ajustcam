import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService } from '../src/recordings/retention.service';

// ── O DISCO CHEIO LIBERA ESPAÇO — NUNCA DESTRÓI ACERVO ──────────────────────
//
// Duas gerações do mesmo defeito, travadas aqui:
//
// 1ª: o guardião apagava a MAIS ANTIGA sem olhar a nuvem. Com o envio quebrado
//     (o `NoSuchBucket` real desta instalação), destruía o que só existia no
//     disco.
// 2ª: a correção preferia "quem já subiu" — mas sem filtrar `localDeletedAt`,
//     as mais antigas com cópia eram EXATAMENTE as que a poda já tinha tirado
//     do disco. E `deleteRecording` apaga o OBJETO REMOTO junto: o guardião
//     destruía a única cópia existente, liberando ZERO byte.
//
// A regra final: o guardião liberta espaço LOCAL. Gravação com cópia na nuvem
// que ainda ocupa disco → apaga só o arquivo local (linha e objeto remoto
// ficam; o playback continua, servido do bucket). Material único é último
// recurso, com ERROR no log. O acervo remoto é INTOCÁVEL sob pressão de disco.

type Consulta = { where: any; take: number };

function montar(opcoes: {
  nuvemAtiva: boolean;
  porFiltro: (where: any) => Array<{ id: string }>;
  percentuais: number[];
  livres: number[];
}) {
  const consultas: Consulta[] = [];
  const apagadas: string[] = [];
  const liberadas: string[] = [];
  const erros: string[] = [];
  const svc: any = Object.create(RetentionService.prototype);
  const usos = [...opcoes.percentuais];
  const livres = [...opcoes.livres];

  svc.logger = {
    warn: () => {},
    log: () => {},
    error: (m: string) => erros.push(m),
  };
  svc.prisma = {
    cloudStorage: { count: async () => (opcoes.nuvemAtiva ? 1 : 0) },
    recording: {
      findMany: async ({ where, take }: Consulta) => {
        consultas.push({ where, take });
        return opcoes.porFiltro(where).map((r) => ({
          ...r, cameraId: 'cam-1', filePath: `${r.id}.mp4`, cloudKey: null, cloudStorageId: null, cloudUploadedAt: null,
        }));
      },
    },
  };
  svc.deleteRecording = async (rec: { id: string }) => { apagadas.push(rec.id); return true; };
  svc.liberarEspacoLocal = async (rec: { id: string }) => { liberadas.push(rec.id); return true; };
  svc.diskUsagePercent = async () => (usos.length > 1 ? usos.shift()! : usos[0]);
  svc.diskFreeBytes = async () => (livres.length > 1 ? livres.shift()! : livres[0]);
  svc.settings = { isAutoCleanupEnabled: async () => true };
  svc.config = { get: () => '/storage' };
  svc.getProtectionSets = async () => ({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  return { svc, consultas, apagadas, liberadas, erros };
}

/** True quando o filtro pede gravação com cópia na nuvem QUE AINDA OCUPA DISCO. */
const pedeEnviadasNoDisco = (where: any) =>
  Boolean(where?.cloudUploadedAt?.not !== undefined && where?.localDeletedAt === null);

const GB = 1024 * 1024 * 1024;

test('com nuvem ativa, LIBERA o local das enviadas — sem tocar linha nem objeto remoto', async () => {
  const { svc, consultas, apagadas, liberadas } = montar({
    nuvemAtiva: true,
    porFiltro: (where) => (pedeEnviadasNoDisco(where) ? [{ id: 'ja-na-nuvem' }] : [{ id: 'nunca-subiu' }]),
    percentuais: [95, 84],
    livres: [10 * GB, 11 * GB],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  assert.ok(pedeEnviadasNoDisco(consultas[0].where),
    'a PRIMEIRA busca tem de exigir cópia na nuvem E arquivo ainda no disco — sem o filtro de localDeletedAt, '
    + 'o guardião pegava gravações já podadas e destruía a única cópia existente liberando zero byte');
  assert.deepEqual(liberadas, ['ja-na-nuvem'], 'enviada que ocupa disco: só o arquivo local sai');
  assert.deepEqual(apagadas, [], 'deleteRecording apaga linha + objeto remoto — proibido para quem tem cópia na nuvem');
});

test('sem mais enviadas ocupando disco, apaga material único — mas GRITA no log', async () => {
  const { svc, apagadas, liberadas, erros } = montar({
    nuvemAtiva: true,
    porFiltro: (where) => (pedeEnviadasNoDisco(where) ? [] : [{ id: 'nunca-subiu' }]),
    percentuais: [95, 84],
    livres: [10 * GB, 11 * GB],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  assert.deepEqual(apagadas, ['nunca-subiu']);
  assert.deepEqual(liberadas, []);
  const aviso = erros.find((m) => m.includes('NUNCA subiu'));
  assert.ok(aviso, 'perda definitiva de imagem não pode acontecer sem alarme no log');
  assert.match(aviso!, /nuvem|bucket|credencial/i, 'o log tem de apontar para a causa (o envio quebrado)');
});

test('no fallback com nuvem ativa, as já-podadas ficam de FORA', async () => {
  // Apagar uma gravação sem arquivo local não libera nada — e destruiria o
  // objeto remoto. O fallback só pode ver o que NUNCA subiu.
  const { svc, consultas } = montar({
    nuvemAtiva: true,
    porFiltro: () => [],
    percentuais: [95, 95],
    livres: [10 * GB],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  const fallback = consultas.find((c) => !pedeEnviadasNoDisco(c.where));
  assert.ok(fallback, 'o fallback precisa ter sido consultado');
  assert.equal(fallback!.where.cloudUploadedAt, null, 'fallback = só material que nunca subiu');
});

test('sem nuvem configurada, o comportamento antigo é preservado', async () => {
  const { svc, consultas, apagadas } = montar({
    nuvemAtiva: false,
    porFiltro: () => [{ id: 'antiga' }],
    percentuais: [95, 84],
    livres: [10 * GB, 11 * GB],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  assert.ok(!pedeEnviadasNoDisco(consultas[0].where), 'sem nuvem, não faz sentido exigir cópia remota');
  assert.equal(consultas[0].where.cloudUploadedAt, undefined, 'sem nuvem, o filtro de upload nem existe');
  assert.deepEqual(apagadas, ['antiga']);
});

test('o alarme de perda única sai UMA vez por passagem, não por gravação', async () => {
  let restantes = 3;
  const { svc, erros } = montar({
    nuvemAtiva: true,
    porFiltro: (where) => {
      if (pedeEnviadasNoDisco(where)) return [];
      if (restantes <= 0) return [];
      restantes -= 1;
      return [{ id: `unica-${restantes}` }];
    },
    percentuais: [95, 94, 93, 84],
    livres: [10 * GB, 11 * GB, 12 * GB, 13 * GB],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  assert.equal(erros.filter((m) => m.includes('NUNCA subiu')).length, 1);
});

test('gravação com hold continua protegida nas duas buscas', async () => {
  const { svc, consultas } = montar({
    nuvemAtiva: true,
    porFiltro: () => [],
    percentuais: [95, 95],
    livres: [10 * GB],
  });

  await svc.checkDiskUsage({ recordingIds: new Set(['protegida']), clipIds: new Set<string>() });

  for (const consulta of consultas) {
    assert.deepEqual(consulta.where.id?.notIn, ['protegida'], 'o hold vale para liberar E para apagar');
  }
});
