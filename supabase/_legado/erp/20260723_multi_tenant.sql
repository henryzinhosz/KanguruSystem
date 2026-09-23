-- VortexERP: Fase 1 - multi-tenant
-- Execute integralmente no SQL Editor do Supabase.
-- O UUID, razão social e CNPJ abaixo representam a operação atual. Ajuste-os antes da execução.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  cnpj TEXT NOT NULL UNIQUE,
  plan_code TEXT NOT NULL DEFAULT 'starter',
  subscription_status TEXT NOT NULL DEFAULT 'ATIVO'
    CHECK (subscription_status IN ('ATIVO', 'ATRASADO', 'BLOQUEADO', 'CANCELADO')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant padrão. Preserve o UUID se precisar executar novamente o script.
INSERT INTO public.tenants (id, legal_name, trade_name, cnpj, plan_code, subscription_status)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'VortexERP - Ambiente de Teste',
  'VortexERP',
  '00000000000000',
  'starter',
  'ATIVO'
)
ON CONFLICT (id) DO NOTHING;

-- A coluna é adicionada já NOT NULL. O DEFAULT apenas atribui o tenant padrão a linhas
-- de teste existentes durante o ALTER; ele é removido logo depois para impedir novos dados sem tenant.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.movements ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.trade_ins ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.supplier_invoices ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES public.tenants(id);

-- SUPER_ADMIN é global e, por definição, não tem tenant_id. Os outros papéis devem ter tenant_id.
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.app_users ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-4000-8000-000000000001';
UPDATE public.app_users SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.app_users ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.app_users ALTER COLUMN unit_id DROP NOT NULL;
ALTER TABLE public.app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE public.app_users ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SELLER', 'OPERATOR'));
ALTER TABLE public.app_users ADD CONSTRAINT app_users_tenant_role_check
  CHECK (
    (role = 'SUPER_ADMIN' AND tenant_id IS NULL)
    OR (role <> 'SUPER_ADMIN' AND tenant_id IS NOT NULL)
  );
ALTER TABLE public.app_users ADD CONSTRAINT app_users_auth_tenant_key UNIQUE (auth_uid, tenant_id);

ALTER TABLE public.products ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.inventory ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.movements ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.sales ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.expenses ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.trade_ins ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.work_orders ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.suppliers ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.supplier_invoices ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE public.store_configs ALTER COLUMN tenant_id DROP DEFAULT;

-- unit_id só é único dentro da empresa.
ALTER TABLE public.store_configs DROP CONSTRAINT IF EXISTS store_configs_pkey;
ALTER TABLE public.store_configs ADD PRIMARY KEY (tenant_id, unit_id);

-- Mantemos os IDs técnicos atuais globais e adicionamos chaves compostas para integridade entre tenants.
ALTER TABLE public.products ADD CONSTRAINT products_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE public.products ADD CONSTRAINT products_tenant_id_sku_key UNIQUE (tenant_id, sku);
ALTER TABLE public.inventory ADD CONSTRAINT inventory_tenant_product_key UNIQUE (tenant_id, product_id);
ALTER TABLE public.inventory ADD CONSTRAINT inventory_tenant_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES public.products(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE IF NOT EXISTS public.user_store_access (
  auth_uid UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (auth_uid, tenant_id, unit_id),
  FOREIGN KEY (auth_uid, tenant_id)
    REFERENCES public.app_users(auth_uid, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, unit_id)
    REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS products_tenant_id_idx ON public.products(tenant_id);
CREATE INDEX IF NOT EXISTS inventory_tenant_id_idx ON public.inventory(tenant_id);
CREATE INDEX IF NOT EXISTS movements_tenant_id_idx ON public.movements(tenant_id);
CREATE INDEX IF NOT EXISTS sales_tenant_id_idx ON public.sales(tenant_id);
CREATE INDEX IF NOT EXISTS expenses_tenant_id_idx ON public.expenses(tenant_id);
CREATE INDEX IF NOT EXISTS trade_ins_tenant_id_idx ON public.trade_ins(tenant_id);
CREATE INDEX IF NOT EXISTS work_orders_tenant_id_idx ON public.work_orders(tenant_id);
CREATE INDEX IF NOT EXISTS suppliers_tenant_id_idx ON public.suppliers(tenant_id);
CREATE INDEX IF NOT EXISTS supplier_invoices_tenant_id_idx ON public.supplier_invoices(tenant_id);
CREATE INDEX IF NOT EXISTS app_users_tenant_id_idx ON public.app_users(tenant_id);

-- Funções de contexto. SECURITY DEFINER evita que a RLS de app_users impeça as próprias policies.
CREATE OR REPLACE FUNCTION public.current_user_tenant_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM public.app_users WHERE auth_uid = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.app_users WHERE auth_uid = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_user_unit_id()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT unit_id FROM public.app_users WHERE auth_uid = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT role = 'SUPER_ADMIN' FROM public.app_users WHERE auth_uid = auth.uid()), false);
$$;

CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT role = 'ADMIN' FROM public.app_users WHERE auth_uid = auth.uid()), false);
$$;

CREATE OR REPLACE FUNCTION public.current_user_has_store_access(p_tenant_id UUID, p_unit_id TEXT)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_user_is_super_admin()
    OR (
      p_tenant_id = public.current_user_tenant_id()
      AND (
        public.current_user_is_admin()
        OR public.current_user_unit_id() = p_unit_id
        OR EXISTS (
          SELECT 1 FROM public.user_store_access usa
          WHERE usa.auth_uid = auth.uid()
            AND usa.tenant_id = p_tenant_id
            AND usa.unit_id = p_unit_id
        )
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.current_user_can_access_tenant(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_user_is_super_admin() OR p_tenant_id = public.current_user_tenant_id();
$$;

-- Impede que o cliente forje tenant_id. Em INSERT, um usuário de tenant recebe seu próprio tenant.
CREATE OR REPLACE FUNCTION public.enforce_current_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id não pode ser alterado';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.tenant_id IS NULL THEN
      IF active_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Selecione um tenant para esta operação';
      END IF;
      NEW.tenant_id := active_tenant_id;
    ELSIF NOT public.current_user_is_super_admin() AND NEW.tenant_id <> active_tenant_id THEN
      RAISE EXCEPTION 'Não é permitido gravar dados em outro tenant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'products', 'inventory', 'movements', 'sales', 'expenses', 'trade_ins',
    'work_orders', 'suppliers', 'supplier_invoices', 'store_configs'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS enforce_current_tenant_trigger ON public.%I', target_table);
    EXECUTE format(
      'CREATE TRIGGER enforce_current_tenant_trigger BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enforce_current_tenant()',
      target_table
    );
  END LOOP;
END;
$$;

-- RLS: remove policies antigas para não manter acesso global por acidente.
DO $$
DECLARE
  target_table TEXT;
  target_policy TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'tenants', 'app_users', 'user_store_access', 'products', 'inventory', 'movements',
    'sales', 'expenses', 'trade_ins', 'work_orders', 'store_configs', 'suppliers', 'supplier_invoices'
  ] LOOP
    FOR target_policy IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = target_table
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target_policy, target_table);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
  END LOOP;
END;
$$;

CREATE POLICY tenants_select ON public.tenants FOR SELECT
  USING (public.current_user_can_access_tenant(id));
CREATE POLICY tenants_update ON public.tenants FOR UPDATE
  USING (public.current_user_is_super_admin() OR (id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (public.current_user_is_super_admin() OR (id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY app_users_select ON public.app_users FOR SELECT
  USING (
    public.current_user_is_super_admin()
    OR auth_uid = auth.uid()
    OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin())
  );
CREATE POLICY app_users_manage ON public.app_users FOR ALL
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (
    public.current_user_is_super_admin()
    OR (
      tenant_id = public.current_user_tenant_id()
      AND public.current_user_is_admin()
      AND role <> 'SUPER_ADMIN'
    )
  );

CREATE POLICY user_store_access_select ON public.user_store_access FOR SELECT
  USING (
    public.current_user_is_super_admin()
    OR auth_uid = auth.uid()
    OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin())
  );
CREATE POLICY user_store_access_manage ON public.user_store_access FOR ALL
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY products_read ON public.products FOR SELECT
  USING (public.current_user_can_access_tenant(tenant_id));
CREATE POLICY products_insert ON public.products FOR INSERT
  WITH CHECK (public.current_user_can_access_tenant(tenant_id));
CREATE POLICY products_update ON public.products FOR UPDATE
  USING (public.current_user_can_access_tenant(tenant_id))
  WITH CHECK (public.current_user_can_access_tenant(tenant_id));
CREATE POLICY products_delete ON public.products FOR DELETE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY inventory_read ON public.inventory FOR SELECT
  USING (public.current_user_can_access_tenant(tenant_id));
CREATE POLICY inventory_insert ON public.inventory FOR INSERT
  WITH CHECK (public.current_user_can_access_tenant(tenant_id));
-- Atualizações de inventário continuam exclusivas das RPCs atômicas.

CREATE POLICY movements_read ON public.movements FOR SELECT
  USING (public.current_user_has_store_access(tenant_id, from_unit_id) OR public.current_user_has_store_access(tenant_id, to_unit_id));
CREATE POLICY movements_insert ON public.movements FOR INSERT
  WITH CHECK (public.current_user_has_store_access(tenant_id, from_unit_id) OR public.current_user_has_store_access(tenant_id, to_unit_id));
CREATE POLICY movements_update ON public.movements FOR UPDATE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));
CREATE POLICY movements_delete ON public.movements FOR DELETE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY sales_read ON public.sales FOR SELECT
  USING (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY sales_insert ON public.sales FOR INSERT
  WITH CHECK (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY sales_update ON public.sales FOR UPDATE
  USING (public.current_user_has_store_access(tenant_id, unit_id))
  WITH CHECK (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY sales_delete ON public.sales FOR DELETE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY expenses_read ON public.expenses FOR SELECT
  USING (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY expenses_insert ON public.expenses FOR INSERT
  WITH CHECK (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY expenses_update ON public.expenses FOR UPDATE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));
CREATE POLICY expenses_delete ON public.expenses FOR DELETE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY trade_ins_read ON public.trade_ins FOR SELECT
  USING (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY trade_ins_insert ON public.trade_ins FOR INSERT
  WITH CHECK (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY trade_ins_update ON public.trade_ins FOR UPDATE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));
CREATE POLICY trade_ins_delete ON public.trade_ins FOR DELETE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY work_orders_read ON public.work_orders FOR SELECT
  USING (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY work_orders_insert ON public.work_orders FOR INSERT
  WITH CHECK (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY work_orders_update ON public.work_orders FOR UPDATE
  USING (public.current_user_has_store_access(tenant_id, unit_id))
  WITH CHECK (public.current_user_has_store_access(tenant_id, unit_id));
CREATE POLICY work_orders_delete ON public.work_orders FOR DELETE
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY store_configs_read ON public.store_configs FOR SELECT
  USING (public.current_user_can_access_tenant(tenant_id));
CREATE POLICY store_configs_manage ON public.store_configs FOR ALL
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY suppliers_read ON public.suppliers FOR SELECT
  USING (public.current_user_can_access_tenant(tenant_id));
CREATE POLICY suppliers_manage ON public.suppliers FOR ALL
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

CREATE POLICY supplier_invoices_read ON public.supplier_invoices FOR SELECT
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));
CREATE POLICY supplier_invoices_manage ON public.supplier_invoices FOR ALL
  USING (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()))
  WITH CHECK (public.current_user_is_super_admin() OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin()));

-- RPCs atômicas passam a obter tenant_id da sessão e filtram todas as leituras/escritas por ele.
CREATE OR REPLACE FUNCTION public.process_inventory_movement(
  p_product_id TEXT, p_from_unit_id TEXT, p_to_unit_id TEXT, p_type TEXT,
  p_quantity INTEGER, p_serials JSONB, p_card_condition TEXT, p_operator_id TEXT,
  p_operator_name TEXT, p_timestamp TIMESTAMPTZ, p_reason TEXT
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  inv_row public.inventory%ROWTYPE;
  current_qty INTEGER;
BEGIN
  IF active_tenant_id IS NULL OR NOT (
    public.current_user_has_store_access(active_tenant_id, p_from_unit_id)
    OR public.current_user_has_store_access(active_tenant_id, p_to_unit_id)
  ) THEN RAISE EXCEPTION 'Acesso negado à movimentação'; END IF;
  SELECT * INTO inv_row FROM public.inventory WHERE tenant_id = active_tenant_id AND product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_from_unit_id = 'FORNECEDOR' AND p_to_unit_id NOT IN ('CLIENTE', 'PERDA') THEN
      INSERT INTO public.inventory (id, tenant_id, product_id, quantities, updated_at)
      VALUES (gen_random_uuid()::text, active_tenant_id, p_product_id, '{}'::jsonb, NOW());
      SELECT * INTO inv_row FROM public.inventory WHERE tenant_id = active_tenant_id AND product_id = p_product_id FOR UPDATE;
    ELSE
      RAISE EXCEPTION 'Produto não encontrado no inventário';
    END IF;
  END IF;
  IF p_from_unit_id <> 'FORNECEDOR' THEN
    current_qty := COALESCE((inv_row.quantities -> p_from_unit_id ->> 'qty')::INTEGER, 0);
    IF current_qty < p_quantity THEN RAISE EXCEPTION 'Estoque insuficiente na origem %', p_from_unit_id; END IF;
    inv_row.quantities := jsonb_set(inv_row.quantities, ARRAY[p_from_unit_id, 'qty'], to_jsonb(current_qty - p_quantity), true);
  END IF;
  IF p_to_unit_id NOT IN ('CLIENTE', 'PERDA') THEN
    current_qty := COALESCE((inv_row.quantities -> p_to_unit_id ->> 'qty')::INTEGER, 0);
    inv_row.quantities := jsonb_set(inv_row.quantities, ARRAY[p_to_unit_id, 'qty'], to_jsonb(current_qty + p_quantity), true);
  END IF;
  UPDATE public.inventory SET quantities = inv_row.quantities, updated_at = NOW()
  WHERE tenant_id = active_tenant_id AND product_id = p_product_id;
  INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason)
  VALUES (gen_random_uuid()::text, active_tenant_id, p_product_id, NULL, p_from_unit_id, p_to_unit_id, p_type, p_quantity, p_serials, p_card_condition, auth.uid()::text, p_operator_name, p_timestamp, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_sale_transaction(
  p_sale_id TEXT, p_invoice_number TEXT, p_unit_id TEXT, p_items JSONB, p_payment_method TEXT,
  p_gross_amount NUMERIC, p_fee_amount NUMERIC, p_net_amount NUMERIC, p_operator_id TEXT,
  p_operator_name TEXT, p_client_cpf TEXT, p_client_name TEXT, p_timestamp TIMESTAMPTZ,
  p_status TEXT, p_requires_approval BOOLEAN
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  item JSONB; item_product_id TEXT; item_quantity INTEGER; current_qty INTEGER;
  inv_row public.inventory%ROWTYPE;
BEGIN
  IF active_tenant_id IS NULL OR NOT public.current_user_has_store_access(active_tenant_id, p_unit_id) THEN RAISE EXCEPTION 'Acesso negado à loja'; END IF;
  INSERT INTO public.sales (id, tenant_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount, net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval)
  VALUES (p_sale_id, active_tenant_id, p_invoice_number, p_unit_id, p_items, p_payment_method, p_gross_amount, p_fee_amount, p_net_amount, auth.uid()::text, p_operator_name, p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval);
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    item_product_id := item->>'productId'; item_quantity := (item->>'quantity')::INTEGER;
    SELECT * INTO inv_row FROM public.inventory WHERE tenant_id = active_tenant_id AND product_id = item_product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Produto % não encontrado no inventário', item_product_id; END IF;
    current_qty := COALESCE((inv_row.quantities -> p_unit_id ->> 'qty')::INTEGER, 0);
    IF current_qty < item_quantity THEN RAISE EXCEPTION 'Estoque insuficiente para o produto % na loja %', item_product_id, p_unit_id; END IF;
    UPDATE public.inventory SET quantities = jsonb_set(inv_row.quantities, ARRAY[p_unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = NOW()
    WHERE tenant_id = active_tenant_id AND product_id = item_product_id;
    INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason)
    VALUES (gen_random_uuid()::text, active_tenant_id, item_product_id, item->>'variationId', p_unit_id, 'CLIENTE', 'SAIDA', item_quantity, item->'serials', item->>'cardCondition', auth.uid()::text, p_operator_name, p_timestamp, 'Venda registrada');
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_sale_cancellation(p_sale_id TEXT, p_approved_by TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  sale_row public.sales%ROWTYPE; item JSONB; item_product_id TEXT; item_quantity INTEGER;
BEGIN
  SELECT * INTO sale_row FROM public.sales WHERE tenant_id = active_tenant_id AND id = p_sale_id FOR UPDATE;
  IF NOT FOUND OR NOT public.current_user_has_store_access(active_tenant_id, sale_row.unit_id) THEN RAISE EXCEPTION 'Venda não encontrada ou acesso negado'; END IF;
  UPDATE public.sales SET status = 'CANCELADA', approved_by = p_approved_by WHERE tenant_id = active_tenant_id AND id = p_sale_id;
  FOR item IN SELECT * FROM jsonb_array_elements(sale_row.items) LOOP
    item_product_id := item->>'productId'; item_quantity := (item->>'quantity')::INTEGER;
    UPDATE public.inventory SET quantities = jsonb_set(quantities, ARRAY[sale_row.unit_id, 'qty'], to_jsonb(COALESCE((quantities -> sale_row.unit_id ->> 'qty')::INTEGER, 0) + item_quantity), true), updated_at = NOW()
    WHERE tenant_id = active_tenant_id AND product_id = item_product_id;
    INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason)
    VALUES (gen_random_uuid()::text, active_tenant_id, item_product_id, item->>'variationId', 'CLIENTE', sale_row.unit_id, 'SAIDA', item_quantity, item->'serials', item->>'cardCondition', auth.uid()::text, sale_row.operator_name, NOW(), 'Cancelamento de venda');
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.process_inventory_movement(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_sale_transaction(TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_sale_cancellation(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_inventory_movement(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_sale_transaction(TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_sale_cancellation(TEXT, TEXT) TO authenticated;

-- Para promover a conta proprietária da plataforma depois de descobrir o UUID em Authentication > Users:
-- UPDATE public.app_users
-- SET role = 'SUPER_ADMIN', tenant_id = NULL, unit_id = NULL
-- WHERE auth_uid = 'COLE-O-UUID-DA-CONTA-AQUI';

COMMIT;