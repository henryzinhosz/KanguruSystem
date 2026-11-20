-- =========================================================================
-- Avaliacao de iPhone na Troca Gamer (desenho aprovado em 2026-11-17).
-- Tabela de precos por franqueado (editavel no ERP, so o dono), pre-carregada com
-- os 111 modelos do sistema antigo. Valor no Pix/dinheiro = valor base - desconto do
-- estado (A/B/C, % por modelo) - desconto da bateria (bateria em 84% ou menos; por
-- modelo, padrao R$ 200). Vale-troca = valor + bonus da loja (padrao 10%).
-- Oferecer MAIS que a tabela pede a senha Gerente; o servidor refaz a conta.
-- Conferencia obrigatoria (iCloud, Face ID/Touch ID, IMEI, cameras, tela, documento).
-- Aditiva: register_pos_trade_in ganha p_evaluation JSONB DEFAULT NULL (PDV antigo
-- continua igual: sem avaliacao = videogame, como hoje). Corpo copiado da 20261103.
-- Antes de aplicar, md5(prosrc) de register_pos_trade_in deve ser
-- 508045f78e0b1fe19e3209a8fc812e2b (LF) ou 70e3e04d0f8a4bee5bb9321f488bb42e (CRLF).
-- =========================================================================

-- ---- 1. Colunas novas ----
ALTER TABLE public.trade_ins
  ADD COLUMN IF NOT EXISTS device_type TEXT,
  ADD COLUMN IF NOT EXISTS evaluation JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_ins_device_type_check') THEN
    ALTER TABLE public.trade_ins ADD CONSTRAINT trade_ins_device_type_check
      CHECK (device_type IS NULL OR device_type IN ('VIDEOGAME', 'IPHONE'));
  END IF;
END;
$$;

-- Bonus do vale-troca na Troca Gamer, por loja (% sobre o valor no Pix/dinheiro).
ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS trade_in_credit_bonus NUMERIC(5, 2) NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_configs_trade_in_credit_bonus_check') THEN
    ALTER TABLE public.store_configs ADD CONSTRAINT store_configs_trade_in_credit_bonus_check
      CHECK (trade_in_credit_bonus >= 0 AND trade_in_credit_bonus <= 100);
  END IF;
END;
$$;

-- ---- 2. Tabela padrao (so leitura pelas funcoes) ----
CREATE TABLE IF NOT EXISTS public.trade_in_phone_model_defaults (
  model_name TEXT NOT NULL,
  storage TEXT NOT NULL,
  base_value NUMERIC(12, 2) NOT NULL,
  grade_a_percent NUMERIC(5, 2) NOT NULL,
  grade_b_percent NUMERIC(5, 2) NOT NULL,
  grade_c_percent NUMERIC(5, 2) NOT NULL,
  battery_deduction NUMERIC(12, 2) NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (model_name, storage)
);
ALTER TABLE public.trade_in_phone_model_defaults ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_in_phone_model_defaults FROM PUBLIC, anon, authenticated;

INSERT INTO public.trade_in_phone_model_defaults
  (model_name, storage, base_value, grade_a_percent, grade_b_percent, grade_c_percent, battery_deduction, sort_order)
VALUES
  ('iPhone 17 Pro Max', '256GB', 7699.00, 45, 65, 75, 200.00, 10),
  ('iPhone 17 Pro Max', '512GB', 7999.00, 45, 65, 75, 200.00, 20),
  ('iPhone 17 Pro Max', '1TB', 8499.00, 45, 65, 75, 200.00, 30),
  ('iPhone 17 Pro', '256GB', 6999.00, 45, 65, 75, 200.00, 40),
  ('iPhone 17 Pro', '512GB', 7399.00, 45, 65, 75, 200.00, 50),
  ('iPhone 17 Pro', '1TB', 7699.00, 45, 65, 75, 200.00, 60),
  ('iPhone Air', '256GB', 5999.00, 45, 65, 75, 200.00, 70),
  ('iPhone Air', '1TB', 6499.00, 45, 65, 75, 200.00, 80),
  ('iPhone 17', '256GB', 5199.00, 45, 65, 75, 200.00, 90),
  ('iPhone 17', '512GB', 5499.00, 45, 65, 75, 200.00, 100),
  ('iPhone 16e', '128GB', 2999.00, 50, 60, 70, 200.00, 110),
  ('iPhone 16e', '256GB', 3399.00, 50, 60, 70, 200.00, 120),
  ('iPhone 16e', '512GB', 3599.00, 50, 60, 70, 200.00, 130),
  ('iPhone 16 Pro Max', '256GB', 5899.00, 50, 60, 70, 200.00, 140),
  ('iPhone 16 Pro Max', '512GB', 6299.00, 50, 60, 70, 200.00, 150),
  ('iPhone 16 Pro Max', '1TB', 6499.00, 50, 60, 70, 200.00, 160),
  ('iPhone 16 Pro', '128GB', 4499.00, 50, 60, 70, 200.00, 170),
  ('iPhone 16 Pro', '256GB', 4999.00, 50, 60, 70, 200.00, 180),
  ('iPhone 16 Pro', '512GB', 5299.00, 50, 60, 70, 200.00, 190),
  ('iPhone 16 Pro', '1TB', 5499.00, 50, 60, 70, 200.00, 200),
  ('iPhone 16 Plus', '128GB', 3799.00, 50, 60, 70, 200.00, 210),
  ('iPhone 16 Plus', '256GB', 4399.00, 50, 60, 70, 200.00, 220),
  ('iPhone 16 Plus', '512GB', 4599.00, 50, 60, 70, 200.00, 230),
  ('iPhone 16', '128GB', 3699.00, 50, 60, 70, 200.00, 240),
  ('iPhone 16', '256GB', 4299.00, 50, 60, 70, 200.00, 250),
  ('iPhone 16', '512GB', 4499.00, 50, 60, 70, 200.00, 260),
  ('iPhone 15 Pro Max', '256GB', 4699.00, 50, 60, 75, 200.00, 270),
  ('iPhone 15 Pro Max', '512GB', 4999.00, 50, 60, 75, 200.00, 280),
  ('iPhone 15 Pro Max', '1TB', 5299.00, 50, 60, 75, 200.00, 290),
  ('iPhone 15 Pro', '128GB', 3999.00, 50, 60, 75, 200.00, 300),
  ('iPhone 15 Pro', '256GB', 4299.00, 50, 60, 75, 200.00, 310),
  ('iPhone 15 Pro', '512GB', 4499.00, 50, 60, 75, 200.00, 320),
  ('iPhone 15 Pro', '1TB', 4799.00, 50, 60, 75, 200.00, 330),
  ('iPhone 15 Plus', '128GB', 3299.00, 50, 65, 75, 200.00, 340),
  ('iPhone 15 Plus', '256GB', 3699.00, 50, 65, 75, 200.00, 350),
  ('iPhone 15 Plus', '512GB', 3899.00, 50, 65, 75, 200.00, 360),
  ('iPhone 15', '128GB', 3199.00, 50, 60, 75, 200.00, 370),
  ('iPhone 15', '256GB', 3499.00, 50, 60, 75, 200.00, 380),
  ('iPhone 15', '512GB', 3799.00, 50, 60, 75, 200.00, 390),
  ('iPhone 14 Pro Max', '128GB', 3699.00, 55, 65, 80, 200.00, 400),
  ('iPhone 14 Pro Max', '256GB', 3999.00, 55, 65, 80, 200.00, 410),
  ('iPhone 14 Pro Max', '512GB', 4099.00, 55, 65, 80, 200.00, 420),
  ('iPhone 14 Pro Max', '1TB', 4199.00, 55, 65, 80, 200.00, 430),
  ('iPhone 14 Pro', '128GB', 3399.00, 55, 65, 80, 200.00, 440),
  ('iPhone 14 Pro', '256GB', 3699.00, 55, 65, 80, 200.00, 450),
  ('iPhone 14 Pro', '512GB', 3799.00, 55, 65, 80, 200.00, 460),
  ('iPhone 14 Pro', '1TB', 3999.00, 55, 65, 80, 200.00, 470),
  ('iPhone 14 Plus', '128GB', 2599.00, 55, 65, 80, 200.00, 480),
  ('iPhone 14 Plus', '256GB', 2799.00, 55, 65, 80, 200.00, 490),
  ('iPhone 14 Plus', '512GB', 2999.00, 55, 65, 80, 200.00, 500),
  ('iPhone 14', '128GB', 2499.00, 60, 70, 80, 200.00, 510),
  ('iPhone 14', '256GB', 2699.00, 60, 70, 80, 200.00, 520),
  ('iPhone 14', '512GB', 2899.00, 60, 70, 80, 200.00, 530),
  ('iPhone SE (3ª geração)', '64GB', 999.00, 60, 70, 80, 200.00, 540),
  ('iPhone SE (3ª geração)', '128GB', 1199.00, 60, 70, 80, 200.00, 550),
  ('iPhone SE (3ª geração)', '256GB', 1299.00, 60, 70, 80, 200.00, 560),
  ('iPhone 13 Pro Max', '128GB', 2999.00, 60, 70, 80, 200.00, 570),
  ('iPhone 13 Pro Max', '256GB', 3299.00, 60, 70, 80, 200.00, 580),
  ('iPhone 13 Pro Max', '512GB', 3499.00, 60, 70, 80, 200.00, 590),
  ('iPhone 13 Pro Max', '1TB', 3599.00, 60, 70, 80, 200.00, 600),
  ('iPhone 13 Pro', '128GB', 2699.00, 60, 70, 80, 200.00, 610),
  ('iPhone 13 Pro', '256GB', 2999.00, 60, 70, 80, 200.00, 620),
  ('iPhone 13 Pro', '512GB', 3199.00, 60, 70, 80, 200.00, 630),
  ('iPhone 13 Pro', '1TB', 3299.00, 60, 70, 80, 200.00, 640),
  ('iPhone 13', '128GB', 2299.00, 60, 70, 80, 200.00, 650),
  ('iPhone 13', '256GB', 2499.00, 60, 70, 80, 200.00, 660),
  ('iPhone 13', '512GB', 2699.00, 60, 70, 80, 200.00, 670),
  ('iPhone 13 mini', '128GB', 1499.00, 60, 70, 80, 200.00, 680),
  ('iPhone 13 mini', '256GB', 1699.00, 60, 70, 80, 200.00, 690),
  ('iPhone 13 mini', '512GB', 1799.00, 60, 70, 80, 200.00, 700),
  ('iPhone 12 Pro Max', '128GB', 2699.00, 60, 70, 85, 200.00, 710),
  ('iPhone 12 Pro Max', '256GB', 2899.00, 60, 70, 85, 200.00, 720),
  ('iPhone 12 Pro Max', '512GB', 2999.00, 60, 70, 85, 200.00, 730),
  ('iPhone 12 Pro', '128GB', 2199.00, 60, 70, 85, 200.00, 740),
  ('iPhone 12 Pro', '256GB', 2499.00, 60, 70, 85, 200.00, 750),
  ('iPhone 12 Pro', '512GB', 2599.00, 60, 70, 85, 200.00, 760),
  ('iPhone 12', '64GB', 1399.00, 60, 70, 80, 200.00, 770),
  ('iPhone 12', '128GB', 1799.00, 60, 70, 80, 200.00, 780),
  ('iPhone 12', '256GB', 1999.00, 60, 70, 80, 200.00, 790),
  ('iPhone 12 mini', '64GB', 999.00, 65, 75, 90, 200.00, 800),
  ('iPhone 12 mini', '128GB', 1299.00, 65, 75, 90, 200.00, 810),
  ('iPhone 12 mini', '256GB', 1499.00, 65, 75, 90, 200.00, 820),
  ('iPhone SE (2ª geração)', '64GB', 699.00, 70, 80, 90, 200.00, 830),
  ('iPhone SE (2ª geração)', '128GB', 799.00, 70, 80, 90, 200.00, 840),
  ('iPhone SE (2ª geração)', '256GB', 999.00, 70, 80, 90, 200.00, 850),
  ('iPhone 11 Pro Max', '64GB', 1499.00, 60, 80, 90, 200.00, 860),
  ('iPhone 11 Pro Max', '256GB', 1699.00, 60, 80, 90, 200.00, 870),
  ('iPhone 11 Pro Max', '512GB', 1799.00, 60, 80, 90, 200.00, 880),
  ('iPhone 11 Pro', '64GB', 1399.00, 60, 80, 90, 200.00, 890),
  ('iPhone 11 Pro', '256GB', 1599.00, 60, 80, 90, 200.00, 900),
  ('iPhone 11 Pro', '512GB', 1699.00, 60, 80, 90, 200.00, 910),
  ('iPhone 11', '64GB', 999.00, 70, 80, 95, 200.00, 920),
  ('iPhone 11', '128GB', 1399.00, 70, 80, 95, 200.00, 930),
  ('iPhone 11', '256GB', 1599.00, 70, 80, 95, 200.00, 940),
  ('iPhone XS Max', '64GB', 799.00, 70, 80, 95, 200.00, 950),
  ('iPhone XS Max', '256GB', 899.00, 70, 80, 95, 200.00, 960),
  ('iPhone XS Max', '512GB', 999.00, 70, 80, 95, 200.00, 970),
  ('iPhone XS', '64GB', 699.00, 70, 80, 95, 200.00, 980),
  ('iPhone XS', '256GB', 799.00, 70, 80, 95, 200.00, 990),
  ('iPhone XS', '512GB', 899.00, 70, 80, 95, 200.00, 1000),
  ('iPhone XR', '64GB', 599.00, 70, 80, 95, 200.00, 1010),
  ('iPhone XR', '128GB', 699.00, 70, 80, 95, 200.00, 1020),
  ('iPhone XR', '256GB', 799.00, 70, 80, 95, 200.00, 1030),
  ('iPhone X', '64GB', 499.00, 90, 95, 95, 200.00, 1040),
  ('iPhone X', '256GB', 599.00, 90, 95, 95, 200.00, 1050),
  ('iPhone 8 Plus', '64GB', 449.00, 90, 95, 95, 200.00, 1060),
  ('iPhone 8 Plus', '128GB', 449.00, 90, 95, 95, 200.00, 1070),
  ('iPhone 8 Plus', '256GB', 549.00, 90, 95, 95, 200.00, 1080),
  ('iPhone 8', '64GB', 399.00, 90, 95, 95, 200.00, 1090),
  ('iPhone 8', '128GB', 449.00, 90, 95, 95, 200.00, 1100),
  ('iPhone 8', '256GB', 499.00, 90, 95, 95, 200.00, 1110)
ON CONFLICT (model_name, storage) DO NOTHING;

-- ---- 3. Tabela de cada franqueado ----
CREATE TABLE IF NOT EXISTS public.trade_in_phone_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL CHECK (length(btrim(model_name)) BETWEEN 1 AND 80),
  storage TEXT NOT NULL CHECK (length(btrim(storage)) BETWEEN 1 AND 20),
  base_value NUMERIC(12, 2) NOT NULL CHECK (base_value >= 0),
  grade_a_percent NUMERIC(5, 2) NOT NULL CHECK (grade_a_percent BETWEEN 0 AND 100),
  grade_b_percent NUMERIC(5, 2) NOT NULL CHECK (grade_b_percent BETWEEN 0 AND 100),
  grade_c_percent NUMERIC(5, 2) NOT NULL CHECK (grade_c_percent BETWEEN 0 AND 100),
  battery_deduction NUMERIC(12, 2) NOT NULL DEFAULT 200 CHECK (battery_deduction >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_name TEXT,
  UNIQUE (tenant_id, model_name, storage)
);
CREATE INDEX IF NOT EXISTS trade_in_phone_models_tenant_idx ON public.trade_in_phone_models (tenant_id, sort_order);

-- ERP le pela RLS; escrita so pelas funcoes abaixo (so o dono).
ALTER TABLE public.trade_in_phone_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_in_phone_models FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.trade_in_phone_models FROM authenticated;
GRANT SELECT ON public.trade_in_phone_models TO authenticated;
DROP POLICY IF EXISTS "Tenant reads trade-in phone models" ON public.trade_in_phone_models;
CREATE POLICY "Tenant reads trade-in phone models" ON public.trade_in_phone_models
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_user_tenant_id());

-- Copia a tabela padrao para a empresa (so os modelos que ela ainda nao tem).
CREATE OR REPLACE FUNCTION public.seed_trade_in_phone_models(p_tenant_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.trade_in_phone_models
    (tenant_id, model_name, storage, base_value, grade_a_percent, grade_b_percent, grade_c_percent, battery_deduction, sort_order)
  SELECT p_tenant_id, d.model_name, d.storage, d.base_value, d.grade_a_percent, d.grade_b_percent, d.grade_c_percent,
    d.battery_deduction, d.sort_order
  FROM public.trade_in_phone_model_defaults AS d
  WHERE NOT EXISTS (
    SELECT 1 FROM public.trade_in_phone_models AS m
    WHERE m.tenant_id = p_tenant_id AND LOWER(m.model_name) = LOWER(d.model_name) AND LOWER(m.storage) = LOWER(d.storage)
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_trade_in_phone_models(UUID) FROM PUBLIC, anon, authenticated;

-- Empresas que ja tem loja recebem a tabela agora.
SELECT public.seed_trade_in_phone_models(t.id)
FROM public.tenants AS t
WHERE EXISTS (SELECT 1 FROM public.store_configs AS s WHERE s.tenant_id = t.id);

-- ---- 4. ERP: editar a tabela (so o dono) ----
CREATE OR REPLACE FUNCTION public.save_trade_in_phone_model(
  p_id UUID,
  p_model_name TEXT,
  p_storage TEXT,
  p_base_value NUMERIC,
  p_grade_a_percent NUMERIC,
  p_grade_b_percent NUMERIC,
  p_grade_c_percent NUMERIC,
  p_battery_deduction NUMERIC,
  p_is_active BOOLEAN
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_model TEXT := regexp_replace(BTRIM(COALESCE(p_model_name, '')), '\s+', ' ', 'g');
  v_storage TEXT := UPPER(regexp_replace(BTRIM(COALESCE(p_storage, '')), '\s+', '', 'g'));
  v_name TEXT;
  v_id UUID;
  v_sort INTEGER;
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o administrador da empresa pode alterar a tabela de iPhone';
  END IF;
  IF v_model = '' OR length(v_model) > 80 THEN
    RAISE EXCEPTION 'Informe o modelo';
  END IF;
  IF v_storage = '' OR length(v_storage) > 20 THEN
    RAISE EXCEPTION 'Informe a memória (ex.: 128GB)';
  END IF;
  IF p_base_value IS NULL OR p_base_value < 0 THEN
    RAISE EXCEPTION 'Informe o valor base';
  END IF;
  IF p_grade_a_percent IS NULL OR p_grade_a_percent NOT BETWEEN 0 AND 100
     OR p_grade_b_percent IS NULL OR p_grade_b_percent NOT BETWEEN 0 AND 100
     OR p_grade_c_percent IS NULL OR p_grade_c_percent NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Os descontos dos estados A, B e C vão de 0 a 100%%';
  END IF;
  IF p_battery_deduction IS NULL OR p_battery_deduction < 0 THEN
    RAISE EXCEPTION 'Informe o desconto da bateria';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.trade_in_phone_models
    WHERE tenant_id = v_tenant_id AND LOWER(model_name) = LOWER(v_model) AND LOWER(storage) = LOWER(v_storage)
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'Este modelo com esta memória já está na tabela';
  END IF;

  SELECT display_name INTO v_name FROM public.app_users WHERE auth_uid = auth.uid() AND tenant_id = v_tenant_id;

  IF p_id IS NULL THEN
    -- Modelo novo entra no topo (lancamentos ficam em cima).
    SELECT COALESCE(MIN(sort_order), 10) - 10 INTO v_sort FROM public.trade_in_phone_models WHERE tenant_id = v_tenant_id;
    INSERT INTO public.trade_in_phone_models
      (tenant_id, model_name, storage, base_value, grade_a_percent, grade_b_percent, grade_c_percent, battery_deduction,
       is_active, sort_order, updated_by_name)
    VALUES (v_tenant_id, v_model, v_storage, ROUND(p_base_value, 2), p_grade_a_percent, p_grade_b_percent, p_grade_c_percent,
      ROUND(p_battery_deduction, 2), COALESCE(p_is_active, TRUE), v_sort, v_name)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.trade_in_phone_models
    SET model_name = v_model, storage = v_storage, base_value = ROUND(p_base_value, 2),
      grade_a_percent = p_grade_a_percent, grade_b_percent = p_grade_b_percent, grade_c_percent = p_grade_c_percent,
      battery_deduction = ROUND(p_battery_deduction, 2), is_active = COALESCE(p_is_active, TRUE),
      updated_at = NOW(), updated_by_name = v_name
    WHERE id = p_id AND tenant_id = v_tenant_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Modelo não encontrado';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_trade_in_phone_model(UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_trade_in_phone_model(UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN) TO authenticated;

-- Excluir: as trocas ja feitas guardam a avaliacao completa, nada se perde.
CREATE OR REPLACE FUNCTION public.delete_trade_in_phone_model(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o administrador da empresa pode alterar a tabela de iPhone';
  END IF;
  DELETE FROM public.trade_in_phone_models WHERE id = p_id AND tenant_id = v_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_trade_in_phone_model(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_trade_in_phone_model(UUID) TO authenticated;

-- Recarregar a tabela padrao: so acrescenta os modelos que faltam (nao mexe nos editados).
CREATE OR REPLACE FUNCTION public.load_default_trade_in_phone_models()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o administrador da empresa pode alterar a tabela de iPhone';
  END IF;
  RETURN public.seed_trade_in_phone_models(v_tenant_id);
END;
$$;

REVOKE ALL ON FUNCTION public.load_default_trade_in_phone_models() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.load_default_trade_in_phone_models() TO authenticated;

-- ---- 5. PDV: tabela ativa + bonus da loja ----
CREATE OR REPLACE FUNCTION public.get_pos_trade_in_phone_table()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_bonus NUMERIC;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT trade_in_credit_bonus INTO v_bonus FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;

  RETURN jsonb_build_object(
    'bonusPercent', COALESCE(v_bonus, 10),
    'models', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id,
        'modelName', m.model_name,
        'storage', m.storage,
        'baseValue', m.base_value,
        'gradeA', m.grade_a_percent,
        'gradeB', m.grade_b_percent,
        'gradeC', m.grade_c_percent,
        'batteryDeduction', m.battery_deduction
      ) ORDER BY m.sort_order, m.model_name, m.storage)
      FROM public.trade_in_phone_models AS m
      WHERE m.tenant_id = v_terminal.tenant_id AND m.is_active
    ), '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_trade_in_phone_table() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_trade_in_phone_table() TO authenticated;

-- ---- 6. Registro pelo PDV: copia da 20261103 + avaliacao de iPhone ----
-- p_evaluation (so iPhone): {"modelId": uuid, "grade": "A"|"B"|"C", "battery": 0-100,
--   "checklist": {"icloud": true, "biometria": true, "imei": true, "cameras": true, "tela": true, "documento": true}}
DROP FUNCTION IF EXISTS public.register_pos_trade_in(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.register_pos_trade_in(
  p_customer_cpf TEXT,
  p_document TEXT,
  p_description TEXT,
  p_serial TEXT,
  p_imei TEXT,
  p_accessories TEXT,
  p_condition TEXT,
  p_amount NUMERIC,
  p_payment_method TEXT,
  p_seller_code TEXT,
  p_admin_password TEXT DEFAULT NULL,
  p_evaluation JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_seller public.pdv_operators%ROWTYPE;
  v_cpf TEXT := regexp_replace(COALESCE(p_customer_cpf, ''), '\D', '', 'g');
  v_method TEXT := UPPER(COALESCE(p_payment_method, ''));
  v_serial TEXT := UPPER(BTRIM(COALESCE(p_serial, '')));
  v_imei TEXT := NULLIF(regexp_replace(COALESCE(p_imei, ''), '\D', '', 'g'), '');
  v_amount NUMERIC(12, 2);
  v_password_check JSONB;
  v_number INTEGER;
  v_id TEXT := 't_' || replace(gen_random_uuid()::TEXT, '-', '');
  v_address TEXT;
  v_credit_id UUID;
  v_terms TEXT;
  -- Avaliacao de iPhone
  v_is_phone BOOLEAN := p_evaluation IS NOT NULL;
  v_device TEXT;
  v_category TEXT;
  v_description TEXT := BTRIM(COALESCE(p_description, ''));
  v_condition TEXT := p_condition;
  v_model public.trade_in_phone_models%ROWTYPE;
  v_grade TEXT;
  v_battery INTEGER;
  v_grade_percent NUMERIC;
  v_battery_deduction NUMERIC(12, 2);
  v_cash_value NUMERIC(12, 2);
  v_bonus NUMERIC;
  v_credit_value NUMERIC(12, 2);
  v_table_value NUMERIC(12, 2);
  v_above_table BOOLEAN := FALSE;
  v_evaluation JSONB;
  v_key TEXT;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT * INTO v_cash FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
  ORDER BY opened_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Abra o caixa para registrar a Troca Gamer';
  END IF;

  IF v_method NOT IN ('VALE', 'DINHEIRO', 'PIX') THEN
    RAISE EXCEPTION 'Forma de pagamento inválida';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Informe o valor da troca';
  END IF;
  v_amount := p_amount;

  IF v_is_phone THEN
    -- iPhone: modelo da tabela da empresa, estado A/B/C, bateria e conferencia completa.
    SELECT * INTO v_model FROM public.trade_in_phone_models
    WHERE id = NULLIF(p_evaluation->>'modelId', '')::UUID AND tenant_id = v_terminal.tenant_id AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Modelo de iPhone não encontrado na tabela';
    END IF;
    v_grade := UPPER(COALESCE(p_evaluation->>'grade', ''));
    IF v_grade NOT IN ('A', 'B', 'C') THEN
      RAISE EXCEPTION 'Escolha o estado do iPhone (A, B ou C)';
    END IF;
    IF COALESCE(p_evaluation->>'battery', '') !~ '^[0-9]{1,3}$' OR (p_evaluation->>'battery')::INTEGER > 100 THEN
      RAISE EXCEPTION 'Informe a saúde da bateria (0 a 100%%)';
    END IF;
    v_battery := (p_evaluation->>'battery')::INTEGER;
    FOREACH v_key IN ARRAY ARRAY['icloud', 'biometria', 'imei', 'cameras', 'tela', 'documento'] LOOP
      IF COALESCE((p_evaluation->'checklist'->>v_key)::BOOLEAN, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION 'Confira todos os itens da lista antes de concluir';
      END IF;
    END LOOP;
    IF v_imei IS NULL THEN
      RAISE EXCEPTION 'Informe o IMEI do iPhone';
    END IF;

    v_grade_percent := CASE v_grade WHEN 'A' THEN v_model.grade_a_percent WHEN 'B' THEN v_model.grade_b_percent ELSE v_model.grade_c_percent END;
    v_battery_deduction := CASE WHEN v_battery <= 84 THEN v_model.battery_deduction ELSE 0 END;
    v_cash_value := GREATEST(0, ROUND(v_model.base_value * (1 - v_grade_percent / 100) - v_battery_deduction, 2));
    SELECT COALESCE(trade_in_credit_bonus, 10) INTO v_bonus FROM public.store_configs
    WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
    v_bonus := COALESCE(v_bonus, 10);
    v_credit_value := ROUND(v_cash_value * (1 + v_bonus / 100), 2);
    v_table_value := CASE WHEN v_method = 'VALE' THEN v_credit_value ELSE v_cash_value END;
    v_above_table := v_amount > v_table_value;

    v_device := 'IPHONE';
    v_category := 'Celulares';
    v_description := v_model.model_name || ' ' || v_model.storage;
    v_condition := CASE v_grade WHEN 'A' THEN 'Excelente' WHEN 'B' THEN 'Bom' ELSE 'Com defeito' END;
    v_evaluation := jsonb_build_object(
      'modelId', v_model.id,
      'modelName', v_model.model_name,
      'storage', v_model.storage,
      'baseValue', v_model.base_value,
      'grade', v_grade,
      'gradePercent', v_grade_percent,
      'battery', v_battery,
      'batteryDeduction', v_battery_deduction,
      'cashValue', v_cash_value,
      'bonusPercent', v_bonus,
      'creditValue', v_credit_value,
      'tableValue', v_table_value,
      'aboveTable', v_above_table,
      'checklist', jsonb_build_object('icloud', TRUE, 'biometria', TRUE, 'imei', TRUE, 'cameras', TRUE, 'tela', TRUE, 'documento', TRUE)
    );
  ELSE
    v_device := 'VIDEOGAME';
    v_category := 'Videogames';
    IF v_description = '' THEN
      RAISE EXCEPTION 'Informe o modelo do videogame';
    END IF;
    IF COALESCE(p_condition, '') NOT IN ('Excelente', 'Bom', 'Com defeito') THEN
      RAISE EXCEPTION 'Estado do videogame inválido';
    END IF;
  END IF;

  IF v_serial = '' THEN
    RAISE EXCEPTION 'Informe o número de série do aparelho';
  END IF;
  IF v_imei IS NOT NULL AND v_imei !~ '^[0-9]{15}$' THEN
    RAISE EXCEPTION 'IMEI inválido: são 15 números';
  END IF;

  SELECT * INTO v_customer FROM public.customers WHERE tenant_id = v_terminal.tenant_id AND cpf = v_cpf;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'CUSTOMER_REQUIRED');
  END IF;

  v_seller := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, p_seller_code);
  IF v_seller.id IS NULL THEN
    RETURN jsonb_build_object('status', 'INVALID_SELLER');
  END IF;

  -- Serial ja no estoque ou em outra troca em aberto: provavel erro de digitacao ou aparelho repetido.
  IF EXISTS (
    SELECT 1 FROM public.product_serial_units
    WHERE tenant_id = v_terminal.tenant_id AND LOWER(serial_number) = LOWER(v_serial) AND status IN ('DISPONIVEL', 'RESERVADO')
  ) OR EXISTS (
    SELECT 1 FROM public.trade_ins
    WHERE tenant_id = v_terminal.tenant_id AND LOWER(serial_number) = LOWER(v_serial) AND status = 'AVALIADO'
  ) THEN
    RETURN jsonb_build_object('status', 'SERIAL_EXISTS');
  END IF;

  -- Senha Gerente: dinheiro/Pix (como antes) ou valor acima da tabela do iPhone.
  IF v_method IN ('DINHEIRO', 'PIX') OR v_above_table THEN
    IF p_admin_password IS NULL OR p_admin_password = '' THEN
      RETURN jsonb_build_object('status', 'PASSWORD_REQUIRED', 'aboveTable', v_above_table, 'tableValue', v_table_value);
    END IF;
    v_password_check := public.check_pos_admin_password(v_terminal.id, p_admin_password, 'TRADE_IN_PAYOUT');
    IF v_password_check->>'status' = 'LOCKED' THEN
      RETURN jsonb_build_object('status', 'LOCKED', 'lockedUntil', v_password_check->'lockedUntil');
    ELSIF v_password_check->>'status' <> 'OK' THEN
      RETURN jsonb_build_object('status', 'INVALID_PASSWORD', 'remainingAttempts', v_password_check->'remainingAttempts');
    END IF;
    -- Vale e Pix nao tem sangria para usar a autorizacao: ja marca como usada.
    IF v_method IN ('VALE', 'PIX') THEN
      PERFORM public.consume_pos_manager_authorization(v_terminal.id, ARRAY['TRADE_IN_PAYOUT']);
    END IF;
  END IF;

  v_address := NULLIF(concat_ws(', ',
    NULLIF(BTRIM(v_customer.address), ''),
    NULLIF(BTRIM(v_customer.address_number), ''),
    NULLIF(BTRIM(v_customer.complement), ''),
    NULLIF(BTRIM(v_customer.district), ''),
    NULLIF(concat_ws('/', NULLIF(BTRIM(v_customer.city), ''), NULLIF(BTRIM(v_customer.state), '')), ''),
    CASE WHEN NULLIF(BTRIM(v_customer.cep), '') IS NULL THEN NULL ELSE 'CEP ' || BTRIM(v_customer.cep) END
  ), '');

  PERFORM pg_advisory_xact_lock(hashtext('trade_in:' || v_terminal.tenant_id::TEXT || ':' || v_terminal.unit_id));
  SELECT COALESCE(MAX(trade_number), 0) + 1 INTO v_number
  FROM public.trade_ins WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;

  INSERT INTO public.trade_ins (
    id, tenant_id, seller_name, seller_cpf, item_description, category, condition, valuation_amount,
    operator_id, operator_name, unit_id, "timestamp", status, trade_number, seller_phone, seller_address,
    seller_document, customer_id, serial_number, imei, accessories, payment_method, terminal_id,
    cash_session_id, staff_code, staff_name, device_type, evaluation
  ) VALUES (
    v_id, v_terminal.tenant_id, v_customer.name, v_customer.cpf, v_description, v_category, v_condition, v_amount,
    v_terminal.id::TEXT, v_seller.name, v_terminal.unit_id, NOW(), 'AVALIADO', v_number, v_customer.phone, v_address,
    NULLIF(BTRIM(COALESCE(p_document, '')), ''), v_customer.id, v_serial, v_imei, NULLIF(BTRIM(COALESCE(p_accessories, '')), ''),
    v_method, v_terminal.id, v_cash.id, v_seller.code, v_seller.name, v_device, v_evaluation
  );

  IF v_method = 'VALE' THEN
    INSERT INTO public.customer_credits (tenant_id, unit_id, customer_cpf, amount, balance, origin_trade_in_id)
    VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_customer.cpf, v_amount, v_amount, v_id)
    RETURNING id INTO v_credit_id;
    INSERT INTO public.customer_credit_movements (tenant_id, credit_id, kind, amount)
    VALUES (v_terminal.tenant_id, v_credit_id, 'EMISSAO', v_amount);
    UPDATE public.trade_ins SET customer_credit_id = v_credit_id WHERE id = v_id;
  ELSIF v_method = 'DINHEIRO' THEN
    -- Sai da gaveta: entra no fechamento como sangria.
    INSERT INTO public.cash_register_movements (cash_session_id, tenant_id, unit_id, terminal_id, type, amount, reason, operator_name)
    VALUES (v_cash.id, v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, 'SANGRIA', v_amount,
      'Troca Gamer nº ' || v_number || ' - ' || v_customer.name, v_seller.name);
  END IF;

  SELECT trade_in_terms INTO v_terms FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;

  RETURN jsonb_build_object(
    'status', 'OK',
    'tradeInId', v_id,
    'tradeNumber', v_number,
    'createdAt', NOW(),
    'customerName', v_customer.name,
    'customerCpf', v_customer.cpf,
    'customerPhone', v_customer.phone,
    'customerAddress', v_address,
    'document', NULLIF(BTRIM(COALESCE(p_document, '')), ''),
    'description', v_description,
    'serialNumber', v_serial,
    'imei', v_imei,
    'accessories', NULLIF(BTRIM(COALESCE(p_accessories, '')), ''),
    'condition', v_condition,
    'amount', v_amount,
    'paymentMethod', v_method,
    'staffCode', v_seller.code,
    'staffName', v_seller.name,
    'terms', v_terms,
    'deviceType', v_device,
    'evaluation', v_evaluation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_pos_trade_in(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_pos_trade_in(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB) TO authenticated;
