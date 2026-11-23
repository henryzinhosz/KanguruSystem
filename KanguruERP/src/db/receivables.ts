import { supabase } from './supabaseClient';
import type { Sale, SettlementRule, SettlementRules, StoreConfig } from '../types';
import { toLocalDateKey } from './finance';

// Previsao de recebimentos (desenho aprovado em 2026-11-20): quando o dinheiro de cada venda
// em Pix/debito/credito cai na conta, ja sem a taxa da maquininha gravada na venda.
// Regras por loja em store_configs.settlement_rules (migration 20261202).

export const DEFAULT_SETTLEMENT_RULES: SettlementRules = {
  pix: { mode: 'IMMEDIATE', days: 0 },
  debito: { mode: 'BUSINESS_DAYS', days: 1 },
  credito: { mode: 'BUSINESS_DAYS', days: 1 },
  businessDays: 'MON_SAT',
  extraHolidays: [],
};

export function rulesOf(store: StoreConfig | undefined): SettlementRules {
  const saved = store?.settlementRules;
  if (!saved) return DEFAULT_SETTLEMENT_RULES;
  return {
    pix: saved.pix ?? DEFAULT_SETTLEMENT_RULES.pix,
    debito: saved.debito ?? DEFAULT_SETTLEMENT_RULES.debito,
    credito: saved.credito ?? DEFAULT_SETTLEMENT_RULES.credito,
    businessDays: saved.businessDays === 'MON_FRI' ? 'MON_FRI' : 'MON_SAT',
    extraHolidays: Array.isArray(saved.extraHolidays) ? saved.extraHolidays : [],
  };
}

// ---- Datas (sempre AAAA-MM-DD no horario do Brasil) ----
const pad = (value: number) => String(value).padStart(2, '0');
const keyOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const dateOf = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDaysKey = (key: string, days: number) => {
  const date = dateOf(key);
  date.setDate(date.getDate() + days);
  return keyOf(date);
};

// Domingo de Pascoa (algoritmo de Meeus/Butcher).
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const holidayCache = new Map<number, Map<string, string>>();

// Feriados nacionais e bancarios do ano (data -> nome).
export function nationalHolidays(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const list = new Map<string, string>([
    [`${year}-01-01`, 'Confraternização Universal'],
    [`${year}-04-21`, 'Tiradentes'],
    [`${year}-05-01`, 'Dia do Trabalho'],
    [`${year}-09-07`, 'Independência'],
    [`${year}-10-12`, 'Nossa Senhora Aparecida'],
    [`${year}-11-02`, 'Finados'],
    [`${year}-11-15`, 'Proclamação da República'],
    [`${year}-11-20`, 'Consciência Negra'],
    [`${year}-12-25`, 'Natal'],
  ]);
  const base = keyOf(easter(year));
  list.set(addDaysKey(base, -48), 'Carnaval');
  list.set(addDaysKey(base, -47), 'Carnaval');
  list.set(addDaysKey(base, -2), 'Sexta-feira Santa');
  list.set(addDaysKey(base, 60), 'Corpus Christi');
  holidayCache.set(year, list);
  return list;
}

// Feriado nacional ou feriado extra da loja ("MM-DD", vale todo ano).
export function holidayName(key: string, rules: SettlementRules): string | null {
  const national = nationalHolidays(Number(key.slice(0, 4))).get(key);
  if (national) return national;
  return rules.extraHolidays.includes(key.slice(5)) ? 'Feriado da loja' : null;
}

export function isPayoutDay(key: string, rules: SettlementRules): boolean {
  const weekday = dateOf(key).getDay(); // 0 domingo, 6 sabado
  if (weekday === 0) return false;
  if (weekday === 6 && rules.businessDays === 'MON_FRI') return false;
  return !holidayName(key, rules);
}

export function nextPayoutDay(key: string, rules: SettlementRules): string {
  let day = key;
  for (let guard = 0; guard < 30 && !isPayoutDay(day, rules); guard++) day = addDaysKey(day, 1);
  return day;
}

// N dias uteis depois (N = 0: o proprio dia, mesmo que nao seja dia util).
export function addPayoutDays(key: string, days: number, rules: SettlementRules): string {
  let day = key;
  let left = days;
  for (let guard = 0; left > 0 && guard < 400; guard++) {
    day = addDaysKey(day, 1);
    if (isPayoutDay(day, rules)) left -= 1;
  }
  return day;
}

// ---- Lancamentos previstos ----
export type ReceivableMethod = 'PIX' | 'DEBITO' | 'CREDITO';

export interface ReceivableEntry {
  payoutDate: string;
  unitId: string;
  saleId: string;
  saleLabel: string; // "Cupom 00012" ou numero da venda
  saleDate: string;
  method: ReceivableMethod;
  installment: string | null; // "2/3" quando o credito cai parcela por parcela
  gross: number;
  fee: number;
  net: number;
  isRefund: boolean;
  // Aporte/empréstimo do sócio passado no cartão (Caixa e Bancos): cai junto com as vendas.
  isAporte?: boolean;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function payoutDatesFor(rule: SettlementRule, saleDay: string, installments: number, rules: SettlementRules): string[] {
  if (rule.mode === 'IMMEDIATE') return [saleDay];
  if (rule.mode === 'INSTALLMENTS' && installments > 1) {
    return Array.from({ length: installments }, (_, index) => nextPayoutDay(addDaysKey(saleDay, 30 * (index + 1)), rules));
  }
  if (rule.mode === 'INSTALLMENTS') return [nextPayoutDay(addDaysKey(saleDay, 30), rules)];
  return [addPayoutDays(saleDay, Math.max(0, rule.days), rules)];
}

const ruleFor = (rules: SettlementRules, method: ReceivableMethod) =>
  method === 'PIX' ? rules.pix : method === 'DEBITO' ? rules.debito : rules.credito;

const saleLabel = (sale: Sale) =>
  sale.receiptNumber ? `Cupom ${String(sale.receiptNumber).padStart(5, '0')}` : `Venda ${sale.invoiceNumber || sale.id.slice(0, 8)}`;

export function buildReceivables(sales: Sale[], storeConfigs: StoreConfig[]): ReceivableEntry[] {
  const entries: ReceivableEntry[] = [];
  const storeMap = new Map(storeConfigs.map(store => [store.unitId, store]));

  sales.forEach(sale => {
    if (sale.status !== 'CONCLUIDA') return;
    const store = storeMap.get(sale.unitId);
    if (!store) return;
    const rules = rulesOf(store);
    const saleDay = toLocalDateKey(sale.timestamp);
    const pixRate = Number(store.paymentFees?.PIX ?? 0); // fracao (0,005 = 0,5%)

    const lines = sale.payments && sale.payments.length > 0
      ? sale.payments
      : (['PIX', 'DEBITO', 'CREDITO'] as string[]).includes(sale.paymentMethod)
        ? [{ paymentMethod: sale.paymentMethod, amount: sale.grossAmount, installments: 1, feePercent: null }]
        : [];

    lines.forEach(line => {
      const method = line.paymentMethod as ReceivableMethod;
      if (method !== 'PIX' && method !== 'DEBITO' && method !== 'CREDITO') return;
      const gross = Number(line.amount) || 0;
      if (gross <= 0) return;
      const feeTotal = method === 'PIX'
        ? round2(gross * pixRate)
        : round2(gross * Number(line.feePercent ?? 0) / 100);
      const dates = payoutDatesFor(ruleFor(rules, method), saleDay, Math.max(1, Number(line.installments) || 1), rules);
      const parts = dates.length;
      let grossLeft = gross;
      let feeLeft = feeTotal;
      dates.forEach((payoutDate, index) => {
        const last = index === parts - 1;
        const partGross = last ? round2(grossLeft) : round2(gross / parts);
        const partFee = last ? round2(feeLeft) : round2(feeTotal / parts);
        grossLeft -= partGross;
        feeLeft -= partFee;
        entries.push({
          payoutDate,
          unitId: sale.unitId,
          saleId: sale.id,
          saleLabel: saleLabel(sale),
          saleDate: saleDay,
          method,
          installment: parts > 1 ? `${index + 1}/${parts}` : null,
          gross: partGross,
          fee: partFee,
          net: round2(partGross - partFee),
          isRefund: false,
        });
      });
    });

    // Devolucao estornada na maquininha: desconta no proximo dia de repasse depois da devolucao.
    (sale.returns || []).forEach(item => {
      if (item.refundMethod !== 'CREDITO' && item.refundMethod !== 'DEBITO') return;
      const returnDay = toLocalDateKey(item.createdAt);
      entries.push({
        payoutDate: addPayoutDays(returnDay, 1, rules),
        unitId: sale.unitId,
        saleId: sale.id,
        saleLabel: `${saleLabel(sale)} (devolução nº ${item.returnNumber})`,
        saleDate: returnDay,
        method: item.refundMethod,
        installment: null,
        gross: -item.totalAmount,
        fee: 0,
        net: -item.totalAmount,
        isRefund: true,
      });
    });
  });

  return entries;
}

// ---- Conferencia com o extrato ----
export interface PayoutCheck {
  unitId: string;
  payoutDate: string;
  expectedAmount: number;
  receivedAmount: number;
  note: string | null;
  checkedByName: string | null;
  checkedAt: string;
}

export async function listPayoutChecks(fromKey: string, toKey: string): Promise<PayoutCheck[]> {
  const { data, error } = await supabase
    .from('payout_checks')
    .select('*')
    .gte('payout_date', fromKey)
    .lte('payout_date', toKey);
  if (error) throw error;
  return (data || []).map(row => ({
    unitId: row.unit_id,
    payoutDate: row.payout_date,
    expectedAmount: Number(row.expected_amount),
    receivedAmount: Number(row.received_amount),
    note: row.note ?? null,
    checkedByName: row.checked_by_name ?? null,
    checkedAt: row.checked_at,
  }));
}

export async function setPayoutCheck(unitId: string, payoutDate: string, expected: number, received: number, note: string): Promise<void> {
  const { error } = await supabase.rpc('set_payout_check', {
    p_unit_id: unitId,
    p_payout_date: payoutDate,
    p_expected_amount: expected,
    p_received_amount: received,
    p_note: note,
  });
  if (error) throw error;
}

export async function clearPayoutCheck(unitId: string, payoutDate: string): Promise<void> {
  const { error } = await supabase.rpc('clear_payout_check', { p_unit_id: unitId, p_payout_date: payoutDate });
  if (error) throw error;
}

export const todayKey = () => keyOf(new Date());
