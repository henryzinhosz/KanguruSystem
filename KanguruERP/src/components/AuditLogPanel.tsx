import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, History, Monitor, RefreshCw, Search } from 'lucide-react';
import type { StoreConfig } from '../types';
import {
  AREA_LABELS,
  POS_CATEGORY_LABELS,
  POS_CONTEXT_LABELS,
  auditActionText,
  fieldLabel,
  formatAuditValue,
  listAuditLog,
  listPosSensitiveActions,
  type AuditArea,
  type AuditEntry,
  type PosCategory,
  type PosSensitiveAction,
} from '../db/auditLog';

// Registro de acoes (desenho aprovado em 2026-11-22): so o dono ve. Duas partes separadas:
// acoes no ERP (quem mudou o que, antes -> depois) e acoes do PDV com senha Gerente, por categoria.

type Period = 'hoje' | '7dias' | 'mes' | 'mespassado';
const PERIOD_LABELS: Record<Period, string> = {
  hoje: 'Hoje',
  '7dias': 'Últimos 7 dias',
  mes: 'Este mês',
  mespassado: 'Mês passado',
};

function periodRange(period: Period): { start: Date; end: Date } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  switch (period) {
    case 'hoje': return { start: today, end: tomorrow };
    case '7dias': return { start: new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6), end: tomorrow };
    case 'mes': return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: tomorrow };
    case 'mespassado': return {
      start: new Date(today.getFullYear(), today.getMonth() - 1, 1),
      end: new Date(today.getFullYear(), today.getMonth(), 1),
    };
  }
}

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco';

const selectClass = 'bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-700 outline-none';

export default function AuditLogPanel({ storeConfigs }: { storeConfigs: StoreConfig[] }) {
  const [view, setView] = useState<'erp' | 'pdv'>('erp');
  const [period, setPeriod] = useState<Period>('7dias');
  const [unitId, setUnitId] = useState('');
  const storeName = (id: string | null) =>
    !id ? '—' : storeConfigs.find(store => store.unitId === id)?.tradeName || (id === 'AVARIADOS' ? 'Avariados' : id);

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2"><History className="w-4 h-4 text-blue-600" /> Registro de ações</h3>
          <p className="text-xs text-slate-500 mt-0.5">Quem fez o quê e quando. Só você (dono) vê. Nada aqui pode ser alterado ou apagado.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className={selectClass} value={period} onChange={event => setPeriod(event.target.value as Period)} aria-label="Período">
            {(Object.keys(PERIOD_LABELS) as Period[]).map(key => <option key={key} value={key}>{PERIOD_LABELS[key]}</option>)}
          </select>
          <select className={selectClass} value={unitId} onChange={event => setUnitId(event.target.value)} aria-label="Loja">
            <option value="">Todas as lojas</option>
            {storeConfigs.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
          </select>
        </div>
      </div>

      <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
        <button type="button" onClick={() => setView('erp')} className={`px-3 py-1.5 text-xs font-bold rounded-md flex items-center gap-1.5 ${view === 'erp' ? 'bg-white shadow-sm text-blue-700' : 'text-slate-500'}`}>
          <History className="w-3.5 h-3.5" /> Ações no ERP
        </button>
        <button type="button" onClick={() => setView('pdv')} className={`px-3 py-1.5 text-xs font-bold rounded-md flex items-center gap-1.5 ${view === 'pdv' ? 'bg-white shadow-sm text-blue-700' : 'text-slate-500'}`}>
          <Monitor className="w-3.5 h-3.5" /> Ações no PDV (senha Gerente)
        </button>
      </div>

      {view === 'erp'
        ? <ErpActions period={period} unitId={unitId} storeName={storeName} />
        : <PosActions period={period} unitId={unitId} storeName={storeName} />}
    </section>
  );
}

interface ListProps {
  period: Period;
  unitId: string;
  storeName: (id: string | null) => string;
}

function ErpActions({ period, unitId, storeName }: ListProps) {
  const [area, setArea] = useState<AuditArea | ''>('');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setError('');
    setOpen(null);
    const { start, end } = periodRange(period);
    listAuditLog({ start, end, unitId: unitId || null, area: area || null, search: appliedSearch })
      .then(rows => { if (alive) setEntries(rows); })
      .catch(err => { if (alive) { setEntries([]); setError(errorText(err)); } });
    return () => { alive = false; };
  }, [period, unitId, area, appliedSearch, reloadKey]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectClass} value={area} onChange={event => setArea(event.target.value as AuditArea | '')} aria-label="Área">
          <option value="">Todas as áreas</option>
          {(Object.keys(AREA_LABELS) as AuditArea[]).map(key => <option key={key} value={key}>{AREA_LABELS[key]}</option>)}
        </select>
        <form className="flex items-center gap-1" onSubmit={event => { event.preventDefault(); setAppliedSearch(search); }}>
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Buscar (produto, venda, pessoa...)"
            className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs outline-none w-56"
          />
          <button type="submit" className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" title="Buscar"><Search className="w-3.5 h-3.5" /></button>
        </form>
        <button type="button" onClick={() => setReloadKey(key => key + 1)} className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" title="Atualizar"><RefreshCw className="w-3.5 h-3.5" /></button>
        {entries && <span className="text-xs text-slate-500">{entries.length} ação(ões){entries.length >= 1000 ? ' (mostrando as 1.000 mais recentes)' : ''}</span>}
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg text-xs">Não foi possível carregar: {error}</div>}
      {entries === null && <p className="text-xs text-slate-500">Carregando...</p>}
      {entries?.length === 0 && !error && <p className="text-xs text-slate-500">Nenhuma ação neste período.</p>}

      {entries && entries.length > 0 && (
        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
          {entries.map((entry, index) => {
            const expanded = open === index;
            const hasDetail = Boolean(entry.changes && Object.keys(entry.changes).length > 0);
            return (
              <div key={`${entry.occurredAt}-${index}`}>
                <button
                  type="button"
                  onClick={() => hasDetail && setOpen(expanded ? null : index)}
                  className={`w-full grid grid-cols-[18px_120px_1fr] sm:grid-cols-[18px_130px_150px_1fr_150px] gap-x-3 gap-y-0.5 px-3 py-2 text-left text-xs ${hasDetail ? 'hover:bg-slate-50' : 'cursor-default'}`}
                >
                  <span className="text-slate-400 pt-0.5">{hasDetail ? (expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />) : null}</span>
                  <span className="text-slate-500 font-mono">{new Date(entry.occurredAt).toLocaleString('pt-BR')}</span>
                  <span className="font-semibold text-slate-700 truncate hidden sm:block" title={entry.actorName ?? ''}>
                    {entry.actorName || '—'}
                    {entry.actorKind === 'PDV' && <span className="ml-1 text-[10px] font-bold text-violet-600">PDV</span>}
                  </span>
                  <span className="text-slate-800 col-start-3 sm:col-start-auto">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mr-1.5">{AREA_LABELS[entry.area] ?? entry.area}</span>
                    <strong className="font-semibold">{auditActionText(entry)}</strong>
                    {entry.summary && <span className="text-slate-600"> · {entry.summary}</span>}
                    <span className="sm:hidden text-slate-500"> · {entry.actorName || '—'}</span>
                  </span>
                  <span className="text-slate-500 truncate hidden sm:block">{storeName(entry.unitId)}</span>
                </button>
                {expanded && entry.changes && <ChangeDetail entry={entry} storeName={storeName} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChangeDetail({ entry, storeName }: { entry: AuditEntry; storeName: (id: string | null) => string }) {
  const rows = Object.entries(entry.changes ?? {});
  const show = (field: string, value: unknown) =>
    (field === 'unit_id' || field === 'from_unit_id' || field === 'to_unit_id') && typeof value === 'string'
      ? storeName(value)
      : formatAuditValue(value, field);
  return (
    <div className="px-3 pb-3 pl-9">
      <div className="bg-slate-50 border border-slate-100 rounded-lg p-3 space-y-1 text-xs">
        {rows.map(([field, value]) => {
          const isPair = entry.operation === 'UPDATE' && Array.isArray(value) && value.length === 2;
          return (
            <div key={field} className="grid grid-cols-[170px_1fr] gap-2">
              <span className="font-semibold text-slate-600">{fieldLabel(field)}</span>
              {isPair ? (
                <span className="text-slate-800 break-words">
                  <span className="text-red-700 line-through decoration-red-300">{show(field, (value as unknown[])[0])}</span>
                  <span className="text-slate-400"> → </span>
                  <span className="text-emerald-700 font-semibold">{show(field, (value as unknown[])[1])}</span>
                </span>
              ) : (
                <span className="text-slate-800 break-words">{show(field, value)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type PosFilter = 'TODAS' | PosCategory | 'ERRADA';

function PosActions({ period, unitId, storeName }: ListProps) {
  const [actions, setActions] = useState<PosSensitiveAction[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<PosFilter>('TODAS');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setActions(null);
    setError('');
    const { start, end } = periodRange(period);
    listPosSensitiveActions({ start, end, unitId: unitId || null })
      .then(rows => { if (alive) setActions(rows); })
      .catch(err => { if (alive) { setActions([]); setError(errorText(err)); } });
    return () => { alive = false; };
  }, [period, unitId, reloadKey]);

  const counts = useMemo(() => {
    const base: Record<PosFilter, number> = { TODAS: 0, CAIXA: 0, VENDA: 0, TROCAS: 0, TERMINAL: 0, ERRADA: 0 };
    for (const action of actions ?? []) {
      base.TODAS += 1;
      if (action.success) base[action.category] += 1;
      else base.ERRADA += 1;
    }
    return base;
  }, [actions]);

  const visible = (actions ?? []).filter(action =>
    filter === 'TODAS' ? true : filter === 'ERRADA' ? !action.success : action.success && action.category === filter);

  const tabs: [PosFilter, string][] = [
    ['TODAS', 'Todas'],
    ['CAIXA', POS_CATEGORY_LABELS.CAIXA],
    ['VENDA', POS_CATEGORY_LABELS.VENDA],
    ['TROCAS', POS_CATEGORY_LABELS.TROCAS],
    ['TERMINAL', POS_CATEGORY_LABELS.TERMINAL],
    ['ERRADA', 'Senha errada'],
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`px-2.5 py-1 rounded-full text-xs font-bold border ${filter === key
              ? key === 'ERRADA' ? 'bg-red-600 border-red-600 text-white' : 'bg-blue-600 border-blue-600 text-white'
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            {label} <span className="opacity-80">{counts[key]}</span>
          </button>
        ))}
        <button type="button" onClick={() => setReloadKey(key => key + 1)} className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 ml-1" title="Atualizar"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>
      <p className="text-[11px] text-slate-500">Cada vez que alguém digitou a senha Gerente no PDV, aceita ou errada, com o detalhe da ação quando existe.</p>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg text-xs">Não foi possível carregar: {error}</div>}
      {actions === null && <p className="text-xs text-slate-500">Carregando...</p>}
      {actions && visible.length === 0 && !error && <p className="text-xs text-slate-500">Nenhuma ação nesta categoria e período.</p>}

      {visible.length > 0 && (
        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left font-bold px-3 py-2">Data e hora</th>
                <th className="text-left font-bold px-3 py-2">Ação</th>
                <th className="text-left font-bold px-3 py-2">Detalhe</th>
                <th className="text-right font-bold px-3 py-2">Valor</th>
                <th className="text-left font-bold px-3 py-2">Terminal / loja</th>
                <th className="text-left font-bold px-3 py-2">Situação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((action, index) => (
                <tr key={`${action.occurredAt}-${index}`} className={action.success ? '' : 'bg-red-50/40'}>
                  <td className="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">{new Date(action.occurredAt).toLocaleString('pt-BR')}</td>
                  <td className="px-3 py-2">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mr-1.5">{POS_CATEGORY_LABELS[action.category] ?? action.category}</span>
                    <strong className="font-semibold text-slate-800">{POS_CONTEXT_LABELS[action.context] ?? action.context}</strong>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{action.detail || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-800 whitespace-nowrap">{action.amount !== null ? currency.format(action.amount) : '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{action.terminalName || '—'} · {storeName(action.unitId)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {!action.success
                      ? <span className="font-bold text-red-700">Senha errada</span>
                      : action.completed === false
                        ? <span className="font-semibold text-amber-700">Senha aceita, ação não concluída</span>
                        : <span className="font-semibold text-emerald-700">Autorizada</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
