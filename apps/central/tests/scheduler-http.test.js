'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ADMIN_TOKEN, startCentral } = require('./helpers/central-server');

// Endpoints do scheduler no servidor REAL, com arquivo de dados TEMPORÁRIO
// (nunca o data file vivo da Central).
//
// O teste MAIS importante deste arquivo é o primeiro: com a flag DESLIGADA
// (default), produção tem de continuar IDÊNTICA — rota inexistente, nenhum
// plano gravado, registro de nós inerte.

const admin = (extra = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', ...extra });
const LIGADO = { DRAC_CENTRAL_SCHEDULER_ENABLED: 'true' };

const NOS = [
  { id: 'no-a', role: 'primary', capacity: 4, cameras: ['cam-01', 'cam-02'] },
  { id: 'no-b', role: 'worker', capacity: 4, cameras: ['cam-03'] },
];

async function preparar(central, id = 'cli-sched') {
  const provision = await fetch(`${central.base}/api/admin/provision`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({ customerName: 'Cliente Scheduler', installationId: id }),
  });
  assert.equal(provision.status, 201);
  const patch = await fetch(`${central.base}/api/admin/installations/${id}/compute-nodes`, {
    method: 'PATCH',
    headers: admin(),
    body: JSON.stringify({ computeNodes: NOS }),
  });
  assert.equal(patch.status, 200);
  return id;
}

async function lerRegistro(central, id) {
  const raw = await fsp.readFile(path.join(central.dir, 'installations.json'), 'utf8');
  return JSON.parse(raw).installations[id];
}

// ── FLAG DESLIGADA (default) ────────────────────────────────────────────────
test('flag OFF (default): as rotas do scheduler NÃO existem e nada é gravado', async (t) => {
  const central = await startCentral();
  t.after(() => central.stop());
  const id = await preparar(central);

  const get = await fetch(`${central.base}/api/admin/installations/${id}/scheduler`, { headers: admin() });
  assert.equal(get.status, 404);
  assert.deepEqual(await get.json(), { error: 'not_found' }, 'com a flag off a rota é indistinguível de uma rota inexistente');

  const post = await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({}),
  });
  assert.equal(post.status, 404);
  assert.deepEqual(await post.json(), { error: 'not_found' });

  // Uma rota comprovadamente inexistente responde EXATAMENTE o mesmo.
  const inexistente = await fetch(`${central.base}/api/admin/rota-que-nao-existe`, { headers: admin() });
  assert.equal(inexistente.status, 404);
  assert.deepEqual(await inexistente.json(), { error: 'not_found' });

  // E o registro continua INERTE: nós preservados, nenhum plano gravado.
  const registro = await lerRegistro(central, id);
  assert.equal('schedulerPlan' in registro, false, 'flag off NÃO pode escrever plano no registro');
  assert.equal(registro.computeNodes.length, 2, 'o registro de nós segue como estava');

  // As rotas existentes seguem idênticas.
  const detail = await fetch(`${central.base}/api/admin/installations/${id}`, { headers: admin() });
  assert.equal(detail.status, 200);
  const body = await detail.json();
  assert.equal(body.computeNodes.length, 2);
  assert.equal('schedulerPlan' in body, false);
});

// ── FLAG LIGADA ─────────────────────────────────────────────────────────────
test('flag ON: consultar o plano, forçar replanejamento e persistir o resultado', async (t) => {
  const central = await startCentral(LIGADO);
  t.after(() => central.stop());
  const id = await preparar(central);

  // 1) Antes de planejar: leitura pura, sem plano.
  const antes = await fetch(`${central.base}/api/admin/installations/${id}/scheduler`, { headers: admin() });
  assert.equal(antes.status, 200);
  const viewAntes = await antes.json();
  assert.equal(viewAntes.enabled, true);
  assert.equal(viewAntes.planned, false);
  assert.equal(viewAntes.plan, null);
  assert.equal(viewAntes.stale, true);
  assert.deepEqual(viewAntes.workloads, ['cam-01', 'cam-02', 'cam-03']);
  assert.equal(viewAntes.nodes.total, 2);
  assert.equal((await lerRegistro(central, id)).schedulerPlan, undefined, 'GET não pode gravar plano');

  // 2) Replanejar: o primeiro plano CONFIRMA o registro (zero migração).
  const replan = await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({}),
  });
  assert.equal(replan.status, 200);
  const { plan } = await replan.json();
  assert.equal(plan.installationId, id);
  assert.equal(plan.epoch, 1);
  assert.deepEqual(plan.migrations, [], 'o primeiro plano não pode mexer no que já grava');
  assert.deepEqual(
    plan.assignments.map((a) => [a.cameraId, a.nodeId]),
    [['cam-01', 'no-a'], ['cam-02', 'no-a'], ['cam-03', 'no-b']],
  );
  assert.ok(plan.assignments.every((a) => a.token > 0 && a.leaseExpiresAt));

  // 3) Persistiu — e o GET devolve exatamente o plano salvo.
  const depois = await fetch(`${central.base}/api/admin/installations/${id}/scheduler`, { headers: admin() });
  const viewDepois = await depois.json();
  assert.equal(viewDepois.planned, true);
  assert.equal(viewDepois.stale, false);
  assert.deepEqual(viewDepois.plan, plan);
  assert.deepEqual((await lerRegistro(central, id)).schedulerPlan, plan);

  // 4) Replanejar de novo NÃO reembaralha nem troca token.
  const replan2 = await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
    method: 'POST', headers: admin(), body: JSON.stringify({}),
  });
  const plan2 = (await replan2.json()).plan;
  assert.equal(plan2.epoch, 2);
  assert.deepEqual(plan2.migrations, []);
  assert.deepEqual(plan2.assignments.map((a) => a.token), plan.assignments.map((a) => a.token));

  // 5) O replanejamento entrou na auditoria.
  const audit = await fetch(`${central.base}/api/admin/audit`, { headers: admin() });
  const eventos = (await audit.json()).items;
  assert.ok(eventos.some((e) => e.type === 'installation.scheduler_replanned' && e.installationId === id));
});

test('flag ON: failover pelo estado dos nós — nó morto tem as cargas remanejadas', async (t) => {
  const central = await startCentral(LIGADO);
  t.after(() => central.stop());
  const id = await preparar(central);

  await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
    method: 'POST', headers: admin(), body: JSON.stringify({}),
  });

  const morto = await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({ nodeStates: { 'no-a': { status: 'down' }, 'no-b': { lastSeenAt: new Date().toISOString() } } }),
  });
  assert.equal(morto.status, 200);
  const plan = (await morto.json()).plan;
  assert.equal(plan.nodes.find((n) => n.id === 'no-a').health, 'dead');
  assert.equal(plan.stats.migrations, 2, 'as duas câmeras do nó morto foram para o vivo');
  assert.ok(plan.migrations.every((m) => m.from === 'no-a' && m.to === 'no-b' && m.reason === 'node_dead'));
  assert.equal(plan.revoked.length, 2, 'os leases do nó morto foram invalidados');
  const antigos = plan.revoked.map((r) => r.token);
  assert.ok(plan.assignments.every((a) => antigos.every((t) => a.token > t)), 'token novo supera todo token revogado');
});

test('flag ON: dryRun calcula sem persistir', async (t) => {
  const central = await startCentral(LIGADO);
  t.after(() => central.stop());
  const id = await preparar(central);

  const seco = await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
    method: 'POST', headers: admin(), body: JSON.stringify({ dryRun: true }),
  });
  assert.equal(seco.status, 200);
  const corpo = await seco.json();
  assert.equal(corpo.dryRun, true);
  assert.equal(corpo.plan.assignments.length, 3);
  assert.equal((await lerRegistro(central, id)).schedulerPlan, undefined, 'dryRun NÃO pode gravar');
  assert.equal((await (await fetch(`${central.base}/api/admin/installations/${id}/scheduler`, { headers: admin() })).json()).planned, false);
});

test('flag ON: guardas — auth, instalação inexistente e payload malformado', async (t) => {
  const central = await startCentral(LIGADO);
  t.after(() => central.stop());
  const id = await preparar(central);

  const anonimo = await fetch(`${central.base}/api/admin/installations/${id}/scheduler`);
  assert.equal(anonimo.status, 401, 'o scheduler segue o mesmo portão de /api/admin');
  const anonimoPost = await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, { method: 'POST' });
  assert.equal(anonimoPost.status, 401);

  const semInstalacao = await fetch(`${central.base}/api/admin/installations/nao-existe/scheduler`, { headers: admin() });
  assert.equal(semInstalacao.status, 404);
  assert.deepEqual(await semInstalacao.json(), { error: 'installation_not_found' });

  for (const corpo of [{ workloads: 'x' }, { workloads: null }, { nodeStates: [] }, { nodeStates: 'x' }]) {
    const r = await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
      method: 'POST', headers: admin(), body: JSON.stringify(corpo),
    });
    assert.equal(r.status, 400, `payload ${JSON.stringify(corpo)} tinha de ser rejeitado`);
    assert.equal((await r.json()).error, 'invalid_scheduler_payload');
  }
  assert.equal((await lerRegistro(central, id)).schedulerPlan, undefined, 'payload inválido não grava plano');
});

test('flag ON: registro de nós INVÁLIDO (legado) é 400, não um plano com dois donos', async (t) => {
  const central = await startCentral(LIGADO);
  t.after(() => central.stop());
  const id = await preparar(central);

  // A PATCH valida, então um registro inválido só chega aqui por dado legado:
  // escrevemos direto no arquivo TEMPORÁRIO (loadDb relê a cada request).
  const arquivo = path.join(central.dir, 'installations.json');
  const db = JSON.parse(await fsp.readFile(arquivo, 'utf8'));
  db.installations[id].computeNodes = [
    { id: 'dup', role: 'primary', capacity: 4, cameras: ['cam-01'] },
    { id: 'dup', role: 'worker', capacity: 4, cameras: ['cam-02'] },
  ];
  await fsp.writeFile(arquivo, JSON.stringify(db, null, 2));

  const r = await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
    method: 'POST', headers: admin(), body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
  const corpo = await r.json();
  assert.equal(corpo.error, 'invalid_compute_nodes');
  assert.ok(corpo.details.some((e) => e.code === 'duplicate_id'));
  assert.equal((await lerRegistro(central, id)).schedulerPlan, undefined, 'registro inválido não gera plano');
});

test('flag ON: as rotas existentes continuam idênticas (o scheduler não vaza)', async (t) => {
  const central = await startCentral(LIGADO);
  t.after(() => central.stop());
  const id = await preparar(central);

  await fetch(`${central.base}/api/admin/installations/${id}/scheduler/replan`, {
    method: 'POST', headers: admin(), body: JSON.stringify({}),
  });

  // publicInstallation lista campos um a um: o plano NÃO aparece nas respostas
  // existentes, mesmo depois de gravado.
  const detail = await (await fetch(`${central.base}/api/admin/installations/${id}`, { headers: admin() })).json();
  assert.equal('schedulerPlan' in detail, false);
  assert.equal(detail.computeNodes.length, 2);
  assert.equal(detail.status, 'PENDING_INSTALL');
  assert.equal(detail.policyPending, false, 'replanejar não pode marcar política pendente');

  const lista = await (await fetch(`${central.base}/api/admin/installations`, { headers: admin() })).json();
  assert.equal(lista.items.length, 1);
  assert.equal('schedulerPlan' in lista.items[0], false);

  const resumo = await (await fetch(`${central.base}/api/admin/summary`, { headers: admin() })).json();
  assert.equal(resumo.totals.installations, 1);
  assert.equal(resumo.totals.computeNodesTotal, 2);

  // E o registro de nós continua editável como antes (o scheduler não o congela).
  const patch = await fetch(`${central.base}/api/admin/installations/${id}/compute-nodes`, {
    method: 'PATCH', headers: admin(), body: JSON.stringify({ computeNodes: [] }),
  });
  assert.equal(patch.status, 200);
  const registro = await lerRegistro(central, id);
  assert.equal('computeNodes' in registro, false);
  assert.ok(registro.schedulerPlan, 'o plano salvo sobrevive à edição do registro (replanejar é explícito)');
});
