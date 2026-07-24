import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

// Varredura do disco de gravações (I/O — separada do helper PURO de reconciliação).
// Percorre a raiz e devolve os caminhos ABSOLUTOS resolvidos de todo arquivo de
// gravação (por extensão), pulando os diretórios internos ocultos (`.pre-buffer`,
// `.playback-compatible`, `.diagnostics-cache`, thumbnails etc.). Os caminhos são
// resolvidos para casar 1:1 com os do banco após `ensureFileUnderRoot`.

export function listRecordingFilesOnDisk(root: string, extensions: string[] = ['.mp4']): string[] {
  const resolvedRoot = resolve(root);
  const exts = extensions.map((e) => e.toLowerCase());
  const out: string[] = [];

  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // diretório removido em corrida / sem permissão: ignora
    }
    for (const entry of entries) {
      // Ignora as pastas internas (começam com ponto): cache, pré-buffer etc.
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (!exts.some((ext) => lower.endsWith(ext))) continue;
      try {
        if (statSync(full).size <= 0) continue; // arquivo vazio não conta como gravação
      } catch {
        continue;
      }
      out.push(resolve(full));
    }
  };

  walk(resolvedRoot);
  return out;
}
