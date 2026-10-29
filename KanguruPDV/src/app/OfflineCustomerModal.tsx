import { useState } from 'react';
import { X } from 'lucide-react';
import type { PosCustomer } from '../services/supabase/customers';
import { isValidCpf, maskCpf } from './cpf';

// Sem internet nao da para buscar/cadastrar clientes: o vendedor digita CPF e nome, que vao
// na venda (e na NFC-e). O cadastro completo fica para quando a internet voltar.

export function OfflineCustomerModal({ onConfirm, onClose }: {
  onConfirm: (customer: PosCustomer) => void;
  onClose: () => void;
}) {
  const [cpf, setCpf] = useState('');
  const [name, setName] = useState('');
  const cpfValid = isValidCpf(cpf);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="offline-customer-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Sem internet</p>
            <h2 id="offline-customer-title">Cliente da venda</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose}><X size={20} /></button>
        </div>
        <p className="modal-copy">Sem internet não dá para buscar o cadastro. Digite o CPF e o nome para sair na venda.</p>
        <label>
          CPF
          <input autoFocus inputMode="numeric" placeholder="000.000.000-00" value={cpf} onChange={(event) => setCpf(maskCpf(event.target.value))} />
          {cpf.replace(/\D/g, '').length === 11 && !cpfValid && <small className="field-error">CPF inválido.</small>}
        </label>
        <label>
          Nome
          <input maxLength={160} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={onClose}>Voltar</button>
          <button
            className="primary-action modal-confirm"
            type="button"
            disabled={!cpfValid || !name.trim()}
            onClick={() => onConfirm({
              id: 'offline',
              code: 0,
              cpf: cpf.replace(/\D/g, ''),
              name: name.trim(),
              phone: '',
              email: null,
              cep: null,
              address: null,
              addressNumber: null,
              complement: null,
              district: null,
              city: null,
              state: null,
              lgpdConsent: false,
              notes: null,
            })}
          >
            Usar na venda
          </button>
        </div>
      </section>
    </div>
  );
}
