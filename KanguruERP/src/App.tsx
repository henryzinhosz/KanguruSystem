/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { useErpStore } from './db/useErpStore';
import { supabase } from './db/supabaseClient';
import Header from './components/Header';
import LoginScreen from './components/LoginScreen';
import DashboardView from './components/DashboardView';
import EstoqueView from './components/EstoqueView';
import VendasView from './components/VendasView';
import FinanceiroView from './components/FinanceiroView';
import AssistênciaView from './components/AssistênciaView';
import AdminToolsView from './components/AdminToolsView';
import ConfiguracoesView from './components/ConfiguracoesView';
import UcpView from './components/UcpView';
import { UserRole } from './types';
import { 
  LayoutDashboard, 
  Package, 
  ShoppingBag, 
  Wrench, 
  DollarSign, 
  FileSpreadsheet,
  Layers,
  ArrowUpRight,
  Coins,
  Settings
} from 'lucide-react';

export default function App() {
  const {
    currentUser,
    setCurrentUser,
    products,
    inventory,
    movements,
    sales,
    expenses,
    tradeIns,
    workOrders,
    storeConfigs,
    suppliers,
    pdvOperators,
    resetDatabase,
    addProduct,
    editProduct,
    registerMovement,
    registerSerializedStockEntry,
    registerSale,
    cancelSale,
    addExpense,
    registerTradeIn,
    approveTradeIn,
    cancelTradeIn,
    addWorkOrder,
    updateWorkOrderStatus,
    updateStoreConfig,
    deleteStoreConfig,
    savePdvOperator,
    deletePdvOperator,
    updateCurrentUserDisplayName,
    importBulkProducts,
    addSupplier,
    editSupplier,
    deleteSupplier,
    authProfileError,
  } = useErpStore();

  // Active Main View Tab
  const [activeTab, setActiveTab] = useState<'dashboard' | 'estoque' | 'vendas' | 'assistencia' | 'financeiro' | 'admin' | 'configuracoes'>('dashboard');

  if (!currentUser) {
    return <LoginScreen accessError={authProfileError} />;
  }

  const isPlatformAdmin = currentUser.role === UserRole.SUPER_ADMIN;

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
        <main className="erp-workspace flex-1 w-full overflow-y-auto p-3 sm:p-4 lg:p-5">
          <UcpView />
        </main>
      </div>
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
    { id: 'dashboard', name: 'Dashboard Geral', icon: LayoutDashboard },
    { id: 'estoque', name: 'Catálogo & Estoque', icon: Package },
    { id: 'vendas', name: 'Trade-In (Usados)', icon: Coins },
    { id: 'assistencia', name: 'Assistência / OS', icon: Wrench },
    { id: 'financeiro', name: 'Livro Caixa & DRE', icon: DollarSign },
    { id: 'admin', name: 'Fornecedores', icon: FileSpreadsheet },
    { id: 'configuracoes', name: 'Configurações', icon: Settings }
  ] as const;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Top Header with Store & Account controls */}
      <Header 
        currentUser={currentUser} 
        onLogout={() => {
          void supabase.auth.signOut();
          setCurrentUser(null);
        }}
      />

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
            {navigationItems.map((item) => {
              const IconComponent = item.icon;
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  id={`nav-${item.id}`}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center px-4 py-3 text-sm font-semibold transition-all duration-150 rounded-r-lg ${
                    isActive
                      ? 'bg-blue-600/15 text-blue-400 border-l-4 border-blue-500 font-bold'
                      : 'hover:bg-slate-900/60 hover:text-white text-slate-400 border-l-4 border-transparent'
                  }`}
                >
                  <IconComponent className="w-[18px] h-[18px] mr-3 shrink-0" />
                  <span>{item.name}</span>
                </button>
              );
            })}
          </nav>

          {/* Footer of Sidebar */}
          <div className="p-4 bg-slate-950/80 border-t border-slate-900 text-xs text-slate-500 font-mono text-center hidden md:block">
            <p>Vortex ERP © 2026</p>
            <p className="mt-0.5 opacity-80">v1.1.0 — Professional Polish</p>
          </div>
        </aside>

        {/* Main Content Workspace Container */}
        <main className="erp-workspace flex-1 p-3 sm:p-4 lg:p-5 w-full overflow-y-auto">
          {activeTab === 'dashboard' && (
            <DashboardView 
              currentUser={currentUser}
              products={products}
              inventory={inventory}
              sales={sales}
              expenses={expenses}
              storeConfigs={storeConfigs}
            />
          )}

          {activeTab === 'estoque' && (
            <EstoqueView 
              currentUser={currentUser}
              products={products}
              inventory={inventory}
              movements={movements}
              sales={sales}
              storeConfigs={storeConfigs}
              addProduct={addProduct}
              editProduct={editProduct}
              registerMovement={registerMovement}
              registerSerializedStockEntry={registerSerializedStockEntry}
            />
          )}

          {activeTab === 'vendas' && (
            <VendasView 
              currentUser={currentUser}
              products={products}
              inventory={inventory}
              tradeIns={tradeIns}
              storeConfigs={storeConfigs}
              registerTradeIn={registerTradeIn}
              approveTradeIn={approveTradeIn}
              cancelTradeIn={cancelTradeIn}
            />
          )}

          {activeTab === 'assistencia' && (
            <AssistênciaView 
              currentUser={currentUser}
              workOrders={workOrders}
              storeConfigs={storeConfigs}
              addWorkOrder={addWorkOrder}
              updateWorkOrderStatus={updateWorkOrderStatus}
            />
          )}

          {activeTab === 'financeiro' && (
            <FinanceiroView 
              currentUser={currentUser}
              expenses={expenses}
              storeConfigs={storeConfigs}
              sales={sales}
              products={products}
              inventory={inventory}
              addExpense={addExpense}
              updateStoreConfig={updateStoreConfig}
              registerSale={registerSale}
              cancelSale={cancelSale}
            />
          )}

          {activeTab === 'admin' && (
            <AdminToolsView 
              onResetDb={resetDatabase}
              importBulkProducts={importBulkProducts}
              suppliers={suppliers}
              addSupplier={addSupplier}
              editSupplier={editSupplier}
              deleteSupplier={deleteSupplier}
            />
          )}

          {activeTab === 'configuracoes' && (
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
