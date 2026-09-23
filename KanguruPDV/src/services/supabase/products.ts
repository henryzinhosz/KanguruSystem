import { supabase } from './client';

export interface PosProduct {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  sellPrice: number;
  availableQuantity: number;
  warrantyMonths: number | null;
  requiresUnitSelection: boolean;
}

export interface PosSerialUnit {
  serialUnitId: string;
  serialNumber: string;
  imei: string | null;
}

interface PosProductRow {
  product_id: string;
  sku: string;
  name: string;
  brand: string | null;
  sell_price: number | string;
  available_quantity: number | string;
  warranty_months: number | string | null;
  requires_unit_selection: boolean | null;
}

interface PosSerialUnitRow {
  serial_unit_id?: string;
  id?: string;
  serial_number: string;
  imei: string | null;
}

export async function searchPosProducts(query: string): Promise<PosProduct[]> {
  const { data, error } = await supabase.rpc('search_pos_products', { p_query: query });
  if (error) {
    throw error;
  }

  return ((data ?? []) as PosProductRow[]).map((product) => ({
    id: product.product_id,
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    sellPrice: Number(product.sell_price),
    availableQuantity: Number(product.available_quantity),
    warrantyMonths: product.warranty_months === null ? null : Number(product.warranty_months),
    requiresUnitSelection: product.requires_unit_selection === true,
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