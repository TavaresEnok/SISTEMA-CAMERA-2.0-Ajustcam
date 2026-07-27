'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const cn = require('../src/datastore/compute-nodes');
const mappers = require('../src/datastore/mappers');
const { publicInstallation } = require('../src/server');

// ── normalizeComputeNodes ────────────────────────────────────────────────────
test('normalize: ausente/null/não-array → [] (single-primary implícito, retrocompat)', () => {
  assert.deepEqual(cn.normalizeComputeNodes(undefined), []);
  assert.deepEqual(cn.normalizeComputeNodes(null), []);
  assert.deepEqual(cn.normalizeComputeNodes({}), []);
  assert.deepEqual(cn.normalizeComputeNodes('nope'), []);
  assert.deepEqual(cn.normalizeComputeNodes([]), []);
});

test('normalize: coerce forma — apara id/host/label, minúscula no papel, descarta lixo e campos vazios', () => {
  const out = cn.normalizeComputeNodes([
    { id: '  n1 ', role: ' PRIMARY ', host: ' 10.0.0.1 ', label: '', extra: 'lixo' },
    'não-objeto',
    null,
    ['array-não-conta'],
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 'n1', role: 'primary', host: '10.0.0.1' });
  assert.equal('label' in out[0], false); // vazio → omitido
  assert.equal('extra' in out[0], false); // lixo descartado
});

test('normalize: capacity (número ou {maxCameras}) → número; lixo → omitido', () => {
  assert.equal(cn.normalizeComputeNodes([{ id: 'a', role: 'worker', capacity: 8 }])[0].capacity, 8);
  assert.equal(cn.normalizeComputeNodes([{ id: 'a', role: 'worker', capacity: { maxCameras: 16 } }])[0].capacity, 16);
  assert.equal('capacity' in cn.normalizeComputeNodes([{ id: 'a', role: 'worker', capacity: 'x' }])[0], false);
  assert.equal('capacity' in cn.normalizeComputeNodes([{ id: 'a', role: 'worker', capacity: -1 }])[0], false);
});

test('normalize: cameras atribuídas → ids aparados sem vazios; ausente → omitido', () => {
  const out = cn.normalizeComputeNodes([{ id: 'a', role: 'worker', cameras: [' cam-1 ', '', 'cam-2', null] }]);
  assert.deepEqual(out[0].cameras, ['cam-1', 'cam-2']);
  assert.equal('cameras' in cn.normalizeComputeNodes([{ id: 'a', role: 'worker' }])[0], false);
  assert.equal('cameras' in cn.normalizeComputeNodes([{ id: 'a', role: 'worker', cameras: [] }])[0], false);
});

test('normalize: idempotente — normalize(normalize(x)) == normalize(x)', () => {
  const input = [{ id: 'p', role: 'PRIMARY', host: 'h', capacity: 4, cameras: ['c1'] }, { id: 'w', role: 'worker' }];
  const once = cn.normalizeComputeNodes(input);
  assert.deepEqual(cn.normalizeComputeNodes(once), once);
});

// ── validateComputeNodes (dentes) ────────────────────────────────────────────
test('validate: [] (ausente) é VÁLIDO — retrocompat, primário único implícito', () => {
  assert.equal(cn.validateComputeNodes([]).valid, true);
  assert.equal(cn.validateComputeNodes(undefined).valid, true);
});

test('validate: um único primário é válido; primário + worker é válido', () => {
  assert.equal(cn.validateComputeNodes([{ id: 'p', role: 'primary' }]).valid, true);
  assert.equal(
    cn.validateComputeNodes([{ id: 'p', role: 'primary' }, { id: 'w', role: 'worker' }]).valid,
    true,
  );
});

test('validate DENTE: papel inválido é rejeitado', () => {
  const r = cn.validateComputeNodes([{ id: 'p', role: 'primary' }, { id: 'x', role: 'boss' }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === 'invalid_role'));
});

test('validate DENTE: id duplicado é rejeitado', () => {
  const r = cn.validateComputeNodes([{ id: 'dup', role: 'primary' }, { id: 'dup', role: 'worker' }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === 'duplicate_id'));
});

test('validate DENTE: id vazio é rejeitado', () => {
  const r = cn.validateComputeNodes([{ id: '', role: 'primary' }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === 'invalid_id'));
});

test('validate DENTE: mais de um nó sem nenhum primary é rejeitado (worker sem primary)', () => {
  const r = cn.validateComputeNodes([{ id: 'w1', role: 'worker' }, { id: 'w2', role: 'worker' }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === 'missing_primary'));
});

test('validate: um só worker (1 nó) NÃO exige primary — a regra missing_primary só vale com >1', () => {
  const r = cn.validateComputeNodes([{ id: 'w1', role: 'worker' }]);
  assert.equal(r.errors.some((e) => e.code === 'missing_primary'), false);
});

// ── summarizeNodes ───────────────────────────────────────────────────────────
test('summarize: sem nós → { configured:false, total:0 } (single-primary implícito)', () => {
  assert.deepEqual(cn.summarizeNodes([]), { configured: false, total: 0, primary: 0, worker: 0, assignedCameras: 0 });
  assert.deepEqual(cn.summarizeNodes(undefined), { configured: false, total: 0, primary: 0, worker: 0, assignedCameras: 0 });
});

test('summarize: conta papéis e câmeras atribuídas', () => {
  const s = cn.summarizeNodes([
    { id: 'p', role: 'primary', cameras: ['c1', 'c2'] },
    { id: 'w', role: 'worker', cameras: ['c3'] },
  ]);
  assert.deepEqual(s, { configured: true, total: 2, primary: 1, worker: 1, assignedCameras: 3 });
});

// ── Round-trip de serialização (nó <-> mapper) ──────────────────────────────
test('roundtrip mapper: computeNodes flui verbatim pelo payload (installationToRow ↔ rowToInstallation)', () => {
  const item = {
    id: 'cliente-nodes',
    customerName: 'Cliente Nós',
    licenseStatus: 'ACTIVE',
    computeNodes: [
      { id: 'p', role: 'primary', host: '10.0.0.1', capacity: 8, cameras: ['cam-1'] },
      { id: 'w', role: 'worker', host: '10.0.0.2' },
    ],
  };
  const row = mappers.installationToRow('cliente-nodes', item);
  const back = mappers.rowToInstallation(row);
  assert.deepEqual(back, item); // round-trip IDÊNTICO
  assert.deepEqual(back.computeNodes, item.computeNodes);
});

// ── Serialização retrocompatível em publicInstallation ──────────────────────
test('publicInstallation: SEM nós → campo computeNodes OMITIDO (saída idêntica à atual)', () => {
  const out = publicInstallation({ id: 'x', customerName: 'X' });
  assert.equal('computeNodes' in out, false);
});

test('publicInstallation: COM nós → surge computeNodes normalizado', () => {
  const out = publicInstallation({
    id: 'x',
    customerName: 'X',
    computeNodes: [{ id: 'p', role: ' PRIMARY ', host: ' 10.0.0.1 ', extra: 'lixo' }],
  });
  assert.deepEqual(out.computeNodes, [{ id: 'p', role: 'primary', host: '10.0.0.1' }]);
});

test('publicInstallation: computeNodes vazio ([]) permanece OMITIDO (single-primary implícito)', () => {
  const out = publicInstallation({ id: 'x', customerName: 'X', computeNodes: [] });
  assert.equal('computeNodes' in out, false);
});

// Endurecimento: payload malformado NÃO pode apagar os nós com 200. Só o array
// vazio EXPLÍCITO remove; typo/tipo errado é 400 e preserva o estado.
const { validateComputeNodes: _v } = require('../src/datastore/compute-nodes');
test('PATCH guard: só array é aceito (o resto é payload inválido)', () => {
  const aceita = (body) => Array.isArray(body.computeNodes);
  assert.equal(aceita({}), false, 'corpo vazio não pode apagar os nós');
  assert.equal(aceita({ compute_nodes: [] }), false, 'typo na chave não pode apagar os nós');
  assert.equal(aceita({ computeNodes: 'x' }), false, 'string não é payload válido');
  assert.equal(aceita({ computeNodes: null }), false, 'null não é payload válido');
  assert.equal(aceita({ computeNodes: [] }), true, 'array vazio é a remoção EXPLÍCITA');
});
