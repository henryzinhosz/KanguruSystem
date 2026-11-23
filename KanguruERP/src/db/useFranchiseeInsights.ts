import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_MANAGER_PERMISSIONS, Product, Sale, StockInventory, StoreConfig, User, UserRole } from '../types';
import { listErpAlerts, listMyAnnouncements, type ErpAlert, type MyAnnouncement } from './insights';
import { computeStockAlerts } from './stockAlerts';
import { ensurePayableRecurrences, listUrgentPayables } from './payables';
import { toLocalDateKey } from './finance';

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
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [announcements, setAnnouncements] = useState<MyAnnouncement[]>([]);

  const reloadAlerts = useCallback(async () => {
    if (!enabled) return;
    setAlertsLoading(true);
    try {
      const [server, payables] = await Promise.all([
        listErpAlerts().catch(() => [] as ErpAlert[]),
        seesFinance ? loadPayableAlerts().catch(() => [] as ErpAlert[]) : Promise.resolve([] as ErpAlert[]),
      ]);
      setServerAlerts(server);
      setPayableAlerts(payables);
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

  const alerts = useMemo(
    () => [...loosePartAlerts, ...payableAlerts, ...stockAlerts, ...serverAlerts],
    [loosePartAlerts, payableAlerts, stockAlerts, serverAlerts]
  );
  const unreadAnnouncements = announcements.filter(item => !item.readAt).length;
  const pendingImportant = announcements.find(item => item.priority === 'IMPORTANTE' && !item.readAt) ?? null;

  return { enabled, alerts, alertsLoading, reloadAlerts, announcements, reloadAnnouncements, unreadAnnouncements, pendingImportant };
}
