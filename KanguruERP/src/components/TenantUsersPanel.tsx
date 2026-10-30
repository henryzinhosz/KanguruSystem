import { FormEvent, useEffect, useState } from 'react';
import { Check, KeyRound, Pencil, Plus, UserCog, X } from 'lucide-react';
import { DEFAULT_MANAGER_PERMISSIONS, ERP_AREA_LABELS, ErpArea, ErpPermissions, StoreConfig, TenantUser, User } from '../types';
import { supabaseService } from '../db/supabaseService';

// Usuarios do ERP (equipe do franqueado): o dono cria logins de Administrador ou Gerente
// de loja (uma ou mais lojas, areas marcaveis), edita, troca a senha e desativa.

interface TenantUsersPanelProps {
  currentUser: User;
  storeConfigs: StoreConfig[];
}

type FormState = {
  authUid: string | null;
  name: string;
  email: string;
  password: string;
  role: 'ADMIN' | 'MANAGER';
  stores: string[];
  permissions: ErpPermissions;
};

const EMPTY_FORM: FormState = { authUid: null, name: '', email: '', password: '', role: 'MANAGER', stores: [], permissions: DEFAULT_MANAGER_PERMISSIONS };
const MIN_PASSWORD = 8;
const AREAS = Object.keys(ERP_AREA_LABELS) as ErpArea[];

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || fallback;

export default function TenantUsersPanel({ currentUser, storeConfigs }: TenantUsersPanelProps) {
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [passwordFor, setPasswordFor] = useState<TenantUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modalError, setModalError] = useState('');
  const [message, setMessage] = useState('');

  const load = () => supabaseService.listTenantUsers().then(setUsers).catch(loadError => setError(errorText(loadError, 'Não foi possível carregar os usuários.')));
  useEffect(() => { void load(); }, []);

  function edit(user: TenantUser) {
    setModalError('');
    setForm({
      authUid: user.authUid,
      name: user.displayName,
      email: user.email,
      password: '',
      role: user.role === 'ADMIN' ? 'ADMIN' : 'MANAGER',
      stores: user.stores,
      permissions: user.permissions ?? DEFAULT_MANAGER_PERMISSIONS,
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setModalError('');
    if (!form.name.trim()) return setModalError('Informe o nome.');
    if (form.role === 'MANAGER' && form.stores.length === 0) return setModalError('Marque ao menos uma loja para o gerente.');
    if (!form.authUid && form.password.length < MIN_PASSWORD) return setModalError(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
    setBusy(true);
    try {
      const permissions = form.role === 'MANAGER' ? form.permissions : null;
      if (form.authUid) {
        await supabaseService.saveTenantUser({ authUid: form.authUid, displayName: form.name.trim(), role: form.role, stores: form.stores, permissions });
        setMessage(`Usuário ${form.name.trim()} atualizado. As mudanças valem no próximo acesso dele.`);
      } else {
        await supabaseService.manageTenantUser({
          action: 'create',
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
          stores: form.role === 'MANAGER' ? form.stores : [],
          permissions,
        });
        setMessage(`Usuário ${form.name.trim()} criado. Ele entra no ERP com o e-mail ${form.email.trim()} e a senha que você definiu.`);
      }
      setForm(null);
      await load();
    } catch (saveError) {
      setModalError(errorText(saveError, 'Não foi possível salvar o usuário.'));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (!passwordFor) return;
    setModalError('');
    if (newPassword.length < MIN_PASSWORD) return setModalError(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
    setBusy(true);
    try {
      await supabaseService.manageTenantUser({ action: 'set_password', authUid: passwordFor.authUid, password: newPassword });
      setMessage(`Senha de ${passwordFor.displayName} trocada.`);
      setPasswordFor(null);
      setNewPassword('');
    } catch (saveError) {
      setModalError(errorText(saveError, 'Não foi possível trocar a senha.'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(user: TenantUser) {
    const activate = !user.isActive;
    if (!window.confirm(activate ? `Reativar o acesso de ${user.displayName}?` : `Desativar ${user.displayName}? Ele deixa de conseguir entrar no ERP (nada é apagado).`)) return;
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await supabaseService.manageTenantUser({ action: 'set_active', authUid: user.authUid, active: activate });
      setMessage(activate ? `${user.displayName} reativado.` : `${user.displayName} desativado.`);
      await load();
    } catch (toggleError) {
      setError(errorText(toggleError, 'Não foi possível alterar o usuário.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
      <div className="flex items-start gap-2">
        <UserCog className="w-5 h-5 text-blue-600 mt-0.5" />
        <div className="mr-auto">
          <h3 className="text-sm font-bold text-slate-900">Usuários do ERP</h3>
          <p className="text-xs text-slate-500">Logins da sua equipe. O gerente vê só as lojas marcadas para ele e as áreas liberadas. Configurações, senha Gerente e usuários ficam só com administradores.</p>
        </div>
        <button type="button" onClick={() => { setModalError(''); setForm({ ...EMPTY_FORM, stores: stores.length === 1 ? [stores[0].unitId] : [] }); }} className="px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 flex items-center gap-1.5 shrink-0"><Plus className="w-4 h-4" />Novo usuário</button>
      </div>
      {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {message && <p role="status" className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><Check className="w-4 h-4" />{message}</p>}

      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
            <tr><th className="p-3">Nome</th><th className="p-3">Perfil</th><th className="p-3">Lojas</th><th className="p-3">Áreas</th><th className="p-3">Situação</th><th className="p-3 text-right">Ações</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.map(user => {
              const isSelf = user.authUid === currentUser.id;
              const permissions = user.permissions ?? DEFAULT_MANAGER_PERMISSIONS;
              return (
                <tr key={user.authUid} className={user.isActive ? '' : 'opacity-60'}>
                  <td className="p-3"><span className="block font-bold text-slate-900">{user.displayName || '—'}{isSelf ? ' (você)' : ''}</span><span className="text-slate-500">{user.email}</span></td>
                  <td className="p-3">{user.role === 'ADMIN' ? 'Administrador' : 'Gerente de loja'}</td>
                  <td className="p-3 text-slate-600">{user.role === 'ADMIN' ? 'Todas' : user.stores.map(storeName).join(', ') || '—'}</td>
                  <td className="p-3 text-slate-600">{user.role === 'ADMIN' ? 'Todas' : AREAS.filter(area => permissions[area]).map(area => ERP_AREA_LABELS[area]).join(', ') || 'Nenhuma'}</td>
                  <td className="p-3">
                    <span className={`px-2 py-1 rounded text-[10px] font-bold ${user.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{user.isActive ? 'ATIVO' : 'DESATIVADO'}</span>
                    {user.lastSignInAt && <span className="block text-[10px] text-slate-400 mt-1">Último acesso {new Date(user.lastSignInAt).toLocaleDateString('pt-BR')}</span>}
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      <button type="button" title="Editar" onClick={() => edit(user)} className="p-2 text-blue-700 rounded-lg hover:bg-blue-50"><Pencil className="w-4 h-4" /></button>
                      <button type="button" title="Trocar senha" onClick={() => { setModalError(''); setNewPassword(''); setPasswordFor(user); }} className="p-2 text-slate-700 rounded-lg hover:bg-slate-100"><KeyRound className="w-4 h-4" /></button>
                      {!isSelf && (
                        <button type="button" disabled={busy} onClick={() => void toggleActive(user)} className={`px-2 py-1 text-[11px] font-bold rounded-lg ${user.isActive ? 'text-rose-700 hover:bg-rose-50' : 'text-emerald-700 hover:bg-emerald-50'}`}>{user.isActive ? 'Desativar' : 'Reativar'}</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-400">Carregando...</td></tr>}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="presentation" onKeyDown={event => { if (event.key === 'Escape') setForm(null); }}>
          <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="tenant-user-title" className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 id="tenant-user-title" className="text-sm font-bold text-slate-900">{form.authUid ? `Editar · ${form.name}` : 'Novo usuário do ERP'}</h3>
              <button type="button" onClick={() => setForm(null)} title="Fechar" aria-label="Fechar" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            {modalError && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{modalError}</p>}
            <label className="block text-xs font-bold text-slate-700">Nome
              <input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none font-normal" />
            </label>
            {!form.authUid && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block text-xs font-bold text-slate-700">E-mail (login)
                  <input type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none font-normal" />
                </label>
                <label className="block text-xs font-bold text-slate-700">Senha inicial (mín. {MIN_PASSWORD})
                  <input type="password" autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none font-normal" />
                </label>
              </div>
            )}
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-bold text-slate-700 mb-1">Perfil</legend>
              {(['MANAGER', 'ADMIN'] as const).map(role => (
                <label key={role} className="flex items-start gap-2 text-xs text-slate-700">
                  <input type="radio" name="role" checked={form.role === role} disabled={form.authUid === currentUser.id && role === 'MANAGER'} onChange={() => setForm({ ...form, role })} className="mt-0.5" />
                  <span><strong>{role === 'ADMIN' ? 'Administrador' : 'Gerente de loja'}</strong> — {role === 'ADMIN' ? 'acesso total, como o dono.' : 'só as lojas e áreas marcadas abaixo.'}</span>
                </label>
              ))}
            </fieldset>
            {form.role === 'MANAGER' && (
              <>
                <fieldset>
                  <legend className="text-xs font-bold text-slate-700 mb-1">Lojas</legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {stores.map(store => (
                      <label key={store.unitId} className="flex items-center gap-1.5 text-xs text-slate-700">
                        <input type="checkbox" checked={form.stores.includes(store.unitId)} onChange={event => setForm({ ...form, stores: event.target.checked ? [...form.stores, store.unitId] : form.stores.filter(item => item !== store.unitId) })} />
                        {store.tradeName || store.unitId}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-xs font-bold text-slate-700 mb-1">Áreas liberadas</legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {AREAS.map(area => (
                      <label key={area} className="flex items-center gap-1.5 text-xs text-slate-700">
                        <input type="checkbox" checked={Boolean(form.permissions[area])} onChange={event => setForm({ ...form, permissions: { ...form.permissions, [area]: event.target.checked } })} />
                        {ERP_AREA_LABELS[area]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setForm(null)} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>
              <button type="submit" disabled={busy} className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-60">{busy ? 'Salvando...' : form.authUid ? 'Salvar alterações' : 'Criar usuário'}</button>
            </div>
          </form>
        </div>
      )}

      {passwordFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="presentation" onKeyDown={event => { if (event.key === 'Escape') setPasswordFor(null); }}>
          <form onSubmit={changePassword} role="dialog" aria-modal="true" aria-labelledby="tenant-password-title" className="w-full max-w-sm bg-white border border-slate-200 rounded-xl shadow-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 id="tenant-password-title" className="text-sm font-bold text-slate-900">Nova senha · {passwordFor.displayName}</h3>
              <button type="button" onClick={() => setPasswordFor(null)} title="Fechar" aria-label="Fechar" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            {modalError && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{modalError}</p>}
            <label className="block text-xs font-bold text-slate-700">Nova senha (mín. {MIN_PASSWORD})
              <input type="password" autoFocus autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none font-normal" />
            </label>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setPasswordFor(null)} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>
              <button type="submit" disabled={busy} className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-60">{busy ? 'Salvando...' : 'Trocar senha'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
