import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { SubscriptionStatus } from '../types';

// Fase 3: mensalidade por cliente e bloqueio por assinatura (migration 20261122).

export const SUPPORT_PHONE = '(21) 96749-4001';
export const SUPPORT_EMAIL = 'suporte@kangurusistemas.com';

export interface SubscriptionState {
  status: SubscriptionStatus | null;
  competence: string | null;
  dueDate: string | null;
  blockAfter: string | null;
}

export interface BillingPayment {
  id: string;
  competence: string;
  amount: number;
  method: string | null;
  paidOn: string;
  note: string | null;
}

export interface TenantBilling {
  status: SubscriptionStatus | null;
  dueDay: number | null;
  startMonth: string | null;
  amount: number | null;
  graceDays: number;
  manualLock: boolean;
  firstUnpaid: string | null;
  dueDate: string | null;
  blockAfter: string | null;
  payments: BillingPayment[];
}

export const isBlockedStatus = (status: SubscriptionStatus | null | undefined) =>
  status === 'BLOQUEADO' || status === 'CANCELADO';

export function formatBillingDate(value: string | null | undefined): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

export function formatCompetence(value: string | null | undefined): string {
  if (!value) return '—';
  const [year, month] = value.slice(0, 7).split('-').map(Number);
  const name = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}/${year}`;
}

export async function getMySubscriptionState(): Promise<SubscriptionState | null> {
  const { data, error } = await supabase.rpc('get_my_subscription_state');
  if (error || !data) return null;
  return data as SubscriptionState;
}

// Situacao da assinatura do usuario logado; confere de novo a cada 5 minutos.
export function useSubscriptionState(tenantId: string | null | undefined): SubscriptionState | null {
  const [state, setState] = useState<SubscriptionState | null>(null);

  useEffect(() => {
    if (!tenantId) {
      setState(null);
      return;
    }
    let active = true;
    const load = () => getMySubscriptionState().then(next => { if (active) setState(next); });
    void load();
    const timer = window.setInterval(load, 5 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [tenantId]);

  return state;
}

export async function syncPlatformSubscriptions(): Promise<void> {
  await supabase.rpc('platform_sync_subscriptions');
}

export async function getTenantBilling(tenantId: string): Promise<TenantBilling> {
  const { data, error } = await supabase.rpc('platform_get_billing', { p_tenant_id: tenantId });
  if (error) throw error;
  const row = data as TenantBilling;
  return {
    ...row,
    amount: row.amount == null ? null : Number(row.amount),
    payments: (row.payments ?? []).map(payment => ({ ...payment, amount: Number(payment.amount) })),
  };
}

export async function saveTenantBilling(tenantId: string, input: { dueDay: number | null; startMonth: string | null; amount: number | null; graceDays: number }): Promise<void> {
  const { error } = await supabase.rpc('platform_save_billing', {
    p_tenant_id: tenantId,
    p_due_day: input.dueDay,
    p_start_month: input.startMonth,
    p_amount: input.amount,
    p_grace_days: input.graceDays,
  });
  if (error) throw error;
}

export async function registerTenantPayment(tenantId: string, input: { competence: string; amount: number; method: string; paidOn: string; note: string }): Promise<void> {
  const { error } = await supabase.rpc('platform_register_payment', {
    p_tenant_id: tenantId,
    p_competence: input.competence,
    p_amount: input.amount,
    p_method: input.method,
    p_paid_on: input.paidOn,
    p_note: input.note,
  });
  if (error) throw error;
}

export async function removeTenantPayment(paymentId: string): Promise<void> {
  const { error } = await supabase.rpc('platform_remove_payment', { p_payment_id: paymentId });
  if (error) throw error;
}

export async function setTenantSubscriptionManual(tenantId: string, status: SubscriptionStatus): Promise<void> {
  const { error } = await supabase.rpc('platform_set_subscription_manual', { p_tenant_id: tenantId, p_status: status });
  if (error) throw error;
}
