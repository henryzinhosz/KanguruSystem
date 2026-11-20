-- Orcamento de PC no PDV, etapa 1 (aprovado em 2026-11-10): orcamento, setups prontos,
-- WhatsApp e PDF. Nao mexe em venda, caixa nem estoque.
-- - Cada linha: peca digitada (custo + margem definidos pelo vendedor) ou produto do estoque
--   (preco do cadastro; o custo medio continua escondido do PDV).
-- - Margem abaixo do minimo da loja exige a senha Gerente (mesma conferencia do desconto).
-- - Custo digitado fica guardado (pos_part_prices) para sugerir nos proximos orcamentos.
-- Aditiva: 3 colunas em store_configs, 2 tabelas novas (sem politicas, so RPC) e funcoes novas.
BEGIN;

ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS quote_min_margin NUMERIC(6, 2) NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS quote_installment_markup NUMERIC(6, 2) NOT NULL DEFAULT 13,
  ADD COLUMN IF NOT EXISTS quote_valid_days INTEGER NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS public.pos_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'QUOTE' CHECK (kind IN ('QUOTE', 'TEMPLATE')),
  quote_number INTEGER,
  status TEXT NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO', 'CANCELADO')),
  title TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  valid_until DATE,
  installment_markup NUMERIC(6, 2) NOT NULL DEFAULT 13,
  items JSONB NOT NULL DEFAULT '[]'::JSONB,
  total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  seller_code TEXT,
  seller_name TEXT,
  margin_approved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_quotes_number_key
  ON public.pos_quotes (tenant_id, unit_id, quote_number) WHERE quote_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_quotes_list_idx
  ON public.pos_quotes (tenant_id, kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pos_part_prices (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  part_key TEXT NOT NULL,
  part_type TEXT,
  name TEXT NOT NULL,
  last_cost NUMERIC(14, 2) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, part_key)
);

ALTER TABLE public.pos_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_part_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pos_quotes, public.pos_part_prices FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_guard_subscription ON public.pos_quotes;
CREATE TRIGGER zz_guard_subscription BEFORE INSERT ON public.pos_quotes
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_subscription();

-- Formato devolvido ao PDV (interna).
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
    'createdAt', p_quote.created_at,
    'updatedAt', p_quote.updated_at
  );
$$;

REVOKE ALL ON FUNCTION public.pos_quote_payload(public.pos_quotes) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_pos_quote_settings()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_config public.store_configs%ROWTYPE;
BEGIN
  SELECT * INTO v_config FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loja não encontrada'; END IF;
  RETURN jsonb_build_object(
    'minMargin', v_config.quote_min_margin,
    'installmentMarkup', v_config.quote_installment_markup,
    'validDays', v_config.quote_valid_days
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_quote_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_quote_settings() TO authenticated;

-- Orcamentos sao da loja do terminal; setups prontos valem para a empresa toda.
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
        AND candidate.status = 'ABERTO'
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

-- Grava o orcamento ou o setup. O servidor recalcula totais e confere a margem.
CREATE OR REPLACE FUNCTION public.save_pos_quote(
  p_quote_id UUID,
  p_kind TEXT,
  p_title TEXT,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_seller_code TEXT,
  p_valid_until DATE,
  p_installment_markup NUMERIC,
  p_items JSONB,
  p_admin_password TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_config public.store_configs%ROWTYPE;
  v_seller public.pdv_operators%ROWTYPE;
  v_title TEXT := NULLIF(BTRIM(COALESCE(p_title, '')), '');
  v_today DATE := (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE;
  v_item JSONB;
  v_lines JSONB := '[]'::JSONB;
  v_type TEXT;
  v_name TEXT;
  v_qty INTEGER;
  v_cost NUMERIC;
  v_price NUMERIC;
  v_is_labor BOOLEAN;
  v_product_id TEXT;
  v_sku TEXT;
  v_total_cost NUMERIC := 0;
  v_total_price NUMERIC := 0;
  v_below BOOLEAN := false;
  v_check JSONB;
  v_number INTEGER;
  v_quote public.pos_quotes%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('QUOTE', 'TEMPLATE') THEN RAISE EXCEPTION 'Tipo inválido'; END IF;
  IF v_title IS NULL THEN RAISE EXCEPTION 'Informe o nome do computador ou do orçamento'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Adicione ao menos uma peça';
  END IF;
  IF jsonb_array_length(p_items) > 40 THEN RAISE EXCEPTION 'Máximo de 40 linhas por orçamento'; END IF;
  IF p_installment_markup IS NULL OR p_installment_markup < 0 OR p_installment_markup > 100 THEN
    RAISE EXCEPTION 'Acréscimo do parcelamento inválido';
  END IF;

  SELECT * INTO v_config FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loja não encontrada'; END IF;

  IF p_kind = 'QUOTE' THEN
    v_seller := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, p_seller_code);
    IF v_seller.id IS NULL THEN
      RETURN jsonb_build_object('status', 'INVALID_SELLER');
    END IF;
    IF p_valid_until IS NULL OR p_valid_until < v_today THEN
      RAISE EXCEPTION 'A validade do orçamento não pode estar no passado';
    END IF;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_type := COALESCE(NULLIF(BTRIM(COALESCE(v_item->>'partType', '')), ''), 'Outro');
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 99 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;
    v_product_id := NULLIF(v_item->>'productId', '');

    IF v_product_id IS NOT NULL THEN
      -- Produto do estoque: nome e preco sempre do cadastro; custo nao vai para o PDV.
      SELECT product.sku, product.name, product.sell_price INTO v_sku, v_name, v_price
      FROM public.products AS product
      WHERE product.tenant_id = v_terminal.tenant_id AND product.id::TEXT = v_product_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Produto do orçamento não encontrado'; END IF;
      v_total_price := v_total_price + ROUND(v_price * v_qty, 2);
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'source', 'STOCK', 'partType', v_type, 'description', v_name, 'productId', v_product_id,
        'sku', v_sku, 'quantity', v_qty, 'unitCost', NULL, 'marginPercent', NULL,
        'unitPrice', v_price, 'lineTotal', ROUND(v_price * v_qty, 2)
      ));
    ELSE
      v_name := NULLIF(BTRIM(COALESCE(v_item->>'description', '')), '');
      IF v_name IS NULL THEN RAISE EXCEPTION 'Descreva todas as peças do orçamento'; END IF;
      IF length(v_name) > 200 THEN RAISE EXCEPTION 'Descrição da peça muito longa'; END IF;
      v_is_labor := v_type = 'Montagem';
      v_cost := ROUND(COALESCE(NULLIF(v_item->>'unitCost', '')::NUMERIC, 0), 2);
      v_price := ROUND(COALESCE(NULLIF(v_item->>'unitPrice', '')::NUMERIC, 0), 2);
      IF v_cost < 0 OR v_price < 0 THEN RAISE EXCEPTION 'Valores da peça inválidos'; END IF;
      IF NOT v_is_labor AND v_cost <= 0 THEN RAISE EXCEPTION 'Informe o custo de "%"', v_name; END IF;
      IF NOT v_is_labor AND v_price <= 0 THEN RAISE EXCEPTION 'Informe o preço de "%"', v_name; END IF;
      IF p_kind = 'QUOTE' AND NOT v_is_labor
        AND v_price < ROUND(v_cost * (1 + v_config.quote_min_margin / 100), 2) THEN
        v_below := true;
      END IF;
      v_total_cost := v_total_cost + ROUND(v_cost * v_qty, 2);
      v_total_price := v_total_price + ROUND(v_price * v_qty, 2);
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'source', 'TYPED', 'partType', v_type, 'description', v_name, 'productId', NULL,
        'sku', NULL, 'quantity', v_qty, 'unitCost', v_cost,
        'marginPercent', CASE WHEN v_cost > 0 THEN ROUND((v_price / v_cost - 1) * 100, 2) END,
        'unitPrice', v_price, 'lineTotal', ROUND(v_price * v_qty, 2)
      ));
    END IF;
  END LOOP;

  IF v_below THEN
    IF NULLIF(COALESCE(p_admin_password, ''), '') IS NULL THEN
      RETURN jsonb_build_object('status', 'PASSWORD_REQUIRED', 'minMargin', v_config.quote_min_margin);
    END IF;
    v_check := public.check_pos_admin_password(v_terminal.id, p_admin_password, 'DISCOUNT_APPROVAL');
    IF v_check->>'status' <> 'OK' THEN
      RETURN v_check;
    END IF;
  END IF;

  IF p_quote_id IS NULL THEN
    IF p_kind = 'QUOTE' THEN
      PERFORM pg_advisory_xact_lock(hashtext('pos_quote:' || v_terminal.tenant_id::TEXT || ':' || v_terminal.unit_id));
      SELECT COALESCE(MAX(quote_number), 0) + 1 INTO v_number
      FROM public.pos_quotes
      WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
    END IF;
    INSERT INTO public.pos_quotes (
      tenant_id, unit_id, kind, quote_number, title, customer_name, customer_phone, valid_until,
      installment_markup, items, total_cost, total_price, seller_code, seller_name, margin_approved
    ) VALUES (
      v_terminal.tenant_id, v_terminal.unit_id, p_kind, v_number, v_title,
      NULLIF(BTRIM(COALESCE(p_customer_name, '')), ''), NULLIF(BTRIM(COALESCE(p_customer_phone, '')), ''),
      CASE WHEN p_kind = 'QUOTE' THEN p_valid_until END,
      p_installment_markup, v_lines, v_total_cost, v_total_price,
      v_seller.code, v_seller.name, v_below
    ) RETURNING * INTO v_quote;
  ELSE
    UPDATE public.pos_quotes AS quote
    SET title = v_title,
        customer_name = NULLIF(BTRIM(COALESCE(p_customer_name, '')), ''),
        customer_phone = NULLIF(BTRIM(COALESCE(p_customer_phone, '')), ''),
        valid_until = CASE WHEN p_kind = 'QUOTE' THEN p_valid_until END,
        installment_markup = p_installment_markup,
        items = v_lines,
        total_cost = v_total_cost,
        total_price = v_total_price,
        seller_code = v_seller.code,
        seller_name = v_seller.name,
        margin_approved = v_below,
        updated_at = NOW()
    WHERE quote.id = p_quote_id
      AND quote.tenant_id = v_terminal.tenant_id
      AND quote.kind = p_kind
      AND quote.status = 'ABERTO'
      AND (quote.kind = 'TEMPLATE' OR quote.unit_id = v_terminal.unit_id)
    RETURNING quote.* INTO v_quote;
    IF NOT FOUND THEN RAISE EXCEPTION 'Orçamento não encontrado nesta loja'; END IF;
  END IF;

  -- Guarda o custo de cada peca digitada. A data so muda quando o custo muda, para
  -- "cotado ha X dias" nao parecer novo quando o orcamento foi so salvo de novo.
  INSERT INTO public.pos_part_prices AS memory (tenant_id, part_key, part_type, name, last_cost, updated_at)
  SELECT DISTINCT ON (part.part_key)
    v_terminal.tenant_id, part.part_key, part.part_type, part.name, part.cost, NOW()
  FROM (
    SELECT lower(regexp_replace(btrim(line->>'description'), '\s+', ' ', 'g')) AS part_key,
      line->>'partType' AS part_type, line->>'description' AS name, (line->>'unitCost')::NUMERIC AS cost
    FROM jsonb_array_elements(v_lines) AS line
    WHERE line->>'source' = 'TYPED' AND COALESCE((line->>'unitCost')::NUMERIC, 0) > 0
  ) AS part
  ON CONFLICT (tenant_id, part_key) DO UPDATE
  SET part_type = EXCLUDED.part_type,
      name = EXCLUDED.name,
      last_cost = EXCLUDED.last_cost,
      updated_at = CASE WHEN memory.last_cost IS DISTINCT FROM EXCLUDED.last_cost THEN NOW() ELSE memory.updated_at END;

  RETURN jsonb_build_object('status', 'OK', 'quote', public.pos_quote_payload(v_quote));
END;
$$;

REVOKE ALL ON FUNCTION public.save_pos_quote(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, NUMERIC, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_pos_quote(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, NUMERIC, JSONB, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_pos_quote(p_quote_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
BEGIN
  UPDATE public.pos_quotes AS quote
  SET status = 'CANCELADO', updated_at = NOW()
  WHERE quote.id = p_quote_id
    AND quote.tenant_id = v_terminal.tenant_id
    AND quote.status = 'ABERTO'
    AND (quote.kind = 'TEMPLATE' OR quote.unit_id = v_terminal.unit_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Orçamento não encontrado nesta loja'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_pos_quote(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_pos_quote(UUID) TO authenticated;

-- Sugestoes de custo ao digitar a peca: ultimas cotacoes e catalogos de fornecedores.
CREATE OR REPLACE FUNCTION public.search_pos_quote_parts(p_query TEXT)
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
  IF v_query IS NULL OR length(v_query) < 3 THEN RETURN '[]'::JSONB; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(match_rows.row_data ORDER BY match_rows.priority, match_rows.seen_at DESC)
    FROM (
      (
        SELECT 1 AS priority, memory.updated_at AS seen_at, jsonb_build_object(
          'source', 'COTACAO', 'name', memory.name, 'partType', memory.part_type,
          'cost', memory.last_cost, 'date', memory.updated_at, 'supplier', NULL
        ) AS row_data
        FROM public.pos_part_prices AS memory
        WHERE memory.tenant_id = v_terminal.tenant_id AND memory.name ILIKE '%' || v_query || '%'
        ORDER BY memory.updated_at DESC
        LIMIT 6
      )
      UNION ALL
      (
        SELECT 2 AS priority, item.updated_at AS seen_at, jsonb_build_object(
          'source', 'FORNECEDOR', 'name', item.name, 'partType', NULL,
          'cost', item.unit_cost, 'date', item.updated_at, 'supplier', supplier.name
        ) AS row_data
        FROM public.supplier_catalog_items AS item
        JOIN public.supplier_catalogs AS catalog ON catalog.id = item.catalog_id
        JOIN public.suppliers AS supplier ON supplier.tenant_id = catalog.tenant_id AND supplier.id = catalog.supplier_id
        WHERE item.tenant_id = v_terminal.tenant_id AND item.is_active AND item.unit_cost > 0
          AND item.name ILIKE '%' || v_query || '%'
        ORDER BY item.updated_at DESC
        LIMIT 6
      )
    ) AS match_rows
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.search_pos_quote_parts(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_pos_quote_parts(TEXT) TO authenticated;

COMMIT;
