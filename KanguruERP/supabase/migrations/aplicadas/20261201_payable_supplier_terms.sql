-- =========================================================================
-- Contas a pagar: prazos de fornecedor (pedido do usuario em 2026-11-20).
-- Parcelada ganha o intervalo PRAZO: dueDate = data da compra/nota e dayOffsets diz em quantos
-- dias vence cada parcela (7/14, 7/14/21, 30/60/90 ou outro prazo digitado).
-- So troca save_payable_bill (mesma assinatura e retorno); copiada da 20261130 com o trecho novo.
-- Antes de aplicar, md5(prosrc) de save_payable_bill deve ser
-- 1513f22779077424d421977940cbaba1 (LF) ou 38eb9d45e242d76816e44ab702a6ceba (CRLF).
-- =========================================================================

CREATE OR REPLACE FUNCTION public.save_payable_bill(p_id UUID, p_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_name TEXT;
  v_bill public.payable_bills;
  v_unit_id TEXT := NULLIF(BTRIM(p_data->>'unitId'), '');
  v_description TEXT := NULLIF(BTRIM(p_data->>'description'), '');
  v_supplier_id TEXT := NULLIF(BTRIM(p_data->>'supplierId'), '');
  v_supplier_name TEXT := NULLIF(BTRIM(p_data->>'supplierName'), '');
  v_category TEXT := NULLIF(BTRIM(p_data->>'category'), '');
  v_amount NUMERIC;
  v_due DATE;
  v_method TEXT := NULLIF(UPPER(BTRIM(p_data->>'paymentMethod')), '');
  v_barcode TEXT := NULLIF(regexp_replace(COALESCE(p_data->>'barcode', ''), '[^0-9]', '', 'g'), '');
  v_pix TEXT := NULLIF(BTRIM(p_data->>'pixKey'), '');
  v_invoice TEXT := NULLIF(BTRIM(p_data->>'invoiceNumber'), '');
  v_notes TEXT := NULLIF(BTRIM(p_data->>'notes'), '');
  v_mode TEXT := COALESCE(NULLIF(UPPER(BTRIM(p_data->>'mode')), ''), 'UNICA');
  v_count INTEGER;
  v_frequency TEXT := COALESCE(NULLIF(UPPER(BTRIM(p_data->>'frequency')), ''), 'MENSAL');
  v_months_ahead INTEGER;
  v_each NUMERIC;
  v_installment_amount NUMERIC;
  v_group UUID;
  v_rec_id UUID;
  v_ids UUID[] := ARRAY[]::UUID[];
  v_offsets INTEGER[];
  v_new_id UUID;
  i INTEGER;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Sessão do ERP necessária';
  END IF;

  BEGIN
    v_amount := ROUND((p_data->>'amount')::NUMERIC, 2);
    v_due := (p_data->>'dueDate')::DATE;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Valor ou vencimento inválido';
  END;

  IF v_unit_id IS NULL THEN
    RAISE EXCEPTION 'Escolha a loja';
  END IF;
  IF v_description IS NULL OR LENGTH(v_description) > 120 THEN
    RAISE EXCEPTION 'Informe a descrição (até 120 caracteres)';
  END IF;
  IF v_category IS NULL OR LENGTH(v_category) > 60 THEN
    RAISE EXCEPTION 'Informe a categoria';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Informe um valor maior que zero';
  END IF;
  IF v_due IS NULL THEN
    RAISE EXCEPTION 'Informe o vencimento';
  END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('BOLETO', 'PIX', 'TRANSFERENCIA', 'CARTAO', 'DINHEIRO', 'DEBITO_AUTOMATICO') THEN
    RAISE EXCEPTION 'Forma de pagamento inválida';
  END IF;
  IF v_barcode IS NOT NULL AND LENGTH(v_barcode) NOT IN (44, 47, 48) THEN
    RAISE EXCEPTION 'Código de barras inválido: são 44, 47 ou 48 números';
  END IF;

  v_name := public.payable_actor(v_unit_id);

  -- Fornecedor do cadastro: o nome vem dele.
  IF v_supplier_id IS NOT NULL THEN
    SELECT name INTO v_supplier_name FROM public.suppliers WHERE tenant_id = v_tenant_id AND id = v_supplier_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fornecedor não encontrado';
    END IF;
  END IF;

  -- Edicao de uma conta em aberto.
  IF p_id IS NOT NULL THEN
    v_bill := public.payable_lock_bill(p_id);
    IF v_bill.status <> 'PENDENTE' THEN
      RAISE EXCEPTION 'Só é possível editar uma conta em aberto';
    END IF;
    IF v_bill.unit_id <> v_unit_id THEN
      PERFORM public.payable_actor(v_bill.unit_id);
    END IF;
    UPDATE public.payable_bills SET
      unit_id = v_unit_id, description = v_description, supplier_id = v_supplier_id,
      supplier_name = v_supplier_name, category = v_category, amount = v_amount, due_date = v_due,
      payment_method = v_method, barcode = v_barcode, pix_key = v_pix, invoice_number = v_invoice,
      notes = v_notes, updated_at = NOW()
    WHERE id = p_id;
    RETURN jsonb_build_object('ids', jsonb_build_array(p_id));
  END IF;

  IF v_mode = 'PARCELADA' THEN
    IF v_frequency = 'PRAZO' THEN
      -- Prazo do fornecedor (ex.: 7/14, 30/60/90): dueDate = data da compra e cada parcela
      -- vence N dias depois dela.
      BEGIN
        SELECT array_agg(value::INTEGER ORDER BY ordinality) INTO v_offsets
        FROM jsonb_array_elements_text(p_data->'dayOffsets') WITH ORDINALITY;
      EXCEPTION WHEN OTHERS THEN
        v_offsets := NULL;
      END;
      v_count := COALESCE(array_length(v_offsets, 1), 0);
      IF v_count < 2 OR v_count > 24 THEN
        RAISE EXCEPTION 'Informe o prazo com 2 a 24 parcelas (ex.: 30/60/90)';
      END IF;
      FOR i IN 1..v_count LOOP
        IF v_offsets[i] < 0 OR v_offsets[i] > 720 OR (i > 1 AND v_offsets[i] <= v_offsets[i - 1]) THEN
          RAISE EXCEPTION 'Prazo inválido: os dias precisam ser crescentes, de 0 a 720';
        END IF;
      END LOOP;
    ELSE
      BEGIN
        v_count := (p_data->>'installments')::INTEGER;
      EXCEPTION WHEN OTHERS THEN
        v_count := NULL;
      END;
      IF v_count IS NULL OR v_count < 2 OR v_count > 48 THEN
        RAISE EXCEPTION 'Informe de 2 a 48 parcelas';
      END IF;
      IF v_frequency NOT IN ('MENSAL', 'QUINZENAL', 'SEMANAL') THEN
        RAISE EXCEPTION 'Frequência das parcelas inválida';
      END IF;
    END IF;
    IF COALESCE((p_data->>'amountIsTotal')::BOOLEAN, true) THEN
      v_each := TRUNC(v_amount / v_count, 2);
      IF v_each <= 0 THEN
        RAISE EXCEPTION 'Valor pequeno demais para dividir em % parcelas', v_count;
      END IF;
    ELSE
      v_each := v_amount;
    END IF;
    v_group := gen_random_uuid();
    FOR i IN 1..v_count LOOP
      -- A ultima parcela fica com os centavos que sobram da divisao.
      v_installment_amount := CASE
        WHEN COALESCE((p_data->>'amountIsTotal')::BOOLEAN, true) AND i = v_count THEN v_amount - v_each * (v_count - 1)
        ELSE v_each
      END;
      INSERT INTO public.payable_bills (
        tenant_id, unit_id, description, supplier_id, supplier_name, category, amount, due_date,
        payment_method, barcode, pix_key, invoice_number, notes, installment_group,
        installment_number, installment_total, created_by_name
      ) VALUES (
        v_tenant_id, v_unit_id, v_description, v_supplier_id, v_supplier_name, v_category,
        v_installment_amount,
        CASE v_frequency
          WHEN 'PRAZO' THEN v_due + v_offsets[i]
          WHEN 'SEMANAL' THEN v_due + (i - 1) * 7
          WHEN 'QUINZENAL' THEN v_due + (i - 1) * 15
          ELSE (v_due + make_interval(months => i - 1))::DATE
        END,
        v_method, CASE WHEN i = 1 THEN v_barcode END, v_pix, v_invoice, v_notes, v_group,
        i, v_count, v_name
      ) RETURNING id INTO v_new_id;
      v_ids := v_ids || v_new_id;
    END LOOP;
    RETURN jsonb_build_object('ids', to_jsonb(v_ids));
  END IF;

  IF v_mode = 'RECORRENTE' THEN
    BEGIN
      v_months_ahead := (p_data->>'monthsAhead')::INTEGER;
    EXCEPTION WHEN OTHERS THEN
      v_months_ahead := NULL;
    END;
    IF v_months_ahead IS NULL OR v_months_ahead < 1 OR v_months_ahead > 12 THEN
      RAISE EXCEPTION 'Escolha de 1 a 12 meses à frente';
    END IF;
    INSERT INTO public.payable_recurrences (
      tenant_id, unit_id, description, supplier_id, supplier_name, category, amount,
      payment_method, pix_key, notes, due_day, start_month, months_ahead, created_by_name
    ) VALUES (
      v_tenant_id, v_unit_id, v_description, v_supplier_id, v_supplier_name, v_category, v_amount,
      v_method, v_pix, v_notes, EXTRACT(DAY FROM v_due)::INTEGER, date_trunc('month', v_due)::DATE,
      v_months_ahead, v_name
    ) RETURNING id INTO v_rec_id;
    PERFORM public.payable_generate_recurrence(v_rec_id);
    -- Codigo de barras, nota e observacao digitados valem so para a primeira conta.
    UPDATE public.payable_bills SET barcode = v_barcode, invoice_number = v_invoice
    WHERE recurrence_id = v_rec_id AND recurrence_month = date_trunc('month', v_due)::DATE;
    SELECT COALESCE(array_agg(id ORDER BY due_date), ARRAY[]::UUID[]) INTO v_ids
    FROM public.payable_bills WHERE recurrence_id = v_rec_id;
    RETURN jsonb_build_object('ids', to_jsonb(v_ids), 'recurrenceId', v_rec_id);
  END IF;

  IF v_mode <> 'UNICA' THEN
    RAISE EXCEPTION 'Tipo de conta inválido';
  END IF;

  INSERT INTO public.payable_bills (
    tenant_id, unit_id, description, supplier_id, supplier_name, category, amount, due_date,
    payment_method, barcode, pix_key, invoice_number, notes, created_by_name
  ) VALUES (
    v_tenant_id, v_unit_id, v_description, v_supplier_id, v_supplier_name, v_category, v_amount, v_due,
    v_method, v_barcode, v_pix, v_invoice, v_notes, v_name
  ) RETURNING id INTO v_new_id;
  RETURN jsonb_build_object('ids', jsonb_build_array(v_new_id));
END;
$$;

REVOKE ALL ON FUNCTION public.save_payable_bill(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_payable_bill(UUID, JSONB) TO authenticated;
