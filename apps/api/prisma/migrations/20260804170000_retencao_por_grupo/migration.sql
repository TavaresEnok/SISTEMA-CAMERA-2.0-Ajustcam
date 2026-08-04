-- Retenção herdada do grupo, com exceção por câmera.
--
-- Até aqui só existia `Camera.retentionDays`, e a única forma de aplicar em lote
-- era o botão do grupo — que SOBRESCREVIA o número de cada câmera. Toda vez que
-- alguém mexia no grupo, as exceções cuidadosamente ajustadas se perdiam, sem
-- volta.
--
-- Agora o grupo guarda a política e a câmera escolhe se a segue. Grupo nasce com
-- um número (nunca vazio), porque um toggle "seguir o grupo" apontando para o
-- nada não é uma opção válida de oferecer.

ALTER TABLE "CameraGroup"
ADD COLUMN IF NOT EXISTS "retentionDays" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "Camera"
ADD COLUMN IF NOT EXISTS "retentionFollowsGroup" BOOLEAN NOT NULL DEFAULT true;

-- ⚠ PASSO OBRIGATÓRIO, e o motivo de ele existir:
--
-- O DEFAULT acima vale para linha NOVA, mas o Postgres também o aplica às linhas
-- que já existem. Sem o UPDATE abaixo, TODA câmera já cadastrada passaria a
-- seguir o grupo instantaneamente — e um acervo de 90 dias viraria 3 na
-- varredura seguinte, que roda de hora em hora e apaga até 20.000 gravações por
-- ciclo.
--
-- Medido nesta instalação no momento da migração: 23 câmeras com 90 dias. O
-- descuido aqui apagaria 87 dias de gravação de 23 câmeras, sem desfazer.
--
-- Câmera que já existe mantém o número dela como EXCEÇÃO. Quem quiser passar a
-- herdar do grupo liga o toggle depois, uma a uma, sabendo o que está fazendo.
UPDATE "Camera" SET "retentionFollowsGroup" = false;

-- O grupo herda o valor mais comum entre as câmeras que ele já tem, para nascer
-- coerente com a realidade em vez de com um padrão genérico. Sem câmeras, fica
-- o default de 3.
UPDATE "CameraGroup" g
SET "retentionDays" = sub.dias
FROM (
  SELECT "groupId", mode() WITHIN GROUP (ORDER BY "retentionDays") AS dias
  FROM "Camera"
  WHERE "groupId" IS NOT NULL
  GROUP BY "groupId"
) sub
WHERE g.id = sub."groupId";
