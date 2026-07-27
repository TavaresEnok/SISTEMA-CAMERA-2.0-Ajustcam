import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';
import {
  appendStderrChunk,
  createStderrRing,
  drainStderrRing,
} from '../src/recordings/helpers/ffmpeg-stderr-ring.helper';

// ─────────────────────────────────────────────────────────────────────────────
// RING BUFFER DO STDERR DO FFMPEG DE GRAVAÇÃO.
//
// Responder "por que a câmera X parou de gravar às 3h?" exigia garimpar log de
// DEBUG de todas as câmeras — nível que ninguém deixa ligado em produção. O ring
// guarda as últimas N linhas por processo (teto rígido de memória) e só despeja
// esse bloco quando o processo morre ANORMALMENTE.
//
// SEGURANÇA: o stderr do FFmpeg carrega a URL RTSP INTEIRA, com a senha da
// câmera. NADA sai daqui sem passar por sanitizeSensitiveText — inclusive quando
// a credencial é partida ao meio entre dois chunks do stream.
// ─────────────────────────────────────────────────────────────────────────────

const CAM = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
const SENHA = 'S3nh4Sup3rSecreta';
const URL_COM_SENHA = `rtsp://admin:${SENHA}@192.168.1.77:554/cam/realmonitor`;

// ── Teto rígido ──────────────────────────────────────────────────────────────

test('ring: guarda apenas as ÚLTIMAS N linhas (teto rígido de memória)', () => {
  const ring = createStderrRing(5);
  for (let i = 1; i <= 200; i += 1) appendStderrChunk(ring, `linha ${i}\n`);

  const linhas = drainStderrRing(ring);
  assert.equal(linhas.length, 5, 'o ring não pode crescer com o tempo de vida do processo');
  assert.deepEqual(linhas, ['linha 196', 'linha 197', 'linha 198', 'linha 199', 'linha 200']);
});

test('ring: linha gigante é truncada (um único log não pode explodir a memória)', () => {
  const ring = createStderrRing(5, 120);
  appendStderrChunk(ring, `${'x'.repeat(10_000)}\n`);

  const [linha] = drainStderrRing(ring);
  assert.equal(linha.length, 120, 'a linha precisa respeitar o teto por linha');
});

test('ring: chunk sem quebra de linha não vaza memória sem limite', () => {
  const ring = createStderrRing(4, 200);
  // FFmpeg pode cuspir progresso com \r e ficar muito tempo sem \n.
  for (let i = 0; i < 50; i += 1) appendStderrChunk(ring, 'y'.repeat(1_000));

  const linhas = drainStderrRing(ring);
  assert.ok(linhas.length <= 4, 'o teto de linhas continua valendo');
  for (const linha of linhas) assert.ok(linha.length <= 200, 'e o teto por linha também');
});

test('ring: drenar ESVAZIA (o mesmo bloco não é despejado duas vezes)', () => {
  const ring = createStderrRing(10);
  appendStderrChunk(ring, 'algo quebrou\n');

  assert.deepEqual(drainStderrRing(ring), ['algo quebrou']);
  assert.deepEqual(drainStderrRing(ring), [], 'o segundo despejo tem de vir vazio');
});

test('ring: linha incompleta (sem \\n final) ainda é despejada na morte', () => {
  const ring = createStderrRing(10);
  appendStderrChunk(ring, 'Connection timed out');

  assert.deepEqual(drainStderrRing(ring), ['Connection timed out'], 'a última linha é justamente a mais importante');
});

// ── Credencial NUNCA aparece ─────────────────────────────────────────────────

test('ring: credencial da câmera NUNCA aparece no despejo', () => {
  const ring = createStderrRing(10);
  appendStderrChunk(ring, `[rtsp @ 0x1] Could not open input ${URL_COM_SENHA}: Connection refused\n`);

  const bloco = drainStderrRing(ring).join('\n');
  assert.ok(!bloco.includes(SENHA), 'a senha da câmera não pode vazar para o log');
  assert.match(bloco, /<redacted>@192\.168\.1\.77/, 'a URL segue legível, só sem credencial');
});

test('ring: credencial PARTIDA entre dois chunks também é sanitizada', () => {
  const ring = createStderrRing(10);
  // O stream de stderr é fatiado pelo SO onde quiser: sanitizar chunk a chunk
  // deixaria passar exatamente este caso.
  appendStderrChunk(ring, `[rtsp @ 0x1] failed rtsp://admin:${SENHA.slice(0, 6)}`);
  appendStderrChunk(ring, `${SENHA.slice(6)}@192.168.1.77:554/cam\n`);

  const bloco = drainStderrRing(ring).join('\n');
  assert.ok(!bloco.includes(SENHA), 'credencial partida entre chunks continua sendo credencial');
  assert.match(bloco, /<redacted>@192\.168\.1\.77/);
});

test('ring: truncar não pode expor um pedaço da senha', () => {
  const ring = createStderrRing(10, 60);
  appendStderrChunk(ring, `${URL_COM_SENHA} falhou depois de muito texto ${'z'.repeat(500)}\n`);

  const bloco = drainStderrRing(ring).join('\n');
  assert.ok(!bloco.includes(SENHA.slice(0, 8)), 'sanitizar tem de vir ANTES de truncar');
});

// ── Despejo pelo serviço: só na morte ANORMAL ────────────────────────────────

function makeManager() {
  const svc: any = Object.create(RecordingProcessManagerService.prototype);
  svc.erros = [] as string[];
  svc.logger = {
    warn() {},
    log() {},
    debug() {},
    error: (msg: string) => svc.erros.push(msg),
  };
  svc.controlMode = 'local';
  svc.shuttingDown = false;
  svc.active = new Map();
  svc.restartAttempts = new Map();
  svc.restartTimers = new Map();
  svc.scanAndRegister = async () => undefined;
  svc.prisma = { camera: { findUnique: async () => ({ recordingEnabled: false, enabled: true }) } };
  svc.start = async () => ({ status: 'recording_started' });
  return svc;
}

function makeState(overrides: Record<string, unknown> = {}) {
  const ring = createStderrRing(10);
  appendStderrChunk(ring, `[rtsp @ 0x1] Could not open input ${URL_COM_SENHA}: Connection refused\n`);
  appendStderrChunk(ring, 'Conversion failed!\n');
  return {
    cameraId: CAM,
    process: { exitCode: 1 },
    segmentSeconds: 60,
    watcher: setTimeout(() => {}, 0),
    knownFiles: new Set<string>(),
    scanInFlight: null,
    finalizePromise: null,
    stderrRing: ring,
    ...overrides,
  } as any;
}

test('despejo: morte ANORMAL joga o bloco inteiro no log, identificado pela câmera', async () => {
  const mgr = makeManager();
  const state = makeState();
  mgr.active.set(CAM, state);

  await mgr.finalizeRecordingState(CAM, state, 1);

  const despejo = mgr.erros.join('\n');
  assert.match(despejo, new RegExp(CAM), 'sem o id da câmera o despejo não responde a pergunta');
  assert.match(despejo, /Could not open input/, 'o bloco de stderr precisa estar lá');
  assert.match(despejo, /Conversion failed!/, 'todas as linhas do ring, de uma vez');
});

test('despejo: a credencial da câmera NÃO aparece no log do despejo', async () => {
  const mgr = makeManager();
  const state = makeState();
  mgr.active.set(CAM, state);

  await mgr.finalizeRecordingState(CAM, state, 1);

  const despejo = mgr.erros.join('\n');
  assert.ok(!despejo.includes(SENHA), 'vazar senha de câmera no log é incidente de segurança');
  assert.match(despejo, /<redacted>@192\.168\.1\.77/);
});

test('despejo: saída NORMAL (parada pedida) não despeja nada', async () => {
  const mgr = makeManager();
  const state = makeState({ stopRequested: true, process: { exitCode: 0 } });
  mgr.active.set(CAM, state);

  await mgr.finalizeRecordingState(CAM, state, 0);

  assert.deepEqual(mgr.erros, [], 'parada normal não pode inundar o log com stderr de rotina');
});

test('despejo: processo sem ring (estado legado) não derruba a finalização', async () => {
  const mgr = makeManager();
  const state = makeState({ stderrRing: undefined });
  mgr.active.set(CAM, state);

  await mgr.finalizeRecordingState(CAM, state, 1);
  assert.equal(mgr.active.has(CAM), false, 'a finalização precisa concluir mesmo sem ring');
});
