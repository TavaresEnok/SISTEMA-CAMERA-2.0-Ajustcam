import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MediamtxProxyService } from '../src/camera-stream/mediamtx-proxy.service';
import { cameraMetrics } from '../src/observability/camera-metrics.service';

// ─────────────────────────────────────────────────────────────────────────────
// FREIO ANTI-TEMPESTADE do watchdog de stream.
//
// Técnica derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
// (frigate/watchdog.py: MAX_RESTARTS / RESTART_WINDOW_S + is_restarting_too_fast).
//
// Problema real: câmera MORTA (fonte offline, roteador queimado, obra na rua) →
// o watchdog reconfigura o path a cada ~80s PARA SEMPRE. Cada reset é um DELETE
// na API do MediaMTX + ffprobe + FFmpeg novo: CPU queimada 24/7 por uma câmera
// que não vai voltar sozinha.
//
// A diferença deliberada em relação ao Frigate: aqui o freio SÓ arma quando a
// recuperação é FÚTIL. Se o path volta a progredir (bytes crescendo), a janela é
// zerada — uma câmera que realmente se recupera JAMAIS é freada. Falso positivo
// que deixa câmera boa sem live é pior que o problema original.
// ─────────────────────────────────────────────────────────────────────────────

const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);
const PATH_A = `cam_${HEX_A}`;
const PATH_B = `cam_${HEX_B}`;
const CAM_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeProxy() {
  let now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const logs: string[] = [];
  let ensureCalls = 0;
  const config = { get: () => undefined } as any;
  const mgr = new MediamtxProxyService(config, {} as any, {} as any, {} as any) as any;
  const record = (message: unknown) => logs.push(String(message));
  mgr.logger = { error: record, warn: record, log: record, debug() {} };
  // Relógio injetado: o freio inteiro decide por tempo, então o teste manda no tempo.
  mgr.nowMs = () => now;
  mgr.invalidateMainCodecCache = () => {};
  mgr.apiRequest = async () => '';
  mgr.ensurePathForCamera = async () => { ensureCalls += 1; };
  return {
    mgr,
    logs,
    recoveries: () => ensureCalls,
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}

beforeEach(() => cameraMetrics.reset());

test('freio: 5 recuperações FÚTEIS dentro da janela armam o freio — a 6ª não acontece', async () => {
  const h = makeProxy();
  // 5 tentativas espaçadas ~1,5min (6 min no total): cabem na janela de 10 min.
  for (let i = 0; i < 5; i += 1) {
    await h.mgr.recoverStuckPath(PATH_A, false, 1);
    h.advance(90_000);
  }
  assert.equal(h.recoveries(), 5, 'as 5 primeiras tentativas devem acontecer normalmente');

  await h.mgr.recoverStuckPath(PATH_A, false, 1);
  assert.equal(h.recoveries(), 5, 'a 6ª tentativa tem de ser BLOQUEADA pelo freio (resfriamento)');
});

test('freio: reinícios ESPAÇADOS (fora da janela) nunca armam o freio', async () => {
  const h = makeProxy();
  // 12 recuperações, uma a cada 11 min: nenhuma janela de 10 min junta 5.
  for (let i = 0; i < 12; i += 1) {
    await h.mgr.recoverStuckPath(PATH_A, false, 1);
    h.advance(11 * 60_000);
  }
  assert.equal(h.recoveries(), 12, 'câmera que cai de vez em quando continua sendo recuperada');
  // E o freio nem pode ter ARMADO no caminho: armar dispara alerta ("a fonte não
  // volta sozinha, manda alguém no local") — acusar disso uma câmera que cai a
  // cada 11 min é chamado falso, e chamado falso destrói a confiança no alerta.
  assert.equal(cameraMetrics.snapshot(CAM_A).brakesTotal, 0, 'nenhum freio pode ter armado');
  assert.equal(h.mgr.recoveryBrake.get(PATH_A)?.level ?? 0, 0, 'nenhum escalonamento pode ter acontecido');
  assert.ok(
    !h.logs.some((line) => /FREIO ANTI-TEMPESTADE/i.test(line)),
    `nada de alerta de freio para câmera intermitente; logs: ${JSON.stringify(h.logs)}`,
  );
});

test('freio: o resfriamento CRESCE a cada vez e a recuperação volta depois dele', async () => {
  const h = makeProxy();
  const armar = async () => {
    for (let i = 0; i < 5; i += 1) {
      await h.mgr.recoverStuckPath(PATH_A, false, 1);
      h.advance(1_000);
    }
  };

  // 1º freio: base de 2 min.
  await armar();
  const after1 = h.recoveries();
  h.advance(114_000); // ~119s desde o 1º reset: ainda dentro dos 2 min do freio
  await h.mgr.recoverStuckPath(PATH_A, false, 1);
  assert.equal(h.recoveries(), after1, 'ainda dentro do 1º resfriamento (2 min): nada de tentar');

  h.advance(6_000); // passou dos 2 min
  await h.mgr.recoverStuckPath(PATH_A, false, 1);
  assert.equal(h.recoveries(), after1 + 1, 'terminado o resfriamento, o watchdog VOLTA a tentar');

  // 2º freio: mais 4 tentativas (a de cima já conta como a 1ª da janela nova).
  for (let i = 0; i < 4; i += 1) {
    h.advance(1_000);
    await h.mgr.recoverStuckPath(PATH_A, false, 1);
  }
  const after2 = h.recoveries();
  h.advance(121_000);
  await h.mgr.recoverStuckPath(PATH_A, false, 1);
  assert.equal(after2, h.recoveries(), 'o 2º resfriamento é MAIOR que o 1º (2 min já não bastam)');

  h.advance(121_000); // total > 4 min
  await h.mgr.recoverStuckPath(PATH_A, false, 1);
  assert.equal(h.recoveries(), after2 + 1, 'passados os 4 min do 2º resfriamento, tenta de novo');
});

test('freio: arma com log VISÍVEL e métrica POR CÂMERA (o operador precisa enxergar)', async () => {
  const h = makeProxy();
  for (let i = 0; i < 5; i += 1) {
    await h.mgr.recoverStuckPath(PATH_A, false, 1);
    h.advance(1_000);
  }

  const snapshot = cameraMetrics.snapshot(CAM_A);
  assert.equal(snapshot.brakesTotal, 1, 'armar o freio precisa virar métrica da câmera');
  assert.equal(snapshot.brakesLastHour, 1, 'e cair na janela de 1h lida pelo /metrics');
  assert.ok(
    h.logs.some((line) => /FREIO ANTI-TEMPESTADE/i.test(line)),
    `o freio precisa gritar no log; logs vistos: ${JSON.stringify(h.logs)}`,
  );
});

test('freio: é POR PATH — travar uma câmera não pode calar a recuperação de outra', async () => {
  const h = makeProxy();
  for (let i = 0; i < 5; i += 1) {
    await h.mgr.recoverStuckPath(PATH_A, false, 1);
    h.advance(1_000);
  }
  const antes = h.recoveries();
  await h.mgr.recoverStuckPath(PATH_A, false, 1);
  assert.equal(h.recoveries(), antes, 'A está freada');
  await h.mgr.recoverStuckPath(PATH_B, false, 1);
  assert.equal(h.recoveries(), antes + 1, 'B é outra câmera: não herda o freio de A');
});

test('freio: path que VOLTA A PROGREDIR zera a janela — câmera curada nunca é freada', async () => {
  const h = makeProxy();
  const recoverReal = h.mgr.recoverStuckPath.bind(h.mgr);

  // 4 tentativas (uma abaixo do limite), espaçadas 1 min: 4 min de janela usados.
  for (let i = 0; i < 4; i += 1) {
    await recoverReal(PATH_A, false, 1);
    h.advance(60_000);
  }
  assert.equal(h.recoveries(), 4);

  // Agora o path volta a receber bytes com espectador: o watchdog observa SAÚDE.
  h.mgr.reconcileMissingPaths = async () => {};
  h.mgr.recoverStuckPath = async () => {
    throw new Error('watchdog não pode tocar em path saudável');
  };
  for (const bytes of [1_000, 2_000]) {
    h.mgr.apiRequest = async () => JSON.stringify({
      items: [{ name: PATH_A, ready: true, readers: ['viewer-1'], bytesReceived: bytes }],
    });
    await h.mgr.streamWatchdogTick();
    h.advance(20_000);
  }

  // Mais 4 tentativas coladas: sem o reset seriam 8 na janela → freio na 5ª.
  h.mgr.apiRequest = async () => '';
  for (let i = 0; i < 4; i += 1) {
    await recoverReal(PATH_A, false, 1);
    h.advance(1_000);
  }
  assert.equal(
    h.recoveries(),
    8,
    'progresso real de bytes tem de zerar a contagem: câmera que se recuperou não pode ser freada',
  );
});

test('freio: não vaza memória — estado some quando o path desaparece do MediaMTX', async () => {
  const h = makeProxy();
  for (let i = 0; i < 5; i += 1) {
    await h.mgr.recoverStuckPath(PATH_A, false, 1);
    h.advance(1_000);
  }
  assert.equal(h.mgr.recoveryBrake.size, 1, 'freio armado guarda estado do path');

  h.mgr.reconcileMissingPaths = async () => {};
  h.mgr.apiRequest = async () => JSON.stringify({ items: [] });
  await h.mgr.streamWatchdogTick();
  assert.equal(h.mgr.recoveryBrake.size, 0, 'path removido do MediaMTX não pode deixar estado para trás');
});
