import { supabase } from './client';

export interface PosCustomer {
  id: string;
  code: number;
  cpf: string;
  name: string;
  phone: string;
  email: string | null;
  cep: string | null;
  address: string | null;
  addressNumber: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  lgpdConsent: boolean;
  notes: string | null;
}

export type PosCustomerInput = Omit<PosCustomer, 'id' | 'code'> & { id: string | null };

interface PosCustomerRow {
  id: string;
  code: number;
  cpf: string;
  name: string;
  phone: string;
  email: string | null;
  cep: string | null;
  address: string | null;
  address_number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  lgpd_consent: boolean;
  notes: string | null;
}

function mapCustomer(row: PosCustomerRow): PosCustomer {
  return {
    id: row.id,
    code: Number(row.code),
    cpf: row.cpf,
    name: row.name,
    phone: row.phone,
    email: row.email,
    cep: row.cep,
    address: row.address,
    addressNumber: row.address_number,
    complement: row.complement,
    district: row.district,
    city: row.city,
    state: row.state,
    lgpdConsent: row.lgpd_consent,
    notes: row.notes,
  };
}

export async function searchPosCustomers(query: string): Promise<PosCustomer[]> {
  const { data, error } = await supabase.rpc('search_pos_customers', { p_query: query });
  if (error) throw error;
  return ((data ?? []) as PosCustomerRow[]).map(mapCustomer);
}

// Sem id: cadastra. Com id: corrige contato e endereco (CPF e nome so pelo ERP).
export async function savePosCustomer(input: PosCustomerInput): Promise<PosCustomer> {
  const { data, error } = await supabase.rpc('save_pos_customer', {
    p_customer_id: input.id,
    p_cpf: input.cpf,
    p_name: input.name,
    p_phone: input.phone,
    p_email: input.email,
    p_cep: input.cep,
    p_address: input.address,
    p_address_number: input.addressNumber,
    p_complement: input.complement,
    p_district: input.district,
    p_city: input.city,
    p_state: input.state,
    p_lgpd_consent: input.lgpdConsent,
    p_notes: input.notes,
  });
  if (error) throw error;
  const row = ((data ?? []) as PosCustomerRow[])[0];
  if (!row) throw new Error('Não foi possível salvar o cliente.');
  return mapCustomer(row);
}

export interface CepAddress {
  address: string;
  district: string;
  city: string;
  state: string;
}

// Endereco pelo CEP (ViaCEP, servico publico gratuito). Nulo se o CEP nao existir.
export async function lookupCep(cep: string): Promise<CepAddress | null> {
  const digits = cep.replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const response = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
  if (!response.ok) return null;
  const data = await response.json() as { erro?: boolean; logradouro?: string; bairro?: string; localidade?: string; uf?: string };
  if (data.erro) return null;
  return {
    address: data.logradouro ?? '',
    district: data.bairro ?? '',
    city: data.localidade ?? '',
    state: data.uf ?? '',
  };
}

export interface PosWarrantyLine {
  saleId: string;
  saleDate: string;
  invoiceNumber: string;
  storeName: string;
  sellerName: string | null;
  customerName: string | null;
  customerCpf: string | null;
  itemName: string;
  itemSku: string;
  quantity: number;
  serialNumber: string | null;
  warrantyMonths: number;
  saleStatus: string;
}

// Garantia por serial, IMEI ou CPF (vendas de qualquer loja do franqueado).
export async function findPosWarranty(query: string): Promise<PosWarrantyLine[]> {
  const { data, error } = await supabase.rpc('find_pos_warranty', { p_query: query });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    saleId: String(row.sale_id),
    saleDate: String(row.sale_date),
    invoiceNumber: String(row.invoice_number ?? ''),
    storeName: String(row.store_name ?? ''),
    sellerName: (row.seller_name as string | null) ?? null,
    customerName: (row.customer_name as string | null) ?? null,
    customerCpf: (row.customer_cpf as string | null) ?? null,
    itemName: String(row.item_name ?? ''),
    itemSku: String(row.item_sku ?? ''),
    quantity: Number(row.quantity ?? 1),
    serialNumber: (row.serial_number as string | null) ?? null,
    warrantyMonths: Number(row.warranty_months ?? 0),
    saleStatus: String(row.sale_status ?? ''),
  }));
}
