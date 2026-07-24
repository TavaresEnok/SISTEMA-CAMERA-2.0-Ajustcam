import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrometheus, type Metric } from '../src/observability/prometheus.helper';

// D7 (2.3): exposição /metrics no formato Prometheus (puro, sem dependência nova).

test('D7 métricas: emite HELP/TYPE uma vez e o valor', () => {
  const out = formatPrometheus([{ name: 'drac_up', help: 'API viva', type: 'gauge', value: 1 }]);
  assert.match(out, /# HELP drac_up API viva/);
  assert.match(out, /# TYPE drac_up gauge/);
  assert.match(out, /^drac_up 1$/m);
});

test('D7 métricas: HELP/TYPE declarados UMA vez para séries com labels', () => {
  const metrics: Metric[] = [
    { name: 'drac_camera_up', help: 'câmera viva', type: 'gauge', value: 1, labels: { cameraId: 'a' } },
    { name: 'drac_camera_up', help: 'câmera viva', type: 'gauge', value: 0, labels: { cameraId: 'b' } },
  ];
  const out = formatPrometheus(metrics);
  assert.equal((out.match(/# TYPE drac_camera_up/g) ?? []).length, 1, 'TYPE só pode aparecer uma vez');
  assert.match(out, /drac_camera_up\{cameraId="a"\} 1/);
  assert.match(out, /drac_camera_up\{cameraId="b"\} 0/);
});

test('D7 métricas: NUNCA emite NaN/Infinity (quebraria o scraper)', () => {
  const out = formatPrometheus([
    { name: 'ok', help: 'h', type: 'gauge', value: 5 },
    { name: 'nan', help: 'h', type: 'gauge', value: NaN },
    { name: 'inf', help: 'h', type: 'gauge', value: Infinity },
  ]);
  assert.match(out, /^ok 5$/m);
  assert.equal(out.includes('nan'), false);
  assert.equal(out.includes('inf'), false);
});

test('D7 métricas: escapa aspas/barra nos labels', () => {
  const out = formatPrometheus([{ name: 'm', help: 'h', type: 'gauge', value: 1, labels: { path: 'a"b\\c' } }]);
  assert.match(out, /path="a\\"b\\\\c"/);
});
