import { useEffect, useState } from 'react';
import { ArrowLeft, CalendarClock, Coins, Gamepad2, Pencil, ReceiptText, ShieldCheck, ShoppingBag, Ticket, Wallet, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Customer } from '../types';
import { formatMoney } from '../db/finance';
import { getCustomerHistory, type CustomerHistory } from '../db/insights';

// Ficha completa do cliente (desenho aprovado em 2026-11-03): resumo + abas Compras, Garantias,
// Ordens de servico, Vales, Reservas e Troca Gamer. So as lojas que o usuario enxerga.

type Tab = 'compras' | 'garantias' | 'os' | 'vales' | 'reservas' | 'troca';

const TABS: { id: Tab; name: string; icon: LucideIcon }[] = [
  { id: 'compras', name: 'Compras', icon: ShoppingBag },
  { id: 'garantias', name: 'Garantias', icon: ShieldCheck },
  { id: 'os', name: 'Ordens de serviço', icon: Wrench },
  { id: 'vales', name: 'Vales', icon: Ticket },
  { id: 'reservas', name: 'Reservas', icon: CalendarClock },
  { id: 'troca', name: 'Troca Gamer', icon: Gamepad2 },
];

const WORK_ORDER_STATUS: Record<string, string> = {
  EM_ANALISE: 'Em análise', AGUARDANDO_PECA: 'Aguardando peça', PRONTO: 'Pronto', ENTREGUE: 'Entregue', DEVOLVIDO: 'Devolvido sem conserto',
};
const RESERVATION_STATUS: Record<string, string> = { ATIVA: 'Ativa', CONVERTIDA: 'Virou venda', CANCELADA: 'Cancelada' };
const CREDIT_ORIGIN: Record<string, string> = { TROCA_GAMER: 'Troca Gamer', DEVOLUCAO: 'Devolução', OUTRO: 'Vale-troca' };
const MOVEMENT_LABEL: Record<string, string> = { EMISSAO: 'Gerado', USO: 'Usado numa venda', ESTORNO_USO: 'Devolvido (venda estornada)' };
const PAYMENT_LABEL: Record<string, string> = {
  DINHEIRO: 'Dinheiro', PIX: 'Pix', CREDITO: 'Crédito', DEBITO: 'Débito', VOUCHER: 'Vale-troca', CREDIARIO: 'Crediário', DIVIDIDO: 'Dividido', VALE: 'Vale-troca',
};

const formatCpf = (cpf: string) => cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
const date = (value: string | null) => (value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('pt-BR') : '—');
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Não foi possível carregar o histórico.';

export default function CustomerDetail({ customer, onBack, onEdit }: { customer: Customer; onBack: () => void; onEdit: () => void }) {
  const [history, setHistory] = useState<CustomerHistory | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('compras');

  useEffect(() => {
    setHistory(null);
    setError('');
    getCustomerHistory(customer.id).then(setHistory).catch(loadError => setError(errorText(loadError)));
  }, [customer.id]);

  const summary = history?.summary;
  const ticket = summary && summary.purchases > 0 ? summary.totalSpent / summary.purchases : 0;
  const counts: Record<Tab, number> = {
    compras: history?.purchases.length ?? 0,
    garantias: history?.warranties.length ?? 0,
    os: history?.workOrders.length ?? 0,
    vales: history?.credits.length ?? 0,
    reservas: history?.reservations.length ?? 0,
    troca: history?.tradeIns.length ?? 0,
  };
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4 text-xs">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 font-bold text-blue-700 hover:underline">
        <ArrowLeft className="h-4 w-4" />Voltar para clientes
      </button>

      <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-4 flex flex-wrap items-start gap-4">
        <div className="h-12 w-12 rounded-xl bg-blue-600 text-white flex items-center justify-center font-black text-base shrink-0">
          {customer.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('')}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Cliente código {customer.code}</p>
          <h3 className="text-base font-bold text-slate-900">{customer.name}{!customer.isActive && <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[9px] font-bold">INATIVO</span>}</h3>
          <p className="text-slate-600">CPF {formatCpf(customer.cpf)} · {customer.phone}{customer.email ? ` · ${customer.email}` : ''}</p>
          {customer.address && (
            <p className="text-slate-500">
              {customer.address}{customer.addressNumber ? `, ${customer.addressNumber}` : ''}{customer.complement ? ` - ${customer.complement}` : ''}
              {customer.district ? ` · ${customer.district}` : ''}{customer.city ? ` · ${customer.city}/${customer.state ?? ''}` : ''}
            </p>
          )}
          <p className="text-slate-500">Cliente desde {date(customer.createdAt)} · LGPD: {customer.lgpdConsent ? 'autorizado' : 'não autorizado'}</p>
        </div>
        <button type="button" onClick={onEdit} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 font-bold text-blue-700 hover:bg-blue-50"><Pencil className="w-4 h-4" />Editar cadastro</button>
      </section>

      {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {!history && !error && <p className="text-slate-400">Carregando histórico...</p>}

      {history && summary && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Stat label="Total gasto" value={formatMoney(summary.totalSpent)} icon={Coins} tone="bg-blue-50 text-blue-600 border-blue-100/80" />
            <Stat label="Compras" value={String(summary.purchases)} icon={ShoppingBag} tone="bg-slate-100 text-slate-600 border-slate-200" />
            <Stat label="Ticket médio" value={formatMoney(ticket)} icon={ReceiptText} tone="bg-slate-100 text-slate-600 border-slate-200" />
            <Stat label="Última compra" value={date(summary.lastPurchase)} icon={CalendarClock} tone="bg-slate-100 text-slate-600 border-slate-200" />
            <Stat label="Saldo de vale-troca" value={formatMoney(summary.creditBalance)} icon={Wallet} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" />
          </div>

          <div className="flex flex-wrap gap-1 border-b border-slate-200">
            {TABS.map(item => {
              const Icon = item.icon;
              return (
                <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 font-bold ${tab === item.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                  <Icon className="h-4 w-4" />{item.name}<span className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-600">{counts[item.id]}</span>
                </button>
              );
            })}
          </div>

          <section className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
            {counts[tab] === 0 && <p className="p-4 text-slate-400">Nada registrado.</p>}

            {tab === 'compras' && (
              <ul className="divide-y divide-slate-100">
                {history.purchases.map(sale => {
                  const canceled = sale.status !== 'CONCLUIDA';
                  return (
                    <li key={sale.id} className={`p-4 space-y-1.5 ${canceled ? 'text-slate-400' : ''}`}>
                      <div className="flex flex-wrap justify-between gap-2">
                        <span>
                          <strong className={canceled ? '' : 'text-slate-900'}>{date(sale.timestamp)} · {sale.storeName}</strong>
                          <span className="block text-slate-500">
                            {[sale.sellerName && `Vendedor ${sale.sellerName}`, PAYMENT_LABEL[sale.paymentMethod ?? ''] ?? sale.paymentMethod,
                              sale.nfceNumber ? `NFC-e nº ${sale.nfceNumber}` : sale.receiptNumber ? `Cupom nº ${String(sale.receiptNumber).padStart(5, '0')}` : null].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <span className="text-right">
                          <strong className={`font-mono ${canceled ? 'line-through' : 'text-slate-900'}`}>{formatMoney(sale.grossAmount)}</strong>
                          {canceled && <span className="block font-bold">Estornada</span>}
                        </span>
                      </div>
                      <ul className="text-slate-600">
                        {sale.items.map((item, index) => (
                          <li key={index}>
                            {item.quantity}× {item.name}{item.itemType === 'SERVICE' ? ' (serviço)' : ''}{item.serials.length ? ` · série ${item.serials.join(', ')}` : ''}
                            <span className="font-mono text-slate-500"> · {formatMoney(item.lineTotal)}</span>
                          </li>
                        ))}
                      </ul>
                      {sale.returns.map(sale_return => (
                        <p key={sale_return.returnNumber} className="text-amber-700 font-semibold">
                          Devolução nº {sale_return.returnNumber} em {date(sale_return.createdAt)}: {formatMoney(sale_return.amount)} ({PAYMENT_LABEL[sale_return.refundMethod] ?? sale_return.refundMethod.toLowerCase()}) · {sale_return.reason}
                        </p>
                      ))}
                    </li>
                  );
                })}
              </ul>
            )}

            {tab === 'garantias' && (
              <ul className="divide-y divide-slate-100">
                {history.warranties.map((warranty, index) => {
                  const valid = warranty.until !== null && warranty.until >= today;
                  return (
                    <li key={index} className="p-4 flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <strong className="text-slate-900">{warranty.itemName}</strong>
                        <span className="block text-slate-500">Comprado em {date(warranty.saleDate)} · {warranty.storeName}{warranty.serial ? ` · série ${warranty.serial}` : ''}</span>
                      </div>
                      <span className={`px-2 py-1 rounded font-bold ${valid ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                        {valid ? 'Em garantia' : 'Vencida'} · até {date(warranty.until)} ({warranty.days ? `${warranty.days} dias` : `${warranty.months} meses`})
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {tab === 'os' && (
              <ul className="divide-y divide-slate-100">
                {history.workOrders.map(order => (
                  <li key={order.id} className="p-4 flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <strong className="text-slate-900">OS nº {order.orderNumber ?? '—'} · {order.equipment || 'Aparelho'}</strong>
                      <span className="block text-slate-500">
                        Aberta em {date(order.createdAt)} · {order.storeName}
                        {order.deliveredAt ? ` · entregue em ${date(order.deliveredAt)}` : order.expectedDate ? ` · previsão ${date(order.expectedDate)}` : ''}
                        {order.warrantyUntil ? ` · garantia até ${date(order.warrantyUntil)}` : ''}
                      </span>
                    </div>
                    <span className="font-mono font-bold text-slate-900">{formatMoney(order.total)}</span>
                    <span className={`px-2 py-1 rounded font-bold ${order.paid ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{order.paid ? 'Pago' : 'A pagar'}</span>
                    <span className="px-2 py-1 rounded bg-slate-100 font-bold text-slate-700">{WORK_ORDER_STATUS[order.status] ?? order.status}</span>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'vales' && (
              <ul className="divide-y divide-slate-100">
                {history.credits.map(credit => (
                  <li key={credit.id} className="p-4 space-y-1">
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong className="text-slate-900">{CREDIT_ORIGIN[credit.origin]} de {formatMoney(credit.amount)} · {date(credit.createdAt)} · {credit.storeName}</strong>
                      <span className={`px-2 py-0.5 rounded font-bold ${credit.balance > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>Saldo {formatMoney(credit.balance)}</span>
                    </div>
                    <ul className="text-slate-500">
                      {credit.movements.map((movement, index) => (
                        <li key={index}>{date(movement.createdAt)} · {MOVEMENT_LABEL[movement.kind] ?? movement.kind}: {formatMoney(Math.abs(movement.amount))}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'reservas' && (
              <ul className="divide-y divide-slate-100">
                {history.reservations.map(reservation => (
                  <li key={reservation.id} className="p-4 space-y-1">
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong className="text-slate-900">{date(reservation.createdAt)} · {reservation.storeName}</strong>
                      <span className="px-2 py-0.5 rounded bg-slate-100 font-bold text-slate-700">{RESERVATION_STATUS[reservation.status] ?? reservation.status}</span>
                    </div>
                    <p className="text-slate-500">
                      {reservation.items.map(item => `${item.quantity}× ${item.name}`).join(', ')}
                      {' · '}retirar até {date(reservation.expiresAt)}{reservation.deposit > 0 ? ` · sinal ${formatMoney(reservation.deposit)}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'troca' && (
              <ul className="divide-y divide-slate-100">
                {history.tradeIns.map(trade => (
                  <li key={trade.id} className="p-4 flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <strong className="text-slate-900">{trade.tradeNumber ? `Troca nº ${trade.tradeNumber} · ` : ''}{trade.description}</strong>
                      <span className="block text-slate-500">{date(trade.timestamp)} · {trade.storeName}{trade.serial ? ` · série ${trade.serial}` : ''}{trade.paymentMethod ? ` · pago em ${PAYMENT_LABEL[trade.paymentMethod] ?? trade.paymentMethod.toLowerCase()}` : ''}</span>
                    </div>
                    <span className="font-mono font-bold text-slate-900">{formatMoney(trade.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: string; icon: LucideIcon; tone: string }) {
  return (
    <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
      <div className={`p-2 rounded-lg shrink-0 border ${tone}`}><Icon className="w-4 h-4" /></div>
      <div className="min-w-0">
        <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">{label}</span>
        <span className="text-sm font-extrabold text-slate-900 block truncate">{value}</span>
      </div>
    </div>
  );
}
