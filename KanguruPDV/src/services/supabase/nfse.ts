import { supabase } from './client';

// NFS-e Nacional dos servicos (migration 20261113, Edge Function nfse-emit).

export type NfseStatus = 'PENDENTE' | 'AUTORIZADA' | 'ERRO' | 'CANCELADA';

export interface PosNfseConfig {
  ready: boolean;
  environment: string | null;
  missing: string[];
}

export interface SaleServiceInvoice {
  id: string;
  saleId: string;
  status: NfseStatus;
  number: string | null;
  consultUrl: string | null;
  danfseUrl: string | null;
  amount: number;
  description: string;
  message: string | null;
  environment: string | null;
}

export interface SaleFiscalKinds {
  saleId: string;
  hasProducts: boolean;
  hasServices: boolean;
}

export interface NfseEmitResult {
  status: NfseStatus;
  invoices: { id?: string; status: NfseStatus; message?: string }[];
  message: string | null;
}

export async function getPosNfseStatus(): Promise<PosNfseConfig | null> {
  const { data, error } = await supabase.rpc('get_pos_nfse_status');
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    ready: row.ready === true,
    environment: (row.environment as string | null) ?? null,
    missing: Array.isArray(row.missing) ? (row.missing as unknown[]).map(String) : [],
  };
}

export async function getSaleServiceInvoices(saleIds: string[]): Promise<{ sales: SaleFiscalKinds[]; invoices: SaleServiceInvoice[] }> {
  if (saleIds.length === 0) return { sales: [], invoices: [] };
  const { data, error } = await supabase.rpc('get_pos_sale_service_invoices', { p_sale_ids: saleIds });
  if (error) throw error;
  const row = (data ?? {}) as { sales?: Record<string, unknown>[]; invoices?: Record<string, unknown>[] };
  return {
    sales: (row.sales ?? []).map((sale) => ({
      saleId: String(sale.saleId),
      hasProducts: sale.hasProducts === true,
      hasServices: sale.hasServices === true,
    })),
    invoices: (row.invoices ?? []).map((invoice) => ({
      id: String(invoice.id),
      saleId: String(invoice.saleId),
      status: invoice.status as NfseStatus,
      number: (invoice.number as string | null) ?? null,
      consultUrl: (invoice.consultUrl as string | null) ?? null,
      danfseUrl: (invoice.danfseUrl as string | null) ?? null,
      amount: Number(invoice.amount ?? 0),
      description: String(invoice.description ?? ''),
      message: (invoice.message as string | null) ?? null,
      environment: (invoice.environment as string | null) ?? null,
    })),
  };
}

async function invokeNfse(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('nfse-emit', { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const payload = context && typeof context.json === 'function' ? await context.json().catch(() => null) : null;
    if (payload?.error) throw new Error(String(payload.error));
    if (context?.status === 404) throw new Error('Serviço de NFS-e não encontrado no servidor (função nfse-emit não publicada).');
    throw new Error('Sem conexão com o serviço de NFS-e.');
  }
  return (data ?? {}) as Record<string, unknown>;
}

// Emite (ou consulta a pendente) as NFS-e dos servicos da venda.
export async function emitPosNfse(saleId: string): Promise<NfseEmitResult> {
  try {
    const row = await invokeNfse({ action: 'emit', saleId });
    const invoices = (Array.isArray(row.invoices) ? row.invoices : []) as NfseEmitResult['invoices'];
    const messages = invoices.map((invoice) => invoice.message).filter(Boolean);
    return {
      status: (row.status as NfseStatus) ?? 'ERRO',
      invoices,
      message: messages.length ? messages.join(' ') : (row.error as string | undefined) ?? null,
    };
  } catch (error) {
    return { status: 'ERRO', invoices: [], message: error instanceof Error ? error.message : 'Falha ao emitir a NFS-e.' };
  }
}

// PDF do DANFSe em base64 (baixado pelo servidor).
export async function fetchDanfsePdf(invoiceId: string): Promise<string> {
  const row = await invokeNfse({ action: 'pdf', invoiceId });
  if (!row.pdf) throw new Error(String(row.error ?? 'DANFSe indisponível.'));
  return String(row.pdf);
}
