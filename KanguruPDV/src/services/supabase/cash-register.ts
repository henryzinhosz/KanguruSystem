import { supabase } from './client';

export interface CashSession {
  id: string;
  cashNumber: string;
  openedAt: string;
  openedByName: string;
  openingFloatAmount: number;
}

export interface CashClosureSummary extends CashSession {
  expectedCashAmount: number;
  expectedPixAmount: number;
  expectedCreditAmount: number;
  expectedDebitAmount: number;
  expectedVoucherAmount: number;
  expectedCreditAccountAmount: number;
  suppliesAmount: number;
  withdrawalsAmount: number;
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function mapSession(row: Record<string, unknown>): CashSession {
  return {
    id: String(row.cash_session_id),
    cashNumber: String(row.cash_number),
    openedAt: String(row.opened_at),
    openedByName: String(row.opened_by_name),
    openingFloatAmount: numberValue(row.opening_float_amount),
  };
}

export async function getOpenCashSession(): Promise<CashSession | null> {
  const { data, error } = await supabase.rpc('get_open_pos_cash_register');
  if (error) throw error;
  return data?.[0] ? mapSession(data[0]) : null;
}

export async function openCashSession(cashNumber: string, openedByName: string, openingFloatAmount: number): Promise<CashSession> {
  const { data, error } = await supabase.rpc('open_pos_cash_register', {
    p_cash_number: cashNumber,
    p_opened_by_name: openedByName,
    p_opening_float_amount: openingFloatAmount,
  });
  if (error || !data?.[0]) throw error ?? new Error('Nao foi possivel abrir o caixa.');
  return mapSession(data[0]);
}

export async function recordCashMovement(type: 'SANGRIA' | 'SUPRIMENTO', amount: number, reason: string, operatorName: string): Promise<void> {
  const { error } = await supabase.rpc('record_pos_cash_movement', {
    p_type: type,
    p_amount: amount,
    p_reason: reason,
    p_operator_name: operatorName,
  });
  if (error) throw error;
}

export async function getCashClosureSummary(): Promise<CashClosureSummary> {
  const { data, error } = await supabase.rpc('get_pos_cash_closure_summary');
  if (error || !data?.[0]) throw error ?? new Error('Nao ha caixa aberto para fechar.');
  const row = data[0] as Record<string, unknown>;
  return {
    ...mapSession(row),
    expectedCashAmount: numberValue(row.expected_cash_amount),
    expectedPixAmount: numberValue(row.expected_pix_amount),
    expectedCreditAmount: numberValue(row.expected_credit_amount),
    expectedDebitAmount: numberValue(row.expected_debit_amount),
    expectedVoucherAmount: numberValue(row.expected_voucher_amount),
    expectedCreditAccountAmount: numberValue(row.expected_credit_account_amount),
    suppliesAmount: numberValue(row.supplies_amount),
    withdrawalsAmount: numberValue(row.withdrawals_amount),
  };
}

export interface CashCounts {
  cash: number;
  pix: number;
  credit: number;
  debit: number;
  voucher: number;
  creditAccount: number;
}

export async function closeCashSession(closedByName: string, counts: CashCounts, notes: string): Promise<void> {
  const { error } = await supabase.rpc('close_pos_cash_register', {
    p_closed_by_name: closedByName,
    p_counted_cash_amount: counts.cash,
    p_counted_pix_amount: counts.pix,
    p_counted_credit_amount: counts.credit,
    p_counted_debit_amount: counts.debit,
    p_counted_voucher_amount: counts.voucher,
    p_counted_credit_account_amount: counts.creditAccount,
    p_notes: notes || null,
  });
  if (error) throw error;
}
