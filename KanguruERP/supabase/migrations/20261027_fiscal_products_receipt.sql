-- 2.8a: dados fiscais do produto, numero do cupom por loja/mes e dados do cupom no PDV.
-- 1. products: CEST, origem, CST, CSOSN, ICMS %, reducao do ICMS %, total de tributos %
--    (NCM ja existe). Listas fixas (origem 0-8, CST oficial, CSOSN) por CHECK.
-- 2. store_configs.instagram (QR code do cupom).
-- 3. sales: tipo fiscal (NAO_FISCAL | NFCE, padrao NAO_FISCAL), situacao da nota (2.8b) e
--    numero do cupom 00001.. por loja, recomecando a cada mes (trigger; a funcao de venda
--    nao muda).
-- 4. get_pos_store_profile ganha IE e Instagram; get_pos_sale_receipt (dados do cupom /
--    reimpressao do ultimo cupom do terminal).
BEGIN;

-- ---- 1. Dados fiscais do produto ----
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS cest TEXT,
  ADD COLUMN IF NOT EXISTS icms_origin TEXT,
  ADD COLUMN IF NOT EXISTS icms_cst TEXT,
  ADD COLUMN IF NOT EXISTS csosn TEXT,
  ADD COLUMN IF NOT EXISTS icms_rate NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS icms_reduction NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS tax_burden_percent NUMERIC(5, 2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_icms_origin_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_icms_origin_check
      CHECK (icms_origin IS NULL OR icms_origin IN ('0', '1', '2', '3', '4', '5', '6', '7', '8'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_icms_cst_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_icms_cst_check
      CHECK (icms_cst IS NULL OR icms_cst IN ('00', '10', '20', '30', '40', '41', '50', '51', '60', '70', '90'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_csosn_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_csosn_check
      CHECK (csosn IS NULL OR csosn IN ('101', '102', '103', '201', '202', '203', '300', '400', '500', '900'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_fiscal_percent_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_fiscal_percent_check
      CHECK (
        (icms_rate IS NULL OR icms_rate BETWEEN 0 AND 100)
        AND (icms_reduction IS NULL OR icms_reduction BETWEEN 0 AND 100)
        AND (tax_burden_percent IS NULL OR tax_burden_percent BETWEEN 0 AND 100)
      );
  END IF;
END;
$$;

-- ---- 2. Instagram da loja ----
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS instagram TEXT;

-- ---- 3. Tipo fiscal e numero do cupom na venda ----
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS fiscal_type TEXT NOT NULL DEFAULT 'NAO_FISCAL',
  ADD COLUMN IF NOT EXISTS fiscal_status TEXT,
  ADD COLUMN IF NOT EXISTS receipt_number INTEGER,
  ADD COLUMN IF NOT EXISTS receipt_period TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_fiscal_type_check') THEN
    ALTER TABLE public.sales ADD CONSTRAINT sales_fiscal_type_check
      CHECK (fiscal_type IN ('NAO_FISCAL', 'NFCE'));
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS sales_receipt_number_key
  ON public.sales (tenant_id, unit_id, receipt_period, receipt_number)
  WHERE receipt_number IS NOT NULL;

-- Interna: proximo numero de cupom da loja no mes da venda (horario de Brasilia).
CREATE OR REPLACE FUNCTION public.assign_sale_receipt_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.receipt_number IS NULL THEN
    NEW.receipt_period := to_char(COALESCE(NEW."timestamp", NOW()) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
    PERFORM pg_advisory_xact_lock(hashtext('receipt:' || NEW.tenant_id::TEXT || ':' || NEW.unit_id || ':' || NEW.receipt_period));
    SELECT COALESCE(MAX(sale.receipt_number), 0) + 1 INTO NEW.receipt_number
    FROM public.sales AS sale
    WHERE sale.tenant_id = NEW.tenant_id AND sale.unit_id = NEW.unit_id
      AND sale.receipt_period = NEW.receipt_period;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_sale_receipt_number() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_sale_receipt_number ON public.sales;
CREATE TRIGGER zz_sale_receipt_number
  BEFORE INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.assign_sale_receipt_number();

-- ---- 4. RPCs do PDV (sessao de terminal) ----
-- Perfil da loja: retorno ganha IE e Instagram (DROP + CREATE; so o PDV usa).
DROP FUNCTION IF EXISTS public.get_pos_store_profile();
CREATE FUNCTION public.get_pos_store_profile()
RETURNS TABLE (
  trade_name TEXT,
  legal_name TEXT,
  cnpj TEXT,
  address TEXT,
  phone TEXT,
  reservation_voucher_terms TEXT,
  state_registration TEXT,
  instagram TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  RETURN QUERY
  SELECT config.trade_name, config.legal_name, config.cnpj, config.address, config.phone,
    config.reservation_voucher_terms, config.state_registration, config.instagram
  FROM public.store_configs AS config
  WHERE config.tenant_id = v_terminal.tenant_id AND config.unit_id = v_terminal.unit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_store_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_store_profile() TO authenticated;

-- Dados do cupom de uma venda da loja do terminal. Sem p_sale_id: a ultima venda
-- registrada por este terminal (botao "Reimprimir ultimo cupom").
CREATE OR REPLACE FUNCTION public.get_pos_sale_receipt(p_sale_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_sale public.sales%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  IF p_sale_id IS NULL THEN
    SELECT * INTO v_sale FROM public.sales AS sale
    WHERE sale.tenant_id = v_terminal.tenant_id AND sale.unit_id = v_terminal.unit_id
      AND sale.operator_id = v_terminal.id::TEXT
    ORDER BY sale."timestamp" DESC
    LIMIT 1;
  ELSE
    SELECT * INTO v_sale FROM public.sales AS sale
    WHERE sale.tenant_id = v_terminal.tenant_id AND sale.unit_id = v_terminal.unit_id
      AND sale.id = p_sale_id;
  END IF;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'saleId', v_sale.id,
    'receiptNumber', v_sale.receipt_number,
    'receiptPeriod', v_sale.receipt_period,
    'timestamp', v_sale."timestamp",
    'items', COALESCE(v_sale.items, '[]'::JSONB),
    'grossAmount', v_sale.gross_amount,
    'depositApplied', COALESCE(v_sale.reservation_deposit_applied, 0),
    'paymentMethod', v_sale.payment_method,
    'payments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('paymentMethod', payment.payment_method, 'amount', payment.amount)
        ORDER BY payment.created_at)
      FROM public.sale_payments AS payment
      WHERE payment.tenant_id = v_sale.tenant_id AND payment.sale_id = v_sale.id
    ), '[]'::JSONB),
    'sellerName', v_sale.seller_name,
    'clientName', v_sale.client_name,
    'clientCpf', v_sale.client_cpf,
    'fiscalType', v_sale.fiscal_type,
    'status', v_sale.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_sale_receipt(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_sale_receipt(TEXT) TO authenticated;

COMMIT;
