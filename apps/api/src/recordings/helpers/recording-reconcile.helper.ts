// Reconciliação DB↔disco de gravações (técnica moonfire `check.rs` / ZoneMinder
// `zmaudit.pl`, REIMPLEMENTADA). PURA e testável: dado o conjunto de paths que o
// Postgres conhece e o conjunto de paths que existem no disco, aponta as duas
// classes de divergência que corroem a integridade das provas:
//
//  - `orfaosNoDisco`: arquivos que EXISTEM no disco mas NÃO têm registro no banco
//    (gravação que o processo fechou mas nunca chegou a registrar — recuperável).
//  - `orfaosNoDb`: registros no banco cujo arquivo NÃO existe mais no disco
//    (linha aponta para nada — some da timeline, download/stream quebram).
//
// Não faz I/O: quem chama coleta as duas listas (query + walk) e passa aqui.

export type RecordingReconciliation = {
  orfaosNoDisco: string[];
  orfaosNoDb: string[];
};

export function reconcileRecordingPaths(
  dbPaths: Iterable<string>,
  diskPaths: Iterable<string>,
): RecordingReconciliation {
  const db = new Set(dbPaths);
  const disk = new Set(diskPaths);

  const orfaosNoDisco: string[] = [];
  for (const path of disk) {
    if (!db.has(path)) orfaosNoDisco.push(path);
  }

  const orfaosNoDb: string[] = [];
  for (const path of db) {
    if (!disk.has(path)) orfaosNoDb.push(path);
  }

  // Ordenação estável: relatório determinístico independentemente da ordem de
  // varredura do filesystem ou do banco.
  orfaosNoDisco.sort();
  orfaosNoDb.sort();
  return { orfaosNoDisco, orfaosNoDb };
}
