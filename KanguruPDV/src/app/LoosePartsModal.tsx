import { FormEvent, useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import ValueInput from './ValueInput';
import { LOOSE_PART_TYPES, createPosLooseParts, type LoosePartDraft } from '../services/supabase/looseParts';
import type { PosCatalogItem } from '../services/supabase/products';

// Peças avulsas - PC (desenho aprovado em 2026-11-22): o vendedor informa tipo, nome e preço de cada
// peça; elas entram no carrinho como produtos normais. O custo é informado depois, no ERP.

interface Line {
  key: number;
  type: string;
  name: string;
  price: number | null;
  warrantyMonths: number | null;
}

let nextKey = 1;
const emptyLine = (): Line => ({ key: nextKey++, type: 'Processador', name: '', price: null, warrantyMonths: 3 });
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

interface Props {
  onAdded: (items: PosCatalogItem[]) => void;
  onClose: () => void;
}

export function LoosePartsModal({ onAdded, onClose }: Props) {
  const [lines, setLines] = useState<Line[]>(() => [emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const update = (key: number, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const total = lines.reduce((sum, line) => sum + (line.price ?? 0), 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const parts: LoosePartDraft[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.name.trim()) return setError(`Peça ${index + 1}: informe o nome.`);
      if (!line.price || line.price <= 0) return setError(`Peça ${index + 1}: informe o preço de venda.`);
      parts.push({ type: line.type, name: line.name.trim(), price: line.price, warrantyMonths: line.warrantyMonths ?? 3 });
    }
    setBusy(true);
    try {
      onAdded(await createPosLooseParts(parts));
    } catch (err) {
      setError((err as { message?: string })?.message || 'Não foi possível adicionar as peças.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="serial-unit-modal loose-parts-modal" role="dialog" aria-modal="true" aria-labelledby="loose-parts-title" onSubmit={(event) => void submit(event)}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Venda</p>
            <h2 id="loose-parts-title">Peças avulsas - PC</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose} disabled={busy}><X size={20} /></button>
        </div>
        <p className="modal-copy">Informe cada peça vendida separada. Elas entram no carrinho; o custo é preenchido depois no ERP.</p>

        <div className="loose-parts-list">
          {lines.map((line, index) => (
            <div className="loose-part-row" key={line.key}>
              <label>
                Tipo
                <select value={line.type} onChange={(event) => update(line.key, { type: event.target.value })}>
                  {LOOSE_PART_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="loose-part-name">
                Nome da peça
                <input autoFocus={index === lines.length - 1} placeholder="Ex.: AMD Ryzen 7 5700X" value={line.name} onChange={(event) => update(line.key, { name: event.target.value })} />
              </label>
              <label>
                Preço de venda
                <ValueInput value={line.price} onValueChange={(value) => update(line.key, { price: value })} />
              </label>
              <label>
                Garantia (meses)
                <ValueInput decimals={0} value={line.warrantyMonths} onValueChange={(value) => update(line.key, { warrantyMonths: value })} />
              </label>
              <button className="icon-button" type="button" title="Remover peça" disabled={lines.length === 1}
                onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>

        <button className="text-action" type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
          <Plus size={15} /> Adicionar outra peça
        </button>

        {error && <p className="payment-lines-error">{error}</p>}

        <div className="modal-actions">
          <span className="loose-parts-total">Total: <strong>{currency.format(total)}</strong></span>
          <button className="text-action" type="button" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="primary-action modal-confirm" type="submit" disabled={busy}>{busy ? 'Adicionando...' : 'Adicionar ao carrinho'}</button>
        </div>
      </form>
    </div>
  );
}
