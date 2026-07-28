-- DRAC-AUD-011/012
--
-- Normalização conservadora de permissões legadas:
--   * linha sem alvo não concede nada e é removida;
--   * linha com câmera E grupo é reduzida ao alvo mais estreito (a câmera);
--   * duplicatas preservam o MENOR privilégio e a linha mais antiga.
DELETE FROM "CameraPermission"
WHERE "cameraId" IS NULL AND "groupId" IS NULL;

UPDATE "CameraPermission"
SET "groupId" = NULL
WHERE "cameraId" IS NOT NULL AND "groupId" IS NOT NULL;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId", "cameraId"
      ORDER BY
        CASE "level"::text
          WHEN 'VIEW' THEN 1
          WHEN 'CONTROL' THEN 2
          WHEN 'RECORD' THEN 3
          WHEN 'ADMIN' THEN 4
          ELSE 5
        END ASC,
        "createdAt" ASC,
        "id" ASC
    ) AS position
  FROM "CameraPermission"
  WHERE "cameraId" IS NOT NULL
)
DELETE FROM "CameraPermission" permission
USING ranked
WHERE permission."id" = ranked."id" AND ranked.position > 1;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId", "groupId"
      ORDER BY
        CASE "level"::text
          WHEN 'VIEW' THEN 1
          WHEN 'CONTROL' THEN 2
          WHEN 'RECORD' THEN 3
          WHEN 'ADMIN' THEN 4
          ELSE 5
        END ASC,
        "createdAt" ASC,
        "id" ASC
    ) AS position
  FROM "CameraPermission"
  WHERE "groupId" IS NOT NULL
)
DELETE FROM "CameraPermission" permission
USING ranked
WHERE permission."id" = ranked."id" AND ranked.position > 1;

ALTER TABLE "CameraPermission"
ADD CONSTRAINT "CameraPermission_exactly_one_target_check"
CHECK (("cameraId" IS NOT NULL) <> ("groupId" IS NOT NULL));

CREATE UNIQUE INDEX "CameraPermission_user_camera_unique"
ON "CameraPermission" ("userId", "cameraId")
WHERE "cameraId" IS NOT NULL;

CREATE UNIQUE INDEX "CameraPermission_user_group_unique"
ON "CameraPermission" ("userId", "groupId")
WHERE "groupId" IS NOT NULL;

-- Registros órfãos anteriores à FK são tornados privados sem dono. Os bytes e
-- metadados são preservados e continuam tecnicamente administráveis; nenhuma
-- conta ganha acesso por suposição.
UPDATE "Camera" camera
SET "ownerUserId" = NULL
WHERE camera."ownerUserId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "User" owner WHERE owner."id" = camera."ownerUserId"
  );

ALTER TABLE "Camera"
ADD CONSTRAINT "Camera_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
