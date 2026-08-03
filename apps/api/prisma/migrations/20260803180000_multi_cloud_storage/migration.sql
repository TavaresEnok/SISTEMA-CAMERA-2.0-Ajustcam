-- Vários storages em nuvem por instalação.
--
-- O problema que isto resolve: até aqui existia UMA configuração de storage
-- (`SystemSetting['cloud.storage']`), e a gravação guardava só `cloudKey` — sem
-- registrar EM QUAL bucket o objeto está. Trocar de fornecedor apontava o
-- playback para o bucket novo procurando chaves do antigo: o acervo inteiro
-- sumia da tela. Os dados continuavam lá, inacessíveis, e a retenção também
-- deixava de alcançá-los para limpar.
--
-- É o caso real de um cliente que contrata 1 TB, cresce e migra para 10 TB de
-- outro fornecedor sem querer perder o histórico.
--
-- Com o vínculo por gravação:
--   · ESCRITA vai sempre para o storage marcado como ativo;
--   · LEITURA resolve pelo storage de origem de cada gravação;
--   · RETENÇÃO apaga no bucket certo;
--   · o antigo vira somente-leitura e se esvazia sozinho conforme a retenção
--     vence — sem copiar terabytes nem janela de indisponibilidade.
--
-- `cloudStorageId` NULL significa "storage legado" (a configuração única). O
-- código trata NULL caindo na config antiga, então instalações anteriores a
-- esta migração continuam funcionando sem nenhum backfill obrigatório.
CREATE TABLE IF NOT EXISTS "CloudStorage" (
    "id"                       TEXT NOT NULL,
    "name"                     TEXT NOT NULL,
    "provider"                 TEXT NOT NULL DEFAULT 's3',
    "endpoint"                 TEXT NOT NULL,
    "region"                   TEXT NOT NULL DEFAULT 'us-east-1',
    "bucket"                   TEXT NOT NULL,
    "prefix"                   TEXT NOT NULL DEFAULT '',
    "accessKeyId"              TEXT NOT NULL,
    "secretAccessKeyEncrypted" TEXT NOT NULL,
    "forcePathStyle"           BOOLEAN NOT NULL DEFAULT true,
    "isActive"                 BOOLEAN NOT NULL DEFAULT false,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CloudStorage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CloudStorage_isActive_idx" ON "CloudStorage" ("isActive");

-- SOMENTE UM ativo por instalação, garantido pelo banco e não por disciplina do
-- código: dois ativos fariam gravações irem para buckets diferentes de forma
-- imprevisível, e ninguém descobriria até precisar da prova.
CREATE UNIQUE INDEX IF NOT EXISTS "CloudStorage_single_active_idx"
ON "CloudStorage" ("isActive") WHERE "isActive" = true;

ALTER TABLE "Recording"
ADD COLUMN IF NOT EXISTS "cloudStorageId" TEXT;

-- ON DELETE SET NULL: apagar o cadastro de um storage não pode apagar em cascata
-- o registro das gravações que estavam nele. A linha sobrevive apontando para o
-- legado, e o operador vê que aquele acervo perdeu o destino — muito melhor que
-- descobrir depois que a prova sumiu do banco junto com a configuração.
ALTER TABLE "Recording"
ADD CONSTRAINT "Recording_cloudStorageId_fkey"
FOREIGN KEY ("cloudStorageId") REFERENCES "CloudStorage"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Recording_cloudStorageId_idx" ON "Recording" ("cloudStorageId");
