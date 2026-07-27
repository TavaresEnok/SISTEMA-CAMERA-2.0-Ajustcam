'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const scheduler = require('../src/scheduler');
const { planAssignments } = require('../src/scheduler/plan');
const leases = require('../src/scheduler/leases');
const { DEFAULT_SCHEDULER_CONFIG, resolveSchedulerConfig, schedulerConfigFromEnv } = require('../src/scheduler/config');

// Relógio INJETADO em todos os testes — o algoritmo não pode ler o relógio dele.
const T0 = Date.parse('2026-07-27T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const node = (id, capacity, role = 'worker') => ({ id, role, ...(capacity === undefined ? {} : { capacity }) });
const cams = (n, prefix = 'cam-') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
const alive = (ids, at = T0) => Object.fromEntries(ids.map((id) => [id, { lastSeenAt: iso(at) }]));
const mapOf = (plan) => Object.fromEntries(plan.assignments.map((a) => [a.cameraId, a.nodeId]));
const loadOf = (plan) => Object.fromEntries(plan.nodes.map((n) => [n.id, n.load]));

// Invariante estrutural que TODO plano tem de respeitar.
function assertPlanIsSane(plan) {
  const pesoPorNo = new Map();
  for (const a of plan.assignments) pesoPorNo.set(a.nodeId, (pesoPorNo.get(a.nodeId) || 0) + a.weight);
  for (const n of plan.nodes) {
    assert.ok(n.load <= n.capacity, `nó ${n.id} estourou a capacidade: ${n.load} > ${n.capacity}`);
    assert.equal(n.load, pesoPorNo.get(n.id) || 0, `carga do nó ${n.id} não bate com a soma dos pesos atribuídos`);
    assert.deepEqual(
      n.cameras,
      plan.assignments.filter((a) => a.nodeId === n.id).map((a) => a.cameraId),
      `lista de câmeras do nó ${n.id} não bate com as atribuições`,
    );
  }
  const seen = new Set();
  for (const a of plan.assignments) {
    assert.equal(seen.has(a.cameraId), false, `câmera ${a.cameraId} atribuída duas vezes (dois donos!)`);
    seen.add(a.cameraId);
    assert.ok(Number.isInteger(a.token) && a.token > 0, 'todo lease tem token inteiro positivo');
    assert.ok(a.token < plan.nextToken, 'nextToken tem de superar todo token emitido');
  }
  for (const u of plan.unassigned) {
    assert.equal(seen.has(u.cameraId), false, 'câmera não pode estar atribuída E sem nó');
  }
}

// ── 1) DETERMINISMO ─────────────────────────────────────────────────────────
test('determinismo: a MESMA entrada dá a MESMA saída em execuções repetidas', () => {
  const input = {
    nodes: [node('no-a', 8), node('no-b', 8), node('no-c', 4)],
    nodeStates: alive(['no-a', 'no-b', 'no-c']),
    workloads: cams(10),
    now: T0,
  };
  const first = planAssignments(input);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(planAssignments(input), first, `execução ${i} divergiu`);
  }
  assertPlanIsSane(first);
});

test('determinismo DENTE: a ORDEM dos nós e das cargas na entrada é irrelevante (desempate estável por id)', () => {
  const base = {
    nodeStates: alive(['no-a', 'no-b']),
    now: T0,
  };
  const direto = planAssignments({
    ...base,
    nodes: [node('no-a', 8), node('no-b', 8)],
    workloads: ['cam-01', 'cam-02', 'cam-03', 'cam-04'],
  });
  const embaralhado = planAssignments({
    ...base,
    nodes: [node('no-b', 8), node('no-a', 8)],
    workloads: ['cam-03', 'cam-01', 'cam-04', 'cam-02'],
  });
  assert.deepEqual(embaralhado, direto, 'plano mudou só porque a entrada veio noutra ordem');
  // E o resultado é o do desempate ESTÁVEL (menor id vence), não o da ordem do array.
  assert.deepEqual(mapOf(direto), {
    'cam-01': 'no-a',
    'cam-02': 'no-b',
    'cam-03': 'no-a',
    'cam-04': 'no-b',
  });
});

test('determinismo: cargas de pesos diferentes entram na ordem canônica (peso DESC, id ASC)', () => {
  const a = planAssignments({
    nodes: [node('no-a', 10), node('no-b', 10)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: [{ id: 'cam-leve', weight: 1 }, { id: 'cam-pesada', weight: 6 }, { id: 'cam-media', weight: 3 }],
    now: T0,
  });
  const b = planAssignments({
    nodes: [node('no-b', 10), node('no-a', 10)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: [{ id: 'cam-media', weight: 3 }, { id: 'cam-leve', weight: 1 }, { id: 'cam-pesada', weight: 6 }],
    now: T0,
  });
  assert.deepEqual(b, a);
  assert.equal(mapOf(a)['cam-pesada'], 'no-a', 'a maior carga entra primeiro, no menor id em caso de empate');
  assert.equal(mapOf(a)['cam-media'], 'no-b');
});

test('determinismo DENTE: `now` é OBRIGATÓRIO — o algoritmo não lê o relógio', () => {
  assert.throws(
    () => planAssignments({ nodes: [node('no-a', 4)], workloads: ['cam-01'] }),
    /now/,
  );
  assert.throws(() => planAssignments({ nodes: [], workloads: [], now: 'não é data' }), /now/);
  // Com `now` injetado, o carimbo e o lease derivam SÓ dele.
  const plan = planAssignments({ nodes: [node('no-a', 4)], workloads: ['cam-01'], now: T0, config: { leaseTtlSeconds: 60 } });
  assert.equal(plan.generatedAt, iso(T0));
  assert.equal(plan.assignments[0].leaseExpiresAt, iso(T0 + 60_000));
});

// ── 2) BALANCEAMENTO POR CAPACIDADE ─────────────────────────────────────────
test('balanceamento: a carga segue a CAPACIDADE declarada (nó com o dobro recebe o dobro)', () => {
  const plan = planAssignments({
    nodes: [node('no-a', 4), node('no-b', 8)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: cams(12),
    now: T0,
  });
  assertPlanIsSane(plan);
  assert.deepEqual(loadOf(plan), { 'no-a': 4, 'no-b': 8 });
  assert.equal(plan.stats.unassigned, 0);
});

test('balanceamento: nó sem capacidade declarada usa o default da config (não é infinito)', () => {
  const plan = planAssignments({
    nodes: [node('no-a'), node('no-b', 2)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: cams(6),
    now: T0,
    config: { defaultNodeCapacity: 4 },
  });
  assertPlanIsSane(plan);
  assert.equal(plan.nodes.find((n) => n.id === 'no-a').capacity, 4);
  assert.equal(plan.nodes.find((n) => n.id === 'no-a').declaredCapacity, null);
  assert.deepEqual(loadOf(plan), { 'no-a': 4, 'no-b': 2 });
});

test('balanceamento: sem folga na frota, a carga sobra em `unassigned` (não estoura o nó)', () => {
  const plan = planAssignments({
    nodes: [node('no-a', 2)],
    nodeStates: alive(['no-a']),
    workloads: cams(3),
    now: T0,
  });
  assertPlanIsSane(plan);
  assert.equal(plan.assignments.length, 2);
  assert.deepEqual(plan.unassigned.map((u) => u.cameraId), ['cam-03']);
  assert.equal(plan.unassigned[0].reason, 'no_capacity');
});

test('peso: uma carga pesada ocupa o espaço de várias leves', () => {
  const plan = planAssignments({
    nodes: [node('no-a', 4), node('no-b', 4)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: [{ id: 'cam-01', weight: 4 }, { id: 'cam-02', weight: 4 }, { id: 'cam-03', weight: 1 }],
    now: T0,
  });
  assertPlanIsSane(plan);
  assert.deepEqual(loadOf(plan), { 'no-a': 4, 'no-b': 4 });
  assert.deepEqual(plan.unassigned.map((u) => u.cameraId), ['cam-03']);
});

// ── 3) AFINIDADE / MINIMIZAÇÃO DE MIGRAÇÕES ─────────────────────────────────
test('estabilidade DENTE: entrar um nó NOVO não migra NENHUMA câmera saudável', () => {
  const doisNos = {
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: cams(6),
    now: T0,
  };
  const plan1 = planAssignments(doisNos);
  assert.equal(plan1.stats.migrations, 0);

  const plan2 = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8), node('no-c', 8)],
    nodeStates: alive(['no-a', 'no-b', 'no-c']),
    workloads: cams(6),
    previous: plan1,
    now: T0 + 60_000,
  });
  assertPlanIsSane(plan2);
  assert.deepEqual(plan2.migrations, [], 'replanejar com nó novo NÃO pode reembaralhar a frota');
  assert.deepEqual(mapOf(plan2), mapOf(plan1), 'toda câmera continuou exatamente onde estava');
  assert.equal(loadOf(plan2)['no-c'], 0, 'o nó novo entra vazio: estabilidade > gráfico bonito');
  assert.deepEqual(plan2.revoked, [], 'sem migração não há lease revogado');

  // E a carga NOVA é que vai para o nó novo (é assim que ele se enche).
  const plan3 = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8), node('no-c', 8)],
    nodeStates: alive(['no-a', 'no-b', 'no-c']),
    workloads: cams(9),
    previous: plan2,
    now: T0 + 120_000,
  });
  assertPlanIsSane(plan3);
  assert.deepEqual(plan3.migrations, []);
  assert.deepEqual(plan3.nodes.find((n) => n.id === 'no-c').cameras, ['cam-07', 'cam-08', 'cam-09']);
});

test('estabilidade: retenção preserva o token (mesmo dono ⇒ mesmo lease, só renovado)', () => {
  const plan1 = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: cams(4),
    now: T0,
  });
  const plan2 = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: cams(4),
    previous: plan1,
    now: T0 + 30_000,
  });
  assert.deepEqual(
    plan2.assignments.map((a) => a.token),
    plan1.assignments.map((a) => a.token),
    'câmera que não mudou de nó não pode trocar de token',
  );
  assert.notEqual(plan2.assignments[0].leaseExpiresAt, plan1.assignments[0].leaseExpiresAt, 'o lease é RENOVADO');
  assert.equal(plan2.epoch, plan1.epoch + 1);
});

test('estabilidade: reduzir a capacidade evita só o excesso (o resto continua parado)', () => {
  const plan1 = planAssignments({
    nodes: [node('no-a', 4), node('no-b', 4)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: cams(6),
    now: T0,
  });
  const plan2 = planAssignments({
    nodes: [node('no-a', 2), node('no-b', 4)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: cams(6),
    previous: plan1,
    now: T0 + 60_000,
  });
  assertPlanIsSane(plan2);
  assert.equal(plan2.stats.migrations, 1, 'só a câmera excedente sai do nó encolhido');
  assert.equal(plan2.migrations[0].from, 'no-a');
  assert.equal(plan2.migrations[0].reason, 'capacity');
});

test('estabilidade: o PRIMEIRO plano confirma o registro existente e migra ZERO', () => {
  const item = {
    id: 'cli-x',
    computeNodes: [
      { id: 'no-a', role: 'primary', capacity: 8, cameras: ['cam-01', 'cam-02'] },
      { id: 'no-b', role: 'worker', capacity: 8, cameras: ['cam-03'] },
    ],
  };
  const plan = scheduler.planForInstallation(item, { now: T0 });
  assertPlanIsSane(plan);
  assert.deepEqual(plan.migrations, [], 'plano inicial não pode mexer no que já está gravando');
  assert.deepEqual(mapOf(plan), { 'cam-01': 'no-a', 'cam-02': 'no-a', 'cam-03': 'no-b' });
  assert.equal(plan.installationId, 'cli-x');
});

// ── 4) NÓ ÚNICO ─────────────────────────────────────────────────────────────
test('nó único: tudo cai nele, sem migração — e continua assim ao replanejar', () => {
  const entrada = {
    nodes: [node('no-unico', 10, 'primary')],
    nodeStates: alive(['no-unico']),
    workloads: cams(5),
    now: T0,
  };
  const plan1 = planAssignments(entrada);
  assertPlanIsSane(plan1);
  assert.equal(plan1.assignments.length, 5);
  assert.ok(plan1.assignments.every((a) => a.nodeId === 'no-unico'));
  assert.deepEqual(plan1.migrations, []);

  const plan2 = planAssignments({ ...entrada, previous: plan1, now: T0 + 60_000 });
  assert.deepEqual(plan2.migrations, [], 'frota de 1 nó nunca migra nada');
  assert.deepEqual(mapOf(plan2), mapOf(plan1));
});

test('nó único MORTO: as cargas ficam sem nó (não se atribui a um nó morto)', () => {
  const plan1 = planAssignments({
    nodes: [node('no-unico', 10)],
    nodeStates: alive(['no-unico']),
    workloads: cams(2),
    now: T0,
  });
  const plan2 = planAssignments({
    nodes: [node('no-unico', 10)],
    nodeStates: { 'no-unico': { lastSeenAt: iso(T0 - 3600_000) } },
    workloads: cams(2),
    previous: plan1,
    now: T0,
  });
  assertPlanIsSane(plan2);
  assert.deepEqual(plan2.assignments, []);
  assert.equal(plan2.unassigned.length, 2);
  assert.ok(plan2.unassigned.every((u) => u.reason === 'node_dead'));
  assert.equal(plan2.revoked.length, 2, 'lease do nó morto é revogado mesmo sem destino');
});

// ── 5) FAILOVER ─────────────────────────────────────────────────────────────
test('failover DENTE: nó sem heartbeat além do limiar é morto e suas cargas são redistribuídas', () => {
  const nodes = [node('no-a', 8), node('no-b', 8), node('no-c', 8)];
  const plan1 = planAssignments({ nodes, nodeStates: alive(['no-a', 'no-b', 'no-c']), workloads: cams(6), now: T0 });
  const doNoB = plan1.nodes.find((n) => n.id === 'no-b').cameras;
  assert.ok(doNoB.length > 0);

  const agora = T0 + 600_000;
  const plan2 = planAssignments({
    nodes,
    nodeStates: {
      'no-a': { lastSeenAt: iso(agora) },
      'no-b': { lastSeenAt: iso(agora - 601_000) }, // silencioso há 10min
      'no-c': { lastSeenAt: iso(agora) },
    },
    workloads: cams(6),
    previous: plan1,
    now: agora,
    config: { nodeDeadAfterSeconds: 180 },
  });
  assertPlanIsSane(plan2);
  assert.equal(plan2.nodes.find((n) => n.id === 'no-b').health, 'dead');
  assert.equal(plan2.nodes.find((n) => n.id === 'no-b').load, 0, 'nó morto não segura carga nenhuma');
  assert.equal(plan2.stats.unassigned, 0, 'havia folga: ninguém pode ficar sem gravar');
  assert.deepEqual(plan2.migrations.map((m) => m.cameraId).sort(), doNoB.slice().sort());
  assert.ok(plan2.migrations.every((m) => m.from === 'no-b' && m.reason === 'node_dead'));
  // As câmeras que NÃO estavam no nó morto não se mexeram.
  for (const [cameraId, nodeId] of Object.entries(mapOf(plan1))) {
    if (doNoB.includes(cameraId)) continue;
    assert.equal(mapOf(plan2)[cameraId], nodeId, `câmera ${cameraId} migrou à toa`);
  }
  // O lease anterior do nó morto foi INVALIDADO, com o token antigo registrado.
  assert.deepEqual(plan2.revoked.map((r) => r.cameraId).sort(), doNoB.slice().sort());
  const tokensAntigos = new Map(plan1.assignments.map((a) => [a.cameraId, a.token]));
  for (const r of plan2.revoked) {
    assert.equal(r.nodeId, 'no-b');
    assert.equal(r.token, tokensAntigos.get(r.cameraId));
    assert.equal(r.reason, 'node_dead');
  }
});

test('failover: `status:down` explícito mata o nó mesmo com heartbeat fresco', () => {
  const plan = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: { 'no-a': { lastSeenAt: iso(T0), status: 'down' }, 'no-b': { lastSeenAt: iso(T0) } },
    workloads: cams(4),
    now: T0,
  });
  assert.equal(plan.nodes.find((n) => n.id === 'no-a').health, 'dead');
  assert.ok(plan.assignments.every((a) => a.nodeId === 'no-b'));
});

test('failover: nó que NUNCA reportou (unknown) é tratado como VIVO — falta de dado não derruba frota', () => {
  const plan = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: {},
    workloads: cams(4),
    now: T0,
  });
  assert.ok(plan.nodes.every((n) => n.health === 'unknown'));
  assert.equal(plan.stats.assigned, 4, 'sem telemetria de nó o scheduler ainda planeja');
  assert.equal(plan.stats.dead, 0);
});

test('failover: nó REMOVIDO do registro tem as cargas recolocadas (reason node_removed)', () => {
  const plan1 = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: cams(4),
    now: T0,
  });
  const plan2 = planAssignments({
    nodes: [node('no-a', 8)],
    nodeStates: alive(['no-a']),
    workloads: cams(4),
    previous: plan1,
    now: T0 + 60_000,
  });
  assertPlanIsSane(plan2);
  assert.ok(plan2.migrations.every((m) => m.from === 'no-b' && m.to === 'no-a' && m.reason === 'node_removed'));
  assert.equal(plan2.stats.assigned, 4);
});

// ── 6) DRENAGEM ─────────────────────────────────────────────────────────────
test('drenagem DENTE: nó em drain solta no máximo `drainBatch` cargas por replanejamento', () => {
  const anterior = { 'cam-01': 'no-a', 'cam-02': 'no-a', 'cam-03': 'no-a', 'cam-04': 'no-a' };
  const entrada = (previous, now) => ({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: { 'no-a': { lastSeenAt: iso(now), draining: true }, 'no-b': { lastSeenAt: iso(now) } },
    workloads: cams(4),
    previous,
    now,
    config: { drainBatch: 2 },
  });

  const plan1 = planAssignments(entrada(anterior, T0));
  assertPlanIsSane(plan1);
  assert.equal(plan1.nodes.find((n) => n.id === 'no-a').health, 'draining');
  assert.equal(plan1.stats.migrations, 2, 'drenagem é GRADUAL: não derruba os 4 streams de uma vez');
  assert.equal(loadOf(plan1)['no-a'], 2);
  assert.equal(loadOf(plan1)['no-b'], 2);
  assert.ok(plan1.migrations.every((m) => m.from === 'no-a' && m.to === 'no-b' && m.reason === 'draining'));

  const plan2 = planAssignments(entrada(plan1, T0 + 60_000));
  assertPlanIsSane(plan2);
  assert.equal(plan2.stats.migrations, 2);
  assert.equal(loadOf(plan2)['no-a'], 0, 'segundo ciclo termina a drenagem');
  assert.equal(loadOf(plan2)['no-b'], 4);

  const plan3 = planAssignments(entrada(plan2, T0 + 120_000));
  assert.deepEqual(plan3.migrations, [], 'nó já vazio não gera mais migração');
});

test('drenagem: nó drenando NÃO recebe carga nova', () => {
  const plan = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: { 'no-a': { lastSeenAt: iso(T0), draining: true }, 'no-b': { lastSeenAt: iso(T0) } },
    workloads: cams(3),
    now: T0,
  });
  assert.ok(plan.assignments.every((a) => a.nodeId === 'no-b'));
});

test('drenagem: SEM destino disponível a carga FICA no nó drenando (nunca órfã à toa)', () => {
  const plan = planAssignments({
    nodes: [node('no-a', 8)],
    nodeStates: { 'no-a': { lastSeenAt: iso(T0), draining: true } },
    workloads: cams(2),
    previous: { 'cam-01': 'no-a', 'cam-02': 'no-a' },
    now: T0,
    config: { drainBatch: 2 },
  });
  assertPlanIsSane(plan);
  assert.equal(plan.stats.assigned, 2, 'drenar sem para onde ir não pode derrubar gravação');
  assert.ok(plan.assignments.every((a) => a.nodeId === 'no-a'));
  assert.deepEqual(plan.migrations, []);
});

test('drenagem: failover tem PRIORIDADE — a folga vai primeiro para quem perdeu o nó', () => {
  const anterior = { 'cam-01': 'no-a', 'cam-02': 'no-b', 'cam-03': 'no-b' };
  const plan = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8), node('no-c', 1)],
    nodeStates: {
      'no-a': { lastSeenAt: iso(T0), draining: true },
      'no-b': { lastSeenAt: iso(T0 - 3600_000) }, // morto
      'no-c': { lastSeenAt: iso(T0) },
    },
    workloads: cams(3),
    previous: anterior,
    now: T0,
    config: { drainBatch: 2 },
  });
  assertPlanIsSane(plan);
  // Só há 1 vaga (no-c cap 1): ela é do failover, não da drenagem.
  assert.equal(loadOf(plan)['no-c'], 1);
  const destino = mapOf(plan);
  assert.equal(destino['cam-01'], 'no-a', 'a carga do nó drenando ficou onde estava (sem vaga)');
  assert.equal(plan.stats.unassigned, 1, 'a outra carga do nó morto ficou sem nó — e isso é reportado');
});

// ── 7) FENCING ──────────────────────────────────────────────────────────────
test('fencing DENTE: nó zumbi com token ANTIGO é REJEITADO; o dono atual é aceito', () => {
  const plan1 = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: alive(['no-a', 'no-b']),
    workloads: ['cam-01'],
    now: T0,
  });
  assert.equal(plan1.assignments[0].nodeId, 'no-a');
  const tokenAntigo = plan1.assignments[0].token;

  // no-a morre; a câmera vai para no-b com token NOVO.
  const agora = T0 + 600_000;
  const plan2 = planAssignments({
    nodes: [node('no-a', 8), node('no-b', 8)],
    nodeStates: { 'no-a': { lastSeenAt: iso(T0) }, 'no-b': { lastSeenAt: iso(agora) } },
    workloads: ['cam-01'],
    previous: plan1,
    now: agora,
  });
  const atual = plan2.assignments[0];
  assert.equal(atual.nodeId, 'no-b');
  assert.ok(atual.token > tokenAntigo, 'trocar de dono TEM de emitir token maior');

  // O zumbi volta achando que ainda é dono:
  const zumbi = leases.checkFencing(plan2, { cameraId: 'cam-01', nodeId: 'no-a', token: tokenAntigo, now: iso(agora) });
  assert.equal(zumbi.accepted, false, 'DOIS nós gravando a mesma câmera = gravação corrompida');
  assert.equal(zumbi.reason, 'stale_token');
  assert.equal(zumbi.current.nodeId, 'no-b');

  // O dono legítimo, com o token vigente, é aceito.
  const dono = leases.checkFencing(plan2, { cameraId: 'cam-01', nodeId: 'no-b', token: atual.token, now: iso(agora) });
  assert.equal(dono.accepted, true);
  assert.equal(dono.reason, 'ok');
});

test('fencing: token antigo é rejeitado mesmo vindo do nó CERTO (houve troca de dono no meio)', () => {
  const plan = {
    assignments: [{ cameraId: 'cam-01', nodeId: 'no-a', token: 7, leaseExpiresAt: iso(T0 + 60_000) }],
  };
  assert.equal(leases.checkFencing(plan, { cameraId: 'cam-01', nodeId: 'no-a', token: 6, now: iso(T0) }).reason, 'stale_token');
  assert.equal(leases.checkFencing(plan, { cameraId: 'cam-01', nodeId: 'no-a', token: 8, now: iso(T0) }).reason, 'future_token');
  assert.equal(leases.checkFencing(plan, { cameraId: 'cam-01', nodeId: 'no-b', token: 7, now: iso(T0) }).reason, 'wrong_node');
  assert.equal(leases.checkFencing(plan, { cameraId: 'cam-99', nodeId: 'no-a', token: 7, now: iso(T0) }).reason, 'unknown_camera');
  assert.equal(leases.checkFencing(null, { cameraId: 'cam-01', nodeId: 'no-a', token: 7 }).reason, 'no_plan');
  assert.equal(leases.checkFencing(plan, { cameraId: 'cam-01', nodeId: 'no-a' }).reason, 'invalid_claim');
  assert.equal(leases.checkFencing(plan, { cameraId: 'cam-01', nodeId: 'no-a', token: 7, now: iso(T0) }).accepted, true);
});

test('fencing: lease EXPIRADO não é aceito nem com o token certo', () => {
  const plan = {
    assignments: [{ cameraId: 'cam-01', nodeId: 'no-a', token: 3, leaseExpiresAt: iso(T0) }],
  };
  assert.equal(leases.checkFencing(plan, { cameraId: 'cam-01', nodeId: 'no-a', token: 3, now: iso(T0) }).reason, 'lease_expired');
  assert.equal(leases.checkFencing(plan, { cameraId: 'cam-01', nodeId: 'no-a', token: 3, now: iso(T0 - 1) }).accepted, true);
});

test('fencing: tokens NUNCA são reaproveitados — nem os de câmeras que saíram do plano', () => {
  const nodes = [node('no-a', 8), node('no-b', 8)];
  const states = alive(['no-a', 'no-b']);
  const plan1 = planAssignments({ nodes, nodeStates: states, workloads: cams(4), now: T0 });
  const maiorToken1 = leases.maxIssuedToken(plan1);

  // Câmera some do inventário…
  const plan2 = planAssignments({ nodes, nodeStates: states, workloads: cams(3), previous: plan1, now: T0 + 1000 });
  // …e volta: tem de receber token NOVO, nunca o antigo.
  const plan3 = planAssignments({ nodes, nodeStates: states, workloads: cams(4), previous: plan2, now: T0 + 2000 });
  const voltou = plan3.assignments.find((a) => a.cameraId === 'cam-04');
  assert.ok(voltou.token > maiorToken1, 'reemitir token seria abrir a porta para o zumbi');
  assert.equal(leases.tokensAreMonotonic(plan1, plan2), true);
  assert.equal(leases.tokensAreMonotonic(plan2, plan3), true);
  assert.ok(plan3.nextToken > plan2.nextToken);
});

// ── 8) FLAG (default DESLIGADO) ─────────────────────────────────────────────
test('flag: o default é DESLIGADO e só "true"/"1" explícito liga', () => {
  assert.equal(DEFAULT_SCHEDULER_CONFIG.enabled, false);
  assert.equal(schedulerConfigFromEnv({}).enabled, false);
  assert.equal(schedulerConfigFromEnv({ DRAC_CENTRAL_SCHEDULER_ENABLED: '' }).enabled, false);
  assert.equal(schedulerConfigFromEnv({ DRAC_CENTRAL_SCHEDULER_ENABLED: 'sim' }).enabled, false);
  assert.equal(schedulerConfigFromEnv({ DRAC_CENTRAL_SCHEDULER_ENABLED: 'on' }).enabled, false);
  assert.equal(schedulerConfigFromEnv({ DRAC_CENTRAL_SCHEDULER_ENABLED: 'false' }).enabled, false);
  assert.equal(schedulerConfigFromEnv({ DRAC_CENTRAL_SCHEDULER_ENABLED: 'true' }).enabled, true);
  assert.equal(schedulerConfigFromEnv({ DRAC_CENTRAL_SCHEDULER_ENABLED: 'TRUE' }).enabled, true);
  assert.equal(schedulerConfigFromEnv({ DRAC_CENTRAL_SCHEDULER_ENABLED: '1' }).enabled, true);
});

test('config: valores inválidos caem no default; resolve é idempotente', () => {
  const c = resolveSchedulerConfig({ leaseTtlSeconds: 'x', nodeDeadAfterSeconds: -5, defaultNodeCapacity: null, drainBatch: 0 });
  assert.equal(c.leaseTtlSeconds, DEFAULT_SCHEDULER_CONFIG.leaseTtlSeconds);
  assert.equal(c.nodeDeadAfterSeconds, DEFAULT_SCHEDULER_CONFIG.nodeDeadAfterSeconds);
  assert.equal(c.defaultNodeCapacity, DEFAULT_SCHEDULER_CONFIG.defaultNodeCapacity);
  assert.equal(c.drainBatch, 0, 'drainBatch 0 é legítimo: congela a drenagem');
  assert.deepEqual(resolveSchedulerConfig(c), c);
});

// ── 9) COLA COM O REGISTRO DA INSTALAÇÃO ────────────────────────────────────
test('registro: cargas saem da união das câmeras dos nós; sem câmeras, plano vazio', () => {
  assert.deepEqual(
    scheduler.workloadsFromInstallation({ computeNodes: [{ id: 'a', role: 'primary', cameras: ['c2', 'c1'] }, { id: 'b', role: 'worker', cameras: ['c3'] }] }),
    [{ id: 'c1', weight: 1 }, { id: 'c2', weight: 1 }, { id: 'c3', weight: 1 }],
  );
  const vazio = scheduler.planForInstallation({ id: 'x', computeNodes: [{ id: 'a', role: 'primary' }] }, { now: T0 });
  assert.deepEqual(vazio.assignments, []);
  assert.deepEqual(vazio.unassigned, []);
  assert.equal(vazio.stats.workloads, 0);
});

test('registro: instalação SEM nós (single-primary implícito) gera plano sem nós e cargas sem destino', () => {
  const plan = scheduler.planForInstallation({ id: 'x' }, { now: T0, workloads: ['cam-01'] });
  assert.deepEqual(plan.nodes, []);
  assert.equal(plan.stats.unassigned, 1);
});

test('registro: teto de cargas protege o data file (erro de USO, não 500)', () => {
  assert.throws(
    () => scheduler.planForInstallation({ id: 'x' }, { now: T0, workloads: cams(5), config: { maxWorkloads: 4 } }),
    (error) => error.code === 'too_many_workloads',
  );
});

test('planView: leitura pura — sem plano salvo, `planned:false`; e ela NÃO escreve nada', () => {
  const item = { id: 'x', computeNodes: [{ id: 'a', role: 'primary', capacity: 4, cameras: ['cam-01'] }] };
  const antes = JSON.stringify(item);
  const view = scheduler.planView(item);
  assert.equal(view.planned, false);
  assert.equal(view.plan, null);
  assert.equal(view.stale, true, 'há carga no registro e nenhum plano: precisa replanejar');
  assert.deepEqual(view.workloads, ['cam-01']);
  assert.equal(view.nodes.total, 1);
  assert.equal(JSON.stringify(item), antes, 'consultar o plano não pode mutar o registro');

  item[scheduler.PLAN_FIELD] = scheduler.planForInstallation(item, { now: T0 });
  const view2 = scheduler.planView(item);
  assert.equal(view2.planned, true);
  assert.equal(view2.stale, false);
  assert.equal(view2.plan.assignments.length, 1);

  item.computeNodes[0].cameras = ['cam-01', 'cam-02'];
  assert.equal(scheduler.planView(item).stale, true, 'carga nova no registro ⇒ plano salvo está velho');
});

test('registro: o plano salvo é JSON puro (viaja verbatim pelo payload jsonb/JSON)', () => {
  const item = {
    id: 'x',
    computeNodes: [{ id: 'a', role: 'primary', capacity: 4, cameras: ['cam-01', 'cam-02'] }],
  };
  const plan = scheduler.planForInstallation(item, { now: T0 });
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, 'round-trip JSON idêntico');
});
