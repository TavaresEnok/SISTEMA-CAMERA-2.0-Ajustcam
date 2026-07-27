import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// D2 (integridade/segurança da gravação) — caminhos de ERRO.
// Testamos a LÓGICA DE DECISÃO real (sem I/O) sobrescrevendo os seams de I/O no
// nível da instância: getStorageUsage (disk-guard) e probeRecordedFileMetadata
// (validação de segmento). Nenhuma mudança de produção.
// ─────────────────────────────────────────────────────────────────────────────

const GiB = 1024 ** 3;

function makeManager(configOverrides: Record<string, any> = {}) {
  const config = { get: (key: string) => configOverrides[key] } as any;
  const mgr = new RecordingProcessManagerService(config, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} }; // silencia ruído de log nos testes
  return mgr;
}

// ── Disk-guard: assertMinimumStorageFree ─────────────────────────────────────

test('D2 disk-guard: disco saudável NÃO bloqueia o início da gravação', async () => {
  const mgr = makeManager();
  mgr.getStorageUsage = async () => ({ totalBytes: 200 * GiB, freeBytes: 100 * GiB, freePercent: 50, usedPercent: 50 });
  await assert.doesNotReject(() => mgr.assertMinimumStorageFree());
});

test('D2 disk-guard: bytes livres abaixo do mínimo BLOQUEIA o início', async () => {
  const mgr = makeManager(); // minFreeBytes default = 2 GiB
  mgr.getStorageUsage = async () => ({ totalBytes: 200 * GiB, freeBytes: 1 * GiB, freePercent: 50, usedPercent: 50 });
  await assert.rejects(() => mgr.assertMinimumStorageFree(), /insuficiente/i);
});

test('D2 disk-guard: percentual livre abaixo do mínimo BLOQUEIA o início', async () => {
  const mgr = makeManager(); // minFreePercent default = 5
  mgr.getStorageUsage = async () => ({ totalBytes: 200 * GiB, freeBytes: 100 * GiB, freePercent: 3, usedPercent: 97 });
  await assert.rejects(() => mgr.assertMinimumStorageFree(), /insuficiente/i);
});

// ── Disk-guard: enforceDiskGuard PARA gravações em disco crítico ──────────────

function armedManager(usage: { totalBytes: number; freeBytes: number; freePercent: number; usedPercent: number }) {
  const mgr = makeManager();
  mgr.active.set('cam-1', {});
  mgr.active.set('cam-2', {});
  mgr.getStorageUsage = async () => usage;
  const stopped: string[] = [];
  mgr.stop = async (id: string) => { stopped.push(id); };
  return { mgr, stopped };
}

test('D2 disk-guard: disco saudável NÃO para nenhuma gravação ativa', async () => {
  const { mgr, stopped } = armedManager({ totalBytes: 200 * GiB, freeBytes: 100 * GiB, freePercent: 50, usedPercent: 50 });
  await mgr.enforceDiskGuard();
  assert.deepEqual(stopped, [], 'disco saudável não deve parar gravações');
});

test('D2 disk-guard: uso acima do teto (>=92%) PARA todas as gravações ativas', async () => {
  // freePercent 6 (> mínimo 5) e freeBytes ok: isola o gatilho por usedPercent.
  const { mgr, stopped } = armedManager({ totalBytes: 200 * GiB, freeBytes: 12 * GiB, freePercent: 6, usedPercent: 94 });
  await mgr.enforceDiskGuard();
  assert.deepEqual(stopped.sort(), ['cam-1', 'cam-2'], 'uso crítico deve parar todas as câmeras armadas');
});

test('D2 disk-guard: bytes livres abaixo do mínimo PARA as gravações ativas', async () => {
  const { mgr, stopped } = armedManager({ totalBytes: 200 * GiB, freeBytes: 1 * GiB, freePercent: 50, usedPercent: 50 });
  await mgr.enforceDiskGuard();
  assert.deepEqual(stopped.sort(), ['cam-1', 'cam-2']);
});

// ── Validação de segmento: registerSegment ───────────────────────────────────

test('D2 integridade: segmento sem duração válida é REJEITADO (não registra lixo)', async () => {
  const mgr = makeManager();
  mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: null, sizeBytes: 0, hasVideoStream: false });
  let created = false;
  mgr.prisma = { camera: { findUnique: async () => ({ recordingMode: 'motion' }) }, recording: { create: async () => { created = true; return { id: 'x' }; } } };
  await assert.rejects(
    () => mgr.registerSegment('cam-1', '/rec/2026-07-24_10-00-00.mp4', 60),
    /segmento_mp4_invalido_ou_incompleto/,
  );
  assert.equal(created, false, 'segmento inválido nunca deve virar linha no banco');
});

test('D2 integridade: segmento válido registra com início/fim/duração corretos', async () => {
  const mgr = makeManager();
  mgr.probeRecordedFileMetadata = async () => ({ durationSecondsExact: 58.4, sizeBytes: 1000, hasVideoStream: true });
  let createdData: any = null;
  mgr.prisma = {
    camera: { findUnique: async () => ({ recordingMode: 'motion' }) },
    recording: {
      findUnique: async () => null,
      create: async ({ data }: any) => { createdData = data; return { id: 'rec-1' }; },
    },
  };
  mgr.thumbnailQueue = { add: async () => undefined };

  await mgr.registerSegment('cam-1', '/rec/2026-07-24_10-00-00.mp4', 60);

  assert.ok(createdData, 'deve criar a gravação');
  assert.equal(createdData.startedAt.toISOString(), '2026-07-24T10:00:00.000Z', 'início vem do nome do arquivo (UTC)');
  assert.equal(createdData.durationSeconds, 58, 'duração arredondada do probe');
  assert.equal(createdData.endedAt.toISOString(), new Date(Date.parse('2026-07-24T10:00:00.000Z') + 58400).toISOString(), 'fim = início + duração exata');
  assert.equal(createdData.triggerMode, 'motion');
  assert.equal(createdData.sizeBytes, 1000n, 'tamanho em BigInt');
});

test('D2 integridade: arquivo com nome fora do padrão é ignorado em silêncio', async () => {
  const mgr = makeManager();
  let probed = false;
  mgr.probeRecordedFileMetadata = async () => { probed = true; return { durationSecondsExact: 10, sizeBytes: 1, hasVideoStream: true }; };
  await mgr.registerSegment('cam-1', '/rec/qualquer-coisa.mp4', 60); // não deve lançar
  assert.equal(probed, false, 'nome fora do padrão retorna antes de qualquer I/O');
});
