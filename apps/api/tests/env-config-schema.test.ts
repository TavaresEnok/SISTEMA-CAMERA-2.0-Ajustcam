import test from 'node:test';
import assert from 'node:assert/strict';
import { readEnvConfig } from '../src/config/env.config';

// ─────────────────────────────────────────────────────────────────────────────
// ESQUEMA DE CONFIGURAÇÃO — o `.env` é entrada de PRODUÇÃO, não literal de código.
//
// `Number(process.env.X ?? 300)` vira NaN com "300 " ou "5min", e NaN não
// explode: desarma comparações em silêncio (guarda de disco que nunca dispara,
// setInterval em rajada de 1ms). `String(x) !== 'false'` aceita qualquer lixo
// como verdadeiro. Nos dois casos o operador acha que configurou e ninguém avisa.
//
// Este arquivo trava as três promessas do esquema:
//   1. o default de HOJE continua idêntico (nada de mudança silenciosa);
//   2. lixo no `.env` NUNCA vira NaN nem zero — cai no default e AVISA;
//   3. valor fora de faixa é limitado ao que o subsistema aguenta.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrato dos defaults ANTES da conversão (capturado do código em produção com
 * o ambiente vazio). Se um valor mudar aqui, alguém alterou o comportamento
 * padrão de uma instalação viva — o teste tem que doer.
 */
const DEFAULTS: Record<string, unknown> = {
  adminEmail: 'admin@local.dev',
  adminName: 'Administrador',
  adminPassword: '',
  aiBaseUrl: 'http://ai-service:8000',
  alarmEmailFrom: '',
  alarmNotificationSuppressSeconds: 300,
  alarmWebhookAllowedHosts: '',
  alarmWebhookDefaultUrl: '',
  alarmWebhookSigningSecret: '',
  alertOpenIncidentsCritical: 5,
  alertRecentWindowMinutes: 60,
  alertScoreCritical: 60,
  alertScoreWarning: 75,
  apiPort: 3000,
  apiPublicUrl: '',
  cameraAllowedCidrs: '',
  cameraDeniedCidrs: '',
  cameraSecretKey: '',
  cameraTestAllowPublicIp: false,
  cookieSecure: undefined,
  corsAllowedOrigins: 'http://localhost:5173',
  databaseUrl: '',
  evidenceHmacKeyId: 'local-v1',
  evidenceHmacSecret: '',
  ffmpegAnalyzedurationUs: 1000000,
  ffmpegMaxDelayUs: 500000,
  ffmpegProbesize: 32768,
  ffmpegRecordingCopyCodec: 'true',
  ffmpegRecordingFormat: 'mp4',
  ffmpegRtspEnablePortFallback: false,
  ffmpegRtspFallbackPorts: '51488,51489,51490',
  ffmpegRtspFallbackTransports: 'tcp,udp',
  ffmpegRtspTransport: 'tcp',
  ffmpegStimeoutUs: 8000000,
  healthAutoRemediationEnabled: true,
  healthAutoRemediationMaxPerRun: 5,
  healthCheckOfflineMinutes: 5,
  internalServiceToken: '',
  jwtExpiresIn: '8h',
  jwtSecret: '',
  livePosterCacheTtlMs: 60000,
  livePosterMaxConcurrency: 3,
  mediaMtxApiBaseUrl: 'http://mediamtx:9997',
  mediaMtxApiPass: '',
  mediaMtxApiUser: '',
  mediaMtxAuthCallbackToken: '',
  mediaMtxEnabled: true,
  mediaMtxHlsPort: 8888,
  mediaMtxPublicHlsUrl: '',
  mediaMtxPublicHost: '',
  mediaMtxPublicScheme: '',
  mediaMtxPublicWebrtcUrl: '',
  mediaMtxRtmpShortHost: '',
  mediaMtxRtspInternalUrl: 'rtsp://mediamtx:8554',
  mediaMtxRunOnDemandCloseAfter: '5m',
  mediaMtxSelectedRunOnDemandCloseAfter: '5m',
  mediaMtxSourceOnDemand: false,
  mediaMtxSourceOnDemandCloseAfter: '5m',
  mediaMtxSourceOnDemandStartTimeout: '6s',
  mediaMtxWarmPathsOnBoot: true,
  mediaMtxWarmSelectedPathsOnBoot: false,
  mediaMtxWebrtcPort: 8889,
  mjpegFps: 20,
  mjpegQ: 5,
  publicAppUrl: '',
  recordingCodecMode: 'copy',
  recordingControlMode: 'local',
  recordingMinFreeBytes: 2147483648,
  recordingMinFreePercent: 5,
  recordingSegmentSeconds: 300,
  recordingThumbnailSecond: 2,
  recordingsRoot: './storage/recordings',
  redisHost: 'localhost',
  redisConnectTimeoutMs: 5000,
  redisPort: 6379,
  redisStartupTimeoutMs: 10000,
  retentionDays: 7,
  retentionUseBullmq: true,
  smtpHost: '',
  smtpPass: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  storageBackend: 'local',
  storageWriteProbeEnabled: true,
  streamIncidentCooldownSeconds: 120,
  streamTokenExpiresIn: '5m',
  workerCommandChannel: 'camera:commands',
};

/**
 * Cada número do esquema, com a variável que o alimenta. A tabela é a lista de
 * quem NÃO pode virar NaN — e serve de documentação executável do `.env`.
 */
const NUMEROS: Array<[envVar: string, chave: string, padrao: number]> = [
  ['API_PORT', 'apiPort', 3000],
  ['REDIS_PORT', 'redisPort', 6379],
  ['REDIS_CONNECT_TIMEOUT_MS', 'redisConnectTimeoutMs', 5_000],
  ['REDIS_STARTUP_TIMEOUT_MS', 'redisStartupTimeoutMs', 10_000],
  ['FFMPEG_STIMEOUT_US', 'ffmpegStimeoutUs', 8_000_000],
  ['FFMPEG_MAX_DELAY_US', 'ffmpegMaxDelayUs', 500_000],
  ['FFMPEG_PROBESIZE', 'ffmpegProbesize', 32_768],
  ['FFMPEG_ANALYZEDURATION_US', 'ffmpegAnalyzedurationUs', 1_000_000],
  ['MJPEG_FPS', 'mjpegFps', 20],
  ['MJPEG_Q', 'mjpegQ', 5],
  ['LIVE_POSTER_CACHE_TTL_MS', 'livePosterCacheTtlMs', 60_000],
  ['LIVE_POSTER_MAX_CONCURRENCY', 'livePosterMaxConcurrency', 3],
  ['RECORDING_SEGMENT_SECONDS', 'recordingSegmentSeconds', 300],
  ['RECORDING_MIN_FREE_BYTES', 'recordingMinFreeBytes', 2_147_483_648],
  ['RECORDING_MIN_FREE_PERCENT', 'recordingMinFreePercent', 5],
  ['RECORDING_THUMBNAIL_SECOND', 'recordingThumbnailSecond', 2],
  ['STREAM_INCIDENT_COOLDOWN_SECONDS', 'streamIncidentCooldownSeconds', 120],
  ['HEALTH_AUTO_REMEDIATION_MAX_PER_RUN', 'healthAutoRemediationMaxPerRun', 5],
  ['ALERT_SCORE_WARNING', 'alertScoreWarning', 75],
  ['ALERT_SCORE_CRITICAL', 'alertScoreCritical', 60],
  ['ALERT_OPEN_INCIDENTS_CRITICAL', 'alertOpenIncidentsCritical', 5],
  ['ALERT_RECENT_WINDOW_MINUTES', 'alertRecentWindowMinutes', 60],
  ['SMTP_PORT', 'smtpPort', 587],
  ['MEDIAMTX_HLS_PORT', 'mediaMtxHlsPort', 8888],
  ['MEDIAMTX_WEBRTC_PORT', 'mediaMtxWebrtcPort', 8889],
  ['RETENTION_DAYS', 'retentionDays', 7],
  ['HEALTHCHECK_OFFLINE_MINUTES', 'healthCheckOfflineMinutes', 5],
  ['ALARM_NOTIFICATION_SUPPRESS_SECONDS', 'alarmNotificationSuppressSeconds', 300],
];

/** Cada flag do esquema e o lado SEGURO em que ela cai quando o valor é lixo. */
const BOOLEANOS: Array<[envVar: string, chave: string, padrao: boolean]> = [
  ['FFMPEG_RTSP_ENABLE_PORT_FALLBACK', 'ffmpegRtspEnablePortFallback', false],
  ['STORAGE_WRITE_PROBE_ENABLED', 'storageWriteProbeEnabled', true],
  ['HEALTH_AUTO_REMEDIATION_ENABLED', 'healthAutoRemediationEnabled', true],
  ['SMTP_SECURE', 'smtpSecure', false],
  ['MEDIAMTX_ENABLED', 'mediaMtxEnabled', true],
  ['MEDIAMTX_SOURCE_ON_DEMAND', 'mediaMtxSourceOnDemand', false],
  ['MEDIAMTX_WARM_PATHS_ON_BOOT', 'mediaMtxWarmPathsOnBoot', true],
  ['MEDIAMTX_WARM_SELECTED_PATHS_ON_BOOT', 'mediaMtxWarmSelectedPathsOnBoot', false],
  ['CAMERA_TEST_ALLOW_PUBLIC_IP', 'cameraTestAllowPublicIp', false],
  ['RETENTION_USE_BULLMQ', 'retentionUseBullmq', true],
];

test('ambiente vazio produz EXATAMENTE os defaults de hoje', () => {
  const config = readEnvConfig({}, () => {});
  assert.deepEqual({ ...config }, DEFAULTS, 'nenhum default pode mudar na conversão do esquema');
});

test('lixo no .env NÃO vira NaN em nenhum número — cai no default e AVISA', () => {
  for (const [envVar, chave, padrao] of NUMEROS) {
    for (const lixo of ['92%', 'noventa', '5 min', '3s', '--']) {
      const avisos: string[] = [];
      const config = readEnvConfig({ [envVar]: lixo }, (m) => avisos.push(m)) as Record<string, number>;
      assert.ok(Number.isFinite(config[chave]), `${envVar}="${lixo}" produziu ${config[chave]} em ${chave}`);
      assert.equal(config[chave], padrao, `${envVar}="${lixo}" deveria cair no default ${padrao}`);
      assert.equal(avisos.length, 1, `${envVar}="${lixo}" precisa AVISAR o operador`);
      assert.match(avisos[0], new RegExp(envVar), `o aviso precisa nomear a variável (${envVar})`);
    }
  }
});

test('todo número do esquema é finito mesmo com o .env inteiro corrompido', () => {
  const source: Record<string, string> = {};
  for (const [envVar] of NUMEROS) source[envVar] = 'NaN';
  const config = readEnvConfig(source, () => {}) as Record<string, unknown>;
  for (const [envVar, chave] of NUMEROS) {
    const value = config[chave];
    assert.equal(typeof value, 'number', `${chave} deixou de ser número`);
    assert.ok(Number.isFinite(value as number), `${envVar} produziu ${value} — NaN desarma comparações em silêncio`);
  }
});

test('faixas: valor absurdo é limitado ao que o subsistema aguenta', () => {
  const c = (source: Record<string, string>) => readEnvConfig(source, () => {}) as Record<string, number>;
  assert.equal(c({ RETENTION_DAYS: '0' }).retentionDays, 1, 'retenção 0 apagaria o acervo inteiro na varredura seguinte');
  assert.equal(c({ RETENTION_DAYS: '-30' }).retentionDays, 1, 'retenção negativa apagaria tudo');
  assert.equal(c({ API_PORT: '70000' }).apiPort, 65535, 'porta acima do domínio TCP');
  assert.equal(c({ API_PORT: '0' }).apiPort, 1, 'porta 0 sobe a API numa porta aleatória');
  assert.equal(c({ SMTP_PORT: '-1' }).smtpPort, 1);
  assert.equal(c({ MJPEG_FPS: '0' }).mjpegFps, 1, 'fps 0 trava o MJPEG');
  assert.equal(c({ MJPEG_FPS: '9999' }).mjpegFps, 60);
  assert.equal(c({ RECORDING_MIN_FREE_PERCENT: '100' }).recordingMinFreePercent, 99, '100% impediria QUALQUER gravação');
  assert.equal(c({ RECORDING_MIN_FREE_BYTES: '-1' }).recordingMinFreeBytes, 0);
  assert.equal(c({ ALERT_SCORE_WARNING: '-5' }).alertScoreWarning, 0);
  assert.equal(c({ ALERT_SCORE_WARNING: '500' }).alertScoreWarning, 100);
  assert.equal(c({ LIVE_POSTER_MAX_CONCURRENCY: '0' }).livePosterMaxConcurrency, 1, 'concorrência 0 nunca gera pôster');
  assert.equal(c({ RECORDING_SEGMENT_SECONDS: '0' }).recordingSegmentSeconds, 5, 'segmento 0 produziria arquivos infinitos');
  assert.equal(c({ HEALTHCHECK_OFFLINE_MINUTES: '0' }).healthCheckOfflineMinutes, 1);
});

test('faixas: inteiro é inteiro (nada de segmento de 300,7s indo pro ffmpeg)', () => {
  const c = (source: Record<string, string>) => readEnvConfig(source, () => {}) as Record<string, number>;
  assert.equal(c({ RECORDING_SEGMENT_SECONDS: '300.7' }).recordingSegmentSeconds, 300);
  assert.equal(c({ RECORDING_SEGMENT_SECONDS: '2,5' }).recordingSegmentSeconds, 5, 'vírgula decimal é lida e o piso vale');
  assert.equal(c({ API_PORT: '3000.9' }).apiPort, 3000);
});

test('valores válidos continuam passando intactos', () => {
  const config = readEnvConfig(
    {
      API_PORT: '4000',
      RETENTION_DAYS: '30',
      RECORDING_SEGMENT_SECONDS: '600',
      RECORDING_MIN_FREE_BYTES: '5368709120',
      MEDIAMTX_HLS_PORT: '8890',
    },
    () => {},
  ) as Record<string, number>;
  assert.equal(config.apiPort, 4000);
  assert.equal(config.retentionDays, 30);
  assert.equal(config.recordingSegmentSeconds, 600);
  assert.equal(config.recordingMinFreeBytes, 5_368_709_120);
  assert.equal(config.mediaMtxHlsPort, 8890);
});

test('host RTMP compacto configurado é preservado para URLs de campo curto', () => {
  const config = readEnvConfig({ MEDIAMTX_RTMP_SHORT_HOST: '192.0.2.10' }, () => {});
  assert.equal(config.mediaMtxRtmpShortHost, '192.0.2.10');
});

test('flags: "0"/"off" DESLIGAM de verdade e "TRUE"/"1" LIGAM', () => {
  for (const [envVar, chave] of BOOLEANOS) {
    for (const ligado of ['1', 'true', 'TRUE', 'on', 'yes']) {
      const config = readEnvConfig({ [envVar]: ligado }, () => {}) as Record<string, boolean>;
      assert.equal(config[chave], true, `${envVar}="${ligado}" deveria LIGAR ${chave}`);
    }
    for (const desligado of ['0', 'false', 'FALSE', 'off', 'no']) {
      const config = readEnvConfig({ [envVar]: desligado }, () => {}) as Record<string, boolean>;
      assert.equal(config[chave], false, `${envVar}="${desligado}" deveria DESLIGAR ${chave}`);
    }
  }
});

test('flags: lixo cai no lado SEGURO (o default de hoje) e AVISA', () => {
  for (const [envVar, chave, padrao] of BOOLEANOS) {
    const avisos: string[] = [];
    const config = readEnvConfig({ [envVar]: 'talvez' }, (m) => avisos.push(m)) as Record<string, boolean>;
    assert.equal(config[chave], padrao, `${envVar} inválido deveria manter ${padrao}`);
    assert.equal(typeof config[chave], 'boolean');
    assert.equal(avisos.length, 1, `${envVar} inválido precisa AVISAR`);
    assert.match(avisos[0], new RegExp(envVar));
  }
});

test('flags: o BOOT avisa uma vez por variável errada, e cala quando está tudo certo', () => {
  const avisos: string[] = [];
  readEnvConfig({ MEDIAMTX_ENABLED: 'talvez', RETENTION_DAYS: '7 dias', API_PORT: '3000' }, (m) => avisos.push(m));
  assert.equal(avisos.length, 2, 'só as duas erradas avisam');

  const silencio: string[] = [];
  readEnvConfig({}, (m) => silencio.push(m));
  assert.deepEqual(silencio, [], 'ambiente vazio é o caso normal: nada de ruído no boot');
});

test('o esquema não perde nem ganha chave sem alguém notar', () => {
  assert.deepEqual(
    Object.keys(readEnvConfig({}, () => {})).sort(),
    Object.keys(DEFAULTS).sort(),
    'chave nova/removida no esquema tem que ser deliberada',
  );
});
