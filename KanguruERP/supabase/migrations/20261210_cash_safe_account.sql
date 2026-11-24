-- =========================================================================
-- Caixa e Bancos: conta "Cofre" (desenho aprovado em 2026-11-23).
-- Furo da 20261209: a gaveta vale o que foi CONTADO no fechamento, então o dinheiro das
-- sangrias sumia do sistema. Agora:
--   - sangria do PDV entra sozinha no Cofre (exceto a sangria da Troca: dinheiro que saiu
--     para o cliente, motivo começando com "Troca");
--   - suprimento do PDV sai sozinho do Cofre;
--   - dinheiro (contas pagas/recebidas) passa a ir para o Cofre por padrão.
-- Do Cofre o dono lança a transferência para a Stone (depósito) ou a retirada do sócio.
-- Só troca 3 funções criadas pela 20261209 (mesma assinatura e retorno). Nenhuma tabela muda.
-- md5 vivos esperados (versão da 20261209), LF / CRLF:
--   cash_settings_resolved  05416480b12666c6de65f86ef25484c3 / 73720f43f9dd456e8777f7dac65ee2fb
--   save_cash_settings      b1cfa1f152d0fc13fe897171aa27f165 / 3cf356d6a76c026565827e3c1e914af9
--   get_cash_overview       a3e4825eef9b3d9fe00a2a6d84ff35a5 / 6f54dd076af9a02e7a25f33fc57468ff
-- =========================================================================

-- Configuração da loja com os padrões preenchidos (ids das contas como texto ou null).
-- Novo: safeAccountId (Cofre) = 1ª conta de dinheiro ativa que não é a do PDV.
CREATE OR REPLACE FUNCTION public.cash_settings_resolved(p_tenant_id UUID, p_unit_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw JSONB;
  v_drawer UUID;
  v_bank UUID;
  v_pdv UUID;
  v_safe UUID;
  v_methods JSONB := '{}'::JSONB;
  v_key TEXT;
BEGIN
  SELECT cash_settings INTO v_raw FROM public.store_configs WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id;
  v_raw := COALESCE(v_raw, '{}'::JSONB);
  SELECT id INTO v_drawer FROM public.cash_accounts
  WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id AND is_active AND kind = 'GAVETA'
  ORDER BY sort_order, created_at LIMIT 1;
  SELECT id INTO v_bank FROM public.cash_accounts
  WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id AND is_active AND kind = 'BANCO'
  ORDER BY sort_order, created_at LIMIT 1;

  v_pdv := CASE WHEN v_raw ? 'pdvCashAccountId' THEN NULLIF(v_raw ->> 'pdvCashAccountId', '')::UUID ELSE v_drawer END;
  IF v_raw ? 'safeAccountId' THEN
    v_safe := NULLIF(v_raw ->> 'safeAccountId', '')::UUID;
  ELSE
    SELECT id INTO v_safe FROM public.cash_accounts
    WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id AND is_active AND kind = 'GAVETA'
      AND id IS DISTINCT FROM v_pdv
    ORDER BY sort_order, created_at LIMIT 1;
  END IF;

  FOREACH v_key IN ARRAY ARRAY['DINHEIRO', 'PIX', 'TRANSFERENCIA', 'BOLETO', 'DEBITO_AUTOMATICO', 'CARTAO', 'OUTRO'] LOOP
    IF jsonb_typeof(v_raw -> 'methodAccounts') = 'object' AND (v_raw -> 'methodAccounts') ? v_key THEN
      v_methods := v_methods || jsonb_build_object(v_key, v_raw -> 'methodAccounts' -> v_key);
    ELSE
      v_methods := v_methods || jsonb_build_object(v_key, CASE
        WHEN v_key = 'DINHEIRO' THEN to_jsonb(COALESCE(v_safe, v_drawer))
        WHEN v_key IN ('CARTAO', 'OUTRO') THEN 'null'::JSONB
        ELSE to_jsonb(v_bank) END);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'pdvCashAccountId', to_jsonb(v_pdv),
    'payoutAccountId', CASE WHEN v_raw ? 'payoutAccountId' THEN v_raw -> 'payoutAccountId' ELSE to_jsonb(v_bank) END,
    'safeAccountId', to_jsonb(v_safe),
    'methodAccounts', v_methods,
    'reserveStartDate', v_raw -> 'reserveStartDate'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cash_settings_resolved(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Grava "para onde vai cada forma" e a data de início da reserva (novo: safeAccountId).
CREATE OR REPLACE FUNCTION public.save_cash_settings(p_unit_id TEXT, p_settings JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_clean JSONB := '{}'::JSONB;
  v_methods JSONB := '{}'::JSONB;
  v_key TEXT;
  v_value TEXT;
  v_start DATE;
BEGIN
  PERFORM public.cash_admin_actor(p_unit_id);
  p_settings := COALESCE(p_settings, '{}'::JSONB);

  FOREACH v_key IN ARRAY ARRAY['pdvCashAccountId', 'payoutAccountId', 'safeAccountId'] LOOP
    IF p_settings ? v_key THEN
      v_value := NULLIF(p_settings ->> v_key, '');
      IF v_value IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.cash_accounts WHERE id::TEXT = v_value AND tenant_id = v_tenant_id AND unit_id = p_unit_id
      ) THEN
        RAISE EXCEPTION 'Conta inválida na configuração';
      END IF;
      v_clean := v_clean || jsonb_build_object(v_key, v_value);
    END IF;
  END LOOP;

  IF NULLIF(v_clean ->> 'safeAccountId', '') IS NOT NULL AND v_clean ->> 'safeAccountId' = v_clean ->> 'pdvCashAccountId' THEN
    RAISE EXCEPTION 'O Cofre precisa ser uma conta diferente da gaveta do PDV';
  END IF;

  IF jsonb_typeof(p_settings -> 'methodAccounts') = 'object' THEN
    FOREACH v_key IN ARRAY ARRAY['DINHEIRO', 'PIX', 'TRANSFERENCIA', 'BOLETO', 'DEBITO_AUTOMATICO', 'CARTAO', 'OUTRO'] LOOP
      IF (p_settings -> 'methodAccounts') ? v_key THEN
        v_value := NULLIF(p_settings -> 'methodAccounts' ->> v_key, '');
        IF v_value IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.cash_accounts WHERE id::TEXT = v_value AND tenant_id = v_tenant_id AND unit_id = p_unit_id
        ) THEN
          RAISE EXCEPTION 'Conta inválida na configuração';
        END IF;
        v_methods := v_methods || jsonb_build_object(v_key, v_value);
      END IF;
    END LOOP;
    v_clean := v_clean || jsonb_build_object('methodAccounts', v_methods);
  END IF;

  IF NULLIF(p_settings ->> 'reserveStartDate', '') IS NOT NULL THEN
    BEGIN
      v_start := (p_settings ->> 'reserveStartDate')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Data de início da reserva inválida';
    END;
    IF v_start > public.payable_today() THEN RAISE EXCEPTION 'A reserva não pode começar no futuro'; END IF;
    v_clean := v_clean || jsonb_build_object('reserveStartDate', to_char(v_start, 'YYYY-MM-DD'));
  END IF;

  UPDATE public.store_configs SET cash_settings = v_clean
  WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id;
  PERFORM public.cash_ensure_reserve_start(v_tenant_id, p_unit_id);
END;
$$;

-- Saldo de cada conta + extrato a partir de p_from + configuração da loja.
-- Novo: sangrias (menos as da Troca) entram e suprimentos saem do Cofre.
CREATE OR REPLACE FUNCTION public.get_cash_overview(p_unit_id TEXT, p_from DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_settings JSONB;
  v_raw JSONB;
  v_pdv UUID;
  v_payout UUID;
  v_safe UUID;
  v_from DATE := COALESCE(p_from, public.payable_today() - 60);
  v_result JSONB;
BEGIN
  PERFORM public.payable_actor(p_unit_id);
  v_settings := public.cash_settings_resolved(v_tenant_id, p_unit_id);
  SELECT cash_settings INTO v_raw FROM public.store_configs WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id;
  v_pdv := NULLIF(v_settings ->> 'pdvCashAccountId', '')::UUID;
  v_payout := NULLIF(v_settings ->> 'payoutAccountId', '')::UUID;
  v_safe := NULLIF(v_settings ->> 'safeAccountId', '')::UUID;
  IF v_safe = v_pdv THEN
    v_safe := NULL; -- sangria não pode voltar para a própria gaveta
  END IF;

  WITH acc AS (
    SELECT * FROM public.cash_accounts WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id
  ),
  methods AS (
    SELECT key AS method, NULLIF(value #>> '{}', '')::UUID AS account_id
    FROM jsonb_each(v_settings -> 'methodAccounts')
  ),
  last_close AS (
    SELECT cs.cash_number, cs.closed_at, cs.counted_cash_amount,
      (cs.closed_at AT TIME ZONE 'America/Sao_Paulo')::DATE AS close_date
    FROM public.cash_register_sessions cs
    JOIN acc ON acc.id = v_pdv
    WHERE cs.tenant_id = v_tenant_id AND cs.unit_id = p_unit_id AND cs.status = 'FECHADO'
      AND cs.counted_cash_amount IS NOT NULL
      AND (cs.closed_at AT TIME ZONE 'America/Sao_Paulo')::DATE > acc.opening_date
    ORDER BY cs.closed_at DESC
    LIMIT 1
  ),
  base AS (
    SELECT acc.id AS account_id,
      CASE WHEN lc.closed_at IS NOT NULL THEN lc.close_date ELSE acc.opening_date END AS base_date,
      CASE WHEN lc.closed_at IS NOT NULL THEN lc.counted_cash_amount ELSE acc.opening_balance END AS base_amount,
      CASE WHEN lc.closed_at IS NOT NULL THEN 'CONTAGEM' ELSE 'INICIAL' END AS base_kind,
      lc.cash_number, lc.closed_at
    FROM acc
    LEFT JOIN last_close lc ON acc.id = v_pdv
  ),
  entries AS (
    -- Recebimentos conferidos (cartão e Pix): o que caiu de fato.
    SELECT v_payout AS account_id, pc.payout_date AS entry_date, 'REPASSE'::TEXT AS kind,
      'Recebimentos conferidos (cartão e Pix)'::TEXT AS description, pc.received_amount::NUMERIC AS amount,
      pc.id::TEXT AS ref
    FROM public.payout_checks pc
    WHERE v_payout IS NOT NULL AND pc.tenant_id = v_tenant_id AND pc.unit_id = p_unit_id
    UNION ALL
    SELECT m.account_id, rp.paid_at, 'CONTA_RECEBER',
      'Recebido de ' || rt.debtor_name || ' (conta a receber nº ' || rt.title_number || ')', rp.amount, rp.id::TEXT
    FROM public.receivable_payments rp
    JOIN public.receivable_titles rt ON rt.id = rp.title_id
    JOIN methods m ON m.method = rp.method AND m.account_id IS NOT NULL
    WHERE rp.tenant_id = v_tenant_id AND rp.unit_id = p_unit_id
    UNION ALL
    SELECT m.account_id, pb.paid_at, 'CONTA_PAGAR',
      'Pago: ' || pb.description || COALESCE(' - ' || pb.supplier_name, ''), -COALESCE(pb.paid_amount, pb.amount), pb.id::TEXT
    FROM public.payable_bills pb
    JOIN methods m ON m.method = pb.paid_method AND m.account_id IS NOT NULL
    WHERE pb.tenant_id = v_tenant_id AND pb.unit_id = p_unit_id AND pb.status = 'PAGO' AND pb.paid_at IS NOT NULL
    UNION ALL
    SELECT m.account_id, (ti."timestamp"::TIMESTAMPTZ AT TIME ZONE 'America/Sao_Paulo')::DATE, 'TROCA_PIX',
      'Troca nº ' || COALESCE(ti.trade_number::TEXT, '-') || ' paga em Pix', -ti.valuation_amount, ti.id::TEXT
    FROM public.trade_ins ti
    JOIN methods m ON m.method = 'PIX' AND m.account_id IS NOT NULL
    WHERE ti.tenant_id = v_tenant_id AND ti.unit_id = p_unit_id AND ti.payment_method = 'PIX'
    UNION ALL
    SELECT m.account_id, (sr.created_at AT TIME ZONE 'America/Sao_Paulo')::DATE, 'DEVOLUCAO_PIX',
      'Devolução nº ' || sr.return_number || ' paga em Pix', -sr.total_amount, sr.id::TEXT
    FROM public.sale_returns sr
    JOIN methods m ON m.method = 'PIX' AND m.account_id IS NOT NULL
    WHERE sr.tenant_id = v_tenant_id AND sr.unit_id = p_unit_id AND sr.refund_method = 'PIX'
    UNION ALL
    -- Sangria do PDV entra no Cofre; suprimento sai do Cofre (sangria da Troca saiu para o cliente).
    SELECT v_safe, (crm.created_at AT TIME ZONE 'America/Sao_Paulo')::DATE,
      CASE WHEN crm.type = 'SANGRIA' THEN 'SANGRIA_PDV' ELSE 'SUPRIMENTO_PDV' END,
      COALESCE(NULLIF(BTRIM(crm.reason), ''), CASE WHEN crm.type = 'SANGRIA' THEN 'Sangria' ELSE 'Suprimento' END)
        || ' (' || crm.operator_name || ')',
      CASE WHEN crm.type = 'SANGRIA' THEN crm.amount ELSE -crm.amount END, crm.id::TEXT
    FROM public.cash_register_movements crm
    WHERE v_safe IS NOT NULL AND crm.tenant_id = v_tenant_id AND crm.unit_id = p_unit_id
      AND NOT (crm.type = 'SANGRIA' AND crm.reason ILIKE 'Troca%')
    UNION ALL
    -- Lançamentos manuais (no cartão: fica fora do saldo, entra pelo repasse conferido).
    SELECT cm.account_id, cm.movement_date, cm.movement_type,
      COALESCE(cm.description, ''), CASE WHEN cm.via_card THEN 0
        WHEN cm.direction = 'ENTRADA' THEN cm.amount ELSE -cm.amount END, cm.id::TEXT
    FROM public.cash_movements cm
    WHERE cm.tenant_id = v_tenant_id AND cm.unit_id = p_unit_id
    UNION ALL
    SELECT cm.to_account_id, cm.movement_date, 'TRANSFERENCIA_ENTRADA', COALESCE(cm.description, ''), cm.amount, cm.id::TEXT
    FROM public.cash_movements cm
    WHERE cm.tenant_id = v_tenant_id AND cm.unit_id = p_unit_id AND cm.to_account_id IS NOT NULL
  ),
  balances AS (
    SELECT b.account_id,
      b.base_amount + COALESCE(SUM(e.amount) FILTER (WHERE e.entry_date > b.base_date), 0) AS balance
    FROM base b
    LEFT JOIN entries e ON e.account_id = b.account_id
    GROUP BY b.account_id, b.base_amount
  ),
  closings AS (
    SELECT cs.cash_number, cs.closed_at, cs.counted_cash_amount
    FROM public.cash_register_sessions cs
    WHERE v_pdv IS NOT NULL AND cs.tenant_id = v_tenant_id AND cs.unit_id = p_unit_id AND cs.status = 'FECHADO'
      AND cs.counted_cash_amount IS NOT NULL
      AND (cs.closed_at AT TIME ZONE 'America/Sao_Paulo')::DATE >= v_from
  )
  SELECT jsonb_build_object(
    'settings', v_settings,
    'rawSettings', COALESCE(v_raw, '{}'::JSONB),
    'accounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', acc.id, 'name', acc.name, 'kind', acc.kind, 'isActive', acc.is_active,
        'openingBalance', acc.opening_balance, 'openingDate', acc.opening_date,
        'balance', ROUND(bal.balance, 2), 'baseKind', b.base_kind, 'baseDate', b.base_date,
        'baseAmount', b.base_amount, 'cashNumber', b.cash_number, 'closedAt', b.closed_at
      ) ORDER BY acc.sort_order, acc.created_at)
      FROM acc JOIN base b ON b.account_id = acc.id JOIN balances bal ON bal.account_id = acc.id
    ), '[]'::JSONB),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'accountId', e.account_id, 'date', e.entry_date, 'kind', e.kind, 'description', e.description,
        'amount', e.amount, 'ref', e.ref, 'counted', e.entry_date > b.base_date
      ) ORDER BY e.entry_date DESC, e.kind)
      FROM entries e JOIN base b ON b.account_id = e.account_id
      WHERE e.entry_date >= v_from
    ), '[]'::JSONB),
    'closings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('cashNumber', c.cash_number, 'closedAt', c.closed_at, 'counted', c.counted_cash_amount)
        ORDER BY c.closed_at DESC)
      FROM closings c
    ), '[]'::JSONB),
    'partnerLoanBalance', COALESCE((
      SELECT SUM(CASE WHEN cm.movement_type = 'EMPRESTIMO_SOCIO' THEN COALESCE(cm.card_gross, cm.amount) ELSE -cm.amount END)
      FROM public.cash_movements cm
      WHERE cm.tenant_id = v_tenant_id AND cm.unit_id = p_unit_id AND cm.movement_type IN ('EMPRESTIMO_SOCIO', 'DEVOLUCAO_SOCIO')
    ), 0)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
