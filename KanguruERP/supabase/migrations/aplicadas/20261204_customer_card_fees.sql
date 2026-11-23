-- =========================================================================
-- Duas tabelas de taxa do cartao (desenho aprovado em 2026-11-22).
--   * Taxa REAL da maquininha: a que ja existe (store_configs.card_fee_table.debito/credito).
--     Continua sendo a gravada em cada pagamento (sale_payments.fee_percent) e descontada do lucro.
--   * Taxa COBRADA DO CLIENTE: nova, dentro da mesma coluna, na chave "cliente"
--     ({"cliente": {"debito": 0, "credito": [2, 3, 4, ... 22]}}). E a usada pela calculadora e pelo
--     "Repassar taxa" do PDV. Linha em branco (null) usa a taxa real; 0 = sem acrescimo.
--   Regra do usuario: Nx = (N + 1)% no credito, debito sem acrescimo. Conta do acrescimo nao muda:
--   valor / (1 - taxa do cliente).
--
-- Nenhuma coluna nova. Muda so:
--   pos_card_real_rate         NOVA (interna): a logica atual de pos_card_fee_rate.
--   pos_card_fee_rate          mesma assinatura: passa a devolver a taxa do CLIENTE (usada pela venda
--                              do PDV so para calcular/conferir o acrescimo).
--   apply_sale_payment_card_fee  trigger dos pagamentos: passa a gravar a taxa REAL (pos_card_real_rate).
--   get_pos_card_fees          PDV recebe so a tabela do cliente (a taxa real nunca chega ao PDV).
-- process_pos_terminal_sale NAO muda.
--
-- ANTES DE APLICAR, conferir md5(prosrc) das 3 funcoes vivas:
--   pos_card_fee_rate            9abb5b0742019f788cbb4ba461fcf0c9 (LF) / 3e4ab5b1179440bb2fbf1f7af04090a4 (CRLF)
--   apply_sale_payment_card_fee  0291ad1c5dc56a515995cade2b2072b9 (LF) / 7992c48f0ce4235cdd1266edae32e2bb (CRLF)
--   get_pos_card_fees            56c6a914a0150136ab56723db39eb321 (LF) / a6d11b375d665f3a96308913284a2dd8 (CRLF)
-- Se algum nao bater, PARAR.
-- =========================================================================

-- Taxa REAL (%) da maquininha para a forma e as parcelas (sem tabela/valor: 0).
CREATE OR REPLACE FUNCTION public.pos_card_real_rate(p_table JSONB, p_method TEXT, p_installments INTEGER)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(CASE
    WHEN p_table IS NULL THEN 0
    WHEN UPPER(p_method) = 'DEBITO' THEN NULLIF(p_table->>'debito', '')::NUMERIC
    WHEN UPPER(p_method) = 'CREDITO' AND p_installments BETWEEN 1 AND 21
      THEN NULLIF(p_table->'credito'->>(p_installments - 1), '')::NUMERIC
  END, 0);
$$;

REVOKE ALL ON FUNCTION public.pos_card_real_rate(JSONB, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

-- Taxa (%) COBRADA DO CLIENTE: a da chave "cliente"; linha sem valor usa a taxa real.
CREATE OR REPLACE FUNCTION public.pos_card_fee_rate(p_table JSONB, p_method TEXT, p_installments INTEGER)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    CASE
      WHEN p_table IS NULL THEN NULL
      WHEN UPPER(p_method) = 'DEBITO' THEN NULLIF(p_table->'cliente'->>'debito', '')::NUMERIC
      WHEN UPPER(p_method) = 'CREDITO' AND p_installments BETWEEN 1 AND 21
        THEN NULLIF(p_table->'cliente'->'credito'->>(p_installments - 1), '')::NUMERIC
    END,
    public.pos_card_real_rate(p_table, p_method, p_installments)
  );
$$;

REVOKE ALL ON FUNCTION public.pos_card_fee_rate(JSONB, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

-- Taxa da maquininha de cada linha de cartao: grava a taxa REAL vigente e soma em
-- sales.fee_amount (o ERP desconta do lucro). Vale para venda online e offline.
-- (Copia da 20261111 trocando so pos_card_fee_rate por pos_card_real_rate.)
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
    SELECT public.pos_card_real_rate(config.card_fee_table, NEW.payment_method, NEW.installments)
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

-- PDV: so a tabela COBRADA DO CLIENTE da loja do terminal (a real nunca sai do servidor).
-- {"debito": 0 | 1.5 | null, "credito": [21 valores ou null]}; null = taxa nao cadastrada; 0 = sem acrescimo.
CREATE OR REPLACE FUNCTION public.get_pos_card_fees()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_table JSONB;
  v_rate NUMERIC;
  v_credit JSONB := '[]'::JSONB;
  v_debit NUMERIC;
  v_count INTEGER;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT card_fee_table INTO v_table
  FROM public.store_configs WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  IF v_table IS NULL THEN
    RETURN NULL;
  END IF;

  -- Debito: valor do cliente (inclusive 0); sem valor, a taxa real (0 vira "nao cadastrada").
  v_debit := NULLIF(v_table->'cliente'->>'debito', '')::NUMERIC;
  IF v_debit IS NULL THEN
    v_debit := NULLIF(public.pos_card_real_rate(v_table, 'DEBITO', 1), 0);
  END IF;

  FOR v_count IN 1..21 LOOP
    v_rate := NULLIF(v_table->'cliente'->'credito'->>(v_count - 1), '')::NUMERIC;
    IF v_rate IS NULL THEN
      v_rate := NULLIF(public.pos_card_real_rate(v_table, 'CREDITO', v_count), 0);
    END IF;
    v_credit := v_credit || jsonb_build_array(v_rate);
  END LOOP;

  RETURN jsonb_build_object('debito', v_debit, 'credito', v_credit);
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_card_fees() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_card_fees() TO authenticated;
