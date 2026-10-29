import { supabase } from './client';

// Troca Gamer (compra de videogame usado): registro pelo PDV com a sessao do terminal.

export type TradeInPayment = 'VALE' | 'DINHEIRO' | 'PIX';
export type TradeInCondition = 'Excelente' | 'Bom' | 'Com defeito';

export interface TradeInInput {
  customerCpf: string;
  document: string;
  description: string;
  serialNumber: string;
  imei: string;
  accessories: string;
  condition: TradeInCondition;
  amount: number;
  paymentMethod: TradeInPayment;
  sellerCode: string;
  adminPassword: string | null;
}

export interface TradeInRecord {
  tradeInId: string;
  tradeNumber: number;
  createdAt: string;
  customerName: string;
  customerCpf: string;
  customerPhone: string | null;
  customerAddress: string | null;
  document: string | null;
  description: string;
  serialNumber: string;
  imei: string | null;
  accessories: string | null;
  condition: string;
  amount: number;
  paymentMethod: TradeInPayment;
  staffCode: string;
  staffName: string;
  terms: string | null;
}

export type TradeInResult =
  | ({ status: 'OK' } & TradeInRecord)
  | { status: 'PASSWORD_REQUIRED' | 'LOCKED' | 'CUSTOMER_REQUIRED' | 'INVALID_SELLER' | 'SERIAL_EXISTS' }
  | { status: 'INVALID_PASSWORD'; remainingAttempts: number };

export async function registerTradeIn(input: TradeInInput): Promise<TradeInResult> {
  const { data, error } = await supabase.rpc('register_pos_trade_in', {
    p_customer_cpf: input.customerCpf,
    p_document: input.document || null,
    p_description: input.description,
    p_serial: input.serialNumber,
    p_imei: input.imei || null,
    p_accessories: input.accessories || null,
    p_condition: input.condition,
    p_amount: input.amount,
    p_payment_method: input.paymentMethod,
    p_seller_code: input.sellerCode,
    p_admin_password: input.adminPassword,
  });
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  const status = String(row.status ?? '');
  if (status === 'INVALID_PASSWORD') return { status, remainingAttempts: Number(row.remainingAttempts ?? 0) };
  if (status !== 'OK') return { status: status as 'PASSWORD_REQUIRED' };
  const text = (value: unknown) => (value == null || value === '' ? null : String(value));
  return {
    status: 'OK',
    tradeInId: String(row.tradeInId),
    tradeNumber: Number(row.tradeNumber),
    createdAt: String(row.createdAt),
    customerName: String(row.customerName ?? ''),
    customerCpf: String(row.customerCpf ?? ''),
    customerPhone: text(row.customerPhone),
    customerAddress: text(row.customerAddress),
    document: text(row.document),
    description: String(row.description ?? ''),
    serialNumber: String(row.serialNumber ?? ''),
    imei: text(row.imei),
    accessories: text(row.accessories),
    condition: String(row.condition ?? ''),
    amount: Number(row.amount ?? 0),
    paymentMethod: String(row.paymentMethod) as TradeInPayment,
    staffCode: String(row.staffCode ?? ''),
    staffName: String(row.staffName ?? ''),
    terms: text(row.terms),
  };
}
