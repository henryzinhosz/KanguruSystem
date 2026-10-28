import { supabase } from './client';

export type PaymentMethodKey =
  | 'DINHEIRO'
  | 'PIX'
  | 'CREDITO'
  | 'DEBITO'
  | 'VOUCHER'
  | 'CREDIARIO';

export interface PaymentLine {
  paymentMethod: PaymentMethodKey;
  amount: number;
  installments?: number;
}

// Senha errada ou bloqueada nao gera excecao: a RPC devolve o status para a
// tentativa ficar registrada no servidor. Nesses casos nada da venda e gravado.
export type PosSaleResult =
  | { status: 'OK' }
  | { status: 'INVALID_PASSWORD'; remainingAttempts: number }
  | { status: 'LOCKED'; lockedUntil: string }
  // Codigo de vendedor ausente, inexistente, inativo, de outra loja ou sem permissao.
  | { status: 'INVALID_SELLER' };

export interface SaleItem {
  itemType: 'PRODUCT' | 'SERVICE';
  productId?: string;
  serviceId?: string;
  reservationItemId?: string;
  // Entrega de encomenda com serial: unidade que chegou e foi escolhida no PDV.
  serialUnitId?: string;
  itemSku: string;
  itemName: string;
  quantity: number;
  discountPercent: number;
  unitPrice: number;
  lineTotal: number;
  variationId?: string;
  serials?: unknown;
  cardCondition?: string;
}

export interface PosSaleTransaction {
  saleId: string;
  invoiceNumber: string;
  items: SaleItem[];
  // Mantido para compatibilidade com chamadas legadas.
  // Quando `payments` vier populado, esse campo e ignorado pela RPC.
  paymentMethod: string;
  // Quando definido, a RPC usa esta lista e ignora `paymentMethod`.
  payments?: PaymentLine[] | null;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  clientCpf: string | null;
  clientName: string | null;
  timestamp: string;
  status: string;
  requiresApproval: boolean;
  // Senha administrativa para liberar descontos acima de max_item_discount_percent.
  // So e exigida quando a RPC identificar itens acima do limite.
  adminPassword?: string | null;
  reservationId?: string | null;
  // Codigo (2 digitos) de quem esta finalizando. Obrigatorio.
  sellerCode: string;
}

export const saleRpc = {
  async processTransaction(transaction: PosSaleTransaction): Promise<PosSaleResult> {
    const { data, error } = await supabase.rpc('process_pos_terminal_sale', {
      p_sale_id: transaction.saleId,
      p_invoice_number: transaction.invoiceNumber,
      p_items: transaction.items,
      p_payment_method: transaction.paymentMethod,
      p_gross_amount: transaction.grossAmount,
      p_fee_amount: transaction.feeAmount,
      p_net_amount: transaction.netAmount,
      p_client_cpf: transaction.clientCpf,
      p_client_name: transaction.clientName,
      p_timestamp: transaction.timestamp,
      p_status: transaction.status,
      p_requires_approval: transaction.requiresApproval,
      p_reservation_id: transaction.reservationId ?? null,
      p_payments: transaction.payments && transaction.payments.length > 0
        ? transaction.payments.map((line) => ({
            paymentMethod: line.paymentMethod,
            amount: Number(line.amount.toFixed(2)),
            installments: line.installments ?? 1,
          }))
        : null,
      p_admin_password: transaction.adminPassword && transaction.adminPassword.length > 0
        ? transaction.adminPassword
        : null,
      p_seller_code: transaction.sellerCode,
    });

    if (error) {
      throw error;
    }
    return (data as PosSaleResult | null) ?? { status: 'OK' };
  },
};

// ---- Cupom da venda (2.8a) ----
export interface PosSaleReceiptItem {
  itemType: string;
  itemSku: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  lineTotal: number;
  serials: string[];
}

export interface PosSaleReceipt {
  saleId: string;
  receiptNumber: number | null;
  timestamp: string;
  items: PosSaleReceiptItem[];
  grossAmount: number;
  depositApplied: number;
  paymentMethod: string;
  payments: { paymentMethod: string; amount: number }[];
  sellerName: string | null;
  clientName: string | null;
  clientCpf: string | null;
  fiscalStatus: NfceStatus | null;
  nfce: PosNfceData | null;
}

export type NfceStatus = 'PENDENTE' | 'AUTORIZADA' | 'ERRO' | 'CANCELADA';

// Dados da NFC-e autorizada (para o cupom fiscal).
export interface PosNfceData {
  environment: 'homologacao' | 'producao' | null;
  number: string | null;
  series: string | null;
  key: string | null;
  protocol: string | null;
  qrcodeUrl: string | null;
  consultUrl: string | null;
  authorizedAt: string | null;
  taxTotal: number | null;
  message: string | null;
  // Emitida em contingencia offline (Sefaz fora do ar) e se a Sefaz ja efetivou.
  contingency?: boolean;
  contingencyDone?: boolean;
}

// Sem saleId: a ultima venda deste terminal (reimpressao).
export async function getPosSaleReceipt(saleId: string | null): Promise<PosSaleReceipt | null> {
  const { data, error } = await supabase.rpc('get_pos_sale_receipt', { p_sale_id: saleId });
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const items = (Array.isArray(row.items) ? row.items : []) as Array<Record<string, unknown>>;
  const payments = (Array.isArray(row.payments) ? row.payments : []) as Array<Record<string, unknown>>;
  return {
    saleId: String(row.saleId),
    receiptNumber: row.receiptNumber == null ? null : Number(row.receiptNumber),
    timestamp: String(row.timestamp),
    items: items.map((item) => ({
      itemType: String(item.itemType ?? 'PRODUCT').toUpperCase(),
      itemSku: String(item.itemSku ?? ''),
      itemName: String(item.itemName ?? ''),
      quantity: Number(item.quantity ?? 0),
      unitPrice: Number(item.unitPrice ?? 0),
      discountPercent: Number(item.discountPercent ?? 0),
      lineTotal: Number(item.lineTotal ?? 0),
      serials: Array.isArray(item.serials) ? (item.serials as unknown[]).map(String) : [],
    })),
    grossAmount: Number(row.grossAmount ?? 0),
    depositApplied: Number(row.depositApplied ?? 0),
    paymentMethod: String(row.paymentMethod ?? ''),
    payments: payments.map((payment) => ({
      paymentMethod: String(payment.paymentMethod ?? ''),
      amount: Number(payment.amount ?? 0),
    })),
    sellerName: (row.sellerName as string | null) ?? null,
    clientName: (row.clientName as string | null) ?? null,
    clientCpf: (row.clientCpf as string | null) ?? null,
    fiscalStatus: (row.fiscalStatus as NfceStatus | null) ?? null,
    nfce: row.nfce
      ? {
          ...(row.nfce as Omit<PosNfceData, 'taxTotal'>),
          taxTotal: (row.nfce as Record<string, unknown>).taxTotal == null ? null : Number((row.nfce as Record<string, unknown>).taxTotal),
        }
      : null,
  };
}

// ---- NFC-e (2.8b) ----
export interface PosNfceStatus {
  configured: boolean;
  environment: 'homologacao' | 'producao' | null;
}

export async function getPosNfceStatus(): Promise<PosNfceStatus> {
  const { data, error } = await supabase.rpc('get_pos_nfce_status');
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  return { configured: row.configured === true, environment: (row.environment as PosNfceStatus['environment']) ?? null };
}

export interface NfceEmitResult {
  status: NfceStatus;
  message: string | null;
  contingency?: boolean;
}

// Emite a NFC-e da venda (Edge Function nfce-emit; a chave da Focus fica no servidor).
export async function emitPosNfce(saleId: string): Promise<NfceEmitResult> {
  const { data, error } = await supabase.functions.invoke('nfce-emit', { body: { saleId } });
  if (error) {
    const context = (error as { context?: Response }).context;
    const body = context && typeof context.json === 'function' ? await context.json().catch(() => null) : null;
    if (body?.error) return { status: 'ERRO', message: String(body.error) };
    // 404 = funcao nfce-emit nao publicada no Supabase (nome diferente ou deploy incompleto).
    if (context?.status === 404) return { status: 'PENDENTE', message: 'Serviço de NFC-e não encontrado no servidor (função nfce-emit não publicada). A venda ficou com NFC-e pendente.' };
    if (context?.status) return { status: 'PENDENTE', message: `O serviço de NFC-e respondeu com erro ${context.status}. A venda ficou com NFC-e pendente.` };
    return { status: 'PENDENTE', message: 'Sem conexão com o serviço de NFC-e. A venda ficou com NFC-e pendente.' };
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    status: (row.status as NfceStatus) ?? 'ERRO',
    message: (row.message as string | undefined) ?? (row.error as string | undefined) ?? null,
    contingency: row.contingency === true,
  };
}

// Acompanha as NFC-e em contingencia da loja ate a Sefaz efetivar (Edge Function).
export async function syncNfceContingency(): Promise<{ pending: number; effective: number; errors: number } | null> {
  const { data, error } = await supabase.functions.invoke('nfce-contingency-sync', { body: {} });
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return { pending: Number(row.pending ?? 0), effective: Number(row.effective ?? 0), errors: Number(row.errors ?? 0) };
}

export interface PosSaleSummary {
  saleId: string;
  receiptNumber: number | null;
  receiptPeriod: string | null;
  timestamp: string;
  grossAmount: number;
  clientName: string | null;
  clientCpf: string | null;
  sellerName: string | null;
  status: string;
  fiscalType: string;
  fiscalStatus: NfceStatus | null;
  nfceNumber: string | null;
  nfceMessage: string | null;
  nfceContingency: boolean;
}

// Busca para reimpressao: por data (AAAA-MM-DD), numero (cupom ou NFC-e) ou CPF.
export async function searchPosSales(filter: { date?: string; number?: string; cpf?: string }): Promise<PosSaleSummary[]> {
  const { data, error } = await supabase.rpc('search_pos_sales', {
    p_date: filter.date || null,
    p_number: filter.number || null,
    p_cpf: filter.cpf || null,
  });
  if (error) throw error;
  return ((Array.isArray(data) ? data : []) as Array<Record<string, unknown>>).map((row) => ({
    saleId: String(row.saleId),
    receiptNumber: row.receiptNumber == null ? null : Number(row.receiptNumber),
    receiptPeriod: (row.receiptPeriod as string | null) ?? null,
    timestamp: String(row.timestamp),
    grossAmount: Number(row.grossAmount ?? 0),
    clientName: (row.clientName as string | null) ?? null,
    clientCpf: (row.clientCpf as string | null) ?? null,
    sellerName: (row.sellerName as string | null) ?? null,
    status: String(row.status ?? ''),
    fiscalType: String(row.fiscalType ?? 'NAO_FISCAL'),
    fiscalStatus: (row.fiscalStatus as NfceStatus | null) ?? null,
    nfceNumber: (row.nfceNumber as string | null) ?? null,
    nfceMessage: (row.nfceMessage as string | null) ?? null,
    nfceContingency: row.nfceContingency === true,
  }));
}
