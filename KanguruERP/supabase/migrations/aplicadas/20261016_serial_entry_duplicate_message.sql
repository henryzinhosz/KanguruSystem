-- =========================================================================
-- Entrada serializada: mensagem clara quando o serial ja existe.
-- Antes: erro tecnico 'duplicate key value violates unique constraint
-- product_serial_units_tenant_serial_key'. Agora lista os seriais repetidos
-- e o produto a que pertencem. Restante identico a 20261015.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.register_serialized_stock_entry(
  p_product_id TEXT,
  p_unit_id TEXT,
  p_units JSONB,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  warranty INTEGER;
  default_cost NUMERIC;
  unit_count INTEGER;
  serial_count INTEGER;
  duplicate_serials TEXT;
BEGIN
  IF active_tenant_id IS NULL OR NOT public.current_user_has_store_access(active_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja';
  END IF;
  IF jsonb_typeof(p_units) <> 'array' OR jsonb_array_length(p_units) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma unidade serializada';
  END IF;

  SELECT warranty_months, GREATEST(COALESCE(cost_price, 0), 0) INTO warranty, default_cost
  FROM public.products
  WHERE tenant_id = active_tenant_id
    AND id = p_product_id
    AND is_serialized = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto serializado não encontrado';
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT LOWER(BTRIM(unit_item->>'serialNumber')))
  INTO unit_count, serial_count
  FROM jsonb_array_elements(p_units) AS unit_item;
  IF unit_count <> serial_count OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_units) AS unit_item
    WHERE NULLIF(BTRIM(unit_item->>'serialNumber'), '') IS NULL
       OR (unit_item ? 'imei' AND unit_item->>'imei' IS NOT NULL AND NULLIF(BTRIM(unit_item->>'imei'), '') IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cada unidade deve ter um serial único e IMEI válido quando informado';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_units) AS unit_item
    WHERE NULLIF(unit_item->>'unitCost', '') IS NOT NULL
      AND (
        (unit_item->>'unitCost')::NUMERIC < 0
        OR (unit_item->>'unitCost')::NUMERIC <> ROUND((unit_item->>'unitCost')::NUMERIC, 2)
      )
  ) THEN
    RAISE EXCEPTION 'O custo de cada unidade deve ser zero ou maior, com no máximo duas casas decimais';
  END IF;

  -- Serial ja cadastrado (em qualquer produto/loja do tenant): mensagem clara em vez do erro de chave duplicada.
  SELECT string_agg(existing.serial_number || ' (' || COALESCE(product.name, existing.product_id) || ')', ', ' ORDER BY existing.serial_number)
  INTO duplicate_serials
  FROM public.product_serial_units AS existing
  LEFT JOIN public.products AS product
    ON product.tenant_id = existing.tenant_id AND product.id = existing.product_id
  WHERE existing.tenant_id = active_tenant_id
    AND LOWER(existing.serial_number) IN (
      SELECT LOWER(BTRIM(unit_item->>'serialNumber')) FROM jsonb_array_elements(p_units) AS unit_item
    );
  IF duplicate_serials IS NOT NULL THEN
    RAISE EXCEPTION 'Número(s) de série já cadastrado(s) no sistema: %', duplicate_serials;
  END IF;

  INSERT INTO public.product_serial_units (tenant_id, product_id, unit_id, serial_number, imei, status, warranty_months, unit_cost)
  SELECT
    active_tenant_id,
    p_product_id,
    p_unit_id,
    BTRIM(unit_item->>'serialNumber'),
    NULLIF(BTRIM(unit_item->>'imei'), ''),
    'DISPONIVEL',
    COALESCE(warranty, 0),
    COALESCE(NULLIF(unit_item->>'unitCost', '')::NUMERIC, default_cost)
  FROM jsonb_array_elements(p_units) AS unit_item;

  INSERT INTO public.movements (
    id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
    serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
  )
  VALUES (
    gen_random_uuid()::TEXT, active_tenant_id, p_product_id, NULL, 'FORNECEDOR', p_unit_id, 'ENTRADA', unit_count,
    (SELECT jsonb_agg(BTRIM(unit_item->>'serialNumber')) FROM jsonb_array_elements(p_units) AS unit_item),
    NULL, auth.uid()::TEXT, COALESCE((SELECT display_name FROM public.app_users WHERE auth_uid = auth.uid()), ''), NOW(),
    COALESCE(NULLIF(BTRIM(p_reason), ''), 'Entrada de estoque serializado'),
    (SELECT ROUND(AVG(COALESCE(NULLIF(unit_item->>'unitCost', '')::NUMERIC, default_cost)), 4)
     FROM jsonb_array_elements(p_units) AS unit_item)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_serialized_stock_entry(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_serialized_stock_entry(TEXT, TEXT, JSONB, TEXT) TO authenticated;
