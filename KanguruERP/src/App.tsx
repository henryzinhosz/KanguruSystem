/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import { useErpStore } from './db/useErpStore';
import { supabase } from './db/supabaseClient';
import Header from './components/Header';
import LoginScreen from './components/LoginScreen';
import DashboardView from './components/DashboardView';
import EstoqueView from './components/EstoqueView';
import VendasView from './components/VendasView';
import FinanceiroView from './components/FinanceiroView';
import AdminToolsView from './components/AdminToolsView';
import ConfiguracoesView from './components/ConfiguracoesView';
import ServicosView from './components/ServicosView';
import ClientesView from './components/ClientesView';
import UcpView from './components/UcpView';
import NetworkView from './components/NetworkView';
import BalancoPanel from './components/BalancoPanel';
import AgencyView from './components/agency/AgencyView';
import type { AgencyTarget } from './db/agency';
import { AttentionDrawer, type AttentionTarget } from './components/AttentionPanel';
import { isCashTab, type FinanceiroTab } from './components/FinanceiroView';
import AnnouncementsView, { ImportantAnnouncementModal } from './components/AnnouncementsView';
import StoreGoalsCard from './components/StoreGoalsCard';
import { useFranchiseeInsights } from './db/useFranchiseeInsights';
import { DEFAULT_MANAGER_PERMISSIONS, ErpArea, UserRole, isNetworkRole } from './types';
import { 
  LayoutDashboard, 
  Package, 
  ShoppingBag, 
  Wrench, 
  DollarSign,
  PiggyBank,
  FileSpreadsheet,
  Layers,
  ArrowUpRight,
  Coins,
  Settings,
  Users,
  ClipboardCheck,
  Megaphone,
  Sparkles
} from 'lucide-react';

import { isBlockedStatus, useSubscriptionState } from './db/billing';
import { SubscriptionBlockedScreen, SubscriptionOverdueBanner } from './components/SubscriptionNotice';

export default function App() {
  const {
    currentUser,
    setCurrentUser,
    products,
    services,
    inventory,
    movements,
    sales,
    expenses,
    tradeIns,
    workOrders,
    storeConfigs,
    suppliers,
    pdvOperators,
    addProduct,
    editProduct,
    saveProduct,
    saveService,
    deleteService,
    registerSerializedStockEntry,
    registerTransfer,
    registerStockEntry,
    productStoreCosts,
    otherIncome,
    reloadOtherIncome,
    loadAllFromSupabase,
    cancelSale,
    addExpense,
    reloadExpenses,
    stockTradeIn,
    mergeProducts,
    cancelTradeIn,
    updateWorkOrderStatus,
    updateStoreConfig,
    deleteStoreConfig,
    savePdvOperator,
    deletePdvOperator,
    updateCurrentUserDisplayName,
    addSupplier,
    editSupplier,
    deleteSupplier,
    authProfileError,
  } = useErpStore();

  // Active Main View Tab
  const [activeTab, setActiveTab] = useState<'dashboard' | 'estoque' | 'balanco' | 'servicos' | 'clientes' | 'vendas' | 'caixa' | 'financeiro' | 'admin' | 'configuracoes' | 'comunicados' | 'agencia'>('dashboard');
  const [attentionOpen, setAttentionOpen] = useState(false);
  // Aba aberta por um alerta ou por um link entre as duas partes (Caixa e Contas / Resultados).
  const [financeiroTab, setFinanceiroTab] = useState<FinanceiroTab | undefined>(undefined);
  const [financeiroKey, setFinanceiroKey] = useState(0);
  const openFinanceTab = (target: FinanceiroTab) => {
    setFinanceiroTab(target);
    setFinanceiroKey(key => key + 1);
    setActiveTab(isCashTab(target) ? 'caixa' : 'financeiro');
  };
  const navigateFromAlert = (target: Exclude<AttentionTarget, null>) => {
    if (target === "contas" || target === "areceber" || target === "recebimentos") {
      openFinanceTab(target);
      return;
    }
    setFinanceiroTab(undefined);
    setActiveTab(target);
  };
  // Botoes das respostas da Agencia: so abrem a tela certa.
  const navigateFromAgency = (target: AgencyTarget) => {
    if (target === 'caixa' || target === 'contas' || target === 'areceber' || target === 'recebimentos') {
      openFinanceTab(target);
      return;
    }
    if (target === 'resultados') {
      openFinanceTab('indicadores');
      return;
    }
    setFinanceiroTab(undefined);
    setActiveTab(target === 'fornecedores' ? 'admin' : target);
  };
  // A Agencia ocupa a tela inteira; "Voltar ao ERP" volta para a ultima tela aberta.
  const agencyReturnTab = useRef<typeof activeTab>('dashboard');
  useEffect(() => {
    if (activeTab !== 'agencia') agencyReturnTab.current = activeTab;
  }, [activeTab]);
  // Volta do login do Instagram (VideoMaker): ?instagram=ok|erro&motivo=...&loja=...
  const [instagramReturn, setInstagramReturn] = useState<{ ok: boolean; reason: string; unitId: string } | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('instagram');
    return result ? { ok: result === 'ok', reason: params.get('motivo') || '', unitId: params.get('loja') || '' } : null;
  });
  useEffect(() => {
    if (!instagramReturn) return;
    const url = new URL(window.location.href);
    ['instagram', 'motivo', 'loja'].forEach(key => url.searchParams.delete(key));
    window.history.replaceState(null, '', url.toString());
  }, [instagramReturn]);
  useEffect(() => {
    if (instagramReturn && currentUser) setActiveTab('agencia');
  }, [instagramReturn, currentUser]);
  const insights = useFranchiseeInsights(currentUser, products, inventory, sales, storeConfigs);
  const subscription = useSubscriptionState(currentUser?.tenantId);

  if (!currentUser) {
    return <LoginScreen accessError={authProfileError} />;
  }

  const isPlatformAdmin = currentUser.role === UserRole.SUPER_ADMIN;

  if (isNetworkRole(currentUser.role)) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
        <Header
          currentUser={currentUser}
          onLogout={() => {
            void supabase.auth.signOut();
            setCurrentUser(null);
          }}
        />
        <NetworkView currentUser={currentUser} />
      </div>
    );
  }

  if (isPlatformAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
        <Header
          currentUser={currentUser}
          onLogout={() => {
            void supabase.auth.signOut();
            setCurrentUser(null);
          }}
        />
        <UcpView />
      </div>
    );
  }

  // Assinatura bloqueada/cancelada: so a tela de aviso (o banco tambem nega o acesso aos dados).
  if (subscription && isBlockedStatus(subscription.status)) {
    return (
      <SubscriptionBlockedScreen
        status={subscription.status}
        onLogout={() => {
          void supabase.auth.signOut();
          setCurrentUser(null);
        }}
      />
    );
  }

  const storeCount = storeConfigs.filter(store => store.unitId !== 'central').length;
  const subscriptionStatus = currentUser.subscriptionStatus;
  const subscriptionPresentation = subscriptionStatus === 'ATIVO'
    ? { label: 'Liberado', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' }
    : subscriptionStatus === 'ATRASADO'
      ? { label: 'Pendente', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20' }
      : { label: 'Bloqueado', className: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };

  const navigationItems = [
    { id: 'dashboard', name: 'Relatórios Gerais', icon: LayoutDashboard },
    { id: 'estoque', name: 'Catálogo & Estoque', icon: Package },
    { id: 'balanco', name: 'Balanço', icon: ClipboardCheck },
    { id: 'servicos', name: 'Serviços / OS', icon: Wrench },
    { id: 'clientes', name: 'Clientes', icon: Users },
    { id: 'vendas', name: 'Trocas Gerais', icon: Coins },
    { id: 'caixa', name: 'Caixa e Contas', icon: PiggyBank },
    { id: 'financeiro', name: 'Resultados', icon: DollarSign },
    { id: 'admin', name: 'Fornecedores', icon: FileSpreadsheet },
    { id: 'configuracoes', name: 'Configurações', icon: Settings },
    { id: 'comunicados', name: 'Comunicados', icon: Megaphone },
    { id: 'agencia', name: 'Agência de IA', icon: Sparkles }
  ] as const;

  // Gerente de loja: so as areas liberadas pelo dono; Configuracoes so para o administrador.
  const AREA_BY_TAB: Partial<Record<(typeof navigationItems)[number]['id'], ErpArea>> = {
    dashboard: 'relatorios',
    estoque: 'estoque',
    balanco: 'estoque',
    servicos: 'servicos',
    clientes: 'clientes',
    vendas: 'troca_gamer',
    caixa: 'financeiro',
    financeiro: 'financeiro',
    admin: 'fornecedores',
    agencia: 'agencia',
  };
  const canOpen = (id: (typeof navigationItems)[number]['id']) => {
    // Comunicados da rede: so aparece quando a empresa recebeu algum.
    if (id === 'comunicados') return insights.announcements.length > 0;
    if (currentUser.role === UserRole.ADMIN) return true;
    if (id === 'configuracoes') return false;
    const area = AREA_BY_TAB[id];
    const permissions = currentUser.permissions ?? DEFAULT_MANAGER_PERMISSIONS;
    return Boolean(area && permissions[area]);
  };
  const allowedItems = navigationItems.filter(item => canOpen(item.id));
  const attentionStoreName = (unitId: string) => storeConfigs.find(store => store.unitId === unitId)?.tradeName || unitId;
  // Aba sem permissao (ex.: link antigo): abre a primeira liberada.
  const tab = canOpen(activeTab) ? activeTab : (allowedItems[0]?.id ?? 'dashboard');

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Top Header with Store & Account controls */}
      <Header
        currentUser={currentUser}
        onLogout={() => {
          void supabase.auth.signOut();
          setCurrentUser(null);
        }}
        alertCount={insights.alerts.length}
        onAlertsClick={() => { setAttentionOpen(true); void insights.reloadAlerts(); }}
      />
      {attentionOpen && (
        <AttentionDrawer
          alerts={insights.alerts}
          loading={insights.alertsLoading}
          storeName={attentionStoreName}
          onNavigate={navigateFromAlert}
          onClose={() => setAttentionOpen(false)}
        />
      )}
      {insights.pendingImportant && (
        <ImportantAnnouncementModal announcement={insights.pendingImportant} onConfirmed={insights.reloadAnnouncements} />
      )}

      {subscription?.status === 'ATRASADO' && <SubscriptionOverdueBanner state={subscription} />}

      <div className="flex-1 flex flex-col md:flex-row">
        {/* Sidebar Left Navigation Rail */}
        <aside className="w-full md:w-60 bg-slate-950 text-slate-300 flex flex-col border-r border-slate-900 shrink-0">
          {/* Quick Stats Summary or info panel */}
          <div className="p-4 bg-slate-950/40 border-b border-slate-900/80 hidden md:block">
            <span className="text-xs text-slate-500 font-bold uppercase tracking-widest font-mono">
              Corporativo
            </span>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-slate-400 font-medium font-sans">Lojas Ativas:</span>
              <span className="bg-blue-500/10 text-blue-400 border border-blue-500/20 font-bold font-mono text-xs px-2 py-0.5 rounded">
                {storeCount} {storeCount === 1 ? 'Unidade' : 'Unidades'}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-slate-400 font-medium font-sans">Plano:</span>
              <span className={`${subscriptionPresentation.className} font-bold font-mono text-xs px-2 py-0.5 rounded border`}>
                {subscriptionPresentation.label}
              </span>
            </div>
          </div>

          {/* Navigation Menu */}
          <nav className="py-4 space-y-1 flex-1 pr-3" aria-label="Menu Principal">
            {allowedItems.map((item) => {
              const IconComponent = item.icon;
              const isActive = tab === item.id;

              return (
                <button
                  key={item.id}
                  id={`nav-${item.id}`}
                  onClick={() => { setFinanceiroTab(undefined); setActiveTab(item.id); }}
                  className={`w-full flex items-center px-4 py-3 text-sm font-semibold transition-all duration-150 rounded-r-lg ${
                    isActive
                      ? 'bg-blue-600/15 text-blue-400 border-l-4 border-blue-500 font-bold'
                      : 'hover:bg-slate-900/60 hover:text-white text-slate-400 border-l-4 border-transparent'
                  }`}
                >
                  <IconComponent className="w-[18px] h-[18px] mr-3 shrink-0" />
                  <span>{item.name}</span>
                  {item.id === 'comunicados' && insights.unreadAnnouncements > 0 && (
                    <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">{insights.unreadAnnouncements}</span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Footer of Sidebar */}
          <div className="p-4 bg-slate-950/80 border-t border-slate-900 text-xs text-slate-500 font-mono text-center hidden md:block">
            <p>Kanguru ERP © 2026</p>
            <p className="mt-0.5 opacity-80">Kanguru Sistemas</p>
          </div>
        </aside>

        {/* Main Content Workspace Container */}
        <main className="erp-workspace flex-1 p-3 sm:p-4 lg:p-5 w-full overflow-y-auto">
          {tab === 'dashboard' && (
            <div className="mb-5 empty:hidden">
              <StoreGoalsCard />
            </div>
          )}

          {tab === 'comunicados' && (
            <AnnouncementsView announcements={insights.announcements} onRead={insights.reloadAnnouncements} />
          )}

          {tab === 'dashboard' && (
            <DashboardView 
              currentUser={currentUser}
              products={products}
              inventory={inventory}
              sales={sales}
              expenses={expenses}
              storeConfigs={storeConfigs}
              productStoreCosts={productStoreCosts}
              otherIncome={otherIncome}
            />
          )}

          {tab === 'estoque' && (
            <EstoqueView 
              currentUser={currentUser}
              products={products}
              inventory={inventory}
              movements={movements}
              sales={sales}
              storeConfigs={storeConfigs}
              addProduct={addProduct}
              editProduct={editProduct}
              saveProduct={saveProduct}
              registerSerializedStockEntry={registerSerializedStockEntry}
              registerTransfer={registerTransfer}
              registerStockEntry={registerStockEntry}
              productStoreCosts={productStoreCosts}
              onStockChanged={loadAllFromSupabase}
              mergeProducts={mergeProducts}
            />
          )}

          {tab === 'balanco' && (
            <BalancoPanel
              currentUser={currentUser}
              products={products.filter(product => !product.archivedAt)}
              inventory={inventory}
              storeConfigs={storeConfigs}
              productStoreCosts={productStoreCosts}
              onStockChanged={loadAllFromSupabase}
            />
          )}

          {tab === 'servicos' && (
            <ServicosView
              services={services}
              saveService={saveService}
              deleteService={deleteService}
              workOrders={workOrders}
              storeConfigs={storeConfigs}
              updateWorkOrderStatus={updateWorkOrderStatus}
            />
          )}

          {tab === 'clientes' && (
            <ClientesView sales={sales} products={products} storeConfigs={storeConfigs} />
          )}

          {tab === 'vendas' && (
            <VendasView 
              currentUser={currentUser}
              products={products}
              inventory={inventory}
              tradeIns={tradeIns}
              storeConfigs={storeConfigs}
              stockTradeIn={stockTradeIn}
              cancelTradeIn={cancelTradeIn}
            />
          )}

          {(tab === 'financeiro' || tab === 'caixa') && (
            <Fragment key={`${tab}-${financeiroKey}`}>
            <FinanceiroView
              section={tab === 'caixa' ? 'caixa' : 'resultados'}
              onOpenTab={openFinanceTab}
              currentUser={currentUser}
              expenses={expenses}
              storeConfigs={storeConfigs}
              sales={sales}
              products={products}
              inventory={inventory}
              suppliers={suppliers}
              addSupplier={addSupplier}
              reloadExpenses={reloadExpenses}
              otherIncome={otherIncome}
              reloadOtherIncome={async () => { await reloadOtherIncome(); await loadAllFromSupabase(); }}
              productStoreCosts={productStoreCosts}
              initialTab={financeiroTab}
              updateStoreConfig={updateStoreConfig}
              cancelSale={cancelSale}
            />
            </Fragment>
          )}

          {tab === 'admin' && (
            <AdminToolsView 
              currentUser={currentUser}
              products={products}
              inventory={inventory}
              storeConfigs={storeConfigs}
              suppliers={suppliers}
              addSupplier={addSupplier}
              editSupplier={editSupplier}
              deleteSupplier={deleteSupplier}
            />
          )}

          {tab === 'agencia' && (
            <AgencyView
              currentUser={currentUser}
              alerts={insights.alerts}
              storeConfigs={storeConfigs}
              products={products}
              inventory={inventory}
              sales={sales}
              expenses={expenses}
              otherIncome={otherIncome}
              workOrders={workOrders}
              pdvOperators={pdvOperators}
              suppliers={suppliers}
              productStoreCosts={productStoreCosts}
              onNavigate={navigateFromAgency}
              onExit={() => setActiveTab(agencyReturnTab.current)}
              instagramReturn={instagramReturn}
              onInstagramReturnHandled={() => setInstagramReturn(null)}
            />
          )}

          {tab === 'configuracoes' && (
            <ConfiguracoesView
              currentUser={currentUser}
              storeConfigs={storeConfigs}
              pdvOperators={pdvOperators}
              updateCurrentUserDisplayName={updateCurrentUserDisplayName}
              updateStoreConfig={updateStoreConfig}
              deleteStoreConfig={deleteStoreConfig}
              savePdvOperator={savePdvOperator}
              deletePdvOperator={deletePdvOperator}
            />
          )}
        </main>
      </div>
    </div>
  );
}
