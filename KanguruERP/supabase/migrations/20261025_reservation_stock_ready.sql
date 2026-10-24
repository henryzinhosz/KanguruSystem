-- Lista de reservas: cada item informa se a encomenda ja chegou no estoque (stockReady),
-- para o PDV travar "Converter em venda" e avisar no card. Mesmo retorno (o campo novo
-- fica dentro do JSON de itens). Copia da 20261023 + o trecho de stockReady.
BEGIN;

CREATE OR REPLACE FUNCTION public.list_pos_reservations()
RETURNS TABLE (
  reservation_id UUID,
  customer_name TEXT,
  customer_phone TEXT,
  expires_at TIMESTAMPTZ,
  deposit_amount NUMERIC,
  deposit_payment_method TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  is_expired BOOLEAN,
  items JSONB,
  seller_code TEXT,
  seller_name TEXT,
  customer_cpf TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  RETURN QUERY
  SELECT reservation.id, reservation.customer_name, reservation.customer_phone,
    reservation.expires_at, reservation.deposit_amount, reservation.deposit_payment_method,
    reservation.status, reservation.created_at, reservation.expires_at <= NOW(),
    COALESCE(jsonb_agg(jsonb_build_object(
      'reservationItemId', reservation_item.id,
      'productId', reservation_item.product_id,
      'quantity', reservation_item.quantity,
      'serialUnitId', reservation_item.serial_unit_id,
      'serialNumber', reservation_item.serial_number,
      'itemSku', reservation_item.item_sku,
      'itemName', reservation_item.item_name,
      'unitPrice', reservation_item.unit_price,
      'discountPercent', reservation_item.discount_percent,
      'lineTotal', reservation_item.line_total,
      'isBackorder', reservation_item.is_backorder,
      -- Encomenda: a mercadoria ja chegou no estoque fisico da loja? (com serial: ha
      -- unidade DISPONIVEL; sem serial: quantidade fisica cobre a linha).
      'stockReady', CASE
        WHEN NOT reservation_item.is_backorder OR reservation_item.serial_unit_id IS NOT NULL THEN true
        ELSE COALESCE((
          SELECT (inventory.quantities -> reservation.unit_id ->> 'qty')::INTEGER
          FROM public.inventory AS inventory
          WHERE inventory.tenant_id = reservation_item.tenant_id
            AND inventory.product_id = reservation_item.product_id
        ), 0) >= reservation_item.quantity
      END,
      'isSerialized', COALESCE((
        SELECT product.is_serialized FROM public.products AS product
        WHERE product.tenant_id = reservation_item.tenant_id AND product.id = reservation_item.product_id
      ), false)
    ) ORDER BY reservation_item.created_at) FILTER (WHERE reservation_item.id IS NOT NULL), '[]'::JSONB),
    reservation.seller_code, reservation.seller_name, reservation.customer_cpf
  FROM public.product_reservations AS reservation
  LEFT JOIN public.product_reservation_items AS reservation_item
    ON reservation_item.tenant_id = reservation.tenant_id
    AND reservation_item.reservation_id = reservation.id
  WHERE reservation.tenant_id = v_terminal.tenant_id
    AND reservation.unit_id = v_terminal.unit_id
    AND reservation.status = 'ATIVA'
  GROUP BY reservation.id
  ORDER BY reservation.expires_at, reservation.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.list_pos_reservations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pos_reservations() TO authenticated;

COMMIT;
