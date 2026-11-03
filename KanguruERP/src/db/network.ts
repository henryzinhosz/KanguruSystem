import { supabase } from './supabaseClient';

// Painel da Rede (migration 20261115): a franqueadora acompanha as franquias, so leitura.

export type NetworkRole = 'OWNER' | 'MANAGER';

export interface NetworkAccess {
  networkId: string;
  networkName: string;
  role: NetworkRole;
  displayName: string;
  isActive: boolean;
}

export interface NetworkUser {
  authUid: string;
  displayName: string;
  role: NetworkRole;
  isActive: boolean;
  email: string;
  lastSignInAt?: string | null;
}

export interface NetworkStore {
  unitId: string;
  tradeName: string | null;
  legalName: string | null;
  cnpj: string | null;
  address: string | null;
  phone: string | null;
  activeTerminals: number;
  openCash: boolean;
  lastSaleAt: string | null;
}

export interface NetworkFranchise {
  tenantId: string;
  legalName: string;
  tradeName: string | null;
  cnpj: string;
  ownerName: string | null;
  ownerPhone: string | null;
  ownerEmail: string | null;
  subscriptionStatus: string;
  createdAt: string;
  stores: NetworkStore[];
}

export interface NetworkStoreMetrics {
  tenantId: string;
  unitId: string;
  storeName: string | null;
  salesCount: number;
  gross: number;
  returned: number;
  cost: number;
  fees: number;
  expenses: number;
  services: number;
  salesMissingCost: number;
}

export interface NetworkMonthlyRow {
  month: string; // AAAA-MM
  tenantId: string;
  unitId: string;
  revenue: number;
  salesCount: number;
}

export interface PlatformNetwork {
  id: string;
  name: string;
  tenants: number;
  tenantIds: string[];
  users: NetworkUser[];
}

export async function getMyNetworkAccess(): Promise<NetworkAccess | null> {
  const { data, error } = await supabase.rpc('get_my_network_access');
  if (error || !data) return null;
  return data as NetworkAccess;
}

export async function listNetworkFranchises(): Promise<NetworkFranchise[]> {
  const { data, error } = await supabase.rpc('network_list_franchises');
  if (error) throw error;
  return (data || []) as NetworkFranchise[];
}

export async function getNetworkStoreMetrics(from: Date, to: Date): Promise<NetworkStoreMetrics[]> {
  const { data, error } = await supabase.rpc('network_store_metrics', { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw error;
  return ((data || []) as NetworkStoreMetrics[]).map(row => ({
    ...row,
    salesCount: Number(row.salesCount),
    gross: Number(row.gross),
    returned: Number(row.returned),
    cost: Number(row.cost),
    fees: Number(row.fees),
    expenses: Number(row.expenses),
    services: Number(row.services),
    salesMissingCost: Number(row.salesMissingCost),
  }));
}

export async function getNetworkMonthlyRevenue(from: Date, to: Date): Promise<NetworkMonthlyRow[]> {
  const { data, error } = await supabase.rpc('network_monthly_revenue', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo',
  });
  if (error) throw error;
  return ((data || []) as NetworkMonthlyRow[]).map(row => ({ ...row, revenue: Number(row.revenue), salesCount: Number(row.salesCount) }));
}

export async function listNetworkUsers(): Promise<NetworkUser[]> {
  const { data, error } = await supabase.rpc('network_list_users');
  if (error) throw error;
  return (data || []) as NetworkUser[];
}

export async function manageNetworkUser(body: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase.functions.invoke('manage-network-users', { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const payload = context && typeof context.json === 'function' ? await context.json().catch(() => null) : null;
    throw new Error(payload?.error || 'Não foi possível concluir. Confira se a função manage-network-users foi publicada.');
  }
  if (data?.error) throw new Error(data.error);
}

// ---- UCP (SUPER_ADMIN) ----

export async function platformListNetworks(): Promise<PlatformNetwork[]> {
  const { data, error } = await supabase.rpc('platform_list_networks');
  if (error) throw error;
  return (data || []) as PlatformNetwork[];
}

export async function platformSaveNetwork(id: string | null, name: string): Promise<string> {
  const { data, error } = await supabase.rpc('platform_save_network', { p_id: id, p_name: name });
  if (error) throw error;
  return data as string;
}

export async function platformSetTenantNetwork(tenantId: string, networkId: string | null): Promise<void> {
  const { error } = await supabase.rpc('platform_set_tenant_network', { p_tenant_id: tenantId, p_network_id: networkId });
  if (error) throw error;
}

// ---- Ficha da franquia (etapa 2, migration 20261116) ----
// p_unit_id null = todas as lojas da franquia.

async function franchiseRpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw error;
  return data as T;
}

export interface FranchiseFinancial {
  payments: { method: string; amount: number }[];
  expenses: { category: string; amount: number; count: number }[];
  returns: { count: number; amount: number; byMethod: { method: string; amount: number }[] };
  daily: { day: string; revenue: number; salesCount: number }[];
}

export interface FranchiseProductRow {
  itemType: 'PRODUCT' | 'SERVICE';
  itemId: string;
  name: string;
  sku: string | null;
  category: string;
  brand: string | null;
  quantity: number;
  revenue: number;
  cost: number;
  missingCost: boolean;
}

export interface FranchiseStock {
  products: {
    productId: string;
    sku: string;
    name: string;
    category: string;
    brand: string | null;
    isSerialized: boolean;
    sellPrice: number;
    minStock: number | null;
    sold30: number;
    lastSaleAt: string | null;
    stores: { unitId: string; qty: number; costValue: number }[] | null;
  }[];
  counts: { id: string; unitId: string; countNumber: number; status: string; createdAt: string; approvedAt: string | null; createdByName: string | null }[];
}

export interface FranchiseSellerRow {
  sellerCode: string | null;
  sellerName: string;
  unitId: string;
  salesCount: number;
  revenue: number;
}

export interface FranchiseServices {
  byStatus: Record<string, number>;
  openedInPeriod: number;
  deliveredInPeriod: number;
  servicesRevenue: number;
  open: { orderNumber: number | null; unitId: string; status: string; equipment: string | null; customer: string | null; createdAt: string; expectedDate: string | null; paid: boolean; staffName: string | null; overdue: boolean }[];
}

export interface FranchiseOperations {
  terminals: { name: string; unitId: string; isActive: boolean; activatedAt: string | null; lastUnlockedAt: string | null }[];
  cashSessions: {
    unitId: string; cashNumber: string | null; status: string; openedAt: string; openedBy: string | null; closedAt: string | null; closedBy: string | null;
    openingFloat: number | null; expectedCash: number | null; countedCash: number | null; cashDifference: number | null; totalDifference: number;
    withdrawals: number; supplies: number;
  }[];
  fiscal: {
    unitId: string; storeName: string | null; configured: boolean; environment: string | null; municipalRegistration: boolean; cityCode: boolean;
    nfceAuthorized: number; nfceProblems: number; nfseAuthorized: number; nfseProblems: number;
  }[];
}

export interface FranchiseCustomers {
  totalCustomers: number;
  newCustomers: number;
  buyers: number;
  returningBuyers: number;
  repeatInPeriod: number;
  identifiedRevenue: number;
  top: { name: string | null; cpf: string | null; purchases: number; spent: number; lastPurchase: string; returning: boolean }[];
}

const range = (tenantId: string, unitId: string | null, from: Date, to: Date) => ({
  p_tenant_id: tenantId,
  p_unit_id: unitId,
  p_from: from.toISOString(),
  p_to: to.toISOString(),
});

export const getFranchiseFinancial = (tenantId: string, unitId: string | null, from: Date, to: Date) =>
  franchiseRpc<FranchiseFinancial>('network_franchise_financial', {
    ...range(tenantId, unitId, from, to),
    p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo',
  });
export const getFranchiseProducts = (tenantId: string, unitId: string | null, from: Date, to: Date) =>
  franchiseRpc<FranchiseProductRow[]>('network_franchise_products', range(tenantId, unitId, from, to));
export const getFranchiseStock = (tenantId: string, unitId: string | null) =>
  franchiseRpc<FranchiseStock>('network_franchise_stock', { p_tenant_id: tenantId, p_unit_id: unitId });
export const getFranchiseTeam = (tenantId: string, unitId: string | null, from: Date, to: Date) =>
  franchiseRpc<FranchiseSellerRow[]>('network_franchise_team', range(tenantId, unitId, from, to));
export const getFranchiseServices = (tenantId: string, unitId: string | null, from: Date, to: Date) =>
  franchiseRpc<FranchiseServices>('network_franchise_services', range(tenantId, unitId, from, to));
export const getFranchiseOperations = (tenantId: string, unitId: string | null, from: Date, to: Date) =>
  franchiseRpc<FranchiseOperations>('network_franchise_operations', range(tenantId, unitId, from, to));
export const getFranchiseCustomers = (tenantId: string, unitId: string | null, from: Date, to: Date) =>
  franchiseRpc<FranchiseCustomers>('network_franchise_customers', range(tenantId, unitId, from, to));
