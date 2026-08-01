import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CameraStatus, CameraPermissionLevel } from '@prisma/client';
import { type AuthUser } from '../common/types/auth-user.type';
import { createHash, randomBytes } from 'crypto';
import * as http from 'http';
import { statfs } from 'node:fs/promises';
import { PrismaService } from '../common/prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PortCheckerService } from '../common/network/port-checker.service';
import {
  buildPublishTarget,
  generateIngestKey,
  hashIngestKey,
  ingestHashMatches,
  isPushSourced,
  isValidIngestKey,
  SOURCE_MODE_PULL,
  SOURCE_MODE_PUSH,
} from './helpers/rtmp-ingest.helper';
import {
  assertCameraTargetAllowed,
  CameraNetworkPolicyError,
} from '../common/network/safe-url.helper';
import { AlarmsService } from '../alarms/alarms.service';
import { CreateCameraDto } from './dto/create-camera.dto';
import { TestCameraConnectionDto } from './dto/test-camera-connection.dto';
import { UpdateCameraDto } from './dto/update-camera.dto';
import {
  buildRtspUrl,
  isHevcCodec,
  resolveAnalyticsRtspProfile,
  resolveDeliveryRtspProfile,
  resolveLiveRtspProfile,
  resolveRecordingRtspProfile,
  sanitizeRtspUrl,
} from './helpers/rtsp-url.helper';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { envNumber } from '../common/config/env-number.helper';
import {
  execFileWithSecretUrl,
  spawnWithSecretUrl,
} from '../common/process/secret-url-process.helper';
import { assessCameraCompatibility } from './helpers/camera-compatibility.helper';
import {
  SNAPSHOT_MAX_BYTES,
  buildSnapshotFailure,
  buildSnapshotFfmpegArgs,
  buildSnapshotSuccess,
  normalizeSnapshotTransport,
  type SnapshotResult,
  type SnapshotSource,
} from './helpers/camera-snapshot.helper';
import {
  buildCameraDiagnosticsReport,
  type CameraDiagnosticsReport,
  type DiagnosticsStreamFacts,
} from './helpers/camera-diagnostics-report.helper';
import {
  GRID_LIVE_MAX_HEIGHT,
  GRID_LIVE_MAX_WIDTH,
  GRID_LIVE_TARGET_FPS,
  resolveGridLiveProfile,
} from '../camera-stream/helpers/live-delivery-profile.helper';
 

export function sanitizeCamera<T extends { passwordEncrypted: string }>(camera: T): Omit<T, 'passwordEncrypted'> {
  const { passwordEncrypted, ...safeCamera } = camera;
  return safeCamera;
}

type ProbedStreamMetadata = {
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  bitrateKbps?: number | null;
};

type DetectedCameraProfile = {
  channel: number;
  subtype: number;
  role: 'main' | 'sub';
  rtspPort: number | null;
  rtspPath: string | null;
  metadata: ProbedStreamMetadata | null;
};

type CameraProbeStep = {
  key: string;
  label: string;
  status: 'ok' | 'warning' | 'error';
  durationMs: number;
  detail?: string | null;
};

type OnvifMediaProfile = {
  token: string;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  encoding?: string | null;
  rtspPath?: string | null;
  rtspUri?: string | null;
};

type CameraProfilePayload = {
  streamWidth?: number | null;
  streamHeight?: number | null;
  streamFps?: number | null;
  streamBitrateKbps?: number | null;
  recordingWidth?: number | null;
  recordingHeight?: number | null;
  recordingFps?: number | null;
  recordingBitrateKbps?: number | null;
};

@Injectable()
export class CamerasService {
  private readonly logger = new Logger(CamerasService.name);
  // ⚠️ Estes três números eram `Number(process.env.X ?? default)`. Com um valor
  // inválido no .env ("4,5s", "5000ms") o resultado é NaN — e NaN não explode:
  //   · `setTimeout(kill, NaN)` dispara em ~1ms e MATA toda sonda antes de a
  //     câmera responder;
  //   · `index += NaN` encerra o laço de caminhos na primeira volta, então
  //     NENHUM caminho RTSP chega a ser testado.
  // Nos dois casos o cadastro de câmera passa a falhar 100% das vezes sem um
  // único erro no log — o operador jura que a câmera está offline.
  private readonly rtspProbeTimeoutMs = envNumber('CAMERA_RTSP_PROBE_TIMEOUT_MS', 4500, {
    min: 500,
    max: 60_000,
    integer: true,
    onInvalid: (message) => this.logger.warn(message),
  });
  private readonly rtspProbeKillTimeoutMs = envNumber('CAMERA_RTSP_PROBE_KILL_TIMEOUT_MS', 5500, {
    min: 500,
    max: 60_000,
    integer: true,
    onInvalid: (message) => this.logger.warn(message),
  });
  private readonly snapshotTimeoutMs = envNumber('CAMERA_SNAPSHOT_TIMEOUT_MS', 9000, {
    min: 2000,
    max: 60_000,
    integer: true,
    onInvalid: (message) => this.logger.warn(message),
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly portChecker: PortCheckerService,
    private readonly alarmsService: AlarmsService,
  ) {}

  private assertTestTargetAllowed(ip: string, port?: number | null): string {
    try {
      return assertCameraTargetAllowed(ip, port, {
        NODE_ENV: process.env.NODE_ENV,
        CAMERA_ALLOWED_CIDRS: this.configService.get<string>('cameraAllowedCidrs'),
        CAMERA_DENIED_CIDRS: this.configService.get<string>('cameraDeniedCidrs'),
      });
    } catch (error) {
      if (error instanceof CameraNetworkPolicyError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async create(dto: CreateCameraDto, privacy?: { isPrivate: boolean; ownerUserId: string | null }) {
    // ── CÂMERA QUE PUBLICA NÃO TEM ENDEREÇO NOSSO ────────────────────────────
    //
    // No modo push é a câmera que disca. Não existe IP para alcançá-la, porta
    // para bater nem credencial para apresentar — e obrigar o instalador a
    // inventar esses valores só para vencer a validação encheria o cadastro de
    // dado falso que ninguém saberia interpretar depois.
    //
    // Guardamos marcadores inertes: o caminho de push nunca os lê (ver
    // configurePushSourcedPath), e a checagem de destino é pulada justamente
    // porque não há destino nenhum a proteger.
    const pushSourced = dto.sourceMode === SOURCE_MODE_PUSH;
    if (pushSourced) {
      return this.createPushSourcedCamera(dto, privacy);
    }

    const normalizedIp = this.assertTestTargetAllowed(dto.ip, dto.rtspPort);
    if (dto.onvifPort != null) this.assertTestTargetAllowed(normalizedIp, dto.onvifPort);
    await this.validateReferences(dto.siteId, dto.areaId, dto.groupId);
    const normalizedProfile = this.normalizeProfileToDetected(dto, null);
    const defaultChannel = dto.channel ?? 1;
    const defaultSubtype = dto.subtype ?? 0;
    const liveSubtype = dto.liveSubtype ?? 0;
    const recordingSubtype = dto.recordingSubtype ?? 0;
    const analyticsSubtype = dto.analyticsSubtype ?? 1;
    const camera = await this.prisma.camera.create({
      data: {
        name: dto.name,
        ip: normalizedIp,
        rtspPort: dto.rtspPort,
        onvifPort: dto.onvifPort,
        username: dto.username,
        passwordEncrypted: this.cryptoService.encrypt(dto.password),
        rtspPath: dto.rtspPath,
        onvifPath: dto.onvifPath,
        onvifProfileToken: dto.onvifProfileToken,
        channel: defaultChannel,
        subtype: defaultSubtype,
        liveChannel: dto.liveChannel ?? defaultChannel,
        liveSubtype,
        recordingChannel: dto.recordingChannel ?? defaultChannel,
        recordingSubtype,
        analyticsChannel: dto.analyticsChannel ?? defaultChannel,
        analyticsSubtype,
        siteId: dto.siteId,
        areaId: dto.areaId,
        groupId: dto.groupId,
        recordingEnabled: dto.recordingEnabled ?? true,
        recordingMode: dto.recordingMode ?? ((dto.recordingEnabled ?? true) ? 'continuous' : 'manual'),
        retentionDays: dto.retentionDays ?? this.getDefaultRetentionDays(),
        preferredRtspTransport: dto.preferredRtspTransport ?? 'tcp',
        preferredLiveProtocol: this.normalizeLiveProtocol(dto.preferredLiveProtocol) === 'mjpeg'
          ? 'webrtc'
          : (this.normalizeLiveProtocol(dto.preferredLiveProtocol) ?? 'webrtc'),
        streamVideoCodec: 'h264',
        streamWidth: normalizedProfile.streamWidth,
        streamHeight: normalizedProfile.streamHeight,
        streamFps: normalizedProfile.streamFps,
        streamBitrateKbps: normalizedProfile.streamBitrateKbps,
        // Codec de origem: descoberto pelo health-check (probe REAL do stream).
        // Não cravar aqui — chutar 'h265' rotulava errado câmeras H.264 e
        // quebrava consumidores que confiavam no rótulo (ex.: clipe).
        recordingVideoCodec: null,
        recordingWidth: normalizedProfile.recordingWidth,
        recordingHeight: normalizedProfile.recordingHeight,
        recordingFps: normalizedProfile.recordingFps,
        recordingBitrateKbps: normalizedProfile.recordingBitrateKbps,
        audioEnabled: dto.audioEnabled ?? false,
        aiEnabled: dto.aiEnabled ?? true,
        alarmsEnabled: dto.alarmsEnabled ?? true,
        hasEdgeAi: dto.hasEdgeAi ?? false,
        motionTrigger: dto.motionTrigger ?? (dto.hasEdgeAi ? 'CAMERA' : 'SYSTEM'),
        // Privacidade (LGPD): câmera do cliente. Conteúdo só do dono.
        isPrivate: privacy?.isPrivate ?? false,
        ownerUserId: privacy?.ownerUserId ?? null,
        status: CameraStatus.ONLINE,
        lastSeenAt: new Date(),
      },
    });

    return sanitizeCamera(camera);
  }

  /**
   * Cadastro de câmera PRIVADA pelo próprio cliente ("+ Adicionar câmera" no app).
   * A câmera fica com `ownerUserId` = o cliente e é auto-vinculada ao grupo do
   * usuário responsável (o grupo onde ele é admin) — se existir. Também recebe
   * uma permissão DIRETA de ADMIN para o dono, garantindo o acesso ao conteúdo
   * mesmo que ele não pertença a nenhum grupo.
   */
  async createPrivateForOwner(dto: CreateCameraDto, owner: AuthUser) {
    // O grupo do cliente: aquele onde ele tem nível ADMIN. Se tiver mais de um,
    // usa o primeiro; se nenhum, a câmera fica sem grupo (acesso pela permissão
    // direta + ownerUserId). O admin do sistema pode reassociar depois.
    const ownerGroup = await this.prisma.cameraPermission.findFirst({
      where: { userId: owner.id, groupId: { not: null }, level: CameraPermissionLevel.ADMIN },
      select: { groupId: true },
      orderBy: { createdAt: 'asc' },
    });
    const groupId = ownerGroup?.groupId ?? dto.groupId ?? undefined;

    // COTA (o "acordado"): quantas câmeras privadas o cliente pode ter. A cota
    // vive no GRUPO do cliente; sem grupo (ou cota 0), não pode cadastrar. O
    // padrão 0 é seguro — só libera quando o admin define no grupo.
    const quota = await this.getPrivateCameraQuota(owner, groupId ?? null);
    if (quota.used >= quota.limit) {
      throw new BadRequestException(
        quota.limit === 0
          ? 'Seu plano não inclui câmeras privadas. Fale com o provedor para liberar.'
          : `Limite de câmeras privadas atingido (${quota.used}/${quota.limit}). Fale com o provedor para ampliar.`,
      );
    }

    const created = await this.create({ ...dto, groupId }, { isPrivate: true, ownerUserId: owner.id });

    // Permissão direta de ADMIN para o dono: o gate de conteúdo (canViewCamera)
    // reconhece o dono por ownerUserId, mas a permissão direta também o habilita
    // a controlar/gravar e sobrevive a uma eventual troca de dono.
    await this.prisma.cameraPermission.create({
      data: { userId: owner.id, cameraId: created.id, level: CameraPermissionLevel.ADMIN },
    }).catch(() => undefined);

    return created;
  }

  /**
   * Cota de câmeras privadas do cliente: quantas ele JÁ tem (`used`) e o teto
   * (`limit`) definido no grupo dele. O app usa isso para mostrar "1 de 1" e
   * desabilitar o "+" quando estourar. Sem grupo → limite 0 (padrão seguro).
   */
  async getPrivateCameraQuota(owner: AuthUser, groupIdHint?: string | null): Promise<{ used: number; limit: number }> {
    let groupId = groupIdHint ?? null;
    if (!groupId) {
      const ownerGroup = await this.prisma.cameraPermission.findFirst({
        where: { userId: owner.id, groupId: { not: null }, level: CameraPermissionLevel.ADMIN },
        select: { groupId: true },
        orderBy: { createdAt: 'asc' },
      });
      groupId = ownerGroup?.groupId ?? null;
    }
    const [used, group] = await Promise.all([
      this.prisma.camera.count({ where: { isPrivate: true, ownerUserId: owner.id } }),
      groupId
        ? this.prisma.cameraGroup.findUnique({ where: { id: groupId }, select: { maxPrivateCameras: true } })
        : Promise.resolve(null),
    ]);
    return { used, limit: Math.max(0, group?.maxPrivateCameras ?? 0) };
  }

  async findAll(accessibleIds?: string[]) {
    const cameras = await this.prisma.camera.findMany({
      where: accessibleIds ? { id: { in: accessibleIds } } : {},
      include: { site: true, area: true, group: true },
      orderBy: { createdAt: 'desc' },
    });
    return cameras.map(sanitizeCamera);
  }

  async findAllInternal() {
    return this.prisma.camera.findMany({
      include: { site: true, area: true, group: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Uma câmera, no MESMO formato de `findAllInternal` (mesmos includes), para o
   * worker consultar sem baixar o parque inteiro. Devolve `null` quando não
   * existe — quem chama decide o status HTTP.
   */
  async findOneInternal(id: string) {
    return this.prisma.camera.findUnique({
      where: { id },
      include: { site: true, area: true, group: true },
    });
  }

  async findOne(id: string) {
    const camera = await this.getCameraOrThrow(id);
    return sanitizeCamera(camera);
  }

  async update(id: string, dto: UpdateCameraDto) {
    const existing = await this.getCameraOrThrow(id);
    const normalizedIp = this.assertTestTargetAllowed(
      dto.ip ?? existing.ip,
      dto.rtspPort ?? existing.rtspPort,
    );
    const targetOnvifPort = dto.onvifPort ?? existing.onvifPort;
    if (targetOnvifPort != null) this.assertTestTargetAllowed(normalizedIp, targetOnvifPort);
    await this.validateReferences(dto.siteId, dto.areaId, dto.groupId);
    const normalizedProfile = this.normalizeProfileToDetected(dto, existing);
    const camera = await this.prisma.camera.update({
      where: { id },
      data: {
        name: dto.name,
        ip: dto.ip === undefined ? undefined : normalizedIp,
        rtspPort: dto.rtspPort,
        onvifPort: dto.onvifPort,
        username: dto.username,
        passwordEncrypted: dto.password ? this.cryptoService.encrypt(dto.password) : existing.passwordEncrypted,
        rtspPath: dto.rtspPath,
        onvifPath: dto.onvifPath,
        onvifProfileToken: dto.onvifProfileToken,
        channel: dto.channel,
        subtype: dto.subtype,
        liveChannel: dto.liveChannel,
        liveSubtype: dto.liveSubtype,
        recordingChannel: dto.recordingChannel,
        recordingSubtype: dto.recordingSubtype,
        analyticsChannel: dto.analyticsChannel,
        analyticsSubtype: dto.analyticsSubtype,
        siteId: dto.siteId,
        areaId: dto.areaId,
        groupId: dto.groupId,
        enabled: dto.enabled !== undefined ? dto.enabled : existing.enabled,
        recordingEnabled: dto.recordingEnabled !== undefined ? dto.recordingEnabled : existing.recordingEnabled,
        recordingMode: dto.recordingMode,
        retentionDays: dto.retentionDays,
        preferredRtspTransport: dto.preferredRtspTransport,
        preferredLiveProtocol: this.normalizeLiveProtocol(dto.preferredLiveProtocol) === 'mjpeg'
          ? 'webrtc'
          : this.normalizeLiveProtocol(dto.preferredLiveProtocol),
        streamVideoCodec: 'h264',
        streamWidth: normalizedProfile.streamWidth,
        streamHeight: normalizedProfile.streamHeight,
        streamFps: normalizedProfile.streamFps,
        streamBitrateKbps: normalizedProfile.streamBitrateKbps,
        // recordingVideoCodec NÃO é sobrescrito ao editar: o health-check o mantém
        // sincronizado com o codec REAL. Cravar constante aqui re-corrompia o rótulo.
        recordingWidth: normalizedProfile.recordingWidth,
        recordingHeight: normalizedProfile.recordingHeight,
        recordingFps: normalizedProfile.recordingFps,
        recordingBitrateKbps: normalizedProfile.recordingBitrateKbps,
        audioEnabled: dto.audioEnabled,
        aiEnabled: dto.aiEnabled,
        alarmsEnabled: dto.alarmsEnabled !== undefined ? dto.alarmsEnabled : existing.alarmsEnabled,
        hasEdgeAi: dto.hasEdgeAi !== undefined ? dto.hasEdgeAi : existing.hasEdgeAi,
        motionTrigger: dto.motionTrigger ?? existing.motionTrigger,
        // Zonas: `undefined` preserva o que existe; array vazio LIMPA (volta a
        // monitorar a câmera inteira) — por isso a checagem explícita.
        ...(dto.detectionZones !== undefined ? { detectionZones: dto.detectionZones as any } : {}),
      },
      include: { site: true, area: true, group: true },
    });

    // NOTA: o reinício da análise (para recarregar as máscaras de zona) é feito
    // pelo CONTROLLER, não aqui. Importar os serviços de IA neste arquivo cria o
    // ciclo real de módulos Cameras→Ai→Cameras e o Nest não instancia
    // (MediamtxProxyService fica sem CamerasService). Incidente 2026-07-21.
    return sanitizeCamera(camera);
  }

  async transferPrivateCameraOwner(id: string, ownerUserId: string) {
    const camera = await this.getCameraOrThrow(id);
    if (!camera.isPrivate) {
      throw new BadRequestException('Somente câmera privada possui proprietário transferível.');
    }
    const nextOwner = await this.prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { id: true, isActive: true },
    });
    if (!nextOwner?.isActive) {
      throw new BadRequestException('O novo proprietário deve ser um usuário ativo.');
    }
    if (camera.ownerUserId === nextOwner.id) return sanitizeCamera(camera);

    return this.prisma.$transaction(async (tx) => {
      if (camera.ownerUserId) {
        // Transferência revoga o acesso direto do antigo dono. Compartilhamentos
        // de terceiros permanecem, pois são concessões independentes.
        await tx.cameraPermission.deleteMany({
          where: { userId: camera.ownerUserId, cameraId: id },
        });
      }
      const existingGrant = await tx.cameraPermission.findFirst({
        where: { userId: nextOwner.id, cameraId: id, groupId: null },
        select: { id: true },
      });
      if (existingGrant) {
        await tx.cameraPermission.update({
          where: { id: existingGrant.id },
          data: { level: CameraPermissionLevel.ADMIN },
        });
      } else {
        await tx.cameraPermission.create({
          data: { userId: nextOwner.id, cameraId: id, level: CameraPermissionLevel.ADMIN },
        });
      }
      const updated = await tx.camera.update({
        where: { id },
        data: { ownerUserId: nextOwner.id },
        include: { site: true, area: true, group: true },
      });
      return sanitizeCamera(updated);
    });
  }

  async remove(id: string) {
    const camera = await this.getCameraOrThrow(id);
    return this.prisma.camera.delete({ where: { id } });
  }

  async updateStatus(id: string, status: CameraStatus, lastSeenAt?: string) {
    return this.prisma.camera.update({
      where: { id },
      data: {
        status,
        lastSeenAt: lastSeenAt ? new Date(lastSeenAt) : new Date(),
      },
    });
  }

  async registerEvent(id: string, type: string, severity: string, message: string, metadata?: any, occurredAt?: Date) {
    const event = await this.prisma.cameraEvent.create({
      data: {
        cameraId: id,
        type,
        severity,
        message,
        metadata: metadata ?? {},
        occurredAt: occurredAt ?? new Date(),
      },
    });
    await this.alarmsService.processEvent({
      eventId: event.id,
      cameraId: id,
      type,
      severity,
      message,
      metadata: metadata ?? {},
      occurredAt: event.occurredAt,
    });
    return event;
  }

  async listLatestDetections(cameraId: string, seconds = 8, limit = 12) {
    const since = new Date(Date.now() - Math.max(1, Math.min(30, seconds)) * 1000);
    const take = Math.max(1, Math.min(30, limit));
    const events = await this.prisma.cameraEvent.findMany({
      where: {
        cameraId,
        occurredAt: { gte: since },
        type: { in: ['FACE_DETECTED', 'FACE_RECOGNIZED', 'FACE_UNKNOWN', 'OBJECT_DETECTED'] },
      },
      orderBy: { occurredAt: 'desc' },
      take,
    });

    return events
      .map((event) => {
        const metadata = event.metadata && typeof event.metadata === 'object'
          ? (event.metadata as Record<string, any>)
          : {};
        const bbox = Array.isArray(metadata.bbox) ? metadata.bbox.map((v: unknown) => Number(v)) : null;
        if (!bbox || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) return null;
        return {
          id: event.id,
          cameraId: event.cameraId,
          type: event.type,
          label: typeof metadata.name === 'string'
            ? metadata.name
            : typeof metadata.label === 'string'
              ? metadata.label
              : event.type.replace(/_/g, ' ').toLowerCase(),
          confidence: Number.isFinite(Number(metadata.confidence)) ? Number(metadata.confidence) : null,
          similarity: Number.isFinite(Number(metadata.similarity)) ? Number(metadata.similarity) : null,
          bbox,
          frameWidth: Number.isFinite(Number(metadata.frameWidth)) ? Number(metadata.frameWidth) : null,
          frameHeight: Number.isFinite(Number(metadata.frameHeight)) ? Number(metadata.frameHeight) : null,
          occurredAt: event.occurredAt,
          overlayMode: typeof metadata.overlayMode === 'string' ? metadata.overlayMode : null,
          trackId: Number.isFinite(Number(metadata.trackId)) ? Number(metadata.trackId) : null,
        };
      })
      .filter(Boolean);
  }

  async testConnection(id: string) {
    const status = await this.getStatus(id);
    const refreshed = await this.getCameraOrThrow(id);
    return {
      camera: sanitizeCamera(refreshed),
      rtspReachable: status.rtspReachable,
      onvifReachable: status.onvifReachable,
      status: status.status,
    };
  }

  async getPipelineSummary(id: string) {
    const camera = await this.getCameraOrThrow(id);
    const password = this.cryptoService.decrypt(camera.passwordEncrypted);
    const liveProfile = resolveLiveRtspProfile(camera);
    const recordingProfile = resolveRecordingRtspProfile(camera);
    const analyticsProfile = resolveAnalyticsRtspProfile(camera);

    const makeUrl = (profile: { channel: number; subtype: number }) => {
      const url = buildRtspUrl({
        username: camera.username,
        password,
        ip: camera.ip,
        rtspPort: camera.rtspPort,
        rtspPath: camera.rtspPath,
        channel: profile.channel,
        subtype: profile.subtype,
      });
      return { raw: url, sanitized: sanitizeRtspUrl(url) };
    };

    const live = makeUrl(liveProfile);
    const recording = makeUrl(recordingProfile);
    const analytics = makeUrl(analyticsProfile);
    const liveCodec = this.normalizeVideoCodec(camera.detectedVideoCodec ?? camera.streamVideoCodec ?? camera.recordingVideoCodec);
    const recordingCodec = this.normalizeVideoCodec(camera.recordingVideoCodec ?? camera.detectedVideoCodec);
    const analyticsExpectedCodec = analyticsProfile.subtype === liveProfile.subtype ? liveCodec : null;
    const analyticsUsesSubstream = analyticsProfile.channel !== liveProfile.channel || analyticsProfile.subtype !== liveProfile.subtype;
    const liveNeedsBrowserTranscode = isHevcCodec(liveCodec) || Boolean(camera.audioEnabled);
    const gridLive = resolveGridLiveProfile({
      detectedWidth: camera.detectedWidth ?? null,
      detectedHeight: camera.detectedHeight ?? null,
      streamWidth: camera.streamWidth ?? null,
      streamHeight: camera.streamHeight ?? null,
    });

    return {
      cameraId: camera.id,
      cameraName: camera.name,
      updatedAt: new Date().toISOString(),
      transport: camera.preferredRtspTransport ?? 'tcp',
      preferredLiveProtocol: camera.preferredLiveProtocol ?? 'webrtc',
      architecture: {
        separated: analyticsUsesSubstream && recordingProfile.subtype === 0 && liveProfile.subtype === 0,
        rule: 'recording_main_live_main_analytics_substream',
      },
      live: {
        role: 'Cliente ao vivo',
        source: 'camera_main_stream',
        channel: liveProfile.channel,
        subtype: liveProfile.subtype,
        rtspUrl: live.sanitized,
        codec: liveCodec ?? null,
        width: gridLive.width,
        height: gridLive.height,
        fps: gridLive.fps,
        selectedWidth: camera.detectedWidth ?? null,
        selectedHeight: camera.detectedHeight ?? null,
        selectedFps: camera.detectedFps ?? null,
        browserProtocol: camera.preferredLiveProtocol ?? 'webrtc',
        browserCodec: liveNeedsBrowserTranscode ? 'h264' : liveCodec ?? 'h264',
        transcodeForBrowser: liveNeedsBrowserTranscode,
        audioEnabled: Boolean(camera.audioEnabled),
      },
      recording: {
        role: 'Arquivo',
        source: 'camera_main_stream',
        channel: recordingProfile.channel,
        subtype: recordingProfile.subtype,
        rtspUrl: recording.sanitized,
        codecPolicy: 'copy_if_hevc_else_transcode_to_h265',
        targetCodec: 'h265',
        sourceCodec: recordingCodec ?? null,
        width: camera.recordingWidth ?? camera.detectedWidth ?? null,
        height: camera.recordingHeight ?? camera.detectedHeight ?? null,
        fps: camera.recordingFps ?? camera.detectedFps ?? null,
        mode: camera.recordingMode,
        enabled: camera.recordingEnabled,
      },
      analytics: {
        role: 'IA / analytics',
        source: 'direct_camera',
        channel: analyticsProfile.channel,
        subtype: analyticsProfile.subtype,
        rtspUrl: analytics.sanitized,
        usesMediaMtx: false,
        audioRequested: false,
        expectedCodec: analyticsExpectedCodec,
        separatedFromLive: analyticsUsesSubstream,
      },
      notes: [
        analyticsUsesSubstream
          ? 'IA está configurada para ler substream direto da câmera.'
          : 'IA está usando o mesmo perfil da live; recomenda-se analyticsSubtype=1 quando houver substream.',
        liveNeedsBrowserTranscode
          ? 'Live pode usar transcode para H.264/WebRTC por codec HEVC ou áudio.'
          : 'Live pode ser entregue sem transcode de vídeo quando o stream for compatível.',
        `Grid limitado a no máximo ${GRID_LIVE_MAX_WIDTH}x${GRID_LIVE_MAX_HEIGHT} em ${GRID_LIVE_TARGET_FPS} FPS; câmera individual usa a resolução original do perfil live.`,
      ],
    };
  }

  async testConnectionDraft(input: TestCameraConnectionDto) {
    this.assertTestTargetAllowed(input.ip, input.rtspPort);
    if (input.onvifPort != null) this.assertTestTargetAllowed(input.ip, input.onvifPort);
    const steps: CameraProbeStep[] = [];
    const runStep = async <T>(key: string, label: string, action: () => Promise<T>, detail?: (value: T) => string | null | undefined): Promise<T> => {
      const startedAt = Date.now();
      try {
        const value = await action();
        steps.push({
          key,
          label,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          detail: detail?.(value) ?? null,
        });
        return value;
      } catch (error) {
        steps.push({
          key,
          label,
          status: 'error',
          durationMs: Date.now() - startedAt,
          detail: error instanceof Error ? error.message : 'falha',
        });
        throw error;
      }
    };
    const rtspPortCandidates = Array.from(
      new Set([input.rtspPort, 554, 8554, 10554, 5544, 51488, 51489, 51490].filter((v): v is number => Number.isFinite(v as number))),
    );
    const reachableRtspPorts = await runStep(
      'rtsp_ports',
      'Verificar portas RTSP',
      async () => {
        const found: number[] = [];
        for (const port of rtspPortCandidates) {
          if (await this.portChecker.check(input.ip, port)) {
            found.push(port);
          }
        }
        return found;
      },
      (ports) => ports.length ? `Portas abertas: ${ports.join(', ')}` : 'Nenhuma porta RTSP comum respondeu',
    );
    if (!reachableRtspPorts.length) {
      steps[steps.length - 1].status = 'warning';
    }
    const rtspReachable = reachableRtspPorts.includes(input.rtspPort);
    const rtspReachableAny = reachableRtspPorts.length > 0;
    const onvifPorts = Array.from(new Set([input.onvifPort, 8075, 8080, 8000, 8899, 80, 2020].filter((v): v is number => Number.isFinite(v as number))));
    const reachablePorts = await runStep(
      'onvif_ports',
      'Verificar portas ONVIF',
      async () => {
        const found: number[] = [];
        for (const port of onvifPorts) {
          if (await this.portChecker.check(input.ip, port)) {
            found.push(port);
          }
        }
        return found;
      },
      (ports) => ports.length ? `Portas abertas: ${ports.join(', ')}` : 'Nenhuma porta ONVIF comum respondeu',
    );
    if (!reachablePorts.length) {
      steps[steps.length - 1].status = 'warning';
    }
    const onvifReachable = input.onvifPort == null ? reachablePorts.length > 0 : reachablePorts.includes(input.onvifPort);

    let onvifMedia: {
      port: number | null;
      path: string | null;
      profiles: OnvifMediaProfile[];
      errors: string[];
    } = { port: null, path: null, profiles: [], errors: [] };
    if (input.username && input.password && reachablePorts.length > 0) {
      onvifMedia = await runStep(
        'onvif_media',
        'Ler perfis ONVIF de mídia',
        () => this.discoverOnvifMediaProfiles({
          host: input.ip,
          ports: reachablePorts,
          preferredPath: input.onvifPath,
          username: input.username!,
          password: input.password!,
        }),
        (media) => media.profiles.length
          ? `${media.profiles.length} perfil(is) ONVIF encontrado(s)`
          : 'ONVIF respondeu, mas não entregou perfis de mídia',
      );
      if (!onvifMedia.profiles.length) {
        steps[steps.length - 1].status = 'warning';
      }
    }

    const channel = input.channel ?? 1;
    const mainSubtype = 0;
    const analyticsSubtype = 1;
    const rtspPathCandidates = this.buildRtspPathCandidates({
      channel,
      subtype: input.subtype ?? mainSubtype,
      customPath: input.rtspPath,
    });

    let rtspAuthOk = false;
    let selectedRtspPortAuthOk = false;
    let detectedRtspPort: number | null = null;
    let detectedRtspPath: string | null = null;
    let detectedStream: ProbedStreamMetadata | null = null;
    let rtspProbeError: string | null = null;
    let mainProfile: DetectedCameraProfile | null = null;
    let subProfile: DetectedCameraProfile | null = null;
    if (rtspReachableAny && input.username && input.password) {
      let probe: Awaited<ReturnType<typeof this.probeRtspPaths>> | null = null;
      if (rtspReachable) {
        const selectedProbe = await runStep(
          'rtsp_selected_probe',
          'Testar vídeo na porta informada',
          () => this.probeRtspPaths({
            ip: input.ip,
            rtspPorts: [input.rtspPort],
            username: input.username!,
            password: input.password!,
            paths: rtspPathCandidates,
          }),
          (result) => result.ok ? `Vídeo OK em ${result.path}` : result.error,
        );
        if (!selectedProbe.ok) {
          steps[steps.length - 1].status = 'warning';
        }
        selectedRtspPortAuthOk = selectedProbe.ok;
        if (selectedProbe.ok) {
          probe = selectedProbe;
        }
      }
      probe ??= await runStep(
        'rtsp_fallback_probe',
        'Testar caminhos RTSP conhecidos',
        () => this.probeRtspPaths({
          ip: input.ip,
          rtspPorts: reachableRtspPorts,
          username: input.username!,
          password: input.password!,
          paths: rtspPathCandidates,
        }),
        (result) => result.ok ? `Vídeo OK em ${result.port}${result.path}` : result.error,
      );
      if (!probe.ok) {
        steps[steps.length - 1].status = 'warning';
      }
      rtspAuthOk = probe.ok;
      detectedRtspPort = probe.port;
      detectedRtspPath = probe.path;
      detectedStream = probe.metadata;
      rtspProbeError = probe.error;

      const portsForProfileProbe = detectedRtspPort ? [detectedRtspPort] : reachableRtspPorts;
      const onvifMain = this.pickOnvifMainProfile(onvifMedia.profiles);
      const onvifSub = this.pickOnvifSubProfile(onvifMedia.profiles, onvifMain?.token);
      const [mainProbe, subProbe] = await runStep(
        'rtsp_profile_probe',
        'Separar stream principal e substream',
        () => Promise.all([
          this.probeRtspPaths({
            ip: input.ip,
            rtspPorts: portsForProfileProbe,
            username: input.username!,
            password: input.password!,
            paths: this.buildRtspPathCandidates({ channel, subtype: mainSubtype, customPath: onvifMain?.rtspPath ?? detectedRtspPath ?? input.rtspPath }),
          }),
          this.probeRtspPaths({
            ip: input.ip,
            rtspPorts: portsForProfileProbe,
            username: input.username!,
            password: input.password!,
            paths: this.buildRtspPathCandidates({ channel, subtype: analyticsSubtype, customPath: onvifSub?.rtspPath ?? input.rtspPath }),
          }),
        ]),
        ([mainResult, subResult]) => {
          const parts = [
            mainResult.ok ? `principal ${mainResult.metadata?.width ?? '?'}x${mainResult.metadata?.height ?? '?'}` : 'principal não confirmado',
            subResult.ok ? `substream ${subResult.metadata?.width ?? '?'}x${subResult.metadata?.height ?? '?'}` : 'substream não confirmado',
          ];
          return parts.join(' · ');
        },
      );
      if (!mainProbe.ok || !subProbe.ok) {
        steps[steps.length - 1].status = mainProbe.ok ? 'warning' : 'error';
      }
      mainProfile = {
        channel,
        subtype: mainSubtype,
        role: 'main',
        rtspPort: mainProbe.port,
        rtspPath: mainProbe.path,
        metadata: mainProbe.metadata,
      };
      subProfile = {
        channel,
        subtype: analyticsSubtype,
        role: 'sub',
        rtspPort: subProbe.port,
        rtspPath: subProbe.path,
        metadata: subProbe.metadata,
      };
    }

    let status: CameraStatus = CameraStatus.OFFLINE;
    if (rtspReachable && onvifReachable && (input.username ? selectedRtspPortAuthOk : true)) {
      status = CameraStatus.ONLINE;
    }

    const suggestedRtspPath = mainProfile?.rtspPath ?? detectedRtspPath ?? `/cam/realmonitor?channel=${channel}&subtype=${mainSubtype}`;
    const candidatePaths = Array.from(new Set([input.onvifPath?.trim(), '/onvif/ptz_service', '/onvif/device_service'].filter((v): v is string => Boolean(v))));
    const candidateTokens = Array.from(new Set([input.onvifProfileToken?.trim(), 'Profile000', 'Profile001', 'profile_1'].filter((v): v is string => Boolean(v))));

    let detectedOnvifPort: number | null = null;
    let detectedOnvifPath: string | null = null;
    let detectedOnvifProfileToken: string | null = null;
    let ptzDigestOk = false;

    if (input.username && input.password && reachablePorts.length > 0) {
      for (const port of reachablePorts) {
        for (const path of candidatePaths) {
          for (const token of candidateTokens) {
            const ok = await this.tryOnvifDigestStop({
              host: input.ip,
              port,
              path,
              username: input.username,
              password: input.password,
              profileToken: token,
            });
            if (ok) {
              ptzDigestOk = true;
              detectedOnvifPort = port;
              detectedOnvifPath = path;
              detectedOnvifProfileToken = token;
              break;
            }
          }
          if (ptzDigestOk) break;
        }
        if (ptzDigestOk) break;
      }
    }

    const compatibility = assessCameraCompatibility({
      selectedPath: mainProfile?.rtspPath ?? detectedRtspPath,
      onvifProfileNames: onvifMedia.profiles.flatMap((profile) => [profile.name, profile.rtspPath]),
      mainMetadata: mainProfile?.metadata ?? detectedStream,
      subMetadata: subProfile?.metadata,
      rtspAuthenticated: rtspAuthOk,
      onvifProfilesFound: onvifMedia.profiles.length,
    });

    return {
      ip: input.ip,
      rtspPort: input.rtspPort,
      onvifPort: input.onvifPort ?? null,
      rtspReachable,
      rtspReachableAny,
      reachableRtspPorts,
      onvifReachable,
      ptzDigestOk,
      reachableOnvifPorts: reachablePorts,
      suggestedRtspPath,
      rtspAuthOk,
      selectedRtspPortAuthOk,
      detectedRtspPort,
      detectedRtspPath,
      detectedStream,
      rtspProbeError,
      detectedOnvifPort,
      detectedOnvifPath,
      detectedOnvifProfileToken,
      onvifMediaProfiles: onvifMedia.profiles.map((profile) => ({
        token: profile.token,
        name: profile.name ?? null,
        width: profile.width ?? null,
        height: profile.height ?? null,
        encoding: profile.encoding ?? null,
        rtspPath: profile.rtspPath ?? null,
      })),
      autoProfiles: {
        live: {
          channel,
          subtype: mainSubtype,
          source: 'main',
          rtspPath: mainProfile?.rtspPath ?? suggestedRtspPath,
          metadata: mainProfile?.metadata ?? detectedStream,
          onvifProfileToken: this.pickOnvifMainProfile(onvifMedia.profiles)?.token ?? null,
        },
        recording: {
          channel,
          subtype: mainSubtype,
          source: 'main',
          rtspPath: mainProfile?.rtspPath ?? suggestedRtspPath,
          metadata: mainProfile?.metadata ?? detectedStream,
          codecPolicy: 'copy_source_prefer_h265',
          onvifProfileToken: this.pickOnvifMainProfile(onvifMedia.profiles)?.token ?? null,
        },
        analytics: {
          channel,
          subtype: analyticsSubtype,
          source: subProfile?.rtspPath ? 'sub' : 'sub_preferred',
          rtspPath: subProfile?.rtspPath ?? null,
          metadata: subProfile?.metadata ?? null,
          onvifProfileToken: this.pickOnvifSubProfile(onvifMedia.profiles, this.pickOnvifMainProfile(onvifMedia.profiles)?.token)?.token ?? null,
        },
      },
      compatibility,
      probeSteps: steps,
      hasEdgeAi: ptzDigestOk || onvifReachable,
      status,
      checkedAt: new Date().toISOString(),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CONFIRMAÇÃO VISUAL — um frame da câmera ANTES de salvar.
  //
  // Metadado não distingue "câmera 7 do estacionamento" de "câmera 3 da
  // recepção": com IP trocado no cadastro, o erro só aparece quando o cliente
  // pede a gravação de um evento — e aí alguém VOLTA AO LOCAL. Um frame resolve.
  //
  // Nunca lança por culpa da câmera: devolve `{ ok: false, reason }`. A tela de
  // cadastro não pode quebrar porque a câmera está muda.
  // ───────────────────────────────────────────────────────────────────────────
  async capturePreviewFrame(
    input: {
      ip: string;
      rtspPort: number;
      username: string;
      password: string;
      rtspPath?: string | null;
      channel?: number | null;
      subtype?: number | null;
      preferredRtspTransport?: string | null;
    },
    options?: { targetAlreadyProvisioned?: boolean },
  ): Promise<SnapshotResult> {
    // Revalida também câmeras persistidas: regras de rede podem ser endurecidas
    // depois do cadastro, e registros legados não podem contornar a política.
    this.assertTestTargetAllowed(input.ip, input.rtspPort);
    const transport = normalizeSnapshotTransport(input.preferredRtspTransport);
    const capturedAt = new Date().toISOString();
    const requestedSource: SnapshotSource = {
      rtspPort: input.rtspPort,
      rtspPath: input.rtspPath?.trim() || null,
      transport,
    };

    if (!input.username || !input.password) {
      return buildSnapshotFailure({
        error: 'Informe usuário e senha da câmera para confirmar a imagem.',
        source: requestedSource,
        capturedAt,
      });
    }

    // Primeiro descobrimos QUAL caminho responde (a mesma sonda do cadastro, que
    // já devolve o erro sanitizado), depois puxamos o frame só desse caminho.
    let probe: Awaited<ReturnType<typeof this.probeRtspPaths>>;
    try {
      probe = await this.probeRtspPaths({
        ip: input.ip,
        rtspPorts: [input.rtspPort],
        username: input.username,
        password: input.password,
        paths: this.buildRtspPathCandidates({
          channel: input.channel,
          subtype: input.subtype,
          customPath: input.rtspPath,
        }),
      });
    } catch (error) {
      return buildSnapshotFailure({ error, source: requestedSource, capturedAt });
    }

    if (!probe.ok || !probe.path) {
      return buildSnapshotFailure({
        error: probe.error ?? 'A câmera não entregou vídeo no endereço informado.',
        source: requestedSource,
        capturedAt,
      });
    }

    const source: SnapshotSource = {
      rtspPort: probe.port ?? input.rtspPort,
      rtspPath: probe.path,
      transport,
    };
    const url = buildRtspUrl({
      username: input.username,
      password: input.password,
      ip: input.ip,
      rtspPort: probe.port ?? input.rtspPort,
      rtspPath: probe.path,
      channel: input.channel ?? undefined,
      subtype: input.subtype ?? undefined,
    });

    try {
      const { stdout } = await execFileWithSecretUrl(
        'ffmpeg',
        buildSnapshotFfmpegArgs({
          rtspUrl: url,
          transport,
          timeoutUs: this.rtspProbeTimeoutMs * 1000,
        }),
        url,
        { encoding: 'buffer', maxBuffer: SNAPSHOT_MAX_BYTES, timeout: this.snapshotTimeoutMs },
      );
      return buildSnapshotSuccess({
        buffer: stdout as Buffer,
        source,
        stream: {
          codec: probe.metadata?.codec ?? null,
          width: probe.metadata?.width ?? null,
          height: probe.metadata?.height ?? null,
          fps: probe.metadata?.fps ?? null,
        },
        capturedAt,
      });
    } catch (error) {
      // `error.message` do execFile carrega o stderr CRU do FFmpeg, que imprime a
      // URL de entrada inteira ("Error opening input file rtsp://user:senha@...").
      // Sanitizar só a `url` NÃO basta — a credencial vaza pela message, e esta
      // message vai tanto para o log quanto para a resposta HTTP.
      this.logger.debug(
        `Falha na confirmação visual ip=${input.ip} path=${sanitizeRtspUrl(String(probe.path))}: ${sanitizeSensitiveText(error)}`,
      );
      return buildSnapshotFailure({ error, source, capturedAt });
    }
  }

  /**
   * Mesma confirmação visual, agora na EDIÇÃO de uma câmera já salva. O campo de
   * senha da tela de edição vem em branco quando o técnico não quer trocá-la —
   * nesse caso usamos a senha guardada. Assim ele consegue conferir a imagem
   * depois de mudar só o IP, ANTES de salvar por cima.
   */
  async capturePreviewFrameForCamera(
    id: string,
    overrides?: {
      ip?: string | null;
      rtspPort?: number | null;
      username?: string | null;
      password?: string | null;
      rtspPath?: string | null;
      channel?: number | null;
      subtype?: number | null;
    },
  ): Promise<SnapshotResult> {
    const camera = await this.getCameraOrThrow(id);
    const liveProfile = resolveLiveRtspProfile(camera);
    const overridePassword = overrides?.password?.trim();
    const targetIp = overrides?.ip?.trim() || camera.ip;
    return this.capturePreviewFrame(
      {
        ip: targetIp,
        rtspPort: Number(overrides?.rtspPort ?? camera.rtspPort),
        username: overrides?.username?.trim() || camera.username,
        password: overridePassword || this.cryptoService.decrypt(camera.passwordEncrypted),
        rtspPath: overrides?.rtspPath?.trim() || camera.rtspPath,
        channel: overrides?.channel ?? liveProfile.channel,
        subtype: overrides?.subtype ?? liveProfile.subtype,
        preferredRtspTransport: camera.preferredRtspTransport,
      },
      // Só o endereço JÁ PROVISIONADO dispensa a guarda. Assim que o técnico
      // digita um IP diferente, o alvo volta a ser entrada do usuário e a
      // proteção contra SSRF vale de novo.
      { targetAlreadyProvisioned: targetIp === camera.ip },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DIAGNÓSTICO RICO DA CÂMERA JÁ SALVA — sob demanda.
  //
  // Depois de salva, a câmera virava três booleanos. Aqui a sonda do cadastro é
  // reexecutada contra a câmera EM PRODUÇÃO e o resultado é comparado com o que
  // está gravado: a divergência é o diagnóstico (codec trocado pelo firmware,
  // substream que sumiu, resolução que despencou).
  // ───────────────────────────────────────────────────────────────────────────
  async getLiveDiagnostics(id: string): Promise<CameraDiagnosticsReport & { cameraId: string; cameraName: string }> {
    const camera = await this.getCameraOrThrow(id);
    const checkedAt = new Date().toISOString();
    const liveProfile = resolveLiveRtspProfile(camera);
    const analyticsProfile = resolveAnalyticsRtspProfile(camera);
    const rawRecordingMode = String(this.configService.get<string>('recordingCodecMode') ?? 'copy').toLowerCase();
    const recordingCodecMode = rawRecordingMode === 'h265' || rawRecordingMode === 'h264' ? rawRecordingMode : 'copy';

    const configured = {
      videoCodec: camera.detectedVideoCodec ?? camera.streamVideoCodec ?? null,
      width: camera.detectedWidth ?? null,
      height: camera.detectedHeight ?? null,
      fps: camera.detectedFps ?? null,
      rtspPort: camera.rtspPort,
      rtspPath: camera.rtspPath,
      audioEnabled: Boolean(camera.audioEnabled),
      liveSubtype: liveProfile.subtype,
      analyticsSubtype: analyticsProfile.subtype,
      recordingCodecMode: recordingCodecMode as 'copy' | 'h265' | 'h264',
    };

    let detected: {
      reachable: boolean;
      main: DiagnosticsStreamFacts | null;
      sub: DiagnosticsStreamFacts | null;
      error: string | null;
    } = { reachable: false, main: null, sub: null, error: null };

    try {
      const secret = this.cryptoService.decrypt(camera.passwordEncrypted);
      const probeProfile = async (profile: { channel: number; subtype: number }, customPath: string | null) => {
        const result = await this.probeRtspPaths({
          ip: camera.ip,
          rtspPorts: [camera.rtspPort],
          username: camera.username,
          password: secret,
          paths: this.buildRtspPathCandidates({
            channel: profile.channel,
            subtype: profile.subtype,
            customPath,
          }),
        });
        return result;
      };

      const [mainProbe, subProbe] = await Promise.all([
        probeProfile(liveProfile, camera.rtspPath),
        probeProfile(analyticsProfile, null),
      ]);

      detected = {
        reachable: mainProbe.ok,
        main: mainProbe.ok
          ? { ...(mainProbe.metadata ?? {}), rtspPort: mainProbe.port, rtspPath: mainProbe.path }
          : null,
        sub: subProbe.ok
          ? { ...(subProbe.metadata ?? {}), rtspPort: subProbe.port, rtspPath: subProbe.path }
          : null,
        // O erro já sai sanitizado da sonda; o relatório sanitiza de novo porque
        // o stderr do ffprobe é a origem clássica de vazamento de credencial.
        error: mainProbe.ok ? null : mainProbe.error,
      };
    } catch (error) {
      this.logger.warn(`Diagnóstico ao vivo falhou camera=${id}: ${sanitizeSensitiveText(error)}`);
      detected = { reachable: false, main: null, sub: null, error: sanitizeSensitiveText(error) };
    }

    return {
      cameraId: camera.id,
      cameraName: camera.name,
      ...buildCameraDiagnosticsReport({ checkedAt, configured, detected }),
    };
  }

  private buildRtspPathCandidates(input: { channel?: number | null; subtype?: number | null; customPath?: string | null }) {
    const channel = input.channel ?? 1;
    const subtype = input.subtype ?? 0;
    const hikvisionProfile = `${channel}${(subtype + 1).toString().padStart(2, '0')}`;
    const isMain = subtype === 0;
    return Array.from(new Set([
      input.customPath?.trim().length ? input.customPath.trim() : null,
      `/cam/realmonitor?channel=${channel}&subtype=${subtype}`,
      `/cam/realmonitor?channel=${channel}&subtype=${subtype}&unicast=true`,
      `/cam/realmonitor?channel=${channel}&subtype=${subtype}&unicast=true&proto=Onvif`,
      `/Streaming/Channels/${hikvisionProfile}`,
      `/Streaming/Channels/${hikvisionProfile}?transportmode=unicast`,
      `/h264/ch${channel}/${isMain ? 'main' : 'sub'}/av_stream`,
      `/h265/ch${channel}/${isMain ? 'main' : 'sub'}/av_stream`,
      isMain ? `/h264Preview_${channel}01_main` : `/h264Preview_${channel}01_sub`,
      isMain ? `/h265Preview_${channel}01_main` : `/h265Preview_${channel}01_sub`,
      isMain ? `/Preview_${channel}01_main` : `/Preview_${channel}01_sub`,
      '/axis-media/media.amp',
      isMain ? `/media/video${channel}` : `/media/video${channel + 1}`,
      isMain ? '/live/ch00_0' : '/live/ch00_1',
      isMain ? '/stream1' : '/stream2',
      isMain ? '/profile1/media.smp' : '/profile2/media.smp',
    ].filter((v): v is string => Boolean(v))));
  }

  private buildGetProfilesSoapBody() {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
  <soap:Body>
    <trt:GetProfiles />
  </soap:Body>
</soap:Envelope>`;
  }

  private buildGetStreamUriSoapBody(profileToken: string) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
  <soap:Body>
    <trt:GetStreamUri>
      <trt:StreamSetup>
        <tt:Stream>RTP-Unicast</tt:Stream>
        <tt:Transport>
          <tt:Protocol>RTSP</tt:Protocol>
        </tt:Transport>
      </trt:StreamSetup>
      <trt:ProfileToken>${profileToken}</trt:ProfileToken>
    </trt:GetStreamUri>
  </soap:Body>
</soap:Envelope>`;
  }

  private parseSoapSuccess(statusCode: number | undefined, responseBody: string) {
    const body = responseBody.trim();
    const lower = body.toLowerCase();
    if ((statusCode ?? 500) >= 400 || lower.includes('<fault') || lower.includes(':fault>') || lower.includes('<soap:fault')) {
      return { ok: false, body, message: `ONVIF SOAP HTTP ${statusCode ?? 500}` };
    }
    return { ok: true, body, message: 'ok' };
  }

  private digestSoapRequest(input: {
    host: string;
    port: number;
    path: string;
    body: string;
    username: string;
    password: string;
    timeout?: number;
  }): Promise<{ ok: boolean; message: string; responseBody?: string }> {
    const timeout = input.timeout ?? 3000;
    const baseHeaders = {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(input.body),
      Connection: 'close',
    };

    return new Promise((resolve) => {
      const collect = (res: http.IncomingMessage, done: (value: { ok: boolean; message: string; responseBody?: string }) => void) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const parsed = this.parseSoapSuccess(res.statusCode, text);
          done({ ok: parsed.ok, message: parsed.message, responseBody: parsed.body });
        });
      };

      const requestOptions: http.RequestOptions = {
        host: input.host,
        port: input.port,
        path: input.path,
        method: 'POST',
        timeout,
        headers: baseHeaders,
      };

      const req1 = http.request(requestOptions, (res1) => {
        if (res1.statusCode === 401) {
          const authHeader = res1.headers['www-authenticate'];
          if (!authHeader || !String(authHeader).toLowerCase().startsWith('digest')) {
            resolve({ ok: false, message: 'ONVIF auth não é Digest' });
            return;
          }
          const auth = this.buildDigestAuthorization('POST', input.path, String(authHeader), input.username, input.password);
          const req2 = http.request(
            { ...requestOptions, headers: { ...baseHeaders, Authorization: auth } },
            (res2) => collect(res2, resolve),
          );
          req2.on('error', (error) => resolve({ ok: false, message: error.message }));
          req2.on('timeout', () => {
            req2.destroy();
            resolve({ ok: false, message: 'ONVIF timeout' });
          });
          req2.write(input.body);
          req2.end();
          return;
        }
        collect(res1, resolve);
      });
      req1.on('error', (error) => resolve({ ok: false, message: error.message }));
      req1.on('timeout', () => {
        req1.destroy();
        resolve({ ok: false, message: 'ONVIF timeout' });
      });
      req1.write(input.body);
      req1.end();
    });
  }

  private extractOnvifMediaProfiles(responseBody?: string): OnvifMediaProfile[] {
    if (!responseBody) return [];
    const profiles: OnvifMediaProfile[] = [];
    const profileRegex = /<(?:\w+:)?Profiles\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Profiles>/g;
    let match: RegExpExecArray | null;
    while ((match = profileRegex.exec(responseBody)) !== null) {
      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      const token = attrs.match(/\b(?:token|Token)="([^"]+)"/)?.[1];
      if (!token) continue;
      const width = this.parseOptionalInt(body.match(/<(?:\w+:)?Width>([^<]+)<\/(?:\w+:)?Width>/)?.[1] ?? null);
      const height = this.parseOptionalInt(body.match(/<(?:\w+:)?Height>([^<]+)<\/(?:\w+:)?Height>/)?.[1] ?? null);
      profiles.push({
        token,
        name: body.match(/<(?:\w+:)?Name>([^<]+)<\/(?:\w+:)?Name>/)?.[1] ?? null,
        encoding: body.match(/<(?:\w+:)?Encoding>([^<]+)<\/(?:\w+:)?Encoding>/)?.[1] ?? null,
        width,
        height,
      });
    }
    return profiles.filter((profile, index, list) => list.findIndex((item) => item.token === profile.token) === index);
  }

  private extractRtspUriFromSoap(responseBody?: string) {
    if (!responseBody) return null;
    const raw = responseBody.match(/<(?:\w+:)?Uri>([^<]+)<\/(?:\w+:)?Uri>/)?.[1];
    return raw ? raw.replace(/&amp;/g, '&').trim() : null;
  }

  private pathFromRtspUri(uri?: string | null) {
    if (!uri) return null;
    try {
      const parsed = new URL(uri);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      const match = uri.match(/^rtsp:\/\/[^/]+(\/.*)$/i);
      return match?.[1] ?? null;
    }
  }

  /**
   * Resolve a câmera dona de uma chave de ingestão RTMP.
   *
   * Chamado no handshake de PUBLICAÇÃO, ou seja, por quem ainda não provou nada
   * — então cada passo desconfia da entrada:
   *  · formato validado antes de tocar o banco (chave torta não vira consulta);
   *  · busca pelo HASH, em índice único, para não varrer o cadastro nem guardar
   *    o segredo em claro;
   *  · exige modo push E câmera habilitada: desativar a câmera ou tirá-la do
   *    modo push corta a publicação na hora, sem precisar rotacionar a chave.
   *
   * Devolve null em qualquer desvio — quem chama traduz isso em 401 sem revelar
   * qual das condições falhou.
   */
  async findCameraByIngestKey(key: unknown) {
    if (!isValidIngestKey(key)) return null;
    const camera = await this.prisma.camera.findUnique({
      where: { rtmpIngestKeyHash: hashIngestKey(key) },
      select: { id: true, name: true, enabled: true, sourceMode: true, rtmpIngestKeyHash: true },
    });
    if (!camera || camera.enabled === false || !isPushSourced(camera)) return null;
    // Redundante depois do findUnique, mas mantém a comparação em tempo constante
    // como invariante do caminho de autenticação, mesmo se a busca mudar um dia.
    if (!ingestHashMatches(camera.rtmpIngestKeyHash, hashIngestKey(key))) return null;
    return camera;
  }

  /**
   * Cria uma câmera que PUBLICA em nós, já com a chave pronta.
   *
   * Sai da mesma chamada o cadastro e o alvo de publicação, porque separar em
   * dois passos obrigaria o instalador a salvar, reabrir e só então descobrir o
   * que colar no equipamento — com a câmera na mão, no alto de um poste.
   */
  private async createPushSourcedCamera(
    dto: CreateCameraDto,
    privacy?: { isPrivate: boolean; ownerUserId: string | null },
  ) {
    await this.validateReferences(dto.siteId, dto.areaId, dto.groupId);
    const key = generateIngestKey();
    const camera = await this.prisma.camera.create({
      data: {
        name: dto.name,
        // Marcadores inertes: no modo push nada disto é discado. Ver o comentário
        // em create() sobre por que não pedimos ao usuário.
        ip: '0.0.0.0',
        rtspPort: 554,
        username: '',
        passwordEncrypted: this.cryptoService.encrypt(''),
        sourceMode: SOURCE_MODE_PUSH,
        rtmpIngestKeyHash: hashIngestKey(key),
        rtmpIngestKeyEncrypted: this.cryptoService.encrypt(key),
        siteId: dto.siteId,
        areaId: dto.areaId,
        groupId: dto.groupId,
        recordingEnabled: dto.recordingEnabled ?? true,
        recordingMode: dto.recordingMode ?? ((dto.recordingEnabled ?? true) ? 'continuous' : 'manual'),
        retentionDays: dto.retentionDays ?? this.getDefaultRetentionDays(),
        // RTMP clássico entrega H.264 — não há sonda a fazer nem codec a adivinhar.
        streamVideoCodec: 'h264',
        detectedVideoCodec: 'h264',
        audioEnabled: dto.audioEnabled ?? false,
        aiEnabled: dto.aiEnabled ?? true,
        alarmsEnabled: dto.alarmsEnabled ?? true,
        ...(privacy?.isPrivate ? { isPrivate: true, ownerUserId: privacy.ownerUserId } : {}),
      },
    });
    this.logger.log(`Câmera ${camera.name} criada em modo de publicação (RTMP).`);
    return { ...camera, rtmpIngest: this.buildIngestDescriptor(key) };
  }

  /**
   * Gera (ou troca) a chave de ingestão e devolve o que o instalador digita na
   * câmera. Colocar a câmera em modo push é parte da mesma operação: chave sem
   * modo não serviria para nada, e modo sem chave deixaria a câmera num estado
   * incompleto que o path de live recusa.
   *
   * Rotacionar derruba a publicação em andamento — é exatamente para isso que
   * serve, quando a chave vaza ou o equipamento é trocado.
   */
  async rotateRtmpIngestKey(cameraId: string) {
    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { id: true, name: true } });
    if (!camera) throw new NotFoundException(`Camera ${cameraId} não encontrada.`);

    const key = generateIngestKey();
    await this.prisma.camera.update({
      where: { id: cameraId },
      data: {
        sourceMode: SOURCE_MODE_PUSH,
        rtmpIngestKeyHash: hashIngestKey(key),
        rtmpIngestKeyEncrypted: this.cryptoService.encrypt(key),
      },
    });
    this.logger.log(`Chave de ingestão RTMP gerada para ${camera.name}.`);
    return this.buildIngestDescriptor(key);
  }

  /**
   * Relê a chave já existente para exibi-la ao administrador. Devolve null quando
   * a câmera não está em modo push ou ainda não tem chave — o chamador traduz
   * isso na interface, sem inventar credencial.
   */
  async getRtmpIngestTarget(cameraId: string) {
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      select: { sourceMode: true, rtmpIngestKeyEncrypted: true },
    });
    if (!camera || !isPushSourced(camera) || !camera.rtmpIngestKeyEncrypted) return null;
    let key: string;
    try { key = this.cryptoService.decrypt(camera.rtmpIngestKeyEncrypted); }
    catch { return null; }
    if (!isValidIngestKey(key)) return null;
    return this.buildIngestDescriptor(key);
  }

  /**
   * Devolve a câmera ao modo tradicional e APAGA a chave. Sem apagar, a chave
   * antiga continuaria autorizando publicação numa câmera que ninguém espera que
   * esteja publicando.
   */
  async disableRtmpIngest(cameraId: string) {
    await this.prisma.camera.update({
      where: { id: cameraId },
      data: { sourceMode: SOURCE_MODE_PULL, rtmpIngestKeyHash: null, rtmpIngestKeyEncrypted: null },
    });
  }

  private buildIngestDescriptor(key: string) {
    const host =
      (this.configService.get<string>('mediaMtxPublicHost') ?? '').trim() || 'SEU-SERVIDOR';
    const port = envNumber('MEDIAMTX_RTMP_PORT', 1935, { min: 1, max: 65535, integer: true });
    const scheme =
      String(process.env.MEDIAMTX_RTMP_SCHEME ?? 'rtmp').trim().toLowerCase() === 'rtmps'
        ? 'rtmps'
        : 'rtmp';
    return { ...buildPublishTarget({ host, port, key, scheme }), sourceMode: SOURCE_MODE_PUSH };
  }

  private async discoverOnvifMediaProfiles(input: {
    host: string;
    ports: number[];
    preferredPath?: string | null;
    username: string;
    password: string;
  }) {
    const paths = Array.from(new Set([
      input.preferredPath?.trim(),
      '/onvif/media_service',
      '/onvif/device_service',
      '/onvif/ptz_service',
    ].filter((value): value is string => Boolean(value))));
    const errors: string[] = [];

    for (const port of input.ports) {
      for (const path of paths) {
        const profilesResult = await this.digestSoapRequest({
          host: input.host,
          port,
          path,
          body: this.buildGetProfilesSoapBody(),
          username: input.username,
          password: input.password,
          timeout: 3000,
        });
        if (!profilesResult.ok) {
          errors.push(`${port}${path}: ${profilesResult.message}`);
          continue;
        }
        const profiles = this.extractOnvifMediaProfiles(profilesResult.responseBody);
        if (!profiles.length) {
          errors.push(`${port}${path}: sem perfis`);
          continue;
        }

        const withUris: OnvifMediaProfile[] = [];
        for (const profile of profiles.slice(0, 6)) {
          const uriResult = await this.digestSoapRequest({
            host: input.host,
            port,
            path,
            body: this.buildGetStreamUriSoapBody(profile.token),
            username: input.username,
            password: input.password,
            timeout: 3000,
          });
          const rtspUri = uriResult.ok ? this.extractRtspUriFromSoap(uriResult.responseBody) : null;
          withUris.push({
            ...profile,
            rtspUri,
            rtspPath: this.pathFromRtspUri(rtspUri),
          });
        }

        return { port, path, profiles: withUris, errors };
      }
    }

    return { port: null, path: null, profiles: [], errors };
  }

  private pickOnvifMainProfile(profiles: OnvifMediaProfile[]) {
    return [...profiles].sort((a, b) => {
      const areaA = Number(a.width ?? 0) * Number(a.height ?? 0);
      const areaB = Number(b.width ?? 0) * Number(b.height ?? 0);
      return areaB - areaA;
    })[0] ?? null;
  }

  private pickOnvifSubProfile(profiles: OnvifMediaProfile[], mainToken?: string | null) {
    const candidates = profiles.filter((profile) => profile.token !== mainToken);
    if (!candidates.length) return null;
    return candidates.sort((a, b) => {
      const areaA = Number(a.width ?? 0) * Number(a.height ?? 0);
      const areaB = Number(b.width ?? 0) * Number(b.height ?? 0);
      return areaA - areaB;
    })[0] ?? null;
  }

  private parseDigestHeader(header: string) {
    const result: Record<string, string> = {};
    const quotedRegex = /(\w+)="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = quotedRegex.exec(header)) !== null) {
      result[match[1]] = match[2];
    }
    return result;
  }

  private buildDigestAuthorization(
    method: string,
    uri: string,
    authHeader: string,
    username: string,
    password: string,
  ) {
    const params = this.parseDigestHeader(authHeader);
    const realm = params.realm ?? '';
    const nonce = params.nonce ?? '';
    const qop = params.qop ?? 'auth';
    const opaque = params.opaque ?? '';
    const cnonce = randomBytes(8).toString('hex');
    const ncStr = '00000001';
    const ha1 = createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
    const ha2 = createHash('md5').update(`${method}:${uri}`).digest('hex');
    const response = createHash('md5')
      .update(`${ha1}:${nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`)
      .digest('hex');
    let auth = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${ncStr}, cnonce="${cnonce}", response="${response}"`;
    if (opaque) auth += `, opaque="${opaque}"`;
    return auth;
  }

  private buildOnvifStopBody(profileToken: string) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
  <soap:Body>
    <tptz:Stop>
      <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
      <tptz:PanTilt>true</tptz:PanTilt>
      <tptz:Zoom>true</tptz:Zoom>
    </tptz:Stop>
  </soap:Body>
</soap:Envelope>`;
  }

  private async tryOnvifDigestStop(input: {
    host: string;
    port: number;
    path: string;
    username: string;
    password: string;
    profileToken: string;
  }) {
    const body = this.buildOnvifStopBody(input.profileToken);
    const baseHeaders = {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
    };

    return await new Promise<boolean>((resolve) => {
      const req1 = http.request(
        {
          host: input.host,
          port: input.port,
          path: input.path,
          method: 'POST',
          timeout: 3500,
          headers: baseHeaders,
        },
        (res1) => {
          const authHeader = res1.headers['www-authenticate'];
          if (res1.statusCode !== 401 || !authHeader || !String(authHeader).toLowerCase().startsWith('digest')) {
            resolve((res1.statusCode ?? 500) < 400);
            return;
          }

          const digestAuth = this.buildDigestAuthorization(
            'POST',
            input.path,
            String(authHeader),
            input.username,
            input.password,
          );
          const req2 = http.request(
            {
              host: input.host,
              port: input.port,
              path: input.path,
              method: 'POST',
              timeout: 3500,
              headers: { ...baseHeaders, Authorization: digestAuth },
            },
            (res2) => resolve((res2.statusCode ?? 500) < 400),
          );
          req2.on('error', () => resolve(false));
          req2.on('timeout', () => {
            req2.destroy();
            resolve(false);
          });
          req2.write(body);
          req2.end();
        },
      );

      req1.on('error', () => resolve(false));
      req1.on('timeout', () => {
        req1.destroy();
        resolve(false);
      });
      req1.write(body);
      req1.end();
    });
  }

  private async probeRtspPaths(input: {
    ip: string;
    rtspPorts: number[];
    username: string;
    password: string;
    paths: string[];
  }) {
    let lastError: string | null = null;
    const successful: Array<{
      port: number;
      path: string;
      url: string;
      metadata: ProbedStreamMetadata;
      score: number;
    }> = [];
    const concurrency = envNumber('CAMERA_RTSP_PROBE_CONCURRENCY', 4, {
      min: 1,
      max: 6,
      integer: true,
      onInvalid: (message) => this.logger.warn(message),
    });
    const probePath = async (port: number, path: string) => {
      const url = `rtsp://${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}@${input.ip}:${port}${path}`;
      const result = await new Promise<{ ok: boolean; error: string | null; metadata: ProbedStreamMetadata | null }>((resolve) => {
        const proc = spawnWithSecretUrl(
          'ffprobe',
          [
            '-v',
            'error',
            '-rtsp_transport',
            'tcp',
            '-timeout',
            String(this.rtspProbeTimeoutMs * 1000),
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=codec_name,width,height,avg_frame_rate,bit_rate:format=bit_rate',
            '-of',
            'json',
            url,
          ],
          url,
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let settled = false;
        const finish = (value: { ok: boolean; error: string | null; metadata: ProbedStreamMetadata | null }) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          resolve(value);
        };
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL');
          finish({ ok: false, error: 'ffprobe timeout', metadata: null });
        }, this.rtspProbeKillTimeoutMs);
        let stdout = '';
        let stderr = '';
        proc.stdout!.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr!.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        proc.on('error', (error) => finish({ ok: false, error: sanitizeSensitiveText(error), metadata: null }));
        proc.on('close', (code) => {
          if (code === 0) {
            finish({ ok: true, error: null, metadata: this.parseProbedStreamMetadata(stdout) });
            return;
          }
          // O stderr do ffprobe imprime a URL de entrada INTEIRA (rtsp://user:senha@...).
          // Sanitizar antes de propagar: este `error` vai para logs e diagnósticos.
          const clean = sanitizeSensitiveText(stderr.trim());
          finish({ ok: false, error: clean.length ? clean.slice(0, 300) : `ffprobe exit ${code ?? -1}`, metadata: null });
        });
      });
      return { port, path, url, result };
    };

    for (const port of input.rtspPorts) {
      for (let index = 0; index < input.paths.length; index += concurrency) {
        const batch = input.paths.slice(index, index + concurrency);
        const results = await Promise.all(batch.map((path) => probePath(port, path)));
        for (const item of results) {
          if (item.result.ok) {
            const metadata = item.result.metadata ?? {};
            successful.push({
              port: item.port,
              path: item.path,
              url: item.url,
              metadata,
              score: this.scoreProbedStream(metadata),
            });
          } else {
            lastError = item.result.error;
          }
        }
        if (successful.length) break;
      }
      if (successful.length) break;
    }
    const best = successful.sort((a, b) => b.score - a.score)[0] ?? null;
    if (best) {
      const metadata = best.metadata;
      if (!metadata.bitrateKbps || metadata.bitrateKbps <= 0) {
        const estimatedBitrate = await this.estimateBitrateWithFfmpeg(best.url);
        if (estimatedBitrate && estimatedBitrate > 0) {
          metadata.bitrateKbps = estimatedBitrate;
        }
      }
      return { ok: true, port: best.port, path: best.path, error: null, metadata };
    }
    return { ok: false, port: null as number | null, path: null as string | null, error: lastError, metadata: null };
  }

  private scoreProbedStream(metadata: ProbedStreamMetadata | null) {
    const width = Number(metadata?.width ?? 0);
    const height = Number(metadata?.height ?? 0);
    const fps = Number(metadata?.fps ?? 0);
    const area = Number.isFinite(width) && Number.isFinite(height) ? width * height : 0;
    const fpsScore = Number.isFinite(fps) ? Math.min(Math.max(fps, 0), 60) : 0;
    return area * 100 + fpsScore;
  }

  async getStatus(id: string) {
    const startedAt = Date.now();
    try {
      const camera = await this.getCameraOrThrow(id);
      const previousStatus = camera.status;
      const rtspReachable = await this.portChecker.check(camera.ip, camera.rtspPort);
      const onvifReachable =
        camera.onvifPort == null ? true : await this.portChecker.check(camera.ip, camera.onvifPort);
      let rtspAuthOk = false;
      let detectedRtspPath: string | null = null;
      let detectedStream: ProbedStreamMetadata | null = null;

      if (rtspReachable) {
        try {
          const password = this.cryptoService.decrypt(camera.passwordEncrypted);
          const liveProfile = resolveDeliveryRtspProfile(camera);
          // DESCOBERTA é do cadastro; aqui é só CONFERÊNCIA DE SAÚDE.
          //
          // `buildRtspPathCandidates` devolve 16 caminhos e `probeRtspPaths` os
          // testa TODOS (não para no primeiro sucesso — precisa pontuar para
          // escolher o melhor). Isso é o certo ao cadastrar uma câmera
          // desconhecida, e é destrutivo aqui: o health check roda a cada 60s e
          // DVR tem limite de sessões RTSP concorrentes. Com 19 câmeras atrás de
          // um único DVR, a sonda consumia todas as sessões e o próprio
          // equipamento passava a responder "SETUP failed: 503
          // ServerUnavailable" — derrubando a análise de movimento (e portanto a
          // gravação) enquanto o painel dizia apenas "verificando saúde".
          //
          // Quando o caminho já é conhecido ele é a ÚNICA resposta certa: 1
          // sessão em vez de 16. A varredura completa fica para quem ainda não
          // tem caminho gravado.
          const knownPath = camera.rtspPath?.trim();
          const rtspPathCandidates = knownPath
            ? [knownPath]
            : this.buildRtspPathCandidates({
                channel: liveProfile.channel,
                subtype: liveProfile.subtype,
                customPath: camera.rtspPath,
              });
          const probe = await this.probeRtspPaths({
            ip: camera.ip,
            rtspPorts: [camera.rtspPort],
            username: camera.username,
            password,
            paths: rtspPathCandidates,
          });
          rtspAuthOk = probe.ok;
          detectedRtspPath = probe.path;
          detectedStream = probe.metadata;
        } catch (error) {
          this.logger.warn(`Falha ao validar auth RTSP da câmera ${camera.id}: ${(error as Error).message}`);
        }
      }

      let status: CameraStatus = CameraStatus.OFFLINE;
      if (rtspReachable && onvifReachable && rtspAuthOk) {
        status = CameraStatus.ONLINE;
      }

      // O probe acima leu o perfil de LIVE. Se a gravação usa o MESMO stream
      // (mesmo canal/subtipo), o codec é idêntico — então sincronizamos também o
      // recordingVideoCodec com o real detectado. Isso AUTO-CURA o rótulo (antes
      // cravado 'h265' no create/update, errado p/ câmeras H.264). Se os perfis
      // diferem (ex.: live no sub, gravação no main), não chutamos: preserva.
      const recProfile = resolveRecordingRtspProfile(camera);
      const liveProfileForCodec = resolveDeliveryRtspProfile(camera);
      const recordingCodecSynced =
        detectedStream?.codec &&
        recProfile.channel === liveProfileForCodec.channel &&
        recProfile.subtype === liveProfileForCodec.subtype
          ? detectedStream.codec
          : camera.recordingVideoCodec;

      await this.prisma.camera.update({
        where: { id },
        data: {
          // NUNCA sobrescreve um rtspPath já preenchido: o probe testa vários
          // caminhos candidatos e, em WAN, o caminho bom pode falhar por timeout
          // enquanto um caminho "genérico" (ex.: /cam/realmonitor em câmera
          // Hikvision) responde com um stream DEGRADADO (640x360). Persistir o
          // vencedor da rodada fazia o caminho flip-flopar e derrubava a
          // resolução da gravação. Só preenche quando estava vazio.
          rtspPath: camera.rtspPath?.trim() ? camera.rtspPath : detectedRtspPath ?? camera.rtspPath,
          detectedVideoCodec: detectedStream?.codec ?? camera.detectedVideoCodec,
          recordingVideoCodec: recordingCodecSynced,
          detectedWidth: detectedStream?.width ?? camera.detectedWidth,
          detectedHeight: detectedStream?.height ?? camera.detectedHeight,
          detectedFps: detectedStream?.fps ?? camera.detectedFps,
          detectedBitrateKbps: detectedStream?.bitrateKbps ?? camera.detectedBitrateKbps,
          status,
          lastSeenAt: status === CameraStatus.ONLINE ? new Date() : undefined,
        },
      });

      if (previousStatus !== CameraStatus.ONLINE && status === CameraStatus.ONLINE) {
        await this.registerEvent(
          id,
          'HEALTH_CAMERA_RECOVERED',
          'INFO',
          'Câmera voltou a ficar online após período degradado.',
          {
            previousStatus,
            rtspReachable,
            rtspAuthOk,
            onvifReachable,
          },
        );
      }

      const refreshed = await this.getCameraOrThrow(id);
      return {
        cameraId: refreshed.id,
        rtspReachable,
        rtspAuthOk,
        onvifReachable,
        detectedVideoCodec: refreshed.detectedVideoCodec ?? null,
        detectedFps: refreshed.detectedFps ?? null,
        configuredFps: refreshed.streamFps ?? null,
        recordingEnabled: refreshed.recordingEnabled,
        preferredLiveProtocol: refreshed.preferredLiveProtocol ?? 'webrtc',
        status,
        lastSeenAt: refreshed.lastSeenAt,
        liveProbeLatencyMs: Math.max(0, Date.now() - startedAt),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      await this.prisma.camera.update({
        where: { id },
        data: {
          status: CameraStatus.ERROR,
        },
      });
      throw error;
    }
  }

  private parseProbedStreamMetadata(stdout: string): ProbedStreamMetadata | null {
    const parsed = this.parseProbeJson(stdout);
    if (!parsed) return null;

    const codec = parsed.codec;
    const width = parsed.width;
    const height = parsed.height;
    const bitrate = parsed.bitrate;
    const fps = parsed.fps;

    if (!codec && !width && !height && !bitrate && !fps) {
      return null;
    }

    return {
      codec,
      width,
      height,
      fps,
      bitrateKbps: bitrate ? Math.max(1, Math.round(bitrate / 1000)) : null,
    };
  }

  private parseProbeJson(stdout: string) {
    try {
      const payload = JSON.parse(stdout) as {
        streams?: Array<{
          codec_name?: string | null;
          width?: number | string | null;
          height?: number | string | null;
          avg_frame_rate?: string | null;
          bit_rate?: number | string | null;
        }>;
        format?: {
          bit_rate?: number | string | null;
        } | null;
      };

      const stream = payload.streams?.[0];
      const codec = this.normalizeVideoCodec(stream?.codec_name);
      const width = this.parseOptionalInt(stream?.width == null ? null : String(stream.width));
      const height = this.parseOptionalInt(stream?.height == null ? null : String(stream.height));
      const fps = this.parseFrameRate(stream?.avg_frame_rate ?? null);
      const streamBitrate = this.parseOptionalInt(stream?.bit_rate == null ? null : String(stream.bit_rate));
      const formatBitrate = this.parseOptionalInt(payload.format?.bit_rate == null ? null : String(payload.format.bit_rate));
      const bitrate = streamBitrate ?? formatBitrate;

      if (!codec && !width && !height && !bitrate && !fps) {
        return null;
      }

      return { codec, width, height, fps, bitrate };
    } catch {
      return null;
    }
  }

  private async estimateBitrateWithFfmpeg(url: string): Promise<number | null> {
    return await new Promise<number | null>((resolve) => {
      const startedAt = Date.now();
      const proc = spawnWithSecretUrl(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'info',
          '-rtsp_transport',
          'tcp',
          '-i',
          url,
          '-map',
          '0:v:0',
          '-c:v',
          'copy',
          '-an',
          '-t',
          '5',
          '-f',
          'matroska',
          'pipe:1',
        ],
        url,
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let settled = false;
      let bytes = 0;
      let stderr = '';
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve(value);
      };

      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        finish(this.calculateBitrateFromBytes(bytes, startedAt) ?? this.extractBitrateFromFfmpegLog(stderr));
      }, 9000);

      proc.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });

      proc.stderr!.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', () => finish(null));
      proc.on('close', () => finish(this.calculateBitrateFromBytes(bytes, startedAt) ?? this.extractBitrateFromFfmpegLog(stderr)));
    });
  }

  private calculateBitrateFromBytes(bytes: number, startedAt: number): number | null {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
    const kbps = Math.round((bytes * 8) / elapsedSeconds / 1000);
    return Number.isFinite(kbps) && kbps > 0 ? kbps : null;
  }

  private extractBitrateFromFfmpegLog(stderr: string): number | null {
    const matches = [...stderr.matchAll(/bitrate=\s*([0-9.]+)\s*kbits\/s/gi)];
    if (!matches.length) return null;
    const last = matches[matches.length - 1]?.[1];
    if (!last) return null;
    const value = Number(last);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.max(1, Math.round(value));
  }

  private parseFrameRate(value?: string | null) {
    if (!value) return null;
    if (value.includes('/')) {
      const [numRaw, denRaw] = value.split('/');
      const numerator = Number(numRaw);
      const denominator = Number(denRaw);
      if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
        return null;
      }
      return Math.max(1, Math.round(numerator / denominator));
    }
    return this.parseOptionalInt(value);
  }

  private parseOptionalInt(value?: string | null) {
    if (value == null || value === '') return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private normalizeVideoCodec(codec?: string | null, opts?: { allowOriginal?: boolean }) {
    const value = codec?.trim().toLowerCase();
    if (!value) return undefined;
    if (opts?.allowOriginal && ['original', 'source', 'passthrough', 'pass-through'].includes(value)) return 'original';
    if (['hevc', 'h.265', 'h265'].includes(value)) return 'h265';
    if (['avc1', 'h.264', 'h264'].includes(value)) return 'h264';
    if (['mjpeg', 'mjpg', 'jpeg'].includes(value)) return 'mjpeg';
    return value;
  }

  private normalizeLiveProtocol(protocol?: string | null) {
    const value = protocol?.trim().toLowerCase();
    if (!value) return undefined;
    if (['auto', 'default', 'padrao', 'padrão', 'smart'].includes(value)) return 'webrtc';
    if (['mjpg', 'jpeg'].includes(value)) return 'mjpeg';
    if (value === 'flv') return 'webrtc';
    if (['ll-hls', 'low-latency-hls'].includes(value)) return 'llhls';
    if (['webrtc', 'hls', 'llhls', 'mjpeg'].includes(value)) return value;
    return value;
  }

  private getDefaultRetentionDays() {
    return this.configService.get<number>('retentionDays') ?? 7;
  }

  private normalizeProfileToDetected(
    profile: CameraProfilePayload,
    existing: {
      detectedWidth?: number | null;
      detectedHeight?: number | null;
      detectedFps?: number | null;
      detectedBitrateKbps?: number | null;
      streamWidth?: number | null;
      streamHeight?: number | null;
      streamFps?: number | null;
      streamBitrateKbps?: number | null;
      recordingWidth?: number | null;
      recordingHeight?: number | null;
      recordingFps?: number | null;
      recordingBitrateKbps?: number | null;
    } | null,
  ): CameraProfilePayload {
    const maxWidth = existing?.detectedWidth ?? null;
    const maxHeight = existing?.detectedHeight ?? null;
    const maxBitrate = existing?.detectedBitrateKbps ?? null;

    const clamp = (value: number | null | undefined, max: number | null) => {
      if (value == null) return value;
      if (!max || max <= 0) return value;
      return Math.min(value, max);
    };

    const gridLive = resolveGridLiveProfile({
      detectedWidth: existing?.detectedWidth ?? null,
      detectedHeight: existing?.detectedHeight ?? null,
      streamWidth: profile.streamWidth ?? existing?.streamWidth ?? null,
      streamHeight: profile.streamHeight ?? existing?.streamHeight ?? null,
    });

    return {
      streamWidth: clamp(gridLive.width, maxWidth),
      streamHeight: clamp(gridLive.height, maxHeight),
      streamFps: gridLive.fps,
      streamBitrateKbps: clamp(profile.streamBitrateKbps ?? existing?.streamBitrateKbps, maxBitrate),
      recordingWidth: profile.recordingWidth ?? existing?.recordingWidth,
      recordingHeight: profile.recordingHeight ?? existing?.recordingHeight,
      recordingFps: existing?.detectedFps ?? profile.recordingFps ?? existing?.recordingFps ?? null,
      recordingBitrateKbps: profile.recordingBitrateKbps ?? existing?.recordingBitrateKbps,
    };
  }

  async getCameraOrThrow(id: string) {
    const camera = await this.prisma.camera.findUnique({ where: { id }, include: { site: true, area: true, group: true } });
    if (!camera) {
      throw new NotFoundException(`Camera ${id} não encontrada.`);
    }
    return camera;
  }

  async listEvents(cameraIds: string[], limit = 50) {
    return this.prisma.cameraEvent.findMany({
      where: { cameraId: { in: cameraIds } },
      include: { camera: { select: { name: true } } },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
  }

  async listEventsFeed(params: {
    accessibleCameraIds: string[];
    cameraId?: string;
    type?: string;
    severity?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.max(1, Math.min(500, params.limit ?? 100));
    const offset = Math.max(0, params.offset ?? 0);
    const from = params.from ? new Date(params.from) : undefined;
    const to = params.to ? new Date(params.to) : undefined;
    const cameraIds = params.cameraId ? [params.cameraId] : params.accessibleCameraIds;
    const where = {
      cameraId: { in: cameraIds },
      ...(params.type ? { type: params.type } : {}),
      ...(params.severity ? { severity: params.severity } : {}),
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.cameraEvent.findMany({
        where,
        include: { camera: { select: { name: true } } },
        orderBy: { occurredAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.cameraEvent.count({ where }),
    ]);

    return {
      items: items.map((event) => ({
        id: event.id,
        cameraId: event.cameraId,
        cameraName: event.camera?.name ?? null,
        type: event.type,
        severity: event.severity,
        message: event.message,
        metadata: event.metadata,
        occurredAt: event.occurredAt,
        createdAt: event.createdAt,
      })),
      total,
      limit,
      offset,
    };
  }

  async getOverview(accessibleIds?: string[]) {
    const where = accessibleIds ? { id: { in: accessibleIds } } : {};
    const cameras = await this.prisma.camera.findMany({
      where,
      select: {
        id: true,
        name: true,
        status: true,
        lastSeenAt: true,
        recordingEnabled: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const thresholdMinutes = this.configService.get<number>('healthCheckOfflineMinutes') ?? 5;
    const staleThreshold = Date.now() - thresholdMinutes * 60 * 1000;
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cameraIds = cameras.map((camera) => camera.id);

    const [events24h, recordings24h] = await Promise.all([
      this.prisma.cameraEvent.count({
        where: {
          ...(cameraIds.length ? { cameraId: { in: cameraIds } } : {}),
          occurredAt: { gte: last24h },
        },
      }),
      this.prisma.recording.count({
        where: {
          ...(cameraIds.length ? { cameraId: { in: cameraIds } } : {}),
          startedAt: { gte: last24h },
        },
      }),
    ]);

    const summary = cameras.reduce(
      (acc, camera) => {
        acc.total += 1;
        if (camera.recordingEnabled) acc.recordingEnabled += 1;
        if (camera.status === CameraStatus.ONLINE) acc.online += 1;
        if (camera.status === CameraStatus.OFFLINE) acc.offline += 1;
        if (camera.status === CameraStatus.ERROR) acc.error += 1;
        if (camera.status === CameraStatus.UNKNOWN) acc.unknown += 1;
        return acc;
      },
      { total: 0, online: 0, offline: 0, error: 0, unknown: 0, recordingEnabled: 0 },
    );

    const stale = cameras
      .map((camera) => ({
        id: camera.id,
        name: camera.name,
        status: camera.status,
        lastSeenAt: camera.lastSeenAt?.toISOString() ?? null,
        stale:
          !camera.lastSeenAt ||
          (camera.status === CameraStatus.ONLINE && camera.lastSeenAt.getTime() < staleThreshold),
      }))
      .filter((camera) => camera.stale)
      .sort((a, b) => {
        const aTs = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
        const bTs = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
        return aTs - bTs;
      });

    return {
      summary,
      activity24h: {
        events: events24h,
        recordings: recordings24h,
      },
      stale: {
        thresholdMinutes,
        count: stale.length,
        items: stale.slice(0, 10),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async listIncidents(params: {
    accessibleCameraIds: string[];
    cameraId?: string;
    from?: string;
    to?: string;
    acknowledged?: boolean;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(200, params.limit ?? 50));
    const from = params.from ? new Date(params.from) : undefined;
    const to = params.to ? new Date(params.to) : undefined;
    const cameraIds = params.cameraId ? [params.cameraId] : params.accessibleCameraIds;

    const items = await this.prisma.cameraEvent.findMany({
      where: {
        cameraId: { in: cameraIds },
        type: { startsWith: 'STREAM_' },
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      include: { camera: { select: { name: true } } },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(limit * 4, 500),
    });

    const mapped = items.map((event) => {
      const metadata = (event.metadata ?? {}) as Record<string, any>;
      const ack = (metadata.ack ?? {}) as Record<string, any>;
      const acknowledged = Boolean(ack.acknowledged);
      return {
        id: event.id,
        cameraId: event.cameraId,
        cameraName: event.camera?.name ?? null,
        type: event.type,
        severity: event.severity,
        message: event.message,
        occurredAt: event.occurredAt,
        metadata: metadata,
        acknowledged,
        acknowledgedAt: ack.at ?? null,
        acknowledgedByUserId: ack.byUserId ?? null,
        note: ack.note ?? null,
      };
    });

    const filtered =
      params.acknowledged === undefined ? mapped : mapped.filter((item) => item.acknowledged === params.acknowledged);

    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
    };
  }

  async listAlarms(params: {
    accessibleCameraIds: string[];
    cameraId?: string;
    from?: string;
    to?: string;
    status?: 'OPEN' | 'ACKED' | 'RESOLVED';
    limit?: number;
  }) {
    const base = await this.listIncidents({
      accessibleCameraIds: params.accessibleCameraIds,
      cameraId: params.cameraId,
      from: params.from,
      to: params.to,
      limit: Math.max(1, Math.min(200, params.limit ?? 100)),
    });

    const withStatus = base.items.map((item) => {
      const metadata = (item.metadata ?? {}) as Record<string, any>;
      const alarm = (metadata.alarm ?? {}) as Record<string, any>;
      const ack = (metadata.ack ?? {}) as Record<string, any>;
      const status = alarm.resolved ? 'RESOLVED' : ack.acknowledged ? 'ACKED' : 'OPEN';
      const priority =
        item.severity === 'ERROR' ? 'P1' : item.severity === 'WARN' ? 'P2' : item.severity === 'INFO' ? 'P3' : 'P4';
      return {
        ...item,
        status,
        priority,
        resolvedAt: alarm.resolvedAt ?? null,
        resolvedByUserId: alarm.resolvedByUserId ?? null,
        resolvedByUserName: alarm.resolvedByUserName ?? null,
      };
    });

    const filtered = params.status ? withStatus.filter((item) => item.status === params.status) : withStatus;
    return {
      items: filtered,
      total: filtered.length,
    };
  }

  async exportIncidentsCsv(params: {
    accessibleCameraIds: string[];
    cameraId?: string;
    from?: string;
    to?: string;
    acknowledged?: boolean;
    limit?: number;
  }) {
    const result = await this.listIncidents({
      ...params,
      limit: params.limit ?? 1000,
    });

    const escape = (value: unknown) => {
      const text = value == null ? '' : String(value);
      if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const header = [
      'incidentId',
      'cameraId',
      'cameraName',
      'type',
      'severity',
      'message',
      'occurredAt',
      'acknowledged',
      'acknowledgedAt',
      'acknowledgedByUserId',
      'note',
    ];

    const rows = result.items.map((item) =>
      [
        item.id,
        item.cameraId,
        item.cameraName ?? '',
        item.type,
        item.severity,
        item.message,
        new Date(item.occurredAt).toISOString(),
        item.acknowledged ? 'true' : 'false',
        item.acknowledgedAt ?? '',
        item.acknowledgedByUserId ?? '',
        item.note ?? '',
      ]
        .map(escape)
        .join(','),
    );

    return [header.join(','), ...rows].join('\n');
  }

  async acknowledgeIncident(eventId: string, user: { id: string; name: string }, note?: string) {
    const event = await this.prisma.cameraEvent.findUnique({
      where: { id: eventId },
      include: { camera: { select: { name: true } } },
    });
    if (!event) {
      throw new NotFoundException('Incidente não encontrado.');
    }

    const metadata = (event.metadata ?? {}) as Record<string, any>;
    const nextMetadata = {
      ...metadata,
      ack: {
        acknowledged: true,
        at: new Date().toISOString(),
        byUserId: user.id,
        byUserName: user.name,
        note: note?.trim() || null,
      },
    };

    const updated = await this.prisma.cameraEvent.update({
      where: { id: eventId },
      data: {
        metadata: nextMetadata,
      },
      include: { camera: { select: { name: true } } },
    });

    return {
      id: updated.id,
      cameraId: updated.cameraId,
      cameraName: updated.camera?.name ?? null,
      type: updated.type,
      severity: updated.severity,
      message: updated.message,
      occurredAt: updated.occurredAt,
      metadata: updated.metadata,
    };
  }

  async resolveAlarm(eventId: string, user: { id: string; name: string }, note?: string) {
    const event = await this.prisma.cameraEvent.findUnique({
      where: { id: eventId },
      include: { camera: { select: { name: true } } },
    });
    if (!event || !event.type.startsWith('STREAM_')) {
      throw new NotFoundException('Alarme não encontrado.');
    }

    const metadata = (event.metadata ?? {}) as Record<string, any>;
    const nextMetadata = {
      ...metadata,
      ack: {
        ...(metadata.ack ?? {}),
        acknowledged: true,
        at: (metadata.ack as any)?.at ?? new Date().toISOString(),
        byUserId: (metadata.ack as any)?.byUserId ?? user.id,
        byUserName: (metadata.ack as any)?.byUserName ?? user.name,
        note: note?.trim() || (metadata.ack as any)?.note || null,
      },
      alarm: {
        resolved: true,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: user.id,
        resolvedByUserName: user.name,
      },
    };

    const updated = await this.prisma.cameraEvent.update({
      where: { id: eventId },
      data: { metadata: nextMetadata },
      include: { camera: { select: { name: true } } },
    });

    return {
      id: updated.id,
      cameraId: updated.cameraId,
      cameraName: updated.camera?.name ?? null,
      type: updated.type,
      severity: updated.severity,
      message: updated.message,
      occurredAt: updated.occurredAt,
      metadata: updated.metadata,
    };
  }

  async ensureIncidentExists(eventId: string) {
    const event = await this.prisma.cameraEvent.findUnique({
      where: { id: eventId },
      select: { id: true, cameraId: true, type: true },
    });
    if (!event || !event.type.startsWith('STREAM_')) {
      throw new NotFoundException('Incidente não encontrado.');
    }
    return event;
  }

  async getHealthScores(accessibleIds?: string[]) {
    const where = accessibleIds ? { id: { in: accessibleIds } } : {};
    const staleMinutes = this.configService.get<number>('healthCheckOfflineMinutes') ?? 5;
    const staleMs = staleMinutes * 60 * 1000;
    const now = Date.now();

    const cameras = await this.prisma.camera.findMany({
      where,
      select: {
        id: true,
        name: true,
        status: true,
        lastSeenAt: true,
        recordingEnabled: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const counts = await this.prisma.cameraEvent.groupBy({
      by: ['cameraId'],
      where: {
        cameraId: { in: cameras.map((c) => c.id) },
        type: { startsWith: 'STREAM_' },
        occurredAt: { gte: last24h },
      },
      _count: { _all: true },
    });
    const countMap = new Map<string, number>(counts.map((item) => [item.cameraId, item._count._all]));

    const items = cameras.map((camera) => {
      let score = 100;
      const reasons: string[] = [];
      if (camera.status === CameraStatus.ERROR) {
        score -= 60;
        reasons.push('status_error');
      } else if (camera.status === CameraStatus.OFFLINE) {
        score -= 45;
        reasons.push('status_offline');
      } else if (camera.status === CameraStatus.UNKNOWN) {
        score -= 20;
        reasons.push('status_unknown');
      }

      if (!camera.lastSeenAt) {
        score -= 20;
        reasons.push('missing_last_seen');
      } else if (now - camera.lastSeenAt.getTime() > staleMs) {
        score -= 25;
        reasons.push('stale_heartbeat');
      }

      if (!camera.recordingEnabled) {
        score -= 10;
        reasons.push('recording_disabled');
      }

      const incidentCount = countMap.get(camera.id) ?? 0;
      if (incidentCount > 0) {
        score -= Math.min(35, incidentCount * 5);
        reasons.push(`stream_incidents_24h_${incidentCount}`);
      }

      const clamped = Math.max(0, Math.min(100, score));
      const level = clamped >= 85 ? 'GOOD' : clamped >= 60 ? 'ATTENTION' : 'CRITICAL';

      return {
        cameraId: camera.id,
        cameraName: camera.name,
        status: camera.status,
        lastSeenAt: camera.lastSeenAt?.toISOString() ?? null,
        recordingEnabled: camera.recordingEnabled,
        streamIncidents24h: incidentCount,
        score: clamped,
        level,
        reasons,
      };
    });

    return {
      items: items.sort((a, b) => a.score - b.score),
      generatedAt: new Date().toISOString(),
      staleThresholdMinutes: staleMinutes,
    };
  }

  async getReliabilityReport(days = 7, accessibleIds?: string[]) {
    const safeDays = Math.max(1, Math.min(90, days));
    const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
    const where = accessibleIds ? { id: { in: accessibleIds } } : {};
    const cameras = await this.prisma.camera.findMany({
      where,
      select: { id: true, name: true, status: true, lastSeenAt: true, recordingEnabled: true },
    });

    const ids = cameras.map((camera) => camera.id);
    const incidents = await this.prisma.cameraEvent.findMany({
      where: {
        cameraId: { in: ids },
        type: { startsWith: 'STREAM_' },
        occurredAt: { gte: since },
      },
      select: { cameraId: true, occurredAt: true, metadata: true },
      orderBy: { occurredAt: 'asc' },
    });

    const recoveries = await this.prisma.cameraEvent.groupBy({
      by: ['cameraId'],
      where: {
        cameraId: { in: ids },
        type: 'HEALTH_AUTO_RECOVERED',
        occurredAt: { gte: since },
      },
      _count: { _all: true },
    });
    const recoveryMap = new Map<string, number>(recoveries.map((item) => [item.cameraId, item._count._all]));

    const incidentMap = new Map<string, Array<{ occurredAt: Date; ackAt: Date | null }>>();
    for (const incident of incidents) {
      const metadata = (incident.metadata ?? {}) as Record<string, any>;
      const ack = (metadata.ack ?? {}) as Record<string, any>;
      const ackAt = ack.at ? new Date(ack.at) : null;
      const current = incidentMap.get(incident.cameraId) ?? [];
      current.push({ occurredAt: incident.occurredAt, ackAt });
      incidentMap.set(incident.cameraId, current);
    }

    const perCamera = cameras.map((camera) => {
      const camIncidents = incidentMap.get(camera.id) ?? [];
      const incidentCount = camIncidents.length;
      const openCount = camIncidents.filter((inc) => !inc.ackAt).length;
      const ackedCount = incidentCount - openCount;
      const ackDurations = camIncidents
        .filter((inc) => inc.ackAt)
        .map((inc) => Math.max(0, (inc.ackAt!.getTime() - inc.occurredAt.getTime()) / 60000));
      const meanAckMinutes =
        ackDurations.length > 0 ? Number((ackDurations.reduce((a, b) => a + b, 0) / ackDurations.length).toFixed(2)) : null;
      const recoveryCount = recoveryMap.get(camera.id) ?? 0;
      const reliabilityScore = Math.max(
        0,
        Math.min(
          100,
          100 -
            incidentCount * 4 -
            openCount * 6 -
            (camera.status === CameraStatus.OFFLINE ? 20 : 0) -
            (camera.status === CameraStatus.ERROR ? 30 : 0),
        ),
      );

      return {
        cameraId: camera.id,
        cameraName: camera.name,
        status: camera.status,
        incidentCount,
        openCount,
        ackedCount,
        meanAckMinutes,
        recoveryCount,
        reliabilityScore,
        recordingEnabled: camera.recordingEnabled,
        lastSeenAt: camera.lastSeenAt?.toISOString() ?? null,
      };
    });

    return {
      days: safeDays,
      generatedAt: new Date().toISOString(),
      summary: {
        cameras: perCamera.length,
        incidents: perCamera.reduce((acc, cam) => acc + cam.incidentCount, 0),
        openIncidents: perCamera.reduce((acc, cam) => acc + cam.openCount, 0),
        meanReliabilityScore:
          perCamera.length > 0
            ? Number((perCamera.reduce((acc, cam) => acc + cam.reliabilityScore, 0) / perCamera.length).toFixed(2))
            : null,
      },
      items: perCamera.sort((a, b) => a.reliabilityScore - b.reliabilityScore),
    };
  }

  async getReliabilityTrend(days = 30, accessibleIds?: string[], cameraId?: string) {
    const safeDays = Math.max(1, Math.min(90, days));
    const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
    const where = accessibleIds ? { id: { in: accessibleIds } } : {};
    const cameras = await this.prisma.camera.findMany({
      where,
      select: { id: true, name: true, status: true },
    });
    const validIds = new Set(cameras.map((camera) => camera.id));
    const targetCameraId = cameraId && validIds.has(cameraId) ? cameraId : undefined;
    const cameraFilter = targetCameraId ? [targetCameraId] : [...validIds];

    const incidents = await this.prisma.cameraEvent.findMany({
      where: {
        cameraId: { in: cameraFilter },
        type: { startsWith: 'STREAM_' },
        occurredAt: { gte: since },
      },
      select: { cameraId: true, occurredAt: true, metadata: true },
    });

    const recoveries = await this.prisma.cameraEvent.findMany({
      where: {
        cameraId: { in: cameraFilter },
        type: 'HEALTH_AUTO_RECOVERED',
        occurredAt: { gte: since },
      },
      select: { cameraId: true, occurredAt: true },
    });

    const dayKey = (date: Date) => date.toISOString().slice(0, 10);
    const trend = new Map<
      string,
      { date: string; incidents: number; acked: number; open: number; recoveries: number; score: number }
    >();
    for (let i = safeDays - 1; i >= 0; i -= 1) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      const key = dayKey(d);
      trend.set(key, { date: key, incidents: 0, acked: 0, open: 0, recoveries: 0, score: 100 });
    }

    for (const incident of incidents) {
      const key = dayKey(incident.occurredAt);
      const row = trend.get(key);
      if (!row) continue;
      row.incidents += 1;
      const metadata = (incident.metadata ?? {}) as Record<string, any>;
      const ack = (metadata.ack ?? {}) as Record<string, any>;
      if (ack.acknowledged) row.acked += 1;
      else row.open += 1;
    }

    for (const recovery of recoveries) {
      const key = dayKey(recovery.occurredAt);
      const row = trend.get(key);
      if (!row) continue;
      row.recoveries += 1;
    }

    const items = [...trend.values()].map((row) => ({
      ...row,
      score: Math.max(0, Math.min(100, 100 - row.incidents * 4 - row.open * 6 + row.recoveries * 2)),
    }));

    return {
      days: safeDays,
      cameraId: targetCameraId ?? null,
      generatedAt: new Date().toISOString(),
      items,
    };
  }

  async getAlerts(accessibleIds?: string[]) {
    const health = await this.getHealthScores(accessibleIds);
    const warningThreshold = this.configService.get<number>('alertScoreWarning') ?? 75;
    const criticalThreshold = this.configService.get<number>('alertScoreCritical') ?? 60;
    const openCritical = this.configService.get<number>('alertOpenIncidentsCritical') ?? 5;
    const recentWindowMinutes = this.configService.get<number>('alertRecentWindowMinutes') ?? 60;

    const from = new Date(Date.now() - recentWindowMinutes * 60 * 1000);
    const cameraIds = health.items.map((item) => item.cameraId);
    const recentIncidents = await this.prisma.cameraEvent.groupBy({
      by: ['cameraId'],
      where: {
        cameraId: { in: cameraIds },
        type: { startsWith: 'STREAM_' },
        occurredAt: { gte: from },
      },
      _count: { _all: true },
    });
    const recentMap = new Map<string, number>(recentIncidents.map((item) => [item.cameraId, item._count._all]));

    type AlertItem = {
      cameraId: string;
      cameraName: string;
      severity: 'CRITICAL' | 'WARNING';
      score: number;
      status: CameraStatus;
      streamIncidents24h: number;
      streamIncidentsRecentWindow: number;
      reasons: string[];
      storageUsagePercent?: number;
      storageThresholdWarning?: number;
      storageThresholdCritical?: number;
    };

    const alerts: AlertItem[] = health.items
      .map((item) => {
        const recent = recentMap.get(item.cameraId) ?? 0;
        const criticalByScore = item.score < criticalThreshold;
        const criticalByOpen = item.streamIncidents24h >= openCritical;
        const warningByScore = item.score < warningThreshold;
        const warningByRecent = recent >= 2;
        if (!(criticalByScore || criticalByOpen || warningByScore || warningByRecent)) {
          return null;
        }
        const severity: AlertItem['severity'] = criticalByScore || criticalByOpen ? 'CRITICAL' : 'WARNING';
        const reasons: string[] = [];
        if (criticalByScore) reasons.push(`score_below_${criticalThreshold}`);
        else if (warningByScore) reasons.push(`score_below_${warningThreshold}`);
        if (criticalByOpen) reasons.push(`incidents24h_ge_${openCritical}`);
        if (warningByRecent) reasons.push(`recent_incidents_${recent}_in_${recentWindowMinutes}m`);

        return {
          cameraId: item.cameraId,
          cameraName: item.cameraName,
          severity,
          score: item.score,
          status: item.status,
          streamIncidents24h: item.streamIncidents24h,
          streamIncidentsRecentWindow: recent,
          reasons,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'CRITICAL' ? -1 : 1;
        return a.score - b.score;
      });

    const storageWarningPercent = envNumber('ALERT_STORAGE_WARNING_PERCENT', 85);
    const storageCriticalPercent = envNumber('ALERT_STORAGE_CRITICAL_PERCENT', 92);
    const recordingsRoot = this.configService.get<string>('recordingsRoot') ?? './storage/recordings';
    try {
      const disk = await statfs(recordingsRoot);
      const totalBytes = Number(disk.blocks) * Number(disk.bsize);
      const freeBytes = Number(disk.bavail) * Number(disk.bsize);
      const usedBytes = Math.max(totalBytes - freeBytes, 0);
      const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
      if (usagePercent >= storageWarningPercent) {
        alerts.unshift({
          cameraId: '__SYSTEM_STORAGE__',
          cameraName: 'Storage do sistema',
          severity: usagePercent >= storageCriticalPercent ? 'CRITICAL' : 'WARNING',
          score: Math.max(0, 100 - usagePercent),
          status: usagePercent >= storageCriticalPercent ? 'ERROR' : 'ONLINE',
          streamIncidents24h: 0,
          streamIncidentsRecentWindow: 0,
          reasons: [
            usagePercent >= storageCriticalPercent
              ? `storage_usage_ge_${storageCriticalPercent}`
              : `storage_usage_ge_${storageWarningPercent}`,
          ],
          storageUsagePercent: usagePercent,
          storageThresholdWarning: storageWarningPercent,
          storageThresholdCritical: storageCriticalPercent,
        });
      }
    } catch (error) {
      this.logger.warn(`Falha ao ler uso de storage para alertas: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      generatedAt: new Date().toISOString(),
      thresholds: {
        warningScore: warningThreshold,
        criticalScore: criticalThreshold,
        criticalOpenIncidents24h: openCritical,
        recentWindowMinutes,
        storageWarningPercent,
        storageCriticalPercent,
      },
      summary: {
        total: alerts.length,
        critical: alerts.filter((item) => item.severity === 'CRITICAL').length,
        warning: alerts.filter((item) => item.severity === 'WARNING').length,
      },
      items: alerts,
    };
  }

  async getOperationsTimeline(params: {
    accessibleCameraIds: string[];
    cameraId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) {
    const limit = Math.max(10, Math.min(500, params.limit ?? 120));
    const from = params.from ? new Date(params.from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = params.to ? new Date(params.to) : new Date();
    const cameraIds = params.cameraId ? [params.cameraId] : params.accessibleCameraIds;

    const [events, alarms, audit] = await Promise.all([
      this.prisma.cameraEvent.findMany({
        where: {
          cameraId: { in: cameraIds },
          occurredAt: { gte: from, lte: to },
        },
        include: { camera: { select: { name: true } } },
        orderBy: { occurredAt: 'desc' },
        take: limit,
      }),
      this.prisma.alarmInstance.findMany({
        where: {
          cameraId: { in: cameraIds },
          lastOccurredAt: { gte: from, lte: to },
        },
        include: { camera: { select: { name: true } } },
        orderBy: { lastOccurredAt: 'desc' },
        take: limit,
      }),
      this.prisma.auditLog.findMany({
        where: {
          createdAt: { gte: from, lte: to },
          OR: [
            { action: { startsWith: 'alarm.' } },
            { action: { startsWith: 'recording.reconnect' } },
            { action: { startsWith: 'incident.' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    const alarmByEventId = new Map<string, (typeof alarms)[number]>();
    for (const alarm of alarms) {
      if (alarm.eventId) alarmByEventId.set(alarm.eventId, alarm);
    }

    const items = [
      ...events.map((event) => {
        const linkedAlarm = alarmByEventId.get(event.id);
        return {
          kind: 'event',
          at: event.occurredAt,
          cameraId: event.cameraId,
          cameraName: event.camera?.name ?? null,
          severity: event.severity,
          type: event.type,
          message: event.message,
          eventId: event.id,
          alarmId: linkedAlarm?.id ?? null,
          alarmStatus: linkedAlarm?.status ?? null,
          action: null,
          actor: null,
        };
      }),
      ...alarms.map((alarm) => ({
        kind: 'alarm',
        at: alarm.lastOccurredAt,
        cameraId: alarm.cameraId ?? null,
        cameraName: alarm.camera?.name ?? null,
        severity: alarm.severity,
        type: alarm.type,
        message: alarm.message,
        eventId: alarm.eventId ?? null,
        alarmId: alarm.id,
        alarmStatus: alarm.status,
        action: null,
        actor: alarm.acknowledgedByUserName ?? alarm.resolvedByUserName ?? null,
      })),
      ...audit.map((entry) => ({
        kind: 'action',
        at: entry.createdAt,
        cameraId: null,
        cameraName: null,
        severity: 'INFO',
        type: entry.action,
        message: `${entry.entityType}${entry.entityId ? ` ${entry.entityId}` : ''}`,
        eventId: null,
        alarmId: null,
        alarmStatus: null,
        action: entry.action,
        actor: entry.userId ?? null,
      })),
    ]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, limit);

    return {
      generatedAt: new Date().toISOString(),
      from: from.toISOString(),
      to: to.toISOString(),
      total: items.length,
      items,
    };
  }

  async getDiagnostics(id: string) {
    const camera = await this.getCameraOrThrow(id);
    const [status, latestRecording, recentEvents] = await Promise.all([
      this.getStatus(id),
      this.prisma.recording.findFirst({
        where: { cameraId: id },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          sizeBytes: true,
          filePath: true,
        },
      }),
      this.prisma.cameraEvent.findMany({
        where: { cameraId: id },
        orderBy: { occurredAt: 'desc' },
        take: 5,
        select: {
          id: true,
          type: true,
          severity: true,
          message: true,
          occurredAt: true,
        },
      }),
    ]);

    const now = Date.now();
    const lastSeenMs = camera.lastSeenAt ? new Date(camera.lastSeenAt).getTime() : null;
    const ageSeconds = lastSeenMs ? Math.max(0, Math.floor((now - lastSeenMs) / 1000)) : null;

    return {
      camera: {
        id: camera.id,
        name: camera.name,
        ip: camera.ip,
        status: camera.status,
        recordingEnabled: camera.recordingEnabled,
        lastSeenAt: camera.lastSeenAt,
      },
      connectivity: {
        rtspReachable: status.rtspReachable,
        onvifReachable: status.onvifReachable,
        checkedAt: status.checkedAt,
      },
      heartbeat: {
        ageSeconds,
        stale: ageSeconds == null ? true : ageSeconds > 300,
      },
      latestRecording: latestRecording
        ? {
            ...latestRecording,
            sizeBytes: latestRecording.sizeBytes ? latestRecording.sizeBytes.toString() : null,
          }
        : null,
      recentEvents,
      ffmpeg: {
        recordingFormat: process.env.FFMPEG_RECORDING_FORMAT ?? 'mp4',
        rtspTransport: process.env.FFMPEG_RTSP_TRANSPORT ?? 'tcp',
      },
    };
  }

  private async validateReferences(siteId?: string, areaId?: string, groupId?: string) {
    if (siteId) {
      const site = await this.prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        throw new NotFoundException('Site/unidade informada não existe.');
      }
    }
    if (areaId) {
      const area = await this.prisma.area.findUnique({ where: { id: areaId } });
      if (!area) {
        throw new NotFoundException('Área/setor informado não existe.');
      }
    }
    if (groupId) {
      const group = await this.prisma.cameraGroup.findUnique({ where: { id: groupId } });
      if (!group) {
        throw new NotFoundException('Grupo informado não existe.');
      }
    }
  }
}
