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
