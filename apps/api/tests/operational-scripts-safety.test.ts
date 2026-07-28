import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(__dirname, '../../..');
const updateScript = readFileSync(resolve(repositoryRoot, 'scripts/update-drac.sh'), 'utf8');
const restoreScript = readFileSync(resolve(repositoryRoot, 'scripts/restore-drac.sh'), 'utf8');

test('update mantém writers quiescentes durante rollback transacional', () => {
  assert.match(updateScript, /stop api web drac-central/);
  assert.match(updateScript, /--exit-on-error --single-transaction/);
  assert.doesNotMatch(updateScript, /pg_restore[^\n]*\|\| true/);
  assert.match(updateScript, /ROLLBACK INCOMPLETO/);
});

test('update bloqueia a migration histórica quando ainda existem gravações duplicadas', () => {
  assert.match(updateScript, /preflight_recording_duplicates/);
  assert.match(updateScript, /20260501042000_recordings_indexes/);
  assert.match(updateScript, /GROUP BY \\"filePath\\"/);
  assert.match(updateScript, /recusou a deleção arbitrária por ctid/);
});

test('restore valida dump e archive antes de marcar o ambiente como mutado', () => {
  const scratch = restoreScript.indexOf('validate_dump_in_scratch_database /tmp/drac-restore-input.dump');
  const archive = restoreScript.indexOf('validate_storage_archive "$STORAGE_ARCHIVE"');
  const mutated = restoreScript.indexOf('RESTORE_MUTATED=true');
  assert.ok(scratch >= 0 && scratch < mutated);
  assert.ok(archive >= 0 && archive < mutated);
  assert.match(restoreScript, /--exit-on-error --single-transaction/);
});

test('restore recusa traversal/links e preserva banco e storage para rollback', () => {
  assert.match(restoreScript, /Archive de storage contém caminho absoluto ou traversal/);
  assert.match(restoreScript, /Archive de storage contém link ou arquivo especial/);
  assert.match(restoreScript, /postgres-before\.dump/);
  assert.match(restoreScript, /storage-before/);
  assert.match(restoreScript, /ROLLBACK INCOMPLETO/);
  assert.match(restoreScript, /api web drac-central ai-service camera-worker/);
});
