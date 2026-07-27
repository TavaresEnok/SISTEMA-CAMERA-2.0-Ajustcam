import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecordingsService } from '../src/recordings/recordings.service';
import {
  __resetHwaccelDetectionCache,
  buildCpuTranscodeArgs,
  type HwaccelDecision,
} from '../src/camera-stream/helpers/hwaccel-presets.helper';

// ── Campo de provas do hwaccel (achado da análise do Frigate) ────────────────
// O transcode de playback compatível é o lugar CERTO para estrear aceleração:
// falha ali não derruba câmera nenhuma. Mas só é seguro com a rede de proteção
// que o Frigate usa no export (record/export.py:749-770): se o comando com
// hwaccel falhar, REFAZER sem hwaccel automaticamente. O arquivo TEM de sair.

type Attempt = { args: string[]; acelerado: boolean };

function decision(over: Partial<HwaccelDecision> = {}): HwaccelDecision {
  return {
    mode: 'auto',
    preset: null,
    device: null,
    usingCpu: true,
    proven: false,
    degraded: false,
    reason: 'CPU',
    warnings: [],
    ...over,
  };
}

const ACELERADO = decision({
  preset: 'preset-nvidia',
  device: '0',
  usingCpu: false,
  proven: true,
  reason: 'Aceleração preset-nvidia comprovada',
});

function makeService(options: {
  hwaccel: HwaccelDecision;
  /** decide o que cada tentativa faz: 'ok' | 'erro' | 'vazio' */
  behaviour: (attempt: Attempt, index: number) => 'ok' | 'erro' | 'vazio';
}) {
  const root = mkdtempSync(join(tmpdir(), 'drac-transcode-'));
  const inputRel = join('cam-1', 'segmento.mkv');
  mkdirSync(join(root, 'cam-1'), { recursive: true });
  writeFileSync(join(root, inputRel), 'conteudo-original');

  const attempts: Attempt[] = [];
  const warnings: string[] = [];
  const svc: any = Object.create(RecordingsService.prototype);
  (svc as any).logger = {
    log: () => {},
    warn: (m: string) => warnings.push(String(m)),
    error: (m: string) => warnings.push(String(m)),
    debug: () => {},
  };
  svc.ensureRecordingExists = async () => ({ id: 'rec-1', cameraId: 'cam-1', filePath: inputRel });
  svc.resolveTranscodeHwaccel = async () => options.hwaccel;
  svc.runTranscodeAttempt = async (args: string[]) => {
    const acelerado = args.some((a) => a === '-hwaccel' || a === '-hwaccel_device');
    const attempt: Attempt = { args, acelerado };
    attempts.push(attempt);
    const out = args[args.length - 1];
    const verdict = options.behaviour(attempt, attempts.length - 1);
    if (verdict === 'erro') {
      // O ffmpeg real MORRE deixando (ou não) um arquivo pela metade.
      writeFileSync(out, 'lixo-parcial');
      throw new Error('ffmpeg exited with code 1');
    }
    if (verdict === 'vazio') {
      // Falha silenciosa clássica de hwaccel: sai 0 e não escreve nada.
      writeFileSync(out, '');
      return;
    }
    writeFileSync(out, `saida-${acelerado ? 'gpu' : 'cpu'}`);
  };

  const prevRoot = process.env.RECORDINGS_ROOT;
  process.env.RECORDINGS_ROOT = root;
  const restore = () => {
    if (prevRoot === undefined) delete process.env.RECORDINGS_ROOT;
    else process.env.RECORDINGS_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  };
  return { svc, attempts, warnings, root, restore, input: join(root, inputRel) };
}

function leftovers(root: string): string[] {
  const dir = join(root, '.playback-compatible', 'cam-1');
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

test('hwaccel falha → REFAZ em CPU sozinho e o arquivo sai', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({
    hwaccel: ACELERADO,
    behaviour: (a) => (a.acelerado ? 'erro' : 'ok'),
  });
  try {
    const out = await h.svc.generateCompatibleFile('rec-1');
    assert.ok(existsSync(out), 'o playback compatível TEM de existir mesmo com a GPU falhando');
    assert.equal(h.attempts.length, 2, 'uma tentativa acelerada + uma em CPU');
    assert.equal(h.attempts[0].acelerado, true);
    assert.equal(h.attempts[1].acelerado, false);
    assert.deepEqual(
      h.attempts[1].args.slice(0, -1),
      buildCpuTranscodeArgs(h.input, '').slice(0, -1),
      'o retry é o comando de CPU já validado em produção',
    );
    assert.ok(
      h.warnings.some((w) => /acelera/i.test(w) && /CPU/i.test(w)),
      `a queda para CPU precisa AVISAR — avisos: ${JSON.stringify(h.warnings)}`,
    );
    assert.deepEqual(leftovers(h.root), ['rec-1.mp4'], 'nenhum .tmp pode sobrar');
  } finally {
    h.restore();
  }
});

test('hwaccel "com sucesso" mas arquivo VAZIO também cai para CPU', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({
    hwaccel: ACELERADO,
    behaviour: (a) => (a.acelerado ? 'vazio' : 'ok'),
  });
  try {
    const out = await h.svc.generateCompatibleFile('rec-1');
    assert.ok(existsSync(out));
    assert.equal(h.attempts.length, 2, 'código de saída 0 não é prova de arquivo bom');
    assert.equal(h.attempts[1].acelerado, false);
    assert.deepEqual(leftovers(h.root), ['rec-1.mp4']);
  } finally {
    h.restore();
  }
});

test('hwaccel comprovado e funcionando: UMA tentativa, sem passar pela CPU', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({ hwaccel: ACELERADO, behaviour: () => 'ok' });
  try {
    const out = await h.svc.generateCompatibleFile('rec-1');
    assert.ok(existsSync(out));
    assert.equal(h.attempts.length, 1);
    assert.equal(h.attempts[0].acelerado, true);
    assert.ok(h.attempts[0].args.includes('h264_nvenc'));
    assert.ok(!h.attempts[0].args.includes('libx264'));
  } finally {
    h.restore();
  }
});

test('sem aceleração: UMA tentativa, com os argumentos de CPU de sempre', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({ hwaccel: decision(), behaviour: () => 'ok' });
  try {
    const out = await h.svc.generateCompatibleFile('rec-1');
    assert.equal(h.attempts.length, 1, 'sem GPU não existe tentativa acelerada para falhar');
    assert.equal(h.attempts[0].acelerado, false);
    assert.deepEqual(h.attempts[0].args.slice(0, -1), buildCpuTranscodeArgs(h.input, '').slice(0, -1));
    assert.ok(h.attempts[0].args[h.attempts[0].args.length - 1].endsWith('.tmp'));
    assert.ok(existsSync(out));
  } finally {
    h.restore();
  }
});

test('aceleração prometida e impossível: AVISA alto e ainda assim entrega em CPU', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({
    hwaccel: decision({
      degraded: true,
      reason: 'O ffmpeg anuncia encoders de GPU, mas NENHUM funcionou de verdade neste host',
      warnings: ['O ffmpeg anuncia encoders de GPU, mas NENHUM funcionou de verdade neste host'],
    }),
    behaviour: () => 'ok',
  });
  try {
    const out = await h.svc.generateCompatibleFile('rec-1');
    assert.ok(existsSync(out), 'degradar não pode significar deixar de entregar');
    assert.equal(h.attempts.length, 1);
    assert.ok(
      h.warnings.some((w) => /NENHUM funcionou de verdade/.test(w)),
      `o dono precisa ver o motivo — avisos: ${JSON.stringify(h.warnings)}`,
    );
  } finally {
    h.restore();
  }
});

test('as duas tentativas falham: erro claro e ZERO lixo em disco', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({ hwaccel: ACELERADO, behaviour: () => 'erro' });
  try {
    await assert.rejects(() => h.svc.generateCompatibleFile('rec-1'), /ffmpeg|compat/i);
    assert.equal(h.attempts.length, 2);
    assert.deepEqual(leftovers(h.root), [], 'transcode falho não pode deixar MP4 truncado no cache');
  } finally {
    h.restore();
  }
});

test('cache: um arquivo compatível já pronto não dispara ffmpeg nenhum', async () => {
  __resetHwaccelDetectionCache();
  const h = makeService({ hwaccel: ACELERADO, behaviour: () => 'ok' });
  try {
    const dir = join(h.root, '.playback-compatible', 'cam-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rec-1.mp4'), 'ja-existe');
    const out = await h.svc.generateCompatibleFile('rec-1');
    assert.equal(out, join(dir, 'rec-1.mp4'));
    assert.equal(h.attempts.length, 0);
  } finally {
    h.restore();
  }
});
