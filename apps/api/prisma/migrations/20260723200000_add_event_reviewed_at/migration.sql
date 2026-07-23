-- Fila de revisão: marcar evento como visto.
ALTER TABLE "CameraEvent" ADD COLUMN "reviewedAt" TIMESTAMP(3);
CREATE INDEX "CameraEvent_reviewedAt_idx" ON "CameraEvent"("reviewedAt");
