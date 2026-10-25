-- 2.7b Parte 2: codigo de produto/servico e leitura de serial no PDV.
-- 1. Codigo: so letras, numeros e hifen, em maiusculas, ate 30 caracteres.
-- 2. Uma numeracao so para produtos e servicos do mesmo tenant (codigo bipado nunca e ambiguo).
-- 3. Codigo vazio no cadastro => o banco gera o proximo numero livre a partir de 10100.
-- 4. find_pos_serial_unit: o PDV bipa o serial (ou IMEI) e encontra a unidade da loja.
-- Aditiva: nenhuma funcao de venda, reserva, caixa ou estorno muda. Codigos antigos
-- continuam valendo; a regra so vale quando o codigo e criado ou alterado.
BEGIN;

CREATE INDEX IF NOT EXISTS products_tenant_upper_sku_idx
  ON public.products (tenant_id, UPPER(sku));
CREATE INDEX IF NOT EXISTS services_tenant_upper_sku_idx
  ON public.services (tenant_id, UPPER(sku));

-- Interna (sem GRANT): proximo numero livre do tenant, entre produtos e servicos.
CREATE OR REPLACE FUNCTION public.next_item_code_for_tenant(p_tenant_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (GREATEST(10099, COALESCE(MAX(codes.code::BIGINT), 0)) + 1)::TEXT
  FROM (
    SELECT product.sku AS code FROM public.products AS product
    WHERE product.tenant_id = p_tenant_id AND product.sku ~ '^[0-9]{1,15}$'
    UNION ALL
    SELECT service.sku FROM public.services AS service
    WHERE service.tenant_id = p_tenant_id AND service.sku ~ '^[0-9]{1,15}$'
  ) AS codes;
$$;

REVOKE ALL ON FUNCTION public.next_item_code_for_tenant(UUID) FROM PUBLIC, anon, authenticated;

-- Trigger de produtos e servicos: normaliza, valida, gera e impede codigo repetido.
CREATE OR REPLACE FUNCTION public.enforce_item_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
  v_taken BOOLEAN;
BEGIN
  -- Editar outros campos nao revalida um codigo antigo.
  IF TG_OP = 'UPDATE' AND NEW.sku IS NOT DISTINCT FROM OLD.sku THEN
    RETURN NEW;
  END IF;
  -- O ERP grava com upsert (INSERT ... ON CONFLICT): a tentativa de INSERT de uma
  -- linha que ja existe com o mesmo codigo tambem nao revalida.
  IF TG_OP = 'INSERT' AND (
    (TG_TABLE_NAME = 'products' AND EXISTS (
      SELECT 1 FROM public.products AS product
      WHERE product.id = NEW.id AND product.tenant_id = NEW.tenant_id AND product.sku = NEW.sku))
    OR (TG_TABLE_NAME = 'services' AND EXISTS (
      SELECT 1 FROM public.services AS service
      WHERE service.id = NEW.id AND service.tenant_id = NEW.tenant_id AND service.sku = NEW.sku))
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'Selecione um tenant para esta operação';
  END IF;

  -- Uma gravacao de codigo por vez no tenant: dois cadastros simultaneos nunca
  -- pegam o mesmo numero automatico nem o mesmo codigo digitado.
  PERFORM pg_advisory_xact_lock(hashtext('item_code:' || NEW.tenant_id::TEXT));

  v_code := UPPER(BTRIM(COALESCE(NEW.sku, '')));
  IF v_code = '' THEN
    v_code := public.next_item_code_for_tenant(NEW.tenant_id);
  ELSIF v_code !~ '^[A-Z0-9-]{1,30}$' THEN
    RAISE EXCEPTION 'Código inválido: use só letras, números e hífen (até 30 caracteres).'
      USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.products AS product
    WHERE product.tenant_id = NEW.tenant_id AND UPPER(product.sku) = v_code
      AND NOT (TG_TABLE_NAME = 'products' AND product.id = NEW.id)
    UNION ALL
    SELECT 1 FROM public.services AS service
    WHERE service.tenant_id = NEW.tenant_id AND UPPER(service.sku) = v_code
      AND NOT (TG_TABLE_NAME = 'services' AND service.id = NEW.id)
  ) INTO v_taken;
  IF v_taken THEN
    RAISE EXCEPTION 'Já existe um produto ou serviço com o código %.', v_code
      USING ERRCODE = '23505';
  END IF;

  NEW.sku := v_code;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_item_code() FROM PUBLIC, anon, authenticated;

-- Prefixo "zz_": triggers BEFORE rodam em ordem alfabetica; este precisa rodar
-- depois do enforce_current_tenant_trigger, que preenche o tenant_id.
DROP TRIGGER IF EXISTS zz_item_code_trigger ON public.products;
CREATE TRIGGER zz_item_code_trigger
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.enforce_item_code();

DROP TRIGGER IF EXISTS zz_item_code_trigger ON public.services;
CREATE TRIGGER zz_item_code_trigger
  BEFORE INSERT OR UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_item_code();

-- ERP: mostra no cadastro qual sera o proximo codigo automatico (so informativo;
-- o numero definitivo e gerado pelo trigger na hora de salvar).
CREATE OR REPLACE FUNCTION public.get_next_item_code()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
BEGIN
  IF active_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Selecione um tenant para esta operação';
  END IF;
  RETURN public.next_item_code_for_tenant(active_tenant_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_next_item_code() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_next_item_code() TO authenticated;

-- PDV: unidade pelo serial ou IMEI bipado. Mesmas colunas de search_pos_items
-- mais os dados da unidade. unit_status: DISPONIVEL | VENDIDO | RESERVADO | PERDIDO
-- | OUTRA_LOJA. serial_unit_id so vem quando a unidade esta disponivel nesta loja.
CREATE OR REPLACE FUNCTION public.find_pos_serial_unit(p_code TEXT)
RETURNS TABLE (
  item_id TEXT,
  item_type TEXT,
  sku TEXT,
  name TEXT,
  brand TEXT,
  sell_price NUMERIC,
  available_quantity INTEGER,
  warranty_months INTEGER,
  requires_unit_selection BOOLEAN,
  max_item_discount_percent NUMERIC,
  serial_unit_id UUID,
  serial_number TEXT,
  imei TEXT,
  unit_status TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_code TEXT := LOWER(BTRIM(p_code));
  v_max_discount NUMERIC(5, 2);
BEGIN
  IF COALESCE(v_code, '') = '' THEN
    RETURN;
  END IF;

  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  SELECT COALESCE(config.max_item_discount_percent, 0)
  INTO v_max_discount
  FROM public.store_configs AS config
  WHERE config.tenant_id = v_terminal.tenant_id
    AND config.unit_id = v_terminal.unit_id;
  v_max_discount := COALESCE(v_max_discount, 0);

  RETURN QUERY
  SELECT product.id, 'PRODUCT'::TEXT, product.sku, product.name, product.brand, product.sell_price,
    COALESCE((inventory.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0),
    product.warranty_months,
    true,
    v_max_discount,
    CASE WHEN unit.unit_id = v_terminal.unit_id AND unit.status = 'DISPONIVEL' THEN unit.id END,
    unit.serial_number,
    unit.imei,
    CASE WHEN unit.unit_id <> v_terminal.unit_id THEN 'OUTRA_LOJA' ELSE unit.status END
  FROM public.product_serial_units AS unit
  JOIN public.products AS product
    ON product.tenant_id = unit.tenant_id AND product.id = unit.product_id
  LEFT JOIN public.inventory AS inventory
    ON inventory.tenant_id = unit.tenant_id AND inventory.product_id = unit.product_id
  WHERE unit.tenant_id = v_terminal.tenant_id
    AND (LOWER(unit.serial_number) = v_code OR LOWER(unit.imei) = v_code)
  -- Serial tem prioridade sobre IMEI se, por acaso, os dois coincidirem.
  ORDER BY CASE WHEN LOWER(unit.serial_number) = v_code THEN 0 ELSE 1 END
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.find_pos_serial_unit(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_pos_serial_unit(TEXT) TO authenticated;

COMMIT;
