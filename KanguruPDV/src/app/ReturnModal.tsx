import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  emitReturnNfe,
  getSaleReturn,
  getSaleReturnable,
  processSaleReturn,
  type RefundMethod,
  type ReturnDestination,
  type ReturnableSale,
} from '../services/supabase/returns';
import { searchPosCustomers, type PosCustomer } from '../services/supabase/customers';
import type { PosStoreProfile } from '../services/supabase/terminal';
import { CustomerFormModal } from './CustomerModals';
import { isValidCpf, maskCpf } from './cpf';
import { formatReceiptNumber } from './receiptPrint';
import { printReturnReceipt } from './returnReceiptPrint';

// Troca / devolucao de uma venda (2.9). Itens parciais, destino (estoque ou avariado),
// forma de devolucao e, quando exigido, CPF/endereco do cliente e a senha Gerente.

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const REFUND_OPTIONS: { value: RefundMethod; label: string; money: boolean }[] = [
  { value: 'TROCA', label: 'Troca (crédito usado agora numa venda nova)', money: false },
  { value: 'VALE', label: 'Vale-troca no CPF do cliente', money: false },
  { value: 'DINHEIRO', label: 'Devolver em dinheiro', money: true },
  { value: 'PIX', label: 'Devolver por PIX', money: true },
  { value: 'CREDITO', label: 'Estorno no cartão de crédito (na maquininha)', money: true },
  { value: 'DEBITO', label: 'Estorno no cartão de débito (na maquininha)', money: true },
];

interface LineState {
  quantity: number;
  serials: string[];
  destination: ReturnDestination;
}

export interface ReturnDone {
  message: string;
  exchange: { cpf: string; amount: number } | null;
}

interface ReturnModalProps {
  saleId: string;
  loadStore: () => Promise<PosStoreProfile | null>;
  onClose: () => void;
  onDone: (result: ReturnDone) => void;
}

export function ReturnModal({ saleId, loadStore, onClose, onDone }: ReturnModalProps) {
  const [sale, setSale] = useState<ReturnableSale | null>(null);
  const [lines, setLines] = useState<Record<number, LineState>>({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<RefundMethod>('TROCA');
  const [cpf, setCpf] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAddress, setNeedsAddress] = useState(false);
  const [customerForm, setCustomerForm] = useState<{ customer: PosCustomer | null } | null>(null);

  useEffect(() => {
    getSaleReturnable(saleId)
      .then((found) => {
        setSale(found);
        if (found?.clientCpf) setCpf(maskCpf(found.clientCpf));
        if (found && found.fiscalStatus === 'AUTORIZADA' && !found.customerAddressComplete) setNeedsAddress(true);
      })
      .catch(() => setError('Não foi possível carregar a venda.'));
  }, [saleId]);

  if (!sale) {
    return (
      <div className="modal-backdrop" role="presentation">
        <section className="serial-unit-modal return-modal" role="dialog" aria-modal="true">
          <p className="modal-copy">{error ?? 'Carregando a venda...'}</p>
          <div className="modal-actions"><button className="text-action" type="button" onClick={onClose}>Fechar</button></div>
        </section>
      </div>
    );
  }

  const products = sale.items.filter((item) => item.itemType === 'PRODUCT');
  const selected = products
    .map((item) => ({ item, line: lines[item.index] }))
    .filter(({ line }) => line && line.quantity > 0);
  const total = selected.reduce((sum, { item, line }) => sum + Math.round(item.unitAmount * line.quantity * 100) / 100, 0);
  const moneyOut = REFUND_OPTIONS.find((option) => option.value === method)?.money ?? false;
  const needsPassword = moneyOut || !sale.withinPeriod;
  const needsCustomer = method === 'TROCA' || method === 'VALE' || sale.fiscalStatus === 'AUTORIZADA';
  const cpfDigits = cpf.replace(/\D/g, '');
  const cpfOk = !needsCustomer || isValidCpf(cpf);
  const serialsOk = selected.every(({ item, line }) => item.serials.length === 0 || line.serials.length === line.quantity);

  function setLine(index: number, patch: Partial<LineState>) {
    setLines((current) => {
      const base = current[index] ?? { quantity: 0, serials: [], destination: 'ESTOQUE' as ReturnDestination };
      return { ...current, [index]: { ...base, ...patch } };
    });
  }

  function toggleSerial(index: number, serial: string) {
    const line = lines[index] ?? { quantity: 0, serials: [], destination: 'ESTOQUE' as ReturnDestination };
    const serials = line.serials.includes(serial) ? line.serials.filter((value) => value !== serial) : [...line.serials, serial];
    setLine(index, { serials, quantity: serials.length });
  }

  async function openCustomerForm() {
    setError(null);
    const found = cpfDigits.length === 11 ? await searchPosCustomers(cpfDigits).catch(() => []) : [];
    setCustomerForm({ customer: found.find((customer) => customer.cpf === cpfDigits) ?? null });
  }

  async function submit() {
    if (!sale) return;
    setBusy(true);
    setError(null);
    try {
      const result = await processSaleReturn({
        saleId: sale.saleId,
        items: selected.map(({ item, line }) => ({
          index: item.index,
          quantity: line.quantity,
          serials: item.serials.length > 0 ? line.serials : [],
          destination: line.destination,
        })),
        reason: reason.trim(),
        refundMethod: method,
        customerCpf: cpfDigits || null,
        adminPassword: needsPassword ? password : null,
      });
      if (result.status === 'PASSWORD_REQUIRED') {
        setError('Digite a senha Gerente para liberar.');
        return;
      }
      if (result.status === 'INVALID_PASSWORD') {
        setPassword('');
        setError(result.remainingAttempts > 0
          ? `Senha Gerente incorreta. Restam ${result.remainingAttempts} tentativa(s).`
          : 'Senha Gerente incorreta. Terminal bloqueado temporariamente para senha.');
        return;
      }
      if (result.status === 'LOCKED') {
        setPassword('');
        setError('Senha Gerente bloqueada por excesso de tentativas. Aguarde alguns minutos.');
        return;
      }
      if (result.status === 'CUSTOMER_REQUIRED') {
        setError('Informe um CPF válido do cliente.');
        return;
      }
      if (result.status === 'CUSTOMER_ADDRESS_REQUIRED') {
        setNeedsAddress(true);
        setError('A venda teve NFC-e: a nota de devolução exige o endereço completo do cliente. Complete o cadastro.');
        return;
      }

      let fiscalText = '';
      if (result.needsFiscalNote) {
        const nfe = await emitReturnNfe(result.returnId);
        fiscalText = nfe.status === 'AUTORIZADA'
          ? ' NF-e de devolução autorizada.'
          : ` NF-e de devolução ${nfe.status === 'PENDENTE' ? 'pendente' : 'com erro'}: ${nfe.message ?? ''}`;
      }
      const receipt = await getSaleReturn(result.returnId).catch(() => null);
      if (receipt) void printReturnReceipt(receipt, await loadStore());
      onDone({
        message: `Devolução nº ${result.returnNumber} registrada: ${currency.format(result.totalAmount)}.${fiscalText}`,
        exchange: method === 'TROCA' ? { cpf: cpfDigits, amount: result.totalAmount } : null,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Não foi possível registrar a devolução.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal return-modal" role="dialog" aria-modal="true" aria-labelledby="return-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Cupom {formatReceiptNumber(sale.receiptNumber)} · {new Date(sale.timestamp).toLocaleDateString('pt-BR')}</p>
            <h2 id="return-title">Trocar / Devolver</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose} disabled={busy}><X size={20} /></button>
        </div>
        <p className="modal-copy">
          {sale.withinPeriod
            ? `Dentro do prazo de troca (${sale.exchangeDays} dias, até ${new Date(sale.deadline).toLocaleDateString('pt-BR')}).`
            : `Fora do prazo de troca (${sale.exchangeDays} dias): exige a senha Gerente.`}
          {sale.fiscalStatus === 'AUTORIZADA' && ' Venda com NFC-e: será emitida a NF-e de devolução.'}
        </p>

        <div className="return-items">
          {products.length === 0 && <p className="empty-state">Esta venda não tem produtos para devolver.</p>}
          {products.map((item) => {
            const available = item.quantity - item.returnedQuantity;
            const line = lines[item.index];
            const freeSerials = item.serials.filter((serial) => !item.returnedSerials.some((done) => done.toLowerCase() === serial.toLowerCase()));
            return (
              <div className="return-item" key={item.index}>
                <div className="return-item-head">
                  <strong>{item.name}</strong>
                  <small>{item.sku} · pago {currency.format(item.unitAmount)} cada · vendido {item.quantity}{item.returnedQuantity > 0 ? ` · já devolvido ${item.returnedQuantity}` : ''}</small>
                </div>
                {available <= 0 ? (
                  <small className="empty-state">Já devolvido por completo.</small>
                ) : item.serials.length > 0 ? (
                  <div className="return-serials">
                    {freeSerials.map((serial) => (
                      <label key={serial} className="return-serial">
                        <input type="checkbox" checked={line?.serials.includes(serial) ?? false} onChange={() => toggleSerial(item.index, serial)} />
                        S/N {serial}
                      </label>
                    ))}
                  </div>
                ) : (
                  <label className="return-qty">
                    Quantidade devolvida
                    <select value={line?.quantity ?? 0} onChange={(event) => setLine(item.index, { quantity: Number(event.target.value) })}>
                      {Array.from({ length: available + 1 }, (_, value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                )}
                {line && line.quantity > 0 && (
                  <label className="return-qty">
                    Destino do produto
                    <select value={line.destination} onChange={(event) => setLine(item.index, { destination: event.target.value as ReturnDestination })}>
                      <option value="ESTOQUE">Volta para o estoque</option>
                      <option value="AVARIADO">Avariado (fora da venda)</option>
                    </select>
                  </label>
                )}
              </div>
            );
          })}
        </div>

        <label>
          Motivo
          <input maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex.: defeito, tamanho, desistência" />
        </label>
        <label>
          O cliente recebe
          <select value={method} onChange={(event) => setMethod(event.target.value as RefundMethod)}>
            {REFUND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          CPF do cliente{needsCustomer ? '' : ' (opcional)'}
          <input inputMode="numeric" placeholder="000.000.000-00" value={cpf} onChange={(event) => setCpf(maskCpf(event.target.value))} />
          {cpfDigits.length === 11 && !isValidCpf(cpf) && <small className="field-error">CPF inválido.</small>}
        </label>
        {needsAddress && (
          <button className="customer-pick" type="button" onClick={() => void openCustomerForm()} disabled={busy || cpfDigits.length !== 11}>
            Completar cadastro do cliente (endereço para a NF-e)
          </button>
        )}
        {needsPassword && (
          <label>
            Senha Gerente
            <input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
        )}

        {error && <p className="field-error">{error}</p>}
        <div className="reservation-modal-summary">
          <span>Total devolvido</span><strong>{currency.format(total)}</strong>
        </div>
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={onClose} disabled={busy}>Voltar</button>
          <button
            className="primary-action modal-confirm"
            type="button"
            onClick={() => void submit()}
            disabled={busy || selected.length === 0 || !reason.trim() || !cpfOk || !serialsOk || (needsPassword && !password)}
          >
            {busy ? 'Registrando...' : method === 'TROCA' ? 'Confirmar e escolher produtos' : 'Confirmar devolução'}
          </button>
        </div>
      </section>
      {customerForm && (
        <CustomerFormModal
          customer={customerForm.customer}
          initialCpf={cpfDigits}
          onSaved={(customer) => {
            setCustomerForm(null);
            setCpf(maskCpf(customer.cpf));
            setNeedsAddress(!(customer.address && customer.addressNumber && customer.district && customer.city && customer.state && customer.cep));
            setError(null);
          }}
          onClose={() => setCustomerForm(null)}
        />
      )}
    </div>
  );
}
