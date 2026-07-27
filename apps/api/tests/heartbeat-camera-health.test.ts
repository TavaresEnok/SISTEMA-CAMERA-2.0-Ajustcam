import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraStatus } from '@prisma/client';
import { CloudConnectorService } from '../src/cloud-connector/cloud-connector.service';
import {
  buildHeartbeatCameras,
  HEARTBEAT_CAMERA_LIMIT_DEFAULT,
  HEARTBEAT_CAMERAS_STALLED_CRITICAL,
} from '../src/cloud-connector/heartbeat-cameras.helper';
import { CameraObservabilityService } from '../src/observability/camera-observability.service';
import { CameraMetricsService } from '../src/observability/camera-metrics.service';

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat da instalação → DRAC Central: SAÚDE POR CÂMERA.
//
// O heartbeat sai a cada 60s e é ARMAZENADO na Central, então três coisas são
// contrato, não detalhe:
//  • ECONOMIA: só os campos que o painel de frota usa (nada de stream/segmentos);
//  • TETO com PRIORIDADE: numa instalação grande o que não couber tem de ser o
//    que está SAUDÁVEL — mandar as 250 primeiras em ordem alfabética esconderia
//    exatamente as câmeras quebradas, que é o único motivo do painel existir;
//  • À PROVA DE FALHA: métrica nova NUNCA pode derrubar o heartbeat (sem
//    heartbeat a Central dá a instalação inteira como morta).
// ─────────────────────────────────────────────────────────────────────────────

type Rec = {
  desired: 'continuous' | 'motion' | 'manual' | 'off';
  active: boolean;
  stalled: boolean;
  secondsSinceLastSegment: number | null;
  restartsLastHour: number;
};

/** Item no formato do relatório REAL do CameraObservabilityService (campos a mais de propósito). */
function healthItem(over: {
  id: string;
  name?: string | null;
  status?: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  recording?: Partial<Rec>;
}) {
  const recording: Rec = {
    desired: 'continuous',
    active: true,
    stalled: false,
    secondsSinceLastSegment: 30,
    restartsLastHour: 0,
    ...(over.recording ?? {}),
  };
  return {
    cameraId: over.id,
    name: over.name === undefined ? `Câmera ${over.id}` : over.name,
    // Campos que o relatório autenticado tem e o heartbeat NÃO pode carregar:
    enabled: true,
    status: over.status ?? 'ONLINE',
    recording: {
      ...recording,
      lastSegmentAt: '2026-07-27T12:00:00.000Z',
      segmentsLastHour: 12,
    },
    stream: { recoveriesLastHour: 4, lastRecoveryAt: '2026-07-27T11:59:00.000Z' },
  };
}

function report(cameras: ReturnType<typeof healthItem>[], staleThresholdSeconds = 375) {
  return {
    generatedAt: '2026-07-27T12:00:00.000Z',
    cameras,
    totals: {
      cameras: cameras.length,
      recordingActive: cameras.filter((c) => c.recording.active).length,
      stalled: cameras.filter((c) => c.recording.stalled).length,
      offline: cameras.filter((c) => c.status === 'OFFLINE').length,
    },
    staleThresholdSeconds,
  };
}

// ── bloco enviado ────────────────────────────────────────────────────────────

test('bloco por câmera manda SÓ o contrato do painel (nada de stream/segmentos/enabled)', () => {
  const { cameras } = buildHeartbeatCameras(
    report([
      healthItem({
        id: 'cam-1',
        name: 'Recepção',
        recording: { desired: 'motion', active: true, secondsSinceLastSegment: 42, restartsLastHour: 3 },
      }),
    ]),
    HEARTBEAT_CAMERA_LIMIT_DEFAULT,
  );

  assert.deepEqual(
    cameras.items[0],
    {
      cameraId: 'cam-1',
      name: 'Recepção',
      status: 'ONLINE',
      recording: {
        desired: 'motion',
        active: true,
        stalled: false,
        secondsSinceLastSegment: 42,
        restartsLastHour: 3,
      },
    },
    'campo a mais aqui é payload extra em disco na Central a cada 60s, para sempre',
  );
  assert.equal(cameras.staleThresholdSeconds, 375, 'sem o limiar a Central não sabe ler secondsSinceLastSegment');
  assert.deepEqual(cameras.totals, { cameras: 1, recordingActive: 1, stalled: 0, offline: 0 });
  assert.equal(cameras.omitted, 0);
});

test('totais e teto: totais são da FROTA INTEIRA mesmo com a lista truncada', () => {
  const cameras = [
    healthItem({ id: 'ok-1' }),
    healthItem({ id: 'ok-2' }),
    healthItem({ id: 'off-1', status: 'OFFLINE', recording: { desired: 'off', active: false } }),
    healthItem({ id: 'bad-1', recording: { active: false, stalled: true, secondsSinceLastSegment: 9000 } }),
  ];
  const { cameras: block } = buildHeartbeatCameras(report(cameras), 1);

  assert.equal(block.items.length, 1, 'teto respeitado');
  assert.equal(block.omitted, 3, 'a Central precisa saber quantas ficaram de fora');
  assert.deepEqual(
    block.totals,
    { cameras: 4, recordingActive: 2, stalled: 1, offline: 1 },
    'os totais não podem encolher junto com a lista, senão o painel mente sobre o tamanho da frota',
  );
});

test('teto: as PROBLEMÁTICAS vão primeiro (travada > inativa-esperada > offline > saudável)', () => {
  // Ordem de entrada de propósito ao contrário da prioridade (o relatório real
  // vem ordenado por NOME, que não tem relação nenhuma com estar quebrada).
  const cameras = [
    healthItem({ id: 'ok-1' }),
    healthItem({ id: 'ok-2' }),
    healthItem({ id: 'offline-1', status: 'OFFLINE', recording: { desired: 'off', active: false } }),
    healthItem({ id: 'inativa-1', recording: { desired: 'continuous', active: false, stalled: false, secondsSinceLastSegment: 10 } }),
    healthItem({ id: 'travada-1', recording: { active: false, stalled: true, secondsSinceLastSegment: 9000 } }),
  ];

  const { cameras: block } = buildHeartbeatCameras(report(cameras), 3);
  assert.deepEqual(
    block.items.map((item) => item.cameraId),
    ['travada-1', 'inativa-1', 'offline-1'],
    'cortar as quebradas para caber as saudáveis é o pior resultado possível do teto',
  );
  assert.equal(block.omitted, 2);
});

test('teto: empate de gravidade mantém a ordem de origem (corte determinístico)', () => {
  const cameras = ['b', 'a', 'c'].map((id) =>
    healthItem({ id, recording: { active: false, stalled: true, secondsSinceLastSegment: 9000 } }),
  );
  const { cameras: block } = buildHeartbeatCameras(report(cameras), 2);
  assert.deepEqual(block.items.map((i) => i.cameraId), ['b', 'a'], 'sem reordenar quem empata');
});

test('frota abaixo do teto: nada é omitido', () => {
  const { cameras: block } = buildHeartbeatCameras(report([healthItem({ id: 'cam-1' })]), 250);
  assert.equal(block.items.length, 1);
  assert.equal(block.omitted, 0);
});

test('relatório vazio/estranho não explode (heartbeat é o último a poder quebrar)', () => {
  const empty = buildHeartbeatCameras(report([]), 250);
  assert.deepEqual(empty.cameras.items, []);
  assert.deepEqual(empty.cameras.totals, { cameras: 0, recordingActive: 0, stalled: 0, offline: 0 });
  assert.deepEqual(empty.alerts, []);

  const junk = buildHeartbeatCameras({ cameras: undefined, staleThresholdSeconds: undefined } as any, 250);
  assert.deepEqual(junk.cameras.items, []);
  assert.deepEqual(junk.alerts, []);
});

// ── alertas derivados ────────────────────────────────────────────────────────

test('alertas: frota saudável não gera alerta nenhum', () => {
  const { alerts } = buildHeartbeatCameras(report([healthItem({ id: 'cam-1' }), healthItem({ id: 'cam-2' })]), 250);
  assert.deepEqual(alerts, []);
});

test('alertas: câmeras travadas viram cameras_stalled (warning; critical a partir do limiar)', () => {
  const stalled = (id: string) =>
    healthItem({ id, recording: { active: false, stalled: true, secondsSinceLastSegment: 9000 } });

  const few = buildHeartbeatCameras(report([stalled('a'), healthItem({ id: 'ok' })]), 250).alerts;
  assert.equal(few.length, 1);
  assert.deepEqual(
    { level: few[0].level, code: few[0].code },
    { level: 'warning', code: 'cameras_stalled' },
  );
  assert.match(few[0].message, /^1 camera/, 'a mensagem tem de dizer QUANTAS');

  const manyList = Array.from({ length: HEARTBEAT_CAMERAS_STALLED_CRITICAL }, (_, i) => stalled(`s-${i}`));
  const many = buildHeartbeatCameras(report(manyList), 250).alerts;
  const stalledAlert = many.find((a) => a.code === 'cameras_stalled');
  assert.equal(stalledAlert?.level, 'critical', `${HEARTBEAT_CAMERAS_STALLED_CRITICAL} travadas é frota caindo, não incidente isolado`);
  assert.ok(stalledAlert?.message.includes(String(HEARTBEAT_CAMERAS_STALLED_CRITICAL)));
});

test('alertas: gravação ESPERADA e INATIVA vira camera_recording_expected_inactive', () => {
  const { alerts } = buildHeartbeatCameras(
    report([
      healthItem({ id: 'inativa-1', recording: { desired: 'continuous', active: false, stalled: false } }),
      healthItem({ id: 'inativa-2', recording: { desired: 'motion', active: false, stalled: false } }),
      healthItem({ id: 'desligada', recording: { desired: 'off', active: false, stalled: false } }),
      healthItem({ id: 'ok' }),
    ]),
    250,
  );

  assert.equal(alerts.length, 1, 'gravação desligada de propósito NÃO é alerta');
  assert.deepEqual(
    { level: alerts[0].level, code: alerts[0].code },
    { level: 'warning', code: 'camera_recording_expected_inactive' },
  );
  assert.match(alerts[0].message, /^2 camera/);
});

test('alertas: travada NÃO é contada também como inativa (um defeito, um alerta)', () => {
  const { alerts } = buildHeartbeatCameras(
    report([healthItem({ id: 'travada', recording: { desired: 'continuous', active: false, stalled: true } })]),
    250,
  );
  assert.deepEqual(alerts.map((a) => a.code), ['cameras_stalled']);
});

test('alertas contam a FROTA INTEIRA, não só o que coube no teto', () => {
  const stalledList = Array.from({ length: 5 }, (_, i) =>
    healthItem({ id: `s-${i}`, recording: { active: false, stalled: true, secondsSinceLastSegment: 9000 } }),
  );
  const { cameras: block, alerts } = buildHeartbeatCameras(report(stalledList), 2);
  assert.equal(block.items.length, 2);
  const stalledAlert = alerts.find((a) => a.code === 'cameras_stalled');
  assert.match(
    stalledAlert?.message ?? '',
    /^5 camera/,
    'truncar a lista não pode encolher o alerta — a Central acionaria suporte com o número errado',
  );
});

// ── integração com o payload do heartbeat ────────────────────────────────────

const REPORT_ONE = () =>
  report([
    healthItem({ id: 'cam-ok' }),
    healthItem({ id: 'cam-travada', name: 'Pátio', recording: { active: false, stalled: true, secondsSinceLastSegment: 9000 } }),
  ]);

function makeConnector(opts: { observability?: unknown; limit?: string | null } = {}) {
  const prisma = {
    camera: {
      groupBy: async (args: any) =>
        args?.by?.[0] === 'status'
          ? [
              { status: CameraStatus.ONLINE, _count: { id: 2 } },
              { status: CameraStatus.OFFLINE, _count: { id: 1 } },
            ]
          : [],
      count: async () => 3,
      aggregate: async () => ({ _sum: { recordingBitrateKbps: 0 } }),
    },
    recording: {
      aggregate: async () => ({
        _count: { id: 0 },
        _sum: { sizeBytes: 0 },
        _max: { startedAt: null },
        _min: { startedAt: null },
      }),
      count: async () => 0,
    },
    alarmInstance: { count: async () => 0 },
    user: { count: async () => 1 },
  } as any;

  const moduleRef = {
    get: (token: unknown) => {
      if (token === CameraObservabilityService) {
        if (!opts.observability) throw new Error('Nest não achou CameraObservabilityService');
        return opts.observability;
      }
      // Os demais colaboradores não existem neste contexto de teste; o serviço
      // real já trata isso (é o mesmo caminho de uma instalação sem worker).
      throw new Error(`sem provider para ${String(token)}`);
    },
  } as any;

  return new CloudConnectorService(prisma, moduleRef);
}

/** Isola o ambiente: sem disco real e sem watchdog, os alertas ficam determinísticos. */
async function collect(service: CloudConnectorService, env: Record<string, string | undefined> = {}) {
  const keys = ['RECORDINGS_ROOT', 'CLOUD_HEARTBEAT_CAMERA_LIMIT', ...Object.keys(env)];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RECORDINGS_ROOT = '/nao-existe-drac-teste-storage';
  delete process.env.CLOUD_HEARTBEAT_CAMERA_LIMIT;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return (await (service as any).collectPayload()) as any;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('heartbeat: o payload carrega o bloco de saúde por câmera', async () => {
  const service = makeConnector({
    observability: { getCamerasHealth: async () => REPORT_ONE() },
  });

  const payload = await collect(service);
  assert.ok(payload.cameras, 'bloco novo ausente no payload');
  assert.deepEqual(payload.cameras.totals, { cameras: 2, recordingActive: 1, stalled: 1, offline: 0 });
  assert.deepEqual(payload.cameras.items.map((i: any) => i.cameraId), ['cam-travada', 'cam-ok']);
  assert.equal(payload.cameras.omitted, 0);
  assert.equal(payload.cameras.staleThresholdSeconds, 375);
  // Os agregados de sempre continuam iguais (o bloco é ADITIVO).
  assert.equal(payload.summary.cameraTotal, 3);
  assert.equal(payload.summary.cameraOnline, 2);
});

test('heartbeat: alertas por câmera entram no MESMO esquema (summary.alerts e readiness)', async () => {
  const service = makeConnector({
    observability: { getCamerasHealth: async () => REPORT_ONE() },
  });

  const payload = await collect(service);
  const alert = payload.summary.alerts.find((a: any) => a.code === 'cameras_stalled');
  assert.ok(alert, 'alerta derivado não chegou em summary.alerts');
  assert.deepEqual(Object.keys(alert).sort(), ['code', 'level', 'message'], 'formato do alerta é contrato com a Central');
  assert.equal(alert.level, 'warning');
  assert.deepEqual(
    payload.production.readiness.alerts.map((a: any) => a.code),
    payload.summary.alerts.map((a: any) => a.code),
    'readiness e summary compartilham a MESMA lista de alertas',
  );
  assert.equal(payload.production.readiness.status, 'attention');
});

test('heartbeat: observabilidade que LANÇA não derruba o heartbeat (payload sai SEM o bloco)', async () => {
  const boom = makeConnector({
    observability: {
      getCamerasHealth: async () => {
        throw new Error('banco fora do ar');
      },
    },
  });
  const healthy = makeConnector({ observability: { getCamerasHealth: async () => REPORT_ONE() } });

  const payload = await collect(boom);
  assert.equal('cameras' in payload, false, 'sem dado, o bloco não vai — nem como null/parcial');

  // O resto do heartbeat continua IDÊNTICO ao de sempre.
  const reference = await collect(healthy);
  assert.equal(payload.summary.cameraTotal, 3);
  assert.equal(payload.summary.status, 'attention');
  const derived = ['cameras_stalled', 'camera_recording_expected_inactive'];
  assert.ok(
    reference.summary.alerts.some((a: any) => derived.includes(a.code)),
    'a referência precisa MESMO ter alerta derivado, senão a comparação abaixo é vazia',
  );
  assert.deepEqual(
    payload.summary.alerts.map((a: any) => a.code),
    reference.summary.alerts.map((a: any) => a.code).filter((code: string) => !derived.includes(code)),
    'a falha só pode custar os alertas de câmera, nada mais',
  );
});

test('heartbeat: sem CameraObservabilityService no container o payload segue igual ao de hoje', async () => {
  const service = makeConnector({ observability: undefined });
  const payload = await collect(service);
  assert.equal('cameras' in payload, false);
  assert.deepEqual(payload.summary.alerts.map((a: any) => a.code), ['cameras_unavailable']);
});

test('heartbeat: CLOUD_HEARTBEAT_CAMERA_LIMIT recorta a lista (frota grande não estoura o payload)', async () => {
  const many = report(
    Array.from({ length: 6 }, (_, i) => healthItem({ id: `cam-${i}` })).concat([
      healthItem({ id: 'cam-travada', recording: { active: false, stalled: true, secondsSinceLastSegment: 9000 } }),
    ]),
  );
  const service = makeConnector({ observability: { getCamerasHealth: async () => many } });

  const payload = await collect(service, { CLOUD_HEARTBEAT_CAMERA_LIMIT: '2' });
  assert.equal(payload.cameras.items.length, 2);
  assert.equal(payload.cameras.items[0].cameraId, 'cam-travada');
  assert.equal(payload.cameras.omitted, 5);
  assert.equal(payload.cameras.totals.cameras, 7);
});

// ── fidelidade do fake ───────────────────────────────────────────────────────
// O helper é exercitado acima com objetos montados à mão. Se o relatório REAL do
// CameraObservabilityService não tiver essa forma, todos os testes acima mentem.

test('fake fiel: o relatório REAL do CameraObservabilityService atravessa o helper', async () => {
  const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
  const prisma = {
    camera: {
      findMany: async () => [
        { id: 'real-1', name: 'Recepção', enabled: true, status: 'ONLINE', recordingMode: 'continuous', recordingEnabled: true },
        { id: 'real-2', name: 'Fundos', enabled: true, status: 'OFFLINE', recordingMode: 'continuous', recordingEnabled: true },
      ],
    },
    recording: {
      groupBy: async () => [{ cameraId: 'real-1', _max: { startedAt: new Date(NOW - 60_000), endedAt: new Date(NOW - 60_000) } }],
    },
  } as any;
  const recordings = {
    getRuntimeSummary: () => ({ activeCount: 1, activeCameraIds: ['real-1'], controlMode: 'local' }),
    getRecordingStaleThresholdSeconds: () => 375,
  } as any;
  const observability = new CameraObservabilityService(prisma, recordings, new CameraMetricsService(() => NOW));
  (observability as any).now = () => NOW;

  const real = await observability.getCamerasHealth();
  const { cameras: block, alerts } = buildHeartbeatCameras(real, HEARTBEAT_CAMERA_LIMIT_DEFAULT);

  assert.deepEqual(block.totals, real.totals, 'os totais do bloco têm de bater com o relatório real');
  assert.equal(block.staleThresholdSeconds, real.staleThresholdSeconds);
  assert.deepEqual(block.items.map((i) => i.cameraId).sort(), ['real-1', 'real-2']);
  assert.deepEqual(Object.keys(block.items[0]).sort(), ['cameraId', 'name', 'recording', 'status']);
  assert.deepEqual(
    Object.keys(block.items[0].recording).sort(),
    ['active', 'desired', 'restartsLastHour', 'secondsSinceLastSegment', 'stalled'],
  );
  // real-2 nunca gravou e está em modo contínuo → o relatório real a marca travada.
  assert.equal(block.items[0].cameraId, 'real-2', 'a travada do relatório real vem primeiro');
  assert.ok(alerts.some((a) => a.code === 'cameras_stalled'));
});
