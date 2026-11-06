import { supabase } from './client';

// Garantia de cada produto em dias ou meses (migration 20261121). Fica em memoria e numa
// copia local (localStorage) para funcionar sem internet e na hora de imprimir o cupom.
// Sem a migration (ou sem conexao) o mapa fica vazio e tudo continua usando os meses.

export interface ProductWarranty {
  days: number | null;
  months: number;
}

const STORAGE_KEY = 'kanguru.productWarranties';
let bySku = new Map<string, ProductWarranty>();
let byProductId = new Map<string, ProductWarranty>();

function store(rows: { productId: string; sku: string; days: number | null; months: number }[]) {
  bySku = new Map(rows.map((row) => [row.sku.toUpperCase(), { days: row.days, months: row.months }]));
  byProductId = new Map(rows.map((row) => [row.productId, { days: row.days, months: row.months }]));
}

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) store(JSON.parse(saved));
} catch {
  // sem copia local: espera a primeira carga
}

export async function loadProductWarranties(): Promise<void> {
  const { data, error } = await supabase.rpc('get_pos_product_warranties');
  if (error) return;
  const rows = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    productId: String(row.product_id),
    sku: String(row.sku ?? ''),
    days: row.warranty_days == null ? null : Number(row.warranty_days),
    months: Number(row.warranty_months ?? 0),
  }));
  store(rows);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // sem armazenamento: so fica em memoria
  }
}

export function findProductWarranty(key: { productId?: string | null; sku?: string | null }): ProductWarranty | null {
  if (key.productId && byProductId.has(key.productId)) return byProductId.get(key.productId) ?? null;
  if (key.sku && bySku.has(key.sku.toUpperCase())) return bySku.get(key.sku.toUpperCase()) ?? null;
  return null;
}

// Texto da garantia: dias tem prioridade; senao os meses informados (ou os do mapa).
export function warrantyText(days: number | null | undefined, months: number | null | undefined): string {
  if (days && days > 0) return `${days} ${days === 1 ? 'dia' : 'dias'}`;
  if (months && months > 0) return `${months} ${months === 1 ? 'mês' : 'meses'}`;
  return 'sem garantia';
}

// Fim da garantia a partir da data da venda (vale ate o fim desse dia).
export function warrantyEndDate(saleDate: string, days: number | null | undefined, months: number): Date | null {
  const end = new Date(saleDate);
  if (days && days > 0) end.setDate(end.getDate() + days);
  else if (months > 0) end.setMonth(end.getMonth() + months);
  else return null;
  end.setHours(23, 59, 59, 999);
  return end;
}
