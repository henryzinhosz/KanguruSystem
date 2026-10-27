-- 2.8b: emissao de NFC-e pela Focus NFe.
-- 1. store_fiscal_settings: chave da Focus por loja + ambiente. Nenhuma tela le esta tabela
--    (RLS sem politicas e sem GRANT): so as Edge Functions (service role) usam a chave.
-- 2. Colunas da NFC-e na venda (numero, serie, chave, protocolo, links) e historico de envios.
-- 3. UCP (SUPER_ADMIN): grava/remove a chave e lista "configurada/nao configurada".
-- 4. ERP: situacao da NFC-e por loja (sem a chave).
-- 5. PDV (sessao de terminal): situacao da NFC-e da loja, busca de vendas para reimpressao
--    e get_pos_sale_receipt com os dados da NFC-e (mesma assinatura e retorno JSONB).
-- Nenhuma RPC de venda, reserva, caixa ou estorno muda.
BEGIN;

-- ---- 1. Chave da Focus por loja ----
CREATE TABLE IF NOT EXISTS public.store_fiscal_settings (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  focus_token TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'homologacao' CHECK (environment IN ('homologacao', 'producao')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID,
  PRIMARY KEY (tenant_id, unit_id)
);

ALTER TABLE public.store_fiscal_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.store_fiscal_settings FROM PUBLIC, anon, authenticated;

-- ---- 2. NFC-e na venda ----
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS nfce_ref TEXT,
  ADD COLUMN IF NOT EXISTS nfce_environment TEXT,
  ADD COLUMN IF NOT EXISTS nfce_number TEXT,
  ADD COLUMN IF NOT EXISTS nfce_series TEXT,
  ADD COLUMN IF NOT EXISTS nfce_key TEXT,
  ADD COLUMN IF NOT EXISTS nfce_protocol TEXT,
  ADD COLUMN IF NOT EXISTS nfce_qrcode_url TEXT,
  ADD COLUMN IF NOT EXISTS nfce_consult_url TEXT,
  ADD COLUMN IF NOT EXISTS nfce_xml_url TEXT,
  ADD COLUMN IF NOT EXISTS nfce_danfe_url TEXT,
  ADD COLUMN IF NOT EXISTS nfce_message TEXT,
  ADD COLUMN IF NOT EXISTS nfce_authorized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nfce_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nfce_cancel_xml_url TEXT,
  ADD COLUMN IF NOT EXISTS nfce_tax_total NUMERIC(12, 2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_fiscal_status_check') THEN
    ALTER TABLE public.sales ADD CONSTRAINT sales_fiscal_status_check
      CHECK (fiscal_status IS NULL OR fiscal_status IN ('PENDENTE', 'AUTORIZADA', 'ERRO', 'CANCELADA'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS sales_nfce_number_idx ON public.sales (tenant_id, unit_id, nfce_number)
  WHERE nfce_number IS NOT NULL;

-- Historico de cada envio/cancelamento (auditoria; so as Edge Functions gravam).
CREATE TABLE IF NOT EXISTS public.sale_fiscal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('EMITIR', 'CONSULTAR', 'CANCELAR')),
  nfce_ref TEXT,
  environment TEXT,
  http_status INTEGER,
  result_status TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.sale_fiscal_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sale_fiscal_events FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS sale_fiscal_events_sale_idx ON public.sale_fiscal_events (tenant_id, sale_id, created_at);

-- ---- 3. UCP ----
-- Grava a chave (em branco = mantem a atual, para trocar so o ambiente).
CREATE OR REPLACE FUNCTION public.platform_set_store_focus(
  p_tenant_id UUID,
  p_unit_id TEXT,
  p_token TEXT,
  p_environment TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token TEXT := NULLIF(BTRIM(COALESCE(p_token, '')), '');
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso restrito à administração da plataforma';
  END IF;
  IF p_environment NOT IN ('homologacao', 'producao') THEN
    RAISE EXCEPTION 'Ambiente inválido';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.store_configs WHERE tenant_id = p_tenant_id AND unit_id = BTRIM(p_unit_id)
  ) THEN
    RAISE EXCEPTION 'Unidade não encontrada para este tenant';
  END IF;
  IF v_token IS NOT NULL AND v_token !~ '^[A-Za-z0-9]{10,200}$' THEN
    RAISE EXCEPTION 'Chave da Focus inválida';
  END IF;

  IF v_token IS NULL THEN
    UPDATE public.store_fiscal_settings
    SET environment = p_environment, updated_at = NOW(), updated_by = auth.uid()
    WHERE tenant_id = p_tenant_id AND unit_id = BTRIM(p_unit_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Informe a chave da Focus';
    END IF;
  ELSE
    INSERT INTO public.store_fiscal_settings (tenant_id, unit_id, focus_token, environment, updated_by)
    VALUES (p_tenant_id, BTRIM(p_unit_id), v_token, p_environment, auth.uid())
    ON CONFLICT (tenant_id, unit_id) DO UPDATE
    SET focus_token = EXCLUDED.focus_token, environment = EXCLUDED.environment,
        updated_at = NOW(), updated_by = EXCLUDED.updated_by;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_clear_store_focus(p_tenant_id UUID, p_unit_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso restrito à administração da plataforma';
  END IF;
  DELETE FROM public.store_fiscal_settings WHERE tenant_id = p_tenant_id AND unit_id = BTRIM(p_unit_id);
END;
$$;

-- Lista por loja: configurada ou nao (nunca devolve a chave).
CREATE OR REPLACE FUNCTION public.platform_list_store_fiscal(p_tenant_id UUID)
RETURNS TABLE (unit_id TEXT, configured BOOLEAN, environment TEXT, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso restrito à administração da plataforma';
  END IF;
  RETURN QUERY
  SELECT store.unit_id, setting.unit_id IS NOT NULL, setting.environment, setting.updated_at
  FROM public.store_configs AS store
  LEFT JOIN public.store_fiscal_settings AS setting
    ON setting.tenant_id = store.tenant_id AND setting.unit_id = store.unit_id
  WHERE store.tenant_id = p_tenant_id
  ORDER BY store.unit_id;
END;
$$;

-- ---- 4. ERP ----
CREATE OR REPLACE FUNCTION public.list_store_nfce_status()
RETURNS TABLE (unit_id TEXT, configured BOOLEAN, environment TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT store.unit_id, setting.unit_id IS NOT NULL, setting.environment
  FROM public.store_configs AS store
  LEFT JOIN public.store_fiscal_settings AS setting
    ON setting.tenant_id = store.tenant_id AND setting.unit_id = store.unit_id
  WHERE store.tenant_id = public.current_user_tenant_id()
    AND public.current_user_has_store_access(store.tenant_id, store.unit_id)
  ORDER BY store.unit_id;
$$;

-- ---- 5. PDV (sessao de terminal) ----
CREATE OR REPLACE FUNCTION public.get_pos_nfce_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_environment TEXT;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT setting.environment INTO v_environment
  FROM public.store_fiscal_settings AS setting
  WHERE setting.tenant_id = v_terminal.tenant_id AND setting.unit_id = v_terminal.unit_id;
  RETURN jsonb_build_object('configured', v_environment IS NOT NULL, 'environment', v_environment);
END;
$$;

-- Busca de vendas da loja para reimpressao: por data (dia, horario de Brasilia), por numero
-- (cupom ou NFC-e) ou por CPF. Ate 200 vendas, mais recentes primeiro.
CREATE OR REPLACE FUNCTION public.search_pos_sales(
  p_date DATE DEFAULT NULL,
  p_number TEXT DEFAULT NULL,
  p_cpf TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_number TEXT := NULLIF(regexp_replace(COALESCE(p_number, ''), '\D', '', 'g'), '');
  v_cpf TEXT := NULLIF(regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g'), '');
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  IF p_date IS NULL AND v_number IS NULL AND v_cpf IS NULL THEN
    RETURN '[]'::JSONB;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_data ORDER BY sale_time DESC)
    FROM (
      SELECT sale."timestamp" AS sale_time, jsonb_build_object(
        'saleId', sale.id,
        'receiptNumber', sale.receipt_number,
        'receiptPeriod', sale.receipt_period,
        'timestamp', sale."timestamp",
        'grossAmount', sale.gross_amount,
        'clientName', sale.client_name,
        'clientCpf', sale.client_cpf,
        'sellerName', sale.seller_name,
        'status', sale.status,
        'fiscalType', sale.fiscal_type,
        'fiscalStatus', sale.fiscal_status,
        'nfceNumber', sale.nfce_number,
        'nfceMessage', sale.nfce_message
      ) AS row_data
      FROM public.sales AS sale
      WHERE sale.tenant_id = v_terminal.tenant_id AND sale.unit_id = v_terminal.unit_id
        AND (p_date IS NULL OR (sale."timestamp" AT TIME ZONE 'America/Sao_Paulo')::DATE = p_date)
        AND (v_number IS NULL OR sale.receipt_number::TEXT = ltrim(v_number, '0')
             OR ltrim(sale.nfce_number, '0') = ltrim(v_number, '0'))
        AND (v_cpf IS NULL OR regexp_replace(COALESCE(sale.client_cpf, ''), '\D', '', 'g') = v_cpf)
      ORDER BY sale."timestamp" DESC
      LIMIT 200
    ) AS found
  ), '[]'::JSONB);
END;
$$;

-- Dados do cupom: mesma funcao da 20261027 com os campos da NFC-e no retorno.
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
    'status', v_sale.status,
    'fiscalStatus', v_sale.fiscal_status,
    'nfce', CASE WHEN v_sale.fiscal_status IS NULL THEN NULL ELSE jsonb_build_object(
      'environment', v_sale.nfce_environment,
      'number', v_sale.nfce_number,
      'series', v_sale.nfce_series,
      'key', v_sale.nfce_key,
      'protocol', v_sale.nfce_protocol,
      'qrcodeUrl', v_sale.nfce_qrcode_url,
      'consultUrl', v_sale.nfce_consult_url,
      'authorizedAt', v_sale.nfce_authorized_at,
      'taxTotal', v_sale.nfce_tax_total,
      'message', v_sale.nfce_message
    ) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.platform_set_store_focus(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_clear_store_focus(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_list_store_fiscal(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_store_nfce_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_pos_nfce_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_pos_sales(DATE, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_pos_sale_receipt(TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.platform_set_store_focus(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_clear_store_focus(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_list_store_fiscal(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_store_nfce_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pos_nfce_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_pos_sales(DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pos_sale_receipt(TEXT) TO authenticated;

COMMIT;
