/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import {
  User,
  UserRole,
  Product,
  StockInventory,
  Sale,
  Expense,
  StoreConfig,
  ProductStoreCost
} from '../types';
import { StaleProductsPanel, StockValuePanel } from './ProductReports';
import { BalancosReportPanel } from './BalancoPanel';
import {
  TrendingUp,
  DollarSign,
  AlertTriangle,
  ShoppingBag,
  CheckCircle,
  Truck,
  Package,
  Coins
} from 'lucide-react';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  ReferenceLine,
  Cell,
  PieChart,
  Pie
} from 'recharts';
import {
  CONSOLIDATED,
  DateRange,
  PERIOD_LABELS,
  PeriodPreset,
  completedSales,
  formatDayLabel,
  formatMoney,
  inScope,
  isInRange,
  monthWeekKey,
  monthWeekLabel,
  listDays,
  resolvePeriod,
  saleCost,
  summarize,
  toLocalDateKey
} from '../db/finance';

interface DashboardProps {
  currentUser: User;
  products: Product[];
  inventory: StockInventory[];
  sales: Sale[];
  expenses: Expense[];
  storeConfigs: StoreConfig[];
  productStoreCosts: ProductStoreCost[];
}

// Paleta categorica validada (ordem fixa; a cor segue a loja/categoria, nunca a posicao no ranking).
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const MAX_CATEGORY_SLICES = SERIES_COLORS.length;

// Itens em Alerta (decisao de 2026-10-14).
const DEFAULT_MIN_STOCK = 2;
const COVERAGE_WINDOW_DAYS = 30;
const HIGH_RISK_DAYS = 7;
const MEDIUM_RISK_DAYS = 15;
const STALE_PRODUCT_DAYS = 90;
const MIN_CHART_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type ComparisonMetric = 'revenue' | 'grossProfit' | 'operatingProfit';
const COMPARISON_LABELS: Record<ComparisonMetric, string> = {
  revenue: 'Faturamento',
  grossProfit: 'Lucro Bruto',
  operatingProfit: 'Lucro Real'
};

type AlertRisk = 'ALTO' | 'MEDIO';
interface StockAlert {
  product: Product;
  qty: number;
  coverageDays: number | null; // null = sem vendas recentes
  risk: AlertRisk;
  reason: string;
}

const compactMoney = (value: number) =>
  `R$ ${value.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })}`;

// Graficos com poucos dias viram uma janela de pelo menos 7 dias terminando no fim do periodo.
function chartWindow(range: DateRange): DateRange {
  const days = listDays(range);
  if (days.length >= MIN_CHART_DAYS) return range;
  const end = range.end;
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - MIN_CHART_DAYS);
  return { start, end };
}

export default function DashboardView({
  currentUser,
  products,
  inventory,
  sales,
  expenses,
  storeConfigs,
  productStoreCosts
}: DashboardProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const canChooseStore = currentUser.unitId === 'central';
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;
  const storeColor = (unitId: string) => {
    const index = stores.findIndex(store => store.unitId === unitId);
    return SERIES_COLORS[(index < 0 ? 0 : index) % SERIES_COLORS.length];
  };

  // Escopo (consolidado ou loja) e periodo
  const [selectedStoreFilter, setSelectedStoreFilter] = useState<string>(CONSOLIDATED);
  const activeUnitId = canChooseStore ? selectedStoreFilter : currentUser.unitId;
  const [section, setSection] = useState<'financeiro' | 'produtos'>('financeiro');
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('mes');
  const [customFrom, setCustomFrom] = useState(() => toLocalDateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [customTo, setCustomTo] = useState(() => toLocalDateKey(new Date()));
  const [comparisonMetric, setComparisonMetric] = useState<ComparisonMetric>('revenue');

  const range = resolvePeriod(periodPreset, customFrom, customTo);
  const rangeDays = listDays(range);
  const rangeLabel = rangeDays.length === 1
    ? formatDayLabel(rangeDays[0])
    : `${formatDayLabel(rangeDays[0])} a ${formatDayLabel(rangeDays[rangeDays.length - 1])}`;

  // Seletor proprio do card de alertas (segue o filtro geral quando ele aponta uma loja)
  const [alertStoreId, setAlertStoreId] = useState<string>('');
  useEffect(() => {
    if (!canChooseStore) {
      setAlertStoreId(currentUser.unitId);
    } else if (activeUnitId !== CONSOLIDATED) {
      setAlertStoreId(activeUnitId);
    } else {
      setAlertStoreId(previous => stores.some(store => store.unitId === previous) ? previous : stores[0]?.unitId || '');
    }
  }, [activeUnitId, canChooseStore, currentUser.unitId, storeConfigs]);

  // 1. Vendas e despesas do escopo
  const allScopeSales = completedSales(sales).filter(sale => inScope(sale.unitId, activeUnitId));
  const scopeSales = allScopeSales.filter(sale => isInRange(sale.timestamp, range));
  const scopeExpenses = expenses.filter(expense => inScope(expense.unitId, activeUnitId) && isInRange(expense.timestamp, range));
  const summary = summarize(scopeSales, scopeExpenses);
  const ticketMedio = summary.salesCount > 0 ? summary.revenue / summary.salesCount : 0;
  const grossMargin = summary.revenue > 0 ? (summary.grossProfit / summary.revenue) * 100 : 0;

  // 2. Acompanhamento diario vs meta (ponto de equilibrio = custo fixo mensal / 30)
  const scopedStoreConfigs = stores.filter(store => inScope(store.unitId, activeUnitId));
  const totalFixedCost = scopedStoreConfigs.reduce((sum, store) => sum + store.fixedCost, 0);
  const dailyMetaBreakEven = Math.round(totalFixedCost / 30);
  const dailyWindow = chartWindow(range);
  const dailyRevenue = new Map<string, number>();
  allScopeSales.forEach(sale => {
    if (!isInRange(sale.timestamp, dailyWindow)) return;
    const key = toLocalDateKey(sale.timestamp);
    dailyRevenue.set(key, (dailyRevenue.get(key) || 0) + sale.grossAmount);
  });
  const dailyChartData = listDays(dailyWindow).map(key => ({
    date: formatDayLabel(key),
    faturamento: Math.round((dailyRevenue.get(key) || 0) * 100) / 100
  }));

  // 3. Faturamento por categoria (servicos entram como "Serviços")
  const categoryTotals = new Map<string, number>();
  scopeSales.forEach(sale => {
    (sale.items || []).forEach(item => {
      const value = item.lineTotal ?? item.unitPrice * item.quantity;
      let category = 'Sem categoria';
      if (item.itemType === 'SERVICE') {
        category = 'Serviços';
      } else if (item.productId) {
        category = products.find(product => product.id === item.productId)?.category || 'Sem categoria';
      }
      categoryTotals.set(category, (categoryTotals.get(category) || 0) + value);
    });
  });
  // Cor fixa por categoria (ordem alfabetica), para nao repintar quando o ranking muda.
  const categoryColorOrder = Array.from(categoryTotals.keys()).sort((a, b) => a.localeCompare(b));
  const rankedCategories = Array.from(categoryTotals.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const categoryChartData = rankedCategories.length > MAX_CATEGORY_SLICES
    ? [
        ...rankedCategories.slice(0, MAX_CATEGORY_SLICES - 1),
        { name: 'Outros', value: rankedCategories.slice(MAX_CATEGORY_SLICES - 1).reduce((sum, item) => sum + item.value, 0) }
      ]
    : rankedCategories;
  const categoryColor = (name: string) => name === 'Outros'
    ? '#94a3b8'
    : SERIES_COLORS[Math.max(0, categoryColorOrder.indexOf(name)) % SERIES_COLORS.length];
  const categoryTotal = categoryChartData.reduce((sum, item) => sum + item.value, 0);

  // 4. Comparativo entre lojas: valor acumulado por dia, uma linha por loja
  const showComparison = isAdmin && activeUnitId === CONSOLIDATED && stores.length > 0;
  const comparisonWindow = chartWindow(range);
  const comparisonDays = listDays(comparisonWindow);
  const comparisonData = (() => {
    const perStoreDaily = new Map<string, Map<string, number>>();
    stores.forEach(store => perStoreDaily.set(store.unitId, new Map()));
    const add = (unitId: string, key: string, value: number) => {
      const daily = perStoreDaily.get(unitId);
      if (daily) daily.set(key, (daily.get(key) || 0) + value);
    };
    completedSales(sales).forEach(sale => {
      if (!isInRange(sale.timestamp, comparisonWindow)) return;
      const key = toLocalDateKey(sale.timestamp);
      const cost = saleCost(sale).cost;
      if (comparisonMetric === 'revenue') add(sale.unitId, key, sale.grossAmount);
      if (comparisonMetric === 'grossProfit') add(sale.unitId, key, sale.grossAmount - cost);
      if (comparisonMetric === 'operatingProfit') add(sale.unitId, key, sale.grossAmount - cost - sale.feeAmount);
    });
    if (comparisonMetric === 'operatingProfit') {
      expenses.forEach(expense => {
        if (isInRange(expense.timestamp, comparisonWindow)) add(expense.unitId, toLocalDateKey(expense.timestamp), -expense.amount);
      });
    }
    const running = new Map<string, number>();
    return comparisonDays.map(key => {
      const row: Record<string, string | number> = { date: formatDayLabel(key) };
      stores.forEach(store => {
        const total = (running.get(store.unitId) || 0) + (perStoreDaily.get(store.unitId)?.get(key) || 0);
        running.set(store.unitId, total);
        row[store.unitId] = Math.round(total * 100) / 100;
      });
      return row;
    });
  })();

  // 5. Itens em alerta (por loja)
  const now = Date.now();
  const coverageStart = now - COVERAGE_WINDOW_DAYS * DAY_MS;
  const staleStart = now - STALE_PRODUCT_DAYS * DAY_MS;
  const stockAlerts: StockAlert[] = (() => {
    if (!alertStoreId) return [];
    const soldLast30 = new Map<string, number>();
    const lastSaleAt = new Map<string, number>();
    completedSales(sales).forEach(sale => {
      if (sale.unitId !== alertStoreId) return;
      const time = new Date(sale.timestamp).getTime();
      (sale.items || []).forEach(item => {
        if (item.itemType === 'SERVICE' || !item.productId) return;
        if (time >= coverageStart) soldLast30.set(item.productId, (soldLast30.get(item.productId) || 0) + item.quantity);
        if (time > (lastSaleAt.get(item.productId) || 0)) lastSaleAt.set(item.productId, time);
      });
    });

    const alerts: StockAlert[] = [];
    products.forEach(product => {
      const qty = inventory.find(inv => inv.productId === product.id)?.quantities[alertStoreId]?.qty || 0;
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
  })();
  const highRiskCount = stockAlerts.filter(alert => alert.risk === 'ALTO').length;

  // 6. Curva ABC (periodo e escopo atuais)
  const productPerformance = new Map<string, { product: Product; qty: number; revenue: number }>();
  products.forEach(product => productPerformance.set(product.id, { product, qty: 0, revenue: 0 }));
  scopeSales.forEach(sale => {
    (sale.items || []).forEach(item => {
      const entry = item.productId ? productPerformance.get(item.productId) : undefined;
      if (!entry) return;
      entry.qty += item.quantity;
      entry.revenue += item.lineTotal ?? item.unitPrice * item.quantity;
    });
  });
  const rankedProducts = Array.from(productPerformance.values())
    .filter(item => item.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
  const totalProductRevenue = rankedProducts.reduce((sum, item) => sum + item.revenue, 0);
  let cumulativeRevenue = 0;
  const abcProducts = rankedProducts.map(item => {
    cumulativeRevenue += item.revenue;
    const ratio = totalProductRevenue > 0 ? cumulativeRevenue / totalProductRevenue : 0;
    const classification: 'A' | 'B' | 'C' = ratio <= 0.7 ? 'A' : ratio <= 0.9 ? 'B' : 'C';
    return { ...item, classification };
  });
  const topProducts = abcProducts.slice(0, 5);

  // 7. Insights do periodo
  const maxExpense = [...scopeExpenses].sort((a, b) => b.amount - a.amount)[0];
  const insightMaiorGasto = maxExpense
    ? `${formatMoney(maxExpense.amount)} (${maxExpense.description})`
    : 'Nenhuma despesa lançada no período';
  const salesByWeek = new Map<string, number>();
  scopeSales.forEach(sale => {
    const week = monthWeekKey(sale.timestamp);
    salesByWeek.set(week, (salesByWeek.get(week) || 0) + sale.grossAmount);
  });
  const topWeek = Array.from(salesByWeek.entries()).sort((a, b) => b[1] - a[1])[0];
  const insightMaiorSemana = topWeek ? `${monthWeekLabel(topWeek[0])} com ${formatMoney(topWeek[1])}` : 'Nenhum faturamento no período';
  const insightCategoriaLider = rankedCategories[0]?.name || 'Nenhuma';

  const paymentStats = new Map<string, number>();
  scopeSales.forEach(sale => {
    if (!sale.payments?.length) {
      paymentStats.set(sale.paymentMethod, (paymentStats.get(sale.paymentMethod) || 0) + sale.grossAmount);
      return;
    }
    // Vendas do PDV com linhas: cada linha no seu metodo. A diferenca para o
    // total e o sinal de reserva (recebido antes, em outro registro).
    const linesTotal = sale.payments.reduce((sum, payment) => sum + payment.amount, 0);
    sale.payments.forEach(payment => {
      paymentStats.set(payment.paymentMethod, (paymentStats.get(payment.paymentMethod) || 0) + payment.amount);
    });
    const deposit = Math.round((sale.grossAmount - linesTotal) * 100) / 100;
    if (deposit > 0) paymentStats.set('SINAL DE RESERVA', (paymentStats.get('SINAL DE RESERVA') || 0) + deposit);
  });
  const dominantPayment = Array.from(paymentStats.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Nenhuma';

  // Previsao de cobertura: os 3 produtos mais vendidos nos ultimos 30 dias (escopo atual)
  const coverageSold = new Map<string, number>();
  allScopeSales.forEach(sale => {
    if (new Date(sale.timestamp).getTime() < coverageStart) return;
    (sale.items || []).forEach(item => {
      if (item.itemType === 'SERVICE' || !item.productId) return;
      coverageSold.set(item.productId, (coverageSold.get(item.productId) || 0) + item.quantity);
    });
  });
  const coverageRows = Array.from(coverageSold.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([productId, sold]) => {
      const product = products.find(item => item.id === productId);
      const quantities = inventory.find(inv => inv.productId === productId)?.quantities || {};
      const stock = activeUnitId === CONSOLIDATED
        ? stores.reduce((sum, store) => sum + (quantities[store.unitId]?.qty || 0), 0)
        : quantities[activeUnitId]?.qty || 0;
      const days = Math.floor(Math.max(0, stock) / (sold / COVERAGE_WINDOW_DAYS));
      return { productId, name: product?.name || productId, stock: Math.max(0, stock), days };
    });

  const periodControls = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-slate-500 font-sans">Período:</span>
      <select
        id="dashboard-period-filter"
        value={periodPreset}
        onChange={(e) => setPeriodPreset(e.target.value as PeriodPreset)}
        className="bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold border border-slate-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 transition"
      >
        {(Object.keys(PERIOD_LABELS) as PeriodPreset[]).map(preset => (
          <option key={preset} value={preset}>{PERIOD_LABELS[preset]}</option>
        ))}
      </select>
      {periodPreset === 'personalizado' && (
        <>
          <input
            type="date"
            aria-label="Data inicial"
            value={customFrom}
            max={customTo}
            onChange={(e) => e.target.value && setCustomFrom(e.target.value)}
            className="bg-slate-50 text-slate-800 text-xs font-semibold border border-slate-200 rounded-lg px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-xs text-slate-400">até</span>
          <input
            type="date"
            aria-label="Data final"
            value={customTo}
            min={customFrom}
            onChange={(e) => e.target.value && setCustomTo(e.target.value)}
            className="bg-slate-50 text-slate-800 text-xs font-semibold border border-slate-200 rounded-lg px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </>
      )}
    </div>
  );

  const categoryPanel = (fullWidth: boolean) => (
    <div className={`bg-white p-5 rounded-xl border border-slate-200 shadow-sm ${fullWidth ? 'lg:col-span-3' : ''}`}>
      <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider mb-2">Faturamento por Categoria</h4>
      <p className="text-xs text-slate-400 mb-4">Divisão do faturamento do período por categoria de produto.</p>
      {categoryChartData.length > 0 ? (
        <div className={fullWidth ? 'grid grid-cols-1 md:grid-cols-2 gap-6 items-center' : ''}>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryChartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={84}
                  paddingAngle={2}
                  stroke="#ffffff"
                  strokeWidth={2}
                  dataKey="value"
                  nameKey="name"
                >
                  {categoryChartData.map(entry => (
                    <Cell key={entry.name} fill={categoryColor(entry.name)} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => [formatMoney(Number(value)), 'Faturamento']} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="space-y-1.5 mt-2">
            {categoryChartData.map(item => (
              <li key={item.name} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: categoryColor(item.name) }} />
                  <span className="text-slate-600 truncate">{item.name}</span>
                </span>
                <span className="font-semibold text-slate-900 font-mono whitespace-nowrap">
                  {formatMoney(item.value)}
                  <span className="text-slate-400 font-normal ml-1">
                    {categoryTotal > 0 ? `${Math.round((item.value / categoryTotal) * 100)}%` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="text-slate-300 text-xs text-center py-16 font-sans">Sem faturamento no período</div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Cabecalho: escopo e periodo */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center bg-white p-4 rounded-lg border border-slate-200 shadow-xs gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 font-sans tracking-tight">Relatórios Gerais</h2>
          <p className="text-xs text-slate-500">
            {PERIOD_LABELS[periodPreset]} ({rangeLabel}) · {activeUnitId === CONSOLIDATED ? 'Todas as lojas' : storeName(activeUnitId)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {periodControls}
          {canChooseStore && (
            <div className="flex items-center space-x-2">
              <span className="text-xs font-semibold text-slate-500 font-sans">Visão:</span>
              <select
                id="dashboard-store-filter"
                value={selectedStoreFilter}
                onChange={(e) => setSelectedStoreFilter(e.target.value)}
                className="bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold border border-slate-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 transition"
              >
                <option value={CONSOLIDATED}>Consolidado (todas as lojas)</option>
                {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Relatorios Gerais: Financeiro | Produtos */}
      <div className="flex gap-1 border-b border-slate-200">
        {([['financeiro', 'Financeiro'], ['produtos', 'Produtos']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            className={`px-4 py-2 text-xs font-bold border-b-2 -mb-px ${section === id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {section === 'financeiro' && (
        <>
      {/* Cards principais */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Card 1: Faturamento Bruto */}
        <div id="stat-card-revenue" className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className="bg-blue-50 text-blue-600 border border-blue-100/80 p-3 rounded-lg shrink-0">
            <DollarSign className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-slate-400 font-sans uppercase font-bold tracking-wider">Faturamento Bruto</p>
            <h3 className="text-xl font-extrabold text-slate-900 font-sans tracking-tight">{formatMoney(summary.revenue)}</h3>
            <p className="text-[11px] text-slate-500 mt-0.5 flex items-center">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-500 mr-1" />
              {summary.salesCount} venda(s) no período
            </p>
          </div>
        </div>

        {/* Card 2: Lucro Bruto */}
        <div id="stat-card-gross-profit" className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className={`p-3 rounded-lg shrink-0 border ${
            summary.grossProfit >= 0
              ? 'bg-emerald-50 text-emerald-600 border-emerald-100/80'
              : 'bg-rose-50 text-rose-600 border-rose-100/80'
          }`}>
            <Package className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-slate-400 font-sans uppercase font-bold tracking-wider">Lucro Bruto</p>
            <h3 className={`text-xl font-extrabold font-sans tracking-tight ${summary.grossProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {formatMoney(summary.grossProfit)}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Custo mercadorias: {formatMoney(summary.cost)} · Margem {grossMargin.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
            </p>
            {summary.salesMissingCost > 0 && (
              <p className="text-[10px] text-amber-700 mt-0.5" title="Vendas anteriores ao custo por item ou lançamentos manuais do Financeiro: o custo delas não entra na conta.">
                {summary.salesMissingCost} venda(s) sem custo registrado
              </p>
            )}
          </div>
        </div>

        {/* Card 3: Lucro Real Operacional */}
        <div id="stat-card-profit" className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className={`p-3 rounded-lg shrink-0 border ${
            summary.operatingProfit >= 0
              ? 'bg-emerald-50 text-emerald-600 border-emerald-100/80'
              : 'bg-rose-50 text-rose-600 border-rose-100/80'
          }`}>
            <CheckCircle className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-slate-400 font-sans uppercase font-bold tracking-wider">Lucro Real Operacional</p>
            <h3 className={`text-xl font-extrabold font-sans tracking-tight ${summary.operatingProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {formatMoney(summary.operatingProfit)}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Taxas: {formatMoney(summary.fees)} · Despesas: {formatMoney(summary.expenses)}
            </p>
          </div>
        </div>

        {/* Card 4: Ticket Medio */}
        <div id="stat-card-ticket" className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className="bg-slate-50 text-slate-600 border border-slate-200/80 p-3 rounded-lg shrink-0">
            <ShoppingBag className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-slate-400 font-sans uppercase font-bold tracking-wider">Ticket Médio</p>
            <h3 className="text-xl font-extrabold text-slate-900 font-sans tracking-tight">{formatMoney(ticketMedio)}</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">Faturamento por venda</p>
          </div>
        </div>
      </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="mb-4">
            <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Acompanhamento Diário vs. Meta</h4>
            <p className="text-xs text-slate-400">
              Faturamento bruto por dia comparado à meta diária do ponto de equilíbrio (custo fixo ÷ 30).
              {listDays(range).length < MIN_CHART_DAYS && ' Períodos curtos mostram os últimos 7 dias.'}
            </p>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyChartData} margin={{ top: 16, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickLine={false} minTickGap={16} />
                <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} tickFormatter={compactMoney} width={72} />
                <Tooltip formatter={(value) => [formatMoney(Number(value)), 'Faturamento']} labelStyle={{ color: '#0f172a' }} />
                <Line type="linear" dataKey="faturamento" stroke={SERIES_COLORS[0]} strokeWidth={2} dot={dailyChartData.length <= 15 ? { r: 3 } : false} activeDot={{ r: 5, stroke: '#ffffff', strokeWidth: 2 }} name="Faturamento diário" />
                {dailyMetaBreakEven > 0 && (
                  <ReferenceLine
                    y={dailyMetaBreakEven}
                    stroke="#64748b"
                    strokeDasharray="4 4"
                    label={{ value: `Meta diária: ${formatMoney(dailyMetaBreakEven)}`, fill: '#475569', fontSize: 10, position: 'insideTopRight' }}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>


      {/* Linha 3: comparativo entre lojas + faturamento por categoria */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {showComparison && (
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-2">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
              <div>
                <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Comparativo entre Lojas</h4>
                <p className="text-xs text-slate-400">
                  {COMPARISON_LABELS[comparisonMetric]} acumulado por dia em cada loja
                  ({formatDayLabel(comparisonDays[0])} a {formatDayLabel(comparisonDays[comparisonDays.length - 1])}).
                </p>
              </div>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0" role="group" aria-label="Indicador do comparativo">
                {(Object.keys(COMPARISON_LABELS) as ComparisonMetric[]).map(metric => (
                  <button
                    key={metric}
                    type="button"
                    onClick={() => setComparisonMetric(metric)}
                    aria-pressed={comparisonMetric === metric}
                    className={`px-3 py-1.5 text-[11px] font-semibold transition ${
                      comparisonMetric === metric ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {COMPARISON_LABELS[metric]}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={comparisonData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickLine={false} minTickGap={16} />
                  <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} tickFormatter={compactMoney} width={72} />
                  <Tooltip
                    formatter={(value, name) => [formatMoney(Number(value)), storeName(String(name))]}
                    itemSorter={(item) => -Number(item.value)}
                    labelStyle={{ color: '#0f172a', fontWeight: 600 }}
                  />
                  <Legend iconType="plainline" formatter={(value) => <span className="text-xs text-slate-600">{storeName(String(value))}</span>} />
                  <ReferenceLine y={0} stroke="#cbd5e1" />
                  {stores.map(store => (
                    <Line
                      key={store.unitId}
                      type="linear"
                      dataKey={store.unitId}
                      name={store.unitId}
                      stroke={storeColor(store.unitId)}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 5, stroke: '#ffffff', strokeWidth: 2 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        {categoryPanel(!showComparison)}
      </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
          <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Insights & Previsão de Cobertura</h4>

          <div className="space-y-3 font-sans">
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/60 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Maior Gasto do Período</span>
              <span className="text-xs font-semibold text-slate-800">{insightMaiorGasto}</span>
            </div>
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/60 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Semana de Maior Venda</span>
              <span className="text-xs font-semibold text-slate-800">{insightMaiorSemana}</span>
            </div>
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/60 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Categoria Líder de Vendas</span>
              <span className="text-xs font-semibold text-slate-800">{insightCategoriaLider}</span>
            </div>
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/60 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Forma de Pagamento Dominante</span>
              <span className="text-xs font-semibold text-slate-800 flex items-center">
                <Coins className="w-3.5 h-3.5 text-slate-400 mr-1.5" />
                {dominantPayment}
              </span>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center">
              <Truck className="w-4 h-4 text-blue-500 mr-1.5" />
              Previsão de Cobertura do Estoque
            </h5>
            <p className="text-[11px] text-slate-400 mb-3">Os 3 produtos mais vendidos nos últimos 30 dias e quanto tempo o estoque atual dura nesse ritmo.</p>
            <div className="space-y-2">
              {coverageRows.map(row => (
                <div key={row.productId} className="flex justify-between items-center text-xs p-1 gap-2">
                  <span className="text-slate-600 font-medium truncate max-w-[200px]">{row.name}</span>
                  <span className={`font-mono font-bold ${
                    row.stock === 0 ? 'text-rose-600' : row.days < HIGH_RISK_DAYS ? 'text-rose-600' : row.days < MEDIUM_RISK_DAYS ? 'text-amber-700' : 'text-slate-700'
                  }`}>
                    {row.stock === 0 ? 'Esgotado' : `~${row.days} dia(s) (${row.stock} un)`}
                  </span>
                </div>
              ))}
              {coverageRows.length === 0 && (
                <p className="text-[11px] text-slate-400">Sem vendas de produtos nos últimos 30 dias.</p>
              )}
            </div>
          </div>
        </div>
        </>
      )}

      {section === 'produtos' && (
        <>
          <StockValuePanel products={products} inventory={inventory} productStoreCosts={productStoreCosts} stores={stores} activeUnitId={activeUnitId} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Itens em Alerta */}
        <div id="stat-card-stock" className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col">
          <div className="flex items-start justify-between gap-2 mb-1">
            <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Itens em Alerta</h4>
            {canChooseStore && stores.length > 0 && (
              <select
                id="dashboard-alert-store"
                aria-label="Loja dos alertas"
                value={alertStoreId}
                onChange={(e) => setAlertStoreId(e.target.value)}
                className="bg-slate-50 hover:bg-slate-100 text-slate-800 text-[11px] font-semibold border border-slate-200 rounded-lg px-2 py-1 outline-none focus:ring-1 focus:ring-blue-500 max-w-[150px]"
              >
                {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
              </select>
            )}
          </div>
          <p className="text-xs text-slate-400 mb-3">
            {stockAlerts.length} produto(s) em alerta{alertStoreId ? ` · ${storeName(alertStoreId)}` : ''}
          </p>

          <div className="flex-1 overflow-y-auto max-h-64 space-y-1.5 pr-1">
            {stockAlerts.map(alert => (
              <div key={alert.product.id} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-slate-100 bg-slate-50/60">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800 truncate">{alert.product.name}</p>
                  <p className="text-[10px] text-slate-500 font-mono">{alert.qty} un · {alert.reason}</p>
                </div>
                <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border ${
                  alert.risk === 'ALTO'
                    ? 'bg-rose-50 text-rose-700 border-rose-200'
                    : 'bg-amber-50 text-amber-800 border-amber-200'
                }`}>
                  <AlertTriangle className="w-3 h-3" />
                  {alert.risk === 'ALTO' ? 'Alto' : 'Médio'}
                </span>
              </div>
            ))}
          </div>

          <p className="text-[11px] mt-3 pt-3 border-t border-slate-100">
            {stockAlerts.length === 0 ? (
              <span className="text-emerald-600 font-semibold">Níveis de estoque normais</span>
            ) : highRiskCount > 0 ? (
              <span className="text-rose-600 font-semibold">{highRiskCount} item(ns) de alto risco: repor com urgência</span>
            ) : (
              <span className="text-amber-700 font-semibold">Acompanhe a reposição</span>
            )}
          </p>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider mb-2">Curva ABC de Produtos</h4>
          <p className="text-xs text-slate-400 mb-4">Contribuição de cada produto no faturamento do período.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left text-slate-500">
              <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold font-sans">
                <tr>
                  <th className="px-4 py-2.5">Produto</th>
                  <th className="px-4 py-2.5 text-center">Unidades</th>
                  <th className="px-4 py-2.5 text-right">Faturamento</th>
                  <th className="px-4 py-2.5 text-center">Classificação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-sans">
                {topProducts.map(item => (
                  <tr key={item.product.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-2.5 font-medium text-slate-900 truncate max-w-xs">{item.product.name}</td>
                    <td className="px-4 py-2.5 text-center font-semibold text-slate-700">{item.qty}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-slate-900">{formatMoney(item.revenue)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                        item.classification === 'A'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : item.classification === 'B'
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : 'bg-slate-50 text-slate-600 border-slate-200'
                      }`}>
                        Classe {item.classification}
                      </span>
                    </td>
                  </tr>
                ))}
                {topProducts.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-slate-400">Nenhum produto vendido no período.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

          </div>
          <StaleProductsPanel products={products} inventory={inventory} productStoreCosts={productStoreCosts} sales={sales} stores={stores} activeUnitId={activeUnitId} />
          <BalancosReportPanel products={products} inventory={inventory} storeConfigs={storeConfigs} productStoreCosts={productStoreCosts} activeUnitId={activeUnitId} />
        </>
      )}
    </div>
  );
}
