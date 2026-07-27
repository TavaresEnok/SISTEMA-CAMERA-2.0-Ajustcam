import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cameraMetrics } from '../src/observability/camera-metrics.service';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';

// ─────────────────────────────────────────────────────────────────────────────
// Os HOOKS de instrumentação. Uma métrica que ninguém alimenta é decoração:
// aqui os pontos reais do pipeline (registro de segmento, morte do processo de
// gravação, recuperação de path do MediaMTX) são exercitados de verdade.
//
// Invariante adicional: o hook é À PROVA DE FALHA — se a métrica explodir, a
// gravação/stream NÃO pode cair junto.
// ─────────────────────────────────────────────────────────────────────────────

const CAM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SEGMENT = `/rec/camera-${CAM}/2026-07-27_10-00-00.mp4`;

beforeEach(() => cameraMetrics.reset());

function makeRecorder(overrides: Record<string, unknown> = {}) {
  const svc: any = Object.create(RecordingProcessManagerService.prototype);
  svc.logger = { warn() {}, log() {}, debug() {}, error() {} };
  svc.probeRecordedFileMetadata = async () => ({ durationSecondsExact: 300, sizeBytes: 5_000_000, hasVideoStream: true });
  svc.thumbnailQueue = { add: async () => undefined };
  svc.prisma = {
    camera: { findUnique: async () => ({ recordingMode: 'continuous' }) },
    recording: {
      findUnique: async () => null,
      create: async () => ({ id: 'rec-1' }),
      update: async () => ({ id: 'rec-1' }),
    },
  };
  Object.assign(svc, overrides);
  return svc;
}

test('hook segmento: registrar um segmento NOVO conta na janela e na marca-d’água', async () => {
  const svc = makeRecorder();
  await svc.registerSegment(CAM, SEGMENT, 300);
  const snap = cameraMetrics.snapshot(CAM);
  assert.equal(snap.segmentsLastHour, 1, 'o hook de registerSegment não está ligado');
  assert.ok(snap.lastSegmentAt, 'a marca-d’água do último segmento precisa avançar');
});

test('hook segmento: RE-registro do mesmo arquivo NÃO conta segmento novo', async () => {
  const svc = makeRecorder({
    prisma: {
      camera: { findUnique: async () => ({ recordingMode: 'continuous' }) },
      recording: {
        findUnique: async () => ({ id: 'rec-1' }), // já existia
        update: async () => ({ id: 'rec-1' }),
        create: async () => { throw new Error('não deveria criar'); },
      },
    },
  });
  await svc.registerSegment(CAM, SEGMENT, 300);
  assert.equal(cameraMetrics.snapshot(CAM).segmentsLastHour, 0, 'atualizar linha existente não é segmento novo');
});

test('hook segmento: segmento REJEITADO (sem vídeo) não conta', async () => {
  const svc = makeRecorder({
    probeRecordedFileMetadata: async () => ({ durationSecondsExact: 300, sizeBytes: 10, hasVideoStream: false }),
  });
  await assert.rejects(() => svc.registerSegment(CAM, SEGMENT, 300));
  assert.equal(cameraMetrics.snapshot(CAM).segmentsLastHour, 0, 'só segmento VÁLIDO conta');
});

function makeState(): any {
  return {
    cameraId: CAM,
    process: { exitCode: 1 },
    watcher: setTimeout(() => {}, 0),
    knownFiles: new Set<string>(),
    scanInFlight: null,
    finalizePromise: null,
  };
}

test('hook reinício: morte NÃO solicitada do processo de gravação conta reinício', async () => {
  const svc = makeRecorder();
  svc.active = new Map();
  svc.scanAndRegister = async () => undefined;
  const state = makeState();
  svc.active.set(CAM, state);
  await svc.finalizeRecordingState(CAM, state, 1);
  assert.equal(cameraMetrics.snapshot(CAM).restartsLastHour, 1, 'queda do FFmpeg precisa aparecer na métrica');
});

test('hook reinício: PARADA PEDIDA pelo operador NÃO conta reinício (senão o alerta mente)', async () => {
  const svc = makeRecorder();
  svc.active = new Map();
  svc.scanAndRegister = async () => undefined;
  const state = makeState();
  state.stopRequested = true; // é o que `stop()` marca antes de matar o processo
  svc.active.set(CAM, state);
  await svc.finalizeRecordingState(CAM, state, 0);
  assert.equal(cameraMetrics.snapshot(CAM).restartsLastHour, 0);
});

test('hook reinício: finalize chamado DUAS vezes conta UMA (close + stop na mesma morte)', async () => {
  const svc = makeRecorder();
  svc.active = new Map();
  svc.scanAndRegister = async () => undefined;
  const state = makeState();
  svc.active.set(CAM, state);
  await svc.finalizeRecordingState(CAM, state, 1);
  await svc.finalizeRecordingState(CAM, state, 1);
  assert.equal(cameraMetrics.snapshot(CAM).restartsLastHour, 1);
});

test('stop(): marca a parada como PEDIDA antes de matar o processo', async () => {
  const svc = makeRecorder();
  svc.controlMode = 'local';
  svc.camerasService = { getCameraOrThrow: async () => ({ id: CAM }) };
  svc.prisma = { ...svc.prisma, camera: { ...svc.prisma.camera, update: async () => ({}) } };
  svc.resolveRecordingModeUpdate = async () => ({});
  svc.scanAndRegister = async () => undefined;
  const state = makeState();
  let flagAtKill: boolean | undefined;
  svc.stopProcessAndWait = async (s: any) => { flagAtKill = s.stopRequested; };
  svc.active = new Map([[CAM, state]]);
  await svc.stop(CAM);
  assert.equal(flagAtKill, true, 'a marca precisa existir ANTES do kill (o handler close dispara primeiro)');
  assert.equal(cameraMetrics.snapshot(CAM).restartsLastHour, 0, 'parada normal não pode virar "reinício"');
});

test('hook stream: recuperação de path travado conta para a câmera certa', async () => {
  const proxy: any = Object.create(MediamtxProxyService.prototype);
  proxy.logger = { warn() {}, log() {}, debug() {}, error() {} };
  proxy.recoveringPaths = new Set<string>();
  proxy.recoveryBrake = new Map<string, unknown>();
  proxy.invalidateMainCodecCache = () => {};
  proxy.apiRequest = async () => '';
  proxy.ensurePathForCamera = async () => undefined;
  const pathName = `cam_${CAM.replace(/-/g, '')}`;

  await proxy.recoverStuckPath(pathName, false, 1);
  const snap = cameraMetrics.snapshot(CAM);
  assert.equal(snap.recoveriesLastHour, 1, 'o hook de recoverStuckPath não está ligado');
  assert.ok(snap.lastRecoveryAt, 'lastRecoveryAt do contrato A precisa ser preenchido');
});

test('hook stream: recuperação que FALHOU não conta como recuperação', async () => {
  const proxy: any = Object.create(MediamtxProxyService.prototype);
  proxy.logger = { warn() {}, log() {}, debug() {}, error() {} };
  proxy.recoveringPaths = new Set<string>();
  proxy.recoveryBrake = new Map<string, unknown>();
  proxy.invalidateMainCodecCache = () => {};
  proxy.apiRequest = async () => '';
  proxy.ensurePathForCamera = async () => { throw new Error('MediaMTX fora'); };
  const pathName = `cam_${CAM.replace(/-/g, '')}`;

  await proxy.recoverStuckPath(pathName, false, 1);
  assert.equal(cameraMetrics.snapshot(CAM).recoveriesLastHour, 0, 'falha não é recuperação');
});

test('à prova de falha: métrica que EXPLODE não derruba gravação nem stream', async () => {
  const boom = () => { throw new Error('registro de métrica quebrado'); };
  const originalSegment = cameraMetrics.recordSegment;
  const originalRestart = cameraMetrics.recordRecordingRestart;
  const originalRecovery = cameraMetrics.recordStreamRecovery;
  const originalBrake = cameraMetrics.recordStreamRecoveryBrake;
  (cameraMetrics as any).recordSegment = boom;
  (cameraMetrics as any).recordRecordingRestart = boom;
  (cameraMetrics as any).recordStreamRecovery = boom;
  (cameraMetrics as any).recordStreamRecoveryBrake = boom;
  try {
    const svc = makeRecorder();
    svc.active = new Map();
    svc.scanAndRegister = async () => undefined;
    await assert.doesNotReject(() => svc.registerSegment(CAM, SEGMENT, 300), 'gravação não pode cair por causa da métrica');
    const state = makeState();
    await assert.doesNotReject(() => svc.finalizeRecordingState(CAM, state, 1));

    const proxy: any = Object.create(MediamtxProxyService.prototype);
    proxy.logger = { warn() {}, log() {}, debug() {}, error() {} };
    proxy.recoveringPaths = new Set<string>();
    proxy.recoveryBrake = new Map<string, unknown>();
    proxy.invalidateMainCodecCache = () => {};
    proxy.apiRequest = async () => '';
    proxy.ensurePathForCamera = async () => undefined;
    // 5 recuperações seguidas ARMAM o freio anti-tempestade — e é justamente aí
    // que a métrica do freio é chamada. Nem isso pode derrubar o watchdog.
    for (let i = 0; i < 5; i += 1) {
      await assert.doesNotReject(() => proxy.recoverStuckPath(`cam_${CAM.replace(/-/g, '')}`, false, 1));
    }
    assert.equal(proxy.recoveringPaths.size, 0, 'o guard por-path precisa ser liberado mesmo assim');
  } finally {
    (cameraMetrics as any).recordSegment = originalSegment;
    (cameraMetrics as any).recordRecordingRestart = originalRestart;
    (cameraMetrics as any).recordStreamRecovery = originalRecovery;
    (cameraMetrics as any).recordStreamRecoveryBrake = originalBrake;
  }
});
