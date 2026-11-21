-- Correções das vendas de novembro conferidas com o extrato da Stone (decisões do usuário em 21/11/2026).
-- Roda tudo de uma vez: se qualquer conferência falhar, nada é gravado. Rodar uma vez só.
--
-- 1. Taxas gravadas erradas:
--    a) 08/11 R$ 5.400 em 12x: passou no TapStone (taxa real R$ 1.096,89 = 20,313%; estava 9,99%).
--    b) Venda de 12/11 do Sergio (R$ 4.300): o cartão de R$ 1.800 passou no TapStone em 10x
--       (taxa real R$ 323,16 = 17,953%; estava 12x a 9,99%). A data da venda volta para 08/11 19:28,
--       quando ela aconteceu de verdade.
--    c) 09/11 R$ 4.520 em 12x: estava com 13% (tabela antiga); real 9,99%.
--    d) 08/11 R$ 29,90 no crédito: cartão Amex (4,49%; estava 3,14%).
-- 2. Venda de 08/11 do Sergio (Pc Gamer N1 + Monitor) lançada duas vezes: fica CANCELADA, SEM devolver
--    nada ao estoque (os dois itens saíram da loja na venda de 12/11). O caixa daquele dia já está fechado,
--    então o bloqueio de estorno com caixa fechado é desligado só durante esta correção.
-- 3. Reserva da Camila (sinal de R$ 5.199,90 no crédito, ainda ativa): cancelada SEM lançar devolução de
--    dinheiro, porque a venda dela já foi lançada em 19/11; a Camila vira a cliente dessa venda.

DO $$
DECLARE
  v_admin UUID;
  v_tenant UUID;
  v_count INTEGER;
  v_reservation public.product_reservations%ROWTYPE;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.app_users WHERE role = 'ADMIN';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Esperava 1 usuário ADMIN, achei %. Nada foi gravado.', v_count; END IF;
  SELECT auth_uid, tenant_id INTO v_admin, v_tenant FROM public.app_users WHERE role = 'ADMIN';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::TEXT, true);

  -- 1a) 08/11 R$ 5.400 12x (TapStone)
  UPDATE public.sale_payments AS p SET fee_percent = 20.313
  FROM public.sales AS s
  WHERE s.tenant_id = v_tenant AND s.invoice_number = 'PDV-1794169699750' AND s.status = 'CONCLUIDA'
    AND p.tenant_id = s.tenant_id AND p.sale_id = s.id
    AND p.payment_method = 'CREDITO' AND p.amount = 5400 AND p.fee_percent = 9.990;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION '1a: pagamento de R$ 5.400 não encontrado como esperado. Nada foi gravado.'; END IF;
  UPDATE public.sales SET fee_amount = fee_amount + 557.43, net_amount = net_amount - 557.43
  WHERE tenant_id = v_tenant AND invoice_number = 'PDV-1794169699750';

  -- 1b) 12/11 R$ 4.300 do Sergio: cartão R$ 1.800 no TapStone 10x e data real 08/11
  UPDATE public.sale_payments AS p SET fee_percent = 17.953, installments = 10
  FROM public.sales AS s
  WHERE s.tenant_id = v_tenant AND s.invoice_number = 'PDV-1794516672222' AND s.status = 'CONCLUIDA'
    AND p.tenant_id = s.tenant_id AND p.sale_id = s.id
    AND p.payment_method = 'CREDITO' AND p.amount = 1800 AND p.installments = 12 AND p.fee_percent = 9.990;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION '1b: cartão de R$ 1.800 da venda de 12/11 não encontrado como esperado. Nada foi gravado.'; END IF;
  UPDATE public.sales
  SET fee_amount = fee_amount + 143.34, net_amount = net_amount - 143.34,
      timestamp = '2026-11-08 19:28:41.704-03'
  WHERE tenant_id = v_tenant AND invoice_number = 'PDV-1794516672222';

  -- 1c) 09/11 R$ 4.520 12x: 13% -> 9,99%
  UPDATE public.sale_payments AS p SET fee_percent = 9.990
  FROM public.sales AS s
  WHERE s.tenant_id = v_tenant AND s.invoice_number = 'PDV-1794271004175' AND s.status = 'CONCLUIDA'
    AND p.tenant_id = s.tenant_id AND p.sale_id = s.id
    AND p.payment_method = 'CREDITO' AND p.amount = 4520 AND p.fee_percent = 13.000;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION '1c: pagamento de R$ 4.520 não encontrado como esperado. Nada foi gravado.'; END IF;
  UPDATE public.sales SET fee_amount = fee_amount - 136.05, net_amount = net_amount + 136.05
  WHERE tenant_id = v_tenant AND invoice_number = 'PDV-1794271004175';

  -- 1d) 08/11 R$ 29,90 Amex
  UPDATE public.sale_payments AS p SET fee_percent = 4.490
  FROM public.sales AS s
  WHERE s.tenant_id = v_tenant AND s.invoice_number = 'PDV-1794157785890' AND s.status = 'CONCLUIDA'
    AND p.tenant_id = s.tenant_id AND p.sale_id = s.id
    AND p.payment_method = 'CREDITO' AND p.amount = 29.90 AND p.fee_percent = 3.140;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION '1d: pagamento de R$ 29,90 não encontrado como esperado. Nada foi gravado.'; END IF;
  UPDATE public.sales SET fee_amount = fee_amount + 0.40, net_amount = net_amount - 0.40
  WHERE tenant_id = v_tenant AND invoice_number = 'PDV-1794157785890';

  -- 2) Cancela a venda repetida de 08/11 sem mexer no estoque
  EXECUTE 'ALTER TABLE public.sales DISABLE TRIGGER zz_sale_cancellation_closed_cash';
  UPDATE public.sales
  SET status = 'CANCELADA', approved_by = 'Correção 21/11/2026: venda lançada duas vezes (vale a de 12/11)'
  WHERE tenant_id = v_tenant AND invoice_number = 'PDV-1794176921704' AND status = 'CONCLUIDA'
    AND gross_amount = 4300;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  EXECUTE 'ALTER TABLE public.sales ENABLE TRIGGER zz_sale_cancellation_closed_cash';
  IF v_count <> 1 THEN RAISE EXCEPTION '2: venda de 08/11 do Sergio não encontrada como esperado. Nada foi gravado.'; END IF;

  -- 3) Reserva da Camila: cancela sem devolução e liga a cliente à venda de 19/11
  SELECT COUNT(*) INTO v_count FROM public.product_reservations
  WHERE tenant_id = v_tenant AND status = 'ATIVA' AND customer_name ILIKE 'Camila%' AND deposit_amount = 5199.90;
  IF v_count <> 1 THEN RAISE EXCEPTION '3: esperava 1 reserva ativa da Camila, achei %. Nada foi gravado.', v_count; END IF;
  SELECT * INTO v_reservation FROM public.product_reservations
  WHERE tenant_id = v_tenant AND status = 'ATIVA' AND customer_name ILIKE 'Camila%' AND deposit_amount = 5199.90
  FOR UPDATE;

  UPDATE public.product_serial_units AS unit
  SET status = 'DISPONIVEL', sale_id = NULL
  FROM public.product_reservation_items AS reservation_item
  WHERE reservation_item.tenant_id = v_tenant AND reservation_item.reservation_id = v_reservation.id
    AND reservation_item.serial_unit_id = unit.id AND unit.status = 'RESERVADO';

  UPDATE public.product_reservations SET status = 'CANCELADA', updated_at = NOW()
  WHERE id = v_reservation.id;

  UPDATE public.sales
  SET client_name = v_reservation.customer_name, client_cpf = v_reservation.customer_cpf
  WHERE tenant_id = v_tenant AND invoice_number = 'PDV-1795137695644' AND status = 'CONCLUIDA'
    AND client_name IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION '3: venda de 19/11 do PS5 não encontrada como esperado. Nada foi gravado.'; END IF;
END $$;

-- Conferência (rode depois):
select s.invoice_number, s.status, (s.timestamp at time zone 'America/Sao_Paulo') as data_hora,
       s.gross_amount, s.fee_amount, s.client_name, p.payment_method, p.installments, p.amount, p.fee_percent
from public.sales s
left join public.sale_payments p on p.sale_id = s.id and p.payment_method = 'CREDITO'
where s.invoice_number in ('PDV-1794169699750','PDV-1794516672222','PDV-1794271004175',
                           'PDV-1794157785890','PDV-1794176921704','PDV-1795137695644')
order by s.timestamp;
