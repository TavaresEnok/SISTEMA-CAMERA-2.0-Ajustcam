-- Zonas de detecção por câmera (polígonos normalizados 0..1).
-- NULL = câmera inteira monitorada (preserva o comportamento atual).
ALTER TABLE "Camera" ADD COLUMN "detectionZones" JSONB;
