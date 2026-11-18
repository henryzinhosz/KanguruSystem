import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Copy, UserRound } from 'lucide-react';
import type { PosCustomer } from '../services/supabase/customers';
import type { PosSeller } from '../services/supabase/sellers';
import type { PosStoreProfile } from '../services/supabase/terminal';
import {
  getPhoneTradeInTable,
  PHONE_CHECKLIST,
  phoneValues,
  registerTradeIn,
  type PhoneChecklistKey,
  type PhoneGrade,
  type PhoneTable,
  type TradeInCondition,
  type TradeInDevice,
  type TradeInPayment,
  type TradeInRecord,
} from '../services/supabase/tradeIns';
import { CustomerFormModal, CustomerPickerModal } from './CustomerModals';
import { copyText } from './quotePrint';
import { formatCpf } from './reservationVoucher';
import { printTradeInTerm } from './tradeInTermPrint';
import ValueInput from './ValueInput';

// Troca Gamer: o vendedor registra a compra do videogame ou iPhone usado, o termo sai
// impresso em duas vias e a troca fica "Aguardando" no ERP para o dono conferir e estocar.
// iPhone: valor pela tabela da empresa (ERP); acima da tabela pede a senha Gerente.

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const PAYMENT_OPTIONS: { value: TradeInPayment; label: string }[] = [
  { value: 'VALE', label: 'Abater em compra (vale-troca no CPF)' },
  { value: 'DINHEIRO', label: 'Pagar em dinheiro (sai do caixa)' },
  { value: 'PIX', label: 'Pagar por Pix' },
];

const CONDITIONS: TradeInCondition[] = ['Excelente', 'Bom', 'Com defeito'];

export const PHONE_GRADES: { grade: PhoneGrade; title: string; text: string }[] = [
  { grade: 'A', title: 'A · Excelente', text: 'Sem arranhões nem marcas de uso. Tela e traseira inteiras. Botões funcionando.' },
  { grade: 'B', title: 'B · Bom', text: 'Arranhões leves e pequenos riscos. Marcas de uso na tela ou traseira. Botões funcionando.' },
  { grade: 'C', title: 'C · Com defeito', text: 'Arranhões profundos, tela ou traseira quebrada, botões com problema ou não liga.' },
];

const emptyChecklist = (): Record<PhoneChecklistKey, boolean> =>
  Object.fromEntries(PHONE_CHECKLIST.map((item) => [item.key, false])) as Record<PhoneChecklistKey, boolean>;

export interface TradeInDone {
  record: TradeInRecord;
  useVoucherNow: boolean;
}

interface TradeInPanelProps {
  // Troca Gamer = videogame; Troca Phone = iPhone (botoes separados no menu).
  device: TradeInDevice;
  seller: PosSeller | null;
  sellerSlot: ReactNode;
  loadStore: () => Promise<PosStoreProfile | null>;
  onPaidCash: () => void;
  onDone: (result: TradeInDone) => void;
}

export function TradeInPanel({ device, seller, sellerSlot, loadStore, onPaidCash, onDone }: TradeInPanelProps) {
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
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<TradeInRecord | null>(null);

  // iPhone
  const [phoneTable, setPhoneTable] = useState<PhoneTable | null>(null);
  const [phoneTableError, setPhoneTableError] = useState<string | null>(null);
  const [family, setFamily] = useState('');
  const [modelId, setModelId] = useState('');
  const [grade, setGrade] = useState<PhoneGrade | null>(null);
  const [battery, setBattery] = useState<number | null>(null);
  const [checklist, setChecklist] = useState(emptyChecklist);

  const isPhone = device === 'IPHONE';
  const title = isPhone ? 'Troca Phone' : 'Troca Gamer';

  useEffect(() => {
    if (!isPhone || phoneTable) return;
    let active = true;
    setPhoneTableError(null);
    getPhoneTradeInTable()
      .then((table) => { if (active) setPhoneTable(table); })
      .catch(() => { if (active) setPhoneTableError('Não foi possível carregar a tabela de iPhone. Confira a internet e tente de novo.'); });
    return () => { active = false; };
  }, [isPhone, phoneTable]);

  const families = useMemo(
    () => Array.from(new Set((phoneTable?.models ?? []).map((model) => model.modelName))),
    [phoneTable],
  );
  const storages = useMemo(
    () => (phoneTable?.models ?? []).filter((model) => model.modelName === family),
    [phoneTable, family],
  );
  const phoneModel = phoneTable?.models.find((model) => model.id === modelId) ?? null;
  const batteryOk = battery != null && Number.isInteger(battery) && battery >= 0 && battery <= 100;
  const values = phoneModel && grade && phoneTable && batteryOk
    ? phoneValues(phoneModel, grade, battery, phoneTable.bonusPercent)
    : null;
  const tableValue = values ? (payment === 'VALE' ? values.creditValue : values.cashValue) : null;
  const aboveTable = isPhone && tableValue != null && amount != null && amount > tableValue;
  const checklistOk = PHONE_CHECKLIST.every((item) => checklist[item.key]);

  // Valor da troca acompanha a tabela sempre que a avaliacao ou a forma mudam.
  useEffect(() => {
    if (isPhone) setAmount(tableValue && tableValue > 0 ? tableValue : null);
  }, [isPhone, tableValue]);

  const needsPassword = payment !== 'VALE' || aboveTable;
  const imeiOk = isPhone ? /^\d{15}$/.test(imei) : imei === '' || /^\d{15}$/.test(imei);
  const deviceOk = isPhone ? Boolean(values && checklistOk) : Boolean(description.trim());
  const ready = Boolean(customer && deviceOk && serialNumber.trim() && amount && amount > 0 && seller && imeiOk
    && (!needsPassword || password));


  function pickFamily(next: string) {
    setFamily(next);
    const first = (phoneTable?.models ?? []).find((model) => model.modelName === next);
    setModelId(first?.id ?? '');
  }

  async function copyProposal() {
    if (!phoneModel || !grade || !values || battery == null || !phoneTable) return;
    const store = await loadStore();
    const gradeInfo = PHONE_GRADES.find((item) => item.grade === grade);
    const text = [
      `*Avaliação do seu iPhone${store?.tradeName ? ` - ${store.tradeName}` : ''}*`,
      `Aparelho: ${phoneModel.modelName} ${phoneModel.storage}`,
      `Estado: ${gradeInfo?.title ?? grade}`,
      `Bateria: ${battery}%`,
      '',
      '*Proposta*',
      `Pix ou dinheiro: ${currency.format(values.cashValue)}`,
      `Crédito na loja: ${currency.format(values.creditValue)}${phoneTable.bonusPercent > 0 ? ` (+${phoneTable.bonusPercent.toLocaleString('pt-BR')}% de bônus)` : ''}`,
      '',
      'Proposta válida por 7 dias, sujeita à conferência do aparelho na loja.',
    ].join('\n');
    try {
      await copyText(text);
      setMessage('Proposta copiada. É só colar no WhatsApp do cliente.');
    } catch {
      setMessage('Não foi possível copiar a proposta.');
    }
  }

  async function submit() {
    if (!customer || !seller || !amount) return;
    if (isPhone && (!phoneModel || !grade || battery == null)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await registerTradeIn({
        customerCpf: customer.cpf,
        document: document.trim(),
        description: isPhone && phoneModel ? `${phoneModel.modelName} ${phoneModel.storage}` : description.trim(),
        serialNumber: serialNumber.trim(),
        imei,
        accessories: accessories.trim(),
        condition: isPhone ? (grade === 'A' ? 'Excelente' : grade === 'B' ? 'Bom' : 'Com defeito') : condition,
        amount,
        paymentMethod: payment,
        sellerCode: seller.code,
        adminPassword: needsPassword ? password : null,
        evaluation: isPhone && phoneModel && grade && battery != null
          ? { modelId: phoneModel.id, grade, battery, checklist }
          : null,
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
          ? `Senha Gerente incorreta. Restam ${result.remainingAttempts} tentativa(s).`
          : 'Senha Gerente incorreta. Terminal bloqueado temporariamente para senha.');
      } else if (result.status === 'LOCKED') {
        setPassword('');
        setError('Senha Gerente bloqueada por excesso de tentativas. Aguarde alguns minutos.');
      } else if (result.status === 'PASSWORD_REQUIRED') {
        setError(result.aboveTable
          ? 'O valor está acima da tabela: digite a senha Gerente.'
          : 'Digite a senha Gerente para pagar em dinheiro ou Pix.');
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
        <h1>{title} nº {done.tradeNumber} registrada</h1>
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
      <h1>{title}</h1>
      <p className="modal-copy">Compra de {isPhone ? 'iPhone usado' : 'videogame usado'} do cliente. Ao confirmar, o termo sai impresso em duas vias e a troca vai para o ERP conferir e estocar.</p>


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

      {isPhone ? (
        <>
          <h2 className="trade-in-section">iPhone</h2>
          {phoneTableError && <p className="field-error">{phoneTableError} <button className="text-action" type="button" onClick={() => { setPhoneTableError(null); setPhoneTable(null); }}>Tentar de novo</button></p>}
          {!phoneTable && !phoneTableError && <p className="modal-copy">Carregando a tabela de iPhone...</p>}
          {phoneTable && phoneTable.models.length === 0 && (
            <p className="field-error">A tabela de iPhone está vazia. Peça ao dono para carregar a tabela no ERP (Troca Gamer › Tabela de iPhone).</p>
          )}
          {phoneTable && phoneTable.models.length > 0 && (
            <>
              <div className="trade-in-grid">
                <label>
                  Modelo
                  <select value={family} onChange={(event) => pickFamily(event.target.value)}>
                    <option value="">Escolha o modelo</option>
                    {families.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label>
                  Memória
                  <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={!family}>
                    {!family && <option value="">—</option>}
                    {storages.map((model) => <option key={model.id} value={model.id}>{model.storage}</option>)}
                  </select>
                </label>
              </div>

              <span className="trade-in-label">Estado</span>
              <div className="trade-in-grades" role="radiogroup" aria-label="Estado do iPhone">
                {PHONE_GRADES.map((item) => (
                  <button
                    key={item.grade}
                    type="button"
                    role="radio"
                    aria-checked={grade === item.grade}
                    className={grade === item.grade ? 'is-active' : ''}
                    onClick={() => setGrade(item.grade)}
                    disabled={busy}
                  >
                    <strong>{item.title}</strong>
                    <small>{item.text}</small>
                  </button>
                ))}
              </div>

              <div className="trade-in-grid">
                <label>
                  Saúde da bateria (%)
                  <ValueInput decimals={0} maxLength={3} value={battery} onValueChange={setBattery} />
                  {battery != null && !batteryOk && <small className="field-error">De 0 a 100.</small>}
                  {phoneModel && batteryOk && battery <= 84 && phoneModel.batteryDeduction > 0 && (
                    <small className="trade-in-hint">84% ou menos: desconta {currency.format(phoneModel.batteryDeduction)} da troca de bateria.</small>
                  )}
                </label>
                <label>
                  Itens que acompanham
                  <input maxLength={200} placeholder="Ex.: caixa, cabo, capinha" value={accessories} onChange={(event) => setAccessories(event.target.value)} />
                </label>
              </div>
            </>
          )}
          <div className="trade-in-grid">
            <label>
              Nº de série
              <input maxLength={60} value={serialNumber} onChange={(event) => setSerialNumber(event.target.value.toUpperCase())} />
            </label>
            <label>
              IMEI
              <input inputMode="numeric" maxLength={15} value={imei} onChange={(event) => setImei(event.target.value.replace(/\D/g, '').slice(0, 15))} />
              {imei !== '' && !imeiOk && <small className="field-error">IMEI tem 15 números.</small>}
            </label>
          </div>

          <span className="trade-in-label">Conferência obrigatória</span>
          <div className="trade-in-checklist">
            {PHONE_CHECKLIST.map((item) => (
              <label key={item.key} className="trade-in-check">
                <input
                  type="checkbox"
                  checked={checklist[item.key]}
                  onChange={(event) => setChecklist((current) => ({ ...current, [item.key]: event.target.checked }))}
                  disabled={busy}
                />
                {item.label}
              </label>
            ))}
          </div>

          {values && phoneTable && (
            <div className="trade-in-offer">
              <div>
                <small>Pix ou dinheiro</small>
                <strong>{currency.format(values.cashValue)}</strong>
              </div>
              <div>
                <small>Vale-troca{phoneTable.bonusPercent > 0 ? ` (+${phoneTable.bonusPercent.toLocaleString('pt-BR')}%)` : ''}</small>
                <strong>{currency.format(values.creditValue)}</strong>
              </div>
              <button className="text-action" type="button" onClick={() => void copyProposal()} disabled={busy}>
                <Copy size={16} /> Copiar proposta para WhatsApp
              </button>
            </div>
          )}
        </>
      ) : (
        <>
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
        </>
      )}

      <h2 className="trade-in-section">Valor</h2>
      <div className="trade-in-grid">
        <label>
          Valor da troca (R$)
          <ValueInput value={amount} onValueChange={setAmount} />
          {isPhone && tableValue != null && (
            <small className={aboveTable ? 'field-error' : 'trade-in-hint'}>
              {aboveTable
                ? `Acima da tabela (${currency.format(tableValue)}): pede a senha Gerente.`
                : `Tabela: ${currency.format(tableValue)}. Pode oferecer menos.`}
            </small>
          )}
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
          Senha Gerente
          <input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
      )}
      {sellerSlot}

      {message && <p className="modal-copy">{message}</p>}
      {error && <p className="field-error">{error}</p>}
      {isPhone && values && !checklistOk && <p className="trade-in-hint">Marque todos os itens da conferência para concluir.</p>}
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
