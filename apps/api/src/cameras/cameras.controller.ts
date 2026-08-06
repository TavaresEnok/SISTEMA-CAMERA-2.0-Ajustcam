import { PendingIngestRegistry } from './pending-ingest.registry';
import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UserRole, CameraStatus, AlarmPriority, AlarmSource } from '@prisma/client';
import { type Request, type Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AccessControlService } from '../access-control/access-control.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { AlarmsService } from '../alarms/alarms.service';
import { CamerasService } from './cameras.service';
import { CameraPreviewFrameDto } from './dto/camera-preview-frame.dto';
import { CreateCameraDto } from './dto/create-camera.dto';
import { TestCameraConnectionDto } from './dto/test-camera-connection.dto';
import { UpdateCameraDto } from './dto/update-camera.dto';
import { TransferCameraOwnerDto } from './dto/transfer-camera-owner.dto';
import { Public } from '../auth/decorators/public.decorator';
import { ServiceTokenGuard } from '../auth/guards/service-token.guard';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { RecordingProcessManagerService } from '../recordings/recording-process-manager.service';
import { MediamtxProxyService } from '../camera-stream/mediamtx-proxy.service';
import { AiManagerService } from '../ai/ai-manager.service';
import { AiService } from '../ai/ai.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { envNumber } from '../common/config/env-number.helper';

@Controller('cameras')
export class CamerasController {
  constructor(
    private readonly camerasService: CamerasService,
    private readonly alarmsService: AlarmsService,
    private readonly accessControlService: AccessControlService,
    private readonly auditService: AuditService,
    private readonly recordingManager: RecordingProcessManagerService,
    private readonly moduleRef: ModuleRef,
    private readonly commercialPolicy: CommercialPolicyService,
    private readonly pendingIngest: PendingIngestRegistry,
  ) {}

  private schedulePostCreateProvisioning(cameraId: string) {
    setTimeout(() => void this.postCreateProvisioning(cameraId), 0);
  }

  private async postCreateProvisioning(cameraId: string) {
    await this.camerasService.getStatus(cameraId).catch(() => undefined);

    try {
      const mediamtx = this.moduleRef.get(MediamtxProxyService, { strict: false });
      await Promise.all([
        mediamtx.ensurePathForCamera(cameraId, 'selected'),
        mediamtx.ensurePathForCamera(cameraId, 'grid'),
      ]);
    } catch {
      // Live will retry when the camera page requests stream URLs.
    }

    try {
      const camera = await this.camerasService.getCameraOrThrow(cameraId);
      if (camera.recordingEnabled && camera.recordingMode === 'continuous') {
        const defaultSegment = envNumber('RECORDING_SEGMENT_SECONDS', 300, { min: 5, max: 3600, integer: true });
        await this.recordingManager.start(cameraId, defaultSegment).catch(() => undefined);
      }
    } catch {
      // Health workers keep recording state reconciled if this immediate start fails.
    }

    try {
      const aiManager = this.moduleRef.get(AiManagerService, { strict: false });
      await aiManager.startCamera(cameraId);
    } catch {
      // The live-view endpoint also starts IA on demand.
    }
  }

  private async withCapabilities(user: AuthUser, camera: Record<string, unknown> & { id: string }) {
    const isAdmin = user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
    if (isAdmin && camera.isPrivate !== true) {
      // Atalho de admin só para câmeras NORMAIS. Numa câmera PRIVADA, `canView`
      // precisa refletir a regra real (admin não vê conteúdo do cliente) para o
      // frontend mostrar o aviso de privacidade em vez de tentar montar o player.
      return { ...camera, canView: true, canControl: true, canRecord: true, canAdmin: true };
    }
    const [canView, canControl, canRecord, canAdmin] = await Promise.all([
      this.accessControlService.canViewCamera(user, camera.id),
      this.accessControlService.canControlCamera(user, camera.id),
      this.accessControlService.canRecordCamera(user, camera.id),
      this.accessControlService.canAdminCamera(user, camera.id),
    ]);
    return { ...camera, canView, canControl, canRecord, canAdmin };
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateCameraDto, @Req() req: Request) {
    await this.commercialPolicy.assertFeature('addCameras', user);
    const camera = await this.camerasService.create(dto);
    await this.auditService.log(user.id, 'camera.create', 'Camera', camera.id, { name: camera.name }, req);
    this.schedulePostCreateProvisioning(camera.id);
    return camera;
  }

  /**
   * "+ Adicionar câmera" do app do CLIENTE. Qualquer usuário autenticado cadastra
   * a PRÓPRIA câmera privada (LGPD): o conteúdo será acessível só a ele. A câmera
   * é auto-vinculada ao grupo do responsável e recebe permissão de admin do dono.
   * O provedor/admin verá a câmera apenas para gerenciamento, nunca o conteúdo.
   */
  /** Cota de câmeras privadas do cliente (usado/limite) — o app mostra "1 de 1". */
  @Roles(UserRole.VIEWER)
  @Get('mine/quota')
  async myPrivateQuota(@CurrentUser() user: AuthUser) {
    const quota = await this.camerasService.getPrivateCameraQuota(user);
    return { ...quota, canAdd: quota.used < quota.limit };
  }

  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('mine')
  async createMine(@CurrentUser() user: AuthUser, @Body() dto: CreateCameraDto, @Req() req: Request) {
    await this.commercialPolicy.assertFeature('addCameras', user);
    const camera = await this.camerasService.createPrivateForOwner(dto, user);
    await this.auditService.log(user.id, 'camera.create_private', 'Camera', camera.id, { name: camera.name, private: true }, req);
    this.schedulePostCreateProvisioning(camera.id);
    return camera;
  }

  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  @Post('test-connection-draft')
  async testConnectionDraft(@CurrentUser() user: AuthUser, @Body() dto: TestCameraConnectionDto, @Req() req: Request) {
    const result = await this.camerasService.testConnectionDraft(dto);
    await this.auditService.log(user.id, 'camera.test_connection_draft', 'Camera', null, result, req);
    return result;
  }

  /**
   * CONFIRMAÇÃO VISUAL DO CADASTRO — devolve UM frame da câmera antes de salvar.
   *
   * Metadado (1920x1080 · H.264) não distingue a câmera do estacionamento da
   * câmera da recepção: com IP trocado, o erro só aparece quando o cliente pede
   * a gravação e alguém precisa VOLTAR AO LOCAL. O frame mata isso no cadastro.
   *
   * A imagem NÃO vai para a auditoria: além de estourar a tabela, guardaria
   * conteúdo de câmera em texto. Só o resultado e a fonte que respondeu.
   */
  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @Post('preview-frame')
  async previewFrameDraft(@CurrentUser() user: AuthUser, @Body() dto: TestCameraConnectionDto, @Req() req: Request) {
    const result = await this.camerasService.capturePreviewFrame({
      ip: dto.ip,
      rtspPort: dto.rtspPort,
      username: dto.username ?? '',
      password: dto.password ?? '',
      rtspPath: dto.rtspPath,
      channel: dto.channel,
      subtype: dto.subtype,
    });
    await this.auditService.log(
      user.id,
      'camera.preview_frame_draft',
      'Camera',
      null,
      { ip: dto.ip, ok: result.ok, source: result.source, bytes: result.bytes },
      req,
    );
    return result;
  }

  @Roles(UserRole.VIEWER)
  @Get()
  async findAll(@CurrentUser() user: AuthUser) {
    const isAdmin = user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
    let cameras = isAdmin
      ? await this.camerasService.findAll()
      : await this.camerasService.findAll(await this.accessControlService.getAccessibleCameraIds(user));

    // Câmera DESATIVADA some para quem só assiste (inclusive apps antigos, que
    // não conhecem o campo). Admin continua vendo, para poder reativar.
    if (!isAdmin) {
      cameras = cameras.filter((camera: any) => camera.enabled !== false);
    }

    return Promise.all(cameras.map((camera: any) => this.withCapabilities(user, camera)));
  }

  @Roles(UserRole.VIEWER)
  @Get('events')
  async listEvents(@CurrentUser() user: AuthUser, @Query('cameraId') cameraId?: string, @Query('limit') limit?: string) {
    if (cameraId) {
      await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    const ids = cameraId ? [cameraId] : await this.accessControlService.getAccessibleCameraIds(user);
    return this.camerasService.listEvents(ids, limit ? parseInt(limit, 10) : 50);
  }

  @Roles(UserRole.VIEWER)
  @Get('events-feed')
  async listEventsFeed(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId?: string,
    @Query('type') type?: string,
    @Query('severity') severity?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // Feed RECENTE (sem from/to) é contexto de operação ao vivo: permissão de
    // VER basta — é o que alimenta o painel de eventos do dashboard, inclusive
    // para contas só-view legítimas. Consulta HISTÓRICA (com from/to) é
    // navegação de acervo: quem não pode assistir ao playback também não deve
    // reconstruir a linha do tempo de movimento de dias inteiros por metadado.
    const consultaHistorica = Boolean(from || to);
    if (cameraId) {
      if (consultaHistorica) await this.accessControlService.assertCanPlaybackCamera(user, cameraId);
      else await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    const accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? (await this.camerasService.findAll()).map((c: any) => c.id)
        : consultaHistorica
          ? await this.accessControlService.getPlaybackCameraIds(user)
          : await this.accessControlService.getAccessibleCameraIds(user);
    return this.camerasService.listEventsFeed({
      accessibleCameraIds,
      cameraId,
      type,
      severity,
      from,
      to,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 600, ttl: 60000 } })
  @Get(':id/detections/latest')
  async latestDetections(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('seconds') seconds?: string,
    @Query('limit') limit?: string,
  ) {
    await this.accessControlService.assertCanViewCamera(user, id);
    return this.camerasService.listLatestDetections(
      id,
      seconds ? parseInt(seconds, 10) : 8,
      limit ? parseInt(limit, 10) : 12,
    );
  }

  @Roles(UserRole.VIEWER)
  @Get('overview')
  async getOverview(@CurrentUser() user: AuthUser) {
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.camerasService.getOverview();
    }
    const ids = await this.accessControlService.getAccessibleCameraIds(user);
    return this.camerasService.getOverview(ids);
  }

  @Roles(UserRole.VIEWER)
  @Get('incidents')
  async listIncidents(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('acknowledged') acknowledged?: string,
    @Query('limit') limit?: string,
  ) {
    if (cameraId) {
      await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    const accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? (await this.camerasService.findAll()).map((c: any) => c.id)
        : await this.accessControlService.getAccessibleCameraIds(user);

    const ack =
      acknowledged === undefined ? undefined : ['1', 'true', 'yes', 'sim'].includes(acknowledged.toLowerCase());

    return this.camerasService.listIncidents({
      accessibleCameraIds,
      cameraId,
      from,
      to,
      acknowledged: ack,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Roles(UserRole.VIEWER)
  @Get('alarms')
  async listAlarms(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: 'OPEN' | 'ACKED' | 'RESOLVED',
    @Query('severity') severity?: string,
    @Query('priority') priority?: AlarmPriority,
    @Query('source') source?: AlarmSource,
    @Query('type') type?: string,
    @Query('zone') zone?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (cameraId) {
      await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    let accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? (await this.camerasService.findAll()).map((c: any) => c.id)
        : await this.accessControlService.getAccessibleCameraIds(user);

    if (zone?.trim()) {
      const normalizedZone = zone.trim().toLowerCase();
      const cameras = await this.camerasService.findAll(accessibleCameraIds);
      accessibleCameraIds = cameras
        .filter((camera: any) =>
          [camera.area?.name, camera.site?.name, camera.group?.name]
            .filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()))
            .some((value) => value.trim().toLowerCase().includes(normalizedZone)),
        )
        .map((camera: any) => camera.id);
    }

    return this.alarmsService.list({
      accessibleCameraIds,
      cameraId,
      from,
      to,
      status,
      severity,
      priority,
      source,
      type,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('alarmAck')
  @Post('incidents/:eventId/ack')
  async acknowledgeIncident(
    @CurrentUser() user: AuthUser,
    @Param('eventId') eventId: string,
    @Body() body: { note?: string },
    @Req() req: Request,
  ) {
    const incident = await this.camerasService.ensureIncidentExists(eventId);
    await this.accessControlService.assertCanViewCamera(user, incident.cameraId);
    const event = await this.camerasService.acknowledgeIncident(eventId, { id: user.id, name: user.name }, body.note);
    await this.auditService.log(user.id, 'incident.ack', 'CameraEvent', eventId, { cameraId: event.cameraId }, req);
    return event;
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('alarmAck')
  @Post('alarms/:eventId/ack')
  async acknowledgeAlarm(
    @CurrentUser() user: AuthUser,
    @Param('eventId') eventId: string,
    @Body() body: { note?: string },
    @Req() req: Request,
  ) {
    const alarm = await this.alarmsService.ensureExists(eventId);
    if (alarm.cameraId) {
      await this.accessControlService.assertCanViewCamera(user, alarm.cameraId);
    }
    const updated = await this.alarmsService.acknowledge(eventId, { id: user.id, name: user.name }, body.note);
    await this.auditService.log(user.id, 'alarm.ack', 'AlarmInstance', eventId, { cameraId: updated.cameraId }, req);
    return updated;
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('alarmAck')
  @Post('alarms/:eventId/resolve')
  async resolveAlarm(
    @CurrentUser() user: AuthUser,
    @Param('eventId') eventId: string,
    @Body() body: { note?: string },
    @Req() req: Request,
  ) {
    const alarm = await this.alarmsService.ensureExists(eventId);
    if (alarm.cameraId) {
      await this.accessControlService.assertCanViewCamera(user, alarm.cameraId);
    }
    const updated = await this.alarmsService.resolve(eventId, { id: user.id, name: user.name }, body.note);
    await this.auditService.log(user.id, 'alarm.resolve', 'AlarmInstance', eventId, { cameraId: updated.cameraId }, req);
    return updated;
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('alarmAck')
  @Post('alarms/:eventId/snooze')
  async snoozeAlarm(
    @CurrentUser() user: AuthUser,
    @Param('eventId') eventId: string,
    @Body() body: { minutes?: number; note?: string },
    @Req() req: Request,
  ) {
    const alarm = await this.alarmsService.ensureExists(eventId);
    if (alarm.cameraId) {
      await this.accessControlService.assertCanViewCamera(user, alarm.cameraId);
    }
    const updated = await this.alarmsService.snooze(eventId, { id: user.id, name: user.name }, body.minutes ?? 15, body.note);
    await this.auditService.log(user.id, 'alarm.snooze', 'AlarmInstance', eventId, { cameraId: updated.cameraId, minutes: body.minutes ?? 15 }, req);
    return updated;
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('alarmAck')
  @Post('alarms/:eventId/unsnooze')
  async unsnoozeAlarm(
    @CurrentUser() user: AuthUser,
    @Param('eventId') eventId: string,
    @Body() body: { note?: string },
    @Req() req: Request,
  ) {
    const alarm = await this.alarmsService.ensureExists(eventId);
    if (alarm.cameraId) {
      await this.accessControlService.assertCanViewCamera(user, alarm.cameraId);
    }
    const updated = await this.alarmsService.unsnooze(eventId, { id: user.id, name: user.name }, body.note);
    await this.auditService.log(user.id, 'alarm.unsnooze', 'AlarmInstance', eventId, { cameraId: updated.cameraId }, req);
    return updated;
  }

  @Roles(UserRole.OPERATOR)
  @Post('alarms/:eventId/note')
  async addAlarmNote(
    @CurrentUser() user: AuthUser,
    @Param('eventId') eventId: string,
    @Body() body: { note?: string },
    @Req() req: Request,
  ) {
    const alarm = await this.alarmsService.ensureExists(eventId);
    if (alarm.cameraId) {
      await this.accessControlService.assertCanViewCamera(user, alarm.cameraId);
    }
    const note = body.note?.trim() ?? '';
    const updated = await this.alarmsService.addNote(eventId, { id: user.id, name: user.name }, note);
    await this.auditService.log(user.id, 'alarm.note.add', 'AlarmInstance', eventId, { cameraId: updated.cameraId }, req);
    return updated;
  }

  @Roles(UserRole.OPERATOR)
  @Post('alarms/bulk')
  async bulkAlarmAction(
    @CurrentUser() user: AuthUser,
    @Body() body: { action: 'ack' | 'resolve' | 'snooze' | 'unsnooze'; eventIds: string[]; note?: string; minutes?: number },
    @Req() req: Request,
  ) {
    const action = body.action;
    const eventIds = Array.isArray(body.eventIds) ? body.eventIds : [];
    for (const eventId of eventIds.slice(0, 200)) {
      const alarm = await this.alarmsService.ensureExists(eventId);
      if (alarm.cameraId) {
        await this.accessControlService.assertCanViewCamera(user, alarm.cameraId);
      }
    }
    const result = await this.alarmsService.bulkAction(action, eventIds, { id: user.id, name: user.name }, {
      note: body.note,
      snoozeMinutes: body.minutes,
    });
    await this.auditService.log(user.id, 'alarm.bulk', 'AlarmInstance', null, { action, totalRequested: result.totalRequested, ok: result.ok }, req);
    return result;
  }

  // ── INGESTÃO POR RTMP (a câmera publica em nós) ───────────────────────────
  //
  // Só administrador: a chave é um credencial de publicação, e quem a tem pode
  // empurrar vídeo como se fosse a câmera. Limite de requisições porque gerar
  // chave é operação rara e em rajada só faria sentido em abuso.

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post(':id/rtmp-ingest')
  async rotateRtmpIngest(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    const alvo = await this.camerasService.rotateRtmpIngestKey(id);
    // A chave NÃO entra na auditoria: o registro prova que houve rotação, sem
    // reintroduzir o segredo num lugar que muita gente pode ler.
    await this.auditService.log(user.id, 'camera.rtmp_ingest.rotate', 'Camera', id, {}, req);
    return alvo;
  }

  /**
   * Equipamentos que tentaram publicar e ainda não pertencem a ninguém.
   *
   * É a peça que faz o sistema "aprender": em vez de recusar em silêncio (o que
   * transforma "a câmera não aparece" num mistério), a tentativa vira uma linha
   * na tela para o administrador dizer de qual câmera é.
   *
   * Rota FIXA antes das dinâmicas `:id/...` — senão o Nest leria
   * "rtmp-ingest" como um id de câmera.
   */
  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Get('rtmp-ingest/pending')
  listPendingIngest() {
    return { items: this.pendingIngest.list() };
  }

  /** Vincula a esta câmera o caminho que o equipamento usa por conta própria. */
  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Post(':id/rtmp-ingest/bind')
  async bindRtmpIngest(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { path?: string },
    @Req() req: Request,
  ) {
    const resultado = await this.camerasService.bindRtmpIngestPath(id, String(body?.path ?? ''));
    this.pendingIngest.clear(resultado.ingestPath);
    await this.auditService.log(user.id, 'camera.rtmp_ingest.bind', 'Camera', id, { path: resultado.ingestPath }, req);
    return resultado;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Get(':id/rtmp-ingest')
  async getRtmpIngest(@Param('id') id: string) {
    const alvo = await this.camerasService.getRtmpIngestTarget(id);
    return alvo ?? { sourceMode: 'rtsp_pull', serverUrl: null, streamKey: null, fullUrl: null };
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Delete(':id/rtmp-ingest')
  async disableRtmpIngest(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    await this.camerasService.disableRtmpIngest(id);
    await this.auditService.log(user.id, 'camera.rtmp_ingest.disable', 'Camera', id, {}, req);
    return { sourceMode: 'rtsp_pull' };
  }

  @Roles(UserRole.ADMIN)
  @Delete('alarms')
  async deleteAllAlarms(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const result = await this.alarmsService.deleteAll();
    await this.auditService.log(user.id, 'alarm.delete_all', 'AlarmInstance', null, result, req);
    return result;
  }

  @Roles(UserRole.OPERATOR)
  @Post('incidents/ack/bulk')
  async acknowledgeIncidentsBulk(
    @CurrentUser() user: AuthUser,
    @Body() body: { eventIds: string[]; note?: string },
    @Req() req: Request,
  ) {
    const eventIds = Array.isArray(body.eventIds) ? [...new Set(body.eventIds)].slice(0, 200) : [];
    const results: Array<{ eventId: string; status: 'acked' | 'skipped'; reason?: string }> = [];
    for (const eventId of eventIds) {
      try {
        const incident = await this.camerasService.ensureIncidentExists(eventId);
        await this.accessControlService.assertCanViewCamera(user, incident.cameraId);
        await this.camerasService.acknowledgeIncident(eventId, { id: user.id, name: user.name }, body.note);
        await this.auditService.log(user.id, 'incident.ack.bulk', 'CameraEvent', eventId, { cameraId: incident.cameraId }, req);
        results.push({ eventId, status: 'acked' });
      } catch (error) {
        results.push({ eventId, status: 'skipped', reason: (error as Error).message });
      }
    }
    return {
      totalRequested: eventIds.length,
      acked: results.filter((item) => item.status === 'acked').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      results,
    };
  }

  @Roles(UserRole.VIEWER)
  @Get('incidents/export.csv')
  async exportIncidentsCsv(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('acknowledged') acknowledged: string | undefined,
    @Res() res: Response,
  ) {
    if (cameraId) {
      await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    const accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? (await this.camerasService.findAll()).map((c: any) => c.id)
        : await this.accessControlService.getAccessibleCameraIds(user);

    const ack =
      acknowledged === undefined ? undefined : ['1', 'true', 'yes', 'sim'].includes(acknowledged.toLowerCase());
    const csv = await this.camerasService.exportIncidentsCsv({
      accessibleCameraIds,
      cameraId,
      from,
      to,
      acknowledged: ack,
      limit: 5000,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="incidents-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  @Roles(UserRole.VIEWER)
  @Get('health-scores')
  async getHealthScores(@CurrentUser() user: AuthUser) {
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.camerasService.getHealthScores();
    }
    const ids = await this.accessControlService.getAccessibleCameraIds(user);
    return this.camerasService.getHealthScores(ids);
  }

  @Roles(UserRole.VIEWER)
  @Get('reliability')
  async getReliability(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    const safeDays = days ? parseInt(days, 10) : 7;
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.camerasService.getReliabilityReport(safeDays);
    }
    const ids = await this.accessControlService.getAccessibleCameraIds(user);
    return this.camerasService.getReliabilityReport(safeDays, ids);
  }

  @Roles(UserRole.VIEWER)
  @Get('reliability-trend')
  async getReliabilityTrend(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
    @Query('cameraId') cameraId?: string,
  ) {
    const safeDays = days ? parseInt(days, 10) : 30;
    if (cameraId) {
      await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.camerasService.getReliabilityTrend(safeDays, undefined, cameraId);
    }
    const ids = await this.accessControlService.getAccessibleCameraIds(user);
    return this.camerasService.getReliabilityTrend(safeDays, ids, cameraId);
  }

  @Roles(UserRole.VIEWER)
  @Get('alerts')
  async getAlerts(@CurrentUser() user: AuthUser) {
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.camerasService.getAlerts();
    }
    const ids = await this.accessControlService.getAccessibleCameraIds(user);
    return this.camerasService.getAlerts(ids);
  }

  @Roles(UserRole.VIEWER)
  @Get('operations-timeline')
  async getOperationsTimeline(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    if (cameraId) {
      await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    const accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? (await this.camerasService.findAll()).map((c: any) => c.id)
        : await this.accessControlService.getAccessibleCameraIds(user);
    return this.camerasService.getOperationsTimeline({
      accessibleCameraIds,
      cameraId,
      from,
      to,
      limit: limit ? parseInt(limit, 10) : 120,
    });
  }

  @Roles(UserRole.VIEWER)
  @Get(':id/diagnostics')
  async getDiagnostics(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.accessControlService.assertCanViewCamera(user, id);
    return this.camerasService.getDiagnostics(id);
  }

  /**
   * DIAGNÓSTICO RICO da câmera já salva, sob demanda: o que a sonda detecta
   * AGORA contra o que está configurado. A divergência é o diagnóstico.
   *
   * Gate de VER (e não de administrar) porque o relatório descreve o conteúdo do
   * stream. Numa câmera PRIVADA `canViewCamera` é invertido — o admin gerencia
   * mas não vê —, e essa inversão precisa valer aqui também.
   */
  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @Get(':id/live-diagnostics')
  async getLiveDiagnostics(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.accessControlService.assertCanViewCamera(user, id);
    return this.camerasService.getLiveDiagnostics(id);
  }

  /**
   * Confirmação visual na EDIÇÃO: um frame da câmera salva (ou dos novos dados
   * digitados) antes de gravar a alteração. Devolve imagem — logo, gate de VER.
   */
  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @Post(':id/preview-frame')
  async previewFrame(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CameraPreviewFrameDto,
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanViewCamera(user, id);
    const result = await this.camerasService.capturePreviewFrameForCamera(id, dto);
    await this.auditService.log(
      user.id,
      'camera.preview_frame',
      'Camera',
      id,
      { ok: result.ok, source: result.source, bytes: result.bytes },
      req,
    );
    return result;
  }

  @Roles(UserRole.VIEWER)
  @Get(':id/pipelines')
  async getPipelines(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.accessControlService.assertCanViewCamera(user, id);
    return this.camerasService.getPipelineSummary(id);
  }

  @Roles(UserRole.VIEWER)
  @Get(':id')
  async findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.accessControlService.assertCanViewCamera(user, id);
    const camera = await this.camerasService.findOne(id);
    return this.withCapabilities(user, camera);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Patch(':id/owner')
  async transferOwner(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: TransferCameraOwnerDto,
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanAdminCamera(user, id);
    const camera = await this.camerasService.transferPrivateCameraOwner(id, dto.ownerUserId);
    await this.auditService.log(
      user.id,
      'camera.owner.transfer',
      'Camera',
      id,
      { ownerUserId: dto.ownerUserId },
      req,
    );
    return camera;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateCameraDto, @Req() req: Request) {
    await this.accessControlService.assertCanAdminCamera(user, id);
    const wasEnabled = (await this.camerasService.getCameraOrThrow(id)).enabled !== false;
    const camera = await this.camerasService.update(id, dto);
    if (dto.enabled === false && wasEnabled) {
      // Desativada: derruba gravação e live AGORA (sem esperar closeAfter/watchdog).
      await this.recordingManager.stop(id).catch(() => undefined);
      try {
        const mediamtx = this.moduleRef.get(MediamtxProxyService, { strict: false });
        await mediamtx.teardownPathsForCamera(id);
      } catch {
        // Sem MediaMTX ativo os paths on-demand morrem sozinhos.
      }
    } else if (dto.enabled === true && !wasEnabled) {
      // Reativada: religa live/gravação/IA pelo mesmo fluxo do pós-criação.
      this.schedulePostCreateProvisioning(id);
    } else if (dto.detectionZones !== undefined) {
      // Zonas mudaram: a análise precisa recarregar as máscaras. Feito AQUI (e
      // não em CamerasService) porque importar os serviços de IA lá fecha o
      // ciclo de módulos Cameras→Ai→Cameras e o Nest não sobe.
      void (async () => {
        try {
          const aiService = this.moduleRef.get(AiService, { strict: false });
          await aiService.stopAnalysis(id).catch(() => undefined);
          const aiManager = this.moduleRef.get(AiManagerService, { strict: false });
          await aiManager.startCamera(id, { allowCameraTrigger: true }).catch(() => undefined);
        } catch {
          // IA indisponível: as zonas passam a valer no próximo start da análise.
        }
      })();
    }
    await this.auditService.log(
      user.id,
      'camera.update',
      'Camera',
      camera.id,
      { name: camera.name, siteId: camera.siteId, areaId: camera.areaId, groupId: camera.groupId, enabled: (camera as { enabled?: boolean }).enabled },
      req,
    );
    return camera;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    await this.accessControlService.assertCanAdminCamera(user, id);
    const camera = await this.camerasService.remove(id);
    await this.auditService.log(user.id, 'camera.delete', 'Camera', camera.id, { name: camera.name }, req);
    return camera;
  }

  @Roles(UserRole.OPERATOR)
  @Post(':id/test-connection')
  async testConnection(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    if (user.role === UserRole.OPERATOR) {
      const canRecord = await this.accessControlService.canRecordCamera(user, id);
      const canAdmin = await this.accessControlService.canAdminCamera(user, id);
      if (!canRecord && !canAdmin) {
        await this.accessControlService.assertCanRecordCamera(user, id);
      }
    }
    const result = await this.camerasService.testConnection(id);
    await this.auditService.log(user.id, 'camera.test_connection', 'Camera', id, { status: result.status }, req);
    return result;
  }

  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('internal/:id/status')
  async internalUpdateStatus(
    @Param('id') id: string,
    @Body() dto: { status: CameraStatus; lastSeenAt?: string },
  ) {
    return this.camerasService.updateStatus(id, dto.status, dto.lastSeenAt);
  }

  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('internal/:id/events')
  async internalRegisterEvent(
    @Param('id') id: string,
    @Body() dto: { type: string; severity?: string; message?: string; metadata?: any; value?: string | number; occurredAt?: string },
  ) {
    const metadata = {
      ...(dto.metadata ?? {}),
      ...(dto.value !== undefined ? { value: dto.value } : {}),
    };
    const event = await this.camerasService.registerEvent(
      id,
      dto.type,
      dto.severity ?? 'INFO',
      dto.message ?? `Evento ${dto.type} detectado`,
      metadata,
      dto.occurredAt ? new Date(dto.occurredAt) : undefined,
    );
    if (dto.type === 'MOTION_DETECTED') {
      await this.recordingManager.handleMotionDetected(id, metadata).catch(() => undefined);
    }
    return event;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RESTRIÇÃO COMERCIAL APLICADA NA FRONTEIRA QUE O WORKER LÊ.
  //
  // O worker legado tem DOIS motores de gravação: os comandos via Redis e um
  // laço próprio de 60s que grava toda câmera com `recordingEnabled=true`,
  // consultando só este endpoint. O caminho de comando já é barrado
  // (`start()` chama `assertFeature('localRecording')` antes de publicar), mas o
  // laço autônomo não passava por lugar nenhum que soubesse da política — então
  // uma instalação inadimplente continuava gravando.
  //
  // Publicar um "stop" NÃO resolveria: o laço relê este endpoint e reiniciaria a
  // gravação no ciclo seguinte, desfazendo o comando em até 60s. A correção
  // precisa mudar o que o worker LÊ.
  //
  // E a máscara é aplicada na RESPOSTA, não no banco. Zerar `recordingEnabled`
  // no Postgres destruiria a intenção do operador: quando o cliente voltasse a
  // pagar, ninguém saberia mais quais câmeras deviam gravar. Como overlay, a
  // restrição some sozinha e a gravação retoma exatamente o que estava
  // configurado.
  //
  // Latência de aplicação: até um ciclo do laço (60s). Aceitável para bloqueio
  // comercial — e o caminho de comando, esse, é imediato.
  // ───────────────────────────────────────────────────────────────────────────
  private async maskRecordingWhenRestricted<T extends { recordingEnabled?: boolean }>(
    cameras: T[],
  ): Promise<T[]> {
    if (await this.commercialPolicy.isAllowed('localRecording')) return cameras;
    return cameras.map((camera) => ({ ...camera, recordingEnabled: false }));
  }

  @Public()
  @UseGuards(ServiceTokenGuard)
  @Get('internal/list')
  async internalList() {
    return this.maskRecordingWhenRestricted(await this.camerasService.findAllInternal());
  }

  // Consulta de UMA câmera para o worker. Existe para matar um N+1 real: o laço
  // de gravação chamava a lista COMPLETA (com joins de site/área/grupo) uma vez
  // por segmento POR CÂMERA — num parque de 200 câmeras isso é 200 respostas de
  // 200 registros a cada virada de segmento, crescendo ao quadrado.
  //
  // Declarado DEPOIS de `internal/list` de propósito: as duas rotas têm dois
  // segmentos, e o Express casa na ordem de declaração — invertido, `:id`
  // engoliria `list`.
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Get('internal/:id')
  async internalOne(@Param('id') id: string) {
    const camera = await this.camerasService.findOneInternal(id);
    if (!camera) throw new NotFoundException('Camera não encontrada.');
    const [masked] = await this.maskRecordingWhenRestricted([camera]);
    return masked;
  }

  @Roles(UserRole.VIEWER)
  @Get(':id/status')
  async getStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.accessControlService.assertCanViewCamera(user, id);
    return this.camerasService.getStatus(id);
  }

}
