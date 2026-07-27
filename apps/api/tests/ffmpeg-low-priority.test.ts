import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingsService } from '../src/recordings/recordings.service';
import {
  FFMPEG_LOW_PRIORITY_NICENESS,
  isMissingCommandError,
  isNiceAvailable,
  markNiceUnavailable,
  planLowPriorityCommand,
  resetNiceAvailabilityCache,
} from '../src/recordings/helpers/ffmpeg-priority.helper';

// ─────────────────────────────────────────────────────────────────────────────
// PRIORIDADE REBAIXADA (nice) NOS FFMPEG PESADOS NÃO-CRÍTICOS.
//
// Um cliente clicando "exportar 1 hora" dispara um libx264 que rouba CPU da
// GRAVAÇÃO de todas as câmeras. O modo de falha não é a exportação lenta — é a
// gravação furar. O Frigate resolve isso prefixando `nice -n 19` nos ffmpeg
// auxiliares (frigate/util/ffmpeg.py, `use_low_priority`).
//
// Duas invariantes:
//   1. o ffmpeg auxiliar (transcode de playback, exportação de clipe,
//      thumbnail/sprite, varredura de integridade) roda rebaixado;
//   2. rebaixar é BÔNUS, nunca requisito: sem o binário/opção `nice`, o comando
//      roda mesmo assim. Falhar uma exportação por causa de prioridade seria
//      trocar um problema por outro pior.
// ─────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'drac-nice-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── Plano do comando ─────────────────────────────────────────────────────────

test('nice: com `nice` disponível, o comando pesado é prefixado com a prioridade baixa', () => {
  resetNiceAvailabilityCache(true);
  const plano = planLowPriorityCommand('ffmpeg', ['-i', 'entrada.mp4', 'saida.mp4']);

  assert.equal(plano.command, 'nice');
  assert.deepEqual(plano.args, ['-n', String(FFMPEG_LOW_PRIORITY_NICENESS), 'ffmpeg', '-i', 'entrada.mp4', 'saida.mp4']);
  assert.equal(plano.lowered, true);
  assert.equal(FFMPEG_LOW_PRIORITY_NICENESS, 19, 'niceness máximo: o auxiliar cede a CPU para a gravação');
});

test('nice: SEM `nice` no sistema, o comando segue igual (portabilidade, nunca falha)', () => {
  resetNiceAvailabilityCache(false);
  const plano = planLowPriorityCommand('ffmpeg', ['-i', 'entrada.mp4']);

  assert.equal(plano.command, 'ffmpeg');
  assert.deepEqual(plano.args, ['-i', 'entrada.mp4']);
  assert.equal(plano.lowered, false);
});

test('nice: a sondagem do sistema responde um booleano e jamais lança', () => {
  resetNiceAvailabilityCache(null);
  assert.equal(typeof isNiceAvailable(), 'boolean');
  resetNiceAvailabilityCache(null);
});

test('nice: erro de binário ausente (ENOENT) é reconhecido; erro de ffmpeg não', () => {
  assert.equal(isMissingCommandError(Object.assign(new Error('spawn nice ENOENT'), { code: 'ENOENT' })), true);
  assert.equal(isMissingCommandError(Object.assign(new Error('ffmpeg falhou'), { code: 1 })), false);
  assert.equal(isMissingCommandError(null), false);
});

// ── Execução: o wrapper do serviço ───────────────────────────────────────────

function makeService(overrides: Record<string, unknown> = {}) {
  const svc: any = Object.create(RecordingsService.prototype);
  svc.logger = { warn() {}, log() {}, debug() {}, error() {} };
  svc.execs = [] as Array<{ command: string; args: string[] }>;
  svc.runExecFile = async (command: string, args: string[]) => {
    svc.execs.push({ command, args });
    return { stdout: '', stderr: '' };
  };
  Object.assign(svc, overrides);
  return svc;
}

test('execução: o ffmpeg auxiliar é executado REBAIXADO quando dá', async () => {
  resetNiceAvailabilityCache(true);
  const svc = makeService();
  await svc.execFfmpegLowPriority(['-i', 'a.mp4', 'b.mp4']);

  assert.equal(svc.execs.length, 1);
  assert.equal(svc.execs[0].command, 'nice');
  assert.deepEqual(svc.execs[0].args.slice(0, 4), ['-n', '19', 'ffmpeg', '-i']);
});

test('execução: se `nice` sumir do PATH na hora H, a exportação roda mesmo assim', async () => {
  resetNiceAvailabilityCache(true);
  const svc = makeService({
    runExecFile: async (command: string, args: string[]) => {
      (svc.execs as Array<unknown>).push({ command, args });
      if (command === 'nice') throw Object.assign(new Error('spawn nice ENOENT'), { code: 'ENOENT' });
      return { stdout: '', stderr: '' };
    },
  });
  svc.execs = [];

  await svc.execFfmpegLowPriority(['-i', 'a.mp4', 'b.mp4']);

  assert.equal(svc.execs.length, 2, 'tem de haver a segunda tentativa, sem nice');
  assert.equal(svc.execs[1].command, 'ffmpeg');
  assert.deepEqual(svc.execs[1].args, ['-i', 'a.mp4', 'b.mp4'], 'os argumentos do ffmpeg não podem mudar');
  resetNiceAvailabilityCache(null);
});

test('execução: erro REAL do ffmpeg continua subindo (não é engolido pelo fallback)', async () => {
  resetNiceAvailabilityCache(true);
  const svc = makeService({
    runExecFile: async () => {
      throw Object.assign(new Error('ffmpeg: Invalid data found'), { code: 1 });
    },
  });

  await assert.rejects(() => svc.execFfmpegLowPriority(['-i', 'a.mp4']), /Invalid data found/);
});

// ── Fiação: todo caminho pesado passa pelo wrapper ───────────────────────────

test('fiação: o transcode de playback compatível roda rebaixado', async () => {
  const chamadas: string[][] = [];
  const svc = makeService({ execFfmpegLowPriority: async (args: string[]) => { chamadas.push(args); return { stdout: '', stderr: '' }; } });

  await svc.runTranscodeAttempt(['-i', 'x.mp4', 'y.mp4']);

  assert.equal(chamadas.length, 1, 'o transcode compatível precisa passar pelo wrapper de prioridade baixa');
  assert.deepEqual(chamadas[0], ['-i', 'x.mp4', 'y.mp4']);
});

test('fiação: a exportação de clipe (cópia e fallback libx264) roda rebaixada', async () => {
  const chamadas: string[][] = [];
  let falharPrimeira = true;
  const svc = makeService({
    execFfmpegLowPriority: async (args: string[]) => {
      chamadas.push(args);
      if (falharPrimeira && args.includes('copy')) throw new Error('copy não serve');
      return { stdout: '', stderr: '' };
    },
  });

  await svc.runClipExport('/in.mp4', '/out.mp4', 10, 30);
  assert.equal(chamadas.length, 2, 'cópia falhou → o libx264 (o caro) também tem de vir rebaixado');
  assert.ok(chamadas[1].includes('libx264'));

  falharPrimeira = false;
  chamadas.length = 0;
  await svc.transcodeClipForCompatibility('/in.mp4', '/out.mp4', 10, 30);
  assert.equal(chamadas.length, 1);
  assert.ok(chamadas[0].includes('libx264'), 'o transcode de compatibilidade do clipe é o pior ladrão de CPU');
});

test('fiação: thumbnail e sprite de timeline rodam rebaixados', async () => {
  const dir = tmpDir();
  const input = join(dir, 'gravacao.mp4');
  writeFileSync(input, Buffer.alloc(2048, 7));

  const chamadas: string[][] = [];
  const svc = makeService({
    thumbnailGenerationInFlight: new Map(),
    timelinePreviewInFlight: new Map(),
    thumbnailGenerationWaiters: [],
    thumbnailGenerationActive: 0,
    thumbnailGenerationConcurrency: 2,
    execFfmpegLowPriority: async (args: string[]) => {
      chamadas.push(args);
      writeFileSync(args[args.length - 1], Buffer.alloc(128, 1)); // o ffmpeg de verdade escreve o arquivo
      return { stdout: '', stderr: '' };
    },
  });

  const thumb = join(dir, 'gravacao.thumb.jpg');
  await svc.ensureThumbnailGenerated('rec-1', input, thumb, 300);
  assert.ok(existsSync(thumb), 'o thumbnail precisa sair mesmo rebaixado');
  assert.equal(chamadas.length, 1, 'o thumbnail passa pelo wrapper de prioridade baixa');

  const sprite = join(dir, 'gravacao.preview.jpg');
  await svc.ensureTimelinePreviewGenerated('rec-1', input, sprite, {
    intervalSeconds: 10,
    frameCount: 4,
    columns: 2,
    rows: 2,
    tileWidth: 160,
    tileHeight: 90,
  });
  assert.ok(existsSync(sprite), 'o sprite precisa sair mesmo rebaixado');
  assert.equal(chamadas.length, 2, 'o sprite também passa pelo wrapper');
});

test('fiação: a varredura de integridade (decodifica o arquivo inteiro) roda rebaixada', async () => {
  const dir = tmpDir();
  const arquivo = join(dir, 'gravacao.mp4');
  writeFileSync(arquivo, Buffer.alloc(4096, 3));

  const chamadas: string[][] = [];
  const svc = makeService({
    prisma: { recording: { findUnique: async () => ({ id: 'rec-1', filePath: arquivo }) } },
    ensureRecordingExists: async () => ({ id: 'rec-1', filePath: arquivo }),
    readDiagnosticsCache: () => ({}),
    writeDiagnosticsCache: () => undefined,
    execFfmpegLowPriority: async (args: string[]) => { chamadas.push(args); return { stdout: '', stderr: '' }; },
  });
  const rootAnterior = process.env.RECORDINGS_ROOT;
  process.env.RECORDINGS_ROOT = dir;
  try {
    const resultado = await svc.getRecordingIntegrity('rec-1');
    assert.equal(resultado.integrityOk, true);
    assert.equal(chamadas.length, 1, 'a varredura de integridade não pode competir com a gravação');
  } finally {
    if (rootAnterior === undefined) delete process.env.RECORDINGS_ROOT;
    else process.env.RECORDINGS_ROOT = rootAnterior;
  }
});

test('fiação: nenhum ffmpeg PESADO ficou chamando execFileAsync direto', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/recordings/recordings.service.ts', 'utf8');
  const diretos = src.split('\n').filter((linha) => /execFileAsync\(\s*'ffmpeg'/.test(linha));
  // Sobra apenas o snapshot de UM frame (interativo, o usuário está esperando a
  // imagem na tela) — todo o resto migrou para o wrapper rebaixado.
  assert.ok(diretos.length <= 1, `esperava no máximo 1 ffmpeg direto, achei ${diretos.length}`);
});

// ── Marcação em produção ─────────────────────────────────────────────────────

test('nice: marcar indisponível desliga o rebaixamento para as próximas chamadas', () => {
  resetNiceAvailabilityCache(true);
  assert.equal(planLowPriorityCommand('ffmpeg', []).lowered, true);
  markNiceUnavailable();
  assert.equal(planLowPriorityCommand('ffmpeg', []).lowered, false);
  resetNiceAvailabilityCache(null);
});
