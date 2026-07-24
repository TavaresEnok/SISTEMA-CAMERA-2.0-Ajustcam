import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// D2 (status por-FATO): em modo local, "está gravando" é o PROCESSO FFmpeg vivo —
// não a idade do último segmento. getStatus não pode reportar OK com o FFmpeg
// morto. "existe gravação recente" (hasRecentSegment) é um campo à parte.
// ─────────────────────────────────────────────────────────────────────────────

function makeManager() {
  const config = { get: () => undefined } as any;
  const mgr = new RecordingProcessManagerService(config, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  mgr.logger = { error() {}, warn() {}, log() {}, debug() {} };
  const recentStart = new Date(Date.now() - 30_000); // segmento recente (<15min)
  mgr.prisma = {
    recording: { findFirst: async () => ({ startedAt: recentStart, endedAt: null, filePath: '/rec/x.mp4' }) },
    camera: { findUnique: async () => ({ recordingEnabled: true }) },
    cameraEvent: { findFirst: async () => null },
  };
  return mgr;
}

test('D2 status: processo local VIVO reporta gravando', async () => {
  const mgr = makeManager();
  mgr.active.set('cam-1', { pid: 4242, startedAt: new Date(), outputPattern: '/rec/%Y.ts' });
  mgr.isPidAlive = () => true;
  const s = await mgr.getStatus('cam-1');
  assert.equal(s.isRecording, true);
  assert.equal(s.statusDetail, 'recording_ok_local_process');
});

test('D2 status: processo local MORTO NÃO reporta gravando (não mente OK com FFmpeg morto)', async () => {
  const mgr = makeManager();
  mgr.active.set('cam-1', { pid: 4242, startedAt: new Date(), outputPattern: '/rec/%Y.ts' });
  mgr.isPidAlive = () => false;
  const s = await mgr.getStatus('cam-1');
  assert.equal(s.isRecording, false, 'PID morto não pode reportar gravando');
  assert.equal(s.stale, true);
  assert.equal(s.statusDetail, 'local_process_dead');
});

test('D2 status: hasRecentSegment é um campo separado de isRecording', async () => {
  const mgr = makeManager();
  mgr.active.set('cam-1', { pid: 4242, startedAt: new Date(), outputPattern: '/rec/%Y.ts' });
  mgr.isPidAlive = () => true;
  const s = await mgr.getStatus('cam-1');
  assert.equal(s.hasRecentSegment, true);
});
