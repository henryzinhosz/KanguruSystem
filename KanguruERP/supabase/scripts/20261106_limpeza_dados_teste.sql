-- Limpeza dos dados de teste (pedido do usuario em 2026-11-04/05). IRREVERSIVEL.
-- FICAM: empresa (tenants), lojas (store_configs), logins (app_users, user_store_access),
--   PDVs ativados (pos_terminals, pos_terminal_activations*), vendedores (pdv_operators),
--   produtos e servicos (cadastro), clientes (customers), Focus (store_fiscal_settings),
--   senha Gerente (store_manager_passwords), rede (networks, network_users,
--   network_royalty_rules, network_alert_settings).
-- SAEM: vendas, pagamentos, devolucoes, vales, notas, reservas, caixas, estoque/seriais/custos,
--   movimentos, balancos, OS, Troca Gamer, despesas, fornecedores/catalogos/pedidos,
--   metas/comunicados/pagamentos de repasse, tentativas de senha, conflitos offline.
-- TRUNCATE sem CASCADE: se alguma tabela que fica apontar para uma que sai, o Postgres
-- recusa e nada e apagado. Tudo numa transacao so.

BEGIN;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.tenants) <> 1 THEN
    RAISE EXCEPTION 'Esperava exatamente 1 empresa no banco. Limpeza cancelada.';
  END IF;
END;
$$;

TRUNCATE TABLE
  public.customer_credit_movements,
  public.customer_credits,
  public.sale_return_items,
  public.sale_returns,
  public.sale_service_invoice_events,
  public.sale_service_invoices,
  public.sale_fiscal_events,
  public.sale_discount_approvals,
  public.sale_payments,
  public.pos_reservation_payments,
  public.product_reservation_items,
  public.product_reservations,
  public.product_serial_units,
  public.trade_ins,
  public.work_orders,
  public.sales,
  public.pos_offline_conflicts,
  public.cash_register_movements,
  public.cash_register_sessions,
  public.pos_admin_password_attempts,
  public.movements,
  public.inventory,
  public.product_store_costs,
  public.product_damaged_stock,
  public.stock_count_items,
  public.stock_counts,
  public.expenses,
  public.purchase_order_items,
  public.purchase_orders,
  public.supplier_catalog_items,
  public.supplier_catalogs,
  public.supplier_invoices,
  public.suppliers,
  public.network_royalty_payments,
  public.network_store_goals,
  public.network_announcement_reads,
  public.network_announcements;

COMMIT;

-- Conferencia (rodar depois): o que ficou.
SELECT 'tenants' AS tabela, COUNT(*) FROM public.tenants
UNION ALL SELECT 'store_configs', COUNT(*) FROM public.store_configs
UNION ALL SELECT 'app_users', COUNT(*) FROM public.app_users
UNION ALL SELECT 'pos_terminals', COUNT(*) FROM public.pos_terminals
UNION ALL SELECT 'pdv_operators', COUNT(*) FROM public.pdv_operators
UNION ALL SELECT 'products', COUNT(*) FROM public.products
UNION ALL SELECT 'services', COUNT(*) FROM public.services
UNION ALL SELECT 'customers', COUNT(*) FROM public.customers
UNION ALL SELECT 'sales', COUNT(*) FROM public.sales
UNION ALL SELECT 'inventory', COUNT(*) FROM public.inventory;
