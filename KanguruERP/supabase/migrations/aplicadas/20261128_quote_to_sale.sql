-- Orcamento de PC, etapa 2 (aprovada em 2026-11-12): converter o orcamento em venda.
-- Caminho aprovado: ao converter, cria um cadastro para aquele PC (NCM 8471.50.10, CSOSN 102,
-- origem 2, tributos 26%) e lanca 1 unidade no estoque com o custo das pecas digitadas. A venda,
-- o estorno, a devolucao e a NFC-e seguem as funcoes de hoje (nenhuma funcao de venda muda).
-- As pecas e valores vao para products.invoice_details (NFC-e: informacoes_adicionais_item, ate
-- 500 caracteres). PC vendido e com estoque zerado some da busca do caixa.
-- Aditiva: colunas novas, funcoes novas, gatilhos novos em sales (nunca recusam venda) e
-- search_pos_items copiada da 20261026 com um filtro a mais (mesma assinatura e retorno).
-- Antes de aplicar: md5 vivo de search_pos_items deve ser f7db1f13f05097257793365a99ac37f8 (LF)
-- ou 19d41d23ff3a91f62ecea4be51b0f881 (CRLF).
BEGIN;

ALTER TABLE public.pos_quotes
  ADD COLUMN IF NOT EXISTS product_id TEXT,
  ADD COLUMN IF NOT EXISTS sale_id TEXT,
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ;
ALTER TABLE public.pos_quotes DROP CONSTRAINT IF EXISTS pos_quotes_status_check;
ALTER TABLE public.pos_quotes ADD CONSTRAINT pos_quotes_status_check
  CHECK (status IN ('ABERTO', 'CONVERTIDO', 'VENDIDO', 'CANCELADO'));

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS quote_id UUID,
  ADD COLUMN IF NOT EXISTS invoice_details TEXT;
CREATE INDEX IF NOT EXISTS products_quote_idx ON public.products (tenant_id, quote_id) WHERE quote_id IS NOT NULL;

-- Valor em reais no formato brasileiro (interna).
CREATE OR REPLACE FUNCTION public.pos_money_text(p_value NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT 'R$ ' || translate(to_char(COALESCE(p_value, 0), 'FM999G999G990D00'), ',.', '.,');
$$;

REVOKE ALL ON FUNCTION public.pos_money_text(NUMERIC) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pos_quote_payload(p_quote public.pos_quotes)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'quoteId', p_quote.id,
    'kind', p_quote.kind,
    'quoteNumber', p_quote.quote_number,
    'status', p_quote.status,
    'title', p_quote.title,
    'customerName', p_quote.customer_name,
    'customerPhone', p_quote.customer_phone,
    'validUntil', p_quote.valid_until,
    'isExpired', p_quote.valid_until IS NOT NULL AND p_quote.valid_until < (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE,
    'installmentMarkup', p_quote.installment_markup,
    'items', p_quote.items,
    'totalCost', p_quote.total_cost,
    'totalPrice', p_quote.total_price,
    'sellerCode', p_quote.seller_code,
    'sellerName', p_quote.seller_name,
    'marginApproved', p_quote.margin_approved,
    'productId', p_quote.product_id,
    'saleId', p_quote.sale_id,
    'convertedAt', p_quote.converted_at,
    'soldAt', p_quote.sold_at,
    'createdAt', p_quote.created_at,
    'updatedAt', p_quote.updated_at
  );
$$;

REVOKE ALL ON FUNCTION public.pos_quote_payload(public.pos_quotes) FROM PUBLIC, anon, authenticated;

-- Lista: orcamentos em aberto, aguardando pagamento e vendidos; setups so ativos.
CREATE OR REPLACE FUNCTION public.list_pos_quotes(p_kind TEXT DEFAULT 'QUOTE', p_query TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_query TEXT := NULLIF(BTRIM(COALESCE(p_query, '')), '');
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(public.pos_quote_payload(quote) ORDER BY quote.created_at DESC)
    FROM (
      SELECT * FROM public.pos_quotes AS candidate
      WHERE candidate.tenant_id = v_terminal.tenant_id
        AND candidate.kind = p_kind
        AND candidate.status <> 'CANCELADO'
        AND (candidate.kind = 'TEMPLATE' OR candidate.unit_id = v_terminal.unit_id)
        AND (
          v_query IS NULL
          OR candidate.quote_number::TEXT = v_query
          OR candidate.title ILIKE '%' || v_query || '%'
          OR candidate.customer_name ILIKE '%' || v_query || '%'
          OR candidate.customer_phone ILIKE '%' || v_query || '%'
        )
      ORDER BY candidate.created_at DESC
      LIMIT 100
    ) AS quote
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.list_pos_quotes(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pos_quotes(TEXT, TEXT) TO authenticated;

-- Converte: cria (ou atualiza) o cadastro do PC e lanca 1 unidade no estoque da loja.
-- Ja convertido: devolve o mesmo PC (para voltar ao caixa se a venda foi abandonada).
CREATE OR REPLACE FUNCTION public.convert_pos_quote(p_quote_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_quote public.pos_quotes%ROWTYPE;
  v_today DATE := (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE;
  v_price NUMERIC;
  v_details TEXT;
  v_product_id TEXT;
  v_sku TEXT;
  v_quantities JSONB;
  v_qty_before INTEGER;
  v_stock JSONB;
BEGIN
  SELECT * INTO v_quote FROM public.pos_quotes
  WHERE id = p_quote_id AND tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND kind = 'QUOTE'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Orçamento não encontrado nesta loja'; END IF;
  IF v_quote.status = 'VENDIDO' THEN RAISE EXCEPTION 'Este orçamento já foi vendido'; END IF;
  IF v_quote.status = 'CANCELADO' THEN RAISE EXCEPTION 'Este orçamento foi cancelado'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'productId', line->>'productId', 'sku', line->>'sku', 'quantity', (line->>'quantity')::INTEGER
  )), '[]'::JSONB)
  INTO v_stock
  FROM jsonb_array_elements(v_quote.items) AS line
  WHERE line->>'source' = 'STOCK';

  IF v_quote.status = 'ABERTO' THEN
    IF v_quote.valid_until < v_today THEN
      RAISE EXCEPTION 'Orçamento vencido: confira os preços e salve de novo antes de vender';
    END IF;

    SELECT COALESCE(SUM((entry.line->>'lineTotal')::NUMERIC), 0),
      left(string_agg(
        (entry.line->>'partType') || ': '
          || CASE WHEN (entry.line->>'quantity')::INTEGER > 1 THEN (entry.line->>'quantity') || 'x ' ELSE '' END
          || (entry.line->>'description') || ' - ' || public.pos_money_text((entry.line->>'lineTotal')::NUMERIC),
        '; ' ORDER BY entry.ord), 500)
    INTO v_price, v_details
    FROM jsonb_array_elements(v_quote.items) WITH ORDINALITY AS entry(line, ord)
    WHERE entry.line->>'source' = 'TYPED';

    IF COALESCE(v_price, 0) <= 0 THEN
      RAISE EXCEPTION 'Este orçamento só tem peças do estoque: venda direto pelo caixa';
    END IF;

    v_product_id := v_quote.product_id;
    IF v_product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.products WHERE tenant_id = v_terminal.tenant_id AND id = v_product_id
    ) THEN
      UPDATE public.products
      SET name = left(v_quote.title, 120), cost_price = v_quote.total_cost, sell_price = v_price, invoice_details = v_details
      WHERE tenant_id = v_terminal.tenant_id AND id = v_product_id
      RETURNING sku INTO v_sku;
    ELSE
      v_product_id := gen_random_uuid()::TEXT;
      INSERT INTO public.products (
        id, tenant_id, sku, name, category, cost_price, sell_price, ncm, icms_origin, csosn,
        icms_rate, tax_burden_percent, is_serialized, quote_id, invoice_details
      ) VALUES (
        v_product_id, v_terminal.tenant_id, NULL, left(v_quote.title, 120), 'PCs montados',
        v_quote.total_cost, v_price, '84715010', '2', '102', 0, 26, false, v_quote.id, v_details
      )
      RETURNING sku INTO v_sku;
    END IF;

    -- Entrada de 1 unidade com o custo das pecas (mesma conta da entrada de estoque do ERP).
    SELECT inv.quantities INTO v_quantities
    FROM public.inventory AS inv
    WHERE inv.tenant_id = v_terminal.tenant_id AND inv.product_id = v_product_id
    FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
      VALUES (v_terminal.tenant_id, v_product_id, '{}'::JSONB, NOW());
      v_quantities := '{}'::JSONB;
    END IF;
    v_quantities := public.inventory_with_unit(v_quantities, v_terminal.unit_id);
    v_qty_before := COALESCE((v_quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0);
    PERFORM public.apply_store_cost_entry(v_terminal.tenant_id, v_product_id, v_terminal.unit_id, v_qty_before, 1, v_quote.total_cost);
    v_quantities := jsonb_set(v_quantities, ARRAY[v_terminal.unit_id, 'qty'], to_jsonb(v_qty_before + 1), true);
    UPDATE public.inventory SET quantities = v_quantities, updated_at = NOW()
    WHERE tenant_id = v_terminal.tenant_id AND product_id = v_product_id;

    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
    ) VALUES (
      gen_random_uuid()::TEXT, v_terminal.tenant_id, v_product_id, NULL, 'ORCAMENTO', v_terminal.unit_id, 'ENTRADA', 1,
      '[]'::JSONB, NULL, auth.uid()::TEXT, COALESCE(v_quote.seller_name, 'PDV'), NOW(),
      'Orçamento nº ' || v_quote.quote_number, v_quote.total_cost
    );

    UPDATE public.pos_quotes
    SET status = 'CONVERTIDO', product_id = v_product_id, converted_at = NOW(), updated_at = NOW()
    WHERE id = v_quote.id;
  ELSE
    v_product_id := v_quote.product_id;
    SELECT sku INTO v_sku FROM public.products WHERE tenant_id = v_terminal.tenant_id AND id = v_product_id;
  END IF;

  SELECT * INTO v_quote FROM public.pos_quotes WHERE id = p_quote_id;
  RETURN jsonb_build_object(
    'quote', public.pos_quote_payload(v_quote),
    'productId', v_product_id,
    'sku', v_sku,
    'stockLines', v_stock
  );
END;
$$;

REVOKE ALL ON FUNCTION public.convert_pos_quote(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_pos_quote(UUID) TO authenticated;

-- Cancelar: em aberto vira cancelado; convertido desfaz a conversao (tira a unidade do estoque
-- e volta para "em aberto"); vendido nao cancela (use estorno ou devolucao).
CREATE OR REPLACE FUNCTION public.cancel_pos_quote(p_quote_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_quote public.pos_quotes%ROWTYPE;
  v_quantities JSONB;
  v_qty INTEGER;
BEGIN
  SELECT * INTO v_quote FROM public.pos_quotes AS quote
  WHERE quote.id = p_quote_id
    AND quote.tenant_id = v_terminal.tenant_id
    AND quote.status IN ('ABERTO', 'CONVERTIDO')
    AND (quote.kind = 'TEMPLATE' OR quote.unit_id = v_terminal.unit_id)
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Orçamento não encontrado nesta loja'; END IF;

  IF v_quote.status = 'CONVERTIDO' THEN
    SELECT inv.quantities INTO v_quantities
    FROM public.inventory AS inv
    WHERE inv.tenant_id = v_terminal.tenant_id AND inv.product_id = v_quote.product_id
    FOR UPDATE;
    v_qty := COALESCE((v_quantities -> v_quote.unit_id ->> 'qty')::INTEGER, 0);
    IF v_qty < 1 THEN
      RAISE EXCEPTION 'O computador deste orçamento já saiu do estoque: não dá para desfazer a conversão';
    END IF;
    UPDATE public.inventory
    SET quantities = jsonb_set(v_quantities, ARRAY[v_quote.unit_id, 'qty'], to_jsonb(v_qty - 1), true), updated_at = NOW()
    WHERE tenant_id = v_terminal.tenant_id AND product_id = v_quote.product_id;
    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
    ) VALUES (
      gen_random_uuid()::TEXT, v_terminal.tenant_id, v_quote.product_id, NULL, v_quote.unit_id, 'ORCAMENTO', 'PERDA', 1,
      '[]'::JSONB, NULL, auth.uid()::TEXT, COALESCE(v_quote.seller_name, 'PDV'), NOW(),
      'Conversão do orçamento nº ' || v_quote.quote_number || ' desfeita', v_quote.total_cost
    );
    UPDATE public.pos_quotes SET status = 'ABERTO', converted_at = NULL, updated_at = NOW() WHERE id = v_quote.id;
    RETURN;
  END IF;

  UPDATE public.pos_quotes SET status = 'CANCELADO', updated_at = NOW() WHERE id = v_quote.id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_pos_quote(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_pos_quote(UUID) TO authenticated;

-- Pecas do PC para imprimir abaixo do item no cupom e no DANFE.
CREATE OR REPLACE FUNCTION public.get_pos_item_invoice_details(p_skus TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('sku', product.sku, 'details', product.invoice_details))
    FROM public.products AS product
    WHERE product.tenant_id = v_terminal.tenant_id
      AND product.invoice_details IS NOT NULL
      AND product.sku = ANY (COALESCE(p_skus, ARRAY[]::TEXT[]))
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_item_invoice_details(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_item_invoice_details(TEXT[]) TO authenticated;

-- Venda do PC marca o orcamento como vendido; estorno volta para "aguardando pagamento".
-- Nunca recusam a venda nem o estorno.
CREATE OR REPLACE FUNCTION public.link_sale_to_quote()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    UPDATE public.pos_quotes AS quote
    SET status = 'VENDIDO', sale_id = NEW.id::TEXT, sold_at = NOW(), updated_at = NOW()
    FROM public.products AS product
    WHERE product.tenant_id = NEW.tenant_id
      AND product.quote_id = quote.id
      AND quote.tenant_id = NEW.tenant_id
      AND quote.status = 'CONVERTIDO'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::JSONB)) AS item
        WHERE item->>'productId' = product.id
      );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.unlink_cancelled_sale_quote()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'CANCELADA' AND OLD.status IS DISTINCT FROM 'CANCELADA' THEN
    BEGIN
      UPDATE public.pos_quotes
      SET status = 'CONVERTIDO', sale_id = NULL, sold_at = NULL, updated_at = NOW()
      WHERE tenant_id = NEW.tenant_id AND sale_id = NEW.id::TEXT AND status = 'VENDIDO';
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.link_sale_to_quote() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unlink_cancelled_sale_quote() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_sale_quote_link ON public.sales;
CREATE TRIGGER zz_sale_quote_link AFTER INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.link_sale_to_quote();
DROP TRIGGER IF EXISTS zz_sale_quote_unlink ON public.sales;
CREATE TRIGGER zz_sale_quote_unlink AFTER UPDATE OF status ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.unlink_cancelled_sale_quote();

-- Copia da 20261026 com um filtro a mais: PC de orcamento sem estoque nesta loja nao aparece.
CREATE OR REPLACE FUNCTION public.search_pos_items(p_query TEXT)
RETURNS TABLE (
  item_id TEXT,
  item_type TEXT,
  sku TEXT,
  name TEXT,
  brand TEXT,
  sell_price NUMERIC,
  available_quantity INTEGER,
  warranty_months INTEGER,
  requires_unit_selection BOOLEAN,
  max_item_discount_percent NUMERIC,
  stores_with_stock TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_query TEXT := BTRIM(p_query);
  v_max_discount NUMERIC(5, 2);
BEGIN
  IF COALESCE(v_query, '') = '' THEN
    RETURN;
  END IF;

  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  SELECT COALESCE(config.max_item_discount_percent, 0)
  INTO v_max_discount
  FROM public.store_configs AS config
  WHERE config.tenant_id = v_terminal.tenant_id
    AND config.unit_id = v_terminal.unit_id;
  v_max_discount := COALESCE(v_max_discount, 0);

  RETURN QUERY
  SELECT results.item_id, results.item_type, results.sku, results.name, results.brand,
    results.sell_price, results.available_quantity, results.warranty_months,
    results.requires_unit_selection, COALESCE(results.item_limit, v_max_discount), results.stores_with_stock
  FROM (
    SELECT product.id AS item_id, 'PRODUCT'::TEXT AS item_type, product.sku,
      product.name, product.brand, product.sell_price,
      GREATEST(local_stock.qty, 0) AS available_quantity,
      product.warranty_months,
      COALESCE(product.is_serialized, false) AS requires_unit_selection,
      CASE WHEN local_stock.qty > 0 THEN ARRAY[]::TEXT[] ELSE ARRAY(
        SELECT COALESCE(NULLIF(BTRIM(store.trade_name), ''), store.unit_id)
        FROM public.store_configs AS store
        WHERE store.tenant_id = v_terminal.tenant_id
          AND store.unit_id <> v_terminal.unit_id
          AND store.unit_id <> 'central'
          AND public.pos_store_available_qty(
            v_terminal.tenant_id, product.id, store.unit_id, COALESCE(inventory.quantities, '{}'::JSONB)
          ) > 0
        ORDER BY 1
      ) END AS stores_with_stock,
      product.max_discount_percent AS item_limit
    FROM public.products AS product
    LEFT JOIN public.inventory AS inventory
      ON inventory.tenant_id = v_terminal.tenant_id
      AND inventory.product_id = product.id
    CROSS JOIN LATERAL (
      SELECT public.pos_store_available_qty(
        v_terminal.tenant_id, product.id, v_terminal.unit_id, COALESCE(inventory.quantities, '{}'::JSONB)
      ) AS qty
    ) AS local_stock
    WHERE product.tenant_id = v_terminal.tenant_id
      AND (product.quote_id IS NULL OR local_stock.qty > 0)
      AND (
        product.sku ILIKE '%' || v_query || '%'
        OR product.name ILIKE '%' || v_query || '%'
        OR COALESCE(product.brand, '') ILIKE '%' || v_query || '%'
      )

    UNION ALL

    SELECT service.id AS item_id, 'SERVICE'::TEXT AS item_type, service.sku,
      service.name, NULL::TEXT AS brand, service.sell_price, 0 AS available_quantity,
      NULL::INTEGER AS warranty_months, false AS requires_unit_selection,
      ARRAY[]::TEXT[] AS stores_with_stock,
      NULL::NUMERIC AS item_limit
    FROM public.services AS service
    WHERE service.tenant_id = v_terminal.tenant_id
      AND service.is_active
      AND (
        service.sku ILIKE '%' || v_query || '%'
        OR service.name ILIKE '%' || v_query || '%'
        OR service.category ILIKE '%' || v_query || '%'
      )
  ) AS results
  -- Codigo exato primeiro; depois quem tem estoque (servico conta como disponivel).
  ORDER BY CASE WHEN results.sku ILIKE v_query THEN 0 ELSE 1 END,
    CASE WHEN results.item_type = 'PRODUCT' AND results.available_quantity <= 0 THEN 1 ELSE 0 END,
    results.name
  LIMIT 30;
END;
$$;

REVOKE ALL ON FUNCTION public.search_pos_items(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_pos_items(TEXT) TO authenticated;

COMMIT;
