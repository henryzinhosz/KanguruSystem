import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDownCircle, ArrowUpCircle, Banknote, CreditCard, HandCoins, Landmark, Link2, PackageCheck,
  PiggyBank, Plus, Settings, Trash2, TrendingUp, Wallet, X,
} from 'lucide-react';
import type { PayableBill, Sale, StoreConfig, Supplier, User } from '../types';
import { UserRole } from '../types';
import ValueInput from './ValueInput';
import {
  CASH_METHOD_KEYS, MOVEMENT_TYPES, addCashMovement, deleteCashAccount, deleteCashMovement, getCashOverview,
  getRestockReserves, listCardAportes, listManualMovements, movementLabel, saveCashAccount, saveCashSettings,
  setBrandSupplier, type CardAporte, type CashAccount, type CashAccountKind, type CashMethodKey, type CashMovementType,
  type CashOverview, type ManualMovement, type RestockReserves,
} from '../db/cashAccounts';
import { addDaysKey, addPayoutDays, buildReceivables, listPayoutChecks, nextPayoutDay, rulesOf, todayKey, type PayoutCheck } from '../db/receivables';
import { listPayableBills } from '../db/payables';
import { listOpenReceivableInstallments, type OpenInstallment } from '../db/receivableTitles';
import { computeCashForecast } from '../db/cashForecast';

// Caixa e Bancos + Reserva de reposição (desenho aprovado em 2026-11-23): quanto dinheiro a
// loja tem de verdade, quanto já é do fornecedor (reposição) e quanto está livre.

interface CashAccountsPanelProps {
  currentUser: User;
  sales: Sale[];
  storeConfigs: StoreConfig[];
  suppliers: Supplier[];
  addSupplier?: (supplier: Omit<Supplier, 'id' | 'historyCount'>) => Promise<Supplier>;
  onExpensesChanged?: () => void | Promise<void>;
}

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDate = (key: string | null | undefined) => key ? key.slice(0, 10).split('-').reverse().join('/') : '';
const formatDateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const inputClass = 'w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-blue-500';
const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco';
  return /get_cash_overview|get_restock_reserves|cash_accounts|schema cache/i.test(message)
    ? 'Caixa e Bancos ainda não está no banco: aplique a migration 20261209.'
    : message;
};

const ENTRY_LABELS: Record<string, string> = {
  REPASSE: 'Repasse conferido',
  CONTA_RECEBER: 'Conta a receber',
  CONTA_PAGAR: 'Conta paga',
  TROCA_PIX: 'Troca em Pix',
  DEVOLUCAO_PIX: 'Devolução em Pix',
  TRANSFERENCIA_ENTRADA: 'Transferência recebida',
  SANGRIA_PDV: 'Sangria do PDV',
  SUPRIMENTO_PDV: 'Suprimento do PDV',
};
const entryLabel = (kind: string) => ENTRY_LABELS[kind] ?? movementLabel(kind);

export default function CashAccountsPanel({ currentUser, sales, storeConfigs, suppliers, addSupplier, onExpensesChanged }: CashAccountsPanelProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = useMemo(() => storeConfigs.filter(store => store.unitId !== 'central'), [storeConfigs]);
  const [unitId, setUnitId] = useState(stores[0]?.unitId ?? '');
  const store = stores.find(item => item.unitId === unitId);
  const today = todayKey();

  const [overview, setOverview] = useState<CashOverview | null>(null);
  const [reserves, setReserves] = useState<RestockReserves | null>(null);
  const [movements, setMovements] = useState<ManualMovement[]>([]);
  const [checks, setChecks] = useState<PayoutCheck[]>([]);
  const [cardAportes, setCardAportes] = useState<CardAporte[]>([]);
  const [payables, setPayables] = useState<PayableBill[]>([]);
  const [openReceivables, setOpenReceivables] = useState<OpenInstallment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [showMovement, setShowMovement] = useState(false);
  const [showBrands, setShowBrands] = useState(false);
  const [accountFilter, setAccountFilter] = useState('');
  const [checkingAccount, setCheckingAccount] = useState<CashAccount | null>(null);
  const [showAllForecast, setShowAllForecast] = useState(false);

  useEffect(() => {
    if (!unitId && stores[0]) setUnitId(stores[0].unitId);
  }, [stores, unitId]);

  const load = useCallback(async () => {
    if (!unitId) return;
    setLoading(true);
    setError('');
    try {
      const from = addDaysKey(today, -60);
      const [nextOverview, nextReserves, nextMovements] = await Promise.all([
        getCashOverview(unitId, from),
        getRestockReserves(unitId),
        listManualMovements(unitId, from),
      ]);
      setOverview(nextOverview);
      setReserves(nextReserves);
      setMovements(nextMovements);
      const earliest = nextOverview.accounts.reduce((min, account) => account.openingDate < min ? account.openingDate : min, today);
      const [nextChecks, nextAportes] = await Promise.all([
        listPayoutChecks(earliest, addDaysKey(today, 40)).catch(() => [] as PayoutCheck[]),
        listCardAportes(earliest, addDaysKey(today, 40)).catch(() => [] as CardAporte[]),
      ]);
      setChecks(nextChecks.filter(item => item.unitId === unitId));
      setCardAportes(nextAportes.filter(item => item.unitId === unitId));
    } catch (loadError) {
      setError(errorText(loadError));
      setOverview(null);
      setReserves(null);
    } finally {
      setLoading(false);
    }
  }, [unitId, today]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listPayableBills().then(setPayables).catch(() => setPayables([]));
    listOpenReceivableInstallments().then(setOpenReceivables).catch(() => setOpenReceivables([]));
  }, []);

  const accounts = overview?.accounts ?? [];
  const activeAccounts = accounts.filter(account => account.isActive);
  const accountName = (id: string | null | undefined) => accounts.find(account => account.id === id)?.name ?? '—';
  const settings = overview?.settings;
  const total = activeAccounts.reduce((sum, account) => sum + account.balance, 0);
  const reserved = (reserves?.suppliers ?? []).reduce((sum, item) => sum + Math.max(0, item.reserve), 0);
  const free = total - reserved;

  // ---- Previsão de 30 dias ----
  const forecast = useMemo(() => {
    if (!overview || !store) return null;
    return computeCashForecast({ today, unitId, store, accounts, settings, total, sales, cardAportes, checks, openReceivables, payables });
  }, [overview, store, accounts, settings, sales, unitId, cardAportes, checks, openReceivables, payables, total, today]);

  const removeMovement = async (movement: ManualMovement) => {
    if (!window.confirm(`Excluir o lançamento "${movementLabel(movement.type)}" de ${money(movement.viaCard ? movement.cardGross ?? movement.amount : movement.amount)}?${movement.viaCard ? ' A despesa da taxa sai junto.' : ''}`)) return;
    setError('');
    try {
      await deleteCashMovement(movement.id);
      setMessage('Lançamento excluído.');
      await load();
      if (movement.viaCard) await onExpensesChanged?.();
    } catch (deleteError) {
      setError(errorText(deleteError));
    }
  };

  const visibleEntries = (overview?.entries ?? []).filter(entry => !accountFilter || entry.accountId === accountFilter);
  const movementById = new Map<string, ManualMovement>(movements.map(item => [item.id, item]));

  return (
    <div className="space-y-4 font-sans text-xs">
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
            <PiggyBank className="w-5 h-5 text-blue-600 mr-2" />Caixa e Bancos
          </h3>
          <p className="text-xs text-slate-400">Quanto dinheiro a loja tem, quanto já é do fornecedor (reposição) e quanto está livre.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {stores.length > 1 && (
            <label className="space-y-1">
              <span className="block font-bold text-slate-500">Loja</span>
              <select value={unitId} onChange={event => setUnitId(event.target.value)} className={inputClass}>
                {stores.map(item => <option key={item.unitId} value={item.unitId}>{item.tradeName || item.unitId}</option>)}
              </select>
            </label>
          )}
          {isAdmin && overview && (
            <button type="button" onClick={() => setShowSetup(true)} className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold text-slate-700 inline-flex items-center gap-1.5">
              <Settings className="w-4 h-4" />Contas e configuração
            </button>
          )}
          {activeAccounts.length > 0 && (
            <button type="button" onClick={() => setShowMovement(true)} className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold inline-flex items-center gap-1.5">
              <Plus className="w-4 h-4" />Novo lançamento
            </button>
          )}
        </div>
      </div>

      {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
      {message && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{message}</div>}
      {loading && !overview && <p className="text-slate-400">Carregando...</p>}

      {overview && accounts.length === 0 && (
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-xs text-center space-y-3">
          <Wallet className="w-8 h-8 text-slate-300 mx-auto" />
          <p className="font-bold text-slate-800 text-sm">Nenhuma conta cadastrada nesta loja</p>
          <p className="text-slate-500 max-w-lg mx-auto">
            Cadastre onde o dinheiro da loja fica (ex.: <strong>Gaveta</strong> do PDV e a conta da <strong>Stone</strong>) com o saldo de hoje.
            A partir daí o saldo anda sozinho com os fechamentos do caixa, os recebimentos conferidos e as contas pagas e recebidas.
          </p>
          {isAdmin
            ? <button type="button" onClick={() => setShowSetup(true)} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold">Cadastrar contas</button>
            : <p className="text-slate-400">Peça ao dono da empresa para cadastrar as contas.</p>}
        </div>
      )}

      {overview && accounts.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {activeAccounts.map(account => {
              const isPdv = account.id === settings?.pdvCashAccountId;
              const isPayout = account.id === settings?.payoutAccountId;
              const isSafe = account.id === settings?.safeAccountId;
              return (
                <div key={account.id} className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider truncate">{account.name}</p>
                      <p className={`text-lg font-black mt-1 font-mono ${account.balance < 0 ? 'text-rose-600' : 'text-slate-900'}`}>{money(account.balance)}</p>
                    </div>
                    <span className={`p-2.5 rounded-lg border ${account.kind === 'GAVETA' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-blue-50 text-blue-600 border-blue-100'}`}>
                      {account.kind === 'GAVETA' ? <Banknote className="w-5 h-5" /> : <Landmark className="w-5 h-5" />}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 font-semibold mt-1">
                    {account.baseKind === 'CONTAGEM'
                      ? `contado no fechamento ${account.cashNumber ?? ''} (${formatDateTime(account.closedAt)})`
                      : `saldo inicial ${money(account.openingBalance)} em ${formatDate(account.openingDate)}`}
                  </p>
                  {(isPdv || isPayout || isSafe) && (
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {[isPdv && 'Recebe a contagem do PDV', isPayout && 'Recebe os repasses conferidos', isSafe && 'Recebe as sangrias do PDV'].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {!isPdv && (
                    <button type="button" onClick={() => setCheckingAccount(account)} className="mt-2 font-bold text-blue-600 hover:underline">Conferir saldo</button>
                  )}
                </div>
              );
            })}
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-900 shadow-xs text-white">
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Total em caixa</p>
              <p className="text-lg font-black mt-1 font-mono">{money(total)}</p>
              <div className="mt-2 space-y-0.5 text-[11px]">
                <p className="flex justify-between gap-2"><span className="text-slate-400">Reserva de reposição</span><span className="font-mono text-amber-300">- {money(reserved)}</span></p>
                <p className="flex justify-between gap-2 font-bold"><span>Livre</span><span className={`font-mono ${free < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{money(free)}</span></p>
              </div>
            </div>
          </div>

          {overview.partnerLoanBalance > 0.004 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2 text-amber-900">
              <HandCoins className="w-4 h-4" />
              <span>A loja deve <strong className="font-mono">{money(overview.partnerLoanBalance)}</strong> ao sócio (empréstimos menos devoluções).</span>
            </div>
          )}
          {free < 0 && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-center gap-2 text-rose-800">
              <AlertTriangle className="w-4 h-4" />
              <span>O dinheiro em caixa não cobre a reserva de reposição: parte do que é dos fornecedores já foi gasto.</span>
            </div>
          )}

          {/* Reserva de reposição */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5"><PackageCheck className="w-4 h-4 text-amber-600" />Reserva de reposição por fornecedor</h4>
                <p className="text-slate-400">
                  Custo do que foi vendido desde {formatDate(reserves?.startDate) || '—'}, menos devoluções e menos as contas de mercadoria pagas ao fornecedor.
                </p>
              </div>
              {isAdmin && (
                <button type="button" onClick={() => setShowBrands(true)} className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold text-slate-700 inline-flex items-center gap-1.5">
                  <Link2 className="w-4 h-4" />Ligar marcas aos fornecedores
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-slate-600">
                <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
                  <tr>
                    <th className="px-3 py-2">Fornecedor</th>
                    <th className="px-3 py-2">Marcas</th>
                    <th className="px-3 py-2 text-right">Custo vendido</th>
                    <th className="px-3 py-2 text-right">Devolvido</th>
                    <th className="px-3 py-2 text-right">Pago ao fornecedor</th>
                    <th className="px-3 py-2 text-right">Reserva</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(reserves?.suppliers ?? []).map(item => (
                    <tr key={item.supplierId ?? 'outros'}>
                      <td className="px-3 py-2 font-bold text-slate-800">{item.name}</td>
                      <td className="px-3 py-2 text-slate-500">{item.supplierId ? item.brands.join(', ') : 'marcas sem fornecedor e produtos sem marca'}</td>
                      <td className="px-3 py-2 text-right font-mono">{money(item.soldCost)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">{item.returnedCost ? `- ${money(item.returnedCost)}` : '-'}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">{item.consumed ? `- ${money(item.consumed)}` : '-'}</td>
                      <td className={`px-3 py-2 text-right font-mono font-bold ${item.reserve < 0 ? 'text-blue-600' : 'text-amber-700'}`}>
                        {money(item.reserve)}
                        {item.reserve < 0 && <span className="block text-[10px] font-sans font-semibold">comprou adiantado</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-bold text-slate-800">
                    <td className="px-3 py-2" colSpan={5}>Total reservado (só os positivos)</td>
                    <td className="px-3 py-2 text-right font-mono text-amber-700">{money(reserved)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-slate-400">
              Ao pagar o fornecedor, lance em Contas a Pagar com a categoria <strong>Mercadoria/Fornecedor</strong> (ou Compras Urgentes) e escolha o fornecedor: o valor sai da reserva dele.
            </p>
          </div>

          {/* Previsão */}
          {forecast && (
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5"><TrendingUp className="w-4 h-4 text-blue-600" />Previsão dos próximos 30 dias</h4>
                <button type="button" onClick={() => setShowAllForecast(value => !value)} className="font-bold text-blue-600 hover:underline">
                  {showAllForecast ? 'Mostrar só dias com movimento' : 'Mostrar todos os dias'}
                </button>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <div className="rounded-lg border border-slate-200 p-2.5"><p className="text-slate-400 font-bold">Entra</p><p className="font-mono font-bold text-emerald-600 text-sm">{money(forecast.incoming)}</p></div>
                <div className="rounded-lg border border-slate-200 p-2.5"><p className="text-slate-400 font-bold">Sai</p><p className="font-mono font-bold text-rose-600 text-sm">{money(forecast.outgoing)}</p></div>
                <div className={`rounded-lg border p-2.5 ${forecast.lowest.value < 0 ? 'border-rose-200 bg-rose-50' : 'border-slate-200'}`}>
                  <p className="text-slate-400 font-bold">Menor saldo</p>
                  <p className={`font-mono font-bold text-sm ${forecast.lowest.value < 0 ? 'text-rose-600' : 'text-slate-900'}`}>{money(forecast.lowest.value)}</p>
                  <p className="text-[10px] text-slate-400">em {formatDate(forecast.lowest.day)}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-2.5"><p className="text-slate-400 font-bold">Saldo em 30 dias</p><p className={`font-mono font-bold text-sm ${forecast.final < 0 ? 'text-rose-600' : 'text-slate-900'}`}>{money(forecast.final)}</p></div>
              </div>
              {forecast.toConfirm > 0.004 && (
                <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                  {money(forecast.toConfirm)} de dias anteriores ainda não foram conferidos em Recebimentos: entram no saldo quando você conferir (aqui contam como hoje).
                </p>
              )}
              {!forecast.hasPayout && <p className="text-slate-400">Escolha em "Contas e configuração" qual conta recebe os repasses para a previsão incluir cartão e Pix.</p>}
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-left text-slate-600">
                  <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold sticky top-0">
                    <tr>
                      <th className="px-3 py-2">Dia</th>
                      <th className="px-3 py-2 text-right">Entra</th>
                      <th className="px-3 py-2 text-right">Sai</th>
                      <th className="px-3 py-2 text-right">Saldo previsto</th>
                      <th className="px-3 py-2">O que sai</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {forecast.rows.filter(row => showAllForecast || row.incoming || row.outgoing || row.day === today).map(row => (
                      <tr key={row.day} className={row.balance < 0 ? 'bg-rose-50/60' : ''}>
                        <td className="px-3 py-1.5 font-mono whitespace-nowrap">{row.day === today ? 'Hoje' : formatDate(row.day)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-emerald-600">{row.incoming ? money(row.incoming) : '-'}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-rose-600">{row.outgoing ? money(row.outgoing) : '-'}</td>
                        <td className={`px-3 py-1.5 text-right font-mono font-bold ${row.balance < 0 ? 'text-rose-600' : 'text-slate-900'}`}>{money(row.balance)}</td>
                        <td className="px-3 py-1.5 text-slate-500 truncate max-w-[280px]" title={row.notes.join(', ')}>{row.notes.slice(0, 3).join(', ')}{row.notes.length > 3 ? '...' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-400">Entra: cartão e Pix a cair (pelas regras de Recebimentos) e contas a receber. Sai: contas a pagar pendentes. Vendas futuras não entram.</p>
            </div>
          )}

          {/* Extrato */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Extrato (últimos 60 dias)</h4>
              <select value={accountFilter} onChange={event => setAccountFilter(event.target.value)} className={`${inputClass} w-auto`}>
                <option value="">Todas as contas</option>
                {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </div>
            {(!accountFilter || accountFilter === settings?.pdvCashAccountId) && (overview.closings ?? []).length > 0 && (
              <p className="text-[11px] text-slate-500">
                Fechamentos do caixa: {overview.closings.slice(0, 5).map(item => `${formatDateTime(item.closedAt)} contado ${money(item.counted)}`).join(' · ')}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-slate-600">
                <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
                  <tr>
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Conta</th>
                    <th className="px-3 py-2">Tipo</th>
                    <th className="px-3 py-2">Descrição</th>
                    <th className="px-3 py-2 text-right">Valor</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleEntries.map((entry, index) => {
                    const manual = movementById.get(entry.ref);
                    const isOutgoingTransfer = entry.kind === 'TRANSFERENCIA';
                    return (
                      <tr key={`${entry.ref}-${entry.kind}-${index}`} className={entry.counted ? '' : 'opacity-60'}>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{formatDate(entry.date)}</td>
                        <td className="px-3 py-2">{accountName(entry.accountId)}</td>
                        <td className="px-3 py-2 font-semibold text-slate-700">{entryLabel(entry.kind)}</td>
                        <td className="px-3 py-2 text-slate-500">
                          {entry.description}
                          {isOutgoingTransfer && manual?.toAccountId && <span> → {accountName(manual.toAccountId)}</span>}
                          {manual?.viaCard && (
                            <span className="block text-[10px] text-blue-600">
                              <CreditCard className="w-3 h-3 inline mr-0.5" />
                              passado no cartão: {money(manual.cardGross ?? 0)} em {manual.cardInstallments}x, taxa {money(manual.cardFee ?? 0)} (despesa); entra pelo repasse de {formatDate(manual.payoutDate)}
                            </span>
                          )}
                          {!entry.counted && <span className="block text-[10px] text-slate-400">já incluído no saldo inicial ou na contagem do caixa</span>}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono font-bold ${manual?.viaCard ? 'text-slate-400' : entry.amount < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {manual?.viaCard ? money(manual.amount) : money(entry.amount)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {isAdmin && manual && entry.kind !== 'TRANSFERENCIA_ENTRADA' && (
                            <button type="button" onClick={() => void removeMovement(manual)} className="p-1 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-600" aria-label="Excluir lançamento">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {visibleEntries.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-slate-400">Nenhum movimento nos últimos 60 dias.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-400">
              Vendas em dinheiro entram pela contagem do fechamento do caixa; cartão e Pix entram quando você confere o dia em Recebimentos.
            </p>
          </div>
        </>
      )}

      {showSetup && overview && store && (
        <SetupModal
          unitId={unitId}
          storeName={store.tradeName || unitId}
          overview={overview}
          onClose={() => setShowSetup(false)}
          onSaved={async text => { setMessage(text); await load(); }}
        />
      )}
      {showMovement && overview && store && (
        <MovementModal
          unitId={unitId}
          store={store}
          overview={overview}
          onClose={() => setShowMovement(false)}
          onSaved={async (text, viaCard) => {
            setShowMovement(false);
            setMessage(text);
            await load();
            if (viaCard) await onExpensesChanged?.();
          }}
        />
      )}
      {checkingAccount && (
        <BalanceCheckModal
          unitId={unitId}
          account={checkingAccount}
          onClose={() => setCheckingAccount(null)}
          onSaved={async text => { setCheckingAccount(null); setMessage(text); await load(); }}
        />
      )}
      {showBrands && reserves && (
        <BrandsModal
          reserves={reserves}
          suppliers={suppliers}
          addSupplier={addSupplier}
          onClose={() => setShowBrands(false)}
          onChanged={load}
        />
      )}
    </div>
  );
}

// ---- Contas e configuração (só o dono) ----
interface AccountDraft { id: string | null; name: string; kind: CashAccountKind; openingBalance: number | null; openingDate: string; isActive: boolean }

function SetupModal({ unitId, storeName, overview, onClose, onSaved }: {
  unitId: string; storeName: string; overview: CashOverview; onClose: () => void; onSaved: (text: string) => void | Promise<void>;
}) {
  const today = todayKey();
  const [drafts, setDrafts] = useState<AccountDraft[]>(() => overview.accounts.length > 0
    ? overview.accounts.map(account => ({ id: account.id, name: account.name, kind: account.kind, openingBalance: account.openingBalance, openingDate: account.openingDate, isActive: account.isActive }))
    : [
      { id: null, name: 'Gaveta (dinheiro)', kind: 'GAVETA', openingBalance: null, openingDate: today, isActive: true },
      { id: null, name: 'Cofre', kind: 'GAVETA', openingBalance: null, openingDate: today, isActive: true },
      { id: null, name: 'Stone', kind: 'BANCO', openingBalance: null, openingDate: today, isActive: true },
    ]);
  const [pdvCash, setPdvCash] = useState(overview.settings.pdvCashAccountId ?? '');
  const [payout, setPayout] = useState(overview.settings.payoutAccountId ?? '');
  const [safe, setSafe] = useState(overview.settings.safeAccountId ?? '');
  const [methods, setMethods] = useState<Record<string, string>>(() => Object.fromEntries(
    CASH_METHOD_KEYS.map(item => [item.key, overview.settings.methodAccounts?.[item.key] ?? ''])
  ));
  const [reserveStart, setReserveStart] = useState(overview.settings.reserveStartDate ?? today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const firstSetup = overview.accounts.length === 0;

  const update = (index: number, patch: Partial<AccountDraft>) => setDrafts(list => list.map((item, i) => i === index ? { ...item, ...patch } : item));

  const remove = async (index: number) => {
    const draft = drafts[index];
    if (!draft.id) return setDrafts(list => list.filter((_, i) => i !== index));
    if (!window.confirm(`Excluir a conta "${draft.name}"?`)) return;
    setError('');
    try {
      await deleteCashAccount(draft.id);
      setDrafts(list => list.filter((_, i) => i !== index));
      await onSaved('Conta excluída.');
    } catch (deleteError) {
      setError(errorText(deleteError));
    }
  };

  const save = async () => {
    setError('');
    if (drafts.some(draft => !draft.name.trim())) return setError('Dê um nome para cada conta.');
    if (drafts.some(draft => !draft.openingDate || draft.openingDate > today)) return setError('A data do saldo inicial não pode ser no futuro.');
    setSaving(true);
    try {
      const ids: string[] = [];
      for (const draft of drafts) {
        ids.push(await saveCashAccount({
          id: draft.id, unitId, name: draft.name.trim(), kind: draft.kind, openingBalance: draft.openingBalance ?? 0,
          openingDate: draft.openingDate, isActive: draft.isActive,
        }));
      }
      // Contas novas ainda não tinham id: 1ª de dinheiro = gaveta do PDV, 2ª = Cofre, 1º banco = repasses.
      const drawerIds = ids.filter((_, index) => drafts[index].kind === 'GAVETA' && drafts[index].isActive);
      const bankId = ids.find((_, index) => drafts[index].kind === 'BANCO' && drafts[index].isActive) ?? null;
      const pdvId = firstSetup ? drawerIds[0] ?? null : pdvCash || null;
      const autoSafe = !safe;
      const safeId = safe || drawerIds.find(id => id !== pdvId) || null;
      const methodMap = Object.fromEntries(CASH_METHOD_KEYS.map(item => {
        if (firstSetup) {
          return [item.key, item.key === 'DINHEIRO' ? safeId ?? pdvId : item.key === 'CARTAO' || item.key === 'OUTRO' ? null : bankId];
        }
        const chosen = methods[item.key] || null;
        // Cofre acabou de ser criado: o dinheiro das contas passa a sair dele, não da gaveta.
        if (item.key === 'DINHEIRO' && autoSafe && safeId && chosen === pdvId) return [item.key, safeId];
        return [item.key, chosen];
      })) as Record<CashMethodKey, string | null>;
      await saveCashSettings(unitId, {
        pdvCashAccountId: pdvId,
        payoutAccountId: firstSetup ? bankId : payout || null,
        safeAccountId: safeId,
        methodAccounts: methodMap,
        reserveStartDate: reserveStart || today,
      });
      await onSaved('Contas salvas.');
      onClose();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  const accountOptions = overview.accounts.filter(account => account.isActive);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="bg-white w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-xl shadow-xl border border-slate-200 text-xs">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50 sticky top-0">
          <h3 className="text-sm font-bold text-slate-900">Contas e configuração · {storeName}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-5">
          {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}

          <section className="space-y-2">
            <h4 className="font-bold text-slate-800">Contas</h4>
            <p className="text-slate-500">Saldo inicial = quanto tinha no <strong>fim do dia</strong> escolhido (o que acontecer depois soma sozinho). Na gaveta, depois do primeiro fechamento do caixa vale o valor contado.</p>
            <div className="space-y-2">
              {drafts.map((draft, index) => (
                <div key={draft.id ?? `new-${index}`} className="grid grid-cols-12 gap-2 items-end border border-slate-200 rounded-lg p-2">
                  <label className="col-span-12 sm:col-span-4 space-y-1">
                    <span className="block font-bold text-slate-500">Nome</span>
                    <input value={draft.name} onChange={event => update(index, { name: event.target.value })} maxLength={60} className={inputClass} />
                  </label>
                  <label className="col-span-6 sm:col-span-2 space-y-1">
                    <span className="block font-bold text-slate-500">Tipo</span>
                    <select value={draft.kind} onChange={event => update(index, { kind: event.target.value as CashAccountKind })} className={inputClass}>
                      <option value="GAVETA">Dinheiro</option>
                      <option value="BANCO">Banco</option>
                    </select>
                  </label>
                  <label className="col-span-6 sm:col-span-2 space-y-1">
                    <span className="block font-bold text-slate-500">Saldo inicial</span>
                    <ValueInput value={draft.openingBalance} onValueChange={value => update(index, { openingBalance: value })} className={`${inputClass} font-mono`} />
                  </label>
                  <label className="col-span-6 sm:col-span-2 space-y-1">
                    <span className="block font-bold text-slate-500">No fim do dia</span>
                    <input type="date" value={draft.openingDate} max={today} onChange={event => update(index, { openingDate: event.target.value })} className={inputClass} />
                  </label>
                  <div className="col-span-6 sm:col-span-2 flex items-center justify-end gap-2 pb-1.5">
                    {draft.id && (
                      <label className="inline-flex items-center gap-1 text-slate-600">
                        <input type="checkbox" checked={draft.isActive} onChange={event => update(index, { isActive: event.target.checked })} />Ativa
                      </label>
                    )}
                    <button type="button" onClick={() => void remove(index)} className="p-1.5 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-600" aria-label="Excluir conta"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setDrafts(list => [...list, { id: null, name: '', kind: 'BANCO', openingBalance: null, openingDate: today, isActive: true }])} className="font-bold text-blue-600 hover:underline inline-flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" />Adicionar conta
            </button>
            {!drafts.some(draft => draft.kind === 'GAVETA' && /cofre/i.test(draft.name)) && (
              <button type="button" onClick={() => setDrafts(list => [...list, { id: null, name: 'Cofre', kind: 'GAVETA', openingBalance: null, openingDate: today, isActive: true }])} className="ml-4 font-bold text-blue-600 hover:underline inline-flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" />Adicionar Cofre (dinheiro das sangrias)
              </button>
            )}
          </section>

          {firstSetup ? (
            <p className="text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
              Padrão: a 1ª conta de <strong>Dinheiro</strong> recebe a contagem do fechamento do PDV; a 2ª (<strong>Cofre</strong>) recebe as sangrias, paga os suprimentos e as contas em dinheiro;
              os repasses de cartão e Pix e o resto vão para a conta de <strong>Banco</strong>. Depois de salvar você pode mudar isso aqui mesmo.
            </p>
          ) : (
            <section className="space-y-2">
              <h4 className="font-bold text-slate-800">Para onde vai cada forma</h4>
              <div className="grid sm:grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="block font-bold text-slate-500">Contagem do fechamento do PDV (vendas em dinheiro)</span>
                  <select value={pdvCash} onChange={event => setPdvCash(event.target.value)} className={inputClass}>
                    <option value="">Nenhuma</option>
                    {accountOptions.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block font-bold text-slate-500">Sangrias e suprimentos do PDV (Cofre)</span>
                  <select value={safe} onChange={event => setSafe(event.target.value)} className={inputClass}>
                    <option value="">{accountOptions.some(account => account.kind === 'GAVETA' && account.id !== pdvCash) ? 'Nenhuma' : 'Nenhuma (adicione uma conta "Cofre")'}</option>
                    {accountOptions.filter(account => account.id !== pdvCash).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                  </select>
                  <span className="block text-[10px] text-slate-400">Sangria da Troca não entra: é dinheiro que saiu para o cliente.</span>
                </label>
                <label className="space-y-1">
                  <span className="block font-bold text-slate-500">Repasses conferidos em Recebimentos (cartão e Pix)</span>
                  <select value={payout} onChange={event => setPayout(event.target.value)} className={inputClass}>
                    <option value="">Nenhuma</option>
                    {accountOptions.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                  </select>
                </label>
                {CASH_METHOD_KEYS.map(item => (
                  <label key={item.key} className="space-y-1">
                    <span className="block font-bold text-slate-500">{item.label} <span className="font-normal text-slate-400">({item.hint})</span></span>
                    <select value={methods[item.key] ?? ''} onChange={event => setMethods(map => ({ ...map, [item.key]: event.target.value }))} className={inputClass}>
                      <option value="">Nenhuma (não mexe no saldo)</option>
                      {accountOptions.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </section>
          )}

          <section className="space-y-1">
            <h4 className="font-bold text-slate-800">Reserva de reposição</h4>
            <label className="block space-y-1 max-w-xs">
              <span className="block font-bold text-slate-500">Começa a contar em</span>
              <input type="date" value={reserveStart} max={today} onChange={event => setReserveStart(event.target.value)} className={inputClass} />
            </label>
            <p className="text-slate-400">Vendas a partir deste dia separam o custo para o fornecedor.</p>
          </section>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">Cancelar</button>
            <button type="button" disabled={saving} onClick={() => void save()} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">
              {saving ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Novo lançamento ----
function MovementModal({ unitId, store, overview, onClose, onSaved }: {
  unitId: string; store: StoreConfig; overview: CashOverview; onClose: () => void; onSaved: (text: string, viaCard: boolean) => void | Promise<void>;
}) {
  const today = todayKey();
  const accounts = overview.accounts.filter(account => account.isActive);
  const [type, setType] = useState<CashMovementType>('APORTE');
  const [accountId, setAccountId] = useState(overview.settings.payoutAccountId ?? accounts[0]?.id ?? '');
  const [toAccountId, setToAccountId] = useState('');
  const [direction, setDirection] = useState<'ENTRADA' | 'SAIDA'>('ENTRADA');
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState('');
  const [viaCard, setViaCard] = useState(false);
  const [installments, setInstallments] = useState(1);
  const [fee, setFee] = useState<number | null>(null);
  const [feeTouched, setFeeTouched] = useState(false);
  const [payoutDate, setPayoutDate] = useState('');
  const [payoutTouched, setPayoutTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canCard = type === 'APORTE' || type === 'EMPRESTIMO_SOCIO';
  const cardOn = canCard && viaCard;
  const realRate = installments <= 0 ? 0 : Number(store.cardFeeTable?.credito?.[installments - 1] ?? 0);

  // Sugere a taxa real da maquininha e o dia em que cai (regras de Recebimentos).
  useEffect(() => {
    if (!cardOn) return;
    if (!feeTouched) setFee(amount ? Math.round(amount * realRate) / 100 : null);
    if (!payoutTouched) {
      const rule = rulesOf(store).credito;
      const rules = rulesOf(store);
      setPayoutDate(rule.mode === 'IMMEDIATE' ? date
        : rule.mode === 'INSTALLMENTS' ? nextPayoutDay(addDaysKey(date, 30), rules)
          : addPayoutDays(date, Math.max(0, rule.days), rules));
    }
  }, [cardOn, amount, realRate, date, feeTouched, payoutTouched, store]);

  const save = async () => {
    setError('');
    if (!accountId && !cardOn) return setError('Escolha a conta.');
    if (!amount || amount <= 0) return setError('Informe o valor.');
    if (type === 'TRANSFERENCIA' && (!toAccountId || toAccountId === accountId)) return setError('Escolha a conta de destino.');
    if (cardOn && (fee == null || fee < 0 || fee >= amount)) return setError('Informe a taxa do cartão (menor que o valor).');
    if (cardOn && !payoutDate) return setError('Informe quando o dinheiro cai na conta.');
    setSaving(true);
    try {
      await addCashMovement({
        unitId,
        type,
        accountId: cardOn ? (overview.settings.payoutAccountId ?? accountId) : accountId,
        toAccountId: type === 'TRANSFERENCIA' ? toAccountId : null,
        direction: type === 'AJUSTE' ? direction : null,
        amount: cardOn ? null : amount,
        date,
        description: description.trim(),
        card: cardOn ? { gross: amount, fee: fee ?? 0, installments, payoutDate } : null,
      });
      await onSaved(cardOn
        ? `Lançado. A taxa de ${money(fee ?? 0)} virou despesa; o líquido entra quando você conferir o repasse de ${formatDate(payoutDate)} em Recebimentos.`
        : 'Lançamento salvo.', cardOn);
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  const typeInfo = MOVEMENT_TYPES.find(item => item.value === type);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="bg-white w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-xl shadow-xl border border-slate-200 text-xs">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50">
          <h3 className="text-sm font-bold text-slate-900">Novo lançamento</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Tipo</span>
            <select value={type} onChange={event => { setType(event.target.value as CashMovementType); setViaCard(false); }} className={inputClass}>
              {MOVEMENT_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            {typeInfo && <span className="block text-slate-400">{typeInfo.hint}</span>}
          </label>

          {canCard && (
            <label className="flex items-start gap-2 p-2.5 rounded-lg border border-blue-200 bg-blue-50/60 cursor-pointer">
              <input type="checkbox" checked={viaCard} onChange={event => setViaCard(event.target.checked)} className="mt-0.5" />
              <span>
                <strong className="text-slate-800">Passado no cartão do sócio (na maquininha da loja)</strong>
                <span className="block text-slate-500">A taxa vira despesa da loja e o líquido entra na conta dos repasses quando você conferir o dia em Recebimentos.</span>
              </span>
            </label>
          )}

          {type === 'AJUSTE' && (
            <div className="flex gap-2">
              {(['ENTRADA', 'SAIDA'] as const).map(value => (
                <button key={value} type="button" onClick={() => setDirection(value)} className={`flex-1 px-3 py-2 rounded-lg border font-bold inline-flex items-center justify-center gap-1 ${direction === value ? (value === 'ENTRADA' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-rose-600 text-white border-rose-600') : 'bg-white text-slate-600 border-slate-200'}`}>
                  {value === 'ENTRADA' ? <ArrowDownCircle className="w-4 h-4" /> : <ArrowUpCircle className="w-4 h-4" />}
                  {value === 'ENTRADA' ? 'Entrada (soma)' : 'Saída (diminui)'}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {!cardOn && (
              <label className="space-y-1">
                <span className="block font-bold text-slate-700">{type === 'TRANSFERENCIA' ? 'De (sai da conta)' : 'Conta'}</span>
                <select value={accountId} onChange={event => setAccountId(event.target.value)} className={inputClass}>
                  {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select>
              </label>
            )}
            {type === 'TRANSFERENCIA' && (
              <label className="space-y-1">
                <span className="block font-bold text-slate-700">Para (entra na conta)</span>
                <select value={toAccountId} onChange={event => setToAccountId(event.target.value)} className={inputClass}>
                  <option value="">Escolha</option>
                  {accounts.filter(account => account.id !== accountId).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select>
              </label>
            )}
            <label className="space-y-1">
              <span className="block font-bold text-slate-700">{cardOn ? 'Valor passado no cartão (R$)' : 'Valor (R$)'}</span>
              <ValueInput value={amount} onValueChange={setAmount} className={`${inputClass} font-mono`} />
            </label>
            <label className="space-y-1">
              <span className="block font-bold text-slate-700">Data</span>
              <input type="date" value={date} max={today} onChange={event => setDate(event.target.value)} className={inputClass} />
            </label>
          </div>

          {cardOn && (
            <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50">
              <label className="space-y-1">
                <span className="block font-bold text-slate-600">Parcelas</span>
                <select value={installments} onChange={event => setInstallments(Number(event.target.value))} className={inputClass}>
                  {Array.from({ length: 21 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}x</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block font-bold text-slate-600">Taxa (R$)</span>
                <ValueInput value={fee} onValueChange={value => { setFeeTouched(true); setFee(value); }} className={`${inputClass} font-mono`} />
              </label>
              <label className="space-y-1">
                <span className="block font-bold text-slate-600">Cai na conta em</span>
                <input type="date" value={payoutDate} min={date} onChange={event => { setPayoutTouched(true); setPayoutDate(event.target.value); }} className={inputClass} />
              </label>
              <p className="col-span-3 text-slate-500">
                {realRate > 0 ? `Taxa sugerida pela tabela real da maquininha (${String(realRate).replace('.', ',')}%). ` : 'Taxa real não cadastrada para essas parcelas: digite a taxa. '}
                Líquido: <strong className="font-mono">{money(Math.max(0, (amount ?? 0) - (fee ?? 0)))}</strong>
              </p>
            </div>
          )}

          <label className="block space-y-1">
            <span className="font-bold text-slate-700">Descrição</span>
            <input value={description} onChange={event => setDescription(event.target.value)} maxLength={200} placeholder="Opcional" className={inputClass} />
          </label>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">Cancelar</button>
            <button type="button" disabled={saving} onClick={() => void save()} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">
              {saving ? 'Salvando...' : 'Salvar lançamento'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Marcas x fornecedores (só o dono) ----
function BrandsModal({ reserves, suppliers, addSupplier, onClose, onChanged }: {
  reserves: RestockReserves; suppliers: Supplier[];
  addSupplier?: (supplier: Omit<Supplier, 'id' | 'historyCount'>) => Promise<Supplier>;
  onClose: () => void; onChanged: () => void | Promise<void>;
}) {
  const [links, setLinks] = useState<Record<string, string>>(() => Object.fromEntries(reserves.brands.map(item => [item.brand, item.supplierId ?? ''])));
  const [localSuppliers, setLocalSuppliers] = useState<Supplier[]>(suppliers);
  const [newSupplier, setNewSupplier] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setLinks(Object.fromEntries(reserves.brands.map(item => [item.brand, item.supplierId ?? '']))), [reserves]);

  const change = async (brand: string, supplierId: string) => {
    setError('');
    setBusy(brand);
    const previous = links[brand] ?? '';
    setLinks(map => ({ ...map, [brand]: supplierId }));
    try {
      await setBrandSupplier(brand, supplierId || null);
      await onChanged();
    } catch (linkError) {
      setLinks(map => ({ ...map, [brand]: previous }));
      setError(errorText(linkError));
    } finally {
      setBusy('');
    }
  };

  const createSupplier = async () => {
    const name = newSupplier.trim();
    if (!name || !addSupplier) return;
    setError('');
    try {
      const created = await addSupplier({ name, cnpj: '', contact: '', category: 'Mercadoria' });
      setLocalSuppliers(list => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewSupplier('');
    } catch (createError) {
      setError(errorText(createError));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="bg-white w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-xl shadow-xl border border-slate-200 text-xs">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50 sticky top-0">
          <h3 className="text-sm font-bold text-slate-900">Ligar marcas aos fornecedores</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-slate-500">O custo vendido de cada marca vai para a reserva do fornecedor escolhido. Marca sem fornecedor e produto sem marca vão para <strong>Outros</strong>.</p>
          {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
          {addSupplier && (
            <div className="flex gap-2 items-end">
              <label className="flex-1 space-y-1">
                <span className="block font-bold text-slate-600">Novo fornecedor (só o nome; complete depois em Fornecedores)</span>
                <input value={newSupplier} onChange={event => setNewSupplier(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void createSupplier(); }} maxLength={80} placeholder="Ex.: Marcia" className={inputClass} />
              </label>
              <button type="button" onClick={() => void createSupplier()} className="px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold">Criar</button>
            </div>
          )}
          <table className="w-full text-left text-slate-600">
            <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
              <tr>
                <th className="px-3 py-2">Marca</th>
                <th className="px-3 py-2 text-right">Produtos</th>
                <th className="px-3 py-2 text-right">Custo vendido</th>
                <th className="px-3 py-2">Fornecedor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reserves.brands.map(item => (
                <tr key={item.brand || '(sem marca)'}>
                  <td className="px-3 py-2 font-semibold text-slate-800">{item.brand || <span className="text-slate-400">(sem marca)</span>}</td>
                  <td className="px-3 py-2 text-right font-mono">{item.products}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(item.soldCost)}</td>
                  <td className="px-3 py-2">
                    {item.brand ? (
                      <select value={links[item.brand] ?? ''} disabled={busy === item.brand} onChange={event => void change(item.brand, event.target.value)} className={inputClass}>
                        <option value="">Outros</option>
                        {localSuppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                      </select>
                    ) : <span className="text-slate-400">Outros (cadastre a marca no produto)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">Fechar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Conferir saldo com o extrato/app (todas as contas menos a gaveta do PDV, que é conferida no fechamento) ----
function BalanceCheckModal({ unitId, account, onClose, onSaved }: {
  unitId: string; account: CashAccount; onClose: () => void; onSaved: (text: string) => void | Promise<void>;
}) {
  const today = todayKey();
  const [real, setReal] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const difference = real == null ? 0 : Math.round((real - account.balance) * 100) / 100;

  const adjust = async () => {
    if (real == null || difference === 0) return;
    setSaving(true);
    setError('');
    try {
      await addCashMovement({
        unitId,
        type: 'AJUSTE',
        accountId: account.id,
        toAccountId: null,
        direction: difference > 0 ? 'ENTRADA' : 'SAIDA',
        amount: Math.abs(difference),
        date: today,
        description: `Conferência de saldo: ${account.name} mostrava ${money(real)}${note.trim() ? ` (${note.trim()})` : ''}`,
        card: null,
      });
      await onSaved(`Ajuste de ${money(difference)} lançado em ${account.name}.`);
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
          <h3 className="text-sm font-bold text-slate-900">Conferir saldo · {account.name}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
            <p className="text-slate-500">Saldo no sistema: <span className="font-mono font-bold text-slate-900">{money(account.balance)}</span></p>
          </div>
          {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
          <label className="block space-y-1">
            <span className="font-bold text-slate-700">{account.kind === 'BANCO' ? 'Saldo que aparece no app/extrato agora (R$)' : 'Quanto tem contado agora (R$)'}</span>
            <ValueInput value={real} onValueChange={setReal} className={`${inputClass} font-mono`} />
          </label>
          {real != null && (difference === 0 ? (
            <p className="font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2">Bateu certinho. Nada a fazer.</p>
          ) : (
            <div className="space-y-2">
              <p className={`font-semibold ${difference < 0 ? 'text-rose-600' : 'text-amber-600'}`}>
                {difference < 0 ? `Tem ${money(-difference)} a menos que o sistema.` : `Tem ${money(difference)} a mais que o sistema.`}
              </p>
              <p className="text-slate-500">
                Antes de ajustar, confira: dia de Recebimentos sem conferir, conta paga que não foi lançada, depósito ou retirada sem lançamento.
                Se não achar, lance o ajuste.
              </p>
              <label className="block space-y-1">
                <span className="font-bold text-slate-700">Motivo (opcional)</span>
                <input value={note} onChange={event => setNote(event.target.value)} maxLength={120} className={inputClass} />
              </label>
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">Fechar</button>
            {real != null && difference !== 0 && (
              <button type="button" disabled={saving} onClick={() => void adjust()} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">
                {saving ? 'Lançando...' : `Lançar ajuste de ${money(difference)}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}