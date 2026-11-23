-- =========================================================================
-- Contas a Receber (desenho aprovado em 2026-11-23). Sem fiado no PDV: a conta é lançada no ERP
-- (ex.: cobrar outro franqueado ou pessoa). Três tipos:
--   MERCADORIA  "Mercadoria repassada": os itens SAEM do estoque na hora (com seriais) e o custo fica
--               guardado. No DRE entra só a diferença entre o valor recebido e o custo (a preço de custo = 0).
--   ACERTO      "Empréstimo / acerto entre lojas": não mexe no estoque e não entra no lucro (só caixa).
--   OUTROS      "Serviço / outros": entra no DRE como "Outras receitas" na data do recebimento.
-- Nenhum entra no faturamento de vendas nem no repasse da franquia.
-- Parcelas com vencimento e baixa próprios (aceita receber em parte), cobrança pelo WhatsApp
-- (contador de cobranças), anexo (bucket privado receivable-attachments), chave Pix da loja
-- (store_configs.pix_key) para a mensagem. Sem juros/multa.
--
-- Aditiva: tabelas, funções, bucket e gatilhos de registro novos + 1 coluna em store_configs.
-- Nenhuma função existente muda.
-- =========================================================================

ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS pix_key TEXT;

-- ---- 1. Tabelas ----
CREATE TABLE IF NOT EXISTS public.receivable_titles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  title_number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('MERCADORIA', 'ACERTO', 'OUTROS')),
  category TEXT NOT NULL,
  debtor_name TEXT NOT NULL,
  debtor_document TEXT,
  debtor_phone TEXT,
  debtor_email TEXT,
  customer_id UUID,
  description TEXT NOT NULL,
  document_number TEXT,
  notes TEXT,
  items JSONB NOT NULL DEFAULT '[]'::JSONB,
  total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount > 0),
  total_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  issue_date DATE NOT NULL,
  attachment_path TEXT,
  attachment_name TEXT,
  status TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO', 'CANCELADO')),
  cancelled_at TIMESTAMPTZ,
  charge_count INTEGER NOT NULL DEFAULT 0,
  last_charge_at TIMESTAMPTZ,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT receivable_titles_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT,
  CONSTRAINT receivable_titles_number_key UNIQUE (tenant_id, title_number)
);

CREATE TABLE IF NOT EXISTS public.receivable_installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  title_id UUID NOT NULL REFERENCES public.receivable_titles(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number >= 0),
  due_date DATE NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  received_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (received_amount >= 0),
  status TEXT NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO', 'PARCIAL', 'RECEBIDO', 'CANCELADO')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT receivable_installments_number_key UNIQUE (title_id, number)
);

CREATE TABLE IF NOT EXISTS public.receivable_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  title_id UUID NOT NULL REFERENCES public.receivable_titles(id) ON DELETE CASCADE,
  installment_id UUID NOT NULL REFERENCES public.receivable_installments(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  -- Parte que entra no DRE como "Outras receitas" (MERCADORIA: valor menos o custo proporcional;
  -- ACERTO: 0; OUTROS: o valor). Calculada pelo banco no recebimento.
  revenue_amount NUMERIC(12, 2) NOT NULL,
  paid_at DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('PIX', 'DINHEIRO', 'TRANSFERENCIA', 'CARTAO', 'BOLETO', 'OUTRO')),
  received_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS receivable_titles_tenant_idx ON public.receivable_titles (tenant_id, unit_id, status);
CREATE INDEX IF NOT EXISTS receivable_installments_due_idx ON public.receivable_installments (tenant_id, unit_id, due_date);
CREATE INDEX IF NOT EXISTS receivable_payments_paid_idx ON public.receivable_payments (tenant_id, unit_id, paid_at);

ALTER TABLE public.receivable_titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receivable_titles_read ON public.receivable_titles;
CREATE POLICY receivable_titles_read ON public.receivable_titles FOR SELECT TO authenticated
  USING (public.current_user_has_store_access(tenant_id, unit_id));
DROP POLICY IF EXISTS receivable_installments_read ON public.receivable_installments;
CREATE POLICY receivable_installments_read ON public.receivable_installments FOR SELECT TO authenticated
  USING (public.current_user_has_store_access(tenant_id, unit_id));
DROP POLICY IF EXISTS receivable_payments_read ON public.receivable_payments;
CREATE POLICY receivable_payments_read ON public.receivable_payments FOR SELECT TO authenticated
  USING (public.current_user_has_store_access(tenant_id, unit_id));

REVOKE ALL ON public.receivable_titles FROM PUBLIC, anon;
REVOKE ALL ON public.receivable_installments FROM PUBLIC, anon;
REVOKE ALL ON public.receivable_payments FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.receivable_titles FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.receivable_installments FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.receivable_payments FROM authenticated;
GRANT SELECT ON public.receivable_titles TO authenticated;
GRANT SELECT ON public.receivable_installments TO authenticated;
GRANT SELECT ON public.receivable_payments TO authenticated;

-- ---- 2. Funções internas (sem GRANT) ----

-- Lê e trava a conta da empresa do usuário (com acesso à loja da conta).
CREATE OR REPLACE FUNCTION public.receivable_lock_title(p_id UUID)
RETURNS public.receivable_titles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_title public.receivable_titles;
BEGIN
  SELECT * INTO v_title FROM public.receivable_titles
  WHERE id = p_id AND tenant_id = v_tenant_id
  FOR UPDATE;
  IF NOT FOUND OR NOT public.current_user_has_store_access(v_title.tenant_id, v_title.unit_id) THEN
    RAISE EXCEPTION 'Conta a receber não encontrada';
  END IF;
  RETURN v_title;
END;
$$;

-- Recalcula o recebido e a situação da parcela a partir dos recebimentos.
CREATE OR REPLACE FUNCTION public.receivable_refresh_installment(p_installment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_received NUMERIC;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_received FROM public.receivable_payments WHERE installment_id = p_installment_id;
  UPDATE public.receivable_installments
  SET received_amount = v_received,
      status = CASE
        WHEN status = 'CANCELADO' THEN 'CANCELADO'
        WHEN v_received >= amount THEN 'RECEBIDO'
        WHEN v_received > 0 THEN 'PARCIAL'
        ELSE 'ABERTO'
      END
  WHERE id = p_installment_id;
END;
$$;

-- Parte de um recebimento que entra no DRE como "Outras receitas".
CREATE OR REPLACE FUNCTION public.receivable_revenue_share(p_title public.receivable_titles, p_amount NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_title.kind
    WHEN 'ACERTO' THEN 0
    WHEN 'OUTROS' THEN p_amount
    ELSE ROUND(p_amount * (1 - p_title.total_cost / NULLIF(p_title.total_amount, 0)), 2)
  END;
$$;

REVOKE ALL ON FUNCTION public.receivable_lock_title(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receivable_refresh_installment(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receivable_revenue_share(public.receivable_titles, NUMERIC) FROM PUBLIC, anon, authenticated;

-- ---- 3. RPCs do ERP ----

-- Cria a conta (p_id nulo) ou altera só os dados descritivos (devedor, descrição, documento,
-- observação, categoria). Valor, itens e parcelas não mudam depois de criada: cancele e lance de novo.
-- p_data (criação):
--   { unitId, kind, category, debtorName, debtorDocument, debtorPhone, debtorEmail, customerId,
--     description, documentNumber, notes, issueDate, totalAmount,
--     items: MERCADORIA [{productId, quantity, serials:[...], unitPrice}] | outros [{description, quantity, unitPrice, serial}],
--     installments: [{dueDate, amount, downPayment?}],
--     downPaymentReceived: { method, paidAt } (opcional: a entrada já foi recebida) }
CREATE OR REPLACE FUNCTION public.save_receivable(p_id UUID, p_data JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_title public.receivable_titles;
  v_unit TEXT := NULLIF(BTRIM(COALESCE(p_data->>'unitId', '')), '');
  v_actor TEXT;
  v_kind TEXT := UPPER(COALESCE(p_data->>'kind', ''));
  v_category TEXT := NULLIF(BTRIM(COALESCE(p_data->>'category', '')), '');
  v_name TEXT := NULLIF(BTRIM(COALESCE(p_data->>'debtorName', '')), '');
  v_document TEXT := NULLIF(regexp_replace(COALESCE(p_data->>'debtorDocument', ''), '\D', '', 'g'), '');
  v_phone TEXT := NULLIF(regexp_replace(COALESCE(p_data->>'debtorPhone', ''), '\D', '', 'g'), '');
  v_email TEXT := NULLIF(BTRIM(COALESCE(p_data->>'debtorEmail', '')), '');
  v_customer UUID := NULLIF(p_data->>'customerId', '')::UUID;
  v_description TEXT := NULLIF(BTRIM(COALESCE(p_data->>'description', '')), '');
  v_document_number TEXT := NULLIF(BTRIM(COALESCE(p_data->>'documentNumber', '')), '');
  v_notes TEXT := NULLIF(BTRIM(COALESCE(p_data->>'notes', '')), '');
  v_issue DATE := COALESCE(NULLIF(p_data->>'issueDate', '')::DATE, public.payable_today());
  v_total NUMERIC := NULLIF(p_data->>'totalAmount', '')::NUMERIC;
  v_items JSONB := '[]'::JSONB;
  v_item JSONB;
  v_product public.products%ROWTYPE;
  v_qty INTEGER;
  v_qty_before INTEGER;
  v_quantities JSONB;
  v_serials TEXT[];
  v_found INTEGER;
  v_avg NUMERIC;
  v_cost NUMERIC;
  v_total_cost NUMERIC := 0;
  v_inst JSONB;
  v_sum NUMERIC := 0;
  v_count INTEGER;
  v_number INTEGER;
  v_inst_number INTEGER := 0;
  v_inst_id UUID;
  v_down_installment UUID;
  v_down JSONB := p_data->'downPaymentReceived';
  v_method TEXT;
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'Sessão do ERP necessária'; END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Informe o nome de quem deve'; END IF;
  IF v_document IS NOT NULL AND length(v_document) NOT IN (11, 14) THEN
    RAISE EXCEPTION 'CPF (11 números) ou CNPJ (14 números) inválido';
  END IF;
  IF v_phone IS NOT NULL AND length(v_phone) NOT BETWEEN 10 AND 13 THEN
    RAISE EXCEPTION 'WhatsApp inválido: informe com DDD';
  END IF;

  -- Alteração: só dados descritivos.
  IF p_id IS NOT NULL THEN
    v_title := public.receivable_lock_title(p_id);
    v_actor := public.payable_actor(v_title.unit_id);
    UPDATE public.receivable_titles SET
      category = COALESCE(v_category, category),
      debtor_name = v_name, debtor_document = v_document, debtor_phone = v_phone, debtor_email = v_email,
      customer_id = v_customer,
      description = COALESCE(v_description, description),
      document_number = v_document_number, notes = v_notes, updated_at = NOW()
    WHERE id = p_id;
    RETURN p_id;
  END IF;

  v_actor := public.payable_actor(v_unit);
  IF v_kind NOT IN ('MERCADORIA', 'ACERTO', 'OUTROS') THEN RAISE EXCEPTION 'Tipo de conta inválido'; END IF;
  IF v_total IS NULL OR v_total <= 0 OR v_total <> ROUND(v_total, 2) THEN
    RAISE EXCEPTION 'Valor total inválido';
  END IF;
  IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_customer AND tenant_id = v_tenant_id) THEN
    v_customer := NULL;
  END IF;

  -- Parcelas: soma tem que dar o total.
  IF jsonb_typeof(p_data->'installments') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Informe as parcelas'; END IF;
  v_count := jsonb_array_length(p_data->'installments');
  IF v_count < 1 OR v_count > 49 THEN RAISE EXCEPTION 'Entre 1 e 48 parcelas (mais a entrada)'; END IF;
  FOR v_inst IN SELECT value FROM jsonb_array_elements(p_data->'installments') LOOP
    IF NULLIF(v_inst->>'dueDate', '') IS NULL THEN RAISE EXCEPTION 'Parcela sem vencimento'; END IF;
    IF NULLIF(v_inst->>'amount', '')::NUMERIC IS NULL OR (v_inst->>'amount')::NUMERIC <= 0
       OR (v_inst->>'amount')::NUMERIC <> ROUND((v_inst->>'amount')::NUMERIC, 2) THEN
      RAISE EXCEPTION 'Valor de parcela inválido';
    END IF;
    v_sum := v_sum + (v_inst->>'amount')::NUMERIC;
  END LOOP;
  IF v_sum <> v_total THEN RAISE EXCEPTION 'A soma das parcelas (R$ %) precisa ser igual ao total (R$ %)', v_sum, v_total; END IF;

  -- Itens.
  IF jsonb_typeof(COALESCE(p_data->'items', '[]'::JSONB)) <> 'array' THEN RAISE EXCEPTION 'Itens inválidos'; END IF;
  IF v_kind = 'MERCADORIA' THEN
    IF jsonb_array_length(COALESCE(p_data->'items', '[]'::JSONB)) = 0 THEN
      RAISE EXCEPTION 'Mercadoria repassada: escolha os produtos do estoque';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_data->'items') LOOP
      SELECT * INTO v_product FROM public.products
      WHERE tenant_id = v_tenant_id AND id = v_item->>'productId' AND archived_at IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'Produto não encontrado'; END IF;
      IF COALESCE(v_product.is_serialized, false) THEN
        SELECT ARRAY(SELECT DISTINCT UPPER(BTRIM(value)) FROM jsonb_array_elements_text(COALESCE(v_item->'serials', '[]'::JSONB))
                     WHERE NULLIF(BTRIM(value), '') IS NOT NULL) INTO v_serials;
        v_qty := COALESCE(array_length(v_serials, 1), 0);
        IF v_qty = 0 THEN RAISE EXCEPTION '%: escolha os seriais', v_product.name; END IF;
        SELECT COUNT(*), COALESCE(SUM(COALESCE(unit.unit_cost, public.get_store_avg_cost(v_tenant_id, v_product.id, v_unit))), 0)
        INTO v_found, v_cost
        FROM public.product_serial_units AS unit
        WHERE unit.tenant_id = v_tenant_id AND unit.product_id = v_product.id AND unit.unit_id = v_unit
          AND unit.status = 'DISPONIVEL' AND UPPER(unit.serial_number) = ANY(v_serials);
        IF v_found <> v_qty THEN RAISE EXCEPTION '%: algum serial não está disponível nesta loja', v_product.name; END IF;
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'productId', v_product.id, 'sku', v_product.sku, 'name', v_product.name, 'quantity', v_qty,
          'serials', to_jsonb(v_serials), 'unitCost', ROUND(v_cost / v_qty, 4), 'costTotal', ROUND(v_cost, 2),
          'unitPrice', NULLIF(v_item->>'unitPrice', '')::NUMERIC
        ));
      ELSE
        v_qty := NULLIF(v_item->>'quantity', '')::INTEGER;
        IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION '%: quantidade inválida', v_product.name; END IF;
        SELECT quantities INTO v_quantities FROM public.inventory
        WHERE tenant_id = v_tenant_id AND product_id = v_product.id;
        IF COALESCE((v_quantities -> v_unit ->> 'qty')::INTEGER, 0) < v_qty THEN
          RAISE EXCEPTION '%: estoque insuficiente nesta loja', v_product.name;
        END IF;
        v_avg := public.get_store_avg_cost(v_tenant_id, v_product.id, v_unit);
        v_cost := ROUND(v_avg * v_qty, 2);
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'productId', v_product.id, 'sku', v_product.sku, 'name', v_product.name, 'quantity', v_qty,
          'serials', '[]'::JSONB, 'unitCost', ROUND(v_avg, 4), 'costTotal', v_cost,
          'unitPrice', NULLIF(v_item->>'unitPrice', '')::NUMERIC
        ));
      END IF;
      v_total_cost := v_total_cost + v_cost;
    END LOOP;
    v_description := COALESCE(v_description, (SELECT string_agg((value->>'quantity') || 'x ' || (value->>'name'), ', ') FROM jsonb_array_elements(v_items)));
  ELSE
    FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'items', '[]'::JSONB)) LOOP
      CONTINUE WHEN NULLIF(BTRIM(COALESCE(v_item->>'description', '')), '') IS NULL;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'description', LEFT(BTRIM(v_item->>'description'), 200),
        'quantity', GREATEST(COALESCE(NULLIF(v_item->>'quantity', '')::INTEGER, 1), 1),
        'unitPrice', COALESCE(NULLIF(v_item->>'unitPrice', '')::NUMERIC, 0),
        'serial', NULLIF(BTRIM(COALESCE(v_item->>'serial', '')), '')
      ));
    END LOOP;
  END IF;
  IF v_description IS NULL THEN RAISE EXCEPTION 'Informe a descrição'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('receivable_number:' || v_tenant_id::TEXT));
  SELECT COALESCE(MAX(title_number), 0) + 1 INTO v_number FROM public.receivable_titles WHERE tenant_id = v_tenant_id;

  INSERT INTO public.receivable_titles (
    tenant_id, unit_id, title_number, kind, category, debtor_name, debtor_document, debtor_phone, debtor_email,
    customer_id, description, document_number, notes, items, total_amount, total_cost, issue_date, created_by_name
  ) VALUES (
    v_tenant_id, v_unit, v_number, v_kind,
    COALESCE(v_category, CASE v_kind WHEN 'MERCADORIA' THEN 'Mercadoria repassada' WHEN 'ACERTO' THEN 'Empréstimo / acerto' ELSE 'Outros' END),
    v_name, v_document, v_phone, v_email, v_customer, LEFT(v_description, 300), v_document_number, v_notes,
    v_items, v_total, ROUND(v_total_cost, 2), v_issue, v_actor
  ) RETURNING * INTO v_title;

  -- Mercadoria: tira do estoque agora (sem venda; o custo fica guardado na conta).
  IF v_kind = 'MERCADORIA' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
      v_qty := (v_item->>'quantity')::INTEGER;
      IF jsonb_array_length(v_item->'serials') > 0 THEN
        UPDATE public.product_serial_units SET status = 'VENDIDO'
        WHERE tenant_id = v_tenant_id AND product_id = v_item->>'productId' AND unit_id = v_unit
          AND status = 'DISPONIVEL'
          AND UPPER(serial_number) IN (SELECT value FROM jsonb_array_elements_text(v_item->'serials'));
        GET DIAGNOSTICS v_found = ROW_COUNT;
        IF v_found <> v_qty THEN RAISE EXCEPTION 'Um serial mudou enquanto a conta era salva: tente de novo'; END IF;
        PERFORM public.sync_serialized_inventory_quantity(v_tenant_id, v_item->>'productId', v_unit);
      ELSE
        SELECT quantities INTO v_quantities FROM public.inventory
        WHERE tenant_id = v_tenant_id AND product_id = v_item->>'productId' FOR UPDATE;
        v_quantities := public.inventory_with_unit(COALESCE(v_quantities, '{}'::JSONB), v_unit);
        v_qty_before := COALESCE((v_quantities -> v_unit ->> 'qty')::INTEGER, 0);
        IF v_qty_before < v_qty THEN RAISE EXCEPTION '%: estoque insuficiente nesta loja', v_item->>'name'; END IF;
        UPDATE public.inventory
        SET quantities = jsonb_set(v_quantities, ARRAY[v_unit, 'qty'], to_jsonb(v_qty_before - v_qty), true), updated_at = NOW()
        WHERE tenant_id = v_tenant_id AND product_id = v_item->>'productId';
      END IF;
      INSERT INTO public.movements (
        id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
        serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
      ) VALUES (
        gen_random_uuid()::TEXT, v_tenant_id, v_item->>'productId', NULL, v_unit, 'CONTA_RECEBER', 'SAIDA', v_qty,
        CASE WHEN jsonb_array_length(v_item->'serials') > 0 THEN v_item->'serials' ELSE NULL END, NULL,
        auth.uid()::TEXT, v_actor, NOW(),
        'Mercadoria repassada a ' || v_name || ' (conta a receber nº ' || v_number || ')', (v_item->>'unitCost')::NUMERIC
      );
    END LOOP;
  END IF;

  -- Parcelas (a entrada, se houver, é a nº 0).
  FOR v_inst IN SELECT value FROM jsonb_array_elements(p_data->'installments') LOOP
    IF COALESCE((v_inst->>'downPayment')::BOOLEAN, false) THEN
      INSERT INTO public.receivable_installments (tenant_id, unit_id, title_id, number, due_date, amount)
      VALUES (v_tenant_id, v_unit, v_title.id, 0, (v_inst->>'dueDate')::DATE, (v_inst->>'amount')::NUMERIC)
      RETURNING id INTO v_down_installment;
    ELSE
      v_inst_number := v_inst_number + 1;
      INSERT INTO public.receivable_installments (tenant_id, unit_id, title_id, number, due_date, amount)
      VALUES (v_tenant_id, v_unit, v_title.id, v_inst_number, (v_inst->>'dueDate')::DATE, (v_inst->>'amount')::NUMERIC);
    END IF;
  END LOOP;

  -- Entrada já recebida na hora.
  IF v_down IS NOT NULL AND jsonb_typeof(v_down) = 'object' AND v_down_installment IS NOT NULL THEN
    v_method := UPPER(COALESCE(v_down->>'method', 'PIX'));
    IF v_method NOT IN ('PIX', 'DINHEIRO', 'TRANSFERENCIA', 'CARTAO', 'BOLETO', 'OUTRO') THEN v_method := 'OUTRO'; END IF;
    INSERT INTO public.receivable_payments (tenant_id, unit_id, title_id, installment_id, amount, revenue_amount, paid_at, method, received_by_name)
    SELECT v_tenant_id, v_unit, v_title.id, v_down_installment, installment.amount,
      public.receivable_revenue_share(v_title, installment.amount),
      COALESCE(NULLIF(v_down->>'paidAt', '')::DATE, v_issue), v_method, v_actor
    FROM public.receivable_installments AS installment WHERE installment.id = v_down_installment;
    PERFORM public.receivable_refresh_installment(v_down_installment);
  END IF;

  RETURN v_title.id;
END;
$$;

-- Recebe uma parcela (inteira ou em parte).
CREATE OR REPLACE FUNCTION public.receive_receivable(p_installment_id UUID, p_amount NUMERIC, p_paid_at DATE, p_method TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_installment public.receivable_installments;
  v_title public.receivable_titles;
  v_actor TEXT;
  v_method TEXT := UPPER(COALESCE(p_method, ''));
BEGIN
  SELECT * INTO v_installment FROM public.receivable_installments
  WHERE id = p_installment_id AND tenant_id = public.current_user_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parcela não encontrada'; END IF;
  v_title := public.receivable_lock_title(v_installment.title_id);
  v_actor := public.payable_actor(v_title.unit_id);
  IF v_title.status <> 'ATIVO' OR v_installment.status IN ('RECEBIDO', 'CANCELADO') THEN
    RAISE EXCEPTION 'Esta parcela não está em aberto';
  END IF;
  IF v_method NOT IN ('PIX', 'DINHEIRO', 'TRANSFERENCIA', 'CARTAO', 'BOLETO', 'OUTRO') THEN
    RAISE EXCEPTION 'Forma de recebimento inválida';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> ROUND(p_amount, 2) THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  IF p_amount > v_installment.amount - v_installment.received_amount THEN
    RAISE EXCEPTION 'O valor passa do que falta receber nesta parcela (R$ %)', v_installment.amount - v_installment.received_amount;
  END IF;
  IF p_paid_at IS NULL OR p_paid_at > public.payable_today() THEN RAISE EXCEPTION 'Data de recebimento inválida'; END IF;

  INSERT INTO public.receivable_payments (tenant_id, unit_id, title_id, installment_id, amount, revenue_amount, paid_at, method, received_by_name)
  VALUES (v_title.tenant_id, v_title.unit_id, v_title.id, v_installment.id, p_amount,
    public.receivable_revenue_share(v_title, p_amount), p_paid_at, v_method, v_actor);
  PERFORM public.receivable_refresh_installment(v_installment.id);
  UPDATE public.receivable_titles SET updated_at = NOW() WHERE id = v_title.id;
END;
$$;

-- Desfaz um recebimento.
CREATE OR REPLACE FUNCTION public.undo_receivable_payment(p_payment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.receivable_payments;
  v_title public.receivable_titles;
BEGIN
  SELECT * INTO v_payment FROM public.receivable_payments
  WHERE id = p_payment_id AND tenant_id = public.current_user_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recebimento não encontrado'; END IF;
  v_title := public.receivable_lock_title(v_payment.title_id);
  PERFORM public.payable_actor(v_title.unit_id);
  IF v_title.status <> 'ATIVO' THEN RAISE EXCEPTION 'Conta cancelada'; END IF;
  DELETE FROM public.receivable_payments WHERE id = p_payment_id;
  PERFORM public.receivable_refresh_installment(v_payment.installment_id);
  UPDATE public.receivable_titles SET updated_at = NOW() WHERE id = v_title.id;
END;
$$;

-- Cancela a conta (só sem recebimentos). Mercadoria repassada volta ao estoque com o custo guardado.
CREATE OR REPLACE FUNCTION public.cancel_receivable(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title public.receivable_titles;
  v_actor TEXT;
  v_item JSONB;
  v_qty INTEGER;
  v_qty_before INTEGER;
  v_quantities JSONB;
  v_found INTEGER;
BEGIN
  v_title := public.receivable_lock_title(p_id);
  v_actor := public.payable_actor(v_title.unit_id);
  IF v_title.status <> 'ATIVO' THEN RAISE EXCEPTION 'Esta conta já está cancelada'; END IF;
  IF EXISTS (SELECT 1 FROM public.receivable_payments WHERE title_id = p_id) THEN
    RAISE EXCEPTION 'Esta conta tem recebimentos: desfaça os recebimentos antes de cancelar';
  END IF;

  IF v_title.kind = 'MERCADORIA' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_title.items) LOOP
      v_qty := (v_item->>'quantity')::INTEGER;
      IF jsonb_array_length(COALESCE(v_item->'serials', '[]'::JSONB)) > 0 THEN
        UPDATE public.product_serial_units SET status = 'DISPONIVEL'
        WHERE tenant_id = v_title.tenant_id AND product_id = v_item->>'productId' AND unit_id = v_title.unit_id
          AND status = 'VENDIDO' AND sale_id IS NULL
          AND UPPER(serial_number) IN (SELECT value FROM jsonb_array_elements_text(v_item->'serials'));
        GET DIAGNOSTICS v_found = ROW_COUNT;
        PERFORM public.sync_serialized_inventory_quantity(v_title.tenant_id, v_item->>'productId', v_title.unit_id);
      ELSE
        INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
        VALUES (v_title.tenant_id, v_item->>'productId', '{}'::JSONB, NOW()) ON CONFLICT DO NOTHING;
        SELECT quantities INTO v_quantities FROM public.inventory
        WHERE tenant_id = v_title.tenant_id AND product_id = v_item->>'productId' FOR UPDATE;
        v_quantities := public.inventory_with_unit(COALESCE(v_quantities, '{}'::JSONB), v_title.unit_id);
        v_qty_before := COALESCE((v_quantities -> v_title.unit_id ->> 'qty')::INTEGER, 0);
        PERFORM public.apply_store_cost_entry(v_title.tenant_id, v_item->>'productId', v_title.unit_id, v_qty_before, v_qty,
          COALESCE((v_item->>'unitCost')::NUMERIC, 0));
        UPDATE public.inventory
        SET quantities = jsonb_set(v_quantities, ARRAY[v_title.unit_id, 'qty'], to_jsonb(v_qty_before + v_qty), true), updated_at = NOW()
        WHERE tenant_id = v_title.tenant_id AND product_id = v_item->>'productId';
      END IF;
      INSERT INTO public.movements (
        id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
        serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
      ) VALUES (
        gen_random_uuid()::TEXT, v_title.tenant_id, v_item->>'productId', NULL, 'CONTA_RECEBER', v_title.unit_id, 'ENTRADA', v_qty,
        CASE WHEN jsonb_array_length(COALESCE(v_item->'serials', '[]'::JSONB)) > 0 THEN v_item->'serials' ELSE NULL END, NULL,
        auth.uid()::TEXT, v_actor, NOW(),
        'Conta a receber nº ' || v_title.title_number || ' cancelada (mercadoria voltou ao estoque)', (v_item->>'unitCost')::NUMERIC
      );
    END LOOP;
  END IF;

  UPDATE public.receivable_installments SET status = 'CANCELADO' WHERE title_id = p_id;
  UPDATE public.receivable_titles SET status = 'CANCELADO', cancelled_at = NOW(), updated_at = NOW() WHERE id = p_id;
END;
$$;

-- Exclui de vez (só o dono e só conta já cancelada).
CREATE OR REPLACE FUNCTION public.delete_receivable(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title public.receivable_titles;
BEGIN
  IF NOT public.current_user_is_admin() THEN RAISE EXCEPTION 'Só o dono da empresa exclui contas a receber'; END IF;
  v_title := public.receivable_lock_title(p_id);
  IF v_title.status <> 'CANCELADO' THEN RAISE EXCEPTION 'Cancele a conta antes de excluir'; END IF;
  DELETE FROM public.receivable_titles WHERE id = p_id;
END;
$$;

-- Registra que a cobrança foi enviada pelo WhatsApp.
CREATE OR REPLACE FUNCTION public.register_receivable_charge(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title public.receivable_titles;
BEGIN
  v_title := public.receivable_lock_title(p_id);
  PERFORM public.payable_actor(v_title.unit_id);
  UPDATE public.receivable_titles SET charge_count = charge_count + 1, last_charge_at = NOW() WHERE id = p_id;
END;
$$;

-- Anexo: caminho <empresa>/<conta>/<arquivo> do bucket privado (nulo = remove).
CREATE OR REPLACE FUNCTION public.set_receivable_attachment(p_id UUID, p_path TEXT, p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title public.receivable_titles;
BEGIN
  v_title := public.receivable_lock_title(p_id);
  PERFORM public.payable_actor(v_title.unit_id);
  IF p_path IS NOT NULL AND split_part(p_path, '/', 1) || '/' || split_part(p_path, '/', 2)
       <> v_title.tenant_id::TEXT || '/' || v_title.id::TEXT THEN
    RAISE EXCEPTION 'Caminho do anexo inválido';
  END IF;
  UPDATE public.receivable_titles
  SET attachment_path = p_path,
      attachment_name = CASE WHEN p_path IS NULL THEN NULL ELSE LEFT(COALESCE(NULLIF(BTRIM(p_name), ''), 'anexo'), 120) END,
      updated_at = NOW()
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_receivable(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_receivable(UUID, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.undo_receivable_payment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_receivable(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_receivable(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_receivable_charge(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_receivable_attachment(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_receivable(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_receivable(UUID, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.undo_receivable_payment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_receivable(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_receivable(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_receivable_charge(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_receivable_attachment(UUID, TEXT, TEXT) TO authenticated;

-- ---- 4. Anexos (bucket privado) ----
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('receivable-attachments', 'receivable-attachments', false, 10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.receivable_file_allowed(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant TEXT := split_part(p_name, '/', 1);
  v_title TEXT := split_part(p_name, '/', 2);
BEGIN
  IF v_tenant <> COALESCE(public.current_user_tenant_id()::TEXT, '')
     OR v_title !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.receivable_titles
    WHERE id = v_title::UUID AND tenant_id::TEXT = v_tenant
      AND public.current_user_has_store_access(tenant_id, unit_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.receivable_file_allowed(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receivable_file_allowed(TEXT) TO authenticated;

DROP POLICY IF EXISTS receivable_attachments_read ON storage.objects;
CREATE POLICY receivable_attachments_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'receivable-attachments' AND public.receivable_file_allowed(name));

DROP POLICY IF EXISTS receivable_attachments_insert ON storage.objects;
CREATE POLICY receivable_attachments_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'receivable-attachments' AND public.receivable_file_allowed(name));

DROP POLICY IF EXISTS receivable_attachments_delete ON storage.objects;
CREATE POLICY receivable_attachments_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'receivable-attachments' AND public.receivable_file_allowed(name));

-- ---- 5. Registro de ações (gatilho genérico da 20261205) ----
DROP TRIGGER IF EXISTS zz_audit_receivable_titles ON public.receivable_titles;
CREATE TRIGGER zz_audit_receivable_titles AFTER INSERT OR UPDATE OR DELETE ON public.receivable_titles
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('FINANCEIRO', 'exclude', 'charge_count,last_charge_at');

DROP TRIGGER IF EXISTS zz_audit_receivable_payments ON public.receivable_payments;
CREATE TRIGGER zz_audit_receivable_payments AFTER INSERT OR DELETE ON public.receivable_payments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('FINANCEIRO', 'exclude', '');
