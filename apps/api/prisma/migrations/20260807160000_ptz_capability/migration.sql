-- Capacidade PTZ deixa de ser adivinhada.
--
-- Antes, o front deduzia "tem PTZ" de "tem caminho ONVIF configurado"
-- (vmsDataStore.ts). Toda câmera cadastrada por ONVIF virava móvel, e a tela
-- de PTZ listava câmera fixa — enquanto a que tem PTZ de verdade, estando
-- offline, ficava de fora.
--
-- NULL é significativo: quer dizer "ainda não sondada", que é diferente de
-- "não tem PTZ" (false). Só assim a varredura sabe o que ainda falta olhar.
ALTER TABLE "Camera" ADD COLUMN "ptzCapable" BOOLEAN;
-- 'auto' = resultado da sonda | 'manual' = decisão do operador, que a sonda
-- nunca sobrescreve.
ALTER TABLE "Camera" ADD COLUMN "ptzCapableSource" TEXT;
ALTER TABLE "Camera" ADD COLUMN "ptzProbedAt" TIMESTAMP(3);

-- A varredura busca por "quem ainda não sei", então o índice cobre o caso
-- comum de câmera ativa com capacidade desconhecida.
CREATE INDEX "Camera_ptzCapable_idx" ON "Camera"("ptzCapable");
