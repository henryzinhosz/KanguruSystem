import { supabase } from './client';
import type { PosCatalogItem } from './products';

// Peças avulsas - PC (migration 20261207): o banco cria um cadastro por peça com 1 unidade (custo
// a informar no ERP). Removida do carrinho ou venda descartada: descarta (zera e arquiva).

export const LOOSE_PART_TYPES = [
  'Processador', 'Placa-mãe', 'Memória RAM', 'SSD', 'HD', 'Placa de vídeo', 'Fonte', 'Gabinete', 'Cooler', 'Monitor',
] as const;

export interface LoosePartDraft {
  type: string;
  name: string;
  price: number;
  warrantyMonths: number;
}

export async function createPosLooseParts(parts: LoosePartDraft[]): Promise<PosCatalogItem[]> {
  const { data, error } = await supabase.rpc('create_pos_loose_parts', { p_parts: parts });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    itemType: 'PRODUCT' as const,
    sku: String(row.sku ?? ''),
    name: String(row.name),
    brand: null,
    sellPrice: Number(row.sellPrice),
    availableQuantity: Number(row.availableQuantity ?? 1),
    warrantyMonths: row.warrantyMonths == null ? null : Number(row.warrantyMonths),
    requiresUnitSelection: false,
    maxItemDiscountPercent: Number(row.maxItemDiscountPercent ?? 0),
    storesWithStock: [],
  }));
}

// Sem esperar: se falhar, a peça aparece no ERP como "não vendida" para descartar lá.
export function discardPosLooseParts(productIds: string[]): void {
  if (productIds.length === 0) return;
  void supabase.rpc('discard_pos_loose_parts', { p_product_ids: productIds });
}
