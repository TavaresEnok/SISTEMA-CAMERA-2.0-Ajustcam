import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CamerasController } from '../src/cameras/cameras.controller';
import { CamerasService } from '../src/cameras/cameras.service';
import type { AuthUser } from '../src/common/types/auth-user.type';
import {
  SNAPSHOT_MAX_HEIGHT,
  buildSnapshotFailure,
  buildSnapshotFfmpegArgs,
  buildSnapshotSuccess,
  isJpegBuffer,
  toJpegDataUrl,
} from '../src/cameras/helpers/camera-snapshot.helper';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRMAÇÃO VISUAL NO CADASTRO
//
// Hoje o integrador cadastra a câmera vendo só metadado: 1920x1080, H.264, 25fps.
// Metadado NÃO distingue "câmera 7 do estacionamento" de "câmera 3 da recepção".
// Quando os IPs são trocados na planilha, ninguém percebe — até o cliente pedir a
// gravação de um evento e receber o corredor errado. Aí alguém VOLTA AO LOCAL,
// que é o chamado mais caro do negócio.
//
// A correção é boba e definitiva: mostrar UM FRAME antes de salvar.
//
// Só que esse frame nasce de um FFmpeg alimentado com a CREDENCIAL DA CÂMERA, e o
// stderr do FFmpeg imprime a URL de entrada inteira (rtsp://user:senha@...). Já
// mordeu esta base antes. Por isso metade destes testes é sobre vazamento.
// ─────────────────────────────────────────────────────────────────────────────

const CAPTURED_AT = '2026-07-27T18:30:00.000Z';
const SOURCE = { rtspPort: 554, rtspPath: '/cam/realmonitor?channel=1&subtype=0', transport: 'tcp' as const };
const SECRET = 'S3nh4Sup3rS3cr3t4';
const RTSP_WITH_SECRET = `rtsp://admin:${SECRET}@192.168.20.149:554/cam/realmonitor?channel=1&subtype=0`;

function jpeg(payloadBytes = 64): Buffer {
  // JPEG mínimo plausível: SOI ... EOI. É o contrato que a validação usa.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(payloadBytes, 0x41),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// ── 1. Argumentos do FFmpeg: um frame, sem áudio, sem shell ────────────────

test('captura pede UM frame JPEG e nada mais', () => {
  const args = buildSnapshotFfmpegArgs({ rtspUrl: RTSP_WITH_SECRET, transport: 'tcp' });

  assert.equal(args[args.indexOf('-frames:v') + 1], '1', 'mais de um frame vira stream, não snapshot');
  assert.ok(args.includes('-an'), 'áudio na captura de imagem é banda e CPU jogados fora');
  assert.equal(args[args.indexOf('-vcodec') + 1], 'mjpeg');
  assert.equal(args[args.length - 1], 'pipe:1', 'o frame sai pelo stdout; nada é escrito em disco');
  assert.equal(args[args.indexOf('-rtsp_transport') + 1], 'tcp');
});

test('a URL com credencial vai como UM argumento próprio do argv (nunca concatenada)', () => {
  const args = buildSnapshotFfmpegArgs({ rtspUrl: RTSP_WITH_SECRET });
  const withSecret = args.filter((arg) => arg.includes(SECRET));
  assert.deepEqual(
    withSecret,
    [RTSP_WITH_SECRET],
    'a senha só pode existir no elemento -i do argv; qualquer outro lugar é rota de vazamento',
  );
  assert.equal(args[args.indexOf('-i') + 1], RTSP_WITH_SECRET);
});

test('transporte inválido cai em TCP (UDP perdendo pacote devolve frame rasgado)', () => {
  const args = buildSnapshotFfmpegArgs({ rtspUrl: RTSP_WITH_SECRET, transport: 'sctp' as never });
  assert.equal(args[args.indexOf('-rtsp_transport') + 1], 'tcp');
});

test('timeout inválido não vira NaN nos argumentos do FFmpeg', () => {
  const args = buildSnapshotFfmpegArgs({ rtspUrl: RTSP_WITH_SECRET, timeoutUs: Number.NaN });
  const timeout = args[args.indexOf('-timeout') + 1];
  assert.equal(
    Number.isFinite(Number(timeout)),
    true,
    '"-timeout NaN" faz o FFmpeg recusar o comando e a confirmação visual some sem explicação',
  );
});

test('o frame é limitado a 720p: é conferência visual, não arquivo de prova', () => {
  const args = buildSnapshotFfmpegArgs({ rtspUrl: RTSP_WITH_SECRET });
  const filter = args[args.indexOf('-vf') + 1];
  assert.match(filter, new RegExp(String(SNAPSHOT_MAX_HEIGHT)));
  assert.match(filter, /format=yuvj420p/, 'sem isso, fonte com pixel format exótico sai verde/roxa');
});

// ── 2. Validação do que voltou do FFmpeg ───────────────────────────────────

test('só aceita JPEG de verdade (SOI + EOI)', () => {
  assert.equal(isJpegBuffer(jpeg()), true);
  assert.equal(isJpegBuffer(Buffer.from('<html>erro do DVR</html>')), false, 'HTML de erro não é imagem');
  assert.equal(isJpegBuffer(Buffer.from([0xff, 0xd8])), false, 'JPEG truncado é frame pela metade');
  assert.equal(isJpegBuffer(Buffer.alloc(0)), false);
  assert.equal(isJpegBuffer(null), false);
  assert.equal(isJpegBuffer('ffd8ffd9'), false);
});

test('o data URL declara JPEG em base64 e nada mais', () => {
  const url = toJpegDataUrl(jpeg());
  assert.match(url, /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
});

test('buffer que não é JPEG vira FALHA explicada, não imagem quebrada na tela', () => {
  const result = buildSnapshotSuccess({
    buffer: Buffer.from('Unauthorized'),
    source: SOURCE,
    capturedAt: CAPTURED_AT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.imageDataUrl, null);
  assert.ok(result.reason.length > 0);
});

test('captura boa devolve imagem, tamanho e a fonte que respondeu', () => {
  const result = buildSnapshotSuccess({
    buffer: jpeg(),
    source: SOURCE,
    stream: { codec: 'h264', width: 1920, height: 1080, fps: 25 },
    capturedAt: CAPTURED_AT,
  });
  assert.equal(result.ok, true);
  assert.match(String(result.imageDataUrl), /^data:image\/jpeg;base64,/);
  assert.equal(result.bytes, jpeg().length);
  assert.equal(result.capturedAt, CAPTURED_AT);
  assert.equal(result.source.rtspPath, SOURCE.rtspPath);
  assert.deepEqual(result.stream, { codec: 'h264', width: 1920, height: 1080, fps: 25 });
});

// ── 3. Vazamento de credencial: o motivo real destes testes ────────────────

test('falha do FFmpeg NÃO devolve a senha da câmera para o navegador', () => {
  // `error.message` do execFile carrega o stderr CRU: sanitizar só a `url` não basta.
  const result = buildSnapshotFailure({
    error: new Error(`ffmpeg exited with code 1\nError opening input file ${RTSP_WITH_SECRET}.`),
    source: SOURCE,
    capturedAt: CAPTURED_AT,
  });

  assert.equal(result.ok, false);
  assert.equal(
    JSON.stringify(result).includes(SECRET),
    false,
    'a senha da câmera chegaria ao cliente que pediu a confirmação visual',
  );
  assert.match(result.reason, /<redacted>@/);
});

test('a fonte devolvida nunca carrega credencial, nem quando o operador cola a URL inteira no caminho', () => {
  const result = buildSnapshotSuccess({
    buffer: jpeg(),
    source: { rtspPort: 554, rtspPath: RTSP_WITH_SECRET, transport: 'tcp' },
    capturedAt: CAPTURED_AT,
  });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('motivo da falha é truncado (stderr do FFmpeg despeja páginas)', () => {
  const result = buildSnapshotFailure({
    error: new Error('x'.repeat(9000)),
    source: SOURCE,
    capturedAt: CAPTURED_AT,
  });
  assert.ok(result.reason.length <= 320, `reason com ${result.reason.length} caracteres`);
});

// ── 4. Gate de acesso das rotas novas ──────────────────────────────────────

const admin: AuthUser = { id: 'admin-1', email: 'admin@drac.local', name: 'Admin', role: UserRole.ADMIN };

function controllerWith(overrides: {
  access?: Record<string, unknown>;
  cameras?: Record<string, unknown>;
  audit?: Record<string, unknown>;
}) {
  const access = {
    assertCanViewCamera: async () => undefined,
    canViewCamera: async () => true,
    ...(overrides.access ?? {}),
  };
  const cameras = {
    capturePreviewFrame: async () => ({ ok: true }),
    capturePreviewFrameForCamera: async () => ({ ok: true }),
    getLiveDiagnostics: async () => ({ state: 'ok' }),
    ...(overrides.cameras ?? {}),
  };
  const audit = { log: async () => undefined, ...(overrides.audit ?? {}) };
  return {
    controller: new CamerasController(
      cameras as any,
      {} as any,
      access as any,
      audit as any,
      {} as any,
      {} as any,
      {} as any,
    ),
    access,
    cameras,
    audit,
  };
}

test('frame da câmera salva exige o gate de VER (câmera privada: nem o admin vê)', async () => {
  let called: string | null = null;
  const { controller } = controllerWith({
    access: {
      assertCanViewCamera: async (_user: AuthUser, id: string) => {
        called = id;
        throw new ForbiddenException('Sem acesso a esta câmera.');
      },
    },
    cameras: {
      capturePreviewFrameForCamera: async () => {
        assert.fail('a captura não pode nem começar sem o gate');
      },
    },
  });

  await assert.rejects(
    () => controller.previewFrame(admin, 'cam-privada', {} as any, {} as any),
    ForbiddenException,
  );
  assert.equal(called, 'cam-privada');
});

test('diagnóstico rico da câmera salva também passa pelo gate de VER', async () => {
  const { controller } = controllerWith({
    access: {
      assertCanViewCamera: async () => {
        throw new ForbiddenException('Sem acesso a esta câmera.');
      },
    },
    cameras: {
      getLiveDiagnostics: async () => {
        assert.fail('o diagnóstico não pode rodar sem o gate');
      },
    },
  });

  await assert.rejects(() => controller.getLiveDiagnostics(admin, 'cam-privada'), ForbiddenException);
});

test('auditoria da confirmação visual NÃO grava a senha nem a imagem', async () => {
  const logged: unknown[] = [];
  const { controller } = controllerWith({
    cameras: {
      capturePreviewFrame: async () => ({
        ok: true,
        imageDataUrl: toJpegDataUrl(jpeg()),
        bytes: 70,
        capturedAt: CAPTURED_AT,
        source: SOURCE,
        stream: null,
      }),
    },
    audit: {
      log: async (...args: unknown[]) => {
        logged.push(args);
      },
    },
  });

  const body = { ip: '192.168.20.149', rtspPort: 554, username: 'admin', password: SECRET };
  const result = await controller.previewFrameDraft(admin, body as any, {} as any);

  assert.equal(result.ok, true);
  const auditPayload = JSON.stringify(logged);
  assert.equal(auditPayload.includes(SECRET), false, 'a senha da câmera ficaria gravada na trilha de auditoria');
  assert.equal(
    auditPayload.includes('data:image/jpeg'),
    false,
    'a imagem inteira em base64 na auditoria estoura a tabela e guarda conteúdo de câmera privada',
  );
});

// ── 5. Alvo da captura: SSRF sem quebrar a câmera WAN que já existe ────────
//
// A guarda de IP público existe porque o cadastro aceita um alvo DIGITADO pelo
// usuário — sem ela, o campo "IP da câmera" vira um scanner da rede interna do
// servidor (SSRF). Mas a mesma guarda aplicada cegamente na câmera JÁ CADASTRADA
// mataria a conferência de imagem de toda instalação com câmera em IP público
// (WAN), que é caso real nesta base. O alvo guardado NÃO é entrada do usuário: a
// gravação e a live já falam com ele o tempo todo.

const WAN_CAMERA = {
  id: 'cam-wan',
  name: 'Portaria WAN',
  ip: '203.0.113.10',
  rtspPort: 554,
  rtspPath: '/cam/realmonitor?channel=1&subtype=0',
  username: 'admin',
  passwordEncrypted: 'enc:...',
  channel: 1,
  subtype: 0,
  liveChannel: 1,
  liveSubtype: 0,
  analyticsSubtype: 1,
  preferredRtspTransport: 'tcp',
};

function serviceForWanCamera() {
  const service = new CamerasService(
    { camera: { findUnique: async () => ({ ...WAN_CAMERA }) } } as any,
    { get: () => undefined } as any,
    { decrypt: () => SECRET } as any,
    { check: async () => true } as any,
    {} as any,
  );
  // Sonda dublada: a captura nem chega ao FFmpeg, o que importa aqui é a guarda.
  (service as any).probeRtspPaths = async () => ({
    ok: false,
    port: null,
    path: null,
    error: 'ffprobe: Connection timed out',
    metadata: null,
  });
  return service;
}

test('cadastro: IP público DIGITADO continua bloqueado (o campo não é um scanner de rede)', async () => {
  await assert.rejects(
    () =>
      serviceForWanCamera().capturePreviewFrame({
        ip: '203.0.113.10',
        rtspPort: 554,
        username: 'admin',
        password: SECRET,
      }),
    /IP público/,
  );
});

test('câmera JÁ CADASTRADA em IP público segue conferível (falha graciosa, não 400)', async () => {
  const result = await serviceForWanCamera().capturePreviewFrameForCamera('cam-wan');
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0, 'a tela precisa do motivo, não de uma exceção');
});

test('override apontando para OUTRO IP público volta a passar pela guarda', async () => {
  await assert.rejects(
    () => serviceForWanCamera().capturePreviewFrameForCamera('cam-wan', { ip: '198.51.100.7' }),
    /IP público/,
    'trocar o alvo é entrada do usuário outra vez — a guarda de SSRF tem que valer',
  );
});

// ── 6. Anti-regressão estrutural ───────────────────────────────────────────

test('as rotas de frame gateiam por assertCanViewCamera no código', () => {
  const source = readFileSync('src/cameras/cameras.controller.ts', 'utf8');
  const routeBody = (decorator: string) => {
    const start = source.indexOf(decorator);
    assert.notEqual(start, -1, `esperava a rota ${decorator}`);
    const rest = source.slice(start + decorator.length);
    const next = rest.search(/\n {2}@(?:Get|Post|Patch|Put|Delete)\(/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  assert.match(routeBody("@Post(':id/preview-frame')"), /assertCanViewCamera\(/);
  assert.match(routeBody("@Get(':id/live-diagnostics')"), /assertCanViewCamera\(/);
});
