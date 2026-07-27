import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetentionService } from '../src/recordings/retention.service';

// O sprite de scrubbing (2.9) mora AO LADO do MP4 e o helper promete que ele
// "herda a retenção da origem". A retenção só conhecia `.thumb.jpg`, então cada
// gravação com scrubbing deixava um `.preview.jpg` PERMANENTE no disco após a
// origem ser apagada — vazamento de armazenamento e de derivado de conteúdo.
// Estes testes travam as duas pontas: exclusão da gravação e varredura de órfãos.

function makeService(root: string, recordings: Array<{ id: string; cameraId: string; filePath: string }>) {
  const svc: any = Object.create(RetentionService.prototype);
  svc.logger = { warn() {}, log() {} };
  svc.config = { get: (k: string) => (k === 'recordingsRoot' ? root : undefined) };
  svc.prisma = {
    exportedClip: { findMany: async () => [], delete: async () => ({}) },
    recording: {
      findMany: async () => recordings.map((r) => ({ ...r })),
      delete: async () => ({}),
    },
  };
  return svc;
}

function seedRecording(root: string, name: string) {
  const cam = join(root, 'cam-1');
  mkdirSync(cam, { recursive: true });
  const mp4 = join(cam, `${name}.mp4`);
  const thumb = join(cam, `${name}.thumb.jpg`);
  const preview = join(cam, `${name}.preview.jpg`);
  for (const f of [mp4, thumb, preview]) writeFileSync(f, 'x');
  return { mp4, thumb, preview, relative: join('cam-1', `${name}.mp4`) };
}

test('retenção: apagar a gravação apaga TAMBÉM o sprite .preview.jpg', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret-'));
  try {
    const f = seedRecording(root, '2026-07-24_10-00-00');
    const svc = makeService(root, []);
    const removed = await svc.deleteRecording(
      { id: 'r1', cameraId: 'cam-1', filePath: f.relative },
      { recordingIds: new Set(), clipIds: new Set(), eventIds: new Set() },
    );
    assert.equal(removed, true);
    assert.equal(existsSync(f.mp4), false, 'o MP4 deveria sumir');
    assert.equal(existsSync(f.thumb), false, 'a thumbnail deveria sumir');
    assert.equal(existsSync(f.preview), false, 'o SPRITE deveria sumir junto com a origem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retenção: varredura remove sprite ÓRFÃO e preserva o de gravação viva', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drac-ret-'));
  try {
    const viva = seedRecording(root, 'viva');
    const orfa = seedRecording(root, 'orfa');
    // Só "viva" existe no banco; o sprite de "orfa" não tem dono.
    const svc = makeService(root, [{ id: 'r-viva', cameraId: 'cam-1', filePath: viva.relative }]);
    const res = await svc.cleanupOrphanDerivedArtifacts();
    assert.equal(existsSync(viva.preview), true, 'sprite de gravação VIVA não pode ser removido');
    assert.equal(existsSync(orfa.preview), false, 'sprite ÓRFÃO deveria ser removido');
    assert.ok(res.orphanThumbnailsDeleted >= 1, 'a contagem deve refletir os derivados órfãos removidos');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
