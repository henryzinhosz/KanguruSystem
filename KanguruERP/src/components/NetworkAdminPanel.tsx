import { FormEvent, useEffect, useState } from 'react';
import { Check, KeyRound, Network, Plus, RefreshCw, UserPlus } from 'lucide-react';
import type { PlatformTenant } from '../types';
import {
  manageNetworkUser,
  platformListNetworks,
  platformSaveNetwork,
  platformSetTenantNetwork,
  type PlatformNetwork,
} from '../db/network';

// UCP › Redes (franqueadoras): criar a rede, ligar os franqueados e criar o login do dono.
// O dono cria os gerentes da rede no proprio Painel da Rede (migration 20261115).

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Erro ao salvar.';

export default function NetworkAdminPanel({ tenants }: { tenants: PlatformTenant[] }) {
  const [networks, setNetworks] = useState<PlatformNetwork[]>([]);
  const [newName, setNewName] = useState('');
  const [ownerForm, setOwnerForm] = useState<{ networkId: string; name: string; email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const reload = () => platformListNetworks().then(setNetworks).catch(loadError => setError(`Não foi possível carregar as redes: ${errorText(loadError)}. Confira se a migration 20261115 foi aplicada.`));
  useEffect(() => {
    void reload();
  }, []);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(success);
      await reload();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setBusy(false);
    }
  };

  const networkOfTenant = (tenantId: string) => networks.find(network => network.tenantIds.includes(tenantId))?.id ?? '';

  const createNetwork = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newName.trim()) return;
    void run(async () => {
      await platformSaveNetwork(null, newName.trim());
      setNewName('');
    }, 'Rede criada.');
  };

  const createOwner = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ownerForm) return;
    const { networkId, name, email, password } = ownerForm;
    void run(async () => {
      await manageNetworkUser({ action: 'create', role: 'OWNER', networkId, name, email, password });
      setOwnerForm(null);
    }, 'Login do dono da rede criado. Passe o e-mail e a senha para ele entrar no endereço do ERP.');
  };

  const input = 'w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs outline-none focus:border-blue-500';

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-blue-700" />
          <div>
            <h3 className="text-sm font-bold text-slate-900">Redes cadastradas</h3>
            <p className="text-xs text-slate-500">A franqueadora entra no Painel da Rede e acompanha as franquias ligadas a ela (somente leitura).</p>
          </div>
        </div>
        <button type="button" onClick={() => void reload()} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100" title="Atualizar" aria-label="Atualizar"><RefreshCw className="h-4 w-4" /></button>
      </div>

      <div className="space-y-4 p-4 text-xs">
        {error && <p className="rounded-md border border-rose-200 bg-rose-50 p-2 text-rose-800">{error}</p>}
        {message && <p className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-emerald-800"><Check className="h-4 w-4" />{message}</p>}

        <form onSubmit={createNetwork} className="flex gap-2">
          <input value={newName} onChange={event => setNewName(event.target.value)} placeholder="Nome da nova rede (ex.: BeB Games)" className={input} />
          <button type="submit" disabled={busy || !newName.trim()} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 font-bold text-white disabled:opacity-50"><Plus className="h-4 w-4" />Criar rede</button>
        </form>

        {networks.map(network => (
          <div key={network.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm text-slate-900">{network.name}</strong>
              <span className="text-slate-500">{network.tenants} franqueado(s)</span>
            </div>
            <div className="space-y-1">
              {network.users.map(user => (
                <div key={user.authUid} className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-50 px-2 py-1.5">
                  <span><strong>{user.displayName}</strong> · {user.email} · {user.role === 'OWNER' ? 'Dono da rede' : 'Gerente da rede'}{user.isActive ? '' : ' · DESATIVADO'}</span>
                  <span className="flex gap-2">
                    <button type="button" disabled={busy} onClick={() => {
                      const password = window.prompt(`Nova senha para ${user.displayName} (mínimo 8 caracteres):`);
                      if (password) void run(() => manageNetworkUser({ action: 'set_password', authUid: user.authUid, password }), 'Senha trocada.');
                    }} className="inline-flex items-center gap-1 font-bold text-blue-700 hover:underline"><KeyRound className="h-3.5 w-3.5" />Senha</button>
                    <button type="button" disabled={busy} onClick={() => void run(() => manageNetworkUser({ action: 'set_active', authUid: user.authUid, active: !user.isActive }), user.isActive ? 'Login desativado.' : 'Login reativado.')} className={`font-bold hover:underline ${user.isActive ? 'text-rose-700' : 'text-emerald-700'}`}>{user.isActive ? 'Desativar' : 'Reativar'}</button>
                  </span>
                </div>
              ))}
              {network.users.length === 0 && <p className="text-slate-400">Ainda sem login. Crie o login do dono da rede.</p>}
            </div>
            {ownerForm?.networkId === network.id ? (
              <form onSubmit={createOwner} className="grid grid-cols-1 gap-2 rounded-md border border-blue-200 bg-blue-50/50 p-2 sm:grid-cols-4">
                <input required placeholder="Nome" value={ownerForm.name} onChange={event => setOwnerForm({ ...ownerForm, name: event.target.value })} className={input} />
                <input required type="email" placeholder="E-mail" value={ownerForm.email} onChange={event => setOwnerForm({ ...ownerForm, email: event.target.value })} className={input} />
                <input required type="password" minLength={8} placeholder="Senha inicial" value={ownerForm.password} onChange={event => setOwnerForm({ ...ownerForm, password: event.target.value })} className={input} />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setOwnerForm(null)} className="rounded-md px-2 py-2 font-bold text-slate-600 hover:bg-slate-100">Cancelar</button>
                  <button type="submit" disabled={busy} className="flex-1 rounded-md bg-blue-600 px-2 py-2 font-bold text-white disabled:opacity-50">Criar</button>
                </div>
              </form>
            ) : (
              <button type="button" onClick={() => setOwnerForm({ networkId: network.id, name: '', email: '', password: '' })} className="inline-flex items-center gap-1.5 font-bold text-blue-700 hover:underline"><UserPlus className="h-4 w-4" />Criar login do dono da rede</button>
            )}
          </div>
        ))}

        {networks.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Franqueados e suas redes</h4>
            <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {tenants.map(tenant => (
                <div key={tenant.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span><strong>{tenant.tradeName || tenant.legalName}</strong> <span className="text-slate-400">{tenant.cnpj}</span></span>
                  <select
                    value={networkOfTenant(tenant.id)}
                    disabled={busy}
                    onChange={event => void run(() => platformSetTenantNetwork(tenant.id, event.target.value || null), 'Franqueado atualizado.')}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5"
                  >
                    <option value="">Sem rede</option>
                    {networks.map(network => <option key={network.id} value={network.id}>{network.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
