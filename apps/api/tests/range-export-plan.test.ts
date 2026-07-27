import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planRangeExport,
  buildConcatManifest,
  buildRangeCopyArgs,
  buildRangeTranscodeArgs,
  buildRangeExportAttempts,
  type RangeSourceSegment,
} from '../src/recordings/helpers/range-export.helper';
import { buildCpuTranscodeArgs } from '../src/camera-stream/helpers/hwaccel-presets.helper';

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTAÇÃO POR INTERVALO (achado da análise do Frigate — frigate/api/export.py
// e frigate/record/export.py). O `exportClip` de hoje recebe UM recordingId e
// offsets DENTRO daquele arquivo. Com segmento de 300s (60s no modo movimento),
// um evento de 3 minutos que cruza a borda NÃO CABE em um segmento — e isso é
// prova judicial. Aqui o plano é montado a partir do INTERVALO, juntando os N
// segmentos que o cobrem.
//
// Este arquivo cobre a parte PURA (nada de I/O): seleção/recorte dos segmentos,
// decisão stream-copy × transcode, manifesto do demuxer concat e a ordem das
// tentativas de ffmpeg.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-07-27T10:00:00.000Z');
const min = (m: number) => T0 + m * 60_000;

function seg(over: Partial<RangeSourceSegment> & { id: string; startedAt: number }): RangeSourceSegment {
  return {
    filePath: `/rec/cam-1/${over.id}.mp4`,
    durationSeconds: 300,
    videoCodec: 'h264',
    audioCodec: null,
    ...over,
  };
}

const TRES_SEGMENTOS: RangeSourceSegment[] = [
  seg({ id: 's1', startedAt: min(0) }),
  seg({ id: 's2', startedAt: min(5) }),
  seg({ id: 's3', startedAt: min(10) }),
];

test('intervalo que atravessa 3 segmentos vira UM plano contínuo, na ordem do relógio', () => {
  const plan = planRangeExport({
    segments: TRES_SEGMENTOS,
    from: min(4.5),
    to: min(11),
    copySafetySeconds: 0,
  });

  assert.deepEqual(plan.parts.map((p) => p.recordingId), ['s1', 's2', 's3']);
  assert.deepEqual(
    plan.parts.map((p) => [p.inpointSeconds, p.outpointSeconds, p.durationSeconds, p.offsetSeconds]),
    [
      [270, 300, 30, 0],
      [0, 300, 300, 30],
      [0, 60, 60, 330],
    ],
    'o recorte tem de casar borda com borda: um único vídeo, sem repetir nem pular',
  );
  assert.equal(plan.totalDurationSeconds, 390, '6min30 pedidos = 390s de vídeo');
  assert.deepEqual(plan.gaps, [], 'gravação contínua não tem buraco');
  assert.equal(plan.continuous, true);
  assert.equal(plan.coveredFrom, new Date(min(4.5)).toISOString());
  assert.equal(plan.coveredTo, new Date(min(11)).toISOString());
  assert.equal(plan.requestedSeconds, 390);
  assert.equal(plan.coveredSeconds, 390);
});

test('stream-copy quando os codecs permitem (rápido e SEM PERDA)', () => {
  const plan = planRangeExport({ segments: TRES_SEGMENTOS, from: min(4.5), to: min(11) });
  assert.equal(plan.strategy, 'copy');
  assert.deepEqual(plan.strategyReasons, []);
  assert.equal(plan.videoCodec, 'h264');
  assert.equal(plan.tagHvc1, false);
});

test('codec de vídeo MISTO no intervalo ⇒ transcode obrigatório (copy sairia quebrado)', () => {
  const plan = planRangeExport({
    segments: [
      seg({ id: 's1', startedAt: min(0), videoCodec: 'h264' }),
      seg({ id: 's2', startedAt: min(5), videoCodec: 'hevc' }),
    ],
    from: min(4.5),
    to: min(6),
  });
  assert.equal(plan.strategy, 'transcode');
  assert.ok(
    plan.strategyReasons.some((r) => r.startsWith('codec_video_misto:')),
    `motivo precisa nomear a mistura — ${JSON.stringify(plan.strategyReasons)}`,
  );
});

test('codec DESCONHECIDO ⇒ transcode: nunca apostamos num copy que pode sair corrompido', () => {
  const plan = planRangeExport({
    segments: [
      seg({ id: 's1', startedAt: min(0) }),
      seg({ id: 's2', startedAt: min(5), videoCodec: null }),
    ],
    from: min(4.5),
    to: min(6),
  });
  assert.equal(plan.strategy, 'transcode');
  assert.ok(plan.strategyReasons.some((r) => r === 'codec_desconhecido:s2'));
});

test('codec de vídeo não copiável para MP4 (mjpeg) ⇒ transcode', () => {
  const plan = planRangeExport({
    segments: [seg({ id: 's1', startedAt: min(0), videoCodec: 'mjpeg' })],
    from: min(1),
    to: min(2),
  });
  assert.equal(plan.strategy, 'transcode');
  assert.ok(plan.strategyReasons.some((r) => r === 'codec_video_nao_copiavel:mjpeg'));
});

test('áudio presente em uns segmentos e ausente em outros ⇒ transcode', () => {
  const plan = planRangeExport({
    segments: [
      seg({ id: 's1', startedAt: min(0), audioCodec: 'aac' }),
      seg({ id: 's2', startedAt: min(5), audioCodec: null }),
    ],
    from: min(4.5),
    to: min(6),
  });
  assert.equal(plan.strategy, 'transcode');
  assert.ok(plan.strategyReasons.some((r) => r.startsWith('audio_misto:')));
});

test('áudio não copiável para MP4 (pcm) ⇒ transcode', () => {
  const plan = planRangeExport({
    segments: [seg({ id: 's1', startedAt: min(0), audioCodec: 'pcm_s16le' })],
    from: min(1),
    to: min(2),
  });
  assert.equal(plan.strategy, 'transcode');
  assert.ok(plan.strategyReasons.some((r) => r === 'codec_audio_nao_copiavel:pcm_s16le'));
});

test('perfil "compatible" força transcode mesmo com codecs uniformes de H.265', () => {
  const hevc = [seg({ id: 's1', startedAt: min(0), videoCodec: 'hevc' })];
  const auto = planRangeExport({ segments: hevc, from: min(1), to: min(2) });
  assert.equal(auto.strategy, 'copy', 'HEVC uniforme é copiável — o navegador é problema de quem pediu compatível');
  assert.equal(auto.tagHvc1, true, 'HEVC em MP4 exige a tag hvc1, senão o arquivo não abre em player nenhum');

  const compat = planRangeExport({ segments: hevc, from: min(1), to: min(2), forceTranscode: true });
  assert.equal(compat.strategy, 'transcode');
  assert.ok(compat.strategyReasons.includes('perfil_compativel_solicitado'));
});

test('margem de keyframe no copy: PRESERVA o instante pedido (nunca corta para dentro)', () => {
  const plan = planRangeExport({
    segments: TRES_SEGMENTOS,
    from: min(4.5),
    to: min(11),
    copySafetySeconds: 2,
  });
  assert.equal(plan.parts[0].inpointSeconds, 268, 'o copy corta no keyframe seguinte: recuamos 2s para não perder o começo');
  assert.equal(plan.parts[2].outpointSeconds, 62, 'e sobramos 2s no fim pelo mesmo motivo');
  assert.equal(plan.leadInSeconds, 2);
  assert.equal(plan.leadOutSeconds, 2);
  assert.equal(plan.coveredFrom, new Date(min(4.5) - 2000).toISOString(), 'o arquivo cobre MAIS que o pedido, nunca menos');
  assert.equal(plan.coveredTo, new Date(min(11) + 2000).toISOString());
  assert.deepEqual(
    plan.parts.map((p) => p.offsetSeconds),
    [0, 32, 332],
    'a margem entra na linha do tempo do arquivo final',
  );
});

test('no transcode o corte é EXATO — margem de keyframe não existe', () => {
  const plan = planRangeExport({
    segments: TRES_SEGMENTOS,
    from: min(4.5),
    to: min(11),
    copySafetySeconds: 2,
    forceTranscode: true,
  });
  assert.equal(plan.parts[0].inpointSeconds, 270);
  assert.equal(plan.parts[2].outpointSeconds, 60);
  assert.equal(plan.leadInSeconds, 0);
  assert.equal(plan.leadOutSeconds, 0);
});

test('a margem nunca ultrapassa a borda do arquivo de origem', () => {
  const plan = planRangeExport({
    segments: [seg({ id: 's1', startedAt: min(0) })],
    from: min(0),
    to: min(5),
    copySafetySeconds: 30,
  });
  assert.equal(plan.parts[0].inpointSeconds, 0, 'não existe tempo negativo dentro do arquivo');
  assert.equal(plan.parts[0].outpointSeconds, 300, 'nem tempo além do fim do arquivo');
  assert.equal(plan.leadInSeconds, 0);
  assert.equal(plan.leadOutSeconds, 0);
});

test('buraco na gravação é REPORTADO, não escondido pela emenda', () => {
  const plan = planRangeExport({
    segments: [
      seg({ id: 's1', startedAt: min(0) }),
      // s2 só começa em 10:07 — dois minutos sem gravação no meio do pedido
      seg({ id: 's2', startedAt: min(7) }),
    ],
    from: min(4),
    to: min(9),
    copySafetySeconds: 0,
  });
  assert.equal(plan.parts.length, 2);
  assert.equal(plan.continuous, false, 'prova com emenda invisível é prova ruim');
  assert.deepEqual(plan.gaps, [
    { from: new Date(min(5)).toISOString(), to: new Date(min(7)).toISOString(), seconds: 120 },
  ]);
  assert.equal(plan.requestedSeconds, 300);
  assert.equal(plan.coveredSeconds, 180, 'só 3 dos 5 minutos pedidos existem em disco');
});

test('borda sem gravação vira buraco no começo e no fim', () => {
  const plan = planRangeExport({
    segments: [seg({ id: 's1', startedAt: min(5) })],
    from: min(4),
    to: min(11),
    copySafetySeconds: 0,
  });
  assert.deepEqual(plan.gaps, [
    { from: new Date(min(4)).toISOString(), to: new Date(min(5)).toISOString(), seconds: 60 },
    { from: new Date(min(10)).toISOString(), to: new Date(min(11)).toISOString(), seconds: 60 },
  ]);
});

test('segmento que só ENCOSTA na borda fica de fora (não há conteúdo pedido nele)', () => {
  const plan = planRangeExport({
    segments: [
      seg({ id: 'antes', startedAt: min(0) }), // termina exatamente em min(5)
      seg({ id: 'dentro', startedAt: min(5) }),
      seg({ id: 'depois', startedAt: min(10) }), // começa exatamente em min(10)
    ],
    from: min(5),
    to: min(10),
  });
  assert.deepEqual(plan.parts.map((p) => p.recordingId), ['dentro']);
});

test('segmento sem duração utilizável é DESCARTADO (EXTINF mentiroso desalinha tudo)', () => {
  const plan = planRangeExport({
    segments: [
      { id: 'ruim', filePath: '/rec/ruim.mp4', startedAt: min(4), durationSeconds: null, videoCodec: 'h264' },
      seg({ id: 'bom', startedAt: min(5) }),
    ],
    from: min(4),
    to: min(6),
  });
  assert.deepEqual(plan.parts.map((p) => p.recordingId), ['bom']);
  assert.equal(plan.skipped, 1);
});

test('teto de segmentos: corta e AVISA que cortou', () => {
  const muitos = Array.from({ length: 5 }, (_, i) => seg({ id: `s${i}`, startedAt: min(i * 5) }));
  const plan = planRangeExport({ segments: muitos, from: min(0), to: min(25), maxSegments: 3 });
  assert.equal(plan.parts.length, 3);
  assert.equal(plan.truncated, true);
  assert.equal(plan.coveredTo, new Date(min(15)).toISOString(), 'a cobertura reportada é a do que REALMENTE entrou');
});

test('intervalo sem nenhum segmento: plano vazio e honesto', () => {
  const plan = planRangeExport({ segments: [], from: min(0), to: min(5) });
  assert.deepEqual(plan.parts, []);
  assert.equal(plan.totalDurationSeconds, 0);
  assert.equal(plan.coveredFrom, null);
  assert.equal(plan.continuous, false);
  assert.equal(plan.coveredSeconds, 0);
});

test('intervalo invertido é rejeitado na origem', () => {
  assert.throws(() => planRangeExport({ segments: TRES_SEGMENTOS, from: min(5), to: min(4) }), /interval|intervalo/i);
});

// ── Manifesto do demuxer concat ──────────────────────────────────────────────

test('manifesto concat: só emite inpoint/outpoint onde REALMENTE há recorte', () => {
  const plan = planRangeExport({ segments: TRES_SEGMENTOS, from: min(4.5), to: min(11), copySafetySeconds: 0 });
  const manifest = buildConcatManifest(plan);
  assert.equal(
    manifest,
    [
      'ffconcat version 1.0',
      "file '/rec/cam-1/s1.mp4'",
      'inpoint 270.000',
      "file '/rec/cam-1/s2.mp4'",
      "file '/rec/cam-1/s3.mp4'",
      'outpoint 60.000',
      '',
    ].join('\n'),
  );
});

test('manifesto concat: aspas no caminho são escapadas (senão o ffmpeg lê outro arquivo)', () => {
  const plan = planRangeExport({
    segments: [seg({ id: 's1', startedAt: min(0), filePath: "/rec/cam d'agua/s1.mp4" })],
    from: min(0),
    to: min(5),
  });
  const manifest = buildConcatManifest(plan);
  assert.ok(manifest.includes("file '/rec/cam d'\\''agua/s1.mp4'"), manifest);
});

test('manifesto concat: quebra de linha no caminho é recusada, não escapada', () => {
  const plan = planRangeExport({
    segments: [seg({ id: 's1', startedAt: min(0), filePath: '/rec/mau\ncaminho.mp4' })],
    from: min(0),
    to: min(5),
  });
  assert.throws(() => buildConcatManifest(plan), /linha|newline/i);
});

// ── Comandos de ffmpeg ───────────────────────────────────────────────────────

test('copy: -c copy sobre o concat, com faststart e sem reencodar nada', () => {
  const args = buildRangeCopyArgs({ manifestPath: '/tmp/m.txt', output: '/out/e.mp4', tagHvc1: false });
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 5), ['-f', 'concat', '-safe', '0', '-i']);
  assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === 'copy');
  assert.ok(!args.includes('libx264'), 'copy que reencoda não é copy');
  assert.equal(args[args.length - 1], '/out/e.mp4');
  assert.ok(!args.includes('-tag:v'));
});

test('copy de HEVC recebe -tag:v hvc1 (sem isso o MP4 não abre)', () => {
  const args = buildRangeCopyArgs({ manifestPath: '/tmp/m.txt', output: '/out/e.mp4', tagHvc1: true });
  assert.equal(args[args.indexOf('-tag:v') + 1], 'hvc1');
});

test('transcode em CPU reusa os argumentos JÁ VALIDADOS do playback compatível', () => {
  const args = buildRangeTranscodeArgs({ manifestPath: '/tmp/m.txt', output: '/out/e.mp4', preset: null });
  const base = buildCpuTranscodeArgs('/tmp/m.txt', '/out/e.mp4');
  const idx = base.indexOf('-i');
  const esperado = [...base.slice(0, idx), '-f', 'concat', '-safe', '0', ...base.slice(idx)];
  assert.deepEqual(args, esperado, 'os parâmetros de encode são fonte única — aqui só entra o input concat');
  assert.equal(args[args.indexOf('-i') - 1], '0', '-safe 0 precisa vir ANTES do -i, senão o ffmpeg recusa caminho absoluto');
});

test('transcode acelerado: hwaccel entra antes do input concat', () => {
  const args = buildRangeTranscodeArgs({
    manifestPath: '/tmp/m.txt',
    output: '/out/e.mp4',
    preset: 'preset-nvidia',
    device: '0',
  });
  assert.ok(args.includes('-hwaccel'));
  assert.ok(args.includes('h264_nvenc'));
  assert.ok(args.indexOf('-hwaccel') < args.indexOf('-f'), 'o hwaccel é opção de INPUT: depois do -i não tem efeito');
  assert.ok(!args.includes('libx264'));
});

// ── Ordem das tentativas (a rede de proteção do Frigate, record/export.py) ────

test('plano copiável: a PRIMEIRA tentativa é stream-copy, com transcode só de reserva', () => {
  const plan = planRangeExport({ segments: TRES_SEGMENTOS, from: min(4.5), to: min(11) });
  const attempts = buildRangeExportAttempts({
    plan,
    manifestPath: '/tmp/m.txt',
    output: '/out/e.mp4',
    hwaccel: { preset: 'preset-nvidia', device: '0' },
  });
  assert.deepEqual(attempts.map((a) => a.kind), ['copy', 'transcode', 'transcode']);
  assert.deepEqual(attempts.map((a) => a.preset), [null, 'preset-nvidia', null]);
  assert.ok(attempts[0].args.includes('copy'));
});

test('plano NÃO copiável: nenhuma tentativa de copy (ela sairia corrompida)', () => {
  const plan = planRangeExport({
    segments: [
      seg({ id: 's1', startedAt: min(0), videoCodec: 'h264' }),
      seg({ id: 's2', startedAt: min(5), videoCodec: 'hevc' }),
    ],
    from: min(4.5),
    to: min(6),
  });
  const attempts = buildRangeExportAttempts({
    plan,
    manifestPath: '/tmp/m.txt',
    output: '/out/e.mp4',
    hwaccel: { preset: 'preset-vaapi', device: '/dev/dri/renderD128' },
  });
  assert.deepEqual(attempts.map((a) => a.kind), ['transcode', 'transcode']);
  assert.equal(attempts.filter((a) => a.kind === 'copy').length, 0);
  assert.deepEqual(attempts.map((a) => a.preset), ['preset-vaapi', null]);
});

test('sem GPU: uma tentativa acelerada não é inventada', () => {
  const plan = planRangeExport({ segments: TRES_SEGMENTOS, from: min(4.5), to: min(11), forceTranscode: true });
  const attempts = buildRangeExportAttempts({ plan, manifestPath: '/tmp/m.txt', output: '/out/e.mp4', hwaccel: null });
  assert.deepEqual(attempts.map((a) => a.kind), ['transcode']);
  assert.equal(attempts[0].preset, null);
});

test('preset acelerado sem encoder conhecido não vira tentativa duplicada de CPU', () => {
  const plan = planRangeExport({ segments: TRES_SEGMENTOS, from: min(4.5), to: min(11), forceTranscode: true });
  const attempts = buildRangeExportAttempts({
    plan,
    manifestPath: '/tmp/m.txt',
    output: '/out/e.mp4',
    // preset de decode puro: não existe encoder para ele em PRESETS_HW_ACCEL_ENCODE
    hwaccel: { preset: 'preset-rpi-64-h264', device: null },
  });
  assert.deepEqual(attempts.map((a) => a.kind), ['transcode']);
  assert.equal(attempts[0].preset, null, 'sem encoder acelerado o comando é o de CPU — repeti-lo é desperdício');
});
