import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  PRESETS_HW_ACCEL_DECODE,
  PRESETS_HW_ACCEL_SCALE,
  buildHwaccelDecodeTable,
  hwaccelDecodeArgs,
  hwaccelScaleArgs,
  buildCpuTranscodeArgs,
  buildCompatibleTranscodeArgs,
} from '../src/camera-stream/helpers/hwaccel-presets.helper';

const FRIGATE_PRESETS = '../../concorrentes/frigate/frigate/ffmpeg_presets.py';

// ── Tabela de DECODE: portada 1:1 do Frigate (MIT) ───────────────────────────

test('decode: VAAPI sai com os argumentos exatos do preset portado', () => {
  assert.deepEqual(hwaccelDecodeArgs('preset-vaapi', { device: '/dev/dri/renderD128' }), [
    '-hwaccel_flags',
    'allow_profile_mismatch',
    '-hwaccel',
    'vaapi',
    '-hwaccel_device',
    '/dev/dri/renderD128',
    '-hwaccel_output_format',
    'vaapi',
  ]);
});

test('decode: NVIDIA sai com os argumentos exatos e o índice da GPU', () => {
  assert.deepEqual(hwaccelDecodeArgs('preset-nvidia', { device: '0' }), [
    '-hwaccel_device',
    '0',
    '-hwaccel',
    'cuda',
    '-hwaccel_output_format',
    'cuda',
  ]);
});

test('decode: QSV h264 e h265 (h265 carrega o plugin, h264 fixa o codec)', () => {
  assert.deepEqual(hwaccelDecodeArgs('preset-intel-qsv-h264', { device: '/dev/dri/renderD128' }), [
    '-hwaccel',
    'qsv',
    '-qsv_device',
    '/dev/dri/renderD128',
    '-hwaccel_output_format',
    'qsv',
    '-c:v',
    'h264_qsv',
  ]);
  assert.deepEqual(hwaccelDecodeArgs('preset-intel-qsv-h265', { device: '/dev/dri/renderD128' }), [
    '-load_plugin',
    'hevc_hw',
    '-hwaccel',
    'qsv',
    '-qsv_device',
    '/dev/dri/renderD128',
    '-hwaccel_output_format',
    'qsv',
  ]);
});

test('decode: jetson usa {1}x{2} (redimensiona no próprio decoder)', () => {
  assert.deepEqual(hwaccelDecodeArgs('preset-jetson-h265', { width: 1280, height: 720 }), [
    '-c:v',
    'hevc_nvmpi',
    '-resize',
    '1280x720',
  ]);
});

test('decode: `-bsf:v dump_extra` só existe a partir do libavformat 61 (QSV e RKMPP)', () => {
  const antigo = buildHwaccelDecodeTable(59);
  const novo = buildHwaccelDecodeTable(61);
  assert.ok(!antigo['preset-intel-qsv-h264'].includes('dump_extra'));
  assert.ok(!antigo['preset-rkmpp'].includes('dump_extra'));
  assert.ok(novo['preset-intel-qsv-h264'].endsWith('-bsf:v dump_extra'));
  assert.ok(novo['preset-intel-qsv-h265'].endsWith('-bsf:v dump_extra'));
  assert.ok(novo['preset-rkmpp'].endsWith('-bsf:v dump_extra'));
  // O apelido `-no-dump_extra` NUNCA leva o bitstream filter, em nenhuma versão.
  assert.ok(!novo['preset-rkmpp-no-dump_extra'].includes('dump_extra'));
});

test('decode: apelidos apontam para o mesmo preset (como no Frigate)', () => {
  for (const alias of ['preset-nvidia-h264', 'preset-nvidia-h265', 'preset-nvidia-mjpeg'] as const) {
    assert.equal(PRESETS_HW_ACCEL_DECODE[alias], PRESETS_HW_ACCEL_DECODE['preset-nvidia']);
    assert.equal(PRESETS_HW_ACCEL_SCALE[alias], PRESETS_HW_ACCEL_SCALE['preset-nvidia']);
  }
  for (const alias of ['preset-rk-h264', 'preset-rk-h265'] as const) {
    assert.equal(PRESETS_HW_ACCEL_DECODE[alias], PRESETS_HW_ACCEL_DECODE['preset-rkmpp']);
  }
});

test('decode: preset que exige dispositivo EXPLODE sem dispositivo (nada de flag órfã)', () => {
  // `-hwaccel_device` sem valor engole o próximo argumento e produz um comando
  // que falha de forma obscura. Melhor falhar aqui, alto e claro.
  assert.throws(() => hwaccelDecodeArgs('preset-vaapi', { device: '' }), /exige um dispositivo/);
  assert.throws(() => hwaccelDecodeArgs('preset-nvidia', {}), /exige um dispositivo/);
  // Presets sem {3} continuam funcionando sem dispositivo.
  assert.deepEqual(hwaccelDecodeArgs('preset-rpi-64-h264'), ['-c:v:1', 'h264_v4l2m2m']);
});

// ── DIVERGÊNCIA DELIBERADA: nós NÃO copiamos o hwdownload ────────────────────

test('DIVERGÊNCIA: nenhum preset de scale nosso baixa o frame da GPU', () => {
  for (const [nome, template] of Object.entries(PRESETS_HW_ACCEL_SCALE)) {
    assert.ok(
      !template.includes('hwdownload'),
      `${nome} não pode conter hwdownload — o frame tem de ficar na GPU até o encoder`,
    );
    assert.ok(
      !template.includes('hwmap=mode=read'),
      `${nome} não pode conter hwmap=mode=read (é o hwdownload do rkmpp)`,
    );
  }
});

test('DIVERGÊNCIA: o Frigate REALMENTE tem hwdownload — a divergência não é fictícia', () => {
  // Se este teste começar a falhar porque o upstream mudou, o teste acima perde
  // o sentido: revise a divergência antes de mexer.
  if (!existsSync(FRIGATE_PRESETS)) {
    // Sem a cópia do concorrente no disco não dá para comparar; o teste acima
    // (que trava a NOSSA tabela) continua valendo sozinho.
    return;
  }
  const upstream = readFileSync(FRIGATE_PRESETS, 'utf8');
  const bloco = upstream.slice(
    upstream.indexOf('PRESETS_HW_ACCEL_SCALE = {'),
    upstream.indexOf('# Presets for FFMPEG Stream Encoding'),
  );
  assert.ok(bloco.length > 0, 'esperava encontrar a tabela de scale do Frigate');
  assert.match(bloco, /scale_vaapi=w=\{1\}:h=\{2\},hwdownload,format=nv12/);
  assert.match(bloco, /scale_cuda=w=\{1\}:h=\{2\},hwdownload,format=nv12/);
  assert.match(bloco, /hwmap=mode=read/);
});

test('scale: o caminho CPU (`default`) é IDÊNTICO ao do Frigate', () => {
  assert.equal(PRESETS_HW_ACCEL_SCALE.default, '-r {0} -vf fps={0},scale={1}:{2}');
  assert.deepEqual(hwaccelScaleArgs('default', { fps: 20, width: 1280, height: 720 }), [
    '-r',
    '20',
    '-vf',
    'fps=20,scale=1280:720',
  ]);
});

test('scale: argumentos exatos dos presets acelerados (sem hwdownload)', () => {
  assert.deepEqual(hwaccelScaleArgs('preset-nvidia', { fps: 20, width: 1280, height: 720 }), [
    '-r',
    '20',
    '-vf',
    'fps=20,scale_cuda=w=1280:h=720',
  ]);
  assert.deepEqual(hwaccelScaleArgs('preset-vaapi', { fps: 15, width: 640, height: 360 }), [
    '-r',
    '15',
    '-vf',
    'fps=15,scale_vaapi=w=640:h=360',
  ]);
  assert.deepEqual(hwaccelScaleArgs('preset-intel-qsv-h264', { fps: 10, width: 800, height: 600 }), [
    '-r',
    '10',
    '-vf',
    'vpp_qsv=w=800:h=600:format=nv12,fps=10',
  ]);
  // jetson escala no decoder: o scale só ajusta a taxa.
  assert.deepEqual(hwaccelScaleArgs('preset-jetson-h264', { fps: 12, width: 1, height: 1 }), [
    '-r',
    '12',
  ]);
});

// ── Transcode do playback compatível ────────────────────────────────────────

test('transcode CPU: os argumentos são exatamente os que produção já rodava', () => {
  assert.deepEqual(buildCpuTranscodeArgs('/in.mkv', '/out.mp4.tmp'), [
    '-y', '-i', '/in.mkv',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
    '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', '/out.mp4.tmp',
  ]);
  assert.deepEqual(
    buildCompatibleTranscodeArgs({ input: '/in.mkv', output: '/out.mp4.tmp', preset: null }),
    buildCpuTranscodeArgs('/in.mkv', '/out.mp4.tmp'),
  );
});

test('transcode acelerado: decode e encode na GPU, sem filtro e sem -pix_fmt', () => {
  const args = buildCompatibleTranscodeArgs({
    input: '/in.mkv',
    output: '/out.mp4.tmp',
    preset: 'preset-nvidia',
    device: '0',
  });
  assert.deepEqual(args, [
    '-y',
    '-hwaccel_device', '0', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
    '-i', '/in.mkv',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21',
    '-profile:v', 'high', '-level', '4.1',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', '/out.mp4.tmp',
  ]);
  // -pix_fmt yuv420p forçaria o download do frame para a RAM: é o hwdownload
  // pela porta dos fundos.
  assert.ok(!args.includes('-pix_fmt'), 'o caminho acelerado não pode forçar pix_fmt');
  assert.ok(!args.includes('-vf'), 'preservando a resolução, não há filtro nenhum');
  assert.ok(!args.some((a) => a.includes('hwdownload')));
});

test('transcode acelerado: VAAPI usa o render node e mantém a superfície de hardware', () => {
  const args = buildCompatibleTranscodeArgs({
    input: '/in.mkv',
    output: '/out.mp4.tmp',
    preset: 'preset-vaapi',
    device: '/dev/dri/renderD128',
  });
  assert.deepEqual(args.slice(0, 10), [
    '-y',
    '-hwaccel_flags', 'allow_profile_mismatch',
    '-hwaccel', 'vaapi',
    '-hwaccel_device', '/dev/dri/renderD128',
    '-hwaccel_output_format', 'vaapi',
    '-i',
  ]);
  assert.ok(args.includes('h264_vaapi'));
  assert.ok(!args.some((a) => a.includes('hwdownload')));
});

test('transcode: preset sem encoder conhecido cai para CPU (não monta comando inválido)', () => {
  // preset-vulkan tem decode mas não tem encode na nossa tabela: em vez de
  // emitir um comando sem `-c:v`, devolvemos o caminho CPU.
  assert.deepEqual(
    buildCompatibleTranscodeArgs({ input: '/in.mkv', output: '/out.tmp', preset: 'preset-vulkan' }),
    buildCpuTranscodeArgs('/in.mkv', '/out.tmp'),
  );
});
