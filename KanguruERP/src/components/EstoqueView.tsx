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
  ProductStoreCost,
  StockEntryLine,
} from '../types';
import { formatMoney } from '../db/finance';
import { supabaseService } from '../db/supabaseService';
import { sanitizeItemCode } from '../db/itemCode';
import { CSOSNS, ICMS_CSTS, ICMS_ORIGINS, productFiscalError } from '../db/fiscal';
import ValueInput from './ValueInput';
import BalancoPanel from './BalancoPanel';

// Estoque minimo padrao quando o produto nao tem um definido (mesmo valor do Dashboard).
const DEFAULT_MIN_STOCK = 2;

// Converte o texto digitado em valor monetario; null se invalido ou com mais de 2 casas.
const parseMoneyInput = (value: string): number | null => {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (Math.round(parsed * 100) / 100 !== parsed) return null;
  return parsed;
};

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return fallback;
};
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
  ArrowRight,
  Pencil,
  ClipboardCheck
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
  ) => Promise<Product>;
  editProduct: (product: Product) => Promise<void>;
  saveProduct: (product: Product) => Promise<void>;
  registerSerializedStockEntry: (
    productId: string,
    unitId: string,
    units: SerializedStockEntryUnit[],
    reason: string
  ) => Promise<void>;
  registerTransfer: (
    productId: string,
    fromUnitId: string,
    toUnitId: string,
    qty: number,
    serials: string[],
    cardCondition: CardCondition | undefined,
    reason: string
  ) => Promise<void>;
  registerStockEntry: (
    productId: string,
    entries: StockEntryLine[],
    unitCost: number,
    reason: string
  ) => Promise<void>;
  productStoreCosts: ProductStoreCost[];
  onStockChanged: () => Promise<void>;
}

type SerializedEntryDraft = { serialNumber: string; imei: string; unitCost: string };
const emptySerializedDraft = (): SerializedEntryDraft => ({ serialNumber: '', imei: '', unitCost: '' });

export default function EstoqueView({
  currentUser,
  products,
  inventory,
  movements,
  sales,
  storeConfigs,
  addProduct,
  editProduct,
  saveProduct,
  registerSerializedStockEntry,
  registerTransfer,
  registerStockEntry,
  productStoreCosts,
  onStockChanged
}: EstoqueViewProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const defaultStoreId = stores[0]?.unitId || '';
  // Os efeitos abaixo dependem da LISTA de lojas, nao do array: cada recarga de dados
  // cria um array novo e, antes, isso apagava os formularios em preenchimento.
  const storeIdsKey = stores.map(store => store.unitId).join('|');

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('Todas');
  
  // UI Tabs inside Estoque
  const [activeSubTab, setActiveSubTab] = useState<'catalogo' | 'entrada' | 'transferencias' | 'avariados' | 'balanco'>('catalogo');
  // Avariados (2.9): produtos devolvidos com defeito, fora da venda.
  const [damaged, setDamaged] = useState<{ unitId: string; productId: string; quantity: number; serials: string[] }[] | null>(null);
  const [damagedError, setDamagedError] = useState('');
  useEffect(() => {
    if (activeSubTab !== 'avariados') return;
    setDamagedError('');
    supabaseService.getDamagedStock().then(setDamaged).catch(() => { setDamaged([]); setDamagedError('Não foi possível carregar os avariados.'); });
  }, [activeSubTab]);

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
  const [newProdMinStock, setNewProdMinStock] = useState('');
  const [newProdMaxDiscount, setNewProdMaxDiscount] = useState<number | null>(null);
  // Edicao de produto existente (mesmo formulario do cadastro) e dados fiscais (2.8a).
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [newProdCest, setNewProdCest] = useState('');
  const [newProdOrigin, setNewProdOrigin] = useState('');
  const [newProdCst, setNewProdCst] = useState('');
  const [newProdCsosn, setNewProdCsosn] = useState('');
  const [newProdIcmsRate, setNewProdIcmsRate] = useState<number | null>(null);
  const [newProdIcmsReduction, setNewProdIcmsReduction] = useState<number | null>(null);
  const [newProdTaxBurden, setNewProdTaxBurden] = useState<number | null>(null);
  const [maxDiscountDrafts, setMaxDiscountDrafts] = useState<Record<string, number | null>>({});
  const [newProdError, setNewProdError] = useState('');
  const [newProdSaving, setNewProdSaving] = useState(false);
  const [nextItemCode, setNextItemCode] = useState('');

  // Form states: Stock Entry
  const [stockEntrySearch, setStockEntrySearch] = useState('');
  const [stockEntryProductId, setStockEntryProductId] = useState('');
  const [stockEntryQuantities, setStockEntryQuantities] = useState<Record<string, string>>({});
  const [serializedEntryUnitId, setSerializedEntryUnitId] = useState('');
  const [serializedEntryUnits, setSerializedEntryUnits] = useState<SerializedEntryDraft[]>([emptySerializedDraft()]);
  const [serializedApplyAllCost, setSerializedApplyAllCost] = useState('');
  const [stockEntryUnitCost, setStockEntryUnitCost] = useState('');
  const [stockEntrySubmitting, setStockEntrySubmitting] = useState(false);
  const [minStockDrafts, setMinStockDrafts] = useState<Record<string, string>>({});
  const [stockEntryReason, setStockEntryReason] = useState('Reposição de estoque');
  const [stockEntryError, setStockEntryError] = useState('');
  const [stockEntrySuccess, setStockEntrySuccess] = useState('');
  
  // Form states: Transfer
  const [transferProductId, setTransferProductId] = useState('');
  const [transferSearch, setTransferSearch] = useState('');
  const [transferFrom, setTransferFrom] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferQty, setTransferQty] = useState(1);
  const [transferSerialInput, setTransferSerialInput] = useState('');
  const [transferCardCondition, setTransferCardCondition] = useState<CardCondition>('NEAR_MINT');
  const [transferReason, setTransferReason] = useState('');
  const [transferError, setTransferError] = useState('');
  const [transferSuccess, setTransferSuccess] = useState(false);
  const [transferSaving, setTransferSaving] = useState(false);



  const selectedStockEntryProduct = products.find(product => product.id === stockEntryProductId) || null;
  const stockEntryResults = products.filter(product => {
    const query = stockEntrySearch.trim().toLowerCase();
    if (!query) return true;
    return product.name.toLowerCase().includes(query) || product.sku.toLowerCase().includes(query);
  });

  const getProductInventory = (productId: string) => inventory.find(item => item.productId === productId);
  const getUnitStock = (productId: string, unitId: string) => getProductInventory(productId)?.quantities[unitId]?.qty || 0;
  const getUnitSerials = (productId: string, unitId: string) => getProductInventory(productId)?.quantities[unitId]?.serials || [];
  // Custo medio da loja; sem registro, o custo padrao do cadastro.
  const getStoreCost = (product: Product, unitId: string) =>
    productStoreCosts.find(cost => cost.productId === product.id && cost.unitId === unitId)?.avgCost ?? product.costPrice;

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
  }, [storeIdsKey]);

  useEffect(() => {
    if (!stores.length) return;
    setStockEntryQuantities(previous => {
      const next: Record<string, string> = {};
      stores.forEach(store => {
        next[store.unitId] = previous[store.unitId] || '';
      });
      return next;
    });
  }, [storeIdsKey]);

  useEffect(() => {
    if (!stockEntryProductId || !stores.length) return;
    setStockEntryQuantities(Object.fromEntries(stores.map(store => [store.unitId, ''])));
    setSerializedEntryUnitId(defaultStoreId);
    setSerializedEntryUnits([emptySerializedDraft()]);
    setSerializedApplyAllCost('');
    setStockEntryUnitCost('');
    setStockEntryError('');
    setStockEntrySuccess('');
  }, [stockEntryProductId, storeIdsKey]);

  // 1. Filtered Catalogs
  const filteredProducts = products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          p.sku.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = categoryFilter === 'Todas' || p.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  // Ao abrir o cadastro, mostra qual sera o proximo codigo automatico.
  useEffect(() => {
    if (!showAddProductModal) return;
    setNewProdError('');
    let active = true;
    supabaseService.getNextItemCode()
      .then(code => { if (active) setNextItemCode(code); })
      .catch(() => { if (active) setNextItemCode(''); });
    return () => { active = false; };
  }, [showAddProductModal]);

  // Transferencia: busca por codigo ou nome (como no PDV). Enter com codigo exato, resultado unico
  // ou serial bipado seleciona o produto; o serial ja escolhe a loja de origem e entra na lista.
  const transferResults = (() => {
    const query = transferSearch.trim().toLowerCase();
    if (!query) return [];
    return products.filter(product => product.name.toLowerCase().includes(query) || product.sku.toLowerCase().includes(query));
  })();
  const selectTransferProduct = (productId: string) => {
    setTransferProductId(productId);
    setTransferSearch('');
    setTransferSerialInput('');
    setTransferError('');
  };
  const handleTransferSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = transferSearch.trim().toUpperCase();
    if (!code) return;
    const exact = products.filter(product => product.sku.toUpperCase() === code);
    const match = exact.length === 1 ? exact[0] : (transferResults.length === 1 ? transferResults[0] : null);
    if (match) {
      selectTransferProduct(match.id);
      return;
    }
    for (const item of inventory) {
      const holder = Object.values(item.quantities).find(unit => (unit.serials || []).some(serial => serial.toUpperCase() === code));
      if (holder) {
        selectTransferProduct(item.productId);
        setTransferFrom(holder.unitId);
        if (transferTo === holder.unitId) setTransferTo(stores.find(store => store.unitId !== holder.unitId)?.unitId || '');
        setTransferSerialInput((holder.serials || []).find(serial => serial.toUpperCase() === code) || code);
        setTransferQty(1);
        return;
      }
    }
    setTransferError('Nenhum produto ou serial encontrado com esse código.');
  };

  // Leitor de codigo de barras na Entrada de Estoque: codigo exato + Enter seleciona o produto.
  const handleStockEntrySearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = stockEntrySearch.trim().toUpperCase();
    if (!code) return;
    const exact = products.filter(product => product.sku.toUpperCase() === code);
    const match = exact.length === 1 ? exact[0] : (stockEntryResults.length === 1 ? stockEntryResults[0] : null);
    if (match) {
      setStockEntryProductId(match.id);
      setStockEntrySearch('');
    }
  };

  // Leitor nos campos de serial: cada bipe (Enter) vai para a proxima linha, criando-a se preciso.
  const focusSerialInput = (index: number) => requestAnimationFrame(() => {
    document.querySelector<HTMLInputElement>(`[data-serial-index="${index}"]`)?.focus();
  });
  const handleSerialKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!serializedEntryUnits[index]?.serialNumber.trim()) return;
    if (index === serializedEntryUnits.length - 1) {
      setSerializedEntryUnits(previous => [...previous, { ...emptySerializedDraft(), unitCost: previous[previous.length - 1]?.unitCost ?? '' }]);
    }
    focusSerialInput(index + 1);
  };

  const resetProductForm = () => {
    setEditingProductId(null);
    setNewProdName('');
    setNewProdSku('');
    setNewProdCategory('Videogames');
    setNewProdBrand('');
    setNewProdCost(0);
    setNewProdSell(0);
    setNewProdNcm('');
    setNewProdWarranty(12);
    setNewProdSerialized(false);
    setNewProdStore(defaultStoreId);
    setNewProdQty(0);
    setNewProdMinStock('');
    setNewProdMaxDiscount(null);
    setNewProdCest('');
    setNewProdOrigin('');
    setNewProdCst('');
    setNewProdCsosn('');
    setNewProdIcmsRate(null);
    setNewProdIcmsReduction(null);
    setNewProdTaxBurden(null);
  };

  const openNewProduct = () => {
    resetProductForm();
    setShowAddProductModal(true);
  };

  const openEditProduct = (product: Product) => {
    resetProductForm();
    setEditingProductId(product.id);
    setNewProdName(product.name);
    setNewProdSku(product.sku);
    setNewProdCategory(product.category);
    setNewProdBrand(product.brand);
    setNewProdCost(product.costPrice);
    setNewProdSell(product.sellPrice);
    setNewProdNcm(product.ncm);
    setNewProdWarranty(product.warrantyMonths);
    setNewProdSerialized(product.isSerialized);
    setNewProdMinStock(product.minStock == null ? '' : String(product.minStock));
    setNewProdMaxDiscount(product.maxDiscountPercent ?? null);
    setNewProdCest(product.cest ?? '');
    setNewProdOrigin(product.icmsOrigin ?? '');
    setNewProdCst(product.icmsCst ?? '');
    setNewProdCsosn(product.csosn ?? '');
    setNewProdIcmsRate(product.icmsRate ?? null);
    setNewProdIcmsReduction(product.icmsReduction ?? null);
    setNewProdTaxBurden(product.taxBurdenPercent ?? null);
    setShowAddProductModal(true);
  };

  // Handle Add Product Submit
  const handleAddProductSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNewProdError('');
    const trimmedSku = sanitizeItemCode(newProdSku.trim());
    const trimmedName = newProdName.trim();
    const trimmedBrand = newProdBrand.trim();
    const trimmedNcm = newProdNcm.trim();

    // Codigo em branco: o banco gera o proximo numero automatico.
    if (!trimmedName) return;
    // Dados fiscais obrigatorios (2.8b): sem eles o produto nao sai na NFC-e.
    const fiscalError = productFiscalError({
      ncm: trimmedNcm,
      origin: newProdOrigin,
      cst: newProdCst,
      csosn: newProdCsosn,
      cest: newProdCest,
      icmsRate: newProdIcmsRate,
      icmsReduction: newProdIcmsReduction,
      taxBurden: newProdTaxBurden
    });
    if (fiscalError) {
      setNewProdError(fiscalError);
      return;
    }
    const fiscalFields = {
      cest: newProdCest.trim() || null,
      icmsOrigin: newProdOrigin || null,
      icmsCst: newProdCst || null,
      csosn: newProdCsosn || null,
      icmsRate: newProdIcmsRate,
      icmsReduction: newProdIcmsReduction,
      taxBurdenPercent: newProdTaxBurden
    };

    const minStockValue = newProdMinStock.trim() === '' ? null : Math.max(0, parseInt(newProdMinStock, 10) || 0);

    setNewProdSaving(true);
    try {
      const editing = editingProductId ? products.find(product => product.id === editingProductId) : undefined;
      if (editing) {
        await saveProduct({
          ...editing,
          sku: trimmedSku || editing.sku,
          name: trimmedName,
          category: newProdCategory,
          brand: trimmedBrand,
          costPrice: newProdCost,
          sellPrice: newProdSell,
          ncm: trimmedNcm,
          warrantyMonths: newProdWarranty,
          isSerialized: newProdSerialized,
          minStock: minStockValue,
          maxDiscountPercent: newProdMaxDiscount,
          ...fiscalFields
        });
      } else await addProduct({
      sku: trimmedSku,
      name: trimmedName,
      category: newProdCategory,
      brand: trimmedBrand,
      costPrice: newProdCost,
      sellPrice: newProdSell,
      ncm: trimmedNcm,
      warrantyMonths: newProdWarranty,
      isSerialized: newProdSerialized,
      isUsed: false,
      minStock: minStockValue,
      maxDiscountPercent: newProdMaxDiscount,
      ...fiscalFields
      });
    } catch (error: any) {
      setNewProdError(error?.message || 'Não foi possível salvar o produto.');
      return;
    } finally {
      setNewProdSaving(false);
    }

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
    setNewProdMinStock('');
    setNewProdMaxDiscount(null);
    resetProductForm();
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
      const drafts = serializedEntryUnits
        .map(unit => ({ serialNumber: unit.serialNumber.trim(), imei: unit.imei.trim(), unitCost: unit.unitCost.trim() }))
        .filter(unit => unit.serialNumber || unit.imei || unit.unitCost);
      const missingSerial = drafts.some(unit => !unit.serialNumber);
      const serials = drafts.map(unit => unit.serialNumber.toLocaleLowerCase());
      const invalidCost = drafts.some(unit => parseMoneyInput(unit.unitCost) === null);
      const units: SerializedStockEntryUnit[] = drafts.map(unit => ({
        serialNumber: unit.serialNumber,
        imei: unit.imei || undefined,
        unitCost: parseMoneyInput(unit.unitCost) ?? undefined
      }));

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
      if (invalidCost) {
        setStockEntryError('Informe o custo de compra de cada unidade (valor em reais, até 2 casas decimais).');
        return;
      }

      setStockEntrySubmitting(true);
      try {
        await registerSerializedStockEntry(selectedStockEntryProduct.id, serializedEntryUnitId, units, movementReason);
        setStockEntrySuccess(`${units.length} unidade(s) serializada(s) registrada(s) para ${selectedStockEntryProduct.name}.`);
        setSerializedEntryUnits([emptySerializedDraft()]);
        setSerializedApplyAllCost('');
        setStockEntryReason('Reposição de estoque');
      } catch (error) {
        setStockEntryError(errorMessage(error, 'Não foi possível registrar a entrada serializada.'));
      } finally {
        setStockEntrySubmitting(false);
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

    const unitCost = parseMoneyInput(stockEntryUnitCost);
    if (unitCost === null) {
      setStockEntryError('Informe o custo unitário da compra (valor em reais, até 2 casas decimais).');
      return;
    }

    setStockEntrySubmitting(true);
    try {
      await registerStockEntry(
        selectedStockEntryProduct.id,
        requestedEntries.map(entry => ({ unitId: entry.unitId, quantity: entry.qty })),
        unitCost,
        movementReason
      );
      setStockEntrySuccess(`Entrada registrada para ${selectedStockEntryProduct.name} em ${requestedEntries.length} loja(s), custo unitário ${formatMoney(unitCost)}.`);
      setStockEntryQuantities(Object.fromEntries(stores.map(store => [store.unitId, ''])));
      setStockEntryUnitCost('');
      setStockEntryReason('Reposição de estoque');
    } catch (error) {
      setStockEntryError(errorMessage(error, 'Não foi possível registrar a entrada. Nada foi gravado.'));
    } finally {
      setStockEntrySubmitting(false);
    }
  };

  // Edicao direto na lista: erro do banco aparece acima dos produtos.
  const [inlineError, setInlineError] = useState('');
  const saveInline = (product: Product) => {
    setInlineError('');
    editProduct(product).catch(error => setInlineError(`Não foi possível salvar ${product.name}: ${error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco'}`));
  };

  const saveMinStock = (product: Product) => {
    const draft = minStockDrafts[product.id];
    if (draft === undefined) return;
    const trimmed = draft.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    const clearDraft = () => setMinStockDrafts(previous => {
      const next = { ...previous };
      delete next[product.id];
      return next;
    });
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      clearDraft();
      return;
    }
    if (value !== (product.minStock ?? null)) {
      saveInline({ ...product, minStock: value });
    }
    clearDraft();
  };

  // Limite de desconto do produto (vazio = usa o padrao da loja). Grava ao sair do campo.
  const saveMaxDiscount = (product: Product) => {
    if (!(product.id in maxDiscountDrafts)) return;
    const value = maxDiscountDrafts[product.id];
    setMaxDiscountDrafts(previous => {
      const next = { ...previous };
      delete next[product.id];
      return next;
    });
    if (value !== null && (value < 0 || value > 100)) return;
    if (value !== (product.maxDiscountPercent ?? null)) {
      saveInline({ ...product, maxDiscountPercent: value });
    }
  };

  // Handle Transfer Submit (Atomic operation)
  const handleTransferSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (transferSaving) return;
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

    if (transferQty < 1) {
      setTransferError('Informe a quantidade a transferir.');
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

    // Executa no banco (custo da origem vai junto); so mostra sucesso se o banco confirmar
    setTransferSaving(true);
    try {
      await registerTransfer(
        transferProductId,
        transferFrom,
        transferTo,
        transferQty,
        serialsToTransfer,
        selectedProduct?.category === 'Cards' ? transferCardCondition : undefined,
        transferReason || 'Transferência entre unidades'
      );
    } catch (err) {
      setTransferError((err as { message?: string })?.message || 'Não foi possível concluir a transferência.');
      return;
    } finally {
      setTransferSaving(false);
    }

    setTransferSuccess(true);
    setTransferQty(1);
    setTransferSerialInput('');
    setTransferReason('');
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
          <button
            id="tab-estoque-transferencias"
            onClick={() => setActiveSubTab('transferencias')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeSubTab === 'transferencias'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Shuffle className="w-4 h-4 mr-1.5" />
            Transferências
          </button>
          <button
            id="tab-estoque-avariados"
            onClick={() => setActiveSubTab('avariados')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeSubTab === 'avariados'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <Package className="w-4 h-4 mr-1.5" />
            Avariados
          </button>
          <button
            id="tab-estoque-balanco"
            onClick={() => setActiveSubTab('balanco')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center border ${
              activeSubTab === 'balanco'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <ClipboardCheck className="w-4 h-4 mr-1.5" />
            Balanço
          </button>
        </div>

        {activeSubTab === 'catalogo' && (
          <button
            id="btn-add-product"
            onClick={openNewProduct}
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
                placeholder="Pesquisar por nome ou código..."
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

          {inlineError && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{inlineError}</p>}
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
              const minStock = p.minStock ?? DEFAULT_MIN_STOCK;
              const minStockDraft = minStockDrafts[p.id];

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
                            : totalStock <= minStock
                              ? 'bg-amber-50 text-amber-700 border border-amber-100/50'
                              : 'bg-emerald-50 text-emerald-700 border border-emerald-100/50'
                        }`}>
                          Estoque: {totalStock} un
                        </span>
                        <h3 className="text-sm font-bold text-slate-900 mt-1 font-sans flex items-center gap-1.5">
                          {p.name}
                          {isAdmin && (
                            <button type="button" onClick={() => openEditProduct(p)} title="Editar produto" aria-label={`Editar ${p.name}`} className="p-1 text-blue-700 rounded hover:bg-blue-50">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {(!p.ncm || !p.icmsOrigin || !(p.csosn || p.icmsCst)) && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100" title="Sem os dados fiscais a NFC-e é recusada: edite o produto">DADOS FISCAIS PENDENTES</span>}
                        </h3>
                        <p className="text-xs text-slate-400 font-mono mt-0.5">Código: {p.sku}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-slate-400 font-mono block">Preço de Venda</span>
                        <span className="text-base font-black text-slate-900 font-mono">
                          R$ {p.sellPrice.toLocaleString('pt-BR')}
                        </span>
                        {isAdmin && (
                          <span className="text-[10px] text-slate-500 font-medium block mt-0.5" title="Usado quando a loja ainda não tem custo de compra registrado">
                            Custo padrão: {formatMoney(p.costPrice)}
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

                          return (
                            <div key={unit.id} className="flex justify-between items-center p-1 bg-white rounded border border-slate-200/50">
                              <div className="min-w-0">
                                <span className="text-slate-600 truncate max-w-[100px] font-medium text-[11px] block">
                                  {unit.name.split(' - ')[0]}
                                </span>
                                {isAdmin && (
                                  <span className="text-[10px] text-emerald-700 font-mono block" title={p.isSerialized ? 'Média do custo das unidades em estoque' : 'Custo médio ponderado da loja'}>
                                    Custo {formatMoney(getStoreCost(p, unit.id))}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center space-x-1">
                                <span className={`font-mono font-bold text-[11px] ${
                                  unitQty === 0
                                    ? 'text-rose-500'
                                    : unitQty <= minStock
                                      ? 'text-amber-500'
                                      : 'text-slate-900'
                                }`}>
                                  {unitQty} un
                                </span>
                                {unitQty <= minStock && (
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
                      <div className="flex items-center gap-3">
                        {isAdmin ? (
                          <label className="flex items-center gap-1 text-slate-400" title="Abaixo deste número o produto entra nos alertas do Dashboard. Em branco = padrão (2).">
                            <span>Mínimo:</span>
                            <ValueInput
                              decimals={0}
                              value={minStockDraft !== undefined ? (minStockDraft === '' ? null : Number(minStockDraft)) : p.minStock}
                              placeholder={String(DEFAULT_MIN_STOCK)}
                              onValueChange={(value) => setMinStockDrafts(previous => ({ ...previous, [p.id]: value == null ? '' : String(value) }))}
                              onBlur={() => saveMinStock(p)}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                              className="w-12 bg-slate-50 border border-slate-200 rounded px-1 py-0.5 text-center font-mono text-slate-700 outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </label>
                        ) : (
                          <span className="font-mono text-slate-400">Mínimo: {minStock}</span>
                        )}
                        {isAdmin ? (
                          <label className="flex items-center gap-1 text-slate-400" title="Desconto máximo sem senha no PDV. Em branco = limite padrão da loja.">
                            <span>Desc. máx. %:</span>
                            <ValueInput
                              value={p.id in maxDiscountDrafts ? maxDiscountDrafts[p.id] : (p.maxDiscountPercent ?? null)}
                              placeholder="loja"
                              onValueChange={(value) => setMaxDiscountDrafts(previous => ({ ...previous, [p.id]: value == null ? null : Math.min(100, value) }))}
                              onBlur={() => saveMaxDiscount(p)}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                              className="w-14 bg-slate-50 border border-slate-200 rounded px-1 py-0.5 text-center font-mono text-slate-700 outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </label>
                        ) : (
                          <span className="font-mono text-slate-400">Desc. máx.: {p.maxDiscountPercent != null ? `${p.maxDiscountPercent}%` : 'padrão da loja'}</span>
                        )}
                        <span className="font-mono text-slate-400">Garantia: {p.warrantyMonths}m</span>
                      </div>
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
              <label className="font-medium text-slate-700 text-xs">Buscar produto por código ou nome <span className="font-normal text-slate-400">(pode bipar o código)</span></label>
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={stockEntrySearch}
                  onChange={(e) => setStockEntrySearch(e.target.value)}
                  onKeyDown={handleStockEntrySearchKeyDown}
                  placeholder="Digite ou bipe o código, ou digite o nome do produto"
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
                        <p className="text-[11px] text-slate-500 font-mono">Código: {product.sku}</p>
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
                    <p className="text-[11px] text-slate-500 font-mono">Código: {selectedStockEntryProduct.sku}</p>
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

                    <div className="flex flex-wrap items-end gap-2 bg-slate-50 border border-slate-200 rounded-xl p-3">
                      <div className="space-y-1">
                        <label className="font-medium text-slate-700">Mesmo custo para todas as unidades (R$)</label>
                        <ValueInput
                          value={parseMoneyInput(serializedApplyAllCost)}
                          onValueChange={(value) => setSerializedApplyAllCost(value == null ? '' : String(value))}
                          placeholder="Ex: 4135,00"
                          className="w-40 bg-white border border-slate-200 rounded-lg p-2 outline-none font-mono"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={parseMoneyInput(serializedApplyAllCost) === null}
                        onClick={() => setSerializedEntryUnits(previous => previous.map(current => ({ ...current, unitCost: serializedApplyAllCost.trim() })))}
                        className="px-3 py-2 border border-slate-200 bg-white text-slate-700 rounded-lg hover:bg-slate-100 transition font-semibold disabled:opacity-40"
                      >
                        Aplicar a todas
                      </button>
                      <p className="text-[11px] text-slate-500 basis-full">Se uma unidade custou diferente (ex.: compra urgente), ajuste só a linha dela.</p>
                    </div>

                    <div className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_36px] gap-2 px-1 text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                        <span>Número de série</span>
                        <span>IMEI opcional</span>
                        <span>Custo (R$)</span>
                        <span />
                      </div>
                      {serializedEntryUnits.map((unit, index) => (
                        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_36px] gap-2">
                          <input
                            type="text"
                            value={unit.serialNumber}
                            data-serial-index={index}
                            onKeyDown={(e) => handleSerialKeyDown(e, index)}
                            onChange={(e) => setSerializedEntryUnits(previous => previous.map((current, currentIndex) => currentIndex === index ? { ...current, serialNumber: e.target.value } : current))}
                            placeholder="Ex: NB-X-0001"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                          />
                          <input
                            type="text"
                            value={unit.imei}
                            onChange={(e) => setSerializedEntryUnits(previous => previous.map((current, currentIndex) => currentIndex === index ? { ...current, imei: e.target.value } : current))}
                            placeholder="Opcional"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                          />
                          <ValueInput
                            value={parseMoneyInput(unit.unitCost)}
                            onValueChange={(value) => setSerializedEntryUnits(previous => previous.map((current, currentIndex) => currentIndex === index ? { ...current, unitCost: value == null ? '' : String(value) } : current))}
                            placeholder="0,00"
                            aria-label="Custo de compra da unidade"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono text-right"
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
                      onClick={() => setSerializedEntryUnits(previous => [...previous, { ...emptySerializedDraft(), unitCost: previous[previous.length - 1]?.unitCost ?? '' }])}
                      className="px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition font-semibold"
                    >
                      Adicionar unidade
                    </button>
                  </div>
                ) : (
                <div className="space-y-3">
                <div className="space-y-1 max-w-xs">
                  <label className="font-medium text-slate-700">Custo unitário desta compra (R$)</label>
                  <ValueInput
                    value={parseMoneyInput(stockEntryUnitCost)}
                    onValueChange={(value) => setStockEntryUnitCost(value == null ? '' : String(value))}
                    placeholder="Ex: 11,00"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400">Cada loja que receber recalcula o próprio custo médio.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-separate border-spacing-y-2">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                        <th className="px-3 py-1">Loja</th>
                        <th className="px-3 py-1 text-center">Estoque Atual</th>
                        <th className="px-3 py-1 text-center">Custo médio</th>
                        <th className="px-3 py-1 text-center">Adicionar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stores.map(store => {
                        const currentQty = getUnitStock(selectedStockEntryProduct.id, store.unitId);
                        const currentCost = getStoreCost(selectedStockEntryProduct, store.unitId);
                        const addQty = parseInt(stockEntryQuantities[store.unitId] || '0', 10) || 0;
                        const entryCost = parseMoneyInput(stockEntryUnitCost);
                        const baseQty = Math.max(0, currentQty);
                        // Mesma conta do servidor (apply_store_cost_entry), so para pre-visualizar.
                        const projectedCost = entryCost !== null && addQty > 0
                          ? (baseQty * currentCost + addQty * entryCost) / (baseQty + addQty)
                          : null;
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
                            <td className="px-3 py-3 border-y border-slate-200 text-center font-mono text-slate-700">
                              {formatMoney(currentCost)}
                              {projectedCost !== null && (
                                <span className="block text-[10px] text-blue-700">→ {formatMoney(projectedCost)}</span>
                              )}
                            </td>
                            <td className="px-3 py-3 rounded-r-xl border border-slate-200 border-l-0">
                              <ValueInput
                                decimals={0}
                                value={stockEntryQuantities[store.unitId] ? Number(stockEntryQuantities[store.unitId]) : null}
                                onValueChange={(value) => setStockEntryQuantities(previous => ({
                                  ...previous,
                                  [store.unitId]: value == null ? '' : String(value)
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
                    <p className="text-sm font-semibold text-slate-900">
                      Custo total da compra: {(() => {
                        if (selectedStockEntryProduct.isSerialized) {
                          const costs = serializedEntryUnits.filter(unit => unit.serialNumber.trim()).map(unit => parseMoneyInput(unit.unitCost));
                          return costs.some(cost => cost === null) ? '—' : formatMoney(costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0));
                        }
                        const entryCost = parseMoneyInput(stockEntryUnitCost);
                        const totalQty = stores.reduce((sum, store) => sum + (parseInt(stockEntryQuantities[store.unitId] || '0', 10) || 0), 0);
                        return entryCost === null ? '—' : formatMoney(entryCost * totalQty);
                      })()}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {selectedStockEntryProduct.isSerialized
                        ? 'Cada linha representa uma unidade física. Números de série não são gerados automaticamente.'
                        : 'Tudo é gravado de uma vez: se algo falhar, nenhuma loja recebe a entrada.'}
                    </p>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => selectedStockEntryProduct.isSerialized
                      ? setSerializedEntryUnits([emptySerializedDraft()])
                      : setStockEntryQuantities(Object.fromEntries(stores.map(store => [store.unitId, ''])))}
                    className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition"
                  >
                    Zerar
                  </button>
                  <button
                    type="submit"
                    disabled={stockEntrySubmitting}
                    className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg transition disabled:opacity-50"
                  >
                    {stockEntrySubmitting ? 'Gravando...' : 'Confirmar Entrada'}
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
              {/* Product Search (como no PDV) */}
              <div className="space-y-1.5">
                <label className="font-medium text-slate-700">Produto <span className="font-normal text-slate-400">(código, nome ou serial; pode bipar)</span></label>
                {transferProductId ? (
                  <div className="flex items-center justify-between gap-3 bg-blue-50 border border-blue-200 rounded-lg p-2.5">
                    <div>
                      <p className="text-sm font-bold text-slate-900">{products.find(p => p.id === transferProductId)?.name}</p>
                      <p className="text-[11px] text-slate-500 font-mono">
                        Código: {products.find(p => p.id === transferProductId)?.sku} · Na origem: {getUnitStock(transferProductId, transferFrom)} un
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setTransferProductId(''); setTransferSerialInput(''); }}
                      className="text-[10px] font-bold uppercase px-2 py-1 rounded-lg bg-white border border-slate-200 text-slate-600"
                    >
                      Trocar
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={transferSearch}
                        onChange={(e) => { setTransferSearch(e.target.value); setTransferError(''); }}
                        onKeyDown={handleTransferSearchKeyDown}
                        placeholder="Digite ou bipe o código, o nome ou o serial"
                        className="w-full bg-slate-50 text-slate-800 rounded-lg pl-9 pr-4 py-2.5 border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500 font-semibold"
                      />
                    </div>
                    {transferSearch.trim() && (
                      <div className="max-h-64 overflow-y-auto space-y-1.5">
                        {transferResults.slice(0, 10).map(product => (
                          <button
                            key={product.id}
                            type="button"
                            onClick={() => selectTransferProduct(product.id)}
                            className="w-full text-left p-2.5 rounded-lg border bg-slate-50 border-slate-200 hover:bg-slate-100 transition flex items-start justify-between gap-3"
                          >
                            <span>
                              <span className="block text-sm font-bold text-slate-900">{product.name}</span>
                              <span className="block text-[11px] text-slate-500 font-mono">Código: {product.sku}</span>
                            </span>
                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-500 shrink-0">
                              {getUnitStock(product.id, transferFrom)} un na origem
                            </span>
                          </button>
                        ))}
                        {transferResults.length === 0 && (
                          <p className="p-3 text-center text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                            Nenhum produto encontrado. Se for um serial, aperte Enter.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
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
                <ValueInput
                  decimals={0}
                  value={transferQty || null}
                  onValueChange={(value) => setTransferQty(value ?? 0)}
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
                disabled={transferSaving}
                className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white rounded-lg transition font-bold"
              >
                {transferSaving ? 'Transferindo...' : 'Efetivar Movimentação'}
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

      {/* 3. VIEW: Avariados */}
      {activeSubTab === 'balanco' && (
        <BalancoPanel
          currentUser={currentUser}
          products={products}
          inventory={inventory}
          storeConfigs={storeConfigs}
          productStoreCosts={productStoreCosts}
          onStockChanged={onStockChanged}
        />
      )}

      {activeSubTab === 'avariados' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h3 className="text-sm font-bold text-slate-900">Avariados</h3>
            <p className="text-xs text-slate-500">Produtos devolvidos com defeito pelo PDV. Ficam fora do estoque de venda.</p>
          </div>
          {damagedError && <p className="p-4 text-xs text-rose-700">{damagedError}</p>}
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
              <tr><th className="p-3 text-left">Produto</th><th className="p-3 text-left">Loja</th><th className="p-3 text-right">Quantidade</th><th className="p-3 text-left">Seriais</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {damaged === null && <tr><td colSpan={4} className="p-4 text-slate-400">Carregando...</td></tr>}
              {damaged !== null && damaged.length === 0 && <tr><td colSpan={4} className="p-4 text-slate-400">Nenhum produto avariado.</td></tr>}
              {(damaged || []).map(row => {
                const product = products.find(item => item.id === row.productId);
                const store = storeConfigs.find(item => item.unitId === row.unitId);
                return (
                  <tr key={`${row.unitId}-${row.productId}`}>
                    <td className="p-3 font-bold text-slate-800">{product?.name ?? row.productId}<span className="block font-normal text-slate-400">{product?.sku}</span></td>
                    <td className="p-3 text-slate-600">{store?.tradeName || row.unitId}</td>
                    <td className="p-3 text-right font-mono">{row.quantity}</td>
                    <td className="p-3 text-slate-500">{row.serials.join(', ') || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Product Modal (Simple custom overlay) */}
      {showAddProductModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-2xl w-full max-h-[92vh] overflow-y-auto flex flex-col">
            <div className="bg-slate-900 text-white p-4 flex justify-between items-center">
              <h3 className="font-bold text-sm uppercase tracking-wider flex items-center">
                <Layers className="w-4.5 h-4.5 mr-2 text-amber-500" />
                {editingProductId ? 'Editar Produto' : 'Cadastrar Novo Produto no Catálogo'}
              </h3>
              <button
                id="btn-close-product-modal"
                onClick={() => { setShowAddProductModal(false); resetProductForm(); }}
                className="text-slate-400 hover:text-white font-bold text-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddProductSubmit} className="p-5 space-y-4 text-xs font-sans">
              {newProdError && (
                <p role="alert" className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-[11px] font-medium">{newProdError}</p>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Código do Produto</label>
                  <input
                    type="text"
                    placeholder={nextItemCode ? `Automático: ${nextItemCode}` : 'Automático'}
                    value={newProdSku}
                    onChange={(e) => setNewProdSku(sanitizeItemCode(e.target.value))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400">Deixe em branco para gerar o próximo número. Só letras, números e hífen.</p>
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
                  <label className="font-bold text-slate-700">NCM (Fins Fiscais) *</label>
                  <input
                    type="text"
                    placeholder="8 números, ex.: 8471.60.52"
                    value={newProdNcm}
                    onChange={(e) => setNewProdNcm(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="font-bold text-slate-700" title="Usado só quando a loja ainda não tem custo de compra registrado. O custo real vem da Entrada de Estoque.">Custo padrão (R$)</label>
                  <ValueInput
                    value={newProdCost || null}
                    onValueChange={(value) => setNewProdCost(value ?? 0)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Preço Venda (R$)</label>
                  <ValueInput
                    value={newProdSell || null}
                    onValueChange={(value) => setNewProdSell(value ?? 0)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Estoque mínimo</label>
                  <ValueInput
                    decimals={0}
                    value={newProdMinStock === '' ? null : Number(newProdMinStock)}
                    placeholder={`Padrão: ${DEFAULT_MIN_STOCK}`}
                    onValueChange={(value) => setNewProdMinStock(value == null ? '' : String(value))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-bold text-slate-700">Limite de desconto (%)</label>
                <ValueInput
                  value={newProdMaxDiscount}
                  placeholder="Em branco = limite padrão da loja"
                  onValueChange={(value) => setNewProdMaxDiscount(value == null ? null : Math.min(100, value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                />
                <p className="text-[10px] text-slate-400">Desconto máximo que o vendedor pode dar no PDV sem a senha administrativa.</p>
              </div>

              <div className="space-y-1 max-w-[200px]">
                <label className="font-bold text-slate-700">Garantia (meses)</label>
                <ValueInput
                  decimals={0}
                  value={newProdWarranty || null}
                  placeholder="0 = sem garantia"
                  onValueChange={(value) => setNewProdWarranty(value ?? 0)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
                />
              </div>

              <fieldset className="border border-slate-200 rounded-lg p-3 space-y-3">
                <legend className="px-1 font-bold text-slate-800 uppercase tracking-wider text-[10px]">Informações fiscais (obrigatórias; CEST só com substituição tributária)</legend>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="font-bold text-slate-700">ICMS (%)</label>
                    <ValueInput value={newProdIcmsRate} placeholder="0,00" onValueChange={(value) => setNewProdIcmsRate(value == null ? null : Math.min(100, value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-slate-700">Redução do ICMS (%)</label>
                    <ValueInput value={newProdIcmsReduction} placeholder="0,00" onValueChange={(value) => setNewProdIcmsReduction(value == null ? null : Math.min(100, value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-slate-700" title="Valor aproximado de impostos informado ao consumidor (Lei da Transparência)">Total de tributos (%)</label>
                    <ValueInput value={newProdTaxBurden} placeholder="0,00" onValueChange={(value) => setNewProdTaxBurden(value == null ? null : Math.min(100, value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none" />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="font-bold text-slate-700">Origem da Situação Tributária</label>
                  <select value={newProdOrigin} onChange={(e) => setNewProdOrigin(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none">
                    <option value="">Selecione uma origem</option>
                    {ICMS_ORIGINS.map(origin => <option key={origin.code} value={origin.code}>{origin.label}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="font-bold text-slate-700">Situação Tributária (CST)</label>
                    <select value={newProdCst} onChange={(e) => setNewProdCst(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none">
                      <option value="">Selecione</option>
                      {ICMS_CSTS.map(code => <option key={code} value={code}>{code}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-slate-700">CSOSN</label>
                    <select value={newProdCsosn} onChange={(e) => setNewProdCsosn(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none">
                      <option value="">Vazio</option>
                      {CSOSNS.map(code => <option key={code} value={code}>{code}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-slate-700">CEST</label>
                    <input type="text" inputMode="numeric" maxLength={9} value={newProdCest} onChange={(e) => setNewProdCest(e.target.value.replace(/[^0-9.]/g, ''))} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-mono" />
                  </div>
                </div>
              </fieldset>

              {!editingProductId && (
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 mt-2 text-[11px] text-slate-500">
                  O estoque será lançado depois, na sub-aba de Entrada de Estoque.
                </div>
              )}

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
                  onClick={() => { setShowAddProductModal(false); resetProductForm(); }}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={newProdSaving}
                  className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg transition disabled:opacity-60"
                >
                  {newProdSaving ? 'Salvando...' : editingProductId ? 'Salvar alterações' : 'Confirmar Cadastro'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
