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
