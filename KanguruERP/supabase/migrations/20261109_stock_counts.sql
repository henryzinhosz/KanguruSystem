-- =========================================================================
-- Balanco de estoque em formato de checklist (desenho aprovado em 2026-10-30).
-- A equipe abre um balanco da loja (inteira ou por categorias), bipa ou digita o que
-- encontra; o sistema anota o estoque do sistema NO MOMENTO de cada contagem (vendas
-- depois nao geram diferenca falsa). Duas acoes no fim:
--   SALVAR: so guarda o relatorio (estoque nao muda);
--   APROVAR (so ADMIN): o ERP aplica as diferencas no estoque ("Balanco nº X").
-- Produto da categoria que ninguem contou e ignorado (aparece como "nao contado").
-- Seriais: os que faltam (DISPONIVEL) viram PERDIDO; reservados que faltam e seriais
-- encontrados fora do sistema so aparecem no relatorio.
-- Aditiva: tabelas e RPCs novas; nenhuma funcao existente muda.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.stock_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  count_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO', 'SALVO', 'APROVADO', 'CANCELADO')),
  categories TEXT[],
  notes TEXT,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by_name TEXT,
  FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, unit_id, count_number)
);

CREATE TABLE IF NOT EXISTS public.stock_count_items (
  count_id UUID NOT NULL REFERENCES public.stock_counts(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  counted_qty INTEGER NOT NULL DEFAULT 0 CHECK (counted_qty >= 0),
  system_qty INTEGER NOT NULL DEFAULT 0,
  counted_serials JSONB NOT NULL DEFAULT '[]'::JSONB,
  system_serials JSONB NOT NULL DEFAULT '[]'::JSONB,
  reserved_serials JSONB NOT NULL DEFAULT '[]'::JSONB,
  counted_by_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (count_id, product_id)
);

ALTER TABLE public.stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_count_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_counts, public.stock_count_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stock_counts, public.stock_count_items TO authenticated;

DROP POLICY IF EXISTS stock_counts_read ON public.stock_counts;
CREATE POLICY stock_counts_read ON public.stock_counts FOR SELECT
  USING (public.current_user_has_store_access(tenant_id, unit_id));
DROP POLICY IF EXISTS stock_count_items_read ON public.stock_count_items;
CREATE POLICY stock_count_items_read ON public.stock_count_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.stock_counts AS count_row
    WHERE count_row.id = stock_count_items.count_id
      AND public.current_user_has_store_access(count_row.tenant_id, count_row.unit_id)
  ));

-- Nome de quem esta usando o ERP (para o registro).
CREATE OR REPLACE FUNCTION public.stock_count_user_name()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(NULLIF(BTRIM(display_name), ''), 'Usuário do ERP')
  FROM public.app_users WHERE auth_uid = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.stock_count_user_name() FROM PUBLIC, anon, authenticated;

-- Balanco aberto da loja que o usuario acessa (trava a linha).
CREATE OR REPLACE FUNCTION public.stock_count_for_update(p_count_id UUID)
RETURNS public.stock_counts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count public.stock_counts%ROWTYPE;
BEGIN
  SELECT * INTO v_count FROM public.stock_counts
  WHERE id = p_count_id AND tenant_id = public.current_user_tenant_id()
  FOR UPDATE;
  IF NOT FOUND OR NOT public.current_user_has_store_access(v_count.tenant_id, v_count.unit_id) THEN
    RAISE EXCEPTION 'Balanço não encontrado';
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_count_for_update(UUID) FROM PUBLIC, anon, authenticated;

-- ---- Abrir ----
CREATE OR REPLACE FUNCTION public.start_stock_count(p_unit_id TEXT, p_categories TEXT[])
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_number INTEGER;
  v_id UUID;
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_has_store_access(v_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_counts WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id AND status = 'ABERTO') THEN
    RAISE EXCEPTION 'Já existe um balanço aberto nesta loja: continue ou cancele o balanço aberto';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('stock_count:' || v_tenant_id::TEXT || ':' || p_unit_id));
  SELECT COALESCE(MAX(count_number), 0) + 1 INTO v_number
  FROM public.stock_counts WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id;

  INSERT INTO public.stock_counts (tenant_id, unit_id, count_number, categories, created_by_name)
  VALUES (v_tenant_id, p_unit_id, v_number, NULLIF(p_categories, ARRAY[]::TEXT[]), public.stock_count_user_name())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.start_stock_count(TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_stock_count(TEXT, TEXT[]) TO authenticated;

-- ---- Contar um produto ----
-- Grava o contado e o estoque do sistema neste momento. Serializado: lista dos seriais
-- bipados (a quantidade contada e o numero de seriais).
CREATE OR REPLACE FUNCTION public.record_stock_count_item(
  p_count_id UUID,
  p_product_id TEXT,
  p_counted_qty INTEGER,
  p_counted_serials JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count public.stock_counts%ROWTYPE := public.stock_count_for_update(p_count_id);
  v_product public.products%ROWTYPE;
  v_serials JSONB := '[]'::JSONB;
  v_system_qty INTEGER := 0;
  v_system_serials JSONB := '[]'::JSONB;
  v_reserved_serials JSONB := '[]'::JSONB;
BEGIN
  IF v_count.status <> 'ABERTO' THEN
    RAISE EXCEPTION 'Este balanço não está mais aberto';
  END IF;
  SELECT * INTO v_product FROM public.products WHERE tenant_id = v_count.tenant_id AND id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto não encontrado';
  END IF;
  IF v_count.categories IS NOT NULL AND NOT (v_product.category = ANY (v_count.categories)) THEN
    RAISE EXCEPTION 'Este produto não é das categorias deste balanço';
  END IF;

  IF COALESCE(v_product.is_serialized, false) THEN
    SELECT COALESCE(jsonb_agg(DISTINCT UPPER(BTRIM(value))), '[]'::JSONB) INTO v_serials
    FROM jsonb_array_elements_text(COALESCE(p_counted_serials, '[]'::JSONB)) AS value
    WHERE NULLIF(BTRIM(value), '') IS NOT NULL;
    SELECT COALESCE(jsonb_agg(UPPER(serial_number) ORDER BY serial_number) FILTER (WHERE status = 'DISPONIVEL'), '[]'::JSONB),
           COALESCE(jsonb_agg(UPPER(serial_number) ORDER BY serial_number) FILTER (WHERE status = 'RESERVADO'), '[]'::JSONB)
    INTO v_system_serials, v_reserved_serials
    FROM public.product_serial_units
    WHERE tenant_id = v_count.tenant_id AND product_id = p_product_id AND unit_id = v_count.unit_id
      AND status IN ('DISPONIVEL', 'RESERVADO');
    v_system_qty := jsonb_array_length(v_system_serials) + jsonb_array_length(v_reserved_serials);
    p_counted_qty := jsonb_array_length(v_serials);
  ELSE
    IF p_counted_qty IS NULL OR p_counted_qty < 0 THEN
      RAISE EXCEPTION 'Quantidade contada inválida';
    END IF;
    SELECT COALESCE((quantities -> v_count.unit_id ->> 'qty')::INTEGER, 0) INTO v_system_qty
    FROM public.inventory WHERE tenant_id = v_count.tenant_id AND product_id = p_product_id;
    v_system_qty := COALESCE(v_system_qty, 0);
  END IF;

  INSERT INTO public.stock_count_items (
    count_id, tenant_id, product_id, counted_qty, system_qty, counted_serials, system_serials, reserved_serials, counted_by_name, updated_at
  ) VALUES (
    p_count_id, v_count.tenant_id, p_product_id, p_counted_qty, v_system_qty, v_serials, v_system_serials, v_reserved_serials,
    public.stock_count_user_name(), NOW()
  )
  ON CONFLICT (count_id, product_id) DO UPDATE
  SET counted_qty = EXCLUDED.counted_qty, system_qty = EXCLUDED.system_qty, counted_serials = EXCLUDED.counted_serials,
      system_serials = EXCLUDED.system_serials, reserved_serials = EXCLUDED.reserved_serials,
      counted_by_name = EXCLUDED.counted_by_name, updated_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.record_stock_count_item(UUID, TEXT, INTEGER, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_count_item(UUID, TEXT, INTEGER, JSONB) TO authenticated;

-- Tirar um produto da contagem (contado por engano).
CREATE OR REPLACE FUNCTION public.remove_stock_count_item(p_count_id UUID, p_product_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count public.stock_counts%ROWTYPE := public.stock_count_for_update(p_count_id);
BEGIN
  IF v_count.status <> 'ABERTO' THEN
    RAISE EXCEPTION 'Este balanço não está mais aberto';
  END IF;
  DELETE FROM public.stock_count_items WHERE count_id = p_count_id AND product_id = p_product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_stock_count_item(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_stock_count_item(UUID, TEXT) TO authenticated;

-- ---- Salvar (so relatorio) / cancelar ----
CREATE OR REPLACE FUNCTION public.save_stock_count(p_count_id UUID, p_notes TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count public.stock_counts%ROWTYPE := public.stock_count_for_update(p_count_id);
BEGIN
  IF v_count.status <> 'ABERTO' THEN
    RAISE EXCEPTION 'Este balanço não está mais aberto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_count_items WHERE count_id = p_count_id) THEN
    RAISE EXCEPTION 'Nenhum produto foi contado';
  END IF;
  UPDATE public.stock_counts
  SET status = 'SALVO', saved_at = NOW(), notes = NULLIF(BTRIM(COALESCE(p_notes, '')), '')
  WHERE id = p_count_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_stock_count(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_stock_count(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_stock_count(p_count_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count public.stock_counts%ROWTYPE := public.stock_count_for_update(p_count_id);
BEGIN
  IF v_count.status NOT IN ('ABERTO', 'SALVO') THEN
    RAISE EXCEPTION 'Balanço aprovado não pode ser cancelado';
  END IF;
  UPDATE public.stock_counts SET status = 'CANCELADO' WHERE id = p_count_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_stock_count(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_stock_count(UUID) TO authenticated;

-- ---- Aprovar e ajustar (so ADMIN) ----
-- Diferenca de cada produto = contado - sistema no momento da contagem, aplicada ao
-- estoque atual. Falta: sai como PERDA (custo medio da loja). Sobra: entra com o custo
-- medio da loja (sem media, o custo padrao do produto). Seriais: DISPONIVEL que faltou vira PERDIDO.
CREATE OR REPLACE FUNCTION public.approve_stock_count(p_count_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count public.stock_counts%ROWTYPE := public.stock_count_for_update(p_count_id);
  v_item public.stock_count_items%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_inv public.inventory%ROWTYPE;
  v_name TEXT := public.stock_count_user_name();
  v_reason TEXT;
  v_diff INTEGER;
  v_current INTEGER;
  v_cost NUMERIC;
  v_missing JSONB;
  v_lost INTEGER;
  v_adjusted INTEGER := 0;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o administrador pode aprovar o balanço';
  END IF;
  IF v_count.status NOT IN ('ABERTO', 'SALVO') THEN
    RAISE EXCEPTION 'Este balanço já foi aprovado ou cancelado';
  END IF;
  v_reason := 'Balanço nº ' || v_count.count_number;

  FOR v_item IN SELECT * FROM public.stock_count_items WHERE count_id = p_count_id LOOP
    SELECT * INTO v_product FROM public.products WHERE tenant_id = v_count.tenant_id AND id = v_item.product_id;
    CONTINUE WHEN NOT FOUND;

    IF COALESCE(v_product.is_serialized, false) THEN
      -- Faltaram: estavam DISPONIVEL no sistema e nao foram bipados.
      SELECT COALESCE(jsonb_agg(value), '[]'::JSONB) INTO v_missing
      FROM jsonb_array_elements_text(v_item.system_serials) AS value
      WHERE NOT (v_item.counted_serials ? value);
      IF jsonb_array_length(v_missing) > 0 THEN
        SELECT ROUND(AVG(COALESCE(unit_cost, GREATEST(COALESCE(v_product.cost_price, 0), 0))), 4) INTO v_cost
        FROM public.product_serial_units
        WHERE tenant_id = v_count.tenant_id AND product_id = v_product.id AND unit_id = v_count.unit_id
          AND status = 'DISPONIVEL' AND UPPER(serial_number) IN (SELECT jsonb_array_elements_text(v_missing));
        UPDATE public.product_serial_units
        SET status = 'PERDIDO', sale_id = NULL
        WHERE tenant_id = v_count.tenant_id AND product_id = v_product.id AND unit_id = v_count.unit_id
          AND status = 'DISPONIVEL' AND UPPER(serial_number) IN (SELECT jsonb_array_elements_text(v_missing));
        GET DIAGNOSTICS v_lost = ROW_COUNT;
        IF v_lost > 0 THEN
          INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost)
          VALUES (gen_random_uuid()::TEXT, v_count.tenant_id, v_product.id, NULL, v_count.unit_id, 'PERDA', 'PERDA', v_lost, v_missing, NULL, auth.uid()::TEXT, v_name, NOW(), v_reason, v_cost);
          v_adjusted := v_adjusted + 1;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    v_diff := v_item.counted_qty - v_item.system_qty;
    CONTINUE WHEN v_diff = 0;

    SELECT * INTO v_inv FROM public.inventory WHERE tenant_id = v_count.tenant_id AND product_id = v_product.id FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE WHEN v_diff < 0;
      INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
      VALUES (v_count.tenant_id, v_product.id, '{}'::JSONB, NOW());
      SELECT * INTO v_inv FROM public.inventory WHERE tenant_id = v_count.tenant_id AND product_id = v_product.id FOR UPDATE;
    END IF;
    v_inv.quantities := public.inventory_with_unit(v_inv.quantities, v_count.unit_id);
    v_current := COALESCE((v_inv.quantities -> v_count.unit_id ->> 'qty')::INTEGER, 0);
    v_cost := public.get_store_avg_cost(v_count.tenant_id, v_product.id, v_count.unit_id);
    IF COALESCE(v_cost, 0) <= 0 THEN
      v_cost := GREATEST(COALESCE(v_product.cost_price, 0), 0);
    END IF;

    IF v_diff < 0 THEN
      -- Nunca deixa o estoque negativo (o que ja saiu depois da contagem ja foi descontado).
      v_diff := -LEAST(-v_diff, v_current);
      CONTINUE WHEN v_diff = 0;
      v_inv.quantities := jsonb_set(v_inv.quantities, ARRAY[v_count.unit_id, 'qty'], to_jsonb(v_current + v_diff), true);
      INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost)
      VALUES (gen_random_uuid()::TEXT, v_count.tenant_id, v_product.id, NULL, v_count.unit_id, 'PERDA', 'PERDA', -v_diff, '[]'::JSONB, NULL, auth.uid()::TEXT, v_name, NOW(), v_reason, v_cost);
    ELSE
      PERFORM public.apply_store_cost_entry(v_count.tenant_id, v_product.id, v_count.unit_id, v_current, v_diff, v_cost);
      v_inv.quantities := jsonb_set(v_inv.quantities, ARRAY[v_count.unit_id, 'qty'], to_jsonb(v_current + v_diff), true);
      INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost)
      VALUES (gen_random_uuid()::TEXT, v_count.tenant_id, v_product.id, NULL, 'BALANCO', v_count.unit_id, 'ENTRADA', v_diff, '[]'::JSONB, NULL, auth.uid()::TEXT, v_name, NOW(), v_reason, v_cost);
    END IF;
    UPDATE public.inventory SET quantities = v_inv.quantities, updated_at = NOW()
    WHERE tenant_id = v_count.tenant_id AND product_id = v_product.id;
    v_adjusted := v_adjusted + 1;
  END LOOP;

  UPDATE public.stock_counts
  SET status = 'APROVADO', approved_at = NOW(), approved_by_name = v_name, saved_at = COALESCE(saved_at, NOW())
  WHERE id = p_count_id;

  RETURN jsonb_build_object('adjustedProducts', v_adjusted);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_stock_count(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_stock_count(UUID) TO authenticated;
