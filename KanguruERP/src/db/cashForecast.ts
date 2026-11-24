import type { PayableBill, Sale, StoreConfig } from '../types';
import type { CardAporte, CashAccount, CashMethodKey, CashSettings } from './cashAccounts';
import { addDaysKey, buildReceivables, type PayoutCheck } from './receivables';
import type { OpenInstallment } from './receivableTitles';

// Previsão de 30 dias do Caixa e Bancos (mesma conta da tela e dos avisos da Agência).

export interface CashForecastInput {
  today: string;
  unitId: string;
  store: StoreConfig;
  accounts: CashAccount[];
  settings: CashSettings | undefined;
  total: number;
  sales: Sale[];
  cardAportes: CardAporte[];
  checks: PayoutCheck[];
  openReceivables: OpenInstallment[];
  payables: PayableBill[];
}

export interface CashForecastRow {
  day: string;
  incoming: number;
  outgoing: number;
  notes: string[];
  balance: number;
}

export interface CashForecast {
  rows: CashForecastRow[];
  incoming: number;
  outgoing: number;
  final: number;
  lowest: { value: number; day: string };
  toConfirm: number;
  hasPayout: boolean;
}

export function computeCashForecast(input: CashForecastInput): CashForecast {
  const { today, unitId, store, accounts, settings, total, sales, cardAportes, checks, openReceivables, payables } = input;
  const payoutAccount = accounts.find(account => account.id === settings?.payoutAccountId);
  const payoutStart = payoutAccount?.openingDate ?? today;
  const entries = buildReceivables(sales.filter(sale => sale.unitId === unitId), [store]);
  const byPayoutDay = new Map<string, number>();
  entries.forEach(entry => byPayoutDay.set(entry.payoutDate, (byPayoutDay.get(entry.payoutDate) ?? 0) + entry.net));
  cardAportes.forEach(item => byPayoutDay.set(item.payoutDate, (byPayoutDay.get(item.payoutDate) ?? 0) + item.net));
  const checked = new Set(checks.map(item => item.payoutDate));
  const end = addDaysKey(today, 29);
  const days = Array.from({ length: 30 }, (_, index) => ({ day: addDaysKey(today, index), incoming: 0, outgoing: 0, notes: [] as string[] }));
  const at = (key: string) => days[Math.max(0, Math.min(29, Math.round((Date.parse(key) - Date.parse(today)) / 86400000)))];
  let toConfirm = 0;
  if (payoutAccount) {
    byPayoutDay.forEach((amount, day) => {
      if (checked.has(day) || day <= payoutStart || day > end) return;
      if (day < today) {
        toConfirm += amount;
        at(today).incoming += amount;
      } else {
        at(day).incoming += amount;
      }
    });
  }
  openReceivables
    .filter(item => item.unitId === unitId && item.remaining > 0 && item.dueDate <= end)
    .forEach(item => {
      const day = at(item.dueDate < today ? today : item.dueDate);
      day.incoming += item.remaining;
      day.notes.push(`receber ${item.debtorName}`);
    });
  payables
    .filter(bill => bill.unitId === unitId && bill.status === 'PENDENTE' && bill.dueDate <= end)
    .filter(bill => !bill.paymentMethod || settings?.methodAccounts?.[bill.paymentMethod as CashMethodKey] != null)
    .forEach(bill => {
      const day = at(bill.dueDate < today ? today : bill.dueDate);
      day.outgoing += bill.amount;
      day.notes.push(bill.description);
    });
  let running = total;
  let lowest = { value: total, day: today };
  const rows = days.map(item => {
    running += item.incoming - item.outgoing;
    if (running < lowest.value) lowest = { value: running, day: item.day };
    return { ...item, balance: running };
  });
  const incoming = rows.reduce((sum, item) => sum + item.incoming, 0);
  const outgoing = rows.reduce((sum, item) => sum + item.outgoing, 0);
  return { rows, incoming, outgoing, final: running, lowest, toConfirm, hasPayout: Boolean(payoutAccount) };
}
