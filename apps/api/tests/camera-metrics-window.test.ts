import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CameraMetricsService,
  CAMERA_METRICS_MAX_CAMERAS,
  CAMERA_METRICS_MAX_EVENTS_PER_SERIES,
} from '../src/observability/camera-metrics.service';

// ─────────────────────────────────────────────────────────────────────────────
// Registro em memória por câmera (contrato A/B da observabilidade).
// Invariantes provados aqui:
//  1. JANELA DESLIZANTE de 1h: evento velho SAI da contagem sozinho.
//  2. MEMÓRIA LIMITADA: nem os eventos por câmera nem o nº de câmeras crescem
//     sem teto (o processo da API vive meses em produção).
//  3. Os contadores CUMULATIVOS (_total do Prometheus) são monotônicos e NÃO
//     são afetados pela poda — um counter que cai quebra rate()/increase().
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function withClock() {
  let now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const svc = new CameraMetricsService(() => now);
  return {
    svc,
    advance(ms: number) { now += ms; },
    set(ms: number) { now = ms; },
    get now() { return now; },
  };
}

test('janela 1h: evento de 2h atrás NÃO conta; de 10min atrás CONTA', () => {
  const clock = withClock();
  clock.svc.recordSegment('cam-1'); // t0 (vai virar "2h atrás")
  clock.advance(2 * HOUR - 10 * MIN);
  clock.svc.recordSegment('cam-1'); // "10 min atrás" no fim
  clock.advance(10 * MIN);

  const snap = clock.svc.snapshot('cam-1');
  assert.equal(snap.segmentsLastHour, 1, 'só o segmento dos últimos 10min pode contar');
  assert.equal(snap.segmentsTotal, 2, 'o total cumulativo NÃO é afetado pela janela');
});

test('janela 1h: vale para reinícios e recuperações também', () => {
  const clock = withClock();
  clock.svc.recordRecordingRestart('cam-1');
  clock.svc.recordStreamRecovery('cam-1');
  clock.advance(90 * MIN);
  assert.equal(clock.svc.snapshot('cam-1').restartsLastHour, 0);
  assert.equal(clock.svc.snapshot('cam-1').recoveriesLastHour, 0);

  clock.svc.recordRecordingRestart('cam-1');
  clock.svc.recordStreamRecovery('cam-1');
  assert.equal(clock.svc.snapshot('cam-1').restartsLastHour, 1);
  assert.equal(clock.svc.snapshot('cam-1').recoveriesLastHour, 1);
  assert.equal(clock.svc.snapshot('cam-1').restartsTotal, 2, 'counter cumulativo não regride');
  assert.equal(clock.svc.snapshot('cam-1').recoveriesTotal, 2, 'counter cumulativo não regride');
});

test('marca-d’água: lastSegmentAt SOBREVIVE à saída do evento da janela', () => {
  const clock = withClock();
  const at = clock.now;
  clock.svc.recordSegment('cam-1');
  clock.advance(3 * HOUR);
  const snap = clock.svc.snapshot('cam-1');
  assert.equal(snap.segmentsLastHour, 0, 'a contagem da janela zera');
  assert.equal(snap.lastSegmentAt?.getTime(), at, 'mas "há quanto tempo não grava" continua conhecido');
});

test('marca-d’água: lastRecoveryAt idem', () => {
  const clock = withClock();
  const at = clock.now;
  clock.svc.recordStreamRecovery('cam-1');
  clock.advance(3 * HOUR);
  assert.equal(clock.svc.snapshot('cam-1').lastRecoveryAt?.getTime(), at);
});

test('poda: série por câmera NÃO cresce além do teto (sem vazamento de memória)', () => {
  const clock = withClock();
  const total = CAMERA_METRICS_MAX_EVENTS_PER_SERIES * 4;
  for (let i = 0; i < total; i++) clock.svc.recordSegment('cam-1'); // todos no mesmo instante (dentro da janela)
  const snap = clock.svc.snapshot('cam-1');
  assert.equal(
    snap.segmentsLastHour,
    CAMERA_METRICS_MAX_EVENTS_PER_SERIES,
    'a contagem satura no teto — a memória por câmera é limitada',
  );
  assert.equal(snap.segmentsTotal, total, 'o total cumulativo continua exato');
  assert.ok(
    clock.svc.debugSeriesLength('cam-1', 'segments') <= CAMERA_METRICS_MAX_EVENTS_PER_SERIES,
    'o array interno não pode passar do teto',
  );
});

test('poda: nº de câmeras rastreadas NÃO cresce sem teto', () => {
  const clock = withClock();
  const extra = 137;
  for (let i = 0; i < CAMERA_METRICS_MAX_CAMERAS + extra; i++) clock.svc.recordSegment(`cam-${i}`);
  assert.equal(clock.svc.size, CAMERA_METRICS_MAX_CAMERAS, 'o mapa satura no teto de câmeras');
  // A eviction descarta as MAIS ANTIGAS, não as recentes.
  assert.equal(clock.svc.snapshot('cam-0').segmentsTotal, 0, 'a câmera mais antiga foi descartada');
  assert.equal(
    clock.svc.snapshot(`cam-${CAMERA_METRICS_MAX_CAMERAS + extra - 1}`).segmentsTotal,
    1,
    'a câmera mais recente permanece',
  );
});

test('câmera desconhecida: snapshot é zerado e não cria entrada (leitura não vaza memória)', () => {
  const clock = withClock();
  const snap = clock.svc.snapshot('nunca-vista');
  assert.deepEqual(
    {
      segmentsLastHour: snap.segmentsLastHour,
      restartsLastHour: snap.restartsLastHour,
      recoveriesLastHour: snap.recoveriesLastHour,
      lastSegmentAt: snap.lastSegmentAt,
      lastRecoveryAt: snap.lastRecoveryAt,
    },
    { segmentsLastHour: 0, restartsLastHour: 0, recoveriesLastHour: 0, lastSegmentAt: null, lastRecoveryAt: null },
  );
  assert.equal(clock.svc.size, 0, 'ler métrica de câmera inexistente não pode alocar entrada');
});

test('observeLastSegmentAt: só avança a marca-d’água (NÃO conta como segmento novo)', () => {
  const clock = withClock();
  const past = clock.now - 30 * MIN;
  clock.svc.observeLastSegmentAt('cam-1', new Date(past));
  const snap = clock.svc.snapshot('cam-1');
  assert.equal(snap.lastSegmentAt?.getTime(), past);
  assert.equal(snap.segmentsLastHour, 0, 'semear a partir do banco não pode inflar a contagem da janela');
  assert.equal(snap.segmentsTotal, 0);

  // Nunca RETROCEDE a marca-d’água.
  clock.svc.observeLastSegmentAt('cam-1', new Date(past - HOUR));
  assert.equal(clock.svc.snapshot('cam-1').lastSegmentAt?.getTime(), past, 'marca-d’água não retrocede');
});

test('à prova de falha: entrada inválida NUNCA lança (métrica não pode derrubar gravação)', () => {
  const clock = withClock();
  assert.doesNotThrow(() => clock.svc.recordSegment(undefined as any));
  assert.doesNotThrow(() => clock.svc.recordSegment(''));
  assert.doesNotThrow(() => clock.svc.recordRecordingRestart(null as any));
  assert.doesNotThrow(() => clock.svc.recordStreamRecovery(123 as any));
  assert.doesNotThrow(() => clock.svc.observeLastSegmentAt('cam-1', undefined));
  assert.doesNotThrow(() => clock.svc.observeLastSegmentAt('cam-1', new Date('nao-e-data')));
  assert.equal(clock.svc.size, 0, 'ids inválidos não criam entradas');
});

test('snapshotAll/knownCameraIds refletem só as câmeras com eventos', () => {
  const clock = withClock();
  clock.svc.recordSegment('cam-a');
  clock.svc.recordStreamRecovery('cam-b');
  assert.deepEqual(clock.svc.knownCameraIds().sort(), ['cam-a', 'cam-b']);
  assert.equal(clock.svc.snapshotAll().length, 2);
});
