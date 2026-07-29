-- Camada de armazenamento da gravação (offload para bucket S3-compatível).
--
-- O acervo passa a poder viver em dois lugares. Rastrear ONDE cada gravação
-- está é o que permite apagar o arquivo local sem perder a prova — e, mais
-- importante, é o que impede apagar o local de algo que ainda NÃO subiu.
--
--   cloudKey        chave no bucket (NULL = nunca subiu)
--   cloudUploadedAt quando o upload foi CONFIRMADO (não quando começou)
--   localDeletedAt  quando o arquivo local foi removido após o upload
--
-- Toda gravação existente nasce como "só local" (todas as colunas NULL), que é
-- exatamente o estado real do acervo hoje. Nenhum backfill é necessário e
-- nenhuma gravação é considerada "na nuvem" por acidente.
--
-- Índice parcial em cloudKey NULL: a varredura do offload procura justamente o
-- que ainda não subiu, e sem ele essa consulta varreria o acervo inteiro a cada
-- ciclo.
ALTER TABLE "Recording"
ADD COLUMN IF NOT EXISTS "cloudKey" TEXT,
ADD COLUMN IF NOT EXISTS "cloudUploadedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "localDeletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Recording_pending_offload_idx"
ON "Recording" ("startedAt")
WHERE "cloudKey" IS NULL;

CREATE INDEX IF NOT EXISTS "Recording_cloud_pending_local_delete_idx"
ON "Recording" ("cloudUploadedAt")
WHERE "cloudKey" IS NOT NULL AND "localDeletedAt" IS NULL;
