import { supabase } from './supabaseClient';
import { ANNOUNCEMENT_BUCKET, type AnnouncementAttachment, type StoreGoalRow } from './insights';

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

// ---- Repasse / royalties (etapa 3, migration 20261117) ----

export type RoyaltyTier = { upTo: number | null; type: 'FIXED' | 'PERCENT'; value: number };
export interface RoyaltyRule {
  mode: 'PERCENT' | 'TIERS';
  percent: number | null;
  tiers: RoyaltyTier[] | null;
  updatedAt?: string;
  updatedByName?: string | null;
}
export interface RoyaltyReportRow {
  tenantId: string;
  name: string;
  cnpj: string;
  ownerName: string | null;
  rule: RoyaltyRule | null;
  base: number;
  royalty: number;
  paid: boolean;
  paidAt: string | null;
  notes: string | null;
  markedByName: string | null;
  paidRule: RoyaltyRule | null;
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';

export async function getRoyaltyReport(month: string): Promise<RoyaltyReportRow[]> {
  const { data, error } = await supabase.rpc('network_royalty_report', { p_month: month, p_tz: timeZone() });
  if (error) throw error;
  return ((data || []) as RoyaltyReportRow[]).map(row => ({ ...row, base: Number(row.base), royalty: Number(row.royalty) }));
}

export async function saveRoyaltyRule(tenantId: string, rule: RoyaltyRule): Promise<void> {
  const { error } = await supabase.rpc('network_save_royalty_rule', {
    p_tenant_id: tenantId,
    p_mode: rule.mode,
    p_percent: rule.mode === 'PERCENT' ? rule.percent : null,
    p_tiers: rule.mode === 'TIERS' ? rule.tiers : null,
  });
  if (error) throw error;
}

export async function setRoyaltyPaid(tenantId: string, month: string, paid: boolean, paidAt?: string, notes?: string): Promise<void> {
  const { error } = await supabase.rpc('network_set_royalty_paid', {
    p_tenant_id: tenantId,
    p_month: month,
    p_paid: paid,
    p_paid_at: paidAt || null,
    p_notes: notes || null,
    p_tz: timeZone(),
  });
  if (error) throw error;
}

// ---------------- Metas, alertas e comunicados da rede (migration 20261119) ----------------

export async function getNetworkGoals(month: string): Promise<StoreGoalRow[]> {
  const { data, error } = await supabase.rpc('network_goals_report', { p_month: month, p_tz: timeZone() });
  if (error) throw error;
  return ((data || []) as StoreGoalRow[]).map(row => ({
    ...row,
    goal: row.goal === null ? null : Number(row.goal),
    previousGoal: row.previousGoal === null ? null : Number(row.previousGoal),
    realized: Number(row.realized),
    lastYearRealized: Number(row.lastYearRealized),
  }));
}

export async function saveNetworkGoals(month: string, goals: { tenantId: string; unitId: string; amount: number | null }[]): Promise<void> {
  const { error } = await supabase.rpc('network_save_store_goals', { p_month: month, p_goals: goals });
  if (error) throw error;
}

export type NetworkAlertKind = 'SEM_VENDA' | 'CAIXA_DIFERENCA' | 'CAIXA_ABERTO' | 'NOTAS' | 'META' | 'ASSINATURA';

export interface NetworkAlert {
  kind: NetworkAlertKind;
  tenantId: string;
  franchiseName: string;
  unitId: string | null;
  storeName: string | null;
  title: string;
  detail: string | null;
  date: string | null;
}

export async function getNetworkAlerts(): Promise<NetworkAlert[]> {
  const { data, error } = await supabase.rpc('network_alerts', { p_tz: timeZone() });
  if (error) throw error;
  return (data || []) as NetworkAlert[];
}

export interface NetworkAlertSettings {
  noSaleDays: number;
  cashDifference: number;
  cashOpenHours: number;
  goalMinPercent: number;
  updatedAt: string | null;
  updatedByName: string | null;
}

export async function getNetworkAlertSettings(): Promise<NetworkAlertSettings> {
  const { data, error } = await supabase.rpc('network_get_alert_settings');
  if (error) throw error;
  return data as NetworkAlertSettings;
}

export async function saveNetworkAlertSettings(settings: Omit<NetworkAlertSettings, 'updatedAt' | 'updatedByName'>): Promise<void> {
  const { error } = await supabase.rpc('network_save_alert_settings', {
    p_no_sale_days: settings.noSaleDays,
    p_cash_difference: settings.cashDifference,
    p_cash_open_hours: settings.cashOpenHours,
    p_goal_min_percent: settings.goalMinPercent,
  });
  if (error) throw error;
}

export interface NetworkAnnouncement {
  id: string;
  title: string;
  body: string;
  priority: 'NORMAL' | 'IMPORTANTE';
  audience: 'OWNERS' | 'ALL';
  targetTenantIds: string[] | null;
  expiresOn: string | null;
  archived: boolean;
  attachments: AnnouncementAttachment[];
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  franchises: { tenantId: string; name: string; recipients: number; reads: { displayName: string | null; email: string | null; readAt: string }[] }[];
}

export async function listNetworkAnnouncements(): Promise<NetworkAnnouncement[]> {
  const { data, error } = await supabase.rpc('network_list_announcements');
  if (error) throw error;
  return (data || []) as NetworkAnnouncement[];
}

export async function saveNetworkAnnouncement(announcement: {
  id: string; title: string; body: string; priority: 'NORMAL' | 'IMPORTANTE'; audience: 'OWNERS' | 'ALL';
  targetTenantIds: string[] | null; expiresOn: string | null; attachments: AnnouncementAttachment[];
}): Promise<void> {
  const { error } = await supabase.rpc('network_save_announcement', {
    p_id: announcement.id,
    p_title: announcement.title,
    p_body: announcement.body,
    p_priority: announcement.priority,
    p_audience: announcement.audience,
    p_target_tenant_ids: announcement.targetTenantIds,
    p_expires_on: announcement.expiresOn,
    p_attachments: announcement.attachments,
  });
  if (error) throw error;
}

export async function setNetworkAnnouncementArchived(id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.rpc('network_set_announcement_archived', { p_id: id, p_archived: archived });
  if (error) throw error;
}

// Envia um anexo para a pasta do comunicado (<rede>/<comunicado>/<arquivo>).
export async function uploadAnnouncementAttachment(networkId: string, announcementId: string, file: File): Promise<AnnouncementAttachment> {
  const safeName = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
  const path = `${networkId}/${announcementId}/${crypto.randomUUID().slice(0, 8)}-${safeName}`;
  const { error } = await supabase.storage.from(ANNOUNCEMENT_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return { path, name: file.name, size: file.size, type: file.type };
}

export async function removeAnnouncementAttachment(path: string): Promise<void> {
  const { error } = await supabase.storage.from(ANNOUNCEMENT_BUCKET).remove([path]);
  if (error) throw error;
}
