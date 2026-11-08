import { useEffect, useState } from 'react';
import { CheckCircle2, Trash2, Wallet } from 'lucide-react';
import ValueInput from './ValueInput';
import { formatMoney, toLocalDateKey } from '../db/finance';
import {
  TenantBilling,
  formatBillingDate,
  formatCompetence,
  getTenantBilling,
  registerTenantPayment,
  removeTenantPayment,
  saveTenantBilling,
} from '../db/billing';
import { SubscriptionStatus } from '../types';

// UCP › ficha do cliente › Cobranca: vencimento, mensalidade e pagamentos registrados a mao.

const METHODS = ['Pix', 'Boleto', 'Transferência', 'Dinheiro', 'Outro'];
const inputClass = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';
const message = (error: unknown, fallback: string) => (error as { message?: string })?.message || fallback;

interface Props {
  tenantId: string;
  onStatusChange: (status: SubscriptionStatus | null) => void;
}

export default function BillingPanel({ tenantId, onStatusChange }: Props) {
  const today = toLocalDateKey(new Date());
  const [billing, setBilling] = useState<TenantBilling | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [exempt, setExempt] = useState(true);
  const [dueDay, setDueDay] = useState<number | null>(5);
  const [startMonth, setStartMonth] = useState(today.slice(0, 7));
  const [amount, setAmount] = useState<number | null>(null);
  const [graceDays, setGraceDays] = useState<number | null>(10);
  const [payMonth, setPayMonth] = useState(today.slice(0, 7));
  const [payAmount, setPayAmount] = useState<number | null>(null);
  const [payMethod, setPayMethod] = useState('Pix');
  const [payDate, setPayDate] = useState(today);
  const [payNote, setPayNote] = useState('');

  const apply = (next: TenantBilling) => {
    setBilling(next);
    onStatusChange(next.status);
    setExempt(next.dueDay == null);
    setDueDay(next.dueDay ?? 5);
    setStartMonth((next.startMonth ?? today).slice(0, 7));
    setAmount(next.amount);
    setGraceDays(next.graceDays);
    setPayMonth((next.firstUnpaid ?? today).slice(0, 7));
    setPayAmount(next.amount);
  };

  const load = () => getTenantBilling(tenantId).then(apply);

  useEffect(() => {
    setError('');
    setNotice('');
    setBilling(null);
    load().catch(loadError => setError(message(loadError, 'Não foi possível carregar a cobrança. Confira se a migration 20261122 foi aplicada.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
      setNotice(done);
    } catch (runError) {
      setError(message(runError, 'Não foi possível concluir.'));
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = () => run(() => saveTenantBilling(tenantId, {
    dueDay: exempt ? null : dueDay,
    startMonth: exempt ? null : `${startMonth}-01`,
    amount,
    graceDays: graceDays ?? 10,
  }), 'Cobrança salva.');

  const registerPayment = () => {
    if (payAmount == null) {
      setError('Informe o valor pago.');
      return;
    }
    void run(() => registerTenantPayment(tenantId, {
      competence: `${payMonth}-01`, amount: payAmount, method: payMethod, paidOn: payDate, note: payNote,
    }).then(() => setPayNote('')), `Pagamento de ${formatCompetence(`${payMonth}-01`)} registrado.`);
  };

  const removePayment = (id: string, competence: string) => {
    if (!window.confirm(`Desfazer o pagamento de ${formatCompetence(competence)}?`)) return;
    void run(() => removeTenantPayment(id), 'Pagamento desfeito.');
  };

  if (!billing) {
    return (
      <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-5 text-sm text-slate-500">
        {error || 'Carregando cobrança...'}
      </section>
    );
  }

  const billingActive = billing.dueDay != null;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">{error}</p>}
      {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{notice}</p>}

      <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-5">
        <h3 className="font-bold text-slate-900 flex items-center gap-2"><Wallet className="w-4 h-4 text-blue-600" />Mensalidade</h3>
        {billing.manualLock && (
          <p className="mt-2 text-xs font-semibold text-rose-700">Bloqueio manual ativo: só sai quando você mudar a situação para Ativo, no topo da ficha.</p>
        )}
        <p className="mt-1 text-sm text-slate-600">
          {!billingActive
            ? 'Cliente isento: nenhuma cobrança automática.'
            : billing.firstUnpaid
              ? `Em aberto: ${formatCompetence(billing.firstUnpaid)} · vence em ${formatBillingDate(billing.dueDate)} · bloqueia depois de ${formatBillingDate(billing.blockAfter)}.`
              : 'Tudo pago.'}
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input type="checkbox" checked={exempt} onChange={event => setExempt(event.target.checked)} />
          Isento (sem cobrança automática)
        </label>

        {!exempt && (
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <label className="text-xs font-bold text-slate-700">Dia de vencimento
              <ValueInput decimals={0} value={dueDay} placeholder="5" onValueChange={value => setDueDay(value)} className={inputClass} />
            </label>
            <label className="text-xs font-bold text-slate-700">Primeira mensalidade
              <input type="month" value={startMonth} onChange={event => setStartMonth(event.target.value)} className={inputClass} />
            </label>
            <label className="text-xs font-bold text-slate-700">Valor (R$)
              <ValueInput value={amount} placeholder="0,00" onValueChange={value => setAmount(value)} className={inputClass} />
            </label>
            <label className="text-xs font-bold text-slate-700">Tolerância (dias)
              <ValueInput decimals={0} value={graceDays} placeholder="10" onValueChange={value => setGraceDays(value)} className={inputClass} />
            </label>
          </div>
        )}

        <div className="mt-4">
          <button type="button" disabled={busy} onClick={() => void saveConfig()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50">Salvar cobrança</button>
        </div>
      </section>

      {billingActive && (
        <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-5">
          <h3 className="font-bold text-slate-900 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600" />Registrar pagamento</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <label className="text-xs font-bold text-slate-700">Mensalidade de
              <input type="month" value={payMonth} onChange={event => setPayMonth(event.target.value)} className={inputClass} />
            </label>
            <label className="text-xs font-bold text-slate-700">Valor pago (R$)
              <ValueInput value={payAmount} placeholder="0,00" onValueChange={value => setPayAmount(value)} className={inputClass} />
            </label>
            <label className="text-xs font-bold text-slate-700">Forma
              <select value={payMethod} onChange={event => setPayMethod(event.target.value)} className={inputClass}>
                {METHODS.map(method => <option key={method}>{method}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-700">Pago em
              <input type="date" value={payDate} onChange={event => setPayDate(event.target.value)} className={inputClass} />
            </label>
          </div>
          <label className="mt-3 block text-xs font-bold text-slate-700">Observação
            <input value={payNote} onChange={event => setPayNote(event.target.value)} className={inputClass} />
          </label>
          <div className="mt-4">
            <button type="button" disabled={busy} onClick={registerPayment} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50">Registrar pagamento</button>
          </div>
        </section>
      )}

      <section className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <h3 className="border-b border-slate-100 px-5 py-3 font-bold text-slate-900">Histórico de pagamentos</h3>
        {billing.payments.length === 0 && <p className="px-5 py-4 text-sm text-slate-500">Nenhum pagamento registrado.</p>}
        <ul className="divide-y divide-slate-100">
          {billing.payments.map(payment => (
            <li key={payment.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="flex-1">
                <strong className="block text-slate-900">{formatCompetence(payment.competence)}</strong>
                <span className="text-xs text-slate-500">Pago em {formatBillingDate(payment.paidOn)}{payment.method ? ` · ${payment.method}` : ''}{payment.note ? ` · ${payment.note}` : ''}</span>
              </span>
              <strong className="text-slate-900">{formatMoney(payment.amount)}</strong>
              <button type="button" disabled={busy} title="Desfazer pagamento" onClick={() => removePayment(payment.id, payment.competence)} className="p-1 text-slate-400 hover:text-rose-600 disabled:opacity-50">
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
