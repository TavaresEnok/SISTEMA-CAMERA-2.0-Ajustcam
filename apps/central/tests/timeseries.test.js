'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ts = require('../src/datastore/timeseries');
const { createDatastore, resolveTimeseriesConfig } = require('../src/datastore');
const { NoopTimeseriesStore, mergeBucketRows } = require('../src/datastore/timeseries-store');
const { heartbeatCameraBlock, heartbeatCameraRaw } = require('../src/server');

// ── Amostra: tem de contar a MESMA história do heartbeat de hoje ─────────────

test('buildSample lê as métricas nos dois formatos que o heartbeat aceita', () => {
  const plano = ts.buildSample({
    at: '2026-07-27T10:00:00.000Z',
    metrics: {
      cameraTotal: 10, cameraOnline: 8, cameraOffline: 1, cameraError: 1,
      activeRecordingCount: 7, diskUsagePercent: 71.5,
    },
    alerts: [{ level: 'critical' }, { level: 'warning' }, { level: 'error' }],
  });
  assert.equal(plano.t, '2026-07-27T10:00:00.000Z');
  assert.equal(plano.camerasTotal, 10);
  assert.equal(plano.camerasOnline, 8);
  assert.equal(plano.recordingsActive, 7);
  assert.equal(plano.diskUsagePercent, 71.5);
  assert.equal(plano.alertsCritical, 2, 'critical + error contam; warning não');

  const aninhado = ts.buildSample({
    at: '2026-07-27T10:00:00.000Z',
    metrics: { cameras: { total: 4, online: 3, offline: 1, error: 0 }, disk: { usagePercent: 33 } },
  });
  assert.equal(aninhado.camerasTotal, 4);
  assert.equal(aninhado.camerasOnline, 3);
  assert.equal(aninhado.camerasOffline, 1);
  assert.equal(aninhado.diskUsagePercent, 33);
});

test('buildSample: disco ausente é null (desconhecido), NÃO zero', () => {
  const sample = ts.buildSample({ at: '2026-07-27T10:00:00.000Z', metrics: { cameraTotal: 2 } });
  assert.equal(sample.diskUsagePercent, null);
  assert.equal(sample.camerasOffline, 0, 'contadores ausentes são 0');
});

// ── Bloco `cameras` OPCIONAL (outro agente vai passar a mandá-lo) ────────────

test('parseCameraHealth aceita o relatório por câmera e normaliza', () => {
  const relatorio = {
    generatedAt: '2026-07-27T10:00:00.000Z',
    staleThresholdSeconds: 120,
    cameras: [
      {
        cameraId: 'cam-1', name: 'Portaria', enabled: true, status: 'ONLINE',
        recording: { desired: true, active: true, lastSegmentAt: '2026-07-27T09:59:00.000Z', secondsSinceLastSegment: 30, segmentsLastHour: 60, restartsLastHour: 0, stalled: false },
        stream: { recoveriesLastHour: 1, lastRecoveryAt: '2026-07-27T09:00:00.000Z' },
      },
      {
        cameraId: 'cam-2', name: 'Fundos', enabled: true, status: 'OFFLINE',
        recording: { desired: true, active: false, secondsSinceLastSegment: 900, segmentsLastHour: 0, restartsLastHour: 3, stalled: true },
        stream: { recoveriesLastHour: 4 },
      },
    ],
  };
  const cameras = ts.parseCameraHealth(relatorio);
  assert.equal(cameras.length, 2);
  assert.equal(cameras[0].cameraId, 'cam-1');
  assert.equal(cameras[0].recordingActive, true);
  assert.equal(cameras[0].streamRecoveriesLastHour, 1);
  assert.equal(cameras[1].recordingStalled, true);
  assert.equal(cameras[1].restartsLastHour, 3);
  assert.equal(cameras[1].lastRecoveryAt, null, 'campo ausente vira null, não quebra');

  // Mesma coisa aceitando o array direto.
  assert.equal(ts.parseCameraHealth(relatorio.cameras).length, 2);
});

test('parseCameraHealth é IDEMPOTENTE (normalizar duas vezes não perde campo)', () => {
  // A rota normaliza e o store normaliza de novo. Se a 2ª passada não entendesse
  // a própria saída, a saúde por câmera chegaria ao banco toda em null.
  const uma = ts.parseCameraHealth([
    {
      cameraId: 'cam-2', name: 'Fundos', enabled: true, status: 'OFFLINE',
      recording: { desired: true, active: false, stalled: true, secondsSinceLastSegment: 900, segmentsLastHour: 0, restartsLastHour: 3, lastSegmentAt: '2026-07-27T09:45:00.000Z' },
      stream: { recoveriesLastHour: 4, lastRecoveryAt: '2026-07-27T09:00:00.000Z' },
    },
  ]);
  const duas = ts.parseCameraHealth(uma);
  assert.deepEqual(duas, uma);
  assert.equal(duas[0].recordingStalled, true);
  assert.equal(duas[0].restartsLastHour, 3);
  assert.equal(duas[0].streamRecoveriesLastHour, 4);
  assert.equal(duas[0].lastSegmentAt, '2026-07-27T09:45:00.000Z');
  assert.deepEqual(ts.parseCameraHealth(duas), uma, 'estável em qualquer número de passadas');
});

test('parseCameraHealth: bloco ausente/lixo NÃO quebra (retorna [])', () => {
  assert.deepEqual(ts.parseCameraHealth(undefined), []);
  assert.deepEqual(ts.parseCameraHealth(null), []);
  assert.deepEqual(ts.parseCameraHealth('nao-sou-lista'), []);
  assert.deepEqual(ts.parseCameraHealth(42), []);
  // O contador de câmeras do heartbeat ({total,online}) NÃO é lista de câmeras.
  assert.deepEqual(ts.parseCameraHealth({ total: 5, online: 4 }), []);
  // Entradas inúteis são descartadas sem erro.
  assert.deepEqual(ts.parseCameraHealth([null, 'x', {}, { cameraId: '  ' }]), []);
});

test('buildSample deriva "estagnadas" do bloco de câmeras quando as métricas não trazem', () => {
  const cameras = [
    { cameraId: 'a', status: 'ONLINE', recording: { active: true, stalled: false } },
    { cameraId: 'b', status: 'ONLINE', recording: { active: true, stalled: true } },
    { cameraId: 'c', status: 'OFFLINE', recording: { active: false, stalled: true } },
  ];
  const sample = ts.buildSample({ at: '2026-07-27T10:00:00.000Z', metrics: {}, cameras });
  assert.equal(sample.camerasStalled, 2);
  assert.equal(sample.camerasTotal, 3);
  assert.equal(sample.camerasOnline, 2);
  assert.equal(sample.recordingsActive, 2);

  // Sem bloco nenhum: nada de exceção, tudo zero.
  const semBloco = ts.buildSample({ at: '2026-07-27T10:00:00.000Z', metrics: {} });
  assert.equal(semBloco.camerasStalled, 0);
  assert.equal(semBloco.camerasTotal, 0);
});

// O bloco REAL que a instalação manda (apps/api .../heartbeat-cameras.helper.ts):
// { totals, staleThresholdSeconds, omitted, items[] } — a lista é CORTADA por
// gravidade num teto (250), mas os totais são da frota INTEIRA.
function blocoRealDaInstalacao({ totalCameras = 400, mostradas = 3, stalled = 7 } = {}) {
  const items = [];
  for (let i = 0; i < mostradas; i += 1) {
    items.push({
      cameraId: `cam-${i}`,
      name: `Câmera ${i}`,
      status: i === 0 ? 'ONLINE' : 'OFFLINE',
      recording: { desired: 'continuous', active: i === 0, stalled: i > 0, secondsSinceLastSegment: 900, restartsLastHour: 2 },
    });
  }
  return {
    totals: { cameras: totalCameras, recordingActive: 380, stalled, offline: 12 },
    staleThresholdSeconds: 120,
    omitted: Math.max(0, totalCameras - mostradas),
    items,
  };
}

test('bloco real da instalação: a lista vem em `items` e é normalizada', () => {
  const cameras = ts.parseCameraHealth(blocoRealDaInstalacao({ mostradas: 3 }));
  assert.equal(cameras.length, 3);
  assert.equal(cameras[0].cameraId, 'cam-0');
  assert.equal(cameras[0].recordingActive, true);
  assert.equal(cameras[1].recordingStalled, true);
  assert.equal(cameras[1].secondsSinceLastSegment, 900);
  assert.equal(cameras[1].restartsLastHour, 2);
});

test('lista TRUNCADA não pode mentir: os totais do bloco vencem a contagem da lista', () => {
  // 400 câmeras, 7 travadas — mas só 3 couberam no payload (2 delas travadas).
  // Contar a lista daria 3 e 2: o painel da frota diria que está tudo bem.
  const bloco = blocoRealDaInstalacao({ totalCameras: 400, mostradas: 3, stalled: 7 });
  const sample = ts.buildSample({ at: '2026-07-27T10:00:00.000Z', metrics: {}, cameras: bloco, cameraTotals: bloco });
  assert.equal(sample.camerasTotal, 400, 'total da frota, não o tamanho da lista truncada');
  assert.equal(sample.camerasStalled, 7, 'travadas da frota, não as 2 que couberam');
  assert.equal(sample.camerasOffline, 12);
  assert.equal(sample.recordingsActive, 380);

  assert.deepEqual(ts.parseCameraTotals(bloco), { cameras: 400, recordingActive: 380, stalled: 7, offline: 12 });
  assert.equal(ts.parseCameraTotals({ items: [] }), null, 'bloco sem totais não inventa número');
  assert.equal(ts.parseCameraTotals(undefined), null);
});

test('heartbeatCameraBlock: ausente = null (não mexe no estado), presente = estado exato', () => {
  assert.equal(heartbeatCameraBlock({ summary: {} }), null, 'sem bloco → null');
  assert.equal(heartbeatCameraBlock({}), null);
  assert.equal(heartbeatCameraBlock(null), null);
  assert.deepEqual(heartbeatCameraBlock({ cameras: [] }), [], 'bloco vazio → estado exato vazio');
  assert.equal(heartbeatCameraBlock({ cameras: [{ cameraId: 'x' }] }).length, 1);
  assert.equal(heartbeatCameraBlock({ observability: { cameras: [{ cameraId: 'y' }] } }).length, 1);
  // Bloco real (com items/totals) → lista normalizada; o cru preserva os totais.
  const bloco = blocoRealDaInstalacao({ mostradas: 2 });
  assert.equal(heartbeatCameraBlock({ cameras: bloco }).length, 2);
  assert.equal(heartbeatCameraRaw({ cameras: bloco }).totals.stalled, 7);
  assert.equal(heartbeatCameraRaw({}), null);
});

// ── Agregação e merge (o coração do rollup) ─────────────────────────────────

test('aggregateSamples calcula min/avg/max e IGNORA métrica ausente', () => {
  const agg = ts.aggregateSamples([
    { t: '2026-07-27T10:00:00.000Z', camerasOnline: 10, diskUsagePercent: 50 },
    { t: '2026-07-27T10:01:00.000Z', camerasOnline: 6, diskUsagePercent: null },
    { t: '2026-07-27T10:02:00.000Z', camerasOnline: 8, diskUsagePercent: 60 },
  ]);
  assert.equal(agg.samples, 3);
  assert.deepEqual(agg.stats.camerasOnline, { min: 6, avg: 8, max: 10, count: 3 });
  assert.deepEqual(agg.stats.diskUsagePercent, { min: 50, avg: 55, max: 60, count: 2 });
});

test('mergeAggregate usa média PONDERADA pela contagem (dentes do rollup parcial)', () => {
  // 3 amostras com média 10 + 1 amostra com média 2 → (10*3 + 2*1)/4 = 8.
  const esquerda = ts.aggregateSamples([
    { camerasOnline: 10 }, { camerasOnline: 10 }, { camerasOnline: 10 },
  ]);
  const direita = ts.aggregateSamples([{ camerasOnline: 2 }]);
  const merged = ts.mergeAggregate(esquerda, direita);
  assert.equal(merged.samples, 4);
  assert.equal(merged.stats.camerasOnline.count, 4);
  assert.equal(merged.stats.camerasOnline.avg, 8, 'média simples daria 6 — seria MENTIRA');
  assert.equal(merged.stats.camerasOnline.min, 2);
  assert.equal(merged.stats.camerasOnline.max, 10);
});

test('mergeAggregate é equivalente a agregar tudo de uma vez (rollup em 2 passadas == 1)', () => {
  const amostras = [];
  for (let i = 0; i < 17; i += 1) {
    amostras.push({ camerasOnline: i, diskUsagePercent: i % 3 === 0 ? null : i * 2 });
  }
  const inteiro = ts.aggregateSamples(amostras);
  const parcial = ts.mergeAggregate(
    ts.aggregateSamples(amostras.slice(0, 5)),
    ts.aggregateSamples(amostras.slice(5)),
  );
  assert.equal(parcial.samples, inteiro.samples);
  assert.deepEqual(parcial.stats.camerasOnline, inteiro.stats.camerasOnline);
  assert.deepEqual(parcial.stats.diskUsagePercent, inteiro.stats.diskUsagePercent);
});

test('mergeAggregate tolera lado ausente (primeiro rollup de um bucket novo)', () => {
  const agg = ts.aggregateSamples([{ camerasOnline: 4 }]);
  assert.deepEqual(ts.mergeAggregate(null, agg).stats.camerasOnline, agg.stats.camerasOnline);
  assert.deepEqual(ts.mergeAggregate(agg, null).stats.camerasOnline, agg.stats.camerasOnline);
});

// ── Retenção / rollup: NADA pode sumir em silêncio ──────────────────────────

function serie(inicioIso, quantidade, passoMinutos, valorInicial = 0) {
  const inicio = new Date(inicioIso).getTime();
  const amostras = [];
  for (let i = 0; i < quantidade; i += 1) {
    amostras.push({
      t: new Date(inicio + i * passoMinutos * 60000).toISOString(),
      camerasOnline: valorInicial + i,
      diskUsagePercent: 50,
    });
  }
  return amostras;
}

test('planRetention: amostras velhas viram agregado horário e NADA é perdido', () => {
  const now = '2026-07-27T12:00:00.000Z';
  // 72h de amostras a cada 30min (145 amostras), retenção crua de 48h.
  const amostras = serie('2026-07-24T12:00:00.000Z', 145, 30);
  const plano = ts.planRetention(amostras, { now, rawRetentionHours: 48 });

  assert.equal(plano.cutoff, '2026-07-25T12:00:00.000Z');
  assert.equal(
    plano.kept.length + plano.pruned.length + plano.invalid.length,
    amostras.length,
    'toda amostra tem de terminar em kept, pruned ou invalid',
  );
  const emBuckets = plano.buckets.reduce((total, bucket) => total + bucket.samples, 0);
  assert.equal(emBuckets, plano.pruned.length, 'toda amostra podada tem de estar num bucket horário');
  assert.ok(plano.pruned.length > 0, 'o cenário precisa de amostras antigas para valer');
  assert.ok(plano.kept.length > 0, 'as recentes continuam cruas');

  // Nenhuma amostra mantida é mais velha que o corte; nenhuma podada é recente.
  const cutoffMs = new Date(plano.cutoff).getTime();
  assert.ok(plano.kept.every((s) => new Date(s.t).getTime() >= cutoffMs));
  assert.ok(plano.pruned.every((s) => new Date(s.t).getTime() < cutoffMs));

  // Buckets são horas cheias, ordenados, e o agregado bate com as amostras.
  assert.ok(plano.buckets.every((b) => b.bucket.endsWith(':00:00.000Z')));
  const primeiro = plano.buckets[0];
  const doPrimeiro = plano.pruned.filter((s) => ts.hourBucket(s.t) === primeiro.bucket);
  assert.equal(primeiro.samples, doPrimeiro.length);
  assert.equal(
    primeiro.stats.camerasOnline.max,
    Math.max(...doPrimeiro.map((s) => s.camerasOnline)),
  );
});

test('planRetention: a amostra EXATAMENTE no corte é MANTIDA (fronteira)', () => {
  const now = '2026-07-27T12:00:00.000Z';
  const amostras = [
    { t: '2026-07-25T11:59:59.999Z', camerasOnline: 1 }, // 1ms mais velha que o corte
    { t: '2026-07-25T12:00:00.000Z', camerasOnline: 2 }, // exatamente no corte
    { t: '2026-07-27T11:59:00.000Z', camerasOnline: 3 },
  ];
  const plano = ts.planRetention(amostras, { now, rawRetentionHours: 48 });
  assert.deepEqual(plano.pruned.map((s) => s.camerasOnline), [1]);
  assert.deepEqual(plano.kept.map((s) => s.camerasOnline), [2, 3]);
});

test('planRetention: amostra sem timestamp válido vai para `invalid` (nunca some)', () => {
  const plano = ts.planRetention(
    [{ t: 'nao-e-data', camerasOnline: 1 }, { t: null, camerasOnline: 2 }, { t: '2026-07-27T11:00:00.000Z', camerasOnline: 3 }],
    { now: '2026-07-27T12:00:00.000Z', rawRetentionHours: 48 },
  );
  assert.equal(plano.invalid.length, 2);
  assert.equal(plano.pruned.length, 0);
  assert.equal(plano.kept.length, 1);
  assert.equal(plano.buckets.length, 0);
});

test('planRetention: rollup em duas passadas dá o MESMO agregado de uma passada', () => {
  const amostras = serie('2026-07-20T08:00:00.000Z', 40, 1, 5); // 40 min dentro da mesma hora+
  const now = '2026-07-27T12:00:00.000Z';
  const umaVez = ts.planRetention(amostras, { now, rawRetentionHours: 1 });

  const parteA = ts.planRetention(amostras.slice(0, 12), { now, rawRetentionHours: 1 });
  const parteB = ts.planRetention(amostras.slice(12), { now, rawRetentionHours: 1 });
  const porBucket = new Map();
  for (const bucket of [...parteA.buckets, ...parteB.buckets]) {
    porBucket.set(bucket.bucket, ts.mergeAggregate(porBucket.get(bucket.bucket) || null, bucket));
  }
  for (const bucket of umaVez.buckets) {
    const incremental = porBucket.get(bucket.bucket);
    assert.equal(incremental.samples, bucket.samples, `bucket ${bucket.bucket}`);
    assert.deepEqual(incremental.stats.camerasOnline, bucket.stats.camerasOnline, `bucket ${bucket.bucket}`);
  }
});

test('hourlyCutoff respeita a retenção do agregado', () => {
  assert.equal(
    ts.hourlyCutoff({ now: '2026-07-27T12:00:00.000Z', hourlyRetentionDays: 90 }),
    '2026-04-28T12:00:00.000Z',
  );
});

// ── Pontos para o gráfico ───────────────────────────────────────────────────

test('hourlyRowToPoint mantém as MESMAS chaves do ponto cru (o gráfico não muda de forma)', () => {
  const agg = ts.aggregateSamples([
    { camerasOnline: 4, diskUsagePercent: 10 },
    { camerasOnline: 8, diskUsagePercent: 20 },
  ]);
  const point = ts.hourlyRowToPoint({ bucket: '2026-07-27T10:00:00.000Z', samples: agg.samples, stats: agg.stats });
  assert.equal(point.t, '2026-07-27T10:00:00.000Z');
  assert.equal(point.samples, 2);
  assert.equal(point.camerasOnline, 6, 'o valor de topo é a MÉDIA da hora');
  assert.equal(point.min.camerasOnline, 4);
  assert.equal(point.max.camerasOnline, 8);
  for (const key of ts.METRIC_KEYS) assert.ok(key in point, `falta a chave ${key}`);
});

test('pointsFromHeartbeatHistory (fallback SEM Postgres) filtra pelo intervalo e é honesto no desconhecido', () => {
  const history = [
    { at: '2026-07-27T09:00:00.000Z', cameraTotal: 3, cameraOnline: 3, activeRecordingCount: 2, diskUsagePercent: 40 },
    { at: '2026-07-27T10:00:00.000Z', cameraTotal: 3, cameraOnline: 2, cameraOffline: 1, activeRecordingCount: 1, diskUsagePercent: 41 },
    { at: '2026-07-27T11:00:00.000Z', cameraTotal: 3, cameraOnline: 3, activeRecordingCount: 3, diskUsagePercent: 42 },
    { at: 'lixo' },
  ];
  const points = ts.pointsFromHeartbeatHistory(history, { from: '2026-07-27T09:30:00.000Z', to: '2026-07-27T10:30:00.000Z' });
  assert.equal(points.length, 1);
  assert.equal(points[0].camerasOnline, 2);
  assert.equal(points[0].camerasOffline, 1);
  assert.equal(points[0].diskUsagePercent, 41);
  assert.equal(points[0].camerasStalled, null, 'o histórico curto nunca teve "estagnadas": null, não 0');
  assert.equal(points[0].alertsCritical, null);

  const todos = ts.pointsFromHeartbeatHistory(history, {});
  assert.equal(todos.length, 3, 'entrada com data inválida é descartada, sem erro');
  assert.deepEqual(ts.pointsFromHeartbeatHistory(undefined, {}), []);
});

test('foldFleetRows SOMA contadores entre instalações e faz MÉDIA do disco', () => {
  const a = ts.toBucketRows('cli-a', [
    { t: '2026-07-27T10:00:00.000Z', camerasOnline: 10, diskUsagePercent: 80 },
    { t: '2026-07-27T10:05:00.000Z', camerasOnline: 10, diskUsagePercent: 90 },
  ], 3600);
  const b = ts.toBucketRows('cli-b', [
    { t: '2026-07-27T10:10:00.000Z', camerasOnline: 4, diskUsagePercent: 20 },
  ], 3600);

  const [point] = ts.foldFleetRows([...a, ...b]);
  assert.equal(point.t, '2026-07-27T10:00:00.000Z');
  assert.equal(point.installations, 2);
  assert.equal(point.samples, 3);
  assert.equal(point.camerasOnline, 14, 'contador: soma das médias por instalação');
  assert.equal(point.diskUsagePercent, 52.5, 'percentual: média entre instalações (85 e 20)');
  assert.equal(point.max.diskUsagePercent, 90, 'o pico da frota continua visível');
  assert.equal(point.min.diskUsagePercent, 20);
});

test('toBucketRows agrupa por bucket e não mistura instalações', () => {
  const rows = ts.toBucketRows('cli-a', [
    { t: '2026-07-27T10:00:00.000Z', camerasOnline: 1 },
    { t: '2026-07-27T10:59:59.000Z', camerasOnline: 3 },
    { t: '2026-07-27T11:00:00.000Z', camerasOnline: 5 },
  ], 3600);
  assert.deepEqual(rows.map((r) => r.bucket), ['2026-07-27T10:00:00.000Z', '2026-07-27T11:00:00.000Z']);
  assert.equal(rows[0].samples, 2);
  assert.equal(rows[0].stats.camerasOnline.avg, 2);
  assert.ok(rows.every((r) => r.installationId === 'cli-a'));
});

test('mergeBucketRows funde rollup consolidado com agregação ao vivo do MESMO bucket', () => {
  const consolidado = [{ installationId: 'cli-a', bucket: '2026-07-27T10:00:00.000Z', ...ts.aggregateSamples([{ camerasOnline: 10 }, { camerasOnline: 10 }, { camerasOnline: 10 }]) }];
  const aoVivo = [
    { installationId: 'cli-a', bucket: '2026-07-27T10:00:00.000Z', ...ts.aggregateSamples([{ camerasOnline: 2 }]) },
    { installationId: 'cli-a', bucket: '2026-07-27T11:00:00.000Z', ...ts.aggregateSamples([{ camerasOnline: 7 }]) },
  ];
  const rows = mergeBucketRows(consolidado, aoVivo);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].samples, 4);
  assert.equal(rows[0].stats.camerasOnline.avg, 8, 'ponderada, igual ao merge de agregados');
  assert.equal(rows[1].samples, 1);
});

// ── Parâmetros de consulta ──────────────────────────────────────────────────

test('resolveRange nunca lança: entrada inválida cai no padrão e a janela é limitada', () => {
  const now = '2026-07-27T12:00:00.000Z';
  const padrao = ts.resolveRange({}, { now });
  assert.equal(padrao.to, now);
  assert.equal(padrao.from, '2026-07-26T12:00:00.000Z');

  const lixo = ts.resolveRange({ from: 'abacaxi', to: 'melancia' }, { now });
  assert.deepEqual(lixo, padrao);

  const invertido = ts.resolveRange({ from: '2026-07-27T10:00:00.000Z', to: '2026-07-27T08:00:00.000Z' }, { now });
  assert.equal(invertido.from, '2026-07-27T08:00:00.000Z');
  assert.equal(invertido.to, '2026-07-27T10:00:00.000Z');

  const enorme = ts.resolveRange({ from: '2020-01-01T00:00:00.000Z', to: now }, { now, maxSpanDays: 30 });
  assert.equal(enorme.from, '2026-06-27T12:00:00.000Z', 'janela limitada a 30 dias');
});

test('chooseResolution: janela dentro da retenção crua = raw; mais antiga = hour', () => {
  const now = '2026-07-27T12:00:00.000Z';
  const opts = { now, rawRetentionHours: 48 };
  assert.equal(ts.chooseResolution({ from: '2026-07-27T00:00:00.000Z', to: now }, opts), 'raw');
  assert.equal(ts.chooseResolution({ from: '2026-07-01T00:00:00.000Z', to: now }, opts), 'hour');
  assert.equal(ts.chooseResolution({ from: '2026-07-27T00:00:00.000Z', to: now }, { ...opts, requested: 'hour' }), 'hour');
  assert.equal(ts.chooseResolution({ from: '2026-07-01T00:00:00.000Z', to: now }, { ...opts, requested: 'raw' }), 'raw');
});

// ── NO-OP sem Postgres: o DEFAULT de produção ───────────────────────────────

test('sem Postgres a série temporal é NO-OP silencioso (produção não muda)', async () => {
  const config = { databaseUrl: '', mode: 'json', dataFile: '/tmp/x.json', backupDir: '/tmp', timeseries: resolveTimeseriesConfig({}, 'json') };
  const saves = [];
  const ds = createDatastore({
    legacy: { load: async () => ({ installations: {}, users: {}, sessions: {}, auditEvents: [] }), save: async (db) => { saves.push(db); } },
    config,
  });

  assert.equal(ds.mode, 'json');
  assert.equal(ds.store, null, 'nenhum pool Postgres é criado');
  assert.ok(ds.timeseries instanceof NoopTimeseriesStore);
  assert.equal(ds.timeseries.enabled, false);

  // Toda a superfície responde sem I/O e sem exceção.
  assert.equal(await ds.timeseries.recordHeartbeat('cli-a', { sample: ts.buildSample({ metrics: {} }) }), null);
  assert.equal(await ds.timeseries.maintain({ now: new Date() }), null);
  assert.equal(await ds.timeseries.installationSeries('cli-a', {}), null);
  assert.equal(await ds.timeseries.fleetSeries({}), null);
  assert.deepEqual(await ds.timeseries.cameraHealth('cli-a'), []);
  assert.equal(await ds.timeseries.purgeInstallation('cli-a'), null);

  // E o datastore continua exatamente o de hoje: escreve no JSON legado.
  await ds.save({ installations: {} });
  assert.equal(saves.length, 1);
});

test('a série temporal só liga com a URL ESPECÍFICA da Central (nunca sozinha)', () => {
  assert.equal(resolveTimeseriesConfig({}, 'json').enabled, false);
  assert.equal(resolveTimeseriesConfig({ DATABASE_URL: 'postgres://vms:x@db:5432/vms' }, 'json').enabled, false);
  assert.equal(resolveTimeseriesConfig({}, 'dual').enabled, true);
  assert.equal(resolveTimeseriesConfig({ DRAC_CENTRAL_TIMESERIES_ENABLED: 'false' }, 'dual').enabled, false);
  assert.equal(resolveTimeseriesConfig({ DRAC_CENTRAL_TIMESERIES_RAW_HOURS: '12' }, 'dual').rawRetentionHours, 12);
  assert.equal(resolveTimeseriesConfig({ DRAC_CENTRAL_TIMESERIES_RAW_HOURS: 'abc' }, 'dual').rawRetentionHours, 48);
});
