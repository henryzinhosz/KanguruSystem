import { FormEvent, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Network,
  Search,
  Store,
  Trash2,
  UserRound,
  Users,
  X
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Wallet } from 'lucide-react';
import BillingPanel from './BillingPanel';
import { getTenantBilling, setTenantSubscriptionManual, syncPlatformSubscriptions } from '../db/billing';
import { PdvOperator, PlatformPosTerminal, PlatformTenant, PlatformTenantDetails, PosTerminalActivation, PosTerminalActivationStatus, StoreNfceStatus, SubscriptionStatus } from '../types';
import { supabaseService } from '../db/supabaseService';
import NetworkAdminPanel from './NetworkAdminPanel';
import { platformListNetworks, type PlatformNetwork } from '../db/network';

interface UcpViewProps {
  onBackToErp?: () => void;
}

const subscriptionOptions: SubscriptionStatus[] = ['ATIVO', 'ATRASADO', 'BLOQUEADO', 'CANCELADO'];

const statusClassName: Record<SubscriptionStatus, string> = {
  ATIVO: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ATRASADO: 'bg-amber-50 text-amber-700 border-amber-200',
  BLOQUEADO: 'bg-rose-50 text-rose-700 border-rose-200',
  CANCELADO: 'bg-slate-100 text-slate-600 border-slate-200'
};

const formatCnpj = (value: string | null) => {
  if (!value) return 'Não informado';
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 14) return value;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
};

const formatDate = (value: string | null) => value
  ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(value))
  : 'Não informado';

const formatDateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  : '-';

const activationStatusClassName: Record<PosTerminalActivationStatus, string> = {
  PENDENTE: 'border-amber-200 bg-amber-50 text-amber-700',
  USADO: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  EXPIRADO: 'border-slate-200 bg-slate-100 text-slate-600',
  REVOGADO: 'border-rose-200 bg-rose-50 text-rose-700'
};

type UcpSection = 'clientes' | 'redes';
type DetailTab = 'lojas' | 'cobranca' | 'terminais' | 'usuarios' | 'vendedores';

const UCP_NAV: { id: UcpSection; name: string; icon: LucideIcon; description: string }[] = [
  { id: 'clientes', name: 'Clientes', icon: Building2, description: 'Franqueados que usam o sistema: assinatura, lojas, PDVs e acessos.' },
  { id: 'redes', name: 'Redes', icon: Network, description: 'Franqueadoras: a rede acompanha as franquias ligadas a ela no Painel da Rede.' },
];

const DETAIL_TABS: { id: DetailTab; name: string; icon: LucideIcon }[] = [
  { id: 'lojas', name: 'Lojas e notas', icon: Store },
  { id: 'cobranca', name: 'Cobrança', icon: Wallet },
  { id: 'terminais', name: 'Terminais PDV', icon: KeyRound },
  { id: 'usuarios', name: 'Usuários do ERP', icon: UserRound },
  { id: 'vendedores', name: 'Vendedores do PDV', icon: Users },
];

const roleLabel: Record<string, string> = { ADMIN: 'Administrador', MANAGER: 'Gerente de loja', SUPER_ADMIN: 'Plataforma' };

const normalizeSearch = (value: string | null | undefined) =>
  (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const initialsOf = (name: string) =>
  name.split(/\s+/).filter(word => word.length > 2).slice(0, 2).map(word => word[0].toUpperCase()).join('') || name.slice(0, 2).toUpperCase();

const getErrorMessage = (value: unknown, fallback: string) => (
  typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'
    ? value.message
    : fallback
);

export default function UcpView({ onBackToErp }: UcpViewProps) {
  const [tenants, setTenants] = useState<PlatformTenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<PlatformTenantDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSavingStatus, setIsSavingStatus] = useState(false);
  const [isLoadingActivations, setIsLoadingActivations] = useState(false);
  const [isCreatingActivation, setIsCreatingActivation] = useState(false);
  const [isActivationFormOpen, setIsActivationFormOpen] = useState(false);
  const [terminalActivations, setTerminalActivations] = useState<PosTerminalActivation[]>([]);
  const [posTerminals, setPosTerminals] = useState<PlatformPosTerminal[]>([]);
  const [isLoadingTerminals, setIsLoadingTerminals] = useState(false);
  const [terminalsError, setTerminalsError] = useState<string | null>(null);
  const [terminalToDelete, setTerminalToDelete] = useState<PlatformPosTerminal | null>(null);
  const [isDeletingTerminal, setIsDeletingTerminal] = useState(false);
  const [reactivatingTerminalId, setReactivatingTerminalId] = useState<string | null>(null);
  const [pdvOperators, setPdvOperators] = useState<PdvOperator[]>([]);
  const [isLoadingPdvOperators, setIsLoadingPdvOperators] = useState(false);
  const [pdvOperatorsError, setPdvOperatorsError] = useState<string | null>(null);
  const [activationHistoryError, setActivationHistoryError] = useState<string | null>(null);
  const [generatedActivationCode, setGeneratedActivationCode] = useState<string | null>(null);
  const [copiedActivationCode, setCopiedActivationCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [statusDraft, setStatusDraft] = useState<SubscriptionStatus>('ATIVO');
  const [form, setForm] = useState({ legalName: '', cnpj: '', adminEmail: '', initialPassword: '' });
  const [activationForm, setActivationForm] = useState({ unitId: '', terminalLabel: '', expiresInMinutes: 15 });
  // NFC-e por loja: so "configurada" e o ambiente voltam do banco (a chave nunca).
  const [storeFiscal, setStoreFiscal] = useState<StoreNfceStatus[]>([]);
  const [focusForm, setFocusForm] = useState<{ unitId: string; token: string; environment: 'homologacao' | 'producao' } | null>(null);
  const [isSavingFocus, setIsSavingFocus] = useState(false);
  const [section, setSection] = useState<UcpSection>('clientes');
  const [detailTab, setDetailTab] = useState<DetailTab>('lojas');
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  const [networks, setNetworks] = useState<PlatformNetwork[]>([]);

  const loadTenants = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Situacao calculada pela cobranca (sem a migration 20261122 a chamada so nao faz nada).
      await syncPlatformSubscriptions().catch(() => undefined);
      setTenants(await supabaseService.getPlatformTenants());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Não foi possível carregar os clientes.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTenants();
    // Rede de cada cliente (so informativo).
    platformListNetworks().then(setNetworks).catch(() => setNetworks([]));
  }, []);

  const loadTerminalActivations = async (tenantId: string) => {
    setIsLoadingActivations(true);
    setActivationHistoryError(null);
    try {
      setTerminalActivations(await supabaseService.getPlatformPosTerminalActivations(tenantId));
    } catch (activationError) {
      setActivationHistoryError(getErrorMessage(activationError, 'Não foi possível carregar o histórico de ativações.'));
    } finally {
      setIsLoadingActivations(false);
    }
  };

  const loadPosTerminals = async (tenantId: string) => {
    setIsLoadingTerminals(true);
    setTerminalsError(null);
    try {
      setPosTerminals(await supabaseService.getPlatformPosTerminals(tenantId));
    } catch (terminalsLoadError) {
      setTerminalsError(getErrorMessage(terminalsLoadError, 'Não foi possível carregar os terminais.'));
    } finally {
      setIsLoadingTerminals(false);
    }
  };

  // Recarrega antes de perguntar: o aviso de caixa aberto precisa estar em dia.
  const askDeleteTerminal = async (terminal: PlatformPosTerminal) => {
    if (!selectedTenant) return;
    setError(null);
    setSuccess(null);
    try {
      const fresh = await supabaseService.getPlatformPosTerminals(selectedTenant.tenant.id);
      setPosTerminals(fresh);
      setTerminalToDelete(fresh.find(item => item.id === terminal.id) ?? null);
    } catch (refreshError) {
      setError(getErrorMessage(refreshError, 'Não foi possível conferir o terminal.'));
    }
  };

  const handleReactivateTerminal = async (terminal: PlatformPosTerminal) => {
    if (!selectedTenant) return;
    setReactivatingTerminalId(terminal.id);
    setError(null);
    setSuccess(null);
    try {
      const result = await supabaseService.createPlatformPosTerminalReactivation(terminal.id);
      setGeneratedActivationCode(result.code);
      setCopiedActivationCode(false);
      setTerminalActivations(current => [result.activation, ...current]);
      setSuccess(`Código de reativação do terminal ${terminal.name} gerado (vale 15 minutos). Digite-o no PDV: o computador volta para este mesmo terminal e, se outro computador estiver usando, ele perde o acesso.`);
    } catch (reactivateError) {
      setError(getErrorMessage(reactivateError, 'Não foi possível gerar o código de reativação.'));
    } finally {
      setReactivatingTerminalId(null);
    }
  };

  const handleDeleteTerminal = async () => {
    if (!selectedTenant || !terminalToDelete) return;
    const { id, name } = terminalToDelete;
    setIsDeletingTerminal(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await supabaseService.deletePlatformPosTerminal(id);
      setTerminalToDelete(null);
      setSuccess(`Terminal ${name} excluído.${result.closedCash > 0 ? ' O caixa que estava aberto foi fechado sem contagem.' : ''}`);
      await loadPosTerminals(selectedTenant.tenant.id);
    } catch (deleteError) {
      setTerminalToDelete(null);
      setError(getErrorMessage(deleteError, 'Não foi possível excluir o terminal.'));
    } finally {
      setIsDeletingTerminal(false);
    }
  };

  const loadPdvOperators = async (tenantId: string) => {
    setIsLoadingPdvOperators(true);
    setPdvOperatorsError(null);
    try {
      setPdvOperators(await supabaseService.getPlatformPdvOperators(tenantId));
    } catch (operatorError) {
      setPdvOperatorsError(getErrorMessage(operatorError, 'Não foi possível carregar os operadores do PDV.'));
    } finally {
      setIsLoadingPdvOperators(false);
    }
  };

  const loadStoreFiscal = async (tenantId: string) => {
    try {
      setStoreFiscal(await supabaseService.getPlatformStoreFiscal(tenantId));
    } catch {
      setStoreFiscal([]);
    }
  };

  const handleSaveFocus = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTenant || !focusForm) return;
    setIsSavingFocus(true);
    setError(null);
    setSuccess(null);
    try {
      await supabaseService.setPlatformStoreFocus({ tenantId: selectedTenant.tenant.id, ...focusForm, token: focusForm.token.trim() });
      setFocusForm(null);
      setSuccess('NFC-e da loja configurada.');
      await loadStoreFiscal(selectedTenant.tenant.id);
    } catch (saveError) {
      setError(getErrorMessage(saveError, 'Não foi possível salvar a chave da Focus.'));
    } finally {
      setIsSavingFocus(false);
    }
  };

  const handleClearFocus = async (unitId: string) => {
    if (!selectedTenant || !window.confirm('Remover a chave da Focus desta loja? O PDV deixa de emitir NFC-e.')) return;
    setError(null);
    try {
      await supabaseService.clearPlatformStoreFocus(selectedTenant.tenant.id, unitId);
      setFocusForm(null);
      setSuccess('Chave da Focus removida.');
      await loadStoreFiscal(selectedTenant.tenant.id);
    } catch (clearError) {
      setError(getErrorMessage(clearError, 'Não foi possível remover a chave da Focus.'));
    }
  };

  const selectTenant = async (tenantId: string) => {
    setIsLoadingDetails(true);
    setError(null);
    setSuccess(null);
    try {
      const details = await supabaseService.getPlatformTenantDetails(tenantId);
      setSelectedTenant(details);
      setStatusDraft(details.tenant.subscriptionStatus || 'ATIVO');
      setActivationForm({ unitId: details.stores[0]?.unitId || '', terminalLabel: '', expiresInMinutes: 15 });
      setTerminalActivations([]);
      setPosTerminals([]);
      setTerminalsError(null);
      setTerminalToDelete(null);
      setPdvOperators([]);
      setActivationHistoryError(null);
      setPdvOperatorsError(null);
      setGeneratedActivationCode(null);
      setCopiedActivationCode(false);
      setIsActivationFormOpen(false);
      setDetailTab('lojas');
      void loadTerminalActivations(tenantId);
      void loadPosTerminals(tenantId);
      void loadPdvOperators(tenantId);
      setStoreFiscal([]);
      setFocusForm(null);
      void loadStoreFiscal(tenantId);
    } catch (detailsError) {
      setError(detailsError instanceof Error ? detailsError.message : 'Não foi possível carregar os detalhes do cliente.');
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const handleCreateTerminalActivation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTenant || !activationForm.unitId || !activationForm.terminalLabel.trim()) return;

    setIsCreatingActivation(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await supabaseService.createPlatformPosTerminalActivation({
        tenantId: selectedTenant.tenant.id,
        unitId: activationForm.unitId,
        terminalLabel: activationForm.terminalLabel.trim(),
        expiresInMinutes: activationForm.expiresInMinutes
      });
      setGeneratedActivationCode(result.code);
      setCopiedActivationCode(false);
      setTerminalActivations(current => [result.activation, ...current]);
      setActivationForm(current => ({ ...current, terminalLabel: '' }));
      setSuccess('Código de ativação gerado. Copie-o antes de fechar esta tela.');
    } catch (createActivationError) {
      setError(getErrorMessage(createActivationError, 'Não foi possível gerar o código de ativação.'));
    } finally {
      setIsCreatingActivation(false);
    }
  };

  const handleCopyActivationCode = async () => {
    if (!generatedActivationCode) return;

    try {
      await navigator.clipboard.writeText(generatedActivationCode);
      setCopiedActivationCode(true);
    } catch {
      setError('Não foi possível copiar o código de ativação.');
    }
  };

  const handleCreateTenant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsCreating(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await supabaseService.createPlatformTenant({
        ...form,
        cnpj: form.cnpj.replace(/\D/g, '')
      });
      setForm({ legalName: '', cnpj: '', adminEmail: '', initialPassword: '' });
      setShowCreate(false);
      setSuccess(`Cliente criado. O administrador ${result.adminEmail} já pode acessar o ERP.`);
      await loadTenants();
      await selectTenant(result.tenantId);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Não foi possível criar o cliente.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSaveSubscription = async () => {
    if (!selectedTenant) return;

    setIsSavingStatus(true);
    setError(null);
    setSuccess(null);
    try {
      await setTenantSubscriptionManual(selectedTenant.tenant.id, statusDraft);
      // Quem tem cobranca configurada pode voltar para a situacao calculada (ex.: mensalidade em aberto).
      const finalStatus = (await getTenantBilling(selectedTenant.tenant.id).catch(() => null))?.status ?? statusDraft;
      applyTenantStatus(selectedTenant.tenant.id, finalStatus);
      setSuccess(finalStatus === statusDraft
        ? 'Status da assinatura atualizado.'
        : `Este cliente tem mensalidade em aberto: a situação ficou ${finalStatus}. Registre o pagamento na aba Cobrança.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Não foi possível atualizar a assinatura.');
    } finally {
      setIsSavingStatus(false);
    }
  };

  const applyTenantStatus = (tenantId: string, status: SubscriptionStatus | null) => {
    setStatusDraft(status || 'ATIVO');
    setSelectedTenant(current => (current && current.tenant.id === tenantId
      ? { ...current, tenant: { ...current.tenant, subscriptionStatus: status } }
      : current));
    setTenants(current => current.map(tenant => (tenant.id === tenantId ? { ...tenant, subscriptionStatus: status } : tenant)));
  };

  const networkNameOf = (tenantId: string) => networks.find(network => network.tenantIds.includes(tenantId))?.name ?? null;
  const tenantName = (tenant: { legalName: string | null; tradeName: string | null }) => tenant.tradeName || tenant.legalName || 'Cliente sem nome';
  const searchTerm = normalizeSearch(search.trim());
  const searchDigits = searchTerm.replace(/\D/g, '');
  const visibleTenants = !searchTerm ? tenants : tenants.filter(tenant => (
    [tenant.legalName, tenant.tradeName, networkNameOf(tenant.id)].some(value => normalizeSearch(value).includes(searchTerm))
    || (searchDigits.length >= 2 && (tenant.cnpj || '').replace(/\D/g, '').includes(searchDigits))
  ));
  const totalStores = tenants.reduce((sum, tenant) => sum + tenant.storeCount, 0);
  const activeTenants = tenants.filter(tenant => tenant.subscriptionStatus === 'ATIVO').length;
  const attentionTenants = tenants.filter(tenant => tenant.subscriptionStatus !== 'ATIVO').length;

  const openSection = (next: UcpSection) => {
    setSection(next);
    setSelectedTenant(null);
    setError(null);
    setSuccess(null);
  };

  const active = UCP_NAV.find(item => item.id === section)!;
  const inputClass = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-0">
      <aside className="w-full md:w-60 bg-slate-950 text-slate-300 flex flex-col border-r border-slate-900 shrink-0">
        <div className="p-4 bg-slate-950/40 border-b border-slate-900/80 hidden md:block">
          <span className="text-xs text-slate-500 font-bold uppercase tracking-widest font-mono flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5" />Plataforma
          </span>
          <p className="mt-1 text-sm font-bold text-white">Kanguru</p>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-400 font-medium">Clientes:</span>
            <span className="bg-blue-500/10 text-blue-400 border border-blue-500/20 font-bold font-mono text-xs px-2 py-0.5 rounded">{tenants.length}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-xs text-slate-400 font-medium">Lojas:</span>
            <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold font-mono text-xs px-2 py-0.5 rounded">{totalStores}</span>
          </div>
        </div>

        <nav className="py-4 space-y-1 flex-1 pr-3" aria-label="Menu do UCP">
          {UCP_NAV.map(item => {
            const Icon = item.icon;
            const isActive = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => openSection(item.id)}
                className={`w-full flex items-center px-4 py-3 text-sm font-semibold transition-all duration-150 rounded-r-lg ${
                  isActive
                    ? 'bg-blue-600/15 text-blue-400 border-l-4 border-blue-500 font-bold'
                    : 'hover:bg-slate-900/60 hover:text-white text-slate-400 border-l-4 border-transparent'
                }`}
              >
                <Icon className="w-[18px] h-[18px] mr-3 shrink-0" />
                <span>{item.name}</span>
              </button>
            );
          })}
          {onBackToErp && (
            <button type="button" onClick={onBackToErp} className="w-full flex items-center px-4 py-3 text-sm font-semibold text-slate-400 hover:bg-slate-900/60 hover:text-white border-l-4 border-transparent rounded-r-lg">
              <ArrowLeft className="w-[18px] h-[18px] mr-3 shrink-0" />Voltar ao ERP
            </button>
          )}
        </nav>

        <div className="p-4 bg-slate-950/80 border-t border-slate-900 text-xs text-slate-500 font-mono text-center hidden md:block">
          <p>UCP</p>
          <p className="mt-0.5 opacity-80">Administração da plataforma</p>
        </div>
      </aside>

      <main className="erp-workspace flex-1 p-3 sm:p-4 lg:p-5 w-full overflow-y-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2"><active.icon className="w-5 h-5 text-blue-600" />{active.name}</h2>
            <p className="text-xs text-slate-500">{active.description}</p>
          </div>
          {section === 'clientes' && !selectedTenant && (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <label className="relative flex-1 sm:w-72 sm:flex-none">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar nome, CNPJ ou rede" className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-200 bg-white text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400" />
              </label>
              <button type="button" onClick={() => void loadTenants()} disabled={isLoading} className="h-10 w-10 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-50" title="Atualizar lista" aria-label="Atualizar lista">
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" onClick={() => { setShowCreate(true); setError(null); setSuccess(null); }} className="h-10 px-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold">
                <Plus className="h-4 w-4" />Novo cliente
              </button>
            </div>
          )}
        </div>

        {(error || success) && !showCreate && (
          <div className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
            {error ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{error || success}</span>
          </div>
        )}

        {section === 'redes' && <NetworkAdminPanel tenants={tenants} />}

        {section === 'clientes' && isLoadingDetails && (
          <div className="py-10 text-center text-sm text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando ficha do cliente...</div>
        )}

        {section === 'clientes' && !isLoadingDetails && !selectedTenant && (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              <SummaryCard label="Clientes" value={tenants.length} icon={Building2} tone="bg-blue-50 text-blue-600 border-blue-100/80" />
              <SummaryCard label="Assinatura ativa" value={activeTenants} icon={CheckCircle2} tone="bg-emerald-50 text-emerald-600 border-emerald-100/80" />
              <SummaryCard label="Atrasados ou bloqueados" value={attentionTenants} icon={CircleAlert} tone="bg-amber-50 text-amber-600 border-amber-100/80" />
              <SummaryCard label="Lojas" value={totalStores} icon={Store} tone="bg-slate-100 text-slate-600 border-slate-200" />
            </div>

            {isLoading && <p className="py-6 text-center text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando clientes...</p>}
            {!isLoading && tenants.length === 0 && <p className="text-slate-400">Nenhum cliente cadastrado.</p>}
            {!isLoading && tenants.length > 0 && visibleTenants.length === 0 && <p className="text-slate-400">Nenhum cliente encontrado para "{search.trim()}".</p>}

            {visibleTenants.map(tenant => {
              const status = tenant.subscriptionStatus || 'BLOQUEADO';
              const networkName = networkNameOf(tenant.id);
              return (
                <section key={tenant.id} className="bg-white border border-slate-200 rounded-xl shadow-xs p-4 flex flex-wrap items-center gap-4">
                  <div className="h-11 w-11 rounded-xl bg-blue-600 text-white flex items-center justify-center font-black text-sm shrink-0">{initialsOf(tenantName(tenant))}</div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold text-slate-900 truncate">{tenantName(tenant)}</h3>
                    <p className="text-slate-500">
                      CNPJ {formatCnpj(tenant.cnpj)} · {tenant.storeCount} loja(s) · desde {formatDate(tenant.createdAt)}
                      {networkName && <> · Rede <strong className="text-slate-700">{networkName}</strong></>}
                    </p>
                  </div>
                  <span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-bold ${statusClassName[status]}`}>{status}</span>
                  <button type="button" onClick={() => void selectTenant(tenant.id)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold">
                    Abrir ficha<ChevronRight className="w-4 h-4" />
                  </button>
                </section>
              );
            })}
          </div>
        )}

        {section === 'clientes' && !isLoadingDetails && selectedTenant && (
          <div className="space-y-4 text-xs">
            <button type="button" onClick={() => { setSelectedTenant(null); setError(null); setSuccess(null); }} className="inline-flex items-center gap-1.5 font-bold text-blue-700 hover:underline">
              <ArrowLeft className="h-4 w-4" />Voltar para clientes
            </button>

            <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-4 flex flex-wrap items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-blue-600 text-white flex items-center justify-center font-black text-base shrink-0">{initialsOf(tenantName(selectedTenant.tenant))}</div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-slate-900">{tenantName(selectedTenant.tenant)}</h3>
                {selectedTenant.tenant.tradeName && selectedTenant.tenant.legalName && selectedTenant.tenant.tradeName !== selectedTenant.tenant.legalName && <p className="text-slate-500">{selectedTenant.tenant.legalName}</p>}
                <p className="text-slate-500">
                  CNPJ {formatCnpj(selectedTenant.tenant.cnpj)} · Plano {selectedTenant.tenant.planCode || 'não informado'} · desde {formatDate(selectedTenant.tenant.createdAt)}
                  {networkNameOf(selectedTenant.tenant.id) && <> · Rede <strong className="text-slate-700">{networkNameOf(selectedTenant.tenant.id)}</strong></>}
                </p>
              </div>
              <div className="flex items-end gap-2">
                <label className="block font-bold text-slate-600">Assinatura
                  <select value={statusDraft} onChange={event => setStatusDraft(event.target.value as SubscriptionStatus)} className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                    {subscriptionOptions.map(status => <option key={status} value={status}>{status}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => void handleSaveSubscription()} disabled={isSavingStatus || statusDraft === (selectedTenant.tenant.subscriptionStatus || 'ATIVO')} className="inline-flex h-[38px] items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 font-bold text-white transition hover:bg-slate-800 disabled:opacity-50">
                  {isSavingStatus && <LoaderCircle className="h-4 w-4 animate-spin" />}Salvar
                </button>
              </div>
            </section>

            <div className="flex flex-wrap gap-1 border-b border-slate-200">
              {DETAIL_TABS.map(tab => {
                const Icon = tab.icon;
                const count = tab.id === 'lojas' ? selectedTenant.stores.length : tab.id === 'terminais' ? posTerminals.length : tab.id === 'usuarios' ? selectedTenant.users.length : pdvOperators.length;
                return (
                  <button key={tab.id} type="button" onClick={() => setDetailTab(tab.id)} className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 font-bold ${detailTab === tab.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                    <Icon className="h-4 w-4" />{tab.name}<span className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-600">{count}</span>
                  </button>
                );
              })}
            </div>

            {detailTab === 'lojas' && (
              <section className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
                {selectedTenant.stores.length === 0 && <p className="p-4 text-slate-400">Nenhuma loja cadastrada. O franqueado cria as lojas no ERP › Configurações.</p>}
                <ul className="divide-y divide-slate-100">
                  {selectedTenant.stores.map(store => {
                    const fiscal = storeFiscal.find(item => item.unitId === store.unitId);
                    const editing = focusForm?.unitId === store.unitId;
                    return (
                      <li key={store.unitId} className="p-4">
                        <div className="flex flex-wrap items-center gap-3">
                          <Store className="h-4 w-4 text-slate-400 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <span className="font-bold text-slate-800">{store.tradeName || store.legalName || store.unitId}</span>
                            <span className="block font-mono text-slate-500">{formatCnpj(store.cnpj)}</span>
                          </div>
                          <span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-bold ${fiscal?.configured ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                            {fiscal?.configured ? `Notas configuradas · ${fiscal.environment === 'producao' ? 'Produção' : 'Teste (homologação)'}` : 'Notas não configuradas'}
                          </span>
                          {!editing && <button type="button" onClick={() => setFocusForm({ unitId: store.unitId, token: '', environment: fiscal?.environment || 'homologacao' })} className="font-bold text-blue-700 hover:underline">{fiscal?.configured ? 'Alterar' : 'Configurar'}</button>}
                          {!editing && fiscal?.configured && <button type="button" onClick={() => void handleClearFocus(store.unitId)} className="font-bold text-rose-700 hover:underline">Remover</button>}
                        </div>
                        {editing && focusForm && (
                          <form onSubmit={handleSaveFocus} className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                            <label className="font-bold text-slate-600">Chave (token) da Focus
                              <input type="password" autoComplete="off" value={focusForm.token} onChange={event => setFocusForm({ ...focusForm, token: event.target.value })} placeholder={fiscal?.configured ? 'Em branco = manter a chave atual' : 'Cole a chave da empresa na Focus'} className={inputClass} />
                            </label>
                            <label className="font-bold text-slate-600">Ambiente
                              <select value={focusForm.environment} onChange={event => setFocusForm({ ...focusForm, environment: event.target.value as 'homologacao' | 'producao' })} className={inputClass}>
                                <option value="homologacao">Teste (homologação) — não vale como nota</option>
                                <option value="producao">Produção — nota real</option>
                              </select>
                            </label>
                            <div className="flex justify-end gap-2">
                              <button type="button" onClick={() => setFocusForm(null)} className="rounded-lg px-3 py-2 font-bold text-slate-600 hover:bg-slate-100">Cancelar</button>
                              <button type="submit" disabled={isSavingFocus || (!fiscal?.configured && !focusForm.token.trim())} className="rounded-lg bg-blue-600 px-3 py-2 font-bold text-white disabled:opacity-50">{isSavingFocus ? 'Salvando...' : 'Salvar'}</button>
                            </div>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {detailTab === 'cobranca' && (
              <BillingPanel tenantId={selectedTenant.tenant.id} onStatusChange={status => applyTenantStatus(selectedTenant.tenant.id, status)} />
            )}

            {detailTab === 'terminais' && (
              <div className="space-y-4">
                <section className="bg-white border border-slate-200 rounded-xl shadow-xs p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2"><KeyRound className="h-4 w-4 text-blue-600" />Ativar um novo PDV</h4>
                      <p className="mt-0.5 text-slate-500">Gere um código temporário e digite-o no PDV da loja para vinculá-lo.</p>
                    </div>
                    {!isActivationFormOpen && (
                      <button type="button" onClick={() => setIsActivationFormOpen(true)} disabled={selectedTenant.stores.length === 0} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">
                        <KeyRound className="h-4 w-4" />Gerar código de ativação
                      </button>
                    )}
                  </div>
                  {selectedTenant.stores.length === 0 && <p className="mt-3 text-amber-700">Cadastre uma loja para gerar códigos de ativação.</p>}
                  {isActivationFormOpen && (
                    <form onSubmit={handleCreateTerminalActivation} className="mt-4 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_auto] sm:items-end">
                      <label className="block font-bold text-slate-700">Loja
                        <select value={activationForm.unitId} onChange={event => setActivationForm({ ...activationForm, unitId: event.target.value })} className={inputClass}>
                          {selectedTenant.stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.legalName || store.unitId}</option>)}
                        </select>
                      </label>
                      <label className="block font-bold text-slate-700">Identificação do terminal
                        <input required value={activationForm.terminalLabel} onChange={event => setActivationForm({ ...activationForm, terminalLabel: event.target.value })} placeholder="Ex.: Caixa 01" className={inputClass} />
                      </label>
                      <label className="block font-bold text-slate-700">Validade
                        <select value={activationForm.expiresInMinutes} onChange={event => setActivationForm({ ...activationForm, expiresInMinutes: Number(event.target.value) })} className={inputClass}>
                          <option value={15}>15 min</option>
                          <option value={30}>30 min</option>
                          <option value={60}>1 hora</option>
                          <option value={240}>4 horas</option>
                        </select>
                      </label>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setIsActivationFormOpen(false)} className="rounded-lg px-3 py-2 font-bold text-slate-600 hover:bg-slate-100">Cancelar</button>
                        <button type="submit" disabled={isCreatingActivation} className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 font-bold text-white transition hover:bg-slate-800 disabled:opacity-60">
                          {isCreatingActivation && <LoaderCircle className="h-4 w-4 animate-spin" />}Gerar
                        </button>
                      </div>
                    </form>
                  )}
                  {generatedActivationCode && (
                    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wide text-emerald-700">Código gerado</div>
                        <div className="mt-1 font-mono text-xl font-bold tracking-widest text-emerald-950">{generatedActivationCode}</div>
                      </div>
                      <button type="button" onClick={() => void handleCopyActivationCode()} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-2 font-bold text-emerald-800 transition hover:bg-emerald-100">
                        <Copy className="h-4 w-4" />{copiedActivationCode ? 'Copiado' : 'Copiar'}
                      </button>
                    </div>
                  )}
                </section>

                <section className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
                    <h4 className="text-sm font-bold text-slate-900">Terminais ativados</h4>
                    <button type="button" onClick={() => void loadPosTerminals(selectedTenant.tenant.id)} disabled={isLoadingTerminals} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 disabled:opacity-50" title="Atualizar terminais" aria-label="Atualizar terminais">
                      <RefreshCw className={`h-4 w-4 ${isLoadingTerminals ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-left">
                      <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Terminal</th><th className="px-4 py-2">Loja</th><th className="px-4 py-2">Ativado em</th><th className="px-4 py-2">Último uso</th><th className="px-4 py-2">Caixa</th><th className="px-4 py-2" aria-label="Ações"></th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {isLoadingTerminals && posTerminals.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando terminais...</td></tr>}
                        {!isLoadingTerminals && posTerminals.length === 0 && !terminalsError && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">Nenhum terminal ativado para este cliente.</td></tr>}
                        {posTerminals.map(terminal => {
                          const store = selectedTenant.stores.find(item => item.unitId === terminal.unitId);
                          return (
                            <tr key={terminal.id}>
                              <td className="px-4 py-2 font-bold text-slate-800">{terminal.name}</td>
                              <td className="px-4 py-2 text-slate-600">{store?.tradeName || store?.legalName || terminal.unitId}</td>
                              <td className="px-4 py-2 text-slate-600">{formatDateTime(terminal.activatedAt)}</td>
                              <td className="px-4 py-2 text-slate-600">{formatDateTime(terminal.lastUsedAt)}</td>
                              <td className="px-4 py-2">
                                {terminal.openCashAt
                                  ? <span className="inline-flex rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700">Aberto desde {formatDateTime(terminal.openCashAt)}</span>
                                  : <span className="inline-flex rounded-md border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">Fechado</span>}
                              </td>
                              <td className="px-4 py-2">
                                <div className="flex justify-end gap-2">
                                  <button type="button" onClick={() => void handleReactivateTerminal(terminal)} disabled={reactivatingTerminalId !== null} title="Gera um código para o computador voltar a este mesmo terminal" className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 px-2.5 py-1 font-bold text-blue-700 transition hover:bg-blue-50 disabled:opacity-50">
                                    {reactivatingTerminalId === terminal.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}Reativar
                                  </button>
                                  <button type="button" onClick={() => void askDeleteTerminal(terminal)} className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-2.5 py-1 font-bold text-rose-700 transition hover:bg-rose-50">
                                    <Trash2 className="h-3.5 w-3.5" />Excluir
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {terminalsError && <p className="px-4 py-2 text-rose-700">{terminalsError}</p>}
                </section>

                <section className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
                    <h4 className="text-sm font-bold text-slate-900">Histórico de códigos</h4>
                    <button type="button" onClick={() => void loadTerminalActivations(selectedTenant.tenant.id)} disabled={isLoadingActivations} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 disabled:opacity-50" title="Atualizar histórico" aria-label="Atualizar histórico">
                      <RefreshCw className={`h-4 w-4 ${isLoadingActivations ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-left">
                      <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Terminal</th><th className="px-4 py-2">Loja</th><th className="px-4 py-2">Gerado em</th><th className="px-4 py-2">Expira em</th><th className="px-4 py-2">Utilizado em</th><th className="px-4 py-2">Situação</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {isLoadingActivations && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando histórico...</td></tr>}
                        {!isLoadingActivations && terminalActivations.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">Nenhum código de ativação foi gerado para este cliente.</td></tr>}
                        {!isLoadingActivations && terminalActivations.map(activation => {
                          const store = selectedTenant.stores.find(item => item.unitId === activation.unitId);
                          return <tr key={activation.id}><td className="px-4 py-2 font-bold text-slate-800">{activation.terminalLabel}</td><td className="px-4 py-2 text-slate-600">{store?.tradeName || store?.legalName || activation.unitId}</td><td className="px-4 py-2 text-slate-600">{formatDateTime(activation.createdAt)}</td><td className="px-4 py-2 text-slate-600">{formatDateTime(activation.expiresAt)}</td><td className="px-4 py-2 text-slate-600">{formatDateTime(activation.usedAt)}</td><td className="px-4 py-2"><span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-bold ${activationStatusClassName[activation.status]}`}>{activation.status}</span></td></tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                  {activationHistoryError && <p className="px-4 py-2 text-rose-700">{activationHistoryError}</p>}
                </section>
              </div>
            )}

            {detailTab === 'usuarios' && (
              <section className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
                {selectedTenant.users.length === 0 && <p className="p-4 text-slate-400">Nenhum usuário vinculado.</p>}
                <ul className="divide-y divide-slate-100">
                  {selectedTenant.users.map(user => {
                    const store = selectedTenant.stores.find(item => item.unitId === user.unitId);
                    return (
                      <li key={user.authUid} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <UserRound className="h-4 w-4 text-slate-400 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate font-bold text-slate-800">{user.email || user.authUid}</span>
                          <span className="text-slate-500">{store?.tradeName || store?.legalName || user.unitId || (user.role === 'ADMIN' ? 'Todas as lojas' : 'Sem loja vinculada')}</span>
                        </div>
                        <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-700">{roleLabel[user.role] ?? user.role}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {detailTab === 'vendedores' && (
              <section className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
                  <h4 className="text-sm font-bold text-slate-900">Vendedores do PDV</h4>
                  <button type="button" onClick={() => void loadPdvOperators(selectedTenant.tenant.id)} disabled={isLoadingPdvOperators} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 disabled:opacity-50" title="Atualizar vendedores" aria-label="Atualizar vendedores">
                    <RefreshCw className={`h-4 w-4 ${isLoadingPdvOperators ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[600px] text-left">
                    <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Vendedor</th><th className="px-4 py-2">Loja</th><th className="px-4 py-2">Permissões</th><th className="px-4 py-2">Situação</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {isLoadingPdvOperators && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando vendedores...</td></tr>}
                      {!isLoadingPdvOperators && pdvOperators.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">Nenhum vendedor do PDV cadastrado.</td></tr>}
                      {!isLoadingPdvOperators && pdvOperators.map(operator => {
                        const store = selectedTenant.stores.find(item => item.unitId === operator.unitId);
                        const permissionCount = Object.values(operator.permissions).filter(Boolean).length;
                        return <tr key={operator.id}><td className="px-4 py-2 font-bold text-slate-800">{operator.name}</td><td className="px-4 py-2 text-slate-600">{store?.tradeName || store?.legalName || (operator.unitId || 'Todas as lojas')}</td><td className="px-4 py-2 text-slate-600">{permissionCount} permissões</td><td className="px-4 py-2"><span className={`inline-flex rounded-md px-2 py-1 text-[10px] font-bold ${operator.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{operator.isActive ? 'ATIVO' : 'INATIVO'}</span></td></tr>;
                      })}
                    </tbody>
                  </table>
                </div>
                {pdvOperatorsError && <p className="px-4 py-2 text-rose-700">{pdvOperatorsError}</p>}
              </section>
            )}
          </div>
        )}
      </main>

      {terminalToDelete && selectedTenant && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="delete-terminal-title" className="bg-white rounded-xl shadow-xl w-full max-w-md text-xs">
            <div className="p-4 border-b border-slate-100">
              <h3 id="delete-terminal-title" className="text-sm font-bold text-slate-900">Excluir o terminal {terminalToDelete.name}?</h3>
              <p className="text-slate-500">Último uso: {formatDateTime(terminalToDelete.lastUsedAt)}</p>
            </div>
            <ul className="list-disc space-y-2 py-4 pl-8 pr-4 text-slate-700">
              <li>O aparelho perde a ativação e pede um código novo ao abrir o PDV.</li>
              {terminalToDelete.openCashAt && <li className="font-bold text-rose-700">O caixa aberto desde {formatDateTime(terminalToDelete.openCashAt)} será fechado sem contagem. As vendas desse caixa só poderão ser desfeitas por Trocar/Devolver.</li>}
              <li>Vendas feitas sem internet e ainda não enviadas por esse aparelho não sobem depois da exclusão.</li>
              <li>As vendas e os relatórios antigos continuam guardados.</li>
            </ul>
            <div className="flex justify-end gap-2 border-t border-slate-100 p-4">
              <button type="button" onClick={() => setTerminalToDelete(null)} disabled={isDeletingTerminal} className="rounded-lg px-3 py-2 font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-60">Cancelar</button>
              <button type="button" onClick={() => void handleDeleteTerminal()} disabled={isDeletingTerminal} className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-3 py-2 font-bold text-white transition hover:bg-rose-700 disabled:opacity-60">
                {isDeletingTerminal && <LoaderCircle className="h-4 w-4 animate-spin" />}Excluir terminal
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form onSubmit={handleCreateTenant} className="bg-white rounded-xl shadow-xl w-full max-w-md text-xs">
            <div className="p-4 border-b border-slate-100 flex justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Novo cliente</h3>
                <p className="text-slate-500">Cria a empresa e o administrador inicial, sem lojas (o franqueado cria as lojas no ERP).</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)} aria-label="Fechar"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-4 space-y-3">
              <label className="block font-bold text-slate-700">Razão social
                <input required value={form.legalName} onChange={event => setForm({ ...form, legalName: event.target.value })} className={inputClass} />
              </label>
              <label className="block font-bold text-slate-700">CNPJ
                <input required inputMode="numeric" maxLength={18} value={form.cnpj} onChange={event => setForm({ ...form, cnpj: event.target.value })} placeholder="00.000.000/0000-00" className={inputClass} />
              </label>
              <label className="block font-bold text-slate-700">E-mail do administrador
                <input required type="email" value={form.adminEmail} onChange={event => setForm({ ...form, adminEmail: event.target.value })} className={inputClass} />
              </label>
              <label className="block font-bold text-slate-700">Senha inicial (mínimo 12 caracteres)
                <input required type="password" minLength={12} value={form.initialPassword} onChange={event => setForm({ ...form, initialPassword: event.target.value })} className={inputClass} />
              </label>
              {error && <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-700">{error}</p>}
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-slate-200 font-bold text-slate-600">Cancelar</button>
              <button type="submit" disabled={isCreating} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">
                {isCreating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{isCreating ? 'Criando...' : 'Criar cliente'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: LucideIcon; tone: string }) {
  return (
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
      <div className={`p-2.5 rounded-lg shrink-0 border ${tone}`}><Icon className="w-5 h-5" /></div>
      <div className="min-w-0">
        <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">{label}</span>
        <span className="text-lg font-extrabold tracking-tight text-slate-900 block">{value}</span>
      </div>
    </div>
  );
}
