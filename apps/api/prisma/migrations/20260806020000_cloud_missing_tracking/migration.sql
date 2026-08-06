-- Vigilância do acervo remoto: quando o objeto foi conferido no bucket, e
-- desde quando ele está SUMIDO (bucket saudável, objeto ausente = apagado por
-- fora). A linha nunca é removida por isso — ela é o registro da perda e o
-- mapa (cloudKey) para reencontrar o objeto se ele for restaurado.
ALTER TABLE "Recording" ADD COLUMN "cloudVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Recording" ADD COLUMN "cloudMissingSince" TIMESTAMP(3);
