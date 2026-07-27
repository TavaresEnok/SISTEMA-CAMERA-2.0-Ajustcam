#!/usr/bin/env bash
#
# Prova o MECANISMO Tenant/RLS (item 3.1) contra um Postgres real (docker):
#   1) app (role NAO-superuser) com SET app.current_tenant='A' ve SO o tenant A;
#   2) SEM setar o GUC -> ve TUDO (backward-compat: single-tenant atual intocado);
#   3) DENTES: sem a politica, o mesmo app vaza os dois tenants.
# Sai 0 se todas as asserçoes passam, 1 se qualquer uma falha. Auto-limpa o container.
#
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

CT=drac-rls-verify
PW=test
docker rm -f "$CT" >/dev/null 2>&1 || true
docker run -d --name "$CT" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=rls -p 55450:5432 postgres:16-alpine >/dev/null
trap 'docker rm -f "$CT" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 60); do docker exec "$CT" psql -U postgres -d rls -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done

# -tA (tuplas/unaligned) + pega a ULTIMA linha (o count e sempre o ultimo statement;
# tags de status como "SET"/"DROP POLICY" saem antes e sao descartadas).
q() { docker exec -i "$CT" psql -U postgres -d rls -tA | tail -n1; }

# Setup: tabela demo tenant-scoped + 2 tenants + role app NAO-superuser + RLS.
docker exec -i "$CT" psql -U postgres -d rls -q >/dev/null <<'SQL'
CREATE TABLE demo ("id" text PRIMARY KEY, "tenantId" text NOT NULL, name text);
INSERT INTO demo VALUES ('a1','A','camA1'), ('a2','A','camA2'), ('b1','B','camB1');
CREATE ROLE app_role NOSUPERUSER;
GRANT SELECT ON demo TO app_role;
ALTER TABLE demo ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo FORCE ROW LEVEL SECURITY;
CREATE POLICY drac_tenant_isolation ON demo
  USING (current_setting('app.current_tenant', true) IS NULL
         OR current_setting('app.current_tenant', true) = ''
         OR "tenantId" = current_setting('app.current_tenant', true));
SQL

fail=0
assert_eq() { if [ "$2" = "$3" ]; then echo "  OK    $1 ($3)"; else echo "  FALHA $1: esperado=$2 obtido=$3"; fail=1; fi; }

got=$(q <<'SQL'
SET ROLE app_role; SET app.current_tenant = 'A'; SELECT count(*) FROM demo;
SQL
)
assert_eq "tenant A isolado (RLS)" 2 "$got"

got=$(q <<'SQL'
SET ROLE app_role; SET app.current_tenant = 'B'; SELECT count(*) FROM demo;
SQL
)
assert_eq "tenant B isolado (RLS)" 1 "$got"

got=$(q <<'SQL'
SET ROLE app_role; SELECT count(*) FROM demo;
SQL
)
assert_eq "sem app.current_tenant -> ve tudo (backward-compat)" 3 "$got"

got=$(q <<'SQL'
ALTER TABLE demo DISABLE ROW LEVEL SECURITY; SET ROLE app_role; SET app.current_tenant = 'A'; SELECT count(*) FROM demo;
SQL
)
assert_eq "SEM RLS -> vaza os 2 tenants (prova que era o RLS que isolava)" 3 "$got"

# FAIL-CLOSED (estado-alvo do rollout): sem o GUC, nega TUDO — esquecer o
# `SET LOCAL app.current_tenant` vira erro visível, não vazamento entre tenants.
docker exec -i "$CT" psql -U postgres -d rls -q >/dev/null <<'SQL'
ALTER TABLE demo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS drac_tenant_isolation ON demo;
CREATE POLICY drac_tenant_isolation ON demo
  USING ("tenantId" = current_setting('app.current_tenant', true));
SQL

got=$(q <<'SQL'
SET ROLE app_role; SET app.current_tenant = 'A'; SELECT count(*) FROM demo;
SQL
)
assert_eq "fail-closed: com tenant setado, isola normalmente" 2 "$got"

got=$(q <<'SQL'
SET ROLE app_role; SELECT count(*) FROM demo;
SQL
)
assert_eq "fail-closed: SEM tenant setado -> NEGA tudo (nao vaza)" 0 "$got"

echo ""
[ "$fail" = 0 ] && echo "RLS PROVADO: isolamento + backward-compat + dentes + fail-closed." || echo "RLS FALHOU."
exit "$fail"
