import { supabase } from './client';

export interface PosSeller {
  code: string;
  name: string;
}

// Codigo de vendedor: 2 digitos (01 a 99). Aceita "7" e completa para "07".
export function normalizeSellerCode(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[0-9]{1,2}$/.test(trimmed)) return null;
  const padded = trimmed.padStart(2, '0');
  return padded === '00' ? null : padded;
}

// Vendedor ativo da loja deste terminal, com permissao de vender; null se nao existir.
export async function findPosSeller(code: string): Promise<PosSeller | null> {
  const normalized = normalizeSellerCode(code);
  if (!normalized) return null;
  const { data, error } = await supabase.rpc('find_pos_seller', { p_code: normalized });
  if (error) throw error;
  const row = (data as Array<{ seller_code: string; seller_name: string }> | null)?.[0];
  return row ? { code: row.seller_code, name: row.seller_name } : null;
}
