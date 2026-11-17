import { supabase } from './client';

// Troca Gamer (compra de videogame ou iPhone usado): registro pelo PDV com a sessao do terminal.

export type TradeInPayment = 'VALE' | 'DINHEIRO' | 'PIX';
export type TradeInCondition = 'Excelente' | 'Bom' | 'Com defeito';
export type TradeInDevice = 'VIDEOGAME' | 'IPHONE';
export type PhoneGrade = 'A' | 'B' | 'C';

// Tabela de iPhone da empresa (ERP) e bonus do vale-troca da loja (migration 20261129).
export interface PhoneModel {
  id: string;
  modelName: string;
  storage: string;
  baseValue: number;
  gradeA: number;
  gradeB: number;
  gradeC: number;
  batteryDeduction: number;
}

export interface PhoneTable {
  bonusPercent: number;
  models: PhoneModel[];
}

export const PHONE_CHECKLIST = [
  { key: 'icloud', label: 'iCloud (Buscar iPhone) desconectado pelo dono' },
  { key: 'biometria', label: 'Face ID / Touch ID funcionando' },
  { key: 'imei', label: 'IMEI sem bloqueio de operadora ou restrição' },
  { key: 'cameras', label: 'Câmeras frontal e traseiras funcionando' },
  { key: 'tela', label: 'Tela sem manchas pretas ou linhas' },
  { key: 'documento', label: 'Documento com foto do dono conferido' },
] as const;

export type PhoneChecklistKey = (typeof PHONE_CHECKLIST)[number]['key'];

export interface PhoneEvaluationInput {
  modelId: string;
  grade: PhoneGrade;
  battery: number;
  checklist: Record<PhoneChecklistKey, boolean>;
}

// Mesma conta do servidor: base - desconto do estado - bateria (84% ou menos); vale = + bonus.
export function phoneValues(model: PhoneModel, grade: PhoneGrade, battery: number | null, bonusPercent: number) {
  const gradePercent = grade === 'A' ? model.gradeA : grade === 'B' ? model.gradeB : model.gradeC;
  const batteryDeduction = battery != null && battery <= 84 ? model.batteryDeduction : 0;
  const round = (value: number) => Math.round(value * 100) / 100;
  const cashValue = Math.max(0, round(model.baseValue * (1 - gradePercent / 100) - batteryDeduction));
  const creditValue = round(cashValue * (1 + bonusPercent / 100));
  return { gradePercent, batteryDeduction, cashValue, creditValue };
}

export interface PhoneEvaluation {
  modelName: string;
  storage: string;
  grade: PhoneGrade;
  battery: number;
  cashValue: number;
  creditValue: number;
  bonusPercent: number;
  tableValue: number;
  aboveTable: boolean;
}

export async function getPhoneTradeInTable(): Promise<PhoneTable> {
  const { data, error } = await supabase.rpc('get_pos_trade_in_phone_table');
  if (error) throw error;
  const row = (data ?? {}) as { bonusPercent?: unknown; models?: Record<string, unknown>[] };
  return {
    bonusPercent: Number(row.bonusPercent ?? 10),
    models: (row.models ?? []).map((model) => ({
      id: String(model.id),
      modelName: String(model.modelName ?? ''),
      storage: String(model.storage ?? ''),
      baseValue: Number(model.baseValue ?? 0),
      gradeA: Number(model.gradeA ?? 0),
      gradeB: Number(model.gradeB ?? 0),
      gradeC: Number(model.gradeC ?? 0),
      batteryDeduction: Number(model.batteryDeduction ?? 0),
    })),
  };
}

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
  evaluation?: PhoneEvaluationInput | null;
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
  deviceType: TradeInDevice;
  evaluation: PhoneEvaluation | null;
}

export type TradeInResult =
  | ({ status: 'OK' } & TradeInRecord)
  | { status: 'PASSWORD_REQUIRED'; aboveTable: boolean }
  | { status: 'LOCKED' | 'CUSTOMER_REQUIRED' | 'INVALID_SELLER' | 'SERIAL_EXISTS' }
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
    ...(input.evaluation ? { p_evaluation: input.evaluation } : {}),
  });
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  const status = String(row.status ?? '');
  if (status === 'INVALID_PASSWORD') return { status, remainingAttempts: Number(row.remainingAttempts ?? 0) };
  if (status === 'PASSWORD_REQUIRED') return { status, aboveTable: row.aboveTable === true };
  if (status !== 'OK') return { status: status as 'LOCKED' };
  const evaluation = row.evaluation && typeof row.evaluation === 'object' ? row.evaluation as Record<string, unknown> : null;
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
    deviceType: row.deviceType === 'IPHONE' ? 'IPHONE' : 'VIDEOGAME',
    evaluation: evaluation ? {
      modelName: String(evaluation.modelName ?? ''),
      storage: String(evaluation.storage ?? ''),
      grade: String(evaluation.grade ?? 'A') as PhoneGrade,
      battery: Number(evaluation.battery ?? 0),
      cashValue: Number(evaluation.cashValue ?? 0),
      creditValue: Number(evaluation.creditValue ?? 0),
      bonusPercent: Number(evaluation.bonusPercent ?? 0),
      tableValue: Number(evaluation.tableValue ?? 0),
      aboveTable: evaluation.aboveTable === true,
    } : null,
  };
}
