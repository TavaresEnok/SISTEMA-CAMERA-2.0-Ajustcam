'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ADMIN_TOKEN, startCentral } = require('./helpers/central-server');

// Prova o caminho DEFAULT (sem Postgres) ponta a ponta no servidor REAL:
//   • o heartbeat continua idêntico — inclusive com o bloco `cameras` novo, que
//     ele tem de ACEITAR e IGNORAR sem erro;
//   • os endpoints novos respondem com o histórico CURTO do JSON (source: json),
//     sem nunca tocar Postgres.
// Roda SEMPRE (não depende de banco). Usa arquivo de dados TEMPORÁRIO — nunca
// o data file vivo da Central.

const admin = (extra = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', ...extra });

test('SEM Postgres: heartbeat com bloco `cameras` é aceito e os endpoints de série caem no JSON', async (t) => {
  const central = await startCentral();
  t.after(() => central.stop());

  const provision = await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({ customerName: 'Cliente Série', installationId: 'cli-serie' }),
  });
  assert.equal(provision.status, 201);
  const provisioned = await provision.json();
  const licenseKey = provisioned.licenseKey;
  assert.ok(licenseKey);

  // Heartbeat COM o bloco novo por câmera (o que o outro agente vai passar a mandar).
  const heartbeat = await fetch(`${central.base}/api/agent/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-drac-installation-id': 'cli-serie', 'x-drac-license-key': licenseKey },
    body: JSON.stringify({
      installation: { name: 'Cliente Série', customerName: 'Cliente Série', version: '1.2.3' },
      summary: {
        status: 'ok',
        cameras: { total: 3, online: 2, offline: 1, error: 0 },
        activeRecordingCount: 2,
        diskUsagePercent: 61,
        alerts: [{ level: 'critical', code: 'disk', message: 'disco cheio' }, { level: 'warning', code: 'x' }],
      },
      cameras: [
        { cameraId: 'cam-1', name: 'Portaria', enabled: true, status: 'ONLINE', recording: { desired: true, active: true, stalled: false, segmentsLastHour: 60 }, stream: { recoveriesLastHour: 0 } },
        { cameraId: 'cam-2', name: 'Fundos', enabled: true, status: 'OFFLINE', recording: { desired: true, active: false, stalled: true, restartsLastHour: 2 }, stream: { recoveriesLastHour: 3 } },
      ],
      server: { hostname: 'srv', totalMemoryBytes: 1000, freeMemoryBytes: 400, loadAverage: [1.5, 1, 1] },
      storage: { disk: { usagePercent: 61 } },
    }),
  });
  assert.equal(heartbeat.status, 200, 'o bloco novo NÃO pode quebrar o heartbeat');
  const hb = await heartbeat.json();
  assert.equal(hb.accepted, true);
  assert.equal(hb.licenseStatus, 'ACTIVE', 'resposta do heartbeat continua idêntica');

  // Série da instalação: sem Postgres, vem do histórico curto do JSON.
  const series = await fetch(`${central.base}/api/admin/installations/cli-serie/timeseries`, { headers: admin() });
  assert.equal(series.status, 200);
  const body = await series.json();
  assert.equal(body.source, 'json');
  assert.equal(body.enabled, false);
  assert.equal(body.degraded, false);
  assert.equal(body.resolution, 'raw');
  assert.equal(body.installationId, 'cli-serie');
  assert.equal(body.points.length, 1);
  assert.equal(body.points[0].camerasTotal, 3);
  assert.equal(body.points[0].camerasOnline, 2);
  assert.equal(body.points[0].camerasOffline, 1);
  assert.equal(body.points[0].recordingsActive, 2);
  assert.equal(body.points[0].diskUsagePercent, 61);
  assert.deepEqual(body.cameras, [], 'sem Postgres não há saúde por câmera guardada');
  assert.ok(body.from < body.to);

  // Frota: mesma forma de ponto, agregada.
  const fleet = await fetch(`${central.base}/api/admin/fleet/timeseries`, { headers: admin() });
  assert.equal(fleet.status, 200);
  const fleetBody = await fleet.json();
  assert.equal(fleetBody.source, 'json');
  assert.equal(fleetBody.enabled, false);
  assert.equal(fleetBody.installations, 1);
  assert.equal(fleetBody.points.length, 1);
  assert.equal(fleetBody.points[0].camerasOnline, 2);
  assert.equal(fleetBody.points[0].installations, 1);

  // Instalação inexistente continua 404 (não inventa série).
  const missing = await fetch(`${central.base}/api/admin/installations/nao-existe/timeseries`, { headers: admin() });
  assert.equal(missing.status, 404);

  // E os endpoints novos exigem autenticação, como todo /api/admin/.
  const anon = await fetch(`${central.base}/api/admin/fleet/timeseries`);
  assert.equal(anon.status, 401);

  // Nada de Postgres foi tocado nem anunciado.
  const log = central.logs.join('');
  assert.equal(/Postgres/i.test(log), false, `log não pode mencionar Postgres no modo JSON: ${log}`);
});

test('SEM Postgres: as rotas existentes continuam idênticas (nada regrediu)', async (t) => {
  const central = await startCentral();
  t.after(() => central.stop());

  await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({ customerName: 'Cliente Dois', installationId: 'cli-dois' }),
  });

  const summary = await fetch(`${central.base}/api/admin/summary`, { headers: admin() });
  assert.equal(summary.status, 200);
  const summaryBody = await summary.json();
  assert.equal(summaryBody.totals.installations, 1);
  assert.equal(summaryBody.totals.pendingInstall, 1);

  const list = await fetch(`${central.base}/api/admin/installations`, { headers: admin() });
  const listBody = await list.json();
  assert.equal(listBody.items.length, 1);
  assert.equal(listBody.items[0].status, 'PENDING_INSTALL');
  assert.deepEqual(listBody.items[0].heartbeatHistory, []);
});
