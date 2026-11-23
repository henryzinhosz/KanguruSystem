import { useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Product, StockInventory } from '../types';

// Juntar produtos repetidos (desenho aprovado em 2026-11-22): escolhe o principal, marca os repetidos;
// o banco passa unidades com serial, estoque e custo para o principal e arquiva os repetidos.

const normalize = (value: string) => value
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(usado\)|usado|seminovo/g, '').replace(/[^a-z0-9]/g, '');

interface Props {
  products: Product[];
  inventory: StockInventory[];
  onMerge: (mainId: string, duplicateIds: string[]) => Promise<void>;
  onClose: () => void;
}

export default function MergeProductsModal({ products, inventory, onMerge, onClose }: Props) {
  const [mainId, setMainId] = useState('');
  const [mainSearch, setMainSearch] = useState('');
  const [dupSearch, setDupSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const main = products.find(product => product.id === mainId) ?? null;
  const stockOf = (productId: string) => Object.entries(inventory.find(item => item.productId === productId)?.quantities ?? {})
    .filter(([unitId]) => unitId !== 'central')
    .reduce((sum, [, unit]) => sum + (unit.qty || 0), 0);

  const search = (query: string, exclude: string[]) => {
    const text = query.trim().toLowerCase();
    if (!text) return [];
    return products
      .filter(product => !exclude.includes(product.id))
      .filter(product => product.name.toLowerCase().includes(text) || product.sku.toLowerCase().includes(text))
      .slice(0, 8);
  };

  // Parecidos com o principal (mesmo nome sem "usado", espacos e acentos).
  const suggestions = useMemo(() => {
    if (!main) return [];
    const key = normalize(main.name);
    return products.filter(product => {
      if (product.id === main.id) return false;
      const other = normalize(product.name);
      return other.length >= 4 && (other.includes(key) || key.includes(other));
    });
  }, [main, products]);

  const candidates = [
    ...suggestions,
    ...products.filter(product => selected.has(product.id) && !suggestions.some(item => item.id === product.id)),
  ];

  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function merge() {
    if (!main || selected.size === 0 || saving) return;
    const names = products.filter(product => selected.has(product.id)).map(product => product.name).join(', ');
    if (!window.confirm(`Juntar em "${main.name}": ${names}?\n\nO estoque, as unidades com serial e o custo passam para "${main.name}" e os repetidos ficam arquivados (as vendas antigas continuam no histórico).`)) return;
    setSaving(true);
    setError('');
    try {
      await onMerge(main.id, [...selected]);
      setDone(`Pronto: ${selected.size} produto(s) juntado(s) em "${main.name}".`);
      setSelected(new Set());
    } catch (err) {
      setError((err as { message?: string })?.message || 'Não foi possível juntar os produtos.');
    } finally {
      setSaving(false);
    }
  }

  const row = (product: Product, action: ReactNode) => (
    <div key={product.id} className="flex items-center justify-between gap-2 px-2.5 py-2">
      <span className="min-w-0">
        <strong className="text-slate-800">{product.name}</strong>
        <span className="block text-slate-500">Cód. {product.sku} · {stockOf(product.id)} em estoque · {product.isSerialized ? 'com serial' : 'sem serial'}</span>
      </span>
      {action}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-xl w-full max-h-[90vh] overflow-hidden flex flex-col text-xs">
        <div className="bg-slate-900 text-white p-4 flex justify-between items-center">
          <h3 className="font-bold uppercase tracking-wider">Juntar produtos repetidos</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">
          {done && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{done}</div>}

          <div className="space-y-1.5">
            <span className="font-bold text-slate-700 block">1. Produto principal (o que fica)</span>
            {main ? (
              <div className="border border-blue-200 bg-blue-50 rounded-lg">
                {row(main, <button type="button" onClick={() => { setMainId(''); setSelected(new Set()); }} className="text-blue-700 font-semibold">Trocar</button>)}
              </div>
            ) : (
              <>
                <input className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none" placeholder="Buscar por nome ou código" value={mainSearch} onChange={event => setMainSearch(event.target.value)} />
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 empty:hidden">
                  {search(mainSearch, []).map(product => row(product,
                    <button type="button" onClick={() => { setMainId(product.id); setMainSearch(''); }} className="text-blue-700 font-semibold">Escolher</button>))}
                </div>
              </>
            )}
          </div>

          {main && (
            <div className="space-y-1.5">
              <span className="font-bold text-slate-700 block">2. Marque os repetidos (vão ser arquivados)</span>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                {candidates.length === 0 && <p className="p-2.5 text-slate-500">Nenhum produto parecido. Busque abaixo.</p>}
                {candidates.map(product => {
                  const sameKind = Boolean(product.isSerialized) === Boolean(main.isSerialized);
                  return row(product, sameKind ? (
                    <input type="checkbox" checked={selected.has(product.id)} onChange={() => toggle(product.id)} aria-label={`Marcar ${product.name}`} />
                  ) : (
                    <span className="text-[10px] text-slate-400 text-right">Tipo diferente<br />(com/sem serial)</span>
                  ));
                })}
              </div>
              <input className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none" placeholder="Buscar outro produto repetido" value={dupSearch} onChange={event => setDupSearch(event.target.value)} />
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 empty:hidden">
                {search(dupSearch, [main.id, ...candidates.map(item => item.id)]).map(product => row(product,
                  Boolean(product.isSerialized) === Boolean(main.isSerialized)
                    ? <button type="button" onClick={() => { toggle(product.id); setDupSearch(''); }} className="text-blue-700 font-semibold">Marcar</button>
                    : <span className="text-[10px] text-slate-400">Tipo diferente</span>))}
              </div>
            </div>
          )}

          {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-slate-100">
          <button type="button" onClick={onClose} className="px-3 py-1.5 border border-slate-200 text-slate-600 rounded hover:bg-slate-50">Fechar</button>
          <button type="button" onClick={() => void merge()} disabled={!main || selected.size === 0 || saving} className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-bold rounded">
            {saving ? 'Juntando...' : `Juntar ${selected.size || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
