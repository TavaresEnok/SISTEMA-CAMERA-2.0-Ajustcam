import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetHwaccelDetectionCache,
  applyQuarantine,
  buildHwaccelDecodeSmokeArgs,
  buildHwaccelEncodeSmokeArgs,
  detectTranscodeHwaccel,
  isHwaccelQuarantined,
  normalizeHwaccelMode,
  probeHwaccel,
  reportHwaccelFailure,
  reportHwaccelSuccess,
  resolveHwaccel,
  selectLibvaDevices,
  type FfmpegExec,
  type FfmpegExecResult,
  type HwaccelProbeReport,
} from '../src/camera-stream/helpers/hwaccel-presets.helper';

// ─────────────────────────────────────────────────────────────────────────────
// O FAKE MODELA O FFMPEG REAL DESTE HOST (saídas copiadas da execução de fato):
//   $ ffmpeg -encoders | grep nvenc  ->  h264_nvenc, hevc_nvenc, av1_nvenc...
//   $ ffmpeg ... -c:v h264_nvenc -f null -
//       [h264_nvenc] Cannot load libcuda.so.1                        (exit 255)
//   $ ffmpeg -vaapi_device /dev/dri/renderD128 ...
//       [AVHWDeviceContext] No VA display found for device ...        (exit 234)
// Ou seja: os três encoders estão COMPILADOS e NENHUM funciona. É exatamente o
// falso positivo que a detecção antiga (`ffmpeg -encoders`) produzia.
// ─────────────────────────────────────────────────────────────────────────────

const ENCODERS_STDOUT = [
  ' V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)',
  ' V..... av1_qsv              AV1 (Intel Quick Sync Video acceleration) (codec av1)',
  ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
  ' V..... h264_qsv             H.264 (Intel Quick Sync Video acceleration) (codec h264)',
  ' V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)',
  ' V..... libx264              libx264 H.264 / AVC',
].join('\n');

type FakeOptions = {
  encoders?: string;
  /** presets cujo ENCODE real funciona */
  encodeWorks?: string[];
  /** presets cujo DECODE real funciona (default: os mesmos do encode) */
  decodeWorks?: string[];
};

function fakeFfmpeg(options: FakeOptions = {}) {
  const calls: string[][] = [];
  const encodeWorks = options.encodeWorks ?? [];
  const decodeWorks = options.decodeWorks ?? encodeWorks;

  const kindOf = (args: string[]): 'nvidia' | 'vaapi' | 'qsv' | 'cpu' => {
    const joined = args.join(' ');
    if (joined.includes('nvenc') || joined.includes('cuda')) return 'nvidia';
    if (joined.includes('vaapi')) return 'vaapi';
    if (joined.includes('qsv')) return 'qsv';
    return 'cpu';
  };

  const exec: FfmpegExec = async (args): Promise<FfmpegExecResult> => {
    calls.push(args);
    if (args.includes('-encoders')) {
      return { ok: true, stdout: options.encoders ?? ENCODERS_STDOUT, stderr: '' };
    }
    const kind = kindOf(args);
    const isDecode = args.includes('-f') && args[args.indexOf('-f') + 1] === 'null';
    const allowed = isDecode ? decodeWorks : encodeWorks;
    if (allowed.includes(kind)) return { ok: true, stdout: '', stderr: '' };
    const stderr =
      kind === 'nvidia'
        ? '[h264_nvenc @ 0x1] Cannot load libcuda.so.1'
        : kind === 'vaapi'
          ? '[AVHWDeviceContext @ 0x1] No VA display found for device /dev/dri/renderD128.'
          : '[AVHWDeviceContext @ 0x1] Error initializing an internal MFX session';
    return { ok: false, stdout: '', stderr };
  };

  return { exec, calls };
}

const renderNodes = async () => ['/dev/dri/renderD128'];

// ── Porta do LibvaGpuSelector (Frigate ffmpeg_presets.py:28-54) ──────────────

test('libva: sem /dev/dri não há dispositivo nenhum', async () => {
  assert.deepEqual(await selectLibvaDevices(null, async () => true), []);
});

test('libva: /dev/dri sem renderD* assume o renderD128 (mesmo default do Frigate)', async () => {
  assert.deepEqual(await selectLibvaDevices(['card0', 'by-path'], async () => true), [
    '/dev/dri/renderD128',
  ]);
});

test('libva: um único render node é usado sem consultar o vainfo', async () => {
  let vainfoCalls = 0;
  const out = await selectLibvaDevices(['card0', 'renderD129'], async () => {
    vainfoCalls += 1;
    return true;
  });
  assert.deepEqual(out, ['/dev/dri/renderD129']);
  assert.equal(vainfoCalls, 0, 'com um só candidato o vainfo é desnecessário');
});

test('libva: com vários render nodes, só entram os que o vainfo aprova', async () => {
  const out = await selectLibvaDevices(
    ['renderD128', 'renderD129', 'card0'],
    async (dev) => dev === '/dev/dri/renderD129',
  );
  assert.deepEqual(out, ['/dev/dri/renderD129']);
});

// ── O teste é REAL, não é a lista de encoders ────────────────────────────────

test('sonda: encoder COMPILADO que não abre o hardware NÃO é aprovado', async () => {
  const { exec, calls } = fakeFfmpeg(); // nada funciona (este host)
  const report = await probeHwaccel({ exec, listRenderNodes: renderNodes, probeFile: '/tmp/p.mp4' });

  assert.deepEqual(report.compiled, { nvenc: true, vaapi: true, qsv: true });
  assert.equal(report.proven['preset-nvidia'], false);
  assert.equal(report.proven['preset-vaapi'], false);
  assert.equal(report.proven['preset-intel-qsv-h264'], false);
  assert.match(report.failures['preset-nvidia'] ?? '', /Cannot load libcuda/);
  assert.match(report.failures['preset-vaapi'] ?? '', /No VA display/);
  // Prova de que houve execução REAL (não só `-encoders`).
  assert.ok(calls.length > 1, 'a sonda tem de EXECUTAR ffmpeg além de listar encoders');
});

test('sonda: encode que passa mas DECODE que falha também reprova o preset', async () => {
  const { exec } = fakeFfmpeg({ encodeWorks: ['nvidia'], decodeWorks: [] });
  const report = await probeHwaccel({ exec, listRenderNodes: renderNodes, probeFile: '/tmp/p.mp4' });
  assert.equal(report.proven['preset-nvidia'], false, 'metade do pipeline não é aceleração');
});

test('sonda: quando encode e decode reais passam, o preset é aprovado com dispositivo', async () => {
  const { exec } = fakeFfmpeg({ encodeWorks: ['nvidia'] });
  const report = await probeHwaccel({ exec, listRenderNodes: renderNodes, probeFile: '/tmp/p.mp4' });
  assert.equal(report.proven['preset-nvidia'], true);
  assert.equal(report.devices['preset-nvidia'], '0');
});

test('sonda: sem render node, VAAPI/QSV são reprovados sem nem chamar o ffmpeg', async () => {
  const { exec, calls } = fakeFfmpeg({ encodeWorks: ['vaapi', 'qsv'] });
  const report = await probeHwaccel({
    exec,
    listRenderNodes: async () => [],
    probeFile: '/tmp/p.mp4',
    candidates: ['preset-vaapi', 'preset-intel-qsv-h264'],
  });
  assert.equal(report.proven['preset-vaapi'], false);
  assert.match(report.failures['preset-vaapi'] ?? '', /render node/);
  assert.equal(calls.length, 1, 'só a listagem de encoders deve ter rodado');
});

test('sonda: encoder ausente do build é reprovado sem executar nada', async () => {
  const { exec, calls } = fakeFfmpeg({ encoders: ' V..... libx264   libx264 H.264 / AVC' });
  const report = await probeHwaccel({ exec, listRenderNodes: renderNodes, probeFile: '/tmp/p.mp4' });
  assert.equal(report.compiled.nvenc, false);
  assert.match(report.failures['preset-nvidia'] ?? '', /não existe neste build/);
  assert.equal(calls.length, 1);
});

test('sonda: argumentos do teste real são os esperados por backend', () => {
  assert.deepEqual(buildHwaccelEncodeSmokeArgs('preset-nvidia', '0', '/tmp/p.mp4'), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-frames:v', '10',
    '-c:v', 'h264_nvenc', '-gpu', '0', '/tmp/p.mp4',
  ]);
  assert.deepEqual(buildHwaccelEncodeSmokeArgs('preset-vaapi', '/dev/dri/renderD128', '/tmp/p.mp4'), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-vaapi_device', '/dev/dri/renderD128',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-frames:v', '10',
    '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '/tmp/p.mp4',
  ]);
  // O decode da fumaça usa a MESMA tabela portada (não uma cópia divergente).
  assert.deepEqual(buildHwaccelDecodeSmokeArgs('preset-nvidia-h265', '0', '/tmp/p.mp4'), [
    '-hide_banner', '-loglevel', 'error',
    '-hwaccel_device', '0', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
    '-i', '/tmp/p.mp4', '-frames:v', '10', '-f', 'null', '-',
  ]);
});

// ── Tri-estado auto | <preset> | cpu ─────────────────────────────────────────

test('modo: normalização tri-estado', () => {
  assert.equal(normalizeHwaccelMode(undefined), 'auto');
  assert.equal(normalizeHwaccelMode(''), 'auto');
  assert.equal(normalizeHwaccelMode('AUTO'), 'auto');
  assert.equal(normalizeHwaccelMode('cpu'), 'cpu');
  assert.equal(normalizeHwaccelMode('off'), 'cpu');
  assert.equal(normalizeHwaccelMode('none'), 'cpu');
  assert.equal(normalizeHwaccelMode('preset-vaapi'), 'preset-vaapi');
  assert.equal(normalizeHwaccelMode('PRESET-NVIDIA'), 'preset-nvidia');
  assert.equal(normalizeHwaccelMode('bugiganga'), 'auto');
});

function reportOf(proven: Partial<Record<string, boolean>>, compiled = { nvenc: true, vaapi: true, qsv: true }): HwaccelProbeReport {
  return {
    compiled,
    renderNodes: ['/dev/dri/renderD128'],
    proven: proven as HwaccelProbeReport['proven'],
    failures: { 'preset-nvidia': 'Cannot load libcuda.so.1', 'preset-vaapi': 'No VA display found' },
    devices: { 'preset-nvidia': '0', 'preset-vaapi': '/dev/dri/renderD128' },
    probedAt: new Date().toISOString(),
  };
}

test('auto: escolhe o preset PROVADO (e nunca o meramente compilado)', () => {
  const d = resolveHwaccel('auto', reportOf({ 'preset-nvidia': true }));
  assert.equal(d.preset, 'preset-nvidia');
  assert.equal(d.device, '0');
  assert.equal(d.usingCpu, false);
  assert.equal(d.proven, true);
  assert.equal(d.degraded, false);
});

test('auto: TODOS compilados e NENHUM funcionando → CPU + aviso VISÍVEL (o caso da VM)', () => {
  const d = resolveHwaccel(
    'auto',
    reportOf({ 'preset-nvidia': false, 'preset-vaapi': false, 'preset-intel-qsv-h264': false }),
  );
  assert.equal(d.preset, null, 'compilado NÃO é prova: tem de cair para CPU');
  assert.equal(d.usingCpu, true);
  assert.equal(d.degraded, true, 'este é o caso que precisa gritar');
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /NENHUM funcionou de verdade/);
  assert.match(d.warnings[0], /Cannot load libcuda/, 'o aviso precisa dizer POR QUE falhou');
});

test('auto: host sem encoder nenhum → CPU silencioso (não há nada a denunciar)', () => {
  const d = resolveHwaccel('auto', reportOf({}, { nvenc: false, vaapi: false, qsv: false }));
  assert.equal(d.preset, null);
  assert.equal(d.usingCpu, true);
  assert.equal(d.degraded, false, 'sem hardware prometido não é degradação, é o normal');
  assert.deepEqual(d.warnings, []);
});

test('cpu: desliga a aceleração mesmo com GPU comprovada, e NÃO reclama', () => {
  const d = resolveHwaccel('cpu', reportOf({ 'preset-nvidia': true }));
  assert.equal(d.preset, null);
  assert.equal(d.usingCpu, true);
  assert.equal(d.degraded, false, 'escolha explícita do operador não é degradação');
});

test('<preset>: forçado e comprovado é respeitado, mesmo fora da ordem do auto', () => {
  const d = resolveHwaccel('preset-vaapi', reportOf({ 'preset-nvidia': true, 'preset-vaapi': true }));
  assert.equal(d.preset, 'preset-vaapi');
  assert.equal(d.device, '/dev/dri/renderD128');
});

test('<preset>: forçado e IMPOSSÍVEL cai para CPU avisando quem forçou', () => {
  const d = resolveHwaccel('preset-vaapi', reportOf({ 'preset-nvidia': true, 'preset-vaapi': false }));
  assert.equal(d.preset, null, 'forçar na config não cria hardware');
  assert.equal(d.usingCpu, true);
  assert.equal(d.degraded, true);
  assert.match(d.warnings[0], /preset-vaapi foi FORÇADO/);
  assert.match(d.warnings[0], /No VA display/);
});

// ── Quarentena (princípio DRAC: degradar, não apagar) ────────────────────────

test('quarentena: uma falha isolada NÃO tira a aceleração do ar', () => {
  __resetHwaccelDetectionCache();
  assert.equal(reportHwaccelFailure('preset-nvidia', 1_000), false);
  assert.equal(isHwaccelQuarantined('preset-nvidia', 1_000), false);
  const d = resolveHwaccel('auto', applyQuarantine(reportOf({ 'preset-nvidia': true }), 1_000));
  assert.equal(d.preset, 'preset-nvidia');
});

test('quarentena: falhas repetidas colocam o preset de molho e o sistema segue em CPU', () => {
  __resetHwaccelDetectionCache();
  reportHwaccelFailure('preset-nvidia', 1_000);
  assert.equal(reportHwaccelFailure('preset-nvidia', 2_000), true);
  const d = resolveHwaccel('auto', applyQuarantine(reportOf({ 'preset-nvidia': true }), 2_000));
  assert.equal(d.preset, null);
  assert.equal(d.usingCpu, true);
  assert.equal(d.degraded, true);
  assert.match(d.reason, /NENHUM funcionou de verdade/);
});

test('quarentena: EXPIRA sozinha — a capacidade é suspensa, não apagada', () => {
  __resetHwaccelDetectionCache();
  reportHwaccelFailure('preset-nvidia', 1_000);
  reportHwaccelFailure('preset-nvidia', 2_000);
  const durante = resolveHwaccel('auto', applyQuarantine(reportOf({ 'preset-nvidia': true }), 2_000));
  assert.equal(durante.preset, null);
  const depois = resolveHwaccel(
    'auto',
    applyQuarantine(reportOf({ 'preset-nvidia': true }), 2_000 + 16 * 60 * 1000),
  );
  assert.equal(depois.preset, 'preset-nvidia', 'passada a janela, testa de novo');
});

test('quarentena: sucesso zera o contador (falhas esparsas não somam para sempre)', () => {
  __resetHwaccelDetectionCache();
  reportHwaccelFailure('preset-nvidia', 1_000);
  reportHwaccelSuccess('preset-nvidia');
  assert.equal(reportHwaccelFailure('preset-nvidia', 3_000), false);
  assert.equal(isHwaccelQuarantined('preset-nvidia', 3_000), false);
});

// ── Detecção completa com cache ─────────────────────────────────────────────

test('detecção: o teste real roda UMA vez e fica em cache (é caro)', async () => {
  __resetHwaccelDetectionCache();
  const { exec, calls } = fakeFfmpeg({ encodeWorks: ['nvidia'] });
  const opts = { exec, listRenderNodes: renderNodes, probeFile: '/tmp/p.mp4', mode: 'auto' as const };
  const a = await detectTranscodeHwaccel(opts);
  const chamadasApos1 = calls.length;
  const b = await detectTranscodeHwaccel(opts);
  assert.equal(a.preset, 'preset-nvidia');
  assert.equal(b.preset, 'preset-nvidia');
  assert.equal(calls.length, chamadasApos1, 'a segunda consulta não pode reexecutar ffmpeg');
  __resetHwaccelDetectionCache();
});

test('detecção: modo cpu nem sequer é enganado por um host acelerado', async () => {
  __resetHwaccelDetectionCache();
  const { exec } = fakeFfmpeg({ encodeWorks: ['nvidia'] });
  const d = await detectTranscodeHwaccel({
    exec,
    listRenderNodes: renderNodes,
    probeFile: '/tmp/p.mp4',
    mode: 'cpu',
  });
  assert.equal(d.usingCpu, true);
  __resetHwaccelDetectionCache();
});
