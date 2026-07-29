import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as bcrypt from 'bcrypt';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AlarmSource, AlarmStatus, CameraPermissionLevel, UserRole } from '@prisma/client';
import { AccessControlService } from '../src/access-control/access-control.service';
import { AuthService } from '../src/auth/auth.service';
import { AiManagerService } from '../src/ai/ai-manager.service';
import { AiService } from '../src/ai/ai.service';
import { CameraStreamController } from '../src/camera-stream/camera-stream.controller';
import { FfmpegMjpegService } from '../src/camera-stream/ffmpeg-mjpeg.service';
import { StreamResourceAdvisorService } from '../src/camera-stream/stream-resource-advisor.service';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import { CamerasController } from '../src/cameras/cameras.controller';
import { EvidenceService } from '../src/evidence/evidence.service';
import { RecordingsController } from '../src/recordings/recordings.controller';
import { RecordingsService } from '../src/recordings/recordings.service';
import { UsersService } from '../src/users/users.service';
import { CameraPermissionsService } from '../src/camera-permissions/camera-permissions.service';
import { SettingsService } from '../src/settings/settings.service';
import { PermissionsGuard } from '../src/role-permissions/permissions.guard';
import { DEFAULT_PERMISSIONS, normalizeMatrix } from '../src/role-permissions/role-permissions.constants';
import { assessCameraCompatibility } from '../src/cameras/helpers/camera-compatibility.helper';
import { assessLiveReadiness } from '../src/camera-stream/helpers/live-readiness.helper';
import type { AuthUser } from '../src/common/types/auth-user.type';
import { AlarmsService } from '../src/alarms/alarms.service';
import { ensureFileUnderRoot } from '../src/recordings/helpers/safe-file.helper';
import { CameraHealthCheckProcessor } from '../src/jobs/processors/camera-health-check.processor';
import { containsCredentialBearingUrl, sanitizeSensitiveText } from '../src/common/security/sensitive-text.helper';

import { test } from 'node:test';

function config(values: Record<string, string>) {
  return { get: (key: string) => values[key] };
}

function settings(values?: { maxLoginAttempts?: number; sessionTimeoutMinutes?: number }) {
  return {
    getMaxLoginAttempts: async () => values?.maxLoginAttempts ?? 5,
    getSessionTimeoutMinutes: async () => values?.sessionTimeoutMinutes ?? 0,
    isStrongPasswordRequired: async () => false,
  };
}

function assertRoutePermission(filePath: string, routeDecorator: string, permission: string) {
  const source = readFileSync(filePath, 'utf8');
  const routeIndex = source.indexOf(routeDecorator);
  assert.notEqual(routeIndex, -1, `${filePath} deve conter ${routeDecorator}`);

  const nearbyDecorators = source.slice(Math.max(0, routeIndex - 220), routeIndex);
  assert(
    nearbyDecorators.includes(`@RequirePermission('${permission}')`),
    `${filePath} ${routeDecorator} deve exigir ${permission}`,
  );
}

const cameras = [
  { id: 'cam-1', groupId: 'group-a' },
  { id: 'cam-2', groupId: 'group-a' },
  { id: 'cam-3', groupId: 'group-b' },
];

const permissions = [
  { userId: 'operator', cameraId: 'cam-3', groupId: null, level: CameraPermissionLevel.VIEW },
  { userId: 'operator', cameraId: null, groupId: 'group-a', level: CameraPermissionLevel.CONTROL },
  { userId: 'recorder', cameraId: 'cam-1', groupId: null, level: CameraPermissionLevel.RECORD },
];

test('settings branding: expõe paletas clara e escura com compatibilidade', async () => {
  const prisma = { systemSetting: { findMany: async () => [] } };
  const service = new SettingsService(prisma as any);
  const branding = await service.getBranding();
  assert.equal(branding.brandPrimaryColor, '', 'chaves históricas devem continuar disponíveis para tema escuro');
  assert.equal(branding.brandUseDefaultColors, true, 'novas instalações devem iniciar com a paleta padrão do app');
  assert.equal(branding.brandLightBackgroundColor, '#f5f7fb', 'tema claro deve possuir fallback próprio');
  assert.equal(branding.brandLightPrimaryTextColor, '#111827', 'texto do tema claro deve ser exposto publicamente');
  assert.equal(await service.isStrongPasswordRequired(), true, 'instalações novas devem exigir senha forte');
});

test('security logs: remove todas as credenciais embutidas em URLs', () => {
  const unsafe = [
    'ffmpeg input rtsp://admin:senha-secreta@10.0.0.20:554/live',
    'retry rtsps://usuario:p%40ss@camera.local/stream and http://api:token@internal/path',
  ].join('\n');
  const sanitized = sanitizeSensitiveText(unsafe);
  assert.equal(containsCredentialBearingUrl(sanitized), false);
  assert.equal(sanitized.includes('senha-secreta'), false);
  assert.equal(sanitized.includes('p%40ss'), false);
  assert.equal(sanitized.includes('token@'), false);
  assert.match(sanitized, /rtsp:\/\/<redacted>@10\.0\.0\.20/);
});

// O helper acima sempre funcionou — o vazamento real (2026-07-15: 10 linhas com senha de
// câmera em claro no log da api) aconteceu porque os CALL SITES não o aplicavam. O stderr
// do FFmpeg/ffprobe imprime a URL de entrada inteira, e ela chega via `error.message`,
// não via a `url` que já era sanitizada. Esta trava vigia os pontos onde isso entra.
test('security logs: pontos que carregam stderr de FFmpeg/ffprobe sanitizam a mensagem', () => {
  const mjpeg = readFileSync('src/camera-stream/ffmpeg-mjpeg.service.ts', 'utf8');
  // poster: a message do execFile traz o stderr do FFmpeg (com a URL+credencial)
  assert.match(
    mjpeg,
    /Falha ao gerar poster live[^`]*sanitizeSensitiveText\(error\)/,
    'log de falha do poster deve sanitizar o erro (stderr do FFmpeg), não só a url',
  );
  // pior caso: esta message vai na RESPOSTA HTTP
  assert.match(
    mjpeg,
    /Falha ao gerar imagem inicial: \$\{sanitizeSensitiveText\(lastError\)\}/,
    'a exceção HTTP do poster deve sanitizar o erro antes de responder ao cliente',
  );

  const cameras = readFileSync('src/cameras/cameras.service.ts', 'utf8');
  assert.match(
    cameras,
    /const clean = sanitizeSensitiveText\(stderr\.trim\(\)\)/,
    'o stderr do ffprobe deve ser sanitizado antes de virar resultado do probe',
  );

  const proxy = readFileSync('src/camera-stream/mediamtx-proxy.service.ts', 'utf8');
  assert.match(
    proxy,
    /MediaMTX API \$\{method\} \$\{path\} failed[^`]*sanitizeSensitiveText\(text\)/,
    'o corpo de erro do MediaMTX pode ecoar a config com a URL+credencial; sanitizar',
  );

  // clip-capture: o stderrTail volta ao cliente numa BadRequestException e a rota é
  // @Roles(VIEWER) — era o gêmeo do 167fd52, achado porque esta trava não o cobria.
  const clip = readFileSync('src/camera-stream/clip-capture.service.ts', 'utf8');
  assert.match(
    clip,
    /state\.stderrTail = sanitizeSensitiveText\(/,
    'o stderr do FFmpeg do clipe deve ser sanitizado ao ser acumulado',
  );
  assert.match(
    clip,
    /Não foi possível gravar o clipe[^`]*sanitizeSensitiveText\(st\.stderrTail\)/,
    'a exceção do clipe vai no corpo da resposta; sanitizar o stderr antes',
  );
});

test('poster das câmeras usa a fonte leve do grid sem iniciar live selected', () => {
  const posterService = readFileSync('src/camera-stream/ffmpeg-mjpeg.service.ts', 'utf8');
  assert.match(
    posterService,
    /resolveGridPosterSource\(cameraId\)/,
    'poster deve reutilizar a seleção de sub-stream da grade',
  );
  assert.doesNotMatch(
    posterService,
    /getMediamtxPosterSource/,
    'poster não pode voltar a abrir um path selected no MediaMTX',
  );
  assert.match(
    posterService,
    /withPosterCaptureSlot\(\(\) => this\.generateLivePosterFrame\(cameraId\)\)/,
    'capturas de poster de câmeras diferentes devem possuir limite de concorrência',
  );

  const proxy = readFileSync('src/camera-stream/mediamtx-proxy.service.ts', 'utf8');
  const methodStart = proxy.indexOf('async resolveGridPosterSource(cameraId: string)');
  assert.notEqual(methodStart, -1, 'proxy deve expor a escolha leve da grade para snapshots');
  const methodBody = proxy.slice(methodStart, proxy.indexOf('\n  private ', methodStart));
  assert.match(methodBody, /chooseGridSource\(cameraId, camera, password, transport\)/);
  assert.doesNotMatch(
    methodBody,
    /ensurePathForCamera/,
    'resolver snapshot não deve criar um stream persistente no MediaMTX',
  );
});

test('poster limita capturas FFmpeg simultâneas', async () => {
  const service = new FfmpegMjpegService(
    { get: (key: string) => key === 'livePosterMaxConcurrency' ? 3 : undefined } as any,
    {} as any,
    {} as any,
    {} as any,
  );
  let active = 0;
  let peak = 0;
  const capture = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  };

  await Promise.all(
    Array.from({ length: 12 }, () => (service as any).withPosterCaptureSlot(capture)),
  );
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

// A trava acima é por arquivo/regex e só pega o que eu lembrei de listar — foi assim que
// o clip-capture escapou por 2 rodadas. Esta varre o repo: se um serviço captura o STDERR
// de um processo (é onde o FFmpeg imprime "Error opening input file rtsp://user:senha@..."
// — o stdout carrega dado/JSON, não diagnóstico), o arquivo TEM de sanitizar em algum
// ponto. Heurística por arquivo de propósito: sanitizar no acúmulo ou no uso são ambos
// válidos, e rastrear isso por regex daria falso-positivo. O alvo é o arquivo NOVO que
// esquece por completo.
test('security logs: todo serviço que captura stderr de processo sanitiza em algum ponto', () => {
  const roots = ['src/camera-stream', 'src/cameras', 'src/recordings', 'src/jobs', 'src/gpu'];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const src = readFileSync(full, 'utf8');
        const capturesStderr = /stderr\??\.on\(\s*['"]data['"]/.test(src) || /stderr:\s*['"]pipe/.test(src);
        if (!capturesStderr) continue;
        if (!/sanitizeSensitiveText|sanitizeRtspUrl/.test(src)) {
          offenders.push(full);
        }
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(
    offenders,
    [],
    `arquivo(s) capturam stderr de processo e nunca sanitizam — o FFmpeg imprime a URL RTSP com senha nele:\n${offenders.join('\n')}`,
  );
});

test('recordings maintenance: arquivos inválidos não entram em backfill infinito', () => {
  const source = readFileSync('src/recordings/recordings.service.ts', 'utf8');
  const worker = readFileSync('src/jobs/processors/thumbnail-generation.processor.ts', 'utf8');
  const retention = readFileSync('src/recordings/retention.service.ts', 'utf8');
  assert.match(source, /invalid\.json/);
  assert.match(worker, /gravação marcada como indisponível/);
  assert.match(retention, /invalid\.json/);
});

function makeAccessControlService() {
  const prisma = {
    camera: {
      findMany: async (args?: any) => {
        if (args?.where?.groupId?.in) {
          return cameras.filter((camera) => args.where.groupId.in.includes(camera.groupId)).map(({ id }) => ({ id }));
        }
        return cameras.map(({ id }) => ({ id }));
      },
      findUnique: async (args: any) => cameras.find((camera) => camera.id === args.where.id) ?? null,
    },
    // Grupos ATIVOS: o bloqueio comercial por grupo (accessStatus) tem suíte
    // própria; aqui todos concedem acesso, como antes de o campo existir.
    cameraGroup: {
      findMany: async (args: any) => {
        const ids = args?.where?.id?.in ?? [...new Set(cameras.map((c: any) => c.groupId).filter(Boolean))];
        return ids.map((id: string) => ({ id, isActive: true, accessStatus: 'ACTIVE' }));
      },
      findUnique: async (args: any) => ({ id: args.where.id, isActive: true, accessStatus: 'ACTIVE' }),
    },
    cameraPermission: {
      findMany: async (args: any) => {
        const where = args.where ?? {};
        let rows = permissions.filter((permission) => permission.userId === where.userId);

        if (where.cameraId?.not === null) rows = rows.filter((permission) => permission.cameraId !== null);
        if (where.groupId?.not === null) rows = rows.filter((permission) => permission.groupId !== null);
        if (Array.isArray(where.OR)) {
          rows = rows.filter((permission) => where.OR.some((condition: any) => {
            if (condition.cameraId) return permission.cameraId === condition.cameraId;
            if (condition.groupId) return permission.groupId === condition.groupId;
            return false;
          }));
        }

        return rows.map((permission) => {
          if (args.select?.cameraId) return { cameraId: permission.cameraId };
          if (args.select?.groupId) return { groupId: permission.groupId };
          if (args.select?.level) return { level: permission.level };
          return permission;
        });
      },
    },
  };

  return new AccessControlService(prisma as any);
}

test('evidence: assina e verifica pacote valido', () => {
  const service = new EvidenceService(config({ evidenceHmacSecret: '0123456789abcdef0123456789abcdef', evidenceHmacKeyId: 'test-key' }) as any);
  const payload = { cameraId: 'cam-1', exportedAt: '2026-05-22T00:00:00.000Z', clips: [{ id: 'clip-1' }] };
  const signed = { ...payload, ...service.signPackage(payload) };

  const result = service.verifyPackage(signed);

  assert.equal(result.ok, true);
  assert.equal(result.hashValid, true);
  assert.equal(result.signatureValid, true);
});

test('evidence: rejeita hash, assinatura alterada e hex malformado sem exception', () => {
  const service = new EvidenceService(config({ evidenceHmacSecret: '0123456789abcdef0123456789abcdef' }) as any);
  const payload = { cameraId: 'cam-1', clips: [{ id: 'clip-1' }] };
  const signed = { ...payload, ...service.signPackage(payload) } as any;

  assert.equal(service.verifyPackage({ ...signed, clips: [{ id: 'clip-2' }] }).ok, false);
  assert.equal(service.verifyPackage({ ...signed, signature: { ...signed.signature, value: '0'.repeat(64) } }).signatureValid, false);
  assert.equal(service.verifyPackage({ ...signed, signature: { ...signed.signature, value: 'not-hex' } }).signatureValid, false);
});

test('access-control: admin acessa todas as cameras', async () => {
  const service = makeAccessControlService();
  const admin: AuthUser = { id: 'admin', email: 'admin@test.local', name: 'Admin', role: UserRole.ADMIN };

  assert.deepEqual(await service.getAccessibleCameraIds(admin), ['cam-1', 'cam-2', 'cam-3']);
  assert.equal(await service.canAdminCamera(admin, 'cam-1'), true);
});

test('access-control: permissoes diretas e por grupo respeitam nivel minimo', async () => {
  const service = makeAccessControlService();
  const operator: AuthUser = { id: 'operator', email: 'op@test.local', name: 'Operador', role: UserRole.OPERATOR };
  const recorder: AuthUser = { id: 'recorder', email: 'rec@test.local', name: 'Recorder', role: UserRole.OPERATOR };

  assert.deepEqual(new Set(await service.getAccessibleCameraIds(operator)), new Set(['cam-1', 'cam-2', 'cam-3']));
  assert.equal(await service.canViewCamera(operator, 'cam-2'), true);
  assert.equal(await service.canControlCamera(operator, 'cam-2'), true);
  assert.equal(await service.canRecordCamera(operator, 'cam-2'), false);
  assert.equal(await service.canRecordCamera(recorder, 'cam-1'), true);
  assert.equal(await service.canAdminCamera(recorder, 'cam-1'), false);
});

test('access-control: usuario sem permissao recebe ForbiddenException', async () => {
  const service = makeAccessControlService();
  const viewer: AuthUser = { id: 'viewer', email: 'viewer@test.local', name: 'Viewer', role: UserRole.VIEWER };

  await assert.rejects(() => service.assertCanViewCamera(viewer, 'cam-1'), ForbiddenException);
});

test('camera compatibility: escolhe perfis separados e alerta substream HEVC', () => {
  const assessment = assessCameraCompatibility({
    selectedPath: '/cam/realmonitor?channel=1&subtype=0',
    onvifProfileNames: ['MainStream', 'SubStream'],
    mainMetadata: { codec: 'hevc', width: 2304, height: 1296, fps: 15 },
    subMetadata: { codec: 'hevc', width: 704, height: 480, fps: 10 },
    rtspAuthenticated: true,
    onvifProfilesFound: 2,
  });

  assert.equal(assessment.detectedFamily, 'dahua');
  assert.equal(assessment.state, 'compatible');
  assert.match(assessment.automaticProfile.recording, /H\.265 direto/);
  assert.equal(assessment.hints.some((hint) => hint.code === 'substream_hevc'), true);
});

test('camera compatibility: configuração ideal H264 separada não gera alerta crítico', () => {
  const assessment = assessCameraCompatibility({
    selectedPath: '/Streaming/Channels/101',
    mainMetadata: { codec: 'h264', width: 1920, height: 1080, fps: 15 },
    subMetadata: { codec: 'h264', width: 1280, height: 720, fps: 10 },
    rtspAuthenticated: true,
    onvifProfilesFound: 2,
  });

  assert.equal(assessment.detectedFamily, 'hikvision');
  assert.equal(assessment.hints.some((hint) => hint.severity === 'critical'), false);
  assert.match(assessment.automaticProfile.live, /1920x1080/);
});

test('live readiness: bloqueia mixed content WebRTC em painel HTTPS', () => {
  const readiness = assessLiveReadiness({
    requestOrigin: 'https://vms.exemplo.com',
    publicAppUrl: 'https://vms.exemplo.com',
    mediamtxEnabled: true,
    pathReady: true,
    whepUrl: 'http://media.exemplo.com/cam-1/whep',
    hlsUrl: 'https://media.exemplo.com/cam-1/index.m3u8',
    webrtcAllowOrigin: 'https://vms.exemplo.com',
  });

  assert.equal(readiness.state, 'blocked');
  assert.equal(readiness.readyForWebrtc, false);
  assert.equal(readiness.fallbackAvailable, true);
  assert.equal(readiness.checks.some((check) => check.code === 'whep_mixed_content'), true);
});

test('live readiness: aprova WHEP na mesma origem segura', () => {
  const readiness = assessLiveReadiness({
    requestOrigin: 'https://vms.exemplo.com',
    publicAppUrl: 'https://vms.exemplo.com',
    mediamtxEnabled: true,
    pathReady: true,
    whepUrl: 'https://vms.exemplo.com/live/cam-1/whep',
    hlsUrl: 'https://vms.exemplo.com/live/cam-1/index.m3u8',
    webrtcAllowOrigin: 'https://vms.exemplo.com',
  });

  assert.equal(readiness.state, 'ready');
  assert.equal(readiness.readyForWebrtc, true);
});

test('mediamtx: URL RTSP interna inclui autenticação sem expor senha em claro malformada', () => {
  const service = new MediamtxProxyService(
    config({
      mediaMtxRtspInternalUrl: 'rtsp://mediamtx:8554',
      mediaMtxApiUser: 'internal-user',
      mediaMtxApiPass: 'p@ss/word',
    }) as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const url = service.buildInternalRtspUrl('cam_abc_grid');
  assert.equal(url, 'rtsp://internal-user:p%40ss%2Fword@mediamtx:8554/cam_abc_grid');
});

test('ai service: modo desativado nao tenta acessar container ausente', async () => {
  const previous = process.env.AI_AUTO_START_ENABLED;
  process.env.AI_AUTO_START_ENABLED = 'false';
  let requests = 0;
  try {
    const service = new AiService(
      {
        get: () => {
          requests += 1;
          throw new Error('não deveria acessar');
        },
        post: () => {
          requests += 1;
          throw new Error('não deveria acessar');
        },
      } as any,
      config({ aiBaseUrl: 'http://ai-service:8000' }) as any,
    );

    assert.equal((await service.getHealth()).status, 'disabled');
    assert.equal((await service.getLatestDetections('cam-1')).status, 'disabled');
    assert.equal((await service.heartbeatLiveViewSession('cam-1', 'session-123')).status, 'disabled');
    assert.equal(requests, 0);
  } finally {
    if (previous === undefined) delete process.env.AI_AUTO_START_ENABLED;
    else process.env.AI_AUTO_START_ENABLED = previous;
  }
});

test('auth: login normaliza email, retorna usuario sanitizado e token assinado', async () => {
  const passwordHash = await bcrypt.hash('secret', 4);
  const signCalls: any[] = [];
  const prisma = {
    user: {
      findUnique: async (args: any) => {
        assert.equal(args.where.email, 'admin@test.local');
        return {
          id: 'user-1',
          email: 'admin@test.local',
          name: 'Admin',
          role: UserRole.ADMIN,
          isActive: true,
          authVersion: 3,
          passwordHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
    authSession: {
      create: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    },
  };
  const jwt = {
    signAsync: async (payload: any, options: any) => {
      signCalls.push({ payload, options });
      return 'signed-token';
    },
  };
  const service = new AuthService(prisma as any, jwt as any, config({ jwtExpiresIn: '15m' }) as any, settings() as any);

  const result = await service.login(' ADMIN@Test.Local ', 'secret');

  assert.equal(result.accessToken, 'signed-token');
  assert.equal(typeof result.refreshToken, 'string');
  assert.equal(result.refreshToken.length >= 32, true);
  assert.equal(result.user.role, UserRole.ADMIN);
  assert.equal('passwordHash' in result.user, false);
  assert.equal(signCalls[0].payload.type, 'access');
  assert.equal(signCalls[0].payload.ver, 3);
  assert.equal(signCalls[0].options.expiresIn, '15m');
});

test('auth: rejeita token revogado e logout incrementa versão da sessão', async () => {
  let updateArgs: any = null;
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        email: 'admin@test.local',
        name: 'Admin',
        role: UserRole.ADMIN,
        isActive: true,
        authVersion: 4,
        passwordHash: 'unused',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      update: async (args: any) => {
        updateArgs = args;
        return {};
      },
    },
    authSession: {
      updateMany: async () => ({ count: 1 }),
    },
  };
  const service = new AuthService(prisma as any, {} as any, config({}) as any, settings() as any);

  await assert.rejects(
    () => service.validateAccessPayload({
      sub: 'user-1',
      email: 'admin@test.local',
      role: UserRole.ADMIN,
      ver: 3,
      type: 'access',
    }),
    UnauthorizedException,
  );
  await service.logout('user-1');
  assert.deepEqual(updateArgs.data.authVersion, { increment: 1 });
});

test('auth: refresh rotaciona token e renova sete dias de inatividade', async () => {
  const now = new Date();
  let updateArgs: any = null;
  const user = {
    id: 'user-1', email: 'admin@test.local', name: 'Admin', role: UserRole.ADMIN,
    isActive: true, authVersion: 4, passwordHash: 'unused', createdAt: now, updatedAt: now,
    resetTokenHash: null, resetTokenExpiresAt: null,
  };
  const prisma = {
    authSession: {
      findUnique: async () => ({
        id: 'session-1', userId: user.id, tokenHash: 'hash', authVersion: 4,
        expiresAt: new Date(now.getTime() + 60_000), lastUsedAt: now,
        revokedAt: null, createdAt: now, user,
      }),
      updateMany: async (args: any) => { updateArgs = args; return { count: 1 }; },
    },
  };
  const jwt = { signAsync: async () => 'novo-access-token' };
  const service = new AuthService(prisma as any, jwt as any, config({ jwtExpiresIn: '8h' }) as any, settings() as any);

  const result = await service.refreshSession('refresh-token-original-com-mais-de-32-caracteres');

  assert.equal(result.accessToken, 'novo-access-token');
  assert.notEqual(result.refreshToken, 'refresh-token-original-com-mais-de-32-caracteres');
  assert.equal(updateArgs.where.id, 'session-1');
  const remainingDays = (new Date(result.refreshExpiresAt).getTime() - Date.now()) / 86_400_000;
  assert.equal(remainingDays > 6.9 && remainingDays <= 7.01, true);
});

test('auth: senha invalida rejeita com UnauthorizedException', async () => {
  const passwordHash = await bcrypt.hash('secret', 4);
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        email: 'admin@test.local',
        name: 'Admin',
        role: UserRole.ADMIN,
        isActive: true,
        passwordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
  };
  const service = new AuthService(prisma as any, { signAsync: async () => 'never' } as any, config({}) as any, settings() as any);

  await assert.rejects(() => service.login('admin@test.local', 'wrong'), UnauthorizedException);
});

test('arquivos: bloqueia prefixo parecido fora da raiz de gravações', () => {
  assert.equal(ensureFileUnderRoot('/storage/recordings', 'cam-1/video.mp4'), '/storage/recordings/cam-1/video.mp4');
  assert.throws(
    () => ensureFileUnderRoot('/storage/recordings', '/storage/recordings-evil/video.mp4'),
    /fora da raiz/,
  );
});

test('alarmes: movimento em câmera DESARMADA não abre alarme (mas armada abre)', async () => {
  // Bug real de produção: 1 câmera armada (gravação por movimento) e o app
  // recebendo alerta de movimento das OUTRAS (Cam-02, 03, 13...) — todas com
  // ONVIF, nenhuma vigiada. O escutador ONVIF registra MOTION_DETECTED como
  // prova de vida da detecção nativa em QUALQUER câmera; isso pode ir para a
  // timeline, mas alarme é chamado à ação e só cabe para quem está ARMADA.
  const fabricaPrisma = (cam: { recordingMode: string; enabled: boolean }) => {
    const criados: any[] = [];
    return {
      criados,
      alarmRule: {
        // Regra de MOTION habilitada: se o gate não segurar, o alarme SAI.
        findUnique: async () => ({ id: 'r1', isEnabled: true, dedupWindowSeconds: 60, priority: 'P3' }),
      },
      camera: {
        findUnique: async () => ({ alarmsEnabled: true, ...cam }),
      },
      alarmInstance: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => null,
        create: async (args: any) => { criados.push(args); return { id: 'a1', ...args.data }; },
      },
    };
  };
  const mute = { isRuleMuted: async () => false, isCameraEventMuted: async () => false };
  const notifica = { onAlarmOpened: async () => undefined, notifyAlarmOpened: async () => undefined };
  const evento = {
    eventId: 'ev-1', cameraId: 'cam-x', type: 'MOTION_DETECTED', severity: 'INFO',
    message: 'Movimento detectado pela própria câmera (ONVIF).', occurredAt: new Date(),
  };

  // Desarmada (modo manual): o gate TEM que devolver null sem criar nada.
  const desarmada = fabricaPrisma({ recordingMode: 'manual', enabled: true });
  const s1 = new AlarmsService(desarmada as any, {} as any, notifica as any, mute as any);
  assert.equal(await s1.processEvent(evento), null, 'câmera desarmada não pode abrir alarme de movimento');
  assert.equal(desarmada.criados.length, 0);

  // Câmera desabilitada conta como desarmada, mesmo em modo motion.
  const desabilitada = fabricaPrisma({ recordingMode: 'motion', enabled: false });
  const s2 = new AlarmsService(desabilitada as any, {} as any, notifica as any, mute as any);
  assert.equal(await s2.processEvent(evento), null);
  assert.equal(desabilitada.criados.length, 0);

  // Armada: o MESMO evento passa o gate e abre alarme — sem este contraste,
  // um gate que bloqueasse tudo também passaria no teste.
  const armada = fabricaPrisma({ recordingMode: 'motion', enabled: true });
  const s3 = new AlarmsService(armada as any, {} as any, notifica as any, mute as any);
  const aberto = await s3.processEvent(evento);
  assert.ok(aberto, 'câmera armada continua alarmando');
  assert.equal(armada.criados.length, 1);
});

test('alarmes: movimento aberto é auto-resolvido após período sem ocorrências', async () => {
  let updateArgs: any = null;
  const prisma = {
    alarmRule: {
      findUnique: async () => ({ dedupWindowSeconds: 60 }),
    },
    alarmInstance: {
      updateMany: async (args: any) => {
        updateArgs = args;
        return { count: 2 };
      },
    },
  };
  const service = new AlarmsService(prisma as any, {} as any, {} as any, {} as any);
  const now = new Date('2026-07-13T20:00:00.000Z');

  const result = await service.resolveStaleMotionAlarms(now);

  assert.equal(result.resolved, 2);
  assert.equal(result.quietSeconds, 300, 'movimentos da mesma cena devem ser consolidados por cinco minutos');
  assert.equal(updateArgs.where.source, AlarmSource.MOTION);
  assert.equal(updateArgs.where.type, 'MOTION_DETECTED');
  assert.deepEqual(updateArgs.where.status.in, [AlarmStatus.OPEN, AlarmStatus.ACKED]);
  assert.equal(updateArgs.data.status, AlarmStatus.RESOLVED);
  assert.equal(updateArgs.data.resolvedByUserName, 'SYSTEM_MOTION_QUIET');
});

test('health motion: status agregado degraded não marca processador saudável como stale', async () => {
  const originalFetch = globalThis.fetch;
  const events: Array<{ cameraId: string; type: string }> = [];
  const nowSeconds = Date.now() / 1000;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      status: 'degraded',
      processors: {
        'cam-healthy': {
          running: true,
          last_seen: nowSeconds,
          readiness: { ready: true, reason: null },
        },
        'cam-stale': {
          running: false,
          last_seen: nowSeconds,
          readiness: { ready: false, reason: 'processor_stopped' },
        },
      },
    }),
  })) as any;

  try {
    const prisma = {
      camera: {
        findMany: async () => [
          { id: 'cam-healthy', name: 'Saudável', status: 'ONLINE' },
          { id: 'cam-stale', name: 'Parada', status: 'ONLINE' },
        ],
      },
      cameraEvent: { findFirst: async () => null },
    };
    const camerasService = {
      registerEvent: async (cameraId: string, type: string) => {
        events.push({ cameraId, type });
      },
    };
    const processor = new CameraHealthCheckProcessor(
      prisma as any,
      config({}) as any,
      camerasService as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await (processor as any).checkMotionDetectorHealth();

    assert.deepEqual(events, [{ cameraId: 'cam-stale', type: 'HEALTH_MOTION_DETECTOR_STALE' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recordings: listagem aplica filtro de cameras acessiveis', async () => {
  const findManyCalls: any[] = [];
  const prisma = {
    recording: {
      findMany: async (args: any) => {
        findManyCalls.push(args);
        return [{ id: 'rec-1', cameraId: 'cam-1', filePath: 'cam-1/rec-1.mp4', startedAt: new Date(), endedAt: null }];
      },
      count: async (args: any) => {
        assert.deepEqual(args.where.cameraId, { in: ['cam-1'] });
        return 1;
      },
    },
  };
  const service = new RecordingsService(prisma as any, {} as any, {} as any, {} as any);

  const result = await service.list({ limit: 10, offset: 0 } as any, ['cam-1']);

  assert.equal(result.total, 1);
  assert.deepEqual(findManyCalls[0].where.cameraId, { in: ['cam-1'] });
});

test('cameras controller: usuario comum lista somente cameras acessiveis com capacidades', async () => {
  const user: AuthUser = { id: 'operator', email: 'op@test.local', name: 'Operador', role: UserRole.OPERATOR };
  const serviceCalls: any[] = [];
  const camerasService = {
    findAll: async (ids?: string[]) => {
      serviceCalls.push(ids);
      return [{ id: 'cam-1', name: 'Sala' }];
    },
  };
  const access = {
    getAccessibleCameraIds: async () => ['cam-1'],
    canViewCamera: async (_user: AuthUser, id: string) => id === 'cam-1',
    canControlCamera: async () => true,
    canRecordCamera: async () => false,
    canAdminCamera: async () => false,
  };
  const controller = new CamerasController(camerasService as any, {} as any, access as any, {} as any, {} as any);

  const result = await controller.findAll(user);

  assert.deepEqual(serviceCalls[0], ['cam-1']);
  assert.deepEqual(result[0], {
    id: 'cam-1',
    name: 'Sala',
    canView: true,
    canControl: true,
    canRecord: false,
    canAdmin: false,
  });
});

test('cameras controller: admin lista todas as cameras sem filtro e com capacidades totais', async () => {
  const user: AuthUser = { id: 'admin', email: 'admin@test.local', name: 'Admin', role: UserRole.ADMIN };
  const serviceCalls: any[] = [];
  const camerasService = {
    findAll: async (ids?: string[]) => {
      serviceCalls.push(ids);
      return [{ id: 'cam-1', name: 'Sala' }];
    },
  };
  const controller = new CamerasController(camerasService as any, {} as any, {} as any, {} as any, {} as any);

  const result = await controller.findAll(user);

  assert.equal(serviceCalls[0], undefined);
  assert.equal(result[0].canAdmin, true);
  assert.equal(result[0].canRecord, true);
});

test('camera-stream controller: cria token somente apos validar permissao de visualizacao', async () => {
  const user: AuthUser = { id: 'operator', email: 'op@test.local', name: 'Operador', role: UserRole.OPERATOR };
  const order: string[] = [];
  const access = {
    // Gate de HISTÓRICO: nestes testes espelha o de view (o que importa
    // é que o gate seja chamado antes de servir conteúdo).
    assertCanPlaybackCamera: async (...args: any[]) => (access as any).assertCanViewCamera(...args),
    assertCanViewCamera: async (_user: AuthUser, cameraId: string) => {
      order.push(`access:${cameraId}`);
    },
  };
  const auth = {
    createStreamToken: async (userId: string, cameraId: string) => {
      order.push(`token:${userId}:${cameraId}`);
      return { streamToken: 'stream-token', expiresAt: '2026-05-22T00:05:00.000Z' };
    },
  };
  const commercialPolicy = {
    assertFeature: async (feature: string) => {
      order.push(`policy:${feature}`);
    },
  };
  const cameras = {
    getCameraOrThrow: async (cameraId: string) => {
      order.push(`camera:${cameraId}`);
      return { id: cameraId, enabled: true };
    },
  };
  const audit = { log: async () => order.push('audit') };
  const controller = new CameraStreamController(
    {} as any,
    {} as any,
    {} as any,
    cameras as any,
    auth as any,
    access as any,
    audit as any,
    commercialPolicy as any,
    {} as any,
    {} as any,
  );

  const result = await controller.createStreamToken(user, 'cam-1', { headers: {} } as any);

  assert.deepEqual(result, { streamToken: 'stream-token', expiresAt: '2026-05-22T00:05:00.000Z' });
  assert.deepEqual(order, ['access:cam-1', 'policy:localLive', 'camera:cam-1', 'token:operator:cam-1', 'audit']);
});

test('camera-stream: URLs de FLV e poster preservam o prefixo público /api', async () => {
  const user: AuthUser = { id: 'viewer', email: 'viewer@test.local', name: 'Viewer', role: UserRole.VIEWER };
  const mediamtx = {
    isEnabled: () => false,
    buildPublicUrls: () => ({
      enabled: false,
      pathName: null,
      whepUrl: null,
      hlsUrl: null,
      rtspUrl: null,
    }),
  };
  const camera = {
    id: 'cam-1',
    channel: 1,
    subtype: 0,
    liveChannel: 1,
    liveSubtype: 0,
    recordingChannel: 1,
    recordingSubtype: 0,
    preferredLiveProtocol: 'webrtc',
    preferredRtspTransport: 'tcp',
    streamVideoCodec: 'h264',
    recordingVideoCodec: 'h264',
    detectedVideoCodec: 'h264',
    detectedWidth: 1920,
    detectedHeight: 1080,
  };
  const auth = {
    createStreamToken: async () => ({ streamToken: 'poster-token', expiresAt: null }),
  };
  const access = { assertCanViewCamera: async () => undefined };
  const controller = new CameraStreamController(
    {} as any,
    {} as any,
    mediamtx as any,
    { getCameraOrThrow: async () => camera } as any,
    auth as any,
    access as any,
    {} as any,
    { assertFeature: async () => undefined } as any,
    {} as any,
    config({ apiPublicUrl: 'https://drac.example.com/api/' }) as any,
  );
  const req = {
    headers: { host: 'drac.example.com' },
    protocol: 'https',
  } as any;

  const delivery = await controller.getDeliveryUrls(user, 'cam-1', undefined, req);
  const posterTokens = await controller.getPosterTokens(user, { cameraIds: ['cam-1'] }, req);

  assert.equal(delivery.protocols.flvUrl, 'https://drac.example.com/api/camera-stream/cam-1/flv');
  assert.equal(delivery.protocols.posterUrl, 'https://drac.example.com/api/camera-stream/cam-1/poster');
  assert.equal(posterTokens.items[0].posterUrl, 'https://drac.example.com/api/camera-stream/cam-1/poster');
});

test('recordings controller: listagem de operador usa cameras acessiveis', async () => {
  const user: AuthUser = { id: 'operator', email: 'op@test.local', name: 'Operador', role: UserRole.OPERATOR };
  const calls: any[] = [];
  const recordings = {
    list: async (query: any, ids?: string[]) => {
      calls.push({ query, ids });
      return { items: [], total: 0 };
    },
  };
  const access = { getPlaybackCameraIds: async () => ['cam-1'] };
  const controller = new RecordingsController({} as any, recordings as any, {} as any, {} as any, access as any, {} as any);

  await controller.listRecordings(user, { limit: 20 } as any);

  assert.deepEqual(calls[0], { query: { limit: 20 }, ids: ['cam-1'] });
});

test('stream resource advisor: identifica cameras que exigem transcode e analytics acoplado', async () => {
  const updates: any[] = [];
  const service = new StreamResourceAdvisorService(
    {
      findAllInternal: async () => [{
        id: 'cam-heavy',
        name: 'Portaria HEVC',
        status: 'ONLINE',
        channel: 1,
        subtype: 0,
        liveChannel: 1,
        liveSubtype: 0,
        recordingChannel: 1,
        recordingSubtype: 0,
        analyticsChannel: 1,
        analyticsSubtype: 0,
        preferredLiveProtocol: 'webrtc',
        streamVideoCodec: 'original',
        recordingVideoCodec: 'h265',
        detectedVideoCodec: 'hevc',
        detectedWidth: 2304,
        detectedHeight: 1296,
        detectedFps: 15,
        audioEnabled: true,
        recordingEnabled: true,
        recordingMode: 'continuous',
        updatedAt: new Date('2026-06-04T00:00:00.000Z'),
      }],
      getCameraOrThrow: async () => ({
        id: 'cam-heavy',
        name: 'Portaria HEVC',
        status: 'ONLINE',
        channel: 1,
        subtype: 0,
        liveChannel: 1,
        liveSubtype: 0,
        recordingChannel: 1,
        recordingSubtype: 0,
        analyticsChannel: 1,
        analyticsSubtype: 0,
        preferredLiveProtocol: 'webrtc',
        streamVideoCodec: 'original',
        recordingVideoCodec: 'h265',
        detectedVideoCodec: 'hevc',
        detectedWidth: 2304,
        detectedHeight: 1296,
        detectedFps: 15,
        audioEnabled: true,
        recordingEnabled: true,
        recordingMode: 'continuous',
        updatedAt: new Date('2026-06-04T00:00:00.000Z'),
      }),
    } as any,
    {
      getPathRuntimeSummaryForCamera: async () => ({
        pathName: 'cam_camheavy',
        available: true,
        ready: true,
        readerCount: 2,
        readers: [{ id: 'reader-1', protocol: 'webrtc', remoteAddr: '10.0.0.20:*' }],
        bytesReceived: 100,
        bytesSent: 200,
        error: null,
      }),
      invalidateMainCodecCache: () => undefined,
    } as any,
    {
      auditLog: {
        findMany: async () => [
          {
            createdAt: new Date(),
            metadata: {
              protocol: 'webrtc',
              stage: 'ice',
              reason: 'ICE failed',
              state: 'failed',
            },
          },
          { createdAt: new Date(), metadata: { protocol: 'webrtc', stage: 'startup', reason: 'sem resposta' } },
          { createdAt: new Date(), metadata: { protocol: 'webrtc', stage: 'startup', reason: 'sem resposta' } },
        ],
      },
      recording: {
        findMany: async () => [],
        count: async (args: any) => args.where?.endedAt === null ? 0 : 0,
        findFirst: async () => null,
      },
      camera: {
        update: async (args: any) => {
          updates.push(args);
          return args;
        },
      },
    } as any,
  );

  const report = await service.getFleetReport(['cam-heavy']);
  const camera = report.cameras[0];

  assert.equal(report.summary.totalCameras, 1);
  assert.equal(report.summary.liveTranscodeLikely, 1);
  assert.equal(report.summary.audioTranscodeLikely, 1);
  assert.equal(report.summary.highCpuRiskCameras, 1);
  assert.equal(camera.profiles.live.transcodeForBrowser, true);
  assert.equal(camera.profiles.analytics.separatedFromLive, false);
  assert.equal(camera.profiles.recording.copyFriendly, true);
  assert.equal(camera.operations.live.failuresLast24h, 3);
  assert.equal(camera.operations.recording.state, 'attention');
  assert.equal(camera.resource.findings.some((item) => item.code === 'hevc_live_transcode'), true);
  assert.equal(camera.resource.findings.some((item) => item.code === 'analytics_reuses_live'), true);
  assert.equal(camera.resource.findings.some((item) => item.code === 'repeated_live_failures'), true);
  assert.equal(camera.resource.findings.some((item) => item.code === 'recording_recent_segments_missing' || item.code === 'recording_large_gap'), true);
  assert.equal(report.recommendations.some((item) => item.code === 'multi_reader_transcode_pressure'), true);
  assert.equal(report.optimizationPlan.safeActionCount, 1);

  const applied = await service.applySafeOptimizations(['cam-heavy']);

  assert.equal(applied.totalChanged, 1);
  assert.deepEqual(updates[0].data, { analyticsSubtype: 1 });
});

test('recordings controller: play-token valida camera da gravacao e grava cookie httpOnly', async () => {
  const user: AuthUser = { id: 'operator', email: 'op@test.local', name: 'Operador', role: UserRole.OPERATOR };
  const order: string[] = [];
  const cookies: any[] = [];
  const recordings = {
    ensureRecordingExists: async (id: string) => {
      order.push(`recording:${id}`);
      return { id, cameraId: 'cam-1' };
    },
  };
  const access = {
    // Gate de HISTÓRICO: nestes testes espelha o de view (o que importa
    // é que o gate seja chamado antes de servir conteúdo).
    assertCanPlaybackCamera: async (...args: any[]) => (access as any).assertCanViewCamera(...args),
    assertCanViewCamera: async (_user: AuthUser, cameraId: string) => {
      order.push(`access:${cameraId}`);
    },
  };
  const auth = {
    createPlaybackToken: async (userId: string, recordingId: string) => {
      order.push(`token:${userId}:${recordingId}`);
      return { playToken: 'play-token', expiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
  };
  const audit = { log: async () => order.push('audit') };
  const res = { cookie: (...args: any[]) => cookies.push(args) };
  const controller = new RecordingsController({} as any, recordings as any, {} as any, auth as any, access as any, audit as any);

  const result = await controller.createPlayToken(user, 'rec-1', { headers: {} } as any, res as any);

  assert.deepEqual(result.playToken, 'play-token');
  assert.deepEqual(order, ['recording:rec-1', 'access:cam-1', 'token:operator:rec-1', 'audit']);
  assert.equal(cookies[0][0], 'vms_play_token');
  assert.equal(cookies[0][1], 'play-token');
  assert.equal(cookies[0][2].httpOnly, true);
  assert.equal(cookies[0][2].sameSite, 'lax');
});

test('recordings controller: playback publico rejeita token de outra gravacao', async () => {
  const auth = {
    verifyPlaybackToken: async () => ({ sub: 'operator', recordingId: 'rec-other', type: 'play' }),
  };
  const controller = new RecordingsController({} as any, {} as any, {} as any, auth as any, {} as any, {} as any);

  await assert.rejects(
    () => controller.playRecording('rec-1', 'token', undefined, undefined, { headers: {} } as any, {} as any),
    UnauthorizedException,
  );
});

test('recordings controller: download valida permissao e audita antes de enviar arquivo', async () => {
  const user: AuthUser = { id: 'operator', email: 'op@test.local', name: 'Operador', role: UserRole.OPERATOR };
  const order: string[] = [];
  const recordings = {
    ensureRecordingExists: async (id: string) => {
      order.push(`recording:${id}`);
      return { id, cameraId: 'cam-1' };
    },
    downloadRecording: async (id: string) => {
      order.push(`download:${id}`);
      return 'streamed';
    },
  };
  const access = {
    // Gate de HISTÓRICO: nestes testes espelha o de view (o que importa
    // é que o gate seja chamado antes de servir conteúdo).
    assertCanPlaybackCamera: async (...args: any[]) => (access as any).assertCanViewCamera(...args),
    assertCanViewCamera: async (_user: AuthUser, cameraId: string) => {
      order.push(`access:${cameraId}`);
    },
  };
  const audit = { log: async () => order.push('audit') };
  const controller = new RecordingsController({} as any, recordings as any, {} as any, {} as any, access as any, audit as any);

  const result = await controller.downloadRecording(user, 'rec-1', { headers: {} } as any, {} as any);

  assert.equal(result, 'streamed');
  assert.deepEqual(order, ['recording:rec-1', 'access:cam-1', 'audit', 'download:rec-1']);
});

test('permissions: defaults incluem PTZ para operador e bloqueiam viewer', () => {
  assert.equal(DEFAULT_PERMISSIONS.OPERATOR.ptzControl, true);
  assert.equal(DEFAULT_PERMISSIONS.VIEWER.ptzControl, false);
});

test('permissions: matriz persistida antiga herda novas chaves pelo default do papel', () => {
  const storedBeforePtzKey = { liveView: true, playback: true };

  assert.equal(normalizeMatrix(storedBeforePtzKey, DEFAULT_PERMISSIONS.OPERATOR).ptzControl, true);
  assert.equal(normalizeMatrix({ ...storedBeforePtzKey, ptzControl: false }, DEFAULT_PERMISSIONS.OPERATOR).ptzControl, false);
});

test('permissions guard: bloqueia rota com permissao fina ausente', async () => {
  const user: AuthUser = { id: 'viewer', email: 'viewer@test.local', name: 'Viewer', role: UserRole.VIEWER };
  const reflector = { getAllAndOverride: () => 'ptzControl' };
  const rolePermissions = { hasPermission: async () => false };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
  const guard = new PermissionsGuard(reflector as any, rolePermissions as any);

  await assert.rejects(() => guard.canActivate(context as any), ForbiddenException);
});

test('permissions guard: super admin ignora bloqueio da matriz fina', async () => {
  const user: AuthUser = { id: 'root', email: 'root@test.local', name: 'Root', role: UserRole.SUPER_ADMIN };
  const reflector = { getAllAndOverride: () => 'serverConfig' };
  const rolePermissions = { hasPermission: async () => false };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
  const guard = new PermissionsGuard(reflector as any, rolePermissions as any);

  assert.equal(await guard.canActivate(context as any), true);
});

test('group tenancy: admin de grupo lista somente usuarios dos grupos administrados', async () => {
  const actor: AuthUser = { id: 'manager', email: 'manager@test.local', name: 'Manager', role: UserRole.OPERATOR };
  const prisma = {
    user: {
      findMany: async (args: any) => {
        assert.deepEqual(args.where.cameraPermissions.some.groupId.in, ['group-car']);
        return [{
          id: 'client-user',
          name: 'Cliente',
          email: 'cliente@test.local',
          role: UserRole.VIEWER,
          isActive: true,
          passwordHash: 'hidden',
          createdAt: new Date(),
          updatedAt: new Date(),
        }];
      },
    },
  };
  const access = { getAdminGroupIds: async () => ['group-car'] };
  const service = new UsersService(prisma as any, { canAssignRole: () => false } as any, settings() as any, access as any);

  const result = await service.list(actor);

  assert.equal(result.length, 1);
  assert.equal('passwordHash' in result[0], false);
});

test('group tenancy: admin de grupo cria usuario ja vinculado ao proprio grupo', async () => {
  const actor: AuthUser = { id: 'manager', email: 'manager@test.local', name: 'Manager', role: UserRole.OPERATOR };
  let createArgs: any = null;
  const prisma = {
    user: {
      create: async (args: any) => {
        createArgs = args;
        return {
          id: 'new-user',
          name: args.data.name,
          email: args.data.email,
          role: args.data.role,
          isActive: true,
          passwordHash: args.data.passwordHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
  };
  const access = { getAdminGroupIds: async () => ['group-car'] };
  const service = new UsersService(prisma as any, { canAssignRole: () => false } as any, settings() as any, access as any);

  const result = await service.create(actor, {
    name: 'Operador Loja',
    email: ' operador@loja.test ',
    password: 'SenhaForte#123',
    role: UserRole.VIEWER,
    groupIds: ['group-car'],
    permissionLevel: CameraPermissionLevel.CONTROL,
  });

  assert.equal(result.email, 'operador@loja.test');
  assert.deepEqual(createArgs.data.cameraPermissions.create, [{ groupId: 'group-car', level: CameraPermissionLevel.CONTROL }]);
});

test('group tenancy: admin de grupo nao vincula usuario fora do proprio grupo', async () => {
  const actor: AuthUser = { id: 'manager', email: 'manager@test.local', name: 'Manager', role: UserRole.OPERATOR };
  const access = { getAdminGroupIds: async () => ['group-car'] };
  const service = new UsersService({} as any, { canAssignRole: () => false } as any, settings() as any, access as any);

  await assert.rejects(
    () => service.create(actor, {
      name: 'Intruso',
      email: 'intruso@loja.test',
      password: 'SenhaForte#123',
      role: UserRole.VIEWER,
      groupIds: ['group-other'],
    }),
    ForbiddenException,
  );
});

test('ai intelligence: agrega health e cameras sem iniciar processadores', async () => {
  const originalFilters = {
    AI_FORCE_SINGLE_CAMERA: process.env.AI_FORCE_SINGLE_CAMERA,
    AI_SINGLE_CAMERA_ID: process.env.AI_SINGLE_CAMERA_ID,
    AI_ENABLED_CAMERA_IDS: process.env.AI_ENABLED_CAMERA_IDS,
    AI_ACTIVE_CAMERA_IDS: process.env.AI_ACTIVE_CAMERA_IDS,
    AI_ANALYTICS_CAMERA_IDS: process.env.AI_ANALYTICS_CAMERA_IDS,
  };
  delete process.env.AI_FORCE_SINGLE_CAMERA;
  delete process.env.AI_SINGLE_CAMERA_ID;
  delete process.env.AI_ENABLED_CAMERA_IDS;
  delete process.env.AI_ACTIVE_CAMERA_IDS;
  delete process.env.AI_ANALYTICS_CAMERA_IDS;

  try {
    const settingsRow = { id: 'global', enabled: true, mode: 'general', updatedAt: new Date('2026-06-04T00:00:00.000Z') };
    const camerasService = {
      findAllInternal: async () => [{
        id: 'cam-ai',
        name: 'Entrada',
        ip: '10.0.0.10',
        status: 'ONLINE',
        aiEnabled: true,
        channel: 1,
        subtype: 0,
        liveChannel: 1,
        liveSubtype: 0,
        recordingChannel: 1,
        recordingSubtype: 0,
        analyticsChannel: 1,
        analyticsSubtype: 1,
        preferredLiveProtocol: 'webrtc',
        streamVideoCodec: 'h264',
        recordingVideoCodec: 'h265',
        recordingMode: 'continuous',
        recordingEnabled: true,
      }],
    };
    const aiService = {
      getHealth: async () => ({
        status: 'online',
        active_processors: ['cam-ai'],
        static_profiles: {
          general: {
            model: 'yolo26n',
            runtime: 'openvino_cpu',
            precision: 'int8',
            analysis_width: 960,
            analysis_height: 540,
            imgsz: 640,
            detection_fps: 4,
            classes: ['person', 'bicycle', 'car', 'motorcycle'],
            class_ids: [0, 1, 2, 3],
            tracker: 'bytetrack',
            overlay_mode: 'triangle',
            overlay_ttl_ms: 600,
            lost_ttl_ms: 600,
          },
        },
        model_registry: {
          detectors: {
            general: {
              model: 'yolo26n',
              active_precision: 'int8',
              available_input_sizes: [640],
              last_selected_input_size: 640,
              pool_busy_drops: 0,
              inference_threads: 8,
              infer_workers: 1,
              active_class_ids: [0, 1, 2, 3],
              openvino_device: 'CPU',
            },
          },
        },
        processors: {
          'cam-ai': {
            running: true,
            analysis_type: 'general',
            advanced_analysis_type: 'general',
            process_fps: 4,
            advanced_process_fps: 4,
            capture_frames_enqueued: 100,
            capture_frames_dropped: 0,
            source: {
              kind: 'direct_camera',
              usesMediaMtx: false,
              audioRequested: false,
              analyticsSourceUrlSanitized: 'rtsp://entrada:***@10.0.0.10:554/cam/realmonitor?channel=1&subtype=1',
              analyticsSourceCodec: 'h264',
            },
            stream: {
              codec: 'h264',
              width: 640,
              height: 360,
              capture_fps: 3.9,
              inference_fps: 3.8,
              frame_age_avg_ms: 80,
              latest_frame_only: true,
              buffer_size: 1,
              queue_size: 0,
              dropped_frames: 0,
            },
            live_view: {
              active_sessions: 1,
              feature_flags: { qos_live_enabled: true, adaptive_enabled_for_camera: false },
              adaptive: { metrics: {} },
            },
            performance: {
              advanced_infer_runs: 20,
              advanced_infer_errors: 0,
              advanced_infer_avg_ms: 22,
              advanced_infer_p95_ms: 30,
              pool_busy_drops: 0,
              overlay_payload_frames: 10,
              overlay_empty_frames: 2,
              overlay_payload_ratio: 0.83,
            },
          },
        },
      }),
      getLatestDetections: async () => ({ status: 'ok', detections: [] }),
      stopAnalysis: async () => ({ status: 'stopped' }),
      startAnalysisWithConfig: async () => ({ status: 'started' }),
    };
    const prisma = { aiSettings: { upsert: async () => settingsRow } };
    const commercialPolicy = { isAllowed: async () => true };
    const service = new AiManagerService(
      camerasService as any,
      aiService as any,
      {} as any,
      prisma as any,
      {} as any,
      commercialPolicy as any,
    );

    const overview = await service.getIntelligenceOverview(['cam-ai']);

    assert.equal(overview.status, 'ok');
    assert.equal(overview.summary.runningProcessors, 1);
    assert.equal(overview.summary.directCameraSources, 1);
    assert.equal(overview.summary.mediaMtxSources, 0);
    assert.equal(overview.cameras[0].source.directCamera, true);
    assert.equal(overview.cameras[0].profiles.analytics.separatedFromLive, true);
    assert.equal(overview.cameras[0].health.state, 'healthy');
    assert.equal(overview.model.profile.model, 'yolo26n');
  } finally {
    for (const [key, value] of Object.entries(originalFilters)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('ai intelligence: sinaliza camera habilitada sem processador', async () => {
  const settingsRow = { id: 'global', enabled: true, mode: 'general', updatedAt: new Date('2026-06-04T00:00:00.000Z') };
  const service = new AiManagerService(
    {
      findAllInternal: async () => [{
        id: 'cam-missing',
        name: 'Portao',
        ip: '10.0.0.11',
        status: 'ONLINE',
        aiEnabled: true,
        channel: 1,
        subtype: 0,
        liveChannel: 1,
        liveSubtype: 0,
        recordingChannel: 1,
        recordingSubtype: 0,
        analyticsChannel: 1,
        analyticsSubtype: 1,
        preferredLiveProtocol: 'webrtc',
        recordingEnabled: true,
      }],
    } as any,
    { getHealth: async () => ({ status: 'online', processors: {} }) } as any,
    {} as any,
    { aiSettings: { upsert: async () => settingsRow } } as any,
    {} as any,
    { isAllowed: async () => true } as any,
  );

  const overview = await service.getIntelligenceOverview(['cam-missing']);

  assert.equal(overview.status, 'critical');
  assert.equal(overview.summary.expectedProcessors, 1);
  assert.equal(overview.summary.runningProcessors, 0);
  assert.equal(overview.cameras[0].health.state, 'stopped');
  assert.equal(overview.recommendations.some((item) => item.code === 'missing_processors'), true);
});

test('group tenancy: admin de grupo NAO anexa usuario de fora ao proprio grupo', async () => {
  // A permissão criada aqui é a MESMA prova que users.service.assertCanManageUser usa
  // para decidir quem o admin de grupo pode gerenciar. Sem validar o alvo, ele anexava a
  // vítima e depois trocava a senha dela (takeover entre tenants).
  const actor: AuthUser = { id: 'manager', email: 'm@t.local', name: 'M', role: UserRole.OPERATOR };
  const prisma = {
    user: { findUnique: async () => ({ id: 'vitima' }) },
    cameraGroup: { findUnique: async () => ({ id: 'grupo-do-manager' }) },
    cameraPermission: {
      // a vítima NÃO tem permissão em nenhum grupo do ator
      findFirst: async () => null,
      create: async () => assert.fail('não deveria criar permissão para usuário de fora'),
    },
  } as any;
  const accessControl = {
    assertCanAdminGroup: async () => undefined,
    getAdminGroupIds: async () => ['grupo-do-manager'],
  } as any;
  const service = new CameraPermissionsService(prisma, accessControl);
  await assert.rejects(
    () => service.grant(actor, { userId: 'vitima', groupId: 'grupo-do-manager', level: CameraPermissionLevel.VIEW } as any),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

test('escalation: admin de grupo NAO altera o proprio perfil', async () => {
  const actor: AuthUser = { id: 'self', email: 's@t.local', name: 'S', role: UserRole.VIEWER };
  const prisma = {
    user: {
      findUnique: async () => ({ id: 'self', role: UserRole.VIEWER }),
      update: async () => assert.fail('não deveria promover a si mesmo'),
    },
    // o ator administra o grupo em que ele próprio está → assertCanManageUser passaria
    cameraPermission: { findFirst: async () => ({ id: 'perm-do-proprio-grupo' }) },
  } as any;
  const access = { getAdminGroupIds: async () => ['g1'] };
  const service = new UsersService(prisma, { canAssignRole: () => true } as any, settings() as any, access as any);
  await assert.rejects(
    () => service.update(actor, 'self', { role: UserRole.OPERATOR } as any),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

test('investigations: cadeia de custodia nao vaza auditoria global', () => {
  const source = readFileSync('src/investigations/investigations.service.ts', 'utf8');
  const custody = source.slice(source.indexOf('async getCustodyChain'), source.indexOf('async getCustodyChain') + 1600);
  assert.match(
    custody,
    /entityType: 'InvestigationItem', entityId: \{ in: itemIds \}/,
    'o ramo InvestigationItem precisa ser escopado aos itens desta investigação',
  );
  assert.doesNotMatch(
    custody,
    /\{ action: \{ contains: 'evidence' \} \},/,
    "o ramo 'evidence' não pode ser global — escopar à investigação",
  );
});

test('investigations: download de pacote valida a raiz do arquivo', () => {
  const source = readFileSync('src/investigations/investigations.service.ts', 'utf8');
  assert.match(
    source,
    /ensureFileUnderRoot\(\s*process\.env\.EVIDENCE_PACKAGES_ROOT/,
    'o filePath vem do metadata (controlável pelo cliente) — validar a raiz antes de servir',
  );
  const dto = readFileSync('src/investigations/dto/create-investigation-item.dto.ts', 'utf8');
  assert.match(dto, /IsNotIn\(SERVER_OWNED_INVESTIGATION_ITEM_TYPES/, 'tipos server-only não podem ser forjados');
  assert.match(dto, /'export_package'/, 'export_package precisa estar entre os reservados');
});

test('permissions audit: rotas sensiveis mantem RequirePermission', () => {
  assertRoutePermission('src/settings/settings.controller.ts', "@Patch()", 'serverConfig');
  assertRoutePermission('src/role-permissions/role-permissions.controller.ts', "@Patch(':role')", 'roleManage');
  assertRoutePermission('src/camera-stream/camera-stream.controller.ts', "@Post(':cameraId/token')", 'liveView');
  assertRoutePermission('src/camera-stream/camera-stream.controller.ts', "@Post(':cameraId/live-failure')", 'liveView');
  assertRoutePermission('src/camera-stream/camera-stream.controller.ts', "@Get('resource-diagnostics')", 'liveView');
  assertRoutePermission('src/camera-stream/camera-stream.controller.ts', "@Get('optimization-plan')", 'cameraConfig');
  assertRoutePermission('src/camera-stream/camera-stream.controller.ts', "@Post('optimization/apply-safe')", 'cameraConfig');
  assertRoutePermission('src/ptz/ptz.controller.ts', "@Post(':cameraId/move')", 'ptzControl');
  assertRoutePermission('src/recordings/recordings.controller.ts', "@Post('recordings/:id/play-token')", 'playback');
  assertRoutePermission('src/recordings/recordings.controller.ts', "@Post('recordings/:id/compatible/prepare')", 'playback');
  assertRoutePermission('src/recordings/recordings.controller.ts', "@Post('recordings/:id/clips/export')", 'exportEvidence');
  assertRoutePermission('src/evidence/evidence.controller.ts', "@Post('sign')", 'exportEvidence');
  assertRoutePermission('src/alarms/alarms.controller.ts', "@Post('rules/:id/mute')", 'alarmAck');
  assertRoutePermission('src/ai/ai.controller.ts', "@Patch('settings')", 'serverConfig');
  assertRoutePermission('src/ai/ai.controller.ts', "@Post('sync')", 'serverConfig');
});
