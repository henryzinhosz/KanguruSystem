import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownRight, ArrowUpRight, Building2, CalendarDays, Check, ChevronDown, ChevronUp, DollarSign, KeyRound, LayoutDashboard, Network, Percent, ReceiptText, RefreshCw, ShoppingCart, Store, TrendingUp, UserPlus, Users, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { User } from '../types';
import { PERIOD_LABELS, PeriodPreset, formatMoney, monthLabel, resolvePeriod, shiftMonthKey, toLocalDateKey, type DateRange } from '../db/finance';
import {
  getNetworkMonthlyRevenue,
  getNetworkStoreMetrics,
  listNetworkFranchises,
  listNetworkUsers,
  manageNetworkUser,
  type NetworkFranchise,
  type NetworkMonthlyRow,
  type NetworkStoreMetrics,
  type NetworkUser,
} from '../db/network';

// Painel da Rede (etapa 1): a franqueadora acompanha as franquias, so leitura.
// Mesmas regras de numeros dos Relatorios Gerais do ERP (calculadas no servidor).

type Tab = 'geral' | 'franquias' | 'usuarios';

const MONTH_SHORT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Erro ao carregar os dados.';

// Periodo anterior para comparar: mes corrente -> mesmos dias do mes passado; demais -> mesmo tamanho logo antes.
function previousRange(preset: PeriodPreset, range: DateRange): DateRange {
  if (preset === 'mes') {
    const start = new Date(range.start.getFullYear(), range.start.getMonth() - 1, 1);
    const days = Math.round((range.end.getTime() - range.start.getTime()) / 86400000);
    return { start, end: new Date(start.getFullYear(), start.getMonth(), 1 + days) };
  }
  if (preset === 'mes_passado') {
    return { start: new Date(range.start.getFullYear(), range.start.getMonth() - 1, 1), end: range.start };
  }
  const length = range.end.getTime() - range.start.getTime();
  return { start: new Date(range.start.getTime() - length), end: range.start };
}

interface Totals {
  revenue: number;
  cost: number;
  grossProfit: number;
  fees: number;
  expenses: number;
  operatingProfit: number;
  salesCount: number;
  ticket: number;
}

function totalsOf(rows: NetworkStoreMetrics[]): Totals {
  const revenue = rows.reduce((sum, row) => sum + row.gross - row.returned, 0);
  const cost = rows.reduce((sum, row) => sum + row.cost, 0);
  const fees = rows.reduce((sum, row) => sum + row.fees, 0);
  const expenses = rows.reduce((sum, row) => sum + row.expenses, 0);
  const salesCount = rows.reduce((sum, row) => sum + row.salesCount, 0);
  return {
    revenue,
    cost,
    grossProfit: revenue - cost,
    fees,
    expenses,
    operatingProfit: revenue - cost - fees - expenses,
    salesCount,
    ticket: salesCount > 0 ? revenue / salesCount : 0,
  };
}

const variation = (current: number, previous: number) => (previous > 0 ? ((current - previous) / previous) * 100 : null);

const NAV_ITEMS: { id: Tab; name: string; icon: LucideIcon; description: string }[] = [
  { id: 'geral', name: 'Visão geral', icon: LayoutDashboard, description: 'Números da rede, evolução e ranking das lojas.' },
  { id: 'franquias', name: 'Franquias', icon: Building2, description: 'Franqueados, lojas e situação de cada operação.' },
  { id: 'usuarios', name: 'Usuários da rede', icon: Users, description: 'Quem da franqueadora acessa este painel.' },
];

// Layout igual ao do ERP: barra lateral escura com as secoes e area de trabalho a direita.
export default function NetworkView({ currentUser }: { currentUser: User }) {
  const [tab, setTab] = useState<Tab>('geral');
  const [summary, setSummary] = useState<{ franchises: number; stores: number } | null>(null);
  const isOwner = currentUser.role === 'NETWORK_OWNER';
  const active = NAV_ITEMS.find(item => item.id === tab)!;

  useEffect(() => {
    listNetworkFranchises()
      .then(rows => setSummary({ franchises: rows.length, stores: rows.reduce((sum, row) => sum + row.stores.length, 0) }))
      .catch(() => setSummary(null));
  }, []);

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-0">
      <aside className="w-full md:w-60 bg-slate-950 text-slate-300 flex flex-col border-r border-slate-900 shrink-0">
        <div className="p-4 bg-slate-950/40 border-b border-slate-900/80 hidden md:block">
          <span className="text-xs text-slate-500 font-bold uppercase tracking-widest font-mono flex items-center gap-1.5">
            <Network className="w-3.5 h-3.5" />Rede
          </span>
          <p className="mt-1 text-sm font-bold text-white truncate" title={currentUser.networkName || ''}>{currentUser.networkName || 'Rede'}</p>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-400 font-medium">Franquias:</span>
            <span className="bg-blue-500/10 text-blue-400 border border-blue-500/20 font-bold font-mono text-xs px-2 py-0.5 rounded">{summary?.franchises ?? '—'}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-xs text-slate-400 font-medium">Lojas:</span>
            <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold font-mono text-xs px-2 py-0.5 rounded">{summary?.stores ?? '—'}</span>
          </div>
        </div>

        <nav className="py-4 space-y-1 flex-1 pr-3" aria-label="Menu do Painel da Rede">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            const isActive = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`w-full flex items-center px-4 py-3 text-sm font-semibold transition-all duration-150 rounded-r-lg ${
                  isActive
                    ? 'bg-blue-600/15 text-blue-400 border-l-4 border-blue-500 font-bold'
                    : 'hover:bg-slate-900/60 hover:text-white text-slate-400 border-l-4 border-transparent'
                }`}
              >
                <Icon className="w-[18px] h-[18px] mr-3 shrink-0" />
                <span>{item.name}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 bg-slate-950/80 border-t border-slate-900 text-xs text-slate-500 font-mono text-center hidden md:block">
          <p>Painel da Rede</p>
          <p className="mt-0.5 opacity-80">Somente leitura</p>
        </div>
      </aside>

      <main className="erp-workspace flex-1 p-3 sm:p-4 lg:p-5 w-full overflow-y-auto space-y-5">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2"><active.icon className="w-5 h-5 text-blue-600" />{active.name}</h2>
          <p className="text-xs text-slate-500">{active.description}</p>
        </div>
        {tab === 'geral' && <NetworkOverview />}
        {tab === 'franquias' && <NetworkFranchises />}
        {tab === 'usuarios' && <NetworkUsers isOwner={isOwner} currentUserId={currentUser.id} />}
      </main>
    </div>
  );
}

const PERIOD_ORDER: PeriodPreset[] = ['hoje', '7dias', 'semana', 'mes', 'mes_passado'];

function Dropdown({ label, value, placeholder, options, onChange }: {
  label: string;
  value: string;
  placeholder?: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(previous => !previous)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`h-10 min-w-44 px-3 rounded-lg border font-bold inline-flex items-center justify-between gap-3 ${selected ? 'bg-white text-slate-800 border-blue-300 ring-1 ring-blue-100' : 'bg-white text-slate-500 border-slate-200'} hover:bg-slate-50`}
      >
        <span className="text-left leading-tight">
          <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
          <span className="block">{selected?.label ?? placeholder ?? 'Escolha'}</span>
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronUp className="w-4 h-4 text-slate-500" />}
      </button>
      {open && (
        <ul role="listbox" className="absolute left-0 top-full mt-1 z-30 min-w-full max-h-72 overflow-auto bg-white border border-slate-200 rounded-lg shadow-lg py-1">
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 font-semibold whitespace-nowrap ${option.value === value ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'}`}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------- Visao geral ----------------

function NetworkOverview() {
  const [preset, setPreset] = useState<PeriodPreset>('hoje');
  const [scope, setScope] = useState(''); // '' = consolidado (rede toda) ou tenantId da franquia
  const [customFrom, setCustomFrom] = useState(() => toLocalDateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [customTo, setCustomTo] = useState(() => toLocalDateKey(new Date()));
  const [currentAll, setCurrent] = useState<NetworkStoreMetrics[]>([]);
  const [previousAll, setPrevious] = useState<NetworkStoreMetrics[]>([]);
  const [monthlyAll, setMonthly] = useState<NetworkMonthlyRow[]>([]);
  const [franchises, setFranchises] = useState<NetworkFranchise[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const range = useMemo(() => resolvePeriod(preset, customFrom, customTo), [preset, customFrom, customTo]);
  const prevRange = useMemo(() => previousRange(preset, range), [preset, range]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const now = new Date();
      const monthsFrom = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      const monthsTo = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const [currentRows, previousRows, monthlyRows, franchiseRows] = await Promise.all([
        getNetworkStoreMetrics(range.start, range.end),
        getNetworkStoreMetrics(prevRange.start, prevRange.end),
        getNetworkMonthlyRevenue(monthsFrom, monthsTo),
        listNetworkFranchises(),
      ]);
      setCurrent(currentRows);
      setPrevious(previousRows);
      setMonthly(monthlyRows);
      setFranchises(franchiseRows);
    } catch (loadError) {
      setError(`Não foi possível carregar os números da rede: ${errorText(loadError)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [range.start.getTime(), range.end.getTime()]);

  // Consolidado = rede toda; franquia escolhida = so as lojas dela.
  const inScope = (tenantId: string) => !scope || tenantId === scope;
  const current = currentAll.filter(row => inScope(row.tenantId));
  const previous = previousAll.filter(row => inScope(row.tenantId));
  const monthly = monthlyAll.filter(row => inScope(row.tenantId));
  const totals = totalsOf(current);
  const prevTotals = totalsOf(previous);
  const franchiseName = (tenantId: string) => {
    const franchise = franchises.find(entry => entry.tenantId === tenantId);
    return franchise?.tradeName || franchise?.legalName || '—';
  };
  const previousByStore = new Map<string, NetworkStoreMetrics>(previous.map(row => [`${row.tenantId}|${row.unitId}`, row]));
  const ranking = [...current]
    .map(row => {
      const revenue = row.gross - row.returned;
      const prev = previousByStore.get(`${row.tenantId}|${row.unitId}`);
      return {
        row,
        revenue,
        grossProfit: revenue - row.cost,
        operatingProfit: revenue - row.cost - row.fees - row.expenses,
        ticket: row.salesCount > 0 ? revenue / row.salesCount : 0,
        change: variation(revenue, prev ? prev.gross - prev.returned : 0),
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // Ultimos 12 meses (total da rede), incluindo meses sem venda.
  const monthKeys = Array.from({ length: 12 }, (_, index) => shiftMonthKey(toLocalDateKey(new Date()).slice(0, 7), index - 11));
  const chartData = monthKeys.map(key => ({
    month: key,
    label: `${MONTH_SHORT[Number(key.slice(5, 7)) - 1]}/${key.slice(2, 4)}`,
    revenue: monthly.filter(row => row.month === key).reduce((sum, row) => sum + row.revenue, 0),
  }));
  const missingCost = current.reduce((sum, row) => sum + row.salesMissingCost, 0);

  const cards: { label: string; value: string; change: number | null; hint?: string; icon: LucideIcon; tone: string; negative?: boolean }[] = [
    { label: 'Faturamento', value: formatMoney(totals.revenue), change: variation(totals.revenue, prevTotals.revenue), hint: 'Vendas concluídas menos devoluções', icon: DollarSign, tone: 'bg-blue-50 text-blue-600 border-blue-100/80' },
    { label: 'Lucro bruto', value: formatMoney(totals.grossProfit), change: variation(totals.grossProfit, prevTotals.grossProfit), hint: 'Faturamento menos custo das mercadorias', icon: TrendingUp, tone: 'bg-emerald-50 text-emerald-600 border-emerald-100/80', negative: totals.grossProfit < 0 },
    { label: 'Lucro real', value: formatMoney(totals.operatingProfit), change: variation(totals.operatingProfit, prevTotals.operatingProfit), hint: 'Lucro bruto menos taxas de cartão e despesas lançadas', icon: Wallet, tone: 'bg-violet-50 text-violet-600 border-violet-100/80', negative: totals.operatingProfit < 0 },
    { label: 'Ticket médio', value: formatMoney(totals.ticket), change: variation(totals.ticket, prevTotals.ticket), icon: ReceiptText, tone: 'bg-amber-50 text-amber-600 border-amber-100/80' },
    { label: 'Vendas', value: totals.salesCount.toLocaleString('pt-BR'), change: variation(totals.salesCount, prevTotals.salesCount), icon: ShoppingCart, tone: 'bg-sky-50 text-sky-600 border-sky-100/80' },
    { label: 'Margem bruta', value: totals.revenue > 0 ? `${((totals.grossProfit / totals.revenue) * 100).toFixed(1)}%` : '—', change: null, icon: Percent, tone: 'bg-slate-100 text-slate-600 border-slate-200' },
  ];

  return (
    <div className="space-y-5 text-xs">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-3 flex flex-wrap items-center gap-2">
        <Dropdown
          label="Período"
          value={preset === 'personalizado' ? '' : preset}
          placeholder="Personalizado"
          options={PERIOD_ORDER.map(key => ({ value: key, label: PERIOD_LABELS[key] }))}
          onChange={value => setPreset(value as PeriodPreset)}
        />
        <button
          type="button"
          onClick={() => setPreset('personalizado')}
          className={`h-10 px-4 rounded-lg border font-bold inline-flex items-center gap-1.5 ${preset === 'personalizado' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
        >
          <CalendarDays className="w-4 h-4" />Personalizado
        </button>
        {preset === 'personalizado' && (
          <>
            <input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} className="h-10 border border-slate-200 rounded-lg px-2" aria-label="De" />
            <input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} className="h-10 border border-slate-200 rounded-lg px-2" aria-label="Até" />
          </>
        )}
        <Dropdown
          label="Visão"
          value={scope}
          options={[{ value: '', label: 'Consolidado (rede toda)' }, ...franchises.map(franchise => ({ value: franchise.tenantId, label: franchise.tradeName || franchise.legalName }))]}
          onChange={setScope}
        />
        <button type="button" onClick={() => void load()} disabled={loading} className="ml-auto p-2 text-slate-500 hover:text-slate-800 disabled:opacity-50" title="Atualizar" aria-label="Atualizar"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>

      {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {cards.map(card => (
          <div key={card.label} className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-4" title={card.hint}>
            <div className={`p-3 rounded-lg shrink-0 border ${card.negative ? 'bg-rose-50 text-rose-600 border-rose-100/80' : card.tone}`}>
              <card.icon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
            <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">{card.label}</span>
            <span className={`text-xl font-extrabold tracking-tight block ${card.negative ? 'text-rose-600' : 'text-slate-900'}`}>{card.value}</span>
            {card.change != null && (
              <span className={`text-[11px] font-bold inline-flex items-center gap-0.5 ${card.change >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {card.change >= 0 ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                {Math.abs(card.change).toFixed(1)}% <span className="font-normal text-slate-400">vs. período anterior</span>
              </span>
            )}
            </div>
          </div>
        ))}
      </div>
      {missingCost > 0 && <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">{missingCost} venda(s) do período têm produto sem custo registrado: o lucro dessas vendas pode estar maior que o real.</p>}

      <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-5">
        <h3 className="text-sm font-bold text-slate-900">Faturamento da rede — últimos 12 meses</h3>
        <div className="h-64 mt-3">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#64748b' }} />
              <YAxis tickLine={false} axisLine={false} width={72} tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={value => `R$ ${(Number(value) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`} />
              <Tooltip cursor={{ fill: 'rgba(37, 99, 235, 0.06)' }} formatter={value => [formatMoney(Number(value)), 'Faturamento']} labelFormatter={(_, payload) => (payload?.[0] ? monthLabel(String(payload[0].payload.month)) : '')} />
              <Bar dataKey="revenue" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="p-5 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900">Ranking das lojas</h3>
          <p className="text-slate-500">{ranking.length} loja(s) na rede · ordenado por faturamento</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 text-left">
              <tr>
                <th className="p-2">#</th><th className="p-2">Loja</th><th className="p-2">Franquia</th>
                <th className="p-2 text-right">Faturamento</th><th className="p-2 text-right">% da rede</th>
                <th className="p-2 text-right">Vendas</th><th className="p-2 text-right">Ticket</th>
                <th className="p-2 text-right">Lucro bruto</th><th className="p-2 text-right">Margem</th>
                <th className="p-2 text-right">Lucro real</th><th className="p-2 text-right">Variação</th>
              </tr>
            </thead>
            <tbody>
              {ranking.map((entry, index) => (
                <tr key={`${entry.row.tenantId}-${entry.row.unitId}`} className="border-t border-slate-100">
                  <td className="p-2 font-bold text-slate-400">{index + 1}</td>
                  <td className="p-2 font-bold text-slate-900">{entry.row.storeName || entry.row.unitId}</td>
                  <td className="p-2 text-slate-600">{franchiseName(entry.row.tenantId)}</td>
                  <td className="p-2 text-right font-mono font-bold">{formatMoney(entry.revenue)}</td>
                  <td className="p-2">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full bg-blue-600" style={{ width: `${totals.revenue > 0 ? Math.max(0, Math.min(100, (entry.revenue / totals.revenue) * 100)) : 0}%` }} /></div>
                      <span className="font-mono w-12 text-right">{totals.revenue > 0 ? `${((entry.revenue / totals.revenue) * 100).toFixed(1)}%` : '—'}</span>
                    </div>
                  </td>
                  <td className="p-2 text-right font-mono">{entry.row.salesCount}</td>
                  <td className="p-2 text-right font-mono">{formatMoney(entry.ticket)}</td>
                  <td className="p-2 text-right font-mono">{formatMoney(entry.grossProfit)}</td>
                  <td className="p-2 text-right font-mono">{entry.revenue > 0 ? `${((entry.grossProfit / entry.revenue) * 100).toFixed(1)}%` : '—'}</td>
                  <td className={`p-2 text-right font-mono ${entry.operatingProfit < 0 ? 'text-rose-700' : ''}`}>{formatMoney(entry.operatingProfit)}</td>
                  <td className={`p-2 text-right font-bold ${entry.change == null ? 'text-slate-400' : entry.change >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {entry.change == null ? '—' : `${entry.change >= 0 ? '+' : ''}${entry.change.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
              {ranking.length === 0 && !loading && <tr><td colSpan={11} className="p-6 text-center text-slate-400">Nenhuma loja ligada a esta rede ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------- Franquias ----------------

function NetworkFranchises() {
  const [franchises, setFranchises] = useState<NetworkFranchise[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listNetworkFranchises()
      .then(setFranchises)
      .catch(loadError => setError(errorText(loadError)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-xs text-slate-400">Carregando franquias...</p>;
  return (
    <div className="space-y-4 text-xs">
      {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {franchises.length === 0 && !error && <p className="text-slate-400">Nenhuma franquia ligada a esta rede ainda.</p>}
      {franchises.map(franchise => (
        <section key={franchise.tenantId} className="bg-white border border-slate-200 rounded-xl shadow-xs p-5 space-y-3">
          <div className="flex flex-wrap justify-between gap-3">
            <div className="flex items-start gap-2">
              <Building2 className="w-5 h-5 text-blue-600 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">{franchise.tradeName || franchise.legalName}</h3>
                <p className="text-slate-500">{franchise.legalName} · CNPJ {franchise.cnpj}</p>
              </div>
            </div>
            <div className="text-right">
              <span className="text-[10px] font-bold uppercase text-slate-500 block">Franqueado</span>
              <strong className="text-slate-800">{franchise.ownerName || 'não informado'}</strong>
              <span className="block text-slate-500">{[franchise.ownerPhone, franchise.ownerEmail].filter(Boolean).join(' · ') || '—'}</span>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {franchise.stores.map(store => (
              <div key={store.unitId} className="border border-slate-200 rounded-lg p-3 space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-slate-800"><Store className="w-4 h-4 text-slate-400" />{store.tradeName || store.unitId}</div>
                {store.address && <p className="text-slate-500">{store.address}</p>}
                {store.phone && <p className="text-slate-500">Tel. {store.phone}</p>}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${store.activeTerminals > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{store.activeTerminals} PDV ativo(s)</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${store.openCash ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>{store.openCash ? 'Caixa aberto' : 'Caixa fechado'}</span>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Última venda: {store.lastSaleAt ? new Date(store.lastSaleAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</span>
                </div>
              </div>
            ))}
            {franchise.stores.length === 0 && <p className="text-slate-400">Sem lojas cadastradas.</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------------- Usuarios da rede ----------------

function NetworkUsers({ isOwner, currentUserId }: { isOwner: boolean; currentUserId: string }) {
  const [users, setUsers] = useState<NetworkUser[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });

  const reload = () => listNetworkUsers().then(setUsers).catch(loadError => setError(errorText(loadError)));
  useEffect(() => {
    void reload();
  }, []);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(success);
      await reload();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setBusy(false);
    }
  };

  const createManager = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      await manageNetworkUser({ action: 'create', role: 'MANAGER', ...form });
      setForm({ name: '', email: '', password: '' });
    }, 'Gerente da rede criado. Passe o e-mail e a senha para ele entrar.');
  };

  const input = 'mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500';
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-5 text-xs">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center gap-2"><Users className="w-5 h-5 text-blue-600" /><h3 className="text-sm font-bold text-slate-900">Usuários da rede</h3></div>
        {error && <p className="m-3 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</p>}
        {message && <p className="m-3 text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-2 flex items-center gap-1.5"><Check className="w-4 h-4" />{message}</p>}
        <table className="w-full">
          <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 text-left"><tr><th className="p-2">Nome</th><th className="p-2">E-mail</th><th className="p-2">Perfil</th><th className="p-2">Situação</th>{isOwner && <th className="p-2 text-right">Ações</th>}</tr></thead>
          <tbody>
            {users.map(user => (
              <tr key={user.authUid} className="border-t border-slate-100">
                <td className="p-2 font-bold text-slate-900">{user.displayName}</td>
                <td className="p-2 text-slate-600">{user.email}</td>
                <td className="p-2">{user.role === 'OWNER' ? 'Dono da rede' : 'Gerente da rede'}</td>
                <td className="p-2"><span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${user.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{user.isActive ? 'ATIVO' : 'DESATIVADO'}</span></td>
                {isOwner && (
                  <td className="p-2">
                    {user.role === 'MANAGER' && user.authUid !== currentUserId && (
                      <div className="flex justify-end gap-2">
                        <button type="button" disabled={busy} onClick={() => {
                          const password = window.prompt(`Nova senha para ${user.displayName} (mínimo 8 caracteres):`);
                          if (password) void run(() => manageNetworkUser({ action: 'set_password', authUid: user.authUid, password }), 'Senha trocada.');
                        }} className="text-blue-700 font-bold hover:underline flex items-center gap-1"><KeyRound className="w-3.5 h-3.5" />Senha</button>
                        <button type="button" disabled={busy} onClick={() => void run(() => manageNetworkUser({ action: 'set_active', authUid: user.authUid, active: !user.isActive }), user.isActive ? 'Gerente desativado.' : 'Gerente reativado.')} className={`font-bold hover:underline ${user.isActive ? 'text-rose-600' : 'text-emerald-700'}`}>{user.isActive ? 'Desativar' : 'Reativar'}</button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isOwner && (
        <form onSubmit={createManager} className="bg-white border border-slate-200 rounded-xl shadow-xs p-4 space-y-3 h-fit">
          <div className="flex items-center gap-2"><UserPlus className="w-5 h-5 text-blue-600" /><h3 className="text-sm font-bold text-slate-900">Novo gerente da rede</h3></div>
          <label className="block font-bold text-slate-700">Nome<input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} className={input} /></label>
          <label className="block font-bold text-slate-700">E-mail<input required type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} className={input} /></label>
          <label className="block font-bold text-slate-700">Senha inicial<input required type="password" minLength={8} value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} className={input} /></label>
          <button type="submit" disabled={busy} className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg disabled:opacity-50">{busy ? 'Salvando...' : 'Criar gerente'}</button>
          <p className="text-slate-500">O gerente vê os mesmos números da rede, mas não cria nem altera logins.</p>
        </form>
      )}
    </div>
  );
}
