import { supabase } from './client';

// Situacao da assinatura da empresa (migration 20261122). Guarda a ultima resposta para
// valer tambem sem internet. Sem a migration ou sem resposta, o PDV segue normal.

export const SUPPORT_PHONE = '(21) 96749-4001';
export const SUPPORT_EMAIL = 'suporte@kangurusistemas.com';

export interface PosSubscriptionState {
  status: 'ATIVO' | 'ATRASADO' | 'BLOQUEADO' | 'CANCELADO' | null;
  competence: string | null;
  dueDate: string | null;
  blockAfter: string | null;
}

const STORAGE_KEY = 'kanguru.subscriptionState';

export function readCachedSubscription(): PosSubscriptionState | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as PosSubscriptionState) : null;
  } catch {
    return null;
  }
}

export async function loadPosSubscription(): Promise<PosSubscriptionState | null> {
  const { data, error } = await supabase.rpc('get_pos_subscription_state');
  if (error || !data) return readCachedSubscription();
  const state = data as PosSubscriptionState;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // sem armazenamento: so vale em memoria
  }
  return state;
}

export function formatSubscriptionDate(value: string | null | undefined): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}
