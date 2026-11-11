import { supabase } from './client';

// Orcamento de PC pelo PDV com a sessao do terminal. Etapa 1: nao gera venda nem mexe no estoque.

export const PART_TYPES = [
  'Processador', 'Placa-mãe', 'Memória RAM', 'SSD', 'HD', 'Placa de vídeo', 'Fonte', 'Gabinete',
  'Cooler', 'Monitor', 'Periférico', 'Montagem', 'Outro',
];

export type QuoteKind = 'QUOTE' | 'TEMPLATE';

export interface QuoteLine {
  source: 'TYPED' | 'STOCK';
  partType: string;
  description: string;
  productId: string | null;
  sku: string | null;
  quantity: number;
  unitCost: number | null;
  marginPercent: number | null;
  unitPrice: number;
  lineTotal: number;
}

export interface QuoteRecord {
  quoteId: string;
  kind: QuoteKind;
  quoteNumber: number | null;
  status: 'ABERTO' | 'CANCELADO';
  title: string;
  customerName: string | null;
  customerPhone: string | null;
  validUntil: string | null;
  isExpired: boolean;
  installmentMarkup: number;
  items: QuoteLine[];
  totalCost: number;
  totalPrice: number;
  sellerCode: string | null;
  sellerName: string | null;
  marginApproved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteSettings {
  minMargin: number;
  installmentMarkup: number;
  validDays: number;
}

export interface PartSuggestion {
  source: 'COTACAO' | 'FORNECEDOR';
  name: string;
  partType: string | null;
  cost: number;
  date: string;
  supplier: string | null;
}

export interface SaveQuoteInput {
  quoteId: string | null;
  kind: QuoteKind;
  title: string;
  customerName: string;
  customerPhone: string;
  sellerCode: string | null;
  validUntil: string | null;
  installmentMarkup: number;
  items: Array<Pick<QuoteLine, 'partType' | 'description' | 'productId' | 'quantity' | 'unitCost' | 'unitPrice'>>;
  adminPassword: string | null;
}

export type SaveQuoteResult =
  | { status: 'OK'; quote: QuoteRecord }
  | { status: 'PASSWORD_REQUIRED'; minMargin: number }
  | { status: 'INVALID'; remainingAttempts: number }
  | { status: 'LOCKED'; lockedUntil: string }
  | { status: 'INVALID_SELLER' };

function mapQuote(row: QuoteRecord): QuoteRecord {
  return {
    ...row,
    installmentMarkup: Number(row.installmentMarkup),
    totalCost: Number(row.totalCost),
    totalPrice: Number(row.totalPrice),
    items: (row.items ?? []).map((line) => ({
      ...line,
      quantity: Number(line.quantity),
      unitCost: line.unitCost == null ? null : Number(line.unitCost),
      marginPercent: line.marginPercent == null ? null : Number(line.marginPercent),
      unitPrice: Number(line.unitPrice),
      lineTotal: Number(line.lineTotal),
    })),
  };
}

export async function getQuoteSettings(): Promise<QuoteSettings> {
  const { data, error } = await supabase.rpc('get_pos_quote_settings');
  if (error) throw error;
  const row = data as QuoteSettings;
  return { minMargin: Number(row.minMargin), installmentMarkup: Number(row.installmentMarkup), validDays: Number(row.validDays) };
}

export async function listQuotes(kind: QuoteKind, query: string): Promise<QuoteRecord[]> {
  const { data, error } = await supabase.rpc('list_pos_quotes', { p_kind: kind, p_query: query.trim() || null });
  if (error) throw error;
  return ((data ?? []) as QuoteRecord[]).map(mapQuote);
}

export async function saveQuote(input: SaveQuoteInput): Promise<SaveQuoteResult> {
  const { data, error } = await supabase.rpc('save_pos_quote', {
    p_quote_id: input.quoteId,
    p_kind: input.kind,
    p_title: input.title,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    p_seller_code: input.sellerCode,
    p_valid_until: input.validUntil,
    p_installment_markup: input.installmentMarkup,
    p_items: input.items,
    p_admin_password: input.adminPassword,
  });
  if (error) throw error;
  const result = data as SaveQuoteResult;
  return result.status === 'OK' ? { status: 'OK', quote: mapQuote(result.quote) } : result;
}

export async function cancelQuote(quoteId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_pos_quote', { p_quote_id: quoteId });
  if (error) throw error;
}

export async function searchPartSuggestions(query: string): Promise<PartSuggestion[]> {
  const { data, error } = await supabase.rpc('search_pos_quote_parts', { p_query: query });
  if (error) throw error;
  return ((data ?? []) as PartSuggestion[]).map((row) => ({ ...row, cost: Number(row.cost) }));
}
