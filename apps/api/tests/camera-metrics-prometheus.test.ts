import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrometheus } from '../src/observability/prometheus.helper';
import { CameraMetricsService } from '../src/observability/camera-metrics.service';
import { buildCameraSeries } from '../src/observability/camera-prometheus.helper';
import { MetricsController } from '../src/observability/metrics.controller';

// ─────────────────────────────────────────────────────────────────────────────
// Contrato B: séries POR CÂMERA no /metrics PÚBLICO.
//
// TESTE DE PRIVACIDADE (LGPD) — o /metrics é @Public: qualquer um que alcance a
// porta lê o corpo inteiro. O nome da câmera ("Recepção Cliente ACME") ou o IP
// ENTREGAM O CLIENTE e a topologia da instalação. O ÚNICO rótulo permitido é
// camera_id. Este arquivo trata isso como invariante de segurança, não estilo.
// ─────────────────────────────────────────────────────────────────────────────

const CAM_A = '11111111-2222-3333-4444-555555555555';
const CAM_B = '99999999-8888-7777-6666-555555555555';

// PII que NUNCA pode aparecer no corpo público.
const CAMERA_NAME = 'Recepção Cliente ACME';
const CAMERA_IP = '192.168.10.42';
const CAMERA_RTSP = `rtsp://admin:s3nh4@${CAMERA_IP}:554/cam/realmonitor`;

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

function registryWith(nowMs = NOW) {
  const svc = new CameraMetricsService(() => nowMs);
  return svc;
}

/** Extrai os blocos de rótulo de todas as séries drac_camera_*. */
function cameraLabelBlocks(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('drac_camera_'))
    .map((line) => {
      const open = line.indexOf('{');
      const close = line.indexOf('}');
      return open === -1 || close === -1 ? '' : line.slice(open + 1, close);
    });
}

test('contrato B: emite as 4 séries por câmera com o rótulo camera_id', () => {
  const reg = registryWith();
  reg.recordSegment(CAM_A);
  reg.recordRecordingRestart(CAM_A);
  reg.recordStreamRecovery(CAM_A);
  const body = formatPrometheus(buildCameraSeries({
    snapshots: reg.snapshotAll(),
    activeCameraIds: [CAM_A],
    nowMs: NOW + 42_000,
  }));

  assert.match(body, new RegExp(`^drac_camera_recording_active\\{camera_id="${CAM_A}"\\} 1$`, 'm'));
  assert.match(body, new RegExp(`^drac_camera_seconds_since_last_segment\\{camera_id="${CAM_A}"\\} 42$`, 'm'));
  assert.match(body, new RegExp(`^drac_camera_recording_restarts_total\\{camera_id="${CAM_A}"\\} 1$`, 'm'));
  assert.match(body, new RegExp(`^drac_camera_stream_recoveries_total\\{camera_id="${CAM_A}"\\} 1$`, 'm'));
  // HELP/TYPE declarados uma única vez por métrica (exigência do formato).
  assert.equal((body.match(/# TYPE drac_camera_recording_active/g) ?? []).length, 1);
  assert.match(body, /# TYPE drac_camera_recording_restarts_total counter/);
  assert.match(body, /# TYPE drac_camera_recording_active gauge/);
});

test('contrato B: câmera SEM gravação ativa emite 0 (série presente, não omitida)', () => {
  const reg = registryWith();
  reg.recordStreamRecovery(CAM_B);
  const body = formatPrometheus(buildCameraSeries({ snapshots: reg.snapshotAll(), activeCameraIds: [], nowMs: NOW }));
  assert.match(body, new RegExp(`^drac_camera_recording_active\\{camera_id="${CAM_B}"\\} 0$`, 'm'));
  assert.match(body, new RegExp(`^drac_camera_recording_restarts_total\\{camera_id="${CAM_B}"\\} 0$`, 'm'));
});

test('contrato B: câmera gravando AGORA mas ainda sem segmento conhecido não inventa idade', () => {
  const reg = registryWith();
  const body = formatPrometheus(buildCameraSeries({ snapshots: reg.snapshotAll(), activeCameraIds: [CAM_A], nowMs: NOW }));
  assert.match(body, new RegExp(`^drac_camera_recording_active\\{camera_id="${CAM_A}"\\} 1$`, 'm'));
  assert.equal(
    body.includes('drac_camera_seconds_since_last_segment'),
    false,
    'sem marca-d’água não se emite idade (0 mentiria "acabou de gravar")',
  );
});

test('contrato B: idade do último segmento nunca é negativa', () => {
  const reg = registryWith();
  reg.recordSegment(CAM_A);
  const body = formatPrometheus(buildCameraSeries({
    snapshots: reg.snapshotAll(),
    activeCameraIds: [],
    nowMs: NOW - 5_000, // relógio "andou para trás"
  }));
  assert.match(body, new RegExp(`^drac_camera_seconds_since_last_segment\\{camera_id="${CAM_A}"\\} 0$`, 'm'));
});

// ── PRIVACIDADE ──────────────────────────────────────────────────────────────

test('PRIVACIDADE: o ÚNICO rótulo das séries por câmera é camera_id', () => {
  const reg = registryWith();
  reg.recordSegment(CAM_A);
  reg.recordStreamRecovery(CAM_B);
  const body = formatPrometheus(buildCameraSeries({
    snapshots: reg.snapshotAll(),
    activeCameraIds: [CAM_A],
    nowMs: NOW,
  }));

  const blocks = cameraLabelBlocks(body);
  assert.ok(blocks.length >= 6, 'esperava várias séries por câmera');
  for (const block of blocks) {
    assert.match(
      block,
      /^camera_id="[0-9a-fA-F-]+"$/,
      `rótulo proibido no /metrics público: {${block}} — só camera_id é permitido (PII/LGPD)`,
    );
  }
});

test('PRIVACIDADE: NOME, IP e URL RTSP da câmera JAMAIS aparecem no /metrics', () => {
  const reg = registryWith();
  // Alguém tentou usar nome/IP/URL como identificador da série: o registro só
  // aceita ids, e o corpo não pode conter nada disso de nenhuma forma.
  reg.recordSegment(CAM_A);
  reg.recordSegment(CAMERA_NAME);
  reg.recordSegment(CAMERA_IP);
  reg.recordSegment(CAMERA_RTSP);
  const body = formatPrometheus(buildCameraSeries({
    snapshots: reg.snapshotAll(),
    activeCameraIds: [CAM_A],
    nowMs: NOW,
  }));

  assert.equal(body.includes(CAMERA_NAME), false, 'nome da câmera entrega o CLIENTE num endpoint público');
  assert.equal(body.includes('Recepção'), false);
  assert.equal(body.includes(CAMERA_IP), false, 'IP entrega a topologia da instalação');
  assert.equal(body.includes('rtsp://'), false, 'URL RTSP carrega credencial');
  assert.equal(body.includes('s3nh4'), false);
  assert.equal(/\bname=/.test(body), false, 'nenhum rótulo "name"');
  assert.equal(/\bip=/.test(body), false, 'nenhum rótulo "ip"');
});

// ── controller (/metrics) ────────────────────────────────────────────────────

function makeController(reg: CameraMetricsService, activeCameraIds: string[]) {
  const recordings = {
    getActiveRecordingCount: () => activeCameraIds.length,
    getRuntimeSummary: () => ({ activeCameraIds }),
  } as any;
  return new MetricsController(recordings, reg);
}

test('/metrics: métricas AGREGADAS atuais continuam exatamente como estavam', () => {
  const reg = registryWith();
  const body = makeController(reg, ['cam-x']).metrics();
  assert.match(body, /^drac_api_up 1$/m);
  assert.match(body, /^drac_api_uptime_seconds \d+$/m);
  assert.match(body, /^drac_api_resident_memory_bytes \d+$/m);
  assert.match(body, /^drac_api_heap_used_bytes \d+$/m);
  assert.match(body, /^drac_recordings_active 1$/m);
});

test('/metrics: inclui as séries por câmera e nenhum rótulo além de camera_id', () => {
  const reg = registryWith(Date.now());
  reg.recordSegment(CAM_A);
  const body = makeController(reg, [CAM_A]).metrics();
  assert.match(body, new RegExp(`^drac_camera_recording_active\\{camera_id="${CAM_A}"\\} 1$`, 'm'));
  for (const block of cameraLabelBlocks(body)) {
    assert.match(block, /^camera_id="[0-9a-fA-F-]+"$/, `rótulo proibido: {${block}}`);
  }
});

test('/metrics: câmera gravando que ainda não emitiu evento aparece como ativa', () => {
  const reg = registryWith(Date.now());
  const body = makeController(reg, [CAM_B]).metrics();
  assert.match(body, new RegExp(`^drac_camera_recording_active\\{camera_id="${CAM_B}"\\} 1$`, 'm'));
});
