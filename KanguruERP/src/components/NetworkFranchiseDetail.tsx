import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlertTriangle, ArrowLeft, Banknote, Boxes, Building2, CalendarDays, ClipboardList, CreditCard, DollarSign, MonitorSmartphone,
  Package, Percent, ReceiptText, RefreshCw, RotateCcw, ShoppingCart, TrendingUp, UserRound, Users, Wallet, Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PERIOD_LABELS, PeriodPreset, formatMoney, resolvePeriod, toLocalDateKey } from '../db/finance';
import {
  getFranchiseCustomers, getFranchiseFinancial, getFranchiseOperations, getFranchiseProducts, getFranchiseServices,
  getFranchiseStock, getFranchiseTeam, getNetworkStoreMetrics,
  type FranchiseCustomers, type FranchiseFinancial, type FranchiseOperations, type FranchiseProductRow,
  type FranchiseSellerRow, type FranchiseServices, type FranchiseStock, type NetworkFranchise, type NetworkStoreMetrics,
} from '../db/network';
import { Dropdown, PERIOD_ORDER } from './NetworkFilters';

// Ficha completa de uma franquia no Painel da Rede (etapa 2). So leitura.

type Section = 'financeiro' | 'produtos' | 'estoque' | 'equipe' | 'servicos' | 'operacao' | 'clientes';

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'financeiro', label: 'Financeiro', icon: DollarSign },
  { id: 'produtos', label: 'Produtos', icon: Package },
  { id: 'estoque', label: 'Estoque', icon: Boxes },
  { id: 'equipe', label: 'Equipe', icon: Users },
  { id: 'servicos', label: 'Serviços / OS', icon: Wrench },
  { id: 'operacao', label: 'Operação', icon: MonitorSmartphone },
  { id: 'clientes', label: 'Clientes', icon: UserRound },
];

const PAYMENT_LABELS: Record<string, string> = {
  DINHEIRO: 'Dinheiro', PIX: 'Pix', CREDITO: 'Crédito', DEBITO: 'Débito', VOUCHER: 'Vale-troca', CREDIARIO: 'Crediário',
  DIVIDIDO: 'Dividido', TROCA: 'Troca', VALE: 'Vale-troca', 'SINAL DE RESERVA': 'Sinal de reserva',
};
const OS_LABELS: Record<string, string> = { EM_ANALISE: 'Em análise', AGUARDANDO_PECA: 'Aguardando peça', PRONTO: 'Pronto' };

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Erro ao carregar os dados.';
const pct = (part: number, total: number) => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : '—');
const dateTime = (value: string | null) => (value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const dateOnly = (value: string | null) => (value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('pt-BR') : '—');

export default function NetworkFranchiseDetail({ franchise, onBack }: { franchise: NetworkFranchise; onBack: () => void }) {
  const [section, setSection] = useState<Section>('financeiro');
  const [preset, setPreset] = useState<PeriodPreset>('mes');
  const [customFrom, setCustomFrom] = useState(() => toLocalDateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [customTo, setCustomTo] = useState(() => toLocalDateKey(new Date()));
  const [unitId, setUnitId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const range = useMemo(() => resolvePeriod(preset, customFrom, customTo), [preset, customFrom, customTo]);
  const storeName = (id: string) => franchise.stores.find(store => store.unitId === id)?.tradeName || id;
  const filters = { tenantId: franchise.tenantId, unitId: unitId || null, from: range.start, to: range.end, reloadKey, storeName };

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onBack} className="mt-1 p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50" title="Voltar às franquias" aria-label="Voltar"><ArrowLeft className="w-4 h-4" /></button>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-blue-700 flex items-center gap-1"><Building2 className="w-3.5 h-3.5" />Ficha da franquia</p>
            <h3 className="text-lg font-bold text-slate-900">{franchise.tradeName || franchise.legalName}</h3>
            <p className="text-slate-500">{franchise.legalName} · CNPJ {franchise.cnpj} · Franqueado: {franchise.ownerName || 'não informado'}{franchise.ownerPhone ? ` · ${franchise.ownerPhone}` : ''}</p>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-3 flex flex-wrap items-center gap-2">
        {section !== 'estoque' && (
          <>
            <Dropdown
              label="Período"
              value={preset === 'personalizado' ? '' : preset}
              placeholder="Personalizado"
              options={PERIOD_ORDER.map(key => ({ value: key, label: PERIOD_LABELS[key] }))}
              onChange={value => setPreset(value as PeriodPreset)}
            />
            <button type="button" onClick={() => setPreset('personalizado')} className={`h-10 px-4 rounded-lg border font-bold inline-flex items-center gap-1.5 ${preset === 'personalizado' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}>
              <CalendarDays className="w-4 h-4" />Personalizado
            </button>
            {preset === 'personalizado' && (
              <>
                <input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} className="h-10 border border-slate-200 rounded-lg px-2" aria-label="De" />
                <input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} className="h-10 border border-slate-200 rounded-lg px-2" aria-label="Até" />
              </>
            )}
          </>
        )}
        <Dropdown
          label="Loja"
          value={unitId}
          options={[{ value: '', label: 'Todas as lojas' }, ...franchise.stores.map(store => ({ value: store.unitId, label: store.tradeName || store.unitId }))]}
          onChange={setUnitId}
        />
        <button type="button" onClick={() => setReloadKey(key => key + 1)} className="ml-auto p-2 text-slate-500 hover:text-slate-800" title="Atualizar" aria-label="Atualizar"><RefreshCw className="w-4 h-4" /></button>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {SECTIONS.map(item => (
          <button key={item.id} type="button" onClick={() => setSection(item.id)} className={`px-3 py-2 font-bold border-b-2 -mb-px inline-flex items-center gap-1.5 ${section === item.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            <item.icon className="w-4 h-4" />{item.label}
          </button>
        ))}
      </div>

      {section === 'financeiro' && <FinancialSection {...filters} />}
      {section === 'produtos' && <ProductsSection {...filters} />}
      {section === 'estoque' && <StockSection {...filters} />}
      {section === 'equipe' && <TeamSection {...filters} />}
      {section === 'servicos' && <ServicesSection {...filters} />}
      {section === 'operacao' && <OperationsSection {...filters} />}
      {section === 'clientes' && <CustomersSection {...filters} />}
    </div>
  );
}

interface SectionProps {
  tenantId: string;
  unitId: string | null;
  from: Date;
  to: Date;
  reloadKey: number;
  storeName: (unitId: string) => string;
}

// Carrega os dados da aba quando os filtros mudam.
function useSectionData<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    load()
      .then(result => active && setData(result))
      .catch(loadError => active && setError(errorText(loadError)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, deps);
  return { data, error, loading };
}

function State({ loading, error, empty }: { loading: boolean; error: string; empty?: boolean }) {
  if (error) return <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">Não foi possível carregar: {error}</p>;
  if (loading) return <p className="text-slate-400">Carregando...</p>;
  if (empty) return <p className="text-slate-400 bg-white border border-slate-200 rounded-xl p-6 text-center">Nada para mostrar neste período.</p>;
  return null;
}

function StatCard({ label, value, icon: Icon, tone, hint, negative }: { label: string; value: string; icon: LucideIcon; tone: string; hint?: string; negative?: boolean }) {
  return (
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center gap-3" title={hint}>
      <div className={`p-2.5 rounded-lg shrink-0 border ${negative ? 'bg-rose-50 text-rose-600 border-rose-100/80' : tone}`}><Icon className="w-5 h-5" /></div>
      <div className="min-w-0">
        <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">{label}</span>
        <span className={`text-lg font-extrabold tracking-tight block truncate ${negative ? 'text-rose-600' : 'text-slate-900'}`}>{value}</span>
      </div>
    </div>
  );
}

function Panel({ title, subtitle, children, action }: { title: string; subtitle?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-bold text-slate-900">{title}</h4>
          {subtitle && <p className="text-slate-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function ShareBar({ value, total, tone = 'bg-blue-600' }: { value: number; total: number; tone?: string }) {
  const width = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return <div className="h-1.5 w-20 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${tone}`} style={{ width: `${width}%` }} /></div>;
}

const TH = 'p-2 text-[10px] uppercase text-slate-500 font-bold text-left bg-slate-50';
const TD = 'p-2 border-t border-slate-100';

// ---------------- Financeiro ----------------

function FinancialSection({ tenantId, unitId, from, to, reloadKey }: SectionProps) {
  const { data, error, loading } = useSectionData(async () => {
    const [metrics, financial] = await Promise.all([getNetworkStoreMetrics(from, to), getFranchiseFinancial(tenantId, unitId, from, to)]);
    return { metrics: metrics.filter(row => row.tenantId === tenantId && (!unitId || row.unitId === unitId)), financial };
  }, [tenantId, unitId, from.getTime(), to.getTime(), reloadKey]);
  if (!data) return <State loading={loading} error={error} />;
  const rows: NetworkStoreMetrics[] = data.metrics;
  const financial: FranchiseFinancial = data.financial;
  const sum = (pick: (row: NetworkStoreMetrics) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const revenue = sum(row => row.gross - row.returned);
  const cost = sum(row => row.cost);
  const fees = sum(row => row.fees);
  const expenses = sum(row => row.expenses);
  const salesCount = sum(row => row.salesCount);
  const grossProfit = revenue - cost;
  const operating = grossProfit - fees - expenses;
  const paymentsTotal = financial.payments.reduce((total, row) => total + row.amount, 0);
  const expensesTotal = financial.expenses.reduce((total, row) => total + row.amount, 0);
  const daily = financial.daily.map(row => ({ ...row, label: `${row.day.slice(8, 10)}/${row.day.slice(5, 7)}` }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Faturamento" value={formatMoney(revenue)} icon={DollarSign} tone="bg-blue-50 text-blue-600 border-blue-100/80" hint="Vendas concluídas menos devoluções" />
        <StatCard label="Custo das mercadorias" value={formatMoney(cost)} icon={Package} tone="bg-slate-100 text-slate-600 border-slate-200" />
        <StatCard label="Lucro bruto" value={formatMoney(grossProfit)} icon={TrendingUp} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" negative={grossProfit < 0} />
        <StatCard label="Margem bruta" value={pct(grossProfit, revenue)} icon={Percent} tone="bg-slate-100 text-slate-600 border-slate-200" />
        <StatCard label="Taxas de cartão" value={formatMoney(fees)} icon={CreditCard} tone="bg-amber-50 text-amber-600 border-amber-100/80" />
        <StatCard label="Despesas lançadas" value={formatMoney(expenses)} icon={Banknote} tone="bg-orange-50 text-orange-600 border-orange-100/80" />
        <StatCard label="Lucro real" value={formatMoney(operating)} icon={Wallet} tone="bg-violet-50 text-violet-600 border-violet-100/80" negative={operating < 0} hint="Lucro bruto menos taxas e despesas" />
        <StatCard label="Ticket médio" value={formatMoney(salesCount > 0 ? revenue / salesCount : 0)} icon={ReceiptText} tone="bg-sky-50 text-sky-600 border-sky-100/80" />
      </div>

      <Panel title="Faturamento por dia" subtitle={`${salesCount} venda(s) no período`}>
        {daily.length === 0 ? <p className="p-6 text-center text-slate-400">Sem vendas no período.</p> : (
          <div className="h-56 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis tickLine={false} axisLine={false} width={70} tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={value => formatMoney(Number(value)).replace(',00', '')} />
                <Tooltip cursor={{ fill: 'rgba(37, 99, 235, 0.06)' }} formatter={(value, _name, item) => [`${formatMoney(Number(value))} · ${item.payload.salesCount} venda(s)`, 'Faturamento']} />
                <Bar dataKey="revenue" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="Formas de pagamento" subtitle="Valor recebido por forma (com juros do cartão quando repassados)">
          <table className="w-full">
            <thead><tr><th className={TH}>Forma</th><th className={`${TH} text-right`}>Valor</th><th className={`${TH} text-right`}>Participação</th></tr></thead>
            <tbody>
              {financial.payments.map(row => (
                <tr key={row.method}><td className={`${TD} font-bold`}>{PAYMENT_LABELS[row.method] || row.method}</td><td className={`${TD} text-right font-mono`}>{formatMoney(row.amount)}</td>
                  <td className={TD}><div className="flex items-center justify-end gap-2"><ShareBar value={row.amount} total={paymentsTotal} /><span className="w-12 text-right font-mono">{pct(row.amount, paymentsTotal)}</span></div></td></tr>
              ))}
              {financial.payments.length === 0 && <tr><td colSpan={3} className={`${TD} text-center text-slate-400`}>Sem pagamentos no período.</td></tr>}
            </tbody>
          </table>
        </Panel>
        <Panel title="Despesas por categoria" subtitle={`Total ${formatMoney(expensesTotal)}`}>
          <table className="w-full">
            <thead><tr><th className={TH}>Categoria</th><th className={`${TH} text-right`}>Lançamentos</th><th className={`${TH} text-right`}>Valor</th><th className={`${TH} text-right`}>%</th></tr></thead>
            <tbody>
              {financial.expenses.map(row => (
                <tr key={row.category}><td className={`${TD} font-bold`}>{row.category}</td><td className={`${TD} text-right`}>{row.count}</td><td className={`${TD} text-right font-mono`}>{formatMoney(row.amount)}</td>
                  <td className={TD}><div className="flex items-center justify-end gap-2"><ShareBar value={row.amount} total={expensesTotal} tone="bg-orange-500" /><span className="w-12 text-right font-mono">{pct(row.amount, expensesTotal)}</span></div></td></tr>
              ))}
              {financial.expenses.length === 0 && <tr><td colSpan={4} className={`${TD} text-center text-slate-400`}>Sem despesas lançadas no período.</td></tr>}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Devoluções" subtitle={`${financial.returns.count} devolução(ões) de vendas do período · ${formatMoney(financial.returns.amount)}`} action={<RotateCcw className="w-4 h-4 text-slate-400" />}>
        <div className="p-3 flex flex-wrap gap-2">
          {financial.returns.byMethod.map(row => (
            <span key={row.method} className="px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200"><strong>{PAYMENT_LABELS[row.method] || row.method}</strong> {formatMoney(row.amount)}</span>
          ))}
          {financial.returns.byMethod.length === 0 && <span className="text-slate-400">Nenhuma devolução.</span>}
        </div>
      </Panel>
    </div>
  );
}

// ---------------- Produtos ----------------

function ProductsSection({ tenantId, unitId, from, to, reloadKey }: SectionProps) {
  const [kind, setKind] = useState<'PRODUCT' | 'SERVICE'>('PRODUCT');
  const { data, error, loading } = useSectionData(() => getFranchiseProducts(tenantId, unitId, from, to), [tenantId, unitId, from.getTime(), to.getTime(), reloadKey]);
  if (!data) return <State loading={loading} error={error} />;
  const rows: FranchiseProductRow[] = data.filter(row => row.itemType === kind);
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  // Curva ABC: A ate 80% do faturamento acumulado, B ate 95%, C o resto.
  let cumulative = 0;
  const ranked = rows.map(row => {
    cumulative += row.revenue;
    const share = total > 0 ? cumulative / total : 1;
    return { ...row, abc: share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C' };
  });
  const abcCount = (letter: string) => ranked.filter(row => row.abc === letter).length;
  const categories = Object.values(rows.reduce<Record<string, { category: string; revenue: number; cost: number; quantity: number }>>((acc, row) => {
    const entry = acc[row.category] ?? (acc[row.category] = { category: row.category, revenue: 0, cost: 0, quantity: 0 });
    entry.revenue += row.revenue;
    entry.cost += row.cost;
    entry.quantity += row.quantity;
    return acc;
  }, {})).sort((a, b) => b.revenue - a.revenue);
  const abcStyle: Record<string, string> = { A: 'bg-emerald-50 text-emerald-700', B: 'bg-amber-50 text-amber-700', C: 'bg-slate-100 text-slate-600' };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {([['PRODUCT', 'Produtos'], ['SERVICE', 'Serviços']] as const).map(([value, label]) => (
          <button key={value} type="button" onClick={() => setKind(value)} className={`px-3 py-1.5 rounded-lg border font-bold ${kind === value ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}>{label}</button>
        ))}
      </div>
      {rows.length === 0 ? <State loading={false} error="" empty /> : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard label="Curva A (80% do faturamento)" value={`${abcCount('A')} item(ns)`} icon={TrendingUp} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" />
            <StatCard label="Curva B (próximos 15%)" value={`${abcCount('B')} item(ns)`} icon={TrendingUp} tone="bg-amber-50 text-amber-600 border-amber-100/80" />
            <StatCard label="Curva C (últimos 5%)" value={`${abcCount('C')} item(ns)`} icon={TrendingUp} tone="bg-slate-100 text-slate-600 border-slate-200" />
          </div>
          <Panel title={kind === 'PRODUCT' ? 'Produtos vendidos' : 'Serviços vendidos'} subtitle={`${rows.length} item(ns) · ${formatMoney(total)} · ordenado por faturamento`}>
            <table className="w-full min-w-[820px]">
              <thead><tr>
                <th className={TH}>ABC</th><th className={TH}>Item</th><th className={TH}>Categoria</th><th className={`${TH} text-right`}>Qtd</th>
                <th className={`${TH} text-right`}>Faturamento</th><th className={`${TH} text-right`}>Custo</th><th className={`${TH} text-right`}>Lucro</th><th className={`${TH} text-right`}>Margem</th>
              </tr></thead>
              <tbody>
                {ranked.map(row => (
                  <tr key={row.itemId}>
                    <td className={TD}><span className={`px-1.5 py-0.5 rounded font-bold ${abcStyle[row.abc]}`}>{row.abc}</span></td>
                    <td className={TD}><span className="font-bold text-slate-800">{row.name}</span>{row.sku && <span className="block text-[10px] text-slate-400 font-mono">{row.sku}</span>}</td>
                    <td className={TD}>{row.category}</td>
                    <td className={`${TD} text-right font-mono`}>{row.quantity}</td>
                    <td className={`${TD} text-right font-mono font-bold`}>{formatMoney(row.revenue)}</td>
                    <td className={`${TD} text-right font-mono`}>{row.missingCost ? <span className="text-amber-700" title="Venda sem custo registrado">?</span> : formatMoney(row.cost)}</td>
                    <td className={`${TD} text-right font-mono`}>{formatMoney(row.revenue - row.cost)}</td>
                    <td className={`${TD} text-right font-mono`}>{pct(row.revenue - row.cost, row.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Por categoria">
            <table className="w-full">
              <thead><tr><th className={TH}>Categoria</th><th className={`${TH} text-right`}>Qtd</th><th className={`${TH} text-right`}>Faturamento</th><th className={`${TH} text-right`}>Margem</th><th className={`${TH} text-right`}>Participação</th></tr></thead>
              <tbody>
                {categories.map(row => (
                  <tr key={row.category}>
                    <td className={`${TD} font-bold`}>{row.category}</td><td className={`${TD} text-right font-mono`}>{row.quantity}</td>
                    <td className={`${TD} text-right font-mono`}>{formatMoney(row.revenue)}</td><td className={`${TD} text-right font-mono`}>{pct(row.revenue - row.cost, row.revenue)}</td>
                    <td className={TD}><div className="flex items-center justify-end gap-2"><ShareBar value={row.revenue} total={total} /><span className="w-12 text-right font-mono">{pct(row.revenue, total)}</span></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}

// ---------------- Estoque ----------------

function StockSection({ tenantId, unitId, reloadKey, storeName }: SectionProps) {
  const [filter, setFilter] = useState<'todos' | 'alerta' | 'parados'>('todos');
  const { data, error, loading } = useSectionData(() => getFranchiseStock(tenantId, unitId), [tenantId, unitId, reloadKey]);
  if (!data) return <State loading={loading} error={error} />;
  const stock: FranchiseStock = data;
  const now = Date.now();
  const rows = stock.products.map(product => {
    const qty = (product.stores || []).reduce((sum, store) => sum + store.qty, 0);
    const costValue = (product.stores || []).reduce((sum, store) => sum + store.costValue, 0);
    const minStock = product.minStock ?? 2;
    const coverage = product.sold30 > 0 ? Math.floor(qty / (product.sold30 / 30)) : null;
    const daysSinceSale = product.lastSaleAt ? Math.floor((now - new Date(product.lastSaleAt).getTime()) / 86400000) : null;
    const alert = qty <= 0 ? 'Zerado' : qty <= minStock ? 'Abaixo do mínimo' : coverage != null && coverage < 15 ? `Cobre ${coverage} dia(s)` : null;
    const stale = qty > 0 && (daysSinceSale == null || daysSinceSale >= 60);
    return { ...product, qty, costValue, saleValue: Math.max(qty, 0) * Number(product.sellPrice || 0), coverage, daysSinceSale, alert, stale };
  }).filter(row => row.qty !== 0 || row.sold30 > 0 || row.minStock != null);
  const visible = rows.filter(row => filter === 'todos' || (filter === 'alerta' ? Boolean(row.alert) : row.stale));
  const totalCost = rows.reduce((sum, row) => sum + row.costValue, 0);
  const totalSale = rows.reduce((sum, row) => sum + row.saleValue, 0);
  const totalUnits = rows.reduce((sum, row) => sum + Math.max(row.qty, 0), 0);
  const staleCost = rows.filter(row => row.stale).reduce((sum, row) => sum + row.costValue, 0);

  return (
    <div className="space-y-4">
      <p className="text-slate-500">Estoque de agora (o período não se aplica).</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Estoque a custo" value={formatMoney(totalCost)} icon={Boxes} tone="bg-blue-50 text-blue-600 border-blue-100/80" />
        <StatCard label="Estoque a preço de venda" value={formatMoney(totalSale)} icon={DollarSign} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" />
        <StatCard label="Unidades em estoque" value={totalUnits.toLocaleString('pt-BR')} icon={Package} tone="bg-slate-100 text-slate-600 border-slate-200" />
        <StatCard label="Parado há 60+ dias (custo)" value={formatMoney(staleCost)} icon={AlertTriangle} tone="bg-amber-50 text-amber-600 border-amber-100/80" />
      </div>
      <Panel
        title="Produtos em estoque"
        subtitle={`${rows.filter(row => row.alert).length} em alerta · ${rows.filter(row => row.stale).length} parado(s)`}
        action={<div className="flex gap-1">{([['todos', 'Todos'], ['alerta', 'Em alerta'], ['parados', 'Parados']] as const).map(([value, label]) => (
          <button key={value} type="button" onClick={() => setFilter(value)} className={`px-2.5 py-1 rounded-lg border font-bold ${filter === value ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}>{label}</button>
        ))}</div>}
      >
        <table className="w-full min-w-[900px]">
          <thead><tr>
            <th className={TH}>Produto</th><th className={TH}>Categoria</th><th className={`${TH} text-right`}>Qtd</th><th className={`${TH} text-right`}>A custo</th>
            <th className={`${TH} text-right`}>A preço de venda</th><th className={`${TH} text-right`}>Vendas 30 dias</th><th className={`${TH} text-right`}>Última venda</th><th className={TH}>Situação</th>
          </tr></thead>
          <tbody>
            {visible.map(row => (
              <tr key={row.productId}>
                <td className={TD}><span className="font-bold text-slate-800">{row.name}</span><span className="block text-[10px] text-slate-400 font-mono">{row.sku}</span>
                  {!unitId && (row.stores || []).length > 1 && <span className="block text-[10px] text-slate-500">{(row.stores || []).map(store => `${storeName(store.unitId)}: ${store.qty}`).join(' · ')}</span>}</td>
                <td className={TD}>{row.category}</td>
                <td className={`${TD} text-right font-mono font-bold ${row.qty <= 0 ? 'text-rose-600' : ''}`}>{row.qty}</td>
                <td className={`${TD} text-right font-mono`}>{formatMoney(row.costValue)}</td>
                <td className={`${TD} text-right font-mono`}>{formatMoney(row.saleValue)}</td>
                <td className={`${TD} text-right font-mono`}>{row.sold30}</td>
                <td className={`${TD} text-right`}>{row.daysSinceSale == null ? 'nunca' : `há ${row.daysSinceSale} dia(s)`}</td>
                <td className={TD}>
                  {row.alert && <span className={`px-1.5 py-0.5 rounded font-bold ${row.qty <= 0 ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{row.alert}</span>}
                  {row.stale && <span className="ml-1 px-1.5 py-0.5 rounded font-bold bg-slate-100 text-slate-600">Parado</span>}
                  {!row.alert && !row.stale && <span className="text-emerald-700 font-bold">Normal</span>}
                </td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={8} className={`${TD} text-center text-slate-400`}>Nenhum produto neste filtro.</td></tr>}
          </tbody>
        </table>
      </Panel>
      <Panel title="Balanços de estoque" action={<ClipboardList className="w-4 h-4 text-slate-400" />}>
        <table className="w-full">
          <thead><tr><th className={TH}>Nº</th><th className={TH}>Loja</th><th className={TH}>Situação</th><th className={TH}>Aberto em</th><th className={TH}>Aprovado em</th><th className={TH}>Por</th></tr></thead>
          <tbody>
            {stock.counts.map(count => (
              <tr key={count.id}><td className={`${TD} font-bold`}>{count.countNumber}</td><td className={TD}>{storeName(count.unitId)}</td><td className={TD}>{count.status}</td>
                <td className={TD}>{dateTime(count.createdAt)}</td><td className={TD}>{dateTime(count.approvedAt)}</td><td className={TD}>{count.createdByName || '—'}</td></tr>
            ))}
            {stock.counts.length === 0 && <tr><td colSpan={6} className={`${TD} text-center text-slate-400`}>Nenhum balanço feito.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

// ---------------- Equipe ----------------

function TeamSection({ tenantId, unitId, from, to, reloadKey, storeName }: SectionProps) {
  const { data, error, loading } = useSectionData(() => getFranchiseTeam(tenantId, unitId, from, to), [tenantId, unitId, from.getTime(), to.getTime(), reloadKey]);
  if (!data) return <State loading={loading} error={error} />;
  const rows: FranchiseSellerRow[] = data;
  if (rows.length === 0) return <State loading={false} error="" empty />;
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  return (
    <Panel title="Vendas por vendedor" subtitle={`${rows.length} vendedor(es) · ${formatMoney(total)}`}>
      <table className="w-full min-w-[700px]">
        <thead><tr><th className={TH}>#</th><th className={TH}>Vendedor</th><th className={TH}>Loja</th><th className={`${TH} text-right`}>Vendas</th><th className={`${TH} text-right`}>Faturamento</th><th className={`${TH} text-right`}>Ticket médio</th><th className={`${TH} text-right`}>Participação</th></tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.unitId}-${row.sellerCode}-${row.sellerName}`}>
              <td className={`${TD} font-bold text-slate-400`}>{index + 1}</td>
              <td className={`${TD} font-bold`}>{row.sellerName}{row.sellerCode && <span className="ml-1 font-mono text-slate-400">({row.sellerCode})</span>}</td>
              <td className={TD}>{storeName(row.unitId)}</td>
              <td className={`${TD} text-right font-mono`}>{row.salesCount}</td>
              <td className={`${TD} text-right font-mono font-bold`}>{formatMoney(row.revenue)}</td>
              <td className={`${TD} text-right font-mono`}>{formatMoney(row.salesCount > 0 ? row.revenue / row.salesCount : 0)}</td>
              <td className={TD}><div className="flex items-center justify-end gap-2"><ShareBar value={row.revenue} total={total} /><span className="w-12 text-right font-mono">{pct(row.revenue, total)}</span></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ---------------- Servicos / OS ----------------

function ServicesSection({ tenantId, unitId, from, to, reloadKey, storeName }: SectionProps) {
  const { data, error, loading } = useSectionData(() => getFranchiseServices(tenantId, unitId, from, to), [tenantId, unitId, from.getTime(), to.getTime(), reloadKey]);
  if (!data) return <State loading={loading} error={error} />;
  const services: FranchiseServices = data;
  const openTotal = Object.values(services.byStatus).reduce((sum, value) => sum + Number(value), 0);
  const overdue = services.open.filter(order => order.overdue).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Faturamento de serviços" value={formatMoney(services.servicesRevenue)} icon={DollarSign} tone="bg-blue-50 text-blue-600 border-blue-100/80" />
        <StatCard label="OS abertas no período" value={String(services.openedInPeriod)} icon={ClipboardList} tone="bg-sky-50 text-sky-600 border-sky-100/80" />
        <StatCard label="OS entregues no período" value={String(services.deliveredInPeriod)} icon={ShoppingCart} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" />
        <StatCard label="OS em andamento (atrasadas)" value={`${openTotal} (${overdue})`} icon={AlertTriangle} tone="bg-amber-50 text-amber-600 border-amber-100/80" negative={overdue > 0} />
      </div>
      <Panel title="OS em andamento" subtitle={Object.entries(services.byStatus).map(([status, total]) => `${OS_LABELS[status] || status}: ${total}`).join(' · ') || 'Nenhuma OS aberta'}>
        <table className="w-full min-w-[820px]">
          <thead><tr><th className={TH}>Nº</th><th className={TH}>Loja</th><th className={TH}>Aparelho</th><th className={TH}>Cliente</th><th className={TH}>Situação</th><th className={TH}>Aberta em</th><th className={TH}>Previsão</th><th className={TH}>Pagamento</th></tr></thead>
          <tbody>
            {services.open.map(order => (
              <tr key={`${order.unitId}-${order.orderNumber}-${order.createdAt}`}>
                <td className={`${TD} font-bold`}>{order.orderNumber ?? '—'}</td><td className={TD}>{storeName(order.unitId)}</td><td className={TD}>{order.equipment || '—'}</td>
                <td className={TD}>{order.customer || '—'}</td><td className={TD}>{OS_LABELS[order.status] || order.status}</td><td className={TD}>{dateTime(order.createdAt)}</td>
                <td className={`${TD} ${order.overdue ? 'text-rose-700 font-bold' : ''}`}>{dateOnly(order.expectedDate)}{order.overdue ? ' (atrasada)' : ''}</td>
                <td className={TD}>{order.paid ? <span className="text-emerald-700 font-bold">Pago</span> : 'A pagar'}</td>
              </tr>
            ))}
            {services.open.length === 0 && <tr><td colSpan={8} className={`${TD} text-center text-slate-400`}>Nenhuma OS em andamento.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

// ---------------- Operacao ----------------

function OperationsSection({ tenantId, unitId, from, to, reloadKey, storeName }: SectionProps) {
  const { data, error, loading } = useSectionData(() => getFranchiseOperations(tenantId, unitId, from, to), [tenantId, unitId, from.getTime(), to.getTime(), reloadKey]);
  if (!data) return <State loading={loading} error={error} />;
  const operations: FranchiseOperations = data;
  const closed = operations.cashSessions.filter(cash => cash.status !== 'ABERTO');
  const differenceTotal = closed.reduce((sum, cash) => sum + Number(cash.totalDifference || 0), 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="PDVs ativos" value={`${operations.terminals.filter(terminal => terminal.isActive).length} de ${operations.terminals.length}`} icon={MonitorSmartphone} tone="bg-blue-50 text-blue-600 border-blue-100/80" />
        <StatCard label="Caixas abertos agora" value={String(operations.cashSessions.filter(cash => cash.status === 'ABERTO').length)} icon={Wallet} tone="bg-sky-50 text-sky-600 border-sky-100/80" />
        <StatCard label="Caixas fechados no período" value={String(closed.length)} icon={ClipboardList} tone="bg-slate-100 text-slate-600 border-slate-200" />
        <StatCard label="Diferença de caixa no período" value={formatMoney(differenceTotal)} icon={Banknote} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" negative={Math.abs(differenceTotal) >= 0.01} hint="Soma do contado menos o esperado, todas as formas" />
      </div>
      <Panel title="Caixas" subtitle="Abertos agora e abertos no período">
        <table className="w-full min-w-[980px]">
          <thead><tr>
            <th className={TH}>Loja</th><th className={TH}>Caixa</th><th className={TH}>Abertura</th><th className={TH}>Fechamento</th>
            <th className={`${TH} text-right`}>Fundo</th><th className={`${TH} text-right`}>Sangrias</th><th className={`${TH} text-right`}>Suprimentos</th>
            <th className={`${TH} text-right`}>Dinheiro esperado</th><th className={`${TH} text-right`}>Contado</th><th className={`${TH} text-right`}>Diferença (todas)</th>
          </tr></thead>
          <tbody>
            {operations.cashSessions.map(cash => {
              const diff = Number(cash.totalDifference || 0);
              return (
                <tr key={`${cash.unitId}-${cash.openedAt}`}>
                  <td className={TD}>{storeName(cash.unitId)}</td><td className={`${TD} font-bold`}>{cash.cashNumber || '—'}</td>
                  <td className={TD}>{dateTime(cash.openedAt)}<span className="block text-[10px] text-slate-400">{cash.openedBy}</span></td>
                  <td className={TD}>{cash.status === 'ABERTO' ? <span className="text-blue-700 font-bold">Aberto</span> : <>{dateTime(cash.closedAt)}<span className="block text-[10px] text-slate-400">{cash.closedBy}</span></>}</td>
                  <td className={`${TD} text-right font-mono`}>{formatMoney(Number(cash.openingFloat || 0))}</td>
                  <td className={`${TD} text-right font-mono`}>{formatMoney(cash.withdrawals)}</td>
                  <td className={`${TD} text-right font-mono`}>{formatMoney(cash.supplies)}</td>
                  <td className={`${TD} text-right font-mono`}>{cash.expectedCash == null ? '—' : formatMoney(Number(cash.expectedCash))}</td>
                  <td className={`${TD} text-right font-mono`}>{cash.countedCash == null ? '—' : formatMoney(Number(cash.countedCash))}</td>
                  <td className={`${TD} text-right font-mono font-bold ${cash.status === 'ABERTO' ? 'text-slate-400' : Math.abs(diff) >= 0.01 ? (diff < 0 ? 'text-rose-700' : 'text-amber-700') : 'text-emerald-700'}`}>{cash.status === 'ABERTO' ? '—' : formatMoney(diff)}</td>
                </tr>
              );
            })}
            {operations.cashSessions.length === 0 && <tr><td colSpan={10} className={`${TD} text-center text-slate-400`}>Nenhum caixa no período.</td></tr>}
          </tbody>
        </table>
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="Notas fiscais" subtitle="Autorizadas no período e problemas pendentes (qualquer data)">
          <table className="w-full">
            <thead><tr><th className={TH}>Loja</th><th className={TH}>Emissor</th><th className={`${TH} text-right`}>NFC-e</th><th className={`${TH} text-right`}>NFS-e</th></tr></thead>
            <tbody>
              {operations.fiscal.map(row => (
                <tr key={row.unitId}>
                  <td className={`${TD} font-bold`}>{row.storeName || row.unitId}</td>
                  <td className={TD}>{row.configured ? <span className="text-emerald-700 font-bold">Configurado{row.environment === 'homologacao' ? ' (teste)' : ''}</span> : <span className="text-rose-700 font-bold">Não configurado</span>}
                    {row.configured && (!row.municipalRegistration || !row.cityCode) && <span className="block text-[10px] text-amber-700">NFS-e: falta inscrição municipal/município</span>}</td>
                  <td className={`${TD} text-right`}>{row.nfceAuthorized}{row.nfceProblems > 0 && <span className="block text-rose-700 font-bold">{row.nfceProblems} com problema</span>}</td>
                  <td className={`${TD} text-right`}>{row.nfseAuthorized}{row.nfseProblems > 0 && <span className="block text-rose-700 font-bold">{row.nfseProblems} com problema</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="PDVs (terminais)">
          <table className="w-full">
            <thead><tr><th className={TH}>Terminal</th><th className={TH}>Loja</th><th className={TH}>Situação</th><th className={TH}>Último desbloqueio</th></tr></thead>
            <tbody>
              {operations.terminals.map(terminal => (
                <tr key={`${terminal.unitId}-${terminal.name}`}>
                  <td className={`${TD} font-bold`}>{terminal.name}</td><td className={TD}>{storeName(terminal.unitId)}</td>
                  <td className={TD}>{terminal.isActive ? <span className="text-emerald-700 font-bold">Ativo</span> : <span className="text-slate-500">Inativo</span>}</td>
                  <td className={TD}>{dateTime(terminal.lastUnlockedAt)}</td>
                </tr>
              ))}
              {operations.terminals.length === 0 && <tr><td colSpan={4} className={`${TD} text-center text-slate-400`}>Nenhum PDV ativado.</td></tr>}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

// ---------------- Clientes ----------------

function CustomersSection({ tenantId, unitId, from, to, reloadKey }: SectionProps) {
  const { data, error, loading } = useSectionData(() => getFranchiseCustomers(tenantId, unitId, from, to), [tenantId, unitId, from.getTime(), to.getTime(), reloadKey]);
  if (!data) return <State loading={loading} error={error} />;
  const customers: FranchiseCustomers = data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Clientes cadastrados" value={customers.totalCustomers.toLocaleString('pt-BR')} icon={Users} tone="bg-blue-50 text-blue-600 border-blue-100/80" />
        <StatCard label="Novos no período" value={customers.newCustomers.toLocaleString('pt-BR')} icon={UserRound} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" />
        <StatCard label="Compraram identificados" value={customers.buyers.toLocaleString('pt-BR')} icon={ShoppingCart} tone="bg-sky-50 text-sky-600 border-sky-100/80" hint="Vendas com CPF no período" />
        <StatCard label="Voltaram a comprar" value={`${customers.returningBuyers} (${pct(customers.returningBuyers, customers.buyers)})`} icon={RotateCcw} tone="bg-violet-50 text-violet-600 border-violet-100/80" hint="Já tinham comprado antes do período" />
      </div>
      <Panel title="Clientes que mais compraram" subtitle={`Ticket médio por cliente identificado: ${formatMoney(customers.buyers > 0 ? customers.identifiedRevenue / customers.buyers : 0)} · nome e CPF mascarados (LGPD)`}>
        <table className="w-full min-w-[700px]">
          <thead><tr><th className={TH}>#</th><th className={TH}>Cliente</th><th className={TH}>CPF</th><th className={`${TH} text-right`}>Compras</th><th className={`${TH} text-right`}>Total gasto</th><th className={TH}>Última compra</th><th className={TH}>Recompra</th></tr></thead>
          <tbody>
            {customers.top.map((row, index) => (
              <tr key={`${row.cpf}-${index}`}>
                <td className={`${TD} font-bold text-slate-400`}>{index + 1}</td><td className={`${TD} font-bold`}>{row.name || '—'}</td>
                <td className={`${TD} font-mono`}>{row.cpf || '—'}</td><td className={`${TD} text-right font-mono`}>{row.purchases}</td>
                <td className={`${TD} text-right font-mono font-bold`}>{formatMoney(row.spent)}</td><td className={TD}>{dateTime(row.lastPurchase)}</td>
                <td className={TD}>{row.returning ? <span className="text-emerald-700 font-bold">Cliente antigo</span> : 'Primeira vez'}</td>
              </tr>
            ))}
            {customers.top.length === 0 && <tr><td colSpan={7} className={`${TD} text-center text-slate-400`}>Nenhuma venda com CPF no período.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
