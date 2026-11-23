import { supabase } from './supabaseClient';

// Registro de acoes (migration 20261205): acoes no ERP (gatilhos + movimentos de estoque) e acoes
// do PDV com senha Gerente. So o dono (ADMIN) consulta.

export type AuditArea = 'PRODUTOS' | 'VENDAS' | 'FINANCEIRO' | 'CONFIGURACOES' | 'PESSOAS' | 'TROCAS' | 'ESTOQUE';
export type PosCategory = 'CAIXA' | 'VENDA' | 'TROCAS' | 'TERMINAL';

export interface AuditEntry {
  occurredAt: string;
  area: AuditArea;
  tableName: string;
  operation: string;
  actorKind: string;
  actorName: string | null;
  unitId: string | null;
  recordId: string | null;
  summary: string | null;
  changes: Record<string, unknown> | null;
}

export interface PosSensitiveAction {
  occurredAt: string;
  unitId: string | null;
  terminalName: string | null;
  category: PosCategory;
  context: string;
  success: boolean;
  completed: boolean | null;
  detail: string | null;
  amount: number | null;
}

export async function listAuditLog(params: {
  start: Date; end: Date; unitId?: string | null; area?: AuditArea | null; search?: string | null;
}): Promise<AuditEntry[]> {
  const { data, error } = await supabase.rpc('list_audit_log', {
    p_start: params.start.toISOString(),
    p_end: params.end.toISOString(),
    p_unit: params.unitId || null,
    p_area: params.area || null,
    p_search: params.search?.trim() || null,
    p_limit: 1000,
  });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
    occurredAt: String(row.occurred_at),
    area: row.area as AuditArea,
    tableName: String(row.table_name),
    operation: String(row.operation),
    actorKind: String(row.actor_kind),
    actorName: (row.actor_name as string | null) ?? null,
    unitId: (row.unit_id as string | null) ?? null,
    recordId: (row.record_id as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    changes: (row.changes as Record<string, unknown> | null) ?? null,
  }));
}

export async function listPosSensitiveActions(params: {
  start: Date; end: Date; unitId?: string | null;
}): Promise<PosSensitiveAction[]> {
  const { data, error } = await supabase.rpc('list_pos_sensitive_actions', {
    p_start: params.start.toISOString(),
    p_end: params.end.toISOString(),
    p_unit: params.unitId || null,
    p_category: null,
  });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
    occurredAt: String(row.occurred_at),
    unitId: (row.unit_id as string | null) ?? null,
    terminalName: (row.terminal_name as string | null) ?? null,
    category: row.category as PosCategory,
    context: String(row.context),
    success: Boolean(row.success),
    completed: row.completed === null || row.completed === undefined ? null : Boolean(row.completed),
    detail: (row.detail as string | null) ?? null,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
  }));
}

// ---- Textos da tela ---------------------------------------------------------

export const AREA_LABELS: Record<AuditArea, string> = {
  PRODUTOS: 'Produtos e serviços',
  VENDAS: 'Vendas',
  FINANCEIRO: 'Financeiro',
  CONFIGURACOES: 'Configurações',
  PESSOAS: 'Pessoas',
  TROCAS: 'Trocas',
  ESTOQUE: 'Estoque',
};

export const POS_CATEGORY_LABELS: Record<PosCategory, string> = {
  CAIXA: 'Caixa',
  VENDA: 'Venda',
  TROCAS: 'Trocas',
  TERMINAL: 'Terminal',
};

export const POS_CONTEXT_LABELS: Record<string, string> = {
  CASH_WITHDRAWAL: 'Sangria',
  CASH_SUPPLY: 'Suprimento',
  CASH_DRAWER: 'Gaveta aberta pelo menu',
  CASH_CLOSE: 'Fechamento de caixa',
  DISCOUNT_APPROVAL: 'Desconto acima do limite',
  SALE_RETURN: 'Devolução com senha',
  RESERVATION_CANCEL: 'Cancelamento de reserva com sinal',
  TRADE_IN_PAYOUT: 'Pagamento de troca (dinheiro/Pix ou acima da tabela)',
  UNLOCK: 'Desbloqueio do terminal',
  PDV_SETTINGS: 'Configurações do PDV',
};

const TABLE_LABELS: Record<string, string> = {
  products: 'produto',
  services: 'serviço',
  sales: 'venda',
  expenses: 'despesa',
  payable_bills: 'conta a pagar',
  payable_recurrences: 'conta que se repete',
  store_configs: 'loja',
  store_manager_passwords: 'senha Gerente',
  app_users: 'usuário do ERP',
  user_store_access: 'acesso a loja',
  pdv_operators: 'vendedor do PDV',
  customers: 'cliente',
  trade_ins: 'troca',
};

const MOVEMENT_LABELS: Record<string, string> = {
  ENTRADA: 'Entrada de estoque',
  SAIDA: 'Saída de estoque',
  PERDA: 'Perda',
  TRANSFERENCIA: 'Transferência',
  AJUSTE: 'Ajuste de estoque',
  BALANCO: 'Balanço',
};

const FIELD_LABELS: Record<string, string> = {
  name: 'Nome', sku: 'Código', sell_price: 'Preço de venda', cost_price: 'Custo padrão',
  max_discount_percent: 'Desconto máximo (%)', min_stock: 'Estoque mínimo', category: 'Categoria',
  brand: 'Marca', ncm: 'NCM', cest: 'CEST', origin: 'Origem', cst: 'CST', csosn: 'CSOSN',
  icms_rate: 'ICMS (%)', icms_reduction: 'Redução ICMS (%)', total_tax_percent: 'Total de tributos (%)',
  warranty_days: 'Garantia (dias)', warranty_months: 'Garantia (meses)', is_serialized: 'Com serial',
  invoice_details: 'Detalhes na nota', status: 'Situação', requires_approval: 'Aguardando aprovação de estorno',
  approved_by: 'Aprovado por / motivo', gross_amount: 'Valor total', items: 'Itens', payment_method: 'Forma de pagamento',
  timestamp: 'Data', client_name: 'Cliente', client_cpf: 'CPF do cliente', seller_code: 'Código do vendedor',
  seller_name: 'Vendedor', invoice_number: 'Número', description: 'Descrição', amount: 'Valor', due_date: 'Vencimento',
  paid_at: 'Pago em', paid_amount: 'Valor pago', paid_method: 'Pago com', paid_by_name: 'Pago por',
  supplier_name: 'Fornecedor', barcode: 'Código de barras', pix_key: 'Chave Pix', attachment_name: 'Anexo',
  cancelled_at: 'Cancelada em', card_fee_table: 'Taxas do cartão', fixed_cost: 'Custo fixo mensal',
  payment_fees: 'Taxas por forma', settlement_rules: 'Quando o dinheiro cai na conta', trade_name: 'Nome da loja',
  display_name: 'Nome', role: 'Perfil', is_active: 'Ativo', permissions: 'Permissões', unit_id: 'Loja',
  code: 'Código', monthly_goal: 'Meta do mês', phone: 'Celular', email: 'E-mail', cpf: 'CPF', cep: 'CEP',
  address: 'Endereço', address_number: 'Número', complement: 'Complemento', neighborhood: 'Bairro',
  city: 'Cidade', state: 'UF', notes: 'Observação', exchange_days: 'Prazo de troca (dias)',
  max_item_discount_percent: 'Desconto padrão (%)', instagram: 'Instagram', cnpj: 'CNPJ',
  type: 'Tipo', quantity: 'Quantidade', from_unit_id: 'De', to_unit_id: 'Para', reason: 'Motivo',
  unit_cost: 'Custo unitário', serials: 'Seriais', set_by_name: 'Definida por',
};

export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const text = field.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}(:?\d{2})?|Z)?)?$/;

export function formatAuditValue(value: unknown, field?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (typeof value === 'number') return value.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) {
      const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
      if (!Number.isNaN(date.getTime())) {
        return value.length === 10 ? date.toLocaleDateString('pt-BR') : date.toLocaleString('pt-BR');
      }
    }
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  if (Array.isArray(value) && field === 'items') return `${value.length} item(ns)`;
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

// Frase curta do que aconteceu ("Alterou produto", "Estornou a venda" etc.).
export function auditActionText(entry: AuditEntry): string {
  if (entry.tableName === 'movements') return MOVEMENT_LABELS[entry.operation] ?? `Estoque: ${entry.operation}`;
  const label = TABLE_LABELS[entry.tableName] ?? entry.tableName;
  const change = (field: string) => {
    const pair = entry.changes?.[field];
    return Array.isArray(pair) && pair.length === 2 ? pair : null;
  };
  if (entry.operation === 'UPDATE') {
    const status = change('status');
    if (entry.tableName === 'sales') {
      if (status && status[1] === 'CANCELADA') return 'Estornou a venda';
      const pending = change('requires_approval');
      if (pending && pending[1] === true) return 'Pediu estorno da venda';
    }
    if (entry.tableName === 'payable_bills' && status) {
      if (status[1] === 'PAGO') return 'Pagou a conta';
      if (status[0] === 'PAGO') return 'Desfez o pagamento da conta';
      if (status[1] === 'CANCELADO') return 'Cancelou a conta';
      if (status[0] === 'CANCELADO') return 'Reabriu a conta';
    }
    if (entry.tableName === 'trade_ins' && status) return `Troca: ${formatAuditValue(status[0])} → ${formatAuditValue(status[1])}`;
    if (entry.tableName === 'products' && change('sell_price')) return 'Mudou o preço do produto';
    if (entry.tableName === 'store_manager_passwords') return 'Alterou a senha Gerente';
    return `Alterou ${label}`;
  }
  if (entry.tableName === 'store_manager_passwords') return entry.operation === 'INSERT' ? 'Definiu a senha Gerente' : 'Removeu a senha Gerente';
  if (entry.tableName === 'user_store_access') return entry.operation === 'INSERT' ? 'Deu acesso a uma loja' : 'Tirou acesso a uma loja';
  if (entry.tableName === 'expenses' && entry.operation === 'INSERT') return 'Lançou despesa';
  return entry.operation === 'INSERT' ? `Criou ${label}` : `Excluiu ${label}`;
}
