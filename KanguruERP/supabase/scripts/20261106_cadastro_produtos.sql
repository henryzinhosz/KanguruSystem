-- Cadastro inicial dos produtos da loja (planilha "Lista de Produtos.xlsx", conferida em 2026-11-06).
-- 95 produtos com dados fiscais: NCM pelo tipo, origem 2, CSOSN 102 (confirmado pelo usuario), ICMS 0.
-- "Total de tributos %" fica vazio: o contador informa (IBPT) antes das notas em producao.
-- Estoque: entra na loja Park Shopping Campo Grande pela mesma funcao da Entrada de Estoque do ERP
-- (register_stock_entry: custo medio, movimento "Cadastro inicial"). O Switch Lite (com serial)
-- NAO recebe estoque aqui: dar entrada pelo ERP com o numero de serie (e imprimir a etiqueta).
-- PRE-REQUISITOS: migrations 20261120 (codigo aleatorio) e 20261121 (garantia em dias) aplicadas;
-- produtos antigos apagados. Roda como o usuario ADMIN da empresa (para o banco aplicar as mesmas
-- regras do ERP). Tudo ou nada.

BEGIN;

DO $$
DECLARE
  v_admin UUID;
  v_tenant UUID;
  v_unit TEXT;
  v_count INTEGER;
  v_id TEXT;
  r RECORD;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.app_users WHERE role = 'ADMIN';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Esperava 1 usuário ADMIN, achei %. Nada foi gravado.', v_count; END IF;
  SELECT auth_uid, tenant_id INTO v_admin, v_tenant FROM public.app_users WHERE role = 'ADMIN';

  SELECT COUNT(*) INTO v_count FROM public.store_configs WHERE tenant_id = v_tenant AND trade_name ILIKE '%park%';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Não achei a loja Park Shopping (achei %). Nada foi gravado.', v_count; END IF;
  SELECT unit_id INTO v_unit FROM public.store_configs WHERE tenant_id = v_tenant AND trade_name ILIKE '%park%';

  IF EXISTS (SELECT 1 FROM public.products WHERE tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'Ainda existem produtos cadastrados. Apague os antigos antes. Nada foi gravado.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'warranty_days') THEN
    RAISE EXCEPTION 'Aplique a migration 20261121 (garantia em dias) antes. Nada foi gravado.';
  END IF;

  -- Age como o ADMIN (so dentro desta transacao).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::TEXT, true);

  FOR r IN
    SELECT * FROM (VALUES
    (NULL, 'Cabo tipo C (Normal)', 'Carregadores', 'Chinesa', 7.00, 29.90, '8544.42.00', 0, 7, false, 11),
    (NULL, 'Cabo Lightning (Normal)', 'Carregadores', 'Chinesa', 7.00, 29.90, '8544.42.00', 0, 7, false, 11),
    (NULL, 'Kit Carregador Lightning', 'Carregadores', 'Chinesa', 14.00, 49.90, '8504.40.10', 0, 7, false, 6),
    (NULL, 'Kit Carregador tipo C', 'Carregadores', 'Chinesa', 14.00, 49.90, '8504.40.10', 0, 7, false, 6),
    (NULL, 'Kit Carregador Micro Usb', 'Carregadores', 'Chinesa', 14.00, 39.90, '8504.40.10', 0, 7, false, 5),
    (NULL, 'Power Bank 5000mAh', 'Carregadores', 'Chinesa', 38.00, 99.90, '8507.60.00', 0, 7, false, 4),
    (NULL, 'Power Bank 10000mAh', 'Carregadores', 'Chinesa', 42.00, 149.90, '8507.60.00', 0, 7, false, 4),
    (NULL, 'Power Bank 20000mAh', 'Carregadores', 'Chinesa', 75.00, 199.90, '8507.60.00', 0, 7, false, 5),
    (NULL, 'Fone Redmi Dot', 'Fones', 'Chinesa', 14.00, 39.90, '8518.30.00', 0, 7, false, 1),
    (NULL, 'Fone Sem Fio KD-790', 'Fones', 'Chinesa', 14.00, 99.90, '8518.30.00', 0, 7, false, 4),
    (NULL, 'Fone Com Fio Lightning', 'Fones', 'Chinesa', 14.00, 39.90, '8518.30.00', 0, 7, false, 4),
    (NULL, 'Cabo Tipo C (Turbo)', 'Carregadores', 'Chinesa', 5.00, 39.90, '8544.42.00', 0, 7, false, 11),
    (NULL, 'Cabo Lightning (Turbo)', 'Carregadores', 'Chinesa', 5.00, 39.90, '8544.42.00', 0, 7, false, 10),
    (NULL, 'Cabo Micro Usb (Turbo)', 'Carregadores', 'Chinesa', 7.00, 39.90, '8544.42.00', 0, 7, false, 19),
    (NULL, 'Adaptador Lightning Para P2', 'Adaptadores', 'Chinesa', 5.00, 29.90, '8536.69.90', 0, 7, false, 6),
    (NULL, 'Carregador Para Carro', 'Carregadores', 'Chinesa', 14.00, 49.90, '8504.40.10', 0, 7, false, 4),
    (NULL, 'Adaptador Wifi 950', 'Adaptadores', 'Chinesa', 9.00, 39.90, '8517.62.77', 0, 7, false, 16),
    (NULL, 'Pasta Termica Nitrogen 1,5g', 'Outros', 'Nitrogen', 45.00, 99.90, '3824.99.89', 0, 7, false, 5),
    (NULL, 'Cabo HDMI 1M', 'Cabos', 'Chinesa', 4.50, 19.90, '8544.42.00', 0, 7, false, 11),
    (NULL, 'Cabo HDMI 2M', 'Cabos', 'Chinesa', 8.00, 29.90, '8544.42.00', 0, 7, false, 4),
    (NULL, 'Cabo HDMI 3M', 'Cabos', 'Chinesa', 9.00, 39.90, '8544.42.00', 0, 7, false, 10),
    (NULL, 'Cabo HDMI 5M', 'Cabos', 'Chinesa', 15.00, 49.90, '8544.42.00', 0, 7, false, 10),
    (NULL, 'Cabo de força', 'Cabos', 'Chinesa', 10.00, 29.90, '8544.42.00', 0, 7, false, 4),
    (NULL, 'Cabo de rede 1M', 'Cabos', 'Chinesa', 7.00, 19.90, '8544.42.00', 0, 7, false, 6),
    (NULL, 'Cabo de rede 3M', 'Cabos', 'Chinesa', 9.00, 29.90, '8544.42.00', 0, 7, false, 4),
    (NULL, 'Filtro de linha', 'Outros', 'Chinesa', 28.00, 79.90, '8536.30.00', 0, 7, false, 6),
    (NULL, 'Controle Ps5 Dual Sense Branco', 'Videogames', 'Sony', 350.00, 499.90, '9504.50.00', 3, NULL, false, 3),
    (NULL, 'Controle Ps5 Dual Sense Preto', 'Videogames', 'Sony', 350.00, 499.90, '9504.50.00', 3, NULL, false, 2),
    (NULL, 'Controle Ps5 Dual Sense Chroma Teal', 'Videogames', 'Sony', 370.00, 599.90, '9504.50.00', 3, NULL, false, 1),
    (NULL, 'Base Carregadora Original', 'Videogames', 'Sony', 165.00, 349.90, '9504.50.00', 3, NULL, false, 5),
    (NULL, 'Controle Xbox Preto', 'Videogames', 'Xbox', 345.00, 499.90, '9504.50.00', 3, NULL, false, 2),
    (NULL, 'Controle Ps4 (Homologado)', 'Videogames', 'Chinesa', 65.00, 249.90, '9504.50.00', 2, NULL, false, 13),
    (NULL, 'Base Carregadora Dobe (PS4)', 'Videogames', 'Dobe', 40.00, 199.90, '9504.50.00', 0, 7, false, 8),
    (NULL, 'Base Carregadora Dobe (Ps5)', 'Videogames', 'Dobe', 45.00, 299.90, '9504.50.00', 0, 7, false, 12),
    (NULL, 'Funkos Pop (Paralelo)', 'Geek', 'Chinesa', 19.75, 49.90, '9503.00.99', 0, NULL, false, 17),
    (NULL, 'Funkos Pop (Original)', 'Geek', 'Funko', 150.00, 199.90, '9503.00.99', 0, NULL, false, 9),
    (NULL, 'Pro Controle Switch (Paralelo)', 'Videogames', 'Chinesa', 83.00, 199.90, '9504.50.00', 0, 7, false, 3),
    (NULL, 'Controle Ipega', 'Videogames', 'Chinesa', 83.00, 199.90, '9504.50.00', 0, 7, false, 1),
    (NULL, 'Case Nintendo (Personalizada)', 'Videogames', 'Chinesa', 80.00, 299.90, '9504.50.00', 0, NULL, false, 4),
    (NULL, 'Case Nintendo (Preta)', 'Videogames', 'Chinesa', 80.00, 199.90, '9504.50.00', 0, NULL, false, 2),
    (NULL, 'Base Carregadora Ipega (Ps5)', 'Videogames', 'Chinesa', 60.00, 199.99, '9504.50.00', 0, NULL, false, 2),
    (NULL, 'Capa Silicone Switch (Oled)', 'Videogames', 'Chinesa', 21.00, 99.90, '9504.50.00', 0, NULL, false, 10),
    (NULL, 'Pelicula Nintendo Switch', 'Videogames', 'Chinesa', 55.00, 149.90, '9504.50.00', 0, NULL, false, 16),
    (NULL, 'Pelicula Ps Portal', 'Videogames', 'Chinesa', 55.00, 149.90, '9504.50.00', 0, NULL, false, 1),
    (NULL, 'Jogos Nintendo (Usado)', 'Videogames', 'Outros', 150.00, 249.90, '8523.51.90', 0, 7, false, 6),
    (NULL, 'Jogos Ps4 (Usados)', 'Videogames', 'Outros', 50.00, 150.00, '8523.49.90', 0, 7, false, 14),
    (NULL, 'Jogos Ps5 (Usados)', 'Videogames', 'Outros', 50.00, 199.90, '8523.49.90', 0, 7, false, 1),
    (NULL, 'Jogos Xbox (Usados)', 'Videogames', 'Outros', 50.00, 149.90, '8523.49.90', 0, 7, false, 14),
    (NULL, 'Jogos Ps3 (Usados)', 'Videogames', 'Outros', 35.00, 49.90, '8523.49.90', 0, 7, false, 6),
    (NULL, 'Switch Lite (Turquesa)', 'Videogames', 'Nintendo', 1380.00, 2200.00, '9504.50.00', 3, NULL, true, 1),
    (NULL, 'Mouse Wave Mc-105 (Preto)', 'Periféricos', 'Oex', 39.25, 99.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Wave Mc-105 (Branco)', 'Periféricos', 'Oex', 51.00, 99.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Arena Mc-102 (Preto)', 'Periféricos', 'Oex', 49.00, 99.90, '8471.60.53', 3, NULL, false, 1),
    (NULL, 'Mouse War Mc-100 (Preto)', 'Periféricos', 'Oex', 28.16, 99.90, '8471.60.53', 3, NULL, false, 1),
    (NULL, 'Mouse Edge Ms-607 (Rosa)', 'Periféricos', 'Oex', 30.00, 74.90, '8471.60.53', 3, NULL, false, 1),
    (NULL, 'Mouse Dual Mode Ms-603 (Branco)', 'Periféricos', 'Oex', 51.00, 74.90, '8471.60.53', 3, NULL, false, 1),
    (NULL, 'Mouse Dual Mode Ms-603 (Cinza)', 'Periféricos', 'Oex', 51.00, 74.90, '8471.60.53', 3, NULL, false, 1),
    (NULL, 'Web Cam Pro W-100', 'Periféricos', 'Oex', 105.29, 199.90, '8525.89.29', 3, NULL, false, 2),
    (NULL, 'Headset Spark HS-317', 'Periféricos', 'Oex', 232.49, 249.90, '8518.30.00', 3, NULL, false, 2),
    (NULL, 'Headset Zion HS-415', 'Periféricos', 'Oex', 335.00, 335.00, '8518.30.00', 3, NULL, false, 1),
    (NULL, 'Headset Beast XR HS-404', 'Periféricos', 'Oex', 157.38, 199.90, '8518.30.00', 3, NULL, false, 2),
    (NULL, 'Headset CragBlade Pro (Branco)', 'Periféricos', 'Redragon', 180.91, 399.90, '8518.30.00', 3, NULL, false, 1),
    (NULL, 'Headset Mento (Preto)', 'Periféricos', 'Redragon', 84.83, 229.90, '8518.30.00', 3, NULL, false, 1),
    (NULL, 'Headset Ares (Preto)', 'Periféricos', 'Redragon', 42.00, 199.90, '8518.30.00', 3, NULL, false, 2),
    (NULL, 'Teclado fizz Magnetico Rgb (Switch Ambermag)', 'Periféricos', 'Redragon', 170.05, 349.90, '8471.60.52', 3, NULL, false, 1),
    (NULL, 'Teclado Mecanico Kumara Branco e Cinza', 'Periféricos', 'Redragon', 110.00, 299.90, '8471.60.52', 3, NULL, false, 1),
    (NULL, 'Teclado Kumara Magnetico RT (Preto)', 'Periféricos', 'Redragon', 189.05, 349.90, '8471.60.52', 3, NULL, false, 1),
    (NULL, 'Teclado Mecanico Mitra Preto (Switch Azul)', 'Periféricos', 'Redragon', 163.40, 299.90, '8471.60.52', 3, NULL, false, 1),
    (NULL, 'Headset Medea RGB (Preto)', 'Periféricos', 'Redragon', 99.75, 249.90, '8518.30.00', 3, NULL, false, 1),
    (NULL, 'Teclado Kumara Magnetico Pro Branco (Switch Azul)', 'Periféricos', 'Redragon', 224.20, 299.90, '8471.60.52', 3, NULL, false, 1),
    (NULL, 'Teclado Mecanico Mitra Rosa e Branco (Switch Marrom)', 'Periféricos', 'Redragon', 137.75, 299.90, '8471.60.52', 3, NULL, false, 1),
    (NULL, 'Teclado Mecanico Fizz RGB Branco e Rosa (Switch Azul)', 'Periféricos', 'Redragon', 169.98, 299.90, '8471.60.52', 3, NULL, false, 1),
    (NULL, 'Mouse Hana RGB Preto Sem Fio', 'Periféricos', 'Redragon', 59.00, 179.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Cobra V3 RGB Preto', 'Periféricos', 'Redragon', 58.00, 199.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Cobra V2 Cypher RGB Branco', 'Periféricos', 'Redragon', 84.83, 279.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Predator RGB Preto', 'Periféricos', 'Redragon', 47.38, 179.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Storm Basic RGB Preto', 'Periféricos', 'Redragon', 52.85, 149.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Invader Pro RGB Preto Sem Fio', 'Periféricos', 'Redragon', 73.80, 249.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Invader RGB Preto', 'Periféricos', 'Redragon', 49.20, 179.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Storm Elite RGB Preto', 'Periféricos', 'Redragon', 101.74, 279.90, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Mouse Deicide RGB Preto', 'Periféricos', 'Redragon', 67.52, 179.60, '8471.60.53', 3, NULL, false, 2),
    (NULL, 'Headset Pandora 2 RGB', 'Periféricos', 'Redragon', 101.00, 249.90, '8518.30.00', 3, NULL, false, 1),
    (NULL, 'Headset Diomedes Preto', 'Periféricos', 'Redragon', 139.00, 349.90, '8518.30.00', 3, NULL, false, 1),
    (NULL, 'Headset Pelias Preto', 'Periféricos', 'Redragon', 89.99, 199.90, '8518.30.00', 3, NULL, false, 1),
    ('7908705553605', 'Funko Pop Star Wars', 'Geek', 'Funko', 199.90, 299.90, '9503.00.99', 0, NULL, false, 1),
    (NULL, 'Funko Pop Dragon Ball + Camiseta', 'Geek', 'Funko', 199.90, 299.90, '9503.00.99', 0, NULL, false, 1),
    (NULL, 'Boneco PVC Dragon Ball', 'Geek', 'Liska Geek', 74.90, 149.90, '9503.00.99', 0, NULL, false, 4),
    (NULL, 'Boneco PVC Rei Gramaffe', 'Geek', 'Liska Geek', 49.90, 99.90, '9503.00.99', 0, NULL, false, 1),
    (NULL, 'Boneco PVC Satoru Gojo', 'Geek', 'Liska Geek', 49.90, 99.90, '9503.00.99', 0, NULL, false, 1),
    (NULL, 'Boneco PVC Demon Slayer', 'Geek', 'Liska Geek', 74.90, 149.90, '9503.00.99', 0, NULL, false, 1),
    (NULL, 'Bonecos PVC Tam P', 'Geek', 'Liska Geek', 19.90, 39.90, '9503.00.99', 0, NULL, false, 11),
    (NULL, 'Bonecos PVC Tam M', 'Geek', 'Liska Geek', 24.90, 49.90, '9503.00.99', 0, NULL, false, 11),
    (NULL, 'Boneco PVC Tam G', 'Geek', 'Liska Geek', 34.90, 69.90, '9503.00.99', 0, NULL, false, 2),
    (NULL, 'Boneco One Piece (Luffy)', 'Geek', 'Liska Geek', 49.90, 99.90, '9503.00.99', 0, NULL, false, 1),
    (NULL, 'Boneco One Piece (Zoro)', 'Geek', 'Liska Geek', 49.90, 99.90, '9503.00.99', 0, NULL, false, 1)
    ) AS t(code, name, category, brand, cost, price, ncm, months, days, serialized, qty)
  LOOP
    v_id := 'p_' || substr(md5(random()::TEXT || clock_timestamp()::TEXT), 1, 12);
    INSERT INTO public.products (
      id, tenant_id, sku, name, category, brand, cost_price, sell_price, ncm,
      warranty_months, warranty_days, is_serialized, is_used,
      icms_origin, csosn, icms_cst, icms_rate, icms_reduction, cest, tax_burden_percent
    ) VALUES (
      v_id, v_tenant, COALESCE(r.code, ''), r.name, r.category, r.brand, r.cost, r.price, r.ncm,
      r.months, r.days, r.serialized, false,
      '2', '102', NULL, 0, 0, NULL, NULL
    );
    IF r.qty > 0 AND NOT r.serialized THEN
      PERFORM public.register_stock_entry(
        v_id,
        jsonb_build_array(jsonb_build_object('unitId', v_unit, 'quantity', r.qty)),
        r.cost,
        'Cadastro inicial (planilha)'
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;

-- Conferencia (rodar depois)
SELECT COUNT(*) AS produtos,
  COUNT(*) FILTER (WHERE sku ~ '^[79][0-9]{5,6}$') AS com_codigo_automatico,
  COUNT(*) FILTER (WHERE warranty_days IS NOT NULL) AS garantia_em_dias,
  (SELECT COALESCE(SUM((entry.value->>'qty')::INTEGER), 0) FROM public.inventory AS inv, jsonb_each(inv.quantities) AS entry) AS unidades_em_estoque
FROM public.products;
