/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { StoreConfig, User, WorkOrder, WorkOrderStatus } from '../types';
import { 
  FileText, 
  Plus, 
  Search, 
  CheckCircle, 
  AlertCircle, 
  Clock, 
  Wrench, 
  DollarSign, 
  Phone,
  Settings
} from 'lucide-react';

interface AssistênciaViewProps {
  currentUser: User;
  workOrders: WorkOrder[];
  storeConfigs: StoreConfig[];
  addWorkOrder: (wo: Omit<WorkOrder, 'id' | 'osNumber' | 'operatorId' | 'operatorName' | 'timestamp'>) => WorkOrder;
  updateWorkOrderStatus: (woId: string, status: WorkOrderStatus) => void;
}

export default function AssistênciaView({
  currentUser,
  workOrders,
  storeConfigs,
  addWorkOrder,
  updateWorkOrderStatus
}: AssistênciaViewProps) {
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  // Navigation: List or Create
  const [activeTab, setActiveTab] = useState<'lista' | 'nova'>('lista');

  // Search/Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('TODOS');

  // Form states
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [equipment, setEquipment] = useState('');
  const [problemDescription, setProblemDescription] = useState('');
  const [partsCost, setPartsCost] = useState<number>(0);
  const [laborCost, setLaborCost] = useState<number>(0);
  const [linkedSerial, setLinkedSerial] = useState('');
  const [workOrderStore, setWorkOrderStore] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!stores.length) return;
    setWorkOrderStore(previous => stores.some(store => store.unitId === previous) ? previous : stores[0].unitId);
  }, [storeConfigs]);

  // Submit Handler
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!workOrderStore || !clientName || !equipment || !problemDescription) {
      setFormError('Preencha os dados básicos do conserto ou montagem.');
      return;
    }

    const totalCost = partsCost + laborCost;

    addWorkOrder({
      clientName,
      clientPhone,
      equipment,
      problemDescription,
      status: 'EM_ANALISE',
      partsCost,
      laborCost,
      totalCost,
      linkedSerial: linkedSerial || undefined,
      unitId: workOrderStore
    });

    // Reset Form
    setClientName('');
    setClientPhone('');
    setEquipment('');
    setProblemDescription('');
    setPartsCost(0);
    setLaborCost(0);
    setLinkedSerial('');
    setSuccessMsg('Ordem de Serviço aberta com sucesso!');
    setActiveTab('lista');
  };

  // Filters
  const filteredOrders = workOrders.filter(wo => {
    const matchesSearch = wo.clientName.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          wo.osNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          wo.equipment.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'TODOS' || wo.status === statusFilter;
    
    // Non-admin operators can only see OS for their own store!
    const matchesStore = currentUser.role === 'ADMIN' || wo.unitId === currentUser.unitId;

    return matchesSearch && matchesStatus && matchesStore;
  });

  const getStatusBadge = (status: WorkOrderStatus) => {
    switch (status) {
      case 'AGUARDANDO_PECA':
        return <span className="bg-amber-100 text-amber-800 border border-amber-200 px-2.5 py-0.5 rounded-[4px] font-bold text-[10px] uppercase">Aguardando Peça</span>;
      case 'EM_ANALISE':
        return <span className="bg-blue-100 text-blue-800 border border-blue-200 px-2.5 py-0.5 rounded-[4px] font-bold text-[10px] uppercase">Em Análise</span>;
      case 'PRONTO':
        return <span className="bg-emerald-100 text-emerald-800 border border-emerald-200 px-2.5 py-0.5 rounded-[4px] font-bold text-[10px] uppercase">Pronto / Consertado</span>;
      case 'ENTREGUE':
        return <span className="bg-slate-100 text-slate-700 border border-slate-200 px-2.5 py-0.5 rounded-[4px] font-bold text-[10px] uppercase">Entregue ao Cliente</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Tab selectors */}
      <div className="flex justify-between items-center bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex-wrap gap-4">
        <div className="flex space-x-2">
          <button
            id="tab-assistencia-lista"
            onClick={() => setActiveTab('lista')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeTab === 'lista'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Wrench className="w-4 h-4 mr-1.5" />
            Ordens de Serviço Ativas
          </button>
          <button
            id="tab-assistencia-nova"
            onClick={() => setActiveTab('nova')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeTab === 'nova'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Nova OS / Montagem de PC
          </button>
        </div>
      </div>

      {/* 1. VIEW: Lista de OS */}
      {activeTab === 'lista' && (
        <div className="space-y-4 font-sans text-xs">
          {successMsg && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-lg flex items-center gap-2">
              <CheckCircle className="w-4 h-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Filters Bar */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col md:flex-row gap-4 justify-between">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="search-os"
                type="text"
                placeholder="Pesquisar por OS, cliente ou equipamento..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-50 text-slate-800 text-xs rounded-lg pl-9 pr-4 py-2.5 border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500 font-semibold"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {['TODOS', 'EM_ANALISE', 'AGUARDANDO_PECA', 'PRONTO', 'ENTREGUE'].map(st => (
                <button
                  key={st}
                  onClick={() => setStatusFilter(st)}
                  className={`px-2.5 py-1.5 text-xs rounded-lg font-semibold transition border ${
                    statusFilter === st
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {st === 'TODOS' ? 'Todos' : st === 'EM_ANALISE' ? 'Análise' : st === 'AGUARDANDO_PECA' ? 'Espera Peça' : st === 'PRONTO' ? 'Prontos' : 'Entregues'}
                </button>
              ))}
            </div>
          </div>

          {/* Cards Display */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {filteredOrders.map(wo => (
              <div key={wo.id} className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden flex flex-col justify-between">
                <div className="p-5 space-y-4">
                  {/* Title OS header */}
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="font-mono text-slate-400 block font-bold text-[10px]">
                        Nº {wo.osNumber}
                      </span>
                      <h3 className="font-bold text-slate-900 text-sm mt-0.5">{wo.equipment}</h3>
                      <p className="text-[10px] text-slate-400 font-medium">Aberto em: {new Date(wo.timestamp).toLocaleDateString('pt-BR')}</p>
                    </div>
                    {getStatusBadge(wo.status)}
                  </div>

                  {/* Problem Description */}
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-100/80 space-y-1">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Diagnóstico de Entrada</span>
                    <p className="text-slate-700 leading-relaxed">{wo.problemDescription}</p>
                  </div>

                  {/* Details and costs side-by-side */}
                  <div className="grid grid-cols-2 gap-4 border-t border-slate-50 pt-3">
                    <div>
                      <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block">Cliente / Contato</span>
                      <span className="font-semibold text-slate-800 block">{wo.clientName}</span>
                      <span className="text-slate-400 flex items-center mt-0.5 text-[10px]">
                        <Phone className="w-3 h-3 mr-1 text-slate-400 shrink-0" />
                        {wo.clientPhone}
                      </span>
                    </div>

                    <div className="text-right">
                      <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block">Orçamento (R$)</span>
                      <span className="font-mono text-slate-500 block">Peças: R$ {wo.partsCost}</span>
                      <span className="font-mono text-slate-500 block">Mão de Obra: R$ {wo.laborCost}</span>
                      <span className="font-mono font-bold text-slate-900 block mt-0.5 text-[13px]">
                        Total: R$ {wo.totalCost}
                      </span>
                    </div>
                  </div>

                  {/* Serial vinculated */}
                  {wo.linkedSerial && (
                    <div className="bg-amber-50 border border-amber-100 p-2 rounded text-[10px] font-mono text-amber-800">
                      🔒 Série vinculada para garantia: <strong className="font-bold">{wo.linkedSerial}</strong>
                    </div>
                  )}
                </div>

                {/* Bottom interactive action triggers */}
                <div className="bg-slate-50 px-5 py-3 border-t border-slate-100 flex justify-between items-center">
                  <span className="text-[10px] text-slate-400">Responsável: {wo.operatorName.split(' ')[0]}</span>
                  
                  {wo.status !== 'ENTREGUE' && (
                    <div className="flex items-center space-x-1.5">
                      <select
                        id={`select-status-${wo.id}`}
                        value={wo.status}
                        onChange={(e) => {
                          updateWorkOrderStatus(wo.id, e.target.value as WorkOrderStatus);
                          setSuccessMsg('Status da Ordem de Serviço atualizado.');
                        }}
                        className="bg-white border border-slate-200 text-slate-700 font-bold rounded px-2.5 py-1 text-[10px] outline-none"
                      >
                        <option value="EM_ANALISE">Em Análise</option>
                        <option value="AGUARDANDO_PECA">Aguardando Peça</option>
                        <option value="PRONTO">Pronto / Retirar</option>
                        <option value="ENTREGUE">Entregue</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {filteredOrders.length === 0 && (
              <div className="col-span-2 text-center text-slate-400 py-16 bg-white border border-slate-200 rounded-xl shadow-sm">
                Nenhuma ordem de serviço ativa nesta loja com os filtros selecionados.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. VIEW: Nova OS */}
      {activeTab === 'nova' && (
        <div className="max-w-xl mx-auto bg-white p-6 rounded-xl border border-slate-200 shadow-sm font-sans space-y-6">
          <div>
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Abertura de Ordem de Serviço / Conserto</h3>
            <p className="text-xs text-slate-400">Gere cupons de conserto, upgrades, montagens e cable management.</p>
          </div>

          {formError && (
            <div className="bg-rose-50 border border-rose-200 text-rose-800 p-3 rounded-lg flex items-center gap-2 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="font-bold text-slate-700">Nome do Cliente</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Luiza Albuquerque"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="font-bold text-slate-700">Telefone / WhatsApp</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: (11) 99999-8888"
                  value={clientPhone}
                  onChange={(e) => setClientPhone(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-700">Loja responsável</label>
              <select
                value={workOrderStore}
                onChange={(event) => setWorkOrderStore(event.target.value)}
                required
                disabled={stores.length === 0}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none disabled:text-slate-400"
              >
                {stores.length === 0 && <option value="">Nenhuma loja cadastrada</option>}
                {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-700">Equipamento / Modelo</label>
              <input
                type="text"
                required
                placeholder="Ex: Console PS5 Slim 1TB ou Desktop Gamer Ryzen 7"
                value={equipment}
                onChange={(e) => setEquipment(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-700">Descrição do Defeito ou Serviço Solicitado</label>
              <textarea
                required
                rows={3}
                placeholder="Ex: Desligamento súbito por superaquecimento. Necessário desoxidação e troca do metal líquido."
                value={problemDescription}
                onChange={(e) => setProblemDescription(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none font-sans leading-relaxed"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="font-bold text-slate-700">Orçamento Prévio de Peças (R$)</label>
                <input
                  type="number"
                  min="0"
                  value={partsCost || ''}
                  onChange={(e) => setPartsCost(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="font-bold text-slate-700">Custo da Mão de Obra (R$)</label>
                <input
                  type="number"
                  min="0"
                  value={laborCost || ''}
                  onChange={(e) => setLaborCost(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="font-bold text-slate-700 flex justify-between">
                <span>Vínculo de Série de Garantia (Opcional)</span>
                <span className="text-[10px] text-slate-400">Verificação automática na consulta</span>
              </label>
              <input
                type="text"
                placeholder="Ex: S/N do SSD instalado ou past-sale-serial..."
                value={linkedSerial}
                onChange={(e) => setLinkedSerial(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition font-bold"
            >
              Confirmar Abertura de OS (Em Análise)
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
