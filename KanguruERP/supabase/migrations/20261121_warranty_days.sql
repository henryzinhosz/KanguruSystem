-- Garantia em DIAS (pedido do usuario em 2026-11-06; ex.: acessorios com 7 dias).
-- products.warranty_days: preenchido = garantia em dias (vale no lugar dos meses);
-- vazio = continua valendo warranty_months (meses), como hoje.
-- Aditiva: nenhuma funcao de venda, reserva, caixa ou estorno muda.
--  * get_pos_product_warranties (nova, PDV): garantia (dias ou meses) de cada produto; o carrinho,
--    o cupom Nao Fiscal (linha "Garantia: ...") e a consulta de garantia usam este mapa.
--  * customer_history_payload (interna, CREATE OR REPLACE, mesmo retorno): copia da 20261118
--    com o calculo de "garantia ate" em dias.
BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS warranty_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_warranty_days_check') THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_warranty_days_check CHECK (warranty_days IS NULL OR warranty_days BETWEEN 1 AND 3650);
  END IF;
END;
$$;

-- PDV (sessao de terminal): garantia de todos os produtos do tenant.
CREATE OR REPLACE FUNCTION public.get_pos_product_warranties()
RETURNS TABLE (product_id TEXT, sku TEXT, warranty_days INTEGER, warranty_months INTEGER)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  RETURN QUERY
  SELECT product.id::TEXT, product.sku::TEXT, product.warranty_days, COALESCE(product.warranty_months, 0)::INTEGER
  FROM public.products AS product
  WHERE product.tenant_id = v_terminal.tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_product_warranties() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_product_warranties() TO authenticated;

CREATE OR REPLACE FUNCTION public.customer_history_payload(p_tenant_id UUID, p_customer_id UUID, p_cpf TEXT, p_units TEXT[], p_limit INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH customer_sales AS (
    SELECT sale.*, COALESCE((
        SELECT SUM(sale_return.total_amount) FROM public.sale_returns AS sale_return
        WHERE sale_return.tenant_id = sale.tenant_id AND sale_return.sale_id = sale.id
      ), 0) AS returned_amount
    FROM public.sales AS sale
    WHERE sale.tenant_id = p_tenant_id
      AND (sale.client_cpf = p_cpf OR (p_customer_id IS NOT NULL AND sale.customer_id = p_customer_id))
      AND (p_units IS NULL OR sale.unit_id = ANY (p_units))
  ), stores AS (
    SELECT unit_id, COALESCE(NULLIF(BTRIM(trade_name), ''), unit_id) AS name FROM public.store_configs WHERE tenant_id = p_tenant_id
  ), credits AS (
    SELECT credit.* FROM public.customer_credits AS credit
    WHERE credit.tenant_id = p_tenant_id AND credit.customer_cpf = p_cpf
  )
  SELECT jsonb_build_object(
    'summary', (SELECT jsonb_build_object(
        'purchases', COUNT(*) FILTER (WHERE status = 'CONCLUIDA'),
        'totalSpent', ROUND(COALESCE(SUM(gross_amount - returned_amount) FILTER (WHERE status = 'CONCLUIDA'), 0), 2),
        'firstPurchase', MIN("timestamp") FILTER (WHERE status = 'CONCLUIDA'),
        'lastPurchase', MAX("timestamp") FILTER (WHERE status = 'CONCLUIDA'),
        'creditBalance', ROUND(COALESCE((SELECT SUM(balance) FROM credits), 0), 2)
      ) FROM customer_sales),
    'purchases', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', sale.id, 'timestamp', sale."timestamp", 'unitId', sale.unit_id,
        'storeName', (SELECT name FROM stores WHERE stores.unit_id = sale.unit_id),
        'status', sale.status, 'grossAmount', sale.gross_amount, 'returnedAmount', sale.returned_amount,
        'paymentMethod', sale.payment_method, 'sellerName', COALESCE(sale.seller_name, sale.operator_name),
        'fiscalType', sale.fiscal_type, 'fiscalStatus', sale.fiscal_status, 'nfceNumber', sale.nfce_number,
        'receiptNumber', sale.receipt_number,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'name', item->>'itemName', 'sku', item->>'itemSku', 'itemType', UPPER(COALESCE(item->>'itemType', 'PRODUCT')),
            'quantity', COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 1),
            'lineTotal', COALESCE(NULLIF(item->>'lineTotal', '')::NUMERIC, 0),
            'serials', CASE WHEN jsonb_typeof(item->'serials') = 'array' THEN item->'serials' ELSE '[]'::JSONB END
          )) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sale.items) = 'array' THEN sale.items ELSE '[]'::JSONB END) AS item), '[]'::JSONB),
        'returns', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'returnNumber', sale_return.return_number, 'createdAt', sale_return.created_at,
            'amount', sale_return.total_amount, 'refundMethod', sale_return.refund_method, 'reason', sale_return.reason
          ) ORDER BY sale_return.created_at) FROM public.sale_returns AS sale_return
          WHERE sale_return.tenant_id = sale.tenant_id AND sale_return.sale_id = sale.id), '[]'::JSONB)
      ) ORDER BY sale."timestamp" DESC)
      FROM (SELECT * FROM customer_sales ORDER BY "timestamp" DESC LIMIT p_limit) AS sale), '[]'::JSONB),
    'warranties', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'saleId', line.sale_id, 'saleDate', line.sale_date, 'storeName', (SELECT name FROM stores WHERE stores.unit_id = line.unit_id),
        'itemName', line.item->>'itemName', 'serial', line.serial,
        'months', line.months,
        'days', line.days,
        'until', CASE
          WHEN line.days > 0 THEN ((line.sale_date AT TIME ZONE 'America/Sao_Paulo')::DATE + line.days)
          WHEN line.months > 0 THEN ((line.sale_date AT TIME ZONE 'America/Sao_Paulo')::DATE + make_interval(months => line.months))::DATE
        END,
        'saleStatus', line.status
      ) ORDER BY line.sale_date DESC)
      FROM (
        SELECT sale.id AS sale_id, sale."timestamp" AS sale_date, sale.unit_id, sale.status, entry.item, serial.value AS serial,
          CASE WHEN COALESCE(product.warranty_days, 0) > 0 THEN 0 ELSE COALESCE(unit.warranty_months, product.warranty_months, 0) END AS months,
          COALESCE(product.warranty_days, 0) AS days
        FROM customer_sales AS sale
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sale.items) = 'array' THEN sale.items ELSE '[]'::JSONB END) AS entry(item)
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(entry.item->'serials') = 'array' AND jsonb_array_length(entry.item->'serials') > 0
            THEN entry.item->'serials' ELSE '[null]'::JSONB END) AS serial(value)
        LEFT JOIN public.products AS product ON product.tenant_id = sale.tenant_id AND product.id = entry.item->>'productId'
        LEFT JOIN public.product_serial_units AS unit ON unit.tenant_id = sale.tenant_id AND serial.value IS NOT NULL
          AND LOWER(unit.serial_number) = LOWER(serial.value)
        WHERE UPPER(COALESCE(entry.item->>'itemType', 'PRODUCT')) = 'PRODUCT' AND sale.status = 'CONCLUIDA'
      ) AS line
      WHERE line.months > 0 OR line.days > 0), '[]'::JSONB),
    'workOrders', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', work_order.id, 'orderNumber', work_order.order_number, 'unitId', work_order.unit_id,
        'storeName', (SELECT name FROM stores WHERE stores.unit_id = work_order.unit_id),
        'status', work_order.status, 'equipment', COALESCE(work_order.equipment_type, work_order.equipment),
        'createdAt', COALESCE(work_order.created_at, work_order."timestamp"), 'expectedDate', work_order.expected_date,
        'deliveredAt', work_order.delivered_at, 'warrantyUntil', work_order.warranty_until,
        'paid', work_order.sale_id IS NOT NULL,
        'total', (SELECT COALESCE(SUM(NULLIF(entry->>'price', '')::NUMERIC), 0) FROM jsonb_array_elements(COALESCE(work_order.items, '[]'::JSONB)) AS entry)
      ) ORDER BY COALESCE(work_order.created_at, work_order."timestamp") DESC)
      FROM public.work_orders AS work_order
      WHERE work_order.tenant_id = p_tenant_id
        AND (work_order.client_cpf = p_cpf OR (p_customer_id IS NOT NULL AND work_order.customer_id = p_customer_id))
        AND (p_units IS NULL OR work_order.unit_id = ANY (p_units))), '[]'::JSONB),
    'credits', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', credit.id, 'unitId', credit.unit_id, 'storeName', (SELECT name FROM stores WHERE stores.unit_id = credit.unit_id),
        'amount', credit.amount, 'balance', credit.balance, 'createdAt', credit.created_at,
        'origin', CASE WHEN credit.origin_trade_in_id IS NOT NULL THEN 'TROCA_GAMER' WHEN credit.origin_return_id IS NOT NULL THEN 'DEVOLUCAO' ELSE 'OUTRO' END,
        'movements', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', movement.kind, 'amount', movement.amount,
            'saleId', movement.sale_id, 'createdAt', movement.created_at) ORDER BY movement.created_at)
          FROM public.customer_credit_movements AS movement WHERE movement.tenant_id = credit.tenant_id AND movement.credit_id = credit.id), '[]'::JSONB)
      ) ORDER BY credit.created_at DESC) FROM credits AS credit), '[]'::JSONB),
    'reservations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', reservation.id, 'unitId', reservation.unit_id, 'storeName', (SELECT name FROM stores WHERE stores.unit_id = reservation.unit_id),
        'status', reservation.status, 'createdAt', reservation.created_at, 'expiresAt', reservation.expires_at,
        'deposit', reservation.deposit_amount, 'saleId', reservation.sale_id,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', item.item_name, 'quantity', item.quantity, 'lineTotal', item.line_total))
          FROM public.product_reservation_items AS item WHERE item.tenant_id = reservation.tenant_id AND item.reservation_id = reservation.id), '[]'::JSONB)
      ) ORDER BY reservation.created_at DESC)
      FROM public.product_reservations AS reservation
      WHERE reservation.tenant_id = p_tenant_id
        AND (reservation.customer_cpf = p_cpf OR (p_customer_id IS NOT NULL AND reservation.customer_id = p_customer_id))
        AND (p_units IS NULL OR reservation.unit_id = ANY (p_units))), '[]'::JSONB),
    'tradeIns', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', trade_in.id, 'tradeNumber', trade_in.trade_number, 'unitId', trade_in.unit_id,
        'storeName', (SELECT name FROM stores WHERE stores.unit_id = trade_in.unit_id),
        'timestamp', trade_in."timestamp", 'description', trade_in.item_description, 'serial', trade_in.serial_number,
        'amount', trade_in.valuation_amount, 'paymentMethod', trade_in.payment_method, 'status', trade_in.status
      ) ORDER BY trade_in."timestamp" DESC)
      FROM public.trade_ins AS trade_in
      WHERE trade_in.tenant_id = p_tenant_id
        AND (regexp_replace(COALESCE(trade_in.seller_cpf, ''), '\D', '', 'g') = p_cpf
          OR (p_customer_id IS NOT NULL AND trade_in.customer_id = p_customer_id))
        AND (p_units IS NULL OR trade_in.unit_id = ANY (p_units))), '[]'::JSONB)
  );
$$;

REVOKE ALL ON FUNCTION public.customer_history_payload(UUID, UUID, TEXT, TEXT[], INTEGER) FROM PUBLIC, anon, authenticated;

COMMIT;
