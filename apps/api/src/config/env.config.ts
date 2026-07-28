import { Logger } from '@nestjs/common';
import { envBool, envNumber } from '../common/config/env-number.helper';

// ─────────────────────────────────────────────────────────────────────────────
// ESQUEMA DE CONFIGURAÇÃO — o `.env` é ENTRADA DE PRODUÇÃO, não literal de código.
//
// O que este arquivo fazia antes: `envNumber('X', 300)`. Isso devolve
// NaN para "300 ", "5min", "92%" ou vírgula decimal — e NaN não explode, ele
// desarma comparações EM SILÊNCIO (já custou uma guarda de disco que nunca
// disparou, com o disco a 100% e todas as câmeras paradas sem um erro no log).
// O irmão booleano é o `String(x) !== 'false'`: aceita qualquer lixo como
// verdadeiro, então `MEDIAMTX_ENABLED=0` continuava LIGADO e ninguém avisava.
//
// Regra do esquema, para todo valor daqui:
//   · valor inválido NUNCA vira NaN nem zero — cai no default e AVISA no boot;
//   · valor fora de faixa é limitado ao que o subsistema realmente aguenta;
//   · os defaults são os MESMOS de antes da conversão (travados por teste).
//
// As faixas são GENEROSAS de propósito: existem para barrar o absurdo (0,
// negativo, porta 70000), não para discutir o ajuste fino do operador.
// ─────────────────────────────────────────────────────────────────────────────

const logger = new Logger('EnvConfig');

type EnvSource = Record<string, string | undefined>;

/**
 * Monta o esquema a partir de uma fonte explícita. `readEnvConfig` existe
 * separada de `envConfig` para que o teste possa injetar um `.env` inteiro e
 * observar os avisos sem depender do ambiente da máquina.
 */
export function readEnvConfig(
  source: EnvSource = process.env,
  onInvalid: (message: string) => void = (message) => logger.warn(message),
) {
  const num = (
    name: string,
    fallback: number,
    options: { min?: number; max?: number; integer?: boolean } = {},
  ) => envNumber(name, fallback, { ...options, onInvalid }, source);
  const flag = (name: string, fallback: boolean) => envBool(name, fallback, { onInvalid }, source);

  return {
    apiPort: num('API_PORT', 3000, { min: 1, max: 65535, integer: true }),
    corsAllowedOrigins: source.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173',
    databaseUrl: source.DATABASE_URL ?? '',
    redisHost: source.REDIS_HOST ?? 'localhost',
    redisPort: num('REDIS_PORT', 6379, { min: 1, max: 65535, integer: true }),
    cameraSecretKey: source.CAMERA_SECRET_KEY ?? '',
    ffmpegRtspTransport: source.FFMPEG_RTSP_TRANSPORT ?? 'tcp',
    ffmpegRtspFallbackTransports: source.FFMPEG_RTSP_FALLBACK_TRANSPORTS ?? 'tcp,udp',
    ffmpegRtspFallbackPorts: source.FFMPEG_RTSP_FALLBACK_PORTS ?? '51488,51489,51490',
    ffmpegRtspEnablePortFallback: flag('FFMPEG_RTSP_ENABLE_PORT_FALLBACK', false),
    // Vão direto para a linha de comando do FFmpeg: NaN aqui não é "número
    // inválido", é câmera que nunca sobe (o processo morre no parse do argumento).
    ffmpegStimeoutUs: num('FFMPEG_STIMEOUT_US', 8_000_000, { min: 100_000, max: 120_000_000, integer: true }),
    ffmpegMaxDelayUs: num('FFMPEG_MAX_DELAY_US', 500_000, { min: 0, max: 60_000_000, integer: true }),
    ffmpegProbesize: num('FFMPEG_PROBESIZE', 32_768, { min: 1024, max: 100_000_000, integer: true }),
    ffmpegAnalyzedurationUs: num('FFMPEG_ANALYZEDURATION_US', 1_000_000, { min: 0, max: 60_000_000, integer: true }),
    mjpegFps: num('MJPEG_FPS', 20, { min: 1, max: 60, integer: true }),
    // qscale do MJPEG no FFmpeg vive em 2..31; fora disso o encoder recusa.
    mjpegQ: num('MJPEG_Q', 5, { min: 2, max: 31, integer: true }),
    // Posters dos cards são capturas pontuais, não lives. Cache maior e
    // concorrência limitada evitam abrir dezenas de conexões RTSP/FFmpeg juntas.
    livePosterCacheTtlMs: num('LIVE_POSTER_CACHE_TTL_MS', 60_000, { min: 0, max: 3_600_000, integer: true }),
    livePosterMaxConcurrency: num('LIVE_POSTER_MAX_CONCURRENCY', 3, { min: 1, max: 32, integer: true }),
    recordingsRoot: source.RECORDINGS_ROOT ?? './storage/recordings',
    storageBackend: source.STORAGE_BACKEND ?? 'local',
    storageWriteProbeEnabled: flag('STORAGE_WRITE_PROBE_ENABLED', true),
    recordingSegmentSeconds: num('RECORDING_SEGMENT_SECONDS', 300, { min: 5, max: 3600, integer: true }),
    // Guarda de espaço livre: zero/NaN aqui é a guarda DESARMADA. Teto de 99%
    // garante que ela continue sendo uma guarda, e não um bloqueio total.
    recordingMinFreeBytes: num('RECORDING_MIN_FREE_BYTES', 2_147_483_648, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
    recordingMinFreePercent: num('RECORDING_MIN_FREE_PERCENT', 5, { min: 0, max: 99, integer: true }),
    ffmpegRecordingFormat: source.FFMPEG_RECORDING_FORMAT ?? 'mp4',
    // Continua STRING de propósito: o consumidor compara com 'false' e a
    // retrocompatibilidade do modo de codec depende do literal.
    ffmpegRecordingCopyCodec: source.FFMPEG_RECORDING_COPY_CODEC ?? 'true',
    // Política de codec da gravação: 'copy' (padrão) arquiva o bitstream original
    // (H.264 ou H.265) sem reencode. 'h265'/'h264' transcodam quando a fonte difere.
    // Retrocompat: quem setou FFMPEG_RECORDING_COPY_CODEC=false mantém o antigo
    // comportamento de forçar H.265.
    recordingCodecMode:
      source.FFMPEG_RECORDING_CODEC_MODE ??
      (source.FFMPEG_RECORDING_COPY_CODEC === 'false' ? 'h265' : 'copy'),
    recordingControlMode: source.RECORDING_CONTROL_MODE ?? 'local',
    workerCommandChannel: source.WORKER_COMMAND_CHANNEL ?? 'camera:commands',
    recordingThumbnailSecond: num('RECORDING_THUMBNAIL_SECOND', 2, { min: 0, max: 3600, integer: true }),
    streamIncidentCooldownSeconds: num('STREAM_INCIDENT_COOLDOWN_SECONDS', 120, { min: 0, max: 86_400, integer: true }),
    healthAutoRemediationEnabled: flag('HEALTH_AUTO_REMEDIATION_ENABLED', true),
    healthAutoRemediationMaxPerRun: num('HEALTH_AUTO_REMEDIATION_MAX_PER_RUN', 5, { min: 0, max: 1000, integer: true }),
    alertScoreWarning: num('ALERT_SCORE_WARNING', 75, { min: 0, max: 100, integer: true }),
    alertScoreCritical: num('ALERT_SCORE_CRITICAL', 60, { min: 0, max: 100, integer: true }),
    alertOpenIncidentsCritical: num('ALERT_OPEN_INCIDENTS_CRITICAL', 5, { min: 1, max: 10_000, integer: true }),
    alertRecentWindowMinutes: num('ALERT_RECENT_WINDOW_MINUTES', 60, { min: 1, max: 10_080, integer: true }),
    cookieSecure: source.COOKIE_SECURE, // 'true'/'false' força o valor; se ausente, deriva de NODE_ENV.
    jwtSecret: source.JWT_SECRET ?? '',
    jwtExpiresIn: source.JWT_EXPIRES_IN ?? '8h',
    evidenceHmacSecret: source.EVIDENCE_HMAC_SECRET ?? '',
    evidenceHmacKeyId: source.EVIDENCE_HMAC_KEY_ID ?? 'local-v1',
    alarmWebhookDefaultUrl: source.ALARM_WEBHOOK_DEFAULT_URL ?? '',
    alarmWebhookAllowedHosts: source.ALARM_WEBHOOK_ALLOWED_HOSTS ?? '',
    alarmWebhookSigningSecret: source.ALARM_WEBHOOK_SIGNING_SECRET ?? '',
    alarmEmailFrom: source.ALARM_EMAIL_FROM ?? '',
    aiBaseUrl: source.AI_BASE_URL ?? 'http://ai-service:8000',
    smtpHost: source.SMTP_HOST ?? '',
    smtpPort: num('SMTP_PORT', 587, { min: 1, max: 65535, integer: true }),
    smtpSecure: flag('SMTP_SECURE', false),
    smtpUser: source.SMTP_USER ?? '',
    smtpPass: source.SMTP_PASS ?? '',
    streamTokenExpiresIn: source.STREAM_TOKEN_EXPIRES_IN ?? '5m',
    publicAppUrl: source.PUBLIC_APP_URL ?? '',
    apiPublicUrl: source.API_PUBLIC_URL ?? '',
    mediaMtxEnabled: flag('MEDIAMTX_ENABLED', true),
    mediaMtxApiBaseUrl: source.MEDIAMTX_API_BASE_URL ?? 'http://mediamtx:9997',
    mediaMtxRtspInternalUrl: source.MEDIAMTX_RTSP_INTERNAL_URL ?? 'rtsp://mediamtx:8554',
    mediaMtxApiUser: source.MEDIAMTX_API_USER ?? '',
    mediaMtxApiPass: source.MEDIAMTX_API_PASS ?? '',
    mediaMtxPublicHost: source.MEDIAMTX_PUBLIC_HOST ?? '',
    mediaMtxPublicScheme: source.MEDIAMTX_PUBLIC_SCHEME ?? '',
    mediaMtxPublicWebrtcUrl: source.MEDIAMTX_PUBLIC_WEBRTC_URL ?? '',
    mediaMtxPublicHlsUrl: source.MEDIAMTX_PUBLIC_HLS_URL ?? '',
    mediaMtxHlsPort: num('MEDIAMTX_HLS_PORT', 8888, { min: 1, max: 65535, integer: true }),
    mediaMtxWebrtcPort: num('MEDIAMTX_WEBRTC_PORT', 8889, { min: 1, max: 65535, integer: true }),
    mediaMtxSourceOnDemand: flag('MEDIAMTX_SOURCE_ON_DEMAND', false),
    // Durações do MediaMTX são STRING com unidade ('5m', '6s') e vão cruas para
    // a API dele — quem valida o formato é o próprio MediaMTX.
    mediaMtxSourceOnDemandStartTimeout: source.MEDIAMTX_SOURCE_ON_DEMAND_START_TIMEOUT ?? '6s',
    mediaMtxSourceOnDemandCloseAfter: source.MEDIAMTX_SOURCE_ON_DEMAND_CLOSE_AFTER ?? '5m',
    mediaMtxRunOnDemandCloseAfter: source.MEDIAMTX_RUN_ON_DEMAND_CLOSE_AFTER ?? '5m',
    mediaMtxSelectedRunOnDemandCloseAfter:
      source.MEDIAMTX_SELECTED_RUN_ON_DEMAND_CLOSE_AFTER
      ?? source.MEDIAMTX_RUN_ON_DEMAND_CLOSE_AFTER
      ?? '5m',
    mediaMtxWarmPathsOnBoot: flag('MEDIAMTX_WARM_PATHS_ON_BOOT', true),
    mediaMtxWarmSelectedPathsOnBoot: flag('MEDIAMTX_WARM_SELECTED_PATHS_ON_BOOT', false),
    adminEmail: source.ADMIN_EMAIL ?? 'admin@local.dev',
    adminPassword: source.ADMIN_PASSWORD ?? '',
    adminName: source.ADMIN_NAME ?? 'Administrador',
    internalServiceToken: source.INTERNAL_SERVICE_TOKEN ?? '',
    cameraTestAllowPublicIp: flag('CAMERA_TEST_ALLOW_PUBLIC_IP', false),
    // Dias de retenção: 0 ou NaN apagaria o acervo INTEIRO na varredura seguinte.
    // Piso de 1 dia é inegociável.
    retentionDays: num('RETENTION_DAYS', 7, { min: 1, max: 3650, integer: true }),
    retentionUseBullmq: flag('RETENTION_USE_BULLMQ', true),
    healthCheckOfflineMinutes: num('HEALTHCHECK_OFFLINE_MINUTES', 5, { min: 1, max: 10_080, integer: true }),
    // Silêncio entre notificações do MESMO alarme (câmera+tipo+prioridade). Evita
    // enxurrada de push em câmeras movimentadas (ex.: movimento numa rua). 300s = 5min.
    alarmNotificationSuppressSeconds: num('ALARM_NOTIFICATION_SUPPRESS_SECONDS', 300, { min: 0, max: 86_400, integer: true }),
  };
}

export const envConfig = () => readEnvConfig();
