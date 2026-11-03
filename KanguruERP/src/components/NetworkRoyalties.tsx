import { FormEvent, Fragment, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Landmark, Plus, Printer, Settings2, Trash2, Undo2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatMoney, shiftMonthKey, toLocalDateKey } from '../db/finance';
import { getRoyaltyReport, saveRoyaltyRule, setRoyaltyPaid, type RoyaltyReportRow, type RoyaltyRule, type RoyaltyTier } from '../db/network';
import ValueInput from './ValueInput';
import { Dropdown } from './NetworkFilters';

// Painel da Rede, etapa 3: repasse (royalties) de cada franquia por mes.
// Base = faturamento bruto (produtos + servicos) - devolucoes; regra por franquia
// (percentual ou faixas, o mes inteiro cai numa faixa so). Calculado no servidor.

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const monthName = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} de ${key.slice(0, 4)}`;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Erro ao salvar.';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

const ruleModeLabel = (rule: RoyaltyRule | null) => (!rule ? 'Sem regra' : rule.mode === 'TIERS' ? 'Faixa de faturamento' : 'Percentual fixo');

export function describeRule(rule: RoyaltyRule | null): string {
  if (!rule) return 'Sem regra';
  if (rule.mode === 'PERCENT') return `${Number(rule.percent ?? 0).toLocaleString('pt-BR')}% do faturamento`;
  const tiers = [...(rule.tiers || [])].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  let previous = 0;
  return tiers.map(tier => {
    const range = tier.upTo == null ? `acima de ${formatMoney(previous)}` : `até ${formatMoney(tier.upTo)}`;
    if (tier.upTo != null) previous = tier.upTo;
    return `${range}: ${tier.type === 'FIXED' ? formatMoney(tier.value) : `${Number(tier.value).toLocaleString('pt-BR')}%`}`;
  }).join(' · ');
}

export default function NetworkRoyalties({ networkName }: { networkName: string }) {
  const currentMonth = toLocalDateKey(new Date()).slice(0, 7);
  const [month, setMonth] = useState(shiftMonthKey(currentMonth, -1));
  const [rows, setRows] = useState<RoyaltyReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<RoyaltyReportRow | null>(null);
  const [paying, setPaying] = useState<RoyaltyReportRow | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setRows(await getRoyaltyReport(month));
    } catch (loadError) {
      setError(`Não foi possível carregar o repasse: ${errorText(loadError)}. Confira se a migration 20261117 foi aplicada.`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [month]);

  const total = rows.reduce((sum, row) => sum + row.royalty, 0);
  const paid = rows.filter(row => row.paid).reduce((sum, row) => sum + row.royalty, 0);
  const pending = rows.filter(row => !row.paid && row.rule).reduce((sum, row) => sum + row.royalty, 0);
  const base = rows.reduce((sum, row) => sum + row.base, 0);
  const monthOptions = Array.from({ length: 13 }, (_, index) => shiftMonthKey(currentMonth, -index)).map(key => ({
    value: key,
    label: key === currentMonth ? `${monthName(key)} (parcial)` : monthName(key),
  }));

  const undoPayment = async (row: RoyaltyReportRow) => {
    if (!window.confirm(`Desfazer o pagamento de ${row.name} em ${monthName(month)}?`)) return;
    try {
      await setRoyaltyPaid(row.tenantId, month, false);
      setMessage('Pagamento desfeito.');
      await load();
    } catch (actionError) {
      setError(errorText(actionError));
    }
  };

  const printReport = () => {
    const lines = rows.map(row => `<tr><td>${escapeHtml(row.name)}<br/><small>${escapeHtml(describeRule(row.paidRule || row.rule))}</small></td>
      <td class="num">${formatMoney(row.base)}</td><td class="num">${formatMoney(row.royalty)}</td>
      <td>${row.paid ? `Pago em ${new Date(`${row.paidAt}T12:00:00`).toLocaleDateString('pt-BR')}` : row.rule ? 'Pendente' : 'Sem regra'}</td></tr>`).join('');
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><title>Repasse ${monthName(month)}</title>
      <style>@page{size:A4;margin:14mm}body{font-family:Arial,sans-serif;font-size:11px;color:#111}h1{font-size:16px;margin:0}
      table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border-bottom:1px solid #ddd;padding:5px;text-align:left;vertical-align:top}
      th{font-size:9px;text-transform:uppercase;color:#555}.num{text-align:right;white-space:nowrap}small{color:#666}tfoot td{font-weight:bold}</style></head>
      <body><h1>Repasse das franquias — ${escapeHtml(networkName)}</h1><div>${monthName(month)} · base = faturamento bruto (produtos + serviços) menos devoluções</div>
      <table><thead><tr><th>Franquia / regra</th><th class="num">Base</th><th class="num">Repasse</th><th>Situação</th></tr></thead><tbody>${lines}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${formatMoney(base)}</td><td class="num">${formatMoney(total)}</td><td>Pago ${formatMoney(paid)} · Pendente ${formatMoney(pending)}</td></tr></tfoot></table>
      <p><small>Emitido em ${new Date().toLocaleString('pt-BR')}</small></p></body></html>`;
    const frame = document.createElement('iframe');
    Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0' });
    document.body.appendChild(frame);
    frame.contentDocument?.open();
    frame.contentDocument?.write(html);
    frame.contentDocument?.close();
    setTimeout(() => {
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 60000);
    }, 100);
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-3 flex flex-wrap items-center gap-2">
        <Dropdown label="Mês" value={month} options={monthOptions} onChange={setMonth} />
        <span className="text-slate-500">Base: faturamento bruto (produtos + serviços) menos devoluções, antes de taxas e despesas.</span>
        <button type="button" onClick={() => setEditing(rows.find(row => !row.rule) ?? rows[0])} disabled={rows.length === 0} className="ml-auto h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"><Settings2 className="w-4 h-4" />Configurações</button>
        <button type="button" onClick={printReport} disabled={rows.length === 0} className="h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"><Printer className="w-4 h-4" />Imprimir</button>
      </div>

      {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {message && <p className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{message}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Card label="Faturamento base da rede" value={formatMoney(base)} icon={Landmark} tone="bg-slate-100 text-slate-600 border-slate-200" />
        <Card label="Repasse do mês" value={formatMoney(total)} icon={Landmark} tone="bg-blue-50 text-blue-600 border-blue-100/80" />
        <Card label="Pago" value={formatMoney(paid)} icon={CheckCircle2} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" />
        <Card label="Pendente" value={formatMoney(pending)} icon={Clock} tone="bg-amber-50 text-amber-600 border-amber-100/80" />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <h4 className="text-sm font-bold text-slate-900">Repasse por franquia · {monthName(month)}</h4>
          {month === currentMonth && <p className="text-amber-700">Mês em andamento: os valores ainda vão mudar.</p>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 text-left">
              <tr><th className="p-2">Franquia</th><th className="p-2">Regra</th><th className="p-2 text-right">Base do mês</th><th className="p-2 text-right">Repasse</th><th className="p-2">Situação</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.tenantId} className="border-t border-slate-100">
                  <td className="p-2"><span className="font-bold text-slate-900">{row.name}</span>{row.ownerName && <span className="block text-slate-500">{row.ownerName}</span>}</td>
                  <td className="p-2 text-slate-600" title={describeRule(row.paid ? row.paidRule : row.rule)}>{ruleModeLabel(row.paid ? row.paidRule : row.rule)}</td>
                  <td className="p-2 text-right font-mono">{formatMoney(row.base)}</td>
                  <td className="p-2 text-right font-mono font-bold">{formatMoney(row.royalty)}</td>
                  <td className="p-2">
                    {row.paid
                      ? <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold" title={[row.notes, row.markedByName && `por ${row.markedByName}`].filter(Boolean).join(' · ')}>Pago em {new Date(`${row.paidAt}T12:00:00`).toLocaleDateString('pt-BR')}</span>
                      : row.rule ? <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-bold">Pendente</span>
                        : <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-500 font-bold">Sem regra</span>}
                  </td>
                  <td className="p-2">
                    <div className="flex justify-end gap-2 whitespace-nowrap">
                      {row.paid
                        ? <button type="button" onClick={() => void undoPayment(row)} className="inline-flex items-center gap-1 font-bold text-slate-600 hover:underline"><Undo2 className="w-3.5 h-3.5" />Desfazer</button>
                        : row.rule && month !== currentMonth && <button type="button" onClick={() => setPaying(row)} className="inline-flex items-center gap-1 font-bold text-emerald-700 hover:underline"><CheckCircle2 className="w-3.5 h-3.5" />Marcar pago</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && <tr><td colSpan={6} className="p-6 text-center text-slate-400">Nenhuma franquia na rede.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
          <Fragment key={editing.tenantId}>
          <RuleModal
            row={editing}
            rows={rows}
            onPick={setEditing}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              setMessage('Regra de repasse salva.');
              await load();
            }}
        />
        </Fragment>
      )}
      {paying && (
        <PayModal
          row={paying}
          monthLabel={monthName(month)}
          onClose={() => setPaying(null)}
          onConfirm={async (paidAt, notes) => {
            await setRoyaltyPaid(paying.tenantId, month, true, paidAt, notes);
            setPaying(null);
            setMessage(`Repasse de ${paying.name} marcado como pago.`);
            await load();
          }}
        />
      )}
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

function RuleModal({ row, rows, onPick, onClose, onSaved }: { row: RoyaltyReportRow; rows: RoyaltyReportRow[]; onPick: (row: RoyaltyReportRow) => void; onClose: () => void; onSaved: () => Promise<void> }) {
  const [mode, setMode] = useState<'PERCENT' | 'TIERS'>(row.rule?.mode ?? 'PERCENT');
  const [percent, setPercent] = useState<number | null>(row.rule?.percent ?? null);
  const [tiers, setTiers] = useState<RoyaltyTier[]>(() => row.rule?.tiers?.length
    ? [...row.rule.tiers].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity))
    : [{ upTo: 130000, type: 'FIXED', value: 0 }, { upTo: null, type: 'FIXED', value: 0 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const updateTier = (index: number, patch: Partial<RoyaltyTier>) => setTiers(current => current.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const limits = tiers.filter(tier => tier.upTo != null).map(tier => tier.upTo as number);
    if (mode === 'TIERS' && limits.some((limit, i) => limit <= 0 || (i > 0 && limit <= limits[i - 1]))) {
      setError('Preencha os limites das faixas em ordem crescente (cada "até" maior que o anterior).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveRoyaltyRule(row.tenantId, mode === 'PERCENT' ? { mode, percent: percent ?? 0, tiers: null } : { mode, percent: null, tiers });
      await onSaved();
    } catch (saveError) {
      setError(errorText(saveError));
      setBusy(false);
    }
  };

  // Ordem da tela fixa enquanto digita (reordenar a cada tecla tirava o foco do campo); "acima de" sempre por ultimo.
  const ordered = [
    ...tiers.map((tier, index) => ({ tier, index })).filter(item => item.tier.upTo != null),
    ...tiers.map((tier, index) => ({ tier, index })).filter(item => item.tier.upTo == null),
  ];
  const highestLimit = Math.max(0, ...tiers.map(tier => tier.upTo ?? 0));
  const input = 'w-full border border-slate-200 rounded-lg p-2 bg-white';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-xl shadow-xl w-full max-w-xl text-xs">
        <div className="p-4 border-b border-slate-100 flex justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Configurações do repasse</h3>
            <p className="text-slate-500">Vale para os meses ainda não marcados como pagos.</p>
            {rows.length > 1
              ? <select value={row.tenantId} onChange={event => { const next = rows.find(item => item.tenantId === event.target.value); if (next) onPick(next); }} className="mt-2 border border-slate-200 rounded-lg p-2 bg-white font-bold text-slate-800">
                  {rows.map(item => <option key={item.tenantId} value={item.tenantId}>{item.name}{item.rule ? '' : ' (sem regra)'}</option>)}
                </select>
              : <p className="mt-1 font-bold text-slate-800">{row.name}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar"><X className="w-5 h-5 text-slate-400" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {([['PERCENT', 'Percentual fixo', 'Ex.: 5% de todo o faturamento'], ['TIERS', 'Faixas de faturamento', 'O mês inteiro cai numa faixa']] as const).map(([value, label, hint]) => (
              <button key={value} type="button" onClick={() => setMode(value)} className={`p-3 rounded-lg border text-left ${mode === value ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200' : 'border-slate-200 hover:bg-slate-50'}`}>
                <span className="block font-bold text-slate-900">{label}</span><span className="text-slate-500">{hint}</span>
              </button>
            ))}
          </div>
          {mode === 'PERCENT' ? (
            <label className="block font-bold text-slate-700">Percentual sobre o faturamento (%)
              <ValueInput value={percent} onValueChange={setPercent} className={`mt-1 ${input}`} />
            </label>
          ) : (
            <div className="space-y-2">
              {ordered.map(({ tier, index }, position) => {
                const previous = tier.upTo == null ? highestLimit : position > 0 ? ordered[position - 1].tier.upTo : 0;
                return (
                  <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                    <label className="font-bold text-slate-600">{tier.upTo == null ? 'Acima de' : `De ${formatMoney((previous ?? 0) + (position > 0 ? 0.01 : 0))} até`}
                      {tier.upTo == null
                        ? <span className="mt-1 block p-2 rounded-lg bg-slate-50 border border-slate-200">{formatMoney(previous ?? 0)}</span>
                        : <ValueInput value={tier.upTo} onValueChange={value => updateTier(index, { upTo: value ?? 0 })} className={`mt-1 ${input}`} />}
                    </label>
                    <label className="font-bold text-slate-600">Cobra
                      <select value={tier.type} onChange={event => updateTier(index, { type: event.target.value as RoyaltyTier['type'] })} className={`mt-1 ${input}`}>
                        <option value="FIXED">Valor fixo (R$)</option>
                        <option value="PERCENT">Percentual (%)</option>
                      </select>
                    </label>
                    <label className="font-bold text-slate-600">{tier.type === 'FIXED' ? 'Valor (R$)' : 'Percentual (%)'}
                      <ValueInput value={tier.value || null} onValueChange={value => updateTier(index, { value: value ?? 0 })} className={`mt-1 ${input}`} />
                    </label>
                    <button type="button" disabled={tiers.length <= 1} onClick={() => setTiers(current => current.filter((_, i) => i !== index))} className="p-2 text-rose-600 disabled:opacity-30" title="Remover faixa"><Trash2 className="w-4 h-4" /></button>
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={() => {
                  const limits = tiers.filter(tier => tier.upTo != null).map(tier => tier.upTo as number);
                  const next = (limits.length ? Math.max(...limits) : 0) + 50000;
                  setTiers(current => [...current, { upTo: next, type: 'FIXED', value: 0 }]);
                }} className="inline-flex items-center gap-1 font-bold text-blue-700 hover:underline"><Plus className="w-3.5 h-3.5" />Adicionar faixa</button>
                {!tiers.some(tier => tier.upTo == null) && (
                  <button type="button" onClick={() => setTiers(current => [...current, { upTo: null, type: 'FIXED', value: 0 }])} className="inline-flex items-center gap-1 font-bold text-blue-700 hover:underline"><Plus className="w-3.5 h-3.5" />Adicionar "acima de"</button>
                )}
              </div>
              <p className="text-slate-500">Exemplo: até R$ 130.000,00 cobra R$ 2.000,00; até R$ 200.000,00 cobra R$ 3.000,00; acima disso cobra 2%.</p>
            </div>
          )}
          {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</p>}
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 font-bold text-slate-600">Cancelar</button>
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">{busy ? 'Salvando...' : 'Salvar regra'}</button>
        </div>
      </form>
    </div>
  );
}

function PayModal({ row, monthLabel, onClose, onConfirm }: { row: RoyaltyReportRow; monthLabel: string; onClose: () => void; onConfirm: (paidAt: string, notes: string) => Promise<void> }) {
  const [paidAt, setPaidAt] = useState(toLocalDateKey(new Date()));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onConfirm(paidAt, notes);
    } catch (confirmError) {
      setError(errorText(confirmError));
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-xl shadow-xl w-full max-w-md text-xs">
        <div className="p-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900">Marcar repasse como pago</h3>
          <p className="text-slate-500">{row.name} · {monthLabel} · <strong>{formatMoney(row.royalty)}</strong></p>
        </div>
        <div className="p-4 space-y-3">
          <label className="block font-bold text-slate-700">Data do pagamento<input type="date" value={paidAt} onChange={event => setPaidAt(event.target.value)} className="mt-1 w-full border border-slate-200 rounded-lg p-2" required /></label>
          <label className="block font-bold text-slate-700">Observação (opcional)<input value={notes} onChange={event => setNotes(event.target.value)} placeholder="Ex.: Pix, comprovante nº..." className="mt-1 w-full border border-slate-200 rounded-lg p-2" /></label>
          <p className="text-slate-500">O valor e a regra de hoje ficam guardados para este mês, mesmo se a regra mudar depois.</p>
          {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</p>}
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 font-bold text-slate-600">Cancelar</button>
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50">{busy ? 'Salvando...' : 'Confirmar pagamento'}</button>
        </div>
      </form>
    </div>
  );
}
