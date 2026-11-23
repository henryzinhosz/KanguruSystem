import { useEffect, useState } from 'react';
import { Copy, X } from 'lucide-react';
import ValueInput from './ValueInput';
import { cardFeeConfigured, cardFeeRate, cardSurcharge, type CardFeeTable, type PaymentMethodKey } from '../services/supabase/sales';

// Calculadora de taxa (desenho aprovado em 2026-11-22): quanto cobrar em cada forma para a loja receber
// o valor cheio. Mesma tabela e mesma conta do "Repassar taxa" da venda. O vendedor NUNCA ve a % da taxa
// (so total e parcela), porque a tela pode ser mostrada ao cliente.

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export interface FeeChoice {
  method: PaymentMethodKey;
  installments: number;
}

interface Row {
  key: string;
  label: string;
  choice: FeeChoice;
  total: number | null; // null = taxa nao cadastrada no ERP
  installment: number | null;
}

function buildRows(fees: CardFeeTable | null, value: number): Row[] {
  const rows: Row[] = [
    { key: 'pix', label: 'Pix ou dinheiro', choice: { method: 'PIX', installments: 1 }, total: value, installment: null },
  ];
  // Taxa 0 cadastrada = sem acrescimo (total = valor); sem taxa cadastrada = null.
  const totalFor = (method: PaymentMethodKey, count: number) =>
    cardFeeConfigured(fees, method, count) ? value + cardSurcharge(value, cardFeeRate(fees, method, count)) : null;
  rows.push({
    key: 'debito',
    label: 'Débito',
    choice: { method: 'DEBITO', installments: 1 },
    total: totalFor('DEBITO', 1),
    installment: null,
  });
  for (let count = 1; count <= 21; count += 1) {
    const total = totalFor('CREDITO', count);
    rows.push({
      key: `credito-${count}`,
      label: `Crédito ${count}x`,
      choice: { method: 'CREDITO', installments: count },
      total,
      installment: total !== null && count > 1 ? total / count : null,
    });
  }
  return rows;
}

function whatsappText(rows: Row[], value: number): string {
  const lines = [`*Formas de pagamento* (valor ${currency.format(value)})`, ''];
  for (const row of rows) {
    if (row.total === null) continue;
    if (row.key === 'pix') lines.push(`À vista no Pix ou dinheiro: ${currency.format(row.total)}`);
    else if (row.key === 'debito') lines.push(`Débito: ${currency.format(row.total)}`);
    else if (row.choice.installments === 1) lines.push(`Crédito à vista: ${currency.format(row.total)}`);
    else lines.push(`${row.choice.installments}x de ${currency.format(row.installment ?? 0)} (total ${currency.format(row.total)})`);
  }
  return lines.join('\n');
}

interface FeeCalculatorModalProps {
  fees: CardFeeTable | null;
  // Aberta pela venda: valor que falta pagar e acao de levar a forma escolhida para o pagamento.
  initialValue?: number | null;
  onUse?: (choice: FeeChoice) => void;
  useDisabledReason?: string | null;
  onClose: () => void;
}

export function FeeCalculatorModal({ fees, initialValue, onUse, useDisabledReason, onClose }: FeeCalculatorModalProps) {
  const [value, setValue] = useState<number | null>(initialValue && initialValue > 0 ? initialValue : null);
  const [copied, setCopied] = useState(false);
  const amount = value && value > 0 ? value : 0;
  const rows = buildRows(fees, amount);
  const saleValue = initialValue && initialValue > 0 ? initialValue : 0;
  // "Usar na venda" so com o valor que falta pagar (senao o pagamento nao bate com o total).
  const canUse = Boolean(onUse) && !useDisabledReason && saleValue > 0
    && Math.round(amount * 100) === Math.round(saleValue * 100);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(whatsappText(rows, amount));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal fee-calc-modal" role="dialog" aria-modal="true" aria-labelledby="fee-calc-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Venda</p>
            <h2 id="fee-calc-title">Calculadora de taxa</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose}><X size={20} /></button>
        </div>

        <div className="fee-calc-top">
          <label>
            Valor da venda
            <ValueInput autoFocus value={value} onValueChange={setValue} />
          </label>
          <button className="reservation-nav" type="button" disabled={amount <= 0} onClick={() => void copy()}>
            <Copy size={16} /> {copied ? 'Copiado!' : 'Copiar para WhatsApp'}
          </button>
        </div>

        {!fees && <p className="modal-copy">Tabela de taxas não carregada (sem internet ou não cadastrada no ERP › Livro Caixa).</p>}
        {onUse && (
          useDisabledReason ? (
            <p className="modal-copy">{useDisabledReason}</p>
          ) : canUse ? (
            <p className="modal-copy">Toque numa forma para usar na venda (o pagamento já sai com "Repassar taxa").</p>
          ) : saleValue > 0 ? (
            <p className="modal-copy">
              Para usar na venda, o valor precisa ser o que falta pagar.{' '}
              <button className="text-action" type="button" onClick={() => setValue(saleValue)}>Voltar para {currency.format(saleValue)}</button>
            </p>
          ) : null
        )}

        <div className="fee-calc-table" role="table" aria-label="Quanto cobrar em cada forma">
          <div className="fee-calc-row fee-calc-head" role="row">
            <span role="columnheader">Forma</span>
            <span role="columnheader">Total a cobrar</span>
            <span role="columnheader">Parcela</span>
          </div>
          {rows.map((row) => {
            const clickable = canUse && row.total !== null;
            const content = (
              <>
                <span role="cell">{row.label}</span>
                <strong role="cell">{row.total === null ? <small>Taxa não cadastrada no ERP</small> : currency.format(row.total)}</strong>
                <span role="cell">{row.installment !== null ? `${row.choice.installments}x de ${currency.format(row.installment)}` : '—'}</span>
              </>
            );
            return clickable ? (
              <button key={row.key} type="button" className="fee-calc-row is-clickable" role="row" onClick={() => onUse?.(row.choice)}>
                {content}
              </button>
            ) : (
              <div key={row.key} className="fee-calc-row" role="row">{content}</div>
            );
          })}
        </div>

        <p className="fee-calc-warning">Nunca digite acréscimo na maquininha. Passe o valor do <b>Total a cobrar</b>.</p>
      </section>
    </div>
  );
}
