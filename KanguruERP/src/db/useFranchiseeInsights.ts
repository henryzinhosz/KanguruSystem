import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_MANAGER_PERMISSIONS, Product, Sale, StockInventory, StoreConfig, User, UserRole } from '../types';
import { listErpAlerts, listMyAnnouncements, type ErpAlert, type MyAnnouncement } from './insights';
import { computeStockAlerts } from './stockAlerts';
import { ensurePayableRecurrences, listUrgentPayables } from './payables';
import { listOpenReceivableInstallments } from './receivableTitles';
import { toLocalDateKey } from './finance';
import { listCardAportes, loadPayoutWatch, type CardAporte, type PayoutWatch } from './cashAccounts';
import { addPayoutDays, buildReceivables, listPayoutChecks, rulesOf, type PayoutCheck } from './receivables';

interface PayoutWatchData {
  watch: PayoutWatch[];
  checks: PayoutCheck[];
  aportes: CardAporte[];
}

// Caixa e Bancos: dados para o aviso "Recebimentos sem conferir" (so quem ve o Financeiro).
async function loadPayoutWatchData(): Promise<PayoutWatchData> {
  const watch = await loadPayoutWatch();
  if (watch.length === 0) return { watch, checks: [], aportes: [] };
  const from = watch.reduce((min, item) => item.payoutStart < min ? item.payoutStart : min, watch[0].payoutStart);
  const to = toLocalDateKey(new Date());
  const [checks, aportes] = await Promise.all([
    listPayoutChecks(from, to).catch(() => [] as PayoutCheck[]),
    listCardAportes(from, to).catch(() => [] as CardAporte[]),
  ]);
  return { watch, checks, aportes };
}

// Contas a pagar vencidas ou vencendo ate amanha: uma linha por loja (so quem ve o Financeiro).
async function loadPayableAlerts(): Promise<ErpAlert[]> {
  await ensurePayableRecurrences().catch(() => 0);
  const now = new Date();
  const today = toLocalDateKey(now);
  const tomorrow = toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const bills = await listUrgentPayables(tomorrow);
  const byStore = new Map<string, typeof bills>();
  bills.forEach(bill => byStore.set(bill.unitId, [...(byStore.get(bill.unitId) ?? []), bill]));
  const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return Array.from(byStore.entries()).map(([unitId, items]) => {
    const overdue = items.filter(bill => bill.dueDate < today);
    const dueToday = items.filter(bill => bill.dueDate === today);
    const dueTomorrow = items.filter(bill => bill.dueDate > today);
    const parts = [
      overdue.length ? `${overdue.length} vencida(s)` : '',
      dueToday.length ? `${dueToday.length} vence(m) hoje` : '',
      dueTomorrow.length ? `${dueTomorrow.length} vence(m) amanhã` : '',
    ].filter(Boolean);
    const total = items.reduce((sum, bill) => sum + bill.amount, 0);
    return {
      kind: 'CONTA_PAGAR' as const,
      unitId,
      ref: unitId,
      title: `${parts.join(', ')} (${money(total)})`,
      detail: items.slice(0, 4).map(bill => bill.description).join(', ') + (items.length > 4 ? '...' : ''),
      date: null,
    };
  });
}

// Contas a receber vencidas: uma linha por loja (so quem ve o Financeiro).
async function loadReceivableAlerts(): Promise<ErpAlert[]> {
  const today = toLocalDateKey(new Date());
  const yesterday = toLocalDateKey(new Date(Date.now() - 86400000));
  const overdue = (await listOpenReceivableInstallments(yesterday)).filter(item => item.dueDate < today && item.remaining > 0);
  const byStore = new Map<string, typeof overdue>();
  overdue.forEach(item => byStore.set(item.unitId, [...(byStore.get(item.unitId) ?? []), item]));
  const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return Array.from(byStore.entries()).map(([unitId, items]) => ({
    kind: 'CONTA_RECEBER' as const,
    unitId,
    ref: `receber-${unitId}`,
    title: `${items.length} parcela(s) vencida(s) (${money(items.reduce((sum, item) => sum + item.remaining, 0))})`,
    detail: Array.from(new Set(items.map(item => item.debtorName))).slice(0, 4).join(', '),
    date: null,
  }));
}

// Alertas "Precisa de atenção" e comunicados da rede para o ERP do franqueado.
// Recarrega a cada 5 minutos; antes das migrations 20261118/20261119 fica vazio (sem erro na tela).
const REFRESH_MS = 5 * 60 * 1000;

export function useFranchiseeInsights(
  currentUser: User | null,
  products: Product[],
  inventory: StockInventory[],
  sales: Sale[],
  storeConfigs: StoreConfig[]
) {
  const enabled = Boolean(currentUser && (currentUser.role === UserRole.ADMIN || currentUser.role === UserRole.MANAGER));
  const seesFinance = Boolean(currentUser && (currentUser.role === UserRole.ADMIN
    || (currentUser.permissions ?? DEFAULT_MANAGER_PERMISSIONS).financeiro));
  const [serverAlerts, setServerAlerts] = useState<ErpAlert[]>([]);
  const [payableAlerts, setPayableAlerts] = useState<ErpAlert[]>([]);
  const [payoutData, setPayoutData] = useState<PayoutWatchData>({ watch: [], checks: [], aportes: [] });
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [announcements, setAnnouncements] = useState<MyAnnouncement[]>([]);

  const reloadAlerts = useCallback(async () => {
    if (!enabled) return;
    setAlertsLoading(true);
    try {
      const emptyPayout: PayoutWatchData = { watch: [], checks: [], aportes: [] };
      const [server, payables, receivables, payout] = await Promise.all([
        listErpAlerts().catch(() => [] as ErpAlert[]),
        seesFinance ? loadPayableAlerts().catch(() => [] as ErpAlert[]) : Promise.resolve([] as ErpAlert[]),
        seesFinance ? loadReceivableAlerts().catch(() => [] as ErpAlert[]) : Promise.resolve([] as ErpAlert[]),
        seesFinance ? loadPayoutWatchData().catch(() => emptyPayout) : Promise.resolve(emptyPayout),
      ]);
      setServerAlerts(server);
      setPayableAlerts([...payables, ...receivables]);
      setPayoutData(payout);
    } finally {
      setAlertsLoading(false);
    }
  }, [enabled, seesFinance]);

  const reloadAnnouncements = useCallback(async () => {
    if (!enabled) return;
    try {
      setAnnouncements(await listMyAnnouncements());
    } catch {
      setAnnouncements([]);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setServerAlerts([]);
      setPayableAlerts([]);
      setAnnouncements([]);
      return;
    }
    void reloadAlerts();
    void reloadAnnouncements();
    const timer = window.setInterval(() => {
      void reloadAlerts();
      void reloadAnnouncements();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, reloadAlerts, reloadAnnouncements]);

  // Estoque baixo: uma linha por loja com a contagem (mesma regra dos "Itens em Alerta").
  const stockAlerts = useMemo<ErpAlert[]>(() => {
    if (!enabled) return [];
    return storeConfigs
      .filter(store => store.unitId !== 'central')
      .flatMap(store => {
        const items = computeStockAlerts(products, inventory, sales, store.unitId);
        if (items.length === 0) return [];
        const critical = items.filter(item => item.risk === 'ALTO').length;
        const names = items.slice(0, 4).map(item => `${item.product.name} (${item.reason.toLowerCase()})`).join(', ');
        return [{
          kind: 'ESTOQUE' as const,
          unitId: store.unitId,
          ref: store.unitId,
          title: `${items.length} produto(s) em alerta${critical ? `, ${critical} crítico(s)` : ''}`,
          detail: names + (items.length > 4 ? '...' : ''),
          date: null,
        }];
      });
  }, [enabled, storeConfigs, products, inventory, sales]);

  // Pecas avulsas vendidas com custo a informar (so o dono informa): primeiro item do sino.
  const loosePartAlerts = useMemo<ErpAlert[]>(() => {
    if (!enabled || currentUser?.role !== UserRole.ADMIN) return [];
    const stock = (productId: string) => Object.entries(inventory.find(item => item.productId === productId)?.quantities ?? {})
      .reduce((sum, [, unit]) => sum + (unit.qty || 0), 0);
    const pending = products.filter(product => product.loosePart && product.costPending && !product.archivedAt && stock(product.id) <= 0);
    if (pending.length === 0) return [];
    return [{
      kind: 'PECA_AVULSA' as const,
      unitId: '',
      ref: 'pecas-avulsas',
      title: `${pending.length} peça(s) vendida(s) sem custo informado`,
      detail: pending.slice(0, 4).map(product => product.name).join(', ') + (pending.length > 4 ? '...' : ''),
      date: null,
    }];
  }, [enabled, currentUser?.role, products, inventory]);

  // Dias de repasse (cartão e Pix) que já passaram há mais de 1 dia útil e não foram conferidos.
  const payoutAlerts = useMemo<ErpAlert[]>(() => {
    if (!enabled || payoutData.watch.length === 0) return [];
    const today = toLocalDateKey(new Date());
    const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    return payoutData.watch.flatMap(item => {
      const store = storeConfigs.find(config => config.unitId === item.unitId);
      if (!store) return [];
      const rules = rulesOf(store);
      const byDay = new Map<string, number>();
      buildReceivables(sales.filter(sale => sale.unitId === item.unitId), [store])
        .forEach(entry => byDay.set(entry.payoutDate, (byDay.get(entry.payoutDate) ?? 0) + entry.net));
      payoutData.aportes
        .filter(aporte => aporte.unitId === item.unitId)
        .forEach(aporte => byDay.set(aporte.payoutDate, (byDay.get(aporte.payoutDate) ?? 0) + aporte.net));
      const checked = new Set(payoutData.checks.filter(check => check.unitId === item.unitId).map(check => check.payoutDate));
      const late = Array.from(byDay.entries())
        .filter(([day, amount]) => day > item.payoutStart && day < today && Math.abs(amount) > 0.004
          && !checked.has(day) && addPayoutDays(day, 1, rules) < today)
        .sort(([a], [b]) => a.localeCompare(b));
      if (late.length === 0) return [];
      const fmt = (key: string) => key.split('-').reverse().slice(0, 2).join('/');
      return [{
        kind: 'RECEBIMENTO' as const,
        unitId: item.unitId,
        ref: `recebimento-${item.unitId}`,
        title: `${late.length} dia(s) de repasse sem conferir (${money(late.reduce((sum, [, amount]) => sum + amount, 0))})`,
        detail: late.slice(0, 6).map(([day]) => fmt(day)).join(', ') + (late.length > 6 ? '...' : ''),
        date: null,
      }];
    });
  }, [enabled, payoutData, storeConfigs, sales]);

  const alerts = useMemo(
    () => [...loosePartAlerts, ...payableAlerts, ...payoutAlerts, ...stockAlerts, ...serverAlerts],
    [loosePartAlerts, payableAlerts, payoutAlerts, stockAlerts, serverAlerts]
  );
  const unreadAnnouncements = announcements.filter(item => !item.readAt).length;
  const pendingImportant = announcements.find(item => item.priority === 'IMPORTANTE' && !item.readAt) ?? null;

  return { enabled, alerts, alertsLoading, reloadAlerts, announcements, reloadAnnouncements, unreadAnnouncements, pendingImportant };
}
