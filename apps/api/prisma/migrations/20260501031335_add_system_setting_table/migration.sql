-- CORREÇÃO DE HISTÓRICO: nenhuma migração criava a tabela "SystemSetting", mas
-- 20260715150000 e 20260720120000 fazem INSERT nela — então `prisma migrate deploy`
-- num banco VAZIO (instalação nova) quebrava com `relation "SystemSetting" does not exist`.
--
-- Esta migração tem timestamp logo após a init, então roda ANTES daqueles INSERT
-- (conserta instalação nova). `IF NOT EXISTS` a torna um no-op idempotente nos bancos
-- EXISTENTES (onde a tabela já foi criada por `db push` no passado), sem duplicar nada.
CREATE TABLE IF NOT EXISTS "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByUserId" TEXT,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);
