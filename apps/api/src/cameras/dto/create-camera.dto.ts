import { IsBoolean, IsIP, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const RECORDING_MODES = ['continuous', 'motion', 'schedule', 'manual'] as const;
const VIDEO_CODECS = ['original', 'h264', 'h265', 'hevc', 'mjpeg'] as const;
const STREAM_VIDEO_CODECS = ['original', 'h264', 'h265', 'hevc', 'mjpeg'] as const;
const RTSP_TRANSPORTS = ['tcp', 'udp'] as const;
const LIVE_PROTOCOLS = ['auto', 'flv', 'hls', 'llhls', 'webrtc', 'mjpeg'] as const;

export class CreateCameraDto {
  @IsString()
  name!: string;

  @IsString()
  @IsIP()
  ip!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  rtspPort!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  onvifPort?: number;

  @IsString()
  username!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  rtspPath?: string;

  @IsOptional()
  @IsString()
  onvifPath?: string;

  @IsOptional()
  @IsString()
  onvifProfileToken?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  channel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  subtype?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  liveChannel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  liveSubtype?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingChannel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  recordingSubtype?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  analyticsChannel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  analyticsSubtype?: number;

  @IsOptional()
  @IsString()
  siteId?: string;

  @IsOptional()
  @IsString()
  areaId?: string;

  @IsOptional()
  @IsString()
  groupId?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  recordingEnabled?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(RECORDING_MODES)
  recordingMode?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDays?: number;

  @IsOptional()
  @IsString()
  @IsIn(RTSP_TRANSPORTS)
  preferredRtspTransport?: string;

  @IsOptional()
  @IsString()
  @IsIn(LIVE_PROTOCOLS)
  preferredLiveProtocol?: string;

  @IsOptional()
  @IsString()
  @IsIn(STREAM_VIDEO_CODECS)
  streamVideoCodec?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamWidth?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamHeight?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamFps?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamBitrateKbps?: number;

  @IsOptional()
  @IsString()
  @IsIn(VIDEO_CODECS)
  recordingVideoCodec?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingWidth?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingHeight?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingFps?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingBitrateKbps?: number;

  @IsOptional()
  @IsBoolean()
  audioEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  alarmsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  hasEdgeAi?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['SYSTEM', 'CAMERA'])
  motionTrigger?: string;
}
