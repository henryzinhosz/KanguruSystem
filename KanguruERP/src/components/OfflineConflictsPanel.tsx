import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { supabaseService } from '../db/supabaseService';
import { StoreConfig } from '../types';

// Vendas feitas no PDV sem internet que chegaram com divergencia (serial ja vendido, estoque
// que ficou negativo, preco que mudou, vendedor invalido, pagamento diferente do total).
// O gerente confere e marca como resolvida.

const KIND_LABELS: Record<string, string> = {
  SERIAL: 'Serial',
  ESTOQUE: 'Estoque',
  PRECO: 'Preço',
  VENDEDOR: 'Vendedor',
  PAGAMENTO: 'Pagamento',
};

interface Conflict {
  id: string;
  unitId: string;
  saleId: string;
  kind: string;
  detail: string;
  createdAt: string;
}

export function OfflineConflictsPanel({ storeConfigs, userName }: { storeConfigs: StoreConfig[]; userName: string }) {
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [error, setError] = useState('');

  const load = () => supabaseService.getOfflineConflicts().then(setConflicts).catch(() => setConflicts([]));
  useEffect(() => {
    void load();
  }, []);

  if (conflicts.length === 0) return null;

  async function resolve(id: string) {
    setError('');
    try {
      await supabaseService.resolveOfflineConflict(id, userName);
      await load();
    } catch {
      setError('Não foi possível marcar como resolvida.');
    }
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-bold text-amber-900">
        <CircleAlert className="w-4 h-4" />
        Vendas sem internet com divergência ({conflicts.length})
      </div>
      <p className="text-xs text-amber-800">Vendas feitas no PDV sem internet que chegaram com alguma diferença. Confira e marque como resolvida.</p>
      {error && <p className="text-xs text-rose-700">{error}</p>}
      <div className="divide-y divide-amber-100 bg-white rounded-lg border border-amber-100">
        {conflicts.map(conflict => (
          <div key={conflict.id} className="flex items-start justify-between gap-3 p-3 text-xs">
            <div>
              <span className="inline-block rounded border border-amber-200 bg-amber-50 px-1.5 font-bold text-amber-800 mr-2">{KIND_LABELS[conflict.kind] ?? conflict.kind}</span>
              <span className="text-slate-800">{conflict.detail}</span>
              <span className="block text-[10px] text-slate-400 mt-0.5">
                {storeConfigs.find(store => store.unitId === conflict.unitId)?.tradeName || conflict.unitId} · {new Date(conflict.createdAt).toLocaleString('pt-BR')} · venda {conflict.saleId.slice(0, 8)}
              </span>
            </div>
            <button type="button" onClick={() => void resolve(conflict.id)} className="shrink-0 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-[10px]">
              Resolvida
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
