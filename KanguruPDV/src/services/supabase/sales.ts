import { supabase } from './client';

export interface SaleItem {
  productId: string;
  quantity: number;
  variationId?: string;
  serials?: unknown;
  cardCondition?: string;
}

export interface PosSaleTransaction {
  saleId: string;
  invoiceNumber: string;
  items: SaleItem[];
  paymentMethod: string;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  clientCpf: string | null;
  clientName: string | null;
  timestamp: string;
  status: string;
  requiresApproval: boolean;
}

export const saleRpc = {
  async processTransaction(transaction: PosSaleTransaction): Promise<void> {
    const { error } = await supabase.rpc('process_pos_terminal_sale', {
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
    });

    if (error) {
      throw error;
    }
  },
};