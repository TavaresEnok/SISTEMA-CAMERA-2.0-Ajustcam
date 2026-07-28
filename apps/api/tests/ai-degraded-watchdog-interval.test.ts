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

// ── O COOLDOWN QUE SUSTENTA O TICK DE 30s ────────────────────────────────────
//
// O comentário no topo deste arquivo justifica baixar o tick para 30s assim:
// "tick mais rápido NÃO vira tempestade de restart porque cada recuperação
// continua travada pelo cooldown POR CÂMERA (piso de 2 min)".
//
// Só que o cooldown era lido cru:
//     Math.max(2 * 60_000, Number(process.env.AI_DEGRADED_RECOVERY_COOLDOWN_MS ?? 10 * 60_000))
//
// Com lixo no env, Number(...) = NaN e Math.max(120000, NaN) = NaN. O uso é
// `if (Date.now() - lastAt < cooldownMs) continue;` — e QUALQUER comparação com
// NaN é false, então o `continue` nunca acontece: o cooldown SOME.
//
// Ou seja, um typo em AI_DEGRADED_RECOVERY_COOLDOWN_MS transformava exatamente
// a garantia acima na sua negação — reinício de análise a cada 30s numa câmera
// que já está degradada, com re-resolução de fonte e mexida em path do MediaMTX
// a cada volta. É a mesma família de defeito que já desarmou a guarda de disco.

import {
  AI_DEGRADED_RECOVERY_COOLDOWN_MIN_MS,
  resolveDegradedRecoveryCooldownMs,
} from '../src/ai/ai-manager.service';

function cooldownDoWatchdog(bruto: string | undefined) {
  const anterior = process.env.AI_DEGRADED_RECOVERY_COOLDOWN_MS;
  if (bruto === undefined) delete process.env.AI_DEGRADED_RECOVERY_COOLDOWN_MS;
  else process.env.AI_DEGRADED_RECOVERY_COOLDOWN_MS = bruto;
  try {
    return resolveDegradedRecoveryCooldownMs();
  } finally {
    if (anterior === undefined) delete process.env.AI_DEGRADED_RECOVERY_COOLDOWN_MS;
    else process.env.AI_DEGRADED_RECOVERY_COOLDOWN_MS = anterior;
  }
}

test('cooldown: env com LIXO nunca vira NaN (era isso que apagava o cooldown)', () => {
  for (const lixo of ['abc', '', '   ', 'dez minutos', '10m', '5min', 'null', '92%']) {
    const valor = cooldownDoWatchdog(lixo);
    assert.ok(Number.isFinite(valor), `"${lixo}" produziu valor não-finito: ${valor}`);
    assert.ok(valor >= AI_DEGRADED_RECOVERY_COOLDOWN_MIN_MS, `"${lixo}" ficou abaixo do piso de 2 min: ${valor}`);
  }
});

test('cooldown: o piso de 2 min é REAL — é ele que impede a tempestade a 30s de tick', () => {
  assert.equal(cooldownDoWatchdog('1000'), 2 * 60_000, 'valor menor que o piso tem de ser elevado');
  assert.equal(cooldownDoWatchdog('0'), 2 * 60_000);
  assert.equal(cooldownDoWatchdog('-5000'), 2 * 60_000);
});

test('cooldown: valor válido é respeitado, e a ausência cai no padrão de 10 min', () => {
  assert.equal(cooldownDoWatchdog('600000'), 600_000);
  assert.equal(cooldownDoWatchdog(undefined), 10 * 60_000);
});

test('cooldown: a comparação de fato PULA a recuperação dentro da janela', () => {
  // O uso real é `if (Date.now() - lastAt < cooldownMs) continue;`. Com NaN esta
  // asserção era false e a recuperação rodava a cada tick.
  const cooldownMs = cooldownDoWatchdog('lixo');
  const agora = 1_000_000;
  const ultimaRecuperacao = agora - 30_000; // um tick atrás
  assert.equal(agora - ultimaRecuperacao < cooldownMs, true, 'dentro da janela, a recuperação TEM de ser pulada');
});
