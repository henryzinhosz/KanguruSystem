-- Venda P4 (identificada pelo usuário em 22/11/2026): 09/11 20:10, TapStone Visa 12x, R$ 2.130,00
-- (a loja recebeu R$ 1.697,48 → taxa real R$ 432,52). Duas peças vendidas avulsas pelo Luiz (24):
--   Processador AMD Ryzen 7 5700X  (custo R$ 1.138,00)
--   Placa-mãe Gigabyte A520M K V2  (custo R$ 360,00)
-- Preço de cada peça: os R$ 2.130,00 divididos na proporção do custo (R$ 1.618,12 + R$ 511,88).
-- Sem caixa, sem estoque, sem nota (como as outras vendas lançadas à mão). Rodar uma vez só.

DO $$
DECLARE
  v_admin UUID;
  v_tenant UUID;
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.app_users WHERE role = 'ADMIN';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Esperava 1 usuário ADMIN, achei %. Nada foi gravado.', v_count; END IF;
  SELECT auth_uid, tenant_id INTO v_admin, v_tenant FROM public.app_users WHERE role = 'ADMIN';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::TEXT, true);

  IF EXISTS (SELECT 1 FROM public.sales WHERE tenant_id = v_tenant AND invoice_number = 'MANUAL-20261109-2010') THEN
    RAISE EXCEPTION 'A venda P4 já foi lançada. Nada foi gravado.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pdv_operators WHERE tenant_id = v_tenant AND id = '0cc736ec-546f-44e4-8896-3bf543be45dd') THEN
    RAISE EXCEPTION 'Vendedor Luiz Eduardo não encontrado. Nada foi gravado.';
  END IF;

  INSERT INTO public.sales (
    id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, timestamp, status, requires_approval, reservation_deposit_applied,
    seller_id, seller_code, seller_name, finalized_by_id, finalized_by_code, finalized_by_name, fiscal_type
  ) VALUES (
    'manual-20261109-2010', v_tenant, NULL, 'MANUAL-20261109-2010', 'loja_beb_games_park_shopping_cg',
    '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Processador AMD Ryzen 7 5700X","quantity":1,"unitPrice":1618.12,"discountPercent":0,"lineTotal":1618.12,"unitCost":1138,"costTotal":1138,"serials":null,"importedFrom":"LANCAMENTO_MANUAL"},
      {"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Placa-mãe Gigabyte A520M K V2","quantity":1,"unitPrice":511.88,"discountPercent":0,"lineTotal":511.88,"unitCost":360,"costTotal":360,"serials":null,"importedFrom":"LANCAMENTO_MANUAL"}]'::JSONB,
    'CREDITO', 2130.00, 432.52, 1697.48, v_admin::TEXT, 'Lançamento manual', '2026-11-09 20:10:23-03',
    'CONCLUIDA', false, 0,
    '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo',
    '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'NAO_FISCAL'
  );
END $$;

-- Conferência (deve dar 1 venda, R$ 2.130,00, taxa R$ 432,52):
select invoice_number, (timestamp at time zone 'America/Sao_Paulo') as data_hora, gross_amount, fee_amount, seller_name
from public.sales where invoice_number = 'MANUAL-20261109-2010';
