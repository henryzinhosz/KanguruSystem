import { supabase } from './supabaseClient';
import type { PayableBill, PayableMethod, PayableRecurrence } from '../types';

// Contas a pagar (migration 20261130). Leitura pela RLS (lojas do usuario); escrita so pelas
// funcoes do banco. Ao pagar, o banco cria a despesa na data do pagamento.

export const PAYABLE_BUCKET = 'payable-attachments';

export const PAYABLE_METHODS: { value: PayableMethod; label: string }[] = [
  { value: 'BOLETO', label: 'Boleto' },
  { value: 'PIX', label: 'Pix' },
  { value: 'TRANSFERENCIA', label: 'Transferência' },
  { value: 'CARTAO', label: 'Cartão' },
  { value: 'DINHEIRO', label: 'Dinheiro' },
  { value: 'DEBITO_AUTOMATICO', label: 'Débito automático' },
];

export const PAYABLE_CATEGORIES = [
  'Mercadoria/Fornecedor',
  'Aluguel',
  'Água/Luz',
  'Internet/Telefone',
  'Salários',
  'Impostos',
  'Repasse da franquia',
  'Sistemas',
  'Marketing',
  'Frete',
  'Manutenção',
  'Compras Urgentes',
  'Outros',
];

export const methodLabel = (method: PayableMethod | null | undefined) =>
  PAYABLE_METHODS.find(item => item.value === method)?.label ?? '';

const num = (value: unknown) => Number(value ?? 0);

function mapBill(row: Record<string, any>): PayableBill {
  return {
    id: row.id,
    unitId: row.unit_id,
    description: row.description,
    supplierId: row.supplier_id ?? null,
    supplierName: row.supplier_name ?? null,
    category: row.category,
    amount: num(row.amount),
    dueDate: row.due_date,
    paymentMethod: row.payment_method ?? null,
    barcode: row.barcode ?? null,
    pixKey: row.pix_key ?? null,
    invoiceNumber: row.invoice_number ?? null,
    notes: row.notes ?? null,
    attachmentPath: row.attachment_path ?? null,
    attachmentName: row.attachment_name ?? null,
    installmentNumber: row.installment_number ?? null,
    installmentTotal: row.installment_total ?? null,
    recurrenceId: row.recurrence_id ?? null,
    status: row.status,
    paidAt: row.paid_at ?? null,
    paidAmount: row.paid_amount == null ? null : num(row.paid_amount),
    paidMethod: row.paid_method ?? null,
    paidByName: row.paid_by_name ?? null,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
  };
}

function mapRecurrence(row: Record<string, any>): PayableRecurrence {
  return {
    id: row.id,
    unitId: row.unit_id,
    description: row.description,
    supplierId: row.supplier_id ?? null,
    supplierName: row.supplier_name ?? null,
    category: row.category,
    amount: num(row.amount),
    paymentMethod: row.payment_method ?? null,
    pixKey: row.pix_key ?? null,
    notes: row.notes ?? null,
    dueDay: Number(row.due_day),
    monthsAhead: Number(row.months_ahead),
    isActive: row.is_active !== false,
  };
}

// Cria as contas do mes das repeticoes ativas (sem erro na tela se a migration nao estiver aplicada).
export async function ensurePayableRecurrences(): Promise<number> {
  const { data, error } = await supabase.rpc('ensure_payable_recurrences');
  if (error) throw error;
  return Number(data ?? 0);
}

// Todas as contas em aberto + as pagas/canceladas dos ultimos 18 meses.
export async function listPayableBills(): Promise<PayableBill[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - 18);
  const sinceKey = since.toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('payable_bills')
    .select('*')
    .or(`status.eq.PENDENTE,due_date.gte.${sinceKey}`)
    .order('due_date', { ascending: true })
    .limit(5000);
  if (error) throw error;
  return (data || []).map(mapBill);
}

export async function listPayableRecurrences(): Promise<PayableRecurrence[]> {
  const { data, error } = await supabase
    .from('payable_recurrences')
    .select('*')
    .order('is_active', { ascending: false })
    .order('description', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapRecurrence);
}

// Contas em aberto que vencem ate amanha (alerta "Precisa de atencao").
export async function listUrgentPayables(untilKey: string): Promise<PayableBill[]> {
  const { data, error } = await supabase
    .from('payable_bills')
    .select('*')
    .eq('status', 'PENDENTE')
    .lte('due_date', untilKey)
    .order('due_date', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data || []).map(mapBill);
}

export interface PayableInput {
  unitId: string;
  description: string;
  supplierId: string | null;
  supplierName: string | null;
  category: string;
  amount: number;
  dueDate: string;
  paymentMethod: PayableMethod | null;
  barcode: string;
  pixKey: string;
  invoiceNumber: string;
  notes: string;
  mode?: 'UNICA' | 'PARCELADA' | 'RECORRENTE';
  installments?: number;
  frequency?: 'MENSAL' | 'QUINZENAL' | 'SEMANAL';
  amountIsTotal?: boolean;
  monthsAhead?: number;
}

export async function savePayableBill(id: string | null, input: PayableInput): Promise<string[]> {
  const { data, error } = await supabase.rpc('save_payable_bill', { p_id: id, p_data: input });
  if (error) throw error;
  return ((data as { ids?: string[] } | null)?.ids ?? []).map(String);
}

export async function payPayableBill(id: string, paidAt: string, paidAmount: number, method: PayableMethod | null): Promise<void> {
  const { error } = await supabase.rpc('pay_payable_bill', { p_id: id, p_paid_at: paidAt, p_paid_amount: paidAmount, p_method: method });
  if (error) throw error;
}

export async function undoPayablePayment(id: string): Promise<void> {
  const { error } = await supabase.rpc('undo_payable_payment', { p_id: id });
  if (error) throw error;
}

export async function setPayableCancelled(id: string, cancelled: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_payable_bill_cancelled', { p_id: id, p_cancelled: cancelled });
  if (error) throw error;
}

// Devolve 'EXCLUIDA' ou 'CANCELADA' (conta de uma repeticao ativa fica cancelada).
export async function deletePayableBill(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('delete_payable_bill', { p_id: id });
  if (error) throw error;
  return String(data ?? '');
}

export async function savePayableRecurrence(id: string, input: {
  description: string;
  supplierId: string | null;
  supplierName: string | null;
  category: string;
  amount: number;
  paymentMethod: PayableMethod | null;
  pixKey: string;
  notes: string;
  dueDay: number;
  monthsAhead: number;
  isActive: boolean;
}): Promise<void> {
  const { error } = await supabase.rpc('save_payable_recurrence', { p_id: id, p_data: input });
  if (error) throw error;
}

// Anexo: envia o arquivo para <empresa>/<conta>/ e guarda o caminho na conta.
export async function uploadPayableAttachment(tenantId: string, bill: PayableBill, file: File): Promise<void> {
  const safeName = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
  const path = `${tenantId}/${bill.id}/${crypto.randomUUID().slice(0, 8)}-${safeName}`;
  const { error } = await supabase.storage.from(PAYABLE_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  const { error: saveError } = await supabase.rpc('set_payable_attachment', { p_id: bill.id, p_path: path, p_name: file.name });
  if (saveError) {
    await supabase.storage.from(PAYABLE_BUCKET).remove([path]);
    throw saveError;
  }
  if (bill.attachmentPath) await supabase.storage.from(PAYABLE_BUCKET).remove([bill.attachmentPath]);
}

export async function removePayableAttachment(bill: PayableBill): Promise<void> {
  if (bill.attachmentPath) {
    const { error } = await supabase.storage.from(PAYABLE_BUCKET).remove([bill.attachmentPath]);
    if (error) throw error;
  }
  const { error } = await supabase.rpc('set_payable_attachment', { p_id: bill.id, p_path: null, p_name: null });
  if (error) throw error;
}

// Link temporario (5 min) para abrir o anexo.
export async function openPayableAttachment(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(PAYABLE_BUCKET).createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
}
