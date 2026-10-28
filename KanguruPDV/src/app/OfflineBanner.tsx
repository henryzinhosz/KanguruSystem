import { useState } from 'react';
import { listOutboxProblems, syncOutbox, useOfflineState } from '../offline/offline';
import type { OutboxEntry } from '../offline/offlineDb';

// Faixa no topo: modo offline e vendas guardadas aguardando envio (ou com erro no envio).

export function OfflineBanner() {
  const { offline, pending, errors, syncing } = useOfflineState();
  const [problems, setProblems] = useState<OutboxEntry[] | null>(null);
  const [retrying, setRetrying] = useState(false);

  if (!offline && pending === 0 && errors === 0) return null;

  async function openProblems() {
    setProblems(await listOutboxProblems());
  }

  async function retry() {
    setRetrying(true);
    await syncOutbox(true);
    setProblems(await listOutboxProblems());
    setRetrying(false);
  }

  return (
    <>
      <div className={`offline-banner${offline ? ' is-offline' : ''}`} role="status">
        <strong>{offline ? 'MODO OFFLINE' : syncing ? 'Enviando vendas feitas sem internet...' : 'Vendas aguardando envio'}</strong>
        <span>
          {pending > 0 ? `${pending} aguardando envio` : offline ? 'vendas ficam guardadas neste computador' : ''}
          {errors > 0 && (
            <button type="button" className="offline-banner-link" onClick={() => void openProblems()}>
              {errors} com erro: ver
            </button>
          )}
        </span>
      </div>
      {problems && (
        <div className="modal-backdrop" role="presentation">
          <section className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="offline-problems-title">
            <p className="eyebrow">Envio das vendas sem internet</p>
            <h2 id="offline-problems-title">Itens com erro</h2>
            <p className="modal-copy">Estes registros não foram aceitos pelo servidor. Eles continuam guardados; tente de novo ou chame o suporte com a mensagem abaixo.</p>
            <div className="receipts-list">
              {problems.length === 0 && <p className="empty-state">Nenhum erro pendente.</p>}
              {problems.map((entry) => (
                <article className="receipt-card" key={entry.id}>
                  <div>
                    <strong>{entry.kind === 'SALE' ? 'Venda' : 'Sangria/suprimento'} de {new Date(entry.createdAt).toLocaleString('pt-BR')}</strong>
                    <small className="field-error">{entry.lastError}</small>
                  </div>
                </article>
              ))}
            </div>
            <div className="modal-actions">
              <button className="text-action" type="button" onClick={() => setProblems(null)} disabled={retrying}>Fechar</button>
              <button className="primary-action modal-confirm" type="button" onClick={() => void retry()} disabled={retrying || offline}>
                {retrying ? 'Enviando...' : 'Tentar de novo'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
