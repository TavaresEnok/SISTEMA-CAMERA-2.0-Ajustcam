import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { type Request, type Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AccessControlService } from '../access-control/access-control.service';
import { AuthService } from '../auth/auth.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { timingSafeTextEquals } from '../common/security/timing-safe.helper';
import { Roles } from '../auth/decorators/roles.decorator';
import { type AuthUser } from '../common/types/auth-user.type';
import { RequirePermission } from '../role-permissions/require-permission.decorator';
import { createReadStream } from 'node:fs';
import { ClipCaptureService } from './clip-capture.service';
import { FfmpegMjpegService } from './ffmpeg-mjpeg.service';
import { MediamtxProxyService } from './mediamtx-proxy.service';
import { StreamResourceAdvisorService } from './stream-resource-advisor.service';
import { assessLiveReadiness } from './helpers/live-readiness.helper';
import { CamerasService } from '../cameras/cameras.service';
import {
  GRID_LIVE_MAX_HEIGHT,
  GRID_LIVE_MAX_WIDTH,
  GRID_LIVE_TARGET_FPS,
  normalizeLiveViewMode,
} from './helpers/live-delivery-profile.helper';
import {
  isHevcCodec,
  resolveDeliveryRtspProfile,
  resolveDeliveryVideoCodec,
  resolveLiveRtspProfile,
  resolveOriginalRtspProfile,
  resolveOriginalVideoCodec,
} from '../cameras/helpers/rtsp-url.helper';

type LiveProtocol = 'auto' | 'flv' | 'hls' | 'llhls' | 'webrtc' | 'mjpeg';
type MediaMtxAuthRequest = {
  user?: string;
  password?: string;
  token?: string;
  action?: string;
  path?: string;
  protocol?: string;
  ip?: string;
};

export function isLoopbackMediaWorkerAuthorized(body: MediaMtxAuthRequest) {
  const action = String(body?.action ?? '');
  const path = String(body?.path ?? '');
  const sourcePath = /^cam_[0-9a-f]{32}(?:_grid|_orig)?_source$/i.test(path);
  const outputPath = /^cam_[0-9a-f]{32}(?:_grid|_orig)?$/i.test(path);
  const loopback =
    body?.ip === '127.0.0.1'
    || body?.ip === '::1'
    || body?.ip === '::ffff:127.0.0.1';
  return (
    loopback
    && (
      (sourcePath && (action === 'read' || action === 'playback'))
      || (outputPath && action === 'publish')
    )
  );
}

@Controller('camera-stream')
export class CameraStreamController {
  constructor(
    private readonly ffmpegMjpegService: FfmpegMjpegService,
    private readonly clipCaptureService: ClipCaptureService,
    private readonly mediamtxProxyService: MediamtxProxyService,
    private readonly camerasService: CamerasService,
    private readonly authService: AuthService,
    private readonly accessControlService: AccessControlService,
    private readonly auditService: AuditService,
    private readonly commercialPolicy: CommercialPolicyService,
    private readonly streamResourceAdvisor: StreamResourceAdvisorService,
    private readonly configService: ConfigService,
  ) {}

  private extractBearerToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') return null;
    if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
    const token = authHeader.slice(7).trim();
    return token || null;
  }

  private supportsHevcWebPlayback(req: Request) {
    const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
    const isAppleDevice = /iphone|ipad|ipod|macintosh|mac os x/.test(ua);
    const isSafariFamily =
      ua.includes('safari') &&
      !ua.includes('chrome') &&
      !ua.includes('chromium') &&
      !ua.includes('crios') &&
      !ua.includes('fxios') &&
      !ua.includes('edgios') &&
      !ua.includes('opr') &&
      !ua.includes('opera');
    return isAppleDevice && isSafariFamily;
  }

  private resolveApiPublicBase(req: Request) {
    const configured = String(
      this.configService.get<string>('apiPublicUrl') ?? process.env.API_PUBLIC_URL ?? '',
    ).trim().replace(/\/+$/, '');
    if (configured) return configured;

    const hostHeader = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost:3000';
    const apiHost = hostHeader.split(',')[0].trim();
    const reqProto = ((req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http')
      .split(',')[0]
      .trim();
    return `${reqProto}://${apiHost}`;
  }

  @Public()
  @SkipThrottle()
  @Post('mediamtx-auth')
  async authorizeMediaMtx(
    @Body() body: MediaMtxAuthRequest,
    @Query('internalToken') internalToken: string | undefined,
    @Res() res: Response,
  ) {
    const deny = (message: string) => res.status(401).json({ message });
    const expectedCallbackToken = (
      this.configService.get<string>('mediaMtxAuthCallbackToken') ?? ''
    ).trim();
    if (
      expectedCallbackToken.length < 32
      || !internalToken
      || !timingSafeTextEquals(internalToken, expectedCallbackToken)
    ) {
      return deny('Callback de mídia não autenticado.');
    }

    const expectedUser = (this.configService.get<string>('mediaMtxApiUser') ?? '').trim();
    const expectedPass = (this.configService.get<string>('mediaMtxApiPass') ?? '').trim();
    const suppliedUser = String(body?.user ?? '');
    const suppliedPass = String(body?.password ?? '');
    const action = String(body?.action ?? '');

    // O runOnDemand nasce dentro do próprio container MediaMTX. Ele lê apenas o
    // path oculto `_source` e publica apenas no path público correspondente.
    // Assim os URLs usados no argv não carregam nem a senha da câmera nem a
    // credencial administrativa do MediaMTX.
    if (isLoopbackMediaWorkerAuthorized(body)) {
      return res.status(200).json({ authorized: true });
    }

    // Processos internos (API, métricas e publishers FFmpeg) continuam usando a
    // credencial administrativa já existente. O endpoint só é chamado pela rede
    // interna do Compose (o nginx o bloqueia com 404 na borda), mas a credencial
    // ainda é obrigatória — e a comparação é em tempo constante: acertá-la libera
    // read E publish em QUALQUER path, ignorando streamToken e ACL.
    if (
      expectedUser &&
      expectedPass &&
      timingSafeTextEquals(suppliedUser, expectedUser) &&
      timingSafeTextEquals(suppliedPass, expectedPass)
    ) {
      return res.status(200).json({ authorized: true });
    }

    if (action !== 'read' && action !== 'playback') {
      return deny('Ação de mídia não autorizada.');
    }

    const match = /^cam_([0-9a-f]{32})(?:_grid|_orig)?$/i.exec(String(body?.path ?? ''));
    if (!match) return deny('Caminho de mídia inválido.');

    const token = String(body?.token ?? '').trim();
    if (!token) return deny('Token de mídia ausente.');

    try {
      const payload = await this.authService.verifyStreamToken(token);
      const tokenCameraId = payload.cameraId.replace(/-/g, '').toLowerCase();
      if (tokenCameraId !== match[1].toLowerCase()) {
        return deny('Token não corresponde à câmera.');
      }
      return res.status(200).json({ authorized: true });
    } catch {
      return deny('Token de mídia inválido ou expirado.');
    }
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Post(':cameraId/token')
  async createStreamToken(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localLive', user);
    if (((await this.camerasService.getCameraOrThrow(cameraId)) as { enabled?: boolean }).enabled === false) {
      throw new BadRequestException('Câmera desativada.');
    }
    const token = await this.authService.createStreamToken(user.id, cameraId);
    await this.auditService.log(user.id, 'stream.token.create', 'Camera', cameraId, null, req);
    return token;
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Get('stats')
  async getGlobalStats() {
    return this.ffmpegMjpegService.getStreamStats();
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('serverConfig')
  @Get(':cameraId/stats')
  async getCameraStats(@Param('cameraId') cameraId: string) {
    return this.ffmpegMjpegService.getStreamStats(cameraId);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Get('resource-diagnostics')
  async getResourceDiagnostics(@CurrentUser() user: AuthUser) {
    const accessibleCameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    return this.streamResourceAdvisor.getFleetReport(accessibleCameraIds);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Get('optimization-plan')
  async getOptimizationPlan(@CurrentUser() user: AuthUser) {
    const accessibleCameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    return this.streamResourceAdvisor.getOptimizationPlan(accessibleCameraIds);
  }

  @Roles(UserRole.ADMIN)
  @RequirePermission('cameraConfig')
  @Post('optimization/apply-safe')
  async applySafeOptimization(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const accessibleCameraIds = await this.accessControlService.getAccessibleCameraIds(user);
    const result = await this.streamResourceAdvisor.applySafeOptimizations(accessibleCameraIds);
    await this.auditService.log(user.id, 'stream.optimization.apply_safe', 'Camera', null, result as any, req);
    return result;
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Get(':cameraId/resource-diagnostics')
  async getCameraResourceDiagnostics(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    return this.streamResourceAdvisor.getCameraReport(cameraId);
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Post(':cameraId/live-failure')
  async recordLiveFailure(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Body() body: { protocol?: string; reason?: string; stage?: string; state?: string },
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    const protocol = String(body?.protocol || 'unknown').slice(0, 32);
    const stage = String(body?.stage || 'startup').slice(0, 64);
    const reason = String(body?.reason || 'Falha de live sem detalhe informado.').slice(0, 500);
    const state = String(body?.state || '').slice(0, 64) || null;
    await this.auditService.log(user.id, 'stream.live.failure', 'Camera', cameraId, {
      protocol,
      stage,
      reason,
      state,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 240),
    }, req);
    return { accepted: true, cameraId, protocol, stage };
  }

  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Get(':cameraId/urls')
  async getDeliveryUrls(
    @CurrentUser() user: AuthUser,
    @Param('cameraId') cameraId: string,
    @Query('viewMode') rawViewMode: string | undefined,
    @Req() req: Request,
  ) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localLive', user);
    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    if ((camera as { enabled?: boolean }).enabled === false) {
      throw new BadRequestException('Câmera desativada. Reative-a nas configurações para ver ao vivo.');
    }
    const token = await this.authService.createStreamToken(user.id, cameraId);
    const viewMode = normalizeLiveViewMode(rawViewMode);

    // Atualiza metadados em segundo plano. Abrir uma live nunca deve esperar
    // uma sonda RTSP/ffprobe, que pode levar vários segundos em câmera instável.
    if (!camera.detectedVideoCodec || !camera.detectedWidth || !camera.detectedHeight) {
      void this.camerasService.getStatus(cameraId).catch(() => undefined);
    }

    let mediaBridge = this.mediamtxProxyService.buildPublicUrls(req, null, null);
    let measuredLiveCodec: string | null = null;
    let liveTranscodedForBrowser = false;
    let effectiveDeliveryProfile = resolveDeliveryRtspProfile(camera);
    if (this.mediamtxProxyService.isEnabled()) {
      try {
        const ensured = await this.mediamtxProxyService.ensurePathForCamera(cameraId, viewMode);
        mediaBridge = this.mediamtxProxyService.buildPublicUrls(req, ensured.pathName, ensured.sourceUrl);
        measuredLiveCodec = ensured.sourceVideoCodec;
        liveTranscodedForBrowser = ensured.transcodedForLive;
        effectiveDeliveryProfile = ensured.liveProfile ?? effectiveDeliveryProfile;
      } catch {
        mediaBridge = this.mediamtxProxyService.buildPublicUrls(req, null, null);
      }
    }

    const hostHeader = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost:3000';
    const apiHost = hostHeader.split(',')[0].trim();
    const reqProto = ((req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http')
      .split(',')[0]
      .trim();
    const apiPublicBase = this.resolveApiPublicBase(req);
    const flvUrl = `${apiPublicBase}/camera-stream/${cameraId}/flv`;
    const posterUrl = `${apiPublicBase}/camera-stream/${cameraId}/poster`;

    const configuredPreferred = (camera.preferredLiveProtocol ?? 'webrtc').toLowerCase();
    const configuredCodec = camera.streamVideoCodec ?? null;
    const originalCodec = resolveOriginalVideoCodec(camera);
    const sourceCodec = measuredLiveCodec ?? resolveDeliveryVideoCodec(camera);
    const liveProfile = resolveLiveRtspProfile(camera);
    const originalProfile = resolveOriginalRtspProfile(camera);
    const deliveryProfile = effectiveDeliveryProfile;
    const smartOriginalEnabled = liveTranscodedForBrowser || isHevcCodec(sourceCodec);
    const supportsOriginalOnClient = this.supportsHevcWebPlayback(req);

    const { sourceUrl: _sourceUrl, ...safeMediaBridge } = mediaBridge;
    const requestOrigin = `${reqProto}://${apiHost}`;
    const liveReadiness = assessLiveReadiness({
      requestOrigin,
      publicAppUrl: process.env.PUBLIC_APP_URL || null,
      mediamtxEnabled: this.mediamtxProxyService.isEnabled(),
      pathReady: Boolean(safeMediaBridge.enabled && safeMediaBridge.pathName),
      whepUrl: safeMediaBridge.whepUrl,
      hlsUrl: safeMediaBridge.hlsUrl,
      webrtcAllowOrigin: process.env.MEDIAMTX_WEBRTC_ALLOW_ORIGIN || null,
    });
    const fallbackManualOrder: LiveProtocol[] = (() => {
      switch (configuredPreferred as LiveProtocol) {
        case 'webrtc':
          return ['webrtc', 'llhls', 'hls'];
        case 'llhls':
          return ['llhls', 'hls', 'webrtc'];
        case 'hls':
          return ['hls', 'llhls', 'webrtc'];
        case 'flv':
          // FLV legado: mantém compatibilidade de leitura, mas força rota HTTP estável.
          return ['llhls', 'hls', 'webrtc'];
        case 'auto':
          return ['webrtc', 'llhls', 'hls'];
        default:
          return ['webrtc', 'llhls', 'hls'];
      }
    })();

    const protocolOrder: LiveProtocol[] = smartOriginalEnabled
      ? ['webrtc', 'llhls', 'hls']
      : fallbackManualOrder;

    return {
      cameraId,
      streamToken: token.streamToken,
      streamTokenExpiresAt: token.expiresAt,
      preferredLiveProtocol: configuredPreferred,
      preferredRtspTransport: camera.preferredRtspTransport ?? 'tcp',
      configuredVideoCodec: configuredCodec,
      sourceVideoCodec: sourceCodec,
      detectedVideoCodec: sourceCodec, // retrocompatibilidade no frontend
      originalVideoCodec: originalCodec,
      liveProfile,
      originalProfile,
      deliveryProfile,
      deliveryMode: viewMode,
      deliveryTarget: viewMode === 'grid'
        ? {
            maxWidth: GRID_LIVE_MAX_WIDTH,
            maxHeight: GRID_LIVE_MAX_HEIGHT,
            targetFps: GRID_LIVE_TARGET_FPS,
            browserCodec: 'h264',
          }
        : {
            originalResolution: true,
            originalFps: true,
            browserCodec: 'h264',
          },
      smartLive: {
        enabled: smartOriginalEnabled,
        supportsOriginalOnClient,
        recommendedProtocol: protocolOrder[0],
        protocolOrder,
        reason: smartOriginalEnabled
          ? 'Perfil Live recebido em HEVC; navegador recebe H.264, enquanto gravação permanece no perfil H.265 dedicado.'
          : configuredPreferred === 'webrtc'
            ? 'WebRTC configurado como protocolo principal; LL-HLS/HLS ficam apenas como contingência técnica.'
            : 'Ordem de fallback baseada no protocolo configurado.',
      },
      liveDiagnostics: {
        generatedAt: new Date().toISOString(),
        publicAppUrl: process.env.PUBLIC_APP_URL || null,
        apiPublicUrl: process.env.API_PUBLIC_URL || null,
        mediaMtxPublicHost: process.env.MEDIAMTX_PUBLIC_HOST || null,
        mediaMtxPublicScheme: process.env.MEDIAMTX_PUBLIC_SCHEME || null,
        mediaMtxPublicWebrtcUrl: process.env.MEDIAMTX_PUBLIC_WEBRTC_URL || null,
        mediaMtxPublicHlsUrl: process.env.MEDIAMTX_PUBLIC_HLS_URL || null,
        mediaMtxWebrtcAllowOrigin: process.env.MEDIAMTX_WEBRTC_ALLOW_ORIGIN || null,
        mediaMtxHlsAllowOrigin: process.env.MEDIAMTX_HLS_ALLOW_ORIGIN || null,
        mediamtxEnabled: this.mediamtxProxyService.isEnabled(),
        pathReady: Boolean(safeMediaBridge.enabled && safeMediaBridge.pathName),
        pathName: safeMediaBridge.pathName ?? null,
        sourceVideoCodec: sourceCodec,
        originalVideoCodec: originalCodec,
        liveTranscodedForBrowser,
        liveProfile,
        deliveryProfile,
        deliveryMode: viewMode,
        preferredProtocol: configuredPreferred,
        protocolOrder,
        readiness: liveReadiness,
      },
      protocols: {
        flvUrl,
        posterUrl,
        ...safeMediaBridge,
      },
    };
  }

  // Emite tokens de poster em LOTE, SEM iniciar path MediaMTX (diferente de
  // /urls, que chama ensurePathForCamera e sobe um restream por câmera). Serve
  // p/ os tiles da grade mostrarem um snapshot de TODAS as câmeras sem custo de
  // stream: o /poster gera 1 frame (cache 15s) puxando direto do RTSP quando
  // não há path live. Câmeras sem acesso são apenas omitidas do resultado.
  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Post('poster-tokens')
  async getPosterTokens(
    @CurrentUser() user: AuthUser,
    @Body() body: { cameraIds?: unknown },
    @Req() req: Request,
  ) {
    await this.commercialPolicy.assertFeature('localLive', user);
    const ids = Array.isArray(body?.cameraIds)
      ? (body.cameraIds.filter((v) => typeof v === 'string' && v.length > 0) as string[]).slice(0, 200)
      : [];
    const apiPublicBase = this.resolveApiPublicBase(req);
    const items: { cameraId: string; streamToken: string; posterUrl: string }[] = [];
    for (const cameraId of ids) {
      try {
        await this.accessControlService.assertCanViewCamera(user, cameraId);
        const token = await this.authService.createStreamToken(user.id, cameraId);
        items.push({
          cameraId,
          streamToken: token.streamToken,
          posterUrl: `${apiPublicBase}/camera-stream/${cameraId}/poster`,
        });
      } catch {
        // Sem acesso / câmera inexistente: omite do lote, não derruba o resto.
      }
    }
    return { items };
  }

  // ── Gravação de CLIPE sob demanda (exato start→stop) para "salvar no celular"
  // O app inicia, o servidor grava com `-c copy`, o app para e baixa o arquivo.
  // Permissão: VER a câmera basta (é o "salvar o que já estou vendo", como a
  // Foto) — NÃO exige permissão de gravação do NVR, senão usuários VIEWER dos
  // clientes ficam com o botão morto.
  @Roles(UserRole.VIEWER)
  @RequirePermission('liveView')
  @Post(':cameraId/clip/start')
  async startClip(@CurrentUser() user: AuthUser, @Param('cameraId') cameraId: string) {
    await this.accessControlService.assertCanViewCamera(user, cameraId);
    await this.commercialPolicy.assertFeature('localLive', user);
    return this.clipCaptureService.start(cameraId, user.id);
  }

  @Roles(UserRole.VIEWER)
  @Post('clip/:clipId/stop')
  async stopClip(@CurrentUser() user: AuthUser, @Param('clipId') clipId: string) {
    return this.clipCaptureService.stop(clipId, user.id);
  }

  @Roles(UserRole.VIEWER)
  @Get('clip/:clipId/download')
  async downloadClip(
    @CurrentUser() user: AuthUser,
    @Param('clipId') clipId: string,
    @Res() res: Response,
  ) {
    const filePath = this.clipCaptureService.getClipFile(clipId, user.id);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="clip-${clipId}.mp4"`);
    const stream = createReadStream(filePath);
    stream.pipe(res);
    // Apaga o arquivo temporário quando o download termina (ou falha).
    const done = () => this.clipCaptureService.cleanup(clipId);
    res.on('close', done);
    stream.on('error', () => { try { res.end(); } catch { /* */ } this.clipCaptureService.cleanup(clipId); });
  }

  @Public()
  @Get(':cameraId/poster')
  async getPoster(
    @Param('cameraId') cameraId: string,
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const bearerToken = this.extractBearerToken(req);
    const tokenValue = token?.trim() || bearerToken;
    if (!tokenValue) {
      throw new UnauthorizedException('Token de stream ausente.');
    }

    const payload = await this.authService.verifyStreamToken(tokenValue);
    if (payload.cameraId !== cameraId) {
      throw new UnauthorizedException('Token inválido para esta câmera.');
    }
    const tokenUser = await this.authService.me(payload.sub);
    await this.accessControlService.assertCanViewCamera(tokenUser, cameraId);

    const poster = await this.ffmpegMjpegService.getLivePosterFrame(cameraId);
    res.status(200);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(poster.buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=10, stale-while-revalidate=20');
    res.setHeader('X-Poster-Generated-At', new Date(poster.generatedAt).toISOString());
    res.end(poster.buffer);
  }

  @Public()
  @Get(':cameraId/flv')
  async getFlv(
    @Param('cameraId') cameraId: string,
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const bearerToken = this.extractBearerToken(req);
    const tokenValue = token?.trim() || bearerToken;
    if (!tokenValue) {
      throw new UnauthorizedException('Token de stream ausente.');
    }

    const payload = await this.authService.verifyStreamToken(tokenValue);
    if (payload.cameraId !== cameraId) {
      throw new UnauthorizedException('Token inválido para esta câmera.');
    }
    const tokenUser = await this.authService.me(payload.sub);
    await this.accessControlService.assertCanViewCamera(tokenUser, cameraId);

    await this.ffmpegMjpegService.startFlvStream(cameraId, req, res);
  }
}
