  -- =========================================================================
  -- Calculadora de juros do cartao (desenho aprovado em 2026-10-30).
  -- O dono configura por loja a taxa do debito e do credito de 1x a 12x (ERP > Livro Caixa).
  -- No PDV, ao escolher credito (parcelas) ou debito, o vendedor pode "Repassar taxa"
  -- (desligado por padrao). Repassada: o cliente paga valor / (1 - taxa) e a loja recebe o
  -- valor cheio; os juros ENTRAM NO PRECO DOS ITENS (cupom, NFC-e e relatorios mostram so o
  -- novo valor, sem linha de juros). Repassada ou nao, a taxa da maquininha fica gravada na
  -- venda (sales.fee_amount) e o ERP desconta do lucro.
  --
  -- sale_payments.amount passa a ser o valor cobrado (com juros); surcharge_amount guarda a
  -- parte dos juros e fee_percent a taxa da tabela no momento. Fechamento de caixa e NFC-e
  -- nao mudam (somam sale_payments.amount e sales.items).
  --
  -- process_pos_terminal_sale: mesma assinatura, copiada da versao viva (20261026) so com os
  -- trechos dos juros. Venda offline nao repassa taxa (o PDV bloqueia), mas a taxa da
  -- maquininha tambem e gravada pela trigger.
  -- ANTES DE APLICAR (md5 vivo; os da devolucao estao no fim do arquivo):
  --   process_pos_terminal_sale  eb8d149053dd195d4f005b1268eee0a5 (LF) / 02dd01a2c635d125d52d58aa2c6d8e3f (CRLF)
  -- =========================================================================

  -- Tabela de taxas por loja: {"debito": 1.99, "credito": [3.19, 4.5, ... 12 valores]} (em %).
  ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS card_fee_table JSONB;

  ALTER TABLE public.sale_payments
    ADD COLUMN IF NOT EXISTS surcharge_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (surcharge_amount >= 0),
    ADD COLUMN IF NOT EXISTS fee_percent NUMERIC(6, 3);

  -- Taxa (%) da loja para a forma e as parcelas (sem tabela/valor: 0).
  CREATE OR REPLACE FUNCTION public.pos_card_fee_rate(p_table JSONB, p_method TEXT, p_installments INTEGER)
  RETURNS NUMERIC
  LANGUAGE sql
  IMMUTABLE
  SET search_path = public
  AS $$
    SELECT COALESCE(CASE
      WHEN p_table IS NULL THEN 0
      WHEN UPPER(p_method) = 'DEBITO' THEN NULLIF(p_table->>'debito', '')::NUMERIC
      WHEN UPPER(p_method) = 'CREDITO' AND p_installments BETWEEN 1 AND 12
        THEN NULLIF(p_table->'credito'->>(p_installments - 1), '')::NUMERIC
    END, 0);
  $$;

  REVOKE ALL ON FUNCTION public.pos_card_fee_rate(JSONB, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

  -- Juros para a loja receber o valor cheio: valor / (1 - taxa) - valor, em centavos.
  CREATE OR REPLACE FUNCTION public.pos_card_surcharge(p_amount NUMERIC, p_rate NUMERIC)
  RETURNS NUMERIC
  LANGUAGE sql
  IMMUTABLE
  SET search_path = public
  AS $$
    SELECT CASE WHEN p_rate <= 0 OR p_rate >= 100 THEN 0
      ELSE ROUND(p_amount / (1 - p_rate / 100) - p_amount, 2) END;
  $$;

  REVOKE ALL ON FUNCTION public.pos_card_surcharge(NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;

  -- Taxa da maquininha de cada linha de cartao: grava a taxa vigente e soma em
  -- sales.fee_amount (o ERP desconta do lucro). Vale para venda online e offline.
  CREATE OR REPLACE FUNCTION public.apply_sale_payment_card_fee()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_fee NUMERIC;
  BEGIN
    IF NEW.payment_method NOT IN ('CREDITO', 'DEBITO') THEN
      RETURN NEW;
    END IF;
    IF NEW.fee_percent IS NULL THEN
      SELECT public.pos_card_fee_rate(config.card_fee_table, NEW.payment_method, NEW.installments)
      INTO NEW.fee_percent
      FROM public.store_configs AS config
      WHERE config.tenant_id = NEW.tenant_id AND config.unit_id = NEW.unit_id;
    END IF;
    v_fee := ROUND(NEW.amount * COALESCE(NEW.fee_percent, 0) / 100, 2);
    IF v_fee > 0 THEN
      UPDATE public.sales
      SET fee_amount = COALESCE(fee_amount, 0) + v_fee,
          net_amount = COALESCE(net_amount, 0) - v_fee
      WHERE tenant_id = NEW.tenant_id AND id = NEW.sale_id;
    END IF;
    RETURN NEW;
  END;
  $$;

  REVOKE ALL ON FUNCTION public.apply_sale_payment_card_fee() FROM PUBLIC, anon, authenticated;

  DROP TRIGGER IF EXISTS zz_sale_payment_card_fee ON public.sale_payments;
  CREATE TRIGGER zz_sale_payment_card_fee
    BEFORE INSERT ON public.sale_payments
    FOR EACH ROW EXECUTE FUNCTION public.apply_sale_payment_card_fee();

  -- PDV: tabela de taxas da loja do terminal.
  CREATE OR REPLACE FUNCTION public.get_pos_card_fees()
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
    RETURN (SELECT card_fee_table FROM public.store_configs WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id);
  END;
  $$;

  REVOKE ALL ON FUNCTION public.get_pos_card_fees() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.get_pos_card_fees() TO authenticated;

  -- ---- Venda do PDV (mesma assinatura): juros repassados entram no preco dos itens ----
  CREATE OR REPLACE FUNCTION public.process_pos_terminal_sale(
    p_sale_id TEXT,
    p_invoice_number TEXT,
    p_items JSONB,
    p_payment_method TEXT,
    p_gross_amount NUMERIC,
    p_fee_amount NUMERIC,
    p_net_amount NUMERIC,
    p_client_cpf TEXT,
    p_client_name TEXT,
    p_timestamp TIMESTAMPTZ,
    p_status TEXT,
    p_requires_approval BOOLEAN,
    p_reservation_id UUID DEFAULT NULL,
    p_payments JSONB DEFAULT NULL,
    p_admin_password TEXT DEFAULT NULL,
    p_seller_code TEXT DEFAULT NULL
  )
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, extensions
  AS $$
  DECLARE
    v_terminal public.pos_terminals%ROWTYPE;
    v_cash public.cash_register_sessions%ROWTYPE;
    v_config public.store_configs%ROWTYPE;
    v_reservation public.product_reservations%ROWTYPE;
    v_reservation_item public.product_reservation_items%ROWTYPE;
    v_backorder_unit_id UUID;
    v_backorder_serial TEXT;
    item JSONB;
    payment JSONB;
    item_type TEXT;
    item_product_id TEXT;
    item_service_id TEXT;
    item_quantity INTEGER;
    current_qty INTEGER;
    reserved_qty INTEGER;
    item_discount NUMERIC;
    item_price NUMERIC;
    item_sku TEXT;
    item_name TEXT;
    item_default_cost NUMERIC;
    item_cost_total NUMERIC;
    item_unit_cost NUMERIC;
    line_total NUMERIC;
    calculated_gross NUMERIC := 0;
    normalized_items JSONB := '[]'::JSONB;
    item_serials JSONB;
    is_serialized_product BOOLEAN;
    inv_row public.inventory%ROWTYPE;
    updated_units INTEGER;
    submitted_item_count INTEGER;
    distinct_reservation_items INTEGER;
    v_max_discount NUMERIC(5, 2);
    v_has_over_limit BOOLEAN := FALSE;
    v_password_check JSONB;
    v_payment_method TEXT;
    v_payment_total NUMERIC := 0;
    v_expected_payment_total NUMERIC;
    v_payment_count INTEGER := 0;
    v_payment_method_input TEXT;
    v_payment_amount_input NUMERIC;
    v_installments_input INTEGER;
    v_card_rate NUMERIC;
    v_line_surcharge NUMERIC;
    v_surcharge_total NUMERIC := 0;
    v_share_sum NUMERIC;
    v_main_line BIGINT;
    v_share NUMERIC;
    v_entry RECORD;
    v_surcharged_items JSONB;
    v_finalizer public.pdv_operators%ROWTYPE;
    v_seller_id UUID;
    v_seller_code TEXT;
    v_seller_name TEXT;
  BEGIN
    SELECT * INTO v_terminal FROM public.pos_terminals
    WHERE device_auth_uid = auth.uid() AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

    SELECT * INTO v_cash FROM public.cash_register_sessions
    WHERE terminal_id = v_terminal.id AND status = 'ABERTO' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Open cash register required before selling'; END IF;

    SELECT * INTO v_config FROM public.store_configs
    WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Store configuration not found'; END IF;
    v_max_discount := COALESCE(v_config.max_item_discount_percent, 0);

    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Sale items must be a JSON array';
    END IF;
    IF jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'Sale must contain at least one item';
    END IF;

    -- ---- Validacao das linhas de pagamento (se informadas) ----
    IF p_payments IS NOT NULL THEN
      IF jsonb_typeof(p_payments) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Sale payments must be a JSON array';
      END IF;
      v_payment_count := jsonb_array_length(p_payments);
      IF v_payment_count = 0 THEN
        RAISE EXCEPTION 'Sale payments array cannot be empty';
      END IF;
      FOR payment IN SELECT entries.value FROM jsonb_array_elements(p_payments) AS entries(value) LOOP
        v_payment_method_input := UPPER(COALESCE(payment->>'paymentMethod', ''));
        v_payment_amount_input := NULLIF(payment->>'amount', '')::NUMERIC;
        v_installments_input := COALESCE(NULLIF(payment->>'installments', '')::INTEGER, 1);
        IF v_payment_method_input NOT IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO', 'VOUCHER', 'CREDIARIO') THEN
          RAISE EXCEPTION 'Invalid payment method: %', v_payment_method_input;
        END IF;
        IF v_payment_amount_input IS NULL OR v_payment_amount_input <= 0 THEN
          RAISE EXCEPTION 'Payment amount must be greater than zero';
        END IF;
        IF v_payment_amount_input <> ROUND(v_payment_amount_input, 2) THEN
          RAISE EXCEPTION 'Payment amount must have at most two decimal places';
        END IF;
        IF v_installments_input < 1 THEN
          RAISE EXCEPTION 'Installments must be at least one';
        END IF;
        -- Taxa do cartao repassada ao cliente: o servidor calcula pela tabela da loja
        -- (a loja recebe o valor cheio) e confere com o que o PDV mostrou.
        IF COALESCE((payment->>'passFee')::BOOLEAN, FALSE) THEN
          IF v_payment_method_input NOT IN ('CREDITO', 'DEBITO') THEN
            RAISE EXCEPTION 'Card fee can only be passed on for credit or debit';
          END IF;
          v_card_rate := public.pos_card_fee_rate(v_config.card_fee_table, v_payment_method_input, v_installments_input);
          IF v_card_rate <= 0 THEN
            RAISE EXCEPTION 'A taxa deste cartão não está configurada no ERP';
          END IF;
          v_line_surcharge := public.pos_card_surcharge(v_payment_amount_input, v_card_rate);
          IF NULLIF(payment->>'surcharge', '') IS NOT NULL
            AND ABS((payment->>'surcharge')::NUMERIC - v_line_surcharge) > 0.01 THEN
            RAISE EXCEPTION 'A taxa do cartão mudou. Confira o valor e finalize de novo.';
          END IF;
          v_surcharge_total := v_surcharge_total + v_line_surcharge;
        END IF;
        v_payment_total := v_payment_total + v_payment_amount_input;
      END LOOP;
    ELSIF UPPER(COALESCE(p_payment_method, '')) = 'DIVIDIDO' THEN
      RAISE EXCEPTION 'Split payment requires payment lines';
    END IF;

    -- ---- Vendedor que esta finalizando (obrigatorio, antes de qualquer escrita) ----
    -- Codigo invalido nao gera excecao: devolve o status para o PDV pedir de novo.
    v_finalizer := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, p_seller_code);
    IF v_finalizer.id IS NULL THEN
      RETURN jsonb_build_object('status', 'INVALID_SELLER');
    END IF;

    -- ---- Aprovacao de desconto (antes de qualquer escrita da venda) ----
    -- O servidor decide sozinho se ha item acima do limite. Em conversao de
    -- reserva o desconto vem congelado e nunca exige senha.
    IF p_reservation_id IS NULL THEN
      FOR item IN SELECT entries.value FROM jsonb_array_elements(p_items) AS entries(value) LOOP
        item_discount := COALESCE(NULLIF(item->>'discountPercent', '')::NUMERIC, 0);
        -- Limite do produto; sem limite proprio (e servicos), o padrao da loja.
        IF item_discount > public.pos_item_discount_limit(v_terminal.tenant_id, item, v_max_discount) THEN
          v_has_over_limit := TRUE;
        END IF;
      END LOOP;
    END IF;

    IF v_has_over_limit THEN
      IF p_admin_password IS NULL OR p_admin_password = '' THEN
        RAISE EXCEPTION 'Administrative password required to approve discounts above the store limit';
      END IF;
      v_password_check := public.check_pos_admin_password(v_terminal.id, p_admin_password, 'DISCOUNT_APPROVAL');
      IF v_password_check->>'status' = 'LOCKED' THEN
        RETURN jsonb_build_object('status', 'LOCKED', 'lockedUntil', v_password_check->'lockedUntil');
      END IF;
      IF v_password_check->>'status' <> 'OK' THEN
        -- Retorna sem excecao: a tentativa errada fica registrada e nada da
        -- venda foi gravado ate aqui.
        RETURN jsonb_build_object(
          'status', 'INVALID_PASSWORD',
          'remainingAttempts', v_password_check->'remainingAttempts'
        );
      END IF;
    END IF;

    IF p_reservation_id IS NOT NULL THEN
      SELECT * INTO v_reservation
      FROM public.product_reservations
      WHERE id = p_reservation_id AND tenant_id = v_terminal.tenant_id
        AND unit_id = v_terminal.unit_id AND status = 'ATIVA'
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Active reservation not found for this terminal store'; END IF;

      SELECT COUNT(*), COUNT(DISTINCT entries.value->>'reservationItemId')
      INTO submitted_item_count, distinct_reservation_items
      FROM jsonb_array_elements(p_items) AS entries(value);
      IF submitted_item_count <> distinct_reservation_items THEN
        RAISE EXCEPTION 'Reservation contains duplicate sale lines';
      END IF;
      IF submitted_item_count <> (
        SELECT COUNT(*) FROM public.product_reservation_items
        WHERE tenant_id = v_terminal.tenant_id AND reservation_id = p_reservation_id
      ) THEN
        RAISE EXCEPTION 'Sale lines do not match the reservation';
      END IF;
    END IF;

    -- Venda de reserva fica com quem iniciou a reserva (comissao de quem atendeu o
    -- cliente); quem finaliza fica registrado a parte. Reserva antiga sem vendedor:
    -- a venda fica com quem finaliza.
    IF p_reservation_id IS NOT NULL AND v_reservation.seller_id IS NOT NULL THEN
      v_seller_id := v_reservation.seller_id;
      v_seller_code := v_reservation.seller_code;
      v_seller_name := v_reservation.seller_name;
    ELSE
      v_seller_id := v_finalizer.id;
      v_seller_code := v_finalizer.code;
      v_seller_name := v_finalizer.name;
    END IF;

    INSERT INTO public.sales (
      id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
      net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval,
      reservation_deposit_applied,
      seller_id, seller_code, seller_name, finalized_by_id, finalized_by_code, finalized_by_name
    ) VALUES (
      p_sale_id, v_terminal.tenant_id, v_cash.id, p_invoice_number, v_terminal.unit_id, p_items, p_payment_method,
      p_gross_amount, p_fee_amount, p_net_amount, v_terminal.id::TEXT, v_terminal.display_name,
      p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval, 0,
      v_seller_id, v_seller_code, v_seller_name, v_finalizer.id, v_finalizer.code, v_finalizer.name
    );

    FOR item IN SELECT entries.value FROM jsonb_array_elements(p_items) AS entries(value) LOOP
      item_type := UPPER(COALESCE(item->>'itemType', 'PRODUCT'));
      item_quantity := (item->>'quantity')::INTEGER;
      item_discount := COALESCE(NULLIF(item->>'discountPercent', '')::NUMERIC, 0);
      IF item_quantity IS NULL OR item_quantity <= 0 THEN RAISE EXCEPTION 'Item quantity must be greater than zero'; END IF;
      IF item_discount < 0 THEN RAISE EXCEPTION 'Discount cannot be negative'; END IF;
      IF item_discount > 100 THEN RAISE EXCEPTION 'Discount cannot exceed 100 percent'; END IF;

      IF item_type = 'SERVICE' THEN
        IF p_reservation_id IS NOT NULL THEN RAISE EXCEPTION 'Services cannot be included in product reservations'; END IF;
        item_product_id := NULL;
        item_service_id := item->>'serviceId';
        SELECT service.sell_price, service.sku, service.name INTO item_price, item_sku, item_name
        FROM public.services AS service
        WHERE service.tenant_id = v_terminal.tenant_id AND service.id = item_service_id AND service.is_active;
        IF NOT FOUND THEN RAISE EXCEPTION 'Service % not found or inactive', item_service_id; END IF;
        item_serials := NULL;
        -- Servico nao tem mercadoria: custo zero.
        item_cost_total := 0;
      ELSIF item_type = 'PRODUCT' THEN
        item_service_id := NULL;
        item_product_id := item->>'productId';
        SELECT product.sell_price, COALESCE(product.is_serialized, false), product.sku, product.name,
              GREATEST(COALESCE(product.cost_price, 0), 0)
        INTO item_price, is_serialized_product, item_sku, item_name, item_default_cost
        FROM public.products AS product
        WHERE product.tenant_id = v_terminal.tenant_id AND product.id = item_product_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', item_product_id; END IF;
        item_serials := item->'serials';

        IF p_reservation_id IS NOT NULL THEN
          SELECT * INTO v_reservation_item
          FROM public.product_reservation_items
          WHERE id = (item->>'reservationItemId')::UUID
            AND tenant_id = v_terminal.tenant_id AND reservation_id = p_reservation_id
            AND product_id = item_product_id AND quantity = item_quantity
          FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'Sale item does not match the reservation'; END IF;
          IF item_discount <> v_reservation_item.discount_percent THEN RAISE EXCEPTION 'Reservation discount has changed'; END IF;
          item_price := v_reservation_item.unit_price;
          item_discount := v_reservation_item.discount_percent;
          item_sku := v_reservation_item.item_sku;
          item_name := v_reservation_item.item_name;

          IF is_serialized_product AND v_reservation_item.serial_unit_id IS NULL
            AND v_reservation_item.is_backorder THEN
            -- Encomenda com serial: na entrega o vendedor escolhe uma unidade que chegou.
            IF item_quantity <> 1 THEN RAISE EXCEPTION 'Serialized reservation line is invalid'; END IF;
            v_backorder_unit_id := NULLIF(item->>'serialUnitId', '')::UUID;
            IF v_backorder_unit_id IS NULL THEN
              RAISE EXCEPTION 'Select the arrived unit for the backorder line';
            END IF;
            UPDATE public.product_serial_units
            SET status = 'VENDIDO', sale_id = p_sale_id
            WHERE id = v_backorder_unit_id
              AND tenant_id = v_terminal.tenant_id AND product_id = item_product_id
              AND unit_id = v_terminal.unit_id AND status = 'DISPONIVEL'
            RETURNING serial_number INTO v_backorder_serial;
            IF NOT FOUND THEN RAISE EXCEPTION 'Selected serialized unit is not available'; END IF;
            -- Guarda na reserva qual unidade foi entregue.
            UPDATE public.product_reservation_items
            SET serial_unit_id = v_backorder_unit_id, serial_number = v_backorder_serial
            WHERE id = v_reservation_item.id AND tenant_id = v_terminal.tenant_id;
            item_serials := jsonb_build_array(v_backorder_serial);
            SELECT COALESCE(unit.unit_cost, item_default_cost) INTO item_cost_total
            FROM public.product_serial_units AS unit
            WHERE unit.id = v_backorder_unit_id AND unit.tenant_id = v_terminal.tenant_id;
          ELSIF is_serialized_product THEN
            IF v_reservation_item.serial_unit_id IS NULL OR item_quantity <> 1 THEN
              RAISE EXCEPTION 'Serialized reservation line is invalid';
            END IF;
            UPDATE public.product_serial_units
            SET status = 'VENDIDO', sale_id = p_sale_id
            WHERE id = v_reservation_item.serial_unit_id
              AND tenant_id = v_terminal.tenant_id AND product_id = item_product_id
              AND unit_id = v_terminal.unit_id AND status = 'RESERVADO';
            GET DIAGNOSTICS updated_units = ROW_COUNT;
            IF updated_units <> 1 THEN RAISE EXCEPTION 'Reserved serialized unit is no longer available'; END IF;
            item_serials := jsonb_build_array(v_reservation_item.serial_number);
            SELECT COALESCE(unit.unit_cost, item_default_cost) INTO item_cost_total
            FROM public.product_serial_units AS unit
            WHERE unit.id = v_reservation_item.serial_unit_id AND unit.tenant_id = v_terminal.tenant_id;
          ELSE
            IF v_reservation_item.serial_unit_id IS NOT NULL THEN RAISE EXCEPTION 'Non-serialized reservation line contains a serial'; END IF;
          END IF;
        ELSIF is_serialized_product THEN
          PERFORM public.mark_serial_units_sold(
            v_terminal.tenant_id, item_product_id, v_terminal.unit_id, p_sale_id, item_serials, item_quantity
          );
          SELECT COALESCE(SUM(COALESCE(unit.unit_cost, item_default_cost)), 0) INTO item_cost_total
          FROM public.product_serial_units AS unit
          WHERE unit.tenant_id = v_terminal.tenant_id AND unit.product_id = item_product_id
            AND unit.sale_id = p_sale_id AND unit.status = 'VENDIDO'
            AND LOWER(unit.serial_number) IN (
              SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(item_serials) AS value
            );
        END IF;

        IF NOT is_serialized_product THEN
          IF jsonb_typeof(item_serials) = 'array' AND jsonb_array_length(item_serials) > 0 THEN
            RAISE EXCEPTION 'Non-serialized products cannot include serial units';
          END IF;
          SELECT * INTO inv_row FROM public.inventory
          WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'Product % was not found in inventory', item_product_id; END IF;
          current_qty := COALESCE((inv_row.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0);
          IF p_reservation_id IS NULL THEN
            SELECT COALESCE(SUM(reservation_item.quantity), 0)::INTEGER INTO reserved_qty
            FROM public.product_reservation_items AS reservation_item
            JOIN public.product_reservations AS reservation
              ON reservation.tenant_id = reservation_item.tenant_id AND reservation.id = reservation_item.reservation_id
            WHERE reservation_item.tenant_id = v_terminal.tenant_id AND reservation_item.product_id = item_product_id
              AND reservation.unit_id = v_terminal.unit_id AND reservation.status = 'ATIVA'
              AND reservation_item.serial_unit_id IS NULL;
            IF current_qty - reserved_qty < item_quantity THEN
              RAISE EXCEPTION 'Insufficient unreserved stock for product % in store %', item_product_id, v_terminal.unit_id;
            END IF;
          ELSIF current_qty < item_quantity THEN
            RAISE EXCEPTION 'Insufficient physical stock for reserved product %', item_product_id;
          END IF;
          -- Custo medio da loja no momento da venda (inventario ja travado acima).
          item_cost_total := public.get_store_avg_cost(v_terminal.tenant_id, item_product_id, v_terminal.unit_id) * item_quantity;
          UPDATE public.inventory
          SET quantities = jsonb_set(inv_row.quantities, ARRAY[v_terminal.unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = NOW()
          WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id;
        END IF;

        INSERT INTO public.movements (
          id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
          serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
        ) VALUES (
          gen_random_uuid()::TEXT, v_terminal.tenant_id, item_product_id, item->>'variationId',
          v_terminal.unit_id, 'CLIENTE', 'SAIDA', item_quantity, item_serials, item->>'cardCondition',
          v_terminal.id::TEXT, v_terminal.display_name, p_timestamp,
          CASE WHEN p_reservation_id IS NULL THEN 'Venda registrada no PDV' ELSE 'Reserva convertida em venda' END,
          ROUND(item_cost_total / item_quantity, 4)
        );
      ELSE
        RAISE EXCEPTION 'Unsupported sale item type: %', item_type;
      END IF;

      -- Auditoria da liberacao (senha ja validada acima).
      IF p_reservation_id IS NULL AND item_discount > public.pos_item_discount_limit(v_terminal.tenant_id, item, v_max_discount) THEN
        INSERT INTO public.sale_discount_approvals (
          tenant_id, unit_id, terminal_id, cash_session_id, sale_id, item_type,
          product_id, service_id, item_sku, item_name, discount_percent, store_limit_percent
        ) VALUES (
          v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, p_sale_id, item_type,
          item_product_id, item_service_id, item_sku, item_name, item_discount,
          public.pos_item_discount_limit(v_terminal.tenant_id, item, v_max_discount)
        );
      END IF;

      item_cost_total := ROUND(item_cost_total, 2);
      item_unit_cost := ROUND(item_cost_total / item_quantity, 4);
      line_total := ROUND(item_price * item_quantity * (100 - item_discount) / 100, 2);
      calculated_gross := calculated_gross + line_total;
      normalized_items := normalized_items || jsonb_build_array(
        item || jsonb_build_object(
          'itemType', item_type, 'unitPrice', item_price, 'itemSku', item_sku,
          'itemName', item_name, 'discountPercent', item_discount,
          'lineTotal', line_total, 'serials', item_serials,
          'unitCost', item_unit_cost, 'costTotal', item_cost_total
        )
      );
    END LOOP;

    IF ABS(COALESCE(p_gross_amount, 0) - calculated_gross) > 0.01 THEN
      RAISE EXCEPTION 'Sale total does not match item prices and discounts';
    END IF;
    IF COALESCE(p_fee_amount, 0) < 0 OR ABS(COALESCE(p_net_amount, 0) - (p_gross_amount - p_fee_amount)) > 0.01 THEN
      RAISE EXCEPTION 'Invalid sale net amount or fee';
    END IF;
    IF p_reservation_id IS NOT NULL AND v_reservation.deposit_amount > calculated_gross THEN
      RAISE EXCEPTION 'Reservation deposit exceeds the sale total';
    END IF;

    -- ---- Juros do cartao repassados: entram no preco dos itens ----
    -- Divididos proporcionalmente ao valor de cada linha (o centavo que sobra vai
    -- para a maior linha). O item passa a valer o preco com juros: cupom, NFC-e e
    -- relatorios mostram so o novo valor, sem linha de juros.
    IF v_surcharge_total > 0 THEN
      IF calculated_gross <= 0 THEN
        RAISE EXCEPTION 'Card fee cannot be passed on a zero total sale';
      END IF;
      SELECT entries.ordinality INTO v_main_line
      FROM jsonb_array_elements(normalized_items) WITH ORDINALITY AS entries(value, ordinality)
      ORDER BY (entries.value->>'lineTotal')::NUMERIC DESC, entries.ordinality
      LIMIT 1;
      SELECT COALESCE(SUM(ROUND(v_surcharge_total * (entries.value->>'lineTotal')::NUMERIC / calculated_gross, 2)), 0)
      INTO v_share_sum
      FROM jsonb_array_elements(normalized_items) AS entries(value);
      v_surcharged_items := '[]'::JSONB;
      FOR v_entry IN
        SELECT entries.value, entries.ordinality
        FROM jsonb_array_elements(normalized_items) WITH ORDINALITY AS entries(value, ordinality)
        ORDER BY entries.ordinality
      LOOP
        v_share := ROUND(v_surcharge_total * (v_entry.value->>'lineTotal')::NUMERIC / calculated_gross, 2)
          + CASE WHEN v_entry.ordinality = v_main_line THEN v_surcharge_total - v_share_sum ELSE 0 END;
        line_total := (v_entry.value->>'lineTotal')::NUMERIC + v_share;
        item_discount := (v_entry.value->>'discountPercent')::NUMERIC;
        item_quantity := (v_entry.value->>'quantity')::INTEGER;
        v_surcharged_items := v_surcharged_items || jsonb_build_array(
          v_entry.value || jsonb_build_object(
            'unitPrice', CASE WHEN item_discount < 100
              THEN ROUND(line_total * 100 / (item_quantity * (100 - item_discount)), 10)
              ELSE (v_entry.value->>'unitPrice')::NUMERIC END,
            'lineTotal', line_total,
            'cardSurcharge', v_share,
            'priceBeforeCardFee', (v_entry.value->>'unitPrice')::NUMERIC
          )
        );
      END LOOP;
      normalized_items := v_surcharged_items;
    END IF;

    -- ---- Pagamento dividido: soma exata ao centavo ----
    -- Base: total calculado pelo servidor. Em conversao de reserva, o saldo
    -- apos o sinal (o sinal ja entrou no caixa como pos_reservation_payments).
    IF p_payments IS NOT NULL THEN
      v_expected_payment_total := calculated_gross;
      IF p_reservation_id IS NOT NULL THEN
        v_expected_payment_total := calculated_gross - v_reservation.deposit_amount;
      END IF;
      IF v_payment_total <> v_expected_payment_total THEN
        RAISE EXCEPTION 'Payment lines do not match the sale total';
      END IF;

      IF v_payment_count = 1 THEN
        v_payment_method := UPPER(p_payments->0->>'paymentMethod');
      ELSE
        v_payment_method := 'DIVIDIDO';
      END IF;
      FOR payment IN SELECT entries.value FROM jsonb_array_elements(p_payments) AS entries(value) LOOP
        -- Linha com taxa repassada: grava o valor cobrado na maquininha (com juros).
        v_line_surcharge := 0;
        IF COALESCE((payment->>'passFee')::BOOLEAN, FALSE) THEN
          v_line_surcharge := public.pos_card_surcharge(
            (payment->>'amount')::NUMERIC,
            public.pos_card_fee_rate(v_config.card_fee_table, UPPER(payment->>'paymentMethod'),
              COALESCE(NULLIF(payment->>'installments', '')::INTEGER, 1))
          );
        END IF;
        INSERT INTO public.sale_payments (
          tenant_id, unit_id, terminal_id, cash_session_id, sale_id,
          payment_method, amount, installments, created_by_name, surcharge_amount
        ) VALUES (
          v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, p_sale_id,
          UPPER(payment->>'paymentMethod'),
          (payment->>'amount')::NUMERIC + v_line_surcharge,
          COALESCE(NULLIF(payment->>'installments', '')::INTEGER, 1),
          v_terminal.display_name,
          v_line_surcharge
        );
      END LOOP;
    ELSE
      -- Legado: nenhuma lista de pagamentos -> mantem o metodo recebido.
      v_payment_method := p_payment_method;
    END IF;

    UPDATE public.sales
    SET items = normalized_items,
        payment_method = v_payment_method,
        reservation_deposit_applied = CASE WHEN p_reservation_id IS NULL THEN 0 ELSE v_reservation.deposit_amount END,
        -- Total com os juros repassados; liquido = total - taxa do cartao (fee_amount
        -- e somado pela trigger zz_sale_payment_card_fee a cada linha de pagamento).
        gross_amount = calculated_gross + v_surcharge_total,
        net_amount = calculated_gross + v_surcharge_total - fee_amount
    WHERE tenant_id = v_terminal.tenant_id AND id = p_sale_id;

    IF p_reservation_id IS NOT NULL THEN
      UPDATE public.product_reservations
      SET status = 'CONVERTIDA', sale_id = p_sale_id, updated_at = NOW()
      WHERE id = p_reservation_id AND tenant_id = v_terminal.tenant_id AND status = 'ATIVA';
    END IF;

    RETURN jsonb_build_object('status', 'OK');
  END;
  $$;

  -- ---- Devolucao (2.9): devolve o preco SEM os juros do cartao (pedido do usuario) ----
  -- get_pos_sale_returnable e process_pos_sale_return: mesmas assinaturas, copiadas da versao
  -- viva (20261030) trocando so o valor unitario (lineTotal - cardSurcharge).
  -- md5 vivo esperado:
  --   get_pos_sale_returnable  fd5fcc213d38c161e7579d9507ee7234 (LF) / a8723a00d2540c4b63f70fe9c26acfb0 (CRLF)
  --   process_pos_sale_return  d93891d2adc6bf1071257d951aaf0b9d (LF) / c7ef26fac63a1cd609f6473e31b34789 (CRLF)
  CREATE OR REPLACE FUNCTION public.get_pos_sale_returnable(p_sale_id TEXT)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_terminal public.pos_terminals%ROWTYPE;
    v_sale public.sales%ROWTYPE;
    v_days INTEGER;
    v_cpf TEXT;
    v_address_ok BOOLEAN := false;
  BEGIN
    SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Active terminal session required';
    END IF;
    SELECT * INTO v_sale FROM public.sales
    WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND id = p_sale_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT exchange_days INTO v_days FROM public.store_configs
    WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
    v_cpf := NULLIF(regexp_replace(COALESCE(v_sale.client_cpf, ''), '\D', '', 'g'), '');
    IF v_cpf IS NOT NULL THEN
      SELECT (NULLIF(BTRIM(customer.address), '') IS NOT NULL AND NULLIF(BTRIM(customer.address_number), '') IS NOT NULL
        AND NULLIF(BTRIM(customer.district), '') IS NOT NULL AND NULLIF(BTRIM(customer.city), '') IS NOT NULL
        AND NULLIF(BTRIM(customer.state), '') IS NOT NULL AND NULLIF(BTRIM(customer.cep), '') IS NOT NULL)
      INTO v_address_ok
      FROM public.customers AS customer
      WHERE customer.tenant_id = v_terminal.tenant_id AND customer.cpf = v_cpf;
    END IF;

    RETURN jsonb_build_object(
      'saleId', v_sale.id,
      'receiptNumber', v_sale.receipt_number,
      'timestamp', v_sale."timestamp",
      'status', v_sale.status,
      'fiscalStatus', v_sale.fiscal_status,
      'nfceNumber', v_sale.nfce_number,
      'clientCpf', v_cpf,
      'clientName', v_sale.client_name,
      'customerAddressComplete', COALESCE(v_address_ok, false),
      'exchangeDays', COALESCE(v_days, 7),
      'deadline', v_sale."timestamp" + make_interval(days => COALESCE(v_days, 7)),
      'withinPeriod', NOW() <= v_sale."timestamp" + make_interval(days => COALESCE(v_days, 7)),
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'index', entry.idx - 1,
          'itemType', UPPER(COALESCE(entry.item->>'itemType', 'PRODUCT')),
          'productId', entry.item->>'productId',
          'name', entry.item->>'itemName',
          'sku', entry.item->>'itemSku',
          'quantity', COALESCE((entry.item->>'quantity')::INTEGER, 0),
          'unitAmount', ROUND((COALESCE((entry.item->>'lineTotal')::NUMERIC, 0) - COALESCE(NULLIF(entry.item->>'cardSurcharge', '')::NUMERIC, 0)) / NULLIF((entry.item->>'quantity')::NUMERIC, 0), 4),
          'serials', COALESCE(entry.item->'serials', '[]'::JSONB),
          'returnedQuantity', COALESCE((
            SELECT SUM(returned.quantity) FROM public.sale_return_items AS returned
            WHERE returned.tenant_id = v_sale.tenant_id AND returned.sale_id = v_sale.id AND returned.item_index = entry.idx - 1
          ), 0),
          'returnedSerials', COALESCE((
            SELECT jsonb_agg(serial) FROM public.sale_return_items AS returned,
              jsonb_array_elements_text(returned.serials) AS serial
            WHERE returned.tenant_id = v_sale.tenant_id AND returned.sale_id = v_sale.id AND returned.item_index = entry.idx - 1
          ), '[]'::JSONB)
        ) ORDER BY entry.idx)
        FROM jsonb_array_elements(COALESCE(v_sale.items, '[]'::JSONB)) WITH ORDINALITY AS entry(item, idx)
      ), '[]'::JSONB),
      'returns', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'returnId', sale_return.id, 'returnNumber', sale_return.return_number, 'createdAt', sale_return.created_at,
          'refundMethod', sale_return.refund_method, 'totalAmount', sale_return.total_amount,
          'fiscalStatus', sale_return.fiscal_status, 'nfeNumber', sale_return.nfe_number
        ) ORDER BY sale_return.created_at)
        FROM public.sale_returns AS sale_return
        WHERE sale_return.tenant_id = v_sale.tenant_id AND sale_return.sale_id = v_sale.id
      ), '[]'::JSONB)
    );
  END;
  $$;

  CREATE OR REPLACE FUNCTION public.process_pos_sale_return(
    p_sale_id TEXT,
    p_items JSONB,
    p_reason TEXT,
    p_refund_method TEXT,
    p_customer_cpf TEXT DEFAULT NULL,
    p_admin_password TEXT DEFAULT NULL
  )
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_terminal public.pos_terminals%ROWTYPE;
    v_cash public.cash_register_sessions%ROWTYPE;
    v_sale public.sales%ROWTYPE;
    v_days INTEGER;
    v_out_of_period BOOLEAN;
    v_method TEXT := UPPER(COALESCE(p_refund_method, ''));
    v_needs_password BOOLEAN;
    v_password_check JSONB;
    v_cpf TEXT;
    v_customer public.customers%ROWTYPE;
    v_return_id UUID := gen_random_uuid();
    v_return_number INTEGER;
    v_total NUMERIC(12, 2) := 0;
    v_credit_id UUID;
    v_entry JSONB;
    v_item JSONB;
    v_index INTEGER;
    v_quantity INTEGER;
    v_destination TEXT;
    v_serials JSONB;
    v_sold_serials JSONB;
    v_already INTEGER;
    v_product_id TEXT;
    v_is_serialized BOOLEAN;
    v_unit_amount NUMERIC;
    v_line_amount NUMERIC(12, 2);
    v_unit_cost NUMERIC;
    v_updated INTEGER;
    v_inv public.inventory%ROWTYPE;
    v_current_qty INTEGER;
    v_serial TEXT;
  BEGIN
    SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Active terminal session required';
    END IF;
    SELECT * INTO v_cash FROM public.cash_register_sessions
    WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
    ORDER BY opened_at DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Abra o caixa para registrar a devolução';
    END IF;
    IF v_method NOT IN ('TROCA', 'VALE', 'DINHEIRO', 'PIX', 'CREDITO', 'DEBITO') THEN
      RAISE EXCEPTION 'Forma de devolução inválida';
    END IF;
    IF NULLIF(BTRIM(COALESCE(p_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Informe o motivo da troca/devolução';
    END IF;
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'Selecione os itens devolvidos';
    END IF;

    -- Troca so na loja da venda.
    SELECT * INTO v_sale FROM public.sales
    WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND id = p_sale_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Venda não encontrada nesta loja';
    END IF;
    IF v_sale.status <> 'CONCLUIDA' THEN
      RAISE EXCEPTION 'Só vendas concluídas podem ter troca/devolução';
    END IF;

    SELECT exchange_days INTO v_days FROM public.store_configs
    WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
    v_out_of_period := NOW() > v_sale."timestamp" + make_interval(days => COALESCE(v_days, 7));

    -- Cliente: obrigatorio no vale/troca e quando a venda teve NFC-e (a NF-e de devolucao
    -- precisa do CPF e do endereco completo do consumidor).
    v_cpf := NULLIF(regexp_replace(COALESCE(p_customer_cpf, v_sale.client_cpf, ''), '\D', '', 'g'), '');
    IF v_cpf IS NOT NULL THEN
      SELECT * INTO v_customer FROM public.customers WHERE tenant_id = v_terminal.tenant_id AND cpf = v_cpf;
    END IF;
    IF (v_method IN ('TROCA', 'VALE') OR v_sale.fiscal_status = 'AUTORIZADA')
      AND (v_cpf IS NULL OR NOT public.is_valid_cpf(v_cpf)) THEN
      RETURN jsonb_build_object('status', 'CUSTOMER_REQUIRED');
    END IF;
    IF v_sale.fiscal_status = 'AUTORIZADA' AND (
      v_customer.id IS NULL OR NULLIF(BTRIM(v_customer.address), '') IS NULL OR NULLIF(BTRIM(v_customer.address_number), '') IS NULL
      OR NULLIF(BTRIM(v_customer.district), '') IS NULL OR NULLIF(BTRIM(v_customer.city), '') IS NULL
      OR NULLIF(BTRIM(v_customer.state), '') IS NULL OR NULLIF(BTRIM(v_customer.cep), '') IS NULL
    ) THEN
      RETURN jsonb_build_object('status', 'CUSTOMER_ADDRESS_REQUIRED');
    END IF;

    -- Senha: dinheiro saindo (dinheiro, PIX, cartao) ou fora do prazo.
    v_needs_password := v_method IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO') OR v_out_of_period;
    IF v_needs_password THEN
      IF p_admin_password IS NULL OR p_admin_password = '' THEN
        RETURN jsonb_build_object('status', 'PASSWORD_REQUIRED', 'outOfPeriod', v_out_of_period);
      END IF;
      v_password_check := public.check_pos_admin_password(v_terminal.id, p_admin_password, 'SALE_RETURN');
      IF v_password_check->>'status' = 'LOCKED' THEN
        RETURN jsonb_build_object('status', 'LOCKED', 'lockedUntil', v_password_check->'lockedUntil');
      ELSIF v_password_check->>'status' <> 'OK' THEN
        RETURN jsonb_build_object('status', 'INVALID_PASSWORD', 'remainingAttempts', v_password_check->'remainingAttempts');
      END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('sale_return:' || v_terminal.tenant_id::TEXT || ':' || v_terminal.unit_id));
    SELECT COALESCE(MAX(return_number), 0) + 1 INTO v_return_number
    FROM public.sale_returns WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;

    INSERT INTO public.sale_returns (
      id, tenant_id, unit_id, terminal_id, cash_session_id, sale_id, return_number, reason, refund_method,
      total_amount, customer_cpf, customer_name, out_of_period, password_approved, operator_name, fiscal_status
    ) VALUES (
      v_return_id, v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, v_sale.id, v_return_number,
      BTRIM(p_reason), v_method, 0.01, v_cpf, COALESCE(v_customer.name, v_sale.client_name), v_out_of_period,
      v_needs_password, v_terminal.display_name,
      CASE WHEN v_sale.fiscal_status = 'AUTORIZADA' THEN 'PENDENTE' ELSE NULL END
    );

    FOR v_entry IN SELECT value FROM jsonb_array_elements(p_items) LOOP
      v_index := (v_entry->>'index')::INTEGER;
      v_quantity := (v_entry->>'quantity')::INTEGER;
      v_destination := UPPER(COALESCE(v_entry->>'destination', 'ESTOQUE'));
      v_serials := COALESCE(v_entry->'serials', '[]'::JSONB);
      IF v_destination NOT IN ('ESTOQUE', 'AVARIADO') THEN
        RAISE EXCEPTION 'Destino inválido para o item devolvido';
      END IF;
      IF v_index IS NULL OR v_index < 0 OR v_index >= jsonb_array_length(COALESCE(v_sale.items, '[]'::JSONB)) THEN
        RAISE EXCEPTION 'Item inválido na devolução';
      END IF;
      IF v_quantity IS NULL OR v_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantidade inválida na devolução';
      END IF;
      v_item := v_sale.items -> v_index;
      IF UPPER(COALESCE(v_item->>'itemType', 'PRODUCT')) <> 'PRODUCT' THEN
        RAISE EXCEPTION 'Serviços não podem ser devolvidos';
      END IF;
      v_product_id := v_item->>'productId';
      SELECT COALESCE(SUM(quantity), 0) INTO v_already FROM public.sale_return_items
      WHERE tenant_id = v_sale.tenant_id AND sale_id = v_sale.id AND item_index = v_index;
      IF v_already + v_quantity > COALESCE((v_item->>'quantity')::INTEGER, 0) THEN
        RAISE EXCEPTION 'Quantidade devolvida maior que a vendida (%)', v_item->>'itemName';
      END IF;

      SELECT COALESCE(product.is_serialized, false) INTO v_is_serialized
      FROM public.products AS product WHERE product.tenant_id = v_sale.tenant_id AND product.id = v_product_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Produto % não encontrado', v_product_id;
      END IF;

      -- Juros do cartao repassados (20261111) nao voltam ao cliente: devolve o preco sem juros.
      v_unit_amount := (COALESCE((v_item->>'lineTotal')::NUMERIC, 0) - COALESCE(NULLIF(v_item->>'cardSurcharge', '')::NUMERIC, 0)) / NULLIF((v_item->>'quantity')::NUMERIC, 0);
      v_line_amount := ROUND(v_unit_amount * v_quantity, 2);
      -- Custo congelado na venda (o mesmo do estorno); venda antiga sem custo usa a media atual.
      v_unit_cost := COALESCE(
        NULLIF(v_item->>'costTotal', '')::NUMERIC / NULLIF((v_item->>'quantity')::NUMERIC, 0),
        public.get_store_avg_cost(v_sale.tenant_id, v_product_id, v_sale.unit_id)
      );

      IF v_is_serialized THEN
        IF jsonb_typeof(v_serials) <> 'array' OR jsonb_array_length(v_serials) <> v_quantity THEN
          RAISE EXCEPTION 'Informe o serial de cada unidade devolvida (%)', v_item->>'itemName';
        END IF;
        v_sold_serials := COALESCE(v_item->'serials', '[]'::JSONB);
        FOR v_serial IN SELECT value FROM jsonb_array_elements_text(v_serials) LOOP
          IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_sold_serials) AS sold WHERE LOWER(sold) = LOWER(v_serial)) THEN
            RAISE EXCEPTION 'Serial % não pertence a esta venda', v_serial;
          END IF;
        END LOOP;
        UPDATE public.product_serial_units
        SET status = CASE WHEN v_destination = 'AVARIADO' THEN 'AVARIADO' ELSE 'DISPONIVEL' END,
            sale_id = NULL, updated_at = NOW()
        WHERE tenant_id = v_sale.tenant_id AND product_id = v_product_id AND sale_id = v_sale.id
          AND status = 'VENDIDO'
          AND LOWER(serial_number) IN (SELECT LOWER(value) FROM jsonb_array_elements_text(v_serials));
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated <> v_quantity THEN
          RAISE EXCEPTION 'Uma ou mais unidades já foram devolvidas (%)', v_item->>'itemName';
        END IF;
      ELSIF v_destination = 'ESTOQUE' THEN
        SELECT * INTO v_inv FROM public.inventory
        WHERE tenant_id = v_sale.tenant_id AND product_id = v_product_id FOR UPDATE;
        IF NOT FOUND THEN
          INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
          VALUES (v_sale.tenant_id, v_product_id, '{}'::JSONB, NOW());
          SELECT * INTO v_inv FROM public.inventory
          WHERE tenant_id = v_sale.tenant_id AND product_id = v_product_id FOR UPDATE;
        END IF;
        v_inv.quantities := public.inventory_with_unit(v_inv.quantities, v_sale.unit_id);
        v_current_qty := COALESCE((v_inv.quantities -> v_sale.unit_id ->> 'qty')::INTEGER, 0);
        PERFORM public.apply_store_cost_entry(v_sale.tenant_id, v_product_id, v_sale.unit_id, v_current_qty, v_quantity, v_unit_cost);
        UPDATE public.inventory
        SET quantities = jsonb_set(v_inv.quantities, ARRAY[v_sale.unit_id, 'qty'], to_jsonb(v_current_qty + v_quantity), true),
            updated_at = NOW()
        WHERE tenant_id = v_sale.tenant_id AND product_id = v_product_id;
      ELSE
        INSERT INTO public.product_damaged_stock (tenant_id, unit_id, product_id, quantity)
        VALUES (v_sale.tenant_id, v_sale.unit_id, v_product_id, v_quantity)
        ON CONFLICT (tenant_id, unit_id, product_id)
        DO UPDATE SET quantity = public.product_damaged_stock.quantity + EXCLUDED.quantity, updated_at = NOW();
      END IF;

      INSERT INTO public.movements (
        id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
        serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
      ) VALUES (
        gen_random_uuid()::TEXT, v_sale.tenant_id, v_product_id, NULL, 'CLIENTE',
        CASE WHEN v_destination = 'AVARIADO' THEN 'AVARIADOS' ELSE v_sale.unit_id END,
        'ENTRADA', v_quantity, CASE WHEN jsonb_array_length(v_serials) > 0 THEN v_serials ELSE NULL END, NULL,
        v_terminal.id::TEXT, v_terminal.display_name, NOW(),
        'Devolução nº ' || v_return_number || ' da venda (cupom ' || COALESCE(v_sale.receipt_number::TEXT, v_sale.id) || ')'
          || CASE WHEN v_destination = 'AVARIADO' THEN ' - avariado' ELSE '' END,
        ROUND(v_unit_cost, 4)
      );

      INSERT INTO public.sale_return_items (
        tenant_id, return_id, sale_id, item_index, product_id, item_name, item_sku, quantity, serials,
        unit_amount, line_amount, unit_cost, destination
      ) VALUES (
        v_sale.tenant_id, v_return_id, v_sale.id, v_index, v_product_id, COALESCE(v_item->>'itemName', ''),
        v_item->>'itemSku', v_quantity, v_serials, ROUND(v_unit_amount, 4), v_line_amount, ROUND(v_unit_cost, 4), v_destination
      );
      v_total := v_total + v_line_amount;
    END LOOP;

    IF v_total <= 0 THEN
      RAISE EXCEPTION 'Valor da devolução inválido';
    END IF;
    UPDATE public.sale_returns SET total_amount = v_total WHERE id = v_return_id;

    IF v_method IN ('TROCA', 'VALE') THEN
      INSERT INTO public.customer_credits (tenant_id, unit_id, customer_cpf, amount, balance, origin_return_id)
      VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_cpf, v_total, v_total, v_return_id)
      RETURNING id INTO v_credit_id;
      INSERT INTO public.customer_credit_movements (tenant_id, credit_id, kind, amount, return_id)
      VALUES (v_terminal.tenant_id, v_credit_id, 'EMISSAO', v_total, v_return_id);
      UPDATE public.sale_returns SET customer_credit_id = v_credit_id WHERE id = v_return_id;
    END IF;

    RETURN jsonb_build_object(
      'status', 'OK', 'returnId', v_return_id, 'returnNumber', v_return_number,
      'totalAmount', v_total, 'creditId', v_credit_id, 'outOfPeriod', v_out_of_period,
      'needsFiscalNote', v_sale.fiscal_status = 'AUTORIZADA'
    );
  END;
  $$;
