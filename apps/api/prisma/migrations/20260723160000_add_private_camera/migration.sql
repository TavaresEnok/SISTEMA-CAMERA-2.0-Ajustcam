-- Câmera privada (LGPD): conteúdo acessível só ao dono; admin gerencia sem ver.
ALTER TABLE "Camera" ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Camera" ADD COLUMN "ownerUserId" TEXT;
CREATE INDEX "Camera_ownerUserId_idx" ON "Camera"("ownerUserId");
