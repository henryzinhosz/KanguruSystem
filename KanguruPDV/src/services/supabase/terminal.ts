import { supabase } from './client';
import { terminalAuth } from './auth';

export interface TerminalContext {
  id: string;
  tenantId: string;
  unitId: string;
  displayName: string;
  tradeName: string | null;
  legalName: string | null;
  cnpj: string | null;
  address: string | null;
  needsAdminPassword: boolean;
}

export async function getTerminalContext(): Promise<TerminalContext | null> {
  const { data, error } = await supabase.rpc('get_pos_terminal_context');
  if (error) throw error;
  if (!data?.[0]) return null;
  return mapTerminalContext(data?.[0], error);
}

export async function activateTerminal(code: string, terminalName: string): Promise<TerminalContext> {
  const session = await terminalAuth.requireAnonymousSession();
  if (!session.user.is_anonymous) {
    throw new Error('Este dispositivo precisa de uma sessao anonima antes da ativacao.');
  }

  const { data, error } = await supabase.rpc('activate_pos_terminal', {
    p_code: code,
    p_terminal_name: terminalName || null,
  });
  if (!error && !data?.[0]) {
    throw new Error('Codigo de ativacao invalido, expirado ou ja utilizado.');
  }
  return mapTerminalContext(data?.[0], error);
}

export async function setAdminPassword(password: string): Promise<void> {
  const { error } = await supabase.rpc('set_pos_terminal_admin_password', { p_password: password });
  if (error) {
    throw error;
  }
}

export async function requireAdminPassword(password: string): Promise<TerminalContext> {
  const { data, error } = await supabase.rpc('unlock_pos_terminal', { p_password: password });
  if (error) throw error;
  // Senha errada devolve zero linhas (a tentativa fica registrada no servidor).
  if (!data?.[0]) throw new Error('Senha Gerente incorreta.');
  return mapTerminalContext(data[0], null);
}

// Senha Gerente da loja (cadastrada no ERP). Enquanto a loja nao tiver, vale a senha
// administrativa antiga do terminal (terminalHasAdmin).
export interface ManagerPasswordStatus {
  configured: boolean;
  setAt: string | null;
  terminalHasAdmin: boolean;
}

export async function getManagerPasswordStatus(): Promise<ManagerPasswordStatus> {
  const { data, error } = await supabase.rpc('get_pos_manager_password_status');
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    configured: row.configured === true,
    setAt: row.setAt ? String(row.setAt) : null,
    terminalHasAdmin: row.terminalHasAdmin === true,
  };
}

export type ManagerAction = 'CASH_DRAWER' | 'CASH_WITHDRAWAL' | 'CASH_SUPPLY' | 'CASH_CLOSE' | 'RESERVATION_CANCEL' | 'PDV_SETTINGS';

export type ManagerAuthorization =
  | { status: 'OK' }
  | { status: 'INVALID'; remainingAttempts: number }
  | { status: 'LOCKED'; lockedUntil: string };

// Confere a senha antes da acao; o servidor aceita a acao seguinte por 5 minutos.
export async function authorizeManager(password: string, action: ManagerAction): Promise<ManagerAuthorization> {
  const { data, error } = await supabase.rpc('authorize_pos_manager', { p_password: password, p_context: action });
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;
  if (row.status === 'OK') return { status: 'OK' };
  if (row.status === 'LOCKED') return { status: 'LOCKED', lockedUntil: String(row.lockedUntil ?? '') };
  return { status: 'INVALID', remainingAttempts: Number(row.remainingAttempts ?? 0) };
}

function mapTerminalContext(data: Record<string, unknown> | undefined, error: unknown): TerminalContext {
  if (error) throw error;
  if (!data) throw new Error('Este dispositivo ainda nao foi ativado ou esta desativado.');
  return {
    id: String(data.terminal_id),
    tenantId: String(data.tenant_id),
    unitId: String(data.unit_id),
    displayName: String(data.terminal_name),
    tradeName: typeof data.trade_name === 'string' ? data.trade_name : null,
    legalName: typeof data.legal_name === 'string' ? data.legal_name : null,
    cnpj: typeof data.cnpj === 'string' ? data.cnpj : null,
    address: typeof data.address === 'string' ? data.address : null,
    needsAdminPassword: data.needs_admin_password === true,
  };
}
// Dados da loja para o cabecalho do voucher de reserva.
export interface PosStoreProfile {
  tradeName: string | null;
  legalName: string | null;
  cnpj: string | null;
  address: string | null;
  phone: string | null;
  reservationVoucherTerms: string | null;
  stateRegistration: string | null;
  instagram: string | null;
}

export async function getPosStoreProfile(): Promise<PosStoreProfile | null> {
  const { data, error } = await supabase.rpc('get_pos_store_profile');
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return {
    tradeName: row.trade_name ?? null,
    legalName: row.legal_name ?? null,
    cnpj: row.cnpj ?? null,
    address: row.address ?? null,
    phone: row.phone ?? null,
    reservationVoucherTerms: row.reservation_voucher_terms ?? null,
    stateRegistration: row.state_registration ?? null,
    instagram: row.instagram ?? null,
  };
}
