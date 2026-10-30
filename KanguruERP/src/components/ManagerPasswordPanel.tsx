import { FormEvent, useEffect, useState } from 'react';
import { Check, KeyRound, X } from 'lucide-react';
import { StoreConfig } from '../types';
import { supabaseService, StoreManagerPasswordStatus } from '../db/supabaseService';

// Senha Gerente de cada loja (substitui a senha administrativa do PDV): desbloquear o
// terminal, desconto acima do limite, devolucao, Troca Gamer em dinheiro/Pix, gaveta,
// sangria, cancelar reserva com sinal e fechar o caixa. So o ADMIN define ou troca.

interface ManagerPasswordPanelProps {
  storeConfigs: StoreConfig[];
}

export default function ManagerPasswordPanel({ storeConfigs }: ManagerPasswordPanelProps) {
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const [status, setStatus] = useState<StoreManagerPasswordStatus[]>([]);
  const [editing, setEditing] = useState<StoreConfig | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => supabaseService.listStoreManagerPasswordStatus().then(setStatus).catch(() => setStatus([]));
  useEffect(() => { void load(); }, []);

  function open(store: StoreConfig) {
    setEditing(store);
    setPassword('');
    setConfirmation('');
    setError('');
    setMessage('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setError('');
    if (password.length < 6) {
      setError('A senha precisa ter pelo menos 6 caracteres.');
      return;
    }
    if (password !== confirmation) {
      setError('As senhas não coincidem.');
      return;
    }
    setBusy(true);
    try {
      await supabaseService.setStoreManagerPassword(editing.unitId, password);
      setMessage(`Senha Gerente de ${editing.tradeName || editing.unitId} salva. Vale para todos os PDVs da loja.`);
      setEditing(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Não foi possível salvar a senha.');
    } finally {
      setBusy(false);
      setPassword('');
      setConfirmation('');
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="w-5 h-5 text-blue-600" />
        <div>
          <h3 className="text-sm font-bold text-slate-900">Senha Gerente do PDV</h3>
          <p className="text-xs text-slate-500">
            Uma senha por loja, para todos os PDVs dela. Pedida para desbloquear o terminal, desconto acima do limite, devolução,
            Troca Gamer em dinheiro/Pix, abrir a gaveta, sangria, cancelar reserva com sinal e fechar o caixa.
            Enquanto a loja não tiver senha Gerente, o PDV continua usando a senha administrativa antiga.
          </p>
        </div>
      </div>
      {message && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><Check className="w-4 h-4" />{message}</p>}
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
            <tr><th className="p-3">Loja</th><th className="p-3">Situação</th><th className="p-3 text-right">Ação</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {stores.map(store => {
              const current = status.find(item => item.unitId === store.unitId);
              return (
                <tr key={store.unitId}>
                  <td className="p-3 font-bold text-slate-900">{store.tradeName || store.unitId}</td>
                  <td className="p-3">
                    {current
                      ? <span className="text-emerald-700 font-bold">Configurada em {new Date(current.setAt).toLocaleString('pt-BR')}{current.setByName ? ` por ${current.setByName}` : ''}</span>
                      : <span className="text-amber-700 font-bold">Não configurada</span>}
                  </td>
                  <td className="p-3 text-right">
                    <button type="button" onClick={() => open(store)} className="px-3 py-1.5 text-xs font-bold text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50">
                      {current ? 'Trocar senha' : 'Definir senha'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="presentation" onKeyDown={event => { if (event.key === 'Escape') setEditing(null); }}>
          <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="manager-password-title" className="w-full max-w-sm bg-white border border-slate-200 rounded-xl shadow-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 id="manager-password-title" className="text-sm font-bold text-slate-900">Senha Gerente · {editing.tradeName || editing.unitId}</h3>
              <button type="button" onClick={() => setEditing(null)} title="Fechar" aria-label="Fechar" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
            <label className="block text-xs font-bold text-slate-700">Nova senha (mínimo 6 caracteres)
              <input type="password" autoFocus autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" />
            </label>
            <label className="block text-xs font-bold text-slate-700">Confirmar senha
              <input type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" />
            </label>
            <p className="text-[11px] text-slate-500">PDVs sem internet continuam aceitando a senha antiga até voltarem a ficar online.</p>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setEditing(null)} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>
              <button type="submit" disabled={busy} className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-60">{busy ? 'Salvando...' : 'Salvar senha'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
