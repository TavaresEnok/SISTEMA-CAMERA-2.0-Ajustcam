import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService } from '../src/recordings/retention.service';

// ── O DISCO CHEIO NÃO PODE DESTRUIR O QUE NUNCA SUBIU ───────────────────────
//
// O guardião de disco apagava a gravação MAIS ANTIGA, sem olhar se ela já tinha
// cópia na nuvem. Com o envio quebrado — a instalação passou horas com o bucket
// respondendo `NoSuchBucket (404)` — nada sobe, o disco enche, e o guardião
// começa a destruir justamente o material que só existia ali. Perda definitiva,
// em silêncio, provocada por uma falha temporária de terceiro.
//
// Ordem correta: primeiro o que JÁ ESTÁ no bucket (apagar o local só libera
// espaço, o vídeo continua existindo). Material único é o ÚLTIMO recurso, e
// gritando — porque a alternativa (não apagar nada) é a guarda de 92% parar a
// gravação, e aí a câmera não registra mais nada.

type Consulta = { where: any; take: number };

function montar(opcoes: {
  nuvemAtiva: boolean;
  porFiltro: (where: any) => Array<{ id: string }>;
  usoDoDisco: number[];
}) {
  const consultas: Consulta[] = [];
  const apagadas: string[] = [];
  const erros: string[] = [];
  const svc: any = Object.create(RetentionService.prototype);
  const usos = [...opcoes.usoDoDisco];

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
  svc.diskUsagePercent = async () => (usos.length > 1 ? usos.shift()! : usos[0]);
  svc.settings = { isAutoCleanupEnabled: async () => true };
  svc.config = { get: () => '/storage' };
  svc.getProtectionSets = async () => ({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  return { svc, consultas, apagadas, erros };
}

/** True quando o filtro pede explicitamente gravação JÁ enviada à nuvem. */
const pedeEnviadas = (where: any) => Boolean(where?.cloudUploadedAt?.not === null || where?.cloudUploadedAt?.not);

test('com nuvem ativa, apaga PRIMEIRO o que já tem cópia no bucket', async () => {
  const { svc, consultas, apagadas } = montar({
    nuvemAtiva: true,
    // Existem enviadas: o guardião nunca deve chegar às pendentes.
    porFiltro: (where) => (pedeEnviadas(where) ? [{ id: 'ja-na-nuvem' }] : [{ id: 'nunca-subiu' }]),
    usoDoDisco: [95, 84],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  assert.ok(consultas.length > 0, 'o guardião precisa ter consultado alguma coisa');
  assert.ok(pedeEnviadas(consultas[0].where), 'a PRIMEIRA busca tem de ser pelas que já subiram');
  assert.deepEqual(apagadas, ['ja-na-nuvem'], 'apagou material único havendo cópia remota disponível');
});

test('sem mais nada na nuvem, apaga material único — mas GRITA no log', async () => {
  // Não apagar também é destrutivo: a guarda de 92% para a gravação e a câmera
  // deixa de registrar. Apagar o mais antigo é o menor dano — desde que fique
  // registrado que houve perda de material sem cópia.
  const { svc, apagadas, erros } = montar({
    nuvemAtiva: true,
    porFiltro: (where) => (pedeEnviadas(where) ? [] : [{ id: 'nunca-subiu' }]),
    usoDoDisco: [95, 84],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  assert.deepEqual(apagadas, ['nunca-subiu']);
  const aviso = erros.find((m) => m.includes('NUNCA subiu'));
  assert.ok(aviso, 'perda definitiva de imagem não pode acontecer sem alarme no log');
  assert.match(aviso!, /nuvem|bucket|credencial/i, 'o log tem de apontar para a causa (o envio quebrado)');
});

test('sem nuvem configurada, o comportamento antigo é preservado', async () => {
  // Instalação só-local: TUDO tem cloudUploadedAt nulo. Filtrar por "já subiu"
  // aqui não acharia nada e o guardião nunca liberaria espaço.
  const { svc, consultas, apagadas } = montar({
    nuvemAtiva: false,
    porFiltro: () => [{ id: 'antiga' }],
    usoDoDisco: [95, 84],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  assert.ok(!pedeEnviadas(consultas[0].where), 'sem nuvem, não faz sentido exigir cópia remota');
  assert.deepEqual(apagadas, ['antiga']);
});

test('o alarme de perda única sai UMA vez por passagem, não por gravação', async () => {
  let restantes = 3;
  const { svc, erros } = montar({
    nuvemAtiva: true,
    porFiltro: (where) => {
      if (pedeEnviadas(where)) return [];
      if (restantes <= 0) return [];
      restantes -= 1;
      return [{ id: `unica-${restantes}` }];
    },
    usoDoDisco: [95, 94, 93, 84],
  });

  await svc.checkDiskUsage({ recordingIds: new Set<string>(), clipIds: new Set<string>() });

  assert.equal(erros.filter((m) => m.includes('NUNCA subiu')).length, 1);
});

test('gravação com hold continua protegida na busca por enviadas', async () => {
  // O hold (investigação/exportação em curso) não pode ser atropelado pela
  // nova ordem de preferência.
  const { svc, consultas } = montar({
    nuvemAtiva: true,
    porFiltro: () => [],
    usoDoDisco: [95, 95],
  });

  await svc.checkDiskUsage({ recordingIds: new Set(['protegida']), clipIds: new Set<string>() });

  assert.deepEqual(consultas[0].where.id?.notIn, ['protegida']);
});
