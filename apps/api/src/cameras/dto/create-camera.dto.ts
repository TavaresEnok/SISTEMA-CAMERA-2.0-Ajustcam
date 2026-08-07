import { IsBoolean, IsIP, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';

const SOURCE_MODES = ['rtsp_pull', 'rtmp_push'] as const;
// Agenda não é aceita enquanto não houver persistência de janelas, fuso e
// executor de start/stop. Aceitar apenas o rótulo criava câmeras que pareciam
// configuradas, mas nunca eram iniciadas por nenhum processo.
const RECORDING_MODES = ['continuous', 'motion', 'manual'] as const;
const VIDEO_CODECS = ['original', 'h264', 'h265', 'hevc', 'mjpeg'] as const;
const STREAM_VIDEO_CODECS = ['original', 'h264', 'h265', 'hevc', 'mjpeg'] as const;
const RTSP_TRANSPORTS = ['tcp', 'udp'] as const;
const LIVE_PROTOCOLS = ['auto', 'flv', 'hls', 'llhls', 'webrtc', 'mjpeg'] as const;

export class CreateCameraDto {
  @IsString()
  name!: string;

  /**
   * Como o vídeo chega. Ausente = 'rtsp_pull', o modo de sempre — toda
   * integração existente continua enviando o mesmo corpo e obtendo o mesmo
   * comportamento.
   *
   * Em 'rtmp_push' a câmera é que disca para nós, então endereço, porta e
   * credencial deixam de existir do nosso lado: não há o que preencher, e exigir
   * um IP inventado só para vencer a validação seria cadastro sujo por desenho.
   */
  @IsOptional()
  @IsIn(SOURCE_MODES)
  sourceMode?: (typeof SOURCE_MODES)[number];

  @ValidateIf((o) => o.sourceMode !== 'rtmp_push')
  @IsString()
  @IsIP()
  ip!: string;

  @ValidateIf((o) => o.sourceMode !== 'rtmp_push')
  @IsInt()
  @Min(1)
  @Max(65535)
  rtspPort!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  onvifPort?: number;

  @ValidateIf((o) => o.sourceMode !== 'rtmp_push')
  @IsString()
  username!: string;

  @ValidateIf((o) => o.sourceMode !== 'rtmp_push')
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
