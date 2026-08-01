-- Caminho próprio do equipamento que publica.
--
-- Medido em campo (2026-08-01, Positivo CIP-B1312-M): a câmera pega só o
-- ENDEREÇO da URL configurada e monta o caminho sozinha a partir do número de
-- série — `live/liveStream_H3ZL2802830WB_0_0C` — descartando o que vem depois
-- do host. O diálogo RTMP completa até o `publish` e só então é recusado.
--
-- Exigir o nosso formato `drac/<chave>` deixaria essa classe inteira de
-- equipamento de fora. Em vez disso o sistema APRENDE: registra a tentativa,
-- o administrador confirma de qual câmera é, e o caminho fica vinculado.
--
-- Único: um caminho pertence a uma câmera só, senão dois equipamentos
-- disputariam o mesmo destino. NULL não colide com NULL no PostgreSQL, então
-- as câmeras sem caminho próprio (a maioria) não ocupam o índice.
ALTER TABLE "Camera"
ADD COLUMN IF NOT EXISTS "rtmpIngestPath" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Camera_rtmpIngestPath_key"
ON "Camera" ("rtmpIngestPath");
