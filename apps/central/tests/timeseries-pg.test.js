'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PgStore } = require('../src/datastore/pg-store');
const { TimeseriesStore } = require('../src/datastore/timeseries-store');
const { TABLES } = require('../src/datastore/schema');
const ts = require('../src/datastore/timeseries');
const { startCentral } = require('./helpers/central-server');

const DB_URL = process.env.DRAC_CENTRAL_DATABASE_URL || '';
// Mesmo contrato dos outros testes PG: sem banco configurado, o arquivo inteiro é
// PULADO (não falha). A verificação real roda contra um Postgres efêmero em docker.
const skip = DB_URL ? false : 'defina DRAC_CENTRAL_DATABASE_URL (Postgres efêmero) para rodar';

// O runner roda os ARQUIVOS de teste em paralelo, e `datastore-pg.test.js` dá
// TRUNCATE nas tabelas de documento do mesmo banco. O teste ponta a ponta sobe uma
// Central de verdade que GUARDA a instalação nessas tabelas — então ele precisa de
// um banco SÓ dele, senão vira teste intermitente (a instalação some no meio).
async function createIsolatedDatabase(suffix) {
  const { Pool } = require('pg');
  const name = `drac_ts_e2e_${process.pid}_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const admin = new Pool({ connectionString: DB_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(DB_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const cleanup = new Pool({ connectionString: DB_URL, max: 1 });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } catch { /* banco efêmero; o container morre depois de qualquer forma */ } finally {
        await cleanup.end();
      }
    },
  };
}

async function makeStore(options = {}) {
  const pgStore = new PgStore({ connectionString: DB_URL });
  const store = new TimeseriesStore({ pgStore, ...options });
  await store.init();
  await pgStore._pg().query(`TRUNCATE ${TABLES.samples}, ${TABLES.samplesHourly}, ${TABLES.cameraHealth}`);
  store.close = () => pgStore.close();
  return store;
}

function sample(at, values = {}) {
  return ts.buildSample({
    at,
    metrics: {
      cameraTotal: values.total ?? 10,
      cameraOnline: values.online ?? 10,
      cameraOffline: values.offline ?? 0,
      cameraError: values.error ?? 0,
      camerasStalled: values.stalled ?? 0,
      activeRecordingCount: values.recording ?? 5,
      ...(values.disk === undefined ? {} : { diskUsagePercent: values.disk }),
    },
    alerts: Array.from({ length: values.critical ?? 0 }, () => ({ level: 'critical' })),
  });
}

async function countRows(store, table, installationId) {
  const result = await store._pg().query(`SELECT count(*)::int AS n FROM ${table} WHERE installation_id=$1`, [installationId]);
  return result.rows[0].n;
}

test('PG: heartbeat vira amostra consultável (round-trip da série crua)', { skip }, async () => {
  const store = await makeStore();
  try {
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-27T10:00:00.000Z', { online: 9, offline: 1, disk: 40, critical: 2 }) });
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-27T10:01:00.000Z', { online: 8, offline: 2, disk: 41 }) });
    // Instalação vizinha não pode aparecer na série de cli-a.
    await store.recordHeartbeat('cli-b', { sample: sample('2026-07-27T10:00:30.000Z', { online: 3 }) });

    const points = await store.rawPoints('cli-a', { from: '2026-07-27T09:00:00.000Z', to: '2026-07-27T11:00:00.000Z' });
    assert.equal(points.length, 2);
    assert.deepEqual(points.map((p) => p.t), ['2026-07-27T10:00:00.000Z', '2026-07-27T10:01:00.000Z']);
    assert.equal(points[0].camerasOnline, 9);
    assert.equal(points[0].diskUsagePercent, 40);
    assert.equal(points[0].alertsCritical, 2);
    assert.equal(points[1].camerasOffline, 2);

    // Reenvio do MESMO instante é idempotente (upsert), não duplica o ponto.
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-27T10:00:00.000Z', { online: 7, disk: 40 }) });
    const again = await store.rawPoints('cli-a', { from: '2026-07-27T09:00:00.000Z', to: '2026-07-27T11:00:00.000Z' });
    assert.equal(again.length, 2);
    assert.equal(again[0].camerasOnline, 7);

    // Fora da janela não vem.
    const vazio = await store.rawPoints('cli-a', { from: '2026-07-27T11:00:00.000Z', to: '2026-07-27T12:00:00.000Z' });
    assert.equal(vazio.length, 0);
  } finally {
    await store.close();
  }
});

test('PG: bloco `cameras` opcional — ausente não mexe, presente vira estado exato', { skip }, async () => {
  const store = await makeStore();
  try {
    await store.recordHeartbeat('cli-a', {
      sample: sample('2026-07-27T10:00:00.000Z'),
      cameras: [
        { cameraId: 'cam-1', name: 'Portaria', enabled: true, status: 'ONLINE', recording: { desired: true, active: true, stalled: false, segmentsLastHour: 60 }, stream: { recoveriesLastHour: 1 } },
        { cameraId: 'cam-2', name: 'Fundos', enabled: true, status: 'OFFLINE', recording: { desired: true, active: false, stalled: true, restartsLastHour: 3 }, stream: { recoveriesLastHour: 4 } },
      ],
    });
    let health = await store.cameraHealth('cli-a');
    assert.deepEqual(health.map((c) => c.cameraId), ['cam-1', 'cam-2']);
    assert.equal(health[1].recordingStalled, true);
    assert.equal(health[1].restartsLastHour, 3);
    assert.equal(health[0].at, '2026-07-27T10:00:00.000Z');

    // Heartbeat SEM o bloco: a saúde por câmera permanece (não foi reportada, não é apagada).
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-27T10:01:00.000Z') });
    health = await store.cameraHealth('cli-a');
    assert.equal(health.length, 2, 'sem bloco, o estado anterior sobrevive');

    // Bloco presente com uma câmera a menos: estado EXATO (cam-2 sai).
    await store.recordHeartbeat('cli-a', {
      sample: sample('2026-07-27T10:02:00.000Z'),
      cameras: [{ cameraId: 'cam-1', name: 'Portaria', status: 'ONLINE', recording: { active: true, stalled: false } }],
    });
    health = await store.cameraHealth('cli-a');
    assert.deepEqual(health.map((c) => c.cameraId), ['cam-1']);
    assert.equal(health[0].at, '2026-07-27T10:02:00.000Z');
  } finally {
    await store.close();
  }
});

test('PG: maintain() faz rollup horário e PODA as cruas — sem perder nada', { skip }, async () => {
  const store = await makeStore({ rawRetentionHours: 48 });
  try {
    const now = '2026-07-27T12:00:00.000Z';
    // 6 amostras dentro da MESMA hora antiga (10h de 2026-07-24) + 2 recentes.
    for (let i = 0; i < 6; i += 1) {
      await store.recordHeartbeat('cli-a', {
        sample: sample(`2026-07-24T10:0${i}:00.000Z`, { online: 10 + i, disk: 50 + i }),
      });
    }
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-27T11:00:00.000Z', { online: 4 }) });
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-27T11:01:00.000Z', { online: 5 }) });
    assert.equal(await countRows(store, TABLES.samples, 'cli-a'), 8);

    const result = await store.maintain({ now });
    assert.equal(result.rolledUpSamples, 6);
    assert.equal(result.buckets, 1);
    assert.equal(await countRows(store, TABLES.samples, 'cli-a'), 2, 'só as recentes seguem cruas');

    const hourly = await store._pg().query(
      `SELECT bucket, samples, stats FROM ${TABLES.samplesHourly} WHERE installation_id='cli-a'`,
    );
    assert.equal(hourly.rowCount, 1);
    assert.equal(ts.toIso(hourly.rows[0].bucket), '2026-07-24T10:00:00.000Z');
    assert.equal(hourly.rows[0].samples, 6);
    assert.deepEqual(hourly.rows[0].stats.camerasOnline, { min: 10, avg: 12.5, max: 15, count: 6 });
    assert.deepEqual(hourly.rows[0].stats.diskUsagePercent, { min: 50, avg: 52.5, max: 55, count: 6 });

    // Rodar de novo não muda nada (idempotente).
    const again = await store.maintain({ now });
    assert.equal(again.rolledUpSamples, 0);
    assert.equal(await countRows(store, TABLES.samplesHourly, 'cli-a'), 1);
  } finally {
    await store.close();
  }
});

test('PG: rollup ATRASADO da mesma hora funde com média PONDERADA (nada é sobrescrito)', { skip }, async () => {
  const store = await makeStore({ rawRetentionHours: 48 });
  try {
    // 1ª passada: 3 amostras de valor 10 na hora antiga.
    for (let i = 0; i < 3; i += 1) {
      await store.recordHeartbeat('cli-a', { sample: sample(`2026-07-24T10:0${i}:00.000Z`, { online: 10 }) });
    }
    await store.maintain({ now: '2026-07-27T12:00:00.000Z' });

    // 2ª passada: chega (atrasada) 1 amostra da MESMA hora, com valor 2.
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-24T10:30:00.000Z', { online: 2 }) });
    await store.maintain({ now: '2026-07-27T12:00:00.000Z' });

    const hourly = await store._pg().query(
      `SELECT samples, stats FROM ${TABLES.samplesHourly} WHERE installation_id='cli-a' AND bucket='2026-07-24T10:00:00.000Z'`,
    );
    assert.equal(hourly.rowCount, 1);
    assert.equal(hourly.rows[0].samples, 4);
    assert.deepEqual(hourly.rows[0].stats.camerasOnline, { min: 2, avg: 8, max: 10, count: 4 });
  } finally {
    await store.close();
  }
});

test('PG: o agregado horário também tem retenção (não cresce para sempre)', { skip }, async () => {
  const store = await makeStore({ rawRetentionHours: 1, hourlyRetentionDays: 30 });
  try {
    await store.recordHeartbeat('cli-a', { sample: sample('2026-01-01T10:00:00.000Z', { online: 3 }) });
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-27T09:00:00.000Z', { online: 4 }) });
    const first = await store.maintain({ now: '2026-07-27T12:00:00.000Z' });
    assert.equal(first.rolledUpSamples, 2);
    // O bucket de janeiro nasce e MORRE na mesma passada (já está fora dos 30 dias).
    const buckets = await store._pg().query(
      `SELECT bucket FROM ${TABLES.samplesHourly} WHERE installation_id='cli-a' ORDER BY bucket`,
    );
    assert.deepEqual(buckets.rows.map((r) => ts.toIso(r.bucket)), ['2026-07-27T09:00:00.000Z']);
    assert.equal(first.hourlyDeleted, 1);
  } finally {
    await store.close();
  }
});

test('PG: série da instalação em raw e em hour (hour inclui o que ainda não foi consolidado)', { skip }, async () => {
  const store = await makeStore({ rawRetentionHours: 48 });
  try {
    const now = '2026-07-27T12:00:00.000Z';
    for (let i = 0; i < 4; i += 1) {
      await store.recordHeartbeat('cli-a', { sample: sample(`2026-07-27T10:0${i}:00.000Z`, { online: 8 + i, disk: 30 }) });
    }
    // Uma amostra antiga, já consolidada em bucket horário.
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-20T08:10:00.000Z', { online: 2, disk: 90 }) });
    await store.maintain({ now });

    const raw = await store.installationSeries('cli-a', { from: '2026-07-27T00:00:00.000Z', to: now, now });
    assert.equal(raw.resolution, 'raw');
    assert.equal(raw.points.length, 4);
    assert.equal(raw.points[0].camerasOnline, 8);

    const hour = await store.installationSeries('cli-a', { from: '2026-07-19T00:00:00.000Z', to: now, now });
    assert.equal(hour.resolution, 'hour', 'janela além da retenção crua cai para o agregado');
    assert.deepEqual(hour.points.map((p) => p.t), ['2026-07-20T08:00:00.000Z', '2026-07-27T10:00:00.000Z']);
    assert.equal(hour.points[0].camerasOnline, 2, 'veio do rollup consolidado');
    assert.equal(hour.points[0].samples, 1);
    assert.equal(hour.points[1].camerasOnline, 9.5, 'veio das cruas ainda não consolidadas: média de 8..11');
    assert.equal(hour.points[1].samples, 4);
    assert.equal(hour.points[1].min.camerasOnline, 8);
    assert.equal(hour.points[1].max.camerasOnline, 11);
  } finally {
    await store.close();
  }
});

test('PG: frota SOMA contadores entre instalações e faz MÉDIA do disco (não infla quem manda mais heartbeat)', { skip }, async () => {
  const store = await makeStore({ rawRetentionHours: 48 });
  try {
    const now = '2026-07-27T12:00:00.000Z';
    // cli-a manda 4 heartbeats no mesmo bucket de 5min; cli-b manda 1.
    for (let i = 0; i < 4; i += 1) {
      await store.recordHeartbeat('cli-a', { sample: sample(`2026-07-27T10:0${i}:00.000Z`, { online: 10, disk: 80 }) });
    }
    await store.recordHeartbeat('cli-b', { sample: sample('2026-07-27T10:02:00.000Z', { online: 4, disk: 20 }) });

    const fleet = await store.fleetSeries({ from: '2026-07-27T09:00:00.000Z', to: now, now, bucketSeconds: 300 });
    assert.equal(fleet.resolution, 'raw');
    assert.equal(fleet.points.length, 1);
    const point = fleet.points[0];
    assert.equal(point.t, '2026-07-27T10:00:00.000Z');
    assert.equal(point.installations, 2);
    assert.equal(point.samples, 5);
    assert.equal(point.camerasOnline, 14, '10 (média de cli-a) + 4 (cli-b) — não 44');
    assert.equal(point.diskUsagePercent, 50, 'média entre instalações (80 e 20)');
    assert.equal(point.max.diskUsagePercent, 80);
  } finally {
    await store.close();
  }
});

test('PG ponta a ponta: heartbeat da Central REAL vira série consultável pelo painel', { skip }, async (t) => {
  let isolated;
  try {
    isolated = await createIsolatedDatabase('e2e');
  } catch (error) {
    t.skip(`sem permissão para criar banco isolado: ${error.message}`);
    return;
  }
  t.after(() => isolated.drop());

  const central = await startCentral({ DRAC_CENTRAL_DATABASE_URL: isolated.url, DRAC_CENTRAL_STORE_MODE: 'pg' });
  t.after(() => central.stop());

  const provision = await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST',
    headers: central.adminHeaders(),
    body: JSON.stringify({ customerName: 'Cliente PG', installationId: 'cli-pg' }),
  });
  assert.equal(provision.status, 201);
  const { licenseKey } = await provision.json();

  const heartbeat = await fetch(`${central.base}/api/agent/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-drac-installation-id': 'cli-pg', 'x-drac-license-key': licenseKey },
    body: JSON.stringify({
      summary: {
        cameras: { total: 3, online: 2, offline: 1, error: 0 },
        activeRecordingCount: 2,
        diskUsagePercent: 77,
        alerts: [{ level: 'critical', code: 'disk', message: 'disco cheio' }],
      },
      cameras: [
        { cameraId: 'cam-1', name: 'Portaria', enabled: true, status: 'ONLINE', recording: { desired: true, active: true, stalled: false } },
        { cameraId: 'cam-2', name: 'Fundos', enabled: true, status: 'OFFLINE', recording: { desired: true, active: false, stalled: true, restartsLastHour: 5 } },
      ],
    }),
  });
  assert.equal(heartbeat.status, 200);

  const series = await fetch(`${central.base}/api/admin/installations/cli-pg/timeseries`, { headers: central.adminHeaders() });
  assert.equal(series.status, 200);
  const body = await series.json();
  assert.equal(body.source, 'postgres');
  assert.equal(body.enabled, true);
  assert.equal(body.degraded, false);
  assert.equal(body.resolution, 'raw');
  assert.equal(body.points.length, 1);
  assert.equal(body.points[0].camerasTotal, 3);
  assert.equal(body.points[0].camerasOnline, 2);
  assert.equal(body.points[0].camerasStalled, 1, 'derivado do bloco por câmera');
  assert.equal(body.points[0].recordingsActive, 2);
  assert.equal(body.points[0].diskUsagePercent, 77);
  assert.equal(body.points[0].alertsCritical, 1);
  assert.equal(body.retention.rawHours, 48);
  assert.deepEqual(body.cameras.map((c) => c.cameraId).sort(), ['cam-1', 'cam-2']);
  assert.equal(body.cameras.find((c) => c.cameraId === 'cam-2').recordingStalled, true);

  const fleet = await fetch(`${central.base}/api/admin/fleet/timeseries`, { headers: central.adminHeaders() });
  const fleetBody = await fleet.json();
  assert.equal(fleetBody.source, 'postgres');
  assert.equal(fleetBody.points.length, 1);
  assert.equal(fleetBody.points[0].camerasOnline, 2);
  assert.equal(fleetBody.points[0].installations, 1);
});

test('PG: purgeInstallation limpa série, rollup e saúde por câmera', { skip }, async () => {
  const store = await makeStore({ rawRetentionHours: 48 });
  try {
    await store.recordHeartbeat('cli-a', {
      sample: sample('2026-07-24T10:00:00.000Z'),
      cameras: [{ cameraId: 'cam-1', status: 'ONLINE', recording: { active: true } }],
    });
    await store.recordHeartbeat('cli-a', { sample: sample('2026-07-27T11:00:00.000Z') });
    await store.maintain({ now: '2026-07-27T12:00:00.000Z' });
    assert.equal(await countRows(store, TABLES.samplesHourly, 'cli-a'), 1);

    await store.purgeInstallation('cli-a');
    assert.equal(await countRows(store, TABLES.samples, 'cli-a'), 0);
    assert.equal(await countRows(store, TABLES.samplesHourly, 'cli-a'), 0);
    assert.equal(await countRows(store, TABLES.cameraHealth, 'cli-a'), 0);
  } finally {
    await store.close();
  }
});
