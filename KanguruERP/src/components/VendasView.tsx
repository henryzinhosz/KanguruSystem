/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { 
  User, 
  UserRole, 
  Product, 
  StockInventory, 
  TradeIn,
  TradeInApproval,
  StoreConfig
} from '../types';
import { 
  Plus, 
  CheckCircle, 
  Coins,
  ArrowRight
} from 'lucide-react';
import ValueInput from './ValueInput';
import { sanitizeItemCode } from '../db/itemCode';
import { CSOSNS, ICMS_CSTS, ICMS_ORIGINS, productFiscalError } from '../db/fiscal';

// Dados fiscais padrao da Troca Gamer (so videogames), informados pelo usuario em 2026-10-28.
// CFOP 5102 sai sozinho na NFC-e (CSOSN 102). O franqueado pode alterar na aprovacao.
const TRADE_FISCAL_DEFAULTS = { ncm: '9504.50.00', origin: '0', csosn: '102', cst: '', cest: '', icmsRate: 0, icmsReduction: 0 };

interface VendasViewProps {
  currentUser: User;
  products: Product[];
  inventory: StockInventory[];
  tradeIns: TradeIn[];
  storeConfigs: StoreConfig[];
  registerTradeIn: (trade: Omit<TradeIn, 'id' | 'operatorId' | 'operatorName' | 'timestamp' | 'status'>) => TradeIn;
  approveTradeIn: (tradeId: string, details: TradeInApproval) => Promise<void>;
  cancelTradeIn: (tradeId: string) => void;
}

export default function VendasView({
  currentUser,
  products,
  inventory,
  tradeIns,
  storeConfigs,
  registerTradeIn,
  approveTradeIn,
  cancelTradeIn
}: VendasViewProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const defaultStoreId = stores[0]?.unitId || '';

  // Filter state for Store (Consolidated or specific store)
  const [selectedStoreFilter, setSelectedStoreFilter] = useState<string>('consolidado');

  // New trade registration target physical store state
  const [tradeUnitId, setTradeUnitId] = useState<string>('');

  // Trade-In form states
  const [tradeSellerName, setTradeSellerName] = useState('');
  const [tradeSellerCpf, setTradeSellerCpf] = useState('');
  const [tradeDesc, setTradeDesc] = useState('');
  const tradeCategory = 'Videogames';
  const [tradeCondition, setTradeCondition] = useState('Excelente');
  const [tradeValuation, setTradeValuation] = useState<number>(0);
  const [tradeSuccess, setTradeSuccess] = useState(false);
  const [tradeError, setTradeError] = useState('');

  // Trade-In approval modal states
  const [tradeToApprove, setTradeToApprove] = useState<TradeIn | null>(null);
  const [approveSku, setApproveSku] = useState('');
  const [approveSellPrice, setApproveSellPrice] = useState(0);
  const [approveWarranty, setApproveWarranty] = useState(3);
  const [approveName, setApproveName] = useState('');
  const [approveSerial, setApproveSerial] = useState('');
  const [approveImei, setApproveImei] = useState('');
  const [approveNcm, setApproveNcm] = useState(TRADE_FISCAL_DEFAULTS.ncm);
  const [approveOrigin, setApproveOrigin] = useState(TRADE_FISCAL_DEFAULTS.origin);
  const [approveCsosn, setApproveCsosn] = useState(TRADE_FISCAL_DEFAULTS.csosn);
  const [approveCst, setApproveCst] = useState(TRADE_FISCAL_DEFAULTS.cst);
  const [approveCest, setApproveCest] = useState(TRADE_FISCAL_DEFAULTS.cest);
  const [approveIcmsRate, setApproveIcmsRate] = useState<number | null>(TRADE_FISCAL_DEFAULTS.icmsRate);
  const [approveIcmsReduction, setApproveIcmsReduction] = useState<number | null>(TRADE_FISCAL_DEFAULTS.icmsReduction);
  const [approveTaxBurden, setApproveTaxBurden] = useState<number | null>(null);
  const [approveError, setApproveError] = useState('');
  const [approveSaving, setApproveSaving] = useState(false);

  useEffect(() => {
    if (!stores.length) return;
    setTradeUnitId(previous => stores.some(store => store.unitId === previous) ? previous : defaultStoreId);
  }, [storeConfigs]);

  // Register Trade-In buyback appraisal
  const handleTradeInSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTradeSuccess(false);
    setTradeError('');

    if (!tradeUnitId || !tradeSellerName || !tradeSellerCpf || !tradeDesc || tradeValuation <= 0) {
      setTradeError('Preencha todos os campos obrigatórios da avaliação de usado.');
      return;
    }

    registerTradeIn({
      sellerName: tradeSellerName,
      sellerCpf: tradeSellerCpf,
      itemDescription: tradeDesc,
      category: tradeCategory,
      condition: tradeCondition,
      valuationAmount: tradeValuation,
      unitId: tradeUnitId
    });

    setTradeSuccess(true);
    setTradeSellerName('');
    setTradeSellerCpf('');
    setTradeDesc('');
    setTradeValuation(0);
  };

  // Open Approval details
  const handleOpenApproval = (trade: TradeIn) => {
    setTradeToApprove(trade);
    setApproveSku('');
    setApproveName(`${trade.itemDescription} (Usado)`);
    setApproveSellPrice(Math.round(trade.valuationAmount * 150) / 100); // sugestao: compra + 50%
    setApproveWarranty(3);
    setApproveSerial('');
    setApproveImei('');
    setApproveNcm(TRADE_FISCAL_DEFAULTS.ncm);
    setApproveOrigin(TRADE_FISCAL_DEFAULTS.origin);
    setApproveCsosn(TRADE_FISCAL_DEFAULTS.csosn);
    setApproveCst(TRADE_FISCAL_DEFAULTS.cst);
    setApproveCest(TRADE_FISCAL_DEFAULTS.cest);
    setApproveIcmsRate(TRADE_FISCAL_DEFAULTS.icmsRate);
    setApproveIcmsReduction(TRADE_FISCAL_DEFAULTS.icmsReduction);
    setApproveError('');
  };

  // Aprovar: cadastra o produto e da entrada da unidade com o serial real. Erro aparece na tela.
  const handleConfirmApproval = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tradeToApprove || approveSaving) return;
    setApproveError('');

    const name = approveName.trim();
    const serial = approveSerial.trim().toUpperCase();
    const imei = approveImei.replace(/\s/g, '');
    if (!name) return setApproveError('Informe o nome do produto.');
    if (approveSellPrice <= 0) return setApproveError('Informe o preço de venda.');
    if (!serial) return setApproveError('Informe o número de série do videogame.');
    if (imei && !/^\d{15}$/.test(imei)) return setApproveError('IMEI inválido: são 15 números.');
    const fiscalError = productFiscalError({
      ncm: approveNcm.trim(),
      origin: approveOrigin,
      cst: approveCst,
      csosn: approveCsosn,
      cest: approveCest,
      icmsRate: approveIcmsRate,
      icmsReduction: approveIcmsReduction,
      taxBurden: approveTaxBurden
    });
    if (fiscalError) return setApproveError(fiscalError);

    setApproveSaving(true);
    try {
      await approveTradeIn(tradeToApprove.id, {
        sku: sanitizeItemCode(approveSku.trim()),
        name,
        sellPrice: approveSellPrice,
        warrantyMonths: approveWarranty,
        serialNumber: serial,
        imei,
        ncm: approveNcm.trim(),
        cest: approveCest.trim() || null,
        icmsOrigin: approveOrigin || null,
        icmsCst: approveCst || null,
        csosn: approveCsosn || null,
        icmsRate: approveIcmsRate,
        icmsReduction: approveIcmsReduction,
        taxBurdenPercent: approveTaxBurden
      });
      setTradeToApprove(null);
    } catch (err) {
      setApproveError((err as { message?: string })?.message || 'Não foi possível estocar o videogame.');
    } finally {
      setApproveSaving(false);
    }
  };

  const activeUnitId = currentUser.unitId === 'central' ? selectedStoreFilter : currentUser.unitId;

  const filteredTradeIns = tradeIns.filter(t => 
    activeUnitId === 'consolidado' || t.unitId === activeUnitId
  );

  return (
    <div className="space-y-6">
      
      {/* Title block */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-black text-slate-800 uppercase tracking-wider flex items-center">
            <Coins className="w-5 h-5 text-blue-600 mr-2" />
            Troca Gamer (Compra de Videogames Usados)
          </h2>
          <p className="text-xs text-slate-400">Avaliação de videogames usados trazidos por clientes e entrada no estoque com o número de série.</p>
        </div>
        {isAdmin && (
          <div className="flex items-center space-x-2 shrink-0">
            <span className="text-xs font-semibold text-slate-500 font-sans">Visão:</span>
            <select
              id="tradein-store-filter"
              value={selectedStoreFilter}
              onChange={(e) => setSelectedStoreFilter(e.target.value)}
              className="bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold border border-slate-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 transition"
            >
              <option value="consolidado">📊 Consolidado (Toda a Rede)</option>
              {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-sans">
        {/* Trade-in valuation Form */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-1 space-y-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
              <Plus className="w-4 h-4 text-blue-600 mr-1.5" />
              Nova Avaliação
            </h3>
            <p className="text-xs text-slate-400">Insira a descrição do item e os dados do vendedor para formalização do termo.</p>
          </div>

          <form onSubmit={handleTradeInSubmit} className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">Nome do Vendedor</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Arthur Pendragon"
                  value={tradeSellerName}
                  onChange={(e) => {
                    setTradeSellerName(e.target.value);
                    setTradeSuccess(false);
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                />
              </div>
              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">CPF do Vendedor</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: 000.000.000-00"
                  value={tradeSellerCpf}
                  onChange={(e) => {
                    setTradeSellerCpf(e.target.value);
                    setTradeSuccess(false);
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono font-semibold text-slate-700"
                />
              </div>
            </div>

            <div className="space-y-1.5">
                <label className="font-bold text-slate-700">Loja Avaliadora</label>
                <select
                  value={tradeUnitId}
                  onChange={(e) => setTradeUnitId(e.target.value)}
                  required
                  disabled={stores.length === 0}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                >
                  {stores.length === 0 && <option value="">Nenhuma loja cadastrada</option>}
                  {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
                </select>
              </div>

            <div className="space-y-1.5">
              <label className="font-bold text-slate-700">Descrição do Videogame</label>
              <input
                type="text"
                required
                placeholder="Ex: PlayStation 5 Slim 1TB c/ 1 Controle"
                value={tradeDesc}
                onChange={(e) => {
                  setTradeDesc(e.target.value);
                  setTradeSuccess(false);
                }}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
              />
            </div>

            <div>
              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">Condição Física Geral</label>
                <select
                  value={tradeCondition}
                  onChange={(e) => setTradeCondition(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                >
                  <option value="Lacrado">Novo / Lacrado (Preço Cheio)</option>
                  <option value="Excelente">Excelente (Sem marcas, c/ caixa)</option>
                  <option value="Bom">Bom (Sinais leves de uso)</option>
                  <option value="Avariado">Avariado / Desgastado</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="font-bold text-slate-700">Valor Proposto da Compra (R$)</label>
              <ValueInput
                required
                value={tradeValuation || null}
                onValueChange={(value) => setTradeValuation(value ?? 0)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
              />
            </div>

            {tradeSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-[10px] text-center font-medium">
                Avaliação registrada no banco! Itens prontos para estocagem.
              </div>
            )}

            {tradeError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-[10px] text-center font-medium">
                {tradeError}
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition font-bold"
            >
              Registrar Avaliação
            </button>
          </form>
        </div>

        {/* Evaluations active and queue */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-2 space-y-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Histórico de Compra de Usados</h3>
            <p className="text-xs text-slate-400">Veja avaliações pendentes de cadastro ou as já aprovadas e cadastradas em estoque.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left text-slate-500">
              <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Vendedor (CPF)</th>
                  <th className="px-3 py-2 text-right">Compra</th>
                  <th className="px-3 py-2 text-center">Status</th>
                  <th className="px-3 py-2 text-center">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTradeIns.map(trade => (
                  <tr key={trade.id} className="hover:bg-slate-50/50">
                    <td className="px-3 py-2.5">
                      <span className="font-bold text-slate-900 block">{trade.itemDescription}</span>
                      <span className="text-[10px] text-slate-400 font-medium block">
                        Estado: {trade.condition}
                        {currentUser.unitId === 'central' && ` | Loja: ${
                          trade.unitId === 'loja_1' ? 'CG' : trade.unitId === 'loja_2' ? 'Barra' : trade.unitId === 'loja_3' ? 'Jacarepaguá' : 'Geral'
                        }`}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-medium text-slate-700">
                      {trade.sellerName}
                      <span className="block font-mono text-[10px] text-slate-400">CPF: {trade.sellerCpf}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-slate-900 font-mono">
                      R$ {trade.valuationAmount.toLocaleString('pt-BR')}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        trade.status === 'APROVADO'
                          ? 'bg-emerald-100 text-emerald-800'
                          : trade.status === 'CANCELADO'
                            ? 'bg-rose-100 text-rose-800'
                            : 'bg-amber-100 text-amber-800'
                      }`}>
                        {trade.status === 'APROVADO' ? 'Estocado' : trade.status === 'CANCELADO' ? 'Cancelado' : 'Aguardando'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {trade.status === 'AVALIADO' && (
                        <div className="flex justify-center space-x-1.5">
                          <button
                            id={`btn-approve-trade-${trade.id}`}
                            onClick={() => handleOpenApproval(trade)}
                            className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold text-[10px] transition"
                          >
                            Estocar Usado
                          </button>
                          <button
                            id={`btn-cancel-trade-${trade.id}`}
                            onClick={() => cancelTradeIn(trade.id)}
                            className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded text-[10px] transition border border-slate-200"
                          >
                            Dispensar
                          </button>
                        </div>
                      )}
                      {trade.status === 'APROVADO' && (
                        <span className="text-[10px] text-emerald-600 font-semibold block">Cadastrado</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Used Item Approval and estocagem definition modal */}
      {tradeToApprove && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full max-h-[92vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
            <div className="bg-slate-900 text-white p-4 flex justify-between items-center">
              <h3 className="font-bold text-xs uppercase tracking-wider">Confirmar Estocagem de Usado</h3>
              <button
                id="btn-close-trade-modal"
                onClick={() => setTradeToApprove(null)}
                className="text-slate-400 hover:text-white font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleConfirmApproval} className="p-4 space-y-4 text-xs font-sans overflow-y-auto">
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block">Item Avaliado</span>
                <span className="font-bold text-slate-800 text-sm block">{tradeToApprove.itemDescription}</span>
                <span className="text-slate-500 block mt-0.5">Custo (valor pago): R$ {tradeToApprove.valuationAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
              </div>

              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">Nome do produto</label>
                <input type="text" required value={approveName} onChange={(e) => setApproveName(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-semibold" />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">Código</label>
                  <input type="text" placeholder="Automático" value={approveSku} onChange={(e) => setApproveSku(sanitizeItemCode(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                </div>
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">Preço de venda (R$)</label>
                  <ValueInput required value={approveSellPrice || null} onValueChange={(value) => setApproveSellPrice(value ?? 0)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">Nº de série</label>
                  <input type="text" required value={approveSerial} onChange={(e) => setApproveSerial(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                </div>
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">IMEI (opcional)</label>
                  <input type="text" inputMode="numeric" value={approveImei} onChange={(e) => setApproveImei(e.target.value.replace(/\D/g, '').slice(0, 15))} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                </div>
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">Garantia (meses)</label>
                  <ValueInput decimals={0} required value={approveWarranty} onValueChange={(value) => setApproveWarranty(value ?? 0)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                </div>
              </div>

              <div className="space-y-2 border-t border-slate-100 pt-3">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Dados fiscais (já preenchidos para videogame; altere se precisar)</span>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <label className="font-bold text-slate-700">NCM</label>
                    <input type="text" value={approveNcm} onChange={(e) => setApproveNcm(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="font-bold text-slate-700">CEST</label>
                    <input type="text" placeholder="Só com ST" value={approveCest} onChange={(e) => setApproveCest(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">Origem</label>
                  <select value={approveOrigin} onChange={(e) => setApproveOrigin(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none">
                    {ICMS_ORIGINS.map(origin => <option key={origin.code} value={origin.code}>{origin.label}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <label className="font-bold text-slate-700">CSOSN</label>
                    <select value={approveCsosn} onChange={(e) => setApproveCsosn(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none">
                      <option value="">—</option>
                      {CSOSNS.map(code => <option key={code} value={code}>{code}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="font-bold text-slate-700">CST</label>
                    <select value={approveCst} onChange={(e) => setApproveCst(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none">
                      <option value="">—</option>
                      {ICMS_CSTS.map(code => <option key={code} value={code}>{code}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1.5">
                    <label className="font-bold text-slate-700">ICMS %</label>
                    <ValueInput value={approveIcmsRate} onValueChange={setApproveIcmsRate} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="font-bold text-slate-700">Redução %</label>
                    <ValueInput value={approveIcmsReduction} onValueChange={setApproveIcmsReduction} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="font-bold text-slate-700">Total tributos %</label>
                    <ValueInput value={approveTaxBurden} onValueChange={setApproveTaxBurden} className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono" />
                  </div>
                </div>
                <p className="text-[10px] text-slate-400">CFOP 5.102 é aplicado automaticamente na NFC-e.</p>
              </div>

              {approveError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-[11px] font-medium">{approveError}</div>
              )}

              <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setTradeToApprove(null)}
                  className="px-3 py-1.5 border border-slate-200 text-slate-600 rounded hover:bg-slate-50 transition"
                >
                  Voltar
                </button>
                <button
                  type="submit"
                  disabled={approveSaving}
                  className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white font-bold rounded transition"
                >
                  {approveSaving ? 'Salvando...' : 'Efetivar Entrada'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
