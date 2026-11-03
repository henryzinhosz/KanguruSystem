import { supabase } from './supabaseClient';

// Alertas "Precisa de atenção", ficha do cliente, metas da rede e comunicados no ERP do franqueado
// (migrations 20261118 e 20261119).

export type ErpAlertKind = 'OS_ATRASADA' | 'OS_PARADA' | 'NOTA' | 'CAIXA' | 'RESERVA' | 'OFFLINE' | 'ESTOQUE';

export interface ErpAlert {
  kind: ErpAlertKind;
  unitId: string;
  ref: string | null;
  title: string;
  detail: string | null;
  date: string | null;
}

export async function listErpAlerts(): Promise<ErpAlert[]> {
  const { data, error } = await supabase.rpc('list_erp_alerts');
  if (error) throw error;
  return (data || []) as ErpAlert[];
}

export interface CustomerHistoryItem {
  name: string | null;
  sku: string | null;
  itemType: 'PRODUCT' | 'SERVICE';
  quantity: number;
  lineTotal: number;
  serials: string[];
}

export interface CustomerHistory {
  summary: { purchases: number; totalSpent: number; firstPurchase: string | null; lastPurchase: string | null; creditBalance: number };
  purchases: {
    id: string; timestamp: string; unitId: string; storeName: string | null; status: string;
    grossAmount: number; returnedAmount: number; paymentMethod: string | null; sellerName: string | null;
    fiscalType: string | null; fiscalStatus: string | null; nfceNumber: string | null; receiptNumber: number | null;
    items: CustomerHistoryItem[];
    returns: { returnNumber: number; createdAt: string; amount: number; refundMethod: string; reason: string }[];
  }[];
  warranties: { saleId: string; saleDate: string; storeName: string | null; itemName: string | null; serial: string | null; months: number; until: string | null; saleStatus: string }[];
  workOrders: {
    id: string; orderNumber: number | null; unitId: string; storeName: string | null; status: string; equipment: string | null;
    createdAt: string; expectedDate: string | null; deliveredAt: string | null; warrantyUntil: string | null; paid: boolean; total: number;
  }[];
  credits: {
    id: string; unitId: string; storeName: string | null; amount: number; balance: number; createdAt: string;
    origin: 'TROCA_GAMER' | 'DEVOLUCAO' | 'OUTRO';
    movements: { kind: 'EMISSAO' | 'USO' | 'ESTORNO_USO'; amount: number; saleId: string | null; createdAt: string }[];
  }[];
  reservations: {
    id: string; unitId: string; storeName: string | null; status: string; createdAt: string; expiresAt: string;
    deposit: number; saleId: string | null; items: { name: string; quantity: number; lineTotal: number }[];
  }[];
  tradeIns: {
    id: string; tradeNumber: number | null; unitId: string; storeName: string | null; timestamp: string;
    description: string; serial: string | null; amount: number; paymentMethod: string | null; status: string;
  }[];
}

export async function getCustomerHistory(customerId: string): Promise<CustomerHistory> {
  const { data, error } = await supabase.rpc('get_customer_history', { p_customer_id: customerId });
  if (error) throw error;
  return data as CustomerHistory;
}

export interface StoreGoalRow {
  tenantId: string;
  franchiseName: string;
  unitId: string;
  storeName: string;
  goal: number | null;
  goalUpdatedAt: string | null;
  goalUpdatedBy: string | null;
  previousGoal: number | null;
  realized: number;
  lastYearRealized: number;
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';

export async function getMyStoreGoals(month: string): Promise<StoreGoalRow[]> {
  const { data, error } = await supabase.rpc('get_my_store_goals', { p_month: month, p_tz: timeZone() });
  if (error) throw error;
  return (data || []) as StoreGoalRow[];
}

export interface AnnouncementAttachment {
  path: string;
  name: string;
  size: number;
  type: string;
}

export interface MyAnnouncement {
  id: string;
  title: string;
  body: string;
  priority: 'NORMAL' | 'IMPORTANTE';
  attachments: AnnouncementAttachment[];
  networkName: string;
  createdByName: string | null;
  createdAt: string;
  expiresOn: string | null;
  readAt: string | null;
}

export async function listMyAnnouncements(): Promise<MyAnnouncement[]> {
  const { data, error } = await supabase.rpc('list_my_announcements');
  if (error) throw error;
  return (data || []) as MyAnnouncement[];
}

export async function markAnnouncementRead(id: string): Promise<void> {
  const { error } = await supabase.rpc('mark_my_announcement_read', { p_id: id });
  if (error) throw error;
}

export const ANNOUNCEMENT_BUCKET = 'network-announcements';

// Link temporario (5 min) para abrir o anexo; o Storage confere quem pode ler.
export async function openAnnouncementAttachment(attachment: AnnouncementAttachment): Promise<void> {
  const { data, error } = await supabase.storage.from(ANNOUNCEMENT_BUCKET).createSignedUrl(attachment.path, 300);
  if (error || !data?.signedUrl) throw error || new Error('Não foi possível abrir o anexo.');
  window.open(data.signedUrl, '_blank', 'noopener');
}

// Mes atual e meses vizinhos no formato YYYY-MM (horario local).
export const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

// Projecao do mes pelo ritmo atual (so para o mes corrente).
export function monthProjection(realized: number, month: string): number | null {
  const now = new Date();
  if (month !== monthKey(now)) return null;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (realized / Math.max(1, now.getDate())) * daysInMonth;
}
