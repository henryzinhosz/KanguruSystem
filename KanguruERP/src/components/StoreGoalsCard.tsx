import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import { formatMoney } from '../db/finance';
import { getMyStoreGoals, monthKey, monthProjection, type StoreGoalRow } from '../db/insights';

// Meta do mes de cada loja, definida pela rede (Painel da Rede › Metas). Sem meta = nao aparece.

export const goalTone = (percent: number) => (percent >= 100 ? 'bg-emerald-500' : percent >= 70 ? 'bg-amber-400' : 'bg-rose-500');

export function GoalBar({ realized, goal }: { realized: number; goal: number }) {
  const percent = goal > 0 ? (realized / goal) * 100 : 0;
  return (
    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
      <div className={`h-full rounded-full ${goalTone(percent)}`} style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

export default function StoreGoalsCard() {
  const [rows, setRows] = useState<StoreGoalRow[]>([]);
  const month = monthKey();

  useEffect(() => {
    // Antes da migration 20261119 (ou sem rede/meta) o card simplesmente nao aparece.
    getMyStoreGoals(month).then(setRows).catch(() => setRows([]));
  }, [month]);

  if (rows.length === 0) return null;
  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-4 text-xs space-y-3">
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 text-blue-600" />
        <h4 className="text-sm font-bold text-slate-900">Meta do mês</h4>
        <span className="text-slate-500">definida pela rede · faturamento menos devoluções</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map(row => {
          const goal = row.goal ?? 0;
          const percent = goal > 0 ? (row.realized / goal) * 100 : 0;
          const projection = monthProjection(row.realized, month);
          return (
            <div key={row.unitId} className="rounded-lg border border-slate-200 p-3 space-y-1.5">
              <div className="flex justify-between gap-2">
                <strong className="text-slate-900">{row.storeName}</strong>
                <strong className="text-slate-900">{percent.toFixed(0)}%</strong>
              </div>
              <GoalBar realized={row.realized} goal={goal} />
              <p className="text-slate-500">
                {formatMoney(row.realized)} de {formatMoney(goal)}
                {projection !== null && ` · projeção ${formatMoney(projection)}`}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
