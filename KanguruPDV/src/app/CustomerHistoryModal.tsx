import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { getPosCustomerHistory, type PosCustomerHistory } from '../services/supabase/insights';

// Historico resumido do cliente da venda (todas as lojas da empresa): resumo, ultimas compras,
// garantias, OS e reservas abertas. A ficha completa fica no ERP › Clientes.

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const date = (value: string | null) => (value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('pt-BR') : '—');
const WORK_ORDER_STATUS: Record<string, string> = {
  EM_ANALISE: 'Em análise', AGUARDANDO_PECA: 'Aguardando peça', PRONTO: 'Pronto', ENTREGUE: 'Entregue', DEVOLVIDO: 'Devolvido',
};

export function CustomerHistoryModal({ cpf, name, onClose }: { cpf: string; name: string; onClose: () => void }) {
  const [history, setHistory] = useState<PosCustomerHistory | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getPosCustomerHistory(cpf)
      .then(setHistory)
      .catch(() => setError('Não foi possível carregar o histórico. Confira a internet e se o sistema foi atualizado.'));
  }, [cpf]);

  const today = new Date().toISOString().slice(0, 10);
  const activeWarranties = history?.warranties.filter((warranty) => warranty.until && warranty.until >= today) ?? [];
  const openOrders = history?.workOrders.filter((order) => !['ENTREGUE', 'DEVOLVIDO'].includes(order.status)) ?? [];
  const activeReservations = history?.reservations.filter((reservation) => reservation.status === 'ATIVA') ?? [];
  const ticket = history && history.summary.purchases > 0 ? history.summary.totalSpent / history.summary.purchases : 0;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal report-modal" role="dialog" aria-modal="true" aria-labelledby="customer-history-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Cliente</p>
            <h2 id="customer-history-title">{name}</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose}><X size={20} /></button>
        </div>
        {error && <p className="empty-state">{error}</p>}
        {!history && !error && <p className="empty-state">Carregando...</p>}
        {history && (
          <div className="lookup-list history-section">
            <div className="report-summary">
              <div><small>Total gasto</small><strong>{currency.format(history.summary.totalSpent)}</strong></div>
              <div><small>Compras</small><strong>{history.summary.purchases}</strong></div>
              <div><small>Ticket médio</small><strong>{currency.format(ticket)}</strong></div>
              <div><small>Última compra</small><strong>{date(history.summary.lastPurchase)}</strong></div>
              <div><small>Vale-troca</small><strong>{currency.format(history.summary.creditBalance)}</strong></div>
            </div>

            {openOrders.length > 0 && (
              <>
                <h3>Ordens de serviço em aberto</h3>
                <div className="product-list">
                  {openOrders.map((order) => (
                    <div className="product-row" key={order.id}>
                      <span><strong>OS nº {order.orderNumber ?? '—'} · {order.equipment || 'Aparelho'}</strong><small>Aberta em {date(order.createdAt)} · {order.storeName}</small></span>
                      <span><strong>{currency.format(order.total)}</strong><small>{WORK_ORDER_STATUS[order.status] ?? order.status} · {order.paid ? 'pago' : 'a pagar'}</small></span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {activeReservations.length > 0 && (
              <>
                <h3>Reservas ativas</h3>
                <div className="product-list">
                  {activeReservations.map((reservation) => (
                    <div className="product-row" key={reservation.id}>
                      <span><strong>{reservation.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}</strong><small>{reservation.storeName} · retirar até {date(reservation.expiresAt)}</small></span>
                      <span><strong>{reservation.deposit > 0 ? currency.format(reservation.deposit) : '—'}</strong><small>sinal</small></span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {activeWarranties.length > 0 && (
              <>
                <h3>Em garantia</h3>
                <div className="product-list">
                  {activeWarranties.map((warranty, index) => (
                    <div className="product-row" key={index}>
                      <span><strong>{warranty.itemName}</strong><small>Comprado em {date(warranty.saleDate)} · {warranty.storeName}{warranty.serial ? ` · série ${warranty.serial}` : ''}</small></span>
                      <span><strong>até {date(warranty.until)}</strong><small>{warranty.months} meses</small></span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <h3>Últimas compras</h3>
            <div className="product-list">
              {history.purchases.length === 0 && <p className="empty-state">Nenhuma compra registrada.</p>}
              {history.purchases.map((sale) => (
                <div className="product-row" key={sale.id}>
                  <span>
                    <strong>
                      {date(sale.timestamp)} · {sale.storeName}
                      {sale.status !== 'CONCLUIDA' && <span className="history-tag is-warn">Estornada</span>}
                      {sale.returnedAmount > 0 && <span className="history-tag">Devolução {currency.format(sale.returnedAmount)}</span>}
                    </strong>
                    <small>{sale.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}{sale.sellerName ? ` · ${sale.sellerName}` : ''}</small>
                  </span>
                  <span><strong>{currency.format(sale.grossAmount)}</strong></span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
