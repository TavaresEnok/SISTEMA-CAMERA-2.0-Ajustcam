import { assertCameraTargetAllowed } from '../../common/network/safe-url.helper';

export type CameraRtspUrlInput = {
  username: string;
  password: string;
  ip: string;
  rtspPort: number;
  rtspPath?: string | null;
  channel?: number | null;
  subtype?: number | null;
};

type CameraRtspProfileInput = {
  channel?: number | null;
  subtype?: number | null;
  liveChannel?: number | null;
  liveSubtype?: number | null;
  recordingChannel?: number | null;
  recordingSubtype?: number | null;
  analyticsChannel?: number | null;
  analyticsSubtype?: number | null;
  streamVideoCodec?: string | null;
  recordingVideoCodec?: string | null;
  detectedVideoCodec?: string | null;
  streamWidth?: number | null;
  streamHeight?: number | null;
};

function normalizeChannel(value: number | null | undefined, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.round(parsed);
}

function normalizeSubtype(value: number | null | undefined, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed);
}

function applyChannelSubtypeToPath(path: string, channel: number, subtype: number) {
  let result = path;
  // Dahua-style query parameters
  result = result.replace(/([?&]channel=)\d+/i, `$1${channel}`);
  result = result.replace(/([?&]subtype=)\d+/i, `$1${subtype}`);
  // Hikvision-style /Streaming/Channels/101: channel 1, main stream 01.
  // Our internal subtype is zero-based, so subtype 0 maps to 01, 1 to 02, etc.
  result = result.replace(
    /(\/Streaming\/Channels\/)(\d+)(\d{2})(\b|\/|$)/i,
    (_match, prefix, _ch, _sub, suffix) => `${prefix}${channel}${(subtype + 1).toString().padStart(2, '0')}${suffix}`,
  );
  return result;
}

export function resolveLiveRtspProfile(camera: CameraRtspProfileInput) {
  return {
    channel: normalizeChannel(camera.liveChannel, normalizeChannel(camera.channel, 1)),
    subtype: normalizeSubtype(camera.liveSubtype, normalizeSubtype(camera.subtype, 0)),
  };
}

export function resolveRecordingRtspProfile(camera: CameraRtspProfileInput) {
  return {
    channel: normalizeChannel(camera.recordingChannel, normalizeChannel(camera.channel, 1)),
    subtype: normalizeSubtype(camera.recordingSubtype, normalizeSubtype(camera.subtype, 0)),
  };
}

export function resolveAnalyticsRtspProfile(camera: CameraRtspProfileInput) {
  return {
    channel: normalizeChannel(camera.analyticsChannel, normalizeChannel(camera.channel, 1)),
    subtype: normalizeSubtype(camera.analyticsSubtype, 1),
  };
}

/**
 * Perfil para a GRADE (mosaico): preferimos o SUB-stream (2º canal, subtype 1) —
 * baixa resolução/bitrate, GOP curto e, na maioria das câmeras, já em H.264.
 * Isso deixa os tiles abrirem quase instantâneos e sem transcodificar. Se a câmera
 * não tiver sub-stream, o chamador faz fallback para o main. Mantém o mesmo canal
 * do live (liveChannel/channel), trocando só o subtype para 1.
 */
export function resolveGridRtspProfile(camera: CameraRtspProfileInput) {
  return {
    channel: normalizeChannel(camera.liveChannel, normalizeChannel(camera.channel, 1)),
    subtype: 1,
  };
}

export function sanitizeRtspUrl(url: string) {
  return url.replace(/(rtsp:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1<redacted>@');
}

export function isHevcCodec(codec?: string | null) {
  const value = String(codec ?? '').trim().toLowerCase();
  return value.includes('h265') || value.includes('hevc') || value.includes('265') || value.includes('hvc1');
}

export function isOriginalLiveProfileRequested(camera: CameraRtspProfileInput) {
  const codec = String(camera.streamVideoCodec ?? '').trim().toLowerCase();
  const wantsOriginalCodec = codec === '' || codec === 'original';
  const wantsOriginalResolution = camera.streamWidth == null && camera.streamHeight == null;
  return wantsOriginalCodec && wantsOriginalResolution;
}

export function resolveOriginalRtspProfile(camera: CameraRtspProfileInput) {
  return resolveRecordingRtspProfile(camera);
}

export function resolveOriginalVideoCodec(camera: CameraRtspProfileInput) {
  return String(camera.recordingVideoCodec ?? camera.detectedVideoCodec ?? camera.streamVideoCodec ?? '').trim().toLowerCase() || null;
}

export function resolveDeliveryVideoCodec(camera: CameraRtspProfileInput) {
  const configuredCodec = String(camera.streamVideoCodec ?? '').trim().toLowerCase();
  if (configuredCodec && configuredCodec !== 'original') {
    return configuredCodec;
  }

  const originalCodec = resolveOriginalVideoCodec(camera);
  if (isOriginalLiveProfileRequested(camera) && originalCodec && !isHevcCodec(originalCodec)) {
    return originalCodec;
  }

  return String(camera.detectedVideoCodec ?? originalCodec ?? configuredCodec ?? '').trim().toLowerCase() || null;
}

export function resolveDeliveryRtspProfile(camera: CameraRtspProfileInput) {
  // Live and recording are independent pipelines. Live must start from the
  // configured live profile, while the recording profile keeps the archive source.
  return resolveLiveRtspProfile(camera);
}

export function buildRtspUrl(camera: CameraRtspUrlInput): string {
  const targetIp = assertCameraTargetAllowed(camera.ip, camera.rtspPort);
  const channel = normalizeChannel(camera.channel, 1);
  const subtype = normalizeSubtype(camera.subtype, 0);

  let rtspPath =
    camera.rtspPath && camera.rtspPath.trim().length > 0
      ? camera.rtspPath
      : `/cam/realmonitor?channel=${channel}&subtype=${subtype}`;

  rtspPath = applyChannelSubtypeToPath(rtspPath, channel, subtype);

  if (!rtspPath.startsWith('/')) {
    rtspPath = '/' + rtspPath;
  }

  const username = encodeURIComponent(camera.username);
  const password = encodeURIComponent(camera.password);
  const authorityHost = isIpv6Literal(targetIp) ? `[${targetIp}]` : targetIp;
  return `rtsp://${username}:${password}@${authorityHost}:${camera.rtspPort}${rtspPath}`;
}

function isIpv6Literal(ip: string): boolean {
  return ip.includes(':');
}
