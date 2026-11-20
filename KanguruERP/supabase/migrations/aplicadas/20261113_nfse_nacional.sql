-- =========================================================================
-- NFS-e Nacional para os servicos (desenho aprovado em 2026-11-01).
-- No Rio a NFS-e no padrao nacional e obrigatoria desde 01/01/2026 (Simples incluso).
-- Servicos continuam fora da NFC-e; com "Nota fiscal" no PDV, os servicos da venda saem
-- em NFS-e pela Focus (mesma chave da loja). A NFS-e nacional aceita 1 codigo de servico e
-- 1 NBS por nota: a venda gera uma NFS-e por grupo (codigo nacional + NBS + codigo municipal).
-- A nota sai no pagamento (na OS: na abertura se pago antes, na entrega se pago no final) e
-- o DANFSe e impresso automaticamente.
-- Aditiva: colunas novas (servicos, loja, configuracao fiscal), 2 tabelas novas e RPCs novas.
-- Nenhuma RPC de venda, caixa ou estorno mudou.
-- =========================================================================

-- Dados fiscais do servico (lista nacional da LC 116 e NBS).
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS nfse_service_code TEXT,  -- codigo de tributacao nacional (6 digitos, ex.: 140201)
  ADD COLUMN IF NOT EXISTS nfse_nbs_code TEXT,      -- NBS (9 digitos, ex.: 120013000)
  ADD COLUMN IF NOT EXISTS nfse_municipal_code TEXT, -- codigo de tributacao municipal (ate 3), quando a prefeitura exigir
  ADD COLUMN IF NOT EXISTS nfse_description TEXT;   -- texto da nota (vazio = nome do servico)

ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_nfse_codes_check;
ALTER TABLE public.services ADD CONSTRAINT services_nfse_codes_check CHECK (
  (nfse_service_code IS NULL OR nfse_service_code ~ '^\d{6}$')
  AND (nfse_nbs_code IS NULL OR nfse_nbs_code ~ '^\d{9}$')
  AND (nfse_municipal_code IS NULL OR nfse_municipal_code ~ '^[0-9A-Za-z]{1,3}$')
);

-- Dados da loja para a NFS-e (o franqueado preenche no ERP).
ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS municipal_registration TEXT,      -- inscricao municipal
  ADD COLUMN IF NOT EXISTS city_ibge_code TEXT,              -- municipio da loja (IBGE, 7 digitos; Rio = 3304557)
  ADD COLUMN IF NOT EXISTS simples_nacional_option TEXT NOT NULL DEFAULT '3'; -- 1 nao optante, 2 MEI, 3 ME/EPP

ALTER TABLE public.store_configs DROP CONSTRAINT IF EXISTS store_configs_nfse_check;
ALTER TABLE public.store_configs ADD CONSTRAINT store_configs_nfse_check CHECK (
  (city_ibge_code IS NULL OR city_ibge_code ~ '^\d{7}$')
  AND simples_nacional_option IN ('1', '2', '3')
);

-- Numeracao da DPS (declaracao enviada a cada NFS-e), por loja. So o servidor usa.
ALTER TABLE public.store_fiscal_settings
  ADD COLUMN IF NOT EXISTS nfse_dps_series INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS nfse_next_dps_number BIGINT NOT NULL DEFAULT 1;

-- Uma linha por NFS-e da venda.
CREATE TABLE IF NOT EXISTS public.sale_service_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  group_key TEXT NOT NULL,            -- codigo nacional | NBS | codigo municipal
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'AUTORIZADA', 'ERRO', 'CANCELADA')),
  ref TEXT,                           -- referencia da ultima tentativa na Focus
  environment TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  dps_series INTEGER,
  dps_number BIGINT,
  service_code TEXT NOT NULL,
  nbs_code TEXT,
  municipal_code TEXT,
  description TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  number TEXT,                        -- numero da NFS-e
  verification_code TEXT,
  consult_url TEXT,                   -- consulta publica (QR code)
  danfse_url TEXT,                    -- PDF do DANFSe
  xml_url TEXT,
  message TEXT,
  authorized_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sale_service_invoices_group_key UNIQUE (tenant_id, sale_id, group_key),
  CONSTRAINT sale_service_invoices_sale_fk
    FOREIGN KEY (tenant_id, sale_id) REFERENCES public.sales(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sale_service_invoices_sale_idx ON public.sale_service_invoices (tenant_id, sale_id);
CREATE UNIQUE INDEX IF NOT EXISTS sale_service_invoices_ref_idx ON public.sale_service_invoices (ref) WHERE ref IS NOT NULL;

ALTER TABLE public.sale_service_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sale_service_invoices_read ON public.sale_service_invoices;
CREATE POLICY sale_service_invoices_read ON public.sale_service_invoices FOR SELECT
  USING (public.current_user_can_access_tenant(tenant_id) AND public.current_user_has_store_access(tenant_id, unit_id));
REVOKE INSERT, UPDATE, DELETE ON public.sale_service_invoices FROM PUBLIC, anon, authenticated;

-- Historico de envios/consultas/cancelamentos (auditoria; so o servidor le).
CREATE TABLE IF NOT EXISTS public.sale_service_invoice_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  invoice_id UUID,
  action TEXT NOT NULL CHECK (action IN ('EMITIR', 'CONSULTAR', 'CANCELAR')),
  ref TEXT,
  environment TEXT,
  http_status INTEGER,
  result_status TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.sale_service_invoice_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sale_service_invoice_events FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS sale_service_invoice_events_sale_idx ON public.sale_service_invoice_events (tenant_id, sale_id, created_at);

-- Proximo numero de DPS da loja (atomico). So a chave de servico (Edge Function).
CREATE OR REPLACE FUNCTION public.next_nfse_dps_number(p_tenant_id UUID, p_unit_id TEXT)
RETURNS TABLE (series INTEGER, number BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.store_fiscal_settings
  SET nfse_next_dps_number = nfse_next_dps_number + 1
  WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id
  RETURNING nfse_dps_series, nfse_next_dps_number - 1;
$$;

REVOKE ALL ON FUNCTION public.next_nfse_dps_number(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_nfse_dps_number(UUID, TEXT) TO service_role;

-- PDV: a loja pode emitir NFS-e? (Focus configurada + CNPJ + municipio).
CREATE OR REPLACE FUNCTION public.get_pos_nfse_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_store public.store_configs%ROWTYPE;
  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_environment TEXT;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT environment INTO v_environment FROM public.store_fiscal_settings
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  IF v_environment IS NULL THEN
    v_missing := v_missing || 'chave da Focus (UCP)';
  END IF;
  SELECT * INTO v_store FROM public.store_configs WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  IF length(regexp_replace(COALESCE(v_store.cnpj, ''), '\D', '', 'g')) <> 14 THEN
    v_missing := v_missing || 'CNPJ da loja';
  END IF;
  IF v_store.city_ibge_code IS NULL THEN
    v_missing := v_missing || 'município da loja (IBGE)';
  END IF;
  RETURN jsonb_build_object('ready', array_length(v_missing, 1) IS NULL, 'environment', v_environment, 'missing', to_jsonb(v_missing));
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_nfse_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_nfse_status() TO authenticated;

-- PDV: NFS-e das vendas da loja (Cupons e notas) e quais vendas tem produto/servico.
CREATE OR REPLACE FUNCTION public.get_pos_sale_service_invoices(p_sale_ids TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  RETURN jsonb_build_object(
    'sales', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'saleId', sale.id,
        'hasProducts', EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS entry
          WHERE UPPER(COALESCE(entry->>'itemType', 'PRODUCT')) = 'PRODUCT'),
        'hasServices', EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS entry
          WHERE UPPER(COALESCE(entry->>'itemType', '')) = 'SERVICE')
      ))
      FROM public.sales AS sale
      WHERE sale.tenant_id = v_terminal.tenant_id AND sale.unit_id = v_terminal.unit_id
        AND sale.id = ANY (COALESCE(p_sale_ids, ARRAY[]::TEXT[]))
    ), '[]'::JSONB),
    'invoices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', invoice.id, 'saleId', invoice.sale_id, 'status', invoice.status, 'number', invoice.number,
        'verificationCode', invoice.verification_code, 'consultUrl', invoice.consult_url, 'danfseUrl', invoice.danfse_url,
        'amount', invoice.amount, 'description', invoice.description, 'message', invoice.message,
        'environment', invoice.environment, 'authorizedAt', invoice.authorized_at
      ) ORDER BY invoice.created_at)
      FROM public.sale_service_invoices AS invoice
      WHERE invoice.tenant_id = v_terminal.tenant_id AND invoice.unit_id = v_terminal.unit_id
        AND invoice.sale_id = ANY (COALESCE(p_sale_ids, ARRAY[]::TEXT[]))
    ), '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_sale_service_invoices(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_sale_service_invoices(TEXT[]) TO authenticated;
