-- Cota de câmeras privadas por grupo (o "acordado" com o cliente). 0 = nenhuma.
ALTER TABLE "CameraGroup" ADD COLUMN "maxPrivateCameras" INTEGER NOT NULL DEFAULT 0;
