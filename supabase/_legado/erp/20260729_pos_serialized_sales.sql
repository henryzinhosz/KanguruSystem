BEGIN;

CREATE OR REPLACE FUNCTION public.mark_serial_units_sold(
  p_tenant_id UUID,
  p_product_id TEXT,
  p_unit_id TEXT,
  p_sale_id TEXT,
  p_serials JSONB,
  p_quantity INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supplied_count INTEGER;
  distinct_count INTEGER;
  updated_count INTEGER;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantidade deve ser maior que zero';
  END IF;
  IF jsonb_typeof(p_serials) <> 'array' THEN
    RAISE EXCEPTION 'Informe os números de série das unidades vendidas';
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT LOWER(BTRIM(value)))
  INTO supplied_count, distinct_count
  FROM jsonb_array_elements_text(p_serials) AS value;

  IF supplied_count <> p_quantity
    OR distinct_count <> p_quantity
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(p_serials) AS value
      WHERE NULLIF(BTRIM(value), '') IS NULL
    ) THEN
    RAISE EXCEPTION 'Informe exatamente % números de série únicos', p_quantity;
  END IF;

  UPDATE public.product_serial_units
  SET status = 'VENDIDO', sale_id = p_sale_id
  WHERE tenant_id = p_tenant_id
    AND product_id = p_product_id
    AND unit_id = p_unit_id
    AND status = 'DISPONIVEL'
    AND LOWER(serial_number) IN (
      SELECT LOWER(BTRIM(value))
      FROM jsonb_array_elements_text(p_serials) AS value
    );

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> p_quantity THEN
    RAISE EXCEPTION 'Um ou mais seriais não existem, não estão disponíveis ou pertencem a outra loja';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_sale_transaction(
  p_sale_id TEXT, p_invoice_number TEXT, p_unit_id TEXT, p_items JSONB, p_payment_method TEXT,
  p_gross_amount NUMERIC, p_fee_amount NUMERIC, p_net_amount NUMERIC, p_operator_id TEXT,
  p_operator_name TEXT, p_client_cpf TEXT, p_client_name TEXT, p_timestamp TIMESTAMPTZ,
  p_status TEXT, p_requires_approval BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  item JSONB; item_product_id TEXT; item_quantity INTEGER; current_qty INTEGER;
  inv_row public.inventory%ROWTYPE;
  is_serialized_product BOOLEAN;
BEGIN
  IF active_tenant_id IS NULL OR NOT public.current_user_has_store_access(active_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja';
  END IF;

  INSERT INTO public.sales (id, tenant_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount, net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval)
  VALUES (p_sale_id, active_tenant_id, p_invoice_number, p_unit_id, p_items, p_payment_method, p_gross_amount, p_fee_amount, p_net_amount, auth.uid()::TEXT, p_operator_name, p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval);

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::INTEGER;

    SELECT is_serialized INTO is_serialized_product
    FROM public.products
    WHERE tenant_id = active_tenant_id AND id = item_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produto % não encontrado', item_product_id;
    END IF;

    IF is_serialized_product THEN
      PERFORM public.mark_serial_units_sold(active_tenant_id, item_product_id, p_unit_id, p_sale_id, item->'serials', item_quantity);
    ELSE
      SELECT * INTO inv_row
      FROM public.inventory
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Produto % não encontrado no inventário', item_product_id;
      END IF;
      current_qty := COALESCE((inv_row.quantities -> p_unit_id ->> 'qty')::INTEGER, 0);
      IF current_qty < item_quantity THEN
        RAISE EXCEPTION 'Estoque insuficiente para o produto % na loja %', item_product_id, p_unit_id;
      END IF;
      UPDATE public.inventory
      SET quantities = jsonb_set(inv_row.quantities, ARRAY[p_unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = NOW()
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id;
    END IF;

    INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason)
    VALUES (gen_random_uuid()::TEXT, active_tenant_id, item_product_id, item->>'variationId', p_unit_id, 'CLIENTE', 'SAIDA', item_quantity, item->'serials', item->>'cardCondition', auth.uid()::TEXT, p_operator_name, p_timestamp, 'Venda registrada');
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_pos_terminal_sale(
  p_sale_id TEXT,
  p_invoice_number TEXT,
  p_items JSONB,
  p_payment_method TEXT,
  p_gross_amount NUMERIC,
  p_fee_amount NUMERIC,
  p_net_amount NUMERIC,
  p_client_cpf TEXT,
  p_client_name TEXT,
  p_timestamp TIMESTAMPTZ,
  p_status TEXT,
  p_requires_approval BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  item JSONB; item_product_id TEXT; item_quantity INTEGER; current_qty INTEGER;
  inv_row public.inventory%ROWTYPE;
  item_serials JSONB;
  has_serials BOOLEAN;
BEGIN
  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  SELECT * INTO v_cash
  FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Open cash register required before selling';
  END IF;

  INSERT INTO public.sales (
    id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval
  )
  VALUES (
    p_sale_id, v_terminal.tenant_id, v_cash.id, p_invoice_number, v_terminal.unit_id, p_items, p_payment_method,
    p_gross_amount, p_fee_amount, p_net_amount, v_terminal.id::TEXT, v_terminal.display_name,
    p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval
  );

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::INTEGER;
    item_serials := item->'serials';
    has_serials := jsonb_typeof(item_serials) = 'array' AND jsonb_array_length(item_serials) > 0;

    IF has_serials THEN
      PERFORM public.mark_serial_units_sold(
        v_terminal.tenant_id,
        item_product_id,
        v_terminal.unit_id,
        p_sale_id,
        item_serials,
        item_quantity
      );
    ELSE
      SELECT * INTO inv_row
      FROM public.inventory
      WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Product % was not found in inventory', item_product_id;
      END IF;
      current_qty := COALESCE((inv_row.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0);
      IF current_qty < item_quantity THEN
        RAISE EXCEPTION 'Insufficient stock for product % in store %', item_product_id, v_terminal.unit_id;
      END IF;
      UPDATE public.inventory
      SET quantities = jsonb_set(inv_row.quantities, ARRAY[v_terminal.unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = NOW()
      WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id;
    END IF;

    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason
    )
    VALUES (
      gen_random_uuid()::TEXT, v_terminal.tenant_id, item_product_id, item->>'variationId',
      v_terminal.unit_id, 'CLIENTE', 'SAIDA', item_quantity, item_serials, item->>'cardCondition',
      v_terminal.id::TEXT, v_terminal.display_name, p_timestamp, 'Venda registrada no PDV'
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_serial_units_sold(UUID, TEXT, TEXT, TEXT, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_pos_terminal_sale(TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_pos_terminal_sale(TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) TO authenticated;

COMMIT;