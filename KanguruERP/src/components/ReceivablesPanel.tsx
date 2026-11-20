import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Landmark, Percent, X } from 'lucide-react';
import type { PayableBill, Sale, StoreConfig, User } from '../types';
import ValueInput from './ValueInput';
import {
  addDaysKey,
  buildReceivables,
  clearPayoutCheck,
  holidayName,
  listPayoutChecks,
  rulesOf,
  setPayoutCheck,
  todayKey,
  type PayoutCheck,
  type ReceivableEntry,
} from '../db/receivables';
import { listPayableBills } from '../db/payables';

// Recebimentos (desenho aprovado em 2026-11-20): quanto cai na conta e quando, ja sem a taxa
// da maquininha, com conferencia do extrato por dia e loja. Regras em Taxas & Custos Fixos.

interface ReceivablesPanelProps {
  currentUser: User;
  sales: Sale[];
  storeConfigs: StoreConfig[];
  onOpenSettings?: () => void;
}

type Period = 'ESTE_MES' | 'MES_PASSADO' | 'PROXIMOS_7' | 'PERSONALIZADO';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDate = (key: string) => key.split('-').reverse().join('/');
const weekday = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
};
const inputClass = 'w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-blue-500';
const errorText = (error: unknown) => error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco';

interface DayRow {
  key: string;
  payoutDate: string;
  unitId: string;
  pix: number;
  debito: number;
  credito: number;
  refunds: number;
  fees: number;
  net: number;
  entries: ReceivableEntry[];
}

export default function ReceivablesPanel({ sales, storeConfigs, onOpenSettings }: ReceivablesPanelProps) {
  const stores = useMemo(() => storeConfigs.filter(store => store.unitId !== 'central'), [storeConfigs]);
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;
  const today = todayKey();
  const month = today.slice(0, 7);

  const [period, setPeriod] = useState<Period>('ESTE_MES');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [checks, setChecks] = useState<PayoutCheck[]>([]);
  const [payables, setPayables] = useState<PayableBill[]>([]);
  const [checking, setChecking] = useState<DayRow | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const range = useMemo(() => {
    if (period === 'ESTE_MES') return { from: `${month}-01`, to: `${month}-31` };
    if (period === 'MES_PASSADO') {
      const [y, m] = month.split('-').map(Number);
      const prev = new Date(y, m - 2, 1);
      const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
      return { from: `${key}-01`, to: `${key}-31` };
    }
    if (period === 'PROXIMOS_7') return { from: today, to: addDaysKey(today, 6) };
    return { from: customFrom || '2000-01-01', to: customTo || '2100-12-31' };
  }, [period, customFrom, customTo, month, today]);

  const allEntries = useMemo(() => buildReceivables(sales, stores), [sales, stores]);
  const scoped = allEntries.filter(entry => !storeFilter || entry.unitId === storeFilter);

  const loadChecks = useCallback(async () => {
    try {
      const from = range.from < `${month}-01` ? range.from : `${month}-01`;
      const to = range.to > addDaysKey(today, 7) ? range.to : addDaysKey(today, 7);
      setChecks(await listPayoutChecks(from, to));
    } catch {
      setChecks([]); // antes da migration 20261202 a tabela nao existe
    }
  }, [range.from, range.to, month, today]);

  useEffect(() => {
    void loadChecks();
  }, [loadChecks]);

  useEffect(() => {
    listPayableBills().then(setPayables).catch(() => setPayables([]));
  }, []);

  // Cartoes do topo.
  const sumNet = (items: ReceivableEntry[]) => items.reduce((total, entry) => total + entry.net, 0);
  const dueToday = scoped.filter(entry => entry.payoutDate === today);
  const nextDate = scoped.map(entry => entry.payoutDate).filter(key => key > today).sort()[0] ?? null;
  const nextEntries = nextDate ? scoped.filter(entry => entry.payoutDate === nextDate) : [];
  const monthReceived = scoped.filter(entry => entry.payoutDate.startsWith(month) && entry.payoutDate <= today);
  const monthFees = monthReceived.reduce((total, entry) => total + entry.fee, 0);

  // Dias do periodo (por data de repasse e loja).
  const rows = useMemo(() => {
    const map = new Map<string, DayRow>();
    scoped
      .filter(entry => entry.payoutDate >= range.from && entry.payoutDate <= range.to)
      .forEach(entry => {
        const key = `${entry.payoutDate}|${entry.unitId}`;
        const row = map.get(key) ?? { key, payoutDate: entry.payoutDate, unitId: entry.unitId, pix: 0, debito: 0, credito: 0, refunds: 0, fees: 0, net: 0, entries: [] };
        if (entry.isRefund) row.refunds += entry.gross;
        else if (entry.method === 'PIX') row.pix += entry.gross;
        else if (entry.method === 'DEBITO') row.debito += entry.gross;
        else row.credito += entry.gross;
        row.fees += entry.fee;
        row.net += entry.net;
        row.entries.push(entry);
        map.set(key, row);
      });
    return Array.from(map.values()).sort((a, b) => b.payoutDate.localeCompare(a.payoutDate) || a.unitId.localeCompare(b.unitId));
  }, [scoped, range.from, range.to]);

  const totals = rows.reduce((acc, row) => ({
    pix: acc.pix + row.pix, debito: acc.debito + row.debito, credito: acc.credito + row.credito,
    refunds: acc.refunds + row.refunds, fees: acc.fees + row.fees, net: acc.net + row.net,
  }), { pix: 0, debito: 0, credito: 0, refunds: 0, fees: 0, net: 0 });

  const checkOf = (row: DayRow) => checks.find(item => item.unitId === row.unitId && item.payoutDate === row.payoutDate);

  // Entra x sai dos proximos 7 dias.
  const flow = Array.from({ length: 7 }, (_, index) => {
    const day = addDaysKey(today, index);
    const incoming = sumNet(scoped.filter(entry => entry.payoutDate === day));
    const pending = payables.filter(bill => bill.status === 'PENDENTE' && (!storeFilter || bill.unitId === storeFilter));
    const outgoing = pending
      .filter(bill => bill.dueDate === day || (index === 0 && bill.dueDate < today))
      .reduce((total, bill) => total + bill.amount, 0);
    return { day, incoming, outgoing, overdue: index === 0 ? pending.filter(bill => bill.dueDate < today).length : 0 };
  });
  const flowIn = flow.reduce((total, item) => total + item.incoming, 0);
  const flowOut = flow.reduce((total, item) => total + item.outgoing, 0);

  const undoCheck = async (row: DayRow) => {
    if (!window.confirm('Desfazer a conferência deste dia?')) return;
    setError('');
    try {
      await clearPayoutCheck(row.unitId, row.payoutDate);
      setMessage('Conferência desfeita.');
      await loadChecks();
    } catch (undoError) {
      setError(errorText(undoError));
    }
  };

  const cards = [
    { label: 'Cai hoje', value: sumNet(dueToday), sub: `${formatDate(today)}`, icon: Landmark, tone: 'text-emerald-600', iconTone: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
    { label: 'Próximo repasse', value: sumNet(nextEntries), sub: nextDate ? `${weekday(nextDate)}, ${formatDate(nextDate)}` : 'nada previsto', icon: CalendarClock, tone: 'text-blue-600', iconTone: 'bg-blue-50 text-blue-600 border-blue-100' },
    { label: 'Recebido no mês', value: sumNet(monthReceived), sub: 'já sem as taxas', icon: CheckCircle2, tone: 'text-slate-900', iconTone: 'bg-slate-50 text-slate-600 border-slate-200' },
    { label: 'Taxas no mês', value: monthFees, sub: 'maquininha e Pix', icon: Percent, tone: 'text-rose-600', iconTone: 'bg-rose-50 text-rose-600 border-rose-100' },
  ];

  return (
    <div className="space-y-4 font-sans text-xs">
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
            <Landmark className="w-5 h-5 text-blue-600 mr-2" />Recebimentos (cartão e Pix)
          </h3>
          <p className="text-xs text-slate-400">
            Quanto cai na conta e quando, já sem a taxa da maquininha.{' '}
            {onOpenSettings && <button type="button" onClick={onOpenSettings} className="font-bold text-blue-600 hover:underline">Ajustar quando cada loja recebe</button>}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="block font-bold text-slate-500">Período (data do repasse)</span>
            <select value={period} onChange={event => setPeriod(event.target.value as Period)} className={inputClass}>
              <option value="ESTE_MES">Este mês</option>
              <option value="MES_PASSADO">Mês passado</option>
              <option value="PROXIMOS_7">Próximos 7 dias</option>
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
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center justify-between">
              <div>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{card.label}</p>
                <p className={`text-lg font-black mt-1 font-mono ${card.tone}`}>{money(card.value)}</p>
                <p className="text-[10px] text-slate-400 font-semibold">{card.sub}</p>
              </div>
              <span className={`p-2.5 rounded-lg border ${card.iconTone}`}><Icon className="w-5 h-5" /></span>
            </div>
          );
        })}
      </div>

      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Entra × sai nos próximos 7 dias</h4>
          <p className="text-slate-500">
            <span className="font-bold text-emerald-600">entra {money(flowIn)}</span> · <span className="font-bold text-rose-600">sai {money(flowOut)}</span> ·{' '}
            <span className={`font-bold ${flowIn - flowOut >= 0 ? 'text-slate-900' : 'text-rose-600'}`}>saldo {money(flowIn - flowOut)}</span>
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {flow.map(item => {
            const holiday = holidayName(item.day, rulesOf(stores.find(store => store.unitId === (storeFilter || stores[0]?.unitId))));
            return (
              <div key={item.day} className={`rounded-lg border p-2 ${item.day === today ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200'}`}>
                <p className="font-bold text-slate-700 capitalize">{item.day === today ? 'Hoje' : weekday(item.day)} <span className="font-normal text-slate-400">{formatDate(item.day).slice(0, 5)}</span></p>
                {holiday && <p className="text-[10px] text-amber-600 font-semibold truncate" title={holiday}>{holiday}</p>}
                <p className="mt-1 flex items-center gap-1 text-emerald-600 font-mono font-bold"><ArrowDownCircle className="w-3 h-3" />{money(item.incoming)}</p>
                <p className="flex items-center gap-1 text-rose-600 font-mono font-bold"><ArrowUpCircle className="w-3 h-3" />{money(item.outgoing)}</p>
                {item.overdue > 0 && <p className="text-[10px] text-rose-600 font-semibold">inclui {item.overdue} vencida(s)</p>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
        {message && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{message}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-slate-600">
            <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
              <tr>
                <th className="px-3 py-2">Cai em</th>
                {stores.length > 1 && <th className="px-3 py-2">Loja</th>}
                <th className="px-3 py-2 text-right">Pix</th>
                <th className="px-3 py-2 text-right">Débito</th>
                <th className="px-3 py-2 text-right">Crédito</th>
                <th className="px-3 py-2 text-right">Devoluções</th>
                <th className="px-3 py-2 text-right">Taxas</th>
                <th className="px-3 py-2 text-right">Líquido</th>
                <th className="px-3 py-2">Conferência</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(row => {
                const check = checkOf(row);
                const open = expanded === row.key;
                const future = row.payoutDate > today;
                const difference = check ? Math.round((check.receivedAmount - row.net) * 100) / 100 : 0;
                return (
                  <React.Fragment key={row.key}>
                    <tr className="hover:bg-slate-50/60 cursor-pointer" onClick={() => setExpanded(open ? null : row.key)}>
                      <td className="px-3 py-2.5 font-mono font-bold text-slate-800 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                          {formatDate(row.payoutDate)}
                        </span>
                        <span className="block text-[10px] font-sans font-semibold text-slate-400 capitalize">
                          {row.payoutDate === today ? 'hoje' : weekday(row.payoutDate)}{future ? ' · previsto' : ''}
                        </span>
                      </td>
                      {stores.length > 1 && <td className="px-3 py-2.5 text-slate-700">{storeName(row.unitId)}</td>}
                      <td className="px-3 py-2.5 text-right font-mono">{row.pix ? money(row.pix) : '-'}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{row.debito ? money(row.debito) : '-'}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{row.credito ? money(row.credito) : '-'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-rose-600">{row.refunds ? money(row.refunds) : '-'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-rose-600">{row.fees ? `- ${money(row.fees)}` : '-'}</td>
                      <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-900">{money(row.net)}</td>
                      <td className="px-3 py-2.5" onClick={event => event.stopPropagation()}>
                        {check ? (
                          <div className="space-y-0.5">
                            <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${difference === 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                              {difference === 0 ? 'Conferido' : `Conferido · diferença ${difference > 0 ? '+' : ''}${money(difference)}`}
                            </span>
                            <span className="block text-[10px] text-slate-400">
                              caiu {money(check.receivedAmount)}{check.checkedByName ? ` · ${check.checkedByName}` : ''}{' '}
                              <button type="button" onClick={() => void undoCheck(row)} className="font-bold text-blue-600 hover:underline">desfazer</button>
                            </span>
                            {check.note && <span className="block text-[10px] text-slate-500">{check.note}</span>}
                          </div>
                        ) : future ? (
                          <span className="text-[10px] text-slate-400">ainda não caiu</span>
                        ) : (
                          <button type="button" onClick={() => setChecking(row)} className="px-2.5 py-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 font-bold text-slate-700">Conferir</button>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/70">
                        <td colSpan={stores.length > 1 ? 9 : 8} className="px-4 py-2">
                          <table className="w-full text-[11px]">
                            <thead className="text-slate-400">
                              <tr>
                                <th className="py-1 text-left font-semibold">Venda</th>
                                <th className="py-1 text-left font-semibold">Data da venda</th>
                                <th className="py-1 text-left font-semibold">Forma</th>
                                <th className="py-1 text-right font-semibold">Valor</th>
                                <th className="py-1 text-right font-semibold">Taxa</th>
                                <th className="py-1 text-right font-semibold">Líquido</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.entries.map((entry, index) => (
                                <tr key={`${entry.saleId}-${index}`} className="border-t border-slate-200/70">
                                  <td className="py-1 text-slate-800">{entry.saleLabel}</td>
                                  <td className="py-1 font-mono">{formatDate(entry.saleDate)}</td>
                                  <td className="py-1">
                                    {entry.isRefund ? 'Estorno ' : ''}{entry.method === 'PIX' ? 'Pix' : entry.method === 'DEBITO' ? 'Débito' : 'Crédito'}
                                    {entry.installment ? ` (parcela ${entry.installment})` : ''}
                                  </td>
                                  <td className="py-1 text-right font-mono">{money(entry.gross)}</td>
                                  <td className="py-1 text-right font-mono text-rose-600">{entry.fee ? `- ${money(entry.fee)}` : '-'}</td>
                                  <td className="py-1 text-right font-mono font-bold">{money(entry.net)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="py-10 text-center text-slate-400">Nenhum recebimento em cartão ou Pix neste período.</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="bg-slate-50 font-bold text-slate-800">
                  <td className="px-3 py-2" colSpan={stores.length > 1 ? 2 : 1}>Total</td>
                  <td className="px-3 py-2 text-right font-mono">{money(totals.pix)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(totals.debito)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(totals.credito)}</td>
                  <td className="px-3 py-2 text-right font-mono text-rose-600">{money(totals.refunds)}</td>
                  <td className="px-3 py-2 text-right font-mono text-rose-600">- {money(totals.fees)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(totals.net)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {checking && (
        <CheckModal
          row={checking}
          storeLabel={storeName(checking.unitId)}
          onClose={() => setChecking(null)}
          onSaved={async () => {
            setChecking(null);
            setError('');
            setMessage('Dia conferido.');
            await loadChecks();
          }}
        />
      )}
    </div>
  );
}

function CheckModal({ row, storeLabel, onClose, onSaved }: { row: DayRow; storeLabel: string; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const expected = Math.round(row.net * 100) / 100;
  const [received, setReceived] = useState<number | null>(expected);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const difference = received != null ? Math.round((received - expected) * 100) / 100 : 0;

  const save = async () => {
    if (received == null) return setError('Informe quanto caiu na conta.');
    setSaving(true);
    setError('');
    try {
      await setPayoutCheck(row.unitId, row.payoutDate, expected, received, note.trim());
      await onSaved();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="bg-white w-full max-w-md rounded-xl shadow-xl border border-slate-200 overflow-hidden text-xs">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50">
          <h3 className="text-sm font-bold text-slate-900">Conferir com o extrato</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
            <p className="font-bold text-slate-900">{formatDate(row.payoutDate)} · {storeLabel}</p>
            <p className="text-slate-500">Previsto: <span className="font-mono font-bold text-slate-800">{money(expected)}</span> (já sem {money(row.fees)} de taxas)</p>
          </div>
          {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Quanto caiu na conta (R$)</span>
            <ValueInput value={received} onValueChange={setReceived} className={`${inputClass} font-mono`} />
          </label>
          {difference !== 0 && (
            <p className={`font-semibold ${difference < 0 ? 'text-rose-600' : 'text-amber-600'}`}>
              {difference < 0
                ? `Caiu ${money(-difference)} a menos que o previsto: confira taxa cobrada a mais ou venda faltando.`
                : `Caiu ${money(difference)} a mais que o previsto.`}
            </p>
          )}
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Observação</span>
            <input value={note} onChange={event => setNote(event.target.value)} maxLength={300} placeholder="Opcional" className={inputClass} />
          </label>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">Cancelar</button>
            <button type="button" disabled={saving} onClick={() => void save()} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50">
              {saving ? 'Salvando...' : 'Marcar como conferido'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
