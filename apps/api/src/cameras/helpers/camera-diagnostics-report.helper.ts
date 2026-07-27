import { sanitizeSensitiveText } from '../../common/security/sensitive-text.helper';
import { isHevcCodec } from './rtsp-url.helper';

/**
 * DIAGNÓSTICO RICO DA CÂMERA JÁ SALVA — detectado AGORA × configurado.
 *
 * O diagnóstico detalhado do DRAC só existia no CADASTRO. Depois de salva, a
 * câmera vira três booleanos (RTSP alcançável, ONVIF alcançável, status), e
 * diagnosticar uma câmera que ERA boa e DEGRADOU — firmware trocou o perfil, o
 * substream sumiu, o codec virou H.265 — passa a ser adivinhação. Quando não se
 * adivinha certo, alguém VOLTA AO LOCAL: o chamado mais caro que existe.
 *
 * A DIVERGÊNCIA é o diagnóstico. Este módulo é lógica pura: recebe o que está
 * gravado (configurado) e o que a sonda acabou de ler (detectado) e classifica.
 *
 * Duas regras que o DRAC não negocia:
 *  - Sem resposta da câmera NADA vira "match" nem "diverged" — vira "unknown".
 *    Declarar divergência com base em silêncio é falso positivo, e falso positivo
 *    num VMS probatório manda o técnico mexer numa câmera que estava certa.
 *  - Credencial de câmera não sai daqui. O texto de erro vem do stderr do
 *    ffprobe, que imprime a URL de entrada inteira (rtsp://user:senha@...).
 */

export type DiagnosticsStreamFacts = {
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  bitrateKbps?: number | null;
  rtspPort?: number | null;
  rtspPath?: string | null;
};

export type DiagnosticsConfigured = {
  videoCodec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  rtspPort?: number | null;
  rtspPath?: string | null;
  audioEnabled?: boolean | null;
  liveSubtype?: number | null;
  analyticsSubtype?: number | null;
  recordingCodecMode?: 'copy' | 'h265' | 'h264' | null;
};

export type DiagnosticsDetected = {
  reachable: boolean;
  main?: DiagnosticsStreamFacts | null;
  sub?: DiagnosticsStreamFacts | null;
  error?: string | null;
};

export type DiagnosticsFindingKey =
  | 'codec'
  | 'resolution'
  | 'fps'
  | 'rtsp_path'
  | 'rtsp_port'
  | 'substream';

export type DiagnosticsFinding = {
  key: DiagnosticsFindingKey;
  label: string;
  configured: string | null;
  detected: string | null;
  state: 'match' | 'diverged' | 'unknown';
  severity: 'info' | 'warning' | 'critical';
  message: string;
};

export type TranscodePipeline = 'live_single' | 'live_grid' | 'recording';

export type TranscodeCode =
  | 'passthrough'
  | 'source_hevc'
  | 'audio_webrtc'
  | 'codec_mode_h265'
  | 'codec_mode_h264';

export type TranscodeVerdict = {
  pipeline: TranscodePipeline;
  label: string;
  transcoding: boolean;
  code: TranscodeCode;
  reason: string;
  /** `measured` quando a sonda leu o codec agora; `assumed` quando usou o gravado. */
  certainty: 'measured' | 'assumed';
};

export type CameraDiagnosticsReport = {
  state: 'ok' | 'diverged' | 'unreachable';
  reachable: boolean;
  summary: string;
  checkedAt: string;
  findings: DiagnosticsFinding[];
  transcode: TranscodeVerdict[];
  detected: { main: string | null; sub: string | null };
  error: string | null;
};

/** Diferença de 1 quadro é arredondamento do ffprobe (24,97 → 25), não degradação. */
const FPS_TOLERANCE = 1;

function normalizeCodecLabel(codec?: string | null): string | null {
  const value = String(codec ?? '').trim().toLowerCase();
  if (!value || value === 'original' || value === 'auto') return null;
  if (['hevc', 'h265', 'h.265', 'hvc1', 'hev1'].includes(value)) return 'H.265';
  if (['avc', 'h264', 'h.264', 'avc1'].includes(value)) return 'H.264';
  if (['mjpeg', 'mjpg', 'jpeg'].includes(value)) return 'MJPEG';
  return value.toUpperCase();
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolutionLabel(width?: number | null, height?: number | null): string | null {
  const w = finiteOrNull(width);
  const h = finiteOrNull(height);
  if (!w || !h || w <= 0 || h <= 0) return null;
  return `${Math.round(w)}x${Math.round(h)}`;
}

function pixels(width?: number | null, height?: number | null): number | null {
  const w = finiteOrNull(width);
  const h = finiteOrNull(height);
  if (!w || !h || w <= 0 || h <= 0) return null;
  return w * h;
}

function cleanText(value?: string | null): string | null {
  if (value == null) return null;
  const text = sanitizeSensitiveText(value).trim();
  return text.length ? text : null;
}

function describeStream(facts?: DiagnosticsStreamFacts | null): string | null {
  if (!facts) return null;
  const parts = [
    normalizeCodecLabel(facts.codec),
    resolutionLabel(facts.width, facts.height),
    finiteOrNull(facts.fps) ? `${Math.round(Number(facts.fps))} FPS` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function makeFinding(
  key: DiagnosticsFindingKey,
  label: string,
  configured: string | null,
  detected: string | null,
  options: {
    reachable: boolean;
    diverged: boolean;
    severity?: DiagnosticsFinding['severity'];
    matchMessage: string;
    divergedMessage: string;
    unknownMessage: string;
  },
): DiagnosticsFinding {
  if (!options.reachable || detected === null) {
    return {
      key,
      label,
      configured,
      detected: null,
      state: 'unknown',
      severity: 'info',
      message: options.unknownMessage,
    };
  }
  if (!options.diverged) {
    return { key, label, configured, detected, state: 'match', severity: 'info', message: options.matchMessage };
  }
  return {
    key,
    label,
    configured,
    detected,
    state: 'diverged',
    severity: options.severity ?? 'warning',
    message: options.divergedMessage,
  };
}

function buildFindings(
  configured: DiagnosticsConfigured,
  detected: DiagnosticsDetected,
): DiagnosticsFinding[] {
  const main = detected.main ?? null;
  const reachable = Boolean(detected.reachable) && Boolean(main);

  const configuredCodec = normalizeCodecLabel(configured.videoCodec);
  const detectedCodec = normalizeCodecLabel(main?.codec);
  const codec = makeFinding('codec', 'Codec de vídeo', configuredCodec, detectedCodec, {
    reachable,
    diverged: Boolean(configuredCodec && detectedCodec && configuredCodec !== detectedCodec),
    // Codec trocado muda TODOS os pipelines de uma vez (live transcodifica, o
    // navegador pode não decodificar, a gravação arquiva outro bitstream).
    severity: 'critical',
    matchMessage: 'A câmera entrega o mesmo codec registrado no cadastro.',
    divergedMessage: `A câmera passou a entregar ${detectedCodec}, mas o DRAC tem ${configuredCodec} registrado. Firmware ou perfil da câmera foi alterado.`,
    unknownMessage: 'Codec não confirmado agora; mostrando apenas o valor registrado.',
  });

  const configuredResolution = resolutionLabel(configured.width, configured.height);
  const detectedResolution = resolutionLabel(main?.width, main?.height);
  const configuredPixels = pixels(configured.width, configured.height);
  const detectedPixels = pixels(main?.width, main?.height);
  const resolutionDiverged = Boolean(
    configuredResolution && detectedResolution && configuredResolution !== detectedResolution,
  );
  // Queda de resolução é o modo de falha que APAGA PROVA: a gravação continua
  // rodando e ninguém percebe até precisar identificar alguém no vídeo.
  const resolutionDropped = Boolean(
    resolutionDiverged && configuredPixels && detectedPixels && detectedPixels < configuredPixels,
  );
  const resolution = makeFinding('resolution', 'Resolução', configuredResolution, detectedResolution, {
    reachable,
    diverged: resolutionDiverged,
    severity: resolutionDropped ? 'critical' : 'warning',
    matchMessage: 'Resolução igual à registrada no cadastro.',
    divergedMessage: resolutionDropped
      ? `A resolução CAIU: registrada ${configuredResolution}, entregue ${detectedResolution}. A gravação está arquivando menos detalhe do que o contratado.`
      : `A câmera passou a entregar ${detectedResolution} (registrado ${configuredResolution}).`,
    unknownMessage: 'Resolução não confirmada agora; mostrando apenas o valor registrado.',
  });

  const configuredFps = finiteOrNull(configured.fps);
  const detectedFps = finiteOrNull(main?.fps);
  const fps = makeFinding(
    'fps',
    'Taxa de quadros',
    configuredFps ? `${Math.round(configuredFps)} FPS` : null,
    detectedFps ? `${Math.round(detectedFps)} FPS` : null,
    {
      reachable,
      diverged: Boolean(
        configuredFps && detectedFps && Math.abs(configuredFps - detectedFps) > FPS_TOLERANCE,
      ),
      matchMessage: 'Taxa de quadros compatível com a registrada.',
      divergedMessage: `A câmera está entregando ${detectedFps ? Math.round(detectedFps) : '?'} FPS contra ${configuredFps ? Math.round(configuredFps) : '?'} FPS registrados.`,
      unknownMessage: 'Taxa de quadros não confirmada agora.',
    },
  );

  const configuredPath = cleanText(configured.rtspPath);
  const detectedPath = cleanText(main?.rtspPath);
  const rtspPath = makeFinding('rtsp_path', 'Caminho RTSP', configuredPath, detectedPath, {
    reachable,
    diverged: Boolean(configuredPath && detectedPath && configuredPath !== detectedPath),
    matchMessage: 'O vídeo respondeu no caminho configurado.',
    divergedMessage: `O vídeo respondeu em ${detectedPath}, e não no caminho configurado ${configuredPath}.`,
    unknownMessage: 'Nenhum caminho RTSP respondeu agora.',
  });

  const configuredPort = finiteOrNull(configured.rtspPort);
  const detectedPort = finiteOrNull(main?.rtspPort);
  const rtspPort = makeFinding(
    'rtsp_port',
    'Porta RTSP',
    configuredPort ? String(Math.round(configuredPort)) : null,
    detectedPort ? String(Math.round(detectedPort)) : null,
    {
      reachable,
      diverged: Boolean(configuredPort && detectedPort && configuredPort !== detectedPort),
      matchMessage: 'O vídeo respondeu na porta configurada.',
      divergedMessage: `O vídeo respondeu na porta ${detectedPort}, e não na porta configurada ${configuredPort}.`,
      unknownMessage: 'Nenhuma porta RTSP respondeu agora.',
    },
  );

  // Substream: o DRAC separa análise (detecção de movimento) da live justamente
  // para não pagar CPU no stream principal. Quando `analyticsSubtype` difere do
  // `liveSubtype`, existe substream ESPERADO — se ele sumiu, a análise degrada.
  const expectsSub = finiteOrNull(configured.analyticsSubtype) !== finiteOrNull(configured.liveSubtype);
  const sub = detected.sub ?? null;
  const subLabel = describeStream(sub);
  const substream: DiagnosticsFinding = !detected.reachable
    ? {
        key: 'substream',
        label: 'Substream',
        configured: expectsSub ? 'esperado' : 'não usado',
        detected: null,
        state: 'unknown',
        severity: 'info',
        message: 'Presença do substream não confirmada agora.',
      }
    : {
        key: 'substream',
        label: 'Substream',
        configured: expectsSub ? 'esperado' : 'não usado',
        detected: sub ? subLabel ?? 'presente' : 'ausente',
        state: expectsSub && !sub ? 'diverged' : 'match',
        severity: expectsSub && !sub ? 'warning' : 'info',
        message:
          expectsSub && !sub
            ? 'O substream configurado para análise não respondeu. A detecção de movimento passa a disputar o stream principal.'
            : expectsSub
              ? 'Substream presente e separado do stream principal.'
              : 'Esta câmera não usa substream separado.',
      };

  return [codec, resolution, fps, rtspPath, rtspPort, substream];
}

function buildTranscodeVerdicts(
  configured: DiagnosticsConfigured,
  detected: DiagnosticsDetected,
): TranscodeVerdict[] {
  const measuredMain = detected.reachable ? detected.main?.codec ?? null : null;
  const mainCodec = measuredMain ?? configured.videoCodec ?? null;
  const certainty: TranscodeVerdict['certainty'] = measuredMain ? 'measured' : 'assumed';
  const mainIsHevc = isHevcCodec(mainCodec);
  const audioEnabled = Boolean(configured.audioEnabled);

  // LIVE (câmera individual, entrega 'selected'): o publisher FFmpeg só sobe
  // quando a fonte é H.265 (o navegador não decodifica HEVC em WebRTC) ou quando
  // o áudio precisa ser reempacotado para o WebRTC.
  const liveSingle: TranscodeVerdict = mainIsHevc
    ? {
        pipeline: 'live_single',
        label: 'Ao vivo (câmera individual)',
        transcoding: true,
        code: 'source_hevc',
        reason: 'A fonte é H.265 e o navegador não decodifica H.265 em WebRTC: o servidor converte para H.264.',
        certainty,
      }
    : audioEnabled
      ? {
          pipeline: 'live_single',
          label: 'Ao vivo (câmera individual)',
          transcoding: true,
          code: 'audio_webrtc',
          reason: 'O vídeo passaria direto, mas o áudio habilitado exige reempacotamento para WebRTC.',
          certainty,
        }
      : {
          pipeline: 'live_single',
          label: 'Ao vivo (câmera individual)',
          transcoding: false,
          code: 'passthrough',
          reason: 'Vídeo entregue como está, sem conversão (sem custo de CPU).',
          certainty,
        };

  // GRADE: usa o substream quando existe (é o que a torna instantânea). Fonte
  // H.264 vai por passthrough; só H.265 exige publisher.
  const gridFacts = detected.reachable ? detected.sub ?? detected.main ?? null : null;
  const gridCodec = gridFacts?.codec ?? mainCodec;
  const gridCertainty: TranscodeVerdict['certainty'] = gridFacts?.codec ? 'measured' : 'assumed';
  const liveGrid: TranscodeVerdict = isHevcCodec(gridCodec)
    ? {
        pipeline: 'live_grid',
        label: 'Ao vivo (grade)',
        transcoding: true,
        code: 'source_hevc',
        reason: 'A fonte da grade é H.265: o servidor converte para H.264 antes de publicar o mosaico.',
        certainty: gridCertainty,
      }
    : {
        pipeline: 'live_grid',
        label: 'Ao vivo (grade)',
        transcoding: false,
        code: 'passthrough',
        reason: 'A grade entrega a fonte H.264 direto, sem FFmpeg no caminho.',
        certainty: gridCertainty,
      };

  // GRAVAÇÃO: o modo padrão do DRAC é 'copy' — arquiva o bitstream ORIGINAL,
  // inclusive H.265. Só os modos explícitos h265/h264 reencodam, e mesmo assim
  // apenas quando a fonte já não está no codec pedido.
  const mode = configured.recordingCodecMode ?? 'copy';
  const recording: TranscodeVerdict =
    mode === 'h265' && !mainIsHevc
      ? {
          pipeline: 'recording',
          label: 'Gravação',
          transcoding: true,
          code: 'codec_mode_h265',
          reason: 'A gravação está fixada em H.265 e a fonte não é H.265: cada segmento é reencodado.',
          certainty,
        }
      : mode === 'h264' && mainIsHevc
        ? {
            pipeline: 'recording',
            label: 'Gravação',
            transcoding: true,
            code: 'codec_mode_h264',
            reason: 'A gravação está fixada em H.264 e a fonte é H.265: cada segmento é reencodado.',
            certainty,
          }
        : {
            pipeline: 'recording',
            label: 'Gravação',
            transcoding: false,
            code: 'passthrough',
            reason: 'A gravação arquiva o bitstream original da câmera, sem reencode.',
            certainty,
          };

  return [liveSingle, liveGrid, recording];
}

export function buildCameraDiagnosticsReport(input: {
  checkedAt: string;
  configured: DiagnosticsConfigured;
  detected: DiagnosticsDetected;
}): CameraDiagnosticsReport {
  const configured = input.configured ?? {};
  const detected = input.detected ?? { reachable: false };
  const findings = buildFindings(configured, detected);
  const transcode = buildTranscodeVerdicts(configured, detected);
  const reachable = Boolean(detected.reachable) && Boolean(detected.main);

  const divergences = findings.filter((item) => item.state === 'diverged');
  const critical = divergences.filter((item) => item.severity === 'critical');
  const state: CameraDiagnosticsReport['state'] = !reachable
    ? 'unreachable'
    : divergences.length
      ? 'diverged'
      : 'ok';

  const summary = !reachable
    ? 'A câmera não respondeu ao diagnóstico agora. Os valores abaixo são os registrados no cadastro — nada foi confirmado nesta tentativa.'
    : divergences.length === 0
      ? 'A câmera está entregando exatamente o que está configurado.'
      : critical.length
        ? `${divergences.length} divergência(s) entre o configurado e o que a câmera entrega agora — ${critical.length} crítica(s).`
        : `${divergences.length} divergência(s) entre o configurado e o que a câmera entrega agora.`;

  return {
    state,
    reachable,
    summary,
    checkedAt: input.checkedAt,
    findings,
    transcode,
    detected: {
      main: describeStream(detected.main),
      sub: describeStream(detected.sub),
    },
    error: cleanText(detected.error),
  };
}
