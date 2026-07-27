// ─────────────────────────────────────────────────────────────────────────────
// Derivado de Frigate (MIT) — Copyright (c) Frigate, Inc.
// Portado de frigate/ffmpeg_presets.py (PRESETS_HW_ACCEL_DECODE,
// PRESETS_HW_ACCEL_SCALE, LibvaGpuSelector) e frigate/util/services.py
// (vainfo_hwaccel). Licença MIT preservada; nenhuma marca/logo utilizada.
// ─────────────────────────────────────────────────────────────────────────────
//
// PARA QUE SERVE AQUI
// O custo medido do nosso preset de grade neste host: decode 59%, scale 18%,
// encode 23%. Ligar só o NVENC ataca 23%. Estas tabelas existem para levar o
// pipeline INTEIRO (decode → scale → encode) para a GPU.
//
// ⚠️ DIVERGÊNCIA DELIBERADA DO FRIGATE — leia antes de "corrigir":
// Os presets de SCALE do Frigate terminam em `hwdownload,format=nv12` (ou
// `hwmap=mode=read,format=yuv420p` no rkmpp) porque o Frigate entrega frames
// CRUS ao detector, que roda na CPU: o frame TEM de descer da GPU.
// O DRAC não detecta nesse caminho — ele RE-ENCODA. Baixar o frame para a RAM
// só para subir de novo ao encoder desperdiça duas travessias PCIe por quadro e
// mata o ganho. Por isso NENHUM preset de scale nosso faz hwdownload: o frame
// nasce na GPU no decode e morre na GPU no encode.
// Consequência prática: a saída destes filtros é uma superfície de hardware —
// só pode alimentar um encoder de hardware (h264_nvenc/h264_vaapi/h264_qsv).
// Se algum dia um consumidor de CPU precisar do frame, ele acrescenta o
// `hwdownload,format=nv12` NO PONTO DE USO; não volte a colocá-lo na tabela.
// O teste tests/hwaccel-presets.test.ts trava essa divergência.

import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Nome de preset (mesmos nomes do Frigate — facilita portar correções de lá). */
export type HwaccelPreset =
  | 'preset-rpi-64-h264'
  | 'preset-rpi-64-h265'
  | 'preset-vaapi'
  | 'preset-intel-qsv-h264'
  | 'preset-intel-qsv-h265'
  | 'preset-nvidia'
  | 'preset-nvidia-h264'
  | 'preset-nvidia-h265'
  | 'preset-nvidia-mjpeg'
  | 'preset-jetson-h264'
  | 'preset-jetson-h265'
  | 'preset-rkmpp'
  | 'preset-rkmpp-no-dump_extra'
  | 'preset-rk-h264'
  | 'preset-rk-h265'
  | 'preset-vulkan'
  | 'preset-amd-amf';

export const HWACCEL_PRESETS: readonly HwaccelPreset[] = [
  'preset-rpi-64-h264',
  'preset-rpi-64-h265',
  'preset-vaapi',
  'preset-intel-qsv-h264',
  'preset-intel-qsv-h265',
  'preset-nvidia',
  'preset-nvidia-h264',
  'preset-nvidia-h265',
  'preset-nvidia-mjpeg',
  'preset-jetson-h264',
  'preset-jetson-h265',
  'preset-rkmpp',
  'preset-rkmpp-no-dump_extra',
  'preset-rk-h264',
  'preset-rk-h265',
  'preset-vulkan',
  'preset-amd-amf',
] as const;

export function isHwaccelPreset(value: unknown): value is HwaccelPreset {
  return typeof value === 'string' && (HWACCEL_PRESETS as readonly string[]).includes(value);
}

/**
 * Igual ao Frigate: `-bsf:v dump_extra` (QSV/RKMPP) só entra a partir do
 * libavformat 61. Ver https://trac.ffmpeg.org/ticket/9766#comment:17
 */
export const DEFAULT_LIBAVFORMAT_VERSION_MAJOR = Number(
  process.env.LIBAVFORMAT_VERSION_MAJOR ?? 59,
);

// ── Presets de DECODE ────────────────────────────────────────────────────────
// Placeholders (idênticos ao Frigate): {0}=fps, {1}=largura, {2}=altura,
// {3}=dispositivo (índice da GPU no NVIDIA, /dev/dri/renderD* no VAAPI/QSV).
export function buildHwaccelDecodeTable(
  libavformatMajor: number = DEFAULT_LIBAVFORMAT_VERSION_MAJOR,
): Record<HwaccelPreset, string> {
  const dumpExtra = libavformatMajor >= 61 ? ' -bsf:v dump_extra' : '';
  const nvidia = '-hwaccel_device {3} -hwaccel cuda -hwaccel_output_format cuda';
  const rkmppNoDumpExtra = '-hwaccel rkmpp -hwaccel_output_format drm_prime';
  const rkmpp = `${rkmppNoDumpExtra}${dumpExtra}`;

  return {
    'preset-rpi-64-h264': '-c:v:1 h264_v4l2m2m',
    'preset-rpi-64-h265': '-c:v:1 hevc_v4l2m2m',
    'preset-vaapi':
      '-hwaccel_flags allow_profile_mismatch -hwaccel vaapi -hwaccel_device {3} -hwaccel_output_format vaapi',
    'preset-intel-qsv-h264': `-hwaccel qsv -qsv_device {3} -hwaccel_output_format qsv -c:v h264_qsv${dumpExtra}`,
    'preset-intel-qsv-h265': `-load_plugin hevc_hw -hwaccel qsv -qsv_device {3} -hwaccel_output_format qsv${dumpExtra}`,
    'preset-nvidia': nvidia,
    'preset-nvidia-h264': nvidia,
    'preset-nvidia-h265': nvidia,
    'preset-nvidia-mjpeg': nvidia,
    'preset-jetson-h264': '-c:v h264_nvmpi -resize {1}x{2}',
    'preset-jetson-h265': '-c:v hevc_nvmpi -resize {1}x{2}',
    'preset-rkmpp': rkmpp,
    'preset-rkmpp-no-dump_extra': rkmppNoDumpExtra,
    'preset-rk-h264': rkmpp,
    'preset-rk-h265': rkmpp,
    // experimentais (idem Frigate)
    'preset-vulkan':
      '-hwaccel vulkan -init_hw_device vulkan=gpu:0 -filter_hw_device gpu -hwaccel_output_format vulkan',
    'preset-amd-amf':
      '-hwaccel amf -init_hw_device amf=gpu:0 -filter_hw_device gpu -hwaccel_output_format amf',
  };
}

export const PRESETS_HW_ACCEL_DECODE: Record<HwaccelPreset, string> = buildHwaccelDecodeTable();

// ── Presets de SCALE ─────────────────────────────────────────────────────────
// SEM `hwdownload` / `hwmap=mode=read` — ver a nota de DIVERGÊNCIA no topo.
// A chave 'default' é o caminho CPU e é IDÊNTICA à do Frigate (lá não há
// hwdownload porque o frame nunca subiu para a GPU).
export type HwaccelScaleKey = HwaccelPreset | 'default';

export const PRESETS_HW_ACCEL_SCALE: Record<HwaccelScaleKey, string> = (() => {
  const cpu = '-r {0} -vf fps={0},scale={1}:{2}';
  const nvidia = '-r {0} -vf fps={0},scale_cuda=w={1}:h={2}';
  const qsv = '-r {0} -vf vpp_qsv=w={1}:h={2}:format=nv12,fps={0}';
  const rkmpp = '-r {0} -vf scale_rkrga=w={1}:h={2}:format=yuv420p:force_original_aspect_ratio=0';

  return {
    'preset-rpi-64-h264': cpu,
    'preset-rpi-64-h265': cpu,
    'preset-vaapi': '-r {0} -vf fps={0},scale_vaapi=w={1}:h={2}',
    'preset-intel-qsv-h264': qsv,
    'preset-intel-qsv-h265': qsv,
    'preset-nvidia': nvidia,
    'preset-nvidia-h264': nvidia,
    'preset-nvidia-h265': nvidia,
    'preset-nvidia-mjpeg': nvidia,
    'preset-jetson-h264': '-r {0}', // o próprio decoder já redimensiona (-resize)
    'preset-jetson-h265': '-r {0}',
    'preset-rkmpp': rkmpp,
    'preset-rkmpp-no-dump_extra': rkmpp,
    'preset-rk-h264': rkmpp,
    'preset-rk-h265': rkmpp,
    default: cpu,
    // experimentais
    'preset-vulkan': '-r {0} -vf fps={0},hwupload,scale_vulkan=w={1}:h={2}',
    'preset-amd-amf': '-r {0} -vf fps={0},hwupload,scale_amf=w={1}:h={2}',
  };
})();

// ── Presets de ENCODE (autoria DRAC, informados pelo birdseye do Frigate) ────
// O destino é SEMPRE H.264 (é o que todo navegador/celular toca) mesmo quando o
// decode é HEVC — mesma escolha do Frigate em PRESETS_HW_ACCEL_ENCODE_BIRDSEYE.
// Qualidade alvo equivalente ao libx264 -crf 18 que rodava antes na CPU.
export const PRESETS_HW_ACCEL_ENCODE: Partial<Record<HwaccelPreset, string>> = {
  'preset-nvidia': '-c:v h264_nvenc -preset p4 -rc vbr -cq 21 -profile:v high -level 4.1',
  'preset-nvidia-h264': '-c:v h264_nvenc -preset p4 -rc vbr -cq 21 -profile:v high -level 4.1',
  'preset-nvidia-h265': '-c:v h264_nvenc -preset p4 -rc vbr -cq 21 -profile:v high -level 4.1',
  'preset-vaapi': '-c:v h264_vaapi -rc_mode CQP -qp 21 -profile:v high',
  'preset-intel-qsv-h264': '-c:v h264_qsv -global_quality 21 -profile:v high',
  'preset-intel-qsv-h265': '-c:v h264_qsv -global_quality 21 -profile:v high',
};

const PLACEHOLDER_DEVICE = '{3}';

function fillTemplate(
  template: string,
  vars: { fps?: number; width?: number; height?: number; device?: string | null },
): string {
  return template
    .replace(/\{0\}/g, String(vars.fps ?? ''))
    .replace(/\{1\}/g, String(vars.width ?? ''))
    .replace(/\{2\}/g, String(vars.height ?? ''))
    .replace(/\{3\}/g, String(vars.device ?? ''));
}

/** Quebra o template já preenchido em argv (espaços em excesso somem). */
export function templateToArgs(template: string): string[] {
  return template.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Argumentos de DECODE. Presets que referenciam {3} exigem dispositivo:
 * emitir `-hwaccel_device` sem valor produz um comando que "quase" funciona e
 * consome o próximo argumento — falha silenciosa. Melhor explodir aqui.
 */
export function hwaccelDecodeArgs(
  preset: HwaccelPreset,
  options: { device?: string | null; width?: number; height?: number; libavformatMajor?: number } = {},
): string[] {
  const table =
    options.libavformatMajor === undefined
      ? PRESETS_HW_ACCEL_DECODE
      : buildHwaccelDecodeTable(options.libavformatMajor);
  const template = table[preset];
  const device = options.device ?? '';
  if (template.includes(PLACEHOLDER_DEVICE) && !device) {
    throw new Error(`Preset ${preset} exige um dispositivo (GPU/render node) e nenhum foi informado.`);
  }
  return templateToArgs(
    fillTemplate(template, { device, width: options.width, height: options.height }),
  );
}

/** Argumentos de SCALE (sem hwdownload — ver DIVERGÊNCIA no topo). */
export function hwaccelScaleArgs(
  preset: HwaccelScaleKey,
  options: { fps: number; width: number; height: number },
): string[] {
  return templateToArgs(fillTemplate(PRESETS_HW_ACCEL_SCALE[preset], options));
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECÇÃO HONESTA
// `ffmpeg -encoders` prova apenas COMPILAÇÃO. Neste próprio host o ffmpeg lista
// h264_nvenc, h264_vaapi e h264_qsv e NENHUM dos três funciona ("Cannot load
// libcuda.so.1", "No VA display found"). Confiar na lista = falso positivo em
// toda VM. Aqui a capacidade só é considerada real depois de um encode E um
// decode CURTOS executados de verdade, no MESMO container que roda o ffmpeg.
// ─────────────────────────────────────────────────────────────────────────────

export type FfmpegExecResult = { ok: boolean; stdout: string; stderr: string };
export type FfmpegExec = (args: string[], timeoutMs?: number) => Promise<FfmpegExecResult>;

/** `auto` = detectar; `cpu` = nunca acelerar; `<preset>` = forçar aquele preset. */
export type HwaccelMode = 'auto' | 'cpu' | HwaccelPreset;

/**
 * Modo tri-estado. Valor desconhecido cai em `auto` — e `auto` é seguro porque
 * NUNCA escolhe um preset que não passou no teste real (diferente do caminho da
 * LIVE, onde o default tem de ser CPU: lá não há como retentar sem derrubar a
 * câmera).
 */
export function normalizeHwaccelMode(value?: string | null): HwaccelMode {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'cpu' || v === 'off' || v === 'none' || v === 'false') return 'cpu';
  if (isHwaccelPreset(v)) return v;
  return 'auto';
}

export type HwaccelProbeReport = {
  /** O que o ffmpeg DIZ ter (compilação). Nunca decide sozinho. */
  compiled: { nvenc: boolean; vaapi: boolean; qsv: boolean };
  /** Render nodes utilizáveis (validados por vainfo, como o LibvaGpuSelector). */
  renderNodes: string[];
  /** O que de fato RODOU: encode + decode curtos executados neste container. */
  proven: Partial<Record<HwaccelPreset, boolean>>;
  /** Motivo da reprovação, por preset (primeira linha útil do stderr). */
  failures: Partial<Record<HwaccelPreset, string>>;
  /** Dispositivo usado no teste que passou. */
  devices: Partial<Record<HwaccelPreset, string>>;
  probedAt: string;
};

export type HwaccelDecision = {
  mode: HwaccelMode;
  /** null = CPU. */
  preset: HwaccelPreset | null;
  device: string | null;
  usingCpu: boolean;
  /** true quando o preset escolhido passou por encode+decode REAIS. */
  proven: boolean;
  /** true quando pediram aceleração e não deu — precisa AVISAR. */
  degraded: boolean;
  reason: string;
  warnings: string[];
};

/** Ordem de preferência do modo `auto`. */
export const AUTO_PROBE_ORDER: readonly HwaccelPreset[] = [
  'preset-nvidia',
  'preset-vaapi',
  'preset-intel-qsv-h264',
] as const;

/**
 * Porta do LibvaGpuSelector do Frigate (ffmpeg_presets.py:28-54), com a mesma
 * escada de decisão: sem /dev/dri → nada; nenhum renderD* → assume o 128;
 * um só → usa esse; vários → mantém apenas os que o vainfo aceita.
 */
export async function selectLibvaDevices(
  entries: string[] | null,
  vainfo: (devicePath: string) => Promise<boolean>,
): Promise<string[]> {
  if (entries === null) return []; // /dev/dri não existe
  const devices = entries.filter((d) => d.startsWith('render'));
  if (devices.length === 0) return ['/dev/dri/renderD128'];
  if (devices.length < 2) return [`/dev/dri/${devices[0]}`];
  const valid: string[] = [];
  for (const device of devices) {
    if (await vainfo(`/dev/dri/${device}`)) valid.push(`/dev/dri/${device}`);
  }
  return valid;
}

/** Encode REAL curtíssimo: abre o dispositivo e roda o encoder de verdade. */
export function buildHwaccelEncodeSmokeArgs(
  preset: HwaccelPreset,
  device: string,
  outputPath: string,
): string[] {
  const common = ['-hide_banner', '-loglevel', 'error', '-y'];
  const source = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-frames:v', '10'];
  if (preset.startsWith('preset-nvidia')) {
    return [...common, ...source, '-c:v', 'h264_nvenc', '-gpu', device, outputPath];
  }
  if (preset === 'preset-vaapi') {
    return [
      ...common,
      '-vaapi_device',
      device,
      ...source,
      '-vf',
      'format=nv12,hwupload',
      '-c:v',
      'h264_vaapi',
      outputPath,
    ];
  }
  if (preset.startsWith('preset-intel-qsv')) {
    return [
      ...common,
      '-init_hw_device',
      `qsv=hw:${device}`,
      '-filter_hw_device',
      'hw',
      ...source,
      '-vf',
      'format=nv12,hwupload=extra_hw_frames=16',
      '-c:v',
      'h264_qsv',
      outputPath,
    ];
  }
  return [...common, ...source, '-c:v', 'libx264', outputPath];
}

/** Decode REAL do arquivo que o encode acabou de produzir, pela tabela portada. */
export function buildHwaccelDecodeSmokeArgs(
  preset: HwaccelPreset,
  device: string,
  inputPath: string,
): string[] {
  // O arquivo da fumaça é H.264; presets de decode específicos de HEVC/MJPEG
  // caem no equivalente H.264 da mesma família.
  const decodePreset: HwaccelPreset = preset.startsWith('preset-nvidia')
    ? 'preset-nvidia'
    : preset.startsWith('preset-intel-qsv')
      ? 'preset-intel-qsv-h264'
      : preset;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...hwaccelDecodeArgs(decodePreset, { device }),
    '-i',
    inputPath,
    '-frames:v',
    '10',
    '-f',
    'null',
    '-',
  ];
}

function firstUsefulLine(text: string): string {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  return (line ?? 'erro desconhecido').slice(0, 200);
}

export async function probeHwaccel(options: {
  exec: FfmpegExec;
  listRenderNodes: () => Promise<string[]>;
  probeFile: string;
  removeProbeFile?: () => Promise<void>;
  candidates?: readonly HwaccelPreset[];
  nvidiaGpuIndex?: string;
}): Promise<HwaccelProbeReport> {
  const candidates = options.candidates ?? AUTO_PROBE_ORDER;
  const encodersOut = await options.exec(['-hide_banner', '-encoders'], 8000);
  const listed = (encodersOut.stdout ?? '').toLowerCase();
  const compiled = {
    nvenc: listed.includes('h264_nvenc'),
    vaapi: listed.includes('h264_vaapi'),
    qsv: listed.includes('h264_qsv'),
  };
  const renderNodes = await options.listRenderNodes();

  const proven: Partial<Record<HwaccelPreset, boolean>> = {};
  const failures: Partial<Record<HwaccelPreset, string>> = {};
  const devices: Partial<Record<HwaccelPreset, string>> = {};

  for (const preset of candidates) {
    const isNvidia = preset.startsWith('preset-nvidia');
    const compiledForPreset = isNvidia
      ? compiled.nvenc
      : preset === 'preset-vaapi'
        ? compiled.vaapi
        : compiled.qsv;
    if (!compiledForPreset) {
      proven[preset] = false;
      failures[preset] = 'encoder não existe neste build do ffmpeg';
      continue;
    }
    const device = isNvidia ? (options.nvidiaGpuIndex ?? '0') : renderNodes[0];
    if (!device) {
      proven[preset] = false;
      failures[preset] = 'nenhum render node (/dev/dri/renderD*) utilizável';
      continue;
    }
    const encode = await options.exec(
      buildHwaccelEncodeSmokeArgs(preset, device, options.probeFile),
      20000,
    );
    if (!encode.ok) {
      proven[preset] = false;
      failures[preset] = firstUsefulLine(encode.stderr);
      continue;
    }
    const decode = await options.exec(
      buildHwaccelDecodeSmokeArgs(preset, device, options.probeFile),
      20000,
    );
    if (!decode.ok) {
      proven[preset] = false;
      failures[preset] = firstUsefulLine(decode.stderr);
      continue;
    }
    proven[preset] = true;
    devices[preset] = device;
  }

  if (options.removeProbeFile) {
    try {
      await options.removeProbeFile();
    } catch {
      /* best-effort */
    }
  }

  return { compiled, renderNodes, proven, failures, devices, probedAt: new Date().toISOString() };
}

function anyCompiled(report: HwaccelProbeReport): boolean {
  return report.compiled.nvenc || report.compiled.vaapi || report.compiled.qsv;
}

/**
 * Decide o caminho a partir do modo e do relatório. Regra de ouro: só entra em
 * aceleração o preset com `proven === true`. Compilado-mas-não-provado é o
 * falso positivo que queremos matar.
 */
export function resolveHwaccel(mode: HwaccelMode, report: HwaccelProbeReport): HwaccelDecision {
  const warnings: string[] = [];

  if (mode === 'cpu') {
    return {
      mode,
      preset: null,
      device: null,
      usingCpu: true,
      proven: false,
      degraded: false, // escolha explícita do operador: não é degradação
      reason: 'Aceleração por hardware desligada por configuração (TRANSCODE_HWACCEL=cpu).',
      warnings,
    };
  }

  const candidates: readonly HwaccelPreset[] = mode === 'auto' ? AUTO_PROBE_ORDER : [mode];
  for (const preset of candidates) {
    if (report.proven[preset] === true) {
      return {
        mode,
        preset,
        device: report.devices[preset] ?? null,
        usingCpu: false,
        proven: true,
        degraded: false,
        reason: `Aceleração ${preset} comprovada por encode+decode reais neste container.`,
        warnings,
      };
    }
  }

  // Chegou aqui: pediram aceleração e não há nenhuma comprovada.
  const detalhes = candidates
    .map((preset) => `${preset}: ${report.failures[preset] ?? 'não testado'}`)
    .join(' | ');

  if (mode !== 'auto') {
    warnings.push(
      `Preset ${mode} foi FORÇADO na configuração mas não funciona neste host (${report.failures[mode] ?? 'não testado'}). Transcodificando em CPU.`,
    );
    return {
      mode,
      preset: null,
      device: null,
      usingCpu: true,
      proven: false,
      degraded: true,
      reason: warnings[0],
      warnings,
    };
  }

  if (anyCompiled(report)) {
    // O caso perigoso: o ffmpeg ANUNCIA os encoders e nenhum abre o hardware.
    warnings.push(
      `O ffmpeg anuncia encoders de GPU, mas NENHUM funcionou de verdade neste host (${detalhes}). Verifique se a GPU foi passada ao container (NVIDIA Container Toolkit / --device /dev/dri) e se o driver VA está instalado na imagem. Transcodificando em CPU.`,
    );
    return {
      mode,
      preset: null,
      device: null,
      usingCpu: true,
      proven: false,
      degraded: true,
      reason: warnings[0],
      warnings,
    };
  }

  return {
    mode,
    preset: null,
    device: null,
    usingCpu: true,
    proven: false,
    degraded: false, // nenhum hardware, nada prometido: comportamento normal
    reason: 'Nenhuma aceleração por hardware disponível neste build do ffmpeg. Transcodificando em CPU.',
    warnings,
  };
}

// ── Montagem do transcode offline (playback compatível) ──────────────────────

/** Argumentos do caminho CPU — CONGELADOS: é o que roda em produção hoje. */
export function buildCpuTranscodeArgs(input: string, output: string): string[] {
  return [
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    output,
  ];
}

/**
 * Transcode do playback compatível. Sem `-vf`: a resolução original é
 * preservada, então o frame decodificado vai DIRETO da GPU ao encoder.
 * Também sem `-pix_fmt yuv420p` no caminho acelerado — forçar formato aqui
 * obrigaria o ffmpeg a baixar o frame para a RAM, exatamente o que a
 * divergência do `hwdownload` evita.
 */
export function buildCompatibleTranscodeArgs(options: {
  input: string;
  output: string;
  preset: HwaccelPreset | null;
  device?: string | null;
}): string[] {
  const { input, output, preset } = options;
  if (!preset) return buildCpuTranscodeArgs(input, output);

  const encode = PRESETS_HW_ACCEL_ENCODE[preset];
  if (!encode) return buildCpuTranscodeArgs(input, output);

  return [
    '-y',
    ...hwaccelDecodeArgs(preset, { device: options.device }),
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...templateToArgs(encode),
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    output,
  ];
}

// ── Detecção com cache + QUARENTENA ──────────────────────────────────────────
// Princípio DRAC: onde o Frigate assume, nós degradamos com segurança. Um preset
// que falha de verdade no transcode não é apagado da tabela — vai para
// QUARENTENA por uma janela curta, o sistema segue em CPU sozinho, e depois ele
// é testado de novo. Nada de desligar a GPU para sempre por um arquivo ruim.

const DETECTION_TTL_MS = 5 * 60 * 1000;
const QUARANTINE_MS = 15 * 60 * 1000;
const QUARANTINE_AFTER_FAILURES = 2;

type DetectionCache = {
  report: HwaccelProbeReport;
  expiresAt: number;
};

let detectionCache: DetectionCache | null = null;
let detectionInFlight: Promise<HwaccelProbeReport> | null = null;
const failureCounts = new Map<HwaccelPreset, number>();
const quarantinedUntil = new Map<HwaccelPreset, number>();

export function __resetHwaccelDetectionCache(): void {
  detectionCache = null;
  detectionInFlight = null;
  failureCounts.clear();
  quarantinedUntil.clear();
}

/** Chame quando um transcode acelerado falhar DE VERDADE (ffmpeg reprovou). */
export function reportHwaccelFailure(preset: HwaccelPreset, now: number = Date.now()): boolean {
  const count = (failureCounts.get(preset) ?? 0) + 1;
  failureCounts.set(preset, count);
  if (count >= QUARANTINE_AFTER_FAILURES) {
    quarantinedUntil.set(preset, now + QUARANTINE_MS);
    failureCounts.set(preset, 0);
    detectionCache = null; // força re-teste quando a quarentena vencer
    return true;
  }
  return false;
}

/** Chame quando um transcode acelerado der certo (zera o contador de falhas). */
export function reportHwaccelSuccess(preset: HwaccelPreset): void {
  failureCounts.delete(preset);
}

export function isHwaccelQuarantined(preset: HwaccelPreset, now: number = Date.now()): boolean {
  const until = quarantinedUntil.get(preset);
  if (until === undefined) return false;
  if (until <= now) {
    quarantinedUntil.delete(preset);
    return false;
  }
  return true;
}

/** Aplica a quarentena por cima do relatório (o preset vira "não provado"). */
export function applyQuarantine(report: HwaccelProbeReport, now: number = Date.now()): HwaccelProbeReport {
  const proven = { ...report.proven };
  const failures = { ...report.failures };
  let changed = false;
  for (const preset of Object.keys(proven) as HwaccelPreset[]) {
    if (proven[preset] && isHwaccelQuarantined(preset, now)) {
      proven[preset] = false;
      failures[preset] =
        'em QUARENTENA após falhas reais no transcode — voltará a ser testado automaticamente';
      changed = true;
    }
  }
  return changed ? { ...report, proven, failures } : report;
}

async function defaultExec(args: string[], timeoutMs = 8000): Promise<FfmpegExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('ffmpeg', args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error: any) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : (error?.message ?? ''),
    };
  }
}

/** vainfo, como o Frigate (util/services.py:870-882). Ausente ⇒ não reprova. */
export async function defaultVainfo(devicePath: string): Promise<boolean> {
  try {
    await execFileAsync('vainfo', ['--display', 'drm', '--device', devicePath], { timeout: 6000 });
    return true;
  } catch (error: any) {
    // vainfo não instalado (ENOENT) não é prova de nada: o encode real decide.
    return error?.code === 'ENOENT';
  }
}

async function defaultListRenderNodes(): Promise<string[]> {
  let entries: string[] | null = null;
  try {
    entries = await readdir('/dev/dri');
  } catch {
    entries = null;
  }
  return selectLibvaDevices(entries, defaultVainfo);
}

export type DetectHwaccelOptions = {
  mode?: HwaccelMode;
  force?: boolean;
  exec?: FfmpegExec;
  listRenderNodes?: () => Promise<string[]>;
  probeFile?: string;
  now?: number;
};

/** Relatório com cache (TTL) — o teste real é caro demais para cada gravação. */
export async function detectHwaccelReport(
  options: DetectHwaccelOptions = {},
): Promise<HwaccelProbeReport> {
  const now = options.now ?? Date.now();
  if (!options.force && detectionCache && detectionCache.expiresAt > now) {
    return detectionCache.report;
  }
  if (!options.force && detectionInFlight) return detectionInFlight;

  const probeFile = options.probeFile ?? join(tmpdir(), `drac-hwaccel-probe.${process.pid}.mp4`);
  const work = probeHwaccel({
    exec: options.exec ?? defaultExec,
    listRenderNodes: options.listRenderNodes ?? defaultListRenderNodes,
    probeFile,
    removeProbeFile: async () => {
      await rm(probeFile, { force: true });
    },
  })
    .then((report) => {
      detectionCache = { report, expiresAt: (options.now ?? Date.now()) + DETECTION_TTL_MS };
      return report;
    })
    .finally(() => {
      detectionInFlight = null;
    });

  detectionInFlight = work;
  return work;
}

/**
 * Decisão pronta para uso (com cache e quarentena aplicados). É esta função que
 * o transcode offline e a tela de GPU consultam — as duas veem a MESMA verdade.
 */
export async function detectTranscodeHwaccel(
  options: DetectHwaccelOptions = {},
): Promise<HwaccelDecision> {
  const mode = options.mode ?? normalizeHwaccelMode(process.env.TRANSCODE_HWACCEL);
  const report = await detectHwaccelReport(options);
  return resolveHwaccel(mode, applyQuarantine(report, options.now ?? Date.now()));
}
