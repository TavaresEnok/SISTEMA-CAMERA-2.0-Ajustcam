-- Revisão POR USUÁRIO: cada operador tem o seu próprio "visto".
-- Substitui o reviewedAt global do CameraEvent (mantido como legado, não removido).
CREATE TABLE "UserEventReview" (
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEventReview_pkey" PRIMARY KEY ("userId","eventId")
);

CREATE INDEX "UserEventReview_eventId_idx" ON "UserEventReview"("eventId");

ALTER TABLE "UserEventReview" ADD CONSTRAINT "UserEventReview_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserEventReview" ADD CONSTRAINT "UserEventReview_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "CameraEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
