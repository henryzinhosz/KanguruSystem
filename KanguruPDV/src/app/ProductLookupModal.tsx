import { FormEvent, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchPosItems, type PosCatalogItem } from '../services/supabase/products';
import { isNetworkError, isOffline, searchOffline, setOffline } from '../offline/offline';

// Consulta de produto (menu Consultas): preco, estoque desta loja e lojas que tem o produto.

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function ProductLookupModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PosCatalogItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      if (isOffline()) {
        setItems(await searchOffline(query.trim()));
      } else {
        try {
          setItems(await searchPosItems(query.trim()));
        } catch (error) {
          if (!isNetworkError(error)) throw error;
          setOffline(true);
          setItems(await searchOffline(query.trim()));
        }
      }
    } catch {
      setItems([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal lookup-modal" role="dialog" aria-modal="true" aria-labelledby="lookup-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Consultas</p>
            <h2 id="lookup-title">Produto e estoque</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose}><X size={20} /></button>
        </div>
        <form className="search-form" onSubmit={(event) => void search(event)}>
          <input autoFocus placeholder="Código, serial, nome ou marca" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="icon-button search-button" type="submit" disabled={busy} title="Buscar"><Search size={21} /></button>
        </form>
        {isOffline() && <p className="modal-copy">Sem internet: estoque da cópia guardada neste computador (outras lojas indisponíveis).</p>}
        <div className="product-list lookup-list">
          {items?.length === 0 && <p className="empty-state">Nenhum item encontrado.</p>}
          {(items ?? []).map((item) => (
            <div className="product-row" key={`${item.itemType}-${item.id}`}>
              <span>
                <strong>{item.name}</strong>
                <small>{item.itemType === 'SERVICE' ? 'Serviço' : 'Produto'} | {item.sku}{item.brand ? ` | ${item.brand}` : ''}</small>
              </span>
              <span>
                <strong>{currency.format(item.sellPrice)}</strong>
                {item.itemType === 'SERVICE' ? (
                  <small>Sem estoque físico</small>
                ) : item.availableQuantity > 0 ? (
                  <small>{item.availableQuantity} nesta loja</small>
                ) : (
                  <>
                    <small className="stock-out">Sem estoque nesta loja</small>
                    {item.storesWithStock.length > 0 && <small className="stock-elsewhere">Possui estoque: {item.storesWithStock.join(', ')}</small>}
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
