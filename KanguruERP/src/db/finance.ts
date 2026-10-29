/**
 * Regras financeiras compartilhadas entre Dashboard e Financeiro, para que
 * as duas telas mostrem exatamente os mesmos numeros.
 *
 * Datas: tudo no horario local do navegador (a loja), nunca em UTC — uma
 * venda as 22h pertence ao proprio dia.
 */

import { Expense, Sale } from '../types';

export const CONSOLIDATED = 'consolidado';

export type PeriodPreset = 'hoje' | 'semana' | '7dias' | 'mes' | 'mes_passado' | 'personalizado';

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  hoje: 'Hoje',
  semana: 'Esta semana',
  '7dias': 'Últimos 7 dias',
  mes: 'Este mês',
  mes_passado: 'Mês passado',
  personalizado: 'Personalizado',
};

// Intervalo [start, end): end e exclusivo (meia-noite do dia seguinte ao ultimo dia).
export interface DateRange {
  start: Date;
  end: Date;
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

// 'YYYY-MM-DD' no horario local.
export function toLocalDateKey(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseLocalDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatDayLabel(key: string): string {
  const [, month, day] = key.split('-');
  return `${day}/${month}`;
}

export function resolvePeriod(
  preset: PeriodPreset,
  customFrom?: string,
  customTo?: string,
  now: Date = new Date()
): DateRange {
  const today = startOfDay(now);
  switch (preset) {
    case 'hoje':
      return { start: today, end: addDays(today, 1) };
    case 'semana': {
      // Segunda-feira desta semana ate hoje (mesma semana do DRE).
      const mondayOffset = (today.getDay() + 6) % 7;
      return { start: addDays(today, -mondayOffset), end: addDays(today, 1) };
    }
    case '7dias':
      return { start: addDays(today, -6), end: addDays(today, 1) };
    case 'mes_passado':
      return {
        start: new Date(today.getFullYear(), today.getMonth() - 1, 1),
        end: new Date(today.getFullYear(), today.getMonth(), 1),
      };
    case 'personalizado': {
      if (customFrom && customTo) {
        const from = parseLocalDateKey(customFrom);
        const to = parseLocalDateKey(customTo);
        const [first, last] = from <= to ? [from, to] : [to, from];
        return { start: first, end: addDays(last, 1) };
      }
      return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: addDays(today, 1) };
    }
    case 'mes':
    default:
      return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: addDays(today, 1) };
  }
}

export function isInRange(timestamp: string, range: DateRange): boolean {
  const time = new Date(timestamp).getTime();
  return time >= range.start.getTime() && time < range.end.getTime();
}

// Todos os dias do intervalo, como chaves locais.
export function listDays(range: DateRange): string[] {
  const days: string[] = [];
  for (let day = startOfDay(range.start); day < range.end; day = addDays(day, 1)) {
    days.push(toLocalDateKey(day));
  }
  return days;
}

export const inScope = (unitId: string, scope: string) => scope === CONSOLIDATED || unitId === scope;

/**
 * Custo das mercadorias de uma venda, a partir do custo congelado em cada item.
 * - Servico: custo zero.
 * - Produto sem costTotal (venda anterior a 2.7b): custo desconhecido.
 * - Lancamento manual sem itens (Financeiro > Registro de Vendas): custo desconhecido.
 */
export function saleCost(sale: Sale): { cost: number; missing: boolean } {
  const items = sale.items || [];
  if (items.length === 0) {
    return { cost: 0, missing: sale.grossAmount > 0 };
  }
  let cost = 0;
  let missing = false;
  items.forEach(item => {
    if (item.itemType === 'SERVICE') return;
    if (typeof item.costTotal === 'number' && Number.isFinite(item.costTotal)) {
      cost += item.costTotal;
    } else {
      missing = true;
    }
  });
  return { cost, missing };
}

export interface FinancialSummary {
  revenue: number;         // faturamento bruto
  cost: number;            // custo das mercadorias vendidas
  grossProfit: number;     // faturamento - custo
  fees: number;            // taxas de pagamento
  expenses: number;        // despesas lancadas no Financeiro
  operatingProfit: number; // lucro bruto - taxas - despesas
  salesCount: number;
  salesMissingCost: number;
}

export const completedSales = (sales: Sale[]) => sales.filter(sale => sale.status === 'CONCLUIDA');

// Trocas/devolucoes (2.9): descontam o valor devolvido e o custo que voltou ao estoque.
// Simplificacao: contam no periodo da venda (nao na data da devolucao).
export const saleReturnedAmount = (sale: Sale) => (sale.returns || []).reduce((sum, item) => sum + item.totalAmount, 0);
const saleReturnedCost = (sale: Sale) => (sale.returns || []).reduce((sum, item) => sum + item.costBack, 0);

export function summarize(sales: Sale[], expenses: Expense[]): FinancialSummary {
  let revenue = 0;
  let cost = 0;
  let fees = 0;
  let salesMissingCost = 0;
  sales.forEach(sale => {
    revenue += sale.grossAmount - saleReturnedAmount(sale);
    fees += sale.feeAmount;
    const info = saleCost(sale);
    cost += info.cost - saleReturnedCost(sale);
    if (info.missing) salesMissingCost += 1;
  });
  const expenseTotal = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const grossProfit = revenue - cost;
  return {
    revenue,
    cost,
    grossProfit,
    fees,
    expenses: expenseTotal,
    operatingProfit: grossProfit - fees - expenseTotal,
    salesCount: sales.length,
    salesMissingCost,
  };
}

const MONTH_ABBREVIATIONS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// Semana do mes (segunda a domingo, cortada na virada do mes), no horario local.
// Sem 01 = do dia 1 ate o primeiro domingo. Chave ordenavel: 'YYYY-MM-NN'.
export function monthWeekKey(timestamp: string): string {
  const date = new Date(timestamp);
  const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7; // 0 = o mes comeca numa segunda
  const week = Math.floor((date.getDate() - 1 + mondayOffset) / 7) + 1;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${String(week).padStart(2, '0')}`;
}

const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const pad2 = (value: number) => String(value).padStart(2, '0');

// Dias que uma semana do mes cobre.
export function monthWeekRange(key: string): { year: number; month: number; week: number; startDay: number; endDay: number } {
  const [year, month, week] = key.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0).getDate();
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  return {
    year,
    month,
    week,
    startDay: Math.max(1, (week - 1) * 7 - mondayOffset + 1),
    endDay: Math.min(lastDay, week * 7 - mondayOffset),
  };
}

// 'Sem 01 - Out (01 a 05/10)'; o ano aparece quando nao e o ano atual.
export function monthWeekLabel(key: string, now: Date = new Date()): string {
  const { year, month, week, startDay, endDay } = monthWeekRange(key);
  const monthLabel = MONTH_ABBREVIATIONS[month - 1] + (year !== now.getFullYear() ? `/${year}` : '');
  const days = startDay === endDay ? `${pad2(startDay)}/${pad2(month)}` : `${pad2(startDay)} a ${pad2(endDay)}/${pad2(month)}`;
  return `Sem ${pad2(week)} - ${monthLabel} (${days})`;
}

// Chave do mes ('YYYY-MM') e nome por extenso ('Outubro 2026').
export const monthKeyOf = (timestamp: string) => toLocalDateKey(timestamp).slice(0, 7);
export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}
export function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

// Todas as semanas de um mes, em ordem.
export function weeksOfMonth(monthKey: string): string[] {
  const [year, month] = monthKey.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const keys = new Set<string>();
  for (let day = 1; day <= lastDay; day += 1) {
    keys.add(monthWeekKey(new Date(year, month - 1, day).toISOString()));
  }
  return Array.from(keys);
}

// Total por forma de pagamento. Venda com linhas (PDV): cada linha na sua forma;
// a diferenca para o total e o sinal de reserva, recebido antes em outro registro.
export const DEPOSIT_PAYMENT_KEY = 'SINAL DE RESERVA';
export function paymentBreakdown(sales: Sale[]): Map<string, number> {
  const totals = new Map<string, number>();
  const add = (method: string, amount: number) => totals.set(method, (totals.get(method) || 0) + amount);
  sales.forEach(sale => {
    if (!sale.payments?.length) {
      add(sale.paymentMethod, sale.grossAmount);
      return;
    }
    const linesTotal = sale.payments.reduce((sum, payment) => sum + payment.amount, 0);
    sale.payments.forEach(payment => add(payment.paymentMethod, payment.amount));
    const deposit = Math.round((sale.grossAmount - linesTotal) * 100) / 100;
    if (deposit > 0) add(DEPOSIT_PAYMENT_KEY, deposit);
  });
  return totals;
}

export interface SellerSummary {
  key: string;
  label: string;
  salesCount: number;
  total: number;
}

// Vendas por vendedor (o vendedor congelado na venda). Vendas sem vendedor: grupo proprio.
export function sellerBreakdown(sales: Sale[]): SellerSummary[] {
  const groups = new Map<string, SellerSummary>();
  sales.forEach(sale => {
    const key = sale.sellerCode ? `${sale.sellerCode}|${sale.sellerName || ''}` : '__none__';
    const label = sale.sellerCode ? `${sale.sellerName || 'Vendedor'} (${sale.sellerCode})` : 'Sem vendedor (vendas antigas)';
    const group = groups.get(key) || { key, label, salesCount: 0, total: 0 };
    group.salesCount += 1;
    group.total += sale.grossAmount;
    groups.set(key, group);
  });
  return Array.from(groups.values()).sort((a, b) => b.total - a.total);
}

export const formatMoney = (value: number) =>
  value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
