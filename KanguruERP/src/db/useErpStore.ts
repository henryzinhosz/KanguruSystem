import { useState, useEffect, useCallback } from 'react';
import { supabaseService, isTableMissingError } from './supabaseService';
import { supabase } from './supabaseClient';
import { 
  User, 
  UserRole,
  Product, 
  Service,
  StockInventory, 
  StockMovement, 
  Sale, 
  Expense, 
  TradeIn, 
  TradeInApproval,
  WorkOrder, 
  WorkOrderStatus,
  StoreConfig, 
  Supplier, 
  PdvOperator,
  CardCondition,
  PaymentMethod,
  MovementType,
  SerializedStockEntryUnit,
  ProductStoreCost,
  StockEntryLine
} from '../types';

export function useErpStore() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [inventory, setInventory] = useState<StockInventory[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [tradeIns, setTradeIns] = useState<TradeIn[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [storeConfigs, setStoreConfigs] = useState<StoreConfig[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [pdvOperators, setPdvOperators] = useState<PdvOperator[]>([]);
  const [productStoreCosts, setProductStoreCosts] = useState<ProductStoreCost[]>([]);

  // Supabase Sync States
  const useSupabase = true;
  const [supabaseLoading, setSupabaseLoading] = useState<boolean>(false);
  const [supabaseConnected, setSupabaseConnected] = useState<boolean | null>(null);
  const [supabaseMissingTables, setSupabaseMissingTables] = useState<string[]>([]);
  const [supabaseError, setSupabaseError] = useState<string | null>(null);
  const [authProfileError, setAuthProfileError] = useState<string | null>(null);

  const clearOperationalData = useCallback(() => {
    setProducts([]);
    setServices([]);
    setInventory([]);
    setMovements([]);
    setSales([]);
    setExpenses([]);
    setTradeIns([]);
    setWorkOrders([]);
    setStoreConfigs([]);
    setSuppliers([]);
    setPdvOperators([]);
    setProductStoreCosts([]);
  }, []);

  // Supabase owns the persisted session; the ERP derives its in-memory gestor profile from it.
  useEffect(() => {
    const applyAuthUser = async (authUser: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null) => {
      if (!authUser) {
        setCurrentUser(null);
        setAuthProfileError(null);
        clearOperationalData();
        return;
      }

      try {
        const profile = await supabaseService.getCurrentAppUserProfile(authUser.id);
        if (!profile) {
          setAuthProfileError('Esta conta ainda não possui acesso ao ERP. Peça ao administrador para criar seu vínculo de usuário.');
          setCurrentUser(null);
          return;
        }

        if (profile.role !== UserRole.SUPER_ADMIN && !profile.tenantId) {
          throw new Error('Usuário de tenant sem tenant_id.');
        }
        if (profile.isActive === false) {
          throw new Error('Seu acesso ao ERP foi desativado pelo administrador da empresa.');
        }
        // Gerente: lojas liberadas. Com mais de uma, as telas mostram o seletor (como o dono).
        const managerStores = profile.role === UserRole.ADMIN ? null : profile.storeIds ?? null;

      const metadataName = typeof authUser.user_metadata?.name === 'string' ? authUser.user_metadata.name : undefined;
        const baseUser: User = {
          id: authUser.id,
          name: profile.displayName || metadataName || authUser.email?.split('@')[0] || 'Gestor',
          role: profile.role,
          tenantId: profile.tenantId,
          unitId: managerStores && managerStores.length > 1 ? 'central' : profile.unitId || 'central',
          planCode: profile.planCode,
          subscriptionStatus: profile.subscriptionStatus,
          permissions: profile.role === UserRole.ADMIN ? null : profile.permissions ?? null,
          storeIds: managerStores
        };

        if (baseUser.role === UserRole.SUPER_ADMIN) {
          clearOperationalData();
        }
        // O Supabase reemite o login ao voltar para a janela (Alt+Tab) e ao renovar
        // o token (~1h). Mesmo usuario e mesmo perfil = manter o objeto atual, para
        // nao recarregar tudo nem apagar o que esta sendo digitado nas telas.
        setCurrentUser(previous => previous
          && previous.id === baseUser.id
          && previous.name === baseUser.name
          && previous.role === baseUser.role
          && previous.tenantId === baseUser.tenantId
          && previous.unitId === baseUser.unitId
          && previous.planCode === baseUser.planCode
          && previous.subscriptionStatus === baseUser.subscriptionStatus
          && JSON.stringify(previous.permissions ?? null) === JSON.stringify(baseUser.permissions ?? null)
          && JSON.stringify(previous.storeIds ?? null) === JSON.stringify(baseUser.storeIds ?? null)
          ? previous
          : baseUser);
        setAuthProfileError(null);
      } catch (error) {
        console.error('Erro ao carregar perfil de acesso:', error);
        setAuthProfileError(error instanceof Error ? error.message : 'Não foi possível carregar seu perfil de acesso.');
        setCurrentUser(null);
      }
    };

    void supabase.auth.getUser().then(({ data }) => void applyAuthUser(data.user));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => void applyAuthUser(session?.user ?? null));

    return () => listener.subscription.unsubscribe();
  }, [clearOperationalData]);

  // Load all data from Supabase
  const loadAllFromSupabase = useCallback(async () => {
    if (currentUser?.role === UserRole.SUPER_ADMIN) {
      clearOperationalData();
      setSupabaseLoading(false);
      return false;
    }

    setSupabaseLoading(true);
    setSupabaseError(null);
    try {
      const conn = await supabaseService.testConnection();
      setSupabaseConnected(conn.connected);
      if (conn.error) {
        setSupabaseError(conn.error);
        setSupabaseLoading(false);
        return false;
      }
      if (conn.missingTables && conn.missingTables.length > 0) {
        setSupabaseMissingTables(conn.missingTables);
        setSupabaseLoading(false);
        return false;
      }

      setSupabaseMissingTables([]);

      // Fetch all tables in parallel
      const [
        pList,
        serviceList,
        iList,
        mList,
        sList,
        eList,
        tList,
        wList,
        cList,
        supList,
        operatorList
      ] = await Promise.all([
        supabaseService.getProducts(),
        supabaseService.getServices(),
        supabaseService.getInventory(),
        supabaseService.getMovements(),
        supabaseService.getSales(),
        supabaseService.getExpenses(),
        supabaseService.getTradeIns(),
        supabaseService.getWorkOrders(),
        supabaseService.getStoreConfigs(),
        supabaseService.getSuppliers(),
        supabaseService.getPdvOperators()
      ]);

      setProducts(pList);
      setServices(serviceList);
      setInventory(iList);
      setMovements(mList);
      setSales(sList);
      setExpenses(eList);
      setTradeIns(tList);
      setWorkOrders(wList);
      setStoreConfigs(cList);
      setSuppliers(supList);
      setPdvOperators(operatorList);

      // Custo por loja (2.7b). Tolerante a falha: o restante do ERP continua
      // funcionando mesmo que a leitura de custos falhe.
      try {
        setProductStoreCosts(await supabaseService.getProductStoreCosts());
      } catch (costError) {
        console.warn('Nao foi possivel carregar o custo por loja:', costError);
        setProductStoreCosts([]);
      }
      
      setSupabaseLoading(false);
      return true;
    } catch (err: any) {
      console.error('Erro ao buscar dados do Supabase:', err);
      if (isTableMissingError(err)) {
        const conn = await supabaseService.testConnection();
        if (conn.missingTables) setSupabaseMissingTables(conn.missingTables);
      } else {
        setSupabaseError(err.message || 'Falha ao sincronizar com o banco remoto');
      }
      setSupabaseLoading(false);
      return false;
    }
  }, [clearOperationalData, currentUser]);

  // Load protected data after the Supabase login has established an authenticated session.
  useEffect(() => {
    if (currentUser && currentUser.role !== UserRole.SUPER_ADMIN) {
      void loadAllFromSupabase();
    }
  }, [currentUser, loadAllFromSupabase]);

  // Add a product to the catalog
  // Codigo vazio: o banco gera o proximo numero. Erro (ex.: codigo repetido) sobe para a tela.
  const addProduct = async (
    product: Omit<Product, 'id'>,
    initialStoreId?: string,
    initialQty: number = 0,
    initialSerials: string[] = []
  ): Promise<Product> => {
    const newId = 'p_new_' + Math.random().toString(36).substring(2, 9);
    let newProduct: Product = {
      ...product,
      sku: product.sku.trim().toUpperCase(),
      name: product.name.trim(),
      brand: product.brand.trim(),
      ncm: product.ncm.trim(),
      id: newId
    };

    if (useSupabase) {
      const savedSku = await supabaseService.upsertProduct(newProduct);
      newProduct = { ...newProduct, sku: savedSku };
    }
    setProducts(prev => [newProduct, ...prev]);

    return newProduct;
  };

  // Edicao completa (formulario do produto): aguarda o banco e devolve o erro para a tela.
  const saveProduct = async (updatedProduct: Product): Promise<void> => {
    const sanitizedProduct: Product = {
      ...updatedProduct,
      sku: updatedProduct.sku.trim().toUpperCase(),
      name: updatedProduct.name.trim(),
      brand: updatedProduct.brand.trim(),
      ncm: updatedProduct.ncm.trim()
    };
    const savedSku = useSupabase ? await supabaseService.upsertProduct(sanitizedProduct) : sanitizedProduct.sku;
    const saved = { ...sanitizedProduct, sku: savedSku };
    setProducts(prev => prev.map(p => p.id === saved.id ? saved : p));
  };

  const editProduct = async (updatedProduct: Product) => {
    const sanitizedProduct: Product = {
      ...updatedProduct,
      sku: updatedProduct.sku.trim(),
      name: updatedProduct.name.trim(),
      brand: updatedProduct.brand.trim(),
      ncm: updatedProduct.ncm.trim()
    };

    if (useSupabase) await supabaseService.upsertProduct(sanitizedProduct);
    setProducts(prev => prev.map(p => p.id === sanitizedProduct.id ? sanitizedProduct : p));
  };

  const saveService = async (service: Service) => {
    const sanitizedService = {
      ...service,
      sku: service.sku.trim().toUpperCase(),
      name: service.name.trim(),
      category: service.category.trim()
    };
    sanitizedService.sku = await supabaseService.upsertService(sanitizedService);
    setServices(previous => previous.some(item => item.id === sanitizedService.id)
      ? previous.map(item => item.id === sanitizedService.id ? sanitizedService : item)
      : [...previous, sanitizedService].sort((left, right) => left.name.localeCompare(right.name))
    );
  };

  const deleteService = async (id: string) => {
    await supabaseService.deleteService(id);
    setServices(previous => previous.filter(service => service.id !== id));
  };

  const registerStockEntry = async (
    productId: string,
    entries: StockEntryLine[],
    unitCost: number,
    reason: string
  ) => {
    await supabaseService.registerStockEntry(productId, entries, unitCost, reason);
    await loadAllFromSupabase();
  };

  const registerSerializedStockEntry = async (
    productId: string,
    unitId: string,
    units: SerializedStockEntryUnit[],
    reason: string
  ) => {
    await supabaseService.registerSerializedStockEntry(productId, unitId, units, reason);
    await loadAllFromSupabase();
  };

  // Transferencia entre lojas: aguarda o banco (erro sobe para a tela) e recarrega o estoque.
  const registerTransfer = async (
    productId: string,
    fromUnitId: string,
    toUnitId: string,
    quantity: number,
    serials: string[],
    cardCondition: CardCondition | undefined,
    reason: string
  ) => {
    await supabaseService.processInventoryMovement({
      id: 'm_' + Math.random().toString(36).substring(2, 9),
      productId,
      fromUnitId,
      toUnitId,
      type: 'TRANSFERENCIA',
      quantity,
      serials,
      cardCondition,
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      timestamp: new Date().toISOString(),
      reason
    });
    await loadAllFromSupabase();
  };

  // Cancel / Return a Sale
  const cancelSale = async (saleId: string, approvedByAdminName?: string): Promise<'PENDENTE_APROVACAO' | 'CANCELADA' | undefined> => {
    const sale = sales.find(s => s.id === saleId);
    if (!sale) return undefined;

    const needsAdminApproval = sale.grossAmount > 300;

    if (needsAdminApproval && currentUser.role !== UserRole.ADMIN && !approvedByAdminName) {
      // Pedido de estorno: aguarda a aprovacao de um administrador.
      if (useSupabase) await supabaseService.updateSaleStatus(saleId, 'PENDENTE_APROVACAO');
      setSales(prev => prev.map(s => (s.id === saleId ? { ...s, status: 'PENDENTE_APROVACAO' as const } : s)));
      return 'PENDENTE_APROVACAO';
    }

    if (useSupabase) {
      await supabaseService.processSaleCancellation(saleId, approvedByAdminName || currentUser.name);
      await loadAllFromSupabase();
    }
    return 'CANCELADA';
  };

  // Register Expenses
  const addExpense = async (expense: Omit<Expense, 'id' | 'operatorId' | 'operatorName' | 'timestamp'>) => {
    const newExpense: Expense = {
      ...expense,
      id: 'e_' + Math.random().toString(36).substring(2, 9),
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      timestamp: new Date().toISOString()
    };
    if (useSupabase) await supabaseService.upsertExpense(newExpense);
    setExpenses(prev => [newExpense, ...prev]);
  };

  // Troca Gamer: cadastra o videogame usado e da entrada da unidade com o serial real.
  // O custo da unidade e o valor pago ao cliente (entra no custo medio da loja).
  // Se o produto ja foi criado numa tentativa anterior que falhou na entrada, reaproveita.
  const approveTradeIn = async (tradeId: string, details: TradeInApproval): Promise<void> => {
    const trade = tradeIns.find(t => t.id === tradeId);
    if (!trade) throw new Error('Troca não encontrada.');
    const unitId = trade.unitId || currentUser.unitId;

    let productId = trade.createdProductId && products.some(p => p.id === trade.createdProductId)
      ? trade.createdProductId
      : null;
    if (!productId) {
      const newProduct = await addProduct({
        sku: details.sku,
        name: details.name,
        category: 'Videogames',
        brand: 'Troca Gamer',
        costPrice: trade.valuationAmount,
        sellPrice: details.sellPrice,
        ncm: details.ncm,
        warrantyMonths: details.warrantyMonths,
        isSerialized: true,
        isUsed: true,
        cest: details.cest,
        icmsOrigin: details.icmsOrigin,
        icmsCst: details.icmsCst,
        csosn: details.csosn,
        icmsRate: details.icmsRate,
        icmsReduction: details.icmsReduction,
        taxBurdenPercent: details.taxBurdenPercent
      });
      productId = newProduct.id;
      const withProduct = { ...trade, createdProductId: productId };
      if (useSupabase) await supabaseService.upsertTradeIn(withProduct);
      setTradeIns(prev => prev.map(t => t.id === tradeId ? withProduct : t));
    }

    await registerSerializedStockEntry(
      productId,
      unitId,
      [{ serialNumber: details.serialNumber, imei: details.imei || undefined, unitCost: trade.valuationAmount }],
      `Troca Gamer: compra de ${trade.sellerName} (CPF: ${trade.sellerCpf})`
    );

    const approved = { ...trade, status: 'APROVADO' as const, createdProductId: productId };
    if (useSupabase) await supabaseService.upsertTradeIn(approved);
    setTradeIns(prev => prev.map(t => t.id === tradeId ? approved : t));
  };

  const cancelTradeIn = async (tradeId: string) => {
    const trade = tradeIns.find(t => t.id === tradeId);
    if (!trade) return;
    const updated = { ...trade, status: 'CANCELADO' as const };
    if (useSupabase) await supabaseService.upsertTradeIn(updated);
    setTradeIns(prev => prev.map(t => (t.id === tradeId ? updated : t)));
  };

  // Ordens de servico: abertas, cobradas e entregues no PDV; o ERP acompanha e muda a situacao.
  const updateWorkOrderStatus = async (woId: string, status: WorkOrderStatus): Promise<void> => {
    if (useSupabase) await supabaseService.updateWorkOrderStatus(woId, status);
    setWorkOrders(prev => prev.map(wo => (wo.id === woId ? { ...wo, status } : wo)));
  };

  // Configure fees and fixed costs per store
  const updateStoreConfig = async (unitId: string, updated: Partial<StoreConfig>) => {
    const existing = storeConfigs.find(cfg => cfg.unitId === unitId);
    const updatedConfig: StoreConfig = {
      unitId,
      fixedCost: existing?.fixedCost || 0,
      maxItemDiscountPercent: existing?.maxItemDiscountPercent ?? 0,
      ...existing,
      ...updated,
      paymentFees: {
        DINHEIRO: 0,
        PIX: 0,
        CREDITO: 0,
        DEBITO: 0,
        ...(existing?.paymentFees || {}),
        ...(updated.paymentFees || {})
      }
    };

    if (useSupabase) {
      await supabaseService.upsertStoreConfig(updatedConfig);
    }

    setStoreConfigs(prev => existing
      ? prev.map(cfg => cfg.unitId === unitId ? updatedConfig : cfg)
      : [...prev, updatedConfig]
    );
  };

  const deleteStoreConfig = async (unitId: string) => {
    if (!currentUser?.tenantId) {
      throw new Error('Selecione uma empresa antes de excluir uma loja.');
    }

    if (useSupabase) {
      await supabaseService.deleteStoreConfig(currentUser.tenantId, unitId);
    }

    setStoreConfigs(previous => previous.filter(config => config.unitId !== unitId));
  };

  const savePdvOperator = async (operator: Omit<PdvOperator, 'tenantId' | 'createdAt' | 'updatedAt'>) => {
    const saved = await supabaseService.upsertPdvOperator(operator);
    setPdvOperators(previous => previous.some(item => item.id === saved.id)
      ? previous.map(item => item.id === saved.id ? saved : item)
      : [...previous, saved].sort((left, right) => left.name.localeCompare(right.name))
    );
  };

  const deletePdvOperator = async (id: string) => {
    await supabaseService.deletePdvOperator(id);
    setPdvOperators(previous => previous.filter(operator => operator.id !== id));
  };

  const updateCurrentUserDisplayName = async (displayName: string) => {
    await supabaseService.updateCurrentUserDisplayName(displayName);
    setCurrentUser(previous => previous ? { ...previous, name: displayName.trim() || previous.name } : previous);
  };

  // Bulk CSV import of product catalog or past sales spreadsheet!
  const addSupplier = async (supplier: Omit<Supplier, 'id' | 'historyCount'>) => {
    const newId = 's_' + Math.random().toString(36).substring(2, 9);
    const newSupplier: Supplier = { 
      ...supplier, 
      id: newId, 
      historyCount: 0 
    };
    if (useSupabase) await supabaseService.upsertSupplier(newSupplier);
    setSuppliers(prev => [newSupplier, ...prev]);
    return newSupplier;
  };

  const editSupplier = async (updatedSupplier: Supplier) => {
    if (useSupabase) await supabaseService.upsertSupplier(updatedSupplier);
    setSuppliers(prev => prev.map(s => s.id === updatedSupplier.id ? updatedSupplier : s));
  };

  const deleteSupplier = async (id: string) => {
    if (useSupabase) await supabaseService.deleteSupplier(id);
    setSuppliers(prev => prev.filter(s => s.id !== id));
  };

  // Gerente so enxerga as lojas liberadas para ele (o banco ja bloqueia o resto).
  const visibleStoreConfigs = currentUser?.storeIds
    ? storeConfigs.filter(config => config.unitId === 'central' || currentUser.storeIds!.includes(config.unitId))
    : storeConfigs;

  return {
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
    storeConfigs: visibleStoreConfigs,
    suppliers,
    pdvOperators,
    productStoreCosts,
    useSupabase,
    supabaseLoading,
    supabaseConnected,
    supabaseMissingTables,
    supabaseError,
    authProfileError,
    loadAllFromSupabase,
    addProduct,
    editProduct,
    saveProduct,
    saveService,
    deleteService,
    registerStockEntry,
    registerSerializedStockEntry,
    registerTransfer,
    cancelSale,
    addExpense,
    approveTradeIn,
    cancelTradeIn,
    updateWorkOrderStatus,
    updateStoreConfig,
    deleteStoreConfig,
    savePdvOperator,
    deletePdvOperator,
    updateCurrentUserDisplayName,
    addSupplier,
    editSupplier,
    deleteSupplier
  };
}
