'use strict';

// Série temporal da frota — LÓGICA PURA (sem I/O, sem pg). É o núcleo do
// "histórico real" do painel mestre.
//
// Por que existe: o heartbeat chega a cada ~60s e o armazenamento atual é UM
// arquivo JSON (já em centenas de KB, e que já corrompeu e derrubou a Central).
// Série temporal a 60s NÃO cabe lá: 1 instalação = 1.440 amostras/dia. Então o
// histórico longo vive no POSTGRES (tabelas próprias) e, quando não há Postgres
// configurado (o DEFAULT), NADA disso liga — a Central segue exatamente como
// hoje, com as ~100 últimas amostras no JSON.
//
// Invariantes deste módulo:
//   • RETENÇÃO NÃO PERDE DADO EM SILÊNCIO: toda amostra podada vira parte de um
//     agregado horário (min/avg/max/count). `planRetention` devolve
//     kept + pruned + invalid == entrada, e a soma de `samples` dos buckets é
//     EXATAMENTE o número de amostras podadas.
//   • Agregado é ASSOCIATIVO: `mergeAggregate` combina dois agregados do mesmo
//     bucket com média PONDERADA por contagem (rollups parciais de uma mesma
//     hora, em passadas diferentes, dão o mesmo resultado de uma passada só).
//   • Contadores (câmeras/gravações/alertas) SOMAM na visão de frota; percentual
//     de disco NÃO soma — é média entre instalações (e o pico vai em `max`).

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Métricas agregadas do heartbeat que viram série temporal.
const METRIC_KEYS = Object.freeze([
  'camerasTotal',
  'camerasOnline',
  'camerasOffline',
  'camerasError',
  'camerasStalled',
  'recordingsActive',
  'diskUsagePercent',
  'alertsCritical',
]);

// Percentuais/razões: na frota viram MÉDIA entre instalações, nunca soma.
const AVERAGED_KEYS = new Set(['diskUsagePercent']);

const DEFAULT_RAW_RETENTION_HOURS = 48;
const DEFAULT_HOURLY_RETENTION_DAYS = 90;
const DEFAULT_RANGE_HOURS = 24;
const MAX_RANGE_DAYS = 93;
const MIN_BUCKET_SECONDS = 60;
const MAX_BUCKET_SECONDS = 24 * 3600;

// Níveis de alerta que contam como CRÍTICO no gráfico.
const CRITICAL_ALERT_LEVELS = new Set(['critical', 'crit', 'fatal', 'error', 'danger', 'severe']);

// ── Coerções ────────────────────────────────────────────────────────────────
function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function toIso(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return null;
}

// Arredonda para 2 casas — evita ruído de ponto flutuante virar "12.300000000000001"
// no JSON do gráfico. null continua null (métrica ausente ≠ zero).
function round2(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// Primeiro valor numérico definido da lista (null se nenhum).
function firstNumber(...candidates) {
  for (const candidate of candidates) {
    const n = toNumber(candidate);
    if (n !== null) return n;
  }
  return null;
}

// ── Saúde por câmera (bloco OPCIONAL do heartbeat) ──────────────────────────
// A API passará a mandar o relatório de observabilidade por câmera
// (CameraObservabilityService.getReport()). Aqui tratamos como OPCIONAL: se vier,
// normalizamos; se não vier (ou vier lixo), devolvemos [] SEM erro. Aceita o array
// direto, o relatório inteiro ({ cameras: [...] }) ou { items: [...] }.
function parseCameraHealth(block) {
  let list = null;
  if (Array.isArray(block)) list = block;
  else if (block && typeof block === 'object') {
    if (Array.isArray(block.cameras)) list = block.cameras;
    else if (Array.isArray(block.items)) list = block.items;
  }
  if (!list) return [];

  // IDEMPOTENTE: aceita tanto o formato do relatório (recording.stalled) quanto a
  // saída JÁ normalizada deste mesmo função (recordingStalled). Sem isso, normalizar
  // duas vezes — algo que acontece de verdade quando a rota normaliza e o store
  // normaliza de novo — ZERAVA todos os campos aninhados.
  const pick = (nested, flat) => (nested === undefined || nested === null ? flat : nested);
  // Último registro do mesmo cameraId vence (é o estado ATUAL).
  const byId = new Map();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const cameraId = String(raw.cameraId ?? raw.id ?? '').trim();
    if (!cameraId) continue;
    const recording = raw.recording && typeof raw.recording === 'object' ? raw.recording : {};
    const stream = raw.stream && typeof raw.stream === 'object' ? raw.stream : {};
    byId.set(cameraId, {
      cameraId,
      name: raw.name === null || raw.name === undefined ? null : String(raw.name),
      enabled: toBool(raw.enabled),
      status: raw.status === null || raw.status === undefined ? null : String(raw.status),
      recordingDesired: toBool(pick(recording.desired, raw.recordingDesired)),
      recordingActive: toBool(pick(recording.active, raw.recordingActive)),
      recordingStalled: toBool(pick(recording.stalled, raw.recordingStalled)),
      lastSegmentAt: toIso(pick(recording.lastSegmentAt, raw.lastSegmentAt)),
      secondsSinceLastSegment: toNumber(pick(recording.secondsSinceLastSegment, raw.secondsSinceLastSegment)),
      segmentsLastHour: toNumber(pick(recording.segmentsLastHour, raw.segmentsLastHour)),
      restartsLastHour: toNumber(pick(recording.restartsLastHour, raw.restartsLastHour)),
      streamRecoveriesLastHour: toNumber(pick(stream.recoveriesLastHour, raw.streamRecoveriesLastHour)),
      lastRecoveryAt: toIso(pick(stream.lastRecoveryAt, raw.lastRecoveryAt)),
    });
  }
  return [...byId.values()];
}

// Totais do bloco `cameras` da instalação. São da FROTA INTEIRA e NÃO encolhem
// quando a lista é truncada (a instalação corta por gravidade e informa quantas
// ficaram de fora em `omitted`). Por isso os totais VENCEM a contagem da lista:
// numa instalação de 400 câmeras, contar a lista truncada MENTIRIA para menos.
function parseCameraTotals(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const totals = block.totals && typeof block.totals === 'object' ? block.totals : null;
  if (!totals) return null;
  return {
    cameras: toNumber(totals.cameras),
    recordingActive: toNumber(totals.recordingActive),
    stalled: toNumber(totals.stalled),
    offline: toNumber(totals.offline),
  };
}

function countCriticalAlerts(alerts) {
  if (!Array.isArray(alerts)) return 0;
  let total = 0;
  for (const alert of alerts) {
    const level = String(alert?.level || '').trim().toLowerCase();
    if (CRITICAL_ALERT_LEVELS.has(level)) total += 1;
  }
  return total;
}

// ── Amostra ─────────────────────────────────────────────────────────────────
// Lê o MESMO formato que o handleHeartbeat já entende (metrics.cameraTotal OU
// metrics.cameras.total, metrics.diskUsagePercent OU metrics.disk.usagePercent),
// para a série temporal contar exatamente a mesma história do painel atual.
// O bloco `cameras` (opcional) só preenche o que as métricas não trouxeram.
function buildSample(input = {}) {
  const metrics = input.metrics && typeof input.metrics === 'object' ? input.metrics : {};
  const counts = metrics.cameras && typeof metrics.cameras === 'object' && !Array.isArray(metrics.cameras)
    ? metrics.cameras
    : {};
  const cameras = Array.isArray(input.cameraHealth) ? input.cameraHealth : parseCameraHealth(input.cameras);
  const hasCameraBlock = cameras.length > 0;
  // Totais declarados pela instalação (frota inteira) — precedem a contagem da
  // lista, que pode vir TRUNCADA por gravidade.
  const totals = parseCameraTotals(input.cameraTotals) || parseCameraTotals(input.cameras) || {};

  const derived = {
    total: hasCameraBlock ? cameras.length : null,
    online: hasCameraBlock ? cameras.filter((c) => String(c.status || '').toUpperCase() === 'ONLINE').length : null,
    stalled: hasCameraBlock ? cameras.filter((c) => c.recordingStalled === true).length : null,
    recording: hasCameraBlock ? cameras.filter((c) => c.recordingActive === true).length : null,
  };

  const storageDisk = input.storage && typeof input.storage === 'object' ? input.storage.disk : null;

  return {
    t: toIso(input.at) || new Date().toISOString(),
    camerasTotal: firstNumber(metrics.cameraTotal, counts.total, totals.cameras, derived.total) ?? 0,
    camerasOnline: firstNumber(metrics.cameraOnline, counts.online, derived.online) ?? 0,
    camerasOffline: firstNumber(metrics.cameraOffline, counts.offline, totals.offline) ?? 0,
    camerasError: firstNumber(metrics.cameraError, counts.error) ?? 0,
    camerasStalled: firstNumber(metrics.camerasStalled, counts.stalled, totals.stalled, derived.stalled) ?? 0,
    recordingsActive: firstNumber(metrics.activeRecordingCount, totals.recordingActive, derived.recording) ?? 0,
    // Disco pode legitimamente não vir: null (desconhecido) ≠ 0 (disco vazio).
    diskUsagePercent: firstNumber(
      metrics.diskUsagePercent,
      metrics.disk && typeof metrics.disk === 'object' ? metrics.disk.usagePercent : null,
      storageDisk && typeof storageDisk === 'object' ? storageDisk.usagePercent : null,
    ),
    alertsCritical: countCriticalAlerts(
      Array.isArray(input.alerts) ? input.alerts : Array.isArray(metrics.alerts) ? metrics.alerts : [],
    ),
  };
}

// ── Buckets e agregação ─────────────────────────────────────────────────────
function bucketStartMs(ms, bucketSeconds = 3600) {
  const size = Math.max(1, Math.floor(Number(bucketSeconds) || 3600)) * 1000;
  return Math.floor(ms / size) * size;
}

function hourBucket(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(bucketStartMs(ms, 3600)).toISOString();
}

// Agrega uma lista de amostras em { samples, stats: { chave: {min,avg,max,count} } }.
// `count` é POR MÉTRICA (uma amostra sem disco não conta no disco) — é o que torna
// o merge ponderado correto.
function aggregateSamples(samples) {
  const acc = {};
  let total = 0;
  for (const sample of samples || []) {
    if (!sample || typeof sample !== 'object') continue;
    total += 1;
    for (const key of METRIC_KEYS) {
      const value = toNumber(sample[key]);
      if (value === null) continue;
      const current = acc[key];
      if (!current) acc[key] = { min: value, max: value, sum: value, count: 1 };
      else {
        if (value < current.min) current.min = value;
        if (value > current.max) current.max = value;
        current.sum += value;
        current.count += 1;
      }
    }
  }
  const stats = {};
  for (const [key, value] of Object.entries(acc)) {
    stats[key] = {
      min: round2(value.min),
      avg: round2(value.sum / value.count),
      max: round2(value.max),
      count: value.count,
    };
  }
  return { samples: total, stats };
}

function cloneAggregate(aggregate) {
  const stats = {};
  for (const [key, value] of Object.entries(aggregate?.stats || {})) stats[key] = { ...value };
  return { samples: Number(aggregate?.samples || 0), stats };
}

// Combina dois agregados do MESMO bucket. Média PONDERADA pela contagem de cada
// métrica — média de médias simples MENTIRIA quando os lados têm tamanhos
// diferentes (ex.: rollup parcial de 50 amostras + rollup do resto, 10 amostras).
function mergeAggregate(left, right) {
  if (!left) return cloneAggregate(right);
  if (!right) return cloneAggregate(left);
  const stats = {};
  const keys = new Set([...Object.keys(left.stats || {}), ...Object.keys(right.stats || {})]);
  for (const key of keys) {
    const a = left.stats?.[key];
    const b = right.stats?.[key];
    if (!a) { stats[key] = { ...b }; continue; }
    if (!b) { stats[key] = { ...a }; continue; }
    const count = Number(a.count || 0) + Number(b.count || 0);
    stats[key] = {
      min: Math.min(a.min, b.min),
      max: Math.max(a.max, b.max),
      avg: count > 0 ? round2((a.avg * Number(a.count || 0) + b.avg * Number(b.count || 0)) / count) : round2(a.avg),
      count,
    };
  }
  return { samples: Number(left.samples || 0) + Number(right.samples || 0), stats };
}

// ── Retenção / rollup ───────────────────────────────────────────────────────
// Amostras CRUAS vivem ~48h; o que é mais velho vira agregado POR HORA.
// Função PURA: recebe as amostras, devolve o PLANO (o que fica, o que sai, e os
// buckets horários equivalentes). Quem executa (SQL) é o store.
//
// Contrato anti-perda: kept + pruned + invalid == entrada, e
// sum(buckets[].samples) == pruned.length.
function planRetention(samples, options = {}) {
  const nowMs = toMs(options.now) ?? Date.now();
  const hoursRaw = toNumber(options.rawRetentionHours);
  const hours = hoursRaw !== null && hoursRaw >= 0 ? hoursRaw : DEFAULT_RAW_RETENTION_HOURS;
  const cutoffMs = nowMs - hours * HOUR_MS;

  const kept = [];
  const pruned = [];
  const invalid = [];
  const byBucket = new Map();

  for (const sample of samples || []) {
    const ms = toMs(sample?.t);
    if (ms === null) {
      // Sem timestamp utilizável não dá para agregar NEM podar: devolvemos
      // explicitamente em `invalid` para que ninguém apague achando que agregou.
      invalid.push(sample);
      continue;
    }
    if (ms >= cutoffMs) {
      kept.push(sample);
      continue;
    }
    pruned.push(sample);
    const bucket = new Date(bucketStartMs(ms, 3600)).toISOString();
    const list = byBucket.get(bucket);
    if (list) list.push(sample);
    else byBucket.set(bucket, [sample]);
  }

  const buckets = [...byBucket.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, list]) => ({ bucket, ...aggregateSamples(list) }));

  return { cutoff: new Date(cutoffMs).toISOString(), kept, pruned, invalid, buckets };
}

// Corte da retenção do agregado horário (o rollup também não é eterno).
function hourlyCutoff(options = {}) {
  const nowMs = toMs(options.now) ?? Date.now();
  const daysRaw = toNumber(options.hourlyRetentionDays);
  const days = daysRaw !== null && daysRaw >= 0 ? daysRaw : DEFAULT_HOURLY_RETENTION_DAYS;
  return new Date(nowMs - days * DAY_MS).toISOString();
}

// ── Pontos para o gráfico ───────────────────────────────────────────────────
// Ponto CRU: as chaves são exatamente METRIC_KEYS (mais `t`).
function rawRowToPoint(row) {
  return {
    t: toIso(row.at ?? row.t),
    camerasTotal: toNumber(row.cameras_total ?? row.camerasTotal, 0),
    camerasOnline: toNumber(row.cameras_online ?? row.camerasOnline, 0),
    camerasOffline: toNumber(row.cameras_offline ?? row.camerasOffline, 0),
    camerasError: toNumber(row.cameras_error ?? row.camerasError, 0),
    camerasStalled: toNumber(row.cameras_stalled ?? row.camerasStalled, 0),
    recordingsActive: toNumber(row.recordings_active ?? row.recordingsActive, 0),
    diskUsagePercent: toNumber(row.disk_usage_percent ?? row.diskUsagePercent),
    alertsCritical: toNumber(row.alerts_critical ?? row.alertsCritical, 0),
  };
}

// Ponto HORÁRIO: MESMAS chaves do ponto cru (valor = média da hora) para o gráfico
// não precisar mudar de forma, + `min`/`max`/`samples` para quem quiser a faixa.
function hourlyRowToPoint(row) {
  const stats = row?.stats && typeof row.stats === 'object' ? row.stats : {};
  const point = { t: toIso(row?.bucket ?? row?.t), samples: toNumber(row?.samples, 0), min: {}, max: {} };
  for (const key of METRIC_KEYS) {
    const stat = stats[key];
    point[key] = stat ? round2(stat.avg) : null;
    if (stat) {
      point.min[key] = round2(stat.min);
      point.max[key] = round2(stat.max);
    }
  }
  return point;
}

// Fallback SEM Postgres: o histórico curto que já existe hoje dentro do JSON
// (item.heartbeatHistory). Mesma forma de ponto — o painel desenha igual.
function pointsFromHeartbeatHistory(history, range = {}) {
  const fromMs = toMs(range.from);
  const toMsValue = toMs(range.to);
  const points = [];
  for (const entry of Array.isArray(history) ? history : []) {
    const ms = toMs(entry?.at);
    if (ms === null) continue;
    if (fromMs !== null && ms < fromMs) continue;
    if (toMsValue !== null && ms > toMsValue) continue;
    points.push({
      t: new Date(ms).toISOString(),
      camerasTotal: toNumber(entry.cameraTotal, 0),
      camerasOnline: toNumber(entry.cameraOnline, 0),
      camerasOffline: toNumber(entry.cameraOffline, 0),
      camerasError: toNumber(entry.cameraError, 0),
      // O histórico curto do JSON nunca teve "estagnadas" nem "alertas críticos":
      // null é HONESTO (desconhecido), 0 seria mentira.
      camerasStalled: null,
      recordingsActive: toNumber(entry.activeRecordingCount, 0),
      diskUsagePercent: toNumber(entry.diskUsagePercent),
      alertsCritical: null,
    });
  }
  return points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

// Converte pontos de UMA instalação em linhas de bucket (mesma forma das linhas
// horárias do Postgres) — assim frota-por-JSON e frota-por-Postgres usam o MESMO
// fold, sem duas verdades.
function toBucketRows(installationId, points, bucketSeconds = 3600) {
  const byBucket = new Map();
  for (const point of points || []) {
    const ms = toMs(point?.t);
    if (ms === null) continue;
    const bucket = new Date(bucketStartMs(ms, bucketSeconds)).toISOString();
    const list = byBucket.get(bucket);
    if (list) list.push(point);
    else byBucket.set(bucket, [point]);
  }
  return [...byBucket.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, list]) => ({ installationId, bucket, ...aggregateSamples(list) }));
}

// Visão de FROTA: por bucket, soma as MÉDIAS de cada instalação (contadores) e
// tira a média entre instalações do percentual de disco (pico vai em `max`).
// Somar amostras cruas direto inflaria instalações que mandam heartbeat mais
// rápido — por isso o fold é sempre sobre o agregado POR INSTALAÇÃO.
function foldFleetRows(rows) {
  const byBucket = new Map();
  for (const row of rows || []) {
    const bucket = toIso(row?.bucket ?? row?.t);
    if (!bucket) continue;
    let entry = byBucket.get(bucket);
    if (!entry) {
      entry = { t: bucket, installations: 0, samples: 0, sums: {}, counts: {}, min: {}, max: {} };
      byBucket.set(bucket, entry);
    }
    entry.installations += 1;
    entry.samples += toNumber(row.samples, 0) || 0;
    for (const key of METRIC_KEYS) {
      const stat = row?.stats?.[key];
      if (!stat) continue;
      const avg = toNumber(stat.avg);
      if (avg === null) continue;
      entry.sums[key] = (entry.sums[key] || 0) + avg;
      entry.counts[key] = (entry.counts[key] || 0) + 1;
      const min = toNumber(stat.min);
      const max = toNumber(stat.max);
      if (min !== null) entry.min[key] = entry.min[key] === undefined ? min : Math.min(entry.min[key], min);
      if (max !== null) entry.max[key] = entry.max[key] === undefined ? max : Math.max(entry.max[key], max);
    }
  }

  return [...byBucket.values()]
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .map((entry) => {
      const point = { t: entry.t, installations: entry.installations, samples: entry.samples, min: {}, max: {} };
      for (const key of METRIC_KEYS) {
        const count = entry.counts[key] || 0;
        if (!count) { point[key] = null; continue; }
        point[key] = AVERAGED_KEYS.has(key) ? round2(entry.sums[key] / count) : round2(entry.sums[key]);
        if (entry.min[key] !== undefined) point.min[key] = round2(entry.min[key]);
        if (entry.max[key] !== undefined) point.max[key] = round2(entry.max[key]);
      }
      return point;
    });
}

// ── Parâmetros de consulta ──────────────────────────────────────────────────
// Nunca lança: entrada inválida vira o intervalo padrão (um gráfico não pode
// derrubar a rota). Janela limitada para não varrer o banco inteiro sem querer.
function resolveRange(query = {}, options = {}) {
  const nowMs = toMs(options.now) ?? Date.now();
  const defaultHours = toNumber(options.defaultHours) ?? DEFAULT_RANGE_HOURS;
  const maxSpanMs = (toNumber(options.maxSpanDays) ?? MAX_RANGE_DAYS) * DAY_MS;

  let toValue = toMs(query.to);
  if (toValue === null) toValue = nowMs;
  let fromValue = toMs(query.from);
  if (fromValue === null) fromValue = toValue - defaultHours * HOUR_MS;
  if (fromValue > toValue) {
    const swap = fromValue;
    fromValue = toValue;
    toValue = swap;
  }
  if (toValue - fromValue > maxSpanMs) fromValue = toValue - maxSpanMs;
  return { from: new Date(fromValue).toISOString(), to: new Date(toValue).toISOString() };
}

// 'raw' enquanto a janela inteira couber na retenção crua; senão 'hour'.
function chooseResolution(range = {}, options = {}) {
  const requested = String(options.requested || '').trim().toLowerCase();
  if (requested === 'raw' || requested === 'hour') return requested;
  const nowMs = toMs(options.now) ?? Date.now();
  const hoursRaw = toNumber(options.rawRetentionHours);
  const hours = hoursRaw !== null && hoursRaw >= 0 ? hoursRaw : DEFAULT_RAW_RETENTION_HOURS;
  const fromMs = toMs(range.from);
  if (fromMs === null) return 'raw';
  return fromMs >= nowMs - hours * HOUR_MS ? 'raw' : 'hour';
}

function normalizeBucketSeconds(value, fallback = 300) {
  const n = toNumber(value);
  if (n === null || n <= 0) return fallback;
  return Math.min(MAX_BUCKET_SECONDS, Math.max(MIN_BUCKET_SECONDS, Math.floor(n)));
}

module.exports = {
  HOUR_MS,
  DAY_MS,
  METRIC_KEYS,
  AVERAGED_KEYS,
  DEFAULT_RAW_RETENTION_HOURS,
  DEFAULT_HOURLY_RETENTION_DAYS,
  DEFAULT_RANGE_HOURS,
  MAX_RANGE_DAYS,
  toNumber,
  toMs,
  toIso,
  round2,
  parseCameraHealth,
  parseCameraTotals,
  countCriticalAlerts,
  buildSample,
  bucketStartMs,
  hourBucket,
  aggregateSamples,
  mergeAggregate,
  planRetention,
  hourlyCutoff,
  rawRowToPoint,
  hourlyRowToPoint,
  pointsFromHeartbeatHistory,
  toBucketRows,
  foldFleetRows,
  resolveRange,
  chooseResolution,
  normalizeBucketSeconds,
};
