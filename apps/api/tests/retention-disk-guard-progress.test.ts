import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService } from '../src/recordings/retention.service';

// ─────────────────────────────────────────────────────────────────────────────
// O GUARDIÃO DE DISCO NÃO PODE VIRAR TRITURADORA DE ACERVO.
//
// `checkDiskUsage` apaga por PRESSÃO DE DISCO, não por idade: sem filtro de
// data, da mais velha para a mais nova, em até 100 lotes de 20 = 2000 gravações
// por passagem. A premissa embutida é "apagar gravação reduz o uso do disco".
//
// Quando a premissa é falsa, o laço destrói prova sem conseguir nada. O caso
// real: o volume das gravações NÃO monta, `recordingsRoot` cai no disco do
// sistema (cheio por outro motivo) e nenhuma exclusão move o percentual.
//
// O Frigate trava a mesma classe de acidente antes de sincronizar disco↔banco
// (`util/media.py`, `SAFETY_THRESHOLD = 0.5`): contagem anormal de exclusão é
// sintoma de mount/config errado, não de acervo velho. Aqui o sinal escolhido é
// mais preciso que um limiar de contagem — se o lote apagou DE FATO e o uso do
// disco não caiu, o espaço não é das gravações.
//
// O que estes testes travam:
//   1. disco que não cede ⇒ o laço ABORTA após N lotes (não vai até 2000);
//   2. o aborto é ERROR no log, com a causa provável (mount) — silêncio aqui
//      seria pior que o bug, porque o disco continua cheio e ninguém sabe;
//   3. progresso real NÃO dispara o freio (uma limpeza legítima sempre libera
//      espaço) — este é o teste que impede o freio de virar um falso positivo;
//   4. progresso intermitente RESETA o contador (só sequências sem progresso
//      contam), senão uma limpeza lenta seria abortada no meio.
// ─────────────────────────────────────────────────────────────────────────────

type Cenario = {
  /** Percentuais devolvidos por `diskUsagePercent`, em ordem de chamada. */
  leituras: number[];
  maxNoProgress?: string;
};

function buildSvc(cenario: Cenario) {
  const logs: string[] = [];
  const apagadas: string[] = [];
  let leituraIndex = 0;
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
    const valor = cenario.leituras[Math.min(leituraIndex, cenario.leituras.length - 1)];
    leituraIndex += 1;
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

test('disco que não cede: aborta após o teto de lotes sem progresso', async () => {
  // Sempre 95%: apagar não muda nada (volume não montado / disco de outro dono).
  const { svc, logs, apagadas } = buildSvc({ leituras: [95] });
  await comEnv({ ...GATILHO, RETENTION_DISK_MAX_NOPROGRESS_BATCHES: '3' }, () => svc.checkDiskUsage());

  assert.equal(apagadas.length, 60, '3 lotes de 20 e para — sem o freio seriam 2000');
  const erro = logs.find((l) => l.startsWith('error:'));
  assert.ok(erro, 'o aborto tem que aparecer como ERROR, não em silêncio');
  assert.match(erro!, /ABORTADO/);
  assert.match(erro!, /montado/, 'a mensagem precisa apontar a causa provável (mount)');
});

test('teto configurável muda o ponto de aborto', async () => {
  const { svc, apagadas } = buildSvc({ leituras: [95] });
  await comEnv({ ...GATILHO, RETENTION_DISK_MAX_NOPROGRESS_BATCHES: '1' }, () => svc.checkDiskUsage());
  assert.equal(apagadas.length, 20, 'teto 1 ⇒ um único lote');
});

test('limpeza legítima NÃO dispara o freio', async () => {
  // Cada leitura cai: 95 → 92 → 88 → 84 (abaixo do alvo 85, o laço termina).
  const { svc, logs, apagadas } = buildSvc({ leituras: [95, 92, 88, 84] });
  await comEnv({ ...GATILHO, RETENTION_DISK_MAX_NOPROGRESS_BATCHES: '3' }, () => svc.checkDiskUsage());

  assert.ok(apagadas.length > 0, 'a limpeza real precisa acontecer');
  assert.equal(logs.filter((l) => l.startsWith('error:')).length, 0, 'progresso real não pode ser tratado como acidente');
  assert.ok(logs.some((l) => l.includes('Guardião de disco concluído')), 'termina pelo caminho normal');
});

test('progresso intermitente reseta o contador (não aborta limpeza lenta)', async () => {
  // 95 (inicial) → 95 (sem progresso) → 95 (sem progresso) → 90 (progresso!)
  // → 95,95 (sem progresso de novo) → 84 (chega ao alvo).
  // Com teto 3, um reset no meio impede o aborto.
  const { svc, logs } = buildSvc({ leituras: [95, 95, 95, 90, 95, 95, 84] });
  await comEnv({ ...GATILHO, RETENTION_DISK_MAX_NOPROGRESS_BATCHES: '3' }, () => svc.checkDiskUsage());

  assert.equal(
    logs.filter((l) => l.startsWith('error:')).length,
    0,
    'sequência sem progresso foi quebrada por um lote que liberou espaço — não é o acidente que o freio caça',
  );
});

test('disco abaixo do gatilho: o guardião nem roda', async () => {
  const { svc, apagadas } = buildSvc({ leituras: [50] });
  await comEnv(GATILHO, () => svc.checkDiskUsage());
  assert.equal(apagadas.length, 0, 'sem pressão de disco não se apaga nada');
});
