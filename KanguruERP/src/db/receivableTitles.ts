import { supabase } from './supabaseClient';

// Contas a receber (migration 20261208). Leitura pela RLS (lojas do usuario); escrita so pelas
// funcoes do banco. Tipos: MERCADORIA (sai do estoque; DRE = valor - custo), ACERTO (so caixa),
// OUTROS (DRE como "Outras receitas").

export const RECEIVABLE_BUCKET = 'receivable-attachments';

export type ReceivableKind = 'MERCADORIA' | 'ACERTO' | 'OUTROS';
export type ReceivableMethod = 'PIX' | 'DINHEIRO' | 'TRANSFERENCIA' | 'CARTAO' | 'BOLETO' | 'OUTRO';
export type InstallmentStatus = 'ABERTO' | 'PARCIAL' | 'RECEBIDO' | 'CANCELADO';

export const RECEIVABLE_KINDS: { value: ReceivableKind; label: string; hint: string }[] = [
  { value: 'MERCADORIA', label: 'Mercadoria repassada', hint: 'Os produtos saem do estoque agora. No lucro entra só a diferença entre o valor e o custo.' },
  { value: 'ACERTO', label: 'Empréstimo / acerto', hint: 'Não mexe no estoque e não entra no lucro: só no caixa.' },
  { value: 'OUTROS', label: 'Serviço / outros', hint: 'Entra no DRE como "Outras receitas" quando for recebido.' },
];

export const RECEIVABLE_METHODS: { value: ReceivableMethod; label: string }[] = [
  { value: 'PIX', label: 'Pix' },
  { value: 'DINHEIRO', label: 'Dinheiro' },
  { value: 'TRANSFERENCIA', label: 'Transferência' },
  { value: 'CARTAO', label: 'Cartão' },
  { value: 'BOLETO', label: 'Boleto' },
  { value: 'OUTRO', label: 'Outro' },
];

export const kindLabel = (kind: ReceivableKind) => RECEIVABLE_KINDS.find(item => item.value === kind)?.label ?? kind;
export const receivableMethodLabel = (method: string) => RECEIVABLE_METHODS.find(item => item.value === method)?.label ?? method;

export interface ReceivablePayment {
  id: string;
  installmentId: string;
  amount: number;
  revenueAmount: number;
  paidAt: string;
  method: ReceivableMethod;
  receivedByName: string | null;
}

export interface ReceivableInstallment {
  id: string;
  number: number; // 0 = entrada
  dueDate: string;
  amount: number;
  receivedAmount: number;
  status: InstallmentStatus;
  payments: ReceivablePayment[];
}

export interface ReceivableTitle {
  id: string;
  unitId: string;
  number: number;
  kind: ReceivableKind;
  category: string;
  debtorName: string;
  debtorDocument: string | null;
  debtorPhone: string | null;
  debtorEmail: string | null;
  customerId: string | null;
  description: string;
  documentNumber: string | null;
  notes: string | null;
  items: Array<Record<string, any>>;
  totalAmount: number;
  totalCost: number;
  issueDate: string;
  attachmentPath: string | null;
  attachmentName: string | null;
  status: 'ATIVO' | 'CANCELADO';
  chargeCount: number;
  lastChargeAt: string | null;
  createdByName: string | null;
  createdAt: string;
  installments: ReceivableInstallment[];
}

const num = (value: unknown) => Number(value ?? 0);

// Todas as contas (ativas e as canceladas dos ultimos 18 meses) com parcelas e recebimentos.
export async function listReceivables(): Promise<ReceivableTitle[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - 18);
  const sinceKey = since.toISOString().slice(0, 10);
  const { data: titles, error } = await supabase
    .from('receivable_titles')
    .select('*')
    .or(`status.eq.ATIVO,issue_date.gte.${sinceKey}`)
    .order('issue_date', { ascending: false })
    .limit(2000);
  if (error) throw error;
  const ids = (titles || []).map(row => row.id as string);
  if (ids.length === 0) return [];
  const [{ data: installments, error: instError }, { data: payments, error: payError }] = await Promise.all([
    supabase.from('receivable_installments').select('*').in('title_id', ids).order('number', { ascending: true }),
    supabase.from('receivable_payments').select('*').in('title_id', ids).order('paid_at', { ascending: true }),
  ]);
  if (instError) throw instError;
  if (payError) throw payError;
  const paymentsByInstallment = new Map<string, ReceivablePayment[]>();
  (payments || []).forEach(row => {
    const list = paymentsByInstallment.get(row.installment_id) ?? [];
    list.push({
      id: row.id, installmentId: row.installment_id, amount: num(row.amount), revenueAmount: num(row.revenue_amount),
      paidAt: row.paid_at, method: row.method, receivedByName: row.received_by_name ?? null,
    });
    paymentsByInstallment.set(row.installment_id, list);
  });
  const installmentsByTitle = new Map<string, ReceivableInstallment[]>();
  (installments || []).forEach(row => {
    const list = installmentsByTitle.get(row.title_id) ?? [];
    list.push({
      id: row.id, number: Number(row.number), dueDate: row.due_date, amount: num(row.amount),
      receivedAmount: num(row.received_amount), status: row.status, payments: paymentsByInstallment.get(row.id) ?? [],
    });
    installmentsByTitle.set(row.title_id, list);
  });
  return (titles || []).map(row => ({
    id: row.id,
    unitId: row.unit_id,
    number: Number(row.title_number),
    kind: row.kind,
    category: row.category,
    debtorName: row.debtor_name,
    debtorDocument: row.debtor_document ?? null,
    debtorPhone: row.debtor_phone ?? null,
    debtorEmail: row.debtor_email ?? null,
    customerId: row.customer_id ?? null,
    description: row.description,
    documentNumber: row.document_number ?? null,
    notes: row.notes ?? null,
    items: Array.isArray(row.items) ? row.items : [],
    totalAmount: num(row.total_amount),
    totalCost: num(row.total_cost),
    issueDate: row.issue_date,
    attachmentPath: row.attachment_path ?? null,
    attachmentName: row.attachment_name ?? null,
    status: row.status,
    chargeCount: Number(row.charge_count ?? 0),
    lastChargeAt: row.last_charge_at ?? null,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    installments: installmentsByTitle.get(row.id) ?? [],
  }));
}

// Parcelas em aberto que vencem ate a data (alerta e previsao de entradas).
export interface OpenInstallment {
  unitId: string;
  dueDate: string;
  remaining: number;
  debtorName: string;
}

export async function listOpenReceivableInstallments(untilKey?: string): Promise<OpenInstallment[]> {
  let query = supabase
    .from('receivable_installments')
    .select('unit_id, due_date, amount, received_amount, status, receivable_titles(debtor_name, status)')
    .in('status', ['ABERTO', 'PARCIAL'])
    .order('due_date', { ascending: true })
    .limit(1000);
  if (untilKey) query = query.lte('due_date', untilKey);
  const { data, error } = await query;
  if (error) throw error;
  return (data || [])
    .filter(row => (row as any).receivable_titles?.status !== 'CANCELADO')
    .map(row => ({
      unitId: row.unit_id,
      dueDate: row.due_date,
      remaining: Math.max(0, num(row.amount) - num(row.received_amount)),
      debtorName: (row as any).receivable_titles?.debtor_name ?? '',
    }));
}

// "Outras receitas" do DRE: a parte de cada recebimento que entra no lucro.
export interface OtherIncomeEntry {
  unitId: string;
  date: string; // AAAA-MM-DD
  amount: number;
}

export async function listOtherIncome(): Promise<OtherIncomeEntry[]> {
  const { data, error } = await supabase
    .from('receivable_payments')
    .select('unit_id, paid_at, revenue_amount')
    .neq('revenue_amount', 0)
    .limit(10000);
  if (error) throw error;
  return (data || []).map(row => ({ unitId: row.unit_id, date: row.paid_at, amount: num(row.revenue_amount) }));
}

export interface ReceivableInput {
  unitId: string;
  kind: ReceivableKind;
  category: string;
  debtorName: string;
  debtorDocument: string;
  debtorPhone: string;
  debtorEmail: string;
  customerId: string | null;
  description: string;
  documentNumber: string;
  notes: string;
  issueDate: string;
  totalAmount: number;
  items: Array<Record<string, unknown>>;
  installments: Array<{ dueDate: string; amount: number; downPayment?: boolean }>;
  downPaymentReceived?: { method: ReceivableMethod; paidAt: string } | null;
}

export async function saveReceivable(id: string | null, input: Partial<ReceivableInput>): Promise<string> {
  const { data, error } = await supabase.rpc('save_receivable', { p_id: id, p_data: input });
  if (error) throw error;
  return String(data ?? '');
}

export async function receiveReceivable(installmentId: string, amount: number, paidAt: string, method: ReceivableMethod): Promise<void> {
  const { error } = await supabase.rpc('receive_receivable', { p_installment_id: installmentId, p_amount: amount, p_paid_at: paidAt, p_method: method });
  if (error) throw error;
}

export async function undoReceivablePayment(paymentId: string): Promise<void> {
  const { error } = await supabase.rpc('undo_receivable_payment', { p_payment_id: paymentId });
  if (error) throw error;
}

export async function cancelReceivable(id: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_receivable', { p_id: id });
  if (error) throw error;
}

export async function deleteReceivable(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_receivable', { p_id: id });
  if (error) throw error;
}

export async function registerReceivableCharge(id: string): Promise<void> {
  const { error } = await supabase.rpc('register_receivable_charge', { p_id: id });
  if (error) throw error;
}

export async function uploadReceivableAttachment(tenantId: string, title: ReceivableTitle, file: File): Promise<void> {
  const safeName = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
  const path = `${tenantId}/${title.id}/${crypto.randomUUID().slice(0, 8)}-${safeName}`;
  const { error } = await supabase.storage.from(RECEIVABLE_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  const { error: saveError } = await supabase.rpc('set_receivable_attachment', { p_id: title.id, p_path: path, p_name: file.name });
  if (saveError) {
    await supabase.storage.from(RECEIVABLE_BUCKET).remove([path]);
    throw saveError;
  }
  if (title.attachmentPath) await supabase.storage.from(RECEIVABLE_BUCKET).remove([title.attachmentPath]);
}

export async function openReceivableAttachment(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(RECEIVABLE_BUCKET).createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
}

// Situacao da parcela considerando a data de hoje.
export function installmentState(installment: ReceivableInstallment, todayKey: string): 'RECEBIDA' | 'CANCELADA' | 'VENCIDA' | 'VENCE_HOJE' | 'PARCIAL' | 'A_VENCER' {
  if (installment.status === 'RECEBIDO') return 'RECEBIDA';
  if (installment.status === 'CANCELADO') return 'CANCELADA';
  if (installment.dueDate < todayKey) return 'VENCIDA';
  if (installment.dueDate === todayKey) return 'VENCE_HOJE';
  if (installment.status === 'PARCIAL') return 'PARCIAL';
  return 'A_VENCER';
}
