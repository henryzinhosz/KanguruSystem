import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import ValueInput from './ValueInput';
import { platformGetAgency, platformSaveAgency, type PlatformAgency } from '../db/agency';

// UCP › ficha do cliente › Agencia de IA: liga/desliga, limite mensal e uso (custo em US$).

const inputClass = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';
const message = (error: unknown, fallback: string) => (error as { message?: string })?.message || fallback;
const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function AgencyAdminPanel({ tenantId }: { tenantId: string }) {
  const [agency, setAgency] = useState<PlatformAgency | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [limit, setLimit] = useState<number | null>(300);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const next = await platformGetAgency(tenantId);
    setAgency(next);
    setEnabled(next.enabled);
    setLimit(next.limit);
  };

  useEffect(() => {
    setAgency(null);
    setError('');
    setNotice('');
    load().catch(loadError => setError(message(loadError, 'Não foi possível carregar a Agência. Confira se a migration 20261211 foi aplicada.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const save = async () => {
    if (limit == null) {
      setError('Informe o limite de perguntas por mês.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await platformSaveAgency(tenantId, enabled, limit);
      await load();
      setNotice('Agência salva.');
    } catch (saveError) {
      setError(message(saveError, 'Não foi possível salvar.'));
    } finally {
      setBusy(false);
    }
  };

  if (!agency) {
    return (
      <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-5 text-sm text-slate-500">
        {error || 'Carregando Agência...'}
      </section>
    );
  }

  const average = agency.used > 0 ? agency.costUsd / agency.used : 0;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">{error}</p>}
      {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{notice}</p>}

      <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-5">
        <h3 className="font-bold text-slate-900 flex items-center gap-2"><Sparkles className="w-4 h-4 text-orange-500" />Agência de IA</h3>
        <p className="mt-1 text-sm text-slate-600">Inclusa no plano. O limite conta as perguntas respondidas por mês (a empresa inteira).</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-bold uppercase text-slate-500">Perguntas no mês</p>
            <p className="mt-1 font-mono text-lg font-bold text-slate-900">{agency.used}/{agency.limit}</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-bold uppercase text-slate-500">Custo no mês</p>
            <p className="mt-1 font-mono text-lg font-bold text-slate-900">{usd(agency.costUsd)}</p>
            <p className="text-xs text-slate-500">Média {usd(average)} por pergunta</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-bold uppercase text-slate-500">Pessoas que usaram</p>
            <p className="mt-1 font-mono text-lg font-bold text-slate-900">{agency.people}</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-bold uppercase text-slate-500">Mês passado</p>
            <p className="mt-1 font-mono text-lg font-bold text-slate-900">{agency.lastMonthUsed}</p>
            <p className="text-xs text-slate-500">{usd(agency.lastMonthCostUsd)}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[auto_200px_auto] sm:items-end">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
            Agência ligada para este cliente
          </label>
          <label className="text-xs font-bold text-slate-700">Limite de perguntas por mês
            <ValueInput decimals={0} value={limit} placeholder="300" onValueChange={value => setLimit(value)} className={inputClass} />
          </label>
          <div>
            <button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Salvando...' : 'Salvar'}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
