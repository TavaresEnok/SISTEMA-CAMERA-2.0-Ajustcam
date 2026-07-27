// ─────────────────────────────────────────────────────────────────────────────
// EXPORTAÇÃO POR INTERVALO (atravessando segmentos).
//
// Derivado da análise do Frigate (`frigate/api/export.py` e
// `frigate/record/export.py`, licença MIT — Copyright (c) Blake Blackshear e
// contribuidores): lá a exportação recebe `start_time`/`end_time` e o ffmpeg
// junta os N segmentos com `-c copy` (stream copy), reencodando só quando é
// obrigatório.
//
// POR QUE ISTO EXISTE AQUI: o `exportClip` do DRAC recebe UM `recordingId` e
// offsets DENTRO daquele arquivo. Com segmento de 300s (60s no modo movimento),
// um evento de 3 minutos que cruza a borda NÃO CABE em um segmento. Como prova
// judicial, "o vídeo acaba no meio do fato" é falha grave.
//
// DIVERGÊNCIA DELIBERADA DO FRIGATE (princípio DRAC: onde ele descarta, nós
// preservamos):
//   1. O corte por STREAM COPY só pode começar num keyframe — o ffmpeg pula
//      para o keyframe SEGUINTE ao ponto pedido e o começo do fato some. Aqui o
//      ponto de entrada recua alguns segundos (`copySafetySeconds`) e o de saída
//      avança o mesmo tanto: o arquivo cobre MAIS que o pedido, nunca menos. O
//      quanto sobrou vai declarado no plano (`leadInSeconds`/`leadOutSeconds`)
//      para a auditoria — margem escondida seria adulteração silenciosa.
//   2. Codec desconhecido ou misturado NÃO tenta copy. Um MP4 emendado com
//      codecs diferentes abre e toca lixo — pior que demorar reencodando.
//   3. Buraco de gravação dentro do intervalo é REPORTADO (`gaps`), não
//      escondido pela emenda: a emenda invisível mente sobre a linha do tempo.
//
// Este módulo é 100% PURO (sem I/O, sem Prisma, sem ffmpeg): entra a lista de
// segmentos + o intervalo, sai o PLANO, o manifesto do demuxer `concat` e os
// comandos. Assim a decisão crítica é determinística e testável sem subir nada.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildCompatibleTranscodeArgs,
  PRESETS_HW_ACCEL_ENCODE,
  type HwaccelPreset,
} from '../../camera-stream/helpers/hwaccel-presets.helper';

export interface RangeSourceSegment {
  /** Recording.id — vira a origem declarada de cada trecho. */
  id: string;
  /** Caminho ABSOLUTO já validado sob a raiz de gravações pelo chamador. */
  filePath: string;
  startedAt: Date | string | number;
  endedAt?: Date | string | number | null;
  durationSeconds?: number | null;
  /**
   * Codec de vídeo do arquivo. `null`/ausente = DESCONHECIDO ⇒ força transcode.
   * (Quem sabe o vídeo sabe o áudio: os dois vêm do mesmo ffprobe.)
   */
  videoCodec?: string | null;
  /** Codec de áudio; `null` com vídeo conhecido significa SEM faixa de áudio. */
  audioCodec?: string | null;
}

export type RangeExportStrategy = 'copy' | 'transcode';

export interface RangeExportPart {
  recordingId: string;
  filePath: string;
  /** Segundos DENTRO do arquivo onde o trecho começa (timestamp do arquivo). */
  inpointSeconds: number;
  /** Segundos DENTRO do arquivo onde o trecho termina (não é relativo ao inpoint). */
  outpointSeconds: number;
  durationSeconds: number;
  /** Início deste trecho na linha do tempo do arquivo EXPORTADO. */
  offsetSeconds: number;
  segmentStartedAt: string;
  /** Duração TOTAL do arquivo de origem — diz se o trecho vai até o fim dele. */
  fileDurationSeconds: number;
}

export interface RangeExportGap {
  from: string;
  to: string;
  seconds: number;
}

export interface RangeExportPlan {
  requestedFrom: string;
  requestedTo: string;
  parts: RangeExportPart[];
  strategy: RangeExportStrategy;
  /** Vazio quando o copy foi possível; senão diz POR QUE tivemos de reencodar. */
  strategyReasons: string[];
  videoCodec: string | null;
  /** HEVC copiado para MP4 sem `hvc1` não abre em player nenhum. */
  tagHvc1: boolean;
  totalDurationSeconds: number;
  /** O que o arquivo final REALMENTE cobre (já com as margens de keyframe). */
  coveredFrom: string | null;
  coveredTo: string | null;
  requestedSeconds: number;
  /** Segundos do pedido que existem em disco (pedido − buracos). */
  coveredSeconds: number;
  gaps: RangeExportGap[];
  continuous: boolean;
  leadInSeconds: number;
  leadOutSeconds: number;
  truncated: boolean;
  skipped: number;
}

export interface PlanRangeExportInput {
  segments: RangeSourceSegment[];
  from: Date | string | number;
  to: Date | string | number;
  /** Folga para considerar dois segmentos contíguos (ms de fechamento do ffmpeg). */
  gapToleranceSeconds?: number;
  maxSegments?: number;
  /** Margem de keyframe do stream copy (só no copy). */
  copySafetySeconds?: number;
  /** Perfil "compatível": reencoda mesmo quando o copy seria possível. */
  forceTranscode?: boolean;
}

const DEFAULT_GAP_TOLERANCE_SECONDS = 1;
const DEFAULT_MAX_SEGMENTS = 240;
const DEFAULT_COPY_SAFETY_SECONDS = 2;

/** Codecs que entram em MP4 por cópia direta — é o que o DRAC grava. */
const COPY_SAFE_VIDEO = new Set(['h264', 'hevc', 'h265']);
const COPY_SAFE_AUDIO = new Set(['aac', 'mp3']);
const HEVC_CODECS = new Set(['hevc', 'h265']);

function toMs(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Segundos com precisão de milissegundo (evita 299.9999999 no manifesto). */
function roundSeconds(ms: number): number {
  return Math.round(ms) / 1000;
}

function normalizeCodec(codec: string | null | undefined): string {
  return String(codec ?? '').trim().toLowerCase();
}

type Candidate = {
  id: string;
  filePath: string;
  startMs: number;
  endMs: number;
  videoCodec: string;
  audioCodec: string;
};

/**
 * Decide stream-copy × transcode olhando SÓ os codecs dos segmentos escolhidos.
 * Conservador de propósito: qualquer dúvida cai em transcode.
 */
function decideStrategy(
  candidates: Candidate[],
  forceTranscode: boolean,
): { strategy: RangeExportStrategy; reasons: string[]; videoCodec: string | null } {
  const reasons: string[] = [];
  const videoCodec = candidates.length ? candidates[0].videoCodec || null : null;

  for (const candidate of candidates) {
    if (!candidate.videoCodec) reasons.push(`codec_desconhecido:${candidate.id}`);
  }
  const videos = [...new Set(candidates.map((c) => c.videoCodec).filter(Boolean))];
  if (videos.length > 1) reasons.push(`codec_video_misto:${videos.join('+')}`);
  for (const codec of videos) {
    if (!COPY_SAFE_VIDEO.has(codec)) reasons.push(`codec_video_nao_copiavel:${codec}`);
  }

  // Áudio: presente em uns e ausente em outros quebra a emenda tanto quanto
  // codec diferente (o mapeamento de faixas muda no meio do arquivo).
  const audios = [...new Set(candidates.map((c) => c.audioCodec))];
  if (audios.length > 1) reasons.push(`audio_misto:${audios.map((a) => a || 'sem_audio').join('+')}`);
  for (const codec of audios) {
    if (codec && !COPY_SAFE_AUDIO.has(codec)) reasons.push(`codec_audio_nao_copiavel:${codec}`);
  }

  if (forceTranscode) reasons.push('perfil_compativel_solicitado');

  return {
    strategy: reasons.length ? 'transcode' : 'copy',
    reasons: [...new Set(reasons)],
    videoCodec,
  };
}

/**
 * Monta o PLANO da exportação por intervalo.
 *
 * Não faz I/O: quem chama já filtrou o que existe no disco e já resolveu os
 * codecs. Segmento sem duração utilizável é DESCARTADO (`skipped`) — emendar um
 * trecho de duração inventada desalinha toda a linha do tempo da prova.
 */
export function planRangeExport(input: PlanRangeExportInput): RangeExportPlan {
  const fromMs = toMs(input.from);
  const toMsValue = toMs(input.to);
  if (fromMs === null || toMsValue === null) {
    throw new TypeError('Intervalo inválido para a exportação.');
  }
  if (toMsValue <= fromMs) {
    throw new RangeError('Intervalo inválido: o fim precisa ser depois do início.');
  }

  const toleranceMs = Math.max(0, (input.gapToleranceSeconds ?? DEFAULT_GAP_TOLERANCE_SECONDS) * 1000);
  const maxSegments = Math.max(1, Math.floor(input.maxSegments ?? DEFAULT_MAX_SEGMENTS));
  const safetySeconds = Math.max(0, input.copySafetySeconds ?? DEFAULT_COPY_SAFETY_SECONDS);

  let skipped = 0;
  const candidates: Candidate[] = [];
  for (const raw of input.segments ?? []) {
    const startMs = toMs(raw.startedAt);
    if (startMs === null) continue;
    const endFromEnded = toMs(raw.endedAt);
    const durationSeconds = Number(raw.durationSeconds);
    const endMs =
      endFromEnded !== null && endFromEnded > startMs
        ? endFromEnded
        : Number.isFinite(durationSeconds) && durationSeconds > 0
          ? startMs + durationSeconds * 1000
          : null;
    if (endMs === null) {
      if (startMs < toMsValue) skipped += 1;
      continue;
    }
    // Sobreposição real: quem apenas ENCOSTA na borda não tem conteúdo pedido.
    if (endMs <= fromMs || startMs >= toMsValue) continue;
    candidates.push({
      id: raw.id,
      filePath: raw.filePath,
      startMs,
      endMs,
      videoCodec: normalizeCodec(raw.videoCodec),
      audioCodec: normalizeCodec(raw.audioCodec),
    });
  }

  candidates.sort((a, b) => (a.startMs - b.startMs) || a.id.localeCompare(b.id));
  const truncated = candidates.length > maxSegments;
  const selected = truncated ? candidates.slice(0, maxSegments) : candidates;

  const { strategy, reasons, videoCodec } = decideStrategy(selected, Boolean(input.forceTranscode));
  // A margem de keyframe existe SÓ no copy: o transcode corta no frame exato.
  const margemMs = strategy === 'copy' ? safetySeconds * 1000 : 0;

  const parts: RangeExportPart[] = [];
  let cursorMs = 0;
  let leadInMs = 0;
  let leadOutMs = 0;

  for (let index = 0; index < selected.length; index += 1) {
    const current = selected[index];
    const fileDurationMs = current.endMs - current.startMs;
    const rawInMs = Math.max(0, fromMs - current.startMs);
    const rawOutMs = Math.min(fileDurationMs, toMsValue - current.startMs);

    // Recuar/avançar só onde há corte de verdade (bordas do intervalo). Emenda
    // interna entre segmentos é exata — margem ali duplicaria conteúdo.
    const inMs = rawInMs > 0 ? Math.max(0, rawInMs - margemMs) : 0;
    const outMs = rawOutMs < fileDurationMs ? Math.min(fileDurationMs, rawOutMs + margemMs) : fileDurationMs;
    if (rawInMs > 0) leadInMs = rawInMs - inMs;
    if (rawOutMs < fileDurationMs) leadOutMs = outMs - rawOutMs;

    const durationMs = outMs - inMs;
    if (durationMs <= 0) continue;
    parts.push({
      recordingId: current.id,
      filePath: current.filePath,
      inpointSeconds: roundSeconds(inMs),
      outpointSeconds: roundSeconds(outMs),
      durationSeconds: roundSeconds(durationMs),
      offsetSeconds: roundSeconds(cursorMs),
      segmentStartedAt: new Date(current.startMs).toISOString(),
      fileDurationSeconds: roundSeconds(fileDurationMs),
    });
    cursorMs += durationMs;
  }

  // ── Buracos: o que foi PEDIDO e não existe em disco ────────────────────────
  const gaps: RangeExportGap[] = [];
  let cursorClockMs = fromMs;
  for (const part of parts) {
    const segmentStartMs = Date.parse(part.segmentStartedAt);
    const partFromMs = segmentStartMs + part.inpointSeconds * 1000;
    const partToMs = segmentStartMs + part.outpointSeconds * 1000;
    if (partFromMs - cursorClockMs > toleranceMs) {
      gaps.push({
        from: new Date(cursorClockMs).toISOString(),
        to: new Date(partFromMs).toISOString(),
        seconds: roundSeconds(partFromMs - cursorClockMs),
      });
    }
    cursorClockMs = Math.max(cursorClockMs, partToMs);
  }
  if (toMsValue - cursorClockMs > toleranceMs) {
    gaps.push({
      from: new Date(cursorClockMs).toISOString(),
      to: new Date(toMsValue).toISOString(),
      seconds: roundSeconds(toMsValue - cursorClockMs),
    });
  }

  const first = parts[0] ?? null;
  const last = parts[parts.length - 1] ?? null;
  const coveredFromMs = first ? Date.parse(first.segmentStartedAt) + first.inpointSeconds * 1000 : null;
  const coveredToMs = last ? Date.parse(last.segmentStartedAt) + last.outpointSeconds * 1000 : null;
  const requestedSeconds = roundSeconds(toMsValue - fromMs);
  const gapSeconds = gaps.reduce((total, gap) => total + gap.seconds, 0);

  return {
    requestedFrom: new Date(fromMs).toISOString(),
    requestedTo: new Date(toMsValue).toISOString(),
    parts,
    strategy,
    strategyReasons: reasons,
    videoCodec,
    tagHvc1: strategy === 'copy' && Boolean(videoCodec) && HEVC_CODECS.has(videoCodec as string),
    totalDurationSeconds: roundSeconds(cursorMs),
    coveredFrom: coveredFromMs === null ? null : new Date(coveredFromMs).toISOString(),
    coveredTo: coveredToMs === null ? null : new Date(coveredToMs).toISOString(),
    requestedSeconds,
    coveredSeconds: Math.max(0, roundSeconds((requestedSeconds - gapSeconds) * 1000)),
    gaps,
    continuous: parts.length > 0 && gaps.length === 0,
    leadInSeconds: roundSeconds(leadInMs),
    leadOutSeconds: roundSeconds(leadOutMs),
    truncated,
    skipped,
  };
}

// ── Manifesto do demuxer `concat` ────────────────────────────────────────────

/**
 * Texto do manifesto lido por `-f concat`. `inpoint`/`outpoint` são timestamps
 * DO ARQUIVO (não relativos entre si) e só são emitidos onde há recorte de
 * verdade — linha à toa é ruído num artefato que pode ir para perícia.
 */
export function buildConcatManifest(plan: RangeExportPlan): string {
  const lines: string[] = ['ffconcat version 1.0'];
  for (const part of plan.parts) {
    if (/[\r\n]/.test(part.filePath)) {
      // Não existe escape de quebra de linha no formato: seria outra diretiva.
      throw new Error(`Caminho de gravação com quebra de linha não pode entrar no manifesto: ${part.recordingId}`);
    }
    lines.push(`file '${part.filePath.replace(/'/g, "'\\''")}'`);
    if (part.inpointSeconds > 0) lines.push(`inpoint ${part.inpointSeconds.toFixed(3)}`);
    // Sem `outpoint` quando o trecho vai até o fim do arquivo: a diretiva seria
    // ruído, e um `outpoint` no milissegundo exato do fim faz o ffmpeg
    // descartar o último pacote em algumas versões.
    if (part.outpointSeconds < part.fileDurationSeconds - 0.0005) {
      lines.push(`outpoint ${part.outpointSeconds.toFixed(3)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ── Comandos de ffmpeg ───────────────────────────────────────────────────────

/**
 * Stream copy sobre o concat: sem reencode, sem perda, minutos viram segundos.
 * `-fflags +genpts` e `-avoid_negative_ts make_zero` são o que evita o
 * "Non-monotonous DTS" clássico de recorte com `inpoint`.
 */
export function buildRangeCopyArgs(options: {
  manifestPath: string;
  output: string;
  tagHvc1?: boolean;
}): string[] {
  return [
    '-y',
    '-fflags',
    '+genpts',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    options.manifestPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    ...(options.tagHvc1 ? ['-tag:v', 'hvc1'] : []),
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    options.output,
  ];
}

/**
 * Transcode do intervalo. Os parâmetros de encode (CPU e acelerado) vêm do
 * MESMO helper do playback compatível — fonte única: o que for ajustado lá vale
 * aqui. A única diferença é o input, que passa a ser o manifesto concat.
 */
export function buildRangeTranscodeArgs(options: {
  manifestPath: string;
  output: string;
  preset: HwaccelPreset | null;
  device?: string | null;
}): string[] {
  const base = buildCompatibleTranscodeArgs({
    input: options.manifestPath,
    output: options.output,
    preset: options.preset,
    device: options.device,
  });
  const inputIndex = base.indexOf('-i');
  if (inputIndex < 0) throw new Error('Comando de transcode sem "-i": não dá para injetar o input concat.');
  // `-f concat -safe 0` são opções de INPUT: têm de vir imediatamente antes do
  // `-i` (sem `-safe 0` o ffmpeg recusa caminho absoluto no manifesto).
  return [...base.slice(0, inputIndex), '-f', 'concat', '-safe', '0', ...base.slice(inputIndex)];
}

export type RangeExportAttempt = {
  kind: 'copy' | 'transcode';
  preset: HwaccelPreset | null;
  args: string[];
};

/**
 * Ordem das tentativas — a rede de proteção do Frigate
 * (`record/export.py:749-770`: comando falhou ⇒ refaz sem hwaccel), com a
 * divergência do DRAC de tentar SEMPRE o copy primeiro quando ele é seguro:
 *
 *   plano copiável   → [copy] → [transcode acelerado] → [transcode CPU]
 *   plano reencodado → [transcode acelerado] → [transcode CPU]
 *
 * O copy NUNCA entra num plano não-copiável: ele "funcionaria" (código 0) e
 * entregaria um arquivo que toca lixo — falha silenciosa, a pior de todas.
 */
export function buildRangeExportAttempts(options: {
  plan: RangeExportPlan;
  manifestPath: string;
  output: string;
  hwaccel: { preset: HwaccelPreset | null; device?: string | null } | null;
}): RangeExportAttempt[] {
  const attempts: RangeExportAttempt[] = [];
  if (options.plan.strategy === 'copy') {
    attempts.push({
      kind: 'copy',
      preset: null,
      args: buildRangeCopyArgs({
        manifestPath: options.manifestPath,
        output: options.output,
        tagHvc1: options.plan.tagHvc1,
      }),
    });
  }

  const preset = options.hwaccel?.preset ?? null;
  // Preset só de decode (sem encoder acelerado na tabela) produziria EXATAMENTE
  // o comando de CPU: tentar duas vezes o mesmo comando é desperdício puro.
  if (preset && PRESETS_HW_ACCEL_ENCODE[preset]) {
    attempts.push({
      kind: 'transcode',
      preset,
      args: buildRangeTranscodeArgs({
        manifestPath: options.manifestPath,
        output: options.output,
        preset,
        device: options.hwaccel?.device ?? null,
      }),
    });
  }

  attempts.push({
    kind: 'transcode',
    preset: null,
    args: buildRangeTranscodeArgs({
      manifestPath: options.manifestPath,
      output: options.output,
      preset: null,
    }),
  });

  return attempts;
}
