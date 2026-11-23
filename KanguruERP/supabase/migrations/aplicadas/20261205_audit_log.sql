-- =========================================================================
-- Registro de ações (desenho aprovado em 2026-11-22). So o DONO (ADMIN) ve.
--
-- 1. Acoes no ERP: tabela nova audit_log, preenchida por gatilhos (AFTER) nas tabelas
--    importantes. Guarda quando, quem (usuario do ERP, terminal do PDV ou "Sistema"), loja,
--    area, o que e o "antes -> depois" de cada campo alterado. Ninguem edita nem apaga.
--    Se a anotacao falhar por qualquer motivo, a operacao original segue normal (nunca bloqueia
--    venda, estorno, cadastro etc.).
--    Estoque (entradas, perdas, transferencias, balancos) NAO e duplicado: a consulta le a
--    tabela movements que ja existe (sem as saidas por venda e as devolucoes de cliente).
-- 2. Acoes no PDV (senha Gerente), separadas e por categoria: le pos_admin_password_attempts
--    (cada uso da senha, aceita ou errada) e completa com o detalhe que ja existe em outras
--    tabelas (sangria/suprimento, descontos aprovados, devolucoes, Troca Gamer).
--
-- Aditiva: nenhuma funcao existente muda. Tabela e funcoes novas + gatilhos novos (prefixo zz_audit_).
-- =========================================================================

-- Confere que todas as tabelas vigiadas existem (senao para tudo).
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'products', 'services', 'sales', 'expenses', 'payable_bills', 'payable_recurrences',
    'store_configs', 'store_manager_passwords', 'app_users', 'user_store_access',
    'pdv_operators', 'customers', 'trade_ins', 'movements', 'pos_admin_password_attempts',
    'pos_terminals', 'cash_register_movements', 'sale_discount_approvals', 'sale_returns'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'Tabela public.% não existe. Nada foi aplicado.', v_table;
    END IF;
  END LOOP;
END $$;

-- ---- 1. Tabela do registro --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  unit_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('ERP', 'PDV', 'SISTEMA', 'OUTRO')),
  actor_id TEXT,
  actor_name TEXT,
  area TEXT NOT NULL,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  record_id TEXT,
  summary TEXT,
  changes JSONB
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_time_idx ON public.audit_log (tenant_id, occurred_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.audit_log_id_seq FROM PUBLIC, anon, authenticated;

-- Ninguem altera nem apaga uma anotacao.
CREATE OR REPLACE FUNCTION public.audit_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'O registro de ações não pode ser alterado nem apagado';
END;
$$;

REVOKE ALL ON FUNCTION public.audit_log_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_log_no_change ON public.audit_log;
CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();

-- ---- 2. Gatilho generico ----------------------------------------------------
-- Argumentos: area, modo ('exclude' = todos os campos menos a lista; 'include' = so a lista;
-- 'mask' = so registra que mudou, sem valores) e a lista de campos separada por virgula.
CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_area TEXT := TG_ARGV[0];
  v_mode TEXT := COALESCE(TG_ARGV[1], 'exclude');
  v_cols TEXT[] := string_to_array(COALESCE(TG_ARGV[2], ''), ',');
  v_skip TEXT[] := ARRAY['tenant_id', 'updated_at', 'password_hash', 'last_login_at', 'last_seen_at', 'last_sign_in_at'];
  v_new JSONB;
  v_old JSONB;
  v_row JSONB;
  v_changes JSONB := '{}'::JSONB;
  v_key TEXT;
  v_uid UUID;
  v_kind TEXT;
  v_actor_id TEXT;
  v_actor_name TEXT;
  v_summary TEXT;
BEGIN
  BEGIN
    IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
    IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
    v_row := COALESCE(v_new, v_old);
    IF NULLIF(v_row->>'tenant_id', '') IS NULL THEN
      RETURN NULL;
    END IF;

    IF v_mode = 'mask' THEN
      v_changes := NULL;
    ELSIF TG_OP = 'UPDATE' THEN
      FOR v_key IN SELECT jsonb_object_keys(v_new) LOOP
        CONTINUE WHEN v_key = ANY(v_skip);
        CONTINUE WHEN v_mode = 'include' AND NOT v_key = ANY(v_cols);
        CONTINUE WHEN v_mode = 'exclude' AND v_key = ANY(v_cols);
        IF (v_old->v_key) IS DISTINCT FROM (v_new->v_key) THEN
          v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_array(v_old->v_key, v_new->v_key));
        END IF;
      END LOOP;
      IF v_changes = '{}'::JSONB THEN
        RETURN NULL; -- nada relevante mudou
      END IF;
    ELSE
      FOR v_key IN SELECT jsonb_object_keys(v_row) LOOP
        CONTINUE WHEN v_key = ANY(v_skip);
        CONTINUE WHEN v_mode = 'include' AND NOT v_key = ANY(v_cols);
        CONTINUE WHEN v_mode = 'exclude' AND v_key = ANY(v_cols);
        v_changes := v_changes || jsonb_build_object(v_key, v_row->v_key);
      END LOOP;
    END IF;

    -- Quem fez: usuario do ERP, terminal do PDV ou sistema (SQL / automatico).
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
      v_kind := 'SISTEMA';
      v_actor_name := 'Sistema';
    ELSE
      v_actor_id := v_uid::TEXT;
      SELECT COALESCE(NULLIF(BTRIM(app_user.display_name), ''), 'Usuário do ERP') INTO v_actor_name
      FROM public.app_users AS app_user WHERE app_user.auth_uid = v_uid LIMIT 1;
      IF FOUND THEN
        v_kind := 'ERP';
      ELSE
        SELECT terminal.id::TEXT, COALESCE(terminal.display_name, 'Terminal do PDV') INTO v_actor_id, v_actor_name
        FROM public.pos_terminals AS terminal WHERE terminal.device_auth_uid = v_uid LIMIT 1;
        IF FOUND THEN
          v_kind := 'PDV';
        ELSE
          v_kind := 'OUTRO';
          v_actor_id := v_uid::TEXT;
          v_actor_name := 'Outro acesso';
        END IF;
      END IF;
    END IF;

    v_summary := COALESCE(
      v_row->>'name', v_row->>'display_name', v_row->>'trade_name', v_row->>'description',
      v_row->>'title', v_row->>'item_description', v_row->>'invoice_number'
    );
    IF TG_TABLE_NAME = 'sales' THEN
      v_summary := v_row->>'invoice_number';
    ELSIF TG_TABLE_NAME = 'user_store_access' THEN
      SELECT app_user.display_name INTO v_summary FROM public.app_users AS app_user
      WHERE app_user.auth_uid = NULLIF(v_row->>'auth_uid', '')::UUID LIMIT 1;
    ELSIF TG_TABLE_NAME = 'store_manager_passwords' THEN
      v_summary := 'Senha Gerente';
    END IF;

    INSERT INTO public.audit_log (
      tenant_id, unit_id, actor_kind, actor_id, actor_name, area, table_name, operation, record_id, summary, changes
    ) VALUES (
      (v_row->>'tenant_id')::UUID, NULLIF(v_row->>'unit_id', ''), v_kind, v_actor_id, v_actor_name, v_area,
      TG_TABLE_NAME, TG_OP, COALESCE(v_row->>'id', v_row->>'auth_uid', v_row->>'unit_id'), LEFT(v_summary, 200), v_changes
    );
  EXCEPTION WHEN OTHERS THEN
    -- O registro nunca impede a operacao original.
    RAISE WARNING 'Registro de ações não gravado (%): %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;

-- ---- 3. Tabelas vigiadas ----------------------------------------------------
DROP TRIGGER IF EXISTS zz_audit_products ON public.products;
CREATE TRIGGER zz_audit_products AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('PRODUTOS', 'exclude', '');

DROP TRIGGER IF EXISTS zz_audit_services ON public.services;
CREATE TRIGGER zz_audit_services AFTER INSERT OR UPDATE OR DELETE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('PRODUTOS', 'exclude', '');

-- Vendas: so estorno/aprovacao e alteracoes de conteudo (a criacao da venda e as atualizacoes
-- automaticas de taxa e nota fiscal nao entram).
DROP TRIGGER IF EXISTS zz_audit_sales ON public.sales;
CREATE TRIGGER zz_audit_sales AFTER UPDATE OR DELETE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('VENDAS', 'include',
    'invoice_number,status,requires_approval,approved_by,gross_amount,items,payment_method,timestamp,client_name,client_cpf,seller_code,seller_name,unit_id');

DROP TRIGGER IF EXISTS zz_audit_expenses ON public.expenses;
CREATE TRIGGER zz_audit_expenses AFTER INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('FINANCEIRO', 'exclude', '');

DROP TRIGGER IF EXISTS zz_audit_payable_bills ON public.payable_bills;
CREATE TRIGGER zz_audit_payable_bills AFTER INSERT OR UPDATE OR DELETE ON public.payable_bills
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('FINANCEIRO', 'exclude', '');

DROP TRIGGER IF EXISTS zz_audit_payable_recurrences ON public.payable_recurrences;
CREATE TRIGGER zz_audit_payable_recurrences AFTER INSERT OR UPDATE OR DELETE ON public.payable_recurrences
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('FINANCEIRO', 'exclude', '');

DROP TRIGGER IF EXISTS zz_audit_store_configs ON public.store_configs;
CREATE TRIGGER zz_audit_store_configs AFTER INSERT OR UPDATE OR DELETE ON public.store_configs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('CONFIGURACOES', 'exclude', '');

-- Senha Gerente: so o aviso de que mudou (nunca a senha nem o hash).
DROP TRIGGER IF EXISTS zz_audit_store_manager_passwords ON public.store_manager_passwords;
CREATE TRIGGER zz_audit_store_manager_passwords AFTER INSERT OR UPDATE OR DELETE ON public.store_manager_passwords
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('CONFIGURACOES', 'mask', '');

DROP TRIGGER IF EXISTS zz_audit_app_users ON public.app_users;
CREATE TRIGGER zz_audit_app_users AFTER INSERT OR UPDATE OR DELETE ON public.app_users
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('PESSOAS', 'exclude', '');

DROP TRIGGER IF EXISTS zz_audit_user_store_access ON public.user_store_access;
CREATE TRIGGER zz_audit_user_store_access AFTER INSERT OR DELETE ON public.user_store_access
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('PESSOAS', 'exclude', '');

DROP TRIGGER IF EXISTS zz_audit_pdv_operators ON public.pdv_operators;
CREATE TRIGGER zz_audit_pdv_operators AFTER INSERT OR UPDATE OR DELETE ON public.pdv_operators
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('PESSOAS', 'exclude', '');

-- Clientes: so alteracao e exclusao (cadastro novo pelo PDV e rotina).
DROP TRIGGER IF EXISTS zz_audit_customers ON public.customers;
CREATE TRIGGER zz_audit_customers AFTER UPDATE OR DELETE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('PESSOAS', 'exclude', '');

-- Troca Gamer/Phone: estocada ou dispensada (mudanca de situacao).
DROP TRIGGER IF EXISTS zz_audit_trade_ins ON public.trade_ins;
CREATE TRIGGER zz_audit_trade_ins AFTER UPDATE ON public.trade_ins
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('TROCAS', 'include', 'status');

-- ---- 4. Consulta das acoes no ERP (so o dono) -------------------------------
CREATE OR REPLACE FUNCTION public.list_audit_log(
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ,
  p_unit TEXT DEFAULT NULL,
  p_area TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 500
)
RETURNS TABLE (
  occurred_at TIMESTAMPTZ,
  area TEXT,
  table_name TEXT,
  operation TEXT,
  actor_kind TEXT,
  actor_name TEXT,
  unit_id TEXT,
  record_id TEXT,
  summary TEXT,
  changes JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_search TEXT := NULLIF(BTRIM(COALESCE(p_search, '')), '');
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o dono da empresa vê o registro de ações';
  END IF;

  RETURN QUERY
  SELECT entry.occurred_at, entry.area, entry.table_name, entry.operation, entry.actor_kind,
    entry.actor_name, entry.unit_id, entry.record_id, entry.summary, entry.changes
  FROM (
    SELECT log.occurred_at, log.area, log.table_name, log.operation, log.actor_kind, log.actor_name,
      log.unit_id, log.unit_id AS unit_alt, log.record_id, log.summary, log.changes
    FROM public.audit_log AS log
    WHERE log.tenant_id = v_tenant_id AND log.occurred_at >= p_start AND log.occurred_at < p_end
    UNION ALL
    -- Estoque: movimentos que ja existem (sem saida por venda nem devolucao de cliente).
    SELECT movement.timestamp::TIMESTAMPTZ, 'ESTOQUE', 'movements', movement.type, 'ERP',
      movement.operator_name,
      COALESCE(NULLIF(movement.from_unit_id, ''), movement.to_unit_id),
      movement.to_unit_id,
      movement.id::TEXT, product.name,
      jsonb_build_object(
        'type', movement.type, 'quantity', movement.quantity, 'from_unit_id', movement.from_unit_id,
        'to_unit_id', movement.to_unit_id, 'reason', movement.reason, 'unit_cost', movement.unit_cost,
        'serials', movement.serials
      )
    FROM public.movements AS movement
    LEFT JOIN public.products AS product ON product.tenant_id = movement.tenant_id AND product.id = movement.product_id
    WHERE movement.tenant_id = v_tenant_id
      AND movement.timestamp::TIMESTAMPTZ >= p_start AND movement.timestamp::TIMESTAMPTZ < p_end
      AND COALESCE(movement.from_unit_id, '') <> 'CLIENTE'
      AND COALESCE(movement.to_unit_id, '') <> 'CLIENTE'
  ) AS entry
  WHERE (p_unit IS NULL OR entry.unit_id = p_unit OR entry.unit_alt = p_unit)
    AND (p_area IS NULL OR entry.area = p_area)
    AND (v_search IS NULL
      OR entry.summary ILIKE '%' || v_search || '%'
      OR entry.actor_name ILIKE '%' || v_search || '%'
      OR entry.record_id ILIKE '%' || v_search || '%'
      OR entry.changes::TEXT ILIKE '%' || v_search || '%')
  ORDER BY entry.occurred_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 2000);
END;
$$;

REVOKE ALL ON FUNCTION public.list_audit_log(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_audit_log(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER) TO authenticated;

-- ---- 5. Consulta das acoes no PDV com senha Gerente (so o dono) -------------
-- Categoria: CAIXA (sangria, suprimento, gaveta, fechamento), VENDA (desconto, devolucao,
-- cancelar reserva com sinal), TROCAS (pagamento da Troca Gamer/Phone), TERMINAL
-- (desbloqueio, configuracoes). completed: para as acoes que o banco confere depois (sangria,
-- suprimento, fechamento, cancelar reserva) diz se a senha foi usada de fato.
CREATE OR REPLACE FUNCTION public.list_pos_sensitive_actions(
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ,
  p_unit TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL
)
RETURNS TABLE (
  occurred_at TIMESTAMPTZ,
  unit_id TEXT,
  terminal_name TEXT,
  category TEXT,
  context TEXT,
  success BOOLEAN,
  completed BOOLEAN,
  detail TEXT,
  amount NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o dono da empresa vê o registro de ações';
  END IF;

  RETURN QUERY
  SELECT item.attempted_at, item.unit_id, item.terminal_name, item.category, item.context, item.success,
    item.completed, item.detail, item.amount
  FROM (
    SELECT attempt.attempted_at, terminal.unit_id, terminal.display_name AS terminal_name,
      CASE
        WHEN attempt.context IN ('CASH_WITHDRAWAL', 'CASH_SUPPLY', 'CASH_DRAWER', 'CASH_CLOSE') THEN 'CAIXA'
        WHEN attempt.context IN ('DISCOUNT_APPROVAL', 'SALE_RETURN', 'RESERVATION_CANCEL') THEN 'VENDA'
        WHEN attempt.context = 'TRADE_IN_PAYOUT' THEN 'TROCAS'
        ELSE 'TERMINAL'
      END AS category,
      attempt.context, attempt.success,
      CASE WHEN attempt.success AND attempt.context IN ('CASH_WITHDRAWAL', 'CASH_SUPPLY', 'CASH_CLOSE', 'RESERVATION_CANCEL')
        THEN attempt.consumed_at IS NOT NULL END AS completed,
      CASE
        WHEN NOT attempt.success THEN 'Senha errada'
        WHEN attempt.context = 'DISCOUNT_APPROVAL' THEN COALESCE(discount.detail, 'Desconto acima do limite ou orçamento abaixo da margem')
        WHEN attempt.context = 'SALE_RETURN' THEN returned.detail
        WHEN attempt.context = 'TRADE_IN_PAYOUT' THEN COALESCE(trade.detail, cash.detail)
        WHEN attempt.context IN ('CASH_WITHDRAWAL', 'CASH_SUPPLY') THEN cash.detail
      END AS detail,
      CASE
        WHEN NOT attempt.success THEN NULL
        WHEN attempt.context = 'SALE_RETURN' THEN returned.amount
        WHEN attempt.context = 'TRADE_IN_PAYOUT' THEN COALESCE(trade.amount, cash.amount)
        WHEN attempt.context IN ('CASH_WITHDRAWAL', 'CASH_SUPPLY') THEN cash.amount
      END AS amount
    FROM public.pos_admin_password_attempts AS attempt
    JOIN public.pos_terminals AS terminal ON terminal.id = attempt.terminal_id
    -- Sangria/suprimento lancado logo depois da senha, no mesmo terminal.
    LEFT JOIN LATERAL (
      SELECT movement.reason || ' · ' || movement.operator_name AS detail, movement.amount
      FROM public.cash_register_movements AS movement
      WHERE attempt.success
        AND attempt.context IN ('CASH_WITHDRAWAL', 'CASH_SUPPLY', 'TRADE_IN_PAYOUT')
        AND movement.terminal_id = attempt.terminal_id
        AND movement.type = CASE WHEN attempt.context = 'CASH_SUPPLY' THEN 'SUPRIMENTO' ELSE 'SANGRIA' END
        AND movement.created_at BETWEEN attempt.attempted_at - INTERVAL '1 minute' AND attempt.attempted_at + INTERVAL '10 minutes'
      ORDER BY movement.created_at
      LIMIT 1
    ) AS cash ON TRUE
    -- Itens com desconto acima do limite aprovados na mesma venda.
    LEFT JOIN LATERAL (
      SELECT string_agg(
        COALESCE(approval.item_name, 'Item') || ' ' || approval.discount_percent::TEXT || '% (limite '
          || approval.store_limit_percent::TEXT || '%)', '; ' ORDER BY approval.item_name) AS detail
      FROM public.sale_discount_approvals AS approval
      WHERE attempt.success AND attempt.context = 'DISCOUNT_APPROVAL'
        AND approval.terminal_id = attempt.terminal_id
        AND approval.approved_at BETWEEN attempt.attempted_at - INTERVAL '1 minute' AND attempt.attempted_at + INTERVAL '10 minutes'
    ) AS discount ON TRUE
    -- Devolucao feita com a senha.
    LEFT JOIN LATERAL (
      SELECT 'Devolução nº ' || sale_return.return_number::TEXT || ' · ' || sale_return.refund_method
          || ' · ' || sale_return.reason
          || CASE WHEN sale_return.out_of_period THEN ' · fora do prazo' ELSE '' END AS detail,
        sale_return.total_amount AS amount
      FROM public.sale_returns AS sale_return
      WHERE attempt.success AND attempt.context = 'SALE_RETURN'
        AND sale_return.terminal_id = attempt.terminal_id
        AND sale_return.created_at BETWEEN attempt.attempted_at - INTERVAL '1 minute' AND attempt.attempted_at + INTERVAL '10 minutes'
      ORDER BY sale_return.created_at
      LIMIT 1
    ) AS returned ON TRUE
    -- Troca Gamer/Phone paga em dinheiro/Pix ou acima da tabela.
    LEFT JOIN LATERAL (
      SELECT 'Troca nº ' || COALESCE(trade.trade_number::TEXT, '-') || ' · ' || COALESCE(trade.payment_method, '')
          || ' · ' || COALESCE(trade.item_description, '') || ' · ' || COALESCE(trade.seller_name, '') AS detail,
        trade.valuation_amount AS amount
      FROM public.trade_ins AS trade
      WHERE attempt.success AND attempt.context = 'TRADE_IN_PAYOUT'
        AND trade.terminal_id = attempt.terminal_id
        AND trade."timestamp"::TIMESTAMPTZ BETWEEN attempt.attempted_at - INTERVAL '1 minute' AND attempt.attempted_at + INTERVAL '15 minutes'
      ORDER BY trade."timestamp"::TIMESTAMPTZ
      LIMIT 1
    ) AS trade ON TRUE
    WHERE attempt.tenant_id = v_tenant_id
      AND attempt.attempted_at >= p_start AND attempt.attempted_at < p_end
  ) AS item
  WHERE (p_unit IS NULL OR item.unit_id = p_unit)
    AND (p_category IS NULL OR item.category = p_category)
  ORDER BY item.attempted_at DESC
  LIMIT 2000;
END;
$$;

REVOKE ALL ON FUNCTION public.list_pos_sensitive_actions(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pos_sensitive_actions(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) TO authenticated;
