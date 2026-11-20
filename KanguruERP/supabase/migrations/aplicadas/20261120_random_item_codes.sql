-- Codigo automatico aleatorio (pedido do usuario em 2026-11-04).
-- Antes: proximo numero a partir de 10100. Agora: numero sorteado de 6 ou 7 digitos,
-- sempre comecando com 7 ou 9 (ex.: 734918, 9201457), sem repetir no tenant
-- (produtos, servicos e seriais/IMEI das unidades).
-- So troca a funcao interna next_item_code_for_tenant (mesma assinatura e retorno).
-- O trigger enforce_item_code (que ja segura o lock por tenant e confere repeticao)
-- e todas as funcoes de venda/estoque NAO mudam. Codigos ja existentes nao mudam.
BEGIN;

CREATE OR REPLACE FUNCTION public.next_item_code_for_tenant(p_tenant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
  v_digits INTEGER;
  v_attempt INTEGER := 0;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 200 THEN
      RAISE EXCEPTION 'Não foi possível gerar um código automático. Digite um código manualmente.';
    END IF;

    v_digits := CASE WHEN random() < 0.5 THEN 6 ELSE 7 END;
    v_code := (CASE WHEN random() < 0.5 THEN '7' ELSE '9' END)
      || LPAD(FLOOR(random() * POWER(10, v_digits - 1))::BIGINT::TEXT, v_digits - 1, '0');

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.products AS product
      WHERE product.tenant_id = p_tenant_id AND UPPER(product.sku) = v_code
    ) AND NOT EXISTS (
      SELECT 1 FROM public.services AS service
      WHERE service.tenant_id = p_tenant_id AND UPPER(service.sku) = v_code
    ) AND NOT EXISTS (
      SELECT 1 FROM public.product_serial_units AS unit
      WHERE unit.tenant_id = p_tenant_id
        AND (UPPER(unit.serial_number) = v_code OR UPPER(unit.imei) = v_code)
    );
  END LOOP;

  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.next_item_code_for_tenant(UUID) FROM PUBLIC, anon, authenticated;

COMMIT;
