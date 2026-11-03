import { useCallback, useEffect, useMemo, useState } from 'react';
import { Product, Sale, StockInventory, StoreConfig, User, UserRole } from '../types';
import { listErpAlerts, listMyAnnouncements, type ErpAlert, type MyAnnouncement } from './insights';
import { computeStockAlerts } from './stockAlerts';

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
  const [serverAlerts, setServerAlerts] = useState<ErpAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [announcements, setAnnouncements] = useState<MyAnnouncement[]>([]);

  const reloadAlerts = useCallback(async () => {
    if (!enabled) return;
    setAlertsLoading(true);
    try {
      setServerAlerts(await listErpAlerts());
    } catch {
      setServerAlerts([]);
    } finally {
      setAlertsLoading(false);
    }
  }, [enabled]);

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

  const alerts = useMemo(() => [...stockAlerts, ...serverAlerts], [stockAlerts, serverAlerts]);
  const unreadAnnouncements = announcements.filter(item => !item.readAt).length;
  const pendingImportant = announcements.find(item => item.priority === 'IMPORTANTE' && !item.readAt) ?? null;

  return { enabled, alerts, alertsLoading, reloadAlerts, announcements, reloadAnnouncements, unreadAnnouncements, pendingImportant };
}
