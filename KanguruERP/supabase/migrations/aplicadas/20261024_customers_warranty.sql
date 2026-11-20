-- Cadastro de clientes (por franqueado) e consulta de garantia no PDV.
-- 1. Tabela customers: codigo automatico, CPF unico por tenant, contato, endereco,
--    consentimento LGPD. RLS para o ERP; o PDV usa so as RPCs (sessao de terminal).
-- 2. Venda e reserva ligam o cliente pelo CPF ja gravado (client_cpf / customer_cpf)
--    com triggers: nenhuma RPC de venda, reserva, caixa ou estorno muda.
-- 3. RPCs do PDV: search_pos_customers, save_pos_customer (cadastra; edita so contato
--    e endereco - CPF e nome so pelo ERP) e find_pos_warranty (serial, IMEI ou CPF).
BEGIN;

-- ---- CPF valido (11 digitos + digitos verificadores) ----
CREATE OR REPLACE FUNCTION public.is_valid_cpf(p_cpf TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_digits TEXT := regexp_replace(COALESCE(p_cpf, ''), '[^0-9]', '', 'g');
  v_sum INTEGER;
  v_check INTEGER;
  i INTEGER;
BEGIN
  IF length(v_digits) <> 11 OR v_digits ~ '^(\d)\1{10}$' THEN
    RETURN false;
  END IF;
  FOR v_len IN 9..10 LOOP
    v_sum := 0;
    FOR i IN 1..v_len LOOP
      v_sum := v_sum + substr(v_digits, i, 1)::INTEGER * (v_len + 2 - i);
    END LOOP;
    v_check := (v_sum * 10) % 11;
    IF v_check = 10 THEN v_check := 0; END IF;
    IF v_check <> substr(v_digits, v_len + 1, 1)::INTEGER THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- ---- 1. Tabela de clientes ----
CREATE TABLE IF NOT EXISTS public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code INTEGER NOT NULL,
  cpf TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  cep TEXT,
  address TEXT,
  address_number TEXT,
  complement TEXT,
  district TEXT,
  city TEXT,
  state TEXT,
  lgpd_consent BOOLEAN NOT NULL,
  lgpd_consent_at TIMESTAMPTZ,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customers_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customers_tenant_cpf_key UNIQUE (tenant_id, cpf),
  CONSTRAINT customers_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT customers_cpf_check CHECK (cpf ~ '^[0-9]{11}$'),
  CONSTRAINT customers_name_not_blank CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  CONSTRAINT customers_phone_not_blank CHECK (NULLIF(BTRIM(phone), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS customers_tenant_name_idx ON public.customers (tenant_id, LOWER(name));

-- Normaliza, valida, gera o codigo e registra a data do consentimento.
CREATE OR REPLACE FUNCTION public.enforce_customer_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'Selecione um tenant para esta operação';
  END IF;
  NEW.cpf := regexp_replace(COALESCE(NEW.cpf, ''), '[^0-9]', '', 'g');
  IF TG_OP = 'INSERT' OR NEW.cpf IS DISTINCT FROM OLD.cpf THEN
    IF NOT public.is_valid_cpf(NEW.cpf) THEN
      RAISE EXCEPTION 'CPF do cliente inválido.' USING ERRCODE = '22023';
    END IF;
  END IF;
  NEW.name := BTRIM(NEW.name);
  NEW.phone := BTRIM(NEW.phone);
  NEW.email := NULLIF(BTRIM(COALESCE(NEW.email, '')), '');
  NEW.cep := NULLIF(regexp_replace(COALESCE(NEW.cep, ''), '[^0-9]', '', 'g'), '');
  NEW.state := NULLIF(UPPER(BTRIM(COALESCE(NEW.state, ''))), '');
  IF NEW.lgpd_consent AND (TG_OP = 'INSERT' OR NOT OLD.lgpd_consent OR NEW.lgpd_consent_at IS NULL) THEN
    NEW.lgpd_consent_at := NOW();
  ELSIF NOT NEW.lgpd_consent THEN
    NEW.lgpd_consent_at := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Codigo sequencial por tenant (1, 2, 3...), um cadastro por vez.
    PERFORM pg_advisory_xact_lock(hashtext('customer_code:' || NEW.tenant_id::TEXT));
    SELECT COALESCE(MAX(customer.code), 0) + 1 INTO NEW.code
    FROM public.customers AS customer WHERE customer.tenant_id = NEW.tenant_id;
  ELSE
    NEW.code := OLD.code;
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_customer_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_current_tenant_trigger ON public.customers;
CREATE TRIGGER enforce_current_tenant_trigger
  BEFORE INSERT OR UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_current_tenant();

-- "zz_": roda depois do trigger de tenant (ordem alfabetica).
DROP TRIGGER IF EXISTS zz_customer_fields_trigger ON public.customers;
CREATE TRIGGER zz_customer_fields_trigger
  BEFORE INSERT OR UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_customer_fields();

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customers_tenant_read ON public.customers;
CREATE POLICY customers_tenant_read ON public.customers
  FOR SELECT USING (public.current_user_can_access_tenant(tenant_id));
DROP POLICY IF EXISTS customers_tenant_insert ON public.customers;
CREATE POLICY customers_tenant_insert ON public.customers
  FOR INSERT WITH CHECK (public.current_user_can_access_tenant(tenant_id));
DROP POLICY IF EXISTS customers_tenant_update ON public.customers;
CREATE POLICY customers_tenant_update ON public.customers
  FOR UPDATE USING (public.current_user_can_access_tenant(tenant_id))
  WITH CHECK (public.current_user_can_access_tenant(tenant_id));

REVOKE ALL ON public.customers FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.customers TO authenticated;

-- ---- 2. Venda e reserva ligadas ao cliente pelo CPF ----
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_id UUID;
ALTER TABLE public.product_reservations ADD COLUMN IF NOT EXISTS customer_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_customer_fk') THEN
    ALTER TABLE public.sales ADD CONSTRAINT sales_customer_fk
      FOREIGN KEY (tenant_id, customer_id) REFERENCES public.customers(tenant_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_reservations_customer_fk') THEN
    ALTER TABLE public.product_reservations ADD CONSTRAINT product_reservations_customer_fk
      FOREIGN KEY (tenant_id, customer_id) REFERENCES public.customers(tenant_id, id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS sales_tenant_client_cpf_idx ON public.sales (tenant_id, client_cpf) WHERE client_cpf IS NOT NULL;

-- Interna: CPF gravado na venda -> cliente cadastrado (nome/CPF da venda ficam congelados).
CREATE OR REPLACE FUNCTION public.link_sale_customer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.client_cpf := NULLIF(regexp_replace(COALESCE(NEW.client_cpf, ''), '[^0-9]', '', 'g'), '');
  IF NEW.customer_id IS NULL AND NEW.client_cpf IS NOT NULL THEN
    SELECT customer.id INTO NEW.customer_id
    FROM public.customers AS customer
    WHERE customer.tenant_id = NEW.tenant_id AND customer.cpf = NEW.client_cpf;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.link_sale_customer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_sale_customer_link ON public.sales;
CREATE TRIGGER zz_sale_customer_link
  BEFORE INSERT OR UPDATE OF client_cpf ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.link_sale_customer();

CREATE OR REPLACE FUNCTION public.link_reservation_customer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.customer_id IS NULL AND NEW.customer_cpf IS NOT NULL THEN
    SELECT customer.id INTO NEW.customer_id
    FROM public.customers AS customer
    WHERE customer.tenant_id = NEW.tenant_id AND customer.cpf = NEW.customer_cpf;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.link_reservation_customer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_reservation_customer_link ON public.product_reservations;
CREATE TRIGGER zz_reservation_customer_link
  BEFORE INSERT OR UPDATE OF customer_cpf ON public.product_reservations
  FOR EACH ROW EXECUTE FUNCTION public.link_reservation_customer();

-- ---- 3. RPCs do PDV (sessao de terminal) ----
-- Busca por CPF, codigo ou nome; so clientes ativos do tenant do terminal.
CREATE OR REPLACE FUNCTION public.search_pos_customers(p_query TEXT)
RETURNS SETOF public.customers
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_query TEXT := BTRIM(COALESCE(p_query, ''));
  v_digits TEXT := regexp_replace(COALESCE(p_query, ''), '[^0-9]', '', 'g');
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;
  IF v_query = '' THEN RETURN; END IF;

  RETURN QUERY
  SELECT customer.*
  FROM public.customers AS customer
  WHERE customer.tenant_id = v_terminal.tenant_id
    AND customer.is_active
    AND (
      (v_digits <> '' AND (customer.cpf LIKE v_digits || '%' OR customer.code::TEXT = v_digits))
      OR customer.name ILIKE '%' || v_query || '%'
    )
  ORDER BY CASE WHEN customer.cpf = v_digits OR customer.code::TEXT = v_digits THEN 0 ELSE 1 END, customer.name
  LIMIT 30;
END;
$$;

REVOKE ALL ON FUNCTION public.search_pos_customers(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_pos_customers(TEXT) TO authenticated;

-- Cadastra (p_customer_id nulo) ou corrige contato/endereco. CPF e nome so mudam no ERP.
CREATE OR REPLACE FUNCTION public.save_pos_customer(
  p_customer_id UUID,
  p_cpf TEXT,
  p_name TEXT,
  p_phone TEXT,
  p_email TEXT,
  p_cep TEXT,
  p_address TEXT,
  p_address_number TEXT,
  p_complement TEXT,
  p_district TEXT,
  p_city TEXT,
  p_state TEXT,
  p_lgpd_consent BOOLEAN,
  p_notes TEXT
)
RETURNS SETOF public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_id UUID;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;
  IF p_lgpd_consent IS NULL THEN RAISE EXCEPTION 'LGPD consent answer is required'; END IF;

  IF p_customer_id IS NULL THEN
    BEGIN
      INSERT INTO public.customers (
        tenant_id, code, cpf, name, phone, email, cep, address, address_number, complement,
        district, city, state, lgpd_consent, notes, created_by_name
      ) VALUES (
        v_terminal.tenant_id, 0, p_cpf, p_name, p_phone, p_email, p_cep, p_address, p_address_number,
        NULLIF(BTRIM(COALESCE(p_complement, '')), ''), NULLIF(BTRIM(COALESCE(p_district, '')), ''),
        NULLIF(BTRIM(COALESCE(p_city, '')), ''), p_state, p_lgpd_consent,
        NULLIF(BTRIM(COALESCE(p_notes, '')), ''), v_terminal.display_name
      )
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Customer CPF already registered';
    END;
  ELSE
    UPDATE public.customers
    SET phone = p_phone, email = p_email, cep = p_cep, address = p_address,
        address_number = p_address_number,
        complement = NULLIF(BTRIM(COALESCE(p_complement, '')), ''),
        district = NULLIF(BTRIM(COALESCE(p_district, '')), ''),
        city = NULLIF(BTRIM(COALESCE(p_city, '')), ''), state = p_state,
        lgpd_consent = p_lgpd_consent, notes = NULLIF(BTRIM(COALESCE(p_notes, '')), '')
    WHERE id = p_customer_id AND tenant_id = v_terminal.tenant_id
    RETURNING id INTO v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  END IF;

  RETURN QUERY SELECT * FROM public.customers WHERE id = v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_pos_customer(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_pos_customer(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;

-- Garantia: vendas do tenant (qualquer loja) pelo serial/IMEI vendido ou pelo CPF.
-- Uma linha por unidade com serial; sem serial, uma linha por item. Servicos ficam fora.
CREATE OR REPLACE FUNCTION public.find_pos_warranty(p_query TEXT)
RETURNS TABLE (
  sale_id TEXT,
  sale_date TIMESTAMPTZ,
  invoice_number TEXT,
  store_name TEXT,
  seller_name TEXT,
  customer_name TEXT,
  customer_cpf TEXT,
  item_name TEXT,
  item_sku TEXT,
  quantity INTEGER,
  serial_number TEXT,
  warranty_months INTEGER,
  sale_status TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_lower TEXT := LOWER(BTRIM(COALESCE(p_query, '')));
  v_digits TEXT := regexp_replace(COALESCE(p_query, ''), '[^0-9]', '', 'g');
  v_is_cpf BOOLEAN;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;
  IF v_lower = '' THEN RETURN; END IF;
  v_is_cpf := length(v_digits) = 11 AND public.is_valid_cpf(v_digits);

  RETURN QUERY
  WITH matched AS (
    SELECT sale.*
    FROM public.sales AS sale
    WHERE sale.tenant_id = v_terminal.tenant_id
      AND (
        (v_is_cpf AND sale.client_cpf = v_digits)
        OR sale.id IN (
          SELECT unit.sale_id FROM public.product_serial_units AS unit
          WHERE unit.tenant_id = v_terminal.tenant_id AND unit.sale_id IS NOT NULL
            AND (LOWER(unit.serial_number) = v_lower OR LOWER(unit.imei) = v_lower)
        )
      )
  ),
  lines AS (
    SELECT matched.id AS line_sale_id, matched."timestamp" AS line_date, matched.invoice_number AS line_invoice,
      matched.unit_id AS line_unit, COALESCE(matched.seller_name, matched.operator_name) AS line_seller,
      matched.client_name AS line_customer, matched.client_cpf AS line_cpf, matched.status AS line_status,
      entry.value AS line_item
    FROM matched
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(matched.items, '[]'::JSONB)) AS entry(value)
    WHERE UPPER(COALESCE(entry.value->>'itemType', 'PRODUCT')) = 'PRODUCT'
  ),
  expanded AS (
    SELECT lines.*, serial.value AS line_serial
    FROM lines
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(lines.line_item->'serials') = 'array' AND jsonb_array_length(lines.line_item->'serials') > 0
        THEN lines.line_item->'serials' ELSE '[null]'::JSONB END
    ) AS serial(value)
  )
  SELECT expanded.line_sale_id, expanded.line_date, expanded.line_invoice,
    COALESCE(NULLIF(BTRIM(store.trade_name), ''), expanded.line_unit),
    expanded.line_seller, expanded.line_customer, expanded.line_cpf,
    expanded.line_item->>'itemName', expanded.line_item->>'itemSku',
    CASE WHEN expanded.line_serial IS NULL THEN COALESCE(NULLIF(expanded.line_item->>'quantity', '')::INTEGER, 1) ELSE 1 END,
    expanded.line_serial,
    COALESCE(unit.warranty_months, product.warranty_months, 0),
    expanded.line_status
  FROM expanded
  LEFT JOIN public.store_configs AS store
    ON store.tenant_id = v_terminal.tenant_id AND store.unit_id = expanded.line_unit
  LEFT JOIN public.products AS product
    ON product.tenant_id = v_terminal.tenant_id AND product.id = expanded.line_item->>'productId'
  LEFT JOIN public.product_serial_units AS unit
    ON unit.tenant_id = v_terminal.tenant_id AND expanded.line_serial IS NOT NULL
    AND LOWER(unit.serial_number) = LOWER(expanded.line_serial)
  -- Busca por serial/IMEI: so a unidade procurada (a venda pode ter outros itens).
  WHERE v_is_cpf OR LOWER(expanded.line_serial) = v_lower OR LOWER(unit.imei) = v_lower
  ORDER BY expanded.line_date DESC
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.find_pos_warranty(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_pos_warranty(TEXT) TO authenticated;

COMMIT;
