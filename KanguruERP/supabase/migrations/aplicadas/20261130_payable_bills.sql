-- =========================================================================
-- Contas a pagar (desenho aprovado em 2026-11-19).
-- Livro Caixa & DRE ganha a aba "Contas a pagar": conta unica, parcelada (mensal, quinzenal,
-- semanal) ou que se repete todo mes (o ERP mantem criadas de 1 a 12 meses a frente, escolha
-- do usuario). Ao dar baixa, a conta VIRA UMA DESPESA (public.expenses) na data do pagamento:
-- Lucro Real Operacional, DRE e Painel da Rede continuam lendo expenses como hoje (regime de
-- caixa). Desfazer a baixa apaga essa despesa. Anexo (PDF/foto) no bucket privado
-- "payable-attachments". Os lembretes antigos de Fornecedores (supplier_invoices) estavam
-- vazios: a tabela fica, so a tela sai.
-- Aditiva: 2 tabelas novas (leitura pela RLS da loja, escrita so pelas RPCs), funcoes novas,
-- bucket e politicas do Storage. Nenhuma funcao existente muda.
-- Conferido no banco em 2026-11-19: expenses (id TEXT PK, unit_id, description, category,
-- amount, operator_id, operator_name, timestamp, created_at, tenant_id; gatilho
-- enforce_current_tenant_trigger), store_configs PK (tenant_id, unit_id), supplier_invoices
-- com 0 linhas, tabela e bucket novos ainda nao existiam.
-- =========================================================================

-- ---- 1. Tabelas ----
CREATE TABLE IF NOT EXISTS public.payable_recurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  description TEXT NOT NULL,
  supplier_id TEXT,
  supplier_name TEXT,
  category TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_method TEXT,
  pix_key TEXT,
  notes TEXT,
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  start_month DATE NOT NULL, -- primeiro dia do mes da primeira conta
  months_ahead INTEGER NOT NULL DEFAULT 1 CHECK (months_ahead BETWEEN 1 AND 12),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payable_recurrences_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT,
  CONSTRAINT payable_recurrences_method_check CHECK (payment_method IS NULL OR payment_method IN
    ('BOLETO', 'PIX', 'TRANSFERENCIA', 'CARTAO', 'DINHEIRO', 'DEBITO_AUTOMATICO'))
);

CREATE INDEX IF NOT EXISTS payable_recurrences_tenant_idx ON public.payable_recurrences (tenant_id, is_active);

CREATE TABLE IF NOT EXISTS public.payable_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  description TEXT NOT NULL,
  supplier_id TEXT,
  supplier_name TEXT,
  category TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  due_date DATE NOT NULL,
  payment_method TEXT,
  barcode TEXT,
  pix_key TEXT,
  invoice_number TEXT,
  notes TEXT,
  attachment_path TEXT,
  attachment_name TEXT,
  installment_group UUID,
  installment_number INTEGER,
  installment_total INTEGER,
  recurrence_id UUID REFERENCES public.payable_recurrences(id) ON DELETE SET NULL,
  recurrence_month DATE,
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'PAGO', 'CANCELADO')),
  paid_at DATE,
  paid_amount NUMERIC(12, 2),
  paid_method TEXT,
  paid_by_name TEXT,
  expense_id TEXT,
  cancelled_at TIMESTAMPTZ,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payable_bills_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT,
  CONSTRAINT payable_bills_method_check CHECK (payment_method IS NULL OR payment_method IN
    ('BOLETO', 'PIX', 'TRANSFERENCIA', 'CARTAO', 'DINHEIRO', 'DEBITO_AUTOMATICO')),
  CONSTRAINT payable_bills_paid_method_check CHECK (paid_method IS NULL OR paid_method IN
    ('BOLETO', 'PIX', 'TRANSFERENCIA', 'CARTAO', 'DINHEIRO', 'DEBITO_AUTOMATICO')),
  CONSTRAINT payable_bills_recurrence_month_key UNIQUE (recurrence_id, recurrence_month)
);

CREATE INDEX IF NOT EXISTS payable_bills_due_idx ON public.payable_bills (tenant_id, unit_id, due_date);
CREATE INDEX IF NOT EXISTS payable_bills_status_idx ON public.payable_bills (tenant_id, status);

ALTER TABLE public.payable_recurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payable_bills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payable_recurrences_read ON public.payable_recurrences;
CREATE POLICY payable_recurrences_read ON public.payable_recurrences FOR SELECT TO authenticated
  USING (public.current_user_has_store_access(tenant_id, unit_id));

DROP POLICY IF EXISTS payable_bills_read ON public.payable_bills;
CREATE POLICY payable_bills_read ON public.payable_bills FOR SELECT TO authenticated
  USING (public.current_user_has_store_access(tenant_id, unit_id));

REVOKE ALL ON public.payable_recurrences FROM PUBLIC, anon;
REVOKE ALL ON public.payable_bills FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payable_recurrences FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payable_bills FROM authenticated;
GRANT SELECT ON public.payable_recurrences TO authenticated;
GRANT SELECT ON public.payable_bills TO authenticated;

-- ---- 2. Funcoes internas (sem GRANT) ----

-- Hoje no horario do Brasil (o servidor roda em UTC).
CREATE OR REPLACE FUNCTION public.payable_today()
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE;
$$;

-- Vencimento do mes: dia escolhido ou o ultimo dia do mes (31 em fevereiro = 28/29).
CREATE OR REPLACE FUNCTION public.payable_month_due(p_month DATE, p_day INTEGER)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT make_date(
    EXTRACT(YEAR FROM p_month)::INTEGER,
    EXTRACT(MONTH FROM p_month)::INTEGER,
    LEAST(p_day, EXTRACT(DAY FROM (date_trunc('month', p_month) + INTERVAL '1 month - 1 day'))::INTEGER)
  );
$$;

-- Usuario do ERP com acesso a loja: devolve o nome (para "criado/pago por").
CREATE OR REPLACE FUNCTION public.payable_actor(p_unit_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_name TEXT;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Sessão do ERP necessária';
  END IF;
  IF p_unit_id IS NULL OR NOT public.current_user_has_store_access(v_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;
  SELECT display_name INTO v_name FROM public.app_users WHERE auth_uid = auth.uid() AND tenant_id = v_tenant_id;
  RETURN COALESCE(NULLIF(BTRIM(v_name), ''), 'Usuário do ERP');
END;
$$;

-- Le e trava a conta da empresa do usuario (com acesso a loja da conta).
CREATE OR REPLACE FUNCTION public.payable_lock_bill(p_id UUID)
RETURNS public.payable_bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_bill public.payable_bills;
BEGIN
  SELECT * INTO v_bill FROM public.payable_bills
  WHERE id = p_id AND tenant_id = v_tenant_id
  FOR UPDATE;
  IF NOT FOUND OR NOT public.current_user_has_store_access(v_bill.tenant_id, v_bill.unit_id) THEN
    RAISE EXCEPTION 'Conta não encontrada';
  END IF;
  RETURN v_bill;
END;
$$;

-- Cria as contas que faltam de uma repeticao: do mes inicial ate N meses a frente do mes atual.
-- Conta cancelada ou excluida (vira cancelada) nao volta: a chave (repeticao, mes) ja existe.
CREATE OR REPLACE FUNCTION public.payable_generate_recurrence(p_recurrence_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec public.payable_recurrences;
  v_month DATE;
  v_last DATE;
  v_created INTEGER := 0;
  v_rows INTEGER;
BEGIN
  SELECT * INTO v_rec FROM public.payable_recurrences WHERE id = p_recurrence_id;
  IF NOT FOUND OR NOT v_rec.is_active THEN
    RETURN 0;
  END IF;

  v_month := date_trunc('month', v_rec.start_month)::DATE;
  v_last := (GREATEST(v_month, date_trunc('month', public.payable_today())::DATE)
    + make_interval(months => v_rec.months_ahead - 1))::DATE;

  WHILE v_month <= v_last LOOP
    INSERT INTO public.payable_bills (
      tenant_id, unit_id, description, supplier_id, supplier_name, category, amount, due_date,
      payment_method, pix_key, notes, recurrence_id, recurrence_month, created_by_name
    ) VALUES (
      v_rec.tenant_id, v_rec.unit_id, v_rec.description, v_rec.supplier_id, v_rec.supplier_name,
      v_rec.category, v_rec.amount, public.payable_month_due(v_month, v_rec.due_day),
      v_rec.payment_method, v_rec.pix_key, v_rec.notes, v_rec.id, v_month, v_rec.created_by_name
    )
    ON CONFLICT (recurrence_id, recurrence_month) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_created := v_created + v_rows;
    v_month := (v_month + INTERVAL '1 month')::DATE;
  END LOOP;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.payable_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payable_month_due(DATE, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payable_actor(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payable_lock_bill(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payable_generate_recurrence(UUID) FROM PUBLIC, anon, authenticated;

-- ---- 3. RPCs do ERP ----

-- Cria (unica, parcelada ou que se repete) ou edita uma conta em aberto.
-- p_data: unitId, description, supplierId, supplierName, category, amount, dueDate,
-- paymentMethod, barcode, pixKey, invoiceNumber, notes; na criacao tambem mode
-- (UNICA | PARCELADA | RECORRENTE), installments (2-48), frequency (MENSAL | QUINZENAL |
-- SEMANAL), amountIsTotal (parcelada: valor e o total, dividido nas parcelas) e monthsAhead (1-12).
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

-- Baixa: a conta vira uma despesa na data do pagamento (entra no Lucro Real Operacional).
CREATE OR REPLACE FUNCTION public.pay_payable_bill(p_id UUID, p_paid_at DATE, p_paid_amount NUMERIC, p_method TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.payable_bills;
  v_name TEXT;
  v_amount NUMERIC := ROUND(p_paid_amount, 2);
  v_method TEXT := NULLIF(UPPER(BTRIM(p_method)), '');
  v_expense_id TEXT;
  v_description TEXT;
BEGIN
  v_bill := public.payable_lock_bill(p_id);
  IF v_bill.status <> 'PENDENTE' THEN
    RAISE EXCEPTION 'Esta conta não está em aberto';
  END IF;
  IF p_paid_at IS NULL OR p_paid_at > public.payable_today() THEN
    RAISE EXCEPTION 'Informe a data do pagamento (não pode ser no futuro)';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Informe o valor pago';
  END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('BOLETO', 'PIX', 'TRANSFERENCIA', 'CARTAO', 'DINHEIRO', 'DEBITO_AUTOMATICO') THEN
    RAISE EXCEPTION 'Forma de pagamento inválida';
  END IF;

  v_name := public.payable_actor(v_bill.unit_id);
  v_expense_id := 'payable-' || v_bill.id::TEXT;
  v_description := LEFT(v_bill.description
    || CASE WHEN v_bill.installment_total IS NOT NULL THEN ' (parcela ' || v_bill.installment_number || '/' || v_bill.installment_total || ')' ELSE '' END
    || CASE WHEN v_bill.supplier_name IS NOT NULL THEN ' - ' || v_bill.supplier_name ELSE '' END, 200);

  INSERT INTO public.expenses AS e (id, tenant_id, unit_id, description, category, amount, operator_id, operator_name, "timestamp")
  VALUES (
    v_expense_id, v_bill.tenant_id, v_bill.unit_id, v_description, v_bill.category, v_amount,
    auth.uid()::TEXT, v_name, (p_paid_at::TIMESTAMP + TIME '12:00') AT TIME ZONE 'America/Sao_Paulo'
  )
  ON CONFLICT (id) DO UPDATE SET
    description = EXCLUDED.description, category = EXCLUDED.category, amount = EXCLUDED.amount,
    operator_id = EXCLUDED.operator_id, operator_name = EXCLUDED.operator_name, "timestamp" = EXCLUDED."timestamp"
  WHERE e.tenant_id = EXCLUDED.tenant_id;

  UPDATE public.payable_bills SET
    status = 'PAGO', paid_at = p_paid_at, paid_amount = v_amount,
    paid_method = COALESCE(v_method, v_bill.payment_method), paid_by_name = v_name,
    expense_id = v_expense_id, updated_at = NOW()
  WHERE id = v_bill.id;

  RETURN jsonb_build_object('status', 'PAGO', 'expenseId', v_expense_id);
END;
$$;

-- Desfaz a baixa: a despesa sai e a conta volta a ficar em aberto.
CREATE OR REPLACE FUNCTION public.undo_payable_payment(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.payable_bills;
BEGIN
  v_bill := public.payable_lock_bill(p_id);
  IF v_bill.status <> 'PAGO' THEN
    RAISE EXCEPTION 'Esta conta não está paga';
  END IF;
  PERFORM public.payable_actor(v_bill.unit_id);
  IF v_bill.expense_id IS NOT NULL THEN
    DELETE FROM public.expenses WHERE id = v_bill.expense_id AND tenant_id = v_bill.tenant_id;
  END IF;
  UPDATE public.payable_bills SET
    status = 'PENDENTE', paid_at = NULL, paid_amount = NULL, paid_method = NULL,
    paid_by_name = NULL, expense_id = NULL, updated_at = NOW()
  WHERE id = v_bill.id;
END;
$$;

-- Cancela (ou reabre) uma conta em aberto. Conta paga: desfazer a baixa antes.
CREATE OR REPLACE FUNCTION public.set_payable_bill_cancelled(p_id UUID, p_cancelled BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.payable_bills;
BEGIN
  v_bill := public.payable_lock_bill(p_id);
  PERFORM public.payable_actor(v_bill.unit_id);
  IF p_cancelled THEN
    IF v_bill.status <> 'PENDENTE' THEN
      RAISE EXCEPTION 'Só é possível cancelar uma conta em aberto';
    END IF;
    UPDATE public.payable_bills SET status = 'CANCELADO', cancelled_at = NOW(), updated_at = NOW() WHERE id = v_bill.id;
  ELSE
    IF v_bill.status <> 'CANCELADO' THEN
      RAISE EXCEPTION 'Esta conta não está cancelada';
    END IF;
    UPDATE public.payable_bills SET status = 'PENDENTE', cancelled_at = NULL, updated_at = NOW() WHERE id = v_bill.id;
  END IF;
END;
$$;

-- Exclui de vez (so o dono). Conta paga leva a despesa junto. Conta de uma repeticao ativa
-- fica cancelada (senao o ERP criaria de novo no proximo acesso).
CREATE OR REPLACE FUNCTION public.delete_payable_bill(p_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.payable_bills;
  v_active_recurrence BOOLEAN := false;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o dono da empresa pode excluir contas';
  END IF;
  v_bill := public.payable_lock_bill(p_id);
  IF v_bill.expense_id IS NOT NULL THEN
    DELETE FROM public.expenses WHERE id = v_bill.expense_id AND tenant_id = v_bill.tenant_id;
  END IF;
  IF v_bill.recurrence_id IS NOT NULL THEN
    SELECT is_active INTO v_active_recurrence FROM public.payable_recurrences WHERE id = v_bill.recurrence_id;
  END IF;
  IF COALESCE(v_active_recurrence, false) THEN
    UPDATE public.payable_bills SET
      status = 'CANCELADO', cancelled_at = NOW(), paid_at = NULL, paid_amount = NULL,
      paid_method = NULL, paid_by_name = NULL, expense_id = NULL, updated_at = NOW()
    WHERE id = v_bill.id;
    RETURN 'CANCELADA';
  END IF;
  DELETE FROM public.payable_bills WHERE id = v_bill.id;
  RETURN 'EXCLUIDA';
END;
$$;

-- Cria as contas que faltam das repeticoes ativas das lojas do usuario (chamada ao abrir a tela).
CREATE OR REPLACE FUNCTION public.ensure_payable_recurrences()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_rec RECORD;
  v_total INTEGER := 0;
BEGIN
  IF v_tenant_id IS NULL THEN
    RETURN 0;
  END IF;
  FOR v_rec IN
    SELECT id FROM public.payable_recurrences
    WHERE tenant_id = v_tenant_id AND is_active
      AND public.current_user_has_store_access(tenant_id, unit_id)
  LOOP
    v_total := v_total + public.payable_generate_recurrence(v_rec.id);
  END LOOP;
  RETURN v_total;
END;
$$;

-- Edita uma repeticao. As contas em aberto que ainda nao venceram passam a usar os dados novos;
-- "parar de repetir" (isActive false) cancela essas contas futuras em aberto.
-- p_data: description, supplierId, supplierName, category, amount, paymentMethod, pixKey, notes,
-- dueDay, monthsAhead, isActive.
CREATE OR REPLACE FUNCTION public.save_payable_recurrence(p_id UUID, p_data JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_rec public.payable_recurrences;
  v_description TEXT := NULLIF(BTRIM(p_data->>'description'), '');
  v_supplier_id TEXT := NULLIF(BTRIM(p_data->>'supplierId'), '');
  v_supplier_name TEXT := NULLIF(BTRIM(p_data->>'supplierName'), '');
  v_category TEXT := NULLIF(BTRIM(p_data->>'category'), '');
  v_method TEXT := NULLIF(UPPER(BTRIM(p_data->>'paymentMethod')), '');
  v_pix TEXT := NULLIF(BTRIM(p_data->>'pixKey'), '');
  v_notes TEXT := NULLIF(BTRIM(p_data->>'notes'), '');
  v_amount NUMERIC;
  v_due_day INTEGER;
  v_months_ahead INTEGER;
  v_active BOOLEAN := COALESCE((p_data->>'isActive')::BOOLEAN, true);
  v_today DATE := public.payable_today();
BEGIN
  SELECT * INTO v_rec FROM public.payable_recurrences WHERE id = p_id AND tenant_id = v_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Repetição não encontrada';
  END IF;
  PERFORM public.payable_actor(v_rec.unit_id);

  BEGIN
    v_amount := ROUND((p_data->>'amount')::NUMERIC, 2);
    v_due_day := (p_data->>'dueDay')::INTEGER;
    v_months_ahead := (p_data->>'monthsAhead')::INTEGER;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Valor, dia ou meses inválidos';
  END;

  IF v_description IS NULL OR LENGTH(v_description) > 120 THEN
    RAISE EXCEPTION 'Informe a descrição (até 120 caracteres)';
  END IF;
  IF v_category IS NULL OR LENGTH(v_category) > 60 THEN
    RAISE EXCEPTION 'Informe a categoria';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Informe um valor maior que zero';
  END IF;
  IF v_due_day IS NULL OR v_due_day < 1 OR v_due_day > 31 THEN
    RAISE EXCEPTION 'Dia do vencimento inválido';
  END IF;
  IF v_months_ahead IS NULL OR v_months_ahead < 1 OR v_months_ahead > 12 THEN
    RAISE EXCEPTION 'Escolha de 1 a 12 meses à frente';
  END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('BOLETO', 'PIX', 'TRANSFERENCIA', 'CARTAO', 'DINHEIRO', 'DEBITO_AUTOMATICO') THEN
    RAISE EXCEPTION 'Forma de pagamento inválida';
  END IF;
  IF v_supplier_id IS NOT NULL THEN
    SELECT name INTO v_supplier_name FROM public.suppliers WHERE tenant_id = v_tenant_id AND id = v_supplier_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fornecedor não encontrado';
    END IF;
  END IF;

  UPDATE public.payable_recurrences SET
    description = v_description, supplier_id = v_supplier_id, supplier_name = v_supplier_name,
    category = v_category, amount = v_amount, payment_method = v_method, pix_key = v_pix,
    notes = v_notes, due_day = v_due_day, months_ahead = v_months_ahead, is_active = v_active,
    -- Reativada: recomeca no mes atual (nao cria os meses em que ficou parada).
    start_month = CASE WHEN NOT v_rec.is_active AND v_active
      THEN GREATEST(start_month, date_trunc('month', v_today)::DATE) ELSE start_month END,
    updated_at = NOW()
  WHERE id = p_id;

  IF v_active THEN
    UPDATE public.payable_bills SET
      description = v_description, supplier_id = v_supplier_id, supplier_name = v_supplier_name,
      category = v_category, amount = v_amount, payment_method = v_method, pix_key = v_pix,
      notes = v_notes, due_date = public.payable_month_due(recurrence_month, v_due_day), updated_at = NOW()
    WHERE recurrence_id = p_id AND status = 'PENDENTE' AND due_date >= v_today
      AND public.payable_month_due(recurrence_month, v_due_day) >= v_today;
    PERFORM public.payable_generate_recurrence(p_id);
  ELSE
    UPDATE public.payable_bills SET status = 'CANCELADO', cancelled_at = NOW(), updated_at = NOW()
    WHERE recurrence_id = p_id AND status = 'PENDENTE' AND due_date > v_today;
  END IF;
END;
$$;

-- Guarda (ou limpa) o anexo da conta. O arquivo e enviado antes pelo ERP no caminho
-- <empresa>/<conta>/<arquivo> do bucket privado.
CREATE OR REPLACE FUNCTION public.set_payable_attachment(p_id UUID, p_path TEXT, p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.payable_bills;
BEGIN
  v_bill := public.payable_lock_bill(p_id);
  PERFORM public.payable_actor(v_bill.unit_id);
  IF p_path IS NOT NULL AND p_path NOT LIKE v_bill.tenant_id::TEXT || '/' || v_bill.id::TEXT || '/%' THEN
    RAISE EXCEPTION 'Caminho do anexo inválido';
  END IF;
  UPDATE public.payable_bills SET
    attachment_path = p_path,
    attachment_name = CASE WHEN p_path IS NULL THEN NULL ELSE LEFT(COALESCE(NULLIF(BTRIM(p_name), ''), 'anexo'), 120) END,
    updated_at = NOW()
  WHERE id = v_bill.id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_payable_bill(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_payable_bill(UUID, DATE, NUMERIC, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.undo_payable_payment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_payable_bill_cancelled(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_payable_bill(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ensure_payable_recurrences() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_payable_recurrence(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_payable_attachment(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_payable_bill(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_payable_bill(UUID, DATE, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.undo_payable_payment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_payable_bill_cancelled(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_payable_bill(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_payable_recurrences() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_payable_recurrence(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_payable_attachment(UUID, TEXT, TEXT) TO authenticated;

-- ---- 4. Anexos (bucket privado) ----
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('payable-attachments', 'payable-attachments', false, 10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Arquivo em <empresa>/<conta>/...: so quem enxerga a conta (empresa + loja) le, envia ou apaga.
CREATE OR REPLACE FUNCTION public.payable_file_allowed(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant TEXT := split_part(p_name, '/', 1);
  v_bill TEXT := split_part(p_name, '/', 2);
BEGIN
  IF v_tenant <> COALESCE(public.current_user_tenant_id()::TEXT, '')
     OR v_bill !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.payable_bills
    WHERE id = v_bill::UUID AND tenant_id::TEXT = v_tenant
      AND public.current_user_has_store_access(tenant_id, unit_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.payable_file_allowed(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payable_file_allowed(TEXT) TO authenticated;

DROP POLICY IF EXISTS payable_attachments_read ON storage.objects;
CREATE POLICY payable_attachments_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'payable-attachments' AND public.payable_file_allowed(name));

DROP POLICY IF EXISTS payable_attachments_insert ON storage.objects;
CREATE POLICY payable_attachments_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payable-attachments' AND public.payable_file_allowed(name));

DROP POLICY IF EXISTS payable_attachments_delete ON storage.objects;
CREATE POLICY payable_attachments_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'payable-attachments' AND public.payable_file_allowed(name));
