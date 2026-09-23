import { FormEvent, useState } from 'react';
import { Building2, Check, Pencil, Plus, Save, Store, Trash2, UserRound, Users } from 'lucide-react';
import { PdvOperator, PdvOperatorPermissions, StoreConfig, User, UserRole } from '../types';

interface ConfiguracoesViewProps {
  currentUser: User;
  storeConfigs: StoreConfig[];
  pdvOperators: PdvOperator[];
  updateCurrentUserDisplayName: (displayName: string) => Promise<void>;
  updateStoreConfig: (unitId: string, updated: Partial<StoreConfig>) => Promise<void>;
  deleteStoreConfig: (unitId: string) => Promise<void>;
  savePdvOperator: (operator: Omit<PdvOperator, 'tenantId' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  deletePdvOperator: (id: string) => Promise<void>;
}

const EMPTY_STORE: Omit<StoreConfig, 'unitId'> = {
  tradeName: '',
  legalName: '',
  cnpj: '',
  stateRegistration: '',
  address: '',
  phone: '',
  contactEmail: '',
  fixedCost: 0,
  paymentFees: { DINHEIRO: 0, PIX: 0, CREDITO: 0, DEBITO: 0 }
};

const EMPTY_OPERATOR_PERMISSIONS: PdvOperatorPermissions = {
  canRegisterSales: false,
  canApplyDiscount: false,
  canCancelSales: false,
  canOpenCash: false,
  canCloseCash: false
};

const operatorPermissionLabels: Record<keyof PdvOperatorPermissions, string> = {
  canRegisterSales: 'Registrar vendas',
  canApplyDiscount: 'Aplicar desconto',
  canCancelSales: 'Cancelar vendas',
  canOpenCash: 'Abrir caixa',
  canCloseCash: 'Fechar caixa'
};

const createUnitId = (tradeName: string) => {
  const normalized = tradeName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  return `loja_${normalized || Date.now().toString(36)}`;
};

export default function ConfiguracoesView({
  currentUser,
  storeConfigs,
  pdvOperators,
  updateCurrentUserDisplayName,
  updateStoreConfig,
  deleteStoreConfig,
  savePdvOperator,
  deletePdvOperator
}: ConfiguracoesViewProps) {
  const [displayName, setDisplayName] = useState(currentUser.name);
  const [profileMessage, setProfileMessage] = useState('');
  const [profileError, setProfileError] = useState('');
  const [editingUnitId, setEditingUnitId] = useState<string | null>(null);
  const [storeForm, setStoreForm] = useState<Omit<StoreConfig, 'unitId'>>(EMPTY_STORE);
  const [storeMessage, setStoreMessage] = useState('');
  const [storeError, setStoreError] = useState('');
  const [editingOperatorId, setEditingOperatorId] = useState<string | null>(null);
  const [operatorForm, setOperatorForm] = useState({ name: '', unitId: '', permissions: EMPTY_OPERATOR_PERMISSIONS, isActive: true });
  const [operatorMessage, setOperatorMessage] = useState('');
  const [operatorError, setOperatorError] = useState('');
  const canManageOperators = currentUser.role === UserRole.ADMIN || currentUser.role === UserRole.MANAGER;

  const updateStoreField = <K extends keyof Omit<StoreConfig, 'unitId'>>(field: K, value: Omit<StoreConfig, 'unitId'>[K]) => {
    setStoreForm(previous => ({ ...previous, [field]: value }));
  };

  const handleProfileSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProfileError('');
    setProfileMessage('');

    if (!displayName.trim()) {
      setProfileError('Informe um nome de exibição.');
      return;
    }

    try {
      await updateCurrentUserDisplayName(displayName.trim());
      setProfileMessage('Nome de exibição atualizado.');
    } catch (error: any) {
      setProfileError(error?.message || 'Não foi possível atualizar o nome de exibição.');
    }
  };

  const handleStoreSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setStoreError('');
    setStoreMessage('');

    if (!storeForm.tradeName?.trim() || !storeForm.legalName?.trim() || !storeForm.cnpj?.trim()) {
      setStoreError('Nome fantasia, razão social e CNPJ são obrigatórios.');
      return;
    }

    const unitId = editingUnitId || createUnitId(storeForm.tradeName);
    if (!editingUnitId && storeConfigs.some(store => store.unitId === unitId)) {
      setStoreError('Já existe uma loja com este identificador. Use outro nome fantasia.');
      return;
    }

    try {
      await updateStoreConfig(unitId, storeForm);
      setStoreMessage(editingUnitId ? 'Dados da loja atualizados.' : 'Loja cadastrada com sucesso.');
      setEditingUnitId(null);
      setStoreForm(EMPTY_STORE);
    } catch (error: any) {
      setStoreError(error?.message || 'Não foi possível salvar os dados da loja.');
    }
  };

  const editStore = (store: StoreConfig) => {
    setEditingUnitId(store.unitId);
    setStoreForm({
      tradeName: store.tradeName || '',
      legalName: store.legalName || '',
      cnpj: store.cnpj || '',
      stateRegistration: store.stateRegistration || '',
      address: store.address || '',
      phone: store.phone || '',
      contactEmail: store.contactEmail || '',
      fixedCost: store.fixedCost,
      paymentFees: store.paymentFees
    });
    setStoreError('');
    setStoreMessage('');
  };

  const removeStore = async (store: StoreConfig) => {
    setStoreError('');
    setStoreMessage('');

    try {
      await deleteStoreConfig(store.unitId);
      if (editingUnitId === store.unitId) {
        setEditingUnitId(null);
        setStoreForm(EMPTY_STORE);
      }
      setStoreMessage('Loja excluída com sucesso.');
    } catch (error: any) {
      setStoreError(error?.message || 'Não foi possível excluir a loja.');
    }
  };

  const resetOperatorForm = () => {
    setEditingOperatorId(null);
    setOperatorForm({ name: '', unitId: '', permissions: EMPTY_OPERATOR_PERMISSIONS, isActive: true });
  };

  const handleOperatorSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setOperatorError('');
    setOperatorMessage('');

    if (!operatorForm.name.trim()) {
      setOperatorError('Informe o nome do operador.');
      return;
    }

    try {
      await savePdvOperator({
        id: editingOperatorId || crypto.randomUUID(),
        name: operatorForm.name.trim(),
        unitId: operatorForm.unitId || null,
        permissions: operatorForm.permissions,
        isActive: operatorForm.isActive
      });
      setOperatorMessage(editingOperatorId ? 'Operador atualizado.' : 'Operador cadastrado.');
      resetOperatorForm();
    } catch (error: any) {
      setOperatorError(error?.message || 'Não foi possível salvar o operador.');
    }
  };

  const editOperator = (operator: PdvOperator) => {
    setEditingOperatorId(operator.id);
    setOperatorForm({
      name: operator.name,
      unitId: operator.unitId || '',
      permissions: { ...EMPTY_OPERATOR_PERMISSIONS, ...operator.permissions },
      isActive: operator.isActive
    });
    setOperatorError('');
    setOperatorMessage('');
  };

  const removeOperator = async (operator: PdvOperator) => {
    setOperatorError('');
    setOperatorMessage('');
    try {
      await deletePdvOperator(operator.id);
      if (editingOperatorId === operator.id) resetOperatorForm();
      setOperatorMessage('Operador excluído.');
    } catch (error: any) {
      setOperatorError(error?.message || 'Não foi possível excluir o operador.');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Configurações</h2>
        <p className="mt-1 text-xs text-slate-500">Gerencie sua identificação no ERP e os dados cadastrais das unidades.</p>
      </div>

      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <UserRound className="w-5 h-5 text-blue-600" />
          <div>
            <h3 className="text-sm font-bold text-slate-900">Perfil do usuário</h3>
            <p className="text-xs text-slate-500">Este nome aparece no cabeçalho e nos novos registros criados por você.</p>
          </div>
        </div>

        {profileError && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{profileError}</p>}
        {profileMessage && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><Check className="w-4 h-4" />{profileMessage}</p>}

        <form onSubmit={handleProfileSubmit} className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <label className="flex-1 text-xs font-bold text-slate-700">
            Nome de exibição
            <input
              type="text"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-medium outline-none focus:ring-1 focus:ring-blue-500"
            />
          </label>
          <button type="submit" className="px-4 py-2.5 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 flex items-center justify-center gap-2">
            <Save className="w-4 h-4" />Salvar perfil
          </button>
        </form>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Store className="w-5 h-5 text-blue-600" />
            <div>
              <h3 className="text-sm font-bold text-slate-900">Lojas cadastradas</h3>
              <p className="text-xs text-slate-500">Unidades são entidades da empresa, sem vínculo direto a um usuário específico.</p>
            </div>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
                <tr>
                  <th className="p-3">Loja</th>
                  <th className="p-3">CNPJ</th>
                  <th className="p-3">Contato</th>
                  <th className="p-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {storeConfigs.map(store => (
                  <tr key={store.unitId}>
                    <td className="p-3">
                      <span className="font-bold text-slate-900 block">{store.tradeName || store.unitId}</span>
                      <span className="text-slate-500">{store.legalName || 'Razão social não informada'}</span>
                    </td>
                    <td className="p-3 text-slate-600">{store.cnpj || 'Não informado'}</td>
                    <td className="p-3 text-slate-600">{store.contactEmail || store.phone || 'Não informado'}</td>
                    <td className="p-3">
                      <div className="flex justify-end items-center gap-1">
                        <button
                          type="button"
                          onClick={() => editStore(store)}
                          title="Editar loja"
                          aria-label={`Editar ${store.tradeName || store.unitId}`}
                          className="p-2 text-blue-700 rounded-lg hover:bg-blue-50 hover:text-blue-900 transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeStore(store)}
                          title="Excluir loja"
                          aria-label={`Excluir ${store.tradeName || store.unitId}`}
                          className="p-2 text-rose-600 rounded-lg hover:bg-rose-50 hover:text-rose-800 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {storeConfigs.length === 0 && (
                  <tr><td colSpan={4} className="p-8 text-center text-slate-400">Nenhuma loja cadastrada.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <form onSubmit={handleStoreSubmit} className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 h-fit">
          <div className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-600" />
            <h3 className="text-sm font-bold text-slate-900">{editingUnitId ? 'Editar loja' : 'Cadastrar loja'}</h3>
          </div>

          {storeError && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{storeError}</p>}
          {storeMessage && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{storeMessage}</p>}

          <StoreFields form={storeForm} onChange={updateStoreField} />

          <div className="flex gap-2 pt-1">
            {editingUnitId && <button type="button" onClick={() => { setEditingUnitId(null); setStoreForm(EMPTY_STORE); }} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>}
            <button type="submit" className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 flex items-center gap-2">
              {editingUnitId ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              {editingUnitId ? 'Salvar alterações' : 'Cadastrar loja'}
            </button>
          </div>
        </form>
      </section>

      {canManageOperators && (
        <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6">
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-600" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">Operadores do PDV</h3>
                <p className="text-xs text-slate-500">Cadastros sem e-mail, senha ou conta de acesso.</p>
              </div>
            </div>
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]"><tr><th className="p-3">Operador</th><th className="p-3">Loja</th><th className="p-3">Situação</th><th className="p-3 text-right">Ações</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {pdvOperators.map(operator => {
                    const permissionCount = Object.values(operator.permissions).filter(Boolean).length;
                    const store = storeConfigs.find(item => item.unitId === operator.unitId);
                    return <tr key={operator.id}><td className="p-3"><span className="block font-bold text-slate-900">{operator.name}</span><span className="text-slate-500">{permissionCount} permissões</span></td><td className="p-3 text-slate-600">{store?.tradeName || store?.legalName || (operator.unitId ? operator.unitId : 'Todas as lojas')}</td><td className="p-3"><span className={`rounded px-2 py-1 text-[10px] font-bold ${operator.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{operator.isActive ? 'ATIVO' : 'INATIVO'}</span></td><td className="p-3"><div className="flex justify-end gap-1"><button type="button" onClick={() => editOperator(operator)} title="Editar operador" className="p-2 text-blue-700 rounded-lg hover:bg-blue-50"><Pencil className="w-4 h-4" /></button><button type="button" onClick={() => void removeOperator(operator)} title="Excluir operador" className="p-2 text-rose-600 rounded-lg hover:bg-rose-50"><Trash2 className="w-4 h-4" /></button></div></td></tr>;
                  })}
                  {pdvOperators.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-slate-400">Nenhum operador cadastrado.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <form onSubmit={handleOperatorSubmit} className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 h-fit">
            <div className="flex items-center gap-2"><Users className="w-5 h-5 text-blue-600" /><h3 className="text-sm font-bold text-slate-900">{editingOperatorId ? 'Editar operador' : 'Cadastrar operador'}</h3></div>
            {operatorError && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{operatorError}</p>}
            {operatorMessage && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{operatorMessage}</p>}
            <label className="block text-xs font-bold text-slate-700">Nome<input required value={operatorForm.name} onChange={event => setOperatorForm({ ...operatorForm, name: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-medium outline-none focus:ring-1 focus:ring-blue-500" /></label>
            <label className="block text-xs font-bold text-slate-700">Loja <span className="font-normal text-slate-400">(opcional)</span><select value={operatorForm.unitId} onChange={event => setOperatorForm({ ...operatorForm, unitId: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-medium outline-none focus:ring-1 focus:ring-blue-500"><option value="">Todas as lojas</option>{storeConfigs.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.legalName || store.unitId}</option>)}</select></label>
            <fieldset className="space-y-2"><legend className="text-xs font-bold text-slate-700">Permissões</legend>{(Object.keys(operatorPermissionLabels) as Array<keyof PdvOperatorPermissions>).map(permission => <label key={permission} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={operatorForm.permissions[permission]} onChange={event => setOperatorForm({ ...operatorForm, permissions: { ...operatorForm.permissions, [permission]: event.target.checked } })} />{operatorPermissionLabels[permission]}</label>)}</fieldset>
            <label className="flex items-center gap-2 text-xs font-bold text-slate-700"><input type="checkbox" checked={operatorForm.isActive} onChange={event => setOperatorForm({ ...operatorForm, isActive: event.target.checked })} />Operador ativo</label>
            <div className="flex gap-2 pt-1">{editingOperatorId && <button type="button" onClick={resetOperatorForm} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>}<button type="submit" className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 flex items-center gap-2">{editingOperatorId ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}{editingOperatorId ? 'Salvar alterações' : 'Cadastrar operador'}</button></div>
          </form>
        </section>
      )}
    </div>
  );
}

function StoreFields({ form, onChange }: {
  form: Omit<StoreConfig, 'unitId'>;
  onChange: <K extends keyof Omit<StoreConfig, 'unitId'>>(field: K, value: Omit<StoreConfig, 'unitId'>[K]) => void;
}) {
  const fields: { field: keyof Omit<StoreConfig, 'unitId'>; label: string; type?: string }[] = [
    { field: 'tradeName', label: 'Nome fantasia' },
    { field: 'legalName', label: 'Razão social' },
    { field: 'cnpj', label: 'CNPJ' },
    { field: 'stateRegistration', label: 'Inscrição estadual' },
    { field: 'address', label: 'Endereço completo' },
    { field: 'phone', label: 'Telefone' },
    { field: 'contactEmail', label: 'E-mail de contato', type: 'email' }
  ];

  return (
    <div className="space-y-3">
      {fields.map(({ field, label, type = 'text' }) => (
        <label key={field} className="block text-xs font-bold text-slate-700">
          {label}
          <input
            type={type}
            value={(form[field] as string) || ''}
            onChange={event => onChange(field, event.target.value as never)}
            className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium"
          />
        </label>
      ))}
    </div>
  );
}
