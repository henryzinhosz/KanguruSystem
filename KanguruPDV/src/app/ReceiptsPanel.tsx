import { FormEvent, useEffect, useState } from 'react';
import { Printer, RotateCcw, Search, Send } from 'lucide-react';
import { searchPosSales, type NfceStatus, type PosSaleSummary } from '../services/supabase/sales';
import { formatCpf } from './reservationVoucher';
import { maskCpf } from './cpf';
import { formatReceiptNumber } from './receiptPrint';

// Reimpressao de cupons (2.8b): busca por data, numero (cupom ou NFC-e) ou CPF.
// NFC-e com erro ou pendente pode ser emitida de novo daqui.

type SearchMode = 'date' | 'number' | 'cpf';

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const NFCE_LABELS: Record<NfceStatus, string> = {
  PENDENTE: 'pendente',
  AUTORIZADA: 'autorizada',
  ERRO: 'com erro',
  CANCELADA: 'cancelada',
};

function todayValue(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

interface ReceiptsPanelProps {
  nfceConfigured: boolean;
  busy: boolean;
  onReprint: (saleId: string) => Promise<void>;
  onEmitNfce: (saleId: string) => Promise<void>;
  onReturn: (saleId: string) => void;
}

export function ReceiptsPanel({ nfceConfigured, busy, onReprint, onEmitNfce, onReturn }: ReceiptsPanelProps) {
  const [mode, setMode] = useState<SearchMode>('date');
  const [value, setValue] = useState(todayValue);
  const [results, setResults] = useState<PosSaleSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch() {
    if (!value.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await searchPosSales(
        mode === 'date' ? { date: value } : mode === 'number' ? { number: value } : { cpf: value }
      ));
      setSearched(true);
    } catch {
      setError('Não foi possível buscar as vendas. Confira a conexão e tente de novo.');
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    void runSearch();
    // Abre ja com as vendas de hoje.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeMode(next: SearchMode) {
    setMode(next);
    setValue(next === 'date' ? todayValue() : '');
    setResults([]);
    setSearched(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch();
  }

  return (
    <section className="reservations-panel receipts-panel">
      <form className="receipts-search" onSubmit={submit}>
        <label>
          Buscar por
          <select value={mode} onChange={(event) => changeMode(event.target.value as SearchMode)}>
            <option value="date">Data</option>
            <option value="number">Número da nota</option>
            <option value="cpf">CPF do cliente</option>
          </select>
        </label>
        <label>
          {mode === 'date' ? 'Data da venda' : mode === 'number' ? 'Número do cupom ou da NFC-e' : 'CPF'}
          {mode === 'date' ? (
            <input type="date" required value={value} max={todayValue()} onChange={(event) => setValue(event.target.value)} />
          ) : (
            <input
              required
              inputMode="numeric"
              autoFocus
              placeholder={mode === 'cpf' ? '000.000.000-00' : 'Ex.: 12'}
              value={value}
              onChange={(event) => setValue(mode === 'cpf' ? maskCpf(event.target.value) : event.target.value.replace(/\D/g, '').slice(0, 9))}
            />
          )}
        </label>
        <button className="primary-action receipts-search-button" type="submit" disabled={searching || !value.trim()}>
          <Search size={18} /> {searching ? 'Buscando...' : 'Buscar'}
        </button>
      </form>

      {error && <p className="notice">{error}</p>}
      {searched && results.length === 0 && !searching && <p className="empty-state">Nenhuma venda encontrada.</p>}
      {results.length === 200 && <p className="empty-state">Mostrando as 200 vendas mais recentes. Refine a busca para ver outras.</p>}

      <div className="receipts-list">
        {results.map((sale) => {
          const date = new Date(sale.timestamp);
          const canEmit = nfceConfigured && sale.status === 'CONCLUIDA'
            && sale.fiscalStatus !== 'AUTORIZADA' && sale.fiscalStatus !== 'CANCELADA';
          return (
            <article className="receipt-card" key={sale.saleId}>
              <div>
                <strong>Cupom {formatReceiptNumber(sale.receiptNumber)}</strong>
                <small>{date.toLocaleDateString('pt-BR')} {date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} | {currency.format(sale.grossAmount)}</small>
                <small>
                  {sale.clientName ? sale.clientName : 'Consumidor'}
                  {sale.clientCpf ? ` | CPF ${formatCpf(sale.clientCpf)}` : ''}
                  {sale.sellerName ? ` | Vendedor: ${sale.sellerName}` : ''}
                </small>
                <span className="receipt-tags">
                  {sale.status === 'CANCELADA' && <span className="receipt-tag is-cancelled">Estornada</span>}
                  {sale.fiscalStatus ? (
                    <span className={`receipt-tag nfce-${sale.fiscalStatus.toLowerCase()}`} title={sale.nfceMessage ?? undefined}>
                      NFC-e {sale.nfceNumber ? `nº ${sale.nfceNumber} ` : ''}{NFCE_LABELS[sale.fiscalStatus]}
                    </span>
                  ) : null}
                  {sale.nfceContingency && sale.fiscalStatus === 'AUTORIZADA' ? (
                    <span className="receipt-tag nfce-pendente" title="Emitida com a Sefaz fora do ar; aguardando a Sefaz efetivar (até 24 h)">em contingência</span>
                  ) : null}
                  {sale.fiscalStatus ? null : (
                    <span className="receipt-tag">Não fiscal</span>
                  )}
                </span>
                {sale.fiscalStatus === 'ERRO' && sale.nfceMessage && <small className="field-error">{sale.nfceMessage}</small>}
              </div>
              <div className="receipt-actions">
                {canEmit && (
                  <button className="reservation-nav" type="button" disabled={busy} onClick={() => void onEmitNfce(sale.saleId).then(runSearch)}>
                    <Send size={16} /> Emitir NFC-e
                  </button>
                )}
                {sale.status === 'CONCLUIDA' && (
                  <button className="reservation-nav" type="button" disabled={busy} onClick={() => onReturn(sale.saleId)}>
                    <RotateCcw size={16} /> Trocar / Devolver
                  </button>
                )}
                <button className="reservation-nav" type="button" disabled={busy} onClick={() => void onReprint(sale.saleId)}>
                  <Printer size={16} /> Reimprimir
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
