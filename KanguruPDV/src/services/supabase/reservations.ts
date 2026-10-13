import { supabase } from './client';

export interface ReservationLineInput {
  productId: string;
  quantity: number;
  discountPercent: number;
  serialUnitId?: string;
}

export interface PosReservationItem {
  reservationItemId: string;
  productId: string;
  quantity: number;
  serialUnitId: string | null;
  serialNumber: string | null;
  itemSku: string;
  itemName: string;
  unitPrice: number;
  discountPercent: number;
  lineTotal: number;
}

export interface PosReservation {
  id: string;
  customerName: string;
  customerPhone: string | null;
  expiresAt: string;
  depositAmount: number;
  depositPaymentMethod: string | null;
  createdAt: string;
  expired: boolean;
  items: PosReservationItem[];
}

interface PosReservationRow {
  reservation_id: string;
  customer_name: string;
  customer_phone: string | null;
  expires_at: string;
  deposit_amount: number | string;
  deposit_payment_method: string | null;
  created_at: string;
  is_expired: boolean;
  items: PosReservationItem[];
}

export async function createPosReservation(input: {
  customerName: string;
  customerPhone: string;
  expiresAt: string;
  depositAmount: number;
  depositPaymentMethod: string | null;
  items: ReservationLineInput[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('reserve_pos_cart', {
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone || null,
    p_expires_at: input.expiresAt,
    p_deposit_amount: input.depositAmount,
    p_deposit_payment_method: input.depositPaymentMethod,
    p_items: input.items.map((item) => ({
      itemType: 'PRODUCT',
      productId: item.productId,
      quantity: item.quantity,
      discountPercent: item.discountPercent,
      ...(item.serialUnitId ? { serialUnitId: item.serialUnitId } : {}),
    })),
  });
  if (error) throw error;
  return String(data);
}

export async function getPosReservations(): Promise<PosReservation[]> {
  const { data, error } = await supabase.rpc('list_pos_reservations');
  if (error) throw error;
  return ((data ?? []) as PosReservationRow[]).map((row) => ({
    id: row.reservation_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    expiresAt: row.expires_at,
    depositAmount: Number(row.deposit_amount),
    depositPaymentMethod: row.deposit_payment_method,
    createdAt: row.created_at,
    expired: row.is_expired,
    items: row.items ?? [],
  }));
}

export async function cancelPosReservation(reservationId: string, refundPaymentMethod: string | null): Promise<void> {
  const { error } = await supabase.rpc('cancel_pos_reservation', {
    p_reservation_id: reservationId,
    p_refund_payment_method: refundPaymentMethod,
  });
  if (error) throw error;
}
