import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { type Request, type Response } from 'express';
import { AccessControlService } from '../access-control/access-control.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { ListRecordingsQueryDto } from './dto/list-recordings-query.dto';
import { BulkThumbnailTokensDto } from './dto/bulk-thumbnail-tokens.dto';
import { BulkRecordingDiagnosticsDto } from './dto/bulk-recording-diagnostics.dto';
import { DownloadBatchDto } from './dto/download-batch.dto';
import { RegisterRecordingDto } from './dto/register-recording.dto';
import { StartRecordingDto } from './dto/start-recording.dto';
import { StopRecordingDto } from './dto/stop-recording.dto';
import { ServiceTokenGuard } from '../auth/guards/service-token.guard';
import { UseGuards } from '@nestjs/common';
import { RecordingProcessManagerService } from './recording-process-manager.service';
import { RecordingsService } from './recordings.service';
import { ExportClipDto } from './dto/export-clip.dto';
import { ExportRangeDto } from './dto/export-range.dto';
import { InvestigationsService } from '../investigations/investigations.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { ModuleRef } from '@nestjs/core';
import { AiManagerService } from '../ai/ai-manager.service';
import { AiService } from '../ai/ai.service';
import { envNumber } from '../common/config/env-number.helper';

@Controller()
export class RecordingsController {
  constructor(
    private readonly recordingManager: RecordingProcessManagerService,
    private readonly recordingsService: RecordingsService,
    private readonly investigationsService: InvestigationsService,
    private readonly authService: AuthService,
    private readonly accessControlService: AccessControlService,
    private readonly auditService: AuditService,
    private readonly commercialPolicy: CommercialPolicyService,
    // ModuleRef resolve AiManagerService/AiService em runtime, evitando o ciclo
    // de módulos Recordings→Ai→Cameras→Recordings (que o Nest não instancia).
    private readonly moduleRef: ModuleRef,
  ) {}

  private extractBearerToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') return null;
    if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
    const token = authHeader.slice(7).trim();
    return token || null;
  }

  private extractCookieToken(req: Request, cookieName: string): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const [keyRaw, ...valueParts] = part.trim().split('=');
      if (!keyRaw) continue;
      if (keyRaw !== cookieName) continue;
      const encoded = valueParts.join('=').trim();
      if (!encoded) return null;
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }
    return null;
  }

  @Roles(UserRole.OPERATOR)
  @Post('cameras/:cameraId/recording/start')
  async startRecording(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Body() dto: StartRecordingDto,
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanRecordCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localRecording', user);
    const defaultSegment = envNumber('RECORDING_SEGMENT_SECONDS', 300, { min: 5, max: 3600, integer: true });
    const segmentSeconds = dto.segmentSeconds ?? defaultSegment;
    const result = await this.recordingManager.start(cameraId, segmentSeconds, { recordingMode: 'manual' });
    await this.auditService.log(user.id, 'recording.start', 'Camera', cameraId, { status: result.status }, req);
    return result;
  }

  @Roles(UserRole.OPERATOR)
  @Post('cameras/:cameraId/recording/stop')
  async stopRecording(@CurrentUser() user: AuthUser, @Param('cameraId') cameraId: string, @Body() _dto: StopRecordingDto, @Req() req: Request) {
    await this.accessControlService.assertCanRecordCamera(user, cameraId);
    const result = await this.recordingManager.stop(cameraId, { recordingMode: 'manual' });
    await this.auditService.log(user.id, 'recording.stop', 'Camera', cameraId, { status: result.status }, req);
    return result;
  }

  @Roles(UserRole.OPERATOR)
  @Post('cameras/:cameraId/recording/motion')
  async setMotionRecording(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Body() body: { enabled?: boolean },
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanRecordCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localRecording', user);
    const enabled = body?.enabled !== false;
    const result = await this.recordingManager.setMotionRecording(cameraId, enabled);
    // Liga/desliga a detecção de movimento (leve, MOG2 — sem YOLO) APENAS nesta
    // câmera. Armar na aba de gravação passa a ser o liga/desliga por câmera:
    // sem câmera armada, o ai-service não analisa nada (custo zero). Best-effort:
    // se o ai-service estiver fora do ar, a gravação manual continua funcionando.
    if (enabled) {
      const aiManager = this.moduleRef.get(AiManagerService, { strict: false });
      await aiManager.startCamera(cameraId).catch(() => undefined);
    } else {
      const aiService = this.moduleRef.get(AiService, { strict: false });
      await aiService.stopAnalysis(cameraId).catch(() => undefined);
    }
    await this.auditService.log(user.id, enabled ? 'recording.motion.enable' : 'recording.motion.disable', 'Camera', cameraId, { status: result.status }, req);
    return result;
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('cameras/:cameraId/recording/status')
  async getRecordingStatus(@CurrentUser() user: AuthUser, @Param('cameraId') cameraId: string) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    return this.recordingManager.getStatus(cameraId);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings/statuses')
  async getRecordingStatuses(
    @CurrentUser() user: AuthUser,
    @Query('cameraIds') cameraIds?: string,
  ) {
    let ids = (cameraIds ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      const accessible = new Set(await this.accessControlService.getAccessibleCameraIds(user));
      ids = ids.length ? ids.filter((id) => accessible.has(id)) : [...accessible];
    } else if (!ids.length) {
      const all = await this.accessControlService.getAccessibleCameraIds(user);
      ids = all;
    }
    return this.recordingManager.getStatuses(ids);
  }

  @Roles(UserRole.OPERATOR)
  @Post('recordings/reconnect-stale')
  async reconnectStaleRecordings(
    @CurrentUser() user: AuthUser,
    @Body() body: { cameraIds?: string[] },
    @Req() req: Request,
  ) {
    await this.commercialPolicy.assertFeature('localRecording', user);
    const requestedIds = Array.isArray(body?.cameraIds) ? body.cameraIds.filter((id) => typeof id === 'string' && id.trim().length > 0) : [];
    let candidateIds: string[];
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      candidateIds = requestedIds;
      if (!candidateIds.length) {
        candidateIds = (await this.accessControlService.getAccessibleCameraIds(user)).slice(0, 500);
      }
    } else {
      const accessible = new Set(await this.accessControlService.getAccessibleCameraIds(user));
      candidateIds = requestedIds.length ? requestedIds.filter((id) => accessible.has(id)) : [...accessible].slice(0, 500);
    }

    const statuses = await this.recordingManager.getStatuses(candidateIds);
    const staleIds = statuses.items
      .filter((item: any) => item.stale && item.intendedRecording)
      .map((item: any) => item.cameraId as string);

    const results: Array<{ cameraId: string; status: 'restarted' | 'skipped'; reason?: string }> = [];
    for (const cameraId of staleIds) {
      try {
        await this.accessControlService.assertCanRecordCamera(user, cameraId);
        await this.recordingManager.stop(cameraId);
        const defaultSegment = envNumber('RECORDING_SEGMENT_SECONDS', 300, { min: 5, max: 3600, integer: true });
        await this.recordingManager.start(cameraId, defaultSegment);
        results.push({ cameraId, status: 'restarted' });
      } catch (error) {
        results.push({ cameraId, status: 'skipped', reason: (error as Error).message });
      }
    }

    await this.auditService.log(
      user.id,
      'recording.reconnect_stale.bulk',
      'Camera',
      null,
      {
        totalCandidates: candidateIds.length,
        totalStale: staleIds.length,
        restarted: results.filter((item) => item.status === 'restarted').length,
        skipped: results.filter((item) => item.status === 'skipped').length,
      },
      req,
    );

    return {
      totalCandidates: candidateIds.length,
      totalStale: staleIds.length,
      restarted: results.filter((item) => item.status === 'restarted').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      results,
    };
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings')
  async listRecordings(@CurrentUser() user: AuthUser, @Query() query: ListRecordingsQueryDto) {
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return this.recordingsService.list(query);
    }
    const ids = await this.accessControlService.getAccessibleCameraIds(user);
    return this.recordingsService.list(query, ids);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Delete('recordings')
  async deleteAllRecordings(@CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.recordingManager.stopAll();
    const result = await this.recordingsService.deleteAllRecordings();
    await this.auditService.log(user.id, 'recording.delete_all', 'Recording', null, result, req);
    return result;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Post('recordings/maintenance/reconcile')
  async reconcileRecordingMetadata(
    @CurrentUser() user: AuthUser,
    @Body() body: { limit?: number },
    @Req() req: Request,
  ) {
    const result = await this.recordingsService.reconcileRecordingMetadata(body?.limit ?? 2_000);
    await this.auditService.log(user.id, 'recording.metadata.reconcile', 'Recording', null, result, req);
    return result;
  }

  /**
   * `recordings:check` (item 2.4) — reconciliação bidirecional DB↔disco. Só RELATA
   * (não apaga nem adota nada): a decisão de agir é do operador. Sem esta rota o
   * método era inalcançável — existia mas não era executável.
   */
  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Post('recordings/maintenance/check-integrity')
  async checkRecordingIntegrity(
    @CurrentUser() user: AuthUser,
    @Body() body: { limit?: number },
    @Req() req: Request,
  ) {
    const result = await this.recordingsService.checkRecordingIntegrity(body?.limit ?? 100_000);
    await this.auditService.log(
      user.id,
      'recording.integrity.check',
      'Recording',
      null,
      { dbCount: result.dbCount, diskCount: result.diskCount, orfaosNoDisco: result.orfaosNoDisco.length, orfaosNoDb: result.orfaosNoDb.length },
      req,
    );
    return result;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Post('recordings/maintenance/thumbnails/backfill')
  async backfillRecordingThumbnails(
    @CurrentUser() user: AuthUser,
    @Body() body: { limit?: number },
    @Req() req: Request,
  ) {
    const result = await this.recordingsService.enqueueMissingThumbnails(body?.limit ?? 2_000);
    await this.auditService.log(user.id, 'recording.thumbnail.backfill', 'Recording', null, result, req);
    return result;
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings/health-summary')
  async getRecordingHealthSummary(
    @CurrentUser() user: AuthUser,
    @Query('date') date?: string,
    @Query('cameraId') cameraId?: string,
    @Query('brokenAlertThreshold') brokenAlertThreshold?: string,
  ) {
    if (cameraId) {
      await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    const accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? undefined
        : await this.accessControlService.getAccessibleCameraIds(user);
    const threshold = brokenAlertThreshold ? Number(brokenAlertThreshold) : undefined;
    return this.recordingsService.getRecordingHealthSummary({
      date,
      cameraId,
      accessibleCameraIds,
      brokenAlertThreshold: Number.isFinite(threshold) ? threshold : undefined,
    });
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings/gaps-report')
  async getRecordingGapsReport(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId?: string,
    @Query('date') date?: string,
  ) {
    if (!cameraId) {
      throw new BadRequestException('cameraId é obrigatório.');
    }
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? undefined
        : await this.accessControlService.getAccessibleCameraIds(user);
    return this.recordingsService.getRecordingGapsReport({
      cameraId,
      date,
      accessibleCameraIds,
    });
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings/playback-readiness')
  async getPlaybackReadiness(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId?: string,
    @Query('date') date?: string,
  ) {
    if (!cameraId) {
      throw new BadRequestException('cameraId é obrigatório.');
    }
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? undefined
        : await this.accessControlService.getAccessibleCameraIds(user);
    return this.recordingsService.getPlaybackReadinessReport({
      cameraId,
      date,
      accessibleCameraIds,
    });
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings/storage-usage')
  async getStorageUsage(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cameraId') cameraId?: string,
  ) {
    if (cameraId) {
      await this.accessControlService.assertCanViewCamera(user, cameraId);
    }
    const accessibleCameraIds =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? undefined
        : await this.accessControlService.getAccessibleCameraIds(user);
    return this.recordingsService.getStorageUsageAnalytics({
      from,
      to,
      cameraId,
      accessibleCameraIds,
    });
  }

  // VOD CONTÍNUO (ADITIVO) — UMA playlist HLS por INTERVALO, listando os vários
  // segmentos já gravados, para o player ver um vídeo contínuo em vez de trocar
  // de arquivo (e recarregar) a cada gravação. O playback atual continua igual:
  // este endpoint só ACRESCENTA uma forma de consumir os MESMOS arquivos, pelo
  // MESMO `/recordings/:id/play` e com o MESMO token de playback.
  //
  // O gate de conteúdo da câmera (invariante 1.2.i — câmera privada: admin
  // gerencia mas NÃO vê) é aplicado ANTES de montar qualquer coisa.
  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get(['recordings/vod.m3u8', 'recordings/vod'])
  async getVodPlaylist(
    @CurrentUser() user: AuthUser,
    @Query('cameraId') cameraId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!cameraId) {
      throw new BadRequestException('cameraId é obrigatório.');
    }
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const result = await this.recordingsService.buildVodPlaylist(user, { cameraId, from, to });
    await this.auditService.log(user.id, 'playback.vod.playlist', 'Camera', cameraId, {
      from: result.from,
      to: result.to,
      segments: result.segmentCount,
      discontinuities: result.discontinuities,
      truncated: result.truncated,
    }, req);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Drac-Vod-Start-Offset-Seconds', String(result.startOffsetSeconds));
    res.setHeader('X-Drac-Vod-Total-Duration-Seconds', String(result.totalDurationSeconds));
    res.setHeader('X-Drac-Vod-Segments', String(result.segmentCount));
    if (String(format ?? '').toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const { playlist: _playlist, ...plan } = result;
      return res.json(plan);
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(result.playlist);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Post('recordings/:id/play-token')
  async createPlayToken(
    @CurrentUser() user: AuthUser,
    @Param('id') recordingId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const recording = await this.recordingsService.ensureRecordingExists(recordingId);
    await this.accessControlService.assertCanViewCamera(user, recording.cameraId);
    const token = await this.authService.createPlaybackToken(user.id, recordingId);
    const expiresAtMs = token.expiresAt ? new Date(token.expiresAt).getTime() : Date.now() + 5 * 60 * 1000;
    const maxAgeMs = Math.max(60_000, expiresAtMs - Date.now());
    // COOKIE_SECURE permite forçar o valor quando produção roda sem TLS (ex: atrás de
    // proxy HTTP interno); sem essa variável, o cookie nunca seria salvo pelo browser
    // e o playback quebraria silenciosamente.
    const secure = process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE.toLowerCase() === 'true'
      : String(process.env.NODE_ENV ?? '').toLowerCase() === 'production';
    res.cookie('vms_play_token', token.playToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/recordings',
      maxAge: maxAgeMs,
    });
    await this.auditService.log(user.id, 'playback.token.create', 'Recording', recordingId, null, req);
    return token;
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings/:id/diagnostics')
  async getDiagnostics(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanViewCamera(user, recording.cameraId);
    return this.recordingsService.getRecordingDiagnostics(id);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings/:id/integrity')
  async getIntegrity(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanViewCamera(user, recording.cameraId);
    return this.recordingsService.getRecordingIntegrity(id);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Post('recordings/:id/compatible/prepare')
  async prepareCompatiblePlayback(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanViewCamera(user, recording.cameraId);
    const result = await this.recordingsService.prepareCompatiblePlayback(id);
    await this.auditService.log(user.id, 'playback.compatible.prepare', 'Recording', id, {
      sizeBytes: result.sizeBytes,
      compatibleCached: result.compatibleCached,
    }, req);
    return result;
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('exportEvidence')
  @Get('recordings/:id/snapshot')
  async snapshotFrame(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('seconds') seconds: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanPlaybackCamera(user, recording.cameraId);
    const frameSeconds = Math.max(0, Math.floor(Number(seconds ?? 0)));
    await this.auditService.log(user.id, 'recording.snapshot', 'Recording', id, { seconds: frameSeconds }, req);
    return this.recordingsService.streamSnapshotFrame(id, frameSeconds, res);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Post('recordings/thumbnail-tokens')
  async createThumbnailTokens(@CurrentUser() user: AuthUser, @Body() dto: BulkThumbnailTokensDto) {
    return this.recordingsService.createThumbnailTokens(user, dto.recordingIds);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Post('recordings/diagnostics/bulk')
  async getBulkDiagnostics(@CurrentUser() user: AuthUser, @Body() dto: BulkRecordingDiagnosticsDto) {
    const ids = [...new Set(dto.recordingIds)].slice(0, 120);
    for (const id of ids) {
      const recording = await this.recordingsService.ensureRecordingExists(id);
      await this.accessControlService.assertCanViewCamera(user, recording.cameraId);
    }
    return this.recordingsService.getRecordingDiagnosticsBulk(ids, Boolean(dto.includeIntegrity));
  }

  @Public()
  @Get('recordings/:id/play')
  async playRecording(
    @Param('id') id: string,
    @Query('token') token: string | undefined,
    @Query('compatible') compatible: string | undefined,
    @Query('forceDirect') forceDirect: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const bearerToken = this.extractBearerToken(req);
    const cookieToken = this.extractCookieToken(req, 'vms_play_token');
    const tokenValue = token?.trim() || bearerToken || cookieToken;
    if (!tokenValue) {
      throw new UnauthorizedException('Token de playback ausente.');
    }
    const payload = await this.authService.verifyPlaybackToken(tokenValue);
    if (payload.recordingId !== id) {
      throw new UnauthorizedException('Token inválido para esta gravação.');
    }
    const tokenUser = await this.authService.me(payload.sub);
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanPlaybackCamera(tokenUser, recording.cameraId);
    const compatibleFlag = ['1', 'true', 'yes'].includes(String(compatible ?? '').toLowerCase());
    const forceDirectFlag = ['1', 'true', 'yes'].includes(String(forceDirect ?? '').toLowerCase());
    const autoPreferCompatible = forceDirectFlag ? false : await this.recordingsService.shouldPreferCompatiblePlayback(id);
    const useCompatible = compatibleFlag || autoPreferCompatible;
    await this.auditService.log(tokenUser.id, 'recording.play', 'Recording', id, {
      compatible: useCompatible,
      requestedCompatible: compatibleFlag,
      autoPreferCompatible,
      forceDirect: forceDirectFlag,
    }, req);
    if (useCompatible) {
      return this.recordingsService.streamRecordingCompatible(id, res);
    }
    return this.recordingsService.streamRecording(id, res, { allowAutoCompat: !forceDirectFlag });
  }

  // ALIAS ADITIVO de `/recordings/:id/play` com sufixo `.mp4` — MESMO handler,
  // MESMO token, MESMO gate (a rota original continua intacta).
  //
  // MOTIVO REAL, MEDIDO (ffprobe 8.0.1): player baseado em ffmpeg >= 7 RECUSA um
  // segmento de HLS cuja URL não termine em extensão de mídia conhecida —
  // "URL ... is not in allowed_segment_extensions". Sem este alias a playlist VOD
  // só tocaria no hls.js do navegador; com ele toca também em VLC/mpv/ffmpeg.
  @Public()
  @Get('recordings/:id/play.mp4')
  async playRecordingAsMp4(
    @Param('id') id: string,
    @Query('token') token: string | undefined,
    @Query('compatible') compatible: string | undefined,
    @Query('forceDirect') forceDirect: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.playRecording(id, token, compatible, forceDirect, req, res);
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('exportEvidence')
  @Get('recordings/:id/download')
  async downloadRecording(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanPlaybackCamera(user, recording.cameraId);
    await this.auditService.log(user.id, 'recording.download', 'Recording', id, { immediate: true }, req);
    return this.recordingsService.downloadRecording(id, res);
  }

  // Emite um token de curta duração para baixar várias gravações num único ZIP.
  // O download em si acontece no GET público abaixo, para que o navegador possa
  // usar o gerenciador de downloads nativo (progresso, retomada de UI, sem blob).
  @Roles(UserRole.OPERATOR)
  @RequirePermission('exportEvidence')
  @Post('recordings/download-batch-token')
  async createDownloadBatchToken(
    @CurrentUser() user: AuthUser,
    @Body() dto: DownloadBatchDto,
    @Req() req: Request,
  ) {
    const ids = [...new Set(dto.recordingIds)].slice(0, 50);
    for (const id of ids) {
      const recording = await this.recordingsService.ensureRecordingExists(id);
      await this.accessControlService.assertCanViewCamera(user, recording.cameraId);
    }
    const token = await this.authService.createDownloadZipToken(user.id, ids);
    await this.auditService.log(user.id, 'recording.download.batch_token', 'Recording', null, { count: ids.length }, req);
    return {
      ...token,
      downloadUrl: `/recordings/download-zip?token=${encodeURIComponent(token.downloadToken)}`,
      count: ids.length,
    };
  }

  @Public()
  @Get('recordings/download-zip')
  async downloadRecordingsZip(
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const tokenValue = token?.trim() || this.extractBearerToken(req);
    if (!tokenValue) {
      throw new UnauthorizedException('Token de download ausente.');
    }
    const payload = await this.authService.verifyDownloadZipToken(tokenValue);
    const tokenUser = await this.authService.me(payload.sub);
    for (const id of payload.recordingIds) {
      const recording = await this.recordingsService.ensureRecordingExists(id);
      await this.accessControlService.assertCanViewCamera(tokenUser, recording.cameraId);
    }
    await this.auditService.log(tokenUser.id, 'recording.download.zip', 'Recording', null, { count: payload.recordingIds.length }, req);
    return this.recordingsService.downloadRecordingsZip(payload.recordingIds, res);
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('exportEvidence')
  @Post('recordings/:id/clips/export')
  async exportClip(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ExportClipDto,
    @Req() req: Request,
  ) {
    const exportReason = dto.notes?.trim() ?? '';
    if (!exportReason) throw new BadRequestException('Motivo é obrigatório para exportar clip.');
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanPlaybackCamera(user, recording.cameraId);
    const clip = await this.recordingsService.exportClip(user, id, dto);

    let investigationItemId: string | null = null;
    if (dto.investigationId) {
      const item = await this.investigationsService.addItem(user, dto.investigationId, {
        type: 'clip',
        label: dto.label?.trim() || `Clip exportado — ${recording.camera.name}`,
        cameraId: recording.cameraId,
        cameraName: recording.camera.name,
        recordingId: recording.id,
        timestamp: clip.startedAt.toISOString(),
        notes: dto.notes,
        metadata: {
          clipId: clip.id,
          downloadUrl: clip.downloadUrl,
          startSeconds: dto.startSeconds,
          endSeconds: dto.endSeconds,
          sourceRecordingId: recording.id,
        },
      });
      investigationItemId = item.id;
    }

    await this.auditService.log(
      user.id,
      'recording.clip.export',
      'Recording',
      id,
      { clipId: clip.id, investigationId: dto.investigationId ?? null, reason: exportReason },
      req,
    );
    return { ...clip, investigationItemId };
  }

  // Exportação por INTERVALO, atravessando segmentos (achado da análise do
  // Frigate). Enfileira e volta na hora: o FFmpeg roda no worker, com prioridade
  // rebaixada e concorrência limitada, para não disputar CPU com a GRAVAÇÃO.
  @Roles(UserRole.OPERATOR)
  @RequirePermission('exportEvidence')
  @Post('cameras/:cameraId/recordings/export-range')
  async exportRange(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Body() dto: ExportRangeDto,
    @Req() req: Request,
  ) {
    const exportReason = dto.notes?.trim() ?? '';
    if (!exportReason) throw new BadRequestException('Motivo é obrigatório para exportar por intervalo.');
    await this.accessControlService.assertCanPlaybackCamera(user, cameraId);
    const result = await this.recordingsService.enqueueCameraRangeExport(user, {
      cameraId,
      from: dto.from,
      to: dto.to,
      profile: dto.profile,
      reason: exportReason,
      label: dto.label ?? null,
    });
    await this.auditService.log(
      user.id,
      'recording.range.export.enqueue',
      'Camera',
      cameraId,
      {
        jobId: result.jobId,
        from: dto.from,
        to: dto.to,
        profile: dto.profile ?? 'auto',
        status: result.status,
        reason: exportReason,
      },
      req,
    );
    return result;
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('exportEvidence')
  @Get('recordings/exports/:jobId')
  async getRangeExportStatus(@CurrentUser() user: AuthUser, @Param('jobId') jobId: string) {
    return this.recordingsService.getCameraRangeExportStatus(user, jobId);
  }

  @Roles(UserRole.OPERATOR)
  @RequirePermission('exportEvidence')
  @Get('recordings/clips/:clipId/download')
  async downloadExportedClip(
    @CurrentUser() user: AuthUser,
    @Param('clipId') clipId: string,
    @Query('reason') reason: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const cleanReason = reason?.trim() ?? '';
    if (!cleanReason) throw new BadRequestException('Motivo é obrigatório para download de clip.');
    const clip = await this.recordingsService.ensureExportedClipExists(clipId);
    await this.accessControlService.assertCanViewCamera(user, clip.cameraId);
    await this.auditService.log(
      user.id,
      'clip.download',
      'ExportedClip',
      clipId,
      { sourceRecordingId: clip.sourceRecordingId, reason: cleanReason },
      req,
    );
    return this.recordingsService.downloadExportedClip(clipId, res);
  }

  @Public()
  @Get('recordings/:id/thumbnail')
  async getThumbnail(
    @Param('id') id: string,
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const bearerToken = this.extractBearerToken(req);
    const cookieToken = this.extractCookieToken(req, 'vms_play_token');
    const tokenValue = token?.trim() || bearerToken || cookieToken;
    if (!tokenValue) {
      throw new UnauthorizedException('Token de thumbnail ausente.');
    }
    const payload = await this.authService.verifyPlaybackToken(tokenValue);
    if (payload.recordingId !== id) {
      throw new UnauthorizedException('Token inválido para esta gravação.');
    }
    const tokenUser = await this.authService.me(payload.sub);
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanPlaybackCamera(tokenUser, recording.cameraId);
    return this.recordingsService.streamThumbnail(id, res);
  }

  @Roles(UserRole.OPERATOR)
  @Post('recordings/:id/thumbnail/regenerate')
  async regenerateThumbnail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanRecordCamera(user, recording.cameraId);
    return this.recordingsService.enqueueThumbnailGeneration(id, true);
  }

  // 2.9 — Metadados do sprite de scrubbing (grid/intervalo). Autenticado e
  // atrás do MESMO gate de conteúdo por câmera (câmera privada herda o gate).
  @Roles(UserRole.VIEWER)
  @RequirePermission('playback')
  @Get('recordings/:id/preview-meta')
  async getTimelinePreviewMeta(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanPlaybackCamera(user, recording.cameraId);
    return this.recordingsService.getTimelinePreviewMeta(id);
  }

  // 2.9 — Sprite (mosaico low-res) para varrer a timeline. Mesmo gate do
  // thumbnail: token de playback da própria gravação + assertCanViewCamera, de
  // modo que derivados de câmera privada NUNCA vazam (invariante LGPD 1.2.i).
  @Public()
  @Get('recordings/:id/preview-sprite')
  async getTimelinePreviewSprite(
    @Param('id') id: string,
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const bearerToken = this.extractBearerToken(req);
    const cookieToken = this.extractCookieToken(req, 'vms_play_token');
    const tokenValue = token?.trim() || bearerToken || cookieToken;
    if (!tokenValue) {
      throw new UnauthorizedException('Token de preview ausente.');
    }
    const payload = await this.authService.verifyPlaybackToken(tokenValue);
    if (payload.recordingId !== id) {
      throw new UnauthorizedException('Token inválido para esta gravação.');
    }
    const tokenUser = await this.authService.me(payload.sub);
    const recording = await this.recordingsService.ensureRecordingExists(id);
    await this.accessControlService.assertCanPlaybackCamera(tokenUser, recording.cameraId);
    return this.recordingsService.streamTimelinePreview(id, res);
  }

  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('recordings/internal/register')
  async registerInternal(@Body() dto: RegisterRecordingDto) {
    return this.recordingsService.registerInternal(dto);
  }
}
