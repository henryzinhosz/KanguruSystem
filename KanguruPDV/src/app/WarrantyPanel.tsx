import { FormEvent, useState } from 'react';
import { Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { findPosWarranty, type PosWarrantyLine } from '../services/supabase/customers';
import { formatCpf } from './reservationVoucher';

const DAY_MS = 24 * 60 * 60 * 1000;

// Fim da garantia: data da venda + meses de garantia (vale ate o fim desse dia).
function warrantyEnd(saleDate: string, months: number): Date {
  const end = new Date(saleDate);
  end.setMonth(end.getMonth() + months);
  end.setHours(23, 59, 59, 999);
  return end;
}

function warrantyStatus(line: PosWarrantyLine): { className: string; label: string; until: string | null } {
  if (line.saleStatus === 'CANCELADA') return { className: 'expired', label: 'Venda estornada', until: null };
  if (line.warrantyMonths <= 0) return { className: 'expired', label: 'Produto sem garantia', until: null };
  const end = warrantyEnd(line.saleDate, line.warrantyMonths);
  const days = Math.ceil((end.getTime() - Date.now()) / DAY_MS);
  const until = end.toLocaleDateString('pt-BR');
  return days >= 0
    ? { className: 'valid', label: `Em garantia · faltam ${days} dia(s)`, until }
    : { className: 'expired', label: `Garantia vencida há ${Math.abs(days)} dia(s)`, until };
}

export function WarrantyPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PosWarrantyLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await findPosWarranty(query.trim()));
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Não foi possível consultar a garantia.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="reservations-panel warranty-panel">
      <h1>Consulta de garantia</h1>
      <p className="modal-copy">Bipe ou digite o <strong>serial</strong> ou <strong>IMEI</strong> do produto, ou o <strong>CPF</strong> do cliente. Vale para compras em qualquer loja da rede do franqueado.</p>
      <form className="search-form" onSubmit={(event) => void search(event)}>
        <input autoFocus placeholder="Serial, IMEI ou CPF" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button className="icon-button search-button" type="submit" disabled={busy} title="Consultar garantia"><Search size={21} /></button>
      </form>
      {error && <p className="field-error">{error}</p>}
      {busy && <p className="empty-state">Consultando...</p>}
      {results && results.length === 0 && !busy && (
        <p className="empty-state">Nenhuma venda encontrada para este serial, IMEI ou CPF.</p>
      )}
      <div className="reservation-list">
        {results?.map((line, index) => {
          const status = warrantyStatus(line);
          return (
            <article className="reservation-entry warranty-entry" key={`${line.saleId}-${line.serialNumber ?? index}`}>
              <div className="reservation-entry-heading">
                <div>
                  <h2>{line.itemName}</h2>
                  <small>
                    {line.itemSku}
                    {line.serialNumber ? ` | Série ${line.serialNumber}` : ` | ${line.quantity} un.`}
                  </small>
                </div>
                <span className={`warranty-status ${status.className}`}>
                  {status.className === 'valid' ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
                  {status.label}
                </span>
              </div>
              <dl className="warranty-details">
                <dt>Garantia até</dt><dd>{status.until ?? '—'}{line.warrantyMonths > 0 ? ` (${line.warrantyMonths} meses)` : ''}</dd>
                <dt>Data da compra</dt><dd>{new Date(line.saleDate).toLocaleDateString('pt-BR')}</dd>
                <dt>Cliente</dt><dd>{line.customerName || 'Não informado'}{line.customerCpf ? ` · CPF ${formatCpf(line.customerCpf)}` : ''}</dd>
                <dt>Loja</dt><dd>{line.storeName}</dd>
                <dt>Vendedor</dt><dd>{line.sellerName || '—'}</dd>
                <dt>Documento</dt><dd>{line.invoiceNumber}</dd>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}
