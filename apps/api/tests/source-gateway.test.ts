import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SourceGatewayService,
  computeBackoffDelayMs,
  type RtspTransport,
} from '../src/camera-stream/source-gateway.service';

// ─────────────────────────────────────────────────────────────────────────────
// Fase 3 — Source Gateway: REGISTRO e ROTEAMENTO da origem por câmera/perfil.
//
// O que estes testes protegem, em ordem de importância:
//  1. INVARIANTE DE PRODUÇÃO: com CAMERA_SOURCE_GATEWAY_ENABLED desligado
//     (default), resolveSourceUrl devolve EXATAMENTE a URL direta de hoje e o
//     registro NÃO ganha estado. Ligar o módulo não pode mudar nada.
//  2. Refcount: dois consumidores = UMA origem; o último release é que libera.
//  3. Máquina de estados: ONLINE→STALLED sem progresso, BACKOFF com jitter
//     dentro do intervalo, circuit breaker que ABRE e FECHA.
//  4. Teto de conexões externas por câmera, com a decisão observável.
//
// Sem I/O: nada aqui abre RTSP, ffmpeg ou MediaMTX — o gateway é registro/decisão.
// ─────────────────────────────────────────────────────────────────────────────

const CAM = '11111111-2222-3333-4444-555555555555';
const CAM_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DIRECT_MAIN = 'rtsp://admin:s3nh4%40@10.0.0.20:554/Streaming/Channels/101';
const DIRECT_SUB = 'rtsp://admin:s3nh4%40@10.0.0.20:554/Streaming/Channels/102';
const INTERNAL_MAIN = 'rtsp://mtxuser:mtxpass@mediamtx:8554/cam_1111222233334444555555555555';
const INTERNAL_SUB = 'rtsp://mtxuser:mtxpass@mediamtx:8554/cam_1111222233334444555555555555_grid';

type Harness = {
  gw: SourceGatewayService;
  advance: (ms: number) => void;
  now: () => number;
  recoveries: string[];
};

const SILENT_LOGGER = { error() {}, warn() {}, log() {}, debug() {}, verbose() {} };

function makeGateway(overrides: Record<string, unknown> = {}, random: () => number = () => 0.5): Harness {
  const cfg: Record<string, unknown> = { cameraSourceGatewayEnabled: false, ...overrides };
  const configService = { get: (key: string) => cfg[key] } as any;
  const gw = new SourceGatewayService(configService);
  let clock = 1_700_000_000_000;
  const recoveries: string[] = [];
  gw.configureSeams({
    clock: () => clock,
    random,
    metrics: {
      recordStreamRecovery(cameraId: string) {
        recoveries.push(cameraId);
      },
    },
  });
  (gw as any).logger = SILENT_LOGGER;
  return {
    gw,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    recoveries,
  };
}

function enabled(overrides: Record<string, unknown> = {}, random?: () => number) {
  return makeGateway({ cameraSourceGatewayEnabled: true, ...overrides }, random);
}

// ── 1. INVARIANTE: flag OFF = comportamento de hoje, byte a byte ─────────────

test('G1 INVARIANTE: flag OFF → resolveSourceUrl devolve EXATAMENTE a URL direta de hoje', () => {
  const h = makeGateway(); // default: desligado

  // Mesmo com o gateway "pronto" (fonte publicada + tráfego), nada muda.
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  h.gw.noteConnecting(CAM, 'main');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  const lease = h.gw.acquire(CAM, 'main', 'recording');

  const decision = h.gw.resolveSourceUrl({
    cameraId: CAM,
    profile: 'main',
    consumer: 'recording',
    directUrl: DIRECT_MAIN,
    internalUrl: INTERNAL_MAIN,
  });

  assert.equal(decision.url, DIRECT_MAIN, 'a URL tem de ser a MESMA string de hoje');
  assert.equal(decision.origin, 'direct');
  assert.equal(decision.reason, 'gateway_disabled');
  assert.equal(decision.servedProfile, 'main');
  assert.equal(lease.gatewayEnabled, false);
  assert.equal(h.gw.snapshotAll().length, 0, 'flag OFF não cria estado no registro');
  assert.equal(h.gw.externalConnections(CAM), 0);
  assert.deepEqual(h.recoveries, [], 'flag OFF não emite métrica alguma');
  lease.release(); // release de lease inerte não pode explodir
});

test('G1 INVARIANTE: flag OFF em TODOS os perfis/consumidores, inclusive com sub publicado', () => {
  const h = makeGateway();
  // Cenário MAIS favorável possível ao gateway: os dois perfis publicados,
  // adquiridos e com tráfego. Mesmo assim, flag OFF = tudo direto na câmera.
  for (const profile of ['main', 'sub'] as const) {
    h.gw.registerPublishedSource(CAM, profile, profile === 'main' ? INTERNAL_MAIN : INTERNAL_SUB);
    h.gw.acquire(CAM, profile, 'live');
    h.gw.noteProgress(CAM, profile, { transport: 'tcp' });
  }
  for (const consumer of ['recording', 'ai', 'live', 'prebuffer', 'poster'] as const) {
    for (const [profile, direct] of [['main', DIRECT_MAIN], ['sub', DIRECT_SUB]] as const) {
      const d = h.gw.resolveSourceUrl({ cameraId: CAM, profile, consumer, directUrl: direct, internalUrl: INTERNAL_SUB });
      assert.equal(d.url, direct, `${consumer}/${profile} tem de continuar direto na câmera`);
      assert.equal(d.origin, 'direct');
    }
  }
});

test('G1 flag ON mas SEM fonte publicada → ainda a URL direta (rollout não quebra nada)', () => {
  const h = enabled();
  const d = h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'main', consumer: 'recording', directUrl: DIRECT_MAIN });
  assert.equal(d.url, DIRECT_MAIN);
  assert.equal(d.origin, 'direct');
  assert.equal(d.reason, 'no_active_source');
});

test('G1 flag ON + fonte publicada e ONLINE → consumidor recebe a URL INTERNA do MediaMTX', () => {
  const h = enabled();
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  const lease = h.gw.acquire(CAM, 'main', 'recording');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });

  const d = h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'main', consumer: 'ai', directUrl: DIRECT_MAIN });
  assert.equal(d.url, INTERNAL_MAIN);
  assert.equal(d.origin, 'gateway');
  assert.equal(d.reason, 'gateway_published');
  assert.equal(lease.gatewayEnabled, true);
});

test('G1 flag ON + consumidor que exige bitstream direto → sempre direto', () => {
  const h = enabled();
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  h.gw.acquire(CAM, 'main', 'recording');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  const d = h.gw.resolveSourceUrl({
    cameraId: CAM,
    profile: 'main',
    consumer: 'recording',
    directUrl: DIRECT_MAIN,
    requireDirect: true,
  });
  assert.equal(d.url, DIRECT_MAIN);
  assert.equal(d.reason, 'consumer_requires_direct');
});

// ── 2. Refcount: dois consumidores = UMA origem ──────────────────────────────

test('G2 refcount: dois consumidores no mesmo perfil compartilham UMA origem', () => {
  const h = enabled();
  const a = h.gw.acquire(CAM, 'main', 'recording');
  const b = h.gw.acquire(CAM, 'main', 'ai');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });

  assert.equal(h.gw.externalConnections(CAM), 1, 'uma única conexão externa à câmera');
  const snap = h.gw.describeSource(CAM, 'main');
  assert.equal(snap?.refCount, 2);
  assert.deepEqual(snap?.consumers.slice().sort(), ['ai', 'recording']);
  assert.notEqual(a.id, b.id);
});

test('G2 refcount: soltar UM consumidor NÃO derruba a origem; o ÚLTIMO release libera', () => {
  const h = enabled();
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  const a = h.gw.acquire(CAM, 'main', 'recording');
  const b = h.gw.acquire(CAM, 'main', 'ai');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });

  a.release();
  let snap = h.gw.describeSource(CAM, 'main');
  assert.equal(snap?.refCount, 1, 'ainda há um consumidor');
  assert.equal(snap?.state, 'ONLINE', 'a origem NÃO pode cair com consumidor ativo');
  assert.equal(h.gw.externalConnections(CAM), 1);
  assert.equal(
    h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'main', consumer: 'ai', directUrl: DIRECT_MAIN }).origin,
    'gateway',
    'quem ficou continua servido pelo gateway',
  );

  b.release();
  snap = h.gw.describeSource(CAM, 'main');
  assert.equal(snap?.refCount, 0);
  assert.equal(snap?.state, 'IDLE', 'sem consumidor a origem fica ociosa');
  assert.equal(h.gw.externalConnections(CAM), 0);
});

test('G2 refcount: release repetido do MESMO lease é idempotente (não zera cedo)', () => {
  const h = enabled();
  const a = h.gw.acquire(CAM, 'main', 'recording');
  h.gw.acquire(CAM, 'main', 'ai');
  a.release();
  a.release();
  a.release();
  assert.equal(h.gw.describeSource(CAM, 'main')?.refCount, 1, 'o consumidor restante continua contado');
  assert.equal(h.gw.externalConnections(CAM), 1);
});

test('G2 refcount: perfis diferentes são origens diferentes (main + sub)', () => {
  const h = enabled();
  h.gw.acquire(CAM, 'main', 'recording');
  h.gw.acquire(CAM, 'sub', 'ai');
  assert.equal(h.gw.externalConnections(CAM), 2);
  assert.equal(h.gw.describeSource(CAM, 'main')?.refCount, 1);
  assert.equal(h.gw.describeSource(CAM, 'sub')?.refCount, 1);
  assert.equal(h.gw.externalConnections(CAM_B), 0, 'câmeras não se misturam');
});

// ── 3. Máquina de estados ────────────────────────────────────────────────────

test('G3 estado: acquire → CONNECTING; progresso → ONLINE e guarda o transporte que funcionou', () => {
  const h = enabled();
  h.gw.acquire(CAM, 'main', 'live');
  assert.equal(h.gw.describeSource(CAM, 'main')?.state, 'CONNECTING');

  h.advance(1_500);
  h.gw.noteProgress(CAM, 'main', { transport: 'udp' as RtspTransport, frame: true });
  const snap = h.gw.describeSource(CAM, 'main');
  assert.equal(snap?.state, 'ONLINE');
  assert.equal(snap?.transport, 'udp');
  assert.equal(snap?.lastPacketAt?.getTime(), h.now());
  assert.equal(snap?.lastFrameAt?.getTime(), h.now());
  assert.equal(h.gw.preferredTransport(CAM, 'main', 'tcp'), 'udp');
  assert.equal(h.gw.preferredTransport(CAM_B, 'main', 'tcp'), 'tcp', 'sem histórico → o padrão do chamador');
});

test('G3 estado: ONLINE → STALLED por falta de progresso; pacote novo evita o stall', () => {
  const h = enabled({ cameraSourceGatewayStallTimeoutMs: 20_000 });
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  h.gw.acquire(CAM, 'main', 'live');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });

  h.advance(19_000);
  h.gw.tick();
  assert.equal(h.gw.describeSource(CAM, 'main')?.state, 'ONLINE', 'dentro da janela ainda está ONLINE');

  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' }); // chegou pacote: reinicia a janela
  h.advance(19_000);
  h.gw.tick();
  assert.equal(h.gw.describeSource(CAM, 'main')?.state, 'ONLINE', 'progresso recente não pode virar STALLED');

  h.advance(2_000); // 21s desde o último pacote
  h.gw.tick();
  assert.equal(h.gw.describeSource(CAM, 'main')?.state, 'STALLED');

  const d = h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'main', consumer: 'ai', directUrl: DIRECT_MAIN });
  assert.equal(d.origin, 'direct', 'origem parada NÃO pode ser roteada pelo gateway');
  assert.equal(d.reason, 'source_stalled');
  assert.equal(d.url, DIRECT_MAIN);
});

test('G3 estado: recuperação (STALLED → ONLINE) conta métrica de recuperação uma única vez', () => {
  const h = enabled({ cameraSourceGatewayStallTimeoutMs: 10_000 });
  h.gw.acquire(CAM, 'main', 'live');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  h.advance(11_000);
  h.gw.tick();
  assert.equal(h.gw.describeSource(CAM, 'main')?.state, 'STALLED');

  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  assert.deepEqual(h.recoveries, [CAM], 'a recuperação é UM evento, não um por pacote');
  assert.equal(h.gw.describeSource(CAM, 'main')?.state, 'ONLINE');
});

// ── Backoff com jitter ───────────────────────────────────────────────────────

test('G4 backoff: crescimento exponencial, teto e jitter dentro do intervalo', () => {
  // random() = 0.5 → jitter neutro: o valor nominal.
  const nominal = (attempt: number) => computeBackoffDelayMs(attempt, { baseMs: 1000, capMs: 60_000, jitter: 0.2, random: () => 0.5 });
  assert.equal(nominal(1), 1000);
  assert.equal(nominal(2), 2000);
  assert.equal(nominal(3), 4000);
  assert.equal(nominal(4), 8000);
  assert.equal(nominal(10), 60_000, 'capado no teto');
  assert.equal(nominal(0), 1000, 'attempt inválido é tratado como 1');
  assert.equal(nominal(-5), 1000);

  // Extremos do jitter: ±20%.
  const low = computeBackoffDelayMs(3, { baseMs: 1000, capMs: 60_000, jitter: 0.2, random: () => 0 });
  const high = computeBackoffDelayMs(3, { baseMs: 1000, capMs: 60_000, jitter: 0.2, random: () => 1 });
  assert.equal(low, 3200);
  assert.equal(high, 4800);

  // Com Math.random real: 300 amostras SEMPRE dentro do intervalo e de fato variando.
  const seen = new Set<number>();
  for (let i = 0; i < 300; i += 1) {
    const v = computeBackoffDelayMs(3, { baseMs: 1000, capMs: 60_000, jitter: 0.2 });
    assert.ok(v >= 3200 && v <= 4800, `jitter fora do intervalo: ${v}`);
    seen.add(v);
  }
  assert.ok(seen.size > 1, 'sem jitter real todas as reconexões voltariam juntas (thundering herd)');
  assert.ok(computeBackoffDelayMs(3, { baseMs: 1000, capMs: 60_000, jitter: 0 }) === 4000, 'jitter 0 = determinístico');
});

test('G4 backoff: falha → BACKOFF e canAttempt só libera depois do nextAttemptAt', () => {
  const h = enabled({
    cameraSourceGatewayBackoffBaseMs: 1000,
    cameraSourceGatewayBackoffJitter: 0,
    cameraSourceGatewayCircuitThreshold: 5,
  });
  h.gw.acquire(CAM, 'main', 'live');
  h.gw.noteConnecting(CAM, 'main');

  h.gw.noteFailure(CAM, 'main', 'connection refused');
  let snap = h.gw.describeSource(CAM, 'main');
  assert.equal(snap?.state, 'BACKOFF');
  assert.equal(snap?.consecutiveFailures, 1);
  assert.equal(snap?.lastBackoffMs, 1000);
  assert.equal(h.gw.canAttempt(CAM, 'main'), false, 'não tenta antes da hora');

  h.advance(999);
  assert.equal(h.gw.canAttempt(CAM, 'main'), false);
  h.advance(1);
  assert.equal(h.gw.canAttempt(CAM, 'main'), true, 'passado o backoff, pode tentar');

  h.gw.noteFailure(CAM, 'main', 'timeout');
  snap = h.gw.describeSource(CAM, 'main');
  assert.equal(snap?.lastBackoffMs, 2000, 'a espera dobra a cada falha seguida');
  assert.equal(snap?.consecutiveFailures, 2);
});

// ── Circuit breaker ──────────────────────────────────────────────────────────

test('G5 circuit breaker: ABRE em N falhas seguidas e FECHA quando a fonte volta', () => {
  const h = enabled({
    cameraSourceGatewayBackoffJitter: 0,
    cameraSourceGatewayCircuitThreshold: 3,
    cameraSourceGatewayCircuitOpenMs: 60_000,
  });
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  h.gw.acquire(CAM, 'main', 'live');

  h.gw.noteFailure(CAM, 'main');
  h.gw.noteFailure(CAM, 'main');
  assert.equal(h.gw.describeSource(CAM, 'main')?.state, 'BACKOFF', 'antes do limiar ainda é backoff');

  h.gw.noteFailure(CAM, 'main'); // 3ª falha = limiar
  const open = h.gw.describeSource(CAM, 'main');
  assert.equal(open?.state, 'CIRCUIT_OPEN', 'no limiar o circuito ABRE');
  assert.equal(open?.circuitOpenUntil?.getTime(), h.now() + 60_000);
  assert.equal(h.gw.canAttempt(CAM, 'main'), false, 'circuito aberto = para de tentar');

  // Com o circuito aberto, o gateway devolve a URL direta (fail-safe = hoje).
  const d = h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'main', consumer: 'ai', directUrl: DIRECT_MAIN });
  assert.equal(d.origin, 'direct');
  assert.equal(d.reason, 'circuit_open');

  h.advance(59_999);
  assert.equal(h.gw.canAttempt(CAM, 'main'), false, 'ainda em resfriamento');
  h.advance(1);
  assert.equal(h.gw.canAttempt(CAM, 'main'), true, 'meio-aberto: uma tentativa é permitida');

  h.gw.noteConnecting(CAM, 'main');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  const closed = h.gw.describeSource(CAM, 'main');
  assert.equal(closed?.state, 'ONLINE');
  assert.equal(closed?.circuitOpenUntil, null, 'sucesso FECHA o circuito');
  assert.equal(closed?.consecutiveFailures, 0);
  assert.deepEqual(h.recoveries, [CAM]);
  assert.equal(
    h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'main', consumer: 'ai', directUrl: DIRECT_MAIN }).origin,
    'gateway',
    'circuito fechado volta a rotear pelo gateway',
  );
});

test('G5 circuit breaker: falha no meio-aberto REABRE com resfriamento maior', () => {
  const h = enabled({
    cameraSourceGatewayBackoffJitter: 0,
    cameraSourceGatewayCircuitThreshold: 2,
    cameraSourceGatewayCircuitOpenMs: 30_000,
  });
  h.gw.acquire(CAM, 'main', 'live');
  h.gw.noteFailure(CAM, 'main');
  h.gw.noteFailure(CAM, 'main');
  assert.equal(h.gw.describeSource(CAM, 'main')?.state, 'CIRCUIT_OPEN');

  h.advance(30_000);
  assert.equal(h.gw.canAttempt(CAM, 'main'), true);
  h.gw.noteConnecting(CAM, 'main');
  h.gw.noteFailure(CAM, 'main'); // a tentativa de meio-aberto falhou
  const snap = h.gw.describeSource(CAM, 'main');
  assert.equal(snap?.state, 'CIRCUIT_OPEN');
  assert.equal(snap?.circuitOpenUntil?.getTime(), h.now() + 60_000, 'resfriamento dobrado');
  assert.equal(h.gw.canAttempt(CAM, 'main'), false);
});

// ── 4. Teto de conexões externas por câmera ──────────────────────────────────

test('G6 teto: default 2 (main + sub) — os dois perfis cabem', () => {
  const h = enabled();
  assert.equal(h.gw.maxExternalConnectionsPerCamera(), 2);
  const a = h.gw.acquire(CAM, 'main', 'recording');
  const b = h.gw.acquire(CAM, 'sub', 'ai');
  assert.equal(a.capped, false);
  assert.equal(b.capped, false);
  assert.equal(a.servedProfile, 'main');
  assert.equal(b.servedProfile, 'sub');
  assert.equal(h.gw.externalConnections(CAM), 2);
});

test('G6 teto: com teto 1, o 2º perfil NÃO abre conexão nova — é servido pelo que já existe', () => {
  const h = enabled({ cameraSourceGatewayMaxExternalPerCamera: 1 });
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  h.gw.acquire(CAM, 'main', 'recording');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });

  const capped = h.gw.acquire(CAM, 'sub', 'ai');
  assert.equal(capped.capped, true, 'a decisão de teto tem de ser observável no lease');
  assert.equal(capped.requestedProfile, 'sub');
  assert.equal(capped.servedProfile, 'main');
  assert.equal(h.gw.externalConnections(CAM), 1, 'o teto foi respeitado: UMA conexão externa');
  assert.equal(h.gw.describeSource(CAM, 'main')?.refCount, 2);
  assert.equal(h.gw.describeSource(CAM, 'sub'), null, 'o perfil sub nem chegou a existir');

  const d = h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'sub', consumer: 'ai', directUrl: DIRECT_SUB });
  assert.equal(d.url, INTERNAL_MAIN, 'o consumidor do sub lê do main já publicado');
  assert.equal(d.origin, 'gateway');
  assert.equal(d.reason, 'cap_reused_profile');
  assert.equal(d.servedProfile, 'main');
  assert.equal(h.gw.stats().cappedAcquisitions, 1);
});

test('G6 teto: com teto atingido e NADA publicado, o consumidor volta ao direto (fail-safe)', () => {
  const h = enabled({ cameraSourceGatewayMaxExternalPerCamera: 1 });
  h.gw.acquire(CAM, 'main', 'recording'); // sem registerPublishedSource
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  const d = h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'sub', consumer: 'ai', directUrl: DIRECT_SUB });
  assert.equal(d.url, DIRECT_SUB);
  assert.equal(d.origin, 'direct');
  assert.equal(d.reason, 'no_published_source');
});

test('G6 teto: liberado o último consumidor, o outro perfil volta a poder abrir', () => {
  const h = enabled({ cameraSourceGatewayMaxExternalPerCamera: 1 });
  const a = h.gw.acquire(CAM, 'main', 'recording');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  a.release();
  const b = h.gw.acquire(CAM, 'sub', 'ai');
  assert.equal(b.capped, false);
  assert.equal(b.servedProfile, 'sub');
  assert.equal(h.gw.externalConnections(CAM), 1, 'continua UMA conexão externa — agora no sub');
});

// ── Observabilidade da decisão ───────────────────────────────────────────────

test('G7 observabilidade: decisões recentes e contadores ficam registrados e limitados', () => {
  const h = enabled();
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  h.gw.acquire(CAM, 'main', 'recording');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'main', consumer: 'recording', directUrl: DIRECT_MAIN });
  h.gw.resolveSourceUrl({ cameraId: CAM, profile: 'main', consumer: 'ai', directUrl: DIRECT_MAIN });
  h.gw.resolveSourceUrl({ cameraId: CAM_B, profile: 'main', consumer: 'ai', directUrl: DIRECT_MAIN });

  const stats = h.gw.stats();
  assert.equal(stats.decisions.gateway_published, 2);
  assert.equal(stats.decisions.no_active_source, 1);
  assert.equal(stats.acquisitions, 1);

  const recent = h.gw.recentDecisions();
  assert.equal(recent.length, 3);
  assert.equal(recent[recent.length - 1].cameraId, CAM_B);
  for (const d of recent) {
    assert.ok(!/s3nh4|mtxpass/.test(JSON.stringify(d)), 'decisão registrada NUNCA guarda credencial');
  }
});

test('G7 observabilidade: snapshot não vaza credencial da URL publicada', () => {
  const h = enabled();
  h.gw.registerPublishedSource(CAM, 'main', INTERNAL_MAIN);
  h.gw.acquire(CAM, 'main', 'recording');
  const snap = h.gw.describeSource(CAM, 'main');
  assert.ok(snap);
  assert.ok(!/mtxpass/.test(JSON.stringify(snap)), 'snapshot é diagnóstico: sem senha');
  assert.equal(snap?.publishedUrl, 'rtsp://<redacted>@mediamtx:8554/cam_1111222233334444555555555555');
});

// ── Memória limitada / higiene ───────────────────────────────────────────────

test('G8 higiene: tick recolhe origens ociosas antigas, mas preserva circuito aberto', () => {
  const h = enabled({
    cameraSourceGatewayIdleTtlMs: 60_000,
    cameraSourceGatewayCircuitThreshold: 1,
    cameraSourceGatewayCircuitOpenMs: 600_000, // resfriamento maior que o TTL de ocioso
  });
  const a = h.gw.acquire(CAM, 'main', 'recording');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  a.release();

  const b = h.gw.acquire(CAM_B, 'main', 'recording');
  h.gw.noteFailure(CAM_B, 'main');
  b.release();

  h.advance(61_000);
  h.gw.tick();
  assert.equal(h.gw.describeSource(CAM, 'main'), null, 'origem ociosa antiga é recolhida');
  assert.ok(h.gw.describeSource(CAM_B, 'main'), 'circuito aberto não pode ser esquecido (voltaria a martelar a câmera)');
});

test('G8 higiene: gateway desligado não emite métrica nem cria estado, mesmo sob falha', () => {
  const h = makeGateway();
  h.gw.noteConnecting(CAM, 'main');
  h.gw.noteFailure(CAM, 'main');
  h.gw.noteProgress(CAM, 'main', { transport: 'tcp' });
  h.gw.tick();
  assert.equal(h.gw.snapshotAll().length, 0);
  assert.deepEqual(h.recoveries, []);
  assert.equal(h.gw.canAttempt(CAM, 'main'), true, 'desligado nunca bloqueia ninguém');
});
