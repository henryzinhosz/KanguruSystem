/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { 
  User, 
  UserRole, 
  Product, 
  StockInventory, 
  Sale, 
  Expense, 
  StoreConfig 
} from '../types';
import { 
  TrendingUp, 
  DollarSign, 
  FileText, 
  ShieldAlert, 
  AlertTriangle, 
  PieChart as PieIcon, 
  ShoppingBag, 
  CheckCircle,
  Truck
} from 'lucide-react';
import {
  BarChart,
  Bar,
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

interface DashboardProps {
  currentUser: User;
  products: Product[];
  inventory: StockInventory[];
  sales: Sale[];
  expenses: Expense[];
  storeConfigs: StoreConfig[];
}

export default function DashboardView({ 
  currentUser, 
  products, 
  inventory, 
  sales, 
  expenses, 
  storeConfigs 
}: DashboardProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  
  // Filter state for Admin (Consolidated or specific store)
  const [selectedStoreFilter, setSelectedStoreFilter] = useState<string>('consolidado');

  const activeUnitId = currentUser.unitId === 'central' ? selectedStoreFilter : currentUser.unitId;

  // 1. Filter Sales and Expenses for active scope
  const filteredSales = sales.filter(s => 
    s.status === 'CONCLUIDA' && 
    (activeUnitId === 'consolidado' || s.unitId === activeUnitId)
  );

  const filteredExpenses = expenses.filter(e => 
    activeUnitId === 'consolidado' || e.unitId === activeUnitId
  );

  // 2. Calculations
  const grossRevenue = filteredSales.reduce((acc, s) => acc + s.grossAmount, 0);
  const totalFees = filteredSales.reduce((acc, s) => acc + s.feeAmount, 0);
  const totalExpenses = filteredExpenses.reduce((acc, e) => acc + e.amount, 0);
  
  // Real Operational Profit = Gross - Payment Fees - Outgoing Expenses
  const realProfit = grossRevenue - totalFees - totalExpenses;
  const numSales = filteredSales.length;
  const ticketMedio = numSales > 0 ? grossRevenue / numSales : 0;

  // 3. Break-Even point and Daily Meta
  // Calculate total monthly fixed costs in scope
  const scopedConfigs = storeConfigs.filter(c => 
    activeUnitId === 'consolidado' || c.unitId === activeUnitId
  );
  const totalFixedCost = scopedConfigs.reduce((acc, c) => acc + c.fixedCost, 0);
  const dailyMetaBreakEven = totalFixedCost / 30;

  // 4. Group sales by date for daily tracking graph
  const salesByDate: { [date: string]: { date: string; faturamento: number; meta: number } } = {};
  
  // Initialize last 7 days with 0 to ensure nice charts
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    salesByDate[dateStr] = { 
      date: dateStr.split('-').slice(1).reverse().join('/'), // DD/MM format
      faturamento: 0, 
      meta: Math.round(dailyMetaBreakEven) 
    };
  }

  filteredSales.forEach(s => {
    const dateStr = s.timestamp.split('T')[0];
    const key = dateStr.split('-').slice(1).reverse().join('/');
    // Map to last 7 days keys if present
    const existingKey = Object.keys(salesByDate).find(k => salesByDate[k].date === key);
    if (existingKey) {
      salesByDate[existingKey].faturamento += s.grossAmount;
    } else {
      // Out of bounds but let's register just in case
      salesByDate[dateStr] = { 
        date: key, 
        faturamento: s.grossAmount, 
        meta: Math.round(dailyMetaBreakEven) 
      };
    }
  });

  const dailyChartData = Object.values(salesByDate).sort((a, b) => {
    const aParts = a.date.split('/');
    const bParts = b.date.split('/');
    return new Date(2026, parseInt(aParts[1]) - 1, parseInt(aParts[0])).getTime() - 
           new Date(2026, parseInt(bParts[1]) - 1, parseInt(bParts[0])).getTime();
  });

  // 5. Product Performance (ABC Curve & Ranking)
  const productPerformance: { [id: string]: { product: Product; qty: number; revenue: number } } = {};
  
  products.forEach(p => {
    productPerformance[p.id] = { product: p, qty: 0, revenue: 0 };
  });

  filteredSales.forEach(s => {
    s.items.forEach(item => {
      if (productPerformance[item.productId]) {
        productPerformance[item.productId].qty += item.quantity;
        productPerformance[item.productId].revenue += item.unitPrice * item.quantity;
      }
    });
  });

  const rankedProducts = Object.values(productPerformance).sort((a, b) => b.revenue - a.revenue);

  // ABC classification
  let cumulativeRevenue = 0;
  const totalRevenueAllProducts = rankedProducts.reduce((acc, p) => acc + p.revenue, 0);
  
  const abcProducts = rankedProducts.map(item => {
    cumulativeRevenue += item.revenue;
    const ratio = totalRevenueAllProducts > 0 ? (cumulativeRevenue / totalRevenueAllProducts) : 0;
    
    let classification: 'A' | 'B' | 'C' = 'C';
    if (ratio <= 0.70) classification = 'A';
    else if (ratio <= 0.90) classification = 'B';

    return {
      ...item,
      classification,
      percentage: totalRevenueAllProducts > 0 ? (item.revenue / totalRevenueAllProducts) * 100 : 0
    };
  });

  const topProducts = [...abcProducts].slice(0, 5);
  const bottomProducts = [...abcProducts].filter(p => p.qty >= 0).reverse().slice(0, 5);

  // 6. Category Breakdown
  const categorySales: { [cat: string]: number } = {};
  filteredSales.forEach(s => {
    s.items.forEach(item => {
      const prod = products.find(p => p.id === item.productId);
      if (prod) {
        categorySales[prod.category] = (categorySales[prod.category] || 0) + (item.unitPrice * item.quantity);
      }
    });
  });

  const pieColors = ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#6366f1'];
  const categoryChartData = Object.entries(categorySales).map(([name, value]) => ({ name, value }));

  // 7. Payment method dominant
  const paymentStats: { [method: string]: number } = {};
  filteredSales.forEach(s => {
    paymentStats[s.paymentMethod] = (paymentStats[s.paymentMethod] || 0) + s.grossAmount;
  });
  const dominantPayment = Object.entries(paymentStats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Nenhuma';

  // 8. Multi-store comparison (Admin only)
  const storeComparisonData = storeConfigs.map(cfg => {
    const storeSales = sales.filter(s => s.status === 'CONCLUIDA' && s.unitId === cfg.unitId);
    const storeExpenses = expenses.filter(e => e.unitId === cfg.unitId);
    const storeRev = storeSales.reduce((acc, s) => acc + s.grossAmount, 0);
    const storeFees = storeSales.reduce((acc, s) => acc + s.feeAmount, 0);
    const storeExp = storeExpenses.reduce((acc, e) => acc + e.amount, 0);
    const storeProfit = storeRev - storeFees - storeExp;

    return {
      name: cfg.tradeName || cfg.unitId,
      Faturamento: storeRev,
      Despesas: storeExp,
      Lucro: storeProfit,
      MetaEquilibrio: cfg.fixedCost
    };
  });

  // 9. Stock status & low stock alert counting
  let lowStockCount = 0;
  inventory.forEach(inv => {
    const scopeQty = activeUnitId === 'consolidado' 
      ? Object.values(inv.quantities).reduce((acc, q) => acc + q.qty, 0)
      : (inv.quantities[activeUnitId]?.qty || 0);

    if (scopeQty <= 2) {
      lowStockCount++;
    }
  });

  // 10. Automated dynamic insights
  const maxExpense = filteredExpenses.sort((a, b) => b.amount - a.amount)[0];
  const insightMaioGasto = maxExpense 
    ? `R$ ${maxExpense.amount.toLocaleString('pt-BR')} (${maxExpense.description})`
    : 'Nenhuma despesa lançada';

  // Week of highest sale (ISO week calculation-ish)
  const salesByWeek: { [week: string]: number } = {};
  filteredSales.forEach(s => {
    const d = new Date(s.timestamp);
    const oneJan = new Date(d.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((d.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    const week = Math.ceil((d.getDay() + 1 + numberOfDays) / 7);
    salesByWeek[`Semana ${week}`] = (salesByWeek[`Semana ${week}`] || 0) + s.grossAmount;
  });
  const topWeek = Object.entries(salesByWeek).sort((a, b) => b[1] - a[1])[0];
  const insightMaiorSemana = topWeek 
    ? `${topWeek[0]} com R$ ${topWeek[1].toLocaleString('pt-BR')}`
    : 'Nenhum faturamento registrado';

  const insightCategoriaMaisVendida = categoryChartData.sort((a, b) => b.value - a.value)[0]?.name || 'Nenhuma';

  return (
    <div className="space-y-6">
      {/* Scope Selector (Only for Admin Master) */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-4 rounded-lg border border-slate-200 shadow-xs gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 font-sans tracking-tight">Painel de Indicadores</h2>
          <p className="text-xs text-slate-500">Acompanhamento do estoque, faturamento e saúde financeira em tempo real.</p>
        </div>
        {isAdmin && (
          <div className="flex items-center space-x-2">
            <span className="text-xs font-semibold text-slate-500 font-sans">Visão:</span>
            <select
              id="dashboard-store-filter"
              value={selectedStoreFilter}
              onChange={(e) => setSelectedStoreFilter(e.target.value)}
              className="bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold border border-slate-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 transition"
            >
              <option value="consolidado">📊 Consolidado (Toda a Rede)</option>
              {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Main Stats Bento Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Card 1: Faturamento */}
        <div id="stat-card-revenue" className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className="bg-blue-50 text-blue-600 border border-blue-100/80 p-3 rounded-lg shrink-0">
            <DollarSign className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] text-slate-400 font-sans uppercase font-bold tracking-wider">Faturamento Bruto</p>
            <h3 className="text-xl font-extrabold text-slate-900 font-sans tracking-tight">
              R$ {grossRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5 flex items-center">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-500 mr-1" />
              {numSales} vendas realizadas
            </p>
          </div>
        </div>

        {/* Card 2: Lucro Real */}
        <div id="stat-card-profit" className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className={`p-3 rounded-lg shrink-0 border ${
            realProfit >= 0 
              ? 'bg-emerald-50 text-emerald-600 border-emerald-100/80' 
              : 'bg-rose-50 text-rose-600 border-rose-100/80'
          }`}>
            <CheckCircle className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] text-slate-400 font-sans uppercase font-bold tracking-wider">Lucro Real Operacional</p>
            <h3 className={`text-xl font-extrabold font-sans tracking-tight ${realProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              R$ {realProfit.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Tarifas/Taxas: R$ {totalFees.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}
            </p>
          </div>
        </div>

        {/* Card 3: Ticket Medio */}
        <div id="stat-card-ticket" className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className="bg-slate-50 text-slate-600 border border-slate-200/80 p-3 rounded-lg shrink-0">
            <ShoppingBag className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] text-slate-400 font-sans uppercase font-bold tracking-wider">Ticket Médio</p>
            <h3 className="text-xl font-extrabold text-slate-900 font-sans tracking-tight">
              R$ {ticketMedio.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">Faturamento por cupom</p>
          </div>
        </div>

        {/* Card 4: Alertas de Estoque Baixo */}
        <div id="stat-card-stock" className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className={`p-3 rounded-lg shrink-0 border ${
            lowStockCount > 0 
              ? 'bg-rose-50 text-rose-600 border-rose-100/80' 
              : 'bg-slate-50 text-slate-600 border border-slate-200/80'
          }`}>
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] text-slate-400 font-sans uppercase font-bold tracking-wider">Itens em Alerta</p>
            <h3 className="text-xl font-extrabold text-slate-900 font-sans tracking-tight">
              {lowStockCount} produtos
            </h3>
            <p className="text-[11px] mt-0.5">
              {lowStockCount > 0 ? (
                <span className="text-rose-600 font-semibold">Repor com urgência</span>
              ) : (
                <span className="text-emerald-600 font-semibold">Níveis de estoque normais</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Line Chart: Daily Sales vs Break-even limit */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-2">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Acompanhamento Diário vs. Meta</h4>
              <p className="text-xs text-slate-400">Linha de faturamento bruto nos últimos 7 dias comparado à meta do Ponto de Equilíbrio diário.</p>
            </div>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyChartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickLine={false} />
                <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `R$${v}`} />
                <Tooltip formatter={(value) => [`R$ ${value}`, 'Faturamento']} labelStyle={{ color: '#0f172a' }} />
                <Legend iconType="circle" />
                <Line type="monotone" dataKey="faturamento" stroke="#3b82f6" strokeWidth={3} name="Faturamento Diário" activeDot={{ r: 8 }} />
                {/* Horizontal meta lines */}
                <ReferenceLine y={Math.round(dailyMetaBreakEven)} stroke="#ef4444" strokeDasharray="4 4" label={{ value: `Meta Ponto de Equilíbrio: R$ ${Math.round(dailyMetaBreakEven)}`, fill: '#ef4444', fontSize: 10, position: 'top' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Pie Chart: Categories distribution */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider mb-2">Faturamento por Categoria</h4>
          <p className="text-xs text-slate-400 mb-4">Divisão proporcional do faturamento acumulado por nichos de mercado.</p>
          <div className="h-56 w-full flex items-center justify-center">
            {categoryChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={categoryChartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {categoryChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={pieColors[index % pieColors.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => [`R$ ${Number(value).toLocaleString('pt-BR')}`, 'Total']} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-slate-300 text-xs text-center py-10 font-sans">Sem faturamento para exibir</div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {categoryChartData.map((item, idx) => (
              <div key={item.name} className="flex items-center space-x-2 text-xs">
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: pieColors[idx % pieColors.length] }} />
                <span className="text-slate-600 truncate">{item.name}:</span>
                <span className="font-bold text-slate-900">R$ {Math.round(item.value / 1000)}k</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Store Performance Comparisons (Admin only) */}
      {isAdmin && activeUnitId === 'consolidado' && (
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="mb-4">
            <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Comparativo entre Lojas</h4>
            <p className="text-xs text-slate-400">Desempenho financeiro lado a lado das 3 lojas físicas de varejo.</p>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={storeComparisonData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} tickLine={false} />
                <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `R$${v}`} />
                <Tooltip formatter={(v) => `R$ ${v}`} />
                <Legend iconType="circle" />
                <Bar dataKey="Faturamento" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Faturamento Bruto" />
                <Bar dataKey="Despesas" fill="#ef4444" radius={[4, 4, 0, 0]} name="Despesas" />
                <Bar dataKey="Lucro" fill="#10b981" radius={[4, 4, 0, 0]} name="Lucro Real" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ABC Curve Analysis & Stock Intelligence */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Curva ABC Table */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider mb-2">Curva ABC de Produtos</h4>
          <p className="text-xs text-slate-400 mb-4">Análise da contribuição de cada produto no faturamento total das lojas.</p>
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
                {topProducts.map((item, idx) => (
                  <tr key={item.product.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-2.5 font-medium text-slate-900 truncate max-w-xs">
                      {item.product.name}
                    </td>
                    <td className="px-4 py-2.5 text-center font-semibold text-slate-700">
                      {item.qty}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold text-slate-900">
                      R$ {item.revenue.toLocaleString('pt-BR')}
                    </td>
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
              </tbody>
            </table>
          </div>
        </div>

        {/* Intelligence Insights & Coverage Days */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
          <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Insights & Previsão de Cobertura</h4>
          
          <div className="space-y-3 font-sans">
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/60 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Maior Gasto do Período</span>
              <span className="text-xs font-semibold text-slate-800">{insightMaioGasto}</span>
            </div>

            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/60 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Semana de Maior Venda</span>
              <span className="text-xs font-semibold text-slate-800">{insightMaiorSemana}</span>
            </div>

            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/60 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Categoria Líder de Vendas</span>
              <span className="text-xs font-semibold text-slate-800">{insightCategoriaMaisVendida}</span>
            </div>

            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200/60 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Forma de Pagamento Dominante</span>
              <span className="text-xs font-semibold text-slate-800 flex items-center">
                {dominantPayment} 
                <span className="ml-2 font-sans text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded font-bold uppercase">
                  Líder de Caixa
                </span>
              </span>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center">
              <Truck className="w-4 h-4 text-blue-500 mr-1.5" />
              Previsão de Cobertura do Estoque Ativo
            </h5>
            <p className="text-[11px] text-slate-400 mb-3">Estimativa de duração do estoque atual baseada nas vendas dos últimos 30 dias.</p>
            <div className="space-y-2">
              {products.slice(0, 3).map(p => {
                const totalStock = activeUnitId === 'consolidado'
                  ? Object.values(inventory.find(i => i.productId === p.id)?.quantities || {}).reduce((acc, q) => acc + q.qty, 0)
                  : (inventory.find(i => i.productId === p.id)?.quantities[activeUnitId]?.qty || 0);

                // Check sales of this product in last 30 days
                const productSales = filteredSales.reduce((acc, s) => {
                  const items = s.items.filter(item => item.productId === p.id);
                  return acc + items.reduce((sub, i) => sub + i.quantity, 0);
                }, 0);

                const dailyRate = productSales / 30;
                let daysCoverageStr = 'Sem Vendas (90+ dias)';
                if (dailyRate > 0) {
                  const coverageDays = Math.round(totalStock / dailyRate);
                  daysCoverageStr = `${coverageDays} dias (${totalStock} un em estoque)`;
                } else if (totalStock === 0) {
                  daysCoverageStr = 'Estoque esgotado (0 dias)';
                }

                return (
                  <div key={p.id} className="flex justify-between items-center text-xs p-1">
                    <span className="text-slate-600 font-medium truncate max-w-[200px]">{p.name}</span>
                    <span className={`font-mono font-bold ${
                      totalStock === 0 
                        ? 'text-rose-600' 
                        : totalStock <= 2 
                          ? 'text-amber-600' 
                          : 'text-blue-600'
                    }`}>
                      {daysCoverageStr}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
