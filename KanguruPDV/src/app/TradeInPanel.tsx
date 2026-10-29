import { useState, type ReactNode } from 'react';
import { UserRound } from 'lucide-react';
import type { PosCustomer } from '../services/supabase/customers';
import type { PosSeller } from '../services/supabase/sellers';
import type { PosStoreProfile } from '../services/supabase/terminal';
import {
  registerTradeIn,
  type TradeInCondition,
  type TradeInPayment,
  type TradeInRecord,
} from '../services/supabase/tradeIns';
import { CustomerFormModal, CustomerPickerModal } from './CustomerModals';
import { formatCpf } from './reservationVoucher';
import { printTradeInTerm } from './tradeInTermPrint';
import ValueInput from './ValueInput';

// Troca Gamer: o vendedor registra a compra do videogame usado, o termo sai impresso
// em duas vias e a troca fica "Aguardando" no ERP para o dono conferir e estocar.

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const PAYMENT_OPTIONS: { value: TradeInPayment; label: string }[] = [
  { value: 'VALE', label: 'Abater em compra (vale-troca no CPF)' },
  { value: 'DINHEIRO', label: 'Pagar em dinheiro (sai do caixa)' },
  { value: 'PIX', label: 'Pagar por Pix' },
];

const CONDITIONS: TradeInCondition[] = ['Excelente', 'Bom', 'Com defeito'];

export interface TradeInDone {
  record: TradeInRecord;
  useVoucherNow: boolean;
}

interface TradeInPanelProps {
  seller: PosSeller | null;
  sellerSlot: ReactNode;
  loadStore: () => Promise<PosStoreProfile | null>;
  onPaidCash: () => void;
  onDone: (result: TradeInDone) => void;
}

export function TradeInPanel({ seller, sellerSlot, loadStore, onPaidCash, onDone }: TradeInPanelProps) {
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [picker, setPicker] = useState(false);
  const [customerForm, setCustomerForm] = useState<{ customer: PosCustomer | null; cpf: string } | null>(null);
  const [document, setDocument] = useState('');
  const [description, setDescription] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [imei, setImei] = useState('');
  const [accessories, setAccessories] = useState('');
  const [condition, setCondition] = useState<TradeInCondition>('Excelente');
  const [amount, setAmount] = useState<number | null>(null);
  const [payment, setPayment] = useState<TradeInPayment>('VALE');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<TradeInRecord | null>(null);

  const needsPassword = payment !== 'VALE';
  const imeiOk = imei === '' || /^\d{15}$/.test(imei);
  const ready = Boolean(customer && description.trim() && serialNumber.trim() && amount && amount > 0 && seller && imeiOk
    && (!needsPassword || password));

  async function submit() {
    if (!customer || !seller || !amount) return;
    setBusy(true);
    setError(null);
    try {
      const result = await registerTradeIn({
        customerCpf: customer.cpf,
        document: document.trim(),
        description: description.trim(),
        serialNumber: serialNumber.trim(),
        imei,
        accessories: accessories.trim(),
        condition,
        amount,
        paymentMethod: payment,
        sellerCode: seller.code,
        adminPassword: needsPassword ? password : null,
      });
      if (result.status === 'OK') {
        setPassword('');
        setDone(result);
        if (result.paymentMethod === 'DINHEIRO') onPaidCash();
        void printTradeInTerm(result, await loadStore());
        return;
      }
      if (result.status === 'INVALID_PASSWORD') {
        setPassword('');
        setError(result.remainingAttempts > 0
          ? `Senha administrativa incorreta. Restam ${result.remainingAttempts} tentativa(s).`
          : 'Senha administrativa incorreta. Terminal bloqueado temporariamente para senha.');
      } else if (result.status === 'LOCKED') {
        setPassword('');
        setError('Senha administrativa bloqueada por excesso de tentativas. Aguarde alguns minutos.');
      } else if (result.status === 'PASSWORD_REQUIRED') {
        setError('Digite a senha administrativa para pagar em dinheiro ou Pix.');
      } else if (result.status === 'CUSTOMER_REQUIRED') {
        setError('Cliente não encontrado no cadastro. Selecione ou cadastre o cliente.');
      } else if (result.status === 'INVALID_SELLER') {
        setError('Código do vendedor não encontrado nesta loja.');
      } else if (result.status === 'SERIAL_EXISTS') {
        setError('Este número de série já está no estoque ou em outra Troca Gamer aguardando. Confira o serial.');
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Não foi possível registrar a Troca Gamer.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="reservations-panel trade-in-panel">
        <h1>Troca Gamer nº {done.tradeNumber} registrada</h1>
        <p className="modal-copy">
          {done.description} (S/N {done.serialNumber}) comprado de {done.customerName} por <strong>{currency.format(done.amount)}</strong>.
          {' '}{done.paymentMethod === 'VALE'
            ? 'O valor virou vale-troca no CPF do cliente.'
            : done.paymentMethod === 'DINHEIRO'
              ? 'O dinheiro saiu do caixa (entra no fechamento como sangria).'
              : 'Faça o Pix para o cliente.'}
          {' '}O termo foi enviado para a impressora: colha a assinatura do cliente na via da loja.
        </p>
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={() => void loadStore().then((store) => printTradeInTerm(done, store))}>
            Imprimir o termo de novo
          </button>
          {done.paymentMethod === 'VALE' ? (
            <>
              <button className="text-action" type="button" onClick={() => onDone({ record: done, useVoucherNow: false })}>Concluir</button>
              <button className="primary-action modal-confirm" type="button" onClick={() => onDone({ record: done, useVoucherNow: true })}>
                Usar o vale agora numa venda
              </button>
            </>
          ) : (
            <button className="primary-action modal-confirm" type="button" onClick={() => onDone({ record: done, useVoucherNow: false })}>Concluir</button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="reservations-panel trade-in-panel">
      <h1>Troca Gamer</h1>
      <p className="modal-copy">Compra de videogame usado do cliente. Ao confirmar, o termo sai impresso em duas vias e a troca vai para o ERP conferir e estocar.</p>

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
      <label>
        RG ou CNH nº (opcional)
        <input maxLength={30} value={document} onChange={(event) => setDocument(event.target.value)} />
      </label>

      <h2 className="trade-in-section">Videogame</h2>
      <label>
        Modelo
        <input maxLength={120} placeholder="Ex.: PS4 Slim 500GB" value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <div className="trade-in-grid">
        <label>
          Nº de série
          <input maxLength={60} value={serialNumber} onChange={(event) => setSerialNumber(event.target.value.toUpperCase())} />
        </label>
        <label>
          IMEI (opcional)
          <input inputMode="numeric" maxLength={15} value={imei} onChange={(event) => setImei(event.target.value.replace(/\D/g, '').slice(0, 15))} />
          {!imeiOk && <small className="field-error">IMEI tem 15 números.</small>}
        </label>
      </div>
      <label>
        Itens que acompanham
        <input maxLength={200} placeholder="Ex.: 2 controles, base carregadora, cabos" value={accessories} onChange={(event) => setAccessories(event.target.value)} />
      </label>
      <label>
        Estado
        <select value={condition} onChange={(event) => setCondition(event.target.value as TradeInCondition)}>
          {CONDITIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>

      <h2 className="trade-in-section">Valor</h2>
      <div className="trade-in-grid">
        <label>
          Valor da troca (R$)
          <ValueInput value={amount} onValueChange={setAmount} />
        </label>
        <label>
          Forma
          <select value={payment} onChange={(event) => { setPayment(event.target.value as TradeInPayment); setPassword(''); }}>
            {PAYMENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {needsPassword && (
        <label>
          Senha administrativa
          <input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
      )}
      {sellerSlot}

      {error && <p className="field-error">{error}</p>}
      <div className="modal-actions">
        <button className="primary-action modal-confirm" type="button" onClick={() => void submit()} disabled={busy || !ready}>
          {busy ? 'Registrando...' : `Confirmar e imprimir termo${amount ? ` (${currency.format(amount)})` : ''}`}
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
