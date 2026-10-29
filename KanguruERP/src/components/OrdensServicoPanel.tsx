import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { StoreConfig, WorkOrder, WorkOrderStatus } from '../types';

// Ordens de servico abertas no PDV: o ERP acompanha e muda a situacao.
// Abrir, cobrar e entregar ficam so no PDV (comprovantes impressos la).

interface OrdensServicoPanelProps {
  workOrders: WorkOrder[];
  storeConfigs: StoreConfig[];
  updateWorkOrderStatus: (id: string, status: WorkOrderStatus) => Promise<void>;
}

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  EM_ANALISE: 'Em análise',
  AGUARDANDO_PECA: 'Aguardando peça',
  PRONTO: 'Pronto',
  ENTREGUE: 'Entregue',
  DEVOLVIDO: 'Devolvido sem conserto'
};

const STATUS_STYLES: Record<WorkOrderStatus, string> = {
  EM_ANALISE: 'bg-blue-50 text-blue-700 border-blue-200',
  AGUARDANDO_PECA: 'bg-amber-50 text-amber-800 border-amber-200',
  PRONTO: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ENTREGUE: 'bg-slate-100 text-slate-600 border-slate-200',
  DEVOLVIDO: 'bg-slate-100 text-slate-600 border-slate-200'
};

const OPEN_STATUSES: WorkOrderStatus[] = ['EM_ANALISE', 'AGUARDANDO_PECA', 'PRONTO'];

const isClosed = (order: WorkOrder) => order.status === 'ENTREGUE' || order.status === 'DEVOLVIDO';

// Data sem hora (aaaa-mm-dd) sem mudar de dia pelo fuso.
const dateOnly = (value?: string) => (value ? value.slice(0, 10).split('-').reverse().join('/') : '—');

export default function OrdensServicoPanel({ workOrders, storeConfigs, updateWorkOrderStatus }: OrdensServicoPanelProps) {
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const [storeFilter, setStoreFilter] = useState('TODAS');
  const [statusFilter, setStatusFilter] = useState<'ATIVAS' | 'ENTREGUES' | 'TODAS'>('ATIVAS');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const storeName = (unitId: string) => {
    const store = stores.find(item => item.unitId === unitId);
    return store?.tradeName || store?.legalName || unitId;
  };

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    const digits = query.replace(/\D/g, '');
    return workOrders.filter(order => {
      if (storeFilter !== 'TODAS' && order.unitId !== storeFilter) return false;
      if (statusFilter === 'ATIVAS' && isClosed(order)) return false;
      if (statusFilter === 'ENTREGUES' && !isClosed(order)) return false;
      if (!text) return true;
      return String(order.orderNumber ?? order.osNumber).toLowerCase() === text
        || order.clientName.toLowerCase().includes(text)
        || order.equipment.toLowerCase().includes(text)
        || (order.linkedSerial || '').toLowerCase().includes(text)
        || (digits.length >= 6 && (order.clientCpf || '').includes(digits));
    });
  }, [workOrders, storeFilter, statusFilter, query]);

  const activeCount = workOrders.filter(order => !isClosed(order) && (storeFilter === 'TODAS' || order.unitId === storeFilter)).length;

  async function changeStatus(order: WorkOrder, status: WorkOrderStatus) {
    setError('');
    setSavingId(order.id);
    try {
      await updateWorkOrderStatus(order.id, status);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Não foi possível mudar a situação da OS.');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <p className="text-xs text-slate-500 mr-auto">
          {activeCount} ordem(ns) de serviço ativa(s). A OS é aberta, cobrada e entregue no PDV; aqui você acompanha e muda a situação.
        </p>
        {stores.length > 1 && (
          <label className="text-[10px] font-bold uppercase text-slate-500">Loja
            <select value={storeFilter} onChange={event => setStoreFilter(event.target.value)} className="mt-1 block bg-white border border-slate-200 rounded-lg p-2 text-xs font-medium normal-case">
              <option value="TODAS">Todas as lojas</option>
              {stores.map(store => <option key={store.unitId} value={store.unitId}>{storeName(store.unitId)}</option>)}
            </select>
          </label>
        )}
        <label className="text-[10px] font-bold uppercase text-slate-500">Mostrar
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)} className="mt-1 block bg-white border border-slate-200 rounded-lg p-2 text-xs font-medium normal-case">
            <option value="ATIVAS">Ativas</option>
            <option value="ENTREGUES">Entregues</option>
            <option value="TODAS">Todas</option>
          </select>
        </label>
        <label className="text-[10px] font-bold uppercase text-slate-500">Buscar
          <span className="mt-1 flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2">
            <Search className="w-4 h-4 text-slate-400" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Nº, cliente, CPF, aparelho, serial" className="py-2 text-xs font-medium normal-case outline-none w-56" />
          </span>
        </label>
      </div>

      {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
              <tr>
                <th className="p-3 w-6"></th>
                <th className="p-3">Nº</th>
                <th className="p-3">Abertura</th>
                {stores.length > 1 && <th className="p-3">Loja</th>}
                <th className="p-3">Cliente</th>
                <th className="p-3">Aparelho</th>
                <th className="p-3">Serviços</th>
                <th className="p-3 text-right">Total</th>
                <th className="p-3">Pagamento</th>
                <th className="p-3">Previsão</th>
                <th className="p-3">Situação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(order => {
                const open = expanded === order.id;
                const services = order.items?.length ? order.items.map(item => item.name).join(', ') : order.problemDescription;
                return (
                  <Fragment key={order.id}>
                    <tr className="hover:bg-slate-50 cursor-pointer" onClick={() => setExpanded(open ? null : order.id)}>
                      <td className="p-3 text-slate-400">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                      <td className="p-3 font-mono font-bold text-slate-900">{order.orderNumber ?? order.osNumber}</td>
                      <td className="p-3 text-slate-600 whitespace-nowrap">{new Date(order.timestamp).toLocaleDateString('pt-BR')}</td>
                      {stores.length > 1 && <td className="p-3 text-slate-600">{storeName(order.unitId)}</td>}
                      <td className="p-3"><span className="block font-bold text-slate-900">{order.clientName}</span><span className="text-slate-500">{order.clientPhone}</span></td>
                      <td className="p-3"><span className="block text-slate-800">{[order.equipmentType, order.equipment].filter(Boolean).join(' · ')}</span>{order.linkedSerial && <span className="text-slate-500 font-mono">S/N {order.linkedSerial}</span>}</td>
                      <td className="p-3 text-slate-600 max-w-[220px]">{services}</td>
                      <td className="p-3 text-right font-mono font-bold">{currency.format(order.totalCost)}</td>
                      <td className="p-3">
                        {order.status === 'DEVOLVIDO'
                          ? <span className="text-slate-500">Não cobrada</span>
                          : order.saleId
                            ? <span className="px-2 py-1 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700">PAGA</span>
                            : order.totalCost > 0
                              ? <span className="px-2 py-1 rounded text-[10px] font-bold bg-amber-50 text-amber-800">A PAGAR</span>
                              : <span className="text-slate-500">Sem custo</span>}
                      </td>
                      <td className="p-3 text-slate-600 whitespace-nowrap">{dateOnly(order.expectedDate)}</td>
                      <td className="p-3" onClick={event => event.stopPropagation()}>
                        {isClosed(order) ? (
                          <span className={`px-2 py-1 rounded border text-[10px] font-bold ${STATUS_STYLES[order.status]}`}>{STATUS_LABELS[order.status]}</span>
                        ) : (
                          <select
                            value={order.status}
                            disabled={savingId === order.id}
                            onChange={event => void changeStatus(order, event.target.value as WorkOrderStatus)}
                            className={`px-2 py-1 rounded border text-[11px] font-bold outline-none ${STATUS_STYLES[order.status]}`}
                          >
                            {OPEN_STATUSES.map(status => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td></td>
                        <td colSpan={stores.length > 1 ? 10 : 9} className="p-3">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                            <div><span className="block text-[10px] font-bold uppercase text-slate-400">Acessórios deixados</span>{order.accessories || 'Nenhum'}</div>
                            <div><span className="block text-[10px] font-bold uppercase text-slate-400">Estado na entrada</span>{order.entryCondition || '—'}</div>
                            <div><span className="block text-[10px] font-bold uppercase text-slate-400">Observação</span>{order.notes || '—'}</div>
                            <div><span className="block text-[10px] font-bold uppercase text-slate-400">Aberta por</span>{order.staffCode ? `${order.staffCode} - ${order.staffName}` : order.operatorName}</div>
                            <div>
                              <span className="block text-[10px] font-bold uppercase text-slate-400">Serviços</span>
                              {order.items?.length
                                ? order.items.map((item, index) => <span key={`${item.serviceId}-${index}`} className="block">{item.sku} · {item.name} · {currency.format(item.price)}</span>)
                                : order.problemDescription}
                            </div>
                            <div>
                              <span className="block text-[10px] font-bold uppercase text-slate-400">Entrega</span>
                              {order.deliveredAt
                                ? `${new Date(order.deliveredAt).toLocaleString('pt-BR')}${order.deliveredByName ? ` por ${order.deliveredByName}` : ''}${order.warrantyUntil ? ` · garantia até ${dateOnly(order.warrantyUntil)}` : ''}`
                                : 'Ainda com a loja'}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={11} className="p-8 text-center text-slate-400">Nenhuma ordem de serviço {statusFilter === 'ATIVAS' ? 'ativa' : 'encontrada'}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
