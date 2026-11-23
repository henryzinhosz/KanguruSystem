import { supabase } from './supabaseClient';

// Caixa e Bancos + Reserva de reposição por fornecedor (migration 20261209).
// Leitura pelas RPCs (saldo calculado no banco); escrita só pelas funções do banco.

export type CashAccountKind = 'GAVETA' | 'BANCO';
export type CashMovementType = 'APORTE' | 'EMPRESTIMO_SOCIO' | 'DEVOLUCAO_SOCIO' | 'RETIRADA' | 'TRANSFERENCIA' | 'AJUSTE';
export type CashMethodKey = 'DINHEIRO' | 'PIX' | 'TRANSFERENCIA' | 'BOLETO' | 'DEBITO_AUTOMATICO' | 'CARTAO' | 'OUTRO';

export const CASH_METHOD_KEYS: { key: CashMethodKey; label: string; hint: string }[] = [
  { key: 'DINHEIRO', label: 'Dinheiro', hint: 'contas pagas e recebidas em dinheiro' },
  { key: 'PIX', label: 'Pix', hint: 'contas, Troca paga em Pix e devolução em Pix' },
  { key: 'TRANSFERENCIA', label: 'Transferência', hint: 'contas pagas ou recebidas por transferência' },
  { key: 'BOLETO', label: 'Boleto', hint: 'contas pagas ou recebidas por boleto' },
  { key: 'DEBITO_AUTOMATICO', label: 'Débito automático', hint: 'contas pagas no débito automático' },
  { key: 'CARTAO', label: 'Cartão', hint: 'conta paga no cartão sai depois, na fatura' },
  { key: 'OUTRO', label: 'Outro', hint: 'recebimentos marcados como "Outro"' },
];

export const MOVEMENT_TYPES: { value: CashMovementType; label: string; hint: string }[] = [
  { value: 'APORTE', label: 'Aporte do sócio', hint: 'dinheiro do dono que entra na loja (não volta)' },
  { value: 'EMPRESTIMO_SOCIO', label: 'Empréstimo do sócio', hint: 'dinheiro do dono que a loja vai devolver' },
  { value: 'DEVOLUCAO_SOCIO', label: 'Devolução ao sócio', hint: 'loja devolve o empréstimo ao dono' },
  { value: 'RETIRADA', label: 'Retirada do sócio', hint: 'dono tira dinheiro da loja' },
  { value: 'TRANSFERENCIA', label: 'Transferência entre contas', hint: 'ex.: depósito da gaveta na Stone' },
  { value: 'AJUSTE', label: 'Ajuste de saldo', hint: 'acertar diferença com o extrato' },
];

export const movementLabel = (type: string) => MOVEMENT_TYPES.find(item => item.value === type)?.label ?? type;

export interface CashSettings {
  pdvCashAccountId: string | null;
  payoutAccountId: string | null;
  methodAccounts: Record<CashMethodKey, string | null>;
  reserveStartDate: string | null;
}

export interface CashAccount {
  id: string;
  name: string;
  kind: CashAccountKind;
  isActive: boolean;
  openingBalance: number;
  openingDate: string;
  balance: number;
  baseKind: 'CONTAGEM' | 'INICIAL';
  baseDate: string;
  baseAmount: number;
  cashNumber: string | null;
  closedAt: string | null;
}

export interface CashEntry {
  accountId: string;
  date: string;
  kind: string;
  description: string;
  amount: number;
  ref: string;
  counted: boolean;
}

export interface CashOverview {
  settings: CashSettings;
  rawSettings: Partial<CashSettings>;
  accounts: CashAccount[];
  entries: CashEntry[];
  closings: { cashNumber: string; closedAt: string; counted: number }[];
  partnerLoanBalance: number;
}

const num = (value: unknown) => Number(value ?? 0);

export async function getCashOverview(unitId: string, from?: string): Promise<CashOverview> {
  const { data, error } = await supabase.rpc('get_cash_overview', { p_unit_id: unitId, p_from: from ?? null });
  if (error) throw error;
  const raw = (data || {}) as Record<string, any>;
  return {
    settings: raw.settings as CashSettings,
    rawSettings: (raw.rawSettings || {}) as Partial<CashSettings>,
    accounts: (raw.accounts || []).map((row: Record<string, any>) => ({
      ...row,
      openingBalance: num(row.openingBalance),
      balance: num(row.balance),
      baseAmount: num(row.baseAmount),
    })) as CashAccount[],
    entries: (raw.entries || []).map((row: Record<string, any>) => ({ ...row, amount: num(row.amount) })) as CashEntry[],
    closings: (raw.closings || []).map((row: Record<string, any>) => ({ ...row, counted: num(row.counted) })),
    partnerLoanBalance: num(raw.partnerLoanBalance),
  };
}

export async function saveCashAccount(input: {
  id: string | null; unitId: string; name: string; kind: CashAccountKind; openingBalance: number; openingDate: string; isActive: boolean;
}): Promise<string> {
  const { data, error } = await supabase.rpc('save_cash_account', {
    p_id: input.id,
    p_unit_id: input.unitId,
    p_name: input.name,
    p_kind: input.kind,
    p_opening_balance: input.openingBalance,
    p_opening_date: input.openingDate,
    p_is_active: input.isActive,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteCashAccount(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_cash_account', { p_id: id });
  if (error) throw error;
}

export async function saveCashSettings(unitId: string, settings: Partial<CashSettings>): Promise<void> {
  const { error } = await supabase.rpc('save_cash_settings', { p_unit_id: unitId, p_settings: settings });
  if (error) throw error;
}

export interface CashMovementInput {
  unitId: string;
  type: CashMovementType;
  accountId: string;
  toAccountId: string | null;
  direction: 'ENTRADA' | 'SAIDA' | null;
  amount: number | null;
  date: string;
  description: string;
  card: { gross: number; fee: number; installments: number; payoutDate: string } | null;
}

export async function addCashMovement(input: CashMovementInput): Promise<string> {
  const { data, error } = await supabase.rpc('add_cash_movement', {
    p_unit_id: input.unitId,
    p_type: input.type,
    p_account_id: input.accountId,
    p_to_account_id: input.toAccountId,
    p_direction: input.direction,
    p_amount: input.amount,
    p_date: input.date,
    p_description: input.description,
    p_card: input.card,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteCashMovement(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_cash_movement', { p_id: id });
  if (error) throw error;
}

// Aporte/empréstimo passado no cartão do sócio: entra no repasse do dia (Recebimentos).
export interface CardAporte {
  id: string;
  unitId: string;
  type: CashMovementType;
  date: string;
  payoutDate: string;
  gross: number;
  fee: number;
  net: number;
  installments: number;
  description: string | null;
}

export async function listCardAportes(fromKey: string, toKey: string): Promise<CardAporte[]> {
  const { data, error } = await supabase
    .from('cash_movements')
    .select('id, unit_id, movement_type, movement_date, payout_date, card_gross, card_fee, amount, card_installments, description')
    .eq('via_card', true)
    .gte('payout_date', fromKey)
    .lte('payout_date', toKey);
  if (error) throw error;
  return (data || []).map(row => ({
    id: row.id,
    unitId: row.unit_id,
    type: row.movement_type,
    date: row.movement_date,
    payoutDate: row.payout_date,
    gross: num(row.card_gross),
    fee: num(row.card_fee),
    net: num(row.amount),
    installments: num(row.card_installments) || 1,
    description: row.description ?? null,
  }));
}

export interface ManualMovement {
  id: string;
  type: CashMovementType;
  accountId: string;
  toAccountId: string | null;
  direction: 'ENTRADA' | 'SAIDA';
  amount: number;
  date: string;
  description: string | null;
  viaCard: boolean;
  cardGross: number | null;
  cardFee: number | null;
  cardInstallments: number | null;
  payoutDate: string | null;
  createdByName: string | null;
  createdAt: string;
}

export async function listManualMovements(unitId: string, fromKey: string): Promise<ManualMovement[]> {
  const { data, error } = await supabase
    .from('cash_movements')
    .select('*')
    .eq('unit_id', unitId)
    .gte('movement_date', fromKey)
    .order('movement_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(row => ({
    id: row.id,
    type: row.movement_type,
    accountId: row.account_id,
    toAccountId: row.to_account_id ?? null,
    direction: row.direction,
    amount: num(row.amount),
    date: row.movement_date,
    description: row.description ?? null,
    viaCard: Boolean(row.via_card),
    cardGross: row.card_gross == null ? null : num(row.card_gross),
    cardFee: row.card_fee == null ? null : num(row.card_fee),
    cardInstallments: row.card_installments ?? null,
    payoutDate: row.payout_date ?? null,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
  }));
}

// ---- Reserva de reposição ----
export interface RestockReserve {
  supplierId: string | null; // null = "Outros"
  name: string;
  brands: string[];
  soldCost: number;
  returnedCost: number;
  consumed: number;
  reserve: number;
}

export interface BrandLink {
  brand: string; // '' = sem marca
  products: number;
  supplierId: string | null;
  soldCost: number;
}

export interface RestockReserves {
  startDate: string | null;
  suppliers: RestockReserve[];
  brands: BrandLink[];
}

export async function getRestockReserves(unitId: string): Promise<RestockReserves> {
  const { data, error } = await supabase.rpc('get_restock_reserves', { p_unit_id: unitId });
  if (error) throw error;
  const raw = (data || {}) as Record<string, any>;
  return {
    startDate: raw.startDate ?? null,
    suppliers: (raw.suppliers || []).map((row: Record<string, any>) => ({
      supplierId: row.supplierId ?? null,
      name: row.name,
      brands: row.brands || [],
      soldCost: num(row.soldCost),
      returnedCost: num(row.returnedCost),
      consumed: num(row.consumed),
      reserve: num(row.reserve),
    })),
    brands: (raw.brands || []).map((row: Record<string, any>) => ({
      brand: row.brand ?? '',
      products: num(row.products),
      supplierId: row.supplierId ?? null,
      soldCost: num(row.soldCost),
    })),
  };
}

export async function setBrandSupplier(brand: string, supplierId: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_brand_supplier', { p_brand: brand, p_supplier_id: supplierId });
  if (error) throw error;
}
