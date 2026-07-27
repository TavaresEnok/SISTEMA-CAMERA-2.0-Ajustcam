-- ============================================================================
-- FUNDAÇÃO Tenant/RLS (item 3.1) — MECANISMO, gated no gatilho comercial.
-- ============================================================================
-- Isolamento multi-tenant por Row-Level Security. A política permite TUDO quando
-- `app.current_tenant` NÃO está setado (o estado single-tenant ATUAL → comportamento
-- 100% inalterado) e isola por tenant quando setado. Isto torna a adoção incremental
-- e reversível: enquanto a app não seta o GUC, nada muda.
--
-- PRÉ-REQUISITOS para o RLS de fato valer (senão é bypassed):
--   1) A app deve conectar como role NÃO-superuser e SEM BYPASSRLS (em prod, o
--      usuário do DATABASE_URL da API não pode ser superuser).
--   2) FORCE ROW LEVEL SECURITY faz a política valer inclusive para o DONO da tabela.
--   3) A app abre cada request/transação com:  SET LOCAL app.current_tenant = '<id>';
--
-- COMPOSIÇÃO com a câmera privada (invariante LGPD 1.2.i): RLS é a fronteira EXTERNA
-- (entre tenants, no BANCO). A inversão de admin de câmera privada (canViewCamera,
-- app) é a INTERNA (dentro do tenant). Compõem — RLS não substitui nem enfraquece a
-- checagem de privacidade; apenas garante que um bug de query nunca cruze tenants.
--
-- Aplique a CADA tabela tenant-scoped (exige a coluna "tenantId"). Exemplo p/ Camera:
--   \i tenant-rls.sql  (ou rode o bloco abaixo trocando o nome da tabela)

-- ⚠️ FAIL-OPEN POR DESIGN, E SÓ ENQUANTO DURAR A ADOÇÃO. A política abaixo permite
-- TUDO quando `app.current_tenant` não está setado — é isso que torna a adoção
-- incremental e reversível (o single-tenant atual não muda em nada). MAS ela NÃO
-- protege contra o erro mais provável no dia a dia multi-tenant: ESQUECER de setar
-- o tenant. No ROLLOUT REAL (quando houver cliente multi-organização), troque para
-- a variante FAIL-CLOSED abaixo — nega quando o GUC está ausente — depois que o
-- wrapper de transação estiver garantindo o `SET LOCAL` em todo request.
--
--   CREATE POLICY drac_tenant_isolation ON <tabela>
--     USING ("tenantId" = current_setting('app.current_tenant', true));
--   -- (sem GUC → current_setting devolve NULL → comparação NULL → nega tudo)
--
-- Use `drac_enable_tenant_rls(tbl, fail_closed => true)` para já nascer fechada.

-- Função reutilizável: habilita RLS + FORCE + política de isolamento numa tabela.
CREATE OR REPLACE FUNCTION drac_enable_tenant_rls(tbl regclass, fail_closed boolean DEFAULT false)
RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  IF fail_closed THEN
    -- Estado-alvo do rollout: sem o GUC, current_setting devolve NULL e a
    -- comparação nega TUDO. Esquecer o `SET LOCAL` vira erro visível (nenhuma
    -- linha), não vazamento silencioso entre tenants.
    EXECUTE format($f$
      CREATE POLICY drac_tenant_isolation ON %s
        USING ("tenantId" = current_setting('app.current_tenant', true))
    $f$, tbl);
  ELSE
    -- Adoção incremental (default): sem o GUC, comporta-se como hoje.
    EXECUTE format($f$
      CREATE POLICY drac_tenant_isolation ON %s
        USING (current_setting('app.current_tenant', true) IS NULL
               OR current_setting('app.current_tenant', true) = ''
               OR "tenantId" = current_setting('app.current_tenant', true))
    $f$, tbl);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Ex.: SELECT drac_enable_tenant_rls('"Camera"');  -- (após adicionar "tenantId")
