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
  StoreConfig
} from '../types';
import { 
  Plus, 
  CheckCircle, 
  Coins,
  ArrowRight
} from 'lucide-react';

interface VendasViewProps {
  currentUser: User;
  products: Product[];
  inventory: StockInventory[];
  tradeIns: TradeIn[];
  storeConfigs: StoreConfig[];
  registerTradeIn: (trade: Omit<TradeIn, 'id' | 'operatorId' | 'operatorName' | 'timestamp' | 'status'>) => TradeIn;
  approveTradeIn: (
    tradeId: string,
    productDetails: { sku: string; name: string; category: string; brand: string; sellPrice: number; warrantyMonths: number; isSerialized: boolean }
  ) => void;
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
  const [tradeCategory, setTradeCategory] = useState('Videogames');
  const [tradeCondition, setTradeCondition] = useState('Excelente');
  const [tradeValuation, setTradeValuation] = useState<number>(0);
  const [tradeSuccess, setTradeSuccess] = useState(false);
  const [tradeError, setTradeError] = useState('');

  // Trade-In approval modal states
  const [tradeToApprove, setTradeToApprove] = useState<TradeIn | null>(null);
  const [approveSku, setApproveSku] = useState('');
  const [approveSellPrice, setApproveSellPrice] = useState(0);
  const [approveWarranty, setApproveWarranty] = useState(3);
  const [approveSerialized, setApproveSerialized] = useState(true);

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
    setApproveSku(`USED-${trade.category.slice(0, 3).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`);
    setApproveSellPrice(trade.valuationAmount * 1.5); // auto mark up suggested
  };

  // Finish Trade-In confirmation and register into catalog
  const handleConfirmApproval = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tradeToApprove) return;

    approveTradeIn(tradeToApprove.id, {
      sku: approveSku,
      name: tradeToApprove.itemDescription,
      category: tradeToApprove.category,
      brand: 'Trade-In Usado',
      sellPrice: approveSellPrice,
      warrantyMonths: approveWarranty,
      isSerialized: approveSerialized
    });

    setTradeToApprove(null);
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
            Trade-In (Compra de Usados)
          </h2>
          <p className="text-xs text-slate-400">Avaliação física de mercadorias usadas trazidas por clientes e reintegração automática ao estoque.</p>
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
              <label className="font-bold text-slate-700">Descrição do Equipamento / Jogo / Card</label>
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

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">Categoria Geral</label>
                <select
                  value={tradeCategory}
                  onChange={(e) => setTradeCategory(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                >
                  <option value="Videogames">Videogames / Consoles</option>
                  <option value="Acessórios">Acessórios / Controles</option>
                  <option value="Jogos">Mídia Física (Jogos)</option>
                  <option value="Cards">Cards / Colecionáveis</option>
                  <option value="Smartphones">Smartphones</option>
                </select>
              </div>

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
              <input
                type="number"
                min="0"
                required
                value={tradeValuation || ''}
                onChange={(e) => setTradeValuation(parseFloat(e.target.value) || 0)}
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
                        Categoria: {trade.category} | Estado: {trade.condition}
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
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-sm w-full overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
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

            <form onSubmit={handleConfirmApproval} className="p-4 space-y-4 text-xs font-sans">
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block">Item Avaliado</span>
                <span className="font-bold text-slate-800 text-sm block">{tradeToApprove.itemDescription}</span>
                <span className="text-slate-500 block mt-0.5">Custo: R$ {tradeToApprove.valuationAmount}</span>
              </div>

              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">SKU Sugerido (Gerado)</label>
                <input
                  type="text"
                  required
                  value={approveSku}
                  onChange={(e) => setApproveSku(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-bold text-slate-700">Defina Preço de Venda (R$)</label>
                <input
                  type="number"
                  min="0"
                  required
                  value={approveSellPrice || ''}
                  onChange={(e) => setApproveSellPrice(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">Garantia (Meses)</label>
                  <input
                    type="number"
                    min="0"
                    required
                    value={approveWarranty}
                    onChange={(e) => setApproveWarranty(parseInt(e.target.value) || 3)}
                    className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="font-bold text-slate-700">Serializar item?</label>
                  <select
                    value={approveSerialized ? 'true' : 'false'}
                    onChange={(e) => setApproveSerialized(e.target.value === 'true')}
                    className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none"
                  >
                    <option value="true">Sim (Gerar S/N)</option>
                    <option value="false">Não (Lote comum)</option>
                  </select>
                </div>
              </div>

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
                  className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded transition"
                >
                  Efetivar Entrada
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
