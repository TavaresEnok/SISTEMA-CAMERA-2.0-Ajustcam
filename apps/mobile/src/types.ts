export type Direction = 'Up' | 'Down' | 'Left' | 'Right' | 'ZoomIn' | 'ZoomOut';
// Abas do redesign. "Live" deixou de ser aba: é um overlay em tela cheia aberto a
// partir de uma câmera (ver App.tsx → liveCamera).
export type Tab = 'central' | 'mosaico' | 'reproducao' | 'revisao' | 'alarmes' | 'ajustes';

// Grupo de câmeras criado pelo usuário no app (organização pessoal), persistido
// localmente em AsyncStorage — mesma natureza das antigas "mosaic areas".
export type CameraGroup = {
  id: string;
  name: string;
  cameraIds: string[];
};

export type AlarmStatus = 'OPEN' | 'ACKED' | 'RESOLVED';

export type Alarm = {
  id: string;
  cameraId: string | null;
  cameraName: string | null;
  type: string;
  title: string | null;
  message: string | null;
  severity: string;
  priority: string;
  status: AlarmStatus | string;
  occurredAt: string;
  acknowledgedByUserName?: string | null;
  occurrenceCount?: number | null;
  isSnoozed?: boolean;
};
export type IconName = 'home' | 'grid' | 'user' | 'settings' | 'camera' | 'mic' | 'video' | 'chevronLeft' | 'plus' | 'bell' | 'move' | 'play' | 'download' | 'calendar';

export type MosaicArea = {
  id: string;
  name: string;
  cameraIds: string[];
};

export type User = {
  id: string;
  name: string;
  email: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
};

export type Camera = {
  id: string;
  name: string;
  ip: string;
  status: string;
  /** false = câmera desativada no sistema (não mostrar nem transmitir). */
  enabled?: boolean;
  group?: { id: string; name: string } | null;
  canView?: boolean;
  canControl?: boolean;
  canRecord?: boolean;
  ptzCapable?: boolean;
  preferredLiveProtocol?: string;
  detectedWidth?: number | null;
  detectedHeight?: number | null;
  detectedFps?: number | null;
};

export type Recording = {
  id: string;
  cameraId: string;
  source?: string;
  triggerMode?: string;
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  sizeBytes?: string | number | null;
  actualSizeBytes?: string | number | null;
  fileUsable?: boolean;
  fileExists?: boolean;
  thumbnailExists?: boolean;
  thumbnailUrl?: string | null;
};

export type ActivePlayback = {
  recording: Recording;
  url: string;
  /** Fonte pedida ao servidor: original (padrão) ou versão compatível. */
  fonte: 'direta' | 'compativel';
  /** Segundo em que o vídeo deve retomar (renovação de token, degrau de codec). */
  retomarEm?: number;
};

export type MobileCapabilities = {
  liveView: boolean;
  playback: boolean;
  exportEvidence: boolean;
  alarmAck: boolean;
};

export type StreamUrls = {
  streamToken?: string;
  streamTokenExpiresAt?: string | null;
  protocols?: {
    hlsUrl?: string | null;
    webrtcUrl?: string | null;
    whepUrl?: string | null;
    flvUrl?: string | null;
    posterUrl?: string | null;
  };
};

export type LiveDetection = {
  id: string;
  type: string;
  label: string;
  confidence: number | null;
  bbox: [number, number, number, number];
  frameWidth: number | null;
  frameHeight: number | null;
};

export type RelayDiscovery = {
  ok: boolean;
  relays?: Array<{ token: string }>;
  relayCount?: number;
  triggerable?: boolean;
  message?: string;
};

export type Session = {
  apiUrl: string;
  token: string;
  refreshToken?: string;
  refreshExpiresAt?: string;
  user: User;
};
