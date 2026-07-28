import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recoverPendingFileDeletions,
  stageFileDeletion,
} from '../src/recordings/helpers/transactional-file-delete.helper';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'drac-delete-journal-'));
  const file = join(root, 'camera-a', 'segment.mp4');
  mkdirSync(join(root, 'camera-a'), { recursive: true });
  writeFileSync(file, 'evidencia-controlada');
  return {
    root,
    file,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('falha do banco restaura exatamente o arquivo colocado em quarentena', async () => {
  const fx = fixture();
  try {
    const staged = await stageFileDeletion(
      fx.root,
      [fx.file],
      [{ model: 'recording', id: 'recording-1' }],
    );
    assert.equal(existsSync(fx.file), false, 'arquivo deve ficar invisível durante a transação');

    // Simula rollback/erro do PostgreSQL posterior ao rename.
    await staged.rollback();
    assert.equal(existsSync(fx.file), true);
    assert.equal(readFileSync(fx.file, 'utf8'), 'evidencia-controlada');
  } finally {
    fx.cleanup();
  }
});

test('crash antes do commit é recuperado porque a linha ainda existe', async () => {
  const fx = fixture();
  try {
    await stageFileDeletion(
      fx.root,
      [fx.file],
      [{ model: 'recording', id: 'recording-1' }],
    );
    assert.equal(existsSync(fx.file), false);

    const result = await recoverPendingFileDeletions(
      fx.root,
      async (guard) => guard.id === 'recording-1',
    );
    assert.deepEqual(result, { scanned: 1, restored: 1, cleaned: 0, failed: 0 });
    assert.equal(readFileSync(fx.file, 'utf8'), 'evidencia-controlada');
  } finally {
    fx.cleanup();
  }
});

test('crash depois do commit conclui a limpeza quando a linha já não existe', async () => {
  const fx = fixture();
  try {
    await stageFileDeletion(
      fx.root,
      [fx.file],
      [{ model: 'recording', id: 'recording-1' }],
    );

    const result = await recoverPendingFileDeletions(fx.root, async () => false);
    assert.deepEqual(result, { scanned: 1, restored: 0, cleaned: 1, failed: 0 });
    assert.equal(existsSync(fx.file), false);
  } finally {
    fx.cleanup();
  }
});

test('paths fora da raiz e a própria raiz são recusados antes de mover dados', async () => {
  const fx = fixture();
  try {
    await assert.rejects(
      () => stageFileDeletion(fx.root, [fx.root], []),
      /raiz de gravações/,
    );
    await assert.rejects(
      () => stageFileDeletion(fx.root, [join(fx.root, '..', 'fora.mp4')], []),
      /fora da raiz/,
    );
    assert.equal(existsSync(fx.file), true);
  } finally {
    fx.cleanup();
  }
});

test('recovery recusa journal adulterado sem tocar em arquivo fora da raiz', async () => {
  const fx = fixture();
  const sentinel = join(fx.root, '..', `drac-sentinel-${Date.now()}.txt`);
  writeFileSync(sentinel, 'não remover');
  try {
    await stageFileDeletion(
      fx.root,
      [fx.file],
      [{ model: 'recording', id: 'recording-1' }],
    );
    const operationId = readdirSync(join(fx.root, '.drac-file-deletions'))[0];
    const journalPath = join(
      fx.root,
      '.drac-file-deletions',
      operationId,
      'journal.json',
    );
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries[0].originalRelative = `../../${journal.operationId}.txt`;
    writeFileSync(journalPath, JSON.stringify(journal));

    const result = await recoverPendingFileDeletions(fx.root, async () => true);
    assert.deepEqual(result, { scanned: 1, restored: 0, cleaned: 0, failed: 1 });
    assert.equal(readFileSync(sentinel, 'utf8'), 'não remover');
  } finally {
    fx.cleanup();
    rmSync(sentinel, { force: true });
  }
});
