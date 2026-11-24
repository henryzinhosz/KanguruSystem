import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Ban,
  CalendarClock,
  CheckCircle2,
  Clock,
  Copy,
  Edit,
  FileText,
  Paperclip,
  Plus,
  Repeat,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  Wallet,
  X,
} from 'lucide-react';
import type { PayableBill, PayableMethod, PayableRecurrence, StoreConfig, Supplier, User } from '../types';
import { UserRole } from '../types';
import ValueInput from './ValueInput';
import {
  PAYABLE_CATEGORIES,
  PAYABLE_METHODS,
  deletePayableBill,
  ensurePayableRecurrences,
  listPayableBills,
  listPayableRecurrences,
  methodLabel,
  openPayableAttachment,
  payPayableBill,
  removePayableAttachment,
  savePayableBill,
  savePayableRecurrence,
  setPayableCancelled,
  undoPayablePayment,
  uploadPayableAttachment,
  type PayableInput,
} from '../db/payables';
import { toLocalDateKey } from '../db/finance';

// Contas a pagar (desenho aprovado em 2026-11-19): conta unica, parcelada ou que se repete
// todo mes. Ao pagar, vira despesa na data do pagamento (Lucro Real Operacional, DRE e Painel
// da Rede leem as despesas como hoje).

interface PayablesPanelProps {
  currentUser: User;
  storeConfigs: StoreConfig[];
  suppliers: Supplier[];
  onExpensesChanged: () => void | Promise<void>;
}

type StatusFilter = 'ABERTAS' | 'VENCIDAS' | 'PAGAS' | 'CANCELADAS' | 'TODAS';
type PeriodFilter = 'TODOS' | 'ESTE_MES' | 'PROXIMO_MES' | 'MES_PASSADO' | 'PERSONALIZADO';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco';
const formatDate = (key: string | null) => (key ? key.split('-').reverse().join('/') : '');
const addDays = (key: string, days: number) => {
  const [y, m, d] = key.split('-').map(Number);
  return toLocalDateKey(new Date(y, m - 1, d + days));
};
const monthOf = (key: string) => key.slice(0, 7);
const shiftMonth = (monthKey: string, delta: number) => {
  const [y, m] = monthKey.split('-').map(Number);
  const date = new Date(y, m - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

interface BillSituation {
  label: string;
  tone: string;
}

function situationOf(bill: PayableBill, today: string): BillSituation {
  if (bill.status === 'PAGO') return { label: `Paga em ${formatDate(bill.paidAt)}`, tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  if (bill.status === 'CANCELADO') return { label: 'Cancelada', tone: 'bg-slate-100 text-slate-500 border-slate-200' };
  if (bill.dueDate < today) {
    const [y1, m1, d1] = bill.dueDate.split('-').map(Number);
    const [y2, m2, d2] = today.split('-').map(Number);
    const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
    return { label: `Vencida há ${days} dia${days === 1 ? '' : 's'}`, tone: 'bg-rose-50 text-rose-700 border-rose-200' };
  }
  if (bill.dueDate === today) return { label: 'Vence hoje', tone: 'bg-orange-50 text-orange-700 border-orange-200' };
  return { label: 'A vencer', tone: 'bg-blue-50 text-blue-700 border-blue-200' };
}

// Prazos de fornecedor: parcelas que vencem N dias depois da data da compra.
const SUPPLIER_TERMS = { P7_14: [7, 14], P7_14_21: [7, 14, 21], P30_60_90: [30, 60, 90] } as const;
type IntervalOption = 'MENSAL' | 'QUINZENAL' | 'SEMANAL' | keyof typeof SUPPLIER_TERMS | 'OUTRO';

// "28/56/84" -> [28, 56, 84]; nulo se invalido (precisa ser crescente, de 0 a 720).
function termOffsets(option: IntervalOption, custom: string): number[] | null {
  if (option in SUPPLIER_TERMS) return [...SUPPLIER_TERMS[option as keyof typeof SUPPLIER_TERMS]];
  if (option !== 'OUTRO') return null;
  const parts = custom.split(/[^0-9]+/).filter(Boolean).map(Number);
  if (parts.length === 0 || parts.length > 24) return null;
  if (parts.some((value, index) => value > 720 || (index > 0 && value <= parts[index - 1]))) return null;
  return parts;
}

const inputClass = 'w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-blue-500';

export default function PayablesPanel({ currentUser, storeConfigs, suppliers, onExpensesChanged }: PayablesPanelProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = useMemo(() => storeConfigs.filter(store => store.unitId !== 'central'), [storeConfigs]);
  const storeName = useCallback(
    (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId,
    [stores]
  );

  const [bills, setBills] = useState<PayableBill[]>([]);
  const [recurrences, setRecurrences] = useState<PayableRecurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Filtro pedido pelos cartoes do topo (vale para as duas listas).
  const [preset, setPreset] = useState<{ status: StatusFilter; seq: number }>({ status: 'ABERTAS', seq: 0 });
  const applyPreset = (status: StatusFilter) => setPreset(previous => ({ status, seq: previous.seq + 1 }));

  const [editing, setEditing] = useState<PayableBill | 'new' | null>(null);
  const [paying, setPaying] = useState<PayableBill | null>(null);
  const [recurrencesOpen, setRecurrencesOpen] = useState(false);

  const today = toLocalDateKey(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await ensurePayableRecurrences().catch(() => 0);
      const [billRows, recurrenceRows] = await Promise.all([listPayableBills(), listPayableRecurrences()]);
      setBills(billRows);
      setRecurrences(recurrenceRows);
    } catch (loadError) {
      setError(`Não foi possível carregar as contas a pagar: ${errorText(loadError)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (billId: string, action: () => Promise<void | string>, success: string, changesExpenses = false) => {
    setBusyId(billId);
    setError('');
    setMessage('');
    try {
      const result = await action();
      setMessage(result === 'CANCELADA' ? 'A conta faz parte de uma repetição ativa e ficou cancelada (para não ser criada de novo).' : success);
      await load();
      if (changesExpenses) await onExpensesChanged();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setBusyId(null);
    }
  };

  // Cartoes do topo (lojas do filtro de loja, contas em aberto).
  const scoped = bills;
  const monthEnd = `${monthOf(today)}-31`;
  const open = scoped.filter(bill => bill.status === 'PENDENTE');
  const overdue = open.filter(bill => bill.dueDate < today);
  const dueToday = open.filter(bill => bill.dueDate === today);
  const nextWeek = open.filter(bill => bill.dueDate > today && bill.dueDate <= addDays(today, 7));
  const paidThisMonth = scoped.filter(bill => bill.status === 'PAGO' && bill.paidAt && monthOf(bill.paidAt) === monthOf(today));
  const sum = (items: PayableBill[], paid = false) => items.reduce((total, bill) => total + (paid ? bill.paidAmount ?? bill.amount : bill.amount), 0);

  const categories = useMemo(
    () => Array.from(new Set([...PAYABLE_CATEGORIES, ...bills.map(bill => bill.category)])).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    [bills]
  );
  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`${label} copiado.`);
    } catch {
      setError('Não foi possível copiar. Selecione o texto e copie manualmente.');
    }
  };

  const openAttachment = async (bill: PayableBill) => {
    if (!bill.attachmentPath) return;
    try {
      window.open(await openPayableAttachment(bill.attachmentPath), '_blank', 'noopener');
    } catch (openError) {
      setError(`Não foi possível abrir o anexo: ${errorText(openError)}`);
    }
  };

  const activeRecurrences = recurrences.filter(item => item.isActive).length;
  const cards = [
    { label: 'Vencidas', items: overdue, tone: 'text-rose-600', icon: AlertCircle, iconTone: 'bg-rose-50 text-rose-600 border-rose-100', filter: 'VENCIDAS' as StatusFilter },
    { label: 'Vence hoje', items: dueToday, tone: 'text-orange-600', icon: Clock, iconTone: 'bg-orange-50 text-orange-600 border-orange-100', filter: 'ABERTAS' as StatusFilter },
    { label: 'Próximos 7 dias', items: nextWeek, tone: 'text-blue-600', icon: CalendarClock, iconTone: 'bg-blue-50 text-blue-600 border-blue-100', filter: 'ABERTAS' as StatusFilter },
  ];

  return (
    <div className="space-y-4 font-sans text-xs">
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
            <Wallet className="w-5 h-5 text-blue-600 mr-2" />Contas a pagar
          </h3>
          <p className="text-xs text-slate-400">Ao dar baixa, a conta vira despesa na data do pagamento e entra no Lucro Real Operacional.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setRecurrencesOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold text-slate-700"
          >
            <Repeat className="w-4 h-4" />Contas que se repetem ({activeRecurrences})
          </button>
          <button
            type="button"
            onClick={() => setEditing('new')}
            disabled={stores.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />Nova conta
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map(card => {
          const Icon = card.icon;
          return (
            <button
              key={card.label}
              type="button"
              onClick={() => applyPreset(card.filter)}
              className="text-left bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center justify-between hover:border-slate-300 transition"
            >
              <div>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{card.label}</p>
                <p className={`text-lg font-black mt-1 font-mono ${card.tone}`}>{money(sum(card.items))}</p>
                <p className="text-[10px] text-slate-400 font-semibold">{card.items.length} conta{card.items.length === 1 ? '' : 's'}</p>
              </div>
              <span className={`p-2.5 rounded-lg border ${card.iconTone}`}><Icon className="w-5 h-5" /></span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => applyPreset('PAGAS')}
          className="text-left bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center justify-between hover:border-slate-300 transition"
        >
          <div>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Pago no mês</p>
            <p className="text-lg font-black mt-1 font-mono text-emerald-600">{money(sum(paidThisMonth, true))}</p>
            <p className="text-[10px] text-slate-400 font-semibold">{paidThisMonth.length} conta{paidThisMonth.length === 1 ? '' : 's'}</p>
          </div>
          <span className="p-2.5 rounded-lg border bg-emerald-50 text-emerald-600 border-emerald-100"><CheckCircle2 className="w-5 h-5" /></span>
        </button>
      </div>

      {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
      {message && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{message}</div>}

      {([
        { id: 'month', title: 'Contas deste mês', hint: 'Vencem até o fim deste mês (inclui as vencidas de meses anteriores).', items: bills.filter(bill => bill.dueDate <= monthEnd) },
        { id: 'future', title: 'Contas dos próximos meses', hint: 'Vencem a partir do mês que vem.', items: bills.filter(bill => bill.dueDate > monthEnd) },
      ]).map(section => (
        <React.Fragment key={section.id}>
          <BillsSection
            title={section.title}
            hint={section.hint}
            bills={section.items}
            preset={preset}
            stores={stores}
            storeName={storeName}
            categories={categories}
            today={today}
            isAdmin={isAdmin}
            loading={loading}
            busyId={busyId}
            onPay={setPaying}
            onEdit={setEditing}
            run={run}
            copyText={copyText}
            openAttachment={openAttachment}
          />
        </React.Fragment>
      ))}

      {editing && (
        <PayableFormModal
          bill={editing === 'new' ? null : editing}
          stores={stores}
          suppliers={suppliers}
          categories={categories}
          tenantId={currentUser.tenantId}
          onClose={() => setEditing(null)}
          onSaved={async (text, paid) => {
            setEditing(null);
            setError('');
            setMessage(text);
            await load();
            if (paid) await onExpensesChanged();
          }}
        />
      )}

      {paying && (
        <PayModal
          bill={paying}
          today={today}
          onClose={() => setPaying(null)}
          onPaid={async () => {
            setPaying(null);
            setError('');
            setMessage('Conta paga: a despesa foi lançada em Despesas na data do pagamento.');
            await load();
            await onExpensesChanged();
          }}
        />
      )}

      {recurrencesOpen && (
        <RecurrencesModal
          recurrences={recurrences}
          stores={stores}
          suppliers={suppliers}
          categories={categories}
          onClose={() => setRecurrencesOpen(false)}
          onChanged={load}
        />
      )}
    </div>
  );
}

interface BillsSectionProps {
  title: string;
  hint: string;
  bills: PayableBill[];
  preset: { status: StatusFilter; seq: number };
  stores: StoreConfig[];
  storeName: (unitId: string) => string;
  categories: string[];
  today: string;
  isAdmin: boolean;
  loading: boolean;
  busyId: string | null;
  onPay: (bill: PayableBill) => void;
  onEdit: (bill: PayableBill) => void;
  run: (billId: string, action: () => Promise<void | string>, success: string, changesExpenses?: boolean) => Promise<void>;
  copyText: (text: string, label: string) => Promise<void>;
  openAttachment: (bill: PayableBill) => Promise<void>;
}

// Uma lista de contas com os proprios filtros (deste mes / dos proximos meses).
function BillsSection({ title, hint, bills, preset, stores, storeName, categories, today, isAdmin, loading, busyId, onPay, onEdit, run, copyText, openAttachment }: BillsSectionProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(preset.status);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('TODOS');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (preset.seq === 0) return;
    setStatusFilter(preset.status);
    setPeriodFilter('TODOS');
  }, [preset]);

  const supplierNames = useMemo(
    () => Array.from(new Set<string>(bills.map(bill => bill.supplierName).filter((name): name is string => Boolean(name)))).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    [bills]
  );
  const period = useMemo(() => {
    const month = monthOf(today);
    if (periodFilter === 'ESTE_MES') return { from: `${month}-01`, to: `${month}-31` };
    if (periodFilter === 'PROXIMO_MES') return { from: `${shiftMonth(month, 1)}-01`, to: `${shiftMonth(month, 1)}-31` };
    if (periodFilter === 'MES_PASSADO') return { from: `${shiftMonth(month, -1)}-01`, to: `${shiftMonth(month, -1)}-31` };
    if (periodFilter === 'PERSONALIZADO') return { from: customFrom || '0000-01-01', to: customTo || '9999-12-31' };
    return null;
  }, [periodFilter, customFrom, customTo, today]);

  const term = search.trim().toLowerCase();
  const visible = bills
    .filter(bill => !storeFilter || bill.unitId === storeFilter)
    .filter(bill => {
      if (statusFilter === 'ABERTAS') return bill.status === 'PENDENTE';
      if (statusFilter === 'VENCIDAS') return bill.status === 'PENDENTE' && bill.dueDate < today;
      if (statusFilter === 'PAGAS') return bill.status === 'PAGO';
      if (statusFilter === 'CANCELADAS') return bill.status === 'CANCELADO';
      return true;
    })
    .filter(bill => !period || (bill.dueDate >= period.from && bill.dueDate <= period.to))
    .filter(bill => !categoryFilter || bill.category === categoryFilter)
    .filter(bill => !supplierFilter || bill.supplierName === supplierFilter)
    .filter(bill => !term || [bill.description, bill.supplierName, bill.invoiceNumber, bill.barcode, bill.notes]
      .some(value => (value || '').toLowerCase().includes(term)))
    .sort((a, b) => (statusFilter === 'PAGAS'
      ? (b.paidAt || '').localeCompare(a.paidAt || '')
      : a.dueDate.localeCompare(b.dueDate)));
  const visibleTotal = visible.reduce((total, bill) => total + bill.amount, 0);

  return (
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">{title}</h4>
          <span className="text-[11px] text-slate-400">{hint}</span>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="block font-bold text-slate-500">Situação</span>
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as StatusFilter)} className={inputClass}>
              <option value="ABERTAS">Em aberto</option>
              <option value="VENCIDAS">Vencidas</option>
              <option value="PAGAS">Pagas</option>
              <option value="CANCELADAS">Canceladas</option>
              <option value="TODAS">Todas</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block font-bold text-slate-500">Vencimento</span>
            <select value={periodFilter} onChange={event => setPeriodFilter(event.target.value as PeriodFilter)} className={inputClass}>
              <option value="TODOS">Todos</option>
              <option value="ESTE_MES">Este mês</option>
              <option value="PROXIMO_MES">Próximo mês</option>
              <option value="MES_PASSADO">Mês passado</option>
              <option value="PERSONALIZADO">Personalizado</option>
            </select>
          </label>
          {periodFilter === 'PERSONALIZADO' && (
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
          {supplierNames.length > 0 && (
            <label className="space-y-1">
              <span className="block font-bold text-slate-500">Fornecedor</span>
              <select value={supplierFilter} onChange={event => setSupplierFilter(event.target.value)} className={inputClass}>
                <option value="">Todos</option>
                {supplierNames.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          )}
          <label className="space-y-1 flex-1 min-w-[180px]">
            <span className="block font-bold text-slate-500">Buscar</span>
            <span className="relative block">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Descrição, fornecedor, nota..." className={`${inputClass} pl-8`} />
            </span>
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] table-fixed text-left text-slate-600">
            <colgroup>
              <col className="w-[110px]" />
              <col />
              {stores.length > 1 && <col className="w-[160px]" />}
              <col className="w-[170px]" />
              <col className="w-[120px]" />
              <col className="w-[150px]" />
              <col className="w-[230px]" />
            </colgroup>
            <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
              <tr>
                <th className="px-3 py-2">Vencimento</th>
                <th className="px-3 py-2">Conta</th>
                {stores.length > 1 && <th className="px-3 py-2">Loja</th>}
                <th className="px-3 py-2">Categoria</th>
                <th className="px-3 py-2 text-right">Valor</th>
                <th className="px-3 py-2">Situação</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map(bill => {
                const situation = situationOf(bill, today);
                const busy = busyId === bill.id;
                return (
                  <tr key={bill.id} className="hover:bg-slate-50/60 align-top">
                    <td className="px-3 py-2.5 font-mono font-bold text-slate-800 whitespace-nowrap">{formatDate(bill.dueDate)}</td>
                    <td className="px-3 py-2.5">
                      <span className="font-bold text-slate-900 block">
                        {bill.description}
                        {bill.installmentTotal && <span className="ml-1.5 text-[10px] font-semibold text-slate-500">parcela {bill.installmentNumber}/{bill.installmentTotal}</span>}
                        {bill.recurrenceId && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold text-violet-600"><Repeat className="w-3 h-3" />todo mês</span>}
                      </span>
                      <span className="text-[10px] text-slate-500 block">
                        {[bill.supplierName, methodLabel(bill.paymentMethod), bill.invoiceNumber ? `NF ${bill.invoiceNumber}` : null].filter(Boolean).join(' · ')}
                      </span>
                      {bill.notes && <span className="text-[10px] text-slate-400 block">{bill.notes}</span>}
                      {bill.status === 'PAGO' && (
                        <span className="text-[10px] text-emerald-700 block">
                          Pago {money(bill.paidAmount ?? bill.amount)}{bill.paidMethod ? ` no ${methodLabel(bill.paidMethod).toLowerCase()}` : ''}{bill.paidByName ? ` por ${bill.paidByName}` : ''}
                        </span>
                      )}
                    </td>
                    {stores.length > 1 && <td className="px-3 py-2.5 text-slate-700">{storeName(bill.unitId)}</td>}
                    <td className="px-3 py-2.5"><span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-[10px] font-semibold">{bill.category}</span></td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-900 whitespace-nowrap">{money(bill.amount)}</td>
                    <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded border text-[10px] font-bold whitespace-nowrap ${situation.tone}`}>{situation.label}</span></td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {bill.status === 'PENDENTE' && (
                          <button type="button" disabled={busy} onClick={() => onPay(bill)} className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50">Pagar</button>
                        )}
                        {bill.barcode && (
                          <IconButton title="Copiar código de barras" onClick={() => void copyText(bill.barcode!, 'Código de barras')}><Copy className="w-3.5 h-3.5" /></IconButton>
                        )}
                        {bill.pixKey && (
                          <IconButton title={`Copiar chave Pix (${bill.pixKey})`} onClick={() => void copyText(bill.pixKey!, 'Chave Pix')}><span className="text-[10px] font-black">PIX</span></IconButton>
                        )}
                        {bill.attachmentPath && (
                          <IconButton title={`Abrir anexo (${bill.attachmentName || 'arquivo'})`} onClick={() => void openAttachment(bill)}><Paperclip className="w-3.5 h-3.5" /></IconButton>
                        )}
                        {bill.status === 'PENDENTE' && (
                          <IconButton title="Editar" onClick={() => onEdit(bill)}><Edit className="w-3.5 h-3.5" /></IconButton>
                        )}
                        {bill.status === 'PAGO' && (
                          <IconButton
                            title="Desfazer baixa"
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm('Desfazer a baixa? A despesa sai de Despesas e a conta volta a ficar em aberto.')) return;
                              void run(bill.id, () => undoPayablePayment(bill.id), 'Baixa desfeita: a conta voltou a ficar em aberto.', true);
                            }}
                          ><Undo2 className="w-3.5 h-3.5" /></IconButton>
                        )}
                        {bill.status === 'PENDENTE' && (
                          <IconButton
                            title="Cancelar conta"
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm(`Cancelar a conta "${bill.description}"?`)) return;
                              void run(bill.id, () => setPayableCancelled(bill.id, true), 'Conta cancelada.');
                            }}
                          ><Ban className="w-3.5 h-3.5" /></IconButton>
                        )}
                        {bill.status === 'CANCELADO' && (
                          <IconButton title="Reabrir conta" disabled={busy} onClick={() => void run(bill.id, () => setPayableCancelled(bill.id, false), 'Conta reaberta.')}>
                            <RotateCcw className="w-3.5 h-3.5" />
                          </IconButton>
                        )}
                        {isAdmin && (
                          <IconButton
                            title="Excluir"
                            danger
                            disabled={busy}
                            onClick={() => {
                              const paid = bill.status === 'PAGO' ? ' A despesa dela também sai de Despesas.' : '';
                              if (!window.confirm(`Excluir a conta "${bill.description}" de vez?${paid}`)) return;
                              void run(bill.id, async () => {
                                if (bill.attachmentPath) await removePayableAttachment(bill);
                                return deletePayableBill(bill.id);
                              }, 'Conta excluída.', bill.status === 'PAGO');
                            }}
                          ><Trash2 className="w-3.5 h-3.5" /></IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={7} className="py-10 text-center text-slate-400">Nenhuma conta encontrada com estes filtros.</td></tr>
              )}
              {loading && (
                <tr><td colSpan={7} className="py-10 text-center text-slate-400">Carregando contas...</td></tr>
              )}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr className="bg-slate-50 font-bold text-slate-800">
                  <td className="px-3 py-2" colSpan={stores.length > 1 ? 4 : 3}>{visible.length} conta{visible.length === 1 ? '' : 's'}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(visibleTotal)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

  );
}

function IconButton({ title, onClick, disabled, danger, children }: { title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`h-7 min-w-7 px-1.5 inline-flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 disabled:opacity-40 ${danger ? 'hover:text-rose-600 hover:bg-rose-50' : 'hover:text-blue-600 hover:bg-blue-50'}`}
    >
      {children}
    </button>
  );
}

function ModalShell({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className={`bg-white w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} max-h-[92vh] rounded-xl shadow-xl border border-slate-200 flex flex-col overflow-hidden`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50">
          <h3 className="text-sm font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>
        <div className="overflow-y-auto p-5 text-xs">{children}</div>
      </div>
    </div>
  );
}

interface FormModalProps {
  bill: PayableBill | null;
  stores: StoreConfig[];
  suppliers: Supplier[];
  categories: string[];
  tenantId: string | null;
  onClose: () => void;
  onSaved: (message: string, paid?: boolean) => void | Promise<void>;
}

function PayableFormModal({ bill, stores, suppliers, categories, tenantId, onClose, onSaved }: FormModalProps) {
  const [unitId, setUnitId] = useState(bill?.unitId ?? stores[0]?.unitId ?? '');
  const [description, setDescription] = useState(bill?.description ?? '');
  const [supplierId, setSupplierId] = useState(bill?.supplierId ?? (bill?.supplierName ? 'custom' : ''));
  const [supplierName, setSupplierName] = useState(bill?.supplierId ? '' : bill?.supplierName ?? '');
  const [category, setCategory] = useState(bill?.category ?? 'Mercadoria/Fornecedor');
  const [amount, setAmount] = useState<number | null>(bill?.amount ?? null);
  const [dueDate, setDueDate] = useState(bill?.dueDate ?? '');
  const [method, setMethod] = useState<PayableMethod | ''>(bill?.paymentMethod ?? 'BOLETO');
  const [barcode, setBarcode] = useState(bill?.barcode ?? '');
  const [pixKey, setPixKey] = useState(bill?.pixKey ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState(bill?.invoiceNumber ?? '');
  const [notes, setNotes] = useState(bill?.notes ?? '');
  const [mode, setMode] = useState<'UNICA' | 'PARCELADA' | 'RECORRENTE'>('UNICA');
  const [installments, setInstallments] = useState<number | null>(2);
  const [frequency, setFrequency] = useState<IntervalOption>('MENSAL');
  const [customTerm, setCustomTerm] = useState('');
  const termMode = frequency in SUPPLIER_TERMS || frequency === 'OUTRO';
  const planOffsets = termMode ? termOffsets(frequency, customTerm) : null;
  const planCount = termMode ? planOffsets?.length ?? 0 : installments ?? 0;
  const termDates = dueDate && planOffsets ? planOffsets.map(days => formatDate(addDays(dueDate, days))) : [];
  const [amountIsTotal, setAmountIsTotal] = useState(true);
  const [monthsAhead, setMonthsAhead] = useState(3);
  const [file, setFile] = useState<File | null>(null);
  // Gasto pago na hora: lanca a conta e ja da baixa (vira despesa nessa data).
  const today = toLocalDateKey(new Date());
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  const [paidAt, setPaidAt] = useState(today);
  const [removeFile, setRemoveFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const digits = barcode.replace(/\D/g, '');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!unitId) return setError('Escolha a loja.');
    if (!description.trim()) return setError('Informe a descrição.');
    if (!amount || amount <= 0) return setError('Informe o valor.');
    if (!dueDate) return setError('Informe o vencimento.');
    if (supplierId === 'custom' && !supplierName.trim()) return setError('Digite o nome do fornecedor ou escolha "Sem fornecedor".');
    if (digits && ![44, 47, 48].includes(digits.length)) return setError('Código de barras inválido: são 44, 47 ou 48 números.');
    const offsets = termOffsets(frequency, customTerm);
    const isTerm = frequency in SUPPLIER_TERMS || frequency === 'OUTRO';
    if (!bill && mode === 'PARCELADA' && isTerm) {
      if (!offsets || offsets.length < 2) return setError('Digite o prazo com 2 ou mais parcelas, em dias crescentes (ex.: 30/60/90).');
    } else if (!bill && mode === 'PARCELADA' && (!installments || installments < 2 || installments > 48)) {
      return setError('Informe de 2 a 48 parcelas.');
    }
    if (file && file.size > 10 * 1024 * 1024) return setError('O anexo pode ter no máximo 10 MB.');
    const payNow = !bill && mode === 'UNICA' && alreadyPaid;
    if (payNow && (!paidAt || paidAt > today)) return setError('Informe a data do pagamento (não pode ser no futuro).');

    const input: PayableInput = {
      unitId,
      description: description.trim(),
      supplierId: supplierId && supplierId !== 'custom' ? supplierId : null,
      supplierName: supplierId === 'custom' ? supplierName.trim() : null,
      category,
      amount,
      dueDate,
      paymentMethod: method || null,
      barcode: digits,
      pixKey: pixKey.trim(),
      invoiceNumber: invoiceNumber.trim(),
      notes: notes.trim(),
    };
    if (!bill) {
      input.mode = mode;
      if (mode === 'PARCELADA') {
        if (isTerm && offsets) {
          input.frequency = 'PRAZO';
          input.dayOffsets = offsets;
          input.installments = offsets.length;
        } else {
          input.installments = installments ?? 2;
          input.frequency = frequency as 'MENSAL' | 'QUINZENAL' | 'SEMANAL';
        }
        input.amountIsTotal = amountIsTotal;
      }
      if (mode === 'RECORRENTE') input.monthsAhead = monthsAhead;
    }

    setSaving(true);
    try {
      const ids = await savePayableBill(bill?.id ?? null, input);
      let attachmentNote = '';
      if (tenantId && (file || (removeFile && bill?.attachmentPath))) {
        try {
          const target = bill ?? { id: ids[0], attachmentPath: null } as PayableBill;
          if (file) await uploadPayableAttachment(tenantId, target, file);
          else if (bill) await removePayableAttachment(bill);
        } catch (fileError) {
          attachmentNote = ` O anexo não foi salvo: ${errorText(fileError)}`;
        }
      }
      let paidNote = '';
      if (payNow && ids[0]) {
        try {
          await payPayableBill(ids[0], paidAt, amount, method || null);
          paidNote = ' Já paga: a despesa entrou em Despesas.';
        } catch (payError) {
          paidNote = ` A conta foi lançada, mas a baixa não foi feita: ${errorText(payError)}`;
        }
      }
      const saved = bill
        ? 'Conta atualizada.'
        : mode === 'PARCELADA'
          ? `${ids.length} parcelas lançadas.`
          : mode === 'RECORRENTE'
            ? `Conta que se repete criada (${ids.length} mês${ids.length === 1 ? '' : 'es'} já lançado${ids.length === 1 ? '' : 's'}).`
            : 'Conta lançada.';
      await onSaved(saved + paidNote + attachmentNote, payNow);
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={bill ? 'Editar conta' : 'Nova conta a pagar'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}

        {!bill && (
          <div className="grid grid-cols-3 gap-2">
            {([['UNICA', 'Única'], ['PARCELADA', 'Parcelada'], ['RECORRENTE', 'Repete todo mês']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`py-2 rounded-lg border font-bold ${mode === value ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Descrição *</span>
          <input value={description} onChange={event => setDescription(event.target.value)} maxLength={120} placeholder="Ex.: Aluguel da loja, Boleto Maxprint NF 1234" className={inputClass} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Loja *</span>
            <select value={unitId} onChange={event => setUnitId(event.target.value)} className={inputClass}>
              {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Categoria *</span>
            <select value={category} onChange={event => setCategory(event.target.value)} className={inputClass}>
              {categories.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Fornecedor</span>
            <select value={supplierId} onChange={event => setSupplierId(event.target.value)} className={inputClass}>
              <option value="">Sem fornecedor</option>
              {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              <option value="custom">Outro (digitar)</option>
            </select>
          </label>
          {supplierId === 'custom' ? (
            <label className="block space-y-1">
              <span className="font-bold text-slate-700">Nome do fornecedor</span>
              <input value={supplierName} onChange={event => setSupplierName(event.target.value)} placeholder="Ex.: Light, Imobiliária" className={inputClass} />
            </label>
          ) : (
            <label className="block space-y-1">
              <span className="font-bold text-slate-700">Forma de pagamento</span>
              <select value={method} onChange={event => setMethod(event.target.value as PayableMethod | '')} className={inputClass}>
                <option value="">Não informada</option>
                {PAYABLE_METHODS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          )}
        </div>
        {supplierId === 'custom' && (
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Forma de pagamento</span>
            <select value={method} onChange={event => setMethod(event.target.value as PayableMethod | '')} className={inputClass}>
              <option value="">Não informada</option>
              {PAYABLE_METHODS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">
              {!bill && mode === 'PARCELADA' ? (amountIsTotal ? 'Valor total (R$) *' : 'Valor de cada parcela (R$) *') : 'Valor (R$) *'}
            </span>
            <ValueInput value={amount} onValueChange={setAmount} className={`${inputClass} font-mono`} />
          </label>
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">
              {!bill && mode === 'PARCELADA' && termMode ? 'Data da compra (nota) *' : !bill && mode !== 'UNICA' ? 'Primeiro vencimento *' : 'Vencimento *'}
            </span>
            <input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} className={inputClass} />
          </label>
        </div>

        {!bill && mode === 'PARCELADA' && (
          <div className="grid grid-cols-3 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
            {termMode ? (
              <label className="block space-y-1">
                <span className="font-bold text-slate-700">Prazo (dias)</span>
                {frequency === 'OUTRO' ? (
                  <input value={customTerm} onChange={event => setCustomTerm(event.target.value)} placeholder="Ex.: 28/56/84" className={`${inputClass} font-mono`} />
                ) : (
                  <div className={`${inputClass} font-mono text-slate-700`}>{SUPPLIER_TERMS[frequency as keyof typeof SUPPLIER_TERMS].join('/')}</div>
                )}
              </label>
            ) : (
              <label className="block space-y-1">
                <span className="font-bold text-slate-700">Parcelas</span>
                <ValueInput decimals={0} value={installments} onValueChange={setInstallments} className={inputClass} />
              </label>
            )}
            <label className="block space-y-1">
              <span className="font-bold text-slate-700">Intervalo</span>
              <select value={frequency} onChange={event => setFrequency(event.target.value as IntervalOption)} className={inputClass}>
                <option value="MENSAL">Todo mês</option>
                <option value="QUINZENAL">A cada 15 dias</option>
                <option value="SEMANAL">Toda semana</option>
                <option value="P7_14">Prazo 7/14 dias</option>
                <option value="P7_14_21">Prazo 7/14/21 dias</option>
                <option value="P30_60_90">Prazo 30/60/90 dias</option>
                <option value="OUTRO">Outro prazo (digitar)</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-bold text-slate-700">O valor digitado é</span>
              <select value={amountIsTotal ? 'TOTAL' : 'EACH'} onChange={event => setAmountIsTotal(event.target.value === 'TOTAL')} className={inputClass}>
                <option value="TOTAL">O total</option>
                <option value="EACH">De cada parcela</option>
              </select>
            </label>
            {amount && planCount >= 2 ? (
              <p className="col-span-3 text-[11px] text-slate-500">
                {amountIsTotal
                  ? `${planCount}x de ${money(Math.floor((amount / planCount) * 100) / 100)} (total ${money(amount)})`
                  : `${planCount}x de ${money(amount)} (total ${money(amount * planCount)})`}
                {termMode && termDates.length > 0 && <span className="block">Vencimentos: {termDates.join(', ')}</span>}
              </p>
            ) : null}
          </div>
        )}

        {!bill && mode === 'UNICA' && (
          <div className={`rounded-lg border p-3 space-y-2 ${alreadyPaid ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
            <label className="flex items-center gap-2 font-bold text-slate-700">
              <input type="checkbox" checked={alreadyPaid} onChange={event => setAlreadyPaid(event.target.checked)} className="w-4 h-4 accent-emerald-600" />
              Já foi paga
            </label>
            {alreadyPaid && (
              <label className="block space-y-1">
                <span className="font-bold text-slate-700">Data do pagamento</span>
                <input type="date" value={paidAt} max={today} onChange={event => setPaidAt(event.target.value)} className={inputClass} />
                <span className="block text-[11px] text-slate-500">A conta é lançada já paga, com a forma de pagamento escolhida acima, e entra em Despesas nesta data.</span>
              </label>
            )}
          </div>
        )}

        {!bill && mode === 'RECORRENTE' && (
          <div className="bg-violet-50 border border-violet-200 rounded-lg p-3 space-y-2">
            <label className="block space-y-1">
              <span className="font-bold text-slate-700">Manter criadas</span>
              <select value={monthsAhead} onChange={event => setMonthsAhead(Number(event.target.value))} className={inputClass}>
                {Array.from({ length: 12 }, (_, index) => index + 1).map(value => (
                  <option key={value} value={value}>{value} {value === 1 ? 'mês' : 'meses'} à frente</option>
                ))}
              </select>
            </label>
            <p className="text-[11px] text-slate-600">
              Vence todo dia {dueDate ? Number(dueDate.slice(8, 10)) : '__'} (em mês mais curto, no último dia). O ERP vai criando sozinho os próximos meses.
              Se o valor muda (luz, água), corrija a conta quando a fatura chegar.
            </p>
          </div>
        )}

        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Código de barras / linha digitável</span>
          <input value={barcode} onChange={event => setBarcode(event.target.value)} placeholder="Cole ou bipe o código do boleto" className={`${inputClass} font-mono`} />
          {digits && <span className={`text-[10px] ${[44, 47, 48].includes(digits.length) ? 'text-emerald-600' : 'text-amber-600'}`}>{digits.length} números</span>}
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Chave Pix</span>
            <input value={pixKey} onChange={event => setPixKey(event.target.value)} className={inputClass} />
          </label>
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Nº da nota</span>
            <input value={invoiceNumber} onChange={event => setInvoiceNumber(event.target.value)} className={inputClass} />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Observação</span>
          <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} className={inputClass} />
        </label>

        <div className="space-y-1">
          <span className="block font-bold text-slate-700">Anexo (boleto ou nota, PDF ou foto, até 10 MB)</span>
          {bill?.attachmentPath && !removeFile && !file && (
            <div className="flex items-center gap-2 text-slate-600">
              <FileText className="w-4 h-4" />{bill.attachmentName || 'arquivo'}
              <button type="button" onClick={() => setRemoveFile(true)} className="text-rose-600 font-bold hover:underline">Remover</button>
            </div>
          )}
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={event => setFile(event.target.files?.[0] ?? null)} className="block text-xs" />
          {!bill && mode !== 'UNICA' && <span className="block text-[10px] text-slate-400">O anexo fica na primeira conta.</span>}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">Cancelar</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function PayModal({ bill, today, onClose, onPaid }: { bill: PayableBill; today: string; onClose: () => void; onPaid: () => void | Promise<void> }) {
  const [paidAt, setPaidAt] = useState(today);
  const [paidAmount, setPaidAmount] = useState<number | null>(bill.amount);
  const [method, setMethod] = useState<PayableMethod | ''>(bill.paymentMethod ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const difference = paidAmount != null ? Math.round((paidAmount - bill.amount) * 100) / 100 : 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!paidAt || paidAt > today) return setError('Informe a data do pagamento (não pode ser no futuro).');
    if (!paidAmount || paidAmount <= 0) return setError('Informe o valor pago.');
    setSaving(true);
    try {
      await payPayableBill(bill.id, paidAt, paidAmount, method || null);
      await onPaid();
    } catch (payError) {
      setError(errorText(payError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Dar baixa (pagar)" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <p className="font-bold text-slate-900">{bill.description}{bill.installmentTotal ? ` (parcela ${bill.installmentNumber}/${bill.installmentTotal})` : ''}</p>
          <p className="text-slate-500">Vencimento {formatDate(bill.dueDate)} · {money(bill.amount)}{bill.supplierName ? ` · ${bill.supplierName}` : ''}</p>
        </div>
        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Data do pagamento</span>
            <input type="date" value={paidAt} max={today} onChange={event => setPaidAt(event.target.value)} className={inputClass} />
          </label>
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Valor pago (R$)</span>
            <ValueInput value={paidAmount} onValueChange={setPaidAmount} className={`${inputClass} font-mono`} />
          </label>
        </div>
        {difference !== 0 && (
          <p className={`text-[11px] font-semibold ${difference > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
            {difference > 0 ? `${money(difference)} de juros/multa` : `${money(-difference)} de desconto`}
          </p>
        )}
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Forma de pagamento</span>
          <select value={method} onChange={event => setMethod(event.target.value as PayableMethod | '')} className={inputClass}>
            <option value="">Não informada</option>
            {PAYABLE_METHODS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <p className="text-[11px] text-slate-500">A despesa entra em Despesas em {formatDate(paidAt)} e desconta do Lucro Real Operacional desse dia.</p>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">Cancelar</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50">
            {saving ? 'Salvando...' : 'Confirmar pagamento'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface RecurrencesModalProps {
  recurrences: PayableRecurrence[];
  stores: StoreConfig[];
  suppliers: Supplier[];
  categories: string[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

function RecurrencesModal({ recurrences, stores, suppliers, categories, onClose, onChanged }: RecurrencesModalProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;

  return (
    <ModalShell title="Contas que se repetem todo mês" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-slate-500">Mudanças aqui valem para as contas que ainda não venceram. "Parar de repetir" cancela as contas futuras em aberto.</p>
        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
        {message && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{message}</div>}
        {recurrences.length === 0 && <p className="py-8 text-center text-slate-400">Nenhuma conta que se repete. Crie em "Nova conta" › "Repete todo mês".</p>}
        {recurrences.map(item => (
          editingId === item.id ? (
            <React.Fragment key={item.id}>
            <RecurrenceEditor
              recurrence={item}
              suppliers={suppliers}
              categories={categories}
              onCancel={() => setEditingId(null)}
              onSaved={async text => {
                setEditingId(null);
                setError('');
                setMessage(text);
                await onChanged();
              }}
              onError={setError}
            />
            </React.Fragment>
          ) : (
            <div key={item.id} className={`flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border ${item.isActive ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-70'}`}>
              <div>
                <p className="font-bold text-slate-900">{item.description} {!item.isActive && <span className="text-[10px] font-bold text-slate-500">(parada)</span>}</p>
                <p className="text-slate-500">
                  {money(item.amount)} · todo dia {item.dueDay} · {item.category}
                  {stores.length > 1 ? ` · ${storeName(item.unitId)}` : ''}
                  {item.supplierName ? ` · ${item.supplierName}` : ''}
                  {item.isActive ? ` · ${item.monthsAhead} ${item.monthsAhead === 1 ? 'mês' : 'meses'} à frente` : ''}
                </p>
              </div>
              <button type="button" onClick={() => { setMessage(''); setEditingId(item.id); }} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 font-bold text-slate-700">
                <Edit className="w-3.5 h-3.5" />Editar
              </button>
            </div>
          )
        ))}
      </div>
    </ModalShell>
  );
}

function RecurrenceEditor({ recurrence, suppliers, categories, onCancel, onSaved, onError }: {
  recurrence: PayableRecurrence;
  suppliers: Supplier[];
  categories: string[];
  onCancel: () => void;
  onSaved: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [description, setDescription] = useState(recurrence.description);
  const [supplierId, setSupplierId] = useState(recurrence.supplierId ?? (recurrence.supplierName ? 'custom' : ''));
  const [supplierName, setSupplierName] = useState(recurrence.supplierId ? '' : recurrence.supplierName ?? '');
  const [category, setCategory] = useState(recurrence.category);
  const [amount, setAmount] = useState<number | null>(recurrence.amount);
  const [dueDay, setDueDay] = useState<number | null>(recurrence.dueDay);
  const [monthsAhead, setMonthsAhead] = useState(recurrence.monthsAhead);
  const [method, setMethod] = useState<PayableMethod | ''>(recurrence.paymentMethod ?? '');
  const [pixKey, setPixKey] = useState(recurrence.pixKey ?? '');
  const [notes, setNotes] = useState(recurrence.notes ?? '');
  const [saving, setSaving] = useState(false);

  const save = async (isActive: boolean) => {
    if (!description.trim()) return onError('Informe a descrição.');
    if (!amount || amount <= 0) return onError('Informe o valor.');
    if (!dueDay || dueDay < 1 || dueDay > 31) return onError('Dia do vencimento: de 1 a 31.');
    if (!isActive && !window.confirm('Parar de repetir? As contas futuras em aberto desta repetição serão canceladas.')) return;
    setSaving(true);
    try {
      await savePayableRecurrence(recurrence.id, {
        description: description.trim(),
        supplierId: supplierId && supplierId !== 'custom' ? supplierId : null,
        supplierName: supplierId === 'custom' ? supplierName.trim() || null : null,
        category,
        amount,
        paymentMethod: method || null,
        pixKey: pixKey.trim(),
        notes: notes.trim(),
        dueDay,
        monthsAhead,
        isActive,
      });
      await onSaved(isActive ? (recurrence.isActive ? 'Repetição atualizada.' : 'Repetição reativada.') : 'Repetição parada: as contas futuras em aberto foram canceladas.');
    } catch (saveError) {
      onError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-3 rounded-lg border border-blue-200 bg-blue-50/40 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1 col-span-2">
          <span className="font-bold text-slate-700">Descrição</span>
          <input value={description} onChange={event => setDescription(event.target.value)} maxLength={120} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Valor (R$)</span>
          <ValueInput value={amount} onValueChange={setAmount} className={`${inputClass} font-mono`} />
        </label>
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Dia do vencimento</span>
          <ValueInput decimals={0} value={dueDay} onValueChange={setDueDay} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Categoria</span>
          <select value={category} onChange={event => setCategory(event.target.value)} className={inputClass}>
            {categories.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Manter criadas</span>
          <select value={monthsAhead} onChange={event => setMonthsAhead(Number(event.target.value))} className={inputClass}>
            {Array.from({ length: 12 }, (_, index) => index + 1).map(value => (
              <option key={value} value={value}>{value} {value === 1 ? 'mês' : 'meses'} à frente</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Fornecedor</span>
          <select value={supplierId} onChange={event => setSupplierId(event.target.value)} className={inputClass}>
            <option value="">Sem fornecedor</option>
            {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            <option value="custom">Outro (digitar)</option>
          </select>
        </label>
        {supplierId === 'custom' ? (
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Nome do fornecedor</span>
            <input value={supplierName} onChange={event => setSupplierName(event.target.value)} className={inputClass} />
          </label>
        ) : (
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Forma de pagamento</span>
            <select value={method} onChange={event => setMethod(event.target.value as PayableMethod | '')} className={inputClass}>
              <option value="">Não informada</option>
              {PAYABLE_METHODS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
        )}
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Chave Pix</span>
          <input value={pixKey} onChange={event => setPixKey(event.target.value)} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">Observação</span>
          <input value={notes} onChange={event => setNotes(event.target.value)} className={inputClass} />
        </label>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        {recurrence.isActive ? (
          <button type="button" disabled={saving} onClick={() => void save(false)} className="px-3 py-2 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 font-bold disabled:opacity-50">Parar de repetir</button>
        ) : <span />}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">Cancelar</button>
          <button type="button" disabled={saving} onClick={() => void save(true)} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">
            {saving ? 'Salvando...' : recurrence.isActive ? 'Salvar' : 'Salvar e reativar'}
          </button>
        </div>
      </div>
    </div>
  );
}
