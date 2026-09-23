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

interface FinanceiroViewProps {
  currentUser: User;
  expenses: Expense[];
  storeConfigs: StoreConfig[];
  sales: Sale[];
  products: Product[];
  inventory: StockInventory[];
  addExpense: (expense: Omit<Expense, 'id' | 'operatorId' | 'operatorName' | 'timestamp'>) => void;
  updateStoreConfig: (unitId: string, updated: Partial<StoreConfig>) => void;
  registerSale: (
    unitId: string,
    items: { productId: string; variationId?: string; quantity: number; unitPrice: number; serials?: string[]; cardCondition?: CardCondition }[],
    paymentMethod: PaymentMethod,
    clientCpf?: string,
    clientName?: string,
    customAmount?: number,
    customDate?: string
  ) => Sale;
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
  registerSale,
  cancelSale
}: FinanceiroViewProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const defaultStoreId = stores[0]?.unitId || '';
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;

  // Active sub-menu: Despesas or Configuração de Custos/Taxas or Break-Even or Registro de Vendas
  const [activeTab, setActiveTab] = useState<'vendas' | 'despesas' | 'indicadores' | 'configs'>('vendas');

  // Sales form states
  const [saleStore, setSaleStore] = useState<string>('');
  const [salePaymentMethod, setSalePaymentMethod] = useState<PaymentMethod>('PIX');
  const [saleAmount, setSaleAmount] = useState<number>(0);
  const [saleDate, setSaleDate] = useState<string>(() => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  });

  const [saleError, setSaleError] = useState('');
  const [saleSuccess, setSaleSuccess] = useState('');
  const [configSuccess, setConfigSuccess] = useState('');
  const [searchSaleQuery, setSearchSaleQuery] = useState('');

  const handleRegisterSimpleSale = (e: React.FormEvent) => {
    e.preventDefault();
    setSaleError('');
    setSaleSuccess('');

    if (!saleStore || saleAmount <= 0) {
      setSaleError('Por favor, informe um valor de venda válido e maior que zero.');
      return;
    }

    if (!saleDate) {
      setSaleError('Por favor, selecione a data da venda.');
      return;
    }

    try {
      const newSale = registerSale(
        saleStore,
        [], // empty items, as we register by payment method value directly
        salePaymentMethod,
        undefined, // no client CPF
        undefined, // no client Name
        saleAmount,
        saleDate
      );

      setSaleAmount(0);
      const formattedDate = new Date(saleDate + 'T12:00:00').toLocaleDateString('pt-BR');
      setSaleSuccess(`Venda ${newSale.invoiceNumber} de R$ ${saleAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} via ${salePaymentMethod} registrada com sucesso para o dia ${formattedDate}!`);
    } catch (err: any) {
      setSaleError(err?.message || 'Erro ao registrar venda.');
    }
  };

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

  // Calculate fee rate for currently configured store
  const currentStoreConfig = storeConfigs.find(c => c.unitId === saleStore) || {
    unitId: saleStore,
    fixedCost: 10000,
    paymentFees: { DINHEIRO: 0, PIX: 0.005, CREDITO: 0.035, DEBITO: 0.015 }
  };
  const currentFeeRate = currentStoreConfig.paymentFees[salePaymentMethod] || 0;
  const parsedSaleAmount = saleAmount || 0;
  const calculatedFee = parsedSaleAmount * currentFeeRate;
  const calculatedNet = parsedSaleAmount - calculatedFee;

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
    setSaleStore(previous => stores.some(store => store.unitId === previous) ? previous : defaultStoreId);
    setExpenseStore(previous => stores.some(store => store.unitId === previous) ? previous : defaultStoreId);
    setSelectedConfigUnit(previous => stores.some(store => store.unitId === previous) ? previous : defaultStoreId);
  }, [storeConfigs]);

  const activeEditingConfig = storeConfigs.find(c => c.unitId === selectedConfigUnit) || {
    unitId: selectedConfigUnit,
    fixedCost: 10000,
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

  // Weekly ISO grouped balance calculation
  // Helper to get ISO Week number
  const getISOWeek = (dateStr: string) => {
    const d = new Date(dateStr);
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return `${d.getUTCFullYear()}-W${Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)}`;
  };

  const weeklyBalances: { [week: string]: { revenue: number; expenses: number; fees: number } } = {};

  sales.filter(s => s.status === 'CONCLUIDA').forEach(s => {
    const week = getISOWeek(s.timestamp);
    if (!weeklyBalances[week]) weeklyBalances[week] = { revenue: 0, expenses: 0, fees: 0 };
    weeklyBalances[week].revenue += s.grossAmount;
    weeklyBalances[week].fees += s.feeAmount;
  });

  expenses.forEach(e => {
    const week = getISOWeek(e.timestamp);
    if (!weeklyBalances[week]) weeklyBalances[week] = { revenue: 0, expenses: 0, fees: 0 };
    weeklyBalances[week].expenses += e.amount;
  });

  const weeklyChartData = Object.entries(weeklyBalances).map(([week, data]) => ({
    week,
    gross: data.revenue,
    expenses: data.expenses,
    net: data.revenue - data.expenses - data.fees
  })).sort((a, b) => a.week.localeCompare(b.week));

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
            Registro de Vendas por Pagamento
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 font-sans">
          {/* Form Card (Lançador) */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-5 space-y-4 text-xs h-fit">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Lançar Nova Venda</h3>
              <p className="text-xs text-slate-400">Registre o faturamento diário consolidado ou vendas individuais por loja e forma de pagamento para alimentar o fluxo de caixa e o DRE.</p>
            {configSuccess && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-lg flex items-center gap-2 text-xs">
                <Check className="w-4 h-4 shrink-0" />
                <span>{configSuccess}</span>
              </div>
            )}
            </div>

            {saleSuccess && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-lg flex items-start space-x-2">
                <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <span>{saleSuccess}</span>
              </div>
            )}

            {saleError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-800 p-3 rounded-lg flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{saleError}</span>
              </div>
            )}

            <form onSubmit={handleRegisterSimpleSale} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Ponto de Venda (Loja)</label>
                  <select
                    value={saleStore}
                    onChange={(e) => setSaleStore(e.target.value)}
                    required
                    disabled={stores.length === 0}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-medium disabled:text-slate-400"
                  >
                    {stores.length === 0 && <option value="">Nenhuma loja cadastrada</option>}
                    {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Forma de Pagamento</label>
                  <select
                    value={salePaymentMethod}
                    onChange={(e) => setSalePaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-medium"
                  >
                    <option value="PIX">PIX</option>
                    <option value="DINHEIRO">Dinheiro físico</option>
                    <option value="CREDITO">Cartão de Crédito</option>
                    <option value="DEBITO">Cartão de Débito</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Valor da Venda (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={saleAmount || ''}
                    onChange={(e) => setSaleAmount(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono font-bold"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Data da Venda</label>
                  <input
                    type="date"
                    required
                    value={saleDate}
                    onChange={(e) => setSaleDate(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-medium"
                  />
                </div>
              </div>

              {/* Fee Breakdown Simulation */}
              <div className="border-t border-slate-100 pt-3 space-y-2">
                <h4 className="font-bold text-slate-900 uppercase tracking-wider text-[10px]">Resumo do Lançamento</h4>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-150 space-y-1.5">
                  <div className="flex justify-between text-slate-600">
                    <span>Faturamento Informado:</span>
                    <span className="font-mono font-semibold">R$ {parsedSaleAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-rose-600">
                    <span>Taxas Estimadas ({(currentFeeRate * 100).toFixed(1)}% via {salePaymentMethod}):</span>
                    <span className="font-mono font-semibold">- R$ {calculatedFee.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200/60 pt-2 text-slate-900 font-bold">
                    <span>Líquido Estimado (Caixa):</span>
                    <span className="font-mono text-emerald-700">R$ {calculatedNet.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition font-bold text-xs shadow-sm flex items-center justify-center space-x-1"
              >
                <Check className="w-4 h-4" />
                <span>Salvar Lançamento</span>
              </button>
            </form>
          </div>

          {/* Histórico de Vendas */}
          <div className="lg:col-span-7 space-y-6">
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Histórico de Vendas</h3>
                  <p className="text-xs text-slate-400 font-sans">Todos os lançamentos de faturamento no livro caixa por loja e data.</p>
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
                                {s.paymentMethod}
                              </span>
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
          {/* Break-Even Calculator explanation */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {storeConfigs.map(cfg => {
              const storeSales = sales.filter(s => s.status === 'CONCLUIDA' && s.unitId === cfg.unitId);
              const storeExpenses = expenses.filter(e => e.unitId === cfg.unitId);
              const storeRev = storeSales.reduce((acc, s) => acc + s.grossAmount, 0);
              const storeFees = storeSales.reduce((acc, s) => acc + s.feeAmount, 0);
              const storeExp = storeExpenses.reduce((acc, e) => acc + e.amount, 0);
              const storeProfit = storeRev - storeFees - storeExp;

              const dailyBreakEven = cfg.fixedCost / 30;
              const hasMetGoal = storeRev >= cfg.fixedCost;

              return (
                <div key={cfg.unitId} className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm space-y-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="font-bold text-slate-900 text-sm">
                        {storeName(cfg.unitId)}
                      </h4>
                      <span className="text-[10px] text-slate-400 font-mono">Custo Fixo: R$ {cfg.fixedCost.toLocaleString('pt-BR')} /mês</span>
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
                      <span>Progresso da Meta:</span>
                      <span>{Math.round((storeRev / cfg.fixedCost) * 100)}%</span>
                    </div>
                    <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${hasMetGoal ? 'bg-emerald-500' : 'bg-amber-500'}`} 
                        style={{ width: `${Math.min(100, (storeRev / cfg.fixedCost) * 100)}%` }} 
                      />
                    </div>
                  </div>

                  <div className="border-t border-slate-100 pt-3.5 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Faturamento Realizado:</span>
                      <span className="font-bold text-slate-900">R$ {storeRev.toLocaleString('pt-BR')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Despesas + Taxas de Cartão:</span>
                      <span className="font-semibold text-rose-600">- R$ {(storeExp + storeFees).toLocaleString('pt-BR')}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-50 pt-2 text-sm font-black text-slate-900">
                      <span>Resultado Líquido:</span>
                      <span className={storeProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                        R$ {storeProfit.toLocaleString('pt-BR')}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* DRE Semanal ISO Display */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-2">Balanço e DRE Semanal (ISO-Week)</h3>
              <p className="text-xs text-slate-400 mb-4">Acompanhe a saúde de caixa agregada por semanas ISO de operação.</p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-slate-500">
                <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
                  <tr>
                    <th className="px-4 py-2.5">Código Semana ISO</th>
                    <th className="px-4 py-2.5 text-right">Faturamento Bruto (Entradas)</th>
                    <th className="px-4 py-2.5 text-right">Custos Variáveis (Taxas/Saídas)</th>
                    <th className="px-4 py-2.5 text-right">Lucro Real Estimado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {weeklyChartData.map(row => (
                    <tr key={row.week} className="hover:bg-slate-50/50">
                      <td className="px-4 py-2.5 font-bold text-slate-900">
                        {row.week}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-700">
                        R$ {row.gross.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-2.5 text-right text-rose-600 font-semibold">
                        - R$ {row.expenses.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-black ${
                        row.net >= 0 ? 'text-emerald-700' : 'text-rose-700'
                      }`}>
                        R$ {row.net.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                  {weeklyChartData.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center text-slate-400 py-10 font-sans">Sem dados de faturamento recentes.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
