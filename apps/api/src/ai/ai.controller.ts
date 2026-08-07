import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiService } from './ai.service';
import { AiManagerService } from './ai-manager.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { AccessControlService } from '../access-control/access-control.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { RequirePermission } from '../role-permissions/require-permission.decorator';

type UpdateAiSettingsBody = {
  enabled?: boolean;
  mode?: string;
  /** Desenhar a caixa do objeto sobre o vídeo ao vivo (preferência operacional). */
  showObjectBox?: boolean;
};

type LiveViewLeaseBody = {
  sessionId?: string;
  ttlSeconds?: number;
  viewMode?: 'selected' | 'grid';
};

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly aiManagerService: AiManagerService,
    private readonly accessControlService: AccessControlService,
    private readonly commercialPolicy: CommercialPolicyService,
  ) {}

  @Roles(UserRole.OPERATOR)
  @Get('health')
  async getHealth(@CurrentUser() user: AuthUser) {
    const [health, accessibleCameraIds] = await Promise.all([
      this.aiService.getHealth(),
      this.accessControlService.getAccessibleCameraIds(user),
    ]);
    if (!health || typeof health !== 'object') return health;
    const allowed = new Set(accessibleCameraIds);
    const processors = health.processors && typeof health.processors === 'object'
      ? Object.fromEntries(Object.entries(health.processors as Record<string, unknown>).filter(([cameraId]) => allowed.has(cameraId)))
      : {};
    return {
      ...health,
      active_processors: Array.isArray(health.active_processors)
        ? health.active_processors.filter((cameraId: unknown) => typeof cameraId === 'string' && allowed.has(cameraId))
        : Object.keys(processors),
      degraded_processors: Array.isArray(health.degraded_processors)
        ? health.degraded_processors.filter((cameraId: unknown) => typeof cameraId === 'string' && allowed.has(cameraId))
        : [],
      processors,
    };
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Get('rollout/summary')
  async getRolloutSummary() {
    return this.aiService.getRolloutSummary();
  }

  @Roles(UserRole.OPERATOR)
  @Get('settings')
  async getSettings() {
    return this.aiManagerService.getSettings();
  }

  /**
   * ONDE a detecção de objeto roda, e por quê.
   *
   * A tela precisa explicar cada decisão — "sem linha desenhada", "desligado
   * pelo operador", "não liberado para esta instalação" pedem ações
   * diferentes, e mostrar só um interruptor apagado não diria qual.
   */
  @Roles(UserRole.OPERATOR)
  @Get('escopo-objeto')
  async getEscopoDeObjeto() {
    return this.aiManagerService.escopoDeObjeto();
  }

  @Roles(UserRole.OPERATOR)
  @Get('intelligence')
  async getIntelligence(@CurrentUser() user: AuthUser) {
    const accessibleCameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    return this.aiManagerService.getIntelligenceOverview(accessibleCameraIds);
  }

  @Roles(UserRole.OPERATOR)
  @Get('intelligence/cameras/:cameraId')
  async getCameraIntelligence(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    return this.aiManagerService.getCameraIntelligence(cameraId);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Patch('settings')
  async updateSettings(@Body() body: UpdateAiSettingsBody) {
    return this.aiManagerService.updateSettings(body);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Post('sync')
  async sync() {
    await this.commercialPolicy.assertFeature('aiAdvanced');
    return this.aiManagerService.restartAll();
  }

  @Roles(UserRole.OPERATOR)
  @Post('intelligence/cameras/:cameraId/restart')
  async restartCamera(@CurrentUser() user: AuthUser, @Param('cameraId') cameraId: string) {
    await this.accessControlService.assertCanRecordCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('aiAdvanced', user);
    return this.aiManagerService.restartCamera(cameraId);
  }

  @Roles(UserRole.OPERATOR)
  @Post('start/:cameraId')
  async start(@CurrentUser() user: AuthUser, @Param('cameraId') cameraId: string) {
    await this.accessControlService.assertCanRecordCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('aiAdvanced', user);
    return this.aiManagerService.startCamera(cameraId);
  }

  @Roles(UserRole.OPERATOR)
  @Post('stop/:cameraId')
  async stop(@CurrentUser() user: AuthUser, @Param('cameraId') cameraId: string) {
    await this.accessControlService.assertCanRecordCamera(user, cameraId);
    return this.aiService.stopAnalysis(cameraId);
  }

  // Overlay de IA em lote: a página Live envia todas as câmeras visíveis de uma vez,
  // mantendo 1 requisição por ciclo de polling independentemente do tamanho da grade.
  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 600, ttl: 60000 } })
  @Get('detections/latest-batch')
  async latestDetectionsBatch(
    @CurrentUser() user: AuthUser,
    @Query('cameraIds') cameraIds?: string,
    @Query('maxAgeMs') maxAgeMs?: string,
    @Query('limit') limit?: string,
  ) {
    const requestedIds = (cameraIds ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 64);
    const accessibleIds = new Set(await this.accessControlService.getAccessibleCameraIds(user));
    const allowedIds = [...new Set(requestedIds.filter((id) => accessibleIds.has(id)))];
    const resolvedMaxAgeMs = Number.isFinite(Number(maxAgeMs)) ? Math.max(200, Math.min(30000, Number(maxAgeMs))) : 5000;
    const resolvedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Number(limit))) : 12;
    if (!allowedIds.length) {
      return { cameras: {}, generatedAt: new Date().toISOString() };
    }
    return this.aiService.getLatestDetectionsBatch(allowedIds, resolvedMaxAgeMs, resolvedLimit);
  }

  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 1200, ttl: 60000 } })
  @Get('detections/latest/:cameraId')
  async latestDetections(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Query('maxAgeMs') maxAgeMs?: string,
    @Query('limit') limit?: string,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const resolvedMaxAgeMs = Number.isFinite(Number(maxAgeMs)) ? Math.max(200, Math.min(30000, Number(maxAgeMs))) : 5000;
    const resolvedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Number(limit))) : 12;
    const snapshot = await this.aiService.getLatestDetections(cameraId, resolvedMaxAgeMs, resolvedLimit);
    if (snapshot?.status === 'not_running') {
      // Tenta auto-start quando a câmera participa da IA.
      const startResult = await this.aiManagerService.startCamera(cameraId, { liveAutoStart: true }).catch(() => ({ status: 'error' }));
      if (startResult?.status === 'disabled') {
        return { status: 'not_running', camera_id: cameraId, detections: [], reason: startResult.status };
      }
      return this.aiService.getLatestDetections(cameraId, resolvedMaxAgeMs, resolvedLimit);
    }
    return snapshot;
  }

  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 2400, ttl: 60000 } })
  @Post('live-view/start/:cameraId')
  async startLiveView(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Body() body: LiveViewLeaseBody,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const { sessionId, ttlSeconds, viewMode } = this.resolveLiveViewBody(body);
    const lease = await this.aiService.startLiveViewSession(cameraId, sessionId, ttlSeconds, viewMode);
    if (lease?.status !== 'not_running') return lease;

    const startResult = await this.aiManagerService.startCamera(cameraId, { liveAutoStart: true }).catch(() => ({ status: 'error' }));
    if (startResult?.status === 'disabled') {
      return { status: 'not_running', camera_id: cameraId, session_id: sessionId, reason: startResult.status };
    }
    return this.aiService.startLiveViewSession(cameraId, sessionId, ttlSeconds, viewMode);
  }

  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 3600, ttl: 60000 } })
  @Post('live-view/heartbeat/:cameraId')
  async heartbeatLiveView(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Body() body: LiveViewLeaseBody,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const { sessionId, ttlSeconds, viewMode } = this.resolveLiveViewBody(body);
    const lease = await this.aiService.heartbeatLiveViewSession(cameraId, sessionId, ttlSeconds, viewMode);
    if (lease?.status !== 'not_running') return lease;

    const startResult = await this.aiManagerService.startCamera(cameraId, { liveAutoStart: true }).catch(() => ({ status: 'error' }));
    if (startResult?.status === 'disabled') {
      return { status: 'not_running', camera_id: cameraId, session_id: sessionId, reason: startResult.status };
    }
    return this.aiService.startLiveViewSession(cameraId, sessionId, ttlSeconds, viewMode);
  }

  @Roles(UserRole.VIEWER)
  @Throttle({ default: { limit: 2400, ttl: 60000 } })
  @Post('live-view/stop/:cameraId')
  async stopLiveView(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Body() body: LiveViewLeaseBody,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const { sessionId } = this.resolveLiveViewBody(body);
    return this.aiService.stopLiveViewSession(cameraId, sessionId);
  }

  private resolveLiveViewBody(body: LiveViewLeaseBody) {
    const sessionId = String(body?.sessionId ?? '').trim();
    if (sessionId.length < 8 || sessionId.length > 128) {
      throw new BadRequestException('sessionId inválido');
    }
    const ttlInput = Number(body?.ttlSeconds);
    const ttlSeconds = Number.isFinite(ttlInput) ? Math.max(5, Math.min(120, Math.round(ttlInput))) : 20;
    const rawViewMode = String(body?.viewMode ?? '').trim().toLowerCase();
    const viewMode: 'selected' | 'grid' = rawViewMode === 'selected' ? 'selected' : 'grid';
    return { sessionId, ttlSeconds, viewMode };
  }
}
