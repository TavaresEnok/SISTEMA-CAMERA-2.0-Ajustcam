import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// REINÍCIO IMEDIATO DO FFMPEG DE GRAVAÇÃO MORTO.
//
// Antes: a morte do processo só era notada pelo health-check (limiar de
// estagnação + cron de 60s) — até ~7 MINUTOS de gravação perdida por câmera, por
// morte. O Frigate supervisiona DENTRO do processo, num laço de 1s
// (frigate/video/ffmpeg.py: `if not self.capture_thread.is_alive()` →
// `reset_capture_thread()`, com pacing por `last_restart_time`).
//
// Aqui o gatilho é a própria saída do processo (evento `close`/`error`), então a
// detecção é instantânea. As duas invariantes que NÃO podem quebrar:
//   1. parada PEDIDA (stop, post-roll de movimento, shutdown) JAMAIS reinicia —
//      reiniciar o que o operador mandou parar é pior que o bug original;
//   2. teto de tentativas em janela deslizante (freio anti-tempestade, mesmo
//      espírito do BRAKE_ do mediamtx-proxy), senão uma câmera morta de verdade
//      vira um loop de ffmpeg queimando CPU de TODAS as outras.
// ─────────────────────────────────────────────────────────────────────────────

const CAM = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reinício "imediato" de verdade nos testes: 1ms de backoff, sem esperar segundos. */
const FAST_BACKOFF = {
  RECORDING_AUTO_RESTART_BASE_DELAY_MS: '1',
  RECORDING_AUTO_RESTART_MAX_DELAY_MS: '1',
};

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    cameraId: CAM,
    process: { exitCode: 1 },
    startedAt: new Date(),
    outputDir: '/rec/out',
    cameraRootDir: '/rec',
    outputPattern: '/rec/out/%Y.ts',
    segmentSeconds: 60,
    pid: 4242,
    watcher: setTimeout(() => {}, 0),
    knownFiles: new Set<string>(),
    scanInFlight: null,
    finalizePromise: null,
    ...overrides,
  } as any;
}

/**
 * Gerenciador com as bordas reais preservadas: `finalizeRecordingState`,
 * `scheduleRecordingRestart` e a decisão de backoff são os do serviço. Só I/O
 * (disco, banco, spawn) é substituído — e `start` registra o que foi pedido.
 */
function makeManager(overrides: Record<string, unknown> = {}) {
  const svc: any = Object.create(RecordingProcessManagerService.prototype);
  svc.logger = { warn() {}, log() {}, debug() {}, error() {} };
  svc.controlMode = 'local';
  svc.shuttingDown = false;
  svc.active = new Map();
  svc.restartAttempts = new Map();
  svc.restartTimers = new Map();
  svc.scanAndRegister = async () => undefined;
  svc.prisma = {
    camera: { findUnique: async () => ({ recordingEnabled: true, enabled: true }) },
  };
  svc.starts = [] as Array<{ cameraId: string; segmentSeconds: number }>;
  svc.start = async (cameraId: string, segmentSeconds: number) => {
    svc.starts.push({ cameraId, segmentSeconds });
    svc.active.set(cameraId, makeState());
    return { status: 'recording_started', cameraId, segmentSeconds };
  };
  Object.assign(svc, overrides);
  return svc;
}

/** Mata o processo de forma ANORMAL (sem pedido de parada) e espera o reinício. */
async function crash(mgr: any, state: any, code: number | null = 1) {
  mgr.active.set(CAM, state);
  await mgr.finalizeRecordingState(CAM, state, code);
  await delay(20);
}

// ── 1. Morte anormal reinicia ────────────────────────────────────────────────

test('queda: morte ANORMAL do ffmpeg de gravação reinicia a gravação imediatamente', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    const mgr = makeManager();
    await crash(mgr, makeState({ segmentSeconds: 60 }));

    assert.equal(mgr.starts.length, 1, 'morte não pedida TEM de reiniciar a gravação');
    assert.equal(mgr.starts[0].cameraId, CAM);
    assert.equal(mgr.starts[0].segmentSeconds, 60, 'reinicia com o MESMO tamanho de segmento');
  });
});

test('queda: reinício acontece sem depender do health-check (janela de ms, não de minutos)', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    const mgr = makeManager();
    const antes = Date.now();
    await crash(mgr, makeState());
    assert.equal(mgr.starts.length, 1);
    assert.ok(Date.now() - antes < 5_000, 'o reinício não pode esperar o cron de 60s do health-check');
  });
});

// ── 2. Parada PEDIDA nunca reinicia ──────────────────────────────────────────

test('queda: parada PEDIDA (stopRequested) NÃO reinicia — nem uma vez', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    const mgr = makeManager();
    const state = makeState({ stopRequested: true, process: { exitCode: 0 } });
    await crash(mgr, state, 0);

    assert.equal(mgr.starts.length, 0, 'reiniciar o que o operador mandou parar é pior que o bug');
  });
});

test('queda: o agendador REJEITA um estado com stopRequested mesmo se chamado direto', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    const mgr = makeManager();
    mgr.scheduleRecordingRestart(CAM, makeState({ stopRequested: true }), 0);
    await delay(20);

    assert.equal(mgr.restartTimers.size, 0, 'nenhum reinício pode ficar agendado para uma parada pedida');
    assert.equal(mgr.starts.length, 0);
  });
});

test('queda: POST-ROLL de movimento (banco já com recordingEnabled=false) NÃO reinicia', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    // stop() grava recordingEnabled=false ANTES de matar o processo: mesmo que a
    // marca em memória se perdesse, o estado DESEJADO no banco veta o reinício.
    const mgr = makeManager({
      prisma: { camera: { findUnique: async () => ({ recordingEnabled: false, enabled: true }) } },
    });
    await crash(mgr, makeState());

    assert.equal(mgr.starts.length, 0, 'o post-roll de movimento não pode ser ressuscitado');
  });
});

test('queda: câmera DESATIVADA não é ressuscitada pelo reinício automático', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    const mgr = makeManager({
      prisma: { camera: { findUnique: async () => ({ recordingEnabled: true, enabled: false }) } },
    });
    await crash(mgr, makeState());

    assert.equal(mgr.starts.length, 0);
  });
});

test('queda: durante o SHUTDOWN da aplicação não há reinício', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    const mgr = makeManager({ shuttingDown: true });
    await crash(mgr, makeState());

    assert.equal(mgr.starts.length, 0, 'desligar a API não pode disparar gravações novas');
  });
});

test('queda: no modo WORKER (gravação delegada) o reinício local não se aplica', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    const mgr = makeManager({ controlMode: 'worker' });
    await crash(mgr, makeState());

    assert.equal(mgr.starts.length, 0);
  });
});

test('queda: a flag RECORDING_AUTO_RESTART_ENABLED=false devolve o comportamento antigo', async () => {
  await withEnv({ ...FAST_BACKOFF, RECORDING_AUTO_RESTART_ENABLED: 'false' }, async () => {
    const mgr = makeManager();
    await crash(mgr, makeState());

    assert.equal(mgr.starts.length, 0, 'a válvula de desligamento precisa funcionar de verdade');
  });
});

test('queda: stop() cancela um reinício já agendado (a parada vence a corrida)', async () => {
  await withEnv({ RECORDING_AUTO_RESTART_BASE_DELAY_MS: '60', RECORDING_AUTO_RESTART_MAX_DELAY_MS: '60' }, async () => {
    const mgr = makeManager({
      camerasService: { getCameraOrThrow: async () => ({ id: CAM }) },
      resolveRecordingModeUpdate: async () => ({}),
      stopProcessAndWait: async () => undefined,
    });
    mgr.prisma.camera.update = async () => ({});

    await crash(mgr, makeState(), 1);
    assert.equal(mgr.starts.length, 0, 'pré-condição: o reinício ainda está no forno (60ms)');
    assert.equal(mgr.restartTimers.size, 1);

    await mgr.stop(CAM);
    await delay(120);

    assert.equal(mgr.starts.length, 0, 'depois do stop() o reinício agendado não pode disparar');
    assert.equal(mgr.restartTimers.size, 0);
  });
});

// ── 3. Backoff e teto ────────────────────────────────────────────────────────

test('backoff: o atraso DOBRA a cada tentativa e satura no teto', async () => {
  await withEnv(
    {
      RECORDING_AUTO_RESTART_BASE_DELAY_MS: '1000',
      RECORDING_AUTO_RESTART_MAX_DELAY_MS: '4000',
      RECORDING_AUTO_RESTART_MAX_ATTEMPTS: '6',
      RECORDING_AUTO_RESTART_WINDOW_MS: '600000',
    },
    () => {
      const mgr = makeManager();
      let agora = 1_000_000;
      mgr.nowMs = () => agora;

      const atrasos: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const plano = mgr.planRecordingRestart(CAM);
        assert.equal(plano.allowed, true, `tentativa ${i + 1} deveria ser permitida`);
        atrasos.push(plano.delayMs);
        agora += 1_000;
      }

      assert.deepEqual(atrasos, [1000, 2000, 4000, 4000, 4000, 4000], 'backoff exponencial saturando no teto');
    },
  );
});

test('teto: estourado o número de tentativas na janela, o freio ARMA e para de reiniciar', async () => {
  await withEnv(
    {
      RECORDING_AUTO_RESTART_BASE_DELAY_MS: '1000',
      RECORDING_AUTO_RESTART_MAX_ATTEMPTS: '5',
      RECORDING_AUTO_RESTART_WINDOW_MS: '600000',
    },
    () => {
      const mgr = makeManager();
      let agora = 1_000_000;
      mgr.nowMs = () => agora;

      for (let i = 0; i < 5; i += 1) {
        assert.equal(mgr.planRecordingRestart(CAM).allowed, true, `tentativa ${i + 1} ainda dentro do teto`);
        agora += 1_000;
      }
      assert.equal(mgr.planRecordingRestart(CAM).allowed, false, 'a 6ª tentativa na janela tem de ser FREADA');
      assert.equal(mgr.planRecordingRestart(CAM).allowed, false, 'e continua freada');
    },
  );
});

test('teto: janela DESLIZANTE — tentativas velhas não contam (câmera intermitente não fica presa)', async () => {
  await withEnv(
    {
      RECORDING_AUTO_RESTART_BASE_DELAY_MS: '1000',
      RECORDING_AUTO_RESTART_MAX_ATTEMPTS: '5',
      RECORDING_AUTO_RESTART_WINDOW_MS: '600000',
    },
    () => {
      const mgr = makeManager();
      let agora = 1_000_000;
      mgr.nowMs = () => agora;

      for (let i = 0; i < 5; i += 1) {
        mgr.planRecordingRestart(CAM);
        agora += 1_000;
      }
      assert.equal(mgr.planRecordingRestart(CAM).allowed, false, 'pré-condição: freio armado');

      agora += 600_001; // a janela inteira passou
      const depois = mgr.planRecordingRestart(CAM);
      assert.equal(depois.allowed, true, 'passada a janela, a câmera volta a poder ser reiniciada');
      assert.equal(depois.delayMs, 1000, 'e o backoff recomeça do início');
    },
  );
});

test('teto: no fluxo REAL de quedas em série, o reinício para no limite configurado', async () => {
  await withEnv({ ...FAST_BACKOFF, RECORDING_AUTO_RESTART_MAX_ATTEMPTS: '3' }, async () => {
    const mgr = makeManager();
    for (let i = 0; i < 6; i += 1) {
      await crash(mgr, makeState());
    }

    assert.equal(mgr.starts.length, 3, 'seis quedas seguidas não podem virar seis ffmpeg — o freio existe');
  });
});

test('queda: dois eventos de morte da MESMA gravação agendam UM reinício só', async () => {
  await withEnv({ RECORDING_AUTO_RESTART_BASE_DELAY_MS: '80', RECORDING_AUTO_RESTART_MAX_DELAY_MS: '80' }, async () => {
    const mgr = makeManager();
    const state = makeState();
    mgr.active.set(CAM, state);
    // `close` e `error` podem disparar para o mesmo processo.
    await mgr.finalizeRecordingState(CAM, state, 1);
    await mgr.finalizeRecordingState(CAM, state, 1);
    await delay(150);

    assert.equal(mgr.starts.length, 1, 'close + error na mesma morte é UM reinício');
  });
});

test('queda: se outra gravação já assumiu a câmera, o reinício desiste', async () => {
  await withEnv({ RECORDING_AUTO_RESTART_BASE_DELAY_MS: '60', RECORDING_AUTO_RESTART_MAX_DELAY_MS: '60' }, async () => {
    const mgr = makeManager();
    await crash(mgr, makeState(), 1);
    // ...mas nesse meio tempo o health-check (ou o operador) já subiu outra.
    mgr.active.set(CAM, makeState());
    await delay(120);

    assert.equal(mgr.starts.length, 0, 'não pode existir DOIS ffmpeg gravando a mesma câmera');
  });
});

test('queda: falha do start() no reinício é registrada e não derruba o processo da API', async () => {
  await withEnv(FAST_BACKOFF, async () => {
    const erros: string[] = [];
    const mgr = makeManager({
      start: async () => {
        throw new Error('disco cheio');
      },
    });
    mgr.logger = { warn() {}, log() {}, debug() {}, error: (m: string) => erros.push(m) };

    await crash(mgr, makeState());
    assert.equal(erros.length, 1, 'a falha do reinício tem de aparecer no log');
    assert.match(erros[0], /disco cheio/);
  });
});

// ── 4. Invariante de origem: a gravação NÃO pode ser rebaixada de prioridade ──

test('prioridade: o ffmpeg de GRAVAÇÃO continua em prioridade normal (nunca sob nice)', () => {
  const src = readFileSync('src/recordings/recording-process-manager.service.ts', 'utf8');
  assert.match(
    src,
    /spawnWithSecretUrl\(\s*'ffmpeg',\s*args,\s*rtspUrl/,
    'a gravação precisa iniciar o ffmpeg diretamente pelo canal privado da URL',
  );
  assert.doesNotMatch(src, /spawn\('nice'/, 'rebaixar a prioridade da GRAVAÇÃO seria o oposto do objetivo');
  assert.doesNotMatch(src, /planLowPriorityCommand/, 'o caminho de gravação não usa o plano de prioridade baixa');
});
