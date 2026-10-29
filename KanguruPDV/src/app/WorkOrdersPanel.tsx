import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Search, Trash2, UserRound } from 'lucide-react';
import type { PosCustomer } from '../services/supabase/customers';
import { searchPosItems, type PosCatalogItem } from '../services/supabase/products';
import type { PosSeller } from '../services/supabase/sellers';
import type { PosStoreProfile } from '../services/supabase/terminal';
import {
  WORK_ORDER_STATUS_LABELS,
  createWorkOrder,
  deliverWorkOrder,
  getWorkOrder,
  listWorkOrders,
  updateWorkOrder,
  type WorkOrderItem,
  type WorkOrderRecord,
  type WorkOrderStatus,
} from '../services/supabase/workOrders';
import { CustomerFormModal, CustomerPickerModal } from './CustomerModals';
import { formatCpf } from './reservationVoucher';
import { formatDateOnly, printWorkOrder } from './workOrderPrint';

// Ordem de Servico: abrir (comprovante de entrada), acompanhar o status, cobrar
// (venda normal com os servicos da OS) e entregar (comprovante de entrega).

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const EQUIPMENT_TYPES = ['Console', 'Controle', 'Notebook', 'Computador', 'Celular', 'Tablet', 'Outro'];
const OPEN_STATUSES: WorkOrderStatus[] = ['EM_ANALISE', 'AGUARDANDO_PECA', 'PRONTO'];

export interface WorkOrderCharge {
  order: WorkOrderRecord;
  deliver: boolean;
}

interface WorkOrdersPanelProps {
  seller: PosSeller | null;
  sellerSlot: ReactNode;
  initialOrderId: string | null;
  loadStore: () => Promise<PosStoreProfile | null>;
  // Vai para a venda com os servicos da OS no carrinho; devolve o erro, se houver.
  onCharge: (charge: WorkOrderCharge) => Promise<string | null>;
}

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; orderId: string };

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function statusTone(status: WorkOrderStatus) {
  if (status === 'PRONTO') return 'is-ready';
  if (status === 'AGUARDANDO_PECA') return 'is-waiting';
  if (status === 'ENTREGUE' || status === 'DEVOLVIDO') return 'is-closed';
  return '';
}

function isPaid(order: WorkOrderRecord) {
  return Boolean(order.saleId) || order.total <= 0;
}

// Busca de servicos do cadastro do ERP (so servicos ativos).
function ServicePicker({ selected, onChange, disabled }: { selected: WorkOrderItem[]; onChange: (items: WorkOrderItem[]) => void; disabled?: boolean }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PosCatalogItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function search(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    if (!query.trim()) {
      setError('Digite parte do nome ou o código do serviço.');
      return;
    }
    try {
      const found = (await searchPosItems(query.trim())).filter((item) => item.itemType === 'SERVICE');
      setResults(found);
      if (found.length === 0) setError('Nenhum serviço encontrado. Os serviços são cadastrados no ERP (Serviços / OS).');
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Não foi possível buscar os serviços.');
    }
  }

  function add(item: PosCatalogItem) {
    onChange([...selected, { serviceId: item.id, sku: item.sku, name: item.name, price: item.sellPrice }]);
    setResults([]);
    setQuery('');
  }

  const total = selected.reduce((sum, item) => sum + item.price, 0);

  return (
    <div className="wo-services">
      {selected.length > 0 && (
        <ul className="wo-service-list">
          {selected.map((item, index) => (
            <li key={`${item.serviceId}-${index}`}>
              <span><strong>{item.name}</strong><small>{item.sku}</small></span>
              <span className="wo-price">{currency.format(item.price)}</span>
              {!disabled && (
                <button type="button" className="icon-button" title="Remover serviço" onClick={() => onChange(selected.filter((_, position) => position !== index))}>
                  <Trash2 size={16} />
                </button>
              )}
            </li>
          ))}
          <li className="wo-service-total"><span>Total</span><strong>{currency.format(total)}</strong></li>
        </ul>
      )}
      {!disabled && (
        <>
          <div className="wo-service-search">
            <input
              placeholder="Buscar serviço por nome ou código (Enter)"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void search(event); }}
            />
            <button className="icon-button search-button" type="button" title="Buscar serviços" onClick={() => void search()}>
              <Search size={18} />
            </button>
          </div>
          {results.length > 0 && (
            <div className="wo-service-results">
              {results.map((item) => (
                <button key={item.id} type="button" onClick={() => add(item)}>
                  <span><strong>{item.name}</strong><small>{item.sku}</small></span>
                  <span>{currency.format(item.sellPrice)} <Plus size={15} /></span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function NewWorkOrder({ seller, sellerSlot, loadStore, onCharge, onCreated, onCancel }: {
  seller: PosSeller | null;
  sellerSlot: ReactNode;
  loadStore: () => Promise<PosStoreProfile | null>;
  onCharge: WorkOrdersPanelProps['onCharge'];
  onCreated: (order: WorkOrderRecord, message: string) => void;
  onCancel: () => void;
}) {
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [picker, setPicker] = useState(false);
  const [customerForm, setCustomerForm] = useState<{ customer: PosCustomer | null; cpf: string } | null>(null);
  const [equipmentType, setEquipmentType] = useState('Console');
  const [equipment, setEquipment] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [accessories, setAccessories] = useState('');
  const [entryCondition, setEntryCondition] = useState('');
  const [devicePassword, setDevicePassword] = useState('');
  const [services, setServices] = useState<WorkOrderItem[]>([]);
  const [notes, setNotes] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [payNow, setPayNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = Boolean(customer && equipment.trim() && entryCondition.trim() && services.length > 0 && seller);
  const total = services.reduce((sum, item) => sum + item.price, 0);

  async function submit() {
    if (!customer || !seller) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createWorkOrder({
        customerCpf: customer.cpf,
        equipmentType,
        equipment: equipment.trim(),
        serialNumber: serialNumber.trim(),
        accessories: accessories.trim(),
        entryCondition: entryCondition.trim(),
        devicePassword: devicePassword.trim(),
        serviceIds: services.map((item) => item.serviceId),
        notes: notes.trim(),
        expectedDate: expectedDate || null,
        sellerCode: seller.code,
      });
      if (result.status === 'CUSTOMER_REQUIRED') {
        setError('Cliente não encontrado no cadastro. Selecione ou cadastre o cliente.');
        return;
      }
      if (result.status === 'INVALID_SELLER') {
        setError('Código do vendedor não encontrado nesta loja.');
        return;
      }
      if (result.status !== 'OK') return;
      const { order } = result;
      // Pagar agora: o comprovante de entrada sai depois da venda, ja como "pago".
      if (payNow && order.total > 0) {
        const chargeError = await onCharge({ order, deliver: false });
        if (chargeError) onCreated(order, `OS nº ${order.orderNumber} aberta, mas a cobrança não abriu: ${chargeError}`);
        return;
      }
      void loadStore().then((store) => printWorkOrder(order, store, 'entry'));
      onCreated(order, `OS nº ${order.orderNumber} aberta. O comprovante foi enviado para a impressora: colha a assinatura do cliente na via da loja.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Não foi possível abrir a OS.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="reservations-panel trade-in-panel">
      <h1>Nova ordem de serviço</h1>
      <p className="modal-copy">O cliente deixa o aparelho. Ao confirmar, o comprovante de entrada sai impresso em duas vias.</p>

      <h2 className="trade-in-section">Cliente</h2>
      {customer ? (
        <div className="trade-in-customer">
          <UserRound size={20} />
          <span>
            <strong>{customer.name}</strong>
            <small>CPF {formatCpf(customer.cpf)} · {customer.phone}{customer.city ? ` · ${customer.city}/${customer.state ?? ''}` : ''}</small>
          </span>
          <button className="text-action" type="button" onClick={() => setCustomerForm({ customer, cpf: customer.cpf })} disabled={busy}>Editar</button>
          <button className="text-action" type="button" onClick={() => setCustomer(null)} disabled={busy}>Trocar</button>
        </div>
      ) : (
        <button className="customer-pick" type="button" onClick={() => setPicker(true)} disabled={busy}>
          <UserRound size={18} /> Selecionar ou cadastrar o cliente
        </button>
      )}

      <h2 className="trade-in-section">Aparelho</h2>
      <div className="trade-in-grid">
        <label>
          Tipo
          <select value={equipmentType} onChange={(event) => setEquipmentType(event.target.value)}>
            {EQUIPMENT_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Marca e modelo
          <input maxLength={120} placeholder="Ex.: PS5 Slim Digital" value={equipment} onChange={(event) => setEquipment(event.target.value)} />
        </label>
        <label>
          Nº de série (opcional)
          <input maxLength={60} value={serialNumber} onChange={(event) => setSerialNumber(event.target.value.toUpperCase())} />
        </label>
        <label>
          Senha / desbloqueio (opcional)
          <input maxLength={60} autoComplete="off" value={devicePassword} onChange={(event) => setDevicePassword(event.target.value)} />
          <small>Sai só na via da loja.</small>
        </label>
      </div>
      <label>
        Acessórios deixados
        <input maxLength={200} placeholder="Ex.: 1 controle, cabo HDMI, fonte (vazio = nenhum)" value={accessories} onChange={(event) => setAccessories(event.target.value)} />
      </label>
      <label>
        Estado na entrada
        <textarea rows={2} maxLength={400} placeholder="Ex.: não liga; riscos na tampa; falta parafuso" value={entryCondition} onChange={(event) => setEntryCondition(event.target.value)} />
      </label>

      <h2 className="trade-in-section">Serviços</h2>
      <ServicePicker selected={services} onChange={setServices} />
      <label>
        Observação (opcional)
        <input maxLength={300} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      <h2 className="trade-in-section">Prazo e pagamento</h2>
      <div className="trade-in-grid">
        <label>
          Previsão de entrega (opcional)
          <input type="date" min={today()} value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} />
        </label>
        <label>
          Pagamento
          <select value={payNow ? 'agora' : 'retirada'} onChange={(event) => setPayNow(event.target.value === 'agora')}>
            <option value="retirada">Na retirada do aparelho</option>
            <option value="agora">Agora (valor total)</option>
          </select>
        </label>
      </div>
      {sellerSlot}

      {error && <p className="field-error">{error}</p>}
      <div className="modal-actions">
        <button className="text-action" type="button" onClick={onCancel} disabled={busy}>Voltar à lista</button>
        <button className="primary-action modal-confirm" type="button" onClick={() => void submit()} disabled={busy || !ready}>
          {busy ? 'Abrindo...' : payNow && total > 0 ? `Abrir OS e cobrar ${currency.format(total)}` : 'Abrir OS e imprimir comprovante'}
        </button>
      </div>

      {picker && (
        <CustomerPickerModal
          onSelect={(selected) => { setCustomer(selected); setPicker(false); }}
          onNew={(cpf) => { setPicker(false); setCustomerForm({ customer: null, cpf: cpf.replace(/\D/g, '') }); }}
          onClose={() => setPicker(false)}
        />
      )}
      {customerForm && (
        <CustomerFormModal
          customer={customerForm.customer}
          initialCpf={customerForm.cpf}
          onSaved={(saved) => { setCustomer(saved); setCustomerForm(null); }}
          onClose={() => setCustomerForm(null)}
        />
      )}
    </section>
  );
}

function WorkOrderDetail({ orderId, seller, sellerSlot, loadStore, onCharge, onBack }: {
  orderId: string;
  seller: PosSeller | null;
  sellerSlot: ReactNode;
  loadStore: () => Promise<PosStoreProfile | null>;
  onCharge: WorkOrdersPanelProps['onCharge'];
  onBack: (message?: string) => void;
}) {
  const [order, setOrder] = useState<WorkOrderRecord | null>(null);
  const [status, setStatus] = useState<WorkOrderStatus>('EM_ANALISE');
  const [services, setServices] = useState<WorkOrderItem[]>([]);
  const [notes, setNotes] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [tested, setTested] = useState(false);
  const [withoutRepair, setWithoutRepair] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function load(record: WorkOrderRecord) {
    setOrder(record);
    setStatus(OPEN_STATUSES.includes(record.status) ? record.status : 'PRONTO');
    setServices(record.items);
    setNotes(record.notes ?? '');
    setExpectedDate(record.expectedDate?.slice(0, 10) ?? '');
  }

  useEffect(() => {
    getWorkOrder(orderId).then(load).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Não foi possível abrir a OS.'));
  }, [orderId]);

  if (!order) {
    return (
      <section className="reservations-panel trade-in-panel">
        {error ? <p className="field-error">{error}</p> : <p className="modal-copy">Carregando a OS...</p>}
        <button className="text-action" type="button" onClick={() => onBack()}>Voltar à lista</button>
      </section>
    );
  }

  const closed = order.status === 'ENTREGUE' || order.status === 'DEVOLVIDO';
  const paid = Boolean(order.saleId);
  const servicesChanged = JSON.stringify(services.map((item) => item.serviceId)) !== JSON.stringify(order.items.map((item) => item.serviceId));
  const dirty = status !== order.status || servicesChanged || notes !== (order.notes ?? '') || expectedDate !== (order.expectedDate?.slice(0, 10) ?? '');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Não foi possível concluir.');
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(async () => {
    if (services.length === 0) throw new Error('A OS precisa de ao menos um serviço.');
    load(await updateWorkOrder(order.workOrderId, { status, serviceIds: services.map((item) => item.serviceId), notes: notes.trim(), expectedDate: expectedDate || null }));
    setInfo('Alterações salvas.');
  });

  const charge = (deliver: boolean) => run(async () => {
    if (dirty) throw new Error('Salve as alterações antes de cobrar.');
    const chargeError = await onCharge({ order, deliver });
    if (chargeError) throw new Error(chargeError);
  });

  const deliver = () => run(async () => {
    if (!seller) throw new Error('Informe o código do vendedor que está entregando.');
    if (dirty) throw new Error('Salve as alterações antes de entregar.');
    const result = await deliverWorkOrder(order.workOrderId, seller.code, { withoutRepair, tested });
    if (result.status === 'INVALID_SELLER') throw new Error('Código do vendedor não encontrado nesta loja.');
    if (result.status === 'NOT_PAID') throw new Error('A OS ainda não foi paga: use "Cobrar e entregar".');
    if (result.status !== 'OK') return;
    const record = result.order;
    void loadStore().then((store) => printWorkOrder(record, store, 'delivery'));
    onBack(`OS nº ${record.orderNumber} ${withoutRepair ? 'devolvida sem conserto' : 'entregue'}. O comprovante foi enviado para a impressora: colha a assinatura do cliente na via da loja.`);
  });

  return (
    <section className="reservations-panel trade-in-panel">
      <div className="wo-detail-heading">
        <h1>OS nº {order.orderNumber}</h1>
        <span className={`wo-status ${statusTone(order.status)}`}>{WORK_ORDER_STATUS_LABELS[order.status]}</span>
        {!closed && <span className={`wo-status ${isPaid(order) ? 'is-ready' : 'is-waiting'}`}>{paid ? 'Paga' : order.total > 0 ? 'A pagar' : 'Sem custo'}</span>}
      </div>
      <p className="modal-copy">
        Aberta em {new Date(order.createdAt).toLocaleString('pt-BR')} por {order.staffCode} - {order.staffName}
        {order.deliveredAt ? ` · ${order.status === 'DEVOLVIDO' ? 'Devolvida' : 'Entregue'} em ${new Date(order.deliveredAt).toLocaleString('pt-BR')}` : ''}
        {order.warrantyUntil ? ` · garantia até ${formatDateOnly(order.warrantyUntil)}` : ''}
      </p>

      <div className="wo-summary">
        <div><small>Cliente</small><strong>{order.customerName}</strong><span>{order.customerCpf ? `CPF ${formatCpf(order.customerCpf)} · ` : ''}{order.customerPhone}</span></div>
        <div><small>Aparelho</small><strong>{[order.equipmentType, order.equipment].filter(Boolean).join(' · ')}</strong><span>{order.serialNumber ? `S/N ${order.serialNumber}` : 'Sem nº de série'}</span></div>
        <div><small>Acessórios</small><span>{order.accessories ?? 'Nenhum'}</span></div>
        <div><small>Estado na entrada</small><span>{order.entryCondition}</span></div>
        {order.devicePassword && <div><small>Senha / desbloqueio</small><span>{order.devicePassword}</span></div>}
      </div>

      <h2 className="trade-in-section">Serviços {paid && !closed ? '(OS paga: serviços travados)' : ''}</h2>
      <ServicePicker selected={services} onChange={setServices} disabled={closed || paid} />

      {!closed && (
        <>
          <div className="trade-in-grid">
            <label>
              Situação
              <select value={status} onChange={(event) => setStatus(event.target.value as WorkOrderStatus)}>
                {OPEN_STATUSES.map((option) => <option key={option} value={option}>{WORK_ORDER_STATUS_LABELS[option]}</option>)}
              </select>
            </label>
            <label>
              Previsão de entrega
              <input type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} />
            </label>
          </div>
          <label>
            Observação
            <input maxLength={300} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="primary-action modal-confirm" type="button" onClick={() => void save()} disabled={busy || !dirty}>Salvar alterações</button>
          </div>

          <h2 className="trade-in-section">Entrega</h2>
          <label className="wo-check">
            <input type="checkbox" checked={withoutRepair} disabled={paid} onChange={(event) => { setWithoutRepair(event.target.checked); setTested(false); }} />
            Devolver sem conserto (não cobra){paid ? ' — OS paga: estorne a venda no ERP antes' : ''}
          </label>
          {!withoutRepair && (
            <label className="wo-check">
              <input type="checkbox" checked={tested} onChange={(event) => setTested(event.target.checked)} />
              Equipamento testado na entrega diante do cliente
            </label>
          )}
          {sellerSlot}
        </>
      )}

      {error && <p className="field-error">{error}</p>}
      {info && <p className="modal-copy">{info}</p>}
      <div className="modal-actions">
        <button className="text-action" type="button" onClick={() => onBack()} disabled={busy}>Voltar à lista</button>
        <button className="text-action" type="button" onClick={() => void loadStore().then((store) => printWorkOrder(order, store, 'entry'))} disabled={busy}>
          Reimprimir entrada
        </button>
        {closed && (
          <button className="text-action" type="button" onClick={() => void loadStore().then((store) => printWorkOrder(order, store, 'delivery'))} disabled={busy}>
            Reimprimir {order.status === 'DEVOLVIDO' ? 'devolução' : 'entrega'}
          </button>
        )}
        {!closed && !paid && order.total > 0 && !withoutRepair && (
          <button className="text-action" type="button" onClick={() => void charge(false)} disabled={busy}>Cobrar agora (sem entregar)</button>
        )}
        {!closed && (withoutRepair || isPaid(order)) && (
          <button className="primary-action modal-confirm" type="button" onClick={() => void deliver()} disabled={busy || !seller || (!withoutRepair && !tested)}>
            {withoutRepair ? 'Devolver sem conserto e imprimir' : 'Entregar e imprimir comprovante'}
          </button>
        )}
        {!closed && !withoutRepair && !isPaid(order) && (
          <button className="primary-action modal-confirm" type="button" onClick={() => void charge(true)} disabled={busy || !tested}>
            Cobrar {currency.format(order.total)} e entregar
          </button>
        )}
      </div>
    </section>
  );
}

export function WorkOrdersPanel({ seller, sellerSlot, initialOrderId, loadStore, onCharge }: WorkOrdersPanelProps) {
  const [view, setView] = useState<View>(initialOrderId ? { kind: 'detail', orderId: initialOrderId } : { kind: 'list' });
  const [query, setQuery] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [orders, setOrders] = useState<WorkOrderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh(text = query) {
    setLoading(true);
    setError(null);
    try {
      setOrders(await listWorkOrders(text, includeClosed));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Não foi possível carregar as ordens de serviço.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.kind === 'list') void refresh();
  }, [view.kind, includeClosed]);

  if (view.kind === 'new') {
    return (
      <NewWorkOrder
        seller={seller}
        sellerSlot={sellerSlot}
        loadStore={loadStore}
        onCharge={onCharge}
        onCreated={(_order, text) => { setMessage(text); setView({ kind: 'list' }); }}
        onCancel={() => setView({ kind: 'list' })}
      />
    );
  }

  if (view.kind === 'detail') {
    return (
      <WorkOrderDetail
        key={view.orderId}
        orderId={view.orderId}
        seller={seller}
        sellerSlot={sellerSlot}
        loadStore={loadStore}
        onCharge={onCharge}
        onBack={(text) => { setMessage(text ?? null); setView({ kind: 'list' }); }}
      />
    );
  }

  return (
    <section className="reservations-panel">
      <div className="wo-detail-heading">
        <h1>Ordens de serviço</h1>
        <button className="primary-action" type="button" onClick={() => { setMessage(null); setView({ kind: 'new' }); }}>
          <Plus size={18} /> Nova OS
        </button>
      </div>
      <form className="wo-service-search" onSubmit={(event) => { event.preventDefault(); void refresh(); }}>
        <input placeholder="Buscar por nº da OS, CPF, nome, aparelho ou serial" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button className="icon-button search-button" type="submit" title="Buscar"><Search size={18} /></button>
      </form>
      <label className="wo-check">
        <input type="checkbox" checked={includeClosed} onChange={(event) => setIncludeClosed(event.target.checked)} />
        Mostrar também as entregues
      </label>
      {message && <p className="modal-copy wo-message">{message}</p>}
      {error && <p className="field-error">{error}</p>}
      {loading && <p className="modal-copy">Carregando...</p>}
      {!loading && orders.length === 0 && !error && <p className="empty-state">Nenhuma ordem de serviço {includeClosed || query ? 'encontrada' : 'ativa'}.</p>}
      <div className="reservation-list">
        {orders.map((order) => (
          <button key={order.workOrderId} type="button" className="wo-row" onClick={() => { setMessage(null); setView({ kind: 'detail', orderId: order.workOrderId }); }}>
            <span className="wo-row-number">nº {order.orderNumber}</span>
            <span className="wo-row-main">
              <strong>{order.customerName}</strong>
              <small>{[order.equipmentType, order.equipment].filter(Boolean).join(' · ')}{order.serialNumber ? ` · S/N ${order.serialNumber}` : ''}</small>
              <small>{order.items.map((item) => item.name).join(', ')}</small>
            </span>
            <span className="wo-row-side">
              <span className={`wo-status ${statusTone(order.status)}`}>{WORK_ORDER_STATUS_LABELS[order.status]}</span>
              <strong>{currency.format(order.total)}</strong>
              <small>
                {order.status === 'ENTREGUE' || order.status === 'DEVOLVIDO'
                  ? (order.deliveredAt ? new Date(order.deliveredAt).toLocaleDateString('pt-BR') : '')
                  : `${order.saleId ? 'Paga' : order.total > 0 ? 'A pagar' : 'Sem custo'}${order.expectedDate ? ` · prev. ${formatDateOnly(order.expectedDate)}` : ''}`}
              </small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
