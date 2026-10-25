import { FormEvent, useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import {
  lookupCep,
  savePosCustomer,
  searchPosCustomers,
  type PosCustomer,
} from '../services/supabase/customers';
import { isValidCpf, maskCpf } from './cpf';
import { formatCpf } from './reservationVoucher';

function customerErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : 'Ocorreu um erro inesperado.';
  if (message.includes('Customer CPF already registered')) {
    return 'Já existe um cliente com este CPF. Busque pelo CPF na lista de clientes.';
  }
  if (message.includes('LGPD consent answer is required')) {
    return 'Responda o consentimento LGPD do cliente.';
  }
  return message;
}

function maskCep(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

// ---- Lista de clientes: busca por CPF, codigo ou nome ----
export function CustomerPickerModal({ onSelect, onNew, onClose }: {
  onSelect: (customer: PosCustomer) => void;
  onNew: (cpf: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PosCustomer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await searchPosCustomers(query.trim()));
    } catch (searchError) {
      setError(customerErrorMessage(searchError));
    } finally {
      setBusy(false);
    }
  }

  const typedCpf = query.replace(/\D/g, '').length === 11 ? query : '';

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal customer-modal" role="dialog" aria-modal="true" aria-labelledby="customer-picker-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Cliente da venda</p>
            <h2 id="customer-picker-title">Lista de clientes</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose}><X size={20} /></button>
        </div>
        <form className="search-form" onSubmit={(event) => void search(event)}>
          <input autoFocus placeholder="CPF, código ou nome do cliente" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="icon-button search-button" type="submit" disabled={busy} title="Buscar clientes"><Search size={21} /></button>
        </form>
        {error && <p className="field-error">{error}</p>}
        <div className="product-list customer-results">
          {results?.map((customer) => (
            <button key={customer.id} className="product-row" type="button" onClick={() => onSelect(customer)}>
              <span>
                <strong>{customer.name}</strong>
                <small>CPF {formatCpf(customer.cpf)} | Código {customer.code}</small>
              </span>
              <span>
                <small>{customer.phone}</small>
                {customer.city && <small>{customer.city}{customer.state ? `/${customer.state}` : ''}</small>}
              </span>
            </button>
          ))}
          {results && results.length === 0 && !busy && (
            <p className="empty-state">Nenhum cliente encontrado. Cadastre um novo.</p>
          )}
        </div>
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={onClose}>Voltar</button>
          <button className="primary-action modal-confirm" type="button" onClick={() => onNew(typedCpf)}>
            <UserPlus size={18} /> Novo cliente
          </button>
        </div>
      </section>
    </div>
  );
}

// ---- Cadastro / correcao de contato. CPF e nome so mudam no ERP. ----
export function CustomerFormModal({ customer, initialCpf, onSaved, onClose }: {
  customer: PosCustomer | null;
  initialCpf: string;
  onSaved: (customer: PosCustomer) => void;
  onClose: () => void;
}) {
  const editing = customer !== null;
  const [cpf, setCpf] = useState(maskCpf(customer?.cpf ?? initialCpf));
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [cep, setCep] = useState(maskCep(customer?.cep ?? ''));
  const [address, setAddress] = useState(customer?.address ?? '');
  const [addressNumber, setAddressNumber] = useState(customer?.addressNumber ?? '');
  const [complement, setComplement] = useState(customer?.complement ?? '');
  const [district, setDistrict] = useState(customer?.district ?? '');
  const [city, setCity] = useState(customer?.city ?? '');
  const [state, setState] = useState(customer?.state ?? '');
  const [consent, setConsent] = useState<'' | 'SIM' | 'NAO'>(customer ? (customer.lgpdConsent ? 'SIM' : 'NAO') : '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [cepStatus, setCepStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cpfComplete = cpf.replace(/\D/g, '').length === 11;
  const cpfValid = isValidCpf(cpf);

  async function changeCep(value: string) {
    const masked = maskCep(value);
    setCep(masked);
    setCepStatus(null);
    if (masked.replace(/\D/g, '').length !== 8) return;
    setCepStatus('Buscando endereço...');
    try {
      const found = await lookupCep(masked);
      if (!found) {
        setCepStatus('CEP não encontrado. Preencha o endereço à mão.');
        return;
      }
      setAddress(found.address);
      setDistrict(found.district);
      setCity(found.city);
      setState(found.state);
      setCepStatus(null);
    } catch {
      setCepStatus('Não foi possível consultar o CEP agora. Preencha o endereço à mão.');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!editing && !cpfValid) { setError('CPF inválido. Confira os números.'); return; }
    if (!name.trim() || !phone.trim()) { setError('Informe nome e celular do cliente.'); return; }
    if (!consent) { setError('Responda o consentimento LGPD do cliente.'); return; }
    setBusy(true);
    try {
      const saved = await savePosCustomer({
        id: customer?.id ?? null,
        cpf: cpf.replace(/\D/g, ''),
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim() || null,
        cep: cep.replace(/\D/g, '') || null,
        address: address.trim() || null,
        addressNumber: addressNumber.trim() || null,
        complement: complement.trim() || null,
        district: district.trim() || null,
        city: city.trim() || null,
        state: state.trim().toUpperCase() || null,
        lgpdConsent: consent === 'SIM',
        notes: notes.trim() || null,
      });
      onSaved(saved);
    } catch (saveError) {
      setError(customerErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal customer-modal" role="dialog" aria-modal="true" aria-labelledby="customer-form-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">{editing ? `Cliente código ${customer.code}` : 'Novo cadastro'}</p>
            <h2 id="customer-form-title">{editing ? 'Corrigir contato e endereço' : 'Cadastrar cliente'}</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose} disabled={busy}><X size={20} /></button>
        </div>
        {editing && <p className="modal-copy">CPF e nome só podem ser alterados no ERP.</p>}
        <form onSubmit={(event) => void submit(event)}>
          <div className="customer-form-grid">
            <label>
              CPF
              <input autoFocus={!editing} required readOnly={editing} inputMode="numeric" placeholder="000.000.000-00"
                value={cpf} onChange={(event) => setCpf(maskCpf(event.target.value))} />
              {!editing && cpfComplete && !cpfValid && <small className="field-error">CPF inválido. Confira os números.</small>}
            </label>
            <label className="span-2">
              Nome completo
              <input required readOnly={editing} maxLength={160} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              Celular
              <input autoFocus={editing} required type="tel" maxLength={40} value={phone} onChange={(event) => setPhone(event.target.value)} />
            </label>
            <label className="span-2">
              E-mail (opcional)
              <input type="email" maxLength={160} value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label>
              CEP
              <input inputMode="numeric" placeholder="00000-000" value={cep} onChange={(event) => void changeCep(event.target.value)} />
              {cepStatus && <small className="field-hint">{cepStatus}</small>}
            </label>
            <label className="span-2">
              Endereço
              <input maxLength={200} value={address} onChange={(event) => setAddress(event.target.value)} />
            </label>
            <label>
              Número
              <input maxLength={20} value={addressNumber} onChange={(event) => setAddressNumber(event.target.value)} />
            </label>
            <label className="span-2">
              Complemento
              <input maxLength={100} value={complement} onChange={(event) => setComplement(event.target.value)} />
            </label>
            <label>
              Bairro
              <input maxLength={100} value={district} onChange={(event) => setDistrict(event.target.value)} />
            </label>
            <label>
              Cidade
              <input maxLength={100} value={city} onChange={(event) => setCity(event.target.value)} />
            </label>
            <label>
              UF
              <input maxLength={2} value={state} onChange={(event) => setState(event.target.value.toUpperCase())} />
            </label>
            <label className="span-3">
              Consentimento (LGPD - Lei nº 13.709)
              <select required value={consent} onChange={(event) => setConsent(event.target.value as '' | 'SIM' | 'NAO')}>
                <option value="">Selecione</option>
                <option value="SIM">Sim, o cliente autoriza o uso dos dados</option>
                <option value="NAO">Não autoriza</option>
              </select>
            </label>
            <label className="span-3">
              Observação (opcional)
              <textarea rows={2} maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
          </div>
          {error && <p className="field-error">{error}</p>}
          <div className="modal-actions">
            <button className="text-action" type="button" onClick={onClose} disabled={busy}>Voltar</button>
            <button className="primary-action modal-confirm" type="submit" disabled={busy || (!editing && !cpfValid)}>
              {busy ? 'Salvando...' : editing ? 'Salvar alterações' : 'Cadastrar cliente'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
