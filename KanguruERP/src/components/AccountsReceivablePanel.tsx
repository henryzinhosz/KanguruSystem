import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, Ban, CalendarClock, CheckCircle2, Clock, Copy, Eye, HandCoins, MessageCircle, Paperclip, Plus, Search, Trash2, Undo2, X,
} from 'lucide-react';
import type { Customer, Product, ProductStoreCost, StockInventory, StoreConfig, User } from '../types';
import { UserRole } from '../types';
import ValueInput from './ValueInput';
import { supabaseService } from '../db/supabaseService';
import { toLocalDateKey } from '../db/finance';
import {
  RECEIVABLE_KINDS, RECEIVABLE_METHODS, cancelReceivable, deleteReceivable, installmentState, kindLabel, listReceivables,
  openReceivableAttachment, receivableMethodLabel, receiveReceivable, registerReceivableCharge, saveReceivable, undoReceivablePayment,
  uploadReceivableAttachment, type ReceivableInstallment, type ReceivableKind, type ReceivableMethod, type ReceivableTitle,
} from '../db/receivableTitles';

// Contas a Receber (desenho aprovado em 2026-11-23): cobrar outro franqueado ou pessoa. Três tipos
// (mercadoria repassada, empréstimo/acerto, serviço/outros), parcelas com baixa própria, cobrança no
// WhatsApp com a chave Pix da loja. Sem juros/multa.

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDate = (key: string) => (key ? key.split('-').reverse().join('/') : '');
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco';
const inputClass = 'w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-blue-500';
const round2 = (value: number) => Math.round(value * 100) / 100;
const digits = (value: string) => value.replace(/\D/g, '');

const addDays = (key: string, days: number) => {
  const [y, m, d] = key.split('-').map(Number);
  return toLocalDateKey(new Date(y, m - 1, d + days));
};
const addMonths = (key: string, months: number) => {
  const [y, m, d] = key.split('-').map(Number);
  const last = new Date(y, m - 1 + months + 1, 0).getDate();
  return toLocalDateKey(new Date(y, m - 1 + months, Math.min(d, last)));
};

const STATE_INFO = {
  RECEBIDA: { label: 'Recebida', tone: 'bg-emerald-100 text-emerald-800' },
  CANCELADA: { label: 'Cancelada', tone: 'bg-slate-200 text-slate-600' },
  VENCIDA: { label: 'Vencida', tone: 'bg-rose-100 text-rose-800' },
  VENCE_HOJE: { label: 'Vence hoje', tone: 'bg-amber-100 text-amber-800' },
  PARCIAL: { label: 'Recebida em parte', tone: 'bg-blue-100 text-blue-800' },
  A_VENCER: { label: 'A vencer', tone: 'bg-slate-100 text-slate-700' },
} as const;

interface Props {
  currentUser: User;
  storeConfigs: StoreConfig[];
  products: Product[];
  inventory: StockInventory[];
  productStoreCosts: ProductStoreCost[];
  onChanged: () => void | Promise<void>;
}

type Row = { title: ReceivableTitle; installment: ReceivableInstallment };
type Filter = 'ABERTAS' | 'VENCIDAS' | 'RECEBIDAS' | 'CANCELADAS' | 'TODAS';

export default function AccountsReceivablePanel({ currentUser, storeConfigs, products, inventory, productStoreCosts, onChanged }: Props) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;
  const today = toLocalDateKey(new Date());
  const [titles, setTitles] = useState<ReceivableTitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState<Filter>('ABERTAS');
  const [storeFilter, setStoreFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<ReceivableKind | ''>('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [receiving, setReceiving] = useState<Row | null>(null);
  const [charging, setCharging] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTitles(await listReceivables());
      setError('');
    } catch (loadError) {
      setError(`Não foi possível carregar as contas a receber: ${errorText(loadError)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = async (text?: string) => {
    await load();
    await onChanged();
    if (text) setMessage(text);
  };

  const rows: Row[] = useMemo(() => titles.flatMap(title => title.installments.map(installment => ({ title, installment }))), [titles]);
  const open = rows.filter(row => row.title.status === 'ATIVO' && (row.installment.status === 'ABERTO' || row.installment.status === 'PARCIAL'));
  const remaining = (row: Row) => round2(row.installment.amount - row.installment.receivedAmount);
  const sum = (list: Row[]) => list.reduce((total, row) => total + remaining(row), 0);
  const month = today.slice(0, 7);
  const receivedMonth = titles.flatMap(title => title.installments.flatMap(item => item.payments))
    .filter(payment => payment.paidAt.startsWith(month)).reduce((total, payment) => total + payment.amount, 0);
  const cards = [
    { label: 'Vencidas', value: sum(open.filter(row => row.installment.dueDate < today)), count: open.filter(row => row.installment.dueDate < today).length, icon: AlertCircle, tone: 'text-rose-600', iconTone: 'bg-rose-50 text-rose-600 border-rose-100' },
    { label: 'Vence hoje', value: sum(open.filter(row => row.installment.dueDate === today)), count: open.filter(row => row.installment.dueDate === today).length, icon: Clock, tone: 'text-amber-600', iconTone: 'bg-amber-50 text-amber-600 border-amber-100' },
    { label: 'Próximos 7 dias', value: sum(open.filter(row => row.installment.dueDate > today && row.installment.dueDate <= addDays(today, 7))), count: open.filter(row => row.installment.dueDate > today && row.installment.dueDate <= addDays(today, 7)).length, icon: CalendarClock, tone: 'text-blue-600', iconTone: 'bg-blue-50 text-blue-600 border-blue-100' },
    { label: 'Recebido no mês', value: receivedMonth, count: null, icon: CheckCircle2, tone: 'text-emerald-600', iconTone: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
    { label: 'Total em aberto', value: sum(open), count: open.length, icon: HandCoins, tone: 'text-slate-900', iconTone: 'bg-slate-50 text-slate-600 border-slate-200' },
  ];

  const term = search.trim().toLowerCase();
  const visible = rows.filter(row => {
    const state = installmentState(row.installment, today);
    if (filter === 'ABERTAS' && (row.title.status !== 'ATIVO' || state === 'RECEBIDA' || state === 'CANCELADA')) return false;
    if (filter === 'VENCIDAS' && (row.title.status !== 'ATIVO' || state !== 'VENCIDA')) return false;
    if (filter === 'RECEBIDAS' && state !== 'RECEBIDA') return false;
    if (filter === 'CANCELADAS' && row.title.status !== 'CANCELADO') return false;
    if (storeFilter && row.title.unitId !== storeFilter) return false;
    if (kindFilter && row.title.kind !== kindFilter) return false;
    if (term) {
      const text = [row.title.debtorName, row.title.description, row.title.documentNumber, row.title.debtorDocument, row.title.debtorPhone, String(row.title.number)]
        .filter(Boolean).join(' ').toLowerCase();
      if (!text.includes(term)) return false;
    }
    return true;
  }).sort((a, b) => a.installment.dueDate.localeCompare(b.installment.dueDate));

  const detail = titles.find(title => title.id === detailId) ?? null;
  const pixOf = (unitId: string) => stores.find(store => store.unitId === unitId)?.pixKey || '';

  return (
    <div className="space-y-4 font-sans text-xs">
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center"><HandCoins className="w-5 h-5 text-emerald-600 mr-2" />Contas a Receber</h3>
          <p className="text-xs text-slate-400">Valores que outro franqueado ou uma pessoa deve à loja. Nada daqui entra no faturamento de vendas nem no repasse.</p>
        </div>
        <button type="button" onClick={() => setFormOpen(true)} className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg">
          <Plus className="w-4 h-4" /> Nova conta a receber
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {cards.map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center justify-between">
              <div>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{card.label}</p>
                <p className={`text-lg font-black mt-1 font-mono ${card.tone}`}>{money(card.value)}</p>
                {card.count !== null && <p className="text-[10px] text-slate-400 font-semibold">{card.count} parcela(s)</p>}
              </div>
              <span className={`p-2.5 rounded-lg border ${card.iconTone}`}><Icon className="w-5 h-5" /></span>
            </div>
          );
        })}
      </div>

      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="block font-bold text-slate-500">Situação</span>
            <select value={filter} onChange={event => setFilter(event.target.value as Filter)} className={inputClass}>
              <option value="ABERTAS">Em aberto</option>
              <option value="VENCIDAS">Vencidas</option>
              <option value="RECEBIDAS">Recebidas</option>
              <option value="CANCELADAS">Canceladas</option>
              <option value="TODAS">Todas</option>
            </select>
          </label>
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
            <span className="block font-bold text-slate-500">Tipo</span>
            <select value={kindFilter} onChange={event => setKindFilter(event.target.value as ReceivableKind | '')} className={inputClass}>
              <option value="">Todos</option>
              {RECEIVABLE_KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
            </select>
          </label>
          <label className="space-y-1 flex-1 min-w-[200px]">
            <span className="block font-bold text-slate-500">Buscar</span>
            <span className="relative block">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Devedor, descrição, documento, nº" className={`${inputClass} pl-8`} />
            </span>
          </label>
        </div>

        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
        {message && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{message}</div>}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-slate-600 min-w-[820px]">
            <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
              <tr>
                <th className="px-3 py-2">Vencimento</th>
                <th className="px-3 py-2">Devedor</th>
                <th className="px-3 py-2">Descrição</th>
                <th className="px-3 py-2 text-right">Valor</th>
                <th className="px-3 py-2">Situação</th>
                <th className="px-3 py-2 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Carregando...</td></tr>}
              {!loading && visible.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Nenhuma conta nesta situação.</td></tr>}
              {visible.map(row => {
                const state = row.title.status === 'CANCELADO' ? 'CANCELADA' : installmentState(row.installment, today);
                const info = STATE_INFO[state];
                const isOpen = row.title.status === 'ATIVO' && (row.installment.status === 'ABERTO' || row.installment.status === 'PARCIAL');
                const total = row.title.installments.filter(item => item.number > 0).length;
                return (
                  <tr key={row.installment.id} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2.5 font-mono font-semibold text-slate-800 whitespace-nowrap">{formatDate(row.installment.dueDate)}</td>
                    <td className="px-3 py-2.5">
                      <span className="font-bold text-slate-900 block">{row.title.debtorName}</span>
                      {row.title.debtorPhone && <span className="text-[10px] text-slate-400 font-mono">{row.title.debtorPhone}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-slate-800 block">{row.title.description}</span>
                      <span className="text-[10px] text-slate-400">
                        Nº {row.title.number} · {row.installment.number === 0 ? 'Entrada' : `Parcela ${row.installment.number}/${total}`} · {kindLabel(row.title.kind)}
                        {stores.length > 1 ? ` · ${storeName(row.title.unitId)}` : ''}
                        {row.title.chargeCount > 0 ? ` · cobrado ${row.title.chargeCount}x` : ''}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap">
                      <span className="font-bold text-slate-900 block">{money(row.installment.amount)}</span>
                      {row.installment.receivedAmount > 0 && row.installment.status !== 'RECEBIDO' && <span className="text-[10px] text-blue-700">falta {money(remaining(row))}</span>}
                    </td>
                    <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${info.tone}`}>{info.label}</span></td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-1.5">
                        {isOpen && (
                          <>
                            <button type="button" onClick={() => setReceiving(row)} className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold text-[10px]">Receber</button>
                            <button type="button" onClick={() => setCharging(row)} title="Cobrar no WhatsApp" className="p-1.5 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50"><MessageCircle className="w-3.5 h-3.5" /></button>
                          </>
                        )}
                        <button type="button" onClick={() => setDetailId(row.title.id)} title="Ver detalhes" className="p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"><Eye className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {formOpen && (
        <ReceivableFormModal
          stores={stores}
          products={products}
          inventory={inventory}
          productStoreCosts={productStoreCosts}
          onClose={() => setFormOpen(false)}
          onSaved={async text => { setFormOpen(false); await refresh(text); }}
        />
      )}
      {receiving && (
        <ReceiveModal
          row={receiving}
          onClose={() => setReceiving(null)}
          onDone={async text => { setReceiving(null); await refresh(text); }}
        />
      )}
      {charging && (
        <WhatsAppModal
          row={charging}
          storeName={storeName(charging.title.unitId)}
          pixKey={pixOf(charging.title.unitId)}
          remaining={remaining(charging)}
          onClose={() => setCharging(null)}
          onSent={async () => { setCharging(null); await load(); }}
        />
      )}
      {detail && (
        <DetailModal
          title={detail}
          isAdmin={isAdmin}
          tenantId={currentUser.tenantId ?? null}
          storeName={storeName(detail.unitId)}
          onClose={() => setDetailId(null)}
          onChanged={async text => { await refresh(text); }}
          onDeleted={async text => { setDetailId(null); await refresh(text); }}
        />
      )}
    </div>
  );
}

// ---- Nova conta ----

interface FormProps {
  stores: StoreConfig[];
  products: Product[];
  inventory: StockInventory[];
  productStoreCosts: ProductStoreCost[];
  onClose: () => void;
  onSaved: (text: string) => void | Promise<void>;
}

type StockLine = { key: number; productId: string; quantity: number; serials: string[]; available: string[] };
type FreeLine = { key: number; description: string; quantity: number; unitPrice: number | null; serial: string };
let lineKey = 1;

function ReceivableFormModal({ stores, products, inventory, productStoreCosts, onClose, onSaved }: FormProps) {
  const today = toLocalDateKey(new Date());
  const [kind, setKind] = useState<ReceivableKind>('MERCADORIA');
  const [unitId, setUnitId] = useState(stores[0]?.unitId || '');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [debtorName, setDebtorName] = useState('');
  const [debtorDocument, setDebtorDocument] = useState('');
  const [debtorPhone, setDebtorPhone] = useState('');
  const [debtorEmail, setDebtorEmail] = useState('');
  const [description, setDescription] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [issueDate, setIssueDate] = useState(today);
  const [stockLines, setStockLines] = useState<StockLine[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [freeLines, setFreeLines] = useState<FreeLine[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [downPayment, setDownPayment] = useState<number | null>(null);
  const [downReceived, setDownReceived] = useState(false);
  const [downMethod, setDownMethod] = useState<ReceivableMethod>('PIX');
  const [count, setCount] = useState<number | null>(1);
  const [frequency, setFrequency] = useState<'MENSAL' | 'QUINZENAL' | 'SEMANAL' | 'PRAZO'>('MENSAL');
  const [firstDue, setFirstDue] = useState(addDays(today, 7));
  const [termDays, setTermDays] = useState('30/60/90');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabaseService.getCustomers().then(setCustomers).catch(() => setCustomers([]));
  }, []);

  const activeProducts = products.filter(product => !product.archivedAt);
  const stockOf = (productId: string) => inventory.find(item => item.productId === productId)?.quantities[unitId]?.qty || 0;
  const avgCost = (product: Product) => productStoreCosts.find(cost => cost.productId === product.id && cost.unitId === unitId)?.avgCost ?? product.costPrice;
  const estimatedCost = stockLines.reduce((totalCost, line) => {
    const product = products.find(item => item.id === line.productId);
    if (!product) return totalCost;
    const qty = product.isSerialized ? line.serials.length : line.quantity;
    return totalCost + avgCost(product) * qty;
  }, 0);
  const freeTotal = freeLines.reduce((acc, line) => acc + (line.unitPrice ?? 0) * line.quantity, 0);

  const addProduct = async (product: Product) => {
    setProductSearch('');
    let available: string[] = [];
    if (product.isSerialized) {
      try {
        available = (await supabaseService.getProductSerials(product.id)).filter(row => row.unitId === unitId && row.status === 'DISPONIVEL').map(row => row.serial);
      } catch {
        available = [];
      }
    }
    setStockLines(previous => [...previous, { key: lineKey++, productId: product.id, quantity: 1, serials: [], available }]);
  };

  const productResults = productSearch.trim()
    ? activeProducts.filter(product => (product.name.toLowerCase().includes(productSearch.toLowerCase()) || product.sku.toLowerCase().includes(productSearch.toLowerCase())) && stockOf(product.id) > 0).slice(0, 8)
    : [];
  const customerResults = customerSearch.trim()
    ? customers.filter(customer => customer.name.toLowerCase().includes(customerSearch.toLowerCase()) || customer.cpf.includes(digits(customerSearch))).slice(0, 6)
    : [];

  // Parcelas (entrada + N parcelas).
  const schedule = useMemo(() => {
    const totalValue = total ?? 0;
    const down = Math.min(downPayment ?? 0, totalValue);
    const rest = round2(totalValue - down);
    const list: { dueDate: string; amount: number; downPayment?: boolean }[] = [];
    if (down > 0) list.push({ dueDate: issueDate, amount: round2(down), downPayment: true });
    if (rest <= 0) return list;
    let dates: string[] = [];
    if (frequency === 'PRAZO') {
      const offsets = termDays.split(/[^0-9]+/).map(Number).filter(value => value > 0);
      dates = offsets.map(offset => addDays(issueDate, offset));
    } else {
      const n = Math.max(1, Math.min(48, count ?? 1));
      dates = Array.from({ length: n }, (_, index) => frequency === 'MENSAL' ? addMonths(firstDue, index) : addDays(firstDue, index * (frequency === 'QUINZENAL' ? 15 : 7)));
    }
    if (dates.length === 0) return list;
    const each = Math.floor((rest / dates.length) * 100) / 100;
    dates.forEach((date, index) => list.push({ dueDate: date, amount: index === dates.length - 1 ? round2(rest - each * (dates.length - 1)) : each }));
    return list;
  }, [total, downPayment, issueDate, frequency, termDays, count, firstDue]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError('');
    if (!debtorName.trim()) return setError('Informe quem deve.');
    if (!debtorPhone.trim()) return setError('Informe o WhatsApp de quem deve (para a cobrança).');
    if (!total || total <= 0) return setError('Informe o valor total.');
    if (kind === 'MERCADORIA') {
      if (stockLines.length === 0) return setError('Escolha os produtos que saem do estoque.');
      for (const line of stockLines) {
        const product = products.find(item => item.id === line.productId);
        if (product?.isSerialized && line.serials.length === 0) return setError(`${product.name}: marque os seriais que saem.`);
        if (product && !product.isSerialized && (line.quantity <= 0 || line.quantity > stockOf(product.id))) return setError(`${product.name}: quantidade maior que o estoque.`);
      }
    } else if (!description.trim() && freeLines.length === 0) {
      return setError('Informe a descrição.');
    }
    if (schedule.length === 0 || schedule.some(item => item.amount <= 0)) return setError('Confira as parcelas.');
    setSaving(true);
    try {
      await saveReceivable(null, {
        unitId, kind, category: kindLabel(kind), debtorName, debtorDocument, debtorPhone, debtorEmail, customerId,
        description, documentNumber, notes, issueDate, totalAmount: total,
        items: kind === 'MERCADORIA'
          ? stockLines.map(line => ({ productId: line.productId, quantity: line.quantity, serials: line.serials }))
          : freeLines.map(line => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice ?? 0, serial: line.serial })),
        installments: schedule,
        downPaymentReceived: downReceived && schedule.some(item => item.downPayment) ? { method: downMethod, paidAt: issueDate } : null,
      });
      await onSaved(kind === 'MERCADORIA' ? 'Conta a receber criada. Os produtos saíram do estoque.' : 'Conta a receber criada.');
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <form onSubmit={submit} className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-3xl w-full max-h-[92vh] overflow-y-auto p-5 space-y-4 text-xs">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">Nova conta a receber</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {RECEIVABLE_KINDS.map(item => (
            <button key={item.value} type="button" onClick={() => setKind(item.value)}
              className={`text-left rounded-lg border p-3 ${kind === item.value ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500' : 'border-slate-200 hover:bg-slate-50'}`}>
              <strong className="block text-slate-900">{item.label}</strong>
              <span className="text-[11px] text-slate-500">{item.hint}</span>
            </button>
          ))}
        </div>

        <section className="space-y-2 bg-slate-50 border border-slate-100 rounded-lg p-3">
          <h4 className="font-bold text-slate-700 uppercase tracking-wider text-[10px]">Quem deve</h4>
          <div className="relative">
            <input value={customerSearch} onChange={event => setCustomerSearch(event.target.value)} placeholder="Buscar no cadastro de clientes (opcional)" className={inputClass} />
            {customerResults.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg divide-y divide-slate-100">
                {customerResults.map(customer => (
                  <button key={customer.id} type="button" className="w-full text-left px-3 py-2 hover:bg-slate-50" onClick={() => {
                    setCustomerId(customer.id); setDebtorName(customer.name); setDebtorDocument(customer.cpf); setDebtorPhone(customer.phone || ''); setDebtorEmail(customer.email || ''); setCustomerSearch('');
                  }}>
                    <strong>{customer.name}</strong> <span className="text-slate-500">· {customer.cpf}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="space-y-1"><span className="font-bold text-slate-600">Nome / razão social *</span>
              <input value={debtorName} onChange={event => { setDebtorName(event.target.value); setCustomerId(null); }} className={inputClass} /></label>
            <label className="space-y-1"><span className="font-bold text-slate-600">CPF ou CNPJ</span>
              <input value={debtorDocument} onChange={event => setDebtorDocument(event.target.value)} className={inputClass} /></label>
            <label className="space-y-1"><span className="font-bold text-slate-600">WhatsApp (com DDD) *</span>
              <input value={debtorPhone} onChange={event => setDebtorPhone(event.target.value)} placeholder="(21) 99999-9999" className={inputClass} /></label>
            <label className="space-y-1"><span className="font-bold text-slate-600">E-mail</span>
              <input value={debtorEmail} onChange={event => setDebtorEmail(event.target.value)} className={inputClass} /></label>
          </div>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {stores.length > 1 && (
            <label className="space-y-1"><span className="font-bold text-slate-600">Loja</span>
              <select value={unitId} onChange={event => { setUnitId(event.target.value); setStockLines([]); }} className={inputClass}>
                {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
              </select></label>
          )}
          <label className="space-y-1"><span className="font-bold text-slate-600">Data</span>
            <input type="date" value={issueDate} max={today} onChange={event => setIssueDate(event.target.value)} className={inputClass} /></label>
          <label className="space-y-1"><span className="font-bold text-slate-600">Nº do documento / nota</span>
            <input value={documentNumber} onChange={event => setDocumentNumber(event.target.value)} className={inputClass} /></label>
          <label className="space-y-1 sm:col-span-3"><span className="font-bold text-slate-600">Descrição {kind === 'MERCADORIA' ? '(em branco = lista dos produtos)' : '*'}</span>
            <input value={description} onChange={event => setDescription(event.target.value)} placeholder={kind === 'MERCADORIA' ? 'Ex.: 3 PS5 para a BeB Barra' : 'Ex.: Empréstimo de caixa'} className={inputClass} /></label>
        </section>

        {kind === 'MERCADORIA' ? (
          <section className="space-y-2 border border-emerald-100 bg-emerald-50/40 rounded-lg p-3">
            <h4 className="font-bold text-emerald-900 uppercase tracking-wider text-[10px]">Produtos que saem do estoque agora</h4>
            <div className="relative">
              <input value={productSearch} onChange={event => setProductSearch(event.target.value)} placeholder="Buscar produto com estoque nesta loja" className={inputClass} />
              {productResults.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg divide-y divide-slate-100">
                  {productResults.map(product => (
                    <button key={product.id} type="button" onClick={() => void addProduct(product)} className="w-full text-left px-3 py-2 hover:bg-slate-50">
                      <strong>{product.name}</strong> <span className="text-slate-500">· {product.sku} · {stockOf(product.id)} em estoque</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {stockLines.map(line => {
              const product = products.find(item => item.id === line.productId);
              if (!product) return null;
              return (
                <div key={line.key} className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-slate-800">{product.name}</strong>
                    <button type="button" onClick={() => setStockLines(previous => previous.filter(item => item.key !== line.key))} className="text-slate-400 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  {product.isSerialized ? (
                    line.available.length === 0 ? <p className="text-rose-700">Nenhum serial disponível nesta loja.</p> : (
                      <div className="flex flex-wrap gap-1.5">
                        {line.available.map(serial => (
                          <label key={serial} className={`px-2 py-1 rounded border font-mono cursor-pointer ${line.serials.includes(serial) ? 'bg-emerald-600 text-white border-emerald-600' : 'border-slate-200 hover:bg-slate-50'}`}>
                            <input type="checkbox" className="hidden" checked={line.serials.includes(serial)} onChange={() => setStockLines(previous => previous.map(item => item.key !== line.key ? item : {
                              ...item, serials: item.serials.includes(serial) ? item.serials.filter(value => value !== serial) : [...item.serials, serial],
                            }))} />
                            {serial}
                          </label>
                        ))}
                      </div>
                    )
                  ) : (
                    <label className="flex items-center gap-2"><span className="font-semibold text-slate-600">Quantidade</span>
                      <ValueInput decimals={0} value={line.quantity} onValueChange={value => setStockLines(previous => previous.map(item => item.key === line.key ? { ...item, quantity: value ?? 0 } : item))} className={`${inputClass} w-24`} />
                      <span className="text-slate-400">de {stockOf(product.id)}</span></label>
                  )}
                </div>
              );
            })}
            {stockLines.length > 0 && (
              <p className="text-emerald-900">Custo estimado: <strong className="font-mono">{money(estimatedCost)}</strong>
                <button type="button" onClick={() => setTotal(round2(estimatedCost))} className="ml-2 font-bold text-emerald-700 underline">Cobrar a preço de custo</button></p>
            )}
          </section>
        ) : (
          <section className="space-y-2 border border-slate-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-700 uppercase tracking-wider text-[10px]">Itens negociados (opcional, só registro)</h4>
              <button type="button" onClick={() => setFreeLines(previous => [...previous, { key: lineKey++, description: '', quantity: 1, unitPrice: null, serial: '' }])} className="font-bold text-blue-700">+ item</button>
            </div>
            {freeLines.map(line => (
              <div key={line.key} className="grid grid-cols-[1fr_70px_110px_130px_24px] gap-1.5">
                <input value={line.description} onChange={event => setFreeLines(previous => previous.map(item => item.key === line.key ? { ...item, description: event.target.value } : item))} placeholder="Descrição" className={inputClass} />
                <ValueInput decimals={0} value={line.quantity} onValueChange={value => setFreeLines(previous => previous.map(item => item.key === line.key ? { ...item, quantity: value ?? 1 } : item))} className={inputClass} />
                <ValueInput value={line.unitPrice} onValueChange={value => setFreeLines(previous => previous.map(item => item.key === line.key ? { ...item, unitPrice: value } : item))} placeholder="Valor" className={inputClass} />
                <input value={line.serial} onChange={event => setFreeLines(previous => previous.map(item => item.key === line.key ? { ...item, serial: event.target.value } : item))} placeholder="Serial" className={inputClass} />
                <button type="button" onClick={() => setFreeLines(previous => previous.filter(item => item.key !== line.key))} className="text-slate-400 hover:text-rose-600"><X className="w-4 h-4" /></button>
              </div>
            ))}
            {freeLines.length > 0 && freeTotal > 0 && (
              <button type="button" onClick={() => setTotal(round2(freeTotal))} className="font-bold text-blue-700 underline">Usar a soma dos itens ({money(freeTotal)}) como total</button>
            )}
          </section>
        )}

        <section className="space-y-2 border border-slate-200 rounded-lg p-3">
          <h4 className="font-bold text-slate-700 uppercase tracking-wider text-[10px]">Valor e parcelas</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <label className="space-y-1"><span className="font-bold text-slate-600">Valor total *</span>
              <ValueInput value={total} onValueChange={setTotal} className={`${inputClass} font-mono`} /></label>
            <label className="space-y-1"><span className="font-bold text-slate-600">Entrada</span>
              <ValueInput value={downPayment} onValueChange={setDownPayment} className={`${inputClass} font-mono`} /></label>
            <label className="space-y-1"><span className="font-bold text-slate-600">Intervalo</span>
              <select value={frequency} onChange={event => setFrequency(event.target.value as typeof frequency)} className={inputClass}>
                <option value="MENSAL">Mensal</option>
                <option value="QUINZENAL">Quinzenal</option>
                <option value="SEMANAL">Semanal</option>
                <option value="PRAZO">Prazo em dias</option>
              </select></label>
            {frequency === 'PRAZO' ? (
              <label className="space-y-1"><span className="font-bold text-slate-600">Dias depois da data</span>
                <input value={termDays} onChange={event => setTermDays(event.target.value)} placeholder="30/60/90" className={inputClass} /></label>
            ) : (
              <label className="space-y-1"><span className="font-bold text-slate-600">Parcelas</span>
                <ValueInput decimals={0} value={count} onValueChange={setCount} className={inputClass} /></label>
            )}
            {frequency !== 'PRAZO' && (
              <label className="space-y-1"><span className="font-bold text-slate-600">1º vencimento</span>
                <input type="date" value={firstDue} onChange={event => setFirstDue(event.target.value)} className={inputClass} /></label>
            )}
          </div>
          {(downPayment ?? 0) > 0 && (
            <label className="flex flex-wrap items-center gap-2">
              <input type="checkbox" checked={downReceived} onChange={event => setDownReceived(event.target.checked)} />
              <span className="font-semibold text-slate-700">A entrada já foi recebida</span>
              {downReceived && (
                <select value={downMethod} onChange={event => setDownMethod(event.target.value as ReceivableMethod)} className={`${inputClass} w-40`}>
                  {RECEIVABLE_METHODS.map(method => <option key={method.value} value={method.value}>{method.label}</option>)}
                </select>
              )}
            </label>
          )}
          {schedule.length > 0 && (
            <div className="border border-slate-100 rounded-lg divide-y divide-slate-100">
              {schedule.map((item, index) => (
                <div key={index} className="flex justify-between px-3 py-1.5">
                  <span>{item.downPayment ? 'Entrada' : `Parcela ${schedule.filter(entry => !entry.downPayment).indexOf(item) + 1}`} · {formatDate(item.dueDate)}</span>
                  <strong className="font-mono">{money(item.amount)}</strong>
                </div>
              ))}
            </div>
          )}
          <label className="space-y-1 block"><span className="font-bold text-slate-600">Observações</span>
            <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} className={inputClass} /></label>
        </section>

        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 border border-slate-200 text-slate-600 rounded hover:bg-slate-50">Cancelar</button>
          <button type="submit" disabled={saving} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded">{saving ? 'Salvando...' : 'Criar conta a receber'}</button>
        </div>
      </form>
    </div>
  );
}

// ---- Receber ----

function ReceiveModal({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: (text: string) => void | Promise<void> }) {
  const today = toLocalDateKey(new Date());
  const left = round2(row.installment.amount - row.installment.receivedAmount);
  const [amount, setAmount] = useState<number | null>(left);
  const [paidAt, setPaidAt] = useState(today);
  const [method, setMethod] = useState<ReceivableMethod>('PIX');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!amount || amount <= 0) return setError('Informe o valor recebido.');
    setSaving(true);
    try {
      await receiveReceivable(row.installment.id, amount, paidAt, method);
      await onDone(amount < left ? `Recebido ${money(amount)}. Ainda falta ${money(round2(left - amount))} nesta parcela.` : 'Parcela recebida.');
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <form onSubmit={submit} className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3 text-xs">
        <h3 className="text-sm font-bold text-slate-900">Receber · {row.title.debtorName}</h3>
        <p className="text-slate-500">{row.title.description} · {row.installment.number === 0 ? 'Entrada' : `Parcela ${row.installment.number}`} · falta <strong>{money(left)}</strong></p>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1"><span className="font-bold text-slate-600">Valor recebido</span>
            <ValueInput value={amount} onValueChange={setAmount} className={`${inputClass} font-mono`} /></label>
          <label className="space-y-1"><span className="font-bold text-slate-600">Data</span>
            <input type="date" value={paidAt} max={today} onChange={event => setPaidAt(event.target.value)} className={inputClass} /></label>
          <label className="space-y-1 col-span-2"><span className="font-bold text-slate-600">Forma</span>
            <select value={method} onChange={event => setMethod(event.target.value as ReceivableMethod)} className={inputClass}>
              {RECEIVABLE_METHODS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select></label>
        </div>
        {row.title.kind === 'MERCADORIA' && <p className="text-slate-500">No lucro entra só a diferença entre o valor e o custo da mercadoria.</p>}
        {row.title.kind === 'ACERTO' && <p className="text-slate-500">Empréstimo / acerto: entra no caixa, não no lucro.</p>}
        {row.title.kind === 'OUTROS' && <p className="text-slate-500">Entra no DRE como "Outras receitas" na data do recebimento.</p>}
        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 border border-slate-200 text-slate-600 rounded hover:bg-slate-50">Cancelar</button>
          <button type="submit" disabled={saving} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded">{saving ? 'Salvando...' : 'Confirmar recebimento'}</button>
        </div>
      </form>
    </div>
  );
}

// ---- WhatsApp ----

function WhatsAppModal({ row, storeName, pixKey, remaining, onClose, onSent }: {
  row: Row; storeName: string; pixKey: string; remaining: number; onClose: () => void; onSent: () => void | Promise<void>;
}) {
  const [text, setText] = useState(() => [
    `Olá, *${row.title.debtorName}*! Tudo bem?`,
    '',
    `Aqui é do financeiro da *${storeName}*. Passando para lembrar do valor em aberto:`,
    `📋 *Descrição:* ${row.title.description}`,
    row.title.documentNumber ? `📄 *Documento:* ${row.title.documentNumber}` : '',
    `💰 *Valor:* ${money(remaining)}`,
    `📅 *Vencimento:* ${formatDate(row.installment.dueDate)}`,
    pixKey ? `\n🔑 *Chave Pix:* ${pixKey}` : '',
    '',
    'Depois do pagamento, é só responder com o comprovante. Se já pagou, desconsidere esta mensagem.',
    `Obrigado!\n*${storeName}*`,
  ].filter(line => line !== '').join('\n'));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const phone = (() => {
    const value = digits(row.title.debtorPhone || '');
    return value.startsWith('55') || value.length > 11 ? value : `55${value}`;
  })();

  async function send() {
    try {
      await registerReceivableCharge(row.title.id);
    } catch (chargeError) {
      setError(errorText(chargeError));
      return;
    }
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
    await onSent();
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 text-xs">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2"><MessageCircle className="w-4 h-4 text-emerald-600" />Cobrar no WhatsApp</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-slate-500">{row.title.debtorName} · {row.title.debtorPhone || 'sem WhatsApp'}{row.title.chargeCount > 0 ? ` · já cobrado ${row.title.chargeCount}x` : ''}</p>
        {!pixKey && <p className="p-2 rounded bg-amber-50 border border-amber-200 text-amber-800">A loja ainda não tem chave Pix. Cadastre em Configurações › Lojas › Dados.</p>}
        <textarea value={text} onChange={event => setText(event.target.value)} rows={12} className={`${inputClass} font-mono leading-relaxed`} />
        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
        <div className="flex justify-between gap-2">
          <button type="button" onClick={async () => { await navigator.clipboard.writeText(text).catch(() => undefined); setCopied(true); }} className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-200 rounded text-slate-700 hover:bg-slate-50">
            <Copy className="w-3.5 h-3.5" />{copied ? 'Copiado!' : 'Copiar texto'}
          </button>
          <button type="button" disabled={!row.title.debtorPhone} onClick={() => void send()} className="inline-flex items-center gap-1 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded">
            <MessageCircle className="w-3.5 h-3.5" />Abrir no WhatsApp
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Detalhes ----

function DetailModal({ title, isAdmin, tenantId, storeName, onClose, onChanged, onDeleted }: {
  title: ReceivableTitle; isAdmin: boolean; tenantId: string | null; storeName: string;
  onClose: () => void; onChanged: (text: string) => void | Promise<void>; onDeleted: (text: string) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>, text: string, deleted = false) => {
    setBusy(true);
    setError('');
    try {
      await action();
      if (deleted) await onDeleted(text); else await onChanged(text);
    } catch (runError) {
      setError(errorText(runError));
    } finally {
      setBusy(false);
    }
  };
  const received = title.installments.reduce((total, item) => total + item.receivedAmount, 0);
  const hasPayments = title.installments.some(item => item.payments.length > 0);

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-2xl w-full max-h-[92vh] overflow-y-auto p-5 space-y-4 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Conta a receber nº {title.number} · {title.debtorName}</h3>
            <p className="text-slate-500">{kindLabel(title.kind)} · {storeName} · criada em {formatDate(title.issueDate)}{title.createdByName ? ` por ${title.createdByName}` : ''}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-50 border border-slate-100 rounded-lg p-3">
          <div><span className="text-slate-500 block">Total</span><strong className="font-mono">{money(title.totalAmount)}</strong></div>
          <div><span className="text-slate-500 block">Recebido</span><strong className="font-mono text-emerald-700">{money(received)}</strong></div>
          <div><span className="text-slate-500 block">Falta</span><strong className="font-mono">{money(round2(title.totalAmount - received))}</strong></div>
          {title.kind === 'MERCADORIA' && <div><span className="text-slate-500 block">Custo da mercadoria</span><strong className="font-mono">{money(title.totalCost)}</strong></div>}
        </div>

        <div className="space-y-1 text-slate-700">
          <p><strong>Descrição:</strong> {title.description}</p>
          {title.debtorDocument && <p><strong>CPF/CNPJ:</strong> {title.debtorDocument}</p>}
          {title.debtorPhone && <p><strong>WhatsApp:</strong> {title.debtorPhone}</p>}
          {title.debtorEmail && <p><strong>E-mail:</strong> {title.debtorEmail}</p>}
          {title.documentNumber && <p><strong>Documento:</strong> {title.documentNumber}</p>}
          {title.notes && <p><strong>Observações:</strong> {title.notes}</p>}
          {title.chargeCount > 0 && <p><strong>Cobranças no WhatsApp:</strong> {title.chargeCount}{title.lastChargeAt ? ` (última em ${new Date(title.lastChargeAt).toLocaleString('pt-BR')})` : ''}</p>}
        </div>

        {title.items.length > 0 && (
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
            {title.items.map((item, index) => (
              <div key={index} className="flex justify-between gap-2 px-3 py-1.5">
                <span>{item.quantity}x {item.name || item.description}{Array.isArray(item.serials) && item.serials.length > 0 ? ` · ${item.serials.join(', ')}` : item.serial ? ` · ${item.serial}` : ''}</span>
                {title.kind === 'MERCADORIA'
                  ? <span className="font-mono text-slate-500">custo {money(Number(item.costTotal ?? 0))}</span>
                  : item.unitPrice ? <span className="font-mono text-slate-500">{money(Number(item.unitPrice) * Number(item.quantity))}</span> : null}
              </div>
            ))}
          </div>
        )}

        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
          {title.installments.map(installment => (
            <div key={installment.id} className="px-3 py-2 space-y-1">
              <div className="flex justify-between">
                <span className="font-semibold">{installment.number === 0 ? 'Entrada' : `Parcela ${installment.number}`} · vence {formatDate(installment.dueDate)}</span>
                <span className="font-mono">{money(installment.amount)}</span>
              </div>
              {installment.payments.map(payment => (
                <div key={payment.id} className="flex justify-between items-center pl-3 text-emerald-800">
                  <span>Recebido {money(payment.amount)} em {formatDate(payment.paidAt)} · {receivableMethodLabel(payment.method)}{payment.receivedByName ? ` · ${payment.receivedByName}` : ''}</span>
                  {title.status === 'ATIVO' && (
                    <button type="button" disabled={busy} onClick={() => {
                      if (!window.confirm('Desfazer este recebimento?')) return;
                      void run(() => undoReceivablePayment(payment.id), 'Recebimento desfeito.');
                    }} className="inline-flex items-center gap-1 text-slate-500 hover:text-rose-700"><Undo2 className="w-3.5 h-3.5" />Desfazer</button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {title.attachmentPath && (
            <button type="button" onClick={async () => { try { window.open(await openReceivableAttachment(title.attachmentPath as string), '_blank', 'noopener'); } catch (openError) { setError(errorText(openError)); } }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-slate-200 rounded hover:bg-slate-50"><Paperclip className="w-3.5 h-3.5" />{title.attachmentName || 'Anexo'}</button>
          )}
          {tenantId && title.status === 'ATIVO' && (
            <label className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer">
              <Paperclip className="w-3.5 h-3.5" />{title.attachmentPath ? 'Trocar anexo' : 'Anexar contrato/nota'}
              <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (file.size > 10 * 1024 * 1024) { setError('Arquivo maior que 10 MB.'); return; }
                void run(() => uploadReceivableAttachment(tenantId, title, file), 'Anexo salvo.');
              }} />
            </label>
          )}
          <span className="flex-1" />
          {title.status === 'ATIVO' && (
            <button type="button" disabled={busy || hasPayments} title={hasPayments ? 'Desfaça os recebimentos antes de cancelar' : undefined}
              onClick={() => {
                const extra = title.kind === 'MERCADORIA' ? ' Os produtos voltam ao estoque.' : '';
                if (!window.confirm(`Cancelar a conta nº ${title.number}?${extra}`)) return;
                void run(() => cancelReceivable(title.id), title.kind === 'MERCADORIA' ? 'Conta cancelada. Os produtos voltaram ao estoque.' : 'Conta cancelada.');
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-amber-300 text-amber-800 rounded hover:bg-amber-50 disabled:opacity-50"><Ban className="w-3.5 h-3.5" />Cancelar conta</button>
          )}
          {title.status === 'CANCELADO' && isAdmin && (
            <button type="button" disabled={busy} onClick={() => {
              if (!window.confirm(`Excluir de vez a conta nº ${title.number}?`)) return;
              void run(() => deleteReceivable(title.id), 'Conta excluída.', true);
            }} className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-rose-300 text-rose-700 rounded hover:bg-rose-50"><Trash2 className="w-3.5 h-3.5" />Excluir</button>
          )}
        </div>
        {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
      </div>
    </div>
  );
}
