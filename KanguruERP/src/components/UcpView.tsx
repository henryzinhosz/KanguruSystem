import { FormEvent, useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Store,
  Users
} from 'lucide-react';
import { PdvOperator, PlatformTenant, PlatformTenantDetails, PosTerminalActivation, PosTerminalActivationStatus, SubscriptionStatus } from '../types';
import { supabaseService } from '../db/supabaseService';

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

  const loadTenants = async () => {
    setIsLoading(true);
    setError(null);
    try {
      setTenants(await supabaseService.getPlatformTenants());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Não foi possível carregar os clientes.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTenants();
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
      setPdvOperators([]);
      setActivationHistoryError(null);
      setPdvOperatorsError(null);
      setGeneratedActivationCode(null);
      setCopiedActivationCode(false);
      setIsActivationFormOpen(false);
      void loadTerminalActivations(tenantId);
      void loadPdvOperators(tenantId);
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
      await supabaseService.updatePlatformSubscriptionStatus(selectedTenant.tenant.id, statusDraft);
      setSelectedTenant({
        ...selectedTenant,
        tenant: { ...selectedTenant.tenant, subscriptionStatus: statusDraft }
      });
      setTenants(current => current.map(tenant => (
        tenant.id === selectedTenant.tenant.id ? { ...tenant, subscriptionStatus: statusDraft } : tenant
      )));
      setSuccess('Status da assinatura atualizado.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Não foi possível atualizar a assinatura.');
    } finally {
      setIsSavingStatus(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      <section className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue-700">
            <Building2 className="h-4 w-4" />
            Administração da plataforma
          </div>
          <h2 className="mt-1 text-2xl font-bold text-slate-950">UCP</h2>
          <p className="mt-1 text-sm text-slate-500">Clientes, acessos e assinaturas da plataforma.</p>
        </div>
        {onBackToErp && (
          <button
            type="button"
            onClick={onBackToErp}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
          >
            Voltar ao ERP
          </button>
        )}
      </section>

      {(error || success) && (
        <div className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
          {error ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{error || success}</span>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.85fr)]">
        <section className="border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Clientes cadastrados</h3>
              <p className="mt-0.5 text-xs text-slate-500">Selecione um cliente para abrir os detalhes.</p>
            </div>
            <button
              type="button"
              onClick={() => void loadTenants()}
              disabled={isLoading}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
              title="Atualizar lista"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-xs">
              <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3">CNPJ</th>
                  <th className="px-4 py-3 text-center">Lojas</th>
                  <th className="px-4 py-3">Assinatura</th>
                  <th className="px-4 py-3">Criação</th>
                  <th className="w-10 px-2 py-3" aria-label="Abrir detalhes" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading && (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando clientes...</td></tr>
                )}
                {!isLoading && tenants.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Nenhum cliente cadastrado.</td></tr>
                )}
                {tenants.map(tenant => {
                  const status = tenant.subscriptionStatus || 'BLOQUEADO';
                  return (
                    <tr key={tenant.id} className="cursor-pointer transition hover:bg-blue-50/50" onClick={() => void selectTenant(tenant.id)}>
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-800">{tenant.legalName || tenant.tradeName || 'Cliente sem nome'}</div>
                        {tenant.tradeName && tenant.tradeName !== tenant.legalName && <div className="mt-0.5 text-slate-500">{tenant.tradeName}</div>}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600">{formatCnpj(tenant.cnpj)}</td>
                      <td className="px-4 py-3 text-center font-bold text-slate-700">{tenant.storeCount}</td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-bold ${statusClassName[status]}`}>{status}</span></td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(tenant.createdAt)}</td>
                      <td className="px-2 py-3 text-slate-400"><ChevronRight className="h-4 w-4" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-blue-600" />
            <h3 className="text-sm font-bold text-slate-900">Novo cliente</h3>
          </div>
          <p className="mt-1 text-xs text-slate-500">Cria o tenant e o administrador inicial, sem lojas vinculadas.</p>
          <form className="mt-4 space-y-3" onSubmit={handleCreateTenant}>
            <label className="block text-xs font-bold text-slate-700">Razão social
              <input required value={form.legalName} onChange={event => setForm({ ...form, legalName: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="block text-xs font-bold text-slate-700">CNPJ
              <input required inputMode="numeric" maxLength={18} value={form.cnpj} onChange={event => setForm({ ...form, cnpj: event.target.value })} placeholder="00.000.000/0000-00" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="block text-xs font-bold text-slate-700">E-mail do administrador
              <input required type="email" value={form.adminEmail} onChange={event => setForm({ ...form, adminEmail: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="block text-xs font-bold text-slate-700">Senha inicial
              <input required type="password" minLength={12} value={form.initialPassword} onChange={event => setForm({ ...form, initialPassword: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <button type="submit" disabled={isCreating} className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">
              {isCreating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {isCreating ? 'Criando cliente...' : 'Criar cliente'}
            </button>
          </form>
        </section>
      </div>

      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-900">Detalhes do cliente</h3>
        </div>
        {isLoadingDetails && <div className="px-4 py-10 text-center text-sm text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando detalhes...</div>}
        {!isLoadingDetails && !selectedTenant && <div className="px-4 py-10 text-center text-sm text-slate-400">Selecione um cliente na lista para consultar seus dados.</div>}
        {!isLoadingDetails && selectedTenant && (
          <div className="space-y-6 p-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <div><div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Razão social</div><div className="mt-1 text-sm font-bold text-slate-800">{selectedTenant.tenant.legalName || 'Não informado'}</div></div>
              <div><div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Nome fantasia</div><div className="mt-1 text-sm text-slate-700">{selectedTenant.tenant.tradeName || 'Não informado'}</div></div>
              <div><div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">CNPJ</div><div className="mt-1 font-mono text-sm text-slate-700">{formatCnpj(selectedTenant.tenant.cnpj)}</div></div>
              <div><div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Plano</div><div className="mt-1 text-sm text-slate-700">{selectedTenant.tenant.planCode || 'Não informado'}</div></div>
              <div><div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Criado em</div><div className="mt-1 text-sm text-slate-700">{formatDate(selectedTenant.tenant.createdAt)}</div></div>
            </div>

            <div className="flex flex-col gap-3 border-y border-slate-100 py-4 sm:flex-row sm:items-end">
              <label className="block flex-1 text-xs font-bold text-slate-700">Status da assinatura
                <select value={statusDraft} onChange={event => setStatusDraft(event.target.value as SubscriptionStatus)} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                  {subscriptionOptions.map(status => <option key={status} value={status}>{status}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => void handleSaveSubscription()} disabled={isSavingStatus} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:opacity-60">
                {isSavingStatus && <LoaderCircle className="h-4 w-4 animate-spin" />}Salvar status
              </button>
            </div>

            <section className="border-b border-slate-100 pb-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600"><KeyRound className="h-4 w-4" />Ativação de terminal PDV</div>
                  <p className="mt-1 text-xs text-slate-500">Gere um código temporário para vincular um terminal a uma loja deste cliente.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsActivationFormOpen(current => !current)}
                  disabled={selectedTenant.stores.length === 0}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <KeyRound className="h-4 w-4" />
                  Gerar código de ativação de terminal
                </button>
              </div>

              {selectedTenant.stores.length === 0 && <p className="mt-3 text-xs text-amber-700">Cadastre uma loja para gerar códigos de ativação.</p>}

              {isActivationFormOpen && (
                <form onSubmit={handleCreateTerminalActivation} className="mt-4 grid gap-3 border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_auto] sm:items-end">
                  <label className="block text-xs font-bold text-slate-700">Loja
                    <select value={activationForm.unitId} onChange={event => setActivationForm({ ...activationForm, unitId: event.target.value })} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                      {selectedTenant.stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.legalName || store.unitId}</option>)}
                    </select>
                  </label>
                  <label className="block text-xs font-bold text-slate-700">Identificação do terminal
                    <input required value={activationForm.terminalLabel} onChange={event => setActivationForm({ ...activationForm, terminalLabel: event.target.value })} placeholder="Ex.: Caixa 01" className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
                  </label>
                  <label className="block text-xs font-bold text-slate-700">Validade
                    <select value={activationForm.expiresInMinutes} onChange={event => setActivationForm({ ...activationForm, expiresInMinutes: Number(event.target.value) })} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                      <option value={15}>15 min</option>
                      <option value={30}>30 min</option>
                      <option value={60}>1 hora</option>
                      <option value={240}>4 horas</option>
                    </select>
                  </label>
                  <button type="submit" disabled={isCreatingActivation} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:opacity-60">
                    {isCreatingActivation && <LoaderCircle className="h-4 w-4 animate-spin" />}Gerar
                  </button>
                </form>
              )}

              {generatedActivationCode && (
                <div className="mt-4 flex flex-col gap-3 border border-emerald-200 bg-emerald-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-wide text-emerald-700">Código gerado</div>
                    <div className="mt-1 font-mono text-xl font-bold tracking-widest text-emerald-950">{generatedActivationCode}</div>
                  </div>
                  <button type="button" onClick={() => void handleCopyActivationCode()} className="flex h-9 w-9 items-center justify-center rounded-md border border-emerald-300 bg-white text-emerald-800 transition hover:bg-emerald-100" title={copiedActivationCode ? 'Código copiado' : 'Copiar código'} aria-label={copiedActivationCode ? 'Código copiado' : 'Copiar código'}>
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              )}
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600"><KeyRound className="h-4 w-4" />Histórico de ativações</div>
                <button type="button" onClick={() => void loadTerminalActivations(selectedTenant.tenant.id)} disabled={isLoadingActivations} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50" title="Atualizar histórico" aria-label="Atualizar histórico">
                  <RefreshCw className={`h-4 w-4 ${isLoadingActivations ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="overflow-x-auto border border-slate-200">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Terminal</th><th className="px-3 py-2">Loja</th><th className="px-3 py-2">Gerado em</th><th className="px-3 py-2">Expira em</th><th className="px-3 py-2">Utilizado em</th><th className="px-3 py-2">Status</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {isLoadingActivations && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando histórico...</td></tr>}
                    {!isLoadingActivations && terminalActivations.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Nenhum código de ativação foi gerado para este cliente.</td></tr>}
                    {!isLoadingActivations && terminalActivations.map(activation => {
                      const store = selectedTenant.stores.find(item => item.unitId === activation.unitId);
                      return <tr key={activation.id}><td className="px-3 py-2 font-bold text-slate-800">{activation.terminalLabel}</td><td className="px-3 py-2 text-slate-600">{store?.tradeName || store?.legalName || activation.unitId}</td><td className="px-3 py-2 text-slate-600">{formatDateTime(activation.createdAt)}</td><td className="px-3 py-2 text-slate-600">{formatDateTime(activation.expiresAt)}</td><td className="px-3 py-2 text-slate-600">{formatDateTime(activation.usedAt)}</td><td className="px-3 py-2"><span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-bold ${activationStatusClassName[activation.status]}`}>{activation.status}</span></td></tr>;
                    })}
                  </tbody>
                </table>
              </div>
              {activationHistoryError && <p className="mt-2 text-xs text-rose-700">{activationHistoryError}</p>}
            </section>

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600"><Store className="h-4 w-4" />Lojas ({selectedTenant.stores.length})</div>
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {selectedTenant.stores.length === 0 && <div className="p-3 text-xs text-slate-400">Nenhuma loja cadastrada.</div>}
                  {selectedTenant.stores.map(store => <div key={store.unitId} className="p-3 text-xs"><div className="font-bold text-slate-800">{store.tradeName || store.legalName || store.unitId}</div><div className="mt-1 font-mono text-slate-500">{formatCnpj(store.cnpj)}</div></div>)}
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600"><Users className="h-4 w-4" />Usuários ({selectedTenant.users.length})</div>
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {selectedTenant.users.length === 0 && <div className="p-3 text-xs text-slate-400">Nenhum usuário vinculado.</div>}
                  {selectedTenant.users.map(user => <div key={user.authUid} className="flex items-center justify-between gap-3 p-3 text-xs"><div className="min-w-0"><div className="truncate font-bold text-slate-800">{user.email || user.authUid}</div><div className="mt-1 text-slate-500">{user.unitId || 'Sem loja vinculada'}</div></div><span className="rounded bg-slate-100 px-2 py-1 font-bold text-slate-700">{user.role}</span></div>)}
                </div>
              </div>
            </div>

            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600"><Users className="h-4 w-4" />Operadores do PDV ({pdvOperators.length})</div>
                <button type="button" onClick={() => void loadPdvOperators(selectedTenant.tenant.id)} disabled={isLoadingPdvOperators} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50" title="Atualizar operadores" aria-label="Atualizar operadores">
                  <RefreshCw className={`h-4 w-4 ${isLoadingPdvOperators ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="overflow-x-auto border border-slate-200">
                <table className="w-full min-w-[600px] text-left text-xs">
                  <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Operador</th><th className="px-3 py-2">Loja</th><th className="px-3 py-2">Permissões</th><th className="px-3 py-2">Situação</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {isLoadingPdvOperators && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Carregando operadores...</td></tr>}
                    {!isLoadingPdvOperators && pdvOperators.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Nenhum operador do PDV cadastrado.</td></tr>}
                    {!isLoadingPdvOperators && pdvOperators.map(operator => {
                      const store = selectedTenant.stores.find(item => item.unitId === operator.unitId);
                      const permissionCount = Object.values(operator.permissions).filter(Boolean).length;
                      return <tr key={operator.id}><td className="px-3 py-2 font-bold text-slate-800">{operator.name}</td><td className="px-3 py-2 text-slate-600">{store?.tradeName || store?.legalName || (operator.unitId || 'Todas as lojas')}</td><td className="px-3 py-2 text-slate-600">{permissionCount} permissões</td><td className="px-3 py-2"><span className={`inline-flex rounded-md px-2 py-1 text-[10px] font-bold ${operator.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{operator.isActive ? 'ATIVO' : 'INATIVO'}</span></td></tr>;
                    })}
                  </tbody>
                </table>
              </div>
              {pdvOperatorsError && <p className="mt-2 text-xs text-rose-700">{pdvOperatorsError}</p>}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}