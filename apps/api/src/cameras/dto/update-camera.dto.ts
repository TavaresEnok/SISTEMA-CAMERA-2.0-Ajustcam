import { ArrayMaxSize, IsArray, IsBoolean, IsIP, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DetectionZoneDto } from './detection-zone.dto';

const RECORDING_MODES = ['continuous', 'motion', 'schedule', 'manual'] as const;
const VIDEO_CODECS = ['original', 'h264', 'h265', 'hevc', 'mjpeg'] as const;
const STREAM_VIDEO_CODECS = ['original', 'h264', 'h265', 'hevc', 'mjpeg'] as const;
const RTSP_TRANSPORTS = ['tcp', 'udp'] as const;
const LIVE_PROTOCOLS = ['auto', 'flv', 'hls', 'llhls', 'webrtc', 'mjpeg'] as const;

export class UpdateCameraDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  @IsIP()
  ip?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  rtspPort?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  onvifPort?: number;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

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

  /** Segue a retenção do grupo? Câmera nova nasce seguindo. */
  @IsOptional()
  @IsBoolean()
  retentionFollowsGroup?: boolean;

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
  streamWidth?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamHeight?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamFps?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamBitrateKbps?: number | null;

  @IsOptional()
  @IsString()
  @IsIn(VIDEO_CODECS)
  recordingVideoCodec?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingWidth?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingHeight?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingFps?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingBitrateKbps?: number | null;

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

  /// Zonas de detecção: polígonos normalizados (0..1). Ver DetectionZoneDto.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => DetectionZoneDto)
  detectionZones?: DetectionZoneDto[];
}
