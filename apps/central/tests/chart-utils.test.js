'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const cu = require('../public/chart-utils.js');

const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

// ── Escala / eixo Y ─────────────────────────────────────────────────────────

test('computeScale: série vazia, constante, toda zero ou negativa nunca produz span 0', () => {
  const cases = [
    [],
    [0, 0, 0],
    [5, 5, 5],
    [-7, -7],
    [-3, -7, -5],
    [0],
    [1e-9, 1e-9],
    ['lixo', null, undefined, NaN, Infinity],
  ];
  for (const values of cases) {
    const scale = cu.computeScale(values);
    assert.ok(Number.isFinite(scale.min), `min finito para ${JSON.stringify(values)}`);
    assert.ok(Number.isFinite(scale.max), `max finito para ${JSON.stringify(values)}`);
    assert.ok(scale.span > 0, `span > 0 para ${JSON.stringify(values)} (veio ${scale.span})`);
    assert.equal(scale.span, scale.max - scale.min);
    assert.ok(scale.max > scale.min);
    assert.ok(scale.ticks.length >= 2);
  }
});

test('computeScale: min/max forçados invertidos não geram span negativo', () => {
  const scale = cu.computeScale([10, 20], { min: 90, max: 10 });
  assert.ok(scale.span > 0, `span > 0 mesmo com min > max (veio ${scale.span})`);
  assert.ok(scale.max > scale.min);
});

test('computeScale: valores negativos entram na escala (não somem grampeados no zero)', () => {
  const scale = cu.computeScale([-42, -7, -3]);
  assert.ok(scale.min <= -42, `min (${scale.min}) precisa cobrir o -42`);
  assert.ok(scale.max >= 0, 'com includeZero o topo é pelo menos 0');
  // o menor valor não pode cair fora do plot
  const y = cu.projectY(-42, scale, 100);
  assert.ok(y >= 0 && y <= 100, `y dentro do plot (veio ${y})`);
});

test('computeScale: eixo percentual fixo 0..100 é respeitado', () => {
  const scale = cu.computeScale([12, 88], { min: 0, max: 100 });
  assert.equal(scale.min, 0);
  assert.equal(scale.max, 100);
  assert.equal(cu.projectY(0, scale, 200), 200);
  assert.equal(cu.projectY(100, scale, 200), 0);
  assert.equal(cu.projectY(50, scale, 200), 100);
});

test('computeScale: eixo inteiro não gera marca fracionária de câmera', () => {
  const scale = cu.computeScale([0, 1], { integer: true });
  for (const tick of scale.ticks) assert.equal(Number.isInteger(tick), true, `tick inteiro (veio ${tick})`);
  assert.ok(scale.step >= 1);
});

// MUTAÇÃO #2 (divisão por zero na escala): com série constante o span vira 0 se
// o guarda de computeScale for removido, e projectY passa a devolver NaN — o
// path do SVG vira "M0,NaN" e o gráfico some sem erro no console.
test('projectY: série constante/degenerada nunca devolve NaN (divisão por zero)', () => {
  const flat = cu.computeScale([5, 5, 5]);
  for (const value of [0, 5, 10, -3]) {
    const y = cu.projectY(value, flat, 120);
    assert.equal(Number.isFinite(y), true, `y finito para ${value} (veio ${y})`);
    assert.ok(y >= 0 && y <= 120, `y grampeado no plot (veio ${y})`);
  }
  // e mesmo se alguém passar uma escala corrompida (span 0/NaN), não vaza NaN
  for (const broken of [{ min: 0, max: 0, span: 0 }, { min: 0, max: 1, span: NaN }, null]) {
    const y = cu.projectY(1, broken, 120);
    assert.equal(Number.isFinite(y), true, `y finito com escala ${JSON.stringify(broken)}`);
  }
});

test('buildLinePath/buildAreaPath: nenhum path contém NaN, nem com série constante ou furada', () => {
  const points = [
    { t: '2026-07-27T00:00:00.000Z', v: 5 },
    { t: '2026-07-27T00:05:00.000Z', v: 5 },
    { t: '2026-07-27T00:10:00.000Z' }, // buraco: sem valor
    { t: '2026-07-27T00:15:00.000Z', v: 5 },
  ];
  const scale = cu.computeScale(points.map((p) => p.v));
  const geometry = { width: 600, height: 160 };
  const line = cu.buildLinePath(points, 'v', geometry, scale);
  const area = cu.buildAreaPath(points, 'v', geometry, scale);
  assert.ok(line.startsWith('M'));
  assert.equal(/NaN|Infinity|undefined/.test(line), false, `linha sem NaN (veio ${line})`);
  assert.equal(/NaN|Infinity|undefined/.test(area), false, `área sem NaN (veio ${area})`);
  assert.ok(area.endsWith('Z'));
  // o buraco é pulado: 3 comandos, não 4
  assert.equal(line.split(' ').length, 3);
  assert.equal(cu.buildLinePath([], 'v', geometry, scale), '');
  assert.equal(cu.buildAreaPath([], 'v', geometry, scale), '');
});

test('projectX: ponto único fica no meio e o último ponto encosta na borda', () => {
  assert.equal(cu.projectX(0, 1, 600), 300);
  assert.equal(cu.projectX(0, 5, 600), 0);
  assert.equal(cu.projectX(4, 5, 600), 600);
  assert.equal(cu.projectX(99, 5, 600), 600); // índice fora da série grampeia
  assert.equal(Number.isFinite(cu.projectX(0, 0, 600)), true);
});

// ── Downsampling ────────────────────────────────────────────────────────────

// MUTAÇÃO #1 (downsampling que perde o pico): trocar a seleção min/max por
// "pega o primeiro do balde" (ou por média) apaga exatamente o pico de 999 e o
// vale de 0 — que é o único motivo de olhar o gráfico numa central de operação.
test('downsamplePoints: reduz 2880 pontos preservando o pico e o vale de cada série', () => {
  const points = [];
  for (let index = 0; index < 2880; index += 1) {
    points.push({ t: new Date(Date.UTC(2026, 6, 27, 0, 0, 0) + index * 30000).toISOString(), ts: index, cameras: 10, disk: 50 });
  }
  points[1234].cameras = 999; // pico isolado no meio de um balde
  points[2001].cameras = 0;   // vale isolado
  points[77].disk = 97;       // pico de outra série, em outro balde

  const reduced = cu.downsamplePoints(points, 120, ['cameras', 'disk']);

  assert.ok(reduced.length <= 122, `orçamento respeitado (veio ${reduced.length})`);
  assert.ok(reduced.length >= 8, `ainda tem forma (veio ${reduced.length})`);
  assert.equal(Math.max(...reduced.map((p) => p.cameras)), 999, 'o pico de câmeras sobreviveu');
  assert.equal(Math.min(...reduced.map((p) => p.cameras)), 0, 'o vale de câmeras sobreviveu');
  assert.equal(Math.max(...reduced.map((p) => p.disk)), 97, 'o pico de disco sobreviveu');
  assert.equal(reduced[0], points[0], 'primeiro ponto preservado');
  assert.equal(reduced[reduced.length - 1], points[points.length - 1], 'último ponto preservado');
  // ordem cronológica mantida
  for (let index = 1; index < reduced.length; index += 1) {
    assert.ok(reduced[index].ts > reduced[index - 1].ts, 'pontos em ordem, sem repetição');
  }
});

test('downsamplePoints: pico na PRIMEIRA e na ÚLTIMA janela também sobrevive', () => {
  const points = Array.from({ length: 500 }, (_, index) => ({ ts: index, v: 1 }));
  points[3].v = 500;
  points[498].v = -500;
  const reduced = cu.downsamplePoints(points, 40, ['v']);
  assert.equal(Math.max(...reduced.map((p) => p.v)), 500);
  assert.equal(Math.min(...reduced.map((p) => p.v)), -500);
});

test('downsamplePoints: série curta volta intacta e entrada inválida não quebra', () => {
  const points = [{ ts: 1, v: 1 }, { ts: 2, v: 2 }];
  const reduced = cu.downsamplePoints(points, 120, ['v']);
  assert.deepEqual(reduced, points);
  assert.notEqual(reduced, points, 'devolve cópia, não a mesma referência');
  assert.deepEqual(cu.downsamplePoints(null, 120, ['v']), []);
  assert.deepEqual(cu.downsamplePoints([{ ts: 1 }, null, undefined], 120, ['v']), [{ ts: 1 }]);
  // maxPoints absurdo não trava nem devolve vazio
  const tiny = cu.downsamplePoints(Array.from({ length: 50 }, (_, i) => ({ ts: i, v: i })), 0, ['v']);
  assert.ok(tiny.length >= 2 && tiny.length <= 50);
});

test('downsamplePoints: sem chaves informadas ainda reduz e mantém as pontas', () => {
  const points = Array.from({ length: 600 }, (_, index) => ({ ts: index }));
  const reduced = cu.downsamplePoints(points, 60, []);
  assert.ok(reduced.length <= 62);
  assert.equal(reduced[0].ts, 0);
  assert.equal(reduced[reduced.length - 1].ts, 599);
});

// ── Série temporal / eixo de tempo ──────────────────────────────────────────

test('normalizeSeries: aceita array cru ou embrulhado, ordena e descarta lixo', () => {
  const wrapped = {
    points: [
      { t: '2026-07-27T02:00:00.000Z', cameras: 4 },
      { t: '2026-07-27T01:00:00.000Z', cameras: '7' },
      { t: 'não-é-data', cameras: 9 },
      null,
      { cameras: 3 },
    ],
  };
  const series = cu.normalizeSeries(wrapped);
  assert.equal(series.length, 2, 'ponto sem tempo válido é descartado');
  assert.equal(series[0].t, '2026-07-27T01:00:00.000Z', 'ordenado por tempo');
  assert.equal(series[0].cameras, 7, 'string numérica vira número');
  assert.equal(series[1].cameras, 4);
  assert.deepEqual(cu.normalizeSeries(null), []);
  assert.deepEqual(cu.normalizeSeries({ error: 'not_found' }), []);
});

test('normalizeSeries: campo de texto do servidor NÃO entra no modelo do gráfico', () => {
  const series = cu.normalizeSeries([{ t: '2026-07-27T01:00:00.000Z', cameras: 2, label: '<img src=x onerror=alert(1)>' }]);
  assert.equal(series.length, 1);
  assert.equal(series[0].cameras, 2);
  assert.equal('label' in series[0], false, 'valor não numérico é descartado antes de chegar no DOM');
});

test('normalizeSeries: métrica null é DESCONHECIDA, nunca zero (contrato do backend)', () => {
  // pointsFromHeartbeatHistory manda camerasStalled/alertsCritical como null
  // quando a fonte não sabe. Number(null) é 0 — deixar passar plotaria mentira.
  const series = cu.normalizeSeries([
    { t: '2026-07-27T00:00:00.000Z', camerasOnline: 4, camerasStalled: null, alertsCritical: null, diskUsagePercent: 0 },
  ]);
  assert.equal(series[0].camerasOnline, 4);
  assert.equal('camerasStalled' in series[0], false, 'null não vira 0');
  assert.equal('alertsCritical' in series[0], false);
  assert.equal(series[0].diskUsagePercent, 0, 'zero de verdade continua zero');
  // e a série inteira em null não é oferecida na legenda
  assert.equal(cu.resolveSeriesKey(series, ['camerasStalled']), null);
  assert.equal(cu.resolveSeriesKey(series, ['diskUsagePercent']), 'diskUsagePercent');
});

test('normalizeSeries: ponto da frota com min/max aninhados não quebra nem vira número', () => {
  // foldFleetRows devolve `min` e `max` como OBJETOS junto das métricas planas.
  const series = cu.normalizeSeries({
    points: [{ t: '2026-07-27T00:00:00.000Z', installations: 3, samples: 12, camerasOnline: 30, min: { camerasOnline: 8 }, max: { camerasOnline: 12 } }],
  });
  assert.equal(series.length, 1);
  assert.equal(series[0].camerasOnline, 30);
  assert.equal('min' in series[0], false, 'objeto aninhado é descartado, não vira NaN');
  assert.equal('max' in series[0], false);
});

test('normalizeSeries: epoch em segundos e em milissegundos viram o mesmo instante', () => {
  const seconds = cu.normalizeSeries([{ t: 1785000000, v: 1 }]);
  const millis = cu.normalizeSeries([{ t: 1785000000000, v: 1 }]);
  assert.equal(seconds[0].t, millis[0].t);
});

test('resolveSeriesKey: encontra o alias realmente presente e devolve null quando não há', () => {
  const points = [{ t: 'x', ts: 1 }, { t: 'y', ts: 2, camerasOnline: 3 }];
  assert.equal(cu.resolveSeriesKey(points, ['cameraOnline', 'camerasOnline']), 'camerasOnline');
  assert.equal(cu.resolveSeriesKey(points, ['naoExiste']), null);
  assert.equal(cu.resolveSeriesKey([], ['camerasOnline']), null);
  assert.equal(cu.resolveSeriesKey(null, null), null);
});

test('formatAxisTime: granularidade segue a JANELA (hora, dia+hora, dia)', () => {
  const at = '2026-07-27T14:05:00.000Z';
  assert.equal(cu.formatAxisTime(at, { utc: true, spanMs: 6 * 60 * 60 * 1000 }), '14:05');
  assert.equal(cu.formatAxisTime(at, { utc: true, spanMs: 48 * 60 * 60 * 1000 }), '27/07 14:05');
  assert.equal(cu.formatAxisTime(at, { utc: true, spanMs: 30 * 24 * 60 * 60 * 1000 }), '27/07');
  assert.equal(cu.formatAxisTime(at, { utc: true, dateOnly: true }), '27/07');
  assert.equal(cu.formatAxisTime('lixo', { utc: true }), '');
  assert.equal(cu.formatAxisTime(null, { utc: true }), '');
  // zero-padding de verdade (01/02, não 1/2)
  assert.equal(cu.formatAxisTime('2026-02-01T03:04:00.000Z', { utc: true, spanMs: 8 * 24 * 60 * 60 * 1000 }), '01/02');
  assert.equal(cu.formatAxisTime('2026-02-01T03:04:00.000Z', { utc: true }), '03:04');
});

test('timeAxisTicks: marcas distribuídas, sem repetir índice, com rótulo da janela', () => {
  const points = cu.normalizeSeries(
    Array.from({ length: 25 }, (_, index) => ({ t: new Date(Date.UTC(2026, 6, 27, index)).toISOString(), v: index })),
  );
  const ticks = cu.timeAxisTicks(points, 5, { utc: true });
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0].index, 0);
  assert.equal(ticks[ticks.length - 1].index, points.length - 1);
  assert.equal(ticks[0].ratio, 0);
  assert.equal(ticks[ticks.length - 1].ratio, 1);
  // janela de 24h → dia + hora
  assert.equal(ticks[0].label, '27/07 00:00');
  const indexes = ticks.map((tick) => tick.index);
  assert.deepEqual(indexes, [...new Set(indexes)].sort((a, b) => a - b), 'sem índice repetido e em ordem');
  assert.deepEqual(cu.timeAxisTicks([], 5), []);
  assert.equal(cu.timeAxisTicks([{ ts: 1, t: '2026-07-27T00:00:00.000Z' }], 5, { utc: true }).length, 1);
});

// ── Agregação dos totais da frota ───────────────────────────────────────────

function installation(overrides = {}) {
  return { id: 'x', status: 'ONLINE', metrics: {}, ...overrides };
}

test('aggregateFleetTotals: soma a frota lendo métrica aninhada e plana', () => {
  const items = [
    installation({ id: 'a', status: 'ONLINE', metrics: { cameras: { total: 10, online: 8, offline: 1, error: 1 }, disk: { usagePercent: 44 }, activeRecordingCount: 8 } }),
    installation({ id: 'b', status: 'OFFLINE', metrics: { cameraTotal: 4, cameraOnline: 0, cameraOffline: 4, diskUsagePercent: 91, activeRecordingCount: 0 } }),
    installation({ id: 'c', status: 'PENDING_INSTALL', metrics: {} }),
  ];
  const totals = cu.aggregateFleetTotals(items);
  assert.equal(totals.installations, 3);
  assert.equal(totals.online, 1);
  assert.equal(totals.offline, 1);
  assert.equal(totals.pending, 1, 'provisionada e nunca vista NÃO conta como queda');
  assert.equal(totals.cameraTotal, 14);
  assert.equal(totals.cameraOnline, 8);
  assert.equal(totals.cameraIssues, 6, 'offline + error de toda a frota');
  assert.equal(totals.recordingActive, 8);
  assert.equal(totals.maxDiskUsagePercent, 91);
});

test('aggregateFleetTotals: câmera contada no agregado E no bloco detalhado não é somada duas vezes', () => {
  const item = installation({
    metrics: { cameraTotal: 4, cameraOnline: 0, cameraOffline: 4 },
    cameras: [{ cameraId: 'c1', name: 'Fundos', status: 'offline', recording: { desired: true, active: false } }],
  });
  const totals = cu.aggregateFleetTotals([item]);
  assert.equal(totals.cameraIssues, 4, 'contador agregado do heartbeat');
  assert.equal(totals.camerasProblem, 1, 'bloco detalhado do heartbeat');
  assert.equal(totals.camerasAttention, 4, 'o cartão usa o MAIOR dos dois, não a soma (seriam 5)');
  // e quando o bloco detalhado é mais rico que o contador, ele que manda
  const richer = cu.aggregateFleetTotals([
    installation({
      metrics: { cameraTotal: 3, cameraOnline: 3, cameraOffline: 0 },
      cameras: [
        { cameraId: 'a', name: 'A', recording: { stalled: true } },
        { cameraId: 'b', name: 'B', recording: { stalled: true } },
      ],
    }),
  ]);
  assert.equal(richer.cameraIssues, 0, 'travada não aparece como offline no agregado');
  assert.equal(richer.camerasAttention, 2, 'as duas travadas aparecem no cartão');
});

test('aggregateFleetTotals: status desconhecido conta como offline, nunca como online', () => {
  const totals = cu.aggregateFleetTotals([
    installation({ status: 'DEGRADED' }),
    installation({ status: '' }),
    installation({ status: undefined }),
  ]);
  assert.equal(totals.online, 0);
  assert.equal(totals.pending, 0);
  assert.equal(totals.offline, 3);
});

test('aggregateFleetTotals: métrica com texto do cliente não contamina o total', () => {
  const totals = cu.aggregateFleetTotals([
    installation({ metrics: { cameraTotal: '12', cameraOnline: '<script>', diskUsagePercent: 'NaN', activeRecordingCount: Infinity } }),
    installation({ metrics: { cameraTotal: 3, cameraOnline: 3, diskUsagePercent: 10, activeRecordingCount: 3 } }),
  ]);
  assert.equal(totals.cameraTotal, 15, 'string numérica soma; string de ataque vira 0');
  assert.equal(totals.cameraOnline, 3);
  assert.equal(totals.maxDiskUsagePercent, 10);
  assert.equal(totals.recordingActive, 3, 'Infinity não vira total infinito');
  assert.equal(Number.isFinite(totals.recordingActive), true);
});

test('aggregateFleetTotals: entrada vazia/inválida devolve zeros, não explode', () => {
  for (const input of [[], null, undefined, 'lixo', [null, undefined, 42]]) {
    const totals = cu.aggregateFleetTotals(input);
    assert.equal(Number.isFinite(totals.cameraTotal), true);
    assert.equal(totals.cameraTotal, 0);
    assert.equal(totals.maxDiskUsagePercent, 0);
  }
});

test('metricNumber: mesma cadeia de fallback do metric() do painel, mas numérica', () => {
  const item = installation({ metrics: { cameras: { total: 9, online: 7, offline: 1, error: 1 }, disk: { usagePercent: 33 }, recording: { active: 5, attention: 2 } } });
  assert.equal(cu.metricNumber(item, 'cameraTotal'), 9);
  assert.equal(cu.metricNumber(item, 'cameraOnline'), 7);
  assert.equal(cu.metricNumber(item, 'cameraOffline'), 1);
  assert.equal(cu.metricNumber(item, 'cameraError'), 1);
  assert.equal(cu.metricNumber(item, 'diskUsagePercent'), 33);
  assert.equal(cu.metricNumber(item, 'activeRecordingCount'), 5);
  assert.equal(cu.metricNumber(item, 'recordingAttentionCameras'), 2);
  // o campo plano tem prioridade sobre o aninhado (igual ao metric() do painel)
  const flat = installation({ metrics: { cameraTotal: 2, cameras: { total: 9 } } });
  assert.equal(cu.metricNumber(flat, 'cameraTotal'), 2);
  // chave desconhecida e item vazio caem no fallback
  assert.equal(cu.metricNumber(item, 'naoExiste', 7), 7);
  assert.equal(cu.metricNumber(null, 'cameraTotal', 0), 0);
  assert.equal(cu.metricNumber({}, 'cameraTotal', 0), 0);
});

test('metricNumber: bloco cameras em ARRAY (novo heartbeat) não quebra a contagem antiga', () => {
  const item = installation({ metrics: { cameras: [{ cameraId: '1' }, { cameraId: '2' }] } });
  assert.equal(cu.metricNumber(item, 'cameraTotal', 0), 0, 'sem .total não inventa número');
  assert.equal(Number.isFinite(cu.metricNumber(item, 'cameraOnline', 0)), true);
});

// ── Câmeras com problema ────────────────────────────────────────────────────

test('selectProblemCameras: pega travada/offline/desativada e ignora a saudável', () => {
  const item = installation({
    cameras: [
      { cameraId: 'ok', name: 'Portaria', status: 'online', enabled: true, recording: { desired: true, active: true, stalled: false } },
      { cameraId: 'trava', name: 'Garagem', status: 'online', enabled: true, recording: { desired: true, active: true, stalled: true, secondsSinceLastSegment: 900, restartsLastHour: 3 } },
      { cameraId: 'off', name: 'Fundos', status: 'offline', enabled: true, recording: { desired: true, active: false } },
      { cameraId: 'desl', name: 'Depósito', status: 'online', enabled: false, recording: { desired: false, active: false } },
    ],
  });
  const problems = cu.selectProblemCameras(item);
  assert.deepEqual(problems.map((camera) => camera.id), ['trava', 'off', 'desl'], 'travada primeiro, saudável fora');
  assert.deepEqual(problems[0].reasons, ['recording_stalled']);
  assert.equal(problems[0].secondsSinceLastSegment, 900);
  assert.equal(problems[0].restartsLastHour, 3);
  assert.ok(problems[1].reasons.includes('offline'));
  assert.ok(problems[1].reasons.includes('recording_inactive'));
  assert.deepEqual(problems[2].reasons, ['disabled']);
});

test('selectProblemCameras: lê a saída REAL de timeseries.parseCameraHealth (campos planos)', () => {
  // Formato que /api/admin/installations/:id/timeseries devolve em `cameras`.
  const cameras = [
    { cameraId: 'a', name: 'Portaria', enabled: true, status: 'ONLINE', recordingDesired: true, recordingActive: true, recordingStalled: false, secondsSinceLastSegment: 12, restartsLastHour: 0 },
    { cameraId: 'b', name: 'Garagem', enabled: true, status: 'ONLINE', recordingDesired: true, recordingActive: true, recordingStalled: true, secondsSinceLastSegment: 1800, restartsLastHour: 4 },
    { cameraId: 'c', name: 'Fundos', enabled: true, status: 'OFFLINE', recordingDesired: true, recordingActive: false, recordingStalled: null, secondsSinceLastSegment: null, restartsLastHour: null },
    { cameraId: 'd', name: 'Depósito', enabled: false, status: 'ONLINE', recordingDesired: false, recordingActive: false, recordingStalled: null },
  ];
  // aceita o array cru da resposta, sem precisar embrulhar
  const problems = cu.selectProblemCameras(cameras);
  assert.deepEqual(problems.map((camera) => camera.id), ['b', 'c', 'd']);
  assert.deepEqual(problems[0].reasons, ['recording_stalled']);
  assert.equal(problems[0].secondsSinceLastSegment, 1800);
  assert.equal(problems[0].restartsLastHour, 4);
  assert.deepEqual(problems[1].reasons, ['offline', 'recording_inactive']);
  assert.equal(problems[1].secondsSinceLastSegment, null, 'null continua null, não vira 0');
  assert.equal(problems[1].restartsLastHour, 0);
  assert.deepEqual(problems[2].reasons, ['disabled']);
  // status em MAIÚSCULA (vem do enum do banco) é reconhecido igual
  assert.equal(cu.selectProblemCameras([{ cameraId: 'x', status: 'ERROR' }])[0].reasons[0], 'error');
});

test('selectProblemCameras: aceita o bloco no heartbeat (metrics.cameras.items) e campo plano stalled', () => {
  const item = installation({ metrics: { cameras: { total: 2, online: 1, items: [{ id: 'c1', name: 'A', stalled: true }] } } });
  const problems = cu.selectProblemCameras(item);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].id, 'c1');
  assert.deepEqual(problems[0].reasons, ['recording_stalled']);
});

test('selectProblemCameras: sem bloco de câmeras devolve lista vazia (degradação silenciosa)', () => {
  assert.deepEqual(cu.selectProblemCameras(installation({ metrics: { cameras: { total: 5, online: 5 } } })), []);
  assert.deepEqual(cu.selectProblemCameras(installation()), []);
  assert.deepEqual(cu.selectProblemCameras(null), []);
  assert.deepEqual(cu.selectProblemCameras({ cameras: [null, 'lixo', 42] }), []);
});

test('selectProblemCameras: limite corta a lista mantendo as mais graves', () => {
  const cameras = [
    { id: 'd', name: 'D', enabled: false },
    { id: 'a', name: 'A', stalled: true },
    { id: 'b', name: 'B', status: 'error' },
  ];
  const problems = cu.selectProblemCameras({ cameras }, { limit: 2 });
  assert.deepEqual(problems.map((camera) => camera.id), ['a', 'b']);
});

test('selectProblemCameras: nome hostil é devolvido CRU (quem renderiza escapa)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const problems = cu.selectProblemCameras({ cameras: [{ id: '1', name: evil, stalled: true }] });
  assert.equal(problems[0].name, evil, 'o módulo não produz HTML — a defesa é o escapeHtml do painel');
});

// ── Contrato com o painel ───────────────────────────────────────────────────

test('index.html carrega o chart-utils e degrada se o arquivo não vier', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  assert.match(html, /<script src="chart-utils\.js"><\/script>/, 'o painel precisa carregar o módulo');
  assert.match(html, /window\.DracChartUtils/, 'e precisa checar a presença dele antes de usar');
  // caminho RELATIVO: a Central também é servida sob /central/ pelo nginx do web
  assert.equal(html.includes('src="/chart-utils.js"'), false, 'caminho absoluto quebraria sob /central/');
});

test('escapeHtml do painel continua neutralizando os cinco metacaracteres', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const source = html.match(/function escapeHtml\(value\) \{[\s\S]*?\n {6}\}/);
  assert.ok(source, 'escapeHtml precisa continuar existindo');
  // eslint-disable-next-line no-new-func
  const escapeHtml = new Function(`${source[0]}; return escapeHtml;`)();
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml("';alert(1);//"), '&#039;;alert(1);//');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml(null), '');
});
