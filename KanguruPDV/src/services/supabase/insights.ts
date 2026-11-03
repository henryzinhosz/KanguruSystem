import { supabase } from './client';

// Relatorio "Vendas por vendedor" (meta do mes) e historico resumido do cliente (migration 20261118).

export interface SellerReportRow {
  code: string;
  name: string;
  goal: number | null;
  todayAmount: number;
  todayCount: number;
  monthAmount: number;
  monthCount: number;
}

export interface SellerReport {
  date: string;
  daysLeft: number;
  daysInMonth: number;
  sellers: SellerReportRow[];
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';

export async function getPosSellerReport(): Promise<SellerReport> {
  const { data, error } = await supabase.rpc('get_pos_seller_report', { p_tz: timeZone() });
  if (error) throw error;
  const report = data as SellerReport;
  return {
    ...report,
    sellers: report.sellers.map((row) => ({
      ...row,
      goal: row.goal === null ? null : Number(row.goal),
      todayAmount: Number(row.todayAmount),
      monthAmount: Number(row.monthAmount),
    })),
  };
}

export interface PosCustomerHistory {
  summary: { purchases: number; totalSpent: number; firstPurchase: string | null; lastPurchase: string | null; creditBalance: number };
  purchases: {
    id: string; timestamp: string; storeName: string | null; status: string; grossAmount: number; returnedAmount: number;
    sellerName: string | null; items: { name: string | null; itemType: string; quantity: number; lineTotal: number; serials: string[] }[];
  }[];
  warranties: { saleDate: string; storeName: string | null; itemName: string | null; serial: string | null; months: number; until: string | null }[];
  workOrders: { id: string; orderNumber: number | null; storeName: string | null; status: string; equipment: string | null; createdAt: string; paid: boolean; total: number }[];
  reservations: { id: string; storeName: string | null; status: string; expiresAt: string; deposit: number; items: { name: string; quantity: number }[] }[];
}

export async function getPosCustomerHistory(cpf: string): Promise<PosCustomerHistory> {
  const { data, error } = await supabase.rpc('get_pos_customer_history', { p_cpf: cpf });
  if (error) throw error;
  return data as PosCustomerHistory;
}
