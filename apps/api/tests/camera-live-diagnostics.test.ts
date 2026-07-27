import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildCameraDiagnosticsReport,
  type CameraDiagnosticsReport,
} from '../src/cameras/helpers/camera-diagnostics-report.helper';
import { CamerasService } from '../src/cameras/cameras.service';

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNÓSTICO RICO DA CÂMERA JÁ SALVA
//
// O chamado mais caro do VMS é o que exige VOLTAR AO LOCAL. Hoje o diagnóstico
// detalhado só existe no CADASTRO; depois da câmera salva sobram três booleanos
// (rtspReachable / onvifReachable / status). Quando uma câmera que era boa
// DEGRADA — o firmware trocou o perfil, o substream sumiu, o codec virou H.265 —
// o técnico não tem como saber disso sem ir até lá.
//
// O que este helper decide é a única coisa que importa nessa hora: o que está
// CONFIGURADO (o que o DRAC acredita) contra o que foi DETECTADO AGORA. A
// DIVERGÊNCIA é o diagnóstico.
//
// Regra de ouro do DRAC (VMS probatório): a tela NUNCA pode quebrar por causa de
// uma câmera muda, e credencial de câmera NUNCA sai na resposta.
// ─────────────────────────────────────────────────────────────────────────────

const CHECKED_AT = '2026-07-27T18:00:00.000Z';

// Câmera "saudável" de referência: 1080p H.264 25fps com substream separado —
// exatamente o que o assistente de cadastro grava no banco quando dá tudo certo.
function healthyInput() {
  return {
    checkedAt: CHECKED_AT,
    configured: {
      videoCodec: 'h264',
      width: 1920,
      height: 1080,
      fps: 25,
      rtspPort: 554,
      rtspPath: '/cam/realmonitor?channel=1&subtype=0',
      audioEnabled: false,
      liveSubtype: 0,
      analyticsSubtype: 1,
      recordingCodecMode: 'copy' as const,
    },
    detected: {
      reachable: true,
      main: {
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: 25,
        bitrateKbps: 4096,
        rtspPort: 554,
        rtspPath: '/cam/realmonitor?channel=1&subtype=0',
      },
      sub: {
        codec: 'h264',
        width: 640,
        height: 360,
        fps: 15,
        bitrateKbps: 512,
        rtspPort: 554,
        rtspPath: '/cam/realmonitor?channel=1&subtype=1',
      },
      error: null,
    },
  };
}

function finding(report: CameraDiagnosticsReport, key: string) {
  const found = report.findings.find((item) => item.key === key);
  assert.ok(found, `esperava a divergência "${key}" no relatório`);
  return found;
}

function verdict(report: CameraDiagnosticsReport, pipeline: string) {
  const found = report.transcode.find((item) => item.pipeline === pipeline);
  assert.ok(found, `esperava o veredito de transcode "${pipeline}"`);
  return found;
}

// ── 1. Nada divergiu ────────────────────────────────────────────────────────

test('câmera intacta: todos os campos casam e o estado é ok', () => {
  const report = buildCameraDiagnosticsReport(healthyInput());

  assert.equal(report.state, 'ok');
  assert.equal(report.reachable, true);
  assert.equal(report.checkedAt, CHECKED_AT);
  assert.equal(
    report.findings.every((item) => item.state === 'match'),
    true,
    `nenhum campo deveria divergir: ${JSON.stringify(report.findings.filter((f) => f.state !== 'match'))}`,
  );
  assert.equal(finding(report, 'codec').detected, 'H.264');
  assert.equal(finding(report, 'resolution').detected, '1920x1080');
  assert.equal(finding(report, 'substream').state, 'match');
});

// ── 2. Firmware trocou o codec: o caso que mais gera visita técnica ─────────

test('codec virou H.265 depois de salvo: divergência CRÍTICA e live passa a transcodificar', () => {
  const input = healthyInput();
  input.detected.main.codec = 'hevc';
  const report = buildCameraDiagnosticsReport(input);

  const codec = finding(report, 'codec');
  assert.equal(codec.state, 'diverged');
  assert.equal(codec.severity, 'critical');
  assert.equal(codec.configured, 'H.264');
  assert.equal(codec.detected, 'H.265');
  assert.equal(report.state, 'diverged');

  // O "por que está transcodificando" precisa apontar a CAUSA medida, não um
  // palpite: o navegador não decodifica H.265 em WebRTC, então a live passa a
  // gastar CPU do servidor. É isso que o técnico precisa ler na tela.
  const live = verdict(report, 'live_single');
  assert.equal(live.transcoding, true);
  assert.equal(live.code, 'source_hevc');
  assert.equal(live.certainty, 'measured');
});

test('codec continua H.264 e sem áudio: live é passthrough (sem CPU à toa)', () => {
  const live = verdict(buildCameraDiagnosticsReport(healthyInput()), 'live_single');
  assert.equal(live.transcoding, false);
  assert.equal(live.code, 'passthrough');
});

test('áudio ligado em H.264 transcodifica a live por causa do WebRTC, não do vídeo', () => {
  const input = healthyInput();
  input.configured.audioEnabled = true;
  const live = verdict(buildCameraDiagnosticsReport(input), 'live_single');
  assert.equal(live.transcoding, true);
  assert.equal(live.code, 'audio_webrtc');
});

// ── 3. Resolução caiu — o bug do rtspPath grudento, visto em produção ───────

test('resolução DESPENCOU: é crítico, não um "aviso" (a gravação perde prova)', () => {
  const input = healthyInput();
  input.detected.main.width = 640;
  input.detected.main.height = 360;
  const report = buildCameraDiagnosticsReport(input);

  const resolution = finding(report, 'resolution');
  assert.equal(resolution.state, 'diverged');
  assert.equal(
    resolution.severity,
    'critical',
    'cair de 1080p para 360p degrada a PROVA; tratar como aviso esconde o problema',
  );
  assert.equal(resolution.configured, '1920x1080');
  assert.equal(resolution.detected, '640x360');
  assert.match(resolution.message, /menor|caiu|queda/i);
});

test('resolução SUBIU: diverge, mas é só aviso (ninguém perde prova ganhando pixel)', () => {
  const input = healthyInput();
  input.detected.main.width = 2592;
  input.detected.main.height = 1944;
  const resolution = finding(buildCameraDiagnosticsReport(input), 'resolution');
  assert.equal(resolution.state, 'diverged');
  assert.equal(resolution.severity, 'warning');
});

// ── 4. FPS: tolerância honesta ──────────────────────────────────────────────

test('FPS com 1 quadro de diferença é arredondamento do ffprobe, não divergência', () => {
  const input = healthyInput();
  input.detected.main.fps = 24;
  assert.equal(finding(buildCameraDiagnosticsReport(input), 'fps').state, 'match');
});

test('FPS caindo de 25 para 8 é divergência de verdade', () => {
  const input = healthyInput();
  input.detected.main.fps = 8;
  const fps = finding(buildCameraDiagnosticsReport(input), 'fps');
  assert.equal(fps.state, 'diverged');
  assert.equal(fps.severity, 'warning');
});

// ── 5. Caminho/porta RTSP mudaram ───────────────────────────────────────────

test('caminho RTSP que respondeu difere do configurado: divergência visível', () => {
  const input = healthyInput();
  input.detected.main.rtspPath = '/Streaming/Channels/102';
  const path = finding(buildCameraDiagnosticsReport(input), 'rtsp_path');
  assert.equal(path.state, 'diverged');
  assert.equal(path.configured, '/cam/realmonitor?channel=1&subtype=0');
  assert.equal(path.detected, '/Streaming/Channels/102');
});

test('porta RTSP que respondeu difere da configurada', () => {
  const input = healthyInput();
  input.detected.main.rtspPort = 8554;
  const port = finding(buildCameraDiagnosticsReport(input), 'rtsp_port');
  assert.equal(port.state, 'diverged');
  assert.equal(port.configured, '554');
  assert.equal(port.detected, '8554');
});

// ── 6. Substream sumiu ──────────────────────────────────────────────────────

test('substream configurado mas AUSENTE agora: divergência (a detecção de movimento lê ele)', () => {
  const input = healthyInput();
  input.detected.sub = null;
  const report = buildCameraDiagnosticsReport(input);

  const sub = finding(report, 'substream');
  assert.equal(sub.state, 'diverged');
  assert.equal(sub.severity, 'warning');
  assert.equal(sub.detected, 'ausente');
  assert.match(sub.message, /substream/i);
});

test('sem substream configurado e sem substream detectado: não inventa divergência', () => {
  const input = healthyInput();
  input.configured.analyticsSubtype = 0;
  input.detected.sub = null;
  const sub = finding(buildCameraDiagnosticsReport(input), 'substream');
  assert.equal(sub.state, 'match');
});

test('grade usa o substream: substream H.265 faz a grade transcodificar', () => {
  const input = healthyInput();
  input.detected.sub.codec = 'h265';
  const grid = verdict(buildCameraDiagnosticsReport(input), 'live_grid');
  assert.equal(grid.transcoding, true);
  assert.equal(grid.code, 'source_hevc');
});

// ── 7. Gravação: o modo real do DRAC é 'copy' (arquiva o bitstream original) ─

test("gravação em modo 'copy' NUNCA transcodifica — nem com fonte H.265", () => {
  const input = healthyInput();
  input.detected.main.codec = 'hevc';
  const recording = verdict(buildCameraDiagnosticsReport(input), 'recording');
  assert.equal(
    recording.transcoding,
    false,
    "modo copy arquiva o bitstream original; dizer que transcodifica seria mentir na tela",
  );
  assert.equal(recording.code, 'passthrough');
});

test("gravação em modo 'h265' com fonte H.264 transcodifica, e o motivo é o MODO", () => {
  const input = healthyInput();
  input.configured.recordingCodecMode = 'h265';
  const recording = verdict(buildCameraDiagnosticsReport(input), 'recording');
  assert.equal(recording.transcoding, true);
  assert.equal(recording.code, 'codec_mode_h265');
});

test("gravação em modo 'h265' com fonte já H.265 volta a ser cópia", () => {
  const input = healthyInput();
  input.configured.recordingCodecMode = 'h265';
  input.detected.main.codec = 'h265';
  const recording = verdict(buildCameraDiagnosticsReport(input), 'recording');
  assert.equal(recording.transcoding, false);
  assert.equal(recording.code, 'passthrough');
});

// ── 8. Degradação graciosa: a câmera não responde ───────────────────────────

test('câmera muda: relatório completo, sem exceção e sem campo inventado', () => {
  const input = healthyInput();
  const report = buildCameraDiagnosticsReport({
    ...input,
    detected: { reachable: false, main: null, sub: null, error: 'Connection timed out' },
  });

  assert.equal(report.state, 'unreachable');
  assert.equal(report.reachable, false);
  assert.ok(report.summary.length > 0, 'a tela precisa de um texto mesmo sem resposta da câmera');
  assert.equal(
    report.findings.every((item) => item.state === 'unknown'),
    true,
    'sem resposta da câmera NADA pode ser declarado "match" nem "diverged" — seria inventar',
  );
  // Continua mostrando o CONFIGURADO: é o que o técnico compara com a etiqueta
  // da câmera no local antes de subir na escada.
  assert.equal(finding(report, 'codec').configured, 'H.264');
  assert.equal(finding(report, 'codec').detected, null);
  // O veredito de transcode ainda aparece, mas marcado como suposição.
  assert.equal(verdict(report, 'live_single').certainty, 'assumed');
});

test('entrada corrompida (tudo nulo) não derruba o relatório', () => {
  const report = buildCameraDiagnosticsReport({
    checkedAt: CHECKED_AT,
    configured: {},
    detected: { reachable: true, main: null, sub: null },
  });
  assert.ok(Array.isArray(report.findings) && report.findings.length > 0);
  assert.ok(typeof report.summary === 'string' && report.summary.length > 0);
});

// ── 9. LGPD / segredo: credencial de câmera não sai na resposta ─────────────

test('erro do ffprobe com a URL inteira NÃO vaza a senha no relatório', () => {
  const report = buildCameraDiagnosticsReport({
    checkedAt: CHECKED_AT,
    configured: { videoCodec: 'h264' },
    detected: {
      reachable: false,
      main: null,
      sub: null,
      // stderr CRU do ffprobe: ele imprime a URL de entrada INTEIRA.
      error: "rtsp://admin:S3nh4Sup3rS3cr3t4@192.168.20.149:554/cam/realmonitor: Connection refused",
    },
  });

  const serialized = JSON.stringify(report);
  assert.equal(
    serialized.includes('S3nh4Sup3rS3cr3t4'),
    false,
    'a senha da câmera chegaria ao navegador do cliente — vazamento de credencial',
  );
  assert.match(String(report.error), /<redacted>@/);
});

test('caminho RTSP colado como URL completa também é redigido', () => {
  const report = buildCameraDiagnosticsReport({
    checkedAt: CHECKED_AT,
    configured: { rtspPath: 'rtsp://admin:OutraS3nha@10.0.0.9:554/live' },
    detected: { reachable: true, main: null, sub: null },
  });
  assert.equal(JSON.stringify(report).includes('OutraS3nha'), false);
});

// ── 10. O serviço: sonda real trocada por dublê, resto é o código de produção ─

const CAMERA_ROW = {
  id: 'cam-7',
  name: 'Estacionamento 7',
  ip: '192.168.20.149',
  rtspPort: 554,
  rtspPath: '/cam/realmonitor?channel=1&subtype=0',
  username: 'admin',
  passwordEncrypted: 'enc:...',
  channel: 1,
  subtype: 0,
  liveChannel: 1,
  liveSubtype: 0,
  analyticsChannel: 1,
  analyticsSubtype: 1,
  recordingChannel: 1,
  recordingSubtype: 0,
  audioEnabled: false,
  preferredRtspTransport: 'tcp',
  detectedVideoCodec: 'h264',
  detectedWidth: 1920,
  detectedHeight: 1080,
  detectedFps: 25,
  detectedBitrateKbps: 4096,
  streamVideoCodec: 'original',
  recordingVideoCodec: 'h265',
};

// A sonda (ffprobe) é o ÚNICO dublê: tudo o mais é o serviço de produção.
// A forma devolvida é exatamente a de `probeRtspPaths`.
function serviceWithProbe(probe: (paths: string[]) => unknown) {
  const service = new CamerasService(
    { camera: { findUnique: async () => ({ ...CAMERA_ROW }) } } as any,
    { get: (key: string) => (key === 'recordingCodecMode' ? 'copy' : undefined) } as any,
    { decrypt: () => SERVICE_PASSWORD } as any,
    { check: async () => true } as any,
    {} as any,
  );
  (service as any).probeRtspPaths = async (input: { paths: string[] }) => probe(input.paths);
  return service;
}

const SERVICE_PASSWORD = 'S3nh4D0Cli3nt3';

test('serviço: divergência de codec sai montada e sem a senha da câmera', async () => {
  const service = serviceWithProbe((paths) => ({
    ok: true,
    port: 554,
    path: paths[0],
    error: null,
    // A câmera trocou de perfil: agora entrega H.265 onde o cadastro anotou H.264.
    metadata: { codec: 'hevc', width: 1920, height: 1080, fps: 25, bitrateKbps: 6000 },
  }));

  const report = await service.getLiveDiagnostics('cam-7');

  assert.equal(report.state, 'diverged');
  assert.equal(finding(report as CameraDiagnosticsReport, 'codec').detected, 'H.265');
  assert.equal(verdict(report as CameraDiagnosticsReport, 'live_single').code, 'source_hevc');

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(SERVICE_PASSWORD), false, 'senha decifrada no payload do diagnóstico');
  assert.equal(serialized.includes('passwordEncrypted'), false, 'o segredo cifrado também não pode sair');
});

test('serviço: câmera muda devolve relatório utilizável em vez de estourar a tela', async () => {
  const service = serviceWithProbe(() => ({
    ok: false,
    port: null,
    path: null,
    error: `rtsp://admin:${SERVICE_PASSWORD}@192.168.20.149:554/cam/realmonitor: Connection timed out`,
    metadata: null,
  }));

  const report = await service.getLiveDiagnostics('cam-7');

  assert.equal(report.state, 'unreachable');
  assert.equal(report.reachable, false);
  assert.ok(report.summary.length > 0);
  assert.equal(
    JSON.stringify(report).includes(SERVICE_PASSWORD),
    false,
    'o stderr do ffprobe carrega a URL inteira — a senha iria para o navegador',
  );
});

test('serviço: sonda que explode não derruba a rota de diagnóstico', async () => {
  const service = serviceWithProbe(() => {
    throw new Error('ffprobe: spawn ENOENT');
  });
  const report = await service.getLiveDiagnostics('cam-7');
  assert.equal(report.state, 'unreachable');
  assert.ok(String(report.error).length > 0);
});

// As sondas do cadastro usam timers e concorrência vindos do ambiente. Um
// `Number(process.env.X)` inválido vira NaN, e NaN não explode: `setTimeout(NaN)`
// dispara em ~1ms (mata TODA sonda antes da câmera responder) e
// `index += NaN` encerra o laço na primeira volta (NENHUM caminho é testado).
// Nos dois casos o cadastro passa a falhar 100% das vezes, sem um erro no log.
test('sondas RTSP não usam Number() cru em variável de ambiente', () => {
  const service = readFileSync('src/cameras/cameras.service.ts', 'utf8');
  for (const name of [
    'CAMERA_RTSP_PROBE_TIMEOUT_MS',
    'CAMERA_RTSP_PROBE_KILL_TIMEOUT_MS',
    'CAMERA_RTSP_PROBE_CONCURRENCY',
  ]) {
    assert.doesNotMatch(
      service,
      new RegExp(`Number\\(process\\.env\\.${name}`),
      `${name} com valor inválido viraria NaN e desarmaria a sonda em silêncio`,
    );
    assert.match(service, new RegExp(`envNumber\\('${name}'`), `${name} deve passar por envNumber`);
  }
});
