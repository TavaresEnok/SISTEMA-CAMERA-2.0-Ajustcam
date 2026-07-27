-- Bloqueio comercial POR GRUPO: o dono da instalação corta um cliente final que
-- parou de pagar, com o mesmo escalonamento que a Central aplica sobre a
-- instalação inteira. Aditivo e não-destrutivo: todo grupo existente nasce
-- ACTIVE, então o comportamento atual é preservado byte a byte.
DO $$ BEGIN
  CREATE TYPE "GroupAccessStatus" AS ENUM ('ACTIVE', 'RESTRICTED', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "CameraGroup"
  ADD COLUMN IF NOT EXISTS "accessStatus" "GroupAccessStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "accessMessage" TEXT;
