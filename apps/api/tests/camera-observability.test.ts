import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../src/auth/decorators/public.decorator';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '../src/role-permissions/require-permission.decorator';
import { ObservabilityController } from '../src/observability/observability.controller';
import { CameraMetricsService } from '../src/observability/camera-metrics.service';
import { CameraObservabilityService } from '../src/observability/camera-observability.service';
import { resolveDesiredRecording, isRecordingStalled } from '../src/observability/camera-health.helper';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// Contrato A: GET /observability/cameras — saúde por câmera (rota AUTENTICADA,
// por isso pode ter nome). Provado aqui:
//  • a montagem do objeto (campos e totais) bate com o contrato;
//  • `stalled` só acusa quem realmente deveria estar gravando;
//  • SEM N+1: o nº de queries NÃO cresce com o nº de câmeras.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
const MIN = 60_000;
const STALE_THRESHOLD = 375; // = o que o manager real devolve com os defaults

type FakeCamera = {
  id: string;
  name: string;
  enabled: boolean;
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN' | 'ERROR';
  recordingMode: string;
  recordingEnabled: boolean;
};

function makeService(opts: {
  cameras: FakeCamera[];
  lastSegments?: Record<string, Date>;
  activeCameraIds?: string[];
  controlMode?: 'local' | 'worker';
  registry?: CameraMetricsService;
  nowMs?: number;
}) {
  const calls: string[] = [];
  const nowMs = opts.nowMs ?? NOW;
  const prisma = {
    camera: {
      findMany: async (args: any) => {
        calls.push('camera.findMany');
        assert.ok(args?.select, 'a query de câmeras deve projetar só as colunas usadas');
        return opts.cameras.map((c) => ({ ...c }));
      },
    },
    recording: {
      groupBy: async (args: any) => {
        calls.push('recording.groupBy');
        assert.deepEqual(args?.by, ['cameraId'], 'agregação por câmera numa query só');
        return Object.entries(opts.lastSegments ?? {}).map(([cameraId, at]) => ({
          cameraId,
          _max: { startedAt: at, endedAt: at },
        }));
      },
      // Presentes de propósito: se a implementação cair para consulta POR CÂMERA,
      // o teste de N+1 pega (estes contam como query também).
      findFirst: async () => {
        calls.push('recording.findFirst');
        return null;
      },
      findMany: async () => {
        calls.push('recording.findMany');
        return [];
      },
    },
  } as any;

  const recordings = {
    getRuntimeSummary: () => ({
      activeCount: (opts.activeCameraIds ?? []).length,
      activeCameraIds: opts.activeCameraIds ?? [],
      controlMode: opts.controlMode ?? 'local',
    }),
    getRecordingStaleThresholdSeconds: () => STALE_THRESHOLD,
  } as any;

  const registry = opts.registry ?? new CameraMetricsService(() => nowMs);
  const service = new CameraObservabilityService(prisma, recordings, registry);
  (service as any).now = () => nowMs;
  return { service, calls, registry };
}

const cam = (over: Partial<FakeCamera> & { id: string }): FakeCamera => ({
  name: `Câmera ${over.id}`,
  enabled: true,
  status: 'ONLINE',
  recordingMode: 'continuous',
  recordingEnabled: true,
  ...over,
});

test('contrato A: monta o objeto completo (câmera + gravação + stream + totais)', async () => {
  const registry = new CameraMetricsService(() => NOW);
  registry.recordSegment('cam-1');
  registry.recordRecordingRestart('cam-1');
  registry.recordStreamRecovery('cam-1');
  const lastSegment = new Date(NOW - 2 * MIN);

  const { service } = makeService({
    cameras: [cam({ id: 'cam-1', name: 'Recepção' })],
    lastSegments: { 'cam-1': lastSegment },
    activeCameraIds: ['cam-1'],
    registry,
  });

  const report = await service.getCamerasHealth();
  assert.equal(report.generatedAt, new Date(NOW).toISOString());
  assert.equal(report.cameras.length, 1);

  const item = report.cameras[0];
  assert.equal(item.cameraId, 'cam-1');
  assert.equal(item.name, 'Recepção', 'a rota é autenticada: o nome PODE aparecer aqui');
  assert.equal(item.enabled, true);
  assert.equal(item.status, 'ONLINE');
  assert.equal(item.recording.desired, 'continuous');
  assert.equal(item.recording.active, true);
  assert.equal(item.recording.lastSegmentAt, lastSegment.toISOString());
  assert.equal(item.recording.secondsSinceLastSegment, 120);
  assert.equal(item.recording.segmentsLastHour, 1);
  assert.equal(item.recording.restartsLastHour, 1);
  assert.equal(item.recording.stalled, false);
  assert.equal(item.stream.recoveriesLastHour, 1);
  assert.equal(item.stream.lastRecoveryAt, new Date(NOW).toISOString());

  assert.deepEqual(report.totals, { cameras: 1, recordingActive: 1, stalled: 0, offline: 0 });
});

test('contrato A: câmera sem NENHUM segmento devolve nulos (não inventa data)', async () => {
  const { service } = makeService({ cameras: [cam({ id: 'cam-1' })], activeCameraIds: [] });
  const item = (await service.getCamerasHealth()).cameras[0];
  assert.equal(item.recording.lastSegmentAt, null);
  assert.equal(item.recording.secondsSinceLastSegment, null);
  assert.equal(item.stream.lastRecoveryAt, null);
});

test('stalled: contínua SEM segmento recente = TRAVADA', async () => {
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1' })],
    lastSegments: { 'cam-1': new Date(NOW - (STALE_THRESHOLD + 10) * 1000) },
    activeCameraIds: ['cam-1'],
  });
  const report = await service.getCamerasHealth();
  assert.equal(report.cameras[0].recording.stalled, true);
  assert.equal(report.totals.stalled, 1);
});

test('stalled: contínua COM segmento dentro do limiar = OK', async () => {
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1' })],
    lastSegments: { 'cam-1': new Date(NOW - (STALE_THRESHOLD - 10) * 1000) },
    activeCameraIds: ['cam-1'],
  });
  assert.equal((await service.getCamerasHealth()).cameras[0].recording.stalled, false);
});

test('stalled: contínua que NUNCA gravou = TRAVADA', async () => {
  const { service } = makeService({ cameras: [cam({ id: 'cam-1' })], activeCameraIds: ['cam-1'] });
  assert.equal((await service.getCamerasHealth()).cameras[0].recording.stalled, true);
});

test('stalled: câmera com gravação DESLIGADA nunca é travada', async () => {
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1', recordingEnabled: false, recordingMode: 'continuous' })],
    activeCameraIds: [],
  });
  const item = (await service.getCamerasHealth()).cameras[0];
  assert.equal(item.recording.desired, 'off');
  assert.equal(item.recording.stalled, false, 'não gravar de propósito não é defeito');
});

test('stalled: câmera DESATIVADA nunca é travada (desired=off mesmo com modo contínuo)', async () => {
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1', enabled: false })],
    activeCameraIds: [],
  });
  const item = (await service.getCamerasHealth()).cameras[0];
  assert.equal(item.recording.desired, 'off');
  assert.equal(item.recording.stalled, false);
});

test('stalled: motion ARMADA e OCIOSA (sem processo) não é travada — silêncio é normal', async () => {
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1', recordingMode: 'motion', recordingEnabled: false })],
    lastSegments: { 'cam-1': new Date(NOW - 6 * 60 * MIN) },
    activeCameraIds: [],
  });
  const item = (await service.getCamerasHealth()).cameras[0];
  assert.equal(item.recording.desired, 'motion', 'em motion o armamento vive no recordingMode');
  assert.equal(item.recording.stalled, false);
});

test('stalled: motion GRAVANDO mas sem segmento além do limiar É travada', async () => {
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1', recordingMode: 'motion', recordingEnabled: true })],
    lastSegments: { 'cam-1': new Date(NOW - (STALE_THRESHOLD + 60) * 1000) },
    activeCameraIds: ['cam-1'],
  });
  assert.equal((await service.getCamerasHealth()).cameras[0].recording.stalled, true);
});

test('modo worker: "gravando" é inferido do segmento recente (o processo não é local)', async () => {
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1' })],
    lastSegments: { 'cam-1': new Date(NOW - 60 * 1000) },
    activeCameraIds: [],
    controlMode: 'worker',
  });
  const item = (await service.getCamerasHealth()).cameras[0];
  assert.equal(item.recording.active, true, 'no worker não existe processo local em this.active');
});

test('status ERROR do banco é reportado como OFFLINE (contrato tem 3 valores)', async () => {
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1', status: 'ERROR' }), cam({ id: 'cam-2', status: 'OFFLINE' })],
    activeCameraIds: [],
  });
  const report = await service.getCamerasHealth();
  assert.equal(report.cameras[0].status, 'OFFLINE');
  assert.equal(report.totals.offline, 2);
});

test('SEM N+1: 50 câmeras usam o MESMO nº de queries que 1', async () => {
  const one = makeService({ cameras: [cam({ id: 'cam-0' })], activeCameraIds: [] });
  await one.service.getCamerasHealth();

  const many = makeService({
    cameras: Array.from({ length: 50 }, (_, i) => cam({ id: `cam-${i}` })),
    lastSegments: Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`cam-${i}`, new Date(NOW - i * 1000)]),
    ),
    activeCameraIds: ['cam-3'],
  });
  await many.service.getCamerasHealth();

  assert.deepEqual(one.calls, ['camera.findMany', 'recording.groupBy']);
  assert.deepEqual(
    many.calls,
    ['camera.findMany', 'recording.groupBy'],
    `N+1 detectado: 50 câmeras dispararam ${many.calls.length} queries (${many.calls.join(', ')})`,
  );
});

test('frota vazia: nem consulta segmentos e devolve totais zerados', async () => {
  const { service, calls } = makeService({ cameras: [] });
  const report = await service.getCamerasHealth();
  assert.deepEqual(report.cameras, []);
  assert.deepEqual(report.totals, { cameras: 0, recordingActive: 0, stalled: 0, offline: 0 });
  assert.deepEqual(calls, ['camera.findMany']);
});

test('a leitura autenticada SEMEIA a marca-d’água do /metrics (sem inflar a janela)', async () => {
  const registry = new CameraMetricsService(() => NOW);
  const lastSegment = new Date(NOW - 3 * MIN);
  const { service } = makeService({
    cameras: [cam({ id: 'cam-1' })],
    lastSegments: { 'cam-1': lastSegment },
    activeCameraIds: ['cam-1'],
    registry,
  });
  await service.getCamerasHealth();
  const snap = registry.snapshot('cam-1');
  assert.equal(snap.lastSegmentAt?.getTime(), lastSegment.getTime(), 'após restart da API o /metrics não fica cego');
  assert.equal(snap.segmentsLastHour, 0, 'semear NÃO pode contar como segmento gravado');
});

// ── helpers puros ────────────────────────────────────────────────────────────

test('resolveDesiredRecording cobre os 4 valores do contrato', () => {
  assert.equal(resolveDesiredRecording({ enabled: true, recordingMode: 'continuous', recordingEnabled: true }), 'continuous');
  assert.equal(resolveDesiredRecording({ enabled: true, recordingMode: 'motion', recordingEnabled: false }), 'motion');
  assert.equal(resolveDesiredRecording({ enabled: true, recordingMode: 'manual', recordingEnabled: true }), 'manual');
  assert.equal(resolveDesiredRecording({ enabled: true, recordingMode: 'manual', recordingEnabled: false }), 'off');
  assert.equal(resolveDesiredRecording({ enabled: false, recordingMode: 'motion', recordingEnabled: true }), 'off');
});

test('isRecordingStalled: limiar é EXCLUSIVO (igual ao limiar ainda não é travado)', () => {
  const base = { desired: 'continuous' as const, active: true, staleThresholdSeconds: 300 };
  assert.equal(isRecordingStalled({ ...base, secondsSinceLastSegment: 300 }), false);
  assert.equal(isRecordingStalled({ ...base, secondsSinceLastSegment: 301 }), true);
});

// ── proteção da rota ─────────────────────────────────────────────────────────
// Diferente do /metrics, ESTA rota devolve nome de câmera — se escapar @Public,
// vira lista de clientes aberta na internet.

test('GET /observability/cameras NÃO é pública e exige ADMIN + serverConfig', () => {
  const handler = ObservabilityController.prototype.cameras;
  assert.equal(
    Reflect.getMetadata(IS_PUBLIC_KEY, handler),
    undefined,
    '@Public nesta rota exporia nome de câmera (= o cliente) sem autenticação',
  );
  assert.equal(
    Reflect.getMetadata(IS_PUBLIC_KEY, ObservabilityController),
    undefined,
    'nem a classe inteira pode ser pública',
  );
  assert.deepEqual(Reflect.getMetadata(ROLES_KEY, handler), [UserRole.ADMIN]);
  assert.equal(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler), 'serverConfig');
});

// ── fidelidade do fake ───────────────────────────────────────────────────────
// O agregador é testado contra um fake do RecordingProcessManagerService. Se o
// serviço real não expuser ESTES métodos com ESTA semântica, o fake mente.

test('fake fiel: o manager REAL expõe getRuntimeSummary().activeCameraIds e o limiar', () => {
  const config = { get: () => undefined } as any;
  const real = new RecordingProcessManagerService(config, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  const summary = real.getRuntimeSummary();
  assert.ok(Array.isArray(summary.activeCameraIds), 'activeCameraIds precisa ser array de ids');
  assert.ok(['local', 'worker'].includes(summary.controlMode), 'controlMode precisa existir');
  const threshold = real.getRecordingStaleThresholdSeconds();
  assert.equal(typeof threshold, 'number');
  assert.ok(threshold > 0, 'limiar de stale precisa ser positivo');
  assert.equal(threshold, STALE_THRESHOLD, 'o limiar do fake precisa bater com o real (defaults)');
});
