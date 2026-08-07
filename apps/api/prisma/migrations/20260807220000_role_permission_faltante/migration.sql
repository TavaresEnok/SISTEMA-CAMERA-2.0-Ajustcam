-- TABELA QUE EXISTIA NO SCHEMA MAS NENHUMA MIGRAÇÃO CRIAVA.
--
-- `model RolePermission` está no schema.prisma desde sempre, e o servidor
-- mestre tem a tabela — mas ela chegou lá por fora (provável `prisma db push`
-- em algum momento), não por migração. Resultado: `prisma migrate deploy`
-- numa base NOVA aplicava as 48 migrações, dizia "Database schema is up to
-- date!" e mesmo assim a tabela não existia.
--
-- Descoberto na primeira instalação de cliente (D-GUARDIAN, 07/08/2026):
-- GET /role-permissions devolvia 500 com
-- "The table `public.RolePermission` does not exist in the current database" —
-- ou seja, a tela de Funções e Permissões quebrada em toda instalação nova,
-- enquanto no servidor de desenvolvimento funcionava.
--
-- IF NOT EXISTS porque o mestre (e qualquer base que já tenha recebido o push)
-- precisa aplicar isto sem erro.
CREATE TABLE IF NOT EXISTS "RolePermission" (
    "role" "UserRole" NOT NULL,
    "permissions" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("role")
);
