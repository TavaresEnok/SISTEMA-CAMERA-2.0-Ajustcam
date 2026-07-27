import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { SettingsService } from '../settings/settings.service';
import {
  applyQuarantine,
  detectHwaccelReport,
  detectTranscodeHwaccel,
  resolveHwaccel,
  type DetectHwaccelOptions,
  type HwaccelDecision,
  type HwaccelPreset,
  type HwaccelProbeReport,
} from '../camera-stream/helpers/hwaccel-presets.helper';

const run = promisify(execFile);

export type GpuVendor = 'nvidia' | 'intel' | 'none';

export type GpuStatus = {
  vendor: GpuVendor;
  enabled: boolean;
  ready: boolean;
  device: {
    name: string | null;
    driver: string | null;
    memoryTotalMb: number | null;
  } | null;
  checks: {
    /** A GPU está visível DENTRO do container (passada via --gpus / device). */
    gpuVisible: boolean;
    /** O ffmpeg deste serviço tem encoder acelerado (NVENC / VAAPI / QSV). */
    transcodeAccel: boolean;
    /**
     * A aceleração foi COMPROVADA por encode+decode reais neste container —
     * não apenas listada por `ffmpeg -encoders` (que é só compilação e dá
     * falso positivo em qualquer VM sem GPU).
     */
    transcodeAccelProven: boolean;
    /** O serviço de IA está usando um runtime acelerado (CUDA / OpenVINO GPU). */
    aiAccel: boolean;
  };
  /** Detecção honesta do pipeline de transcode offline (playback compatível). */
  hwaccel: {
    /** Tri-estado configurado em TRANSCODE_HWACCEL: auto | <preset> | cpu. */
    mode: string;
    /** Preset em uso agora (null = CPU). */
    preset: HwaccelPreset | null;
    device: string | null;
    /** O preset em uso passou pelo teste real? */
    proven: boolean;
    /** Prometeram aceleração e não há: precisa aparecer na tela. */
    degraded: boolean;
    reason: string;
    /** Presets aprovados no teste real (independente do modo configurado). */
    provenPresets: HwaccelPreset[];
    /** Por que cada candidato reprovou (texto do ffmpeg). */
    failures: Record<string, string>;
    /** O que o ffmpeg apenas DECLARA ter (compilação). */
    compiled: { nvenc: boolean; vaapi: boolean; qsv: boolean };
    probedAt: string;
  };
  ai: {
    /** A feature de IA está ligada no sistema? (aiFeatureEnabled). Hoje: false. */
    featureEnabled: boolean;
    /** A aceleração de IA por GPU está ligada? (gpuAiAccelerationEnabled). */
    accelerationEnabled: boolean;
    /** Tudo pronto para LIGAR a aceleração de IA (feature on + GPU visível + serviço no ar). */
    ready: boolean;
    reachable: boolean;
    runtime: string | null;
    device: string | null;
  };
  /** Mensagens do que falta para ficar pronto. */
  hints: string[];
};

export type GpuMetrics = {
  available: boolean;
  utilizationPct: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  temperatureC: number | null;
  encoderSessions: number | null;
  powerWatts: number | null;
  sampledAt: string;
};

export type GpuVerifyResult = {
  ok: boolean;
  encoder: string | null;
  elapsedMs: number | null;
  message: string;
  /**
   * true  = encode+decode reais rodaram neste container.
   * false = o resultado veio de declaração (encoder compilado / env de outro
   *         container). Nunca confunda os dois na UI.
   */
  proven?: boolean;
};

@Injectable()
export class GpuService {
  private readonly logger = new Logger(GpuService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  private async exec(
    cmd: string,
    args: string[],
    timeoutMs = 6000,
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await run(cmd, args, { timeout: timeoutMs, windowsHide: true });
      return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: any) {
      return {
        ok: false,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : (error?.message ?? ''),
      };
    }
  }

  private async detectNvidia(): Promise<GpuStatus['device'] | null> {
    const r = await this.exec('nvidia-smi', [
      '--query-gpu=name,driver_version,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    if (!r.ok || !r.stdout.trim()) return null;
    const [name, driver, memTotal] = r.stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
    return {
      name: name || null,
      driver: driver || null,
      memoryTotalMb: Number.isFinite(Number(memTotal)) ? Math.round(Number(memTotal)) : null,
    };
  }

  private async hasIntelRenderNode(): Promise<boolean> {
    try {
      await access('/dev/dri/renderD128');
      return true;
    } catch {
      return false;
    }
  }

  private async ffmpegAccelEncoders(): Promise<{ nvenc: boolean; vaapi: boolean; qsv: boolean }> {
    const r = await this.exec('ffmpeg', ['-hide_banner', '-encoders']);
    const out = r.stdout.toLowerCase();
    return {
      nvenc: out.includes('h264_nvenc'),
      vaapi: out.includes('h264_vaapi'),
      qsv: out.includes('h264_qsv'),
    };
  }

  private async probeAiRuntime(): Promise<{ reachable: boolean; runtime: string | null; device: string | null }> {
    const base = (this.config.get<string>('aiBaseUrl') ?? 'http://ai-service:8000').replace(/\/+$/, '');
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) return { reachable: false, runtime: null, device: null };
      const body: any = await res.json();
      // static_profiles expõe o perfil GENERAL com runtime/openvino_device.
      const profiles = body?.static_profiles ?? {};
      const general = profiles?.general ?? profiles?.GENERAL ?? Object.values(profiles ?? {})[0] ?? {};
      const runtime = (general?.runtime as string | undefined) ?? null;
      const device = (general?.openvino_device as string | undefined) ?? null;
      return { reachable: true, runtime, device };
    } catch {
      return { reachable: false, runtime: null, device: null };
    }
  }

  /**
   * Detecção HONESTA: o relatório vem de encode+decode CURTOS executados de
   * verdade (helper compartilhado com o transcode offline — as duas telas veem
   * a mesma verdade, com o mesmo cache e a mesma quarentena).
   */
  /**
   * Porta de execução do teste real. Em produção fica vazia (o helper usa o
   * ffmpeg deste container, o MESMO que roda o transcode offline).
   */
  protected hwaccelProbeOptions(): DetectHwaccelOptions {
    return {};
  }

  private async probeHwaccelCapability(force = false): Promise<{
    report: HwaccelProbeReport;
    capability: HwaccelDecision;
    effective: HwaccelDecision;
  }> {
    const probeOptions = this.hwaccelProbeOptions();
    const report = await detectHwaccelReport({ ...probeOptions, force });
    const emQuarentena = applyQuarantine(report);
    return {
      report,
      // `auto` ignora o modo configurado: responde "este host CONSEGUE acelerar?".
      capability: resolveHwaccel('auto', emQuarentena),
      // O que o transcode vai realmente usar agora (respeita TRANSCODE_HWACCEL).
      effective: await detectTranscodeHwaccel(probeOptions),
    };
  }

  async getStatus(): Promise<GpuStatus> {
    const [device, intel, encoders, hw, aiProbe, enabled, aiFeatureEnabled, aiAccelEnabled] = await Promise.all([
      this.detectNvidia(),
      this.hasIntelRenderNode(),
      this.ffmpegAccelEncoders(),
      this.probeHwaccelCapability(),
      this.probeAiRuntime(),
      this.settings.isGpuAccelerationEnabled(),
      this.settings.isAiFeatureEnabled(),
      this.settings.isGpuAiAccelerationEnabled(),
    ]);
    const ai = aiProbe;

    const vendor: GpuVendor = device ? 'nvidia' : intel ? 'intel' : 'none';
    const gpuVisible = Boolean(device) || intel;
    // O transcode real roda no container do MediaMTX. Quando o pacote GPU está
    // ativo, ele sobe com a imagem mediamtx-nvenc (ffmpeg NVENC garantido) e seta
    // GPU_TRANSCODE_AVAILABLE=true na API — então confiamos nesse sinal. Como
    // fallback, também aceitamos o ffmpeg local desta API ter encoder acelerado.
    const transcodePipelineHasNvenc = String(this.config.get<string>('gpuTranscodeAvailable') ?? process.env.GPU_TRANSCODE_AVAILABLE ?? '').toLowerCase() === 'true';
    // ANTES: bastava o encoder aparecer em `ffmpeg -encoders`. Isso é COMPILAÇÃO,
    // não hardware — neste próprio host o ffmpeg lista h264_nvenc/h264_vaapi/
    // h264_qsv e nenhum dos três abre um dispositivo ("Cannot load libcuda.so.1",
    // "No VA display found"). Agora só conta o que RODOU de fato.
    const localTranscodeAccel = hw.capability.proven;
    const transcodeAccel = gpuVisible && (transcodePipelineHasNvenc || localTranscodeAccel);
    const aiRuntime = (ai.runtime ?? '').toLowerCase();
    const aiDevice = (ai.device ?? '').toLowerCase();
    const aiRunsOnGpu = ai.reachable && (aiRuntime.includes('cuda') || aiRuntime.includes('gpu') || (aiDevice !== '' && aiDevice !== 'cpu'));
    // "ready" = dá pra LIGAR a aceleração de IA: feature de IA ligada + GPU visível
    // + serviço de IA no ar. Como aiFeatureEnabled é false hoje, isto fica false.
    const aiReady = aiFeatureEnabled && gpuVisible && ai.reachable;

    const hints: string[] = [];
    if (!gpuVisible) {
      hints.push('Nenhuma GPU visível no container. Passe a GPU para os serviços (NVIDIA Container Toolkit + docker-compose.gpu.yml).');
    }
    if (gpuVisible && !transcodeAccel) {
      hints.push('A GPU está visível, mas o ffmpeg deste build não tem encoder acelerado. Use uma imagem com NVENC/VAAPI.');
    }
    // O aviso que faltava: o ffmpeg PROMETE aceleração e o hardware não responde.
    // Sem isto o admin liga a GPU e acha que ganhou desempenho que não existe.
    if (hw.capability.degraded) {
      hints.push(hw.capability.reason);
    }
    if (hw.effective.degraded && hw.effective.reason !== hw.capability.reason) {
      hints.push(hw.effective.reason);
    }

    return {
      vendor,
      enabled,
      ready: gpuVisible && transcodeAccel,
      device,
      checks: {
        gpuVisible,
        transcodeAccel,
        transcodeAccelProven: hw.capability.proven,
        aiAccel: aiRunsOnGpu,
      },
      hwaccel: {
        mode: hw.effective.mode,
        preset: hw.effective.preset,
        device: hw.effective.device,
        proven: hw.effective.proven,
        degraded: hw.effective.degraded || hw.capability.degraded,
        reason: hw.effective.reason,
        provenPresets: (Object.keys(hw.report.proven) as HwaccelPreset[]).filter(
          (preset) => hw.report.proven[preset] === true,
        ),
        failures: hw.report.failures as Record<string, string>,
        compiled: hw.report.compiled,
        probedAt: hw.report.probedAt,
      },
      ai: {
        featureEnabled: aiFeatureEnabled,
        accelerationEnabled: aiAccelEnabled,
        ready: aiReady,
        reachable: ai.reachable,
        runtime: ai.runtime,
        device: ai.device,
      },
      hints,
    };
  }

  async getMetrics(): Promise<GpuMetrics> {
    const sampledAt = new Date().toISOString();
    const r = await this.exec('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,encoder.stats.sessionCount,power.draw',
      '--format=csv,noheader,nounits',
    ], 5000);
    if (!r.ok || !r.stdout.trim()) {
      return {
        available: false,
        utilizationPct: null,
        memoryUsedMb: null,
        memoryTotalMb: null,
        temperatureC: null,
        encoderSessions: null,
        powerWatts: null,
        sampledAt,
      };
    }
    const cols = r.stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
    const num = (v: string | undefined) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      available: true,
      utilizationPct: num(cols[0]),
      memoryUsedMb: num(cols[1]),
      memoryTotalMb: num(cols[2]),
      temperatureC: num(cols[3]),
      encoderSessions: num(cols[4]),
      powerWatts: num(cols[5]),
      sampledAt,
    };
  }

  /** Nome do encoder efetivamente usado por cada família de preset. */
  private encoderOfPreset(preset: HwaccelPreset | null): string | null {
    if (!preset) return null;
    if (preset.startsWith('preset-nvidia')) return 'h264_nvenc';
    if (preset === 'preset-vaapi') return 'h264_vaapi';
    if (preset.startsWith('preset-intel-qsv')) return 'h264_qsv';
    return null;
  }

  async verify(): Promise<GpuVerifyResult> {
    // Auto-teste HONESTO: refaz o encode+decode reais agora (force), em vez de
    // acreditar na lista de encoders compilados.
    const startedAt = Date.now();
    const hw = await this.probeHwaccelCapability(true);
    const elapsedMs = Date.now() - startedAt;
    const transcodePipelineHasNvenc = String(this.config.get<string>('gpuTranscodeAvailable') ?? process.env.GPU_TRANSCODE_AVAILABLE ?? '').toLowerCase() === 'true';

    if (hw.capability.proven && hw.capability.preset) {
      const encoder = this.encoderOfPreset(hw.capability.preset);
      return {
        ok: true,
        encoder,
        elapsedMs,
        proven: true,
        message: `Encode + decode de teste com ${encoder} (${hw.capability.preset}) concluídos em ${elapsedMs} ms.`,
      };
    }

    const motivos = Object.entries(hw.report.failures)
      .map(([preset, erro]) => `${preset}: ${erro}`)
      .join(' | ');

    if (transcodePipelineHasNvenc) {
      // Sinal declarado por OUTRO container (MediaMTX com NVENC). Não dá para
      // provar daqui — e isso precisa ficar explícito, não virar "ok" silencioso.
      return {
        ok: true,
        encoder: 'h264_nvenc',
        elapsedMs,
        proven: false,
        message:
          'Pipeline de transcode (MediaMTX) DECLARA ter NVENC — não é possível comprovar a partir deste container. ' +
          `O ffmpeg da API não conseguiu acelerar nada aqui (${motivos || 'sem encoder de GPU'}).`,
      };
    }

    const compilados = Object.entries(hw.report.compiled)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (compilados.length > 0) {
      return {
        ok: false,
        encoder: null,
        elapsedMs,
        proven: false,
        message: `O ffmpeg lista ${compilados.join('/')} mas NENHUM funcionou de verdade: ${motivos || 'erro desconhecido'}.`,
      };
    }
    return {
      ok: false,
      encoder: null,
      elapsedMs,
      proven: false,
      message: 'Nenhum encoder de GPU disponível no ffmpeg deste serviço.',
    };
  }

  async setMode(enabled: boolean, userId?: string): Promise<GpuStatus> {
    if (enabled) {
      const status = await this.getStatus();
      if (!status.ready) {
        const reason = status.hints[0] ?? 'GPU não está pronta para uso.';
        throw new BadRequestException(reason);
      }
    }
    await this.settings.patch({ gpuAccelerationEnabled: enabled }, userId);
    this.logger.log(`Aceleração por GPU ${enabled ? 'ATIVADA' : 'desativada'}${userId ? ` por ${userId}` : ''}.`);
    return this.getStatus();
  }

  // Aceleração de IA por GPU. Toda a lógica está pronta, porém DORMENTE: enquanto
  // a feature de IA estiver desligada (aiFeatureEnabled=false), este controle é
  // bloqueado — exatamente como a página de IA, que também está desativada.
  async setAiMode(enabled: boolean, userId?: string): Promise<GpuStatus> {
    const aiFeatureEnabled = await this.settings.isAiFeatureEnabled();
    if (!aiFeatureEnabled) {
      throw new BadRequestException('A IA está desativada no sistema. Ative a feature de IA antes de acelerar a IA por GPU.');
    }
    if (enabled) {
      const status = await this.getStatus();
      if (!status.ai.ready) {
        throw new BadRequestException('GPU para IA não está pronta (verifique GPU visível e serviço de IA no ar).');
      }
    }
    await this.settings.patch({ gpuAiAccelerationEnabled: enabled }, userId);
    this.logger.log(`Aceleração de IA por GPU ${enabled ? 'ATIVADA' : 'desativada'}${userId ? ` por ${userId}` : ''}.`);
    return this.getStatus();
  }
}
