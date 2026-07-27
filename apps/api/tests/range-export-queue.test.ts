import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRangeExportJobId,
  buildRangeExportFileName,
  normalizeRangeExportIdentity,
  planOrphanRecovery,
  rangeExportProgress,
  RANGE_EXPORT_STEPS,
} from '../src/jobs/helpers/range-export-job.helper';

// ─────────────────────────────────────────────────────────────────────────────
// FILA DE EXPORTAÇÃO — parte pura.
//
// Hoje a exportação roda SÍNCRONA no request: três operadores clicando
// "Exportar" disparam três FFmpeg competindo com a GRAVAÇÃO, e um restart do
// servidor perde o trabalho. O Frigate tem fila, mas EM MEMÓRIA
// (`frigate/jobs/export.py`) — some no restart pelo mesmo motivo. Aqui a fila é
// BullMQ (Redis), então o que falta provar é: (a) idempotência por
// (câmera,intervalo,perfil), (b) progresso legível e (c) órfão recuperado.
// ─────────────────────────────────────────────────────────────────────────────

const CAM = 'cam-1';
const FROM = '2026-07-27T10:04:30.000Z';
const TO = '2026-07-27T10:11:00.000Z';

test('idempotência: mesmo (câmera, intervalo, perfil) ⇒ MESMO jobId e MESMO arquivo', () => {
  const a = normalizeRangeExportIdentity({ cameraId: CAM, from: FROM, to: TO, profile: 'auto' });
  const b = normalizeRangeExportIdentity({ cameraId: CAM, from: new Date(FROM), to: new Date(TO) });
  assert.equal(buildRangeExportJobId(a), buildRangeExportJobId(b));
  assert.equal(buildRangeExportFileName(a), buildRangeExportFileName(b));
});

test('idempotência não colapsa o que é diferente (câmera, borda, perfil)', () => {
  const base = normalizeRangeExportIdentity({ cameraId: CAM, from: FROM, to: TO });
  const outraCamera = normalizeRangeExportIdentity({ cameraId: 'cam-2', from: FROM, to: TO });
  const outroSegundo = normalizeRangeExportIdentity({ cameraId: CAM, from: FROM, to: '2026-07-27T10:11:01.000Z' });
  const outroPerfil = normalizeRangeExportIdentity({ cameraId: CAM, from: FROM, to: TO, profile: 'compatible' });

  const ids = new Set([base, outraCamera, outroSegundo, outroPerfil].map(buildRangeExportJobId));
  assert.equal(ids.size, 4, 'exportações diferentes NÃO podem compartilhar job — uma sobrescreveria a prova da outra');
});

test('jobId não usa ":" (BullMQ recusa id com dois-pontos) e é estável no formato', () => {
  const id = buildRangeExportJobId(normalizeRangeExportIdentity({ cameraId: CAM, from: FROM, to: TO }));
  assert.ok(!id.includes(':'), `id inválido para o Redis: ${id}`);
  assert.match(id, /^rex-[0-9a-f]{32}$/);
});

test('o nome do arquivo é derivado da MESMA identidade (dedup também em disco)', () => {
  const identity = normalizeRangeExportIdentity({ cameraId: CAM, from: FROM, to: TO });
  const name = buildRangeExportFileName(identity);
  assert.match(name, /^range-[0-9a-f]{32}\.mp4$/);
  assert.ok(!name.includes('/') && !name.includes('..'), 'nome de arquivo não pode carregar caminho');
});

test('perfil desconhecido cai em "auto" (nunca vira um perfil inventado)', () => {
  const identity = normalizeRangeExportIdentity({ cameraId: CAM, from: FROM, to: TO, profile: 'turbo' as never });
  assert.equal(identity.profile, 'auto');
});

test('identidade rejeita data inválida em vez de virar NaN silencioso', () => {
  assert.throws(
    () => normalizeRangeExportIdentity({ cameraId: CAM, from: 'ontem', to: TO }),
    /data|inv/i,
  );
});

// ── Progresso ────────────────────────────────────────────────────────────────

test('progresso é monotônico do enfileiramento à conclusão', () => {
  const percentuais = RANGE_EXPORT_STEPS.map((step) => rangeExportProgress(step).percent);
  for (let i = 1; i < percentuais.length; i += 1) {
    assert.ok(
      percentuais[i] > percentuais[i - 1],
      `progresso andou para trás em ${RANGE_EXPORT_STEPS[i]}: ${percentuais.join(',')}`,
    );
  }
  assert.equal(rangeExportProgress('queued').percent, 0);
  assert.equal(rangeExportProgress('done').percent, 100);
});

test('progresso distingue copiar de reencodar (o operador precisa saber a espera)', () => {
  assert.equal(rangeExportProgress('copying').step, 'copying');
  assert.equal(rangeExportProgress('encoding').step, 'encoding');
  assert.notEqual(rangeExportProgress('copying').percent, rangeExportProgress('encoding').percent);
});

// ── Recuperação de órfãos ────────────────────────────────────────────────────
// Um restart (deploy, OOM, queda de energia) deixa o job em ACTIVE sem ninguém
// trabalhando nele: ele fica "exportando" para sempre na tela do operador.

const AGORA = Date.parse('2026-07-27T12:00:00.000Z');
const OPCOES = { now: AGORA, staleAfterMs: 120_000, maxAttempts: 3 };

test('job ativo com batimento recente é DEIXADO EM PAZ (está exportando de verdade)', () => {
  const plano = planOrphanRecovery(
    [{ id: 'rex-a', processedOn: AGORA - 600_000, heartbeatAt: AGORA - 5_000, attemptsMade: 0 }],
    OPCOES,
  );
  assert.deepEqual(plano.map((p) => p.action), ['keep']);
});

test('job ativo sem batimento há tempo demais é ÓRFÃO ⇒ reenfileirado', () => {
  const plano = planOrphanRecovery(
    [{ id: 'rex-b', processedOn: AGORA - 600_000, heartbeatAt: AGORA - 600_000, attemptsMade: 0 }],
    OPCOES,
  );
  assert.equal(plano[0].action, 'requeue');
  assert.equal(plano[0].staleForMs, 600_000);
});

test('job ativo SEM batimento nenhum conta como órfão (não fica preso para sempre)', () => {
  const plano = planOrphanRecovery([{ id: 'rex-c', attemptsMade: 0 }], OPCOES);
  assert.equal(plano[0].action, 'requeue');
});

test('job VENENOSO (já derrubou o processo N vezes) é abandonado, não recolocado', () => {
  const plano = planOrphanRecovery(
    [{ id: 'rex-d', processedOn: AGORA - 600_000, attemptsMade: 2 }],
    OPCOES,
  );
  assert.equal(plano[0].action, 'abandon', 'reenfileirar sem limite vira crash-loop da API inteira');
  assert.match(plano[0].reason, /tentativ/i);
});

test('a recuperação avalia cada job por si (um órfão não arrasta o vizinho vivo)', () => {
  const plano = planOrphanRecovery(
    [
      { id: 'vivo', heartbeatAt: AGORA - 1_000, attemptsMade: 0 },
      { id: 'orfao', heartbeatAt: AGORA - 3_600_000, attemptsMade: 0 },
      { id: 'veneno', heartbeatAt: AGORA - 3_600_000, attemptsMade: 5 },
    ],
    OPCOES,
  );
  assert.deepEqual(
    plano.map((p) => [p.id, p.action]),
    [
      ['vivo', 'keep'],
      ['orfao', 'requeue'],
      ['veneno', 'abandon'],
    ],
  );
});

test('janela de órfão inválida não vira NaN (comparação desarmada mataria a guarda)', () => {
  const plano = planOrphanRecovery(
    [{ id: 'rex-e', heartbeatAt: AGORA - 1_000, attemptsMade: 0 }],
    { now: AGORA, staleAfterMs: Number.NaN, maxAttempts: Number.NaN },
  );
  assert.equal(plano[0].action, 'keep', 'com janela inválida o padrão seguro é NÃO mexer no job vivo');
});
