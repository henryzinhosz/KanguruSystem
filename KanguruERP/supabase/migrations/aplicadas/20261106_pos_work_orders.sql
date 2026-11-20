-- =========================================================================
-- Ordem de Servico pelo PDV (desenho aprovado em 2026-10-29).
-- O vendedor abre a OS no PDV (cliente do cadastro, aparelho, acessorios, estado,
-- servicos cadastrados no ERP, previsao, vendedor) e imprime o comprovante de entrada;
-- acompanha o status; na entrega cobra por uma venda normal (servicos da OS no
-- carrinho) e imprime o comprovante de entrega (garantia de 90 dias).
-- Pagamento: na abertura (total) ou na entrega, sem sinal.
-- A venda liga a OS pelos itens (item.workOrderId) por trigger: a funcao de venda
-- NAO muda. Estorno da venda desfaz o pagamento da OS.
-- Aditiva: colunas novas em work_orders, RPCs novas e duas triggers em sales.
-- =========================================================================

-- ---- 1. Colunas novas ----
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS order_number INTEGER,
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id),
  ADD COLUMN IF NOT EXISTS client_cpf TEXT,
  ADD COLUMN IF NOT EXISTS client_address TEXT,
  ADD COLUMN IF NOT EXISTS equipment_type TEXT,
  ADD COLUMN IF NOT EXISTS accessories TEXT,
  ADD COLUMN IF NOT EXISTS entry_condition TEXT,
  ADD COLUMN IF NOT EXISTS device_password TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS expected_date DATE,
  ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES public.pos_terminals(id),
  ADD COLUMN IF NOT EXISTS staff_code TEXT,
  ADD COLUMN IF NOT EXISTS staff_name TEXT,
  ADD COLUMN IF NOT EXISTS sale_id TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_by_code TEXT,
  ADD COLUMN IF NOT EXISTS delivered_by_name TEXT,
  ADD COLUMN IF NOT EXISTS tested_on_delivery BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warranty_until DATE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_number_idx
  ON public.work_orders (tenant_id, unit_id, order_number) WHERE order_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_orders_sale_idx ON public.work_orders (tenant_id, sale_id) WHERE sale_id IS NOT NULL;

-- Status: os 4 de antes + DEVOLVIDO (devolvido sem conserto).
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status IN ('EM_ANALISE', 'AGUARDANDO_PECA', 'PRONTO', 'ENTREGUE', 'DEVOLVIDO'));

-- Textos dos comprovantes, editaveis por loja (nulo = texto padrao do PDV).
ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS work_order_terms TEXT,
  ADD COLUMN IF NOT EXISTS work_order_delivery_terms TEXT;

-- ---- 2. Funcoes internas (sem GRANT) ----
-- Servicos escolhidos -> itens da OS com o preco atual do cadastro.
CREATE OR REPLACE FUNCTION public.work_order_items_from_services(p_tenant_id UUID, p_service_ids JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items JSONB := '[]'::JSONB;
  v_service_id TEXT;
  v_service public.services%ROWTYPE;
BEGIN
  IF p_service_ids IS NULL OR jsonb_typeof(p_service_ids) <> 'array' THEN
    RETURN v_items;
  END IF;
  FOR v_service_id IN SELECT jsonb_array_elements_text(p_service_ids) LOOP
    SELECT * INTO v_service FROM public.services
    WHERE tenant_id = p_tenant_id AND id = v_service_id AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Serviço não encontrado ou inativo no cadastro';
    END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'serviceId', v_service.id, 'sku', v_service.sku, 'name', v_service.name, 'price', v_service.sell_price
    ));
  END LOOP;
  RETURN v_items;
END;
$$;

REVOKE ALL ON FUNCTION public.work_order_items_from_services(UUID, JSONB) FROM PUBLIC, anon, authenticated;

-- OS completa para o PDV (comprovantes e tela): cliente, aparelho, servicos,
-- pagamento (da venda ligada) e textos da loja.
CREATE OR REPLACE FUNCTION public.work_order_payload(p_order public.work_orders)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale public.sales%ROWTYPE;
  v_paid_items JSONB;
  v_paid_total NUMERIC;
  v_payments JSONB;
  v_config public.store_configs%ROWTYPE;
  v_total NUMERIC;
BEGIN
  SELECT COALESCE(SUM((entry->>'price')::NUMERIC), 0) INTO v_total
  FROM jsonb_array_elements(p_order.items) AS entry;

  IF p_order.sale_id IS NOT NULL THEN
    SELECT * INTO v_sale FROM public.sales WHERE tenant_id = p_order.tenant_id AND id = p_order.sale_id;
    IF FOUND THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'name', entry->>'itemName', 'sku', entry->>'itemSku',
          'quantity', COALESCE((entry->>'quantity')::INTEGER, 1),
          'unitPrice', (entry->>'unitPrice')::NUMERIC,
          'discountPercent', COALESCE((entry->>'discountPercent')::NUMERIC, 0),
          'lineTotal', (entry->>'lineTotal')::NUMERIC
        )), '[]'::JSONB),
        COALESCE(SUM((entry->>'lineTotal')::NUMERIC), 0)
      INTO v_paid_items, v_paid_total
      FROM jsonb_array_elements(v_sale.items) AS entry
      WHERE entry->>'workOrderId' = p_order.id;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('paymentMethod', payment.payment_method, 'amount', payment.amount)
        ORDER BY payment.created_at), '[]'::JSONB)
      INTO v_payments
      FROM public.sale_payments AS payment
      WHERE payment.tenant_id = p_order.tenant_id AND payment.sale_id = v_sale.id;
      IF v_payments = '[]'::JSONB THEN
        v_payments := jsonb_build_array(jsonb_build_object('paymentMethod', v_sale.payment_method, 'amount', v_sale.gross_amount));
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_config FROM public.store_configs WHERE tenant_id = p_order.tenant_id AND unit_id = p_order.unit_id;

  RETURN jsonb_build_object(
    'workOrderId', p_order.id,
    'orderNumber', p_order.order_number,
    'status', p_order.status,
    'createdAt', p_order."timestamp",
    'customerName', p_order.client_name,
    'customerCpf', p_order.client_cpf,
    'customerPhone', p_order.client_phone,
    'customerAddress', p_order.client_address,
    'equipmentType', p_order.equipment_type,
    'equipment', p_order.equipment,
    'serialNumber', p_order.linked_serial,
    'accessories', p_order.accessories,
    'entryCondition', p_order.entry_condition,
    'devicePassword', p_order.device_password,
    'problem', p_order.problem_description,
    'notes', p_order.notes,
    'items', p_order.items,
    'total', v_total,
    'expectedDate', p_order.expected_date,
    'staffCode', p_order.staff_code,
    'staffName', p_order.staff_name,
    'saleId', p_order.sale_id,
    'paidAt', p_order.paid_at,
    'receiptNumber', v_sale.receipt_number,
    'paidItems', COALESCE(v_paid_items, '[]'::JSONB),
    'paidTotal', v_paid_total,
    'payments', COALESCE(v_payments, '[]'::JSONB),
    'deliveredAt', p_order.delivered_at,
    'deliveredByCode', p_order.delivered_by_code,
    'deliveredByName', p_order.delivered_by_name,
    'testedOnDelivery', p_order.tested_on_delivery,
    'warrantyUntil', p_order.warranty_until,
    'terms', v_config.work_order_terms,
    'deliveryTerms', v_config.work_order_delivery_terms
  );
END;
$$;

REVOKE ALL ON FUNCTION public.work_order_payload(public.work_orders) FROM PUBLIC, anon, authenticated;

-- Terminal ativo da sessao (padrao do PDV).
CREATE OR REPLACE FUNCTION public.work_order_terminal()
RETURNS public.pos_terminals
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
  RETURN v_terminal;
END;
$$;

REVOKE ALL ON FUNCTION public.work_order_terminal() FROM PUBLIC, anon, authenticated;

-- ---- 3. Abrir a OS (PDV) ----
CREATE OR REPLACE FUNCTION public.create_pos_work_order(
  p_customer_cpf TEXT,
  p_equipment_type TEXT,
  p_equipment TEXT,
  p_serial TEXT,
  p_accessories TEXT,
  p_entry_condition TEXT,
  p_device_password TEXT,
  p_service_ids JSONB,
  p_notes TEXT,
  p_expected_date DATE,
  p_seller_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_customer public.customers%ROWTYPE;
  v_seller public.pdv_operators%ROWTYPE;
  v_cpf TEXT := regexp_replace(COALESCE(p_customer_cpf, ''), '\D', '', 'g');
  v_items JSONB;
  v_number INTEGER;
  v_address TEXT;
  v_order public.work_orders%ROWTYPE;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_equipment, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe a marca e o modelo do aparelho';
  END IF;
  IF NULLIF(BTRIM(COALESCE(p_entry_condition, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe o estado do aparelho na entrada';
  END IF;
  v_items := public.work_order_items_from_services(v_terminal.tenant_id, p_service_ids);
  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Escolha ao menos um serviço';
  END IF;
  IF p_expected_date IS NOT NULL AND p_expected_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'A previsão de entrega não pode ser no passado';
  END IF;

  SELECT * INTO v_customer FROM public.customers WHERE tenant_id = v_terminal.tenant_id AND cpf = v_cpf;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'CUSTOMER_REQUIRED');
  END IF;

  v_seller := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, p_seller_code);
  IF v_seller.id IS NULL THEN
    RETURN jsonb_build_object('status', 'INVALID_SELLER');
  END IF;

  v_address := NULLIF(concat_ws(', ',
    NULLIF(BTRIM(v_customer.address), ''),
    NULLIF(BTRIM(v_customer.address_number), ''),
    NULLIF(BTRIM(v_customer.complement), ''),
    NULLIF(BTRIM(v_customer.district), ''),
    NULLIF(concat_ws('/', NULLIF(BTRIM(v_customer.city), ''), NULLIF(BTRIM(v_customer.state), '')), ''),
    CASE WHEN NULLIF(BTRIM(v_customer.cep), '') IS NULL THEN NULL ELSE 'CEP ' || BTRIM(v_customer.cep) END
  ), '');

  PERFORM pg_advisory_xact_lock(hashtext('work_order:' || v_terminal.tenant_id::TEXT || ':' || v_terminal.unit_id));
  SELECT COALESCE(MAX(order_number), 0) + 1 INTO v_number
  FROM public.work_orders WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;

  INSERT INTO public.work_orders (
    id, tenant_id, os_number, client_name, client_phone, equipment, problem_description, status,
    parts_cost, labor_cost, total_cost, linked_serial, unit_id, operator_id, operator_name, "timestamp",
    order_number, customer_id, client_cpf, client_address, equipment_type, accessories, entry_condition,
    device_password, notes, items, expected_date, terminal_id, staff_code, staff_name, updated_at
  ) VALUES (
    'os_' || replace(gen_random_uuid()::TEXT, '-', ''), v_terminal.tenant_id, v_number::TEXT, v_customer.name,
    COALESCE(v_customer.phone, ''), BTRIM(p_equipment),
    (SELECT string_agg(entry->>'name', ', ') FROM jsonb_array_elements(v_items) AS entry),
    'EM_ANALISE', 0,
    (SELECT SUM((entry->>'price')::NUMERIC) FROM jsonb_array_elements(v_items) AS entry),
    (SELECT SUM((entry->>'price')::NUMERIC) FROM jsonb_array_elements(v_items) AS entry),
    NULLIF(UPPER(BTRIM(COALESCE(p_serial, ''))), ''), v_terminal.unit_id, v_terminal.id::TEXT, v_seller.name, NOW(),
    v_number, v_customer.id, v_customer.cpf, v_address, NULLIF(BTRIM(COALESCE(p_equipment_type, '')), ''),
    NULLIF(BTRIM(COALESCE(p_accessories, '')), ''), BTRIM(p_entry_condition),
    NULLIF(BTRIM(COALESCE(p_device_password, '')), ''), NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    v_items, p_expected_date, v_terminal.id, v_seller.code, v_seller.name, NOW()
  )
  RETURNING * INTO v_order;

  RETURN jsonb_build_object('status', 'OK', 'order', public.work_order_payload(v_order));
END;
$$;

REVOKE ALL ON FUNCTION public.create_pos_work_order(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pos_work_order(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, DATE, TEXT) TO authenticated;

-- ---- 4. Listar e abrir (PDV, so a loja do terminal) ----
-- Busca por numero, CPF, nome ou serial. Sem p_include_closed: so as ativas.
CREATE OR REPLACE FUNCTION public.list_pos_work_orders(p_query TEXT DEFAULT NULL, p_include_closed BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_query TEXT := NULLIF(BTRIM(COALESCE(p_query, '')), '');
  v_digits TEXT := regexp_replace(COALESCE(p_query, ''), '\D', '', 'g');
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(public.work_order_payload(work_order) ORDER BY work_order."timestamp" DESC)
    FROM (
      SELECT * FROM public.work_orders AS candidate
      WHERE candidate.tenant_id = v_terminal.tenant_id
        AND candidate.unit_id = v_terminal.unit_id
        AND candidate.order_number IS NOT NULL
        AND (p_include_closed OR v_query IS NOT NULL OR candidate.status NOT IN ('ENTREGUE', 'DEVOLVIDO'))
        AND (
          v_query IS NULL
          OR candidate.order_number::TEXT = v_query
          OR (v_digits <> '' AND length(v_digits) >= 6 AND candidate.client_cpf LIKE '%' || v_digits || '%')
          OR candidate.client_name ILIKE '%' || v_query || '%'
          OR candidate.linked_serial ILIKE '%' || v_query || '%'
          OR candidate.equipment ILIKE '%' || v_query || '%'
        )
      ORDER BY candidate."timestamp" DESC
      LIMIT 100
    ) AS work_order
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.list_pos_work_orders(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pos_work_orders(TEXT, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_pos_work_order(p_work_order_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_order public.work_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.work_orders
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND id = p_work_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ordem de serviço não encontrada nesta loja';
  END IF;
  RETURN public.work_order_payload(v_order);
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_work_order(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_work_order(TEXT) TO authenticated;

-- ---- 5. Atualizar (status, servicos, observacao, previsao) ----
-- Servicos so mudam enquanto a OS nao foi paga (depois de paga ficam travados).
CREATE OR REPLACE FUNCTION public.update_pos_work_order(
  p_work_order_id TEXT,
  p_status TEXT,
  p_service_ids JSONB,
  p_notes TEXT,
  p_expected_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_order public.work_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  SELECT * INTO v_order FROM public.work_orders
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND id = p_work_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ordem de serviço não encontrada nesta loja';
  END IF;
  IF v_order.status IN ('ENTREGUE', 'DEVOLVIDO') THEN
    RAISE EXCEPTION 'Esta OS já foi entregue';
  END IF;
  IF p_status NOT IN ('EM_ANALISE', 'AGUARDANDO_PECA', 'PRONTO') THEN
    RAISE EXCEPTION 'Situação inválida';
  END IF;

  v_items := v_order.items;
  IF p_service_ids IS NOT NULL THEN
    v_items := public.work_order_items_from_services(v_terminal.tenant_id, p_service_ids);
    IF v_order.sale_id IS NOT NULL AND v_items IS DISTINCT FROM v_order.items THEN
      -- Compara so os ids (o preco do cadastro pode ter mudado depois do pagamento).
      IF (SELECT array_agg(entry->>'serviceId' ORDER BY entry->>'serviceId') FROM jsonb_array_elements(v_items) AS entry)
         IS DISTINCT FROM
         (SELECT array_agg(entry->>'serviceId' ORDER BY entry->>'serviceId') FROM jsonb_array_elements(v_order.items) AS entry) THEN
        RAISE EXCEPTION 'OS já paga: os serviços não podem mudar';
      END IF;
      v_items := v_order.items;
    END IF;
  END IF;

  UPDATE public.work_orders
  SET status = p_status,
      items = v_items,
      problem_description = COALESCE((SELECT string_agg(entry->>'name', ', ') FROM jsonb_array_elements(v_items) AS entry), ''),
      labor_cost = COALESCE((SELECT SUM((entry->>'price')::NUMERIC) FROM jsonb_array_elements(v_items) AS entry), 0),
      total_cost = COALESCE((SELECT SUM((entry->>'price')::NUMERIC) FROM jsonb_array_elements(v_items) AS entry), 0),
      notes = NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
      expected_date = p_expected_date,
      updated_at = NOW()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  RETURN public.work_order_payload(v_order);
END;
$$;

REVOKE ALL ON FUNCTION public.update_pos_work_order(TEXT, TEXT, JSONB, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_pos_work_order(TEXT, TEXT, JSONB, TEXT, DATE) TO authenticated;

-- ---- 6. Entregar ----
-- Consertado: precisa estar paga (ou total zero) e testado diante do cliente; garantia de 90 dias.
-- Sem conserto (DEVOLVIDO): so se nao foi paga (paga = estornar a venda antes).
CREATE OR REPLACE FUNCTION public.deliver_pos_work_order(
  p_work_order_id TEXT,
  p_seller_code TEXT,
  p_without_repair BOOLEAN DEFAULT false,
  p_tested BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_order public.work_orders%ROWTYPE;
  v_seller public.pdv_operators%ROWTYPE;
  v_total NUMERIC;
BEGIN
  SELECT * INTO v_order FROM public.work_orders
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND id = p_work_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ordem de serviço não encontrada nesta loja';
  END IF;
  IF v_order.status IN ('ENTREGUE', 'DEVOLVIDO') THEN
    RAISE EXCEPTION 'Esta OS já foi entregue';
  END IF;

  v_seller := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, p_seller_code);
  IF v_seller.id IS NULL THEN
    RETURN jsonb_build_object('status', 'INVALID_SELLER');
  END IF;

  SELECT COALESCE(SUM((entry->>'price')::NUMERIC), 0) INTO v_total FROM jsonb_array_elements(v_order.items) AS entry;

  IF COALESCE(p_without_repair, false) THEN
    IF v_order.sale_id IS NOT NULL THEN
      RAISE EXCEPTION 'OS já paga: estorne a venda antes de devolver sem conserto';
    END IF;
  ELSE
    IF v_order.sale_id IS NULL AND v_total > 0 THEN
      RETURN jsonb_build_object('status', 'NOT_PAID');
    END IF;
    IF NOT COALESCE(p_tested, false) THEN
      RAISE EXCEPTION 'Teste o aparelho diante do cliente antes de entregar';
    END IF;
  END IF;

  UPDATE public.work_orders
  SET status = CASE WHEN COALESCE(p_without_repair, false) THEN 'DEVOLVIDO' ELSE 'ENTREGUE' END,
      delivered_at = NOW(),
      delivered_by_code = v_seller.code,
      delivered_by_name = v_seller.name,
      tested_on_delivery = COALESCE(p_tested, false),
      warranty_until = CASE WHEN COALESCE(p_without_repair, false) THEN NULL ELSE CURRENT_DATE + 90 END,
      updated_at = NOW()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  RETURN jsonb_build_object('status', 'OK', 'order', public.work_order_payload(v_order));
END;
$$;

REVOKE ALL ON FUNCTION public.deliver_pos_work_order(TEXT, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deliver_pos_work_order(TEXT, TEXT, BOOLEAN, BOOLEAN) TO authenticated;

-- ---- 7. Venda <-> OS (triggers em sales; a funcao de venda nao muda) ----
-- Itens da venda com workOrderId pagam a OS: precisam ser exatamente os servicos da OS
-- (mesma loja, ainda nao paga nem entregue). Venda offline nunca e recusada aqui:
-- se nao bater, so nao liga.
CREATE OR REPLACE FUNCTION public.link_sale_work_orders()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_work_order_id TEXT;
  v_order public.work_orders%ROWTYPE;
  v_sale_services TEXT[];
  v_order_services TEXT[];
  v_problem TEXT;
BEGIN
  IF jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' THEN
    RETURN NEW;
  END IF;

  FOR v_work_order_id IN
    SELECT DISTINCT entry->>'workOrderId' FROM jsonb_array_elements(NEW.items) AS entry
    WHERE NULLIF(entry->>'workOrderId', '') IS NOT NULL
  LOOP
    v_problem := NULL;
    SELECT * INTO v_order FROM public.work_orders
    WHERE tenant_id = NEW.tenant_id AND id = v_work_order_id
    FOR UPDATE;
    IF NOT FOUND OR v_order.unit_id <> NEW.unit_id THEN
      v_problem := 'Ordem de serviço não encontrada nesta loja';
    ELSIF v_order.status IN ('ENTREGUE', 'DEVOLVIDO') THEN
      v_problem := 'Esta OS já foi entregue';
    ELSIF v_order.sale_id IS NOT NULL THEN
      v_problem := 'Esta OS já foi paga';
    ELSE
      SELECT array_agg(entry->>'serviceId' ORDER BY entry->>'serviceId')
      INTO v_sale_services
      FROM jsonb_array_elements(NEW.items) AS entry
      CROSS JOIN LATERAL generate_series(1, GREATEST(COALESCE((entry->>'quantity')::INTEGER, 1), 1))
      WHERE entry->>'workOrderId' = v_work_order_id;
      SELECT array_agg(entry->>'serviceId' ORDER BY entry->>'serviceId')
      INTO v_order_services
      FROM jsonb_array_elements(v_order.items) AS entry;
      IF v_sale_services IS DISTINCT FROM v_order_services THEN
        v_problem := 'Os serviços da venda não batem com os da OS. Volte à OS e cobre de novo.';
      END IF;
    END IF;

    IF v_problem IS NOT NULL THEN
      IF NEW.offline_origin THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION '%', v_problem;
    END IF;

    UPDATE public.work_orders
    SET sale_id = NEW.id, paid_at = NOW(), updated_at = NOW()
    WHERE id = v_order.id;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.link_sale_work_orders() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_sale_work_order_link ON public.sales;
CREATE TRIGGER zz_sale_work_order_link
  AFTER INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.link_sale_work_orders();

-- Estorno da venda: a OS volta a ficar "a pagar".
CREATE OR REPLACE FUNCTION public.unlink_cancelled_sale_work_orders()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'CANCELADA' AND OLD.status IS DISTINCT FROM 'CANCELADA' THEN
    UPDATE public.work_orders
    SET sale_id = NULL, paid_at = NULL, updated_at = NOW()
    WHERE tenant_id = NEW.tenant_id AND sale_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.unlink_cancelled_sale_work_orders() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_sale_work_order_unlink ON public.sales;
CREATE TRIGGER zz_sale_work_order_unlink
  AFTER UPDATE OF status ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.unlink_cancelled_sale_work_orders();
