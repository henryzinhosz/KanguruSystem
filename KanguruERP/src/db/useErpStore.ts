import { useState, useEffect, useCallback } from 'react';
import { supabaseService, isTableMissingError } from './supabaseService';
import { supabase } from './supabaseClient';
import { 
  User, 
  UserRole,
  Product, 
  StockInventory, 
  StockMovement, 
  Sale, 
  Expense, 
  TradeIn, 
  WorkOrder, 
  StoreConfig, 
  Supplier, 
  PdvOperator,
  CardCondition,
  PaymentMethod,
  MovementType,
  SerializedStockEntryUnit
} from '../types';

export function useErpStore() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [inventory, setInventory] = useState<StockInventory[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [tradeIns, setTradeIns] = useState<TradeIn[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [storeConfigs, setStoreConfigs] = useState<StoreConfig[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [pdvOperators, setPdvOperators] = useState<PdvOperator[]>([]);

  // Supabase Sync States
  const useSupabase = true;
  const [supabaseLoading, setSupabaseLoading] = useState<boolean>(false);
  const [supabaseConnected, setSupabaseConnected] = useState<boolean | null>(null);
  const [supabaseMissingTables, setSupabaseMissingTables] = useState<string[]>([]);
  const [supabaseError, setSupabaseError] = useState<string | null>(null);
  const [authProfileError, setAuthProfileError] = useState<string | null>(null);

  const clearOperationalData = useCallback(() => {
    setProducts([]);
    setInventory([]);
    setMovements([]);
    setSales([]);
    setExpenses([]);
    setTradeIns([]);
    setWorkOrders([]);
    setStoreConfigs([]);
    setSuppliers([]);
    setPdvOperators([]);
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

      const metadataName = typeof authUser.user_metadata?.name === 'string' ? authUser.user_metadata.name : undefined;
        const baseUser: User = {
          id: authUser.id,
          name: metadataName || authUser.email?.split('@')[0] || 'Gestor',
          role: profile.role,
          tenantId: profile.tenantId,
          unitId: profile.unitId || 'central',
          planCode: profile.planCode,
          subscriptionStatus: profile.subscriptionStatus
        };

        if (baseUser.role === UserRole.SUPER_ADMIN) {
          clearOperationalData();
        }
        setCurrentUser(baseUser);
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
      setInventory(iList);
      setMovements(mList);
      setSales(sList);
      setExpenses(eList);
      setTradeIns(tList);
      setWorkOrders(wList);
      setStoreConfigs(cList);
      setSuppliers(supList);
      setPdvOperators(operatorList);
      
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

  // Toggle useSupabase state
  const toggleUseSupabase = async (enabled: boolean): Promise<{ success: boolean; error?: string; missingTables?: string[] }> => {
    if (!enabled) {
      return { success: false, error: 'O uso do Supabase é obrigatório e não pode ser desativado.' };
    }
    if (currentUser?.role === UserRole.SUPER_ADMIN) {
      clearOperationalData();
      return { success: false, error: 'Dados operacionais não estão disponíveis para administração da plataforma.' };
    }
    setSupabaseLoading(true);
    const conn = await supabaseService.testConnection();
    setSupabaseConnected(conn.connected);
    
    if (!conn.connected) {
      setSupabaseLoading(false);
      return { success: false, error: conn.error || 'Não foi possível conectar ao Supabase' };
    }
    
    if (conn.missingTables && conn.missingTables.length > 0) {
      setSupabaseMissingTables(conn.missingTables);
      setSupabaseLoading(false);
      return { success: false, error: 'Tabelas ausentes no banco de dados', missingTables: conn.missingTables };
    }

    setSupabaseMissingTables([]);
    const loaded = await loadAllFromSupabase();
    if (loaded) {
      setSupabaseLoading(false);
      return { success: true };
    } else {
      setSupabaseLoading(false);
      return { success: false, error: 'Falha ao buscar dados após conectar.' };
    }
  };

  // Export current local storage data into Supabase
  const exportLocalToSupabase = async (): Promise<{ success: boolean; errors: string[] }> => {
    setSupabaseLoading(true);
    const result = await supabaseService.exportAllToSupabase({
      products,
      inventory,
      movements,
      sales,
      expenses,
      tradeIns,
      workOrders,
      storeConfigs,
      suppliers
    });
    
    if (result.success) {
      await loadAllFromSupabase();
    }
    setSupabaseLoading(false);
    return result;
  };

  // RESET DATABASE helper
  const resetDatabase = () => {
    setCurrentUser(null);
    setProducts([]);
    setInventory([]);
    setMovements([]);
    setSales([]);
    setExpenses([]);
    setTradeIns([]);
    setWorkOrders([]);
    setStoreConfigs([]);
    setSuppliers([]);
    setPdvOperators([]);
  };

  // Add a product to the catalog
  const addProduct = (
    product: Omit<Product, 'id'>,
    initialStoreId?: string,
    initialQty: number = 0,
    initialSerials: string[] = []
  ) => {
    const newId = 'p_new_' + Math.random().toString(36).substring(2, 9);
    const newProduct: Product = {
      ...product,
      sku: product.sku.trim(),
      name: product.name.trim(),
      brand: product.brand.trim(),
      ncm: product.ncm.trim(),
      id: newId
    };
    setProducts(prev => [newProduct, ...prev]);

    if (useSupabase) {
      supabaseService.upsertProduct(newProduct).catch(err => console.error('Erro ao salvar produto no Supabase:', err));
    }

    return newProduct;
  };

  const editProduct = (updatedProduct: Product) => {
    const sanitizedProduct: Product = {
      ...updatedProduct,
      sku: updatedProduct.sku.trim(),
      name: updatedProduct.name.trim(),
      brand: updatedProduct.brand.trim(),
      ncm: updatedProduct.ncm.trim()
    };

    setProducts(prev => prev.map(p => p.id === sanitizedProduct.id ? sanitizedProduct : p));
    if (useSupabase) {
      supabaseService.upsertProduct(sanitizedProduct).catch(err => console.error('Erro ao editar produto no Supabase:', err));
    }
  };

  // Log raw movement & update quantity atomically
  const registerMovement = (
    productId: string,
    fromUnitId: string | 'FORNECEDOR',
    toUnitId: string | 'CLIENTE' | 'PERDA',
    type: MovementType,
    quantity: number,
    serials: string[] = [],
    cardCondition?: CardCondition,
    reason: string = '',
    syncToSupabase: boolean = true
  ) => {
    const createEmptyInventory = (): StockInventory => ({
      productId,
      quantities: Object.fromEntries(
        storeConfigs.map(store => [store.unitId, { unitId: store.unitId, qty: 0, serials: [], cardConditions: {} }])
      )
    });

    // Generate movement log
    const moveLog: StockMovement = {
      id: 'm_' + Math.random().toString(36).substring(2, 9),
      productId,
      fromUnitId,
      toUnitId,
      type,
      quantity,
      serials,
      cardCondition,
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      timestamp: new Date().toISOString(),
      reason
    };

    setMovements(prev => [moveLog, ...prev]);
    if (useSupabase && syncToSupabase) {
      supabaseService.processInventoryMovement(moveLog).catch(err => console.error('Erro ao salvar movimentação no Supabase:', err));
    }

    // Update quantities atomically inside the stock state
    setInventory(prevInv => {
      const existing = prevInv.find(inv => inv.productId === productId);
      const baseInventory = existing || createEmptyInventory();
      const updatedQuantities = { ...baseInventory.quantities };

      if (!existing && fromUnitId === 'FORNECEDOR' && toUnitId !== 'CLIENTE' && toUnitId !== 'PERDA') {
        updatedQuantities[toUnitId] = {
          unitId: toUnitId,
          qty: 0,
          serials: [],
          cardConditions: {}
        };
      }

      // Subtract from source if it is a real warehouse/store unit
      if (fromUnitId !== 'FORNECEDOR') {
        const srcUnit = updatedQuantities[fromUnitId] || { unitId: fromUnitId, qty: 0, serials: [], cardConditions: {} };
        const newQty = Math.max(0, srcUnit.qty - quantity);
        let newSerials = [...(srcUnit.serials || [])];
        if (serials.length > 0) {
          newSerials = newSerials.filter(s => !serials.includes(s));
        }

        const newConditions = { ...(srcUnit.cardConditions || {}) };
        if (cardCondition && newConditions[cardCondition] !== undefined) {
          newConditions[cardCondition] = Math.max(0, (newConditions[cardCondition] || 0) - quantity);
        }

        updatedQuantities[fromUnitId] = {
          ...srcUnit,
          qty: newQty,
          serials: newSerials,
          cardConditions: newConditions
        };
      }

      // Add to target if it is a real warehouse/store unit
      if (toUnitId !== 'CLIENTE' && toUnitId !== 'PERDA') {
        const destUnit = updatedQuantities[toUnitId] || { unitId: toUnitId, qty: 0, serials: [], cardConditions: {} };
        const newQty = destUnit.qty + quantity;
        const newSerials = [...(destUnit.serials || []), ...serials];

        const newConditions = { ...(destUnit.cardConditions || {}) };
        if (cardCondition) {
          newConditions[cardCondition] = (newConditions[cardCondition] || 0) + quantity;
        }

        updatedQuantities[toUnitId] = {
          ...destUnit,
          qty: newQty,
          serials: newSerials,
          cardConditions: newConditions
        };
      }

      const updatedRecord = {
        ...baseInventory,
        quantities: updatedQuantities
      };

      if (useSupabase) {
        supabaseService.upsertInventory(updatedRecord).catch(err => console.error('Erro ao atualizar estoque no Supabase:', err));
      }

      return existing
        ? prevInv.map(inv => inv.productId === productId ? updatedRecord : inv)
        : [...prevInv, updatedRecord];
    });
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

  // Register a point-of-sale Venda
  const registerSale = (
    unitId: string,
    items: { productId: string; variationId?: string; quantity: number; unitPrice: number; serials?: string[]; cardCondition?: CardCondition }[],
    paymentMethod: PaymentMethod,
    clientCpf?: string,
    clientName?: string,
    customAmount?: number,
    customDate?: string
  ) => {
    const grossAmount = customAmount !== undefined ? customAmount : items.reduce((acc, item) => acc + (item.unitPrice * item.quantity), 0);
    
    // Get store configs to calculate fees
    const config = storeConfigs.find(c => c.unitId === unitId) || {
      unitId,
      fixedCost: 10000,
      paymentFees: { DINHEIRO: 0.0, PIX: 0.005, CREDITO: 0.035, DEBITO: 0.015 }
    };

    const feeRate = config.paymentFees[paymentMethod];
    const feeAmount = grossAmount * feeRate;
    const netAmount = grossAmount - feeAmount;

    const saleId = 's_' + Math.random().toString(36).substring(2, 9);
    const invoiceNumber = 'VD-' + (1000 + sales.length + 1);

    const isHighValue = grossAmount > 2000; // Trigger demo pending approval status for high value (optional, wait, prompt requested: "Toda venda cancelada ou estornada acima de um valor configurável (ex: R$300) deve exigir aprovação de um Administrador")
    // Wait, let's keep sales completed immediately, but allow cancellation with Admin approval if > R$300!
    
    const newSale: Sale = {
      id: saleId,
      invoiceNumber,
      unitId,
      items,
      paymentMethod,
      grossAmount,
      feeAmount,
      netAmount,
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      clientCpf,
      clientName,
      timestamp: customDate ? new Date(customDate).toISOString() : new Date().toISOString(),
      status: 'CONCLUIDA',
      requiresApproval: false
    };

    // Commit changes to state
    setSales(prev => [newSale, ...prev]);
    if (useSupabase) {
      supabaseService.processSaleTransaction(newSale).catch(err => console.error('Erro ao salvar venda no Supabase:', err));
    }

    // Update local inventory/movement state only
    items.forEach(item => {
      registerMovement(
        item.productId,
        unitId,
        'CLIENTE',
        'SAIDA',
        item.quantity,
        item.serials || [],
        item.cardCondition,
        `Venda ${invoiceNumber}`,
        false
      );
    });

    return newSale;
  };

  // Cancel / Return a Sale
  const cancelSale = (saleId: string, approvedByAdminName?: string) => {
    const sale = sales.find(s => s.id === saleId);
    if (!sale) return;

    const needsAdminApproval = sale.grossAmount > 300;

    if (needsAdminApproval && currentUser.role !== UserRole.ADMIN && !approvedByAdminName) {
      // Mark as pending cancellation approval
      setSales(prev => prev.map(s => {
        if (s.id === saleId) {
          const updated = { ...s, status: 'PENDENTE_APROVACAO' as const };
          if (useSupabase) {
            supabaseService.upsertSale(updated).catch(err => console.error('Erro ao atualizar venda no Supabase:', err));
          }
          return updated;
        }
        return s;
      }));
      return 'PENDENTE_APROVACAO';
    }

    // Process actual cancellation: return items to store inventory!
    setSales(prev => prev.map(s => {
      if (s.id === saleId) {
        return {
          ...s,
          status: 'CANCELADA' as const,
          approvedBy: approvedByAdminName || currentUser.name
        };
      }
      return s;
    }));

    if (useSupabase) {
      supabaseService.processSaleCancellation(saleId, approvedByAdminName || currentUser.name)
        .catch(err => console.error('Erro ao cancelar venda no Supabase:', err));
    }

    sale.items.forEach(item => {
      registerMovement(
        item.productId,
        'CLIENTE',
        sale.unitId,
        'ENTRADA',
        item.quantity,
        item.serials || [],
        item.cardCondition,
        `Cancelamento da Venda ${sale.invoiceNumber}`,
        false
      );
    });

    return 'CANCELADA';
  };

  // Register Expenses
  const addExpense = (expense: Omit<Expense, 'id' | 'operatorId' | 'operatorName' | 'timestamp'>) => {
    const newExpense: Expense = {
      ...expense,
      id: 'e_' + Math.random().toString(36).substring(2, 9),
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      timestamp: new Date().toISOString()
    };
    setExpenses(prev => [newExpense, ...prev]);
    if (useSupabase) {
      supabaseService.upsertExpense(newExpense).catch(err => console.error('Erro ao salvar despesa no Supabase:', err));
    }
  };

  // Register Trade-in evaluation
  const registerTradeIn = (trade: Omit<TradeIn, 'id' | 'operatorId' | 'operatorName' | 'timestamp' | 'status'>) => {
    const newTrade: TradeIn = {
      ...trade,
      id: 't_' + Math.random().toString(36).substring(2, 9),
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      timestamp: new Date().toISOString(),
      status: 'AVALIADO'
    };
    setTradeIns(prev => [newTrade, ...prev]);
    if (useSupabase) {
      supabaseService.upsertTradeIn(newTrade).catch(err => console.error('Erro ao salvar troca no Supabase:', err));
    }
    return newTrade;
  };

  // Approve a trade-in and automatically insert it as a USED item in the stock catalog!
  const approveTradeIn = (
    tradeId: string, 
    productDetails: { sku: string; name: string; category: string; brand: string; sellPrice: number; warrantyMonths: number; isSerialized: boolean }
  ) => {
    const trade = tradeIns.find(t => t.id === tradeId);
    if (!trade) return;

    // Create product in catalog
    const newProduct = addProduct({
      sku: productDetails.sku,
      name: `${productDetails.name} (Usado / Trade-In)`,
      category: productDetails.category,
      brand: productDetails.brand,
      costPrice: trade.valuationAmount,
      sellPrice: productDetails.sellPrice,
      ncm: '9504.50.00',
      warrantyMonths: productDetails.warrantyMonths,
      isSerialized: productDetails.isSerialized,
      isUsed: true
    });

    // Automatically give an initial Entrada of 1 unit in the physical store where trade-in was registered
    const unitIdToEnter = trade.unitId || (currentUser.unitId === 'central' ? 'loja_1' : currentUser.unitId);
    const serialToAdd = productDetails.isSerialized ? [`USED-${Math.random().toString(36).substring(2, 7).toUpperCase()}`] : [];
    
    registerMovement(
      newProduct.id,
      'FORNECEDOR',
      unitIdToEnter,
      'ENTRADA',
      1,
      serialToAdd,
      undefined,
      `Entrada de Trade-In Usado de ${trade.sellerName} (CPF: ${trade.sellerCpf})`
    );

    // Update tradeIn status
    setTradeIns(prev => prev.map(t => {
      if (t.id === tradeId) {
        const updated = { ...t, status: 'APROVADO' as const, createdProductId: newProduct.id };
        if (useSupabase) {
          supabaseService.upsertTradeIn(updated).catch(err => console.error('Erro ao atualizar troca no Supabase:', err));
        }
        return updated;
      }
      return t;
    }));
  };

  const cancelTradeIn = (tradeId: string) => {
    setTradeIns(prev => prev.map(t => {
      if (t.id === tradeId) {
        const updated = { ...t, status: 'CANCELADO' as const };
        if (useSupabase) {
          supabaseService.upsertTradeIn(updated).catch(err => console.error('Erro ao cancelar troca no Supabase:', err));
        }
        return updated;
      }
      return t;
    }));
  };

  // Work Orders / OS
  const addWorkOrder = (wo: Omit<WorkOrder, 'id' | 'osNumber' | 'operatorId' | 'operatorName' | 'timestamp'>) => {
    const osNumber = `OS-2026-${String(workOrders.length + 1).padStart(3, '0')}`;
    const newWo: WorkOrder = {
      ...wo,
      id: 'wo_' + Math.random().toString(36).substring(2, 9),
      osNumber,
      operatorId: currentUser.id,
      operatorName: currentUser.name,
      timestamp: new Date().toISOString()
    };
    setWorkOrders(prev => [newWo, ...prev]);
    if (useSupabase) {
      supabaseService.upsertWorkOrder(newWo).catch(err => console.error('Erro ao criar OS no Supabase:', err));
    }
    return newWo;
  };

  const updateWorkOrderStatus = (woId: string, status: 'AGUARDANDO_PECA' | 'EM_ANALISE' | 'PRONTO' | 'ENTREGUE') => {
    setWorkOrders(prev => prev.map(wo => {
      if (wo.id === woId) {
        const updated = { ...wo, status };
        if (useSupabase) {
          supabaseService.upsertWorkOrder(updated).catch(err => console.error('Erro ao atualizar OS no Supabase:', err));
        }
        return updated;
      }
      return wo;
    }));
  };

  // Configure fees and fixed costs per store
  const updateStoreConfig = async (unitId: string, updated: Partial<StoreConfig>) => {
    const existing = storeConfigs.find(cfg => cfg.unitId === unitId);
    const updatedConfig: StoreConfig = {
      unitId,
      fixedCost: existing?.fixedCost || 0,
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
  const importBulkProducts = (csvText: string) => {
    const lines = csvText.split('\n');
    let importedCount = 0;
    
    // Simple parser: sku, name, category, brand, costPrice, sellPrice, ncm, warrantyMonths, isSerialized
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const cols = line.split(';'); // semicolon-separated
      if (cols.length < 6) continue;

      const sku = cols[0]?.trim();
      const name = cols[1]?.trim();
      const category = cols[2]?.trim() || 'Outros';
      const brand = cols[3]?.trim() || 'Desconhecida';
      const costPrice = parseFloat(cols[4]) || 0;
      const sellPrice = parseFloat(cols[5]) || 0;
      const ncm = cols[6]?.trim() || '0000.00.00';
      const warrantyMonths = parseInt(cols[7]) || 12;
      const isSerialized = cols[8]?.trim().toLowerCase() === 'sim' || cols[8]?.trim().toLowerCase() === 'true';

      if (sku && name) {
        addProduct({
          sku,
          name,
          category,
          brand,
          costPrice,
          sellPrice,
          ncm,
          warrantyMonths,
          isSerialized,
          isUsed: false
        });
        importedCount++;
      }
    }
    return importedCount;
  };

  const addSupplier = (supplier: Omit<Supplier, 'id' | 'historyCount'>) => {
    const newId = 's_' + Math.random().toString(36).substring(2, 9);
    const newSupplier: Supplier = { 
      ...supplier, 
      id: newId, 
      historyCount: 0 
    };
    setSuppliers(prev => [newSupplier, ...prev]);
    if (useSupabase) {
      supabaseService.upsertSupplier(newSupplier).catch(err => console.error('Erro ao criar fornecedor no Supabase:', err));
    }
    return newSupplier;
  };

  const editSupplier = (updatedSupplier: Supplier) => {
    setSuppliers(prev => prev.map(s => s.id === updatedSupplier.id ? updatedSupplier : s));
    if (useSupabase) {
      supabaseService.upsertSupplier(updatedSupplier).catch(err => console.error('Erro ao editar fornecedor no Supabase:', err));
    }
  };

  const deleteSupplier = (id: string) => {
    setSuppliers(prev => prev.filter(s => s.id !== id));
    if (useSupabase) {
      supabaseService.deleteSupplier(id).catch(err => console.error('Erro ao deletar fornecedor no Supabase:', err));
    }
  };

  return {
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
    useSupabase,
    supabaseLoading,
    supabaseConnected,
    supabaseMissingTables,
    supabaseError,
    authProfileError,
    toggleUseSupabase,
    loadAllFromSupabase,
    exportLocalToSupabase,
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
    deleteSupplier
  };
}
