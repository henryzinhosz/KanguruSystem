import type { Product, Sale, StockInventory } from '../types';
import { completedSales } from './finance';

// Itens em Alerta (decisao de 2026-10-14). Usado no card dos Relatorios Gerais e no
// painel "Precisa de atenção".
export const DEFAULT_MIN_STOCK = 2;
export const COVERAGE_WINDOW_DAYS = 30;
export const HIGH_RISK_DAYS = 7;
export const MEDIUM_RISK_DAYS = 15;
const STALE_PRODUCT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AlertRisk = 'ALTO' | 'MEDIO';
export interface StockAlert {
  product: Product;
  qty: number;
  coverageDays: number | null; // null = sem vendas recentes
  risk: AlertRisk;
  reason: string;
}

export function computeStockAlerts(products: Product[], inventory: StockInventory[], sales: Sale[], unitId: string): StockAlert[] {
  if (!unitId) return [];
  const now = Date.now();
  const coverageStart = now - COVERAGE_WINDOW_DAYS * DAY_MS;
  const staleStart = now - STALE_PRODUCT_DAYS * DAY_MS;
  const soldLast30 = new Map<string, number>();
  const lastSaleAt = new Map<string, number>();
  completedSales(sales).forEach(sale => {
    if (sale.unitId !== unitId) return;
    const time = new Date(sale.timestamp).getTime();
    (sale.items || []).forEach(item => {
      if (item.itemType === 'SERVICE' || !item.productId) return;
      if (time >= coverageStart) soldLast30.set(item.productId, (soldLast30.get(item.productId) || 0) + item.quantity);
      if (time > (lastSaleAt.get(item.productId) || 0)) lastSaleAt.set(item.productId, time);
    });
  });

  const alerts: StockAlert[] = [];
  products.forEach(product => {
    const qty = inventory.find(inv => inv.productId === product.id)?.quantities[unitId]?.qty || 0;
    const minDefined = product.minStock !== null && product.minStock !== undefined;
    const minStock = minDefined ? (product.minStock as number) : DEFAULT_MIN_STOCK;
    const soldRecently = (lastSaleAt.get(product.id) || 0) >= staleStart;
    // Produto parado: zerado, sem venda ha 90+ dias e sem minimo definido (provavelmente saiu de linha).
    if (qty <= 0 && !minDefined && !soldRecently) return;

    const dailyRate = (soldLast30.get(product.id) || 0) / COVERAGE_WINDOW_DAYS;
    const coverageDays = dailyRate > 0 ? Math.max(0, qty) / dailyRate : null;

    let risk: AlertRisk | null = null;
    if (qty <= 0 || (coverageDays !== null && coverageDays < HIGH_RISK_DAYS)) risk = 'ALTO';
    else if (qty <= minStock || (coverageDays !== null && coverageDays < MEDIUM_RISK_DAYS)) risk = 'MEDIO';
    if (!risk) return;

    let reason: string;
    if (qty <= 0) reason = 'Esgotado';
    else if (coverageDays !== null && coverageDays < MEDIUM_RISK_DAYS) reason = `~${Math.max(1, Math.floor(coverageDays))} dia(s) de estoque`;
    else reason = `Mínimo: ${minStock}`;

    alerts.push({ product, qty: Math.max(0, qty), coverageDays, risk, reason });
  });

  return alerts.sort((a, b) => {
    if (a.risk !== b.risk) return a.risk === 'ALTO' ? -1 : 1;
    const coverageA = a.coverageDays ?? Number.POSITIVE_INFINITY;
    const coverageB = b.coverageDays ?? Number.POSITIVE_INFINITY;
    if (coverageA !== coverageB) return coverageA - coverageB;
    return a.qty - b.qty;
  });
}
