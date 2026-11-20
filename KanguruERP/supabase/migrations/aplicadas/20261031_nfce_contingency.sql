-- 2.8b parte 2 (caso 1): NFC-e emitida pela Focus em contingencia offline quando a Sefaz
-- esta fora do ar. A nota sai com "EMITIDA EM CONTINGENCIA" e em duas vias; a Edge Function
-- nfce-contingency-sync acompanha a efetivacao na Sefaz (prazo legal de 24 horas).
-- get_pos_sale_receipt e search_pos_sales: copias da 20261028 com os campos de contingencia
-- (mesma assinatura e retorno JSONB). Nenhuma funcao de venda, caixa ou estorno muda.
BEGIN;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS nfce_contingency BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nfce_contingency_done BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS sales_nfce_contingency_idx ON public.sales (tenant_id, unit_id)
  WHERE nfce_contingency AND NOT nfce_contingency_done;

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
      'message', v_sale.nfce_message,
      'contingency', COALESCE(v_sale.nfce_contingency, false),
      'contingencyDone', COALESCE(v_sale.nfce_contingency_done, false)
    ) END
  );
END;
$$;

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
        'nfceMessage', sale.nfce_message,
        'nfceContingency', COALESCE(sale.nfce_contingency, false) AND NOT COALESCE(sale.nfce_contingency_done, false)
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

COMMIT;
