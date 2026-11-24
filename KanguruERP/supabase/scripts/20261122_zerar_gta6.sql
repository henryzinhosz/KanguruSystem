-- Zera o estoque do "Gta 6 (Ps5)" (código 7880264) em todas as lojas, a pedido do usuário em 22/11/2026
-- (entrada de estoque digitada errada: 373 unidades). Grava um movimento AJUSTE por loja, com o motivo.
-- O custo médio da loja não muda (saída não mexe na média). Rodar uma vez só.

DO $$
DECLARE
  v_admin UUID;
  v_tenant UUID;
  v_operator TEXT;
  v_count INTEGER;
  v_product_id TEXT;
  v_quantities JSONB;
  v_unit TEXT;
  v_qty INTEGER;
  v_total INTEGER := 0;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.app_users WHERE role = 'ADMIN';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Esperava 1 usuário ADMIN, achei %. Nada foi gravado.', v_count; END IF;
  SELECT auth_uid, tenant_id, COALESCE(NULLIF(BTRIM(display_name), ''), 'Dono') INTO v_admin, v_tenant, v_operator
  FROM public.app_users WHERE role = 'ADMIN';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::TEXT, true);

  SELECT COUNT(*) INTO v_count FROM public.products
  WHERE tenant_id = v_tenant AND sku = '7880264' AND name ILIKE 'Gta 6%' AND NOT COALESCE(is_serialized, false);
  IF v_count <> 1 THEN RAISE EXCEPTION 'Esperava 1 produto Gta 6 (código 7880264, sem serial), achei %. Nada foi gravado.', v_count; END IF;
  SELECT id INTO v_product_id FROM public.products
  WHERE tenant_id = v_tenant AND sku = '7880264' AND name ILIKE 'Gta 6%';

  SELECT quantities INTO v_quantities FROM public.inventory
  WHERE tenant_id = v_tenant AND product_id = v_product_id FOR UPDATE;
  IF v_quantities IS NULL THEN RAISE EXCEPTION 'Estoque do Gta 6 não encontrado. Nada foi gravado.'; END IF;

  FOR v_unit IN SELECT jsonb_object_keys(v_quantities) LOOP
    v_qty := COALESCE((v_quantities -> v_unit ->> 'qty')::INTEGER, 0);
    CONTINUE WHEN v_qty = 0;
    v_quantities := jsonb_set(v_quantities, ARRAY[v_unit, 'qty'], to_jsonb(0), true);
    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
    ) VALUES (
      gen_random_uuid()::TEXT, v_tenant, v_product_id, NULL, v_unit, 'AJUSTE', 'AJUSTE', v_qty,
      NULL, NULL, v_admin::TEXT, v_operator, NOW(),
      'Correção 22/11/2026: entrada digitada errada, estoque zerado a pedido do dono',
      ROUND(public.get_store_avg_cost(v_tenant, v_product_id, v_unit), 4)
    );
    v_total := v_total + v_qty;
  END LOOP;

  IF v_total = 0 THEN RAISE EXCEPTION 'O Gta 6 já está com estoque zero. Nada foi gravado.'; END IF;

  UPDATE public.inventory SET quantities = v_quantities, updated_at = NOW()
  WHERE tenant_id = v_tenant AND product_id = v_product_id;

  RAISE NOTICE 'Gta 6: % unidade(s) zerada(s).', v_total;
END $$;

-- Conferência (deve mostrar qty 0 em todas as lojas):
select p.name, inv.quantities
from public.inventory inv
join public.products p on p.tenant_id = inv.tenant_id and p.id = inv.product_id
where p.sku = '7880264';
