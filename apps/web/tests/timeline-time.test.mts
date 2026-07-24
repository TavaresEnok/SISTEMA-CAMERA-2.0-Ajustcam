import assert from 'node:assert/strict';
import test from 'node:test';
import { minuteOfDay, hmsToMinute } from '../src/lib/timeline-time.ts';

// D4: a Revisão abre o playback no INSTANTE do evento. O playhead é minuto-do-dia
// COM os segundos como fração; arredondar ao minuto erraria até 30s.

test('minuteOfDay preserva os segundos como fração', () => {
  assert.equal(minuteOfDay(new Date(2026, 6, 24, 12, 34, 27)), 754 + 27 / 60);
  assert.equal(minuteOfDay(new Date(2026, 6, 24, 0, 0, 30)), 0.5, '30s = meio minuto');
  assert.equal(minuteOfDay(new Date(2026, 6, 24, 12, 34, 0)), 754, 'sem segundos é o minuto exato');
});

test('hmsToMinute converte HH:mm:ss em minuto fracionário (ss default 0)', () => {
  assert.equal(hmsToMinute(12, 34, 27), 754 + 27 / 60);
  assert.equal(hmsToMinute(1, 0), 60);
});

test('regressão: evento em 12:34:27 é preservado ao segundo (não vira 12:34:00)', () => {
  const seconds = Math.round(minuteOfDay(new Date(2026, 6, 24, 12, 34, 27)) * 60);
  assert.equal(seconds, 12 * 3600 + 34 * 60 + 27, 'o instante em segundos sobrevive ao caminho de navegação');
});
