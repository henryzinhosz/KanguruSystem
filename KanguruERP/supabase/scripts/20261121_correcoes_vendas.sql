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
-- 2. Venda de 08/11 do Sergio (Pc Gamer N1 + Monitor) lançada duas vezes: já foi devolvida inteira no PDV
--    em 11/11 (faturamento já se anula). A taxa do cartão dela vai a zero (a real está na venda de 12/11) e
--    sai 1 PC Gamer N1 e 1 Monitor do estoque (a devolução pôs de volta, mas saíram na venda de 12/11).
-- 3. Reserva da Camila (sinal de R$ 5.199,90 no crédito, ainda ativa): cancelada SEM lançar devolução de
--    dinheiro, porque a venda dela já foi lançada em 19/11; a Camila vira a cliente dessa venda.
-- 4. Venda do Davi (PS5 Slim Drive + Base, decisão de 22/11/2026): o Pix de R$ 2.000 e o cartão foram em 05/11;
--    o cartão é o TapStone Master 12x R$ 3.474 de 05/11 20:07 (taxa real R$ 705,44 = 20,306%), não o 4x de
--    R$ 3.485,71 lançado. O Adaptador Lightning entrou por engano: sai da venda e volta 1 unidade ao estoque.
--    Total da venda passa a R$ 5.474,00 (o que o cliente pagou); data 05/11 20:07.
-- 5. Cópias e impressões não lançadas (comprovantes achados pelo usuário): 10 no cartão (taxa real da Stone),
--    6 no Pix e R$ 63 em dinheiro (vários dias sem registro; lançados juntos em 20/11). Sem vendedor,
--    sem caixa, sem estoque (como as vendas importadas). Nota "COPIA-<data>-<hora>".
-- 6. Switch OLED usado (06/11, link 8x, R$ 2.400 preço cheio, custo R$ 1.200, vendedor Luiz) = "MANUAL-20261106-1114";
--    22 valores pequenos da Stone sem venda lançados como "Vendas antigas do sistema - Sem discriminação de itens"
--    (custo 0, taxa real da Stone) = "SEMITENS-<data>-<hora>".

DO $$
DECLARE
  v_admin UUID;
  v_tenant UUID;
  v_count INTEGER;
  v_reservation public.product_reservations%ROWTYPE;
  v_sale public.sales%ROWTYPE;
  v_inv public.inventory%ROWTYPE;
  v_qty INTEGER;
  r RECORD;
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

  -- 2) Venda repetida de 08/11: já foi devolvida inteira no PDV em 11/11 (devolução nº 2, "Erro"), então
  --    o faturamento já se anula. Falta: (a) tirar a taxa do cartão dela (a taxa real está na venda de 12/11,
  --    corrigida no 1b) e (b) tirar do estoque o PC Gamer N1 e o Monitor que a devolução pôs de volta, porque
  --    os dois saíram da loja na venda de 12/11 (Orçamento de PC).
  SELECT * INTO v_sale FROM public.sales
  WHERE tenant_id = v_tenant AND invoice_number = 'PDV-1794176921704' AND status = 'CONCLUIDA'
    AND gross_amount = 4300
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '2: venda de 08/11 do Sergio não encontrada como esperado. Nada foi gravado.'; END IF;
  SELECT COUNT(*) INTO v_count FROM public.sale_returns
  WHERE tenant_id = v_tenant AND sale_id = v_sale.id AND total_amount = 4300;
  IF v_count <> 1 THEN RAISE EXCEPTION '2: devolução da venda de 08/11 não encontrada como esperado. Nada foi gravado.'; END IF;
  SELECT COUNT(*) INTO v_count FROM public.sale_payments
  WHERE tenant_id = v_tenant AND sale_id = v_sale.id AND payment_method NOT IN ('PIX', 'CREDITO', 'DEBITO');
  IF v_count <> 0 THEN RAISE EXCEPTION '2: formas de pagamento da venda de 08/11 diferentes do esperado. Nada foi gravado.'; END IF;

  UPDATE public.sale_payments SET fee_percent = 0
  WHERE tenant_id = v_tenant AND sale_id = v_sale.id AND payment_method IN ('CREDITO', 'DEBITO');
  UPDATE public.sales SET fee_amount = 0, net_amount = gross_amount WHERE id = v_sale.id;

  FOR r IN SELECT * FROM (VALUES ('p_new_mb713wy'), ('p_new_980rown')) AS v(product_id) LOOP
    SELECT * INTO v_inv FROM public.inventory
    WHERE tenant_id = v_tenant AND product_id = r.product_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '2: estoque do produto % não encontrado. Nada foi gravado.', r.product_id; END IF;
    v_inv.quantities := public.inventory_with_unit(v_inv.quantities, v_sale.unit_id);
    v_qty := COALESCE((v_inv.quantities -> v_sale.unit_id ->> 'qty')::INTEGER, 0);
    IF v_qty < 1 THEN
      RAISE EXCEPTION '2: o produto % já está com estoque % (alguém já corrigiu?). Nada foi gravado.', r.product_id, v_qty;
    END IF;
    UPDATE public.inventory
    SET quantities = jsonb_set(v_inv.quantities, ARRAY[v_sale.unit_id, 'qty'], to_jsonb(v_qty - 1), true),
        updated_at = NOW()
    WHERE tenant_id = v_tenant AND product_id = r.product_id;
    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
    ) VALUES (
      gen_random_uuid()::TEXT, v_tenant, r.product_id, NULL, v_sale.unit_id, 'CLIENTE', 'SAIDA', 1,
      NULL, NULL, v_admin::TEXT, 'Correção 22/11/2026', NOW(),
      'Correção: voltou ao estoque pela devolução nº 2, mas saiu na venda de 12/11 (Orçamento de PC)',
      ROUND(public.get_store_avg_cost(v_tenant, r.product_id, v_sale.unit_id), 4)
    );
  END LOOP;

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

  -- 4) Venda do Davi: cartão TapStone 12x R$ 3.474, sem o adaptador, data 05/11 20:07
  SELECT * INTO v_sale FROM public.sales
  WHERE tenant_id = v_tenant AND invoice_number = 'PDV-1793990988859' AND status = 'CONCLUIDA'
    AND gross_amount = 5485.71 AND jsonb_array_length(items) = 3
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '4: venda do Davi não encontrada como esperado. Nada foi gravado.'; END IF;
  IF v_sale.fee_amount NOT BETWEEN 205 AND 207 OR v_sale.net_amount <> v_sale.gross_amount - v_sale.fee_amount THEN
    RAISE EXCEPTION '4: taxa da venda do Davi diferente do esperado (%). Nada foi gravado.', v_sale.fee_amount;
  END IF;
  SELECT COUNT(*) INTO v_count FROM jsonb_array_elements(v_sale.items) AS e
  WHERE (e->>'productId' = 'p_a58be439b275' AND (e->>'quantity')::INTEGER = 1 AND (e->>'lineTotal')::NUMERIC = 31.07)
     OR (e->>'productId' = 'p_new_qfboyef' AND (e->>'priceBeforeCardFee')::NUMERIC = 4899.90)
     OR (e->>'productId' = 'p_3acfaaf9e852' AND (e->>'priceBeforeCardFee')::NUMERIC = 349.90);
  IF v_count <> 3 THEN RAISE EXCEPTION '4: itens da venda do Davi diferentes do esperado. Nada foi gravado.'; END IF;
  SELECT COUNT(*) INTO v_count FROM public.sale_payments
  WHERE tenant_id = v_tenant AND sale_id = v_sale.id AND payment_method = 'PIX' AND amount = 2000;
  IF v_count <> 1 THEN RAISE EXCEPTION '4: Pix de R$ 2.000 da venda do Davi não encontrado. Nada foi gravado.'; END IF;

  UPDATE public.sale_payments
  SET amount = 3474.00, installments = 12, fee_percent = 20.306, surcharge_amount = 224.20
  WHERE tenant_id = v_tenant AND sale_id = v_sale.id AND payment_method = 'CREDITO'
    AND amount = 3485.71 AND installments = 4;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION '4: cartão de R$ 3.485,71 da venda do Davi não encontrado. Nada foi gravado.'; END IF;

  -- Juros do cartão (R$ 224,20 = 3.474 - 3.249,80) divididos entre o PS5 e a base, como o PDV faz.
  UPDATE public.sales
  SET items = (
        SELECT jsonb_agg(
          CASE WHEN t.e->>'productId' = 'p_new_qfboyef'
               THEN t.e || '{"cardSurcharge": 209.26, "unitPrice": 5109.16, "lineTotal": 5109.16}'::JSONB
               ELSE t.e || '{"cardSurcharge": 14.94, "unitPrice": 364.84, "lineTotal": 364.84}'::JSONB
          END ORDER BY t.ord)
        FROM jsonb_array_elements(v_sale.items) WITH ORDINALITY AS t(e, ord)
        WHERE t.e->>'productId' <> 'p_a58be439b275'),
      gross_amount = 5474.00, fee_amount = 705.44, net_amount = 4768.56,
      timestamp = '2026-11-05 20:07:16-03'
  WHERE id = v_sale.id;

  -- Adaptador volta ao estoque da loja com o custo congelado na venda (R$ 5,00), como no estorno.
  SELECT * INTO v_inv FROM public.inventory
  WHERE tenant_id = v_tenant AND product_id = 'p_a58be439b275'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '4: estoque do Adaptador Lightning não encontrado. Nada foi gravado.'; END IF;
  v_inv.quantities := public.inventory_with_unit(v_inv.quantities, v_sale.unit_id);
  v_qty := COALESCE((v_inv.quantities -> v_sale.unit_id ->> 'qty')::INTEGER, 0);
  PERFORM public.apply_store_cost_entry(v_tenant, 'p_a58be439b275', v_sale.unit_id, v_qty, 1, 5);
  UPDATE public.inventory
  SET quantities = jsonb_set(v_inv.quantities, ARRAY[v_sale.unit_id, 'qty'], to_jsonb(v_qty + 1), true),
      updated_at = NOW()
  WHERE tenant_id = v_tenant AND product_id = 'p_a58be439b275';
  INSERT INTO public.movements (
    id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
    serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
  ) VALUES (
    gen_random_uuid()::TEXT, v_tenant, 'p_a58be439b275', NULL, 'CLIENTE', v_sale.unit_id, 'SAIDA', 1,
    NULL, NULL, v_admin::TEXT, 'Correção 22/11/2026', NOW(),
    'Correção: adaptador lançado por engano na venda PDV-1793990988859', 5
  );

  -- 5) Cópias e impressões não lançadas
  IF EXISTS (SELECT 1 FROM public.sales WHERE tenant_id = v_tenant AND invoice_number LIKE 'COPIA-%') THEN
    RAISE EXCEPTION '5: as cópias já foram lançadas. Nada foi gravado.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE tenant_id = v_tenant AND id = 'p_new_z0er2mb') THEN
    RAISE EXCEPTION '5: produto Copia e Impressão não encontrado. Nada foi gravado.';
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      ('2026-11-11 10:50:30-03', 'DEBITO', 20.00, 0.19),
      ('2026-11-11 13:22:00-03', 'PIX', 4.00, 0.00),
      ('2026-11-14 14:16:00-03', 'PIX', 5.00, 0.00),
      ('2026-11-14 14:36:24-03', 'DEBITO', 17.00, 0.16),
      ('2026-11-14 18:24:00-03', 'PIX', 10.00, 0.00),
      ('2026-11-15 13:12:37-03', 'CREDITO', 16.00, 0.50),
      ('2026-11-15 20:53:03-03', 'DEBITO', 4.00, 0.04),
      ('2026-11-16 12:43:00-03', 'DEBITO', 12.00, 0.11),
      ('2026-11-16 17:39:00-03', 'PIX', 20.00, 0.00),
      ('2026-11-17 17:29:34-03', 'DEBITO', 10.00, 0.10),
      ('2026-11-18 14:35:16-03', 'CREDITO', 10.00, 0.31),
      ('2026-11-18 14:40:54-03', 'DEBITO', 12.00, 0.11),
      ('2026-11-18 18:36:30-03', 'DEBITO', 5.00, 0.05),
      ('2026-11-18 19:39:22-03', 'CREDITO', 12.00, 0.38),
      ('2026-11-20 15:22:00-03', 'PIX', 12.00, 0.00),
      ('2026-11-20 17:26:00-03', 'PIX', 4.00, 0.00),
      ('2026-11-20 21:00:00-03', 'DINHEIRO', 63.00, 0.00)
    ) AS v(ts, method, gross, fee)
  LOOP
    INSERT INTO public.sales (
      id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
      net_amount, operator_id, operator_name, timestamp, status, requires_approval, reservation_deposit_applied,
      fiscal_type
    ) VALUES (
      'copia-' || to_char(r.ts::TIMESTAMPTZ AT TIME ZONE 'America/Sao_Paulo', 'YYYYMMDD-HH24MI'), v_tenant, NULL,
      'COPIA-' || to_char(r.ts::TIMESTAMPTZ AT TIME ZONE 'America/Sao_Paulo', 'YYYYMMDD-HH24MI'),
      'loja_beb_games_park_shopping_cg',
      jsonb_build_array(jsonb_build_object(
        'itemType', 'PRODUCT', 'productId', 'p_new_z0er2mb', 'itemSku', '7096167', 'itemName', 'Copia e Impressão',
        'quantity', 1, 'unitPrice', r.gross, 'discountPercent', 0, 'lineTotal', r.gross,
        'unitCost', ROUND(r.gross * 0.125, 2), 'costTotal', ROUND(r.gross * 0.125, 2), 'serials', NULL,
        'importedFrom', 'LANCAMENTO_MANUAL')),
      r.method, r.gross, r.fee, r.gross - r.fee, v_admin::TEXT, 'Lançamento manual (cópias)', r.ts::TIMESTAMPTZ,
      'CONCLUIDA', false, 0, 'NAO_FISCAL'
    );
  END LOOP;
  SELECT COUNT(*) INTO v_count FROM public.sales WHERE tenant_id = v_tenant AND invoice_number LIKE 'COPIA-%';
  IF v_count <> 17 THEN RAISE EXCEPTION '5: esperava 17 lançamentos de cópias, gravou %. Nada foi gravado.', v_count; END IF;

  -- 6) Venda do Switch OLED usado (06/11, link de pagamento 8x, preço cheio R$ 2.400, custo R$ 1.200, vendedor Luiz)
  --    e 22 valores pequenos da Stone sem venda (decisão do usuário: lançar sem discriminar itens, custo 0).
  IF EXISTS (SELECT 1 FROM public.sales WHERE tenant_id = v_tenant AND (invoice_number LIKE 'SEMITENS-%' OR invoice_number LIKE 'MANUAL-%')) THEN
    RAISE EXCEPTION '6: esses lançamentos já existem. Nada foi gravado.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pdv_operators WHERE tenant_id = v_tenant AND id = '0cc736ec-546f-44e4-8896-3bf543be45dd') THEN
    RAISE EXCEPTION '6: vendedor Luiz Eduardo não encontrado. Nada foi gravado.';
  END IF;

  INSERT INTO public.sales (
    id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, timestamp, status, requires_approval, reservation_deposit_applied,
    seller_id, seller_code, seller_name, finalized_by_id, finalized_by_code, finalized_by_name, fiscal_type
  ) VALUES (
    'manual-20261106-1114', v_tenant, NULL, 'MANUAL-20261106-1114', 'loja_beb_games_park_shopping_cg',
    '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Nintendo Switch OLED (Seminovo)","quantity":1,"unitPrice":2400,"discountPercent":0,"lineTotal":2400,"unitCost":1200,"costTotal":1200,"serials":null,"importedFrom":"LANCAMENTO_MANUAL"}]'::JSONB,
    'CREDITO', 2400.00, 343.20, 2056.80, v_admin::TEXT, 'Lançamento manual', '2026-11-06 11:14:05-03',
    'CONCLUIDA', false, 0,
    '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo',
    '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'NAO_FISCAL'
  );

  FOR r IN
    SELECT * FROM (VALUES
      ('2026-11-02 14:58:30-03', 'CREDITO', 100.00, 4.44),
      ('2026-11-02 18:18:39-03', 'DEBITO', 3.00, 0.03),
      ('2026-11-02 20:15:04-03', 'DEBITO', 10.00, 0.10),
      ('2026-11-02 20:35:42-03', 'DEBITO', 49.90, 0.47),
      ('2026-11-04 10:37:14-03', 'CREDITO', 4.00, 0.13),
      ('2026-11-06 21:35:37-03', 'DEBITO', 50.00, 0.48),
      ('2026-11-07 18:18:50-03', 'CREDITO', 199.90, 8.40),
      ('2026-11-07 18:59:20-03', 'DEBITO', 6.00, 0.06),
      ('2026-11-07 19:27:51-03', 'DEBITO', 8.00, 0.08),
      ('2026-11-07 20:12:25-03', 'DEBITO', 12.00, 0.11),
      ('2026-11-08 18:32:15-03', 'DEBITO', 12.00, 0.11),
      ('2026-11-10 10:17:16-03', 'DEBITO', 4.00, 0.04),
      ('2026-11-12 19:10:39-03', 'CREDITO', 199.90, 8.40),
      ('2026-11-12 19:12:27-03', 'CREDITO', 49.90, 1.57),
      ('2026-11-14 13:11:12-03', 'DEBITO', 55.93, 0.53),
      ('2026-11-14 16:49:26-03', 'DEBITO', 150.00, 1.43),
      ('2026-11-14 17:48:38-03', 'DEBITO', 55.93, 0.53),
      ('2026-11-15 19:46:17-03', 'CREDITO', 149.90, 6.30),
      ('2026-11-17 18:38:00-03', 'CREDITO', 34.93, 1.10),
      ('2026-11-20 17:12:16-03', 'DEBITO', 30.00, 0.29),
      ('2026-11-20 18:51:24-03', 'DEBITO', 60.00, 0.57),
      ('2026-11-20 19:58:57-03', 'DEBITO', 239.90, 2.28)
    ) AS v(ts, method, gross, fee)
  LOOP
    INSERT INTO public.sales (
      id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
      net_amount, operator_id, operator_name, timestamp, status, requires_approval, reservation_deposit_applied,
      fiscal_type
    ) VALUES (
      'semitens-' || to_char(r.ts::TIMESTAMPTZ AT TIME ZONE 'America/Sao_Paulo', 'YYYYMMDD-HH24MISS'), v_tenant, NULL,
      'SEMITENS-' || to_char(r.ts::TIMESTAMPTZ AT TIME ZONE 'America/Sao_Paulo', 'YYYYMMDD-HH24MISS'),
      'loja_beb_games_park_shopping_cg',
      jsonb_build_array(jsonb_build_object(
        'itemType', 'PRODUCT', 'productId', NULL, 'itemSku', '',
        'itemName', 'Vendas antigas do sistema - Sem discriminação de itens',
        'quantity', 1, 'unitPrice', r.gross, 'discountPercent', 0, 'lineTotal', r.gross,
        'unitCost', 0, 'costTotal', 0, 'serials', NULL, 'importedFrom', 'LANCAMENTO_MANUAL')),
      r.method, r.gross, r.fee, r.gross - r.fee, v_admin::TEXT, 'Lançamento manual (sem itens)', r.ts::TIMESTAMPTZ,
      'CONCLUIDA', false, 0, 'NAO_FISCAL'
    );
  END LOOP;
  SELECT COUNT(*) INTO v_count FROM public.sales WHERE tenant_id = v_tenant AND invoice_number LIKE 'SEMITENS-%';
  IF v_count <> 22 THEN RAISE EXCEPTION '6: esperava 22 lançamentos sem itens, gravou %. Nada foi gravado.', v_count; END IF;
END $$;

-- Conferência 1 (rode depois): vendas corrigidas
select s.invoice_number, s.status, (s.timestamp at time zone 'America/Sao_Paulo') as data_hora,
       s.gross_amount, s.fee_amount, s.client_name, p.payment_method, p.installments, p.amount, p.fee_percent
from public.sales s
left join public.sale_payments p on p.sale_id = s.id and p.payment_method = 'CREDITO'
where s.invoice_number in ('PDV-1794169699750','PDV-1794516672222','PDV-1794271004175',
                           'PDV-1794157785890','PDV-1794176921704','PDV-1795137695644',
                           'PDV-1793990988859')
order by s.timestamp;

-- Conferência 2: cópias (deve dar 17 lançamentos, R$ 236,00, taxas R$ 1,95)
select count(*) as lancamentos, sum(gross_amount) as total, sum(fee_amount) as taxas
from public.sales where invoice_number like 'COPIA-%';

-- Conferência 3: Switch OLED (1 venda, R$ 2.400, taxa R$ 343,20) e sem itens (22, R$ 1.485,19, taxas R$ 37,45)
select left(invoice_number, 6) as grupo, count(*) as lancamentos, sum(gross_amount) as total, sum(fee_amount) as taxas
from public.sales where invoice_number like 'MANUAL-%' or invoice_number like 'SEMITENS-%'
group by 1 order by 1;
