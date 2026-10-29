import { supabase } from './client';

// Trocas e devolucoes (2.9): RPCs com a sessao do terminal + NF-e de devolucao (Edge Function).

export type RefundMethod = 'TROCA' | 'VALE' | 'DINHEIRO' | 'PIX' | 'CREDITO' | 'DEBITO';
export type ReturnDestination = 'ESTOQUE' | 'AVARIADO';

export interface ReturnableItem {
  index: number;
  itemType: string;
  productId: string | null;
  name: string;
  sku: string;
  quantity: number;
  returnedQuantity: number;
  unitAmount: number;
  serials: string[];
  returnedSerials: string[];
}

export interface ReturnableSale {
  saleId: string;
  receiptNumber: number | null;
  timestamp: string;
  status: string;
  fiscalStatus: string | null;
  nfceNumber: string | null;
  clientCpf: string | null;
  clientName: string | null;
  customerAddressComplete: boolean;
  exchangeDays: number;
  deadline: string;
  withinPeriod: boolean;
  items: ReturnableItem[];
}

const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

export async function getSaleReturnable(saleId: string): Promise<ReturnableSale | null> {
  const { data, error } = await supabase.rpc('get_pos_sale_returnable', { p_sale_id: saleId });
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    saleId: String(row.saleId),
    receiptNumber: row.receiptNumber == null ? null : Number(row.receiptNumber),
    timestamp: String(row.timestamp),
    status: String(row.status ?? ''),
    fiscalStatus: (row.fiscalStatus as string | null) ?? null,
    nfceNumber: (row.nfceNumber as string | null) ?? null,
    clientCpf: (row.clientCpf as string | null) ?? null,
    clientName: (row.clientName as string | null) ?? null,
    customerAddressComplete: row.customerAddressComplete === true,
    exchangeDays: Number(row.exchangeDays ?? 7),
    deadline: String(row.deadline),
    withinPeriod: row.withinPeriod === true,
    items: ((Array.isArray(row.items) ? row.items : []) as Array<Record<string, unknown>>).map((item) => ({
      index: Number(item.index),
      itemType: String(item.itemType ?? 'PRODUCT'),
      productId: (item.productId as string | null) ?? null,
      name: String(item.name ?? ''),
      sku: String(item.sku ?? ''),
      quantity: Number(item.quantity ?? 0),
      returnedQuantity: Number(item.returnedQuantity ?? 0),
      unitAmount: Number(item.unitAmount ?? 0),
      serials: strings(item.serials),
      returnedSerials: strings(item.returnedSerials),
    })),
  };
}

export interface ReturnLineInput {
  index: number;
  quantity: number;
  serials: string[];
  destination: ReturnDestination;
}

export type SaleReturnResult =
  | { status: 'OK'; returnId: string; returnNumber: number; totalAmount: number; creditId: string | null; needsFiscalNote: boolean }
  | { status: 'PASSWORD_REQUIRED'; outOfPeriod: boolean }
  | { status: 'INVALID_PASSWORD'; remainingAttempts: number }
  | { status: 'LOCKED'; lockedUntil: string }
  | { status: 'CUSTOMER_REQUIRED' }
  | { status: 'CUSTOMER_ADDRESS_REQUIRED' };

export async function processSaleReturn(input: {
  saleId: string;
  items: ReturnLineInput[];
  reason: string;
  refundMethod: RefundMethod;
  customerCpf: string | null;
  adminPassword: string | null;
}): Promise<SaleReturnResult> {
  const { data, error } = await supabase.rpc('process_pos_sale_return', {
    p_sale_id: input.saleId,
    p_items: input.items,
    p_reason: input.reason,
    p_refund_method: input.refundMethod,
    p_customer_cpf: input.customerCpf,
    p_admin_password: input.adminPassword,
  });
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  switch (row.status) {
    case 'OK':
      return {
        status: 'OK',
        returnId: String(row.returnId),
        returnNumber: Number(row.returnNumber),
        totalAmount: Number(row.totalAmount),
        creditId: (row.creditId as string | null) ?? null,
        needsFiscalNote: row.needsFiscalNote === true,
      };
    case 'PASSWORD_REQUIRED':
      return { status: 'PASSWORD_REQUIRED', outOfPeriod: row.outOfPeriod === true };
    case 'INVALID_PASSWORD':
      return { status: 'INVALID_PASSWORD', remainingAttempts: Number(row.remainingAttempts ?? 0) };
    case 'LOCKED':
      return { status: 'LOCKED', lockedUntil: String(row.lockedUntil) };
    case 'CUSTOMER_ADDRESS_REQUIRED':
      return { status: 'CUSTOMER_ADDRESS_REQUIRED' };
    default:
      return { status: 'CUSTOMER_REQUIRED' };
  }
}

export async function getCustomerCreditBalance(cpf: string): Promise<number> {
  const { data, error } = await supabase.rpc('get_pos_customer_credit', { p_cpf: cpf });
  if (error) throw error;
  return Number((data as Record<string, unknown> | null)?.balance ?? 0);
}

export interface SaleReturnReceipt {
  returnId: string;
  returnNumber: number;
  createdAt: string;
  saleReceiptNumber: number | null;
  saleTimestamp: string;
  reason: string;
  refundMethod: RefundMethod;
  totalAmount: number;
  customerCpf: string | null;
  customerName: string | null;
  operatorName: string;
  outOfPeriod: boolean;
  creditBalance: number | null;
  fiscalStatus: string | null;
  nfeNumber: string | null;
  nfeSeries: string | null;
  nfeKey: string | null;
  nfeMessage: string | null;
  items: { name: string; sku: string | null; quantity: number; serials: string[]; lineAmount: number; destination: ReturnDestination }[];
}

export async function getSaleReturn(returnId: string): Promise<SaleReturnReceipt | null> {
  const { data, error } = await supabase.rpc('get_pos_sale_return', { p_return_id: returnId });
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    returnId: String(row.returnId),
    returnNumber: Number(row.returnNumber),
    createdAt: String(row.createdAt),
    saleReceiptNumber: row.saleReceiptNumber == null ? null : Number(row.saleReceiptNumber),
    saleTimestamp: String(row.saleTimestamp),
    reason: String(row.reason ?? ''),
    refundMethod: row.refundMethod as RefundMethod,
    totalAmount: Number(row.totalAmount ?? 0),
    customerCpf: (row.customerCpf as string | null) ?? null,
    customerName: (row.customerName as string | null) ?? null,
    operatorName: String(row.operatorName ?? ''),
    outOfPeriod: row.outOfPeriod === true,
    creditBalance: row.creditBalance == null ? null : Number(row.creditBalance),
    fiscalStatus: (row.fiscalStatus as string | null) ?? null,
    nfeNumber: (row.nfeNumber as string | null) ?? null,
    nfeSeries: (row.nfeSeries as string | null) ?? null,
    nfeKey: (row.nfeKey as string | null) ?? null,
    nfeMessage: (row.nfeMessage as string | null) ?? null,
    items: ((Array.isArray(row.items) ? row.items : []) as Array<Record<string, unknown>>).map((item) => ({
      name: String(item.name ?? ''),
      sku: (item.sku as string | null) ?? null,
      quantity: Number(item.quantity ?? 0),
      serials: strings(item.serials),
      lineAmount: Number(item.lineAmount ?? 0),
      destination: (item.destination as ReturnDestination) ?? 'ESTOQUE',
    })),
  };
}

export interface ReturnNfeResult {
  status: 'AUTORIZADA' | 'PENDENTE' | 'ERRO';
  message: string | null;
}

export async function emitReturnNfe(returnId: string): Promise<ReturnNfeResult> {
  const { data, error } = await supabase.functions.invoke('nfe-return-emit', { body: { returnId } });
  if (error) {
    const context = (error as { context?: Response }).context;
    const body = context && typeof context.json === 'function' ? await context.json().catch(() => null) : null;
    if (body?.error) return { status: 'ERRO', message: String(body.error) };
    if (context?.status === 404) return { status: 'PENDENTE', message: 'Serviço de NF-e de devolução não encontrado no servidor (função nfe-return-emit não publicada).' };
    return { status: 'PENDENTE', message: 'Sem conexão com o serviço de NF-e. A nota de devolução ficou pendente.' };
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return { status: (row.status as ReturnNfeResult['status']) ?? 'ERRO', message: (row.message as string | undefined) ?? (row.error as string | undefined) ?? null };
}
