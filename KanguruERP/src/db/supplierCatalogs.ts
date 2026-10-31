import { supabase } from './supabaseClient';
import type { CatalogReadingConfig, ParsedCatalogItem } from './supplierCatalogParser';

// Catalogo de fornecedores e pedidos de compra (migration 20261112).
// Leitura direta (RLS da empresa); toda escrita passa pelas RPCs.

export interface SupplierCatalog {
  id: string;
  supplierId: string;
  readingConfig: CatalogReadingConfig | null;
  fileName: string | null;
  importedAt: string | null;
  importedByName: string | null;
}

export interface SupplierCatalogItem {
  id: string;
  catalogId: string;
  itemKey: string;
  supplierCode: string;
  name: string;
  brand: string;
  productType: string;
  status: string;
  sheetName: string;
  unitCost: number;
  previousCost: number | null;
  isActive: boolean;
  productId: string | null;
}

export type PurchaseOrderStatus = 'RASCUNHO' | 'ENVIADO' | 'CANCELADO';

export interface PurchaseOrderItem {
  catalogItemId: string | null;
  supplierCode: string;
  name: string;
  brand: string;
  productType: string;
  unitCost: number;
  quantity: number;
  pricePending: boolean;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  orderNumber: number;
  unitId: string;
  status: PurchaseOrderStatus;
  notes: string;
  total: number;
  createdByName: string;
  createdAt: string;
  sentAt: string | null;
  items: PurchaseOrderItem[];
}

export interface CatalogImportResult {
  catalogId: string;
  total: number;
  new: number;
  priceChanged: number;
  removed: number;
}

const PAGE = 1000;

export async function listSupplierCatalogs(): Promise<SupplierCatalog[]> {
  const { data, error } = await supabase
    .from('supplier_catalogs')
    .select('id, supplier_id, reading_config, file_name, imported_at, imported_by_name');
  if (error) throw error;
  return (data || []).map(row => ({
    id: row.id,
    supplierId: row.supplier_id,
    readingConfig: (row.reading_config && Object.keys(row.reading_config).length ? row.reading_config : null) as CatalogReadingConfig | null,
    fileName: row.file_name,
    importedAt: row.imported_at,
    importedByName: row.imported_by_name,
  }));
}

export async function listSupplierCatalogItems(catalogId: string): Promise<SupplierCatalogItem[]> {
  const items: SupplierCatalogItem[] = [];
  // Lista grande: busca em paginas de 1000 (limite padrao do Supabase).
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('supplier_catalog_items')
      .select('id, catalog_id, item_key, supplier_code, name, brand, product_type, status, sheet_name, unit_cost, previous_cost, is_active, product_id')
      .eq('catalog_id', catalogId)
      .order('brand', { ascending: true })
      .order('name', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    (data || []).forEach(row => items.push({
      id: row.id,
      catalogId: row.catalog_id,
      itemKey: row.item_key,
      supplierCode: row.supplier_code || '',
      name: row.name,
      brand: row.brand || '',
      productType: row.product_type || '',
      status: row.status || '',
      sheetName: row.sheet_name || '',
      unitCost: Number(row.unit_cost),
      previousCost: row.previous_cost == null ? null : Number(row.previous_cost),
      isActive: row.is_active,
      productId: row.product_id,
    }));
    if (!data || data.length < PAGE) break;
  }
  return items;
}

export async function importSupplierCatalog(
  supplierId: string,
  fileName: string,
  config: CatalogReadingConfig,
  items: ParsedCatalogItem[]
): Promise<CatalogImportResult> {
  const { data, error } = await supabase.rpc('import_supplier_catalog', {
    p_supplier_id: supplierId,
    p_file_name: fileName,
    p_config: config,
    p_items: items.map(item => ({
      key: item.key,
      code: item.code,
      name: item.name,
      brand: item.brand,
      type: item.type,
      status: item.status,
      sheet: item.sheet,
      cost: item.cost,
      priceDetails: item.priceDetails,
    })),
  });
  if (error) throw error;
  return data as CatalogImportResult;
}

export async function linkSupplierCatalogItem(itemId: string, productId: string | null): Promise<void> {
  const { error } = await supabase.rpc('link_supplier_catalog_item', { p_item_id: itemId, p_product_id: productId });
  if (error) throw error;
}

export async function listPurchaseOrders(): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, supplier_id, order_number, unit_id, status, notes, total, created_by_name, created_at, sent_at, purchase_order_items(catalog_item_id, position, supplier_code, name, brand, product_type, unit_cost, quantity, price_pending)')
    .order('order_number', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data || []).map(row => ({
    id: row.id,
    supplierId: row.supplier_id,
    orderNumber: row.order_number,
    unitId: row.unit_id,
    status: row.status as PurchaseOrderStatus,
    notes: row.notes || '',
    total: Number(row.total),
    createdByName: row.created_by_name || '',
    createdAt: row.created_at,
    sentAt: row.sent_at,
    items: ((row.purchase_order_items || []) as any[])
      .sort((a, b) => a.position - b.position)
      .map(item => ({
        catalogItemId: item.catalog_item_id,
        supplierCode: item.supplier_code || '',
        name: item.name,
        brand: item.brand || '',
        productType: item.product_type || '',
        unitCost: Number(item.unit_cost),
        quantity: item.quantity,
        pricePending: item.price_pending,
      })),
  }));
}

export async function savePurchaseOrder(order: {
  id: string | null;
  supplierId: string;
  unitId: string;
  notes: string;
  items: { catalogItemId: string; quantity: number }[];
  send: boolean;
}): Promise<{ id: string; orderNumber: number }> {
  const { data, error } = await supabase.rpc('save_purchase_order', {
    p_order_id: order.id,
    p_supplier_id: order.supplierId,
    p_unit_id: order.unitId,
    p_notes: order.notes,
    p_items: order.items,
    p_send: order.send,
  });
  if (error) throw error;
  return data as { id: string; orderNumber: number };
}

export async function setPurchaseOrderStatus(orderId: string, status: 'ENVIADO' | 'CANCELADO'): Promise<void> {
  const { error } = await supabase.rpc('set_purchase_order_status', { p_order_id: orderId, p_status: status });
  if (error) throw error;
}
