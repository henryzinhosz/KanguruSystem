/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { 
  User, 
  UserRole, 
  Product, 
  StockInventory, 
  TradeIn,
  TradeInStockLine,
  TradeInStockResult,
  StoreConfig
} from '../types';
import { Coins, Gamepad2, Smartphone } from 'lucide-react';
import IphoneTablePanel from './IphoneTablePanel';
import TradeInStockModal from './TradeInStockModal';

// Conferir e Estocar com varios itens (migration 20261206): ver TradeInStockModal.
const isPhoneTrade = (trade: TradeIn) => trade.deviceType === 'IPHONE';

interface VendasViewProps {
  currentUser: User;
  products: Product[];
  inventory: StockInventory[];
  tradeIns: TradeIn[];
  storeConfigs: StoreConfig[];
  stockTradeIn: (tradeId: string, lines: TradeInStockLine[]) => Promise<TradeInStockResult[]>;
  cancelTradeIn: (tradeId: string) => Promise<void>;
}

export default function VendasView({
  currentUser,
  products,
  inventory,
  tradeIns,
  storeConfigs,
  stockTradeIn,
  cancelTradeIn
}: VendasViewProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');

  // Filter state for Store (Consolidated or specific store)
  const [selectedStoreFilter, setSelectedStoreFilter] = useState<string>('consolidado');

  const [tradeToStock, setTradeToStock] = useState<TradeIn | null>(null);
  const [listError, setListError] = useState('');
  const [phoneTableOpen, setPhoneTableOpen] = useState(false);
  // Trocas Gerais: abas Troca Gamer (videogames) e Troca Phone (iPhones), como os botoes do PDV.
  const [tab, setTab] = useState<'gamer' | 'phone'>('gamer');

  const activeUnitId = currentUser.unitId === 'central' ? selectedStoreFilter : currentUser.unitId;

  const storeTradeIns = tradeIns.filter(t =>
    activeUnitId === 'consolidado' || t.unitId === activeUnitId
  );
  const filteredTradeIns = storeTradeIns.filter(t => (tab === 'phone') === isPhoneTrade(t));
  const pendingCount = (phone: boolean) =>
    storeTradeIns.filter(t => t.status === 'AVALIADO' && isPhoneTrade(t) === phone).length;
  const tabs = [
    { id: 'gamer' as const, label: 'Troca Gamer', icon: Gamepad2, pending: pendingCount(false) },
    { id: 'phone' as const, label: 'Troca Phone', icon: Smartphone, pending: pendingCount(true) }
  ];

  return (
    <div className="space-y-6">

      {/* Title block */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs">
        <div className="p-5 pb-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-black text-slate-800 uppercase tracking-wider flex items-center">
            <Coins className="w-5 h-5 text-blue-600 mr-2" />
            Trocas Gerais
          </h2>
          <p className="text-xs text-slate-400">
            {tab === 'phone' ? 'Compra de iPhones usados.' : 'Compra de videogames usados.'} Os vendedores registram a troca no PDV (com o termo impresso). Aqui você confere os dados e estoca o aparelho.
          </p>
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
        <div className="flex gap-1 border-t border-slate-100 px-5">
          {tabs.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold border-b-2 -mb-px ${tab === item.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
              >
                <Icon className="w-4 h-4" />{item.label}
                {item.pending > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold" title="Aguardando conferir e estocar">{item.pending}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Grid */}
      <div className="font-sans">
        {/* Evaluations active and queue */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{tab === 'phone' ? 'Trocas de iPhone registradas' : 'Trocas de videogame registradas'}</h3>
              {tab === 'phone' && isAdmin && (
                <button
                  type="button"
                  onClick={() => setPhoneTableOpen(true)}
                  className="inline-flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg px-3 py-1.5 transition"
                >
                  <Smartphone className="w-3.5 h-3.5" />Tabela de iPhone
                </button>
              )}
            </div>
            <p className="text-xs text-slate-400">"Aguardando" = já paga ao cliente no PDV, falta conferir e estocar.</p>
          </div>
          {listError && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-[11px] font-medium">{listError}</div>}

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
                      <span className="font-bold text-slate-900 block">
                        {trade.tradeNumber ? `Nº ${trade.tradeNumber} · ` : ''}{trade.itemDescription}
                      </span>
                      {trade.serialNumber && (
                        <span className="text-[10px] text-slate-500 font-mono block">S/N: {trade.serialNumber}{trade.imei ? ` · IMEI: ${trade.imei}` : ''}</span>
                      )}
                      {trade.accessories && <span className="text-[10px] text-slate-500 block">Itens: {trade.accessories}</span>}
                      {trade.evaluation && (
                        <span className="text-[10px] text-slate-500 block">
                          iPhone · estado {trade.evaluation.grade} · bateria {trade.evaluation.battery}% · tabela R$ {trade.evaluation.tableValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                          {trade.evaluation.aboveTable && <span className="ml-1 font-bold text-amber-700">(acima da tabela, com senha Gerente)</span>}
                        </span>
                      )}
                      <span className="text-[10px] text-slate-400 font-medium block">
                        {new Date(trade.timestamp).toLocaleString('pt-BR')} · Estado: {trade.condition}
                        {trade.staffName && ` · Vendedor: ${trade.staffCode ? `${trade.staffCode} - ` : ''}${trade.staffName}`}
                        {currentUser.unitId === 'central' && ` | Loja: ${
                          trade.unitId === 'loja_1' ? 'CG' : trade.unitId === 'loja_2' ? 'Barra' : trade.unitId === 'loja_3' ? 'Jacarepaguá' : 'Geral'
                        }`}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-medium text-slate-700">
                      {trade.sellerName}
                      <span className="block font-mono text-[10px] text-slate-400">CPF: {trade.sellerCpf}</span>
                      {trade.sellerPhone && <span className="block text-[10px] text-slate-400">Tel.: {trade.sellerPhone}</span>}
                      {trade.sellerDocument && <span className="block text-[10px] text-slate-400">RG/CNH: {trade.sellerDocument}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-slate-900 font-mono">
                      R$ {trade.valuationAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      {trade.paymentMethod && (
                        <span className="block text-[10px] font-semibold text-slate-400">
                          {trade.paymentMethod === 'VALE' ? 'Vale-troca' : trade.paymentMethod === 'DINHEIRO' ? 'Dinheiro' : 'Pix'}
                        </span>
                      )}
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
                            onClick={() => setTradeToStock(trade)}
                            className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold text-[10px] transition"
                          >
                            Conferir e Estocar
                          </button>
                          <button
                            id={`btn-cancel-trade-${trade.id}`}
                            onClick={() => {
                              const paid = trade.paymentMethod ? ' O valor já foi pago ao cliente no PDV; dispensar só tira a troca da lista e NÃO devolve o dinheiro nem cancela o vale.' : '';
                              if (!window.confirm(`Dispensar esta troca?${paid}`)) return;
                              setListError('');
                              cancelTradeIn(trade.id).catch(error => setListError(`Não foi possível dispensar a troca: ${error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco'}`));
                            }}
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
                {filteredTradeIns.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-slate-400">
                      {tab === 'phone' ? 'Nenhuma troca de iPhone registrada ainda.' : 'Nenhuma troca de videogame registrada ainda.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {phoneTableOpen && <IphoneTablePanel onClose={() => setPhoneTableOpen(false)} />}

      {tradeToStock && (
        <TradeInStockModal
          trade={tradeToStock}
          products={products}
          inventory={inventory}
          storeConfigs={storeConfigs}
          onStock={lines => stockTradeIn(tradeToStock.id, lines)}
          onClose={() => setTradeToStock(null)}
        />
      )}
    </div>
  );
}
