import test from 'node:test';
import assert from 'node:assert/strict';
import { envBool, parseBooleanish } from '../src/common/config/env-number.helper';

// ── O modo de falha que envBool existe para matar ────────────────────────────
// `String(process.env.X ?? 'true') !== 'false'` aceita QUALQUER lixo como
// verdadeiro, e `=== 'true'` recusa qualquer coisa que não seja exatamente
// "true". Nos dois casos o operador escreve algo no .env, o sistema IGNORA e
// NINGUÉM é avisado — o mesmo silêncio do NaN, só que em booleano.
//
//   MEDIAMTX_ENABLED=0   → hoje continua LIGADO (o operador jura que desligou).
//   FFMPEG_..._FALLBACK=TRUE → hoje continua DESLIGADO (jura que ligou).
//
// A regra aqui: grafias universais de sim/não são HONRADAS; o que não for
// reconhecido cai no default seguro e AVISA.

test('grafias universais de verdadeiro são honradas (inclusive maiúsculas)', () => {
  for (const raw of ['1', 'true', 'TRUE', 'True', 't', 'yes', 'YES', 'y', 'on', 'ON', ' true ']) {
    assert.equal(envBool('X', false, {}, { X: raw }), true, `"${raw}" deveria ser verdadeiro`);
  }
});

test('grafias universais de falso são honradas — "0" desliga de verdade', () => {
  for (const raw of ['0', 'false', 'FALSE', 'f', 'no', 'NO', 'n', 'off', 'OFF', ' false ']) {
    assert.equal(envBool('X', true, {}, { X: raw }), false, `"${raw}" deveria ser falso`);
  }
});

test('lixo NÃO vira verdadeiro por acidente: cai no default e AVISA', () => {
  for (const fallback of [true, false]) {
    for (const raw of ['sim', 'nao', 'talvez', '2', 'ligado', 'enabled']) {
      const avisos: string[] = [];
      const value = envBool('X', fallback, { onInvalid: (m) => avisos.push(m) }, { X: raw });
      assert.equal(value, fallback, `"${raw}" deveria cair no default ${fallback}`);
      assert.equal(avisos.length, 1, `"${raw}" precisa AVISAR o operador`);
      assert.match(avisos[0], /X="?/);
    }
  }
});

test('variável ausente ou vazia usa o default sem poluir o log do boot', () => {
  const avisos: string[] = [];
  assert.equal(envBool('X', true, { onInvalid: (m) => avisos.push(m) }, {}), true);
  assert.equal(envBool('X', false, { onInvalid: (m) => avisos.push(m) }, { X: '' }), false);
  assert.equal(envBool('X', true, { onInvalid: (m) => avisos.push(m) }, { X: '   ' }), true);
  assert.deepEqual(avisos, [], 'ausência é o caso normal, não erro do operador');
});

test('parseBooleanish devolve null para o desconhecido (nunca chuta)', () => {
  assert.equal(parseBooleanish('sim'), null);
  assert.equal(parseBooleanish(undefined), null);
  assert.equal(parseBooleanish(''), null);
  assert.equal(parseBooleanish('true'), true);
  assert.equal(parseBooleanish('off'), false);
  assert.equal(parseBooleanish(true), true, 'booleano já resolvido passa direto');
  assert.equal(parseBooleanish(false), false);
  assert.equal(parseBooleanish(1), null, 'número não é booleano de ambiente');
});

test('o retorno é SEMPRE booleano — nunca string, nunca undefined', () => {
  for (const raw of ['true', 'lixo', undefined, '']) {
    const value = envBool('X', false, {}, { X: raw as string });
    assert.equal(typeof value, 'boolean', `raw=${raw} devolveu ${typeof value}`);
  }
});
