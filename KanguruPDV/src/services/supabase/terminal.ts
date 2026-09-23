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
  return mapTerminalContext(data?.[0], error);
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