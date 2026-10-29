-- =========================================================================
-- Corrige o estoque de produtos com serial na loja que ainda nao tinha o produto.
-- Bug: sync_serialized_inventory_quantity (legado 20260728) usava jsonb_set com
-- caminho {loja, qty}; quando a loja ainda nao existia no JSON de quantities,
-- jsonb_set nao cria o nivel intermediario e a quantidade da loja nao era gravada.
-- Ex.: transferir o unico PS5 da loja A para a loja B (que nunca teve o produto)
-- zerava A e B continuava sem registro (aparecia 0).
-- Agora a loja e criada antes (inventory_with_unit, da 20261015).
-- Mesma assinatura e retorno; o trigger nao muda.
-- Antes de aplicar, conferir o md5 vivo:
--   select md5(prosrc) from pg_proc where proname='sync_serialized_inventory_quantity';
--   esperado 97335c57fbd54af569bb674eabff4c53 (LF) ou f6997beac85c048ef37f467d0904973e (CRLF)
-- =========================================================================

CREATE OR REPLACE FUNCTION public.sync_serialized_inventory_quantity(
  p_tenant_id UUID,
  p_product_id TEXT,
  p_unit_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  available_quantity INTEGER;
  available_serials JSONB;
BEGIN
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(jsonb_agg(serial_number ORDER BY serial_number), '[]'::jsonb)
  INTO available_quantity, available_serials
  FROM public.product_serial_units
  WHERE tenant_id = p_tenant_id
    AND product_id = p_product_id
    AND unit_id = p_unit_id
    AND status = 'DISPONIVEL';

  INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
  VALUES (
    p_tenant_id,
    p_product_id,
    jsonb_build_object(
      p_unit_id,
      jsonb_build_object('unitId', p_unit_id, 'qty', available_quantity, 'serials', available_serials, 'cardConditions', '{}'::jsonb)
    ),
    NOW()
  )
  ON CONFLICT (tenant_id, product_id) DO UPDATE
  SET
    quantities = jsonb_set(
      jsonb_set(
        jsonb_set(public.inventory_with_unit(public.inventory.quantities, p_unit_id), ARRAY[p_unit_id, 'unitId'], to_jsonb(p_unit_id), true),
        ARRAY[p_unit_id, 'qty'], to_jsonb(available_quantity), true
      ),
      ARRAY[p_unit_id, 'serials'], available_serials, true
    ),
    updated_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.sync_serialized_inventory_quantity(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Reparo: recalcula o estoque de todas as lojas de todos os produtos com serial.
DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT DISTINCT unit.tenant_id, unit.product_id, unit.unit_id
    FROM public.product_serial_units AS unit
    JOIN public.products AS product ON product.tenant_id = unit.tenant_id AND product.id = unit.product_id
    WHERE product.is_serialized = true AND unit.unit_id IS NOT NULL
  LOOP
    PERFORM public.sync_serialized_inventory_quantity(pair.tenant_id, pair.product_id, pair.unit_id);
  END LOOP;
END;
$$;
