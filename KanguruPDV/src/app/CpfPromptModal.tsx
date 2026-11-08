import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { isValidCpf, maskCpf } from './cpf';

// Nota fiscal sem cliente selecionado: pergunta so o CPF. Nao cria cadastro; o CPF fica
// gravado na venda e sai na NFC-e. Esc e tratado no App (volta para a venda).

export function CpfPromptModal({ onConfirm, onSkip, onClose }: {
  onConfirm: (cpf: string) => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const [cpf, setCpf] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValidCpf(cpf)) {
      setError(cpf.trim() ? 'CPF inválido. Confira os números.' : 'Digite o CPF ou escolha Sem CPF.');
      return;
    }
    onConfirm(cpf.replace(/\D/g, ''));
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="cpf-prompt-title" onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Nota fiscal</p>
            <h2 id="cpf-prompt-title">CPF na nota?</h2>
          </div>
          <button className="icon-button" type="button" title="Voltar para a venda" onClick={onClose}><X size={20} /></button>
        </div>
        <label>
          CPF do cliente
          <input
            autoFocus
            inputMode="numeric"
            placeholder="000.000.000-00"
            value={cpf}
            onChange={(event) => {
              setCpf(maskCpf(event.target.value));
              setError(null);
            }}
          />
          {error && <small className="field-error">{error}</small>}
        </label>
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={onSkip}>Sem CPF</button>
          <button className="primary-action modal-confirm" type="submit">Emitir com CPF</button>
        </div>
      </form>
    </div>
  );
}
