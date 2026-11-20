-- Modo offline do PDV (desenho aprovado 2026-10-28).
-- 1. get_pos_offline_snapshot: copia dos dados que o PDV guarda no computador para vender sem
--    internet (catalogo com preco, estoque e limite de desconto da loja, seriais disponiveis,
--    vendedores, perfil da loja, caixa aberto e dados fiscais dos produtos).
-- 2. import_pos_offline_sale: recebe uma venda feita sem internet, com data/hora original.
--    Nao recusa por estoque/serial/preco: a venda ja aconteceu. Divergencias vao para
--    pos_offline_conflicts (lista no ERP para o gerente resolver). Idempotente pelo id da venda.
-- 3. resolve_pos_offline_conflict: ERP marca a divergencia como resolvida.
-- Nenhuma funcao de venda, caixa ou estorno existente muda.
BEGIN;

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS offline_origin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.pos_offline_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('SERIAL', 'ESTOQUE', 'PRECO', 'VENDEDOR', 'PAGAMENTO')),
  detail TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pos_offline_conflicts_open_idx ON public.pos_offline_conflicts (tenant_id, unit_id) WHERE NOT resolved;

ALTER TABLE public.pos_offline_conflicts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pos_offline_conflicts_read ON public.pos_offline_conflicts;
CREATE POLICY pos_offline_conflicts_read ON public.pos_offline_conflicts
  FOR SELECT USING (public.current_user_has_store_access(tenant_id, unit_id));
REVOKE ALL ON public.pos_offline_conflicts FROM PUBLIC, anon;
GRANT SELECT ON public.pos_offline_conflicts TO authenticated;

-- ---- 1. Copia para o modo offline ----
CREATE OR REPLACE FUNCTION public.get_pos_offline_snapshot()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_config public.store_configs%ROWTYPE;
  v_store_limit NUMERIC;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT * INTO v_config FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  v_store_limit := COALESCE(v_config.max_item_discount_percent, 0);

  RETURN jsonb_build_object(
    'generatedAt', NOW(),
    'terminalId', v_terminal.id,
    'terminalName', v_terminal.display_name,
    'unitId', v_terminal.unit_id,
    'store', jsonb_build_object(
      'tradeName', v_config.trade_name, 'legalName', v_config.legal_name, 'cnpj', v_config.cnpj,
      'address', v_config.address, 'phone', v_config.phone, 'stateRegistration', v_config.state_registration,
      'instagram', v_config.instagram, 'reservationVoucherTerms', v_config.reservation_voucher_terms
    ),
    'nfce', (
      SELECT jsonb_build_object('configured', setting.unit_id IS NOT NULL, 'environment', setting.environment)
      FROM (SELECT 1) AS one
      LEFT JOIN public.store_fiscal_settings AS setting
        ON setting.tenant_id = v_terminal.tenant_id AND setting.unit_id = v_terminal.unit_id
    ),
    'cash', (
      SELECT jsonb_build_object('id', cash.id, 'cashNumber', cash.cash_number, 'openedAt', cash.opened_at,
        'openedByName', cash.opened_by_name, 'openingFloatAmount', cash.opening_float_amount)
      FROM public.cash_register_sessions AS cash
      WHERE cash.terminal_id = v_terminal.id AND cash.status = 'ABERTO'
      ORDER BY cash.opened_at DESC LIMIT 1
    ),
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', product.id, 'sku', product.sku, 'name', product.name, 'brand', product.brand,
        'sellPrice', product.sell_price, 'warrantyMonths', product.warranty_months,
        'isSerialized', COALESCE(product.is_serialized, false),
        'availableQuantity', CASE WHEN COALESCE(product.is_serialized, false) THEN 0
          ELSE public.pos_store_available_qty(v_terminal.tenant_id, product.id, v_terminal.unit_id, inventory.quantities) END,
        'maxItemDiscountPercent', public.pos_item_discount_limit(
          v_terminal.tenant_id, jsonb_build_object('itemType', 'PRODUCT', 'productId', product.id), v_store_limit),
        'ncm', product.ncm, 'cest', product.cest, 'icmsOrigin', product.icms_origin, 'icmsCst', product.icms_cst,
        'csosn', product.csosn, 'icmsRate', product.icms_rate, 'taxBurdenPercent', product.tax_burden_percent
      ))
      FROM public.products AS product
      LEFT JOIN public.inventory AS inventory
        ON inventory.tenant_id = product.tenant_id AND inventory.product_id = product.id
      WHERE product.tenant_id = v_terminal.tenant_id
    ), '[]'::JSONB),
    'services', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', service.id, 'sku', service.sku, 'name', service.name, 'sellPrice', service.sell_price,
        'maxItemDiscountPercent', v_store_limit
      ))
      FROM public.services AS service
      WHERE service.tenant_id = v_terminal.tenant_id AND service.is_active
    ), '[]'::JSONB),
    'serialUnits', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', unit.id, 'productId', unit.product_id, 'serialNumber', unit.serial_number, 'imei', unit.imei
      ))
      FROM public.product_serial_units AS unit
      WHERE unit.tenant_id = v_terminal.tenant_id AND unit.unit_id = v_terminal.unit_id AND unit.status = 'DISPONIVEL'
    ), '[]'::JSONB),
    'sellers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', operator.code, 'name', operator.name))
      FROM public.pdv_operators AS operator
      WHERE operator.tenant_id = v_terminal.tenant_id AND operator.unit_id = v_terminal.unit_id
        AND operator.is_active AND operator.code IS NOT NULL
        AND COALESCE((operator.permissions->>'canRegisterSales')::BOOLEAN, false)
    ), '[]'::JSONB)
  );
END;
$$;

-- ---- 2. Importacao de venda feita sem internet ----
-- p_sale: { saleId, invoiceNumber, timestamp, cashSessionId, sellerCode, clientCpf, clientName,
--           items: [{ itemType, productId|serviceId, quantity, discountPercent, unitPrice, serials }],
--           payments: [{ paymentMethod, amount }],
--           nfce: { ref, environment, number, series, key, protocol, qrcodeUrl, consultUrl, taxTotal } | null }
CREATE OR REPLACE FUNCTION public.import_pos_offline_sale(p_sale JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  v_seller public.pdv_operators%ROWTYPE;
  v_sale_id TEXT := NULLIF(BTRIM(p_sale->>'saleId'), '');
  v_timestamp TIMESTAMPTZ := (p_sale->>'timestamp')::TIMESTAMPTZ;
  v_seller_code TEXT := NULLIF(BTRIM(p_sale->>'sellerCode'), '');
  v_items JSONB := COALESCE(p_sale->'items', '[]'::JSONB);
  v_payments JSONB := COALESCE(p_sale->'payments', '[]'::JSONB);
  v_nfce JSONB := p_sale->'nfce';
  item JSONB;
  payment JSONB;
  item_type TEXT;
  item_product_id TEXT;
  item_service_id TEXT;
  item_quantity INTEGER;
  item_discount NUMERIC;
  item_price NUMERIC;
  item_current_price NUMERIC;
  item_sku TEXT;
  item_name TEXT;
  item_default_cost NUMERIC;
  item_cost_total NUMERIC;
  item_serials JSONB;
  is_serialized_product BOOLEAN;
  line_total NUMERIC;
  calculated_gross NUMERIC := 0;
  normalized_items JSONB := '[]'::JSONB;
  inv_row public.inventory%ROWTYPE;
  current_qty INTEGER;
  v_serial TEXT;
  v_unit public.product_serial_units%ROWTYPE;
  v_payment_total NUMERIC := 0;
  v_payment_count INTEGER;
  v_payment_method TEXT;
  v_conflicts INTEGER := 0;
  v_receipt INTEGER;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;
  IF v_sale_id IS NULL OR v_timestamp IS NULL THEN RAISE EXCEPTION 'Venda offline sem identificação ou data'; END IF;
  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'Venda offline sem itens'; END IF;
  IF jsonb_typeof(v_payments) <> 'array' OR jsonb_array_length(v_payments) = 0 THEN RAISE EXCEPTION 'Venda offline sem pagamento'; END IF;

  -- Ja importada (reenvio apos queda no meio do envio): nada a fazer.
  SELECT receipt_number INTO v_receipt FROM public.sales WHERE tenant_id = v_terminal.tenant_id AND id = v_sale_id;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'OK', 'duplicate', true, 'receiptNumber', v_receipt);
  END IF;

  SELECT * INTO v_cash FROM public.cash_register_sessions
  WHERE id = NULLIF(p_sale->>'cashSessionId', '')::UUID AND terminal_id = v_terminal.id;
  IF NOT FOUND THEN
    SELECT * INTO v_cash FROM public.cash_register_sessions
    WHERE terminal_id = v_terminal.id AND status = 'ABERTO' ORDER BY opened_at DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Caixa da venda offline não encontrado'; END IF;
  END IF;

  v_seller := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, v_seller_code);
  IF v_seller.id IS NULL THEN
    INSERT INTO public.pos_offline_conflicts (tenant_id, unit_id, sale_id, kind, detail)
    VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_sale_id, 'VENDEDOR',
      'Código de vendedor "' || COALESCE(v_seller_code, '') || '" não encontrado ou inativo no envio.');
    v_conflicts := v_conflicts + 1;
  END IF;

  v_payment_count := jsonb_array_length(v_payments);
  FOR payment IN SELECT value FROM jsonb_array_elements(v_payments) LOOP
    IF UPPER(COALESCE(payment->>'paymentMethod', '')) NOT IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO', 'CREDIARIO') THEN
      RAISE EXCEPTION 'Forma de pagamento inválida na venda offline: %', payment->>'paymentMethod';
    END IF;
    IF COALESCE((payment->>'amount')::NUMERIC, 0) <= 0 THEN RAISE EXCEPTION 'Valor de pagamento inválido na venda offline'; END IF;
    v_payment_total := v_payment_total + (payment->>'amount')::NUMERIC;
  END LOOP;
  v_payment_method := CASE WHEN v_payment_count = 1 THEN UPPER(v_payments->0->>'paymentMethod') ELSE 'DIVIDIDO' END;

  INSERT INTO public.sales (
    id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval,
    reservation_deposit_applied, seller_id, seller_code, seller_name, finalized_by_id, finalized_by_code,
    finalized_by_name, offline_origin
  ) VALUES (
    v_sale_id, v_terminal.tenant_id, v_cash.id, COALESCE(p_sale->>'invoiceNumber', 'PDV-OFFLINE'), v_terminal.unit_id,
    v_items, v_payment_method, 0, 0, 0, v_terminal.id::TEXT, v_terminal.display_name,
    NULLIF(p_sale->>'clientCpf', ''), NULLIF(p_sale->>'clientName', ''), v_timestamp, 'CONCLUIDA', false, 0,
    v_seller.id, COALESCE(v_seller.code, v_seller_code), v_seller.name, v_seller.id, COALESCE(v_seller.code, v_seller_code),
    v_seller.name, true
  );

  FOR item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    item_type := UPPER(COALESCE(item->>'itemType', 'PRODUCT'));
    item_quantity := (item->>'quantity')::INTEGER;
    item_discount := LEAST(GREATEST(COALESCE(NULLIF(item->>'discountPercent', '')::NUMERIC, 0), 0), 100);
    item_price := NULLIF(item->>'unitPrice', '')::NUMERIC;
    IF item_quantity IS NULL OR item_quantity <= 0 THEN RAISE EXCEPTION 'Quantidade inválida na venda offline'; END IF;
    item_serials := NULL;

    IF item_type = 'SERVICE' THEN
      item_product_id := NULL;
      item_service_id := item->>'serviceId';
      SELECT service.sell_price, service.sku, service.name INTO item_current_price, item_sku, item_name
      FROM public.services AS service
      WHERE service.tenant_id = v_terminal.tenant_id AND service.id = item_service_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Serviço % não encontrado', item_service_id; END IF;
      item_cost_total := 0;
    ELSIF item_type = 'PRODUCT' THEN
      item_service_id := NULL;
      item_product_id := item->>'productId';
      SELECT product.sell_price, COALESCE(product.is_serialized, false), product.sku, product.name,
             GREATEST(COALESCE(product.cost_price, 0), 0)
      INTO item_current_price, is_serialized_product, item_sku, item_name, item_default_cost
      FROM public.products AS product
      WHERE product.tenant_id = v_terminal.tenant_id AND product.id = item_product_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Produto % não encontrado', item_product_id; END IF;

      IF is_serialized_product THEN
        item_serials := COALESCE(item->'serials', '[]'::JSONB);
        item_cost_total := 0;
        FOR v_serial IN SELECT value FROM jsonb_array_elements_text(item_serials) LOOP
          SELECT * INTO v_unit FROM public.product_serial_units
          WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id
            AND LOWER(serial_number) = LOWER(BTRIM(v_serial))
          FOR UPDATE;
          IF FOUND AND v_unit.status = 'DISPONIVEL' AND v_unit.unit_id = v_terminal.unit_id THEN
            UPDATE public.product_serial_units SET status = 'VENDIDO', sale_id = v_sale_id, updated_at = NOW() WHERE id = v_unit.id;
            item_cost_total := item_cost_total + COALESCE(v_unit.unit_cost, item_default_cost);
          ELSE
            INSERT INTO public.pos_offline_conflicts (tenant_id, unit_id, sale_id, kind, detail)
            VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_sale_id, 'SERIAL',
              'Serial ' || v_serial || ' (' || item_name || ') não estava disponível nesta loja no envio'
              || CASE WHEN FOUND THEN ' (situação: ' || v_unit.status || ')' ELSE ' (não cadastrado)' END || '.');
            v_conflicts := v_conflicts + 1;
            item_cost_total := item_cost_total + item_default_cost;
          END IF;
        END LOOP;
        IF jsonb_array_length(item_serials) <> item_quantity THEN
          INSERT INTO public.pos_offline_conflicts (tenant_id, unit_id, sale_id, kind, detail)
          VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_sale_id, 'SERIAL',
            'Quantidade de seriais diferente da quantidade vendida (' || item_name || ').');
          v_conflicts := v_conflicts + 1;
        END IF;
      ELSE
        SELECT * INTO inv_row FROM public.inventory
        WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id FOR UPDATE;
        IF NOT FOUND THEN
          INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
          VALUES (v_terminal.tenant_id, item_product_id, '{}'::JSONB, NOW());
          SELECT * INTO inv_row FROM public.inventory
          WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id FOR UPDATE;
        END IF;
        inv_row.quantities := public.inventory_with_unit(inv_row.quantities, v_terminal.unit_id);
        current_qty := COALESCE((inv_row.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0);
        IF current_qty < item_quantity THEN
          INSERT INTO public.pos_offline_conflicts (tenant_id, unit_id, sale_id, kind, detail)
          VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_sale_id, 'ESTOQUE',
            item_name || ': vendido ' || item_quantity || ' sem internet, estoque no envio ' || current_qty
            || '. O estoque ficou negativo: confira a contagem.');
          v_conflicts := v_conflicts + 1;
        END IF;
        item_cost_total := public.get_store_avg_cost(v_terminal.tenant_id, item_product_id, v_terminal.unit_id) * item_quantity;
        UPDATE public.inventory
        SET quantities = jsonb_set(inv_row.quantities, ARRAY[v_terminal.unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true),
            updated_at = NOW()
        WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id;
      END IF;

      INSERT INTO public.movements (
        id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
        serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
      ) VALUES (
        gen_random_uuid()::TEXT, v_terminal.tenant_id, item_product_id, NULL, v_terminal.unit_id, 'CLIENTE', 'SAIDA',
        item_quantity, item_serials, NULL, v_terminal.id::TEXT, v_terminal.display_name, v_timestamp,
        'Venda registrada no PDV sem internet', ROUND(item_cost_total / item_quantity, 4)
      );
    ELSE
      RAISE EXCEPTION 'Tipo de item inválido na venda offline: %', item_type;
    END IF;

    -- Vale o preco cobrado no PDV; se o cadastro mudou, registra para conferencia.
    item_price := COALESCE(item_price, item_current_price);
    IF item_current_price IS NOT NULL AND ABS(item_price - item_current_price) > 0.009 THEN
      INSERT INTO public.pos_offline_conflicts (tenant_id, unit_id, sale_id, kind, detail)
      VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_sale_id, 'PRECO',
        item_name || ': vendido a ' || to_char(item_price, 'FM999G990D00') || ' sem internet; preço atual '
        || to_char(item_current_price, 'FM999G990D00') || '.');
      v_conflicts := v_conflicts + 1;
    END IF;

    item_cost_total := ROUND(item_cost_total, 2);
    line_total := ROUND(item_price * item_quantity * (100 - item_discount) / 100, 2);
    calculated_gross := calculated_gross + line_total;
    normalized_items := normalized_items || jsonb_build_array(
      item || jsonb_build_object(
        'itemType', item_type, 'unitPrice', item_price, 'itemSku', item_sku, 'itemName', item_name,
        'discountPercent', item_discount, 'lineTotal', line_total, 'serials', item_serials,
        'unitCost', ROUND(item_cost_total / item_quantity, 4), 'costTotal', item_cost_total
      )
    );
  END LOOP;

  IF ABS(v_payment_total - calculated_gross) > 0.01 THEN
    INSERT INTO public.pos_offline_conflicts (tenant_id, unit_id, sale_id, kind, detail)
    VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_sale_id, 'PAGAMENTO',
      'Pagamentos somam ' || to_char(v_payment_total, 'FM999G990D00') || ' e os itens ' || to_char(calculated_gross, 'FM999G990D00') || '.');
    v_conflicts := v_conflicts + 1;
  END IF;

  FOR payment IN SELECT value FROM jsonb_array_elements(v_payments) LOOP
    INSERT INTO public.sale_payments (
      tenant_id, unit_id, terminal_id, cash_session_id, sale_id, payment_method, amount, installments, created_by_name
    ) VALUES (
      v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, v_sale_id,
      UPPER(payment->>'paymentMethod'), ROUND((payment->>'amount')::NUMERIC, 2),
      COALESCE(NULLIF(payment->>'installments', '')::INTEGER, 1), v_terminal.display_name
    );
  END LOOP;

  UPDATE public.sales
  SET items = normalized_items, gross_amount = calculated_gross, net_amount = calculated_gross,
      fiscal_type = CASE WHEN v_nfce IS NOT NULL AND jsonb_typeof(v_nfce) = 'object' THEN 'NFCE' ELSE 'NAO_FISCAL' END,
      fiscal_status = CASE WHEN v_nfce IS NOT NULL AND jsonb_typeof(v_nfce) = 'object' THEN 'AUTORIZADA' ELSE NULL END,
      nfce_ref = v_nfce->>'ref', nfce_environment = v_nfce->>'environment', nfce_number = v_nfce->>'number',
      nfce_series = v_nfce->>'series', nfce_key = v_nfce->>'key', nfce_protocol = v_nfce->>'protocol',
      nfce_qrcode_url = v_nfce->>'qrcodeUrl', nfce_consult_url = v_nfce->>'consultUrl',
      nfce_tax_total = NULLIF(v_nfce->>'taxTotal', '')::NUMERIC,
      nfce_authorized_at = CASE WHEN v_nfce IS NOT NULL AND jsonb_typeof(v_nfce) = 'object' THEN v_timestamp ELSE NULL END,
      nfce_contingency = v_nfce IS NOT NULL AND jsonb_typeof(v_nfce) = 'object',
      nfce_contingency_done = false
  WHERE tenant_id = v_terminal.tenant_id AND id = v_sale_id
  RETURNING receipt_number INTO v_receipt;

  RETURN jsonb_build_object('status', 'OK', 'receiptNumber', v_receipt, 'conflicts', v_conflicts);
END;
$$;

-- ---- 3. ERP: resolver divergencia ----
CREATE OR REPLACE FUNCTION public.resolve_pos_offline_conflict(p_conflict_id UUID, p_resolved_by TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conflict public.pos_offline_conflicts%ROWTYPE;
BEGIN
  SELECT * INTO v_conflict FROM public.pos_offline_conflicts WHERE id = p_conflict_id FOR UPDATE;
  IF NOT FOUND OR v_conflict.tenant_id IS DISTINCT FROM public.current_user_tenant_id()
     OR NOT public.current_user_has_store_access(v_conflict.tenant_id, v_conflict.unit_id) THEN
    RAISE EXCEPTION 'Divergência não encontrada ou sem acesso';
  END IF;
  UPDATE public.pos_offline_conflicts
  SET resolved = true, resolved_by = NULLIF(BTRIM(COALESCE(p_resolved_by, '')), ''), resolved_at = NOW()
  WHERE id = p_conflict_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_offline_snapshot() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.import_pos_offline_sale(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_pos_offline_conflict(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_offline_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_pos_offline_sale(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_pos_offline_conflict(UUID, TEXT) TO authenticated;

COMMIT;
