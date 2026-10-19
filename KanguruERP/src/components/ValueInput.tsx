import { InputHTMLAttributes, useEffect, useState } from 'react';

// Campo de valor padrao (dinheiro, percentual, quantidade): comeca vazio com uma
// dica clarinha, sem setinhas, aceita so digitos e virgula (ponto e ignorado) e
// nunca deixa um zero na frente do que foi digitado. decimals=0 => so inteiros.
// Mesmo componente no PDV (KanguruPDV/src/app/ValueInput.tsx).

export function sanitizeValueText(raw: string, decimals: number): string {
  let text = raw.replace(/[^0-9,]/g, '');
  if (decimals === 0) {
    text = text.replace(/,/g, '');
  } else {
    const comma = text.indexOf(',');
    if (comma >= 0) {
      text = text.slice(0, comma + 1) + text.slice(comma + 1).replace(/,/g, '').slice(0, decimals);
    }
  }
  text = text.replace(/^0+(?=\d)/, ''); // "05" -> "5"; "0,5" fica
  if (text.startsWith(',')) text = `0${text}`;
  return text;
}

export function parseValueText(text: string): number | null {
  if (!text) return null;
  const parsed = Number(text.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatValueText(value: number | null | undefined, decimals: number): string {
  if (value == null || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(decimals).replace('.', ',');
}

interface ValueInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> {
  // null = vazio. Para mostrar o campo vazio quando o estado e 0, passe `valor || null`.
  value: number | null | undefined;
  onValueChange: (value: number | null) => void;
  decimals?: number;
}

export default function ValueInput({ value, onValueChange, decimals = 2, placeholder, ...rest }: ValueInputProps) {
  const [text, setText] = useState(() => formatValueText(value, decimals));

  // Mudanca vinda de fora (limpar formulario, sugestao de valor): reflete no campo.
  // Vazio e zero contam como iguais para nao apagar um "0" ou "0," em digitacao.
  useEffect(() => {
    if ((parseValueText(text) ?? 0) !== (value ?? 0)) {
      setText(formatValueText(value, decimals));
    }
  }, [value]);

  return (
    <input
      {...rest}
      type="text"
      inputMode={decimals === 0 ? 'numeric' : 'decimal'}
      autoComplete="off"
      placeholder={placeholder ?? (decimals === 0 ? '0' : '0,00')}
      value={text}
      onChange={(event) => {
        const next = sanitizeValueText(event.target.value, decimals);
        setText(next);
        onValueChange(parseValueText(next));
      }}
    />
  );
}
