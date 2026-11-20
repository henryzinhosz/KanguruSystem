-- =========================================================================
-- Catalogo de fornecedores + pedido de compra (desenho aprovado em 2026-10-30).
-- O franqueado importa a planilha de precos do fornecedor (o ERP le e separa marca, tipo
-- e preco real sozinho; a conferencia fica em reading_config para a proxima planilha),
-- consulta o catalogo com o proprio estoque ao lado (so informativo) e monta pedidos de
-- compra (varias marcas do mesmo fornecedor) com PDF. O pedido NAO mexe no estoque.
-- Catalogos da rede pelo UCP ficam para a 2a etapa.
-- Aditiva: 4 tabelas novas (leitura por RLS, escrita so pelas RPCs) e RPCs novas.
-- Conferido no banco em 2026-10-30: suppliers.id TEXT, unique (tenant_id, id); tabelas novas
-- ainda nao existiam.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.supplier_catalogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL,
  reading_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  file_name TEXT,
  imported_at TIMESTAMPTZ,
  imported_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT supplier_catalogs_supplier_key UNIQUE (tenant_id, supplier_id),
  CONSTRAINT supplier_catalogs_supplier_fk
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES public.suppliers(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.supplier_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  catalog_id UUID NOT NULL REFERENCES public.supplier_catalogs(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL, -- codigo do fornecedor normalizado (ou o nome, quando nao ha codigo)
  supplier_code TEXT,
  name TEXT NOT NULL,
  brand TEXT,
  product_type TEXT,
  status TEXT,
  sheet_name TEXT,
  unit_cost NUMERIC(12, 4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  previous_cost NUMERIC(12, 4), -- preco da planilha anterior, quando mudou
  price_details JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true, -- false = saiu da ultima planilha
  product_id TEXT, -- produto do franqueado ligado ao item (so para mostrar o estoque)
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT supplier_catalog_items_key UNIQUE (catalog_id, item_key)
);

CREATE INDEX IF NOT EXISTS supplier_catalog_items_tenant_idx ON public.supplier_catalog_items (tenant_id, catalog_id);

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL,
  order_number INTEGER NOT NULL,
  unit_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RASCUNHO' CHECK (status IN ('RASCUNHO', 'ENVIADO', 'CANCELADO')),
  notes TEXT,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT purchase_orders_number_key UNIQUE (tenant_id, order_number),
  CONSTRAINT purchase_orders_supplier_fk
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES public.suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_orders_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  catalog_item_id UUID REFERENCES public.supplier_catalog_items(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  supplier_code TEXT,
  name TEXT NOT NULL,
  brand TEXT,
  product_type TEXT,
  unit_cost NUMERIC(12, 4) NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price_pending BOOLEAN NOT NULL DEFAULT false -- preco zerado na planilha: "a confirmar"
);

CREATE INDEX IF NOT EXISTS purchase_order_items_order_idx ON public.purchase_order_items (order_id);

-- Leitura: usuarios da empresa. Escrita: so pelas RPCs abaixo.
ALTER TABLE public.supplier_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supplier_catalogs_read ON public.supplier_catalogs;
CREATE POLICY supplier_catalogs_read ON public.supplier_catalogs FOR SELECT
  USING (public.current_user_can_access_tenant(tenant_id));
DROP POLICY IF EXISTS supplier_catalog_items_read ON public.supplier_catalog_items;
CREATE POLICY supplier_catalog_items_read ON public.supplier_catalog_items FOR SELECT
  USING (public.current_user_can_access_tenant(tenant_id));
DROP POLICY IF EXISTS purchase_orders_read ON public.purchase_orders;
CREATE POLICY purchase_orders_read ON public.purchase_orders FOR SELECT
  USING (public.current_user_can_access_tenant(tenant_id) AND public.current_user_has_store_access(tenant_id, unit_id));
DROP POLICY IF EXISTS purchase_order_items_read ON public.purchase_order_items;
CREATE POLICY purchase_order_items_read ON public.purchase_order_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.purchase_orders AS purchase_order
    WHERE purchase_order.id = purchase_order_items.order_id
      AND public.current_user_can_access_tenant(purchase_order.tenant_id)
      AND public.current_user_has_store_access(purchase_order.tenant_id, purchase_order.unit_id)
  ));

REVOKE INSERT, UPDATE, DELETE ON public.supplier_catalogs, public.supplier_catalog_items,
  public.purchase_orders, public.purchase_order_items FROM anon, authenticated;

-- Usuario do ERP ativo da empresa (gerente tambem importa e faz pedidos).
CREATE OR REPLACE FUNCTION public.supplier_catalog_user()
RETURNS public.app_users
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM public.app_users WHERE auth_uid = auth.uid();
  IF NOT FOUND OR v_user.tenant_id IS NULL OR v_user.is_active IS FALSE THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.supplier_catalog_user() FROM PUBLIC, anon, authenticated;

-- Importa a planilha conferida: atualiza os itens pelo codigo (guarda o preco anterior
-- quando muda), marca como "saiu da lista" o que nao veio e guarda a configuracao de leitura.
-- Ligacoes com produtos do cadastro sao mantidas.
CREATE OR REPLACE FUNCTION public.import_supplier_catalog(
  p_supplier_id TEXT,
  p_file_name TEXT,
  p_config JSONB,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE := public.supplier_catalog_user();
  v_catalog_id UUID;
  v_item JSONB;
  v_key TEXT;
  v_cost NUMERIC;
  v_existing public.supplier_catalog_items%ROWTYPE;
  v_new INTEGER := 0;
  v_changed INTEGER := 0;
  v_removed INTEGER := 0;
  v_total INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE tenant_id = v_user.tenant_id AND id = p_supplier_id) THEN
    RAISE EXCEPTION 'Fornecedor não encontrado';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A planilha não tem itens para importar';
  END IF;
  IF jsonb_array_length(p_items) > 20000 THEN
    RAISE EXCEPTION 'Planilha grande demais (máximo de 20.000 itens)';
  END IF;

  INSERT INTO public.supplier_catalogs (tenant_id, supplier_id, reading_config, file_name, imported_at, imported_by_name)
  VALUES (v_user.tenant_id, p_supplier_id, COALESCE(p_config, '{}'::JSONB), p_file_name, NOW(), v_user.display_name)
  ON CONFLICT (tenant_id, supplier_id) DO UPDATE
  SET reading_config = EXCLUDED.reading_config, file_name = EXCLUDED.file_name,
      imported_at = EXCLUDED.imported_at, imported_by_name = EXCLUDED.imported_by_name
  RETURNING id INTO v_catalog_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_key := NULLIF(BTRIM(v_item->>'key'), '');
    IF v_key IS NULL OR NULLIF(BTRIM(v_item->>'name'), '') IS NULL THEN
      CONTINUE;
    END IF;
    v_cost := GREATEST(COALESCE(NULLIF(v_item->>'cost', '')::NUMERIC, 0), 0);

    SELECT * INTO v_existing FROM public.supplier_catalog_items
    WHERE catalog_id = v_catalog_id AND item_key = v_key;
    -- Codigo repetido na planilha: vale a primeira linha (updated_at = NOW() = ja visto agora).
    IF FOUND AND v_existing.updated_at = NOW() THEN
      CONTINUE;
    END IF;
    v_total := v_total + 1;
    IF NOT FOUND THEN
      v_new := v_new + 1;
      INSERT INTO public.supplier_catalog_items (
        tenant_id, catalog_id, item_key, supplier_code, name, brand, product_type, status, sheet_name,
        unit_cost, price_details
      ) VALUES (
        v_user.tenant_id, v_catalog_id, v_key, NULLIF(BTRIM(v_item->>'code'), ''), BTRIM(v_item->>'name'),
        NULLIF(BTRIM(v_item->>'brand'), ''), NULLIF(BTRIM(v_item->>'type'), ''), NULLIF(BTRIM(v_item->>'status'), ''),
        NULLIF(BTRIM(v_item->>'sheet'), ''), ROUND(v_cost, 4), v_item->'priceDetails'
      );
    ELSE
      IF ROUND(v_cost, 4) <> v_existing.unit_cost THEN
        v_changed := v_changed + 1;
      END IF;
      UPDATE public.supplier_catalog_items
      SET supplier_code = NULLIF(BTRIM(v_item->>'code'), ''),
          name = BTRIM(v_item->>'name'),
          brand = NULLIF(BTRIM(v_item->>'brand'), ''),
          product_type = NULLIF(BTRIM(v_item->>'type'), ''),
          status = NULLIF(BTRIM(v_item->>'status'), ''),
          sheet_name = NULLIF(BTRIM(v_item->>'sheet'), ''),
          previous_cost = CASE WHEN ROUND(v_cost, 4) <> v_existing.unit_cost THEN v_existing.unit_cost ELSE NULL END,
          unit_cost = ROUND(v_cost, 4),
          price_details = v_item->'priceDetails',
          is_active = true,
          updated_at = NOW()
      WHERE id = v_existing.id;
    END IF;
  END LOOP;

  UPDATE public.supplier_catalog_items
  SET is_active = false, previous_cost = NULL, updated_at = NOW()
  WHERE catalog_id = v_catalog_id AND is_active AND updated_at < NOW();
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  RETURN jsonb_build_object('catalogId', v_catalog_id, 'total', v_total,
    'new', v_new, 'priceChanged', v_changed, 'removed', v_removed);
END;
$$;

REVOKE ALL ON FUNCTION public.import_supplier_catalog(TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_supplier_catalog(TEXT, TEXT, JSONB, JSONB) TO authenticated;

-- Liga (ou desliga, com NULL) um item do fornecedor a um produto do cadastro.
CREATE OR REPLACE FUNCTION public.link_supplier_catalog_item(p_item_id UUID, p_product_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE := public.supplier_catalog_user();
BEGIN
  IF p_product_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.products WHERE tenant_id = v_user.tenant_id AND id = p_product_id) THEN
    RAISE EXCEPTION 'Produto não encontrado';
  END IF;
  UPDATE public.supplier_catalog_items SET product_id = p_product_id
  WHERE id = p_item_id AND tenant_id = v_user.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item do catálogo não encontrado';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.link_supplier_catalog_item(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_supplier_catalog_item(UUID, TEXT) TO authenticated;

-- Cria ou atualiza um pedido (so rascunho pode mudar). Os itens vem do catalogo do
-- fornecedor e ficam copiados no pedido (nome, marca, preco do momento).
-- p_items: [{"catalogItemId": "...", "quantity": 2}]
CREATE OR REPLACE FUNCTION public.save_purchase_order(
  p_order_id UUID,
  p_supplier_id TEXT,
  p_unit_id TEXT,
  p_notes TEXT,
  p_items JSONB,
  p_send BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE := public.supplier_catalog_user();
  v_order public.purchase_orders%ROWTYPE;
  v_item JSONB;
  v_catalog_item public.supplier_catalog_items%ROWTYPE;
  v_quantity INTEGER;
  v_position INTEGER := 0;
  v_total NUMERIC := 0;
BEGIN
  IF NOT public.current_user_has_store_access(v_user.tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja de entrega';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Adicione ao menos um item ao pedido';
  END IF;

  IF p_order_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('purchase_order:' || v_user.tenant_id::TEXT));
    INSERT INTO public.purchase_orders (tenant_id, supplier_id, order_number, unit_id, notes, created_by_name)
    VALUES (
      v_user.tenant_id, p_supplier_id,
      COALESCE((SELECT MAX(order_number) FROM public.purchase_orders WHERE tenant_id = v_user.tenant_id), 0) + 1,
      p_unit_id, NULLIF(BTRIM(p_notes), ''), v_user.display_name
    )
    RETURNING * INTO v_order;
  ELSE
    SELECT * INTO v_order FROM public.purchase_orders
    WHERE id = p_order_id AND tenant_id = v_user.tenant_id FOR UPDATE;
    IF NOT FOUND OR NOT public.current_user_has_store_access(v_order.tenant_id, v_order.unit_id) THEN
      RAISE EXCEPTION 'Pedido não encontrado';
    END IF;
    IF v_order.status <> 'RASCUNHO' THEN
      RAISE EXCEPTION 'Só pedido em rascunho pode ser alterado';
    END IF;
    IF v_order.supplier_id <> p_supplier_id THEN
      RAISE EXCEPTION 'O pedido é de outro fornecedor';
    END IF;
    UPDATE public.purchase_orders SET unit_id = p_unit_id, notes = NULLIF(BTRIM(p_notes), ''), updated_at = NOW()
    WHERE id = v_order.id;
    DELETE FROM public.purchase_order_items WHERE order_id = v_order.id;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_quantity := NULLIF(v_item->>'quantity', '')::INTEGER;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Quantidade inválida no pedido';
    END IF;
    SELECT catalog_item.* INTO v_catalog_item
    FROM public.supplier_catalog_items AS catalog_item
    JOIN public.supplier_catalogs AS catalog ON catalog.id = catalog_item.catalog_id
    WHERE catalog_item.id = NULLIF(v_item->>'catalogItemId', '')::UUID
      AND catalog_item.tenant_id = v_user.tenant_id AND catalog.supplier_id = p_supplier_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item não encontrado no catálogo deste fornecedor';
    END IF;
    v_position := v_position + 1;
    INSERT INTO public.purchase_order_items (
      tenant_id, order_id, catalog_item_id, position, supplier_code, name, brand, product_type,
      unit_cost, quantity, price_pending
    ) VALUES (
      v_user.tenant_id, v_order.id, v_catalog_item.id, v_position, v_catalog_item.supplier_code, v_catalog_item.name,
      v_catalog_item.brand, v_catalog_item.product_type, v_catalog_item.unit_cost, v_quantity, v_catalog_item.unit_cost <= 0
    );
    v_total := v_total + v_catalog_item.unit_cost * v_quantity;
  END LOOP;

  UPDATE public.purchase_orders
  SET total = ROUND(v_total, 2),
      status = CASE WHEN p_send THEN 'ENVIADO' ELSE status END,
      sent_at = CASE WHEN p_send THEN NOW() ELSE sent_at END
  WHERE id = v_order.id;

  RETURN jsonb_build_object('id', v_order.id, 'orderNumber', v_order.order_number);
END;
$$;

REVOKE ALL ON FUNCTION public.save_purchase_order(UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN) TO authenticated;

-- Marca como enviado ou cancela.
CREATE OR REPLACE FUNCTION public.set_purchase_order_status(p_order_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE := public.supplier_catalog_user();
  v_order public.purchase_orders%ROWTYPE;
BEGIN
  IF p_status NOT IN ('ENVIADO', 'CANCELADO') THEN
    RAISE EXCEPTION 'Situação inválida';
  END IF;
  SELECT * INTO v_order FROM public.purchase_orders
  WHERE id = p_order_id AND tenant_id = v_user.tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT public.current_user_has_store_access(v_order.tenant_id, v_order.unit_id) THEN
    RAISE EXCEPTION 'Pedido não encontrado';
  END IF;
  IF v_order.status = 'CANCELADO' THEN
    RAISE EXCEPTION 'Pedido já cancelado';
  END IF;
  UPDATE public.purchase_orders
  SET status = p_status,
      sent_at = CASE WHEN p_status = 'ENVIADO' THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
      updated_at = NOW()
  WHERE id = v_order.id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_purchase_order_status(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_purchase_order_status(UUID, TEXT) TO authenticated;
