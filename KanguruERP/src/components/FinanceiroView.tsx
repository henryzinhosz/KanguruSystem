/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { 
  User, 
  UserRole, 
  Expense, 
  StoreConfig, 
  Sale,
  PaymentMethod,
  SALE_PAYMENT_METHOD_LABELS,
  Product,
  StockInventory,
  CardCondition
} from '../types';
import { 
  Plus, 
  DollarSign, 
  Settings, 
  FileSpreadsheet, 
  Calculator, 
  Activity, 
  ArrowUpRight, 
  Percent, 
  Calendar,
  Layers,
  Receipt,
  Undo2,
  Check,
  Search,
  AlertCircle,
  ShoppingBag,
  Trash2
} from 'lucide-react';
import {
  CONSOLIDATED,
  completedSales,
  formatMoney,
  inScope,
  isInRange,
  monthKeyOf,
  monthLabel,
  monthWeekKey,
  monthWeekLabel,
  monthWeekRange,
  resolvePeriod,
  shiftMonthKey,
  weeksOfMonth,
  summarize,
} from '../db/finance';

interface FinanceiroViewProps {
  currentUser: User;
  expenses: Expense[];
  storeConfigs: StoreConfig[];
  sales: Sale[];
  products: Product[];
  inventory: StockInventory[];
  addExpense: (expense: Omit<Expense, 'id' | 'operatorId' | 'operatorName' | 'timestamp'>) => void;
  updateStoreConfig: (unitId: string, updated: Partial<StoreConfig>) => void;
  cancelSale: (saleId: string, approvedByAdminName?: string) => string | undefined;
}

export default function FinanceiroView({
  currentUser,
  expenses,
  storeConfigs,
  sales,
  products,
  inventory,
  addExpense,
  updateStoreConfig,
  cancelSale
}: FinanceiroViewProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const defaultStoreId = stores[0]?.unitId || '';
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;

  // Active sub-menu: Despesas or Configuração de Custos/Taxas or Break-Even or Registro de Vendas
  const [activeTab, setActiveTab] = useState<'vendas' | 'despesas' | 'indicadores' | 'configs'>('vendas');

  // Vendas sao registradas somente pelo PDV; aqui ficam o historico e o estorno.
  const [saleError, setSaleError] = useState('');
  const [saleSuccess, setSaleSuccess] = useState('');
  const [configSuccess, setConfigSuccess] = useState('');
  const [searchSaleQuery, setSearchSaleQuery] = useState('');

  // Indicadores & DRE: usuario da central escolhe a loja; usuario de loja ve so a dele.
  const canChooseStore = currentUser.unitId === 'central';
  const [indicatorScope, setIndicatorScope] = useState<string>(CONSOLIDATED);
  const activeIndicatorScope = canChooseStore ? indicatorScope : currentUser.unitId;

  // DRE: mes escolhido + semana ('all' = mes inteiro)
  const [dreMonth, setDreMonth] = useState<string>(() => monthKeyOf(new Date().toISOString()));
  const [dreWeek, setDreWeek] = useState<string>('all');

  const handleCancelSale = (saleId: string) => {
    const res = cancelSale(saleId);
    if (res === 'PENDENTE_APROVACAO') {
      setSaleSuccess('O estorno foi encaminhado para aprovação do administrador.');
    } else {
      setSaleSuccess('Venda estornada com sucesso.');
    }
  };

  const handleApproveCancelSale = (saleId: string) => {
    cancelSale(saleId, currentUser.name);
    setSaleSuccess('Estorno aprovado com sucesso.');
  };


  // Expense form state
  const [expenseDesc, setExpenseDesc] = useState('');
  const [expenseCat, setExpenseCat] = useState('Água/Luz');
  const [expenseAmount, setExpenseAmount] = useState<number>(0);
  const [expenseStore, setExpenseStore] = useState<string>('');
  const [expenseError, setExpenseError] = useState('');
  const [expenseSuccess, setExpenseSuccess] = useState('');

  // Config editing state
  const [selectedConfigUnit, setSelectedConfigUnit] = useState<string>('');
  const [editFixedCost, setEditFixedCost] = useState<number>(10000);
  const [editPixFee, setEditPixFee] = useState('0.5');
  const [editCredFee, setEditCredFee] = useState('3.5');
  const [editDebFee, setEditDebFee] = useState('1.5');

  useEffect(() => {
    if (!stores.length) return;
    setExpenseStore(previous => stores.some(store => store.unitId === previous) ? previous : defaultStoreId);
    setSelectedConfigUnit(previous => stores.some(store => store.unitId === previous) ? previous : defaultStoreId);
  }, [storeConfigs]);

  const activeEditingConfig = storeConfigs.find(c => c.unitId === selectedConfigUnit) || {
    unitId: selectedConfigUnit,
    fixedCost: 10000,
    maxItemDiscountPercent: 0,
    paymentFees: { DINHEIRO: 0, PIX: 0.005, CREDITO: 0.035, DEBITO: 0.015 }
  };

  // Set values when config store changes
  const handleConfigStoreChange = (unitId: string) => {
    setSelectedConfigUnit(unitId);
    const cfg = storeConfigs.find(c => c.unitId === unitId);
    if (cfg) {
      setEditFixedCost(cfg.fixedCost);
      setEditPixFee(String(cfg.paymentFees.PIX * 100));
      setEditCredFee(String(cfg.paymentFees.CREDITO * 100));
      setEditDebFee(String(cfg.paymentFees.DEBITO * 100));
    }
  };

  const parsePercentage = (value: string) => {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed / 100 : 0;
  };

  // Submit Expense
  const handleExpenseSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setExpenseError('');
    setExpenseSuccess('');

    if (!expenseStore || !expenseDesc || expenseAmount <= 0) {
      setExpenseError('Preencha os dados da despesa corretamente.');
      return;
    }

    addExpense({
      description: expenseDesc,
      category: expenseCat,
      amount: expenseAmount,
      unitId: expenseStore
    });

    setExpenseDesc('');
    setExpenseAmount(0);
    setExpenseSuccess('Despesa registrada com sucesso.');
  };

  // Submit Store Configuration (Only available for Admins!)
  const handleConfigSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setConfigSuccess('');
    updateStoreConfig(selectedConfigUnit, {
      fixedCost: editFixedCost,
      paymentFees: {
        DINHEIRO: 0,
        PIX: parsePercentage(editPixFee),
        CREDITO: parsePercentage(editCredFee),
        DEBITO: parsePercentage(editDebFee)
      }
    });
    setConfigSuccess('Configurações de custos e taxas salvas com sucesso.');
  };

  // DRE semanal (semana do mes, horario local) — mesmas regras do Dashboard (db/finance.ts).
  const scopedSales = completedSales(sales).filter(sale => inScope(sale.unitId, activeIndicatorScope));
  const scopedExpenses = expenses.filter(expense => inScope(expense.unitId, activeIndicatorScope));
  const currentMonthKey = monthKeyOf(new Date().toISOString());
  // Meses disponiveis: os que tem movimento + o mes atual, do mais recente ao mais antigo.
  const dreMonthOptions = Array.from(new Set([
    currentMonthKey,
    dreMonth,
    ...scopedSales.map(sale => monthKeyOf(sale.timestamp)),
    ...scopedExpenses.map(expense => monthKeyOf(expense.timestamp)),
  ])).sort((a, b) => b.localeCompare(a));
  const dreMonthWeeks = weeksOfMonth(dreMonth);
  const monthSales = scopedSales.filter(sale => monthKeyOf(sale.timestamp) === dreMonth);
  const monthExpenses = scopedExpenses.filter(expense => monthKeyOf(expense.timestamp) === dreMonth);
  const weeklyChartData = dreMonthWeeks
    .filter(week => dreWeek === 'all' || week.endsWith(`-${dreWeek}`))
    .map(week => ({
      week,
      ...summarize(
        monthSales.filter(sale => monthWeekKey(sale.timestamp) === week),
        monthExpenses.filter(expense => monthWeekKey(expense.timestamp) === week)
      ),
    }));
  const dreMonthTotal = summarize(monthSales, monthExpenses);
  const weeksMissingCost = weeklyChartData.reduce((sum, row) => sum + row.salesMissingCost, 0);
  const changeDreMonth = (monthKey: string) => {
    setDreMonth(monthKey);
    setDreWeek('all');
  };

  // Cards de ponto de equilibrio: mes atual (o custo fixo e mensal).
  const currentMonth = resolvePeriod('mes');
  const breakEvenStores = stores.filter(store => inScope(store.unitId, activeIndicatorScope));

  return (
    <div className="space-y-6">
      {/* Sub navigation bar */}
      <div className="flex justify-between items-center bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex-wrap gap-4">
        <div className="flex space-x-2">
          <button
            id="tab-financeiro-sales"
            onClick={() => setActiveTab('vendas')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeTab === 'vendas'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Receipt className="w-4 h-4 mr-1.5" />
            Histórico de Vendas
          </button>
          <button
            id="tab-financeiro-expenses"
            onClick={() => setActiveTab('despesas')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeTab === 'despesas'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Calculator className="w-4 h-4 mr-1.5" />
            Registro de Despesas (Saídas)
          </button>
          <button
            id="tab-financeiro-indicators"
            onClick={() => setActiveTab('indicadores')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeTab === 'indicadores'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Activity className="w-4 h-4 mr-1.5" />
            Indicadores & DRE Semanal
          </button>
          {isAdmin && (
            <button
              id="tab-financeiro-configs"
              onClick={() => setActiveTab('configs')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
                activeTab === 'configs'
                  ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                  : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
              }`}
            >
              <Settings className="w-4 h-4 mr-1.5" />
              Taxas & Custos Fixos (Admin)
            </button>
          )}
        </div>
      </div>

      {/* 0. VIEW: Registro de Vendas por Forma de Pagamento */}
      {activeTab === 'vendas' && (
        <div className="grid grid-cols-1 gap-6 font-sans">
          {/* Histórico de Vendas */}
          <div className="space-y-6">
            {saleSuccess && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-lg flex items-start space-x-2 text-xs">
                <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <span>{saleSuccess}</span>
              </div>
            )}

            {saleError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-800 p-3 rounded-lg flex items-start space-x-2 text-xs">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{saleError}</span>
              </div>
            )}
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Histórico de Vendas</h3>
                  <p className="text-xs text-slate-400 font-sans">Vendas registradas pelo PDV, por loja e data. O estorno é feito aqui.</p>
                </div>

                <div className="relative w-48 text-xs">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    placeholder="Filtrar por código/loja..."
                    value={searchSaleQuery}
                    onChange={(e) => setSearchSaleQuery(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-8 p-2 outline-none"
                  />
                </div>
              </div>

              <div className="overflow-x-auto text-xs">
                <table className="w-full text-left text-slate-500">
                  <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
                    <tr>
                      <th className="px-3 py-2">Data Lançamento</th>
                      <th className="px-3 py-2">Fatura / Doc</th>
                      <th className="px-3 py-2">Loja</th>
                      <th className="px-3 py-2 text-center">Forma Pagto</th>
                      <th className="px-3 py-2 text-right">Valor Bruto</th>
                      <th className="px-3 py-2 text-right">Valor Líquido</th>
                      <th className="px-3 py-2 text-center">Status</th>
                      <th className="px-3 py-2 text-center">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sales
                      .filter(s => {
                        if (!searchSaleQuery) return true;
                        const query = searchSaleQuery.toLowerCase();
                        const storeLabel = s.unitId === 'loja_1' ? 'loja 1' : s.unitId === 'loja_2' ? 'loja 2' : s.unitId === 'loja_3' ? 'loja 3' : 'central';
                        return (
                          s.invoiceNumber.toLowerCase().includes(query) ||
                          storeLabel.includes(query) ||
                          s.paymentMethod.toLowerCase().includes(query) ||
                          (SALE_PAYMENT_METHOD_LABELS[s.paymentMethod] ?? '').toLowerCase().includes(query) ||
                          (s.payments ?? []).some(p => (SALE_PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod).toLowerCase().includes(query)) ||
                          new Date(s.timestamp).toLocaleDateString('pt-BR').includes(query)
                        );
                      })
                      .map((s) => {
                        const storeLabel = s.unitId === 'loja_1' ? 'Loja 1' : s.unitId === 'loja_2' ? 'Loja 2' : s.unitId === 'loja_3' ? 'Loja 3' : 'Central';
                        const isCancelPending = s.status === 'PENDENTE_APROVACAO';
                        const isCanceled = s.status === 'CANCELADA';
                        const isCompleted = s.status === 'CONCLUIDA';
                        
                        return (
                          <tr key={s.id} className="hover:bg-slate-50/50">
                            <td className="px-3 py-2.5 font-medium text-slate-700">
                              {new Date(s.timestamp).toLocaleDateString('pt-BR')}
                            </td>
                            <td className="px-3 py-2.5 font-bold text-slate-900">
                              {s.invoiceNumber}
                            </td>
                            <td className="px-3 py-2.5 font-medium text-slate-700">
                              {storeLabel}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded font-semibold text-[10px]">
                                {SALE_PAYMENT_METHOD_LABELS[s.paymentMethod] ?? s.paymentMethod}
                              </span>
                              {s.payments && s.payments.length > 1 && (
                                <div className="mt-1 flex flex-col items-center gap-0.5 text-[10px] text-slate-500">
                                  {s.payments.map((p, index) => (
                                    <span key={`${s.id}-payment-${index}`}>
                                      {SALE_PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}: R$ {p.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right font-bold text-slate-950 font-mono">
                              R$ {s.grossAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                            </td>
                            <td className="px-3 py-2.5 text-right font-semibold text-emerald-700 font-mono">
                              R$ {s.netAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              {isCompleted && (
                                <span className="px-2 py-0.5 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full text-[9px] font-bold">
                                  Concluída
                                </span>
                              )}
                              {isCancelPending && (
                                <span className="px-2 py-0.5 bg-amber-50 text-amber-800 border border-amber-200 rounded-full text-[9px] font-bold animate-pulse">
                                  Estorno Pendente
                                </span>
                              )}
                              {isCanceled && (
                                <span className="px-2 py-0.5 bg-slate-100 text-slate-500 border border-slate-200 rounded-full text-[9px] font-bold line-through">
                                  Estornada
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              {isCompleted && (
                                <button
                                  type="button"
                                  onClick={() => handleCancelSale(s.id)}
                                  className="px-2.5 py-1 bg-rose-50 text-rose-700 hover:bg-rose-100 font-bold rounded-lg border border-rose-200 transition text-[10px]"
                                >
                                  Estornar
                                </button>
                              )}
                              {isCancelPending && (
                                <div className="space-y-1">
                                  {isAdmin ? (
                                    <button
                                      type="button"
                                      onClick={() => handleApproveCancelSale(s.id)}
                                      className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg transition text-[10px] shadow-sm flex items-center justify-center mx-auto"
                                    >
                                      <Check className="w-3 h-3 mr-0.5" />
                                      Aprovar
                                    </button>
                                  ) : (
                                    <span className="text-[9px] text-amber-600 font-semibold block">Aguardando Admin</span>
                                  )}
                                </div>
                              )}
                              {isCanceled && (
                                <span className="text-[10px] text-slate-400 font-medium">Estorno Aprovado</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    
                    {sales.length === 0 && (
                      <tr>
                        <td colSpan={8} className="text-center text-slate-400 py-10">Nenhuma venda registrada recentemente.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 1. VIEW: Registro de Despesas */}
      {activeTab === 'despesas' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-sans">
          {/* Form Card */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-1 space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Lançamento de Despesa</h3>
              <p className="text-xs text-slate-400">Lance saídas variáveis de caixa (contas, manutenção, urgências).</p>
            </div>

            {expenseError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-800 p-3 rounded-lg flex items-center gap-2 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{expenseError}</span>
              </div>
            )}

            {expenseSuccess && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-lg flex items-center gap-2 text-xs">
                <Check className="w-4 h-4 shrink-0" />
                <span>{expenseSuccess}</span>
              </div>
            )}

            <form onSubmit={handleExpenseSubmit} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="font-bold text-slate-700">Descrição</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Cartucho de tinta impressora"
                  value={expenseDesc}
                  onChange={(e) => setExpenseDesc(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Categoria</label>
                  <select
                    value={expenseCat}
                    onChange={(e) => setExpenseCat(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2outline-none"
                  >
                    <option value="Água/Luz">Contas (Água/Luz)</option>
                    <option value="Aluguel">Aluguel</option>
                    <option value="Salários">Salários</option>
                    <option value="Manutenção">Manutenção</option>
                    <option value="Compras Urgentes">Compras Urgentes</option>
                    <option value="Outros">Outros</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Vincular à Loja</label>
                  <select
                    value={expenseStore}
                    onChange={(e) => setExpenseStore(e.target.value)}
                    required
                    disabled={stores.length === 0}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none disabled:text-slate-400"
                  >
                    {stores.length === 0 && <option value="">Nenhuma loja cadastrada</option>}
                    {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-bold text-slate-700">Valor da Saída (R$)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={expenseAmount || ''}
                  onChange={(e) => setExpenseAmount(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none font-mono"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition font-bold"
              >
                Lançar Despesa
              </button>
            </form>
          </div>

          {/* Expenses Ledger Table */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-2">Livro Caixa de Saídas</h3>
              <p className="text-xs text-slate-400 mb-4">Veja as despesas cadastradas por data e operador.</p>
            </div>

            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left text-slate-500">
                <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
                  <tr>
                    <th className="px-3 py-2">Data/Hora</th>
                    <th className="px-3 py-2">Loja</th>
                    <th className="px-3 py-2">Descrição</th>
                    <th className="px-3 py-2 text-center">Categoria</th>
                    <th className="px-3 py-2 text-right">Valor</th>
                    <th className="px-3 py-2">Operador</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {expenses.map(e => (
                    <tr key={e.id} className="hover:bg-slate-50/50">
                      <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400">
                        {new Date(e.timestamp).toLocaleString('pt-BR')}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-slate-700">
                        {e.unitId === 'loja_1' ? 'Loja 1' : e.unitId === 'loja_2' ? 'Loja 2' : 'Loja 3'}
                      </td>
                      <td className="px-3 py-2.5 text-slate-900 font-medium">
                        {e.description}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="px-2 py-0.5 bg-rose-50 text-rose-800 rounded-[4px] font-semibold text-[10px]">
                          {e.category}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-bold text-rose-600 font-mono">
                        - R$ {e.amount.toLocaleString('pt-BR')}
                      </td>
                      <td className="px-3 py-2.5 text-slate-500 font-sans">
                        {e.operatorName.split(' ')[0]}
                      </td>
                    </tr>
                  ))}
                  {expenses.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-center text-slate-400 py-10">Nenhuma despesa lançada recentemente.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 2. VIEW: Indicadores e DRE Semanal */}
      {activeTab === 'indicadores' && (
        <div className="space-y-6 font-sans text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Indicadores & DRE</h3>
              <p className="text-xs text-slate-400">Lucro bruto = faturamento − custo das mercadorias. Lucro real = lucro bruto − taxas − despesas.</p>
            </div>
            {canChooseStore && (
              <label className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-500">Loja:</span>
                <select
                  id="financeiro-indicator-scope"
                  value={indicatorScope}
                  onChange={(e) => setIndicatorScope(e.target.value)}
                  className="bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold border border-slate-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value={CONSOLIDATED}>Consolidado (todas as lojas)</option>
                  {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* Ponto de equilibrio do mes atual, por loja */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {breakEvenStores.map(cfg => {
              const month = summarize(
                completedSales(sales).filter(sale => sale.unitId === cfg.unitId && isInRange(sale.timestamp, currentMonth)),
                expenses.filter(expense => expense.unitId === cfg.unitId && isInRange(expense.timestamp, currentMonth))
              );
              const storeRev = month.revenue;
              const storeProfit = month.operatingProfit;
              const goalPercent = cfg.fixedCost > 0 ? (storeRev / cfg.fixedCost) * 100 : 0;
              const hasMetGoal = cfg.fixedCost > 0 && storeRev >= cfg.fixedCost;

              return (
                <div key={cfg.unitId} className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm space-y-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="font-bold text-slate-900 text-sm">
                        {storeName(cfg.unitId)}
                      </h4>
                      <span className="text-[10px] text-slate-400 font-mono">Meta (custo fixo): {formatMoney(cfg.fixedCost)} /mês</span>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      hasMetGoal ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                    }`}>
                      {hasMetGoal ? 'Ponto de Equilíbrio Atingido' : 'Em Andamento'}
                    </span>
                  </div>

                  {/* Meter graph progress bar */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-slate-400 font-semibold">
                      <span>Progresso da meta no mês:</span>
                      <span>{Math.round(goalPercent)}%</span>
                    </div>
                    <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${hasMetGoal ? 'bg-emerald-500' : 'bg-amber-500'}`}
                        style={{ width: `${Math.min(100, goalPercent)}%` }}
                      />
                    </div>
                  </div>

                  <div className="border-t border-slate-100 pt-3.5 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Faturamento do mês:</span>
                      <span className="font-bold text-slate-900">{formatMoney(storeRev)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Custo das mercadorias:</span>
                      <span className="font-semibold text-rose-600">- {formatMoney(month.cost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Taxas de pagamento:</span>
                      <span className="font-semibold text-rose-600">- {formatMoney(month.fees)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Despesas lançadas:</span>
                      <span className="font-semibold text-rose-600">- {formatMoney(month.expenses)}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-50 pt-2 text-sm font-black text-slate-900">
                      <span>Lucro real operacional:</span>
                      <span className={storeProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                        {formatMoney(storeProfit)}
                      </span>
                    </div>
                    {month.salesMissingCost > 0 && (
                      <p className="text-[10px] text-amber-700">{month.salesMissingCost} venda(s) sem custo registrado no mês.</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* DRE Semanal (semana do mes) */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-2">Balanço e DRE Semanal</h3>
              <p className="text-xs text-slate-400 mb-4">Escolha o mês e, se quiser, uma semana (segunda a domingo).</p>
            </div>

            <div className="flex flex-col gap-3 mb-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => changeDreMonth(shiftMonthKey(dreMonth, -1))}
                  aria-label="Mês anterior"
                  className="w-8 h-8 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 font-bold"
                >
                  ‹
                </button>
                <select
                  id="dre-month"
                  aria-label="Mês do DRE"
                  value={dreMonth}
                  onChange={(e) => changeDreMonth(e.target.value)}
                  className="bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold border border-slate-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 min-w-[150px]"
                >
                  {dreMonthOptions.map(monthKey => <option key={monthKey} value={monthKey}>{monthLabel(monthKey)}</option>)}
                </select>
                <button
                  type="button"
                  onClick={() => changeDreMonth(shiftMonthKey(dreMonth, 1))}
                  disabled={dreMonth >= currentMonthKey}
                  aria-label="Próximo mês"
                  className="w-8 h-8 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 font-bold disabled:opacity-40"
                >
                  ›
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Semana do DRE">
                <button
                  type="button"
                  onClick={() => setDreWeek('all')}
                  aria-pressed={dreWeek === 'all'}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
                    dreWeek === 'all' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  Mês inteiro
                </button>
                {dreMonthWeeks.map(week => {
                  const range = monthWeekRange(week);
                  const weekNumber = week.slice(-2);
                  return (
                    <button
                      key={week}
                      type="button"
                      onClick={() => setDreWeek(weekNumber)}
                      aria-pressed={dreWeek === weekNumber}
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
                        dreWeek === weekNumber ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      Sem {weekNumber}
                      <span className={`ml-1 font-normal ${dreWeek === weekNumber ? 'text-slate-300' : 'text-slate-400'}`}>
                        {String(range.startDay).padStart(2, '0')}–{String(range.endDay).padStart(2, '0')}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-slate-500">
                <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
                  <tr>
                    <th className="px-4 py-2.5">Semana</th>
                    <th className="px-4 py-2.5 text-right">Faturamento Bruto</th>
                    <th className="px-4 py-2.5 text-right">Custo Mercadorias</th>
                    <th className="px-4 py-2.5 text-right">Lucro Bruto</th>
                    <th className="px-4 py-2.5 text-right">Taxas</th>
                    <th className="px-4 py-2.5 text-right">Despesas</th>
                    <th className="px-4 py-2.5 text-right">Lucro Real Operacional</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {weeklyChartData.map(row => (
                    <tr key={row.week} className="hover:bg-slate-50/50">
                      <td className="px-4 py-2.5 font-bold text-slate-900">
                        {monthWeekLabel(row.week)}
                        {row.salesMissingCost > 0 && (
                          <span className="ml-1 text-amber-600" title={`${row.salesMissingCost} venda(s) sem custo registrado`}>*</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-700">{formatMoney(row.revenue)}</td>
                      <td className="px-4 py-2.5 text-right text-rose-600">- {formatMoney(row.cost)}</td>
                      <td className={`px-4 py-2.5 text-right font-semibold ${row.grossProfit >= 0 ? 'text-slate-900' : 'text-rose-700'}`}>{formatMoney(row.grossProfit)}</td>
                      <td className="px-4 py-2.5 text-right text-rose-600">- {formatMoney(row.fees)}</td>
                      <td className="px-4 py-2.5 text-right text-rose-600">- {formatMoney(row.expenses)}</td>
                      <td className={`px-4 py-2.5 text-right font-black ${
                        row.operatingProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'
                      }`}>
                        {formatMoney(row.operatingProfit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {dreWeek === 'all' && (
                  <tfoot className="font-mono border-t-2 border-slate-200 bg-slate-50">
                    <tr>
                      <td className="px-4 py-2.5 font-sans font-bold text-slate-900">Total de {monthLabel(dreMonth)}</td>
                      <td className="px-4 py-2.5 text-right font-bold text-slate-900">{formatMoney(dreMonthTotal.revenue)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-rose-600">- {formatMoney(dreMonthTotal.cost)}</td>
                      <td className={`px-4 py-2.5 text-right font-bold ${dreMonthTotal.grossProfit >= 0 ? 'text-slate-900' : 'text-rose-700'}`}>{formatMoney(dreMonthTotal.grossProfit)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-rose-600">- {formatMoney(dreMonthTotal.fees)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-rose-600">- {formatMoney(dreMonthTotal.expenses)}</td>
                      <td className={`px-4 py-2.5 text-right font-black ${dreMonthTotal.operatingProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatMoney(dreMonthTotal.operatingProfit)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {weeksMissingCost > 0 && (
              <p className="text-[11px] text-amber-700 mt-3 font-sans">
                * Semana com {weeksMissingCost === 1 ? 'uma venda' : 'vendas'} sem custo registrado (anteriores à 2.7b ou lançamentos manuais): o custo delas não entra na conta.
              </p>
            )}
          </div>
        </div>
      )}

      {/* 3. VIEW: Configuração de Custos/Taxas */}
      {activeTab === 'configs' && isAdmin && (
        <div className="max-w-xl mx-auto bg-white p-6 rounded-xl border border-slate-200 shadow-sm font-sans space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-950 uppercase tracking-tight">Configurador de Custos e Taxas Financeiras</h3>
            <p className="text-xs text-slate-400">Configure os custos fixos mensais para cálculo de break-even e as taxas que as operadoras cobram para cada método de pagamento.</p>
          </div>

          <div className="space-y-4 text-xs">
            {/* Store config selector */}
            <div className="space-y-1.5">
              <label className="font-bold text-slate-700">Selecione a Loja Física</label>
              <select
                value={selectedConfigUnit}
                onChange={(e) => handleConfigStoreChange(e.target.value)}
                disabled={stores.length === 0}
                className="w-full bg-slate-50 border border-slate-200 rounded p-2 outline-none"
              >
                {stores.length === 0 && <option value="">Nenhuma loja cadastrada</option>}
                {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
              </select>
            </div>

            <form onSubmit={handleConfigSubmit} className="space-y-4">
              {/* Fixed monthly cost */}
              <div className="space-y-1.5">
                <label className="font-bold text-slate-700 flex justify-between">
                  <span>Custo Fixo Mensal (R$)</span>
                  <span className="text-[10px] text-slate-400">Aluguel + Contas + Salários + Custos fixos</span>
                </label>
                <input
                  type="number"
                  min="0"
                  required
                  value={editFixedCost || ''}
                  onChange={(e) => setEditFixedCost(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 border border-slate-200 rounded p-2 outline-none font-mono"
                />
              </div>

              {/* Fee sliders/percentage inputs */}
              <div className="space-y-3 bg-slate-50 p-4 rounded-xl border border-slate-100">
                <h4 className="font-bold text-slate-800 uppercase tracking-wider text-[10px] flex items-center">
                  <Percent className="w-3.5 h-3.5 text-amber-500 mr-1.5" />
                  Taxas de Operadoras de Pagamento
                </h4>
                
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="font-bold text-slate-600 block text-[10px]">PIX (%)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      pattern="[0-9]*[.,]?[0-9]*"
                      value={editPixFee}
                      onChange={(e) => setEditPixFee(e.target.value.replace(/[^0-9,.]/g, ''))}
                      className="w-full bg-white border border-slate-200 rounded p-1.5 outline-none font-mono"
                    />
                    <span className="text-[10px] text-slate-400 font-mono">{editPixFee || '0'}%</span>
                  </div>

                  <div className="space-y-1">
                    <label className="font-bold text-slate-600 block text-[10px]">Crédito (%)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      pattern="[0-9]*[.,]?[0-9]*"
                      value={editCredFee}
                      onChange={(e) => setEditCredFee(e.target.value.replace(/[^0-9,.]/g, ''))}
                      className="w-full bg-white border border-slate-200 rounded p-1.5 outline-none font-mono"
                    />
                    <span className="text-[10px] text-slate-400 font-mono">{editCredFee || '0'}%</span>
                  </div>

                  <div className="space-y-1">
                    <label className="font-bold text-slate-600 block text-[10px]">Débito (%)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      pattern="[0-9]*[.,]?[0-9]*"
                      value={editDebFee}
                      onChange={(e) => setEditDebFee(e.target.value.replace(/[^0-9,.]/g, ''))}
                      className="w-full bg-white border border-slate-200 rounded p-1.5 outline-none font-mono"
                    />
                    <span className="text-[10px] text-slate-400 font-mono">{editDebFee || '0'}%</span>
                  </div>
                </div>

                <div className="text-[10px] text-slate-400 bg-white p-2 rounded border border-slate-150 font-sans mt-2">
                  ℹ️ <strong>Nota:</strong> Pagamentos em <strong>DINHEIRO</strong> estão configurados com <strong>0.0% de taxa</strong> automática de caixa.
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg transition"
              >
                Salvar Configuração de Custos
              </button>
              {configSuccess && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-lg flex items-center gap-2 text-xs">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>{configSuccess}</span>
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
