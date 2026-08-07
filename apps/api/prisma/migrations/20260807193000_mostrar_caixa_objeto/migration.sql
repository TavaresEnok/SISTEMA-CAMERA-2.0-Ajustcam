-- "Mostrar quadrado no objeto" — preferência OPERACIONAL da instalação.
--
-- Antes só existia GENERAL_OVERLAY_MODE (variável de ambiente do processo),
-- igual para toda a frota e alterável apenas recriando container. Quem opera
-- precisa poder decidir se quer a marcação na tela, sem linha de comando.
ALTER TABLE "AiSettings" ADD COLUMN "showObjectBox" BOOLEAN NOT NULL DEFAULT true;
