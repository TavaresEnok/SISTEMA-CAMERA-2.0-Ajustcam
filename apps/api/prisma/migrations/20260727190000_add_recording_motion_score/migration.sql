-- Retenção em dois níveis ("N dias de tudo" + "M dias do que teve movimento").
-- Ideia derivada do Frigate (MIT) — Copyright (c) Frigate, Inc.
--
-- motionScore: -1 = DESCONHECIDO (backfill, IA desligada, erro ao contar),
--               0 = sem movimento, > 0 = quantidade de eventos de movimento.
-- O default -1 é deliberado: toda gravação já existente entra em QUARENTENA e
-- NUNCA expira no corte curto — apagar de menos custa disco, apagar de mais é
-- irreversível e pode destruir prova.
ALTER TABLE "Recording"
ADD COLUMN IF NOT EXISTS "motionScore" INTEGER NOT NULL DEFAULT -1;
