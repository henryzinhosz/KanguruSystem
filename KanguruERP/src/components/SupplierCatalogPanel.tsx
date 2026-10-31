import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileSpreadsheet, Link2, Minus, Plus, Printer, Search, ShoppingCart, Trash2, Upload, X } from 'lucide-react';
import type { Product, StockInventory, StoreConfig, Supplier, User } from '../types';
import { readWorkbook, suggestProducts, type CatalogReadingConfig, type ParsedCatalogItem } from '../db/supplierCatalogParser';
import {
  importSupplierCatalog,
  linkSupplierCatalogItem,
  listPurchaseOrders,
  listSupplierCatalogItems,
  listSupplierCatalogs,
  savePurchaseOrder,
  setPurchaseOrderStatus,
  type PurchaseOrder,
  type SupplierCatalog,
  type SupplierCatalogItem,
} from '../db/supplierCatalogs';
import { formatMoney } from '../db/finance';
import CatalogImportModal from './CatalogImportModal';
import { printPurchaseOrder } from './purchaseOrderPrint';

// Catalogo de fornecedores + pedido de compra: importa a planilha do fornecedor, mostra o
// catalogo (com o estoque das lojas ao lado, so informativo) e monta o pedido com PDF.
// O pedido nao mexe no estoque.

interface SupplierCatalogPanelProps {
  currentUser: User;
  suppliers: Supplier[];
  products: Product[];
  inventory: StockInventory[];
  storeConfigs: StoreConfig[];
}

interface CartLine {
  item: SupplierCatalogItem;
  quantity: number;
}

const STATUS_LABELS: Record<string, string> = { RASCUNHO: 'Rascunho', ENVIADO: 'Enviado', CANCELADO: 'Cancelado' };
const PAGE_SIZE = 100;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Erro no banco.';

const isLaunch = (status: string) => /LAN[CÇ]AMENTO|NOVO/.test(status);

export default function SupplierCatalogPanel({ currentUser, suppliers, products, inventory, storeConfigs }: SupplierCatalogPanelProps) {
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const [tab, setTab] = useState<'catalogo' | 'pedidos'>('catalogo');
  const [supplierId, setSupplierId] = useState('');
  const [catalogs, setCatalogs] = useState<SupplierCatalog[]>([]);
  const [items, setItems] = useState<SupplierCatalogItem[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [importing, setImporting] = useState<{ fileName: string; workbook: Record<string, unknown[][]> } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Filtros do catalogo
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [type, setType] = useState('');
  const [onlyLaunches, setOnlyLaunches] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [linking, setLinking] = useState<SupplierCatalogItem | null>(null);

  // Carrinho (pedido em montagem)
  const [cart, setCart] = useState<CartLine[]>([]);
  const [editingOrder, setEditingOrder] = useState<PurchaseOrder | null>(null);
  const [deliveryStore, setDeliveryStore] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const supplier = suppliers.find(entry => entry.id === supplierId);
  const catalog = catalogs.find(entry => entry.supplierId === supplierId) || null;
  const storeById = (unitId: string) => stores.find(store => store.unitId === unitId);

  useEffect(() => {
    if (!supplierId && suppliers.length) setSupplierId(suppliers[0].id);
  }, [suppliers]);
  useEffect(() => {
    if (!deliveryStore && stores.length) setDeliveryStore(currentUser.unitId !== 'central' && stores.some(store => store.unitId === currentUser.unitId) ? currentUser.unitId : stores[0].unitId);
  }, [storeConfigs]);

  const reloadCatalogs = async () => {
    const list = await listSupplierCatalogs();
    setCatalogs(list);
    return list;
  };
  const reloadOrders = async () => setOrders(await listPurchaseOrders());

  useEffect(() => {
    void Promise.all([reloadCatalogs(), reloadOrders()]).catch(error =>
      setMessage({ kind: 'error', text: `Não foi possível carregar os catálogos: ${errorText(error)}. Confira se a migration 20261112 foi aplicada.` }));
  }, []);

  useEffect(() => {
    setItems([]);
    setBrand('');
    setType('');
    setVisible(PAGE_SIZE);
    if (!catalog) return;
    setLoading(true);
    listSupplierCatalogItems(catalog.id)
      .then(setItems)
      .catch(error => setMessage({ kind: 'error', text: errorText(error) }))
      .finally(() => setLoading(false));
  }, [catalog?.id, catalog?.importedAt]);

  // Fornecedor trocado: o carrinho e de um fornecedor so.
  const changeSupplier = (id: string) => {
    if (cart.length && id !== supplierId && !window.confirm('O pedido em montagem é de outro fornecedor e será descartado. Continuar?')) return;
    if (id !== supplierId) {
      setCart([]);
      setEditingOrder(null);
      setNotes('');
    }
    setSupplierId(id);
  };

  // ---- Importacao ----
  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setMessage(null);
    try {
      const workbook = await readWorkbook(await file.arrayBuffer());
      setImporting({ fileName: file.name, workbook });
    } catch (error) {
      setMessage({ kind: 'error', text: `Não foi possível ler a planilha: ${errorText(error)}` });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const handleImport = async (config: CatalogReadingConfig, parsedItems: ParsedCatalogItem[]) => {
    if (!importing || !supplier) return;
    const result = await importSupplierCatalog(supplier.id, importing.fileName, config, parsedItems);
    setImporting(null);
    await reloadCatalogs();
    setMessage({ kind: 'ok', text: `Catálogo de ${supplier.name} atualizado: ${result.total} itens (${result.new} novos, ${result.priceChanged} com preço novo, ${result.removed} saíram da lista).` });
  };

  // ---- Catalogo ----
  const brands = useMemo(() => [...new Set(items.map(item => item.brand).filter(Boolean))].sort(), [items]);
  const types = useMemo(() => [...new Set(items.filter(item => !brand || item.brand === brand).map(item => item.productType).filter(Boolean))].sort(), [items, brand]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter(item =>
      (showRemoved || item.isActive)
      && (!brand || item.brand === brand)
      && (!type || item.productType === type)
      && (!onlyLaunches || isLaunch(item.status))
      && (!term || item.name.toLowerCase().includes(term) || item.supplierCode.toLowerCase().includes(term)));
  }, [items, search, brand, type, onlyLaunches, showRemoved]);

  const stockOf = (productId: string | null) => {
    if (!productId) return null;
    const quantities = inventory.find(entry => entry.productId === productId)?.quantities || {};
    const perStore = stores.map(store => ({ store, qty: quantities[store.unitId]?.qty || 0 }));
    return { total: perStore.reduce((sum, entry) => sum + entry.qty, 0), perStore };
  };
  const productById = (id: string | null) => (id ? products.find(product => product.id === id) : undefined);

  const addToCart = (item: SupplierCatalogItem, quantity: number) => {
    if (quantity <= 0) return;
    setCart(previous => {
      const existing = previous.find(line => line.item.id === item.id);
      return existing
        ? previous.map(line => (line.item.id === item.id ? { ...line, quantity: line.quantity + quantity } : line))
        : [...previous, { item, quantity }];
    });
    setQuantities(previous => ({ ...previous, [item.id]: 0 }));
  };

  const handleLink = async (item: SupplierCatalogItem, productId: string | null) => {
    try {
      await linkSupplierCatalogItem(item.id, productId);
      setItems(previous => previous.map(entry => (entry.id === item.id ? { ...entry, productId } : entry)));
      setLinking(null);
    } catch (error) {
      setMessage({ kind: 'error', text: `Não foi possível ligar o produto: ${errorText(error)}` });
    }
  };

  // ---- Pedido ----
  const cartByBrand = useMemo(() => {
    const groups = new Map<string, CartLine[]>();
    cart.forEach(line => groups.set(line.item.brand || 'Sem marca', [...(groups.get(line.item.brand || 'Sem marca') || []), line]));
    return [...groups.entries()];
  }, [cart]);
  const cartTotal = cart.reduce((sum, line) => sum + line.item.unitCost * line.quantity, 0);
  const pendingInCart = cart.filter(line => !(line.item.unitCost > 0)).length;

  const saveOrder = async (send: boolean) => {
    if (!supplier || !cart.length || !deliveryStore) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await savePurchaseOrder({
        id: editingOrder?.id ?? null,
        supplierId: supplier.id,
        unitId: deliveryStore,
        notes,
        items: cart.map(line => ({ catalogItemId: line.item.id, quantity: line.quantity })),
        send,
      });
      const list = await listPurchaseOrders();
      setOrders(list);
      const order = list.find(entry => entry.id === saved.id);
      if (send && order) printPurchaseOrder(order, supplier, storeById(order.unitId));
      setCart([]);
      setEditingOrder(null);
      setNotes('');
      setMessage({ kind: 'ok', text: send ? `Pedido nº ${saved.orderNumber} finalizado. Salve o PDF e envie ao fornecedor.` : `Rascunho do pedido nº ${saved.orderNumber} salvo.` });
    } catch (error) {
      setMessage({ kind: 'error', text: `Não foi possível salvar o pedido: ${errorText(error)}` });
    } finally {
      setSaving(false);
    }
  };

  const editOrder = (order: PurchaseOrder) => {
    const byId = new Map(items.map(item => [item.id, item]));
    const lines = order.items
      .map(line => ({ item: line.catalogItemId ? byId.get(line.catalogItemId) : undefined, quantity: line.quantity }))
      .filter((line): line is CartLine => Boolean(line.item));
    if (lines.length < order.items.length) {
      setMessage({ kind: 'error', text: 'Alguns itens deste rascunho não estão mais no catálogo e ficaram de fora.' });
    }
    setCart(lines);
    setEditingOrder(order);
    setDeliveryStore(order.unitId);
    setNotes(order.notes);
    setTab('catalogo');
  };

  const changeStatus = async (order: PurchaseOrder, status: 'ENVIADO' | 'CANCELADO') => {
    if (status === 'CANCELADO' && !window.confirm(`Cancelar o pedido nº ${order.orderNumber}?`)) return;
    try {
      await setPurchaseOrderStatus(order.id, status);
      await reloadOrders();
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) });
    }
  };

  if (!suppliers.length) {
    return <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500">Cadastre um fornecedor (aba Contas e fornecedores) para importar o catálogo dele.</div>;
  }

  return (
    <div className="space-y-4 text-xs">
      {/* Cabecalho */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-end gap-3 justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="font-bold text-slate-700 block">Fornecedor</span>
            <select value={supplierId} onChange={event => changeSupplier(event.target.value)} className="border border-slate-200 rounded-lg p-2 bg-slate-50 min-w-56">
              {suppliers.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
          <div className="text-slate-500 pb-2">
            {catalog?.importedAt
              ? <>Catálogo: <strong>{items.filter(item => item.isActive).length} itens</strong> · {catalog.fileName} · {new Date(catalog.importedAt).toLocaleDateString('pt-BR')}</>
              : 'Ainda sem catálogo: importe a planilha de preços do fornecedor.'}
          </div>
        </div>
        <div className="flex gap-2">
          <input ref={fileInput} type="file" accept=".xlsx,.xls,.xlsm,.csv" className="hidden" onChange={event => void handleFile(event.target.files?.[0])} />
          <button type="button" onClick={() => fileInput.current?.click()} className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg flex items-center gap-1.5">
            <Upload className="w-4 h-4" />{catalog ? 'Importar nova planilha' : 'Importar planilha'}
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        {([['catalogo', 'Catálogo e pedido'], ['pedidos', `Pedidos (${orders.length})`]] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)} className={`px-4 py-2 rounded-lg font-bold border ${tab === key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`}>{label}</button>
        ))}
      </div>

      {message && (
        <div className={`p-3 rounded-lg border flex justify-between gap-2 ${message.kind === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Fechar aviso"><X className="w-4 h-4" /></button>
        </div>
      )}

      {tab === 'catalogo' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
          {/* Catalogo */}
          <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="p-3 border-b border-slate-100 flex flex-wrap gap-2 items-center">
              <div className="relative flex-1 min-w-48">
                <Search className="w-4 h-4 text-slate-400 absolute left-2 top-2" />
                <input value={search} onChange={event => { setSearch(event.target.value); setVisible(PAGE_SIZE); }} placeholder="Buscar por nome ou código" className="w-full border border-slate-200 rounded-lg p-1.5 pl-8" />
              </div>
              <select value={brand} onChange={event => { setBrand(event.target.value); setType(''); setVisible(PAGE_SIZE); }} className="border border-slate-200 rounded-lg p-1.5 bg-white">
                <option value="">Todas as marcas</option>
                {brands.map(entry => <option key={entry} value={entry}>{entry} ({items.filter(item => item.brand === entry && item.isActive).length})</option>)}
              </select>
              <select value={type} onChange={event => { setType(event.target.value); setVisible(PAGE_SIZE); }} className="border border-slate-200 rounded-lg p-1.5 bg-white">
                <option value="">Todos os tipos</option>
                {types.map(entry => <option key={entry} value={entry}>{entry}</option>)}
              </select>
              <label className="flex items-center gap-1 font-bold text-slate-600"><input type="checkbox" checked={onlyLaunches} onChange={event => setOnlyLaunches(event.target.checked)} />Lançamentos</label>
              <label className="flex items-center gap-1 text-slate-500"><input type="checkbox" checked={showRemoved} onChange={event => setShowRemoved(event.target.checked)} />Fora da lista</label>
            </div>
            {loading ? (
              <p className="p-6 text-slate-400">Carregando catálogo...</p>
            ) : filtered.length === 0 ? (
              <p className="p-6 text-slate-400">{items.length ? 'Nenhum item neste filtro.' : 'Sem itens. Importe a planilha do fornecedor.'}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 text-left">
                    <tr><th className="p-2">Código</th><th className="p-2">Produto</th><th className="p-2">Marca / tipo</th><th className="p-2 text-right">Custo</th><th className="p-2">Seu estoque</th><th className="p-2 text-right">Pedir</th></tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, visible).map(item => {
                      const stock = stockOf(item.productId);
                      const linked = productById(item.productId);
                      const zero = !(item.unitCost > 0);
                      return (
                        <tr key={item.id} className={`border-t border-slate-100 ${item.isActive ? '' : 'opacity-50'}`}>
                          <td className="p-2 font-mono whitespace-nowrap">{item.supplierCode}</td>
                          <td className="p-2">
                            {item.name}
                            <span className="ml-1 inline-flex gap-1">
                              {isLaunch(item.status) && <span className="text-[9px] font-bold text-blue-700 bg-blue-50 px-1 rounded">LANÇAMENTO</span>}
                              {zero && <span className="text-[9px] font-bold text-amber-700 bg-amber-50 px-1 rounded">PREÇO A CONFIRMAR</span>}
                              {!item.isActive && <span className="text-[9px] font-bold text-slate-600 bg-slate-100 px-1 rounded">SAIU DA LISTA</span>}
                            </span>
                          </td>
                          <td className="p-2 whitespace-nowrap"><strong>{item.brand || '—'}</strong><span className="block text-slate-500">{item.productType}</span></td>
                          <td className="p-2 text-right font-mono whitespace-nowrap">
                            {zero ? '—' : formatMoney(item.unitCost)}
                            {item.previousCost != null && item.previousCost > 0 && (
                              <span className={`block text-[10px] ${item.unitCost > item.previousCost ? 'text-rose-600' : 'text-emerald-600'}`}>
                                {item.unitCost > item.previousCost ? '▲' : '▼'} {Math.abs(((item.unitCost - item.previousCost) / item.previousCost) * 100).toFixed(1)}%
                              </span>
                            )}
                          </td>
                          <td className="p-2 whitespace-nowrap">
                            {stock ? (
                              <button type="button" onClick={() => setLinking(item)} className="text-left" title={`${linked?.name || ''}\n${stock.perStore.map(entry => `${entry.store.tradeName || entry.store.unitId}: ${entry.qty}`).join('\n')}`}>
                                <span className={`font-bold ${stock.total === 0 ? 'text-rose-600' : 'text-slate-800'}`}>{stock.total} un</span>
                                <span className="block text-[10px] text-slate-500">{stock.perStore.map(entry => `${(entry.store.tradeName || entry.store.unitId).split(' ').slice(-2).join(' ')}: ${entry.qty}`).join(' · ')}</span>
                              </button>
                            ) : (
                              <button type="button" onClick={() => setLinking(item)} className="text-blue-700 font-bold flex items-center gap-1 hover:underline"><Link2 className="w-3.5 h-3.5" />Ligar</button>
                            )}
                          </td>
                          <td className="p-2">
                            <div className="flex justify-end items-center gap-1">
                              <input
                                type="number"
                                min={1}
                                value={quantities[item.id] || ''}
                                placeholder="1"
                                onChange={event => setQuantities(previous => ({ ...previous, [item.id]: Math.max(0, Math.floor(Number(event.target.value) || 0)) }))}
                                onKeyDown={event => event.key === 'Enter' && addToCart(item, quantities[item.id] || 1)}
                                className="w-14 border border-slate-200 rounded p-1 text-right"
                              />
                              <button type="button" disabled={!item.isActive} onClick={() => addToCart(item, quantities[item.id] || 1)} className="p-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded" title="Adicionar ao pedido"><Plus className="w-3.5 h-3.5" /></button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filtered.length > visible && (
                  <button type="button" onClick={() => setVisible(previous => previous + PAGE_SIZE)} className="w-full p-3 text-blue-700 font-bold border-t border-slate-100 hover:bg-slate-50">
                    Mostrar mais ({filtered.length - visible} restantes)
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Pedido em montagem */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3 xl:sticky xl:top-4">
            <h3 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
              <ShoppingCart className="w-4 h-4 text-blue-600" />
              {editingOrder ? `Editando pedido nº ${editingOrder.orderNumber}` : 'Pedido de compra'}
            </h3>
            {cart.length === 0 ? (
              <p className="text-slate-400">Adicione itens do catálogo. O pedido pode juntar várias marcas deste fornecedor.</p>
            ) : (
              <div className="space-y-3 max-h-[50vh] overflow-auto pr-1">
                {cartByBrand.map(([brandName, lines]) => (
                  <div key={brandName} className="space-y-1">
                    <div className="font-bold text-slate-700 bg-slate-50 px-2 py-1 rounded">{brandName}</div>
                    {lines.map(line => {
                      const zero = !(line.item.unitCost > 0);
                      return (
                        <div key={line.item.id} className={`flex items-center gap-2 p-1.5 rounded ${zero ? 'bg-amber-50 border border-amber-200' : ''}`}>
                          <div className="flex-1 min-w-0">
                            <span className="block truncate" title={line.item.name}>{line.item.name}</span>
                            <span className={`text-[10px] ${zero ? 'text-amber-700 font-bold' : 'text-slate-500'}`}>{zero ? 'Preço a confirmar' : `${formatMoney(line.item.unitCost)} · ${formatMoney(line.item.unitCost * line.quantity)}`}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => setCart(previous => previous.map(entry => entry.item.id === line.item.id ? { ...entry, quantity: Math.max(1, entry.quantity - 1) } : entry))} className="p-1 border border-slate-200 rounded"><Minus className="w-3 h-3" /></button>
                            <input type="number" min={1} value={line.quantity} onChange={event => setCart(previous => previous.map(entry => entry.item.id === line.item.id ? { ...entry, quantity: Math.max(1, Math.floor(Number(event.target.value) || 1)) } : entry))} className="w-12 border border-slate-200 rounded p-1 text-center" />
                            <button type="button" onClick={() => setCart(previous => previous.map(entry => entry.item.id === line.item.id ? { ...entry, quantity: entry.quantity + 1 } : entry))} className="p-1 border border-slate-200 rounded"><Plus className="w-3 h-3" /></button>
                            <button type="button" onClick={() => setCart(previous => previous.filter(entry => entry.item.id !== line.item.id))} className="p-1 text-rose-600" title="Remover"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            {pendingInCart > 0 && (
              <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 flex gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" />{pendingInCart} item(ns) com preço a confirmar: não entram no total.</p>
            )}
            <div className="flex justify-between font-bold text-sm border-t border-slate-100 pt-2"><span>Total</span><span>{formatMoney(cartTotal)}</span></div>
            <label className="block space-y-1">
              <span className="font-bold text-slate-700">Entregar na loja</span>
              <select value={deliveryStore} onChange={event => setDeliveryStore(event.target.value)} className="w-full border border-slate-200 rounded-lg p-2 bg-slate-50">
                {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-bold text-slate-700">Observação</span>
              <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} className="w-full border border-slate-200 rounded-lg p-2" placeholder="Ex.: forma de pagamento, prazo de entrega" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={saving || !cart.length} onClick={() => void saveOrder(false)} className="py-2 border border-slate-300 rounded-lg font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Salvar rascunho</button>
              <button type="button" disabled={saving || !cart.length} onClick={() => void saveOrder(true)} className="py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-bold disabled:opacity-40 flex items-center justify-center gap-1"><Printer className="w-4 h-4" />Finalizar e PDF</button>
            </div>
            {editingOrder && (
              <button type="button" onClick={() => { setCart([]); setEditingOrder(null); setNotes(''); }} className="w-full text-slate-500 hover:underline">Descartar alterações</button>
            )}
          </div>
        </div>
      )}

      {tab === 'pedidos' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          {orders.length === 0 ? (
            <p className="p-6 text-slate-400">Nenhum pedido ainda.</p>
          ) : (
            <table className="w-full">
              <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 text-left">
                <tr><th className="p-2">Nº</th><th className="p-2">Data</th><th className="p-2">Fornecedor</th><th className="p-2">Entregar em</th><th className="p-2">Itens</th><th className="p-2 text-right">Total</th><th className="p-2">Situação</th><th className="p-2 text-right">Ações</th></tr>
              </thead>
              <tbody>
                {orders.map(order => {
                  const orderSupplier = suppliers.find(entry => entry.id === order.supplierId);
                  const pending = order.items.filter(item => item.pricePending).length;
                  return (
                    <tr key={order.id} className="border-t border-slate-100">
                      <td className="p-2 font-bold">{order.orderNumber}</td>
                      <td className="p-2 whitespace-nowrap">{new Date(order.createdAt).toLocaleDateString('pt-BR')}</td>
                      <td className="p-2">{orderSupplier?.name || order.supplierId}</td>
                      <td className="p-2">{storeById(order.unitId)?.tradeName || order.unitId}</td>
                      <td className="p-2">{order.items.length}{pending > 0 && <span className="ml-1 text-[9px] font-bold text-amber-700 bg-amber-50 px-1 rounded">{pending} a confirmar</span>}</td>
                      <td className="p-2 text-right font-mono">{formatMoney(order.total)}</td>
                      <td className="p-2">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${order.status === 'ENVIADO' ? 'bg-emerald-50 text-emerald-700' : order.status === 'CANCELADO' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-700'}`}>{STATUS_LABELS[order.status]}</span>
                      </td>
                      <td className="p-2">
                        <div className="flex justify-end gap-2 whitespace-nowrap">
                          <button type="button" onClick={() => printPurchaseOrder(order, orderSupplier, storeById(order.unitId))} className="text-blue-700 font-bold hover:underline flex items-center gap-1"><FileSpreadsheet className="w-3.5 h-3.5" />PDF</button>
                          {order.status === 'RASCUNHO' && (
                            <>
                              <button type="button" onClick={() => { if (order.supplierId !== supplierId) changeSupplier(order.supplierId); editOrder(order); }} disabled={order.supplierId !== supplierId} title={order.supplierId !== supplierId ? 'Escolha este fornecedor no topo para editar' : undefined} className="text-slate-700 font-bold hover:underline disabled:opacity-40">Editar</button>
                              <button type="button" onClick={() => void changeStatus(order, 'ENVIADO')} className="text-emerald-700 font-bold hover:underline">Marcar enviado</button>
                            </>
                          )}
                          {order.status !== 'CANCELADO' && <button type="button" onClick={() => void changeStatus(order, 'CANCELADO')} className="text-rose-600 font-bold hover:underline">Cancelar</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {importing && supplier && (
        <CatalogImportModal
          supplierName={supplier.name}
          fileName={importing.fileName}
          workbook={importing.workbook}
          savedConfig={catalog?.readingConfig ?? null}
          existingItems={items}
          onCancel={() => setImporting(null)}
          onImport={handleImport}
        />
      )}

      {linking && (
        <LinkProductModal
          item={linking}
          products={products}
          currentProductId={linking.productId}
          onClose={() => setLinking(null)}
          onLink={productId => void handleLink(linking, productId)}
        />
      )}
    </div>
  );
}

function LinkProductModal({ item, products, currentProductId, onClose, onLink }: {
  item: SupplierCatalogItem;
  products: Product[];
  currentProductId: string | null;
  onClose: () => void;
  onLink: (productId: string | null) => void;
}) {
  const [term, setTerm] = useState('');
  const suggestions = useMemo(() => suggestProducts(item.name, products), [item, products]);
  const results = term.trim()
    ? products.filter(product => product.name.toLowerCase().includes(term.trim().toLowerCase()) || product.sku.toLowerCase().includes(term.trim().toLowerCase())).slice(0, 20)
    : suggestions;
  const current = products.find(product => product.id === currentProductId);
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg text-xs">
        <div className="p-4 border-b border-slate-100 flex justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-slate-900">Ligar ao seu produto</h2>
            <p className="text-slate-500">{item.name}</p>
            <p className="text-slate-400 mt-1">A ligação só mostra o seu estoque ao lado do item. Não muda nada no pedido nem no cadastro.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar"><X className="w-5 h-5 text-slate-400" /></button>
        </div>
        <div className="p-4 space-y-3">
          {current && (
            <div className="flex justify-between items-center bg-emerald-50 border border-emerald-200 rounded p-2">
              <span>Ligado a <strong>{current.name}</strong> ({current.sku})</span>
              <button type="button" onClick={() => onLink(null)} className="text-rose-600 font-bold hover:underline">Desligar</button>
            </div>
          )}
          <input autoFocus value={term} onChange={event => setTerm(event.target.value)} placeholder="Buscar no seu cadastro (nome ou código)" className="w-full border border-slate-200 rounded-lg p-2" />
          <p className="text-[10px] font-bold uppercase text-slate-500">{term.trim() ? 'Resultados' : 'Sugestões pelo nome'}</p>
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg max-h-72 overflow-auto">
            {results.length === 0 && <p className="p-3 text-slate-400">Nenhum produto parecido. Busque pelo nome ou código.</p>}
            {results.map(product => (
              <button key={product.id} type="button" onClick={() => onLink(product.id)} className="w-full text-left p-2 hover:bg-blue-50 flex justify-between gap-2">
                <span>{product.name}</span>
                <span className="font-mono text-slate-400">{product.sku}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
