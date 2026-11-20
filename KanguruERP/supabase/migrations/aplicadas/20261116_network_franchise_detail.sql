-- =========================================================================
-- Painel da Rede, etapa 2: ficha completa de cada franquia (desenho aprovado em 2026-11-01).
-- So leitura. Cada funcao confere que a franquia pertence a rede de quem pergunta
-- (network_assert_tenant). p_unit_id NULL = todas as lojas da franquia.
-- Clientes finais: so nome abreviado e CPF mascarado (LGPD), mascarados aqui no servidor.
-- Colunas conferidas no banco ativo em 2026-11-03. Aditiva: so funcoes novas.
-- =========================================================================

-- A franquia e da rede de quem esta logado? (erro se nao for)
CREATE OR REPLACE FUNCTION public.network_assert_tenant(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id AND network_id = v_me.network_id) THEN
    RAISE EXCEPTION 'Franquia fora da sua rede';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.network_assert_tenant(UUID) FROM PUBLIC, anon, authenticated;

-- Nome abreviado ("Joao S.") e CPF mascarado ("***.456.789-**").
CREATE OR REPLACE FUNCTION public.network_mask_name(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN NULLIF(BTRIM(COALESCE(p_name, '')), '') IS NULL THEN NULL
    WHEN array_length(regexp_split_to_array(BTRIM(p_name), '\s+'), 1) = 1 THEN initcap(BTRIM(p_name))
    ELSE initcap(split_part(BTRIM(p_name), ' ', 1)) || ' ' ||
      upper(left((regexp_split_to_array(BTRIM(p_name), '\s+'))[array_length(regexp_split_to_array(BTRIM(p_name), '\s+'), 1)], 1)) || '.'
  END;
$$;

CREATE OR REPLACE FUNCTION public.network_mask_cpf(p_cpf TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN length(regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g')) = 11
    THEN '***.' || substr(regexp_replace(p_cpf, '\D', '', 'g'), 4, 3) || '.' || substr(regexp_replace(p_cpf, '\D', '', 'g'), 7, 3) || '-**'
    ELSE NULL END;
$$;

REVOKE ALL ON FUNCTION public.network_mask_name(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_mask_cpf(TEXT) FROM PUBLIC, anon, authenticated;

-- ---------------- Financeiro ----------------
-- Formas de pagamento, despesas por categoria, devolucoes e faturamento por dia.
-- (Totais de faturamento/custo/lucro por loja: network_store_metrics, da etapa 1.)
CREATE OR REPLACE FUNCTION public.network_franchise_financial(
  p_tenant_id UUID, p_unit_id TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ, p_tz TEXT DEFAULT 'America/Sao_Paulo'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  RETURN (
    WITH period_sales AS (
      SELECT sale.* FROM public.sales AS sale
      WHERE sale.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR sale.unit_id = p_unit_id)
        AND sale.status = 'CONCLUIDA' AND sale."timestamp" >= p_from AND sale."timestamp" < p_to
    ), payment_lines AS (
      SELECT payment.payment_method AS method, payment.amount
      FROM public.sale_payments AS payment
      JOIN period_sales AS sale ON sale.tenant_id = payment.tenant_id AND sale.id = payment.sale_id
      UNION ALL
      SELECT sale.payment_method, sale.gross_amount - COALESCE(sale.reservation_deposit_applied, 0)
      FROM period_sales AS sale
      WHERE NOT EXISTS (SELECT 1 FROM public.sale_payments AS payment WHERE payment.tenant_id = sale.tenant_id AND payment.sale_id = sale.id)
      UNION ALL
      SELECT 'SINAL DE RESERVA', sale.reservation_deposit_applied FROM period_sales AS sale WHERE COALESCE(sale.reservation_deposit_applied, 0) > 0
    ), returns AS (
      SELECT sale_return.* FROM public.sale_returns AS sale_return
      JOIN period_sales AS sale ON sale.tenant_id = sale_return.tenant_id AND sale.id = sale_return.sale_id
    )
    SELECT jsonb_build_object(
      'payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', method, 'amount', ROUND(total, 2)) ORDER BY total DESC)
        FROM (SELECT method, SUM(amount) AS total FROM payment_lines WHERE amount > 0 GROUP BY method) AS grouped), '[]'::JSONB),
      'expenses', COALESCE((SELECT jsonb_agg(jsonb_build_object('category', category, 'amount', ROUND(total, 2), 'count', entries) ORDER BY total DESC)
        FROM (SELECT COALESCE(NULLIF(BTRIM(expense.category), ''), 'Outros') AS category, SUM(expense.amount) AS total, COUNT(*) AS entries
          FROM public.expenses AS expense
          WHERE expense.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR expense.unit_id = p_unit_id)
            AND expense."timestamp" >= p_from AND expense."timestamp" < p_to
          GROUP BY 1) AS grouped), '[]'::JSONB),
      'returns', jsonb_build_object(
        'count', (SELECT COUNT(*) FROM returns),
        'amount', ROUND(COALESCE((SELECT SUM(total_amount) FROM returns), 0), 2),
        'byMethod', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', refund_method, 'amount', ROUND(total, 2))) FROM
          (SELECT refund_method, SUM(total_amount) AS total FROM returns GROUP BY refund_method) AS grouped), '[]'::JSONB)
      ),
      'daily', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', day, 'revenue', ROUND(revenue, 2), 'salesCount', sales_count) ORDER BY day)
        FROM (SELECT to_char(sale."timestamp" AT TIME ZONE p_tz, 'YYYY-MM-DD') AS day,
            SUM(sale.gross_amount - COALESCE((SELECT SUM(r.total_amount) FROM public.sale_returns AS r WHERE r.tenant_id = sale.tenant_id AND r.sale_id = sale.id), 0)) AS revenue,
            COUNT(*) AS sales_count
          FROM period_sales AS sale GROUP BY 1) AS grouped), '[]'::JSONB)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.network_franchise_financial(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_franchise_financial(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;

-- ---------------- Produtos ----------------
-- Itens vendidos no periodo, por produto/servico (quantidade, faturamento, custo).
CREATE OR REPLACE FUNCTION public.network_franchise_products(p_tenant_id UUID, p_unit_id TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'itemType', grouped.item_type, 'itemId', grouped.item_id, 'name', grouped.name, 'sku', grouped.sku,
      'category', COALESCE(product.category, CASE WHEN grouped.item_type = 'SERVICE' THEN 'Serviços' ELSE 'Sem categoria' END),
      'brand', product.brand, 'quantity', grouped.quantity, 'revenue', ROUND(grouped.revenue, 2),
      'cost', ROUND(grouped.cost, 2), 'missingCost', grouped.missing_cost > 0
    ) ORDER BY grouped.revenue DESC)
    FROM (
      SELECT UPPER(COALESCE(item->>'itemType', 'PRODUCT')) AS item_type,
        COALESCE(item->>'productId', item->>'serviceId') AS item_id,
        MAX(item->>'itemName') AS name, MAX(item->>'itemSku') AS sku,
        SUM(COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 0)) AS quantity,
        SUM(COALESCE(NULLIF(item->>'lineTotal', '')::NUMERIC, 0)) AS revenue,
        SUM(COALESCE(NULLIF(item->>'costTotal', '')::NUMERIC, 0)) AS cost,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(item->>'itemType', 'PRODUCT')) = 'PRODUCT' AND NULLIF(item->>'costTotal', '') IS NULL) AS missing_cost
      FROM public.sales AS sale
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS item
      WHERE sale.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR sale.unit_id = p_unit_id)
        AND sale.status = 'CONCLUIDA' AND sale."timestamp" >= p_from AND sale."timestamp" < p_to
      GROUP BY 1, 2
    ) AS grouped
    LEFT JOIN public.products AS product
      ON grouped.item_type = 'PRODUCT' AND product.tenant_id = p_tenant_id AND product.id = grouped.item_id
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_franchise_products(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_franchise_products(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ---------------- Estoque ----------------
-- Estoque atual por produto e loja com o custo (medio da loja; serializado = custo de cada
-- unidade disponivel), vendas dos ultimos 30 dias, ultima venda e balancos.
CREATE OR REPLACE FUNCTION public.network_franchise_stock(p_tenant_id UUID, p_unit_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  RETURN jsonb_build_object(
    'products', COALESCE((
      WITH stores AS (
        SELECT store.unit_id FROM public.store_configs AS store
        WHERE store.tenant_id = p_tenant_id AND store.unit_id <> 'central' AND (p_unit_id IS NULL OR store.unit_id = p_unit_id)
      ), sold AS (
        SELECT item->>'productId' AS product_id,
          SUM(COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 0)) FILTER (WHERE sale."timestamp" >= NOW() - INTERVAL '30 days') AS sold30,
          MAX(sale."timestamp") AS last_sale_at
        FROM public.sales AS sale
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS item
        WHERE sale.tenant_id = p_tenant_id AND sale.status = 'CONCLUIDA'
          AND (p_unit_id IS NULL OR sale.unit_id = p_unit_id)
          AND UPPER(COALESCE(item->>'itemType', 'PRODUCT')) = 'PRODUCT'
        GROUP BY 1
      )
      SELECT jsonb_agg(jsonb_build_object(
        'productId', product.id, 'sku', product.sku, 'name', product.name, 'category', product.category, 'brand', product.brand,
        'isSerialized', COALESCE(product.is_serialized, false), 'sellPrice', product.sell_price,
        'minStock', product.min_stock, 'sold30', COALESCE(sold.sold30, 0), 'lastSaleAt', sold.last_sale_at,
        'stores', (
          SELECT jsonb_agg(jsonb_build_object(
            'unitId', stores.unit_id,
            'qty', COALESCE((inventory.quantities -> stores.unit_id ->> 'qty')::NUMERIC, 0),
            'costValue', ROUND(CASE WHEN COALESCE(product.is_serialized, false) THEN COALESCE((
                SELECT SUM(COALESCE(unit.unit_cost, product.cost_price, 0)) FROM public.product_serial_units AS unit
                WHERE unit.tenant_id = p_tenant_id AND unit.product_id = product.id AND unit.unit_id = stores.unit_id AND unit.status = 'DISPONIVEL'
              ), 0)
              ELSE GREATEST(COALESCE((inventory.quantities -> stores.unit_id ->> 'qty')::NUMERIC, 0), 0) * COALESCE((
                SELECT cost.avg_cost FROM public.product_store_costs AS cost
                WHERE cost.tenant_id = p_tenant_id AND cost.product_id = product.id AND cost.unit_id = stores.unit_id
              ), product.cost_price, 0) END, 2)
          ))
          FROM stores
        )
      ) ORDER BY product.name)
      FROM public.products AS product
      LEFT JOIN public.inventory AS inventory ON inventory.tenant_id = product.tenant_id AND inventory.product_id = product.id
      LEFT JOIN sold ON sold.product_id = product.id
      WHERE product.tenant_id = p_tenant_id
    ), '[]'::JSONB),
    'counts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', stock_count.id, 'unitId', stock_count.unit_id, 'countNumber', stock_count.count_number, 'status', stock_count.status,
        'createdAt', stock_count.created_at, 'approvedAt', stock_count.approved_at, 'createdByName', stock_count.created_by_name
      ) ORDER BY stock_count.created_at DESC)
      FROM public.stock_counts AS stock_count
      WHERE stock_count.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR stock_count.unit_id = p_unit_id)
    ), '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.network_franchise_stock(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_franchise_stock(UUID, TEXT) TO authenticated;

-- ---------------- Equipe ----------------
CREATE OR REPLACE FUNCTION public.network_franchise_team(p_tenant_id UUID, p_unit_id TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'sellerCode', grouped.seller_code, 'sellerName', grouped.seller_name, 'unitId', grouped.unit_id,
      'salesCount', grouped.sales_count, 'revenue', ROUND(grouped.revenue, 2)
    ) ORDER BY grouped.revenue DESC)
    FROM (
      SELECT sale.seller_code, COALESCE(sale.seller_name, 'Sem vendedor') AS seller_name, sale.unit_id,
        COUNT(*) AS sales_count,
        SUM(sale.gross_amount - COALESCE((SELECT SUM(r.total_amount) FROM public.sale_returns AS r WHERE r.tenant_id = sale.tenant_id AND r.sale_id = sale.id), 0)) AS revenue
      FROM public.sales AS sale
      WHERE sale.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR sale.unit_id = p_unit_id)
        AND sale.status = 'CONCLUIDA' AND sale."timestamp" >= p_from AND sale."timestamp" < p_to
      GROUP BY 1, 2, 3
    ) AS grouped
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_franchise_team(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_franchise_team(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ---------------- Servicos / OS ----------------
CREATE OR REPLACE FUNCTION public.network_franchise_services(p_tenant_id UUID, p_unit_id TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  RETURN jsonb_build_object(
    'byStatus', COALESCE((
      SELECT jsonb_object_agg(status, total) FROM (
        SELECT work_order.status, COUNT(*) AS total FROM public.work_orders AS work_order
        WHERE work_order.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR work_order.unit_id = p_unit_id)
          AND work_order.status IN ('EM_ANALISE', 'AGUARDANDO_PECA', 'PRONTO')
        GROUP BY 1
      ) AS grouped
    ), '{}'::JSONB),
    'openedInPeriod', (SELECT COUNT(*) FROM public.work_orders AS work_order
      WHERE work_order.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR work_order.unit_id = p_unit_id)
        AND COALESCE(work_order.created_at, work_order."timestamp") >= p_from AND COALESCE(work_order.created_at, work_order."timestamp") < p_to),
    'deliveredInPeriod', (SELECT COUNT(*) FROM public.work_orders AS work_order
      WHERE work_order.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR work_order.unit_id = p_unit_id)
        AND work_order.delivered_at >= p_from AND work_order.delivered_at < p_to),
    'servicesRevenue', ROUND(COALESCE((
      SELECT SUM(COALESCE(NULLIF(item->>'lineTotal', '')::NUMERIC, 0))
      FROM public.sales AS sale
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS item
      WHERE sale.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR sale.unit_id = p_unit_id)
        AND sale.status = 'CONCLUIDA' AND sale."timestamp" >= p_from AND sale."timestamp" < p_to
        AND UPPER(COALESCE(item->>'itemType', '')) = 'SERVICE'
    ), 0), 2),
    'open', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'orderNumber', work_order.order_number, 'unitId', work_order.unit_id, 'status', work_order.status,
        'equipment', COALESCE(work_order.equipment_type, work_order.equipment),
        'customer', public.network_mask_name(work_order.client_name),
        'createdAt', COALESCE(work_order.created_at, work_order."timestamp"), 'expectedDate', work_order.expected_date,
        'paid', work_order.sale_id IS NOT NULL, 'staffName', work_order.staff_name,
        'overdue', work_order.expected_date IS NOT NULL AND work_order.expected_date < CURRENT_DATE
      ) ORDER BY COALESCE(work_order.created_at, work_order."timestamp"))
      FROM public.work_orders AS work_order
      WHERE work_order.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR work_order.unit_id = p_unit_id)
        AND work_order.status IN ('EM_ANALISE', 'AGUARDANDO_PECA', 'PRONTO')
    ), '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.network_franchise_services(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_franchise_services(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ---------------- Operacao ----------------
-- PDVs, caixas do periodo (com diferencas), situacao fiscal e notas com problema.
CREATE OR REPLACE FUNCTION public.network_franchise_operations(p_tenant_id UUID, p_unit_id TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  RETURN jsonb_build_object(
    'terminals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', terminal.display_name, 'unitId', terminal.unit_id, 'isActive', terminal.is_active,
        'activatedAt', terminal.activated_at, 'lastUnlockedAt', terminal.last_unlocked_at
      ) ORDER BY terminal.unit_id, terminal.display_name)
      FROM public.pos_terminals AS terminal
      WHERE terminal.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR terminal.unit_id = p_unit_id)
    ), '[]'::JSONB),
    'cashSessions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'unitId', cash.unit_id, 'cashNumber', cash.cash_number, 'status', cash.status,
        'openedAt', cash.opened_at, 'openedBy', cash.opened_by_name, 'closedAt', cash.closed_at, 'closedBy', cash.closed_by_name,
        'openingFloat', cash.opening_float_amount,
        'expectedCash', cash.expected_cash_amount, 'countedCash', cash.counted_cash_amount, 'cashDifference', cash.cash_difference_amount,
        'totalDifference', COALESCE(cash.cash_difference_amount, 0) + COALESCE(cash.pix_difference_amount, 0)
          + COALESCE(cash.credit_difference_amount, 0) + COALESCE(cash.debit_difference_amount, 0)
          + COALESCE(cash.voucher_difference_amount, 0) + COALESCE(cash.credit_account_difference_amount, 0),
        'withdrawals', COALESCE((SELECT SUM(movement.amount) FROM public.cash_register_movements AS movement
          WHERE movement.cash_session_id = cash.id AND movement.type = 'SANGRIA'), 0),
        'supplies', COALESCE((SELECT SUM(movement.amount) FROM public.cash_register_movements AS movement
          WHERE movement.cash_session_id = cash.id AND movement.type = 'SUPRIMENTO'), 0)
      ) ORDER BY cash.opened_at DESC)
      FROM public.cash_register_sessions AS cash
      WHERE cash.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR cash.unit_id = p_unit_id)
        AND (cash.status = 'ABERTO' OR (cash.opened_at >= p_from AND cash.opened_at < p_to))
    ), '[]'::JSONB),
    'fiscal', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'unitId', store.unit_id, 'storeName', store.trade_name,
        'configured', setting.unit_id IS NOT NULL, 'environment', setting.environment,
        'municipalRegistration', store.municipal_registration IS NOT NULL, 'cityCode', store.city_ibge_code IS NOT NULL,
        'nfceAuthorized', (SELECT COUNT(*) FROM public.sales AS sale WHERE sale.tenant_id = store.tenant_id AND sale.unit_id = store.unit_id
          AND sale.fiscal_status = 'AUTORIZADA' AND sale."timestamp" >= p_from AND sale."timestamp" < p_to),
        'nfceProblems', (SELECT COUNT(*) FROM public.sales AS sale WHERE sale.tenant_id = store.tenant_id AND sale.unit_id = store.unit_id
          AND sale.status = 'CONCLUIDA' AND sale.fiscal_status IN ('ERRO', 'PENDENTE')),
        'nfseAuthorized', (SELECT COUNT(*) FROM public.sale_service_invoices AS invoice WHERE invoice.tenant_id = store.tenant_id AND invoice.unit_id = store.unit_id
          AND invoice.status = 'AUTORIZADA' AND invoice.created_at >= p_from AND invoice.created_at < p_to),
        'nfseProblems', (SELECT COUNT(*) FROM public.sale_service_invoices AS invoice WHERE invoice.tenant_id = store.tenant_id AND invoice.unit_id = store.unit_id
          AND invoice.status IN ('ERRO', 'PENDENTE'))
      ) ORDER BY store.trade_name)
      FROM public.store_configs AS store
      LEFT JOIN public.store_fiscal_settings AS setting ON setting.tenant_id = store.tenant_id AND setting.unit_id = store.unit_id
      WHERE store.tenant_id = p_tenant_id AND store.unit_id <> 'central' AND (p_unit_id IS NULL OR store.unit_id = p_unit_id)
    ), '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.network_franchise_operations(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_franchise_operations(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ---------------- Clientes (mascarados) ----------------
CREATE OR REPLACE FUNCTION public.network_franchise_customers(p_tenant_id UUID, p_unit_id TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  RETURN (
    WITH buyers AS (
      SELECT regexp_replace(sale.client_cpf, '\D', '', 'g') AS cpf, MAX(sale.client_name) AS name,
        COUNT(*) AS purchases, SUM(sale.gross_amount) AS spent, MAX(sale."timestamp") AS last_purchase
      FROM public.sales AS sale
      WHERE sale.tenant_id = p_tenant_id AND (p_unit_id IS NULL OR sale.unit_id = p_unit_id)
        AND sale.status = 'CONCLUIDA' AND sale."timestamp" >= p_from AND sale."timestamp" < p_to
        AND length(regexp_replace(COALESCE(sale.client_cpf, ''), '\D', '', 'g')) = 11
      GROUP BY 1
    ), returning_buyers AS (
      SELECT buyers.cpf FROM buyers
      WHERE EXISTS (SELECT 1 FROM public.sales AS older
        WHERE older.tenant_id = p_tenant_id AND older.status = 'CONCLUIDA' AND older."timestamp" < p_from
          AND regexp_replace(COALESCE(older.client_cpf, ''), '\D', '', 'g') = buyers.cpf)
    )
    SELECT jsonb_build_object(
      'totalCustomers', (SELECT COUNT(*) FROM public.customers AS customer WHERE customer.tenant_id = p_tenant_id AND customer.is_active),
      'newCustomers', (SELECT COUNT(*) FROM public.customers AS customer WHERE customer.tenant_id = p_tenant_id
        AND customer.created_at >= p_from AND customer.created_at < p_to),
      'buyers', (SELECT COUNT(*) FROM buyers),
      'returningBuyers', (SELECT COUNT(*) FROM returning_buyers),
      'repeatInPeriod', (SELECT COUNT(*) FROM buyers WHERE purchases > 1),
      'identifiedRevenue', ROUND(COALESCE((SELECT SUM(spent) FROM buyers), 0), 2),
      'top', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'name', public.network_mask_name(COALESCE(customer.name, buyers.name)), 'cpf', public.network_mask_cpf(buyers.cpf),
          'purchases', buyers.purchases, 'spent', ROUND(buyers.spent, 2), 'lastPurchase', buyers.last_purchase,
          'returning', buyers.cpf IN (SELECT cpf FROM returning_buyers)
        ) ORDER BY buyers.spent DESC)
        FROM (SELECT * FROM buyers ORDER BY spent DESC LIMIT 30) AS buyers
        LEFT JOIN public.customers AS customer ON customer.tenant_id = p_tenant_id AND customer.cpf = buyers.cpf
      ), '[]'::JSONB)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.network_franchise_customers(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_franchise_customers(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
