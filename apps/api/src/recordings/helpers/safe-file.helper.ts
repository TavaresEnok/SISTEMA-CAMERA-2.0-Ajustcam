import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

/**
 * Resolve o prefixo existente por realpath e mantém apenas os componentes que
 * ainda não existem. Assim, tanto arquivos de leitura quanto caminhos de saída
 * não podem atravessar um diretório symlink que já exista.
 */
function resolveThroughExistingParent(inputPath: string): string {
  let existing = inputPath;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(relative(parent, existing));
    existing = parent;
  }
  const canonicalParent = existsSync(existing) ? realpathSync(existing) : resolve(existing);
  return resolve(canonicalParent, ...missing);
}

export function ensureFileUnderRoot(root: string, filePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedFile = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(resolvedRoot, filePath);

  // A barreira lexical continua sendo feita primeiro, inclusive quando a raiz
  // ainda será criada. Isso também evita que realpath de um alvo arbitrário
  // seja consultado antes de rejeitarmos `..`/prefixos irmãos.
  if (!isWithin(resolvedRoot, resolvedFile)) {
    throw new Error('Arquivo fora da raiz de gravações.');
  }

  const canonicalRoot = resolveThroughExistingParent(resolvedRoot);
  const canonicalFile = resolveThroughExistingParent(resolvedFile);
  if (!isWithin(canonicalRoot, canonicalFile)) {
    throw new Error('Arquivo fora da raiz de gravações (symlink recusado).');
  }

  // Retornar o caminho canônico elimina a janela em que o symlink já validado
  // seria seguido novamente pelos chamadores. Operações críticas ainda devem
  // manter o volume sem escrita por usuários não confiáveis.
  return canonicalFile;
}
