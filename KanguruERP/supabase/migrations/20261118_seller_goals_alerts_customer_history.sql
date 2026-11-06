-- =========================================================================
-- Melhorias do franqueado (desenhos aprovados em 2026-11-03):
-- 1. Meta do mes por vendedor + relatorio "Vendas por vendedor" no PDV (todos podem ver).
--    Conta so PRODUTOS (servicos/OS fora), pelo valor sem juros do cartao, menos devolucoes.
--    Reserva convertida conta para quem iniciou (a venda ja guarda esse vendedor).
-- 2. Alertas do ERP ("Precisa de atenção"): OS atrasadas/paradas, notas com problema, caixa com
--    diferenca acima do limite da loja, reservas vencidas, vendas offline com divergencia.
--    Ficam ate o problema ser resolvido (sem "dispensar"). Estoque baixo e calculado no ERP.
-- 3. Ficha completa do cliente (ERP) e historico resumido (PDV).
-- Aditiva: 2 colunas novas e funcoes novas. Nenhuma funcao de venda/caixa/estorno mudou.
-- =========================================================================

ALTER TABLE public.pdv_operators
  ADD COLUMN IF NOT EXISTS monthly_goal NUMERIC(12, 2);
ALTER TABLE public.pdv_operators DROP CONSTRAINT IF EXISTS pdv_operators_monthly_goal_check;
ALTER TABLE public.pdv_operators
  ADD CONSTRAINT pdv_operators_monthly_goal_check CHECK (monthly_goal IS NULL OR monthly_goal >= 0);

-- Diferenca de caixa (R$) a partir da qual o ERP mostra alerta.
ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS cash_difference_alert NUMERIC(12, 2) NOT NULL DEFAULT 10;
ALTER TABLE public.store_configs DROP CONSTRAINT IF EXISTS store_configs_cash_difference_alert_check;
ALTER TABLE public.store_configs
  ADD CONSTRAINT store_configs_cash_difference_alert_check CHECK (cash_difference_alert >= 0);

-- Valor em reais no formato brasileiro (R$ 1.234,56), sem depender do idioma do banco.
CREATE OR REPLACE FUNCTION public.format_brl(p_value NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'R$ ' || translate(to_char(COALESCE(p_value, 0), 'FM999,999,990.00'), ',.', '.,');
$$;

REVOKE ALL ON FUNCTION public.format_brl(NUMERIC) FROM PUBLIC, anon, authenticated;

-- Valor dos PRODUTOS de uma venda, sem os juros do cartao repassados ao cliente.
CREATE OR REPLACE FUNCTION public.sale_product_amount(p_items JSONB)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(SUM(COALESCE(NULLIF(item->>'lineTotal', '')::NUMERIC, 0) - COALESCE(NULLIF(item->>'cardSurcharge', '')::NUMERIC, 0)), 0)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::JSONB END) AS item
  WHERE UPPER(COALESCE(item->>'itemType', 'PRODUCT')) = 'PRODUCT';
$$;

REVOKE ALL ON FUNCTION public.sale_product_amount(JSONB) FROM PUBLIC, anon, authenticated;

-- ---------------- 1. Vendas por vendedor (PDV) ----------------
CREATE OR REPLACE FUNCTION public.get_pos_seller_report(p_tz TEXT DEFAULT 'America/Sao_Paulo')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_today DATE := (NOW() AT TIME ZONE p_tz)::DATE;
  v_month_start DATE := date_trunc('month', (NOW() AT TIME ZONE p_tz))::DATE;
  v_next_month DATE := (date_trunc('month', (NOW() AT TIME ZONE p_tz)) + INTERVAL '1 month')::DATE;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  RETURN (
    WITH month_sales AS (
      SELECT sale.seller_code, sale.seller_name, (sale."timestamp" AT TIME ZONE p_tz)::DATE AS sale_day,
        public.sale_product_amount(sale.items) - COALESCE((
          SELECT SUM(sale_return.total_amount) FROM public.sale_returns AS sale_return
          WHERE sale_return.tenant_id = sale.tenant_id AND sale_return.sale_id = sale.id
        ), 0) AS amount
      FROM public.sales AS sale
      WHERE sale.tenant_id = v_terminal.tenant_id AND sale.unit_id = v_terminal.unit_id
        AND sale.status = 'CONCLUIDA' AND sale.seller_code IS NOT NULL
        AND sale."timestamp" >= (v_month_start::TIMESTAMP AT TIME ZONE p_tz)
        AND sale."timestamp" < (v_next_month::TIMESTAMP AT TIME ZONE p_tz)
        AND public.sale_product_amount(sale.items) > 0
    ), sellers AS (
      SELECT operator.code, operator.name, operator.monthly_goal FROM public.pdv_operators AS operator
      WHERE operator.tenant_id = v_terminal.tenant_id AND operator.unit_id = v_terminal.unit_id
        AND operator.is_active AND operator.code IS NOT NULL
      UNION
      -- Quem vendeu no mes e foi desativado depois continua no relatorio.
      SELECT DISTINCT month_sales.seller_code, month_sales.seller_name, NULL::NUMERIC FROM month_sales
      WHERE NOT EXISTS (SELECT 1 FROM public.pdv_operators AS operator
        WHERE operator.tenant_id = v_terminal.tenant_id AND operator.unit_id = v_terminal.unit_id
          AND operator.is_active AND operator.code = month_sales.seller_code)
    ), rows_data AS (
      SELECT sellers.code, sellers.name, sellers.monthly_goal AS goal,
        COALESCE(SUM(month_sales.amount) FILTER (WHERE month_sales.sale_day = v_today), 0) AS today_amount,
        COUNT(month_sales.sale_day) FILTER (WHERE month_sales.sale_day = v_today) AS today_count,
        COALESCE(SUM(month_sales.amount), 0) AS month_amount,
        COUNT(month_sales.sale_day) AS month_count
      FROM sellers
      LEFT JOIN month_sales ON month_sales.seller_code = sellers.code
      GROUP BY sellers.code, sellers.name, sellers.monthly_goal
    )
    SELECT jsonb_build_object(
      'date', v_today,
      'daysLeft', v_next_month - v_today,
      'daysInMonth', v_next_month - v_month_start,
      'sellers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'code', code, 'name', name, 'goal', goal,
          'todayAmount', ROUND(today_amount, 2), 'todayCount', today_count,
          'monthAmount', ROUND(month_amount, 2), 'monthCount', month_count
        ) ORDER BY month_amount DESC, code) FROM rows_data), '[]'::JSONB)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_seller_report(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_seller_report(TEXT) TO authenticated;

-- ---------------- 2. Alertas do ERP ----------------
-- Lista de pendencias das lojas que o usuario enxerga. Cada linha: kind, unitId, ref, title, detail, date.
CREATE OR REPLACE FUNCTION public.list_erp_alerts()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := public.current_user_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RETURN '[]'::JSONB;
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(alert ORDER BY alert->>'date' DESC NULLS LAST)
    FROM (
      -- OS atrasada: passou da previsao e ainda nao ficou pronta.
      SELECT jsonb_build_object('kind', 'OS_ATRASADA', 'unitId', work_order.unit_id, 'ref', work_order.id,
        'title', 'OS nº ' || COALESCE(work_order.order_number::TEXT, '?') || ' atrasada',
        'detail', concat_ws(' · ', COALESCE(work_order.equipment_type, work_order.equipment), work_order.client_name,
          'previsão ' || to_char(work_order.expected_date, 'DD/MM/YYYY')),
        'date', work_order.expected_date) AS alert
      FROM public.work_orders AS work_order
      WHERE work_order.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, work_order.unit_id)
        AND work_order.status IN ('EM_ANALISE', 'AGUARDANDO_PECA')
        AND work_order.expected_date IS NOT NULL AND work_order.expected_date < CURRENT_DATE
      UNION ALL
      -- OS pronta e nao retirada ha mais de 30 dias (aviso antes do abandono de 90 dias).
      SELECT jsonb_build_object('kind', 'OS_PARADA', 'unitId', work_order.unit_id, 'ref', work_order.id,
        'title', 'OS nº ' || COALESCE(work_order.order_number::TEXT, '?') || ' pronta e não retirada',
        'detail', concat_ws(' · ', COALESCE(work_order.equipment_type, work_order.equipment), work_order.client_name,
          'pronta desde ' || to_char(work_order.updated_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY')),
        'date', work_order.updated_at)
      FROM public.work_orders AS work_order
      WHERE work_order.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, work_order.unit_id)
        AND work_order.status = 'PRONTO' AND work_order.updated_at < NOW() - INTERVAL '30 days'
      UNION ALL
      -- NFC-e com erro ou parada como pendente (mais de 10 min).
      SELECT jsonb_build_object('kind', 'NOTA', 'unitId', sale.unit_id, 'ref', sale.id,
        'title', 'NFC-e ' || CASE WHEN sale.fiscal_status = 'ERRO' THEN 'com erro' ELSE 'pendente' END,
        'detail', concat_ws(' · ', 'Venda de ' || to_char(sale."timestamp" AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
          public.format_brl(sale.gross_amount)),
        'date', sale."timestamp")
      FROM public.sales AS sale
      WHERE sale.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, sale.unit_id)
        AND sale.status = 'CONCLUIDA' AND sale.fiscal_status IN ('ERRO', 'PENDENTE')
        AND sale."timestamp" < NOW() - INTERVAL '10 minutes'
      UNION ALL
      -- NFC-e em contingencia ha mais de 12 h sem ser efetivada (prazo da Sefaz: 24 h).
      SELECT jsonb_build_object('kind', 'NOTA', 'unitId', sale.unit_id, 'ref', sale.id,
        'title', 'NFC-e em contingência há mais de 12 h',
        'detail', 'Venda de ' || to_char(sale."timestamp" AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' · abra o PDV com internet para enviar',
        'date', sale."timestamp")
      FROM public.sales AS sale
      WHERE sale.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, sale.unit_id)
        AND sale.status = 'CONCLUIDA' AND sale.nfce_contingency AND NOT sale.nfce_contingency_done
        AND sale.fiscal_status = 'AUTORIZADA' AND sale."timestamp" < NOW() - INTERVAL '12 hours'
      UNION ALL
      -- NFS-e com erro ou pendente.
      SELECT jsonb_build_object('kind', 'NOTA', 'unitId', invoice.unit_id, 'ref', invoice.sale_id,
        'title', 'NFS-e ' || CASE WHEN invoice.status = 'ERRO' THEN 'com erro' ELSE 'pendente' END,
        'detail', concat_ws(' · ', 'Serviço de ' || to_char(invoice.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
          public.format_brl(invoice.amount), NULLIF(LEFT(invoice.message, 120), '')),
        'date', invoice.created_at)
      FROM public.sale_service_invoices AS invoice
      JOIN public.sales AS sale ON sale.tenant_id = invoice.tenant_id AND sale.id = invoice.sale_id AND sale.status = 'CONCLUIDA'
      WHERE invoice.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, invoice.unit_id)
        AND invoice.status IN ('ERRO', 'PENDENTE') AND invoice.created_at < NOW() - INTERVAL '10 minutes'
      UNION ALL
      -- NF-e de devolucao com erro.
      SELECT jsonb_build_object('kind', 'NOTA', 'unitId', sale_return.unit_id, 'ref', sale_return.sale_id,
        'title', 'NF-e de devolução nº ' || sale_return.return_number || ' com erro',
        'detail', 'Devolução de ' || to_char(sale_return.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
        'date', sale_return.created_at)
      FROM public.sale_returns AS sale_return
      WHERE sale_return.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, sale_return.unit_id)
        AND sale_return.fiscal_status = 'ERRO'
      UNION ALL
      -- Caixa fechado nos ultimos 7 dias com diferenca acima do limite da loja.
      SELECT jsonb_build_object('kind', 'CAIXA', 'unitId', cash.unit_id, 'ref', cash.id,
        'title', 'Caixa ' || COALESCE(cash.cash_number, '') || ' fechado com diferença de ' || public.format_brl(cash.total_difference),
        'detail', concat_ws(' · ', 'Fechado em ' || to_char(cash.closed_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'),
          'por ' || cash.closed_by_name, 'limite da loja ' || public.format_brl(cash.alert_limit)),
        'date', cash.closed_at)
      FROM (
        SELECT session.*, store.cash_difference_alert AS alert_limit,
          COALESCE(session.cash_difference_amount, 0) + COALESCE(session.pix_difference_amount, 0)
            + COALESCE(session.credit_difference_amount, 0) + COALESCE(session.debit_difference_amount, 0)
            + COALESCE(session.voucher_difference_amount, 0) + COALESCE(session.credit_account_difference_amount, 0) AS total_difference
        FROM public.cash_register_sessions AS session
        JOIN public.store_configs AS store ON store.tenant_id = session.tenant_id AND store.unit_id = session.unit_id
        WHERE session.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, session.unit_id)
          AND session.closed_at >= NOW() - INTERVAL '7 days'
      ) AS cash
      WHERE ABS(cash.total_difference) > cash.alert_limit
      UNION ALL
      -- Reserva ativa que passou do prazo de retirada.
      SELECT jsonb_build_object('kind', 'RESERVA', 'unitId', reservation.unit_id, 'ref', reservation.id,
        'title', 'Reserva vencida de ' || reservation.customer_name,
        'detail', concat_ws(' · ', 'Prazo ' || to_char(reservation.expires_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY'),
          CASE WHEN reservation.deposit_amount > 0 THEN 'sinal ' || public.format_brl(reservation.deposit_amount) END,
          reservation.customer_phone),
        'date', reservation.expires_at)
      FROM public.product_reservations AS reservation
      WHERE reservation.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, reservation.unit_id)
        AND reservation.status = 'ATIVA' AND reservation.expires_at < NOW()
      UNION ALL
      -- Venda feita sem internet com divergencia ainda nao resolvida.
      SELECT jsonb_build_object('kind', 'OFFLINE', 'unitId', conflict.unit_id, 'ref', conflict.sale_id,
        'title', 'Venda sem internet com divergência',
        'detail', conflict.detail, 'date', conflict.created_at)
      FROM public.pos_offline_conflicts AS conflict
      WHERE conflict.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, conflict.unit_id)
        AND NOT conflict.resolved
    ) AS alerts
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.list_erp_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_erp_alerts() TO authenticated;

-- ---------------- 3. Historico do cliente ----------------
-- Monta o historico de um cliente (CPF) dentro de uma empresa. p_units NULL = todas as lojas.
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
        'until', CASE WHEN line.months > 0 THEN ((line.sale_date AT TIME ZONE 'America/Sao_Paulo')::DATE + make_interval(months => line.months))::DATE END,
        'saleStatus', line.status
      ) ORDER BY line.sale_date DESC)
      FROM (
        SELECT sale.id AS sale_id, sale."timestamp" AS sale_date, sale.unit_id, sale.status, entry.item, serial.value AS serial,
          COALESCE(unit.warranty_months, product.warranty_months, 0) AS months
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
      WHERE line.months > 0), '[]'::JSONB),
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

-- ERP: ficha completa (so as lojas que o usuario enxerga).
CREATE OR REPLACE FUNCTION public.get_customer_history(p_customer_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := public.current_user_tenant_id();
  v_customer public.customers%ROWTYPE;
  v_units TEXT[];
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  SELECT * INTO v_customer FROM public.customers WHERE tenant_id = v_tenant AND id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;
  SELECT array_agg(store.unit_id) INTO v_units FROM public.store_configs AS store
  WHERE store.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, store.unit_id);
  RETURN public.customer_history_payload(v_tenant, v_customer.id, v_customer.cpf, COALESCE(v_units, ARRAY[]::TEXT[]), 300);
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_history(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_history(UUID) TO authenticated;

-- PDV: historico resumido do cliente da venda (todas as lojas da empresa, ultimas 10 compras).
CREATE OR REPLACE FUNCTION public.get_pos_customer_history(p_cpf TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cpf TEXT := regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g');
  v_customer_id UUID;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;
  IF length(v_cpf) <> 11 THEN RAISE EXCEPTION 'CPF inválido'; END IF;
  SELECT id INTO v_customer_id FROM public.customers WHERE tenant_id = v_terminal.tenant_id AND cpf = v_cpf;
  RETURN public.customer_history_payload(v_terminal.tenant_id, v_customer_id, v_cpf, NULL, 10);
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_customer_history(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_customer_history(TEXT) TO authenticated;
