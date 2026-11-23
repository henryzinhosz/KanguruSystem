import { useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Product } from '../types';
import ValueInput from './ValueInput';
import { supabaseService } from '../db/supabaseService';

// Pecas avulsas (migration 20261207), em destaque no topo do Catalogo (pedido do usuario):
// vendidas com custo a informar (o lucro so fica certo depois) e as que ficaram sem vender.

interface Props {
  pending: Product[];
  unsold: Product[];
  onChanged: () => Promise<void>;
}

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function LoosePartsPendingPanel({ pending, unsold, onChanged }: Props) {
  const [costs, setCosts] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (pending.length === 0 && unsold.length === 0) return null;

  async function run(id: string, action: () => Promise<void>) {
    setBusy(id);
    setError('');
    try {
      await action();
      await onChanged();
    } catch (err) {
      setError((err as { message?: string })?.message || 'Não foi possível salvar.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border-2 border-rose-300 bg-rose-50 p-4 space-y-3 text-xs">
      {pending.length > 0 && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-black text-rose-800">
            <AlertTriangle className="w-5 h-5" />
            {pending.length} peça(s) avulsa(s) vendida(s) com custo pendente
          </h3>
          <p className="text-rose-700">Enquanto o custo não for informado, essas vendas aparecem com lucro maior que o real.</p>
          <div className="bg-white border border-rose-200 rounded-lg divide-y divide-rose-100">
            {pending.map(product => (
              <div key={product.id} className="flex flex-wrap items-center gap-2 p-2.5">
                <span className="flex-1 min-w-[200px]">
                  <strong className="text-slate-900">{product.name}</strong>
                  <span className="block text-slate-500">Cód. {product.sku} · vendida por {money(product.sellPrice)}</span>
                </span>
                <label className="flex items-center gap-1.5 font-semibold text-slate-700">
                  Custo
                  <ValueInput
                    className="w-28 bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono"
                    value={costs[product.id] ?? null}
                    onValueChange={value => setCosts(previous => ({ ...previous, [product.id]: value }))}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy !== null || costs[product.id] == null}
                  onClick={() => void run(product.id, () => supabaseService.setLoosePartCost(product.id, costs[product.id] as number))}
                  className="px-3 py-1.5 rounded bg-rose-700 hover:bg-rose-800 disabled:opacity-50 text-white font-bold"
                >
                  {busy === product.id ? 'Salvando...' : 'Salvar custo'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {unsold.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-bold text-amber-800">Peças avulsas que não foram vendidas ({unsold.length})</h4>
          <p className="text-amber-800">Criadas no PDV mas a venda não terminou (ex.: PDV fechado no meio). Descarte para tirar do estoque.</p>
          <div className="bg-white border border-amber-200 rounded-lg divide-y divide-amber-100">
            {unsold.map(product => (
              <div key={product.id} className="flex items-center justify-between gap-2 p-2.5">
                <span><strong className="text-slate-900">{product.name}</strong> <span className="text-slate-500">· {money(product.sellPrice)}</span></span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm(`Descartar "${product.name}"? O estoque dela zera e o cadastro é arquivado.`)) return;
                    void run(product.id, () => supabaseService.discardLoosePart(product.id));
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-amber-300 text-amber-800 hover:bg-amber-50 font-semibold"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Descartar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-rose-800 font-semibold">{error}</p>}
    </section>
  );
}
