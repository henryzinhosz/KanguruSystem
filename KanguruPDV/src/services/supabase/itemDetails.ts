import { supabase } from './client';

// Pecas do PC montado (orcamento convertido) para imprimir abaixo do item no cupom e no DANFE.
// Carregado logo antes de imprimir; sem internet o mapa fica vazio e o cupom sai sem as pecas.

let bySku = new Map<string, string>();

export async function loadItemDetails(skus: string[]): Promise<void> {
  const unique = Array.from(new Set(skus.filter(Boolean)));
  if (unique.length === 0) return;
  try {
    const { data, error } = await supabase.rpc('get_pos_item_invoice_details', { p_skus: unique });
    if (error) return;
    const next = new Map(bySku);
    for (const row of (data ?? []) as { sku: string; details: string }[]) next.set(row.sku, row.details);
    bySku = next;
  } catch {
    // sem conexao: imprime sem as pecas
  }
}

export function itemDetails(sku: string): string | null {
  return bySku.get(sku) ?? null;
}
