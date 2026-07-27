import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuService } from '../src/gpu/gpu.service';
import {
  __resetHwaccelDetectionCache,
  type FfmpegExec,
} from '../src/camera-stream/helpers/hwaccel-presets.helper';

// ── O falso positivo que existia ────────────────────────────────────────────
// getStatus/verify concluíam "GPU pronta" a partir de `ffmpeg -encoders`, que
// só prova COMPILAÇÃO. Este host é a prova viva do problema: o ffmpeg lista
// h264_nvenc/h264_vaapi/h264_qsv e NENHUM abre o hardware. O painel dizia
// "encoder acelerado ✓" e o admin ligava uma aceleração inexistente.

const ENCODERS = [
  ' V....D h264_nvenc  NVIDIA NVENC H.264 encoder (codec h264)',
  ' V..... h264_qsv    H.264 (Intel Quick Sync Video acceleration) (codec h264)',
  ' V....D h264_vaapi  H.264/AVC (VAAPI) (codec h264)',
].join('\n');

function ffmpegFake(options: { funciona?: boolean } = {}): FfmpegExec {
  return async (args) => {
    if (args.includes('-encoders')) return { ok: true, stdout: ENCODERS, stderr: '' };
    if (options.funciona) return { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: '[h264_nvenc @ 0x1] Cannot load libcuda.so.1' };
  };
}

function makeGpuService(options: {
  funciona?: boolean;
  nvidiaSmi?: boolean;
  declaraNvenc?: boolean;
  mode?: 'auto' | 'cpu';
}) {
  __resetHwaccelDetectionCache();
  const svc: any = Object.create(GpuService.prototype);
  svc.logger = { log: () => {}, warn: () => {}, error: () => {} };
  svc.config = {
    get: (key: string) =>
      key === 'gpuTranscodeAvailable' ? (options.declaraNvenc ? 'true' : '') : undefined,
  };
  svc.settings = {
    isGpuAccelerationEnabled: async () => false,
    isAiFeatureEnabled: async () => false,
    isGpuAiAccelerationEnabled: async () => false,
  };
  // nvidia-smi / ffmpeg -encoders do próprio serviço.
  svc.exec = async (cmd: string, args: string[]) => {
    if (cmd === 'nvidia-smi') {
      return options.nvidiaSmi
        ? { ok: true, stdout: 'NVIDIA RTX A2000, 550.54.14, 6144\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'command not found' };
    }
    return ffmpegFake(options)(args);
  };
  svc.probeAiRuntime = async () => ({ reachable: false, runtime: null, device: null });
  svc.hwaccelProbeOptions = () => ({
    exec: ffmpegFake(options),
    listRenderNodes: async () => ['/dev/dri/renderD128'],
    probeFile: '/tmp/drac-teste-probe.mp4',
    mode: options.mode ?? ('auto' as const),
  });
  return svc as GpuService;
}

test('status: encoders COMPILADOS + hardware morto ⇒ NÃO está pronto (era falso positivo)', async () => {
  const svc = makeGpuService({ funciona: false, nvidiaSmi: true });
  const status = await svc.getStatus();
  assert.equal(status.hwaccel.compiled.nvenc, true, 'o ffmpeg realmente anuncia o encoder');
  assert.equal(status.checks.transcodeAccelProven, false, 'mas nada foi comprovado');
  assert.equal(status.checks.transcodeAccel, false, 'e portanto o transcode NÃO está acelerado');
  assert.equal(status.ready, false);
});

test('status: quando o encode+decode reais passam, aí sim fica pronto', async () => {
  const svc = makeGpuService({ funciona: true, nvidiaSmi: true });
  const status = await svc.getStatus();
  assert.equal(status.checks.transcodeAccelProven, true);
  assert.equal(status.checks.transcodeAccel, true);
  assert.equal(status.ready, true);
  assert.equal(status.hwaccel.preset, 'preset-nvidia', 'NVIDIA é a primeira da ordem de preferência');
  assert.ok(status.hwaccel.provenPresets.includes('preset-nvidia'));
  assert.equal(status.hwaccel.proven, true);
});

test('status: o AVISO do hardware que não responde chega na tela (hints)', async () => {
  const svc = makeGpuService({ funciona: false, nvidiaSmi: true });
  const status = await svc.getStatus();
  assert.equal(status.hwaccel.degraded, true);
  assert.ok(
    status.hints.some((h) => /NENHUM funcionou de verdade/.test(h)),
    `o painel precisa mostrar o motivo — hints: ${JSON.stringify(status.hints)}`,
  );
  assert.ok(
    status.hints.some((h) => /Cannot load libcuda/.test(h)),
    'o erro real do ffmpeg tem de aparecer, não uma mensagem genérica',
  );
});

test('status: modo cpu roda em CPU sem acusar degradação (é escolha, não falha)', async () => {
  const svc = makeGpuService({ funciona: true, nvidiaSmi: true, mode: 'cpu' });
  const status = await svc.getStatus();
  assert.equal(status.hwaccel.preset, null, 'o transcode não usa GPU');
  assert.equal(status.hwaccel.degraded, false);
  assert.equal(status.checks.transcodeAccelProven, true, 'mas o hardware continua comprovado');
});

test('verify: reprova quando o encoder existe e o hardware não responde', async () => {
  const svc = makeGpuService({ funciona: false, nvidiaSmi: true });
  const r = await svc.verify();
  assert.equal(r.ok, false);
  assert.equal(r.proven, false);
  assert.match(r.message, /NENHUM funcionou de verdade/);
  assert.match(r.message, /Cannot load libcuda/);
});

test('verify: aprova com encode+decode reais e diz que foi COMPROVADO', async () => {
  const svc = makeGpuService({ funciona: true, nvidiaSmi: true });
  const r = await svc.verify();
  assert.equal(r.ok, true);
  assert.equal(r.proven, true);
  assert.equal(r.encoder, 'h264_nvenc');
  assert.match(r.message, /Encode \+ decode de teste/);
});

test('verify: sinal DECLARADO por outro container nunca se disfarça de comprovado', async () => {
  // O NVENC do MediaMTX não pode ser testado a partir da API. Continuamos
  // aceitando o sinal, mas ele sai marcado como NÃO comprovado.
  const svc = makeGpuService({ funciona: false, nvidiaSmi: true, declaraNvenc: true });
  const r = await svc.verify();
  assert.equal(r.ok, true);
  assert.equal(r.proven, false, 'declarado ≠ comprovado');
  assert.match(r.message, /DECLARA ter NVENC/);
});
