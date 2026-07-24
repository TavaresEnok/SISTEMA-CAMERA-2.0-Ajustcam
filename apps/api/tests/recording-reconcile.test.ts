import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRecordingPaths } from '../src/recordings/helpers/recording-reconcile.helper';

// ─────────────────────────────────────────────────────────────────────────────
// 2.4 — reconciliação DB↔disco de gravações (moonfire check.rs / zmaudit.pl).
// Helper PURO: as duas classes de órfão são detectadas nas DUAS direções.
// ─────────────────────────────────────────────────────────────────────────────

test('2.4: detecta órfãos nas duas direções', () => {
  const db = ['/rec/a.mp4', '/rec/b.mp4', '/rec/c.mp4'];
  const disk = ['/rec/b.mp4', '/rec/c.mp4', '/rec/d.mp4'];
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(db, disk);
  // No disco mas fora do banco → d.mp4.
  assert.deepEqual(orfaosNoDisco, ['/rec/d.mp4']);
  // No banco mas fora do disco → a.mp4.
  assert.deepEqual(orfaosNoDb, ['/rec/a.mp4']);
});

test('2.4: tudo casando → nenhum órfão', () => {
  const paths = ['/rec/a.mp4', '/rec/b.mp4'];
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(paths, [...paths]);
  assert.deepEqual(orfaosNoDisco, []);
  assert.deepEqual(orfaosNoDb, []);
});

test('2.4: banco vazio → todo arquivo do disco é órfão-no-disco', () => {
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths([], ['/rec/x.mp4', '/rec/y.mp4']);
  assert.deepEqual(orfaosNoDisco, ['/rec/x.mp4', '/rec/y.mp4']);
  assert.deepEqual(orfaosNoDb, []);
});

test('2.4: disco vazio → todo registro do banco é órfão-no-db', () => {
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(['/rec/x.mp4', '/rec/y.mp4'], []);
  assert.deepEqual(orfaosNoDisco, []);
  assert.deepEqual(orfaosNoDb, ['/rec/x.mp4', '/rec/y.mp4']);
});

test('2.4: resultado é determinístico (ordenado) apesar da ordem de entrada', () => {
  const db = ['/rec/z.mp4', '/rec/m.mp4', '/rec/a.mp4'];
  const disk: string[] = [];
  const { orfaosNoDb } = reconcileRecordingPaths(db, disk);
  assert.deepEqual(orfaosNoDb, ['/rec/a.mp4', '/rec/m.mp4', '/rec/z.mp4'], 'ordenação estável');
});

test('2.4: duplicatas na mesma lista não geram falso órfão', () => {
  const { orfaosNoDisco, orfaosNoDb } = reconcileRecordingPaths(
    ['/rec/a.mp4', '/rec/a.mp4'],
    ['/rec/a.mp4', '/rec/a.mp4'],
  );
  assert.deepEqual(orfaosNoDisco, []);
  assert.deepEqual(orfaosNoDb, []);
});
