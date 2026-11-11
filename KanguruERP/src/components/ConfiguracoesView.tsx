import { FormEvent, useEffect, useState } from 'react';
import { Building2, Check, ChevronDown, Pencil, Plus, Save, Store, Trash2, UserRound, Users, X } from 'lucide-react';
import { PdvOperator, PdvOperatorPermissions, StoreConfig, StoreNfceStatus, User, UserRole } from '../types';
import { supabaseService } from '../db/supabaseService';
import ValueInput from './ValueInput';
import ManagerPasswordPanel from './ManagerPasswordPanel';
import TenantUsersPanel from './TenantUsersPanel';
import FranchiseeContactPanel from './FranchiseeContactPanel';

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

// Mesmo texto padrao do PDV (KanguruPDV/src/app/reservationVoucher.ts).
// Mesmo texto padrao do PDV (KanguruPDV/src/app/tradeInTermPrint.ts).
const DEFAULT_TRADE_IN_TERMS = 'Declaro, para todos os fins de direito, que sou o legítimo proprietário do equipamento descrito acima, que ele tem origem lícita e não é produto de furto, roubo, receptação ou de qualquer outro crime, assumindo integral responsabilidade civil e criminal por esta declaração.\n\nDeclaro que o equipamento está livre de dívidas, alienação, penhora ou bloqueio, e transfiro à loja a sua propriedade pelo valor acima, dando plena e total quitação, sem nada mais a reclamar.\n\nEstou ciente de que a loja pode consultar a procedência do equipamento e comunicar às autoridades competentes qualquer suspeita de irregularidade.\n\nAutorizo o uso dos meus dados pessoais exclusivamente para o registro desta operação, nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018).';
const DEFAULT_WORK_ORDER_TERMS = "O valor dos serviços é uma estimativa e pode mudar após a análise técnica. A loja avisa o cliente e só executa serviço com valor diferente depois da autorização dele.\n\nA loja não se responsabiliza por dados, jogos, contas ou arquivos salvos no aparelho. Recomendamos fazer cópia de segurança antes de deixar o aparelho.\n\nA abertura do aparelho pode romper o selo de garantia do fabricante.\n\nAparelho não retirado em até 90 (noventa) dias após o aviso de que está pronto poderá ser considerado abandonado, nos termos da lei.\n\nA retirada só é feita com este comprovante ou pelo próprio cliente com documento com foto.\n\nAutorizo o uso dos meus dados pessoais exclusivamente para o atendimento desta ordem de serviço, nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018).";
const DEFAULT_WORK_ORDER_DELIVERY_TERMS = "Declaro que recebi o equipamento descrito acima, testado na minha presença, funcionando quanto aos serviços executados, nada mais tendo a reclamar.\n\nA garantia de 90 (noventa) dias cobre somente os serviços executados e as peças trocadas (Código de Defesa do Consumidor, art. 26). Não cobre mau uso, quedas, contato com líquidos, oxidação, descarga elétrica ou abertura do aparelho por terceiros.\n\nPara usar a garantia, apresente este comprovante.";

const DEFAULT_VOUCHER_TERMS =
  'Reserva de compra garantida. Para retirada do produto, apresente este voucher juntamente com a nota emitida. ' +
  'Não será aceita desistência nem devolução de valores e itens negociados. ' +
  'Através deste, o cliente declara estar ciente e de acordo.';

const EMPTY_STORE: Omit<StoreConfig, 'unitId'> = {
  tradeName: '',
  legalName: '',
  cnpj: '',
  stateRegistration: '',
  address: '',
  phone: '',
  contactEmail: '',
  reservationVoucherTerms: '',
  tradeInTerms: '',
  workOrderTerms: '',
  workOrderDeliveryTerms: '',
  instagram: '',
  municipalRegistration: '',
  cityIbgeCode: '',
  simplesNacionalOption: '3',
  exchangeDays: 7,
  quoteMinMargin: 30,
  quoteInstallmentMarkup: 13,
  quoteValidDays: 3,
  cashDifferenceAlert: 10,
  fixedCost: 0,
  maxItemDiscountPercent: 0,
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
  // Cadastro/edicao de loja em janela (modal) sobre o ERP.
  const [storeModalOpen, setStoreModalOpen] = useState(false);
  // NFC-e: a chave da Focus e configurada no UCP; aqui so a situacao de cada loja.
  const [nfceStatus, setNfceStatus] = useState<StoreNfceStatus[]>([]);
  useEffect(() => {
    supabaseService.getStoreNfceStatus().then(setNfceStatus).catch(() => setNfceStatus([]));
  }, []);
  const [storeForm, setStoreForm] = useState<Omit<StoreConfig, 'unitId'>>(EMPTY_STORE);
  const [storeMessage, setStoreMessage] = useState('');
  const [storeError, setStoreError] = useState('');
  const [editingOperatorId, setEditingOperatorId] = useState<string | null>(null);
  const [operatorForm, setOperatorForm] = useState<{ name: string; code: string; unitId: string; permissions: PdvOperatorPermissions; isActive: boolean; monthlyGoal: number | null }>({ name: '', code: '', unitId: '', permissions: EMPTY_OPERATOR_PERMISSIONS, isActive: true, monthlyGoal: null });
  const [operatorMessage, setOperatorMessage] = useState('');
  const [operatorError, setOperatorError] = useState('');
  const canManageOperators = currentUser.role === UserRole.ADMIN || currentUser.role === UserRole.MANAGER;
  type SettingsTab = 'conta' | 'lojas' | 'pdv' | 'usuarios';
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('conta');
  const settingsTabs = ([
    ['conta', 'Minha conta'],
    ['lojas', 'Lojas'],
    ...(canManageOperators ? [['pdv', 'Configurações do PDV']] : []),
    ...(currentUser.role === UserRole.ADMIN ? [['usuarios', 'Usuários do ERP']] : []),
  ] as [SettingsTab, string][]);
  // Janela da loja dividida em abas.
  const [storeSection, setStoreSection] = useState<StoreSection>('dados');

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
      setStoreModalOpen(false);
    } catch (error: any) {
      setStoreError(error?.message || 'Não foi possível salvar os dados da loja.');
    }
  };

  const openNewStore = () => {
    setEditingUnitId(null);
    setStoreForm(EMPTY_STORE);
    setStoreError('');
    setStoreMessage('');
    setStoreSection('dados');
    setStoreModalOpen(true);
  };

  const closeStoreModal = () => {
    setStoreModalOpen(false);
    setEditingUnitId(null);
    setStoreForm(EMPTY_STORE);
    setStoreError('');
  };

  const editStore = (store: StoreConfig) => {
    setStoreSection('dados');
    setStoreModalOpen(true);
    setEditingUnitId(store.unitId);
    setStoreForm({
      tradeName: store.tradeName || '',
      legalName: store.legalName || '',
      cnpj: store.cnpj || '',
      stateRegistration: store.stateRegistration || '',
      address: store.address || '',
      phone: store.phone || '',
      contactEmail: store.contactEmail || '',
      reservationVoucherTerms: store.reservationVoucherTerms || '',
      tradeInTerms: store.tradeInTerms || '',
      workOrderTerms: store.workOrderTerms || '',
      workOrderDeliveryTerms: store.workOrderDeliveryTerms || '',
      instagram: store.instagram || '',
      municipalRegistration: store.municipalRegistration || '',
      cityIbgeCode: store.cityIbgeCode || '',
      simplesNacionalOption: store.simplesNacionalOption || '3',
      exchangeDays: store.exchangeDays ?? 7,
      quoteMinMargin: store.quoteMinMargin ?? 30,
      quoteInstallmentMarkup: store.quoteInstallmentMarkup ?? 13,
      quoteValidDays: store.quoteValidDays ?? 3,
      cashDifferenceAlert: store.cashDifferenceAlert ?? 10,
      fixedCost: store.fixedCost,
      maxItemDiscountPercent: store.maxItemDiscountPercent,
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
    setOperatorForm({ name: '', code: '', unitId: '', permissions: EMPTY_OPERATOR_PERMISSIONS, isActive: true, monthlyGoal: null });
  };

  const handleOperatorSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setOperatorError('');
    setOperatorMessage('');

    if (!operatorForm.name.trim()) {
      setOperatorError('Informe o nome do operador.');
      return;
    }
    // Codigo de 2 digitos (01 a 99); "7" vira "07".
    const trimmedCode = operatorForm.code.trim();
    const code = /^[0-9]{1,2}$/.test(trimmedCode) ? trimmedCode.padStart(2, '0') : '';
    if (!code || code === '00') {
      setOperatorError('Informe o código do vendedor: 2 dígitos, de 01 a 99.');
      return;
    }
    if (!operatorForm.unitId) {
      setOperatorError('Selecione a loja do vendedor.');
      return;
    }
    const duplicate = pdvOperators.find(operator =>
      operator.id !== editingOperatorId && operator.isActive && operatorForm.isActive
      && operator.unitId === operatorForm.unitId && operator.code === code
    );
    if (duplicate) {
      setOperatorError(`Já existe um vendedor ativo com o código ${code} nesta loja (${duplicate.name}).`);
      return;
    }

    try {
      await savePdvOperator({
        id: editingOperatorId || crypto.randomUUID(),
        name: operatorForm.name.trim(),
        code,
        unitId: operatorForm.unitId,
        permissions: operatorForm.permissions,
        isActive: operatorForm.isActive,
        monthlyGoal: operatorForm.monthlyGoal && operatorForm.monthlyGoal > 0 ? operatorForm.monthlyGoal : null
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
      code: operator.code || '',
      unitId: operator.unitId || '',
      permissions: { ...EMPTY_OPERATOR_PERMISSIONS, ...operator.permissions },
      isActive: operator.isActive,
      monthlyGoal: operator.monthlyGoal ?? null
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
        <p className="mt-1 text-xs text-slate-500">Sua conta, as lojas, o PDV e a equipe do ERP.</p>
      </div>

      {/* Abas: cada parte das configuracoes na sua aba (como no Catalogo & Estoque). */}
      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {settingsTabs.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setSettingsTab(id)} className={`px-4 py-2 text-xs font-bold border-b-2 -mb-px ${settingsTab === id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>
        ))}
      </div>

      {settingsTab === 'conta' && (
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <UserRound className="w-5 h-5 text-blue-600" />
            <div>
              <h3 className="text-sm font-bold text-slate-900">Perfil do usuário</h3>
              <p className="text-xs text-slate-500">Este nome aparece no cabeçalho e nos novos registros criados por você.</p>
            </div>
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
      )}

      {settingsTab === 'conta' && currentUser.role === UserRole.ADMIN && <FranchiseeContactPanel />}

      {settingsTab === 'lojas' && (
      <section>
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          {storeMessage && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><Check className="w-4 h-4" />{storeMessage}</p>}
          {storeError && !storeModalOpen && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{storeError}</p>}
          <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Store className="w-5 h-5 text-blue-600" />
            <div>
              <h3 className="text-sm font-bold text-slate-900">Lojas cadastradas</h3>
              <p className="text-xs text-slate-500">Unidades são entidades da empresa, sem vínculo direto a um usuário específico.</p>
            </div>
          </div>
          <button type="button" onClick={openNewStore} className="px-4 py-2.5 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2 shrink-0">
            <Building2 className="w-4 h-4" />Criar loja
          </button>
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
                    <td className="p-3 text-slate-600">
                      {store.cnpj || 'Não informado'}
                      {(() => {
                        const nfce = nfceStatus.find(item => item.unitId === store.unitId);
                        return (
                          <span className={`mt-1 block w-fit rounded border px-1.5 text-[10px] font-bold ${nfce?.configured ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                            {nfce?.configured ? `NFC-e configurada${nfce.environment === 'homologacao' ? ' (teste)' : ''}` : 'NFC-e não configurada'}
                          </span>
                        );
                      })()}
                    </td>
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

      </section>
      )}

      {settingsTab === 'usuarios' && currentUser.role === UserRole.ADMIN && <TenantUsersPanel currentUser={currentUser} storeConfigs={storeConfigs} />}

      {storeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="presentation" onKeyDown={event => { if (event.key === 'Escape') closeStoreModal(); }}>
          <form onSubmit={handleStoreSubmit} role="dialog" aria-modal="true" aria-labelledby="store-modal-title" className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-blue-600" />
                <h3 id="store-modal-title" className="text-sm font-bold text-slate-900">{editingUnitId ? `Editar loja · ${storeForm.tradeName || editingUnitId}` : 'Criar loja'}</h3>
              </div>
              <button type="button" onClick={closeStoreModal} title="Fechar" aria-label="Fechar" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>

            {storeError && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{storeError}</p>}

            <div className="flex flex-wrap gap-1 border-b border-slate-200">
              {STORE_SECTIONS.map(([id, label]) => (
                <button key={id} type="button" onClick={() => setStoreSection(id)} className={`px-3 py-1.5 text-xs font-bold border-b-2 -mb-px ${storeSection === id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>
              ))}
            </div>

            <StoreFields form={storeForm} onChange={updateStoreField} section={storeSection} />

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={closeStoreModal} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>
              <button type="submit" className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 flex items-center gap-2">
                {editingUnitId ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {editingUnitId ? 'Salvar alterações' : 'Criar loja'}
              </button>
            </div>
          </form>
        </div>
      )}

      {settingsTab === 'pdv' && (
        <div className="space-y-6">
        {canManageOperators && (
          <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6">
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-blue-600" />
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Vendedores do PDV</h3>
                  <p className="text-xs text-slate-500">Cadastros sem e-mail, senha ou conta de acesso.</p>
                </div>
              </div>
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]"><tr><th className="p-3">Código</th><th className="p-3">Operador</th><th className="p-3">Loja</th><th className="p-3">Situação</th><th className="p-3 text-right">Ações</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {pdvOperators.map(operator => {
                      const permissionCount = Object.values(operator.permissions).filter(Boolean).length;
                      const store = storeConfigs.find(item => item.unitId === operator.unitId);
                      return <tr key={operator.id}><td className="p-3 font-mono font-bold text-slate-900">{operator.code || <span className="text-amber-700 font-sans font-normal">sem código</span>}</td><td className="p-3"><span className="block font-bold text-slate-900">{operator.name}</span><span className="text-slate-500">{permissionCount} permissões{operator.monthlyGoal ? ` · meta ${operator.monthlyGoal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}/mês` : ''}</span></td><td className="p-3 text-slate-600">{store?.tradeName || store?.legalName || (operator.unitId ? operator.unitId : 'Todas as lojas')}</td><td className="p-3"><span className={`rounded px-2 py-1 text-[10px] font-bold ${operator.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{operator.isActive ? 'ATIVO' : 'INATIVO'}</span></td><td className="p-3"><div className="flex justify-end gap-1"><button type="button" onClick={() => editOperator(operator)} title="Editar operador" className="p-2 text-blue-700 rounded-lg hover:bg-blue-50"><Pencil className="w-4 h-4" /></button><button type="button" onClick={() => void removeOperator(operator)} title="Excluir operador" className="p-2 text-rose-600 rounded-lg hover:bg-rose-50"><Trash2 className="w-4 h-4" /></button></div></td></tr>;
                    })}
                    {pdvOperators.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-slate-400">Nenhum operador cadastrado.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <form onSubmit={handleOperatorSubmit} className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 h-fit">
              <div className="flex items-center gap-2"><Users className="w-5 h-5 text-blue-600" /><h3 className="text-sm font-bold text-slate-900">{editingOperatorId ? 'Editar operador' : 'Cadastrar operador'}</h3></div>
              {operatorError && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{operatorError}</p>}
              {operatorMessage && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{operatorMessage}</p>}
              <label className="block text-xs font-bold text-slate-700">Nome<input required value={operatorForm.name} onChange={event => setOperatorForm({ ...operatorForm, name: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-medium outline-none focus:ring-1 focus:ring-blue-500" /></label>
              <label className="block text-xs font-bold text-slate-700">Código do vendedor <span className="font-normal text-slate-400">(2 dígitos, usado para finalizar vendas no PDV)</span><input required inputMode="numeric" maxLength={2} placeholder="Ex: 07" value={operatorForm.code} onChange={event => setOperatorForm({ ...operatorForm, code: event.target.value.replace(/[^0-9]/g, '').slice(0, 2) })} className="mt-1.5 w-24 bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-mono font-bold text-center tracking-widest outline-none focus:ring-1 focus:ring-blue-500" /></label>
              <label className="block text-xs font-bold text-slate-700">Loja<select required value={operatorForm.unitId} onChange={event => setOperatorForm({ ...operatorForm, unitId: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-medium outline-none focus:ring-1 focus:ring-blue-500"><option value="">Selecione a loja</option>{storeConfigs.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.legalName || store.unitId}</option>)}</select></label>
              <label className="block text-xs font-bold text-slate-700">Meta do mês (R$) <span className="font-normal text-slate-400">(opcional; só produtos, aparece no relatório "Vendas por vendedor" do PDV)</span><ValueInput value={operatorForm.monthlyGoal} onValueChange={value => setOperatorForm({ ...operatorForm, monthlyGoal: value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-medium outline-none focus:ring-1 focus:ring-blue-500" /></label>
              <fieldset className="space-y-2"><legend className="text-xs font-bold text-slate-700">Permissões</legend>{(Object.keys(operatorPermissionLabels) as Array<keyof PdvOperatorPermissions>).map(permission => <label key={permission} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={operatorForm.permissions[permission]} onChange={event => setOperatorForm({ ...operatorForm, permissions: { ...operatorForm.permissions, [permission]: event.target.checked } })} />{operatorPermissionLabels[permission]}</label>)}</fieldset>
              <label className="flex items-center gap-2 text-xs font-bold text-slate-700"><input type="checkbox" checked={operatorForm.isActive} onChange={event => setOperatorForm({ ...operatorForm, isActive: event.target.checked })} />Operador ativo</label>
              <div className="flex gap-2 pt-1">{editingOperatorId && <button type="button" onClick={resetOperatorForm} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>}<button type="submit" className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 flex items-center gap-2">{editingOperatorId ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}{editingOperatorId ? 'Salvar alterações' : 'Cadastrar operador'}</button></div>
            </form>
          </section>
        )}
          {currentUser.role === UserRole.ADMIN && <ManagerPasswordPanel storeConfigs={storeConfigs} />}
        </div>
      )}
    </div>
  );
}

type StoreSection = 'dados' | 'fiscal' | 'pdv' | 'textos';

const STORE_SECTIONS: [StoreSection, string][] = [
  ['dados', 'Dados'],
  ['fiscal', 'Fiscal'],
  ['pdv', 'Regras do PDV'],
  ['textos', 'Textos dos impressos'],
];

type StoreTextField = 'reservationVoucherTerms' | 'tradeInTerms' | 'workOrderTerms' | 'workOrderDeliveryTerms';

// Textos dos impressos da loja (cada um abre ao clicar no titulo).
const STORE_TEXTS: { field: StoreTextField; title: string; hint: string; placeholder: string; rows: number }[] = [
  { field: 'reservationVoucherTerms', title: 'Regras do voucher de reserva', hint: 'Impressas nos vouchers de reserva do PDV desta loja. Em branco usa o texto padrão.', placeholder: DEFAULT_VOUCHER_TERMS, rows: 4 },
  { field: 'tradeInTerms', title: 'Declarações do termo da Troca Gamer', hint: 'Impressas no termo de compra de videogame usado. Uma linha em branco separa os parágrafos. Em branco usa o texto padrão.', placeholder: DEFAULT_TRADE_IN_TERMS, rows: 8 },
  { field: 'workOrderTerms', title: 'Condições do comprovante de entrada da OS', hint: 'Impressas quando o cliente deixa o aparelho. Uma linha em branco separa os parágrafos. Em branco usa o texto padrão.', placeholder: DEFAULT_WORK_ORDER_TERMS, rows: 8 },
  { field: 'workOrderDeliveryTerms', title: 'Declaração do comprovante de entrega da OS', hint: 'Impressa quando o cliente retira o aparelho. Em branco usa o texto padrão.', placeholder: DEFAULT_WORK_ORDER_DELIVERY_TERMS, rows: 6 },
];

function StoreFields({ form, onChange, section }: {
  section: StoreSection;
  form: Omit<StoreConfig, 'unitId'>;
  onChange: <K extends keyof Omit<StoreConfig, 'unitId'>>(field: K, value: Omit<StoreConfig, 'unitId'>[K]) => void;
}) {
  const [openText, setOpenText] = useState<StoreTextField | null>(null);
  const fields: { field: keyof Omit<StoreConfig, 'unitId'>; label: string; type?: string; section: StoreSection }[] = [
    { field: 'tradeName', label: 'Nome fantasia', section: 'dados' },
    { field: 'legalName', label: 'Razão social', section: 'dados' },
    { field: 'cnpj', label: 'CNPJ', section: 'dados' },
    { field: 'stateRegistration', label: 'Inscrição estadual', section: 'fiscal' },
    { field: 'municipalRegistration', label: 'Inscrição municipal (NFS-e dos serviços)', section: 'fiscal' },
    { field: 'address', label: 'Endereço completo', section: 'dados' },
    { field: 'phone', label: 'Telefone', section: 'dados' },
    { field: 'contactEmail', label: 'E-mail de contato', type: 'email', section: 'dados' },
    { field: 'instagram', label: 'Instagram da loja (ex.: @bebgamescg) — vira o QR code do cupom', section: 'dados' }
  ];

  return (
    <div className="space-y-3">
      {fields.filter(entry => entry.section === section).map(({ field, label, type = 'text' }) => (
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
      {section === 'fiscal' && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-xs font-bold text-slate-700">
          Município da loja (código IBGE) <span className="font-normal text-slate-400">(NFS-e)</span>
          <div className="mt-1 flex gap-1.5">
            <input
              value={form.cityIbgeCode || ''}
              placeholder="3304557"
              onChange={event => onChange('cityIbgeCode', event.target.value.replace(/\D/g, '').slice(0, 7))}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-mono"
            />
            <button type="button" onClick={() => onChange('cityIbgeCode', '3304557')} className="shrink-0 px-2 text-[10px] font-bold border border-slate-200 rounded-lg hover:bg-slate-50" title="Rio de Janeiro">Rio (RJ)</button>
          </div>
        </label>
        <label className="block text-xs font-bold text-slate-700">
          Simples Nacional <span className="font-normal text-slate-400">(NFS-e)</span>
          <select
            value={form.simplesNacionalOption || '3'}
            onChange={event => onChange('simplesNacionalOption', event.target.value as '1' | '2' | '3')}
            className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium"
          >
            <option value="3">Optante — ME/EPP</option>
            <option value="2">Optante — MEI</option>
            <option value="1">Não optante</option>
          </select>
        </label>
      </div>}
      {section === 'pdv' && <>
      <label className="block text-xs font-bold text-slate-700">
        Limite de desconto padrão (%) <span className="font-normal text-slate-400">(usado quando o produto não tem limite próprio; vale também para serviços)</span>
        <ValueInput
          value={form.maxItemDiscountPercent || null}
          onValueChange={value => onChange('maxItemDiscountPercent', Math.min(100, value ?? 0))}
          className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium"
        />
      </label>
      <label className="block text-xs font-bold text-slate-700">
        Prazo de troca (dias) <span className="font-normal text-slate-400">(depois dele, troca/devolução no PDV só com a senha administrativa)</span>
        <ValueInput
          decimals={0}
          value={form.exchangeDays ?? 7}
          onValueChange={value => onChange('exchangeDays', Math.min(365, Math.max(0, value ?? 0)))}
          className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium"
        />
      </label>
      <label className="block text-xs font-bold text-slate-700">
        Margem mínima do orçamento de PC (%) <span className="font-normal text-slate-400">(abaixo dela, o PDV pede a senha Gerente)</span>
        <ValueInput
          value={form.quoteMinMargin ?? 30}
          onValueChange={value => onChange('quoteMinMargin', Math.min(1000, Math.max(0, value ?? 0)))}
          className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium"
        />
      </label>
      <label className="block text-xs font-bold text-slate-700">
        Acréscimo no 12x do orçamento (%) <span className="font-normal text-slate-400">(valor que o cliente paga a mais em 12x; o vendedor pode mudar no orçamento)</span>
        <ValueInput
          value={form.quoteInstallmentMarkup ?? 13}
          onValueChange={value => onChange('quoteInstallmentMarkup', Math.min(100, Math.max(0, value ?? 0)))}
          className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium"
        />
      </label>
      <label className="block text-xs font-bold text-slate-700">
        Validade do orçamento (dias)
        <ValueInput
          decimals={0}
          value={form.quoteValidDays ?? 3}
          onValueChange={value => onChange('quoteValidDays', Math.min(60, Math.max(1, value ?? 1)))}
          className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium"
        />
      </label>
      <label className="block text-xs font-bold text-slate-700">
        Alerta de diferença de caixa (R$) <span className="font-normal text-slate-400">(fechamento com diferença acima deste valor aparece em "Precisa de atenção")</span>
        <ValueInput
          value={form.cashDifferenceAlert ?? 10}
          onValueChange={value => onChange('cashDifferenceAlert', Math.max(0, value ?? 0))}
          className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium"
        />
      </label>
      </>}
      {section === 'textos' && (
        <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
          {STORE_TEXTS.map(({ field, title, hint, placeholder, rows }) => {
            const open = openText === field;
            const filled = Boolean((form[field] as string | undefined)?.trim());
            return (
              <div key={field}>
                <button
                  type="button"
                  onClick={() => setOpenText(open ? null : field)}
                  aria-expanded={open}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-xs font-bold ${open ? 'bg-blue-50 text-blue-800' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
                >
                  <span>
                    {title}
                    <span className={`ml-2 text-[10px] font-semibold ${filled ? 'text-emerald-700' : 'text-slate-400'}`}>{filled ? 'texto próprio' : 'texto padrão'}</span>
                  </span>
                  <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && (
                  <div className="px-3 pb-3 pt-1 bg-white space-y-1">
                    <p className="text-[11px] text-slate-500">{hint}</p>
                    <textarea
                      rows={rows}
                      autoFocus
                      value={(form[field] as string) || ''}
                      placeholder={placeholder}
                      onChange={event => onChange(field, event.target.value as never)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs outline-none focus:ring-1 focus:ring-blue-500 font-medium"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
