import { supabase } from './supabaseClient';
import { 
  Product, 
  Service,
  StockInventory, 
  StockMovement, 
  Sale,
  SaleReturnInfo,
  StoreNfceStatus,
  SalePaymentLine,
  Expense, 
  TradeIn, 
  WorkOrder, 
  StoreConfig, 
  Supplier,
  SupplierInvoiceReminder,
  UserRole,
  PlatformTenant,
  PlatformTenantDetails,
  SubscriptionStatus,
  PosTerminalActivation,
  PdvOperator,
  PdvOperatorPermissions,
  SerializedStockEntryUnit,
  ProductStoreCost,
  StockEntryLine,
  SaleStatus,
  Customer
} from '../types';

// Helper to check if an error is due to a missing table (relation does not exist)
export function isTableMissingError(error: any): boolean {
  if (!error) return false;
  return error.code === '42P01' || (error.message && error.message.includes('relation') && error.message.includes('does not exist'));
}

function mapPosTerminalActivation(activation: any): PosTerminalActivation {
  return {
    id: activation.id,
    codeHash: activation.code_hash,
    tenantId: activation.tenant_id,
    unitId: activation.unit_id,
    terminalLabel: activation.terminal_label,
    expiresAt: activation.expires_at,
    usedAt: activation.used_at ?? null,
    usedByAuthUid: activation.used_by_auth_uid ?? null,
    revokedAt: activation.revoked_at ?? null,
    createdAt: activation.created_at,
    status: activation.status ?? (activation.revoked_at ? 'REVOGADO' : activation.used_at ? 'USADO' : activation.expires_at <= new Date().toISOString() ? 'EXPIRADO' : 'PENDENTE')
  };
}

const defaultPdvOperatorPermissions: PdvOperatorPermissions = {
  canRegisterSales: false,
  canApplyDiscount: false,
  canCancelSales: false,
  canOpenCash: false,
  canCloseCash: false
};

function mapPdvOperator(operator: any): PdvOperator {
  return {
    id: operator.id,
    tenantId: operator.tenant_id,
    unitId: operator.unit_id ?? null,
    code: operator.code ?? null,
    name: operator.name,
    permissions: { ...defaultPdvOperatorPermissions, ...(operator.permissions || {}) },
    isActive: operator.is_active,
    createdAt: operator.created_at,
    updatedAt: operator.updated_at
  };
}

export const SQL_SCHEMA_SCRIPT = `-- SQL para criar as tabelas no Supabase (copie e execute no SQL Editor do seu painel do Supabase)

-- 1. Produtos
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT,
  cost_price NUMERIC NOT NULL,
  sell_price NUMERIC NOT NULL,
  ncm TEXT,
  warranty_months INTEGER,
  is_serialized BOOLEAN DEFAULT false,
  is_used BOOLEAN DEFAULT false,
  variations JSONB,
  is_kit BOOLEAN DEFAULT false,
  kit_items JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Estoque (Inventário)
CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  quantities JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Movimentações de Estoque
CREATE TABLE IF NOT EXISTS movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  variation_id TEXT,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  serials JSONB,
  card_condition TEXT,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Vendas
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  items JSONB NOT NULL,
  payment_method TEXT NOT NULL,
  gross_amount NUMERIC NOT NULL,
  fee_amount NUMERIC NOT NULL,
  net_amount NUMERIC NOT NULL,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  client_cpf TEXT,
  client_name TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  requires_approval BOOLEAN DEFAULT false,
  approved_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Despesas (Gastos)
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Trocas / Avaliações (Trade-Ins)
CREATE TABLE IF NOT EXISTS trade_ins (
  id TEXT PRIMARY KEY,
  seller_name TEXT NOT NULL,
  seller_cpf TEXT NOT NULL,
  item_description TEXT NOT NULL,
  category TEXT NOT NULL,
  condition TEXT NOT NULL,
  valuation_amount NUMERIC NOT NULL,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  created_product_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Ordens de Serviço (OS)
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  os_number TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  equipment TEXT NOT NULL,
  problem_description TEXT NOT NULL,
  status TEXT NOT NULL,
  parts_cost NUMERIC DEFAULT 0,
  labor_cost NUMERIC DEFAULT 0,
  total_cost NUMERIC DEFAULT 0,
  linked_serial TEXT,
  unit_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Configurações de Loja
CREATE TABLE IF NOT EXISTS store_configs (
  unit_id TEXT PRIMARY KEY,
  fixed_cost NUMERIC DEFAULT 0,
  payment_fees JSONB NOT NULL,
  trade_name TEXT,
  legal_name TEXT,
  cnpj TEXT,
  state_registration TEXT,
  address TEXT,
  phone TEXT,
  contact_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Fornecedores
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cnpj TEXT NOT NULL,
  contact TEXT NOT NULL,
  category TEXT NOT NULL,
  history_count INTEGER DEFAULT 0,
  phone TEXT,
  website TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Contas a pagar de fornecedores
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY,
  supplier_id TEXT,
  supplier_name TEXT NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  due_date DATE NOT NULL,
  installments TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDENTE', 'PAGO')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`;

export const SQL_RLS_AND_RPC_SCRIPT = `-- SQL para habilitar RLS e criar funções atômicas no Supabase

-- 0. Usuários de aplicação vinculados ao Auth do Supabase
CREATE TABLE IF NOT EXISTS app_users (
  auth_uid UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'OPERATOR')),
  unit_id TEXT NOT NULL,
  display_name TEXT
);

ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS trade_name TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS cnpj TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS state_registration TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS contact_email TEXT;

-- Helpers para uso em políticas de RLS
CREATE OR REPLACE FUNCTION public.current_user_unit_id()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT unit_id FROM public.app_users WHERE auth_uid = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.app_users WHERE auth_uid = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT role = 'ADMIN' FROM public.app_users WHERE auth_uid = auth.uid()), false);
$$;

CREATE OR REPLACE FUNCTION public.update_current_user_display_name(p_display_name TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.app_users
  SET display_name = NULLIF(BTRIM(p_display_name), '')
  WHERE auth_uid = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Usuário de aplicação não encontrado';
  END IF;
END;
$$;

-- Ativar RLS em todas as tabelas de dados relacionadas
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoices ENABLE ROW LEVEL SECURITY;

-- Cada usuário autenticado pode consultar somente o próprio vínculo de acesso.
CREATE POLICY "Users can read their own app user" ON app_users
  FOR SELECT USING (auth_uid = auth.uid());

-- Produtos
CREATE POLICY "Authenticated can read products" ON products
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated can insert products" ON products
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated can update products" ON products
  FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "Only admin can delete products" ON products
  FOR DELETE USING (public.current_user_is_admin());

-- Estoque
CREATE POLICY "Authenticated can read inventory" ON inventory
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated can insert inventory" ON inventory
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "No direct inventory updates" ON inventory
  FOR UPDATE USING (false);

CREATE POLICY "No direct inventory deletes" ON inventory
  FOR DELETE USING (false);

-- Movimentações
CREATE POLICY "Store movement read access" ON movements
  FOR SELECT USING (
    public.current_user_is_admin() OR
    from_unit_id = public.current_user_unit_id() OR
    to_unit_id = public.current_user_unit_id()
  );

CREATE POLICY "Store movement inserts" ON movements
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND (
      public.current_user_is_admin() OR
      from_unit_id = public.current_user_unit_id() OR
      to_unit_id = public.current_user_unit_id()
    )
  );

CREATE POLICY "Store movement updates" ON movements
  FOR UPDATE USING (public.current_user_is_admin());

CREATE POLICY "Store movement deletes" ON movements
  FOR DELETE USING (public.current_user_is_admin());

-- Vendas
CREATE POLICY "Store sales access" ON sales
  FOR SELECT USING (
    public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
  );

CREATE POLICY "Store sales inserts" ON sales
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND (
      public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
    )
  );

CREATE POLICY "Store sales updates" ON sales
  FOR UPDATE USING (
    public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
  );

CREATE POLICY "Store sales deletes" ON sales
  FOR DELETE USING (public.current_user_is_admin());

-- Despesas
CREATE POLICY "Store expenses access" ON expenses
  FOR SELECT USING (
    public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
  );

CREATE POLICY "Store expenses inserts" ON expenses
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND (
      public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
    )
  );

CREATE POLICY "Store expenses updates" ON expenses
  FOR UPDATE USING (public.current_user_is_admin());

CREATE POLICY "Store expenses deletes" ON expenses
  FOR DELETE USING (public.current_user_is_admin());

-- Trade-Ins
CREATE POLICY "Store trade-ins access" ON trade_ins
  FOR SELECT USING (
    public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
  );

CREATE POLICY "Store trade-ins inserts" ON trade_ins
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND (
      public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
    )
  );

CREATE POLICY "Store trade-ins updates" ON trade_ins
  FOR UPDATE USING (public.current_user_is_admin());

CREATE POLICY "Store trade-ins deletes" ON trade_ins
  FOR DELETE USING (public.current_user_is_admin());

-- Ordens de Serviço
CREATE POLICY "Store work orders access" ON work_orders
  FOR SELECT USING (
    public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
  );

CREATE POLICY "Store work orders inserts" ON work_orders
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND (
      public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
    )
  );

CREATE POLICY "Store work orders updates" ON work_orders
  FOR UPDATE USING (
    public.current_user_is_admin() OR unit_id = public.current_user_unit_id()
  );

CREATE POLICY "Store work orders deletes" ON work_orders
  FOR DELETE USING (public.current_user_is_admin());

-- Configurações de Loja
CREATE POLICY "Store configs access" ON store_configs
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Admin configs insert" ON store_configs
  FOR INSERT WITH CHECK (public.current_user_is_admin());

CREATE POLICY "Admin configs update" ON store_configs
  FOR UPDATE USING (public.current_user_is_admin());

CREATE POLICY "Admin configs delete" ON store_configs
  FOR DELETE USING (public.current_user_is_admin());

-- Fornecedores
CREATE POLICY "Supplier access" ON suppliers
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Supplier admin insert" ON suppliers
  FOR INSERT WITH CHECK (public.current_user_is_admin());

CREATE POLICY "Supplier admin update" ON suppliers
  FOR UPDATE USING (public.current_user_is_admin());

CREATE POLICY "Supplier admin delete" ON suppliers
  FOR DELETE USING (public.current_user_is_admin());

-- Contas a Pagar de Fornecedores
CREATE POLICY "Admin can read supplier invoices" ON supplier_invoices
  FOR SELECT USING (public.current_user_is_admin());

CREATE POLICY "Admin can insert supplier invoices" ON supplier_invoices
  FOR INSERT WITH CHECK (public.current_user_is_admin());

CREATE POLICY "Admin can update supplier invoices" ON supplier_invoices
  FOR UPDATE USING (public.current_user_is_admin());

CREATE POLICY "Admin can delete supplier invoices" ON supplier_invoices
  FOR DELETE USING (public.current_user_is_admin());

-- Functions to process inventory and sales atomically
CREATE OR REPLACE FUNCTION public.process_inventory_movement(
  p_product_id TEXT,
  p_from_unit_id TEXT,
  p_to_unit_id TEXT,
  p_type TEXT,
  p_quantity INTEGER,
  p_serials JSONB,
  p_card_condition TEXT,
  p_operator_id TEXT,
  p_operator_name TEXT,
  p_timestamp TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inv_row inventory%ROWTYPE;
  current_qty INTEGER;
BEGIN
  SELECT * INTO inv_row FROM inventory WHERE product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto não encontrado no inventário';
  END IF;

  IF p_from_unit_id <> 'FORNECEDOR' THEN
    current_qty := COALESCE((inv_row.quantities -> p_from_unit_id ->> 'qty')::INTEGER, 0);
    IF current_qty < p_quantity THEN
      RAISE EXCEPTION 'Estoque insuficiente na origem %', p_from_unit_id;
    END IF;
    inv_row.quantities := jsonb_set(inv_row.quantities, ARRAY[p_from_unit_id, 'qty'], to_jsonb(current_qty - p_quantity), true);
  END IF;

  IF p_to_unit_id NOT IN ('CLIENTE', 'PERDA') THEN
    current_qty := COALESCE((inv_row.quantities -> p_to_unit_id ->> 'qty')::INTEGER, 0);
    inv_row.quantities := jsonb_set(inv_row.quantities, ARRAY[p_to_unit_id, 'qty'], to_jsonb(current_qty + p_quantity), true);
  END IF;

  UPDATE inventory
  SET quantities = inv_row.quantities,
      updated_at = NOW()
  WHERE product_id = p_product_id;

  INSERT INTO movements (
    id,
    product_id,
    variation_id,
    from_unit_id,
    to_unit_id,
    type,
    quantity,
    serials,
    card_condition,
    operator_id,
    operator_name,
    timestamp,
    reason
  ) VALUES (
    gen_random_uuid()::text,
    p_product_id,
    NULL,
    p_from_unit_id,
    p_to_unit_id,
    p_type,
    p_quantity,
    p_serials,
    p_card_condition,
    p_operator_id,
    p_operator_name,
    p_timestamp,
    p_reason
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_sale_transaction(
  p_sale_id TEXT,
  p_invoice_number TEXT,
  p_unit_id TEXT,
  p_items JSONB,
  p_payment_method TEXT,
  p_gross_amount NUMERIC,
  p_fee_amount NUMERIC,
  p_net_amount NUMERIC,
  p_operator_id TEXT,
  p_operator_name TEXT,
  p_client_cpf TEXT,
  p_client_name TEXT,
  p_timestamp TIMESTAMPTZ,
  p_status TEXT,
  p_requires_approval BOOLEAN
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  item JSONB;
  item_product_id TEXT;
  item_quantity INTEGER;
  current_qty INTEGER;
  inv_row inventory%ROWTYPE;
BEGIN
  INSERT INTO sales (
    id,
    invoice_number,
    unit_id,
    items,
    payment_method,
    gross_amount,
    fee_amount,
    net_amount,
    operator_id,
    operator_name,
    client_cpf,
    client_name,
    timestamp,
    status,
    requires_approval
  ) VALUES (
    p_sale_id,
    p_invoice_number,
    p_unit_id,
    p_items,
    p_payment_method,
    p_gross_amount,
    p_fee_amount,
    p_net_amount,
    p_operator_id,
    p_operator_name,
    p_client_cpf,
    p_client_name,
    p_timestamp,
    p_status,
    p_requires_approval
  );

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::INTEGER;

    SELECT * INTO inv_row FROM inventory WHERE product_id = item_product_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produto % não encontrado no inventário', item_product_id;
    END IF;

    IF p_unit_id <> 'CLIENTE' THEN
      current_qty := COALESCE((inv_row.quantities -> p_unit_id ->> 'qty')::INTEGER, 0);
      IF current_qty < item_quantity THEN
        RAISE EXCEPTION 'Estoque insuficiente para o produto % na loja %', item_product_id, p_unit_id;
      END IF;
      UPDATE inventory
      SET quantities = jsonb_set(
        inv_row.quantities,
        ARRAY[p_unit_id, 'qty'],
        to_jsonb(current_qty - item_quantity),
        true
      ), updated_at = NOW()
      WHERE product_id = item_product_id;
    END IF;

    INSERT INTO movements (
      id,
      product_id,
      variation_id,
      from_unit_id,
      to_unit_id,
      type,
      quantity,
      serials,
      card_condition,
      operator_id,
      operator_name,
      timestamp,
      reason
    ) VALUES (
      gen_random_uuid()::text,
      item_product_id,
      (item->>'variationId'),
      p_unit_id,
      'CLIENTE',
      'SAIDA',
      item_quantity,
      item->'serials',
      item->>'cardCondition',
      p_operator_id,
      p_operator_name,
      p_timestamp,
      'Venda registrada'
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_sale_cancellation(
  p_sale_id TEXT,
  p_approved_by TEXT
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  sale_row sales%ROWTYPE;
  item JSONB;
  item_product_id TEXT;
  item_quantity INTEGER;
BEGIN
  SELECT * INTO sale_row FROM sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda não encontrada';
  END IF;

  UPDATE sales
  SET status = 'CANCELADA', approved_by = p_approved_by
  WHERE id = p_sale_id;

  FOR item IN SELECT * FROM jsonb_array_elements(sale_row.items) LOOP
    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::INTEGER;

    UPDATE inventory
    SET quantities = jsonb_set(
      quantities,
      ARRAY[sale_row.unit_id, 'qty'],
      to_jsonb(COALESCE((quantities -> sale_row.unit_id ->> 'qty')::INTEGER, 0) + item_quantity),
      true
    ), updated_at = NOW()
    WHERE product_id = item_product_id;

    INSERT INTO movements (
      id,
      product_id,
      variation_id,
      from_unit_id,
      to_unit_id,
      type,
      quantity,
      serials,
      card_condition,
      operator_id,
      operator_name,
      timestamp,
      reason
    ) VALUES (
      gen_random_uuid()::text,
      item_product_id,
      (item->>'variationId'),
      'CLIENTE',
      sale_row.unit_id,
      'SAIDA',
      item_quantity,
      item->'serials',
      item->>'cardCondition',
      sale_row.operator_id,
      sale_row.operator_name,
      NOW(),
      'Cancelamento de venda'
    );
  END LOOP;
END;
$$;
`;

export const SQL_STORE_CONFIGS_MIGRATION_SCRIPT = `-- Migração de cadastro de lojas para uma base Supabase já existente
-- Execute uma única vez no SQL Editor do Supabase.
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS trade_name TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS cnpj TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS state_registration TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS contact_email TEXT;`;

export const supabaseService = {
  async getPlatformTenants(): Promise<PlatformTenant[]> {
    const { data, error } = await supabase.rpc('platform_list_tenants');
    if (error) throw error;

    return (data || []).map((tenant: any) => ({
      id: tenant.id,
      legalName: tenant.legal_name ?? null,
      tradeName: tenant.trade_name ?? null,
      cnpj: tenant.cnpj ?? null,
      storeCount: Number(tenant.store_count || 0),
      subscriptionStatus: tenant.subscription_status as SubscriptionStatus | null,
      createdAt: tenant.created_at
    }));
  },

  async getPlatformTenantDetails(tenantId: string): Promise<PlatformTenantDetails> {
    const { data, error } = await supabase.rpc('platform_tenant_details', {
      p_tenant_id: tenantId
    });
    if (error) throw error;
    return data as PlatformTenantDetails;
  },

  async updatePlatformSubscriptionStatus(tenantId: string, subscriptionStatus: SubscriptionStatus): Promise<void> {
    const { error } = await supabase.rpc('platform_update_subscription_status', {
      p_tenant_id: tenantId,
      p_subscription_status: subscriptionStatus
    });
    if (error) throw error;
  },

  async createPlatformPosTerminalActivation(input: {
    tenantId: string;
    unitId: string;
    terminalLabel: string;
    expiresInMinutes: number;
  }): Promise<{ code: string; activation: PosTerminalActivation }> {
    const { data, error } = await supabase.rpc('platform_create_pos_terminal_activation', {
      p_tenant_id: input.tenantId,
      p_unit_id: input.unitId,
      p_terminal_label: input.terminalLabel,
      p_expires_in_minutes: input.expiresInMinutes
    });
    if (error) throw error;

    if (!data?.code || !data?.activation) {
      throw new Error('Resposta inválida ao gerar o código de ativação.');
    }

    return {
      code: data.code,
      activation: mapPosTerminalActivation(data.activation)
    };
  },

  async getPlatformPosTerminalActivations(tenantId: string): Promise<PosTerminalActivation[]> {
    const { data, error } = await supabase.rpc('platform_list_pos_terminal_activations', {
      p_tenant_id: tenantId,
      p_unit_id: null
    });
    if (error) throw error;
    return (data || []).map(mapPosTerminalActivation);
  },

  async getPlatformPdvOperators(tenantId: string): Promise<PdvOperator[]> {
    const { data, error } = await supabase.rpc('platform_list_pdv_operators', {
      p_tenant_id: tenantId
    });
    if (error) throw error;
    return (data || []).map(mapPdvOperator);
  },

  // Chave da Focus por loja (UCP). A chave nunca volta do banco: so "configurada" e o ambiente.
  async getPlatformStoreFiscal(tenantId: string): Promise<StoreNfceStatus[]> {
    const { data, error } = await supabase.rpc('platform_list_store_fiscal', { p_tenant_id: tenantId });
    if (error) throw error;
    return (data || []).map((row: any) => ({
      unitId: row.unit_id,
      configured: Boolean(row.configured),
      environment: row.environment ?? null
    }));
  },

  async setPlatformStoreFocus(input: { tenantId: string; unitId: string; token: string; environment: 'homologacao' | 'producao' }): Promise<void> {
    const { error } = await supabase.rpc('platform_set_store_focus', {
      p_tenant_id: input.tenantId,
      p_unit_id: input.unitId,
      p_token: input.token,
      p_environment: input.environment
    });
    if (error) throw error;
  },

  async clearPlatformStoreFocus(tenantId: string, unitId: string): Promise<void> {
    const { error } = await supabase.rpc('platform_clear_store_focus', { p_tenant_id: tenantId, p_unit_id: unitId });
    if (error) throw error;
  },

  async createPlatformTenant(input: {
    legalName: string;
    cnpj: string;
    adminEmail: string;
    initialPassword: string;
  }): Promise<{ tenantId: string; adminEmail: string }> {
    const { data, error } = await supabase.functions.invoke('create-tenant-admin', {
      body: input
    });

    if (error) throw error;
    if (!data?.tenantId || !data?.adminEmail) {
      throw new Error('Resposta inválida do serviço de provisionamento.');
    }

    return data;
  },

  async getCurrentAppUserProfile(authUserId: string): Promise<{
    role: UserRole;
    tenantId: string | null;
    unitId: string | null;
    planCode: string | null;
    subscriptionStatus: 'ATIVO' | 'ATRASADO' | 'BLOQUEADO' | 'CANCELADO' | null;
  } | null> {
    const { data, error } = await supabase
      .from('app_users')
      .select('role, tenant_id, unit_id')
      .eq('auth_uid', authUserId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    if (!Object.values(UserRole).includes(data.role as UserRole)) {
      throw new Error('O usuário possui um papel de acesso inválido.');
    }

    let planCode: string | null = null;
    let subscriptionStatus: 'ATIVO' | 'ATRASADO' | 'BLOQUEADO' | 'CANCELADO' | null = null;

    if (data.tenant_id) {
      const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .select('plan_code, subscription_status')
        .eq('id', data.tenant_id)
        .maybeSingle();

      if (!tenantError && tenant) {
        planCode = tenant.plan_code || null;
        subscriptionStatus = tenant.subscription_status || null;
      }
    }

    return {
      role: data.role as UserRole,
      tenantId: data.tenant_id,
      unitId: data.unit_id,
      planCode,
      subscriptionStatus
    };
  },

  // Test connection and find missing tables
  async testConnection(): Promise<{ connected: boolean; error?: string; missingTables?: string[] }> {
    try {
      const missingTables: string[] = [];
      const tablesToCheck = [
        'products', 'inventory', 'movements', 'sales', 
        'expenses', 'trade_ins', 'work_orders', 'store_configs', 'suppliers', 'services'
      ];

      // We will perform a quick request on 'products' first
      const { error: initialErr } = await supabase.from('products').select('id').limit(1);
      
      if (initialErr) {
        if (isTableMissingError(initialErr)) {
          // Connected but schema is not ready
          missingTables.push('products');
        } else {
          return { connected: false, error: initialErr.message };
        }
      }

      // Check others if needed
      for (const table of tablesToCheck) {
        if (table === 'products' && missingTables.includes('products')) continue;
        const { error } = await supabase.from(table).select('*').limit(1);
        if (error && isTableMissingError(error)) {
          missingTables.push(table);
        }
      }

      return { 
        connected: true, 
        missingTables 
      };
    } catch (e: any) {
      return { connected: false, error: e.message || 'Erro desconhecido ao conectar' };
    }
  },

  // === CLIENTES ===
  async getCustomers(): Promise<Customer[]> {
    const { data, error } = await supabase.from('customers').select('*').order('name');
    if (error) throw error;
    return (data || []).map(c => ({
      id: c.id,
      code: Number(c.code),
      cpf: c.cpf,
      name: c.name,
      phone: c.phone,
      email: c.email ?? null,
      cep: c.cep ?? null,
      address: c.address ?? null,
      addressNumber: c.address_number ?? null,
      complement: c.complement ?? null,
      district: c.district ?? null,
      city: c.city ?? null,
      state: c.state ?? null,
      lgpdConsent: Boolean(c.lgpd_consent),
      lgpdConsentAt: c.lgpd_consent_at ?? null,
      notes: c.notes ?? null,
      isActive: Boolean(c.is_active),
      createdAt: c.created_at
    }));
  },

  // Sem id: cadastra (o banco gera o codigo). Com id: atualiza todos os campos.
  async saveCustomer(customer: Omit<Customer, 'code' | 'lgpdConsentAt' | 'createdAt'> & { id: string | null }): Promise<void> {
    const payload = {
      cpf: customer.cpf,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      cep: customer.cep,
      address: customer.address,
      address_number: customer.addressNumber,
      complement: customer.complement,
      district: customer.district,
      city: customer.city,
      state: customer.state,
      lgpd_consent: customer.lgpdConsent,
      notes: customer.notes,
      is_active: customer.isActive
    };
    const { error } = customer.id
      ? await supabase.from('customers').update(payload).eq('id', customer.id)
      : await supabase.from('customers').insert(payload);
    if (error) {
      if (error.code === '23505' && String(error.message || '').includes('customers_tenant_cpf_key')) {
        throw new Error('Já existe um cliente com este CPF.');
      }
      throw error;
    }
  },

  // === PRODUCTS ===
  async getProducts(): Promise<Product[]> {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []).map(p => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      brand: p.brand || '',
      costPrice: Number(p.cost_price),
      sellPrice: Number(p.sell_price),
      ncm: p.ncm || '',
      warrantyMonths: p.warranty_months || 0,
      isSerialized: p.is_serialized,
      isUsed: p.is_used,
      variations: p.variations || undefined,
      isKit: p.is_kit,
      kitItems: p.kit_items || undefined,
      minStock: p.min_stock ?? null,
      maxDiscountPercent: p.max_discount_percent == null ? null : Number(p.max_discount_percent),
      cest: p.cest ?? null,
      icmsOrigin: p.icms_origin ?? null,
      icmsCst: p.icms_cst ?? null,
      csosn: p.csosn ?? null,
      icmsRate: p.icms_rate == null ? null : Number(p.icms_rate),
      icmsReduction: p.icms_reduction == null ? null : Number(p.icms_reduction),
      taxBurdenPercent: p.tax_burden_percent == null ? null : Number(p.tax_burden_percent)
    }));
  },

  // Devolve o codigo gravado: vazio vira o proximo numero automatico (trigger do banco).
  async upsertProduct(p: Product): Promise<string> {
    const payload = {
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      brand: p.brand,
      cost_price: p.costPrice,
      sell_price: p.sellPrice,
      ncm: p.ncm,
      warranty_months: p.warrantyMonths,
      is_serialized: p.isSerialized,
      is_used: p.isUsed,
      variations: p.variations || null,
      is_kit: p.isKit || false,
      kit_items: p.kitItems || null,
      min_stock: p.minStock ?? null,
      max_discount_percent: p.maxDiscountPercent ?? null,
      cest: p.cest?.trim() || null,
      icms_origin: p.icmsOrigin || null,
      icms_cst: p.icmsCst || null,
      csosn: p.csosn || null,
      icms_rate: p.icmsRate ?? null,
      icms_reduction: p.icmsReduction ?? null,
      tax_burden_percent: p.taxBurdenPercent ?? null
    };

    const { data, error } = await supabase
      .from('products')
      .upsert(payload)
      .select('sku')
      .single();

    if (error) throw error;
    return data.sku;
  },

  // Proximo codigo automatico (so para mostrar no formulario).
  async getNextItemCode(): Promise<string> {
    const { data, error } = await supabase.rpc('get_next_item_code');
    if (error) throw error;
    return String(data ?? '');
  },

  async deleteProduct(id: string): Promise<void> {
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) throw error;
  },

  async getServices(): Promise<Service[]> {
    const { data, error } = await supabase.from('services').select('*').order('name');
    if (error) throw error;
    return (data || []).map(service => ({
      id: service.id,
      sku: service.sku,
      name: service.name,
      category: service.category,
      sellPrice: Number(service.sell_price),
      isActive: service.is_active
    }));
  },

  async upsertService(service: Service): Promise<string> {
    const { data, error } = await supabase.from('services').upsert({
      id: service.id,
      sku: service.sku.trim(),
      name: service.name.trim(),
      category: service.category.trim(),
      sell_price: service.sellPrice,
      is_active: service.isActive
    }).select('sku').single();
    if (error) throw error;
    return data.sku;
  },

  async deleteService(id: string): Promise<void> {
    const { error } = await supabase.from('services').delete().eq('id', id);
    if (error) throw error;
  },

  // === INVENTORY ===
  async getInventory(): Promise<StockInventory[]> {
    const { data, error } = await supabase.from('inventory').select('*');
    if (error) throw error;

    return (data || []).map(i => ({
      productId: i.product_id,
      quantities: i.quantities
    }));
  },

  async upsertInventory(inv: StockInventory): Promise<void> {
    const payload = {
      product_id: inv.productId,
      quantities: inv.quantities,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('inventory')
      .upsert(payload);

    if (error) throw error;
  },

  async processInventoryMovement(m: StockMovement): Promise<void> {
    const { error } = await supabase.rpc('process_inventory_movement', {
      p_product_id: m.productId,
      p_from_unit_id: m.fromUnitId,
      p_to_unit_id: m.toUnitId,
      p_type: m.type,
      p_quantity: m.quantity,
      p_serials: m.serials || null,
      p_card_condition: m.cardCondition || null,
      p_operator_id: m.operatorId,
      p_operator_name: m.operatorName,
      p_timestamp: m.timestamp,
      p_reason: m.reason
    });

    if (error) throw error;
  },

  async registerSerializedStockEntry(
    productId: string,
    unitId: string,
    units: SerializedStockEntryUnit[],
    reason: string
  ): Promise<void> {
    const { error } = await supabase.rpc('register_serialized_stock_entry', {
      p_product_id: productId,
      p_unit_id: unitId,
      p_units: units.map(unit => ({
        serialNumber: unit.serialNumber,
        imei: unit.imei || null,
        unitCost: unit.unitCost ?? null
      })),
      p_reason: reason
    });

    if (error) throw error;
  },

  // Entrada sem serial com custo: grava todas as lojas de uma vez (tudo ou nada)
  // e recalcula o custo medio de cada loja que recebeu.
  async registerStockEntry(
    productId: string,
    entries: StockEntryLine[],
    unitCost: number,
    reason: string
  ): Promise<void> {
    const { error } = await supabase.rpc('register_stock_entry', {
      p_product_id: productId,
      p_entries: entries.map(entry => ({ unitId: entry.unitId, quantity: entry.quantity })),
      p_unit_cost: unitCost,
      p_reason: reason
    });

    if (error) throw error;
  },

  async getProductStoreCosts(): Promise<ProductStoreCost[]> {
    const { data, error } = await supabase.rpc('list_product_store_costs');
    if (error) throw error;
    return (data || []).map((row: { product_id: string; unit_id: string; avg_cost: number | string; unit_count: number | null }) => ({
      productId: row.product_id,
      unitId: row.unit_id,
      avgCost: Number(row.avg_cost),
      unitCount: row.unit_count ?? null
    }));
  },

  async processSaleTransaction(s: Sale): Promise<void> {
    const { error } = await supabase.rpc('process_sale_transaction', {
      p_sale_id: s.id,
      p_invoice_number: s.invoiceNumber,
      p_unit_id: s.unitId,
      p_items: s.items,
      p_payment_method: s.paymentMethod,
      p_gross_amount: s.grossAmount,
      p_fee_amount: s.feeAmount,
      p_net_amount: s.netAmount,
      p_operator_id: s.operatorId,
      p_operator_name: s.operatorName,
      p_client_cpf: s.clientCpf || null,
      p_client_name: s.clientName || null,
      p_timestamp: s.timestamp,
      p_status: s.status,
      p_requires_approval: s.requiresApproval
    });

    if (error) throw error;
  },

  async processSaleCancellation(saleId: string, approvedBy?: string): Promise<void> {
    const { error } = await supabase.rpc('process_sale_cancellation', {
      p_sale_id: saleId,
      p_approved_by: approvedBy || null
    });

    if (error) throw error;
  },

  // === MOVEMENTS ===
  async getMovements(): Promise<StockMovement[]> {
    const { data, error } = await supabase
      .from('movements')
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) throw error;
    return (data || []).map(m => ({
      id: m.id,
      productId: m.product_id,
      variationId: m.variation_id || undefined,
      fromUnitId: m.from_unit_id,
      toUnitId: m.to_unit_id,
      type: m.type,
      quantity: m.quantity,
      serials: m.serials || undefined,
      cardCondition: m.card_condition || undefined,
      operatorId: m.operator_id,
      operatorName: m.operator_name,
      timestamp: m.timestamp,
      reason: m.reason || ''
    }));
  },

  async upsertMovement(m: StockMovement): Promise<void> {
    const payload = {
      id: m.id,
      product_id: m.productId,
      variation_id: m.variationId || null,
      from_unit_id: m.fromUnitId,
      to_unit_id: m.toUnitId,
      type: m.type,
      quantity: m.quantity,
      serials: m.serials || null,
      card_condition: m.cardCondition || null,
      operator_id: m.operatorId,
      operator_name: m.operatorName,
      timestamp: m.timestamp,
      reason: m.reason
    };

    const { error } = await supabase.from('movements').upsert(payload);
    if (error) throw error;
  },

  // === SALES ===
  async getSales(): Promise<Sale[]> {
    const { data, error } = await supabase
      .from('sales')
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) throw error;

    // Linhas de pagamento das vendas do PDV. Tolerante a falha para o ERP
    // continuar funcionando antes da migration 2.7 ser aplicada.
    const paymentsBySale = new Map<string, SalePaymentLine[]>();
    const { data: paymentRows, error: paymentsError } = await supabase
      .from('sale_payments')
      .select('sale_id, payment_method, amount, installments')
      .order('created_at', { ascending: true });
    if (paymentsError) {
      console.warn('Nao foi possivel carregar sale_payments:', paymentsError.message);
    } else {
      (paymentRows || []).forEach(p => {
        const lines = paymentsBySale.get(p.sale_id) ?? [];
        lines.push({
          paymentMethod: p.payment_method,
          amount: Number(p.amount),
          installments: Number(p.installments ?? 1)
        });
        paymentsBySale.set(p.sale_id, lines);
      });
    }

    // Trocas/devolucoes (2.9). Tolerante a falha antes da migration 20261030.
    const returnsBySale = new Map<string, SaleReturnInfo[]>();
    const { data: returnRows, error: returnsError } = await supabase
      .from('sale_returns')
      .select('id, sale_id, return_number, created_at, refund_method, total_amount, reason, fiscal_status, nfe_number, nfe_xml_url, nfe_danfe_url')
      .order('created_at', { ascending: true });
    if (!returnsError) {
      const costBack = new Map<string, number>();
      const { data: itemRows } = await supabase
        .from('sale_return_items')
        .select('return_id, quantity, unit_cost, destination');
      (itemRows || []).forEach(item => {
        if (item.destination !== 'ESTOQUE') return;
        costBack.set(item.return_id, (costBack.get(item.return_id) ?? 0) + Number(item.unit_cost ?? 0) * Number(item.quantity));
      });
      (returnRows || []).forEach(r => {
        const list = returnsBySale.get(r.sale_id) ?? [];
        list.push({
          id: r.id,
          returnNumber: r.return_number,
          createdAt: r.created_at,
          refundMethod: r.refund_method,
          totalAmount: Number(r.total_amount),
          costBack: Math.round((costBack.get(r.id) ?? 0) * 100) / 100,
          reason: r.reason,
          fiscalStatus: r.fiscal_status ?? undefined,
          nfeNumber: r.nfe_number ?? undefined,
          nfeXmlUrl: r.nfe_xml_url ?? undefined,
          nfeDanfeUrl: r.nfe_danfe_url ?? undefined
        });
        returnsBySale.set(r.sale_id, list);
      });
    }

    return (data || []).map(s => ({
      id: s.id,
      invoiceNumber: s.invoice_number,
      unitId: s.unit_id,
      items: s.items,
      paymentMethod: s.payment_method,
      payments: paymentsBySale.get(s.id),
      grossAmount: Number(s.gross_amount),
      feeAmount: Number(s.fee_amount),
      netAmount: Number(s.net_amount),
      operatorId: s.operator_id,
      operatorName: s.operator_name,
      clientCpf: s.client_cpf || undefined,
      clientName: s.client_name || undefined,
      timestamp: s.timestamp,
      status: s.status,
      requiresApproval: s.requires_approval,
      approvedBy: s.approved_by || undefined,
      sellerCode: s.seller_code || undefined,
      sellerName: s.seller_name || undefined,
      finalizedByName: s.finalized_by_name || undefined,
      receiptNumber: s.receipt_number ?? undefined,
      receiptPeriod: s.receipt_period ?? undefined,
      fiscalType: s.fiscal_type ?? undefined,
      fiscalStatus: s.fiscal_status ?? undefined,
      nfceNumber: s.nfce_number ?? undefined,
      nfceSeries: s.nfce_series ?? undefined,
      nfceKey: s.nfce_key ?? undefined,
      nfceEnvironment: s.nfce_environment ?? undefined,
      nfceXmlUrl: s.nfce_xml_url ?? undefined,
      nfceDanfeUrl: s.nfce_danfe_url ?? undefined,
      nfceMessage: s.nfce_message ?? undefined,
      nfceAuthorizedAt: s.nfce_authorized_at ?? undefined,
      nfceContingencyPending: s.nfce_contingency === true && s.nfce_contingency_done !== true,
      returns: returnsBySale.get(s.id)
    }));
  },

  // === Modo offline do PDV: divergencias das vendas feitas sem internet ===
  async getOfflineConflicts(): Promise<{ id: string; unitId: string; saleId: string; kind: string; detail: string; createdAt: string }[]> {
    const { data, error } = await supabase
      .from("pos_offline_conflicts")
      .select("id, unit_id, sale_id, kind, detail, created_at")
      .eq("resolved", false)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(row => ({ id: row.id, unitId: row.unit_id, saleId: row.sale_id, kind: row.kind, detail: row.detail, createdAt: row.created_at }));
  },

  async resolveOfflineConflict(conflictId: string, resolvedBy: string): Promise<void> {
    const { error } = await supabase.rpc("resolve_pos_offline_conflict", { p_conflict_id: conflictId, p_resolved_by: resolvedBy });
    if (error) throw error;
  },

  // === Avariados (2.9): saldo por loja (sem serial) e unidades serializadas avariadas ===
  async getDamagedStock(): Promise<{ unitId: string; productId: string; quantity: number; serials: string[] }[]> {
    const rows = new Map<string, { unitId: string; productId: string; quantity: number; serials: string[] }>();
    const { data: stock, error: stockError } = await supabase
      .from('product_damaged_stock')
      .select('unit_id, product_id, quantity')
      .gt('quantity', 0);
    if (stockError) throw stockError;
    (stock || []).forEach(row => rows.set(`${row.unit_id}|${row.product_id}`, { unitId: row.unit_id, productId: row.product_id, quantity: Number(row.quantity), serials: [] }));
    const { data: units, error: unitsError } = await supabase
      .from('product_serial_units')
      .select('unit_id, product_id, serial_number')
      .eq('status', 'AVARIADO');
    if (unitsError) throw unitsError;
    (units || []).forEach(unit => {
      const key = `${unit.unit_id}|${unit.product_id}`;
      const row = rows.get(key) ?? { unitId: unit.unit_id, productId: unit.product_id, quantity: 0, serials: [] };
      row.quantity += 1;
      row.serials.push(unit.serial_number);
      rows.set(key, row);
    });
    return Array.from(rows.values());
  },

  // === NFC-e (2.8b) ===
  async getStoreNfceStatus(): Promise<StoreNfceStatus[]> {
    const { data, error } = await supabase.rpc('list_store_nfce_status');
    if (error) throw error;
    return (data || []).map((row: any) => ({
      unitId: row.unit_id,
      configured: Boolean(row.configured),
      environment: row.environment ?? null
    }));
  },

  // Cancela a NFC-e na Sefaz (ate 30 min depois da autorizacao). Lanca o motivo se recusado.
  async cancelSaleNfce(saleId: string, justification: string): Promise<void> {
    const { data, error } = await supabase.functions.invoke('nfce-cancel', {
      body: { saleId, justification }
    });
    if (error) {
      const context = (error as { context?: Response }).context;
      const body = context && typeof context.json === 'function' ? await context.json().catch(() => null) : null;
      throw new Error(body?.error || 'Não foi possível cancelar a NFC-e.');
    }
    if (data?.status !== 'CANCELADA') throw new Error(data?.error || 'Não foi possível cancelar a NFC-e.');
  },

  // Muda so o status: nunca regrava os itens (o custo congelado vem do servidor).
  async updateSaleStatus(saleId: string, status: SaleStatus): Promise<void> {
    const { error } = await supabase.from('sales').update({ status }).eq('id', saleId);
    if (error) throw error;
  },

  async upsertSale(s: Sale): Promise<void> {
    const payload = {
      id: s.id,
      invoice_number: s.invoiceNumber,
      unit_id: s.unitId,
      items: s.items,
      payment_method: s.paymentMethod,
      gross_amount: s.grossAmount,
      fee_amount: s.feeAmount,
      net_amount: s.netAmount,
      operator_id: s.operatorId,
      operator_name: s.operatorName,
      client_cpf: s.clientCpf || null,
      client_name: s.clientName || null,
      timestamp: s.timestamp,
      status: s.status,
      requires_approval: s.requiresApproval,
      approved_by: s.approvedBy || null
    };

    const { error } = await supabase.from('sales').upsert(payload);
    if (error) throw error;
  },

  // === EXPENSES ===
  async getExpenses(): Promise<Expense[]> {
    const { data, error } = await supabase
      .from('expenses')
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) throw error;
    return (data || []).map(e => ({
      id: e.id,
      unitId: e.unit_id,
      description: e.description,
      category: e.category,
      amount: Number(e.amount),
      operatorId: e.operator_id,
      operatorName: e.operator_name,
      timestamp: e.timestamp
    }));
  },

  async upsertExpense(e: Expense): Promise<void> {
    const payload = {
      id: e.id,
      unit_id: e.unitId,
      description: e.description,
      category: e.category,
      amount: e.amount,
      operator_id: e.operatorId,
      operator_name: e.operatorName,
      timestamp: e.timestamp
    };

    const { error } = await supabase.from('expenses').upsert(payload);
    if (error) throw error;
  },

  // === TRADE INS ===
  async getTradeIns(): Promise<TradeIn[]> {
    const { data, error } = await supabase
      .from('trade_ins')
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) throw error;
    return (data || []).map(t => ({
      id: t.id,
      sellerName: t.seller_name,
      sellerCpf: t.seller_cpf,
      itemDescription: t.item_description,
      category: t.category,
      condition: t.condition,
      valuationAmount: Number(t.valuation_amount),
      operatorId: t.operator_id,
      operatorName: t.operator_name,
      unitId: t.unit_id,
      timestamp: t.timestamp,
      status: t.status,
      createdProductId: t.created_product_id || undefined
    }));
  },

  async upsertTradeIn(t: TradeIn): Promise<void> {
    const payload = {
      id: t.id,
      seller_name: t.sellerName,
      seller_cpf: t.sellerCpf,
      item_description: t.itemDescription,
      category: t.category,
      condition: t.condition,
      valuation_amount: t.valuationAmount,
      operator_id: t.operatorId,
      operator_name: t.operatorName,
      unit_id: t.unitId,
      timestamp: t.timestamp,
      status: t.status,
      created_product_id: t.createdProductId || null
    };

    const { error } = await supabase.from('trade_ins').upsert(payload);
    if (error) throw error;
  },

  // === WORK ORDERS ===
  async getWorkOrders(): Promise<WorkOrder[]> {
    const { data, error } = await supabase
      .from('work_orders')
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) throw error;
    return (data || []).map(w => ({
      id: w.id,
      osNumber: w.os_number,
      clientName: w.client_name,
      clientPhone: w.client_phone,
      equipment: w.equipment,
      problemDescription: w.problem_description,
      status: w.status,
      partsCost: Number(w.parts_cost),
      laborCost: Number(w.labor_cost),
      totalCost: Number(w.total_cost),
      linkedSerial: w.linked_serial || undefined,
      unitId: w.unit_id,
      operatorId: w.operator_id,
      operatorName: w.operator_name,
      timestamp: w.timestamp
    }));
  },

  async upsertWorkOrder(w: WorkOrder): Promise<void> {
    const payload = {
      id: w.id,
      os_number: w.osNumber,
      client_name: w.clientName,
      client_phone: w.clientPhone,
      equipment: w.equipment,
      problem_description: w.problemDescription,
      status: w.status,
      parts_cost: w.partsCost,
      labor_cost: w.laborCost,
      total_cost: w.totalCost,
      linked_serial: w.linkedSerial || null,
      unit_id: w.unitId,
      operator_id: w.operatorId,
      operator_name: w.operatorName,
      timestamp: w.timestamp
    };

    const { error } = await supabase.from('work_orders').upsert(payload);
    if (error) throw error;
  },

  // === STORE CONFIGS ===
  async getStoreConfigs(): Promise<StoreConfig[]> {
    const { data, error } = await supabase.from('store_configs').select('*');
    if (error) throw error;

    return (data || []).map(c => ({
      unitId: c.unit_id,
      fixedCost: Number(c.fixed_cost),
      maxItemDiscountPercent: Number(c.max_item_discount_percent ?? 0),
      paymentFees: c.payment_fees,
      tradeName: c.trade_name || undefined,
      legalName: c.legal_name || undefined,
      cnpj: c.cnpj || undefined,
      stateRegistration: c.state_registration || undefined,
      address: c.address || undefined,
      phone: c.phone || undefined,
      contactEmail: c.contact_email || undefined,
      reservationVoucherTerms: c.reservation_voucher_terms || undefined,
      instagram: c.instagram || undefined,
      exchangeDays: c.exchange_days == null ? undefined : Number(c.exchange_days)
    }));
  },

  async upsertStoreConfig(c: StoreConfig): Promise<void> {
    const payload = {
      unit_id: c.unitId,
      fixed_cost: c.fixedCost,
      max_item_discount_percent: c.maxItemDiscountPercent ?? 0,
      payment_fees: c.paymentFees,
      trade_name: c.tradeName || null,
      legal_name: c.legalName || null,
      cnpj: c.cnpj || null,
      state_registration: c.stateRegistration || null,
      address: c.address || null,
      phone: c.phone || null,
      contact_email: c.contactEmail || null,
      reservation_voucher_terms: c.reservationVoucherTerms?.trim() || null,
      instagram: c.instagram?.trim() || null,
      ...(c.exchangeDays != null ? { exchange_days: Math.max(0, Math.min(365, Math.round(c.exchangeDays))) } : {})
    };

    const { error } = await supabase.from('store_configs').upsert(payload);
    if (error) throw error;
  },

  async deleteStoreConfig(tenantId: string, unitId: string): Promise<void> {
    const { error } = await supabase
      .from('store_configs')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('unit_id', unitId);

    if (error) throw error;
  },

  async getPdvOperators(): Promise<PdvOperator[]> {
    const { data, error } = await supabase
      .from('pdv_operators')
      .select('*')
      .order('name');
    if (error) throw error;
    return (data || []).map(mapPdvOperator);
  },

  async upsertPdvOperator(operator: Omit<PdvOperator, 'tenantId' | 'createdAt' | 'updatedAt'>): Promise<PdvOperator> {
    const { data, error } = await supabase
      .from('pdv_operators')
      .upsert({
        id: operator.id,
        unit_id: operator.unitId,
        code: operator.code,
        name: operator.name,
        permissions: operator.permissions,
        is_active: operator.isActive
      })
      .select()
      .single();
    if (error) {
      // Indice unico (tenant + loja + codigo, entre ativos): mensagem clara.
      if (error.code === '23505' && String(error.message || '').includes('pdv_operators_tenant_unit_code_key')) {
        throw new Error(`Já existe um vendedor ativo com o código ${operator.code} nesta loja.`);
      }
      throw error;
    }
    return mapPdvOperator(data);
  },

  async deletePdvOperator(id: string): Promise<void> {
    const { error } = await supabase
      .from('pdv_operators')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },

  async updateCurrentUserDisplayName(displayName: string): Promise<void> {
    const { error } = await supabase.auth.updateUser({
      data: { name: displayName }
    });

    if (error) throw error;
  },

  // === SUPPLIERS ===
  async getSuppliers(): Promise<Supplier[]> {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true });

    if (error) throw error;
    return (data || []).map(s => ({
      id: s.id,
      name: s.name,
      cnpj: s.cnpj,
      contact: s.contact,
      category: s.category,
      historyCount: s.history_count,
      phone: s.phone || undefined,
      website: s.website || undefined
    }));
  },

  async upsertSupplier(s: Supplier): Promise<void> {
    const payload = {
      id: s.id,
      name: s.name,
      cnpj: s.cnpj,
      contact: s.contact,
      category: s.category,
      history_count: s.historyCount,
      phone: s.phone || null,
      website: s.website || null
    };

    const { error } = await supabase.from('suppliers').upsert(payload);
    if (error) throw error;
  },

  async deleteSupplier(id: string): Promise<void> {
    const { error } = await supabase.from('suppliers').delete().eq('id', id);
    if (error) throw error;
  },

  // === SUPPLIER INVOICES / ACCOUNTS PAYABLE ===
  async getSupplierInvoices(): Promise<SupplierInvoiceReminder[]> {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('*')
      .order('due_date', { ascending: true });

    if (error) throw error;
    return (data || []).map(invoice => ({
      id: invoice.id,
      supplierId: invoice.supplier_id || 'custom',
      supplierName: invoice.supplier_name,
      description: invoice.description,
      amount: Number(invoice.amount),
      dueDate: invoice.due_date,
      installments: invoice.installments,
      status: invoice.status,
      notes: invoice.notes || undefined,
      createdAt: invoice.created_at
    }));
  },

  async upsertSupplierInvoice(invoice: SupplierInvoiceReminder): Promise<void> {
    const { error } = await supabase.from('supplier_invoices').upsert({
      id: invoice.id,
      supplier_id: invoice.supplierId === 'custom' ? null : invoice.supplierId,
      supplier_name: invoice.supplierName,
      description: invoice.description,
      amount: invoice.amount,
      due_date: invoice.dueDate,
      installments: invoice.installments,
      status: invoice.status,
      notes: invoice.notes || null,
      created_at: invoice.createdAt
    });

    if (error) throw error;
  },

  async deleteSupplierInvoice(id: string): Promise<void> {
    const { error } = await supabase.from('supplier_invoices').delete().eq('id', id);
    if (error) throw error;
  },

  // Export all local database structures to Supabase in bulk
  async exportAllToSupabase(data: {
    products: Product[];
    inventory: StockInventory[];
    movements: StockMovement[];
    sales: Sale[];
    expenses: Expense[];
    tradeIns: TradeIn[];
    workOrders: WorkOrder[];
    storeConfigs: StoreConfig[];
    suppliers: Supplier[];
  }): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Helper to upload in batches
    const runTask = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err: any) {
        errors.push(`Erro ao exportar ${name}: ${err.message || err}`);
      }
    };

    // 1. Products
    await runTask('Produtos', async () => {
      for (const p of data.products) {
        await this.upsertProduct(p);
      }
    });

    // 2. Inventory
    await runTask('Estoque', async () => {
      for (const i of data.inventory) {
        await this.upsertInventory(i);
      }
    });

    // 3. Movements
    await runTask('Movimentações', async () => {
      for (const m of data.movements) {
        await this.upsertMovement(m);
      }
    });

    // 4. Sales
    await runTask('Vendas', async () => {
      for (const s of data.sales) {
        await this.upsertSale(s);
      }
    });

    // 5. Expenses
    await runTask('Despesas', async () => {
      for (const e of data.expenses) {
        await this.upsertExpense(e);
      }
    });

    // 6. Trade Ins
    await runTask('Trocas', async () => {
      for (const t of data.tradeIns) {
        await this.upsertTradeIn(t);
      }
    });

    // 7. Work Orders
    await runTask('Ordens de Serviço', async () => {
      for (const w of data.workOrders) {
        await this.upsertWorkOrder(w);
      }
    });

    // 8. Store Configs
    await runTask('Configurações', async () => {
      for (const c of data.storeConfigs) {
        await this.upsertStoreConfig(c);
      }
    });

    // 9. Suppliers
    await runTask('Fornecedores', async () => {
      for (const s of data.suppliers) {
        await this.upsertSupplier(s);
      }
    });

    return {
      success: errors.length === 0,
      errors
    };
  }
};
