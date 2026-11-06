import { FormEvent, useEffect, useState } from 'react';
import { Check, Contact, Save } from 'lucide-react';
import { supabaseService } from '../db/supabaseService';

// Contato do franqueado (dono da empresa): usado depois na visao da marca no UCP.
// So o administrador ve e edita (migration 20261114).

export default function FranchiseeContactPanel() {
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    supabaseService.getTenantContact()
      .then(contact => {
        setOwnerName(contact?.ownerName || '');
        setOwnerPhone(contact?.ownerPhone || '');
        setOwnerEmail(contact?.ownerEmail || '');
        setLoaded(true);
      })
      .catch(() => setError('Não foi possível carregar os dados do franqueado. Confira se a migration 20261114 foi aplicada.'));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await supabaseService.saveTenantContact({ ownerName, ownerPhone, ownerEmail });
      setMessage('Dados do franqueado salvos.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : (saveError as { message?: string })?.message || 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-medium outline-none focus:ring-1 focus:ring-blue-500';

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Contact className="w-5 h-5 text-blue-600" />
        <div>
          <h3 className="text-sm font-bold text-slate-900">Dados do franqueado</h3>
          <p className="text-xs text-slate-500">Contato do responsável pela franquia, usado pela marca para acompanhar as lojas.</p>
        </div>
      </div>
      {error && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {message && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><Check className="w-4 h-4" />{message}</p>}
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <label className="text-xs font-bold text-slate-700">
          Nome do franqueado (nome real)
          <input value={ownerName} onChange={event => setOwnerName(event.target.value)} maxLength={150} className={input} />
        </label>
        <label className="text-xs font-bold text-slate-700">
          Telefone de contato
          <input value={ownerPhone} onChange={event => setOwnerPhone(event.target.value)} inputMode="tel" maxLength={30} placeholder="(21) 99999-9999" className={input} />
        </label>
        <label className="text-xs font-bold text-slate-700">
          E-mail de contato
          <input type="email" value={ownerEmail} onChange={event => setOwnerEmail(event.target.value)} maxLength={150} className={input} />
        </label>
        <div className="md:col-span-3 flex justify-end">
          <button type="submit" disabled={busy || !loaded} className="px-4 py-2.5 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center gap-2">
            <Save className="w-4 h-4" />{busy ? 'Salvando...' : 'Salvar dados do franqueado'}
          </button>
        </div>
      </form>
    </section>
  );
}
