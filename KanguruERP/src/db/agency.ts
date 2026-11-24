import { getSupabaseConfig, supabase } from './supabaseClient';

// Agencia de IA (migration 20261211, Edge Function agency-chat).

export type AgencyRoom = 'recepcao' | 'marketing' | 'vendas' | 'financeiro' | 'compras' | 'atendimento';

export interface AgencyStatus {
  ok: boolean;
  reason: 'SEM_ACESSO' | 'SEM_PERMISSAO' | 'BLOQUEADO' | 'DESLIGADA' | 'LIMITE' | null;
  enabled: boolean;
  limit: number;
  used: number;
}

export interface AgencyConversation {
  id: string;
  room: AgencyRoom;
  title: string;
  scopeLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgencyMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export const AGENCY_REASON_LABELS: Record<NonNullable<AgencyStatus['reason']>, string> = {
  SEM_ACESSO: 'Seu login não tem acesso à Agência.',
  SEM_PERMISSAO: 'O dono da empresa ainda não liberou a Agência para o seu usuário.',
  BLOQUEADO: 'A assinatura da empresa está bloqueada.',
  DESLIGADA: 'A Agência está desligada para esta empresa. Fale com o suporte da Kanguru.',
  LIMITE: 'O limite de perguntas deste mês acabou. Ele volta no dia 1º.',
};

export async function getAgencyStatus(): Promise<AgencyStatus | null> {
  const { data, error } = await supabase.rpc('get_agency_status');
  if (error) {
    // Migration ainda nao aplicada: a Agencia fica escondida.
    if (/get_agency_status/.test(error.message || '')) return null;
    throw error;
  }
  const raw = (data || {}) as Record<string, unknown>;
  return {
    ok: Boolean(raw.ok),
    reason: (raw.reason as AgencyStatus['reason']) ?? null,
    enabled: raw.enabled !== false,
    limit: Number(raw.limit ?? 0),
    used: Number(raw.used ?? 0),
  };
}

export async function listAgencyConversations(room: AgencyRoom): Promise<AgencyConversation[]> {
  const { data, error } = await supabase
    .from('agency_conversations')
    .select('id, room, title, scope_label, created_at, updated_at')
    .eq('room', room)
    .order('updated_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data || []).map(row => ({
    id: row.id,
    room: row.room,
    title: row.title,
    scopeLabel: row.scope_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listAgencyMessages(conversationId: string): Promise<AgencyMessage[]> {
  const { data, error } = await supabase
    .from('agency_messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(row => ({ id: row.id, role: row.role, content: row.content, createdAt: row.created_at }));
}

export async function deleteAgencyConversation(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_agency_conversation', { p_id: id });
  if (error) throw error;
}

export interface AskInput {
  room: AgencyRoom;
  conversationId: string | null;
  message: string;
  // So na conversa nova: retrato dos dados da loja (fica fixo na conversa).
  context?: string;
  scopeLabel?: string;
}

export interface AskResult {
  conversationId: string;
  text: string;
  used: number;
  limit: number;
}

// Envia a pergunta e recebe a resposta aos poucos (onText recebe o texto acumulado).
export async function askAgency(input: AskInput, onText: (text: string) => void): Promise<AskResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Sessão expirada. Entre de novo.');
  const { url, anonKey } = getSupabaseConfig();

  const response = await fetch(`${url}/functions/v1/agency-chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok || !response.body) {
    let message = 'Não foi possível falar com a Agência agora.';
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // resposta sem corpo
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let result: AskResult | null = null;
  let failure: string | null = null;

  const handle = (chunk: string) => {
    const lines = chunk.split('\n');
    const event = lines.find(line => line.startsWith('event: '))?.slice(7).trim();
    const dataLine = lines.find(line => line.startsWith('data: '))?.slice(6);
    if (!event || !dataLine) return;
    const data = JSON.parse(dataLine) as Record<string, unknown>;
    if (event === 'delta') {
      text += String(data.text ?? '');
      onText(text);
    } else if (event === 'done') {
      result = {
        conversationId: String(data.conversationId),
        text: String(data.text ?? text),
        used: Number(data.used ?? 0),
        limit: Number(data.limit ?? 0),
      };
    } else if (event === 'error') {
      failure = String(data.message || 'Não foi possível responder agora.');
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      handle(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) handle(buffer);

  if (failure) throw new Error(failure);
  if (!result) throw new Error('A resposta foi interrompida. Tente de novo.');
  return result;
}

// Marcadores de botao no fim da resposta: [[abrir:contas]].
export type AgencyTarget =
  | 'dashboard' | 'estoque' | 'servicos' | 'clientes' | 'caixa' | 'contas' | 'areceber' | 'recebimentos' | 'resultados' | 'fornecedores';

export const AGENCY_TARGET_LABELS: Record<AgencyTarget, string> = {
  dashboard: 'Abrir Relatórios Gerais',
  estoque: 'Abrir Catálogo & Estoque',
  servicos: 'Abrir Serviços / OS',
  clientes: 'Abrir Clientes',
  caixa: 'Abrir Caixa e Bancos',
  contas: 'Abrir Contas a Pagar',
  areceber: 'Abrir Contas a Receber',
  recebimentos: 'Abrir Recebimentos',
  resultados: 'Abrir Indicadores & DRE',
  fornecedores: 'Abrir Fornecedores',
};

export function splitAnswer(text: string): { body: string; targets: AgencyTarget[] } {
  const targets: AgencyTarget[] = [];
  const body = text
    .replace(/\[\[abrir:([a-z]+)\]\]/g, (_, target: string) => {
      if (target in AGENCY_TARGET_LABELS && !targets.includes(target as AgencyTarget)) targets.push(target as AgencyTarget);
      return '';
    })
    // marcador ainda chegando (resposta em andamento)
    .replace(/\[\[[a-z:]*\]?$/, '')
    .trim();
  return { body, targets: targets.slice(0, 2) };
}

// ---------------- UCP (so a plataforma) ----------------
export interface PlatformAgency {
  enabled: boolean;
  limit: number;
  used: number;
  costUsd: number;
  people: number;
  lastMonthUsed: number;
  lastMonthCostUsd: number;
}

export async function platformGetAgency(tenantId: string): Promise<PlatformAgency> {
  const { data, error } = await supabase.rpc('platform_get_agency', { p_tenant_id: tenantId });
  if (error) throw error;
  const raw = (data || {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled !== false,
    limit: Number(raw.limit ?? 0),
    used: Number(raw.used ?? 0),
    costUsd: Number(raw.costUsd ?? 0),
    people: Number(raw.people ?? 0),
    lastMonthUsed: Number(raw.lastMonthUsed ?? 0),
    lastMonthCostUsd: Number(raw.lastMonthCostUsd ?? 0),
  };
}

export async function platformSaveAgency(tenantId: string, enabled: boolean, limit: number): Promise<void> {
  const { error } = await supabase.rpc('platform_save_agency', { p_tenant_id: tenantId, p_enabled: enabled, p_limit: limit });
  if (error) throw error;
}
