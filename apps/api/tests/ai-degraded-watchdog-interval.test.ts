import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_DEGRADED_WATCHDOG_DEFAULT_INTERVAL_MS,
  AI_DEGRADED_WATCHDOG_MIN_INTERVAL_MS,
  AiManagerService,
  resolveDegradedWatchdogIntervalMs,
} from '../src/ai/ai-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// Watchdog de processadores de IA DEGRADADOS: com 120s, um detector cego (fonte
// trocou por baixo dele) só era percebido depois de 2 ciclos = 4 MINUTOS de
// câmera armada sem detectar movimento — ou seja, sem gravar. A 30s o mesmo
// diagnóstico sai em 1 minuto.
//
// Por que baixar é seguro: a frequência do TICK não é a frequência da AÇÃO. Cada
// recuperação continua travada pelo cooldown POR CÂMERA em tempo absoluto
// (AI_DEGRADED_RECOVERY_COOLDOWN_MS, piso de 2 min; 5 min para processador
// ausente), então tick mais rápido NÃO vira tempestade de restart — só encurta a
// DETECÇÃO. O custo por tick é um GET /health no ai-service.
//
// O piso antigo (Math.max(60_000, Number(env ?? 120_000))) tinha um defeito
// silencioso: env com lixo → Number('abc') = NaN → Math.max(60_000, NaN) = NaN →
// setInterval(NaN) dispara a cada ~1ms. O resolvedor abaixo fecha esse buraco.
// ─────────────────────────────────────────────────────────────────────────────

test('intervalo: o default detecta 4x mais rápido que os 120s antigos', () => {
  assert.equal(AI_DEGRADED_WATCHDOG_DEFAULT_INTERVAL_MS, 30_000);
  assert.equal(resolveDegradedWatchdogIntervalMs(undefined), 30_000);
  assert.ok(
    AI_DEGRADED_WATCHDOG_DEFAULT_INTERVAL_MS * 4 <= 120_000,
    'o objetivo declarado é detectar ~4x mais rápido que os 120s',
  );
});

test('intervalo: env explícito é respeitado', () => {
  assert.equal(resolveDegradedWatchdogIntervalMs('45000'), 45_000);
  assert.equal(resolveDegradedWatchdogIntervalMs('300000'), 300_000);
});

test('intervalo: piso protege o ai-service de martelada', () => {
  assert.equal(resolveDegradedWatchdogIntervalMs('1'), AI_DEGRADED_WATCHDOG_MIN_INTERVAL_MS);
  assert.equal(resolveDegradedWatchdogIntervalMs('9999'), AI_DEGRADED_WATCHDOG_MIN_INTERVAL_MS);
  assert.ok(AI_DEGRADED_WATCHDOG_MIN_INTERVAL_MS >= 10_000, 'o piso não pode ser irrisório');
});

test('intervalo: valor INVÁLIDO cai no default (nunca NaN — setInterval(NaN) = tempestade)', () => {
  for (const raw of ['abc', '', '   ', '-5', '0', 'NaN', 'Infinity', null, undefined]) {
    const value = resolveDegradedWatchdogIntervalMs(raw as any);
    assert.ok(Number.isFinite(value), `entrada ${JSON.stringify(raw)} produziu valor não finito: ${value}`);
    assert.equal(value, AI_DEGRADED_WATCHDOG_DEFAULT_INTERVAL_MS, `entrada ${JSON.stringify(raw)} deveria cair no default`);
  }
});

test('wiring: onModuleInit agenda o watchdog de degradados no intervalo resolvido', async () => {
  const svc: any = Object.create(AiManagerService.prototype);
  svc.logger = { log() {}, warn() {}, error() {}, debug() {} };
  svc.degradedStrikes = new Map();
  svc.lastDegradedRecoveryAt = new Map();

  const intervals: number[] = [];
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const envAutoStart = process.env.AI_AUTO_START_ENABLED;
  const envInterval = process.env.AI_DEGRADED_WATCHDOG_INTERVAL_MS;
  (globalThis as any).setInterval = (_fn: unknown, ms: number) => {
    intervals.push(ms);
    return { unref() {} };
  };
  (globalThis as any).setTimeout = () => ({ unref() {} });
  try {
    process.env.AI_AUTO_START_ENABLED = 'true';
    delete process.env.AI_DEGRADED_WATCHDOG_INTERVAL_MS;
    await svc.onModuleInit();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    if (envAutoStart === undefined) delete process.env.AI_AUTO_START_ENABLED;
    else process.env.AI_AUTO_START_ENABLED = envAutoStart;
    if (envInterval === undefined) delete process.env.AI_DEGRADED_WATCHDOG_INTERVAL_MS;
    else process.env.AI_DEGRADED_WATCHDOG_INTERVAL_MS = envInterval;
  }

  assert.deepEqual(
    intervals,
    [AI_DEGRADED_WATCHDOG_DEFAULT_INTERVAL_MS],
    'o watchdog precisa ser agendado exatamente uma vez, no intervalo resolvido',
  );
});
