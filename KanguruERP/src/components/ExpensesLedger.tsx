import { useMemo, useState } from 'react';
import { BookOpen, Search, Trash2 } from 'lucide-react';
import type { Expense, StoreConfig, User } from '../types';
import { UserRole } from '../types';
import { supabaseService } from '../db/supabaseService';
import { toLocalDateKey } from '../db/finance';

// Livro caixa (Saidas): tudo o que saiu do caixa, inclusive as contas a pagar ja pagas
// (despesa "payable-<conta>"). Lancar um gasto agora e pela Nova conta (opcao "Ja foi paga").

interface ExpensesLedgerProps {
  currentUser: User;
  expenses: Expense[];
  storeConfigs: StoreConfig[];
  onChanged: () => void | Promise<void>;
  onOpenPayables: () => void;
}

type Period = 'ESTE_MES' | 'MES_PASSADO' | 'ULTIMOS_30' | 'ESTE_ANO' | 'TODOS' | 'PERSONALIZADO';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const inputClass = 'w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-blue-500';
const isPayable = (expense: Expense) => expense.id.startsWith('payable-');

export default function ExpensesLedger({ currentUser, expenses, storeConfigs, onChanged, onOpenPayables }: ExpensesLedgerProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;

  const [period, setPeriod] = useState<Period>('ESTE_MES');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const range = useMemo(() => {
    const now = new Date();
    const today = toLocalDateKey(now);
    const month = today.slice(0, 7);
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonth = toLocalDateKey(previous).slice(0, 7);
    if (period === 'ESTE_MES') return { from: `${month}-01`, to: `${month}-31` };
    if (period === 'MES_PASSADO') return { from: `${previousMonth}-01`, to: `${previousMonth}-31` };
    if (period === 'ULTIMOS_30') return { from: toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to: today };
    if (period === 'ESTE_ANO') return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    if (period === 'PERSONALIZADO') return { from: customFrom || '0000-01-01', to: customTo || '9999-12-31' };
    return null;
  }, [period, customFrom, customTo]);

  const categories = useMemo(
    () => Array.from(new Set<string>(expenses.map(expense => expense.category))).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    [expenses]
  );

  const term = search.trim().toLowerCase();
  const visible = expenses
    .filter(expense => stores.length === 0 || stores.some(store => store.unitId === expense.unitId))
    .filter(expense => !storeFilter || expense.unitId === storeFilter)
    .filter(expense => !categoryFilter || expense.category === categoryFilter)
    .filter(expense => {
      if (!range) return true;
      const day = toLocalDateKey(expense.timestamp);
      return day >= range.from && day <= range.to;
    })
    .filter(expense => !term || `${expense.description} ${expense.operatorName}`.toLowerCase().includes(term))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const total = visible.reduce((sum, expense) => sum + expense.amount, 0);

  const remove = async (expense: Expense) => {
    if (!window.confirm(`Apagar a despesa "${expense.description}" (${money(expense.amount)})? Ela sai do Livro caixa e do Lucro Real.`)) return;
    setBusyId(expense.id);
    setError('');
    setMessage('');
    try {
      await supabaseService.deleteExpense(expense.id);
      await onChanged();
      setMessage('Despesa apagada.');
    } catch (removeError) {
      setError(`Não foi possível apagar: ${removeError instanceof Error ? removeError.message : (removeError as { message?: string })?.message || 'erro no banco'}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4 font-sans text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
            <BookOpen className="w-5 h-5 text-blue-600 mr-2" />Livro caixa (Saídas)
          </h3>
          <p className="text-xs text-slate-400">
            Tudo o que saiu do caixa, inclusive as contas a pagar já pagas. Para lançar um gasto, use{' '}
            <button type="button" onClick={onOpenPayables} className="font-bold text-blue-600 hover:underline">Contas a Pagar › Nova conta</button>{' '}
            (opção "Já foi paga").
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Total do filtro</p>
          <p className="text-lg font-black font-mono text-rose-600">{money(total)}</p>
          <p className="text-[10px] text-slate-400 font-semibold">{visible.length} saída{visible.length === 1 ? '' : 's'}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="block font-bold text-slate-500">Período</span>
          <select value={period} onChange={event => setPeriod(event.target.value as Period)} className={inputClass}>
            <option value="ESTE_MES">Este mês</option>
            <option value="MES_PASSADO">Mês passado</option>
            <option value="ULTIMOS_30">Últimos 30 dias</option>
            <option value="ESTE_ANO">Este ano</option>
            <option value="TODOS">Todos</option>
            <option value="PERSONALIZADO">Personalizado</option>
          </select>
        </label>
        {period === 'PERSONALIZADO' && (
          <>
            <label className="space-y-1">
              <span className="block font-bold text-slate-500">De</span>
              <input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} className={inputClass} />
            </label>
            <label className="space-y-1">
              <span className="block font-bold text-slate-500">Até</span>
              <input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} className={inputClass} />
            </label>
          </>
        )}
        {stores.length > 1 && (
          <label className="space-y-1">
            <span className="block font-bold text-slate-500">Loja</span>
            <select value={storeFilter} onChange={event => setStoreFilter(event.target.value)} className={inputClass}>
              <option value="">Todas as lojas</option>
              {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
            </select>
          </label>
        )}
        <label className="space-y-1">
          <span className="block font-bold text-slate-500">Categoria</span>
          <select value={categoryFilter} onChange={event => setCategoryFilter(event.target.value)} className={inputClass}>
            <option value="">Todas</option>
            {categories.map(category => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
        <label className="space-y-1 flex-1 min-w-[180px]">
          <span className="block font-bold text-slate-500">Buscar</span>
          <span className="relative block">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Descrição ou quem lançou" className={`${inputClass} pl-8`} />
          </span>
        </label>
      </div>

      {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
      {message && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{message}</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-slate-600">
          <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
            <tr>
              <th className="px-3 py-2">Data</th>
              {stores.length > 1 && <th className="px-3 py-2">Loja</th>}
              <th className="px-3 py-2">Descrição</th>
              <th className="px-3 py-2">Categoria</th>
              <th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2">Lançado por</th>
              {isAdmin && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map(expense => {
              const payable = isPayable(expense);
              return (
                <tr key={expense.id} className="hover:bg-slate-50/60">
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                    {new Date(expense.timestamp).toLocaleDateString('pt-BR')}
                    {!payable && <span className="block text-[10px] text-slate-400">{new Date(expense.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
                  </td>
                  {stores.length > 1 && <td className="px-3 py-2.5 text-slate-700">{storeName(expense.unitId)}</td>}
                  <td className="px-3 py-2.5 font-medium text-slate-900">
                    {expense.description}
                    {payable && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-bold">Conta a pagar</span>}
                  </td>
                  <td className="px-3 py-2.5"><span className="px-2 py-0.5 bg-rose-50 text-rose-800 rounded text-[10px] font-semibold whitespace-nowrap">{expense.category}</span></td>
                  <td className="px-3 py-2.5 text-right font-mono font-bold text-rose-600 whitespace-nowrap">- {money(expense.amount)}</td>
                  <td className="px-3 py-2.5 text-slate-500">{expense.operatorName}</td>
                  {isAdmin && (
                    <td className="px-3 py-2.5 text-right">
                      {payable ? (
                        <button type="button" onClick={onOpenPayables} title="Desfaça a baixa ou exclua a conta em Contas a Pagar" className="text-[10px] font-bold text-blue-600 hover:underline whitespace-nowrap">
                          Ver em Contas a Pagar
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busyId === expense.id}
                          onClick={() => void remove(expense)}
                          title="Apagar despesa"
                          aria-label="Apagar despesa"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-slate-400">Nenhuma saída neste filtro.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
