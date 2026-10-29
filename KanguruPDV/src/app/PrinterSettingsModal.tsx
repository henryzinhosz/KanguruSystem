import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { getDirectPrinter, listPrinters, printTestPage, setDirectPrinter } from '../printing/directPrint';

// Menu › Configuracoes › Impressora: escolhe a termica (nome no Windows) para impressao direta.

export function PrinterSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [printers, setPrinters] = useState<string[] | null>(null);
  const [selected, setSelected] = useState(getDirectPrinter() ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listPrinters().then(setPrinters).catch(() => {
      setPrinters([]);
      setStatus('Não foi possível listar as impressoras deste computador.');
    });
  }, []);

  async function test() {
    if (!selected) return;
    setBusy(true);
    setStatus(null);
    try {
      await printTestPage(selected);
      setStatus('Teste enviado. Saiu impresso com os acentos certos? Então pode salvar.');
    } catch (error) {
      setStatus(`A impressão falhou: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="printer-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Configurações</p>
            <h2 id="printer-title">Impressora do cupom</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose}><X size={20} /></button>
        </div>
        <p className="modal-copy">
          Escolha a impressora térmica deste computador. O cupom sai direto nela, com a letra da impressora,
          e a gaveta abre sozinha nas vendas em dinheiro. Sem impressora escolhida, o PDV usa a janela de impressão do Windows.
        </p>
        <label>
          Impressora
          <select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={printers === null}>
            <option value="">Usar a janela do Windows (sem impressão direta)</option>
            {(printers ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {status && <p className="modal-copy">{status}</p>}
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={() => void test()} disabled={busy || !selected}>
            {busy ? 'Imprimindo...' : 'Imprimir teste'}
          </button>
          <button
            className="primary-action modal-confirm"
            type="button"
            onClick={() => {
              setDirectPrinter(selected || null);
              onSaved(selected ? `Impressão direta ligada na impressora "${selected}".` : 'Impressão direta desligada: o PDV usa a janela do Windows.');
            }}
          >
            Salvar
          </button>
        </div>
      </section>
    </div>
  );
}
