import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService } from '../src/recordings/retention.service';

// ─────────────────────────────────────────────────────────────────────────────
// O GUARDIÃO DE DISCO NÃO PODE VIRAR TRITURADORA DE ACERVO — NEM DESISTIR À TOA.
//
// `checkDiskUsage` apaga por PRESSÃO DE DISCO, não por idade: da mais velha
// para a mais nova, em até 100 lotes de 20. A premissa é "apagar gravação
// libera espaço". Quando ela é falsa (volume não montado, disco cheio por
// outro dono), o laço destruiria prova sem conseguir nada — daí o freio.
//
// O freio original media progresso no PERCENTUAL ARREDONDADO — e isso o
// quebrava no sentido oposto: um lote de 20 gravações (~240 MB) não move 1
// ponto percentual num disco real (1 ponto em 4 TB são 40 GB), então o freio
// disparava SEMPRE em disco grande. O guardião apagava 60 gravações legítimas,
// registrava um erro FALSO de "volume não montado" e desistia; o disco subia
// até os 92% que param todas as câmeras. O progresso agora é medido em BYTES
// LIVRES: qualquer exclusão real aparece, em qualquer tamanho de disco.
//
// O que estes testes travam:
//   1. disco que não cede UM BYTE ⇒ aborta após N lotes, com ERROR e causa;
//   2. lote que libera bytes SEM mover o percentual ⇒ NÃO dispara o freio
//      (o caso do disco grande — a regressão que existia);
//   3. progresso intermitente reseta o contador;
//   4. abaixo do gatilho, nada roda.
// ─────────────────────────────────────────────────────────────────────────────

type Cenario = {
  /** Percentuais devolvidos por `diskUsagePercent`, em ordem de chamada. */
  percentuais: number[];
  /** Bytes livres devolvidos por `diskFreeBytes`, em ordem de chamada. */
  livres: number[];
};

function buildSvc(cenario: Cenario) {
  const logs: string[] = [];
  const apagadas: string[] = [];
  let pIndex = 0;
  let fIndex = 0;
  let proximoId = 0;

  const svc: any = Object.create(RetentionService.prototype);
  svc.logger = {
    log: (m: string) => logs.push(`log:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
    error: (m: string) => logs.push(`error:${m}`),
  };
  svc.config = { get: (key: string) => (key === 'recordingsRoot' ? '/mnt/gravacoes' : undefined) };
  svc.settings = { isAutoCleanupEnabled: async () => true };
  svc.prisma = {
    cloudStorage: { count: async () => 0 },
    recording: {
      // Acervo inesgotável: se o laço não parar sozinho, ele apaga para sempre.
      findMany: async (args: any) => Array.from({ length: args.take ?? 20 }, () => {
        proximoId += 1;
        return { id: `rec-${proximoId}`, cameraId: 'cam-1', filePath: `cam-1/rec-${proximoId}.mp4` };
      }),
    },
  };
  // Sem I/O real: o que importa é quantas vezes o laço decidiu apagar.
  svc.getProtectionSets = async () => ({ recordingIds: new Set<string>(), clipIds: new Set<string>(), eventIds: new Set<string>() });
  svc.deleteRecording = async (recording: { id: string }) => {
    apagadas.push(recording.id);
    return true;
  };
  svc.diskUsagePercent = async () => {
    const valor = cenario.percentuais[Math.min(pIndex, cenario.percentuais.length - 1)];
    pIndex += 1;
    return valor;
  };
  svc.diskFreeBytes = async () => {
    const valor = cenario.livres[Math.min(fIndex, cenario.livres.length - 1)];
    fIndex += 1;
    return valor;
  };

  return { svc, logs, apagadas };
}

async function comEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const anterior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    anterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const GATILHO = { RETENTION_DISK_TRIGGER_PERCENT: '90', RETENTION_DISK_TARGET_PERCENT: '85' };
const GB = 1024 * 1024 * 1024;

test('disco que não cede UM BYTE: aborta após o teto de lotes sem progresso', async () => {
  // Percentual e bytes livres constantes: apagar não muda nada (volume não
  // montado / disco de outro dono).
  const { svc, logs, apagadas } = buildSvc({ percentuais: [95], livres: [2 * GB] });
  await comEnv({ ...GATILHO, RETENTION_DISK_MAX_NOPROGRESS_BATCHES: '3' }, () => svc.checkDiskUsage());

  assert.equal(apagadas.length, 60, '3 lotes de 20 e para — sem o freio seriam 2000');
  const erro = logs.find((l) => l.startsWith('error:') && l.includes('ABORTADO'));
  assert.ok(erro, 'o aborto tem que aparecer como ERROR, não em silêncio');
  assert.match(erro!, /montado/, 'a mensagem precisa apontar a causa provável (mount)');
});

test('DISCO GRANDE: bytes liberados sem mover o percentual NÃO disparam o freio', async () => {
  // A regressão que existia: 4 TB, cada lote libera ~240 MB (visível em bytes,
  // invisível no percentual inteiro). O guardião tem de continuar até o alvo.
  const { svc, logs, apagadas } = buildSvc({
    percentuais: [91, 91, 91, 91, 84],           // o percentual "não se move"…
    livres: [100 * GB, 100.2 * GB, 100.4 * GB, 100.6 * GB, 100.9 * GB], // …mas cada lote libera bytes
  });
  await comEnv({ ...GATILHO, RETENTION_DISK_MAX_NOPROGRESS_BATCHES: '3' }, () => svc.checkDiskUsage());

  assert.ok(apagadas.length >= 60, `parou cedo demais (${apagadas.length}) — o freio disparou com progresso real`);
  assert.equal(
    logs.filter((l) => l.startsWith('error:') && l.includes('ABORTADO')).length,
    0,
    'liberar bytes É progresso, em qualquer tamanho de disco — abortar aqui deixa o disco subir aos 92% que param as câmeras',
  );
});

test('teto configurável muda o ponto de aborto', async () => {
  const { svc, apagadas } = buildSvc({ percentuais: [95], livres: [2 * GB] });
  await comEnv({ ...GATILHO, RETENTION_DISK_MAX_NOPROGRESS_BATCHES: '1' }, () => svc.checkDiskUsage());
  assert.equal(apagadas.length, 20, 'teto 1 ⇒ um único lote');
});

test('progresso intermitente reseta o contador (não aborta limpeza lenta)', async () => {
  // livres: base → 2 lotes sem liberar → libera → 2 sem liberar → o percentual
  // chega ao alvo. Com teto 3, o reset no meio impede o aborto.
  const { svc, logs } = buildSvc({
    percentuais: [95, 95, 95, 95, 95, 95, 84],
    livres: [10 * GB, 10 * GB, 10 * GB, 11 * GB, 11 * GB, 11 * GB, 12 * GB],
  });
  await comEnv({ ...GATILHO, RETENTION_DISK_MAX_NOPROGRESS_BATCHES: '3' }, () => svc.checkDiskUsage());

  assert.equal(
    logs.filter((l) => l.startsWith('error:') && l.includes('ABORTADO')).length,
    0,
    'sequência sem progresso foi quebrada por um lote que liberou espaço — não é o acidente que o freio caça',
  );
});

test('disco abaixo do gatilho: o guardião nem roda', async () => {
  const { svc, apagadas } = buildSvc({ percentuais: [50], livres: [500 * GB] });
  await comEnv(GATILHO, () => svc.checkDiskUsage());
  assert.equal(apagadas.length, 0, 'sem pressão de disco não se apaga nada');
});
