import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diagnosticsTone,
  orderFindings,
  parseDiagnosticsReport,
  summarizeTranscode,
} from '../src/lib/camera-diagnostics.ts';
import {
  describePreviewSource,
  isSafeJpegDataUrl,
  parsePreviewFrame,
} from '../src/lib/camera-preview-frame.ts';

// ─────────────────────────────────────────────────────────────────────────────
// A CAMADA DE TELA dos dois recursos que atacam o chamado mais caro do VMS — o
// que exige VOLTAR AO LOCAL.
//
// Estes módulos são 100% puros: recebem o payload da API e devolvem o que a
// página desenha. A regra dura é a mesma dos dois lados: a tela NÃO PODE
// QUEBRAR. Câmera muda, API antiga, payload truncado, campo nulo — nada disso
// pode virar exceção no meio do cadastro de uma câmera.
// ─────────────────────────────────────────────────────────────────────────────

const REPORT = {
  cameraId: 'cam-7',
  cameraName: 'Estacionamento 7',
  state: 'diverged',
  reachable: true,
  summary: '2 divergência(s) — 1 crítica(s).',
  checkedAt: '2026-07-27T18:00:00.000Z',
  findings: [
    {
      key: 'fps',
      label: 'Taxa de quadros',
      configured: '25 FPS',
      detected: '8 FPS',
      state: 'diverged',
      severity: 'warning',
      message: 'caiu',
    },
    {
      key: 'substream',
      label: 'Substream',
      configured: 'esperado',
      detected: 'presente',
      state: 'match',
      severity: 'info',
      message: 'ok',
    },
    {
      key: 'codec',
      label: 'Codec de vídeo',
      configured: 'H.264',
      detected: 'H.265',
      state: 'diverged',
      severity: 'critical',
      message: 'firmware trocou',
    },
    {
      key: 'rtsp_port',
      label: 'Porta RTSP',
      configured: '554',
      detected: null,
      state: 'unknown',
      severity: 'info',
      message: 'não confirmada',
    },
  ],
  transcode: [
    {
      pipeline: 'live_single',
      label: 'Ao vivo (câmera individual)',
      transcoding: true,
      code: 'source_hevc',
      reason: 'A fonte é H.265 e o navegador não decodifica H.265 em WebRTC.',
      certainty: 'measured',
    },
    {
      pipeline: 'recording',
      label: 'Gravação',
      transcoding: false,
      code: 'passthrough',
      reason: 'Arquiva o bitstream original.',
      certainty: 'measured',
    },
  ],
  detected: { main: 'H.265 · 1920x1080 · 25 FPS', sub: 'H.264 · 640x360 · 15 FPS' },
  error: null,
};

// ── Leitura defensiva do payload ────────────────────────────────────────────

test('payload completo é lido sem perder nada', () => {
  const report = parseDiagnosticsReport(REPORT);
  assert.ok(report);
  assert.equal(report.cameraName, 'Estacionamento 7');
  assert.equal(report.findings.length, 4);
  assert.equal(report.transcode.length, 2);
  assert.equal(report.state, 'diverged');
});

test('lixo no lugar do relatório vira null, não exceção', () => {
  for (const garbage of [null, undefined, 'erro', 42, [], { findings: 'nope' }]) {
    assert.doesNotThrow(() => parseDiagnosticsReport(garbage));
  }
  assert.equal(parseDiagnosticsReport(null), null);
  assert.equal(parseDiagnosticsReport('Internal Server Error'), null);
});

test('payload parcial (API mais antiga) ainda desenha: listas vazias, sem quebrar', () => {
  const report = parseDiagnosticsReport({ state: 'ok', checkedAt: '2026-07-27T18:00:00.000Z' });
  assert.ok(report);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.transcode, []);
  assert.equal(report.reachable, false, 'sem o campo, o honesto é assumir NÃO confirmado');
});

test('item de divergência corrompido é descartado sem levar os outros junto', () => {
  const report = parseDiagnosticsReport({
    ...REPORT,
    findings: [null, 'x', { key: 'codec', label: 'Codec', state: 'diverged', severity: 'critical' }],
  });
  assert.ok(report);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].configured, null);
});

test('estado desconhecido do backend não vira estado inventado', () => {
  const report = parseDiagnosticsReport({ ...REPORT, state: 'explodiu' });
  assert.ok(report);
  assert.equal(report.state, 'unreachable', 'na dúvida o relatório não afirma que está tudo certo');
});

// ── Ordem: o técnico lê de cima para baixo ─────────────────────────────────

test('divergência CRÍTICA vem primeiro; o que casou vai para o fim', () => {
  const report = parseDiagnosticsReport(REPORT);
  assert.ok(report);
  const keys = orderFindings(report.findings).map((item) => item.key);
  assert.deepEqual(
    keys,
    ['codec', 'fps', 'rtsp_port', 'substream'],
    'crítico → divergente → não confirmado → igual ao configurado',
  );
});

// ── Tom visual ─────────────────────────────────────────────────────────────

test('tom segue a gravidade real e não pinta de verde o que não foi confirmado', () => {
  assert.equal(diagnosticsTone({ state: 'diverged', severity: 'critical' }), 'bad');
  assert.equal(diagnosticsTone({ state: 'diverged', severity: 'warning' }), 'warn');
  assert.equal(diagnosticsTone({ state: 'match', severity: 'info' }), 'good');
  assert.equal(
    diagnosticsTone({ state: 'unknown', severity: 'info' }),
    'neutral',
    'pintar de verde o não confirmado faria o técnico deixar a câmera quebrada no local',
  );
});

// ── Motivo de estar transcodificando ───────────────────────────────────────

test('o resumo cita SÓ quem está transcodificando, com o motivo medido', () => {
  const report = parseDiagnosticsReport(REPORT);
  assert.ok(report);
  const lines = summarizeTranscode(report.transcode);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Ao vivo \(câmera individual\)/);
  assert.match(lines[0], /H\.265/);
});

test('ninguém transcodificando devolve lista vazia (sem alarme falso)', () => {
  const lines = summarizeTranscode([
    { pipeline: 'recording', label: 'Gravação', transcoding: false, code: 'passthrough', reason: 'cópia', certainty: 'measured' },
  ]);
  assert.deepEqual(lines, []);
});

test('motivo suposto é marcado como suposição', () => {
  const lines = summarizeTranscode([
    {
      pipeline: 'live_single',
      label: 'Ao vivo',
      transcoding: true,
      code: 'source_hevc',
      reason: 'fonte H.265',
      certainty: 'assumed',
    },
  ]);
  assert.match(lines[0], /não confirmad|suposi/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRMAÇÃO VISUAL — o frame que vai para dentro de <img src=...>
// ─────────────────────────────────────────────────────────────────────────────

const JPEG_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==';

test('só JPEG embutido em base64 é aceito como src da imagem', () => {
  assert.equal(isSafeJpegDataUrl(JPEG_URL), true);
});

test('qualquer outra coisa é RECUSADA antes de virar src', () => {
  // O src desta imagem vem de uma resposta HTTP. Aceitar esquema arbitrário aqui
  // transforma um payload adulterado em execução de script dentro do painel.
  for (const hostile of [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=',
    'http://intruso.example/pixel.jpg',
    '//intruso.example/x.jpg',
    'data:image/jpeg,<script>',
    'data:image/jpeg;base64,',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isSafeJpegDataUrl(hostile as never), false, `deveria recusar: ${String(hostile)}`);
  }
});

test('frame bom vira objeto pronto para a tela', () => {
  const frame = parsePreviewFrame({
    ok: true,
    imageDataUrl: JPEG_URL,
    bytes: 24142,
    capturedAt: '2026-07-27T18:30:00.000Z',
    source: { rtspPort: 554, rtspPath: '/cam/realmonitor?channel=1&subtype=0', transport: 'tcp' },
    stream: { codec: 'h264', width: 1920, height: 1080, fps: 25 },
    reason: null,
  });
  assert.equal(frame.ok, true);
  assert.equal(frame.imageDataUrl, JPEG_URL);
  assert.equal(frame.stream?.width, 1920);
});

test('ok:true com imagem inválida NÃO é tratado como sucesso', () => {
  const frame = parsePreviewFrame({ ok: true, imageDataUrl: 'javascript:alert(1)' });
  assert.equal(frame.ok, false, 'sucesso sem imagem utilizável é falha na tela');
  assert.equal(frame.imageDataUrl, null);
  assert.ok(frame.reason.length > 0, 'o técnico precisa saber por que não apareceu imagem');
});

test('falha da API vira motivo legível em vez de tela em branco', () => {
  const frame = parsePreviewFrame({ ok: false, imageDataUrl: null, reason: 'Connection timed out' });
  assert.equal(frame.ok, false);
  assert.equal(frame.reason, 'Connection timed out');
});

test('resposta corrompida não derruba o assistente de cadastro', () => {
  for (const garbage of [null, undefined, 'boom', 0, []]) {
    const frame = parsePreviewFrame(garbage);
    assert.equal(frame.ok, false);
    assert.ok(frame.reason.length > 0);
  }
});

test('a fonte que respondeu é descrita para o técnico conferir', () => {
  const label = describePreviewSource({
    rtspPort: 8554,
    rtspPath: '/Streaming/Channels/101',
    transport: 'tcp',
  });
  assert.match(label, /8554/);
  assert.match(label, /Streaming\/Channels\/101/);
});

test('sem fonte, a descrição some em vez de imprimir "null"', () => {
  assert.equal(describePreviewSource(null), '');
  assert.equal(describePreviewSource({ rtspPort: null, rtspPath: null, transport: 'tcp' }), '');
});
