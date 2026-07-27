import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';
import { CameraHealthCheckProcessor } from '../src/jobs/processors/camera-health-check.processor';

// ─────────────────────────────────────────────────────────────────────────────
// Gravação TRAVADA detectada pelo PROGRESSO DO ARQUIVO EM ESCRITA.
//
// O limiar antigo só olha o ÚLTIMO SEGMENTO FECHADO: com segmento de 300s ele
// exige max(180s, 300×1,25)=375s e o job roda a cada 60s → até ~7min parado.
// O FFmpeg, porém, escreve CONTINUAMENTE no .ts em andamento: se esse arquivo
// para de crescer, travou AGORA.
//
// Os testes de detecção usam ARQUIVOS DE VERDADE em tmpdir (readdir/stat/mtime
// reais); só os casos "sem processo" e a fiação do health-check usam seams.
// ─────────────────────────────────────────────────────────────────────────────

function makeManager() {
  const config = { get: () => undefined } as any;
  const mgr = new RecordingProcessManagerService(config, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  return mgr;
}

const dirs: string[] = [];
function tmpOutputDir() {
  const dir = mkdtempSync(join(tmpdir(), 'drac-write-stall-'));
  dirs.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Cria um .ts com `bytes` e mtime `ageSeconds` no passado. */
function writeSegment(dir: string, name: string, bytes: number, ageSeconds: number) {
  const full = join(dir, name);
  writeFileSync(full, Buffer.alloc(bytes, 1));
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(full, when, when);
  return full;
}

/** Estado de gravação ativa com `uptimeSeconds` de vida (fora da janela de graça por padrão). */
function armRecording(mgr: any, cameraId: string, outputDir: string, uptimeSeconds = 600) {
  mgr.active.set(cameraId, {
    cameraId,
    pid: 4242,
    startedAt: new Date(Date.now() - uptimeSeconds * 1000),
    outputDir,
    outputPattern: join(outputDir, '%Y-%m-%d_%H-%M-%S.ts'),
    segmentSeconds: 300,
  });
}

// ── Detecção: arquivo real em tmpdir ─────────────────────────────────────────

test('write-stall: arquivo do segmento CRESCENDO (mtime agora) → saudável', () => {
  const mgr = makeManager();
  const dir = tmpOutputDir();
  writeSegment(dir, '2026-07-27_10-00-00.ts', 4096, 0);
  armRecording(mgr, 'cam-1', dir);

  const progress = mgr.getRecordingWriteProgress('cam-1');

  assert.equal(progress.stalled, false, 'escrita recente não pode ser acusada de travada');
  assert.equal(progress.reason, 'writing');
  assert.equal(progress.applicable, true);
  assert.ok(progress.secondsSinceLastWrite < progress.stallThresholdSeconds);
});

test('write-stall: arquivo PARADO além do limiar → TRAVADO (antes de fechar o segmento)', () => {
  const mgr = makeManager();
  const dir = tmpOutputDir();
  writeSegment(dir, '2026-07-27_10-00-00.ts', 4096, 120);
  armRecording(mgr, 'cam-1', dir);

  const progress = mgr.getRecordingWriteProgress('cam-1');

  assert.equal(progress.stalled, true, '120s sem escrita com o processo vivo é gravação travada');
  assert.equal(progress.reason, 'stalled');
  assert.ok(progress.secondsSinceLastWrite >= 119 && progress.secondsSinceLastWrite <= 122, `idade medida=${progress.secondsSinceLastWrite}`);
  assert.equal(progress.stallThresholdSeconds, 45, 'default conservador de 45s');
});

test('write-stall: parado ABAIXO do limiar (30s < 45s) ainda é saudável', () => {
  const mgr = makeManager();
  const dir = tmpOutputDir();
  writeSegment(dir, '2026-07-27_10-00-00.ts', 4096, 30);
  armRecording(mgr, 'cam-1', dir);

  assert.equal(mgr.getRecordingWriteProgress('cam-1').stalled, false, 'jitter de filesystem não pode matar gravação boa');
});

test('write-stall: logo após o start, arquivo AINDA NÃO EXISTE → NÃO acusa (janela de graça)', () => {
  const mgr = makeManager();
  const dir = tmpOutputDir(); // vazio: o FFmpeg ainda está conectando
  armRecording(mgr, 'cam-1', dir, 10); // 10s de vida, graça padrão = 90s

  const progress = mgr.getRecordingWriteProgress('cam-1');

  assert.equal(progress.stalled, false, 'acusar aqui reiniciaria em loop uma câmera que só está lenta para conectar');
  assert.equal(progress.reason, 'startup_grace');
});

test('write-stall: dentro da graça, mesmo com arquivo velho, NÃO acusa', () => {
  const mgr = makeManager();
  const dir = tmpOutputDir();
  writeSegment(dir, '2026-07-27_10-00-00.ts', 4096, 300);
  armRecording(mgr, 'cam-1', dir, 20); // 20s de vida < 90s de graça

  const progress = mgr.getRecordingWriteProgress('cam-1');

  assert.equal(progress.stalled, false, 'a graça pós-start vence qualquer arquivo antigo herdado da pasta');
  assert.equal(progress.reason, 'startup_grace');
});

test('write-stall: fora da graça e SEM nenhum .ts (janela entre remux e próximo segmento) → NÃO acusa', () => {
  const mgr = makeManager();
  const dir = tmpOutputDir();
  writeFileSync(join(dir, '2026-07-27_10-00-00.mp4'), Buffer.alloc(10, 1)); // já remuxado
  armRecording(mgr, 'cam-1', dir);

  const progress = mgr.getRecordingWriteProgress('cam-1');

  assert.equal(progress.stalled, false);
  assert.equal(progress.reason, 'no_segment_file');
});

test('write-stall: .ts residual VELHO não mascara o segmento vivo (escolhe por mtime, não por nome)', () => {
  const mgr = makeManager();
  const dir = tmpOutputDir();
  // Residual de remux que falhou, com nome LEXICOGRAFICAMENTE MAIOR que o vivo.
  writeSegment(dir, '2026-07-27_23-59-59.ts', 8192, 900);
  const vivo = writeSegment(dir, '2026-07-27_10-00-00.ts', 4096, 1);
  armRecording(mgr, 'cam-1', dir);

  const progress = mgr.getRecordingWriteProgress('cam-1');

  assert.equal(progress.stalled, false, 'se QUALQUER .ts da pasta recebeu bytes agora, a gravação está viva');
  assert.equal(progress.filePath, vivo);
});

test('write-stall: pasta de saída inexistente → probe_failed, nunca acusa', () => {
  const mgr = makeManager();
  armRecording(mgr, 'cam-1', join(tmpOutputDir(), 'nao-existe'));

  const progress = mgr.getRecordingWriteProgress('cam-1');

  assert.equal(progress.stalled, false);
  assert.equal(progress.reason, 'probe_failed');
});

test('write-stall: CRESCIMENTO comprovado vence mtime preguiçoso do filesystem', () => {
  const mgr = makeManager();
  const dir = tmpOutputDir();
  const path = writeSegment(dir, '2026-07-27_10-00-00.ts', 4096, 300);
  armRecording(mgr, 'cam-1', dir);

  assert.equal(mgr.getRecordingWriteProgress('cam-1').stalled, true, 'primeira observação: mtime velho → travado');

  // Arquivo cresceu, mas o filesystem manteve o mtime velho.
  writeFileSync(path, Buffer.alloc(9000, 1));
  const when = new Date(Date.now() - 300 * 1000);
  utimesSync(path, when, when);

  const progress = mgr.getRecordingWriteProgress('cam-1');
  assert.equal(progress.stalled, false, 'bytes a mais são prova direta de progresso');
  assert.equal(progress.reason, 'growing');
});

// ── Não aplicabilidade ───────────────────────────────────────────────────────

test('write-stall: sem processo de gravação ativo a regra NÃO se aplica', () => {
  const mgr = makeManager();

  const progress = mgr.getRecordingWriteProgress('cam-sem-processo');

  assert.equal(progress.applicable, false, 'quem cobra câmera sem processo é o limiar por último segmento');
  assert.equal(progress.stalled, false);
  assert.equal(progress.reason, 'no_active_process');
});

test('write-stall: limiar/graça configuráveis, com piso duro contra configuração suicida', () => {
  const mgr = makeManager();
  const previous = process.env.RECORDING_WRITE_STALL_SECONDS;
  try {
    process.env.RECORDING_WRITE_STALL_SECONDS = '1';
    assert.equal(mgr.getWriteStallSeconds(), 20, 'piso de 20s impede que um valor absurdo mate gravação boa');
    process.env.RECORDING_WRITE_STALL_SECONDS = '75';
    assert.equal(mgr.getWriteStallSeconds(), 75);
    assert.ok(mgr.getWriteStallGraceSeconds(75) >= 75, 'a graça nunca pode ser menor que o limiar');
  } finally {
    if (previous == null) delete process.env.RECORDING_WRITE_STALL_SECONDS;
    else process.env.RECORDING_WRITE_STALL_SECONDS = previous;
  }
});

// ── getStatus: exposição ADITIVA ─────────────────────────────────────────────

function statusManager() {
  const mgr = makeManager();
  const recentStart = new Date(Date.now() - 30_000);
  mgr.prisma = {
    recording: { findFirst: async () => ({ startedAt: recentStart, endedAt: null, filePath: '/rec/x.mp4' }) },
    camera: { findUnique: async () => ({ recordingEnabled: true }) },
    cameraEvent: { findFirst: async () => null },
  };
  mgr.isPidAlive = () => true;
  return mgr;
}

test('getStatus: expõe writeStalled/writeProgress SEM alterar os campos existentes', async () => {
  const mgr = statusManager();
  const dir = tmpOutputDir();
  writeSegment(dir, '2026-07-27_10-00-00.ts', 4096, 120);
  armRecording(mgr, 'cam-1', dir);

  const status = await mgr.getStatus('cam-1');

  assert.equal(status.writeStalled, true, 'o campo novo denuncia o travamento');
  assert.equal(status.writeProgress.reason, 'stalled');
  // Contrato antigo INTACTO: `stale` continua sendo só "processo morto".
  assert.equal(status.isRecording, true);
  assert.equal(status.stale, false, 'stale não pode mudar de significado — quem reinicia é o health-check');
  assert.equal(status.statusDetail, 'recording_ok_local_process');
  assert.equal(status.hasRecentSegment, true);
});

test('getStatus: sem processo ativo o campo novo vem inaplicável (nunca quebra o consumidor)', async () => {
  const mgr = statusManager();

  const status = await mgr.getStatus('cam-1');

  assert.equal(status.writeStalled, false);
  assert.equal(status.writeProgress.applicable, false);
});

// ── Fiação no health-check ───────────────────────────────────────────────────

function healthProcessor(options: {
  latestSegmentAt: Date | null;
  writeProgress: any;
  lastReconnectAt?: Date | null;
}) {
  const events: Array<{ type: string; metadata: any }> = [];
  const calls: string[] = [];
  const cameraFindMany: any[] = [];
  const prisma = {
    camera: {
      findMany: async (args: any) => {
        cameraFindMany.push(args);
        return [{ id: 'cam-1', name: 'Portaria', status: 'ONLINE' }];
      },
    },
    recording: {
      groupBy: async () => (options.latestSegmentAt
        ? [{ cameraId: 'cam-1', _max: { endedAt: options.latestSegmentAt, startedAt: options.latestSegmentAt } }]
        : []),
    },
    cameraEvent: {
      findFirst: async (args: any) => {
        const types: string[] = args?.where?.type?.in ?? [args?.where?.type];
        if (types.includes('HEALTH_RECORDING_RECONNECT_REQUESTED') && options.lastReconnectAt) {
          return { occurredAt: options.lastReconnectAt };
        }
        return null;
      },
    },
    alarmInstance: { findFirst: async () => null },
  };
  const camerasService = {
    registerEvent: async (_cameraId: string, type: string, _severity: string, _message: string, metadata: any) => {
      events.push({ type, metadata });
    },
  };
  const recordingManager = {
    getRecordingWriteProgress: () => options.writeProgress,
    stop: async () => { calls.push('stop'); },
    start: async () => { calls.push('start'); },
  };
  const processor = new CameraHealthCheckProcessor(
    prisma as any,
    { get: () => undefined } as any,
    camerasService as any,
    recordingManager as any,
    {} as any,
    {} as any,
  );
  (processor as any).logger = { error() {}, warn() {}, log() {}, debug() {} };
  return { processor, events, calls, cameraFindMany };
}

const STALLED_PROGRESS = {
  applicable: true,
  filePath: '/rec/cam-1/2026/07/27/10/2026-07-27_10-00-00.ts',
  sizeBytes: 4096,
  secondsSinceLastWrite: 120,
  stallThresholdSeconds: 45,
  graceSeconds: 90,
  stalled: true,
  reason: 'stalled',
};

const HEALTHY_PROGRESS = { ...STALLED_PROGRESS, secondsSinceLastWrite: 3, stalled: false, reason: 'writing' };

async function runStalenessCheck(harness: ReturnType<typeof healthProcessor>) {
  await (harness.processor as any).checkRecordingStaleness();
}

test('health-check: sem a flag, segmento recente + arquivo travado NÃO reinicia (default preservado)', async () => {
  const previous = process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  try {
    const harness = healthProcessor({ latestSegmentAt: new Date(Date.now() - 30_000), writeProgress: STALLED_PROGRESS });
    await runStalenessCheck(harness);
    assert.deepEqual(harness.calls, [], 'sem a flag o comportamento tem de ser idêntico ao de hoje');
    assert.deepEqual(harness.events.map((e) => e.type), []);
  } finally {
    if (previous == null) delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
    else process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = previous;
  }
});

test('health-check: com a flag, arquivo travado reinicia ANTES do limiar antigo', async () => {
  const previous = process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = 'true';
  try {
    // Segmento fechado há apenas 30s: o limiar antigo (375s) NÃO acusaria nada.
    const harness = healthProcessor({ latestSegmentAt: new Date(Date.now() - 30_000), writeProgress: STALLED_PROGRESS });
    await runStalenessCheck(harness);

    assert.deepEqual(harness.calls, ['stop', 'start'], 'travamento por arquivo deve reiniciar a gravação');
    const types = harness.events.map((e) => e.type);
    assert.ok(types.includes('HEALTH_RECORDING_STALE'));
    assert.ok(types.includes('HEALTH_RECORDING_RECONNECT_REQUESTED'));
    assert.ok(types.includes('HEALTH_RECORDING_RECONNECT_SUCCESS'));
    const stale = harness.events.find((e) => e.type === 'HEALTH_RECORDING_STALE')!;
    assert.equal(stale.metadata.detectedBy, 'write_progress', 'o evento tem de dizer QUEM detectou');
    assert.equal(stale.metadata.writeStalled, true);
    assert.equal(stale.metadata.writeProgress.secondsSinceLastWrite, 120);
  } finally {
    if (previous == null) delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
    else process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = previous;
  }
});

test('health-check: com a flag, gravação escrevendo normalmente NÃO é tocada', async () => {
  const previous = process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = 'true';
  try {
    const harness = healthProcessor({ latestSegmentAt: new Date(Date.now() - 30_000), writeProgress: HEALTHY_PROGRESS });
    await runStalenessCheck(harness);
    assert.deepEqual(harness.calls, [], 'falso positivo aqui MATA gravação boa');
    assert.deepEqual(harness.events.map((e) => e.type), []);
  } finally {
    if (previous == null) delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
    else process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = previous;
  }
});

test('health-check: o limiar ANTIGO continua valendo como rede (sem segmento nenhum, flag off)', async () => {
  const previous = process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  try {
    const harness = healthProcessor({ latestSegmentAt: null, writeProgress: HEALTHY_PROGRESS });
    await runStalenessCheck(harness);
    assert.deepEqual(harness.calls, ['stop', 'start']);
    const stale = harness.events.find((e) => e.type === 'HEALTH_RECORDING_STALE')!;
    assert.equal(stale.metadata.detectedBy, 'last_segment');
  } finally {
    if (previous == null) delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
    else process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = previous;
  }
});

test('health-check: cooldown de reconexão continua protegendo o travamento por arquivo', async () => {
  const previous = process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = 'true';
  try {
    const harness = healthProcessor({
      latestSegmentAt: new Date(Date.now() - 30_000),
      writeProgress: STALLED_PROGRESS,
      lastReconnectAt: new Date(Date.now() - 10_000), // cooldown padrão = 180s
    });
    await runStalenessCheck(harness);
    assert.deepEqual(harness.calls, [], 'reconexão recente bloqueia novo restart (anti-loop)');
  } finally {
    if (previous == null) delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
    else process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = previous;
  }
});

test('health-check: modo motion continua EXCLUÍDO da varredura de travamento', async () => {
  const previous = process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = 'true';
  try {
    const harness = healthProcessor({ latestSegmentAt: new Date(Date.now() - 30_000), writeProgress: STALLED_PROGRESS });
    await runStalenessCheck(harness);
    assert.deepEqual(
      harness.cameraFindMany[0].where,
      { recordingEnabled: true, recordingMode: { not: 'motion' } },
      'câmera armada por movimento passa horas sem gravar de propósito',
    );
  } finally {
    if (previous == null) delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
    else process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = previous;
  }
});

test('health-check: gerenciador sem o método novo não derruba a varredura', async () => {
  const previous = process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
  process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = 'true';
  try {
    const harness = healthProcessor({ latestSegmentAt: new Date(Date.now() - 30_000), writeProgress: STALLED_PROGRESS });
    (harness.processor as any).recordingManager = { stop: async () => {}, start: async () => {} };
    await assert.doesNotReject(() => runStalenessCheck(harness));
  } finally {
    if (previous == null) delete process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED;
    else process.env.HEALTH_RECORDING_WRITE_STALL_ENABLED = previous;
  }
});
