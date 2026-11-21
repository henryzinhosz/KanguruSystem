-- Importa as vendas do sistema antigo (SISCEL) de 01 a 06/11/2026 (39 vendas, R$ 10228,06).
-- Fonte: relatórios "Resumo de Vendas com Produtos" de cada dia + extrato de recebimentos da Stone.
-- O que faz:
--   * grava cada venda com o número antigo (nota "ANT-171214" etc.), vendedor, itens, custo e a taxa real da Stone;
--   * NÃO mexe no estoque, NÃO entra em nenhum caixa do PDV e NÃO emite nota;
--   * não cria linhas de pagamento (as vendas ficam como as vendas antigas: uma forma por venda; duas vendas
--     pagas em duas formas ficam como "DIVIDIDO").
-- Roda tudo de uma vez: se der qualquer erro, nada é gravado. Rodar uma vez só (o script recusa se já rodou).
-- Taxas (total R$ 609,67): Visa/Master conforme a tabela da maquininha, Elo débito 1,69%,
-- Xbox Series S pelo link de pagamento 10x (16,71%), notebook no débito (0,95%; no sistema antigo estava como Pix).

DO $$
DECLARE
  v_admin UUID;
  v_tenant UUID;
  v_unit TEXT := 'loja_beb_games_park_shopping_cg';
  v_count INTEGER;
  r RECORD;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.app_users WHERE role = 'ADMIN';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Esperava 1 usuário ADMIN, achei %. Nada foi gravado.', v_count; END IF;
  SELECT auth_uid, tenant_id INTO v_admin, v_tenant FROM public.app_users WHERE role = 'ADMIN';

  IF NOT EXISTS (SELECT 1 FROM public.store_configs WHERE tenant_id = v_tenant AND unit_id = v_unit) THEN
    RAISE EXCEPTION 'Loja % não encontrada. Nada foi gravado.', v_unit;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales WHERE tenant_id = v_tenant AND invoice_number LIKE 'ANT-%') THEN
    RAISE EXCEPTION 'As vendas antigas já foram importadas. Nada foi gravado.';
  END IF;
  SELECT COUNT(*) INTO v_count FROM public.pdv_operators
  WHERE tenant_id = v_tenant AND id IN ('0cc736ec-546f-44e4-8896-3bf543be45dd', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '676c91d0-775f-448b-9b03-517844536d8d');
  IF v_count <> 3 THEN RAISE EXCEPTION 'Vendedores não encontrados. Nada foi gravado.'; END IF;

  -- Age como o ADMIN (só dentro desta transação).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::TEXT, true);

  FOR r IN
    SELECT * FROM (VALUES
    (171115, '2026-11-01 14:25:16-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DIVIDIDO', 15.00, 0.31, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":3,"unitPrice":5,"discountPercent":0,"lineTotal":15,"unitCost":0.5,"costTotal":1.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171116, '2026-11-01 16:41:06-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'DEBITO', 149.90, 1.42, NULL, '[{"itemType":"PRODUCT","productId":"p_a40c3a0970f3","itemSku":"774545","itemName":"Pelicula Nintendo Switch","quantity":1,"unitPrice":149.9,"discountPercent":0,"lineTotal":149.9,"unitCost":55,"costTotal":55,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171117, '2026-11-01 14:35:04-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'DEBITO', 29.90, 0.28, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Cabo de rede 5M X-Cell","quantity":1,"unitPrice":29.9,"discountPercent":0,"lineTotal":29.9,"unitCost":10,"costTotal":10,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171118, '2026-11-01 15:00:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'PIX', 99.90, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_e0936bb31c00","itemSku":"7573403","itemName":"Power Bank 5000mAh","quantity":1,"unitPrice":99.9,"discountPercent":0,"lineTotal":99.9,"unitCost":38,"costTotal":38,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171119, '2026-11-01 15:30:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'PIX', 200.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_927ba8bd2a91","itemSku":"957535","itemName":"Controle Ps4 (Homologado)","quantity":1,"unitPrice":200,"discountPercent":0,"lineTotal":200,"unitCost":65,"costTotal":65,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171122, '2026-11-01 16:00:00-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'DINHEIRO', 39.90, 0.00, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Cabo carregador (diversos)","quantity":1,"unitPrice":39.9,"discountPercent":0,"lineTotal":39.9,"unitCost":14,"costTotal":14,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171126, '2026-11-01 17:30:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'PIX', 270.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Headset Redragon Ire Pro","quantity":1,"unitPrice":270,"discountPercent":0,"lineTotal":270,"unitCost":127,"costTotal":127,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171127, '2026-11-01 19:08:01-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'CREDITO', 249.90, 12.47, NULL, '[{"itemType":"PRODUCT","productId":"p_927ba8bd2a91","itemSku":"957535","itemName":"Controle Ps4 (Homologado)","quantity":1,"unitPrice":249.9,"discountPercent":0,"lineTotal":249.9,"unitCost":65,"costTotal":65,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171131, '2026-11-01 19:24:08-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'CREDITO', 50.00, 1.57, NULL, '[{"itemType":"PRODUCT","productId":"p_new_xgh8how","itemSku":"743594","itemName":"GRIP Para Controle","quantity":1,"unitPrice":20,"discountPercent":0,"lineTotal":20,"unitCost":14.9,"costTotal":14.9,"serials":null,"importedFrom":"SISTEMA_ANTIGO"},{"itemType":"PRODUCT","productId":"p_new_0m1bgyl","itemSku":"9215848","itemName":"Capa para controle","quantity":1,"unitPrice":30,"discountPercent":0,"lineTotal":30,"unitCost":9.9,"costTotal":9.9,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171138, '2026-11-01 20:00:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'PIX', 29.90, 0.00, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Cabo carregador (diversos)","quantity":1,"unitPrice":29.9,"discountPercent":0,"lineTotal":29.9,"unitCost":7,"costTotal":7,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171143, '2026-11-01 21:00:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DINHEIRO', 5.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":1,"unitPrice":5,"discountPercent":0,"lineTotal":5,"unitCost":0.5,"costTotal":0.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171144, '2026-11-02 14:02:08-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'DEBITO', 249.90, 2.37, NULL, '[{"itemType":"PRODUCT","productId":"p_927ba8bd2a91","itemSku":"957535","itemName":"Controle Ps4 (Homologado)","quantity":1,"unitPrice":249.9,"discountPercent":0,"lineTotal":249.9,"unitCost":65,"costTotal":65,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171149, '2026-11-02 15:30:00-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'PIX', 199.90, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_73a7cdd3db43","itemSku":"772693","itemName":"Power Bank 20000mAh","quantity":1,"unitPrice":199.9,"discountPercent":0,"lineTotal":199.9,"unitCost":75,"costTotal":75,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171154, '2026-11-02 17:00:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'PIX', 224.90, 0.00, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Microfone Skipper MG-300 OEX","quantity":1,"unitPrice":224.9,"discountPercent":0,"lineTotal":224.9,"unitCost":224.9,"costTotal":224.9,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171158, '2026-11-02 19:22:37-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'CREDITO', 1100.00, 34.54, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Controle Ps5 Dual Sense Chroma Pearl","quantity":1,"unitPrice":550,"discountPercent":0,"lineTotal":550,"unitCost":390,"costTotal":390,"serials":null,"importedFrom":"SISTEMA_ANTIGO"},{"itemType":"PRODUCT","productId":"p_60775eda7d99","itemSku":"7383776","itemName":"Controle Ps5 Dual Sense Chroma Teal","quantity":1,"unitPrice":550,"discountPercent":0,"lineTotal":550,"unitCost":370,"costTotal":370,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171165, '2026-11-03 13:00:00-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'DINHEIRO', 12.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":3,"unitPrice":4,"discountPercent":0,"lineTotal":12,"unitCost":0.5,"costTotal":1.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171167, '2026-11-03 17:02:23-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'CREDITO', 324.80, 16.21, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Headset Redragon Zeus Lite","quantity":1,"unitPrice":249.9,"discountPercent":0,"lineTotal":249.9,"unitCost":108,"costTotal":108,"serials":null,"importedFrom":"SISTEMA_ANTIGO"},{"itemType":"PRODUCT","productId":"p_3c2b6873cc15","itemSku":"9222722","itemName":"Mouse Dual Mode Ms-603 (Cinza)","quantity":1,"unitPrice":74.9,"discountPercent":0,"lineTotal":74.9,"unitCost":51,"costTotal":51,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171168, '2026-11-03 18:17:55-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'CREDITO', 2999.90, 501.28, 'Djuli Luz Loura Gomes', '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Xbox Series S 512GB (Seminovo)","quantity":1,"unitPrice":2999.9,"discountPercent":0,"lineTotal":2999.9,"unitCost":1200,"costTotal":1200,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171169, '2026-11-03 19:00:00-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'DINHEIRO', 12.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":3,"unitPrice":4,"discountPercent":0,"lineTotal":12,"unitCost":0.5,"costTotal":1.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171170, '2026-11-03 19:30:00-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'PIX', 8.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":1,"unitPrice":8,"discountPercent":0,"lineTotal":8,"unitCost":0.5,"costTotal":0.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171173, '2026-11-04 11:00:00-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'PIX', 8.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":2,"unitPrice":4,"discountPercent":0,"lineTotal":8,"unitCost":0.5,"costTotal":1,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171176, '2026-11-04 13:41:21-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'DEBITO', 4.00, 0.07, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":1,"unitPrice":4,"discountPercent":0,"lineTotal":4,"unitCost":0.5,"costTotal":0.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171177, '2026-11-04 13:50:35-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'DEBITO', 124.90, 1.19, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Teclado Cobby TC206 OEX","quantity":1,"unitPrice":124.9,"discountPercent":0,"lineTotal":124.9,"unitCost":50,"costTotal":50,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171180, '2026-11-04 15:00:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DINHEIRO', 4.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":1,"unitPrice":4,"discountPercent":0,"lineTotal":4,"unitCost":0.5,"costTotal":0.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171182, '2026-11-04 17:42:31-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'DEBITO', 6.00, 0.10, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":2,"unitPrice":3,"discountPercent":0,"lineTotal":6,"unitCost":0.5,"costTotal":1,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171183, '2026-11-04 18:00:00-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'DINHEIRO', 4.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":1,"unitPrice":4,"discountPercent":0,"lineTotal":4,"unitCost":0.5,"costTotal":0.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171184, '2026-11-04 18:32:56-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DEBITO', 55.93, 0.53, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Almofada M","quantity":1,"unitPrice":55.93,"discountPercent":0,"lineTotal":55.93,"unitCost":55.93,"costTotal":55.93,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171186, '2026-11-04 19:00:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DINHEIRO', 30.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_0m1bgyl","itemSku":"9215848","itemName":"Capa para controle","quantity":1,"unitPrice":30,"discountPercent":0,"lineTotal":30,"unitCost":9.9,"costTotal":9.9,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171192, '2026-11-05 14:39:23-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'CREDITO', 249.90, 7.85, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Headset Redragon Zeus Lite","quantity":1,"unitPrice":249.9,"discountPercent":0,"lineTotal":249.9,"unitCost":108,"costTotal":108,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171194, '2026-11-05 16:14:53-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DEBITO', 39.90, 0.38, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Cabo carregador (diversos)","quantity":1,"unitPrice":39.9,"discountPercent":0,"lineTotal":39.9,"unitCost":14,"costTotal":14,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171196, '2026-11-05 17:00:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'PIX', 29.90, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_xgh8how","itemSku":"743594","itemName":"GRIP Para Controle","quantity":1,"unitPrice":29.9,"discountPercent":0,"lineTotal":29.9,"unitCost":14.9,"costTotal":14.9,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171197, '2026-11-05 18:00:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DINHEIRO', 10.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":1,"unitPrice":10,"discountPercent":0,"lineTotal":10,"unitCost":0.5,"costTotal":0.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171207, '2026-11-05 21:07:51-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'DEBITO', 2800.00, 26.60, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Notebook Acer (Seminovo)","quantity":1,"unitPrice":2800,"discountPercent":0,"lineTotal":2800,"unitCost":2000,"costTotal":2000,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171214, '2026-11-06 13:43:46-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'CREDITO', 41.93, 1.32, NULL, '[{"itemType":"PRODUCT","productId":null,"itemSku":"","itemName":"Copos N01","quantity":1,"unitPrice":41.93,"discountPercent":0,"lineTotal":41.93,"unitCost":41.93,"costTotal":41.93,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171216, '2026-11-06 14:00:00-03', '0cc736ec-546f-44e4-8896-3bf543be45dd', '24', 'Luiz Eduardo', 'DINHEIRO', 29.90, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_xgh8how","itemSku":"743594","itemName":"GRIP Para Controle","quantity":1,"unitPrice":29.9,"discountPercent":0,"lineTotal":29.9,"unitCost":14.9,"costTotal":14.9,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171217, '2026-11-06 14:15:18-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DEBITO', 25.00, 0.24, NULL, '[{"itemType":"PRODUCT","productId":"p_a58be439b275","itemSku":"955338","itemName":"Adaptador Lightning Para P2","quantity":1,"unitPrice":25,"discountPercent":0,"lineTotal":25,"unitCost":5,"costTotal":5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171218, '2026-11-06 14:30:00-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'DINHEIRO', 4.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_new_z0er2mb","itemSku":"7096167","itemName":"Copia e Impressão","quantity":1,"unitPrice":4,"discountPercent":0,"lineTotal":4,"unitCost":0.5,"costTotal":0.5,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171230, '2026-11-06 15:00:00-03', '676c91d0-775f-448b-9b03-517844536d8d', '29', 'Felippe', 'DIVIDIDO', 460.00, 0.00, NULL, '[{"itemType":"PRODUCT","productId":"p_7d29c8f03772","itemSku":"755972","itemName":"Controle Ps5 Dual Sense Preto","quantity":1,"unitPrice":460,"discountPercent":0,"lineTotal":460,"unitCost":350,"costTotal":350,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB),
    (171234, '2026-11-06 21:23:53-03', 'b27e3c17-38f3-4292-b652-b7510ad7402d', '40', 'Caio', 'CREDITO', 29.90, 0.94, NULL, '[{"itemType":"PRODUCT","productId":"p_new_0m1bgyl","itemSku":"9215848","itemName":"Capa para controle","quantity":1,"unitPrice":29.9,"discountPercent":0,"lineTotal":29.9,"unitCost":9.9,"costTotal":9.9,"serials":null,"importedFrom":"SISTEMA_ANTIGO"}]'::JSONB)
    ) AS v(num, ts, seller_id, seller_code, seller_name, method, gross, fee, client_name, items)
  LOOP
    INSERT INTO public.sales (
      id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
      net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval,
      reservation_deposit_applied, seller_id, seller_code, seller_name, finalized_by_id, finalized_by_code,
      finalized_by_name, fiscal_type
    ) VALUES (
      'ant-' || r.num, v_tenant, NULL, 'ANT-' || r.num, v_unit, r.items, r.method, r.gross, r.fee,
      r.gross - r.fee, v_admin::TEXT, 'Importação do sistema antigo', NULL, r.client_name, r.ts::TIMESTAMPTZ,
      'CONCLUIDA', false, 0, r.seller_id::UUID, r.seller_code, r.seller_name, r.seller_id::UUID, r.seller_code,
      r.seller_name, 'NAO_FISCAL'
    );
  END LOOP;

  SELECT COUNT(*) INTO v_count FROM public.sales WHERE tenant_id = v_tenant AND invoice_number LIKE 'ANT-%';
  IF v_count <> 39 THEN RAISE EXCEPTION 'Esperava 39 vendas, gravou %. Nada foi gravado.', v_count; END IF;
END $$;

-- Conferência (rode depois): por dia, deve dar
--   01/11 1.139,40 | 02/11 1.774,70 | 03/11 3.356,70 | 04/11 236,83 | 05/11 3.129,70 | 06/11 590,73
select (timestamp at time zone 'America/Sao_Paulo')::date as dia, count(*) as vendas,
       sum(gross_amount) as faturamento, sum(fee_amount) as taxas
from public.sales where invoice_number like 'ANT-%'
group by 1 order by 1;
