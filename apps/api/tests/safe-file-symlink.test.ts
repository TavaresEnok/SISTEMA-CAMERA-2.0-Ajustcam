import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureFileUnderRoot } from '../src/recordings/helpers/safe-file.helper';

test('ensureFileUnderRoot recusa symlink de arquivo para fora da raiz', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'drac-safe-file-'));
  try {
    const root = join(workspace, 'storage');
    const outside = join(workspace, 'segredo.txt');
    mkdirSync(root);
    writeFileSync(outside, 'sentinela');
    symlinkSync(outside, join(root, 'clip.mp4'));

    assert.throws(
      () => ensureFileUnderRoot(root, 'clip.mp4'),
      /symlink recusado/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ensureFileUnderRoot recusa diretório symlink para fora, inclusive para saída inexistente', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'drac-safe-dir-'));
  try {
    const root = join(workspace, 'storage');
    const outside = join(workspace, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'camera'));

    assert.throws(
      () => ensureFileUnderRoot(root, 'camera/novo.mp4'),
      /symlink recusado/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ensureFileUnderRoot devolve caminho canônico interno para leitura', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'drac-safe-internal-'));
  try {
    const root = join(workspace, 'storage');
    const directory = join(root, 'camera');
    const file = join(directory, 'clip.mp4');
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, 'video');

    const safePath = ensureFileUnderRoot(root, 'camera/clip.mp4');
    assert.equal(readFileSync(safePath, 'utf8'), 'video');
    assert.equal(safePath, file);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
