import React, { useEffect, useMemo, useState } from 'react';
import { Printer, Search, Tag, X } from 'lucide-react';
import { supabaseService } from '../db/supabaseService';
import { formatMoney } from '../db/finance';
import { StoreConfig } from '../types';
import { LabelData, LabelSize, loadLabelSize, printLabels, saveLabelSize } from './labelPrint';

// Janela de etiquetas: aberta depois de uma entrada de estoque ("Imprimir N etiquetas?")
// ou pelo botao de etiqueta na lista de produtos (reimprimir).
// Sem serial: quantidade de etiquetas. Com serial: uma etiqueta por serial escolhido.

export interface LabelRequest {
  title: string;
  product: { id: string; name: string; sku: string; sellPrice: number; isSerialized: boolean };
  quantity?: number;          // sem serial: quantidade sugerida
  serials?: string[];         // com serial: seriais ja definidos (entrada de estoque)
}

interface Props {
  request: LabelRequest;
  storeConfigs: StoreConfig[];
  onClose: () => void;
}

const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function LabelPrintModal({ request, storeConfigs, onClose }: Props) {
  const { product } = request;
  const [size, setSize] = useState<LabelSize>(loadLabelSize);
  const [quantity, setQuantity] = useState(String(request.quantity ?? 1));
  const [serials, setSerials] = useState<{ serial: string; storeName: string }[]>(
    (request.serials ?? []).map(serial => ({ serial, storeName: '' })),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set(request.serials ?? []));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  // Reimprimir produto com serial: carrega os seriais em estoque (nenhum marcado).
  useEffect(() => {
    if (!product.isSerialized || request.serials) return;
    setLoading(true);
    supabaseService.getProductSerials(product.id)
      .then(rows => setSerials(rows.map(row => {
        const store = storeConfigs.find(item => item.unitId === row.unitId);
        return { serial: row.serial, storeName: `${store?.tradeName || store?.legalName || row.unitId}${row.status === 'RESERVADO' ? ' · reservado' : ''}` };
      })))
      .catch(() => setError('Não foi possível carregar os seriais deste produto.'))
      .finally(() => setLoading(false));
  }, [product.id, product.isSerialized, request.serials, storeConfigs]);

  const key = normalize(search);
  const visible = useMemo(
    () => (key ? serials.filter(row => normalize(row.serial).includes(key)) : serials),
    [serials, key],
  );

  const count = product.isSerialized ? selected.size : Math.max(0, parseInt(quantity, 10) || 0);

  function toggle(serial: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(serial)) next.delete(serial); else next.add(serial);
      return next;
    });
  }

  // Bipar/digitar o serial e apertar Enter marca a unidade e limpa a busca.
  function handleSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const exact = serials.find(row => normalize(row.serial) === key) ?? (visible.length === 1 ? visible[0] : undefined);
    if (exact) {
      setSelected(previous => new Set(previous).add(exact.serial));
      setSearch('');
    }
  }

  function print() {
    if (count === 0) return;
    if (count > 500) {
      setError('Imprima no máximo 500 etiquetas por vez.');
      return;
    }
    const base = { name: product.name, price: product.sellPrice, code: product.sku };
    const labels: LabelData[] = product.isSerialized
      ? serials.filter(row => selected.has(row.serial)).map(row => ({ ...base, serial: row.serial }))
      : Array.from({ length: count }, () => base);
    saveLabelSize(size);
    printLabels(labels, size);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4" role="presentation">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between p-5 border-b border-slate-100">
          <div>
            <h3 className="font-bold text-slate-900 flex items-center gap-2"><Tag className="w-4 h-4 text-blue-600" />{request.title}</h3>
            <p className="text-xs text-slate-500 mt-1">{product.name} · Cód. {product.sku} · {formatMoney(product.sellPrice)}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto text-sm">
          <div>
            <span className="block text-xs font-bold text-slate-700 mb-1.5">Tamanho da etiqueta</span>
            <div className="flex gap-2">
              {(['60x40', '60x30'] as LabelSize[]).map(option => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setSize(option)}
                  className={`flex-1 py-2 rounded-lg border text-sm font-bold ${size === option ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                >
                  {option.replace('x', ' × ')} mm
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5">Na janela de impressão, escolha a impressora de etiquetas. O tamanho do papel no driver deve ser o mesmo.</p>
          </div>

          {!product.isSerialized && (
            <label className="block text-xs font-bold text-slate-700">
              Quantidade de etiquetas
              <input
                type="text"
                inputMode="numeric"
                value={quantity}
                onChange={event => setQuantity(event.target.value.replace(/\D/g, '').slice(0, 3))}
                className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none"
              />
            </label>
          )}

          {product.isSerialized && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-slate-700">Seriais ({selected.size} de {serials.length} marcados)</span>
                {serials.length > 0 && (
                  <button
                    type="button"
                    className="text-xs font-bold text-blue-700 hover:underline"
                    onClick={() => setSelected(selected.size === serials.length ? new Set() : new Set(serials.map(row => row.serial)))}
                  >
                    {selected.size === serials.length ? 'Desmarcar todos' : 'Marcar todos'}
                  </button>
                )}
              </div>
              {serials.length > 0 && (
                <div className="relative mb-2">
                  <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
                  <input
                    autoFocus
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    onKeyDown={handleSearchKey}
                    placeholder="Digite ou bipe o serial e aperte Enter"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 pl-8 pr-2.5 outline-none"
                  />
                </div>
              )}
              {loading && <p className="text-xs text-slate-500">Carregando seriais...</p>}
              {!loading && serials.length === 0 && <p className="text-xs text-slate-500">Nenhuma unidade em estoque deste produto.</p>}
              {!loading && serials.length > 0 && visible.length === 0 && (
                <p className="text-xs font-bold text-rose-600">Serial "{search.trim()}" não existe no estoque deste produto.</p>
              )}
              <div className="max-h-60 overflow-y-auto space-y-1">
                {visible.map(row => (
                  <label key={row.serial} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border cursor-pointer ${selected.has(row.serial) ? 'border-blue-300 bg-blue-50' : 'border-slate-200'}`}>
                    <input type="checkbox" checked={selected.has(row.serial)} onChange={() => toggle(row.serial)} />
                    <span className="font-mono font-bold text-slate-800">{row.serial}</span>
                    {row.storeName && <span className="ml-auto text-[11px] text-slate-500">{row.storeName}</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-slate-100">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-bold text-slate-600 hover:bg-slate-100">
            {request.serials || request.quantity ? 'Não imprimir' : 'Cancelar'}
          </button>
          <button
            type="button"
            onClick={print}
            disabled={count === 0}
            className="px-4 py-2 rounded-lg text-sm font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 flex items-center gap-2"
          >
            <Printer className="w-4 h-4" />Imprimir {count} etiqueta{count === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
