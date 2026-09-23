/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { 
  User, 
  UserRole, 
  Product, 
  StockInventory, 
  StockMovement, 
  CardCondition,
  Sale,
  StoreConfig,
  SerializedStockEntryUnit,
} from '../types';
import { 
  Package, 
  Search, 
  Plus, 
  Shuffle, 
  ShieldAlert, 
  CheckCircle, 
  Tag, 
  FileCheck, 
  Grid, 
  Info,
  Calendar,
  Layers,
  ArrowRight
} from 'lucide-react';

interface EstoqueViewProps {
  currentUser: User;
  products: Product[];
  inventory: StockInventory[];
  movements: StockMovement[];
  sales: Sale[];
  storeConfigs: StoreConfig[];
  addProduct: (
    product: Omit<Product, 'id'>,
    initialStoreId?: string,
    initialQty?: number,
    initialSerials?: string[]
  ) => Product;
  editProduct: (product: Product) => void;
  registerMovement: (
    productId: string,
    fromUnitId: string,
    toUnitId: string,
    type: 'TRANSFERENCIA' | 'ENTRADA' | 'PERDA',
    qty: number,
    serials?: string[],
    cardCondition?: CardCondition,
    reason?: string
  ) => void;
  registerSerializedStockEntry: (
    productId: string,
    unitId: string,
    units: SerializedStockEntryUnit[],
    reason: string
  ) => Promise<void>;
}

export default function EstoqueView({
  currentUser,
  products,
  inventory,
  movements,
  sales,
  storeConfigs,
  addProduct,
  editProduct,
  registerMovement,
  registerSerializedStockEntry
}: EstoqueViewProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const defaultStoreId = stores[0]?.unitId || '';

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('Todas');
  
  // UI Tabs inside Estoque
  const [activeSubTab, setActiveSubTab] = useState<'catalogo' | 'entrada' | 'transferencias' | 'garantias'>('catalogo');

  // Form states: New Product
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [newProdName, setNewProdName] = useState('');
  const [newProdSku, setNewProdSku] = useState('');
  const [newProdCategory, setNewProdCategory] = useState('Videogames');
  const [newProdBrand, setNewProdBrand] = useState('');
  const [newProdCost, setNewProdCost] = useState(0);
  const [newProdSell, setNewProdSell] = useState(0);
  const [newProdNcm, setNewProdNcm] = useState('');
  const [newProdWarranty, setNewProdWarranty] = useState(12);
  const [newProdSerialized, setNewProdSerialized] = useState(false);
  const [newProdStore, setNewProdStore] = useState('');
  const [newProdQty, setNewProdQty] = useState(0);

  // Form states: Stock Entry
  const [stockEntrySearch, setStockEntrySearch] = useState('');
  const [stockEntryProductId, setStockEntryProductId] = useState('');
  const [stockEntryQuantities, setStockEntryQuantities] = useState<Record<string, string>>({});
  const [serializedEntryUnitId, setSerializedEntryUnitId] = useState('');
  const [serializedEntryUnits, setSerializedEntryUnits] = useState<SerializedStockEntryUnit[]>([{ serialNumber: '', imei: '' }]);
  const [stockEntryReason, setStockEntryReason] = useState('Reposição de estoque');
  const [stockEntryError, setStockEntryError] = useState('');
  const [stockEntrySuccess, setStockEntrySuccess] = useState('');
  
  // Form states: Transfer
  const [transferProductId, setTransferProductId] = useState('');
  const [transferFrom, setTransferFrom] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferQty, setTransferQty] = useState(1);
  const [transferSerialInput, setTransferSerialInput] = useState('');
  const [transferCardCondition, setTransferCardCondition] = useState<CardCondition>('NEAR_MINT');
  const [transferReason, setTransferReason] = useState('');
  const [transferError, setTransferError] = useState('');
  const [transferSuccess, setTransferSuccess] = useState(false);

  // Warranty Query States
  const [warrantyQuerySerial, setWarrantyQuerySerial] = useState('');
  const [warrantyQueryResult, setWarrantyQueryResult] = useState<any | null>(null);

  const selectedStockEntryProduct = products.find(product => product.id === stockEntryProductId) || null;
  const stockEntryResults = products.filter(product => {
    const query = stockEntrySearch.trim().toLowerCase();
    if (!query) return true;
    return product.name.toLowerCase().includes(query) || product.sku.toLowerCase().includes(query);
  });

  const getProductInventory = (productId: string) => inventory.find(item => item.productId === productId);
  const getUnitStock = (productId: string, unitId: string) => getProductInventory(productId)?.quantities[unitId]?.qty || 0;
  const getUnitSerials = (productId: string, unitId: string) => getProductInventory(productId)?.quantities[unitId]?.serials || [];

  const generateEntrySerials = (productSku: string, unitId: string, currentSerialCount: number, quantity: number) => {
    const skuBase = productSku.trim().toUpperCase();
    const unitBase = unitId.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return Array.from({ length: quantity }, (_, index) => `${skuBase}-${unitBase}-${String(currentSerialCount + index + 1).padStart(3, '0')}`);
  };

  useEffect(() => {
    if (!stores.length) return;
    setNewProdStore(previous => stores.some(store => store.unitId === previous) ? previous : defaultStoreId);
    setTransferFrom(previous => stores.some(store => store.unitId === previous) ? previous : defaultStoreId);
    setTransferTo(previous => {
      if (stores.some(store => store.unitId === previous) && previous !== defaultStoreId) return previous;
      return stores[1]?.unitId || defaultStoreId;
    });
  }, [storeConfigs]);

  useEffect(() => {
    if (!stores.length) return;
    setStockEntryQuantities(previous => {
      const next: Record<string, string> = {};
      stores.forEach(store => {
        next[store.unitId] = previous[store.unitId] || '';
      });
      return next;
    });
  }, [storeConfigs]);

  useEffect(() => {
    if (!stockEntryProductId || !stores.length) return;
    setStockEntryQuantities(Object.fromEntries(stores.map(store => [store.unitId, ''])));
    setSerializedEntryUnitId(defaultStoreId);
    setSerializedEntryUnits([{ serialNumber: '', imei: '' }]);
    setStockEntryError('');
    setStockEntrySuccess('');
  }, [stockEntryProductId, storeConfigs]);

  // 1. Filtered Catalogs
  const filteredProducts = products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          p.sku.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = categoryFilter === 'Todas' || p.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  // Handle Add Product Submit
  const handleAddProductSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedSku = newProdSku.trim();
    const trimmedName = newProdName.trim();
    const trimmedBrand = newProdBrand.trim();
    const trimmedNcm = newProdNcm.trim();

    if (!trimmedName || !trimmedSku) return;

    addProduct({
      sku: trimmedSku,
      name: trimmedName,
      category: newProdCategory,
      brand: trimmedBrand,
      costPrice: newProdCost,
      sellPrice: newProdSell,
      ncm: trimmedNcm,
      warrantyMonths: newProdWarranty,
      isSerialized: newProdSerialized,
      isUsed: false
    });

    // Reset Form
    setNewProdName('');
    setNewProdSku('');
    setNewProdBrand('');
    setNewProdCost(0);
    setNewProdSell(0);
    setNewProdNcm('');
    setNewProdWarranty(12);
    setNewProdSerialized(false);
    setNewProdStore(defaultStoreId);
    setNewProdQty(0);
    setShowAddProductModal(false);
  };

  const handleStockEntrySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStockEntryError('');
    setStockEntrySuccess('');

    if (!selectedStockEntryProduct) {
      setStockEntryError('Selecione um produto cadastrado.');
      return;
    }

    const movementReason = stockEntryReason.trim() || 'Entrada de estoque multi-loja';

    if (selectedStockEntryProduct.isSerialized) {
      const units = serializedEntryUnits
        .map(unit => ({ serialNumber: unit.serialNumber.trim(), imei: unit.imei?.trim() || undefined }))
        .filter(unit => unit.serialNumber || unit.imei);
      const missingSerial = units.some(unit => !unit.serialNumber);
      const serials = units.map(unit => unit.serialNumber.toLocaleLowerCase());

      if (!serializedEntryUnitId || !stores.some(store => store.unitId === serializedEntryUnitId)) {
        setStockEntryError('Selecione a loja que receberá as unidades serializadas.');
        return;
      }
      if (units.length === 0 || missingSerial) {
        setStockEntryError('Informe ao menos um número de série. IMEI é opcional.');
        return;
      }
      if (new Set(serials).size !== serials.length) {
        setStockEntryError('Não repita números de série na mesma entrada.');
        return;
      }

      try {
        await registerSerializedStockEntry(selectedStockEntryProduct.id, serializedEntryUnitId, units, movementReason);
        setStockEntrySuccess(`${units.length} unidade(s) serializada(s) registrada(s) para ${selectedStockEntryProduct.name}.`);
        setSerializedEntryUnits([{ serialNumber: '', imei: '' }]);
        setStockEntryReason('Reposição de estoque');
      } catch (error) {
        setStockEntryError(error instanceof Error ? error.message : 'Não foi possível registrar a entrada serializada.');
      }
      return;
    }

    const requestedEntries = stores
      .map(store => ({
        unitId: store.unitId,
        qty: parseInt(stockEntryQuantities[store.unitId] || '0', 10) || 0
      }))
      .filter(entry => entry.qty > 0);

    if (requestedEntries.length === 0) {
      setStockEntryError('Informe pelo menos uma quantidade maior que zero.');
      return;
    }

    requestedEntries.forEach(entry => {
      registerMovement(
        selectedStockEntryProduct.id,
        'FORNECEDOR',
        entry.unitId,
        'ENTRADA',
        entry.qty,
        [],
        undefined,
        movementReason
      );
    });

    setStockEntrySuccess(`Entrada registrada para ${selectedStockEntryProduct.name} em ${requestedEntries.length} loja(s).`);
    setStockEntryQuantities(Object.fromEntries(stores.map(store => [store.unitId, '0'])));
    setStockEntryReason('Reposição de estoque');
  };

  // Handle Transfer Submit (Atomic operation)
  const handleTransferSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTransferError('');
    setTransferSuccess(false);

    if (!transferProductId) {
      setTransferError('Selecione um produto.');
      return;
    }

    if (transferFrom === transferTo) {
      setTransferError('A unidade de origem e destino não podem ser iguais.');
      return;
    }

    // Check inventory availability at transferFrom source
    const prodInv = inventory.find(i => i.productId === transferProductId);
    const sourceQty = prodInv?.quantities[transferFrom]?.qty || 0;

    if (sourceQty < transferQty) {
      setTransferError(`Estoque insuficiente na origem. Estoque atual: ${sourceQty} unidades.`);
      return;
    }

    const selectedProduct = products.find(p => p.id === transferProductId);
    let serialsToTransfer: string[] = [];

    // Parse serial numbers if serialized product
    if (selectedProduct?.isSerialized) {
      const inputSerials = transferSerialInput.split(',').map(s => s.trim()).filter(Boolean);
      if (inputSerials.length !== transferQty) {
        setTransferError(`Informe exatamente ${transferQty} número(s) de série separados por vírgula.`);
        return;
      }

      // Check if serials exist in source unit
      const availableSerials = prodInv?.quantities[transferFrom]?.serials || [];
      const missingSerials = inputSerials.filter(s => !availableSerials.includes(s));
      if (missingSerials.length > 0) {
        setTransferError(`Os seguintes números de série não estão disponíveis na origem: ${missingSerials.join(', ')}`);
        return;
      }
      serialsToTransfer = inputSerials;
    }

    // Execute transfer
    registerMovement(
      transferProductId,
      transferFrom,
      transferTo,
      'TRANSFERENCIA',
      transferQty,
      serialsToTransfer,
      selectedProduct?.category === 'Cards' ? transferCardCondition : undefined,
      transferReason || 'Transferência entre unidades'
    );

    setTransferSuccess(true);
    setTransferQty(1);
    setTransferSerialInput('');
    setTransferReason('');
  };

  // Warranty Query execution
  const executeWarrantyQuery = (e: React.FormEvent) => {
    e.preventDefault();
    setWarrantyQueryResult(null);

    if (!warrantyQuerySerial) return;

    // Search active inventory first
    let foundInInventory: any = null;
    inventory.forEach(inv => {
      const prod = products.find(p => p.id === inv.productId);
      Object.entries(inv.quantities).forEach(([unitId, data]) => {
        if (data.serials?.includes(warrantyQuerySerial)) {
          foundInInventory = {
            product: prod,
            location: stores.find(store => store.unitId === unitId)?.tradeName || unitId,
            status: 'Em Estoque',
            warrantyTerm: `${prod?.warrantyMonths} meses (Ativa na venda)`
          };
        }
      });
    });

    if (foundInInventory) {
      setWarrantyQueryResult(foundInInventory);
      return;
    }

    // Search sales records
    let foundInSales: any = null;
    sales.forEach(s => {
      s.items.forEach(item => {
        if (item.serials?.includes(warrantyQuerySerial)) {
          const prod = products.find(p => p.id === item.productId);
          
          // Calculate warranty expiration
          const saleDate = new Date(s.timestamp);
          const expDate = new Date(saleDate);
          expDate.setMonth(saleDate.getMonth() + (prod?.warrantyMonths || 0));
          const daysLeft = Math.ceil((expDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
          const isExpired = daysLeft < 0;

          foundInSales = {
            product: prod,
            invoice: s.invoiceNumber,
            saleDate: saleDate.toLocaleDateString('pt-BR'),
            client: s.clientName || 'Consumidor Final',
            clientCpf: s.clientCpf || 'Não Informado',
            store: stores.find(store => store.unitId === s.unitId)?.tradeName || s.unitId,
            status: isExpired ? 'Garantia Expirada' : 'Garantia Ativa',
            expDate: expDate.toLocaleDateString('pt-BR'),
            daysLeft: isExpired ? 0 : daysLeft
          };
        }
      });
    });

    if (foundInSales) {
      setWarrantyQueryResult(foundInSales);
    } else {
      setWarrantyQueryResult({ status: 'Não Encontrado' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Sub-Header Tabs */}
      <div className="flex justify-between items-center bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex-wrap gap-4">
        <div className="flex space-x-2">
          <button
            id="tab-estoque-cadastro"
            onClick={() => setActiveSubTab('catalogo')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeSubTab === 'catalogo'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Package className="w-4 h-4 mr-1.5" />
            Cadastro de Produto
          </button>
          <button
            id="tab-estoque-entrada"
            onClick={() => setActiveSubTab('entrada')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeSubTab === 'entrada'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Layers className="w-4 h-4 mr-1.5" />
            Entrada de Estoque
          </button>
        </div>

        {activeSubTab === 'catalogo' && (
          <button
            id="btn-add-product"
            onClick={() => setShowAddProductModal(true)}
            className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg transition flex items-center shadow-xs"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Novo Produto
          </button>
        )}
      </div>

      {/* 1. VIEW: Catalogo & Niveis */}
      {activeSubTab === 'catalogo' && (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col md:flex-row gap-4 justify-between">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="search-product"
                type="text"
                placeholder="Pesquisar por nome ou SKU..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-50 text-slate-800 text-xs rounded-lg pl-9 pr-4 py-2.5 border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500 font-semibold"
              />
            </div>
            <div className="flex gap-2">
              {['Todas', 'Videogames', 'Peças', 'Cards', 'Computadores'].map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-3 py-1.5 text-xs rounded-lg font-semibold transition border ${
                    categoryFilter === cat
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Grid Catalog Display */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {filteredProducts.map(p => {
              const prodInv = inventory.find(i => i.productId === p.id);
              
              // Sum stock quantity based on active view unit
              const activeUnitId = currentUser.unitId;
              const totalStock = activeUnitId === 'central'
                ? Object.entries(prodInv?.quantities || {})
                    .filter(([uid]) => uid !== 'central')
                    .reduce((acc, [_, q]) => acc + q.qty, 0)
                : prodInv?.quantities[activeUnitId]?.qty || 0;

              return (
                <div key={p.id} className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden flex flex-col justify-between">
                  <div className="p-5 space-y-4">
                    {/* Catalog Details */}
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="text-[10px] bg-slate-100 text-slate-600 font-bold px-2 py-0.5 rounded uppercase font-mono">
                          {p.category}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase font-mono ml-1.5 ${
                          totalStock === 0 
                            ? 'bg-rose-50 text-rose-700 border border-rose-100/50' 
                            : totalStock <= 2 
                              ? 'bg-amber-50 text-amber-700 border border-amber-100/50'
                              : 'bg-emerald-50 text-emerald-700 border border-emerald-100/50'
                        }`}>
                          Estoque: {totalStock} un
                        </span>
                        <h3 className="text-sm font-bold text-slate-900 mt-1 font-sans">{p.name}</h3>
                        <p className="text-xs text-slate-400 font-mono mt-0.5">SKU: {p.sku}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-slate-400 font-mono block">Preço de Venda</span>
                        <span className="text-base font-black text-slate-900 font-mono">
                          R$ {p.sellPrice.toLocaleString('pt-BR')}
                        </span>
                        {isAdmin && (
                          <span className="text-[10px] text-emerald-600 font-medium block mt-0.5">
                            Custo: R$ {p.costPrice.toLocaleString('pt-BR')}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Stock levels by physical units */}
                    <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-100/80 space-y-2">
                      <h4 className="text-[10px] text-slate-400 font-bold uppercase tracking-wider font-sans mb-1">
                        Estoque por Unidade
                      </h4>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {stores.map(store => {
                          const unit = { id: store.unitId, name: store.tradeName || store.unitId };
                          const unitQty = prodInv?.quantities[unit.id]?.qty || 0;
                          const serials = prodInv?.quantities[unit.id]?.serials || [];

                          return (
                            <div key={unit.id} className="flex justify-between items-center p-1 bg-white rounded border border-slate-200/50">
                              <span className="text-slate-600 truncate max-w-[100px] font-medium text-[11px]">
                                {unit.name.split(' - ')[0]}
                              </span>
                              <div className="flex items-center space-x-1">
                                <span className={`font-mono font-bold text-[11px] ${
                                  unitQty === 0 
                                    ? 'text-rose-500' 
                                    : unitQty <= 2 
                                      ? 'text-amber-500' 
                                      : 'text-slate-900'
                                }`}>
                                  {unitQty} un
                                </span>
                                {unitQty <= 2 && (
                                  <span className={`w-1.5 h-1.5 rounded-full ${unitQty === 0 ? 'bg-rose-500' : 'bg-amber-500'}`} />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Serialization or Conditions metadata */}
                    <div className="flex justify-between items-center text-[11px] text-slate-500 font-sans border-t border-slate-100 pt-3">
                      <div className="flex items-center space-x-1">
                        {p.isSerialized ? (
                          <span className="bg-blue-50 text-blue-700 font-bold px-1.5 py-0.5 rounded text-[10px]">
                            Serializado
                          </span>
                        ) : (
                          <span className="bg-slate-50 text-slate-500 px-1.5 py-0.5 rounded text-[10px]">
                            Lote Comum
                          </span>
                        )}
                        {p.isUsed && (
                          <span className="bg-amber-50 text-amber-700 font-bold px-1.5 py-0.5 rounded text-[10px]">
                            Usado
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-slate-400">Garantia: {p.warrantyMonths}m</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 1. VIEW: Entrada de Estoque */}
      {activeSubTab === 'entrada' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 font-sans">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-5 space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Entrada de Estoque</h3>
              <p className="text-xs text-slate-400">Localize um produto já cadastrado e distribua a entrada entre várias lojas na mesma operação.</p>
            </div>

            {stockEntryError && (
              <div className="p-3 bg-rose-50 border border-rose-100 text-rose-700 rounded-lg text-[11px] font-medium">
                {stockEntryError}
              </div>
            )}

            {stockEntrySuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-[11px] font-medium">
                {stockEntrySuccess}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="font-medium text-slate-700 text-xs">Buscar produto por SKU ou nome</label>
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={stockEntrySearch}
                  onChange={(e) => setStockEntrySearch(e.target.value)}
                  placeholder="Digite o SKU ou nome do produto"
                  className="w-full bg-slate-50 text-slate-800 text-xs rounded-lg pl-9 pr-4 py-2.5 border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500 font-semibold"
                />
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
              {stockEntryResults.slice(0, 12).map(product => {
                const productStock = stores.reduce((sum, store) => sum + getUnitStock(product.id, store.unitId), 0);
                const isSelected = product.id === stockEntryProductId;
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => setStockEntryProductId(product.id)}
                    className={`w-full text-left p-3 rounded-xl border transition ${
                      isSelected
                        ? 'bg-blue-50 border-blue-200 shadow-xs'
                        : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-slate-900">{product.name}</p>
                        <p className="text-[11px] text-slate-500 font-mono">SKU: {product.sku}</p>
                      </div>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-500">
                        {productStock} un
                      </span>
                    </div>
                  </button>
                );
              })}

              {stockEntryResults.length === 0 && (
                <div className="p-4 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                  Nenhum produto encontrado.
                </div>
              )}
            </div>

            {selectedStockEntryProduct && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Produto selecionado</p>
                    <h4 className="text-sm font-bold text-slate-900">{selectedStockEntryProduct.name}</h4>
                    <p className="text-[11px] text-slate-500 font-mono">SKU: {selectedStockEntryProduct.sku}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setStockEntryProductId('')}
                    className="text-[10px] font-bold uppercase px-2 py-1 rounded-lg bg-white border border-slate-200 text-slate-600"
                  >
                    Limpar
                  </button>
                </div>
                <p className="text-[11px] text-slate-600">
                  Estoque total atual: <span className="font-bold">{stores.reduce((sum, store) => sum + getUnitStock(selectedStockEntryProduct.id, store.unitId), 0)} un</span>
                </p>
                <p className="text-[11px] text-slate-600">
                  Tipo: {selectedStockEntryProduct.isSerialized ? 'Serializado' : 'Lote comum'}
                </p>
              </div>
            )}
          </div>

          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-7 space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                {selectedStockEntryProduct?.isSerialized ? 'Unidades Serializadas' : 'Distribuição por Loja'}
              </h3>
              <p className="text-xs text-slate-400">
                {selectedStockEntryProduct?.isSerialized
                  ? 'Informe cada unidade física. O saldo da loja será calculado automaticamente a partir dos seriais disponíveis.'
                  : 'Informe quanto entra em cada unidade. O saldo será somado ao estoque já existente.'}
              </p>
            </div>

            {!selectedStockEntryProduct ? (
              <div className="min-h-[260px] flex items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-400">
                Selecione um produto para liberar a entrada de estoque.
              </div>
            ) : (
              <form onSubmit={handleStockEntrySubmit} className="space-y-4 text-xs">
                {selectedStockEntryProduct.isSerialized ? (
                  <div className="space-y-4">
                    <div className="space-y-1.5 max-w-md">
                      <label className="font-medium text-slate-700">Loja de destino</label>
                      <select
                        value={serializedEntryUnitId}
                        onChange={(e) => setSerializedEntryUnitId(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                      >
                        {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
                      </select>
                    </div>

                    <div className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_36px] gap-2 px-1 text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                        <span>Número de série</span>
                        <span>IMEI opcional</span>
                        <span />
                      </div>
                      {serializedEntryUnits.map((unit, index) => (
                        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_36px] gap-2">
                          <input
                            type="text"
                            value={unit.serialNumber}
                            onChange={(e) => setSerializedEntryUnits(previous => previous.map((current, currentIndex) => currentIndex === index ? { ...current, serialNumber: e.target.value } : current))}
                            placeholder="Ex: NB-X-0001"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                          />
                          <input
                            type="text"
                            value={unit.imei || ''}
                            onChange={(e) => setSerializedEntryUnits(previous => previous.map((current, currentIndex) => currentIndex === index ? { ...current, imei: e.target.value } : current))}
                            placeholder="Opcional"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => setSerializedEntryUnits(previous => previous.length === 1 ? previous : previous.filter((_, currentIndex) => currentIndex !== index))}
                            aria-label="Remover unidade"
                            title="Remover unidade"
                            disabled={serializedEntryUnits.length === 1}
                            className="border border-slate-200 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => setSerializedEntryUnits(previous => [...previous, { serialNumber: '', imei: '' }])}
                      className="px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition font-semibold"
                    >
                      Adicionar unidade
                    </button>
                  </div>
                ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-separate border-spacing-y-2">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                        <th className="px-3 py-1">Loja</th>
                        <th className="px-3 py-1 text-center">Estoque Atual</th>
                        <th className="px-3 py-1 text-center">Adicionar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stores.map(store => {
                        const currentQty = getUnitStock(selectedStockEntryProduct.id, store.unitId);
                        return (
                          <tr key={store.unitId} className="bg-slate-50/80">
                            <td className="px-3 py-3 rounded-l-xl border border-slate-200 border-r-0">
                              <div>
                                <p className="font-semibold text-slate-800">{store.tradeName || store.unitId}</p>
                                <p className="text-[10px] text-slate-400 font-mono">{store.unitId}</p>
                              </div>
                            </td>
                            <td className="px-3 py-3 border-y border-slate-200 text-center font-mono font-bold text-slate-700">
                              {currentQty}
                            </td>
                            <td className="px-3 py-3 rounded-r-xl border border-slate-200 border-l-0">
                              <input
                                type="number"
                                min="0"
                                value={stockEntryQuantities[store.unitId] ?? ''}
                                onChange={(e) => setStockEntryQuantities(previous => ({
                                  ...previous,
                                  [store.unitId]: e.target.value
                                }))}
                                className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none text-center font-mono"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="font-medium text-slate-700">Motivo da entrada</label>
                    <input
                      type="text"
                      value={stockEntryReason}
                      onChange={(e) => setStockEntryReason(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                      placeholder="Ex: reposição, recebimento de fornecedor"
                    />
                  </div>
                  <div className="space-y-1.5 bg-slate-50 border border-slate-200 rounded-xl p-3">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Resumo</p>
                    <p className="text-sm font-semibold text-slate-900">
                      Total a lançar: {selectedStockEntryProduct.isSerialized
                        ? serializedEntryUnits.filter(unit => unit.serialNumber.trim()).length
                        : stores.reduce((sum, store) => sum + (parseInt(stockEntryQuantities[store.unitId] || '0', 10) || 0), 0)} un
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {selectedStockEntryProduct.isSerialized
                        ? 'Cada linha representa uma unidade física. Números de série não são gerados automaticamente.'
                        : 'O saldo será somado diretamente ao estoque da unidade.'}
                    </p>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => selectedStockEntryProduct.isSerialized
                      ? setSerializedEntryUnits([{ serialNumber: '', imei: '' }])
                      : setStockEntryQuantities(Object.fromEntries(stores.map(store => [store.unitId, '0'])))}
                    className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition"
                  >
                    Zerar
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg transition"
                  >
                    Confirmar Entrada
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* 2. VIEW: Transferencias */}
      {activeSubTab === 'transferencias' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-sans">
          {/* Form Card */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-1 space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Nova Transferência</h3>
              <p className="text-xs text-slate-400">Movimente itens de forma atômica e auditável entre as lojas.</p>
            </div>

            <form onSubmit={handleTransferSubmit} className="space-y-4 text-xs">
              {/* Product Select */}
              <div className="space-y-1.5">
                <label className="font-medium text-slate-700">Selecione o Produto</label>
                <select
                  value={transferProductId}
                  onChange={(e) => {
                    setTransferProductId(e.target.value);
                    setTransferError('');
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-amber-500 text-slate-800"
                >
                  <option value="">-- Selecione o Produto --</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} (SKU: {p.sku})
                    </option>
                  ))}
                </select>
              </div>

              {/* Source Warehouse */}
              <div className="space-y-1.5">
                <label className="font-medium text-slate-700">Origem (Sairá de)</label>
                <select
                  value={transferFrom}
                  onChange={(e) => setTransferFrom(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                >
                  {stores.map(store => (
                    <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>
                  ))}
                </select>
              </div>

              {/* Target Warehouse */}
              <div className="space-y-1.5">
                <label className="font-medium text-slate-700">Destino (Entrará em)</label>
                <select
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                >
                  {stores.map(store => (
                    <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>
                  ))}
                </select>
              </div>

              {/* Quantity */}
              <div className="space-y-1.5">
                <label className="font-medium text-slate-700">Quantidade</label>
                <input
                  type="number"
                  min="1"
                  value={transferQty}
                  onChange={(e) => setTransferQty(parseInt(e.target.value) || 1)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                />
              </div>

              {/* Serial inputs if product is serialized */}
              {products.find(p => p.id === transferProductId)?.isSerialized && (
                <div className="space-y-1.5">
                  <label className="font-medium text-slate-700 flex items-center justify-between">
                    <span>Número(s) de Série</span>
                    <span className="text-[10px] text-slate-400">Separados por vírgula</span>
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: PS5-CEN-01, PS5-CEN-02"
                    value={transferSerialInput}
                    onChange={(e) => setTransferSerialInput(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                  />
                  {/* Display available serials in the source warehouse */}
                  <div className="bg-amber-50 border border-amber-100 p-2 rounded text-[10px] text-amber-800">
                    <span className="font-semibold block mb-0.5">Disponíveis na origem:</span>
                    <span className="font-mono">
                      {inventory.find(i => i.productId === transferProductId)?.quantities[transferFrom]?.serials?.join(', ') || 'Nenhum serial disponível'}
                    </span>
                  </div>
                </div>
              )}

              {/* Card Condition for Cards category */}
              {products.find(p => p.id === transferProductId)?.category === 'Cards' && (
                <div className="space-y-1.5">
                  <label className="font-medium text-slate-700">Condição do Card (Pokémon)</label>
                  <select
                    value={transferCardCondition}
                    onChange={(e) => setTransferCardCondition(e.target.value as CardCondition)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                  >
                    <option value="PSA_10">PSA 10 (Gem Mint)</option>
                    <option value="NEAR_MINT">Near Mint (NM)</option>
                    <option value="LIGHTLY_PLAYED">Lightly Played (LP)</option>
                    <option value="MODERATELY_PLAYED">Moderately Played (MP)</option>
                    <option value="DAMAGED">Damaged (DMG)</option>
                  </select>
                </div>
              )}

              {/* Transfer Reason */}
              <div className="space-y-1.5">
                <label className="font-medium text-slate-700">Motivo</label>
                <input
                  type="text"
                  placeholder="Ex: Reposição de estoque vitrine"
                  value={transferReason}
                  onChange={(e) => setTransferReason(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                />
              </div>

              {/* Errors & Alerts */}
              {transferError && (
                <div className="p-3 bg-rose-50 border border-rose-100 text-rose-700 rounded-lg flex items-center space-x-2 text-[11px]">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>{transferError}</span>
                </div>
              )}

              {transferSuccess && (
                <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg flex items-center space-x-2 text-[11px]">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span>Transferência realizada com sucesso e log de auditoria salvo!</span>
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition font-bold"
              >
                Efetivar Movimentação
              </button>
            </form>
          </div>

          {/* Transfers Audit Log Table */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm lg:col-span-2 flex flex-col justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-2">Logs de Auditoria de Transferências</h3>
              <p className="text-xs text-slate-400 mb-4">Acompanhe quem movimentou itens pela rede de lojas físicas.</p>
              
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left text-slate-500">
                  <thead className="text-[10px] text-slate-400 uppercase bg-slate-50 font-bold">
                    <tr>
                      <th className="px-3 py-2">Data/Hora</th>
                      <th className="px-3 py-2">Operador</th>
                      <th className="px-3 py-2">Produto</th>
                      <th className="px-3 py-2 text-center">De ➔ Para</th>
                      <th className="px-3 py-2 text-center">Quant.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {movements
                      .filter(m => m.type === 'TRANSFERENCIA')
                      .slice(0, 10)
                      .map(m => {
                        const prod = products.find(p => p.id === m.productId);
                        return (
                          <tr key={m.id} className="hover:bg-slate-50/80">
                            <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400">
                              {new Date(m.timestamp).toLocaleString('pt-BR')}
                            </td>
                            <td className="px-3 py-2.5 font-medium text-slate-700">
                              {m.operatorName.split(' ')[0]}
                            </td>
                            <td className="px-3 py-2.5 text-slate-900 font-medium">
                              <span className="block truncate max-w-[150px]">{prod?.name || 'Produto Removido'}</span>
                              {m.serials && m.serials.length > 0 && (
                                <span className="block text-[9px] text-slate-400 font-mono">S/N: {m.serials.join(', ')}</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span className="inline-flex items-center space-x-1 font-mono text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-600 font-bold">
                                <span>{m.fromUnitId === 'central' ? 'CEN' : m.fromUnitId.replace('loja_', 'L')}</span>
                                <ArrowRight className="w-2.5 h-2.5" />
                                <span>{m.toUnitId === 'central' ? 'CEN' : m.toUnitId.replace('loja_', 'L')}</span>
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-center font-bold text-slate-950 font-mono">
                              {m.quantity}
                            </td>
                          </tr>
                        );
                      })}
                    {movements.filter(m => m.type === 'TRANSFERENCIA').length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center text-slate-400 py-10">Nenhuma transferência recente registrada.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. VIEW: Consulta Garantia */}
      {activeSubTab === 'garantias' && (
        <div className="max-w-2xl mx-auto bg-white p-6 rounded-xl border border-slate-200 shadow-sm font-sans space-y-6">
          <div className="text-center space-y-1">
            <h3 className="text-lg font-bold text-slate-950">Consulta Rápida de Garantia e Série</h3>
            <p className="text-xs text-slate-400">Localize consoles, placas e peças de hardware pelo número de série único ou CPF do cliente.</p>
          </div>

          <form onSubmit={executeWarrantyQuery} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="query-serial-number"
                type="text"
                placeholder="Insira o número de série (Ex: PS5-L1-01, RTX-L1-01)..."
                value={warrantyQuerySerial}
                onChange={(e) => setWarrantyQuerySerial(e.target.value)}
                className="w-full bg-slate-50 text-slate-800 text-xs rounded-lg pl-9 pr-4 py-2.5 border border-slate-200 outline-none focus:ring-1 focus:ring-amber-500 font-mono"
              />
            </div>
            <button
              type="submit"
              className="px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition"
            >
              Consultar
            </button>
          </form>

          {/* Results Block */}
          {warrantyQueryResult && (
            <div className="border border-slate-150 rounded-xl overflow-hidden text-xs">
              {warrantyQueryResult.status === 'Não Encontrado' ? (
                <div className="p-6 bg-rose-50/50 text-center text-rose-700 font-medium space-y-2">
                  <ShieldAlert className="w-8 h-8 text-rose-500 mx-auto" />
                  <p>Número de série não cadastrado no sistema ou vendido sem vínculo.</p>
                </div>
              ) : (
                <div>
                  <div className={`p-4 text-white flex justify-between items-center ${
                    warrantyQueryResult.status === 'Em Estoque' || warrantyQueryResult.status === 'Garantia Ativa'
                      ? 'bg-emerald-600'
                      : 'bg-rose-600'
                  }`}>
                    <div>
                      <h4 className="font-bold text-sm">{warrantyQueryResult.product?.name}</h4>
                      <p className="opacity-80 text-[10px] font-mono">SKU: {warrantyQueryResult.product?.sku} | S/N: {warrantyQuerySerial}</p>
                    </div>
                    <span className="font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-white/20 text-[10px]">
                      {warrantyQueryResult.status}
                    </span>
                  </div>

                  <div className="p-4 space-y-3 font-sans bg-slate-50">
                    {warrantyQueryResult.status === 'Em Estoque' ? (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Localização Ativa</span>
                          <span className="font-medium text-slate-800">{warrantyQueryResult.location}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Garantia Futura</span>
                          <span className="font-medium text-slate-800">{warrantyQueryResult.warrantyTerm}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Cliente Comprador</span>
                          <span className="font-semibold text-slate-800">{warrantyQueryResult.client}</span>
                          <span className="block text-[10px] font-mono text-slate-400">CPF: {warrantyQueryResult.clientCpf}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Loja Física Vendedora</span>
                          <span className="font-medium text-slate-800">{warrantyQueryResult.store}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Data da Compra</span>
                          <span className="font-medium text-slate-800 flex items-center">
                            <Calendar className="w-3.5 h-3.5 mr-1 text-slate-400" />
                            {warrantyQueryResult.saleDate}
                          </span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Data de Expiração</span>
                          <span className="font-semibold text-slate-800 flex items-center">
                            <Calendar className="w-3.5 h-3.5 mr-1 text-slate-400" />
                            {warrantyQueryResult.expDate}
                          </span>
                          {warrantyQueryResult.status === 'Garantia Ativa' ? (
                            <span className="text-emerald-600 font-bold font-mono text-[10px] block mt-0.5">
                              {warrantyQueryResult.daysLeft} dias restantes
                            </span>
                          ) : (
                            <span className="text-rose-600 font-bold block text-[10px] mt-0.5">Expirada</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add Product Modal (Simple custom overlay) */}
      {showAddProductModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full overflow-hidden flex flex-col">
            <div className="bg-slate-900 text-white p-4 flex justify-between items-center">
              <h3 className="font-bold text-sm uppercase tracking-wider flex items-center">
                <Layers className="w-4.5 h-4.5 mr-2 text-amber-500" />
                Cadastrar Novo Produto no Catálogo
              </h3>
              <button
                id="btn-close-product-modal"
                onClick={() => setShowAddProductModal(false)}
                className="text-slate-400 hover:text-white font-bold text-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddProductSubmit} className="p-5 space-y-4 text-xs font-sans">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">SKU do Produto</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: GPU-ASUS-4070"
                    value={newProdSku}
                    onChange={(e) => setNewProdSku(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Categoria</label>
                  <select
                    value={newProdCategory}
                    onChange={(e) => setNewProdCategory(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                  >
                    <option value="Videogames">Videogames</option>
                    <option value="Peças">Peças de PC</option>
                    <option value="Cards">Cards Colecionáveis</option>
                    <option value="Computadores">Computadores Prontos</option>
                    <option value="Outros">Outros</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-bold text-slate-700">Nome Comercial</label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Teclado Mecânico Corsair K70"
                  value={newProdName}
                  onChange={(e) => setNewProdName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Marca / Fabricante</label>
                  <input
                    type="text"
                    placeholder="Ex: Corsair"
                    value={newProdBrand}
                    onChange={(e) => setNewProdBrand(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">NCM (Fins Fiscais)</label>
                  <input
                    type="text"
                    placeholder="Ex: 8471.60.52"
                    value={newProdNcm}
                    onChange={(e) => setNewProdNcm(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Preço Custo (R$)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={newProdCost || ''}
                    onChange={(e) => setNewProdCost(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Preço Venda (R$)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={newProdSell || ''}
                    onChange={(e) => setNewProdSell(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                  />
                </div>
              </div>

              <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 mt-2 text-[11px] text-slate-500">
                O estoque será lançado depois, na sub-aba de Entrada de Estoque.
              </div>

              <div className="flex items-center space-x-2 bg-slate-50 p-3 rounded-lg border border-slate-100 mt-2">
                <input
                  id="product-is-serialized"
                  type="checkbox"
                  checked={newProdSerialized}
                  onChange={(e) => setNewProdSerialized(e.target.checked)}
                  className="w-4 h-4 text-amber-500 focus:ring-amber-500"
                />
                <div>
                  <label htmlFor="product-is-serialized" className="font-bold text-slate-800 cursor-pointer">
                    Ativar rastreamento por Número de Série (Serialização)
                  </label>
                  <p className="text-[10px] text-slate-400">Marque se cada unidade tiver código de barras próprio (consoles, GPUs, notebooks).</p>
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAddProductModal(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg transition"
                >
                  Confirmar Cadastro
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
