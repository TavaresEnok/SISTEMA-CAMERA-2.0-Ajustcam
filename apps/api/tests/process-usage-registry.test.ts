import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CameraMetricsService,
  CAMERA_METRICS_MAX_PROCESSES,
} from '../src/observability/camera-metrics.service';
import { buildProcessSeries } from '../src/observability/camera-prometheus.helper';
import { formatPrometheus } from '../src/observability/prometheus.helper';
import { MetricsController } from '../src/observability/metrics.controller';
import { ProcessUsageCollector } from '../src/observability/process-usage.collector';
import { CameraObservabilityService } from '../src/observability/camera-observability.service';

// ─────────────────────────────────────────────────────────────────────────────
// Registro PID → câmera e a atribuição do custo (CPU/RSS) a cada câmera.
//
// Por que isto existe: sem custo POR CÂMERA, "quantas câmeras cabem neste
// servidor" é chute — e chute erra para os dois lados (sobra = margem jogada
// fora; falta = SLA quebrado no meio do contrato).
//
// Invariantes provados aqui:
//  • o registro NUNCA lança (é chamado de dentro do caminho de gravação);
//  • memória limitada (a API vive meses de pé);
//  • PID morto some sozinho;
//  • no /metrics PÚBLICO só existe o rótulo camera_id — nem pid, nem kind,
//    nem nome/IP (regra de PII/LGPD já estabelecida neste módulo).
// ─────────────────────────────────────────────────────────────────────────────

const CAM_A = '11111111-2222-3333-4444-555555555555';
const CAM_B = '99999999-8888-7777-6666-555555555555';
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

function registry(nowMs = NOW) {
  return new CameraMetricsService(() => nowMs, () => 4);
}

// ── registro PID → câmera ────────────────────────────────────────────────────

test('registro: trackProcess associa PIDs à câmera e untrackProcess desassocia', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 4242);
  reg.trackProcess(CAM_A, 'prebuffer', 4243);
  reg.trackProcess(CAM_B, 'recording', 5000);

  assert.deepEqual(reg.trackedPids().sort((a, b) => a - b), [4242, 4243, 5000]);
  reg.untrackProcess(4243);
  assert.deepEqual(reg.trackedPids().sort((a, b) => a - b), [4242, 5000]);
  reg.untrackProcess(4243); // idempotente
  assert.equal(reg.trackedProcessCount, 2);
});

test('registro: entrada nova no MESMO pid substitui a antiga (PID reciclado pelo SO)', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 4242);
  reg.observeProcessUsage([{ pid: 4242, cpuPercent: 90, rssBytes: 1024 }]);
  reg.trackProcess(CAM_B, 'transcode', 4242);

  assert.equal(reg.processUsage(CAM_A).processes, 0, 'o PID antigo não pode ficar pendurado na câmera errada');
  assert.equal(reg.processUsage(CAM_B).processes, 1);
  assert.equal(reg.processUsage(CAM_B).cpuPercent, 0, 'a amostra do processo ANTERIOR não vale para o novo');
});

test('registro: entrada inválida é ignorada em silêncio (JAMAIS lança no caminho de gravação)', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 0);
  reg.trackProcess(CAM_A, 'recording', -1);
  reg.trackProcess(CAM_A, 'recording', 1.5);
  reg.trackProcess(CAM_A, 'recording', Number.NaN);
  reg.trackProcess('', 'recording', 10);
  reg.trackProcess(null as unknown as string, 'recording', 11);
  reg.trackProcess(CAM_A, 'coisa-que-nao-existe' as never, 12);
  reg.untrackProcess(Number.NaN);
  reg.untrackProcess(null as unknown as number);

  assert.deepEqual(reg.trackedPids(), [12], 'só o PID válido entrou');
  assert.equal(reg.processUsage(CAM_A).details[0].kind, 'other', 'kind desconhecido cai em "other", não quebra');
});

test('registro: TETO de memória — passar do limite não faz o Map crescer sem fim', () => {
  const reg = registry();
  for (let pid = 1; pid <= CAMERA_METRICS_MAX_PROCESSES + 250; pid += 1) {
    reg.trackProcess(CAM_A, 'recording', pid);
  }
  assert.equal(
    reg.trackedProcessCount,
    CAMERA_METRICS_MAX_PROCESSES,
    'sem teto, um vazamento de untrackProcess derruba a API por memória depois de meses',
  );
  const pids = reg.trackedPids();
  assert.equal(pids.includes(1), false, 'o mais antigo é o descartado');
  assert.equal(pids.includes(CAMERA_METRICS_MAX_PROCESSES + 250), true, 'o mais recente fica');
});

test('registro: untrackCameraProcesses limpa tudo de uma câmera de uma vez', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 1);
  reg.trackProcess(CAM_A, 'prebuffer', 2);
  reg.trackProcess(CAM_B, 'recording', 3);
  reg.untrackCameraProcesses(CAM_A);
  assert.deepEqual(reg.trackedPids(), [3]);
});

// ── atribuição de custo ──────────────────────────────────────────────────────

test('agregado: CPU e RSS de vários processos SOMAM na câmera dona', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  reg.trackProcess(CAM_A, 'prebuffer', 11);
  reg.trackProcess(CAM_B, 'recording', 20);
  reg.observeProcessUsage([
    { pid: 10, cpuPercent: 42.5, rssBytes: 12_000_000 },
    { pid: 11, cpuPercent: 7.5, rssBytes: 3_000_000 },
    { pid: 20, cpuPercent: 10, rssBytes: 8_000_000 },
    { pid: 999, cpuPercent: 500, rssBytes: 1 }, // PID de ninguém: descartado
  ]);

  const a = reg.processUsage(CAM_A);
  assert.equal(a.cpuPercent, 50);
  assert.equal(a.memoryBytes, 15_000_000);
  assert.equal(a.processes, 2);
  assert.equal(a.measuredProcesses, 2);

  const totals = reg.processUsageTotals();
  assert.equal(totals.cpuPercent, 60, 'total do host = soma das câmeras');
  assert.equal(totals.memoryBytes, 23_000_000);
  assert.equal(totals.cameras, 2);
  assert.equal(totals.cpuBudgetCores, 4);
  assert.equal(totals.cpuSaturation, 0.15, '60% de 400% disponíveis');
  assert.equal(totals.cpuPercentPerCamera, 30);
});

test('agregado: processo AINDA sem amostra não conta como 0% (não dilui a média)', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  reg.trackProcess(CAM_B, 'recording', 20);
  reg.observeProcessUsage([{ pid: 10, cpuPercent: 40, rssBytes: 1000 }]);

  const totals = reg.processUsageTotals();
  assert.equal(totals.cameras, 1, 'só a câmera com medida entra na conta de capacidade');
  assert.equal(totals.cpuPercentPerCamera, 40, 'diluir com a câmera não medida diria "cabe o dobro"');
  assert.equal(reg.processUsage(CAM_B).measuredProcesses, 0);
  assert.equal(reg.processUsage(CAM_B).cpuPercent, 0);
});

test('agregado: câmera desconhecida devolve zeros sem alocar entrada', () => {
  const reg = registry();
  const usage = reg.processUsage(CAM_A);
  assert.equal(usage.cpuPercent, 0);
  assert.equal(usage.processes, 0);
  assert.deepEqual(usage.details, []);
  assert.equal(reg.trackedProcessCount, 0);
});

test('agregado: detalhe traz pid e kind (é o endpoint AUTENTICADO que consome isso)', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  reg.trackProcess(CAM_A, 'transcode', 11);
  reg.observeProcessUsage([{ pid: 10, cpuPercent: 12, rssBytes: 100 }]);
  const details = reg.processUsage(CAM_A).details;
  assert.deepEqual(details.map((d) => [d.pid, d.kind, d.cpuPercent]), [
    [10, 'recording', 12],
    [11, 'transcode', null],
  ]);
});

// ── /metrics público ─────────────────────────────────────────────────────────

function processLabelBlocks(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('drac_camera_process'))
    .map((line) => {
      const open = line.indexOf('{');
      const close = line.indexOf('}');
      return open === -1 || close === -1 ? '' : line.slice(open + 1, close);
    });
}

test('/metrics: séries de custo por câmera + totais do host', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  reg.trackProcess(CAM_A, 'prebuffer', 11);
  reg.trackProcess(CAM_B, 'recording', 20);
  reg.observeProcessUsage([
    { pid: 10, cpuPercent: 40, rssBytes: 10_000_000 },
    { pid: 11, cpuPercent: 5, rssBytes: 2_000_000 },
    { pid: 20, cpuPercent: 15, rssBytes: 5_000_000 },
  ]);

  const body = formatPrometheus(buildProcessSeries({
    usages: reg.processUsageByCamera(),
    totals: reg.processUsageTotals(),
  }));

  assert.match(body, new RegExp(`^drac_camera_process_cpu_percent\\{camera_id="${CAM_A}"\\} 45$`, 'm'));
  assert.match(body, new RegExp(`^drac_camera_process_memory_bytes\\{camera_id="${CAM_A}"\\} 12000000$`, 'm'));
  assert.match(body, new RegExp(`^drac_camera_process_count\\{camera_id="${CAM_A}"\\} 2$`, 'm'));
  assert.match(body, new RegExp(`^drac_camera_process_cpu_percent\\{camera_id="${CAM_B}"\\} 15$`, 'm'));
  assert.match(body, /^drac_host_camera_process_cpu_percent 60$/m);
  assert.match(body, /^drac_host_camera_process_memory_bytes 17000000$/m);
  assert.match(body, /^drac_host_cpu_budget_cores 4$/m);
  assert.match(body, /^drac_host_camera_process_cpu_saturation 0.15$/m);
  assert.equal((body.match(/# TYPE drac_camera_process_cpu_percent/g) ?? []).length, 1, 'HELP/TYPE uma vez só');
});

test('PRIVACIDADE: o ÚNICO rótulo das séries de custo é camera_id (nem pid, nem kind)', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 4242);
  reg.observeProcessUsage([{ pid: 4242, cpuPercent: 40, rssBytes: 10 }]);
  const body = formatPrometheus(buildProcessSeries({
    usages: reg.processUsageByCamera(),
    totals: reg.processUsageTotals(),
  }));

  const blocks = processLabelBlocks(body);
  assert.ok(blocks.length >= 3, 'esperava as séries por câmera');
  for (const block of blocks) {
    assert.match(block, /^camera_id="[0-9a-fA-F-]+"$/, `rótulo proibido no /metrics público: {${block}}`);
  }
  assert.equal(/pid="/.test(body), false, 'PID é rótulo de alta cardinalidade e muda a cada restart');
  assert.equal(body.includes('4242'), false, 'nem como valor: o PID não descreve custo');
});

test('PRIVACIDADE: id que não tem forma de identificador NÃO vira série pública', () => {
  const reg = registry();
  // Alguém instrumentou passando nome/IP como "cameraId": fail-closed.
  reg.trackProcess('Recepção Cliente ACME', 'recording', 10);
  reg.trackProcess('192.168.10.42', 'recording', 11);
  reg.trackProcess('rtsp://admin:s3nh4@192.168.10.42:554/cam', 'recording', 12);
  reg.trackProcess(CAM_A, 'recording', 13);
  reg.observeProcessUsage([
    { pid: 10, cpuPercent: 1, rssBytes: 1 },
    { pid: 11, cpuPercent: 1, rssBytes: 1 },
    { pid: 12, cpuPercent: 1, rssBytes: 1 },
    { pid: 13, cpuPercent: 1, rssBytes: 1 },
  ]);
  const body = formatPrometheus(buildProcessSeries({
    usages: reg.processUsageByCamera(),
    totals: reg.processUsageTotals(),
  }));

  assert.equal(body.includes('Recepção'), false, 'nome entrega o CLIENTE num endpoint público');
  assert.equal(body.includes('192.168.10.42'), false, 'IP entrega a topologia');
  assert.equal(body.includes('rtsp://'), false, 'URL RTSP carrega credencial');
  assert.equal(body.includes('s3nh4'), false);
  assert.match(body, new RegExp(`^drac_camera_process_cpu_percent\\{camera_id="${CAM_A}"\\} 1$`, 'm'));
});

test('PRIVACIDADE: nada do PROCESSO (nome do binário/cmdline) chega ao /metrics', () => {
  // O Frigate publica `cmdline` como rótulo. Aqui isso vazaria a URL RTSP com
  // senha do FFmpeg num endpoint sem autenticação.
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  reg.observeProcessUsage([{ pid: 10, cpuPercent: 1, rssBytes: 1 }]);
  const body = formatPrometheus(buildProcessSeries({
    usages: reg.processUsageByCamera(),
    totals: reg.processUsageTotals(),
  }));
  assert.equal(/ffmpeg/i.test(body), false);
  assert.equal(/cmdline/i.test(body), false);
  assert.equal(/\bname="/.test(body), false);
});

test('/metrics: sem processo rastreado, as séries por câmera somem — os agregados permanecem', () => {
  const reg = registry();
  const body = formatPrometheus(buildProcessSeries({
    usages: reg.processUsageByCamera(),
    totals: reg.processUsageTotals(),
  }));
  assert.equal(body.includes('drac_camera_process_cpu_percent'), false);
  assert.match(body, /^drac_host_camera_process_cpu_percent 0$/m);
});

test('/metrics: o controller publica o custo junto com o que já existia', () => {
  const reg = new CameraMetricsService(() => Date.now(), () => 4);
  reg.trackProcess(CAM_A, 'recording', 4242);
  reg.observeProcessUsage([{ pid: 4242, cpuPercent: 33, rssBytes: 7_000_000 }]);
  const recordings = {
    getActiveRecordingCount: () => 1,
    getRuntimeSummary: () => ({ activeCameraIds: [CAM_A] }),
  } as any;

  const body = new MetricsController(recordings, reg).metrics();
  assert.match(body, /^drac_api_up 1$/m, 'as agregadas antigas continuam intactas');
  assert.match(body, new RegExp(`^drac_camera_process_cpu_percent\\{camera_id="${CAM_A}"\\} 33$`, 'm'));
  assert.match(body, /^drac_host_camera_process_cpu_percent 33$/m);
});

test('/metrics: FALHA na coleta de custo não derruba o endpoint', () => {
  const reg = new CameraMetricsService(() => Date.now(), () => 4);
  (reg as any).processUsageByCamera = () => { throw new Error('boom'); };
  const recordings = {
    getActiveRecordingCount: () => 0,
    getRuntimeSummary: () => ({ activeCameraIds: [] }),
  } as any;

  const body = new MetricsController(recordings, reg).metrics();
  assert.match(body, /^drac_api_up 1$/m, 'observabilidade quebrada não pode apagar o /metrics');
});

// ── coletor ──────────────────────────────────────────────────────────────────

function fakeSampler(script: Array<{ readings: Array<{ pid: number; cpuPercent: number | null; rssBytes: number | null }>; deadPids: number[] }>) {
  const seen: number[][] = [];
  let call = 0;
  return {
    seen,
    sampler: {
      available: true,
      sample(pids: Iterable<number>) {
        seen.push([...pids]);
        return script[Math.min(call++, script.length - 1)];
      },
      forget() {},
    } as any,
  };
}

test('coletor: amostra SÓ os PIDs registrados (custo O(frota), não O(host))', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  reg.trackProcess(CAM_B, 'recording', 20);
  const { seen, sampler } = fakeSampler([{ readings: [{ pid: 10, cpuPercent: 30, rssBytes: 100 }], deadPids: [] }]);

  new ProcessUsageCollector(reg, sampler).collectOnce();

  assert.deepEqual(seen[0].sort((a, b) => a - b), [10, 20]);
  assert.equal(reg.processUsage(CAM_A).cpuPercent, 30);
});

test('coletor: PID morto é DESREGISTRADO (limpeza automática, sem erro)', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  reg.trackProcess(CAM_A, 'prebuffer', 11);
  const { sampler } = fakeSampler([{ readings: [{ pid: 10, cpuPercent: 5, rssBytes: 1 }], deadPids: [11] }]);

  new ProcessUsageCollector(reg, sampler).collectOnce();

  assert.deepEqual(reg.trackedPids(), [10], 'o processo que morreu some do registro sozinho');
  assert.equal(reg.processUsage(CAM_A).processes, 1);
});

test('coletor: sampler que EXPLODE não propaga (gravação não pode cair por métrica)', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  const sampler = { available: true, sample() { throw new Error('boom'); }, forget() {} } as any;
  assert.doesNotThrow(() => new ProcessUsageCollector(reg, sampler).collectOnce());
  assert.deepEqual(reg.trackedPids(), [10], 'falha de coleta NÃO desregistra processo vivo');
});

test('coletor: sampler indisponível (sem /proc) simplesmente não coleta', () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 10);
  let called = 0;
  const sampler = { available: false, sample() { called += 1; return { readings: [], deadPids: [] }; }, forget() {} } as any;
  const collector = new ProcessUsageCollector(reg, sampler);
  collector.onModuleInit();
  collector.collectOnce();
  collector.onApplicationShutdown();
  assert.equal(called, 0);
  assert.deepEqual(reg.trackedPids(), [10]);
});

// ── endpoint autenticado ─────────────────────────────────────────────────────

function observabilityService(reg: CameraMetricsService) {
  const prisma = {
    camera: {
      findMany: async () => [
        { id: CAM_A, name: 'Recepção', enabled: true, status: 'ONLINE', recordingMode: 'continuous', recordingEnabled: true },
      ],
    },
    recording: { groupBy: async () => [] },
  } as any;
  const recordings = {
    getRuntimeSummary: () => ({ activeCameraIds: [CAM_A], controlMode: 'local' }),
    getRecordingStaleThresholdSeconds: () => 375,
  } as any;
  return new CameraObservabilityService(prisma, recordings, reg);
}

test('GET /observability/cameras: custo por câmera COM detalhe (rota autenticada)', async () => {
  const reg = registry();
  reg.trackProcess(CAM_A, 'recording', 4242);
  reg.trackProcess(CAM_A, 'prebuffer', 4243);
  reg.observeProcessUsage([
    { pid: 4242, cpuPercent: 40, rssBytes: 10_000_000 },
    { pid: 4243, cpuPercent: 5, rssBytes: 2_000_000 },
  ]);

  const report = await observabilityService(reg).getCamerasHealth();
  const item = report.cameras[0];
  assert.equal(item.processes.cpuPercent, 45);
  assert.equal(item.processes.memoryBytes, 12_000_000);
  assert.equal(item.processes.count, 2);
  assert.deepEqual(
    item.processes.items.map((p) => [p.pid, p.kind, p.cpuPercent]),
    [[4242, 'recording', 40], [4243, 'prebuffer', 5]],
    'aqui o detalhe PODE aparecer: a rota exige ADMIN + serverConfig',
  );

  assert.equal(report.host.cpuPercent, 45);
  assert.equal(report.host.cpuBudgetCores, 4);
  assert.equal(report.host.cameras, 1);
  assert.equal(report.host.estimatedCameraCapacity, 7, '400 × 0,8 = 320 → 320/45 = 7 câmeras');
});

test('GET /observability/cameras: totals ANTIGO permanece com os mesmos 4 campos', async () => {
  const reg = registry();
  const report = await observabilityService(reg).getCamerasHealth();
  assert.deepEqual(Object.keys(report.totals), ['cameras', 'recordingActive', 'stalled', 'offline']);
  assert.deepEqual(report.cameras[0].processes.items, [], 'câmera sem processo rastreado: bloco vazio, não ausente');
});
