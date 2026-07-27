import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { envNumber, parseFiniteNumber } from '../src/common/config/env-number.helper';

// ── O modo de falha que este helper existe para matar ────────────────────────
// `Number(process.env.X ?? 92)` vira NaN com "92%" — e NaN NÃO explode: ele
// desarma comparações em silêncio. Na guarda de disco isso significava disco a
// 100% com TODAS as câmeras parando, sem um erro no log. Falha ABERTA.

test('typo comum NÃO vira NaN: cai no default e AVISA', () => {
  const avisos: string[] = [];
  for (const ruim of ['92%', 'noventa', '', '  ', 'abc', '9 2', '92px']) {
    const v = envNumber('X', 92, { onInvalid: (m) => avisos.push(m) }, { X: ruim });
    assert.equal(v, 92, `"${ruim}" deveria cair no default`);
    assert.ok(Number.isFinite(v));
  }
  // Vazio/espaço é ausência, não erro do operador — não polui o log.
  assert.equal(avisos.length, 5, `avisos: ${avisos.length}`);
});

test('variável AUSENTE usa o default sem avisar (caso normal no boot)', () => {
  const avisos: string[] = [];
  assert.equal(envNumber('X', 30, { onInvalid: (m) => avisos.push(m) }, {}), 30);
  assert.deepEqual(avisos, []);
});

test('aceita vírgula decimal (o .env é escrito por humano brasileiro)', () => {
  assert.equal(envNumber('X', 1, {}, { X: '92,5' }), 92.5);
});

test('piso e teto são aplicados (setInterval nunca recebe valor absurdo)', () => {
  assert.equal(envNumber('X', 30_000, { min: 10_000 }, { X: '5' }), 10_000);
  assert.equal(envNumber('X', 92, { min: 1, max: 100 }, { X: '900' }), 100);
});

test('NUNCA devolve NaN, nem com default inválido', () => {
  for (const raw of ['abc', undefined, 'NaN', 'Infinity', '-Infinity']) {
    const v = envNumber('X', Number.NaN, {}, { X: raw as string });
    assert.ok(Number.isFinite(v), `raw=${raw} devolveu ${v}`);
  }
});

test('parseFiniteNumber rejeita prefixo numérico (não esconde o typo)', () => {
  assert.equal(parseFiniteNumber('92%'), null, 'aceitar o 92 esconderia o erro do operador');
  assert.equal(parseFiniteNumber('92'), 92);
  assert.equal(parseFiniteNumber(Infinity), null);
});

// ── Os call sites que já sangraram ──────────────────────────────────────────
test('guarda de disco e retenção NÃO usam Number() cru em env', () => {
  const rpm = readFileSync('src/recordings/recording-process-manager.service.ts', 'utf8');
  assert.doesNotMatch(rpm, /Number\(process\.env\.RECORDING_DISK_GUARD_MAX_USED_PERCENT/,
    'NaN aqui desarma a guarda e o disco enche a 100%');
  assert.doesNotMatch(rpm, /Math\.max\([\d_]+, Number\(process\.env\.RECORDING_DISK_GUARD_INTERVAL_MS/,
    'Math.max(n, NaN) = NaN, e setInterval(NaN) dispara em rajada');
  assert.match(rpm, /envNumber\('RECORDING_DISK_GUARD_MAX_USED_PERCENT'/);
  assert.match(rpm, /envNumber\('RECORDING_DISK_GUARD_INTERVAL_MS'/);

  const ret = readFileSync('src/recordings/retention.service.ts', 'utf8');
  assert.match(ret, /envNumber\('RECORDING_RETENTION_DAYS'/, 'dias 0/NaN apagaria o acervo inteiro');
});
