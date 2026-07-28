import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DeletionGuard = {
  model: 'recording' | 'exportedClip';
  id: string;
};

type JournalEntry = {
  originalRelative: string;
  quarantineRelative: string;
};

type DeletionJournal = {
  version: 1;
  operationId: string;
  createdAt: string;
  guards: DeletionGuard[];
  entries: JournalEntry[];
};

export type StagedFileDeletion = {
  operationId: string;
  movedFiles: number;
  missingFiles: number;
  commit(): Promise<{ cleanupDeferred: boolean }>;
  rollback(): Promise<void>;
};

const JOURNAL_DIR = '.drac-file-deletions';
const JOURNAL_FILE = 'journal.json';

function assertUnderRoot(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  const rel = relative(absoluteRoot, absolute);
  if (!rel || rel === '.') {
    throw new Error('A raiz de gravações não pode ser movida ou removida.');
  }
  if (rel === JOURNAL_DIR || rel.startsWith(`${JOURNAL_DIR}${sep}`)) {
    throw new Error('O journal de exclusão não pode ser alvo de exclusão.');
  }
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('Artefato fora da raiz de gravações.');
  }
  return rel;
}

async function fsyncFile(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ? Promise.reject(error)
      : false;
  }
}

function journalPaths(root: string, operationId: string) {
  const operationsRoot = join(resolve(root), JOURNAL_DIR);
  const operationRoot = join(operationsRoot, operationId);
  return {
    operationsRoot,
    operationRoot,
    quarantineRoot: join(operationRoot, 'files'),
    journalPath: join(operationRoot, JOURNAL_FILE),
  };
}

function validateJournal(root: string, expectedOperationId: string, journal: DeletionJournal) {
  if (
    journal.version !== 1
    || journal.operationId !== expectedOperationId
    || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(journal.operationId)
    || !Array.isArray(journal.entries)
    || journal.entries.length > 100_000
    || !Array.isArray(journal.guards)
    || journal.guards.length > 100_000
  ) {
    throw new Error('Journal de exclusão inválido.');
  }
  for (const entry of journal.entries) {
    if (
      !entry
      || typeof entry.originalRelative !== 'string'
      || typeof entry.quarantineRelative !== 'string'
      || isAbsolute(entry.originalRelative)
      || isAbsolute(entry.quarantineRelative)
    ) {
      throw new Error('Entrada inválida no journal de exclusão.');
    }
    assertUnderRoot(root, join(root, entry.originalRelative));
    const quarantinePrefix = join(JOURNAL_DIR, journal.operationId, 'files');
    const quarantineAbsolute = resolve(root, entry.quarantineRelative);
    const quarantine = relative(resolve(root), quarantineAbsolute);
    if (
      quarantine.startsWith(`..${sep}`)
      || quarantine === '..'
      || isAbsolute(quarantine)
      ||
      quarantine !== quarantinePrefix
      && !quarantine.startsWith(`${quarantinePrefix}${sep}`)
    ) {
      throw new Error('Quarentena inválida no journal de exclusão.');
    }
  }
  for (const guard of journal.guards) {
    if (
      !guard
      || !['recording', 'exportedClip'].includes(guard.model)
      || typeof guard.id !== 'string'
      || !guard.id
      || guard.id.length > 256
    ) {
      throw new Error('Guard inválido no journal de exclusão.');
    }
  }
}

async function writeDurableJournal(root: string, journal: DeletionJournal) {
  const paths = journalPaths(root, journal.operationId);
  await mkdir(paths.quarantineRoot, { recursive: true, mode: 0o700 });
  await writeFile(paths.journalPath, `${JSON.stringify(journal)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await fsyncFile(paths.journalPath);
  await fsyncDirectory(paths.operationRoot);
  await fsyncDirectory(paths.operationsRoot);
  return paths;
}

async function restoreJournal(root: string, journal: DeletionJournal) {
  const absoluteRoot = resolve(root);
  const errors: string[] = [];
  const changedDirectories = new Set<string>();
  for (const entry of [...journal.entries].reverse()) {
    const original = join(absoluteRoot, entry.originalRelative);
    const quarantined = join(absoluteRoot, entry.quarantineRelative);
    if (!(await pathExists(quarantined))) continue;
    if (await pathExists(original)) {
      errors.push(`destino já existe: ${basename(original)}`);
      continue;
    }
    try {
      await mkdir(dirname(original), { recursive: true, mode: 0o700 });
      await rename(quarantined, original);
      changedDirectories.add(dirname(original));
      changedDirectories.add(dirname(quarantined));
    } catch (error) {
      errors.push(`${basename(original)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) {
    throw new Error(`Falha ao restaurar exclusão não confirmada: ${errors.join('; ')}`);
  }
  for (const directory of changedDirectories) {
    await fsyncDirectory(directory);
  }
  await rm(journalPaths(root, journal.operationId).operationRoot, { recursive: true, force: true });
  await fsyncDirectory(journalPaths(root, journal.operationId).operationsRoot);
}

async function cleanupCommittedJournal(root: string, journal: DeletionJournal) {
  try {
    await rm(journalPaths(root, journal.operationId).operationRoot, {
      recursive: true,
      force: true,
    });
    return { cleanupDeferred: false };
  } catch {
    // O DB já confirmou a exclusão. Preservar o journal permite concluir a
    // limpeza no próximo boot sem fingir que a transação falhou.
    return { cleanupDeferred: true };
  }
}

export async function stageFileDeletion(
  root: string,
  candidates: string[],
  guards: DeletionGuard[],
): Promise<StagedFileDeletion> {
  const absoluteRoot = resolve(root);
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const operationId = randomUUID();
  const uniqueRelative = Array.from(new Set(
    candidates.map((candidate) => assertUnderRoot(
      absoluteRoot,
      isAbsolute(candidate) ? candidate : join(absoluteRoot, candidate),
    )),
  ));
  const journal: DeletionJournal = {
    version: 1,
    operationId,
    createdAt: new Date().toISOString(),
    guards: [...guards],
    entries: uniqueRelative.map((originalRelative, index) => ({
      originalRelative,
      quarantineRelative: join(
        JOURNAL_DIR,
        operationId,
        'files',
        String(index).padStart(8, '0'),
      ),
    })),
  };
  await writeDurableJournal(absoluteRoot, journal);

  let movedFiles = 0;
  let missingFiles = 0;
  const changedDirectories = new Set<string>();
  try {
    for (const entry of journal.entries) {
      const original = join(absoluteRoot, entry.originalRelative);
      const quarantined = join(absoluteRoot, entry.quarantineRelative);
      if (!(await pathExists(original))) {
        missingFiles += 1;
        continue;
      }
      await rename(original, quarantined);
      changedDirectories.add(dirname(original));
      changedDirectories.add(dirname(quarantined));
      movedFiles += 1;
    }
    for (const directory of changedDirectories) {
      await fsyncDirectory(directory);
    }
  } catch (error) {
    try {
      await restoreJournal(absoluteRoot, journal);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Falha ao preparar exclusão e ao restaurar os arquivos.',
      );
    }
    throw error;
  }

  return {
    operationId,
    movedFiles,
    missingFiles,
    commit: () => cleanupCommittedJournal(absoluteRoot, journal),
    rollback: () => restoreJournal(absoluteRoot, journal),
  };
}

export async function recoverPendingFileDeletions(
  root: string,
  guardExists: (guard: DeletionGuard) => Promise<boolean>,
) {
  const absoluteRoot = resolve(root);
  const operationsRoot = join(absoluteRoot, JOURNAL_DIR);
  let dirs: Array<{ name: string; isDirectory(): boolean }>;
  try {
    dirs = await readdir(operationsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { scanned: 0, restored: 0, cleaned: 0, failed: 0 };
    }
    throw error;
  }

  let scanned = 0;
  let restored = 0;
  let cleaned = 0;
  let failed = 0;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    scanned += 1;
    const operationRoot = join(operationsRoot, dir.name);
    try {
      const raw = await readFile(join(operationRoot, JOURNAL_FILE), 'utf8');
      if (raw.length > 1_000_000) throw new Error('Journal de exclusão excede o tamanho máximo.');
      const journal = JSON.parse(raw) as DeletionJournal;
      validateJournal(absoluteRoot, dir.name, journal);
      const states = await Promise.all(journal.guards.map(guardExists));
      if (states.some(Boolean)) {
        await restoreJournal(absoluteRoot, journal);
        restored += 1;
      } else {
        const result = await cleanupCommittedJournal(absoluteRoot, journal);
        if (result.cleanupDeferred) throw new Error('Limpeza do journal continua pendente.');
        cleaned += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { scanned, restored, cleaned, failed };
}
