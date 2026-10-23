import { supabase } from './client';

export interface PosCatalogItem {
  id: string;
  itemType: 'PRODUCT' | 'SERVICE';
  sku: string;
  name: string;
  brand: string | null;
  sellPrice: number;
  availableQuantity: number;
  warrantyMonths: number | null;
  requiresUnitSelection: boolean;
  maxItemDiscountPercent: number;
  // Sem estoque nesta loja: nomes das outras lojas que tem o produto.
  storesWithStock: string[];
}

export interface PosSerialUnit {
  serialUnitId: string;
  serialNumber: string;
  imei: string | null;
}

interface PosCatalogItemRow {
  item_id: string;
  item_type: 'PRODUCT' | 'SERVICE';
  sku: string;
  name: string;
  brand: string | null;
  sell_price: number | string;
  available_quantity: number | string;
  warranty_months: number | string | null;
  requires_unit_selection: boolean | null;
  max_item_discount_percent: number | string;
  stores_with_stock?: string[] | null;
}

interface PosSerialUnitRow {
  serial_unit_id?: string;
  id?: string;
  serial_number: string;
  imei: string | null;
}

export async function searchPosItems(query: string): Promise<PosCatalogItem[]> {
  const { data, error } = await supabase.rpc('search_pos_items', { p_query: query });
  if (error) {
    throw error;
  }

  return ((data ?? []) as PosCatalogItemRow[]).map((item) => ({
    id: item.item_id,
    itemType: item.item_type,
    sku: item.sku,
    name: item.name,
    brand: item.brand,
    sellPrice: Number(item.sell_price),
    availableQuantity: Number(item.available_quantity),
    warrantyMonths: item.warranty_months === null ? null : Number(item.warranty_months),
    requiresUnitSelection: item.requires_unit_selection === true,
    maxItemDiscountPercent: Number(item.max_item_discount_percent ?? 0),
    storesWithStock: item.stores_with_stock ?? [],
  }));
}

export async function getPosAvailableSerialUnits(
  productId: string,
  unitId: string
): Promise<PosSerialUnit[]> {
  const { data, error } = await supabase.rpc('pdv_list_available_serial_units', {
    p_product_id: productId,
    p_unit_id: unitId,
  });
  if (error) {
    throw error;
  }

  return ((data ?? []) as PosSerialUnitRow[]).map((serialUnit) => {
    const serialUnitId = serialUnit.serial_unit_id ?? serialUnit.id;
    if (!serialUnitId) {
      throw new Error('A unidade serializada retornada nao possui identificador.');
    }

    return {
      serialUnitId,
      serialNumber: serialUnit.serial_number,
      imei: serialUnit.imei,
    };
  });
}
// Unidade pelo serial (ou IMEI) bipado. status: DISPONIVEL | VENDIDO | RESERVADO | PERDIDO | OUTRA_LOJA.
// serialUnit so vem quando a unidade esta disponivel nesta loja.
export interface PosScannedSerialUnit {
  product: PosCatalogItem;
  serialNumber: string;
  status: string;
  serialUnit: PosSerialUnit | null;
}

interface PosScannedSerialUnitRow extends PosCatalogItemRow {
  serial_unit_id: string | null;
  serial_number: string;
  imei: string | null;
  unit_status: string;
}

export async function findPosSerialUnit(code: string): Promise<PosScannedSerialUnit | null> {
  const { data, error } = await supabase.rpc('find_pos_serial_unit', { p_code: code });
  if (error) {
    throw error;
  }

  const row = ((data ?? []) as PosScannedSerialUnitRow[])[0];
  if (!row) return null;

  return {
    product: {
      id: row.item_id,
      itemType: row.item_type,
      sku: row.sku,
      name: row.name,
      brand: row.brand,
      sellPrice: Number(row.sell_price),
      availableQuantity: Number(row.available_quantity),
      warrantyMonths: row.warranty_months === null ? null : Number(row.warranty_months),
      requiresUnitSelection: row.requires_unit_selection === true,
      maxItemDiscountPercent: Number(row.max_item_discount_percent ?? 0),
      storesWithStock: [],
    },
    serialNumber: row.serial_number,
    status: row.unit_status,
    serialUnit: row.serial_unit_id
      ? { serialUnitId: row.serial_unit_id, serialNumber: row.serial_number, imei: row.imei }
      : null,
  };
}
