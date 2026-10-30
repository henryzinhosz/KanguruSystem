import { useMemo, useState } from 'react';
import { Product, ProductStoreCost, Sale, StockInventory, StoreConfig } from '../types';
import { CONSOLIDATED, completedSales, formatMoney } from '../db/finance';

// Relatorios Gerais › Produtos: estoque valorizado (quanto dinheiro esta em mercadoria)
// e produtos parados (com estoque e sem venda ha X dias).

interface ProductReportsProps {
  products: Product[];
  inventory: StockInventory[];
  productStoreCosts: ProductStoreCost[];
  sales: Sale[];
  stores: StoreConfig[];
  activeUnitId: string;
}

interface StockLine {
  product: Product;
  qty: number;
  cost: number;
  saleValue: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_OPTIONS = [30, 60, 90] as const;

// Quantidade e custo do produto no escopo (uma loja ou todas). Custo: media da loja;
// serializado: media das unidades em estoque x quantidade de unidades (= soma exata).
function stockLines(products: Product[], inventory: StockInventory[], costs: ProductStoreCost[], unitIds: string[]): StockLine[] {
  const lines: StockLine[] = [];
  for (const product of products) {
    const inv = inventory.find(item => item.productId === product.id);
    let qty = 0;
    let cost = 0;
    for (const unitId of unitIds) {
      const storeCost = costs.find(item => item.productId === product.id && item.unitId === unitId);
      const unitQty = product.isSerialized
        ? storeCost?.unitCount ?? inv?.quantities[unitId]?.qty ?? 0
        : inv?.quantities[unitId]?.qty ?? 0;
      if (unitQty <= 0) continue;
      qty += unitQty;
      cost += unitQty * (storeCost?.avgCost ?? Math.max(product.costPrice || 0, 0));
    }
    if (qty > 0) lines.push({ product, qty, cost, saleValue: qty * (product.sellPrice || 0) });
  }
  return lines;
}

export function StockValuePanel({ products, inventory, productStoreCosts, stores, activeUnitId }: Omit<ProductReportsProps, 'sales'>) {
  const unitIds = activeUnitId === CONSOLIDATED ? stores.map(store => store.unitId) : [activeUnitId];
  const lines = useMemo(() => stockLines(products, inventory, productStoreCosts, unitIds), [products, inventory, productStoreCosts, unitIds.join('|')]);
  const totals = lines.reduce((sum, line) => ({ qty: sum.qty + line.qty, cost: sum.cost + line.cost, sale: sum.sale + line.saleValue }), { qty: 0, cost: 0, sale: 0 });
  const byCategory = Array.from(lines.reduce((map, line) => {
    const current = map.get(line.product.category) || { qty: 0, cost: 0, sale: 0 };
    map.set(line.product.category, { qty: current.qty + line.qty, cost: current.cost + line.cost, sale: current.sale + line.saleValue });
    return map;
  }, new Map<string, { qty: number; cost: number; sale: number }>())).sort((left, right) => right[1].cost - left[1].cost);

  return (
    <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
      <div>
        <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Estoque valorizado</h4>
        <p className="text-xs text-slate-400">Quanto está investido no estoque de hoje, pelo custo médio de cada loja (itens com serial: custo de cada unidade).</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
          <span className="block text-[10px] font-bold uppercase text-slate-400">Investido (custo)</span>
          <span className="text-lg font-extrabold text-slate-900">{formatMoney(totals.cost)}</span>
          <span className="block text-[11px] text-slate-500">{totals.qty} unidade(s)</span>
        </div>
        <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
          <span className="block text-[10px] font-bold uppercase text-slate-400">Valor a preço de venda</span>
          <span className="text-lg font-extrabold text-slate-900">{formatMoney(totals.sale)}</span>
        </div>
        <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
          <span className="block text-[10px] font-bold uppercase text-slate-400">Lucro possível</span>
          <span className={`text-lg font-extrabold ${totals.sale - totals.cost >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{formatMoney(totals.sale - totals.cost)}</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left text-slate-500">
          <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
            <tr>
              <th className="px-4 py-2.5">Categoria</th>
              <th className="px-4 py-2.5 text-center">Unidades</th>
              <th className="px-4 py-2.5 text-right">Custo</th>
              <th className="px-4 py-2.5 text-right">Preço de venda</th>
              <th className="px-4 py-2.5 text-right">% do investido</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {byCategory.map(([category, value]) => (
              <tr key={category}>
                <td className="px-4 py-2.5 font-medium text-slate-900">{category}</td>
                <td className="px-4 py-2.5 text-center">{value.qty}</td>
                <td className="px-4 py-2.5 text-right font-bold text-slate-900">{formatMoney(value.cost)}</td>
                <td className="px-4 py-2.5 text-right">{formatMoney(value.sale)}</td>
                <td className="px-4 py-2.5 text-right">{totals.cost > 0 ? `${((value.cost / totals.cost) * 100).toFixed(1).replace('.', ',')}%` : '—'}</td>
              </tr>
            ))}
            {byCategory.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Sem produtos em estoque.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function StaleProductsPanel({ products, inventory, productStoreCosts, sales, stores, activeUnitId }: ProductReportsProps) {
  const [days, setDays] = useState<(typeof STALE_OPTIONS)[number]>(60);
  const unitIds = activeUnitId === CONSOLIDATED ? stores.map(store => store.unitId) : [activeUnitId];

  const rows = useMemo(() => {
    // Ultima venda de cada produto no escopo (vendas concluidas).
    const lastSale = new Map<string, number>();
    for (const sale of completedSales(sales)) {
      if (!unitIds.includes(sale.unitId)) continue;
      const time = new Date(sale.timestamp).getTime();
      for (const item of sale.items) {
        if (!item.productId) continue;
        if ((lastSale.get(item.productId) ?? 0) < time) lastSale.set(item.productId, time);
      }
    }
    const limit = Date.now() - days * DAY_MS;
    return stockLines(products, inventory, productStoreCosts, unitIds)
      .map(line => ({ ...line, last: lastSale.get(line.product.id) ?? null }))
      .filter(line => line.last === null || line.last < limit)
      .sort((left, right) => right.cost - left.cost);
  }, [products, inventory, productStoreCosts, sales, unitIds.join('|'), days]);

  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);

  return (
    <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Produtos parados</h4>
          <p className="text-xs text-slate-400">
            Com estoque e sem venda há mais de {days} dias: {rows.length} produto(s), {formatMoney(totalCost)} parados em mercadoria.
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0" role="group" aria-label="Dias sem venda">
          {STALE_OPTIONS.map(option => (
            <button
              key={option}
              type="button"
              onClick={() => setDays(option)}
              className={`px-3 py-1.5 text-xs font-semibold ${days === option ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {option} dias
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left text-slate-500">
          <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
            <tr>
              <th className="px-4 py-2.5">Produto</th>
              <th className="px-4 py-2.5">Categoria</th>
              <th className="px-4 py-2.5 text-center">Estoque</th>
              <th className="px-4 py-2.5 text-right">Custo parado</th>
              <th className="px-4 py-2.5 text-right">Última venda</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(row => (
              <tr key={row.product.id}>
                <td className="px-4 py-2.5 font-medium text-slate-900"><span className="font-mono text-slate-400 mr-1.5">{row.product.sku}</span>{row.product.name}</td>
                <td className="px-4 py-2.5">{row.product.category}</td>
                <td className="px-4 py-2.5 text-center font-semibold text-slate-700">{row.qty}</td>
                <td className="px-4 py-2.5 text-right font-bold text-slate-900">{formatMoney(row.cost)}</td>
                <td className="px-4 py-2.5 text-right">{row.last ? new Date(row.last).toLocaleDateString('pt-BR') : 'Nunca vendido'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Nenhum produto parado. Bom sinal!</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
