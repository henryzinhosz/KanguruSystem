import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Pencil, Percent, Target, TrendingUp, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatMoney, shiftMonthKey, toLocalDateKey } from '../db/finance';
import { getNetworkGoals, saveNetworkGoals } from '../db/network';
import { monthProjection, type StoreGoalRow } from '../db/insights';
import ValueInput from './ValueInput';
import { Dropdown } from './NetworkFilters';
import { GoalBar } from './StoreGoalsCard';

// Painel da Rede › Metas (desenho aprovado em 2026-11-03): meta de faturamento por LOJA e mes,
// realizado (bruto - devolucoes, mesma base do repasse), % e projecao pelo ritmo do mes.

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const monthName = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} de ${key.slice(0, 4)}`;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Erro ao salvar.';
const keyOf = (row: StoreGoalRow) => `${row.tenantId}|${row.unitId}`;

export default function NetworkGoals() {
  const currentMonth = toLocalDateKey(new Date()).slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [rows, setRows] = useState<StoreGoalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [drafts, setDrafts] = useState<Record<string, number | null> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setRows(await getNetworkGoals(month));
    } catch (loadError) {
      setError(`Não foi possível carregar as metas: ${errorText(loadError)}. Confira se a migration 20261119 foi aplicada.`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setDrafts(null);
    setMessage('');
    void load();
  }, [month]);

  const monthOptions = Array.from({ length: 14 }, (_, index) => shiftMonthKey(currentMonth, 1 - index)).map(key => ({
    value: key,
    label: key === currentMonth ? `${monthName(key)} (atual)` : monthName(key),
  }));

  const startEditing = (fill?: (row: StoreGoalRow) => number | null) => {
    setMessage('');
    setDrafts(Object.fromEntries(rows.map(row => [keyOf(row), fill ? fill(row) : row.goal])));
  };

  const applyGrowth = () => {
    const answer = window.prompt('Meta = faturamento do mesmo mês do ano passado + quantos %? (ex.: 10)');
    if (answer === null) return;
    const percent = Number(answer.replace(',', '.'));
    if (!Number.isFinite(percent)) return;
    startEditing(row => (row.lastYearRealized > 0 ? Math.round(row.lastYearRealized * (1 + percent / 100)) : row.goal));
  };

  const save = async () => {
    if (!drafts) return;
    setBusy(true);
    setError('');
    try {
      await saveNetworkGoals(month, rows.map(row => ({ tenantId: row.tenantId, unitId: row.unitId, amount: drafts[keyOf(row)] ?? null })));
      setDrafts(null);
      setMessage(`Metas de ${monthName(month)} salvas.`);
      await load();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setBusy(false);
    }
  };

  const withGoal = rows.filter(row => row.goal);
  const totalGoal = withGoal.reduce((sum, row) => sum + (row.goal ?? 0), 0);
  const totalRealized = withGoal.reduce((sum, row) => sum + row.realized, 0);
  const totalProjection = monthProjection(totalRealized, month);
  const percent = totalGoal > 0 ? (totalRealized / totalGoal) * 100 : 0;

  // Agrupa por franquia, na ordem que veio do servidor.
  const franchises = rows.reduce<{ tenantId: string; name: string; stores: StoreGoalRow[] }[]>((groups, row) => {
    const group = groups.find(item => item.tenantId === row.tenantId);
    if (group) group.stores.push(row);
    else groups.push({ tenantId: row.tenantId, name: row.franchiseName, stores: [row] });
    return groups;
  }, []);

  return (
    <div className="space-y-4 text-xs">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-3 flex flex-wrap items-center gap-2">
        <Dropdown label="Mês" value={month} options={monthOptions} onChange={setMonth} />
        <span className="text-slate-500">Realizado = faturamento bruto menos devoluções (mesma base do repasse).</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {drafts ? (
            <>
              <button type="button" onClick={() => setDrafts(null)} className="h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold inline-flex items-center gap-1.5"><X className="w-4 h-4" />Cancelar</button>
              <button type="button" onClick={() => void save()} disabled={busy} className="h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold inline-flex items-center gap-1.5 disabled:opacity-50"><CheckCircle2 className="w-4 h-4" />{busy ? 'Salvando...' : 'Salvar metas'}</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => startEditing(row => row.previousGoal)} disabled={rows.length === 0} className="h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"><Copy className="w-4 h-4" />Copiar do mês anterior</button>
              <button type="button" onClick={applyGrowth} disabled={rows.length === 0} className="h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"><Percent className="w-4 h-4" />+% sobre o ano anterior</button>
              <button type="button" onClick={() => startEditing()} disabled={rows.length === 0} className="h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold inline-flex items-center gap-1.5 disabled:opacity-50"><Pencil className="w-4 h-4" />Editar metas</button>
            </>
          )}
        </div>
      </div>

      {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {message && <p className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{message}</p>}
      {drafts && <p className="text-blue-800 bg-blue-50 border border-blue-200 rounded-lg p-3">Editando as metas de {monthName(month)}. Loja com meta vazia fica sem meta. Confira e clique em Salvar metas.</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Card label="Meta da rede no mês" value={formatMoney(totalGoal)} icon={Target} tone="bg-blue-50 text-blue-600 border-blue-100/80" />
        <Card label="Realizado (lojas com meta)" value={formatMoney(totalRealized)} icon={TrendingUp} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" />
        <Card label="Atingido" value={`${percent.toFixed(0)}%`} icon={CheckCircle2} tone="bg-slate-100 text-slate-600 border-slate-200" />
        <Card label={totalProjection !== null ? 'Projeção do mês' : 'Lojas com meta'} value={totalProjection !== null ? formatMoney(totalProjection) : `${withGoal.length} de ${rows.length}`} icon={TrendingUp} tone="bg-amber-50 text-amber-600 border-amber-100/80" />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 text-left">
              <tr>
                <th className="p-2 pl-4">Loja</th>
                <th className="p-2 text-right w-44">Meta</th>
                <th className="p-2 text-right">Realizado</th>
                <th className="p-2 w-48">Atingido</th>
                <th className="p-2 text-right">{month === currentMonth ? 'Projeção' : ''}</th>
                <th className="p-2 pr-4 text-right">Mesmo mês ano passado</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="p-6 text-center text-slate-400">Carregando...</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-400">Nenhuma loja na rede.</td></tr>}
              {!loading && franchises.map(franchise => [
                <tr key={franchise.tenantId} className="bg-slate-50/60 border-t border-slate-200"><td colSpan={6} className="px-4 py-2 font-bold text-slate-700">{franchise.name}</td></tr>,
                ...franchise.stores.map(row => {
                  const goal = row.goal ?? 0;
                  const rowPercent = goal > 0 ? (row.realized / goal) * 100 : null;
                  const projection = monthProjection(row.realized, month);
                  return (
                    <tr key={keyOf(row)} className="border-t border-slate-100">
                      <td className="p-2 pl-4 font-semibold text-slate-800">{row.storeName}</td>
                      <td className="p-2 text-right font-mono">
                        {drafts ? (
                          <ValueInput value={drafts[keyOf(row)] ?? null} onValueChange={value => setDrafts(current => ({ ...current!, [keyOf(row)]: value }))} className="w-40 border border-slate-200 rounded-lg p-1.5 text-right bg-white" />
                        ) : row.goal ? formatMoney(row.goal) : <span className="text-slate-400 font-sans">sem meta</span>}
                      </td>
                      <td className="p-2 text-right font-mono font-bold">{formatMoney(row.realized)}</td>
                      <td className="p-2">
                        {rowPercent !== null ? (
                          <div className="flex items-center gap-2"><div className="flex-1"><GoalBar realized={row.realized} goal={goal} /></div><span className="w-10 text-right font-bold">{rowPercent.toFixed(0)}%</span></div>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="p-2 text-right font-mono text-slate-600">{projection !== null && goal > 0 ? formatMoney(projection) : ''}</td>
                      <td className="p-2 pr-4 text-right font-mono text-slate-500">{row.lastYearRealized > 0 ? formatMoney(row.lastYearRealized) : '—'}</td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, icon: Icon, tone }: { label: string; value: string; icon: LucideIcon; tone: string }) {
  return (
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
      <div className={`p-2.5 rounded-lg shrink-0 border ${tone}`}><Icon className="w-5 h-5" /></div>
      <div className="min-w-0">
        <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">{label}</span>
        <span className="text-lg font-extrabold tracking-tight text-slate-900 block truncate">{value}</span>
      </div>
    </div>
  );
}
