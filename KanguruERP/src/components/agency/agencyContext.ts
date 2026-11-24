import type { Expense, PdvOperator, Product, ProductStoreCost, Sale, StockInventory, StoreConfig, Supplier, WorkOrder } from '../../types';
import type { AgencyRoom } from '../../db/agency';
import {
  completedSales,
  formatMoney,
  otherIncomeTimestamp,
  paymentBreakdown,
  saleReturnedAmount,
  sellerBreakdown,
  summarize,
  toLocalDateKey,
  type OtherIncome,
} from '../../db/finance';
import { computeStockAlerts } from '../../db/stockAlerts';
import { listErpAlerts } from '../../db/insights';
import { getCashOverview, getRestockReserves } from '../../db/cashAccounts';
import { listPayableBills } from '../../db/payables';
import { listOpenReceivableInstallments } from '../../db/receivableTitles';
import { buildReceivables } from '../../db/receivables';
import { SALE_PAYMENT_METHOD_LABELS } from '../../types';

// Retrato dos dados da loja que cada sala da Agencia le (vai para a IA no inicio da conversa).
// Usa as mesmas contas das telas do ERP e so o que o login ja enxerga.
// Nunca entra CPF, telefone, e-mail ou endereco de cliente; nomes de pessoas vao abreviados.

export interface AgencyData {
  unitId: string;
  storeConfigs: StoreConfig[];
  products: Product[];
  inventory: StockInventory[];
  sales: Sale[];
  expenses: Expense[];
  otherIncome: OtherIncome[];
  workOrders: WorkOrder[];
  pdvOperators: PdvOperator[];
  suppliers: Supplier[];
  productStoreCosts: ProductStoreCost[];
  // Gerente sem a area Caixa e Contas + Resultados: sem lucro, caixa e contas.
  canSeeFinance: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const money = (value: number) => formatMoney(Math.round(value * 100) / 100);
const ddmm = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
const pct = (value: number) => `${(Math.round(value * 10) / 10).toLocaleString('pt-BR')}%`;

// "Maria Souza Lima" -> "Maria S."
export function abbreviateName(name: string | null | undefined): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Cliente';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

const qtyIn = (inventory: StockInventory[], productId: string, unitId: string) =>
  Math.max(0, inventory.find(inv => inv.productId === productId)?.quantities[unitId]?.qty || 0);

const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);

interface ProductStat { product: Product | undefined; name: string; qty: number; revenue: number; lastSale: number }

function productStats(sales: Sale[], products: Product[], sinceMs: number): Map<string, ProductStat> {
  const byId = new Map(products.map(product => [product.id, product]));
  const stats = new Map<string, ProductStat>();
  sales.forEach(sale => {
    const time = new Date(sale.timestamp).getTime();
    if (time < sinceMs) return;
    (sale.items || []).forEach(item => {
      if (item.itemType === 'SERVICE' || !item.productId) return;
      const current = stats.get(item.productId) || {
        product: byId.get(item.productId),
        name: item.itemName || byId.get(item.productId)?.name || 'Produto',
        qty: 0,
        revenue: 0,
        lastSale: 0,
      };
      current.qty += item.quantity;
      current.revenue += item.lineTotal ?? item.unitPrice * item.quantity;
      current.lastSale = Math.max(current.lastSale, time);
      stats.set(item.productId, current);
    });
  });
  return stats;
}

function lastSaleByProduct(sales: Sale[]): Map<string, number> {
  const last = new Map<string, number>();
  sales.forEach(sale => {
    const time = new Date(sale.timestamp).getTime();
    (sale.items || []).forEach(item => {
      if (!item.productId) return;
      if (time > (last.get(item.productId) || 0)) last.set(item.productId, time);
    });
  });
  return last;
}

function header(data: AgencyData, store: StoreConfig | undefined): string[] {
  const now = new Date();
  const lines = [
    `Loja: ${store?.tradeName || data.unitId}`,
    `Data deste retrato: ${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (horário de Brasília)`,
  ];
  if (store?.instagram) lines.push(`Instagram da loja: ${store.instagram}`);
  if (store?.exchangeDays) lines.push(`Prazo de troca da loja: ${store.exchangeDays} dias`);
  return lines;
}

function monthSummary(data: AgencyData, sales: Sale[], from: Date, to: Date, label: string): string[] {
  const inRange = (timestamp: string) => {
    const time = new Date(timestamp).getTime();
    return time >= from.getTime() && time < to.getTime();
  };
  const monthSales = sales.filter(sale => inRange(sale.timestamp));
  const monthExpenses = data.expenses.filter(expense => expense.unitId === data.unitId && inRange(expense.timestamp));
  const monthIncome = data.otherIncome.filter(entry => entry.unitId === data.unitId && inRange(otherIncomeTimestamp(entry)));
  const summary = summarize(monthSales, monthExpenses, monthIncome);
  const ticket = summary.salesCount > 0 ? summary.revenue / summary.salesCount : 0;
  const lines = [`${label}: faturamento ${money(summary.revenue)} em ${summary.salesCount} vendas (ticket médio ${money(ticket)})`];
  if (data.canSeeFinance) {
    lines.push(`  Custo das mercadorias ${money(summary.cost)} | Lucro bruto ${money(summary.grossProfit)} | Taxas de cartão ${money(summary.fees)} | Despesas ${money(summary.expenses)} | Outras receitas ${money(summary.otherIncome)} | Lucro real operacional ${money(summary.operatingProfit)}`);
    if (summary.salesMissingCost > 0) lines.push(`  (${summary.salesMissingCost} venda(s) sem custo registrado: lucro pode estar maior que o real)`);
  }
  return lines;
}

function salesSection(data: AgencyData, sales: Sale[]): string[] {
  const now = new Date();
  const startMonth = monthStart(now);
  const startPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const lines = ['', 'RESULTADO'];
  lines.push(...monthSummary(data, sales, startMonth, tomorrow, `Mês atual (até hoje, dia ${now.getDate()})`));
  lines.push(...monthSummary(data, sales, startPrev, startMonth, 'Mês passado (completo)'));
  const todayKey = toLocalDateKey(now);
  const yesterdayKey = toLocalDateKey(new Date(now.getTime() - DAY_MS));
  const dayTotal = (key: string) => {
    const list = sales.filter(sale => toLocalDateKey(sale.timestamp) === key);
    return `${list.length} vendas, ${money(list.reduce((sum, sale) => sum + sale.grossAmount - saleReturnedAmount(sale), 0))}`;
  };
  lines.push(`Hoje: ${dayTotal(todayKey)} | Ontem: ${dayTotal(yesterdayKey)}`);
  return lines;
}

function topProductsSection(data: AgencyData, sales: Sale[], days: number, limit: number, withStock: boolean): string[] {
  const stats = productStats(sales, data.products, Date.now() - days * DAY_MS);
  const top = Array.from(stats.entries()).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, limit);
  if (top.length === 0) return ['', `MAIS VENDIDOS (${days} dias): nenhuma venda de produto no período`];
  return ['', `MAIS VENDIDOS (${days} dias, por faturamento)`, ...top.map(([id, stat]) => {
    const parts = [`- ${stat.name}${stat.product?.brand ? ` (${stat.product.brand})` : ''}: ${stat.qty} un, ${money(stat.revenue)}`];
    if (withStock) {
      const qty = qtyIn(data.inventory, id, data.unitId);
      const daily = stat.qty / days;
      parts.push(`estoque ${qty}${daily > 0 ? ` (~${Math.floor(qty / daily)} dias)` : ''}`);
    }
    return parts.join(' | ');
  })];
}

function staleSection(data: AgencyData, sales: Sale[], limit: number): string[] {
  const last = lastSaleByProduct(sales);
  const cutoff = Date.now() - 60 * DAY_MS;
  const store = data.storeConfigs.find(config => config.unitId === data.unitId);
  const stale = data.products
    .filter(product => !product.archivedAt && !product.loosePart)
    .map(product => ({ product, qty: qtyIn(data.inventory, product.id, data.unitId), last: last.get(product.id) || 0 }))
    .filter(row => row.qty > 0 && row.last < cutoff)
    .sort((a, b) => b.qty * b.product.sellPrice - a.qty * a.product.sellPrice)
    .slice(0, limit);
  if (stale.length === 0) return ['', 'PRODUTOS PARADOS (estoque sem venda há 60+ dias): nenhum'];
  return ['', 'PRODUTOS PARADOS (estoque sem venda há 60+ dias)', ...stale.map(row => {
    const limitDiscount = row.product.maxDiscountPercent ?? store?.maxItemDiscountPercent;
    const lastLabel = row.last ? `última venda ${new Date(row.last).toLocaleDateString('pt-BR')}` : 'nunca vendido';
    return `- ${row.product.name}${row.product.brand ? ` (${row.product.brand})` : ''}: ${row.qty} un a ${money(row.product.sellPrice)} | ${lastLabel}${limitDiscount != null ? ` | desconto máx. ${pct(limitDiscount)}` : ''}`;
  })];
}

function categorySection(sales: Sale[], products: Product[], days: number): string[] {
  const byId = new Map(products.map(product => [product.id, product]));
  const since = Date.now() - days * DAY_MS;
  const totals = new Map<string, number>();
  sales.forEach(sale => {
    if (new Date(sale.timestamp).getTime() < since) return;
    (sale.items || []).forEach(item => {
      const key = item.itemType === 'SERVICE' ? 'Serviços' : (item.productId && byId.get(item.productId)?.category) || 'Outros';
      totals.set(key, (totals.get(key) || 0) + (item.lineTotal ?? item.unitPrice * item.quantity));
    });
  });
  const rows = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return [];
  return ['', `FATURAMENTO POR CATEGORIA (${days} dias)`, rows.map(([name, value]) => `${name} ${money(value)}`).join(' | ')];
}

function sellersSection(data: AgencyData, sales: Sale[]): string[] {
  const start = monthStart(new Date()).getTime();
  const monthSales = sales.filter(sale => new Date(sale.timestamp).getTime() >= start);
  const groups = sellerBreakdown(monthSales);
  const lines = ['', 'VENDEDORES NO MÊS (faturamento das vendas de cada um)'];
  if (groups.length === 0) lines.push('- nenhuma venda no mês');
  groups.forEach(group => {
    const code = group.key === '__none__' ? null : group.key.split('|')[0];
    const operator = code ? data.pdvOperators.find(op => op.code === code && op.unitId === data.unitId && op.isActive) : undefined;
    const goal = operator?.monthlyGoal;
    lines.push(`- ${group.label}: ${group.salesCount} vendas, ${money(group.total)}${goal ? ` | meta ${money(goal)} (${pct((group.total / goal) * 100)})` : ''}`);
  });
  const withoutSales = data.pdvOperators.filter(op => op.isActive && op.unitId === data.unitId && op.code && !groups.some(group => group.key.startsWith(`${op.code}|`)));
  if (withoutSales.length) lines.push(`Sem vendas no mês: ${withoutSales.map(op => `${op.name} (${op.code})`).join(', ')}`);
  const payments = Array.from(paymentBreakdown(monthSales).entries()).sort((a, b) => b[1] - a[1]);
  if (payments.length) {
    lines.push(`Formas de pagamento no mês: ${payments.map(([method, value]) => `${SALE_PAYMENT_METHOD_LABELS[method as keyof typeof SALE_PAYMENT_METHOD_LABELS] ?? method} ${money(value)}`).join(' | ')}`);
  }
  const identified = monthSales.filter(sale => sale.clientCpf).length;
  if (monthSales.length) lines.push(`Vendas com cliente identificado no mês: ${identified} de ${monthSales.length}`);
  return lines;
}

function combosSection(sales: Sale[], products: Product[]): string[] {
  const byId = new Map(products.map(product => [product.id, product]));
  const since = Date.now() - 90 * DAY_MS;
  const pairs = new Map<string, number>();
  sales.forEach(sale => {
    if (new Date(sale.timestamp).getTime() < since) return;
    const names = Array.from(new Set((sale.items || [])
      .filter(item => item.itemType !== 'SERVICE' && item.productId)
      .map(item => item.itemName || byId.get(item.productId!)?.name || ''))).filter(Boolean).sort();
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const key = `${names[i]} + ${names[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  });
  const top = Array.from(pairs.entries()).filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length === 0) return [];
  return ['', 'PRODUTOS COMPRADOS JUNTOS (90 dias)', ...top.map(([key, count]) => `- ${key}: ${count} vezes`)];
}

function returnsSection(sales: Sale[]): string[] {
  const since = Date.now() - 30 * DAY_MS;
  const returns = sales.flatMap(sale => sale.returns || []).filter(item => new Date(item.createdAt).getTime() >= since);
  if (returns.length === 0) return ['', 'TROCAS E DEVOLUÇÕES (30 dias): nenhuma'];
  const total = returns.reduce((sum, item) => sum + item.totalAmount, 0);
  const reasons = new Map<string, number>();
  returns.forEach(item => {
    const reason = (item.reason || 'sem motivo').trim().slice(0, 60);
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  });
  return ['', `TROCAS E DEVOLUÇÕES (30 dias): ${returns.length}, total ${money(total)}`,
    `Motivos: ${Array.from(reasons.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => `${reason} (${count})`).join('; ')}`];
}

async function alertsSection(unitId: string, limit: number): Promise<string[]> {
  try {
    const alerts = (await listErpAlerts()).filter(alert => alert.unitId === unitId).slice(0, limit);
    if (alerts.length === 0) return ['', 'AVISOS DO SINO "PRECISA DE ATENÇÃO": nenhum'];
    return ['', 'AVISOS DO SINO "PRECISA DE ATENÇÃO"', ...alerts.map(alert => `- ${alert.title}${alert.detail ? `: ${alert.detail}` : ''}`)];
  } catch {
    return [];
  }
}

async function cashSection(unitId: string, detailed: boolean): Promise<string[]> {
  const lines: string[] = ['', 'CAIXA E BANCOS (dinheiro disponível; diferente de lucro)'];
  try {
    const [overview, reserves] = await Promise.all([getCashOverview(unitId), getRestockReserves(unitId).catch(() => null)]);
    const accounts = overview.accounts.filter(account => account.isActive);
    if (accounts.length === 0) {
      lines.push('- contas não configuradas (Caixa e Contas › Caixa e Bancos)');
      return lines;
    }
    accounts.forEach(account => lines.push(`- ${account.name}: ${money(account.balance)}`));
    const total = accounts.reduce((sum, account) => sum + account.balance, 0);
    const reserveTotal = (reserves?.suppliers || []).reduce((sum, row) => sum + Math.max(0, row.reserve), 0);
    lines.push(`Total ${money(total)} | Reserva de reposição dos fornecedores ${money(reserveTotal)} | Livre ${money(total - reserveTotal)}`);
    if (overview.partnerLoanBalance > 0) lines.push(`A loja deve ao sócio: ${money(overview.partnerLoanBalance)}`);
    if (detailed && reserves) {
      const rows = reserves.suppliers.filter(row => Math.abs(row.reserve) >= 0.01);
      if (rows.length) {
        lines.push(`Reserva por fornecedor${reserves.startDate ? ` (desde ${new Date(`${reserves.startDate}T12:00:00`).toLocaleDateString('pt-BR')})` : ''}:`);
        rows.forEach(row => lines.push(`- ${row.name}${row.brands.length ? ` (${row.brands.slice(0, 6).join(', ')})` : ''}: reserva ${money(row.reserve)} (custo vendido ${money(row.soldCost)}, já comprado ${money(row.consumed)})`));
      }
    }
  } catch {
    lines.push('- não foi possível ler o caixa agora');
  }
  return lines;
}

async function billsSection(data: AgencyData): Promise<string[]> {
  const lines: string[] = [];
  const today = toLocalDateKey(new Date());
  const until = toLocalDateKey(new Date(Date.now() + 30 * DAY_MS));
  try {
    const bills = (await listPayableBills()).filter(bill => bill.unitId === data.unitId && bill.status === 'PENDENTE' && bill.dueDate <= until);
    const overdue = bills.filter(bill => bill.dueDate < today);
    lines.push('', `CONTAS A PAGAR (vencidas e próximos 30 dias): ${money(bills.reduce((sum, bill) => sum + bill.amount, 0))}${overdue.length ? ` | ${overdue.length} vencida(s) somando ${money(overdue.reduce((sum, bill) => sum + bill.amount, 0))}` : ''}`);
    bills.slice(0, 25).forEach(bill => lines.push(`- ${ddmm(bill.dueDate)} ${bill.description}${bill.supplierName ? ` (${bill.supplierName})` : ''}: ${money(bill.amount)}${bill.dueDate < today ? ' VENCIDA' : ''}`));
  } catch {
    lines.push('', 'CONTAS A PAGAR: não foi possível ler agora');
  }
  try {
    const open = (await listOpenReceivableInstallments(until)).filter(row => row.unitId === data.unitId);
    if (open.length) {
      lines.push('', `CONTAS A RECEBER (vencidas e próximos 30 dias): ${money(open.reduce((sum, row) => sum + row.remaining, 0))}`);
      open.slice(0, 15).forEach(row => lines.push(`- ${ddmm(row.dueDate)} ${abbreviateName(row.debtorName)}: ${money(row.remaining)}${row.dueDate < today ? ' VENCIDA' : ''}`));
    }
  } catch {
    // tabela ainda nao existe ou sem acesso
  }
  const payouts = buildReceivables(data.sales.filter(sale => sale.unitId === data.unitId), data.storeConfigs)
    .filter(entry => entry.payoutDate >= today && entry.payoutDate <= until);
  if (payouts.length) {
    const byDay = new Map<string, number>();
    payouts.forEach(entry => byDay.set(entry.payoutDate, (byDay.get(entry.payoutDate) || 0) + entry.net));
    const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    lines.push('', `RECEBIMENTOS DE CARTÃO/PIX A CAIR (próximos 30 dias, já sem taxas): ${money(payouts.reduce((sum, entry) => sum + entry.net, 0))}`);
    lines.push(days.slice(0, 15).map(([day, value]) => `${ddmm(day)} ${money(value)}`).join(' | '));
  }
  return lines;
}

function expensesSection(data: AgencyData): string[] {
  const start = monthStart(new Date()).getTime();
  const totals = new Map<string, number>();
  data.expenses
    .filter(expense => expense.unitId === data.unitId && new Date(expense.timestamp).getTime() >= start)
    .forEach(expense => totals.set(expense.category || 'Outros', (totals.get(expense.category || 'Outros') || 0) + expense.amount));
  const rows = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return ['', 'DESPESAS DO MÊS: nenhuma lançada'];
  return ['', 'DESPESAS DO MÊS POR CATEGORIA', rows.map(([name, value]) => `${name} ${money(value)}`).join(' | ')];
}

function stockAlertsSection(data: AgencyData, sales: Sale[], limit: number, withCost: boolean): string[] {
  const alerts = computeStockAlerts(data.products, data.inventory, sales, data.unitId).slice(0, limit);
  if (alerts.length === 0) return ['', 'ESTOQUE EM ALERTA: nenhum produto'];
  const costOf = (productId: string, fallback: number) =>
    data.productStoreCosts.find(row => row.productId === productId && row.unitId === data.unitId)?.avgCost || fallback;
  return ['', 'ESTOQUE EM ALERTA (ALTO = esgotado ou < 7 dias; MÉDIO = no mínimo ou < 15 dias)', ...alerts.map(alert => {
    const cost = withCost ? ` | custo ${money(costOf(alert.product.id, alert.product.costPrice))}` : '';
    return `- [${alert.risk}] ${alert.product.name}${alert.product.brand ? ` (${alert.product.brand})` : ''}: ${alert.qty} un, ${alert.reason}${cost} | preço ${money(alert.product.sellPrice)}`;
  })];
}

function suppliersSection(data: AgencyData): string[] {
  const rows = data.suppliers.filter(supplier => (supplier.brands || []).length > 0);
  if (rows.length === 0) return [];
  return ['', 'FORNECEDORES E MARCAS', ...rows.map(supplier => `- ${supplier.name}: ${(supplier.brands || []).join(', ')}`)];
}

function workOrdersSection(data: AgencyData): string[] {
  const now = Date.now();
  const open = data.workOrders
    .filter(order => order.unitId === data.unitId && order.status !== 'ENTREGUE' && order.status !== 'DEVOLVIDO')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const statusLabel: Record<string, string> = { AGUARDANDO_PECA: 'aguardando peça', EM_ANALISE: 'em análise', PRONTO: 'pronta para retirar' };
  const lines = ['', `ORDENS DE SERVIÇO EM ABERTO: ${open.length}`];
  open.slice(0, 25).forEach(order => {
    const days = Math.floor((now - new Date(order.timestamp).getTime()) / DAY_MS);
    const late = order.expectedDate && order.expectedDate < toLocalDateKey(new Date()) && order.status !== 'PRONTO' ? ' ATRASADA' : '';
    lines.push(`- OS ${order.orderNumber ?? order.osNumber}: ${order.equipment || order.equipmentType || 'aparelho'} de ${abbreviateName(order.clientName)} | ${statusLabel[order.status] ?? order.status} há ${days} dia(s)${order.expectedDate ? ` | previsão ${ddmm(order.expectedDate)}` : ''}${late}${order.paidAt ? ' | já paga' : ''} | problema: ${(order.problemDescription || '').slice(0, 80)}`);
  });
  const since = now - 30 * DAY_MS;
  const delivered = data.workOrders.filter(order => order.unitId === data.unitId && order.deliveredAt && new Date(order.deliveredAt).getTime() >= since);
  lines.push(`Entregues nos últimos 30 dias: ${delivered.length}`);
  return lines;
}

// Monta o retrato de uma sala. Cada sala recebe o que precisa (menos texto = resposta melhor e mais barata).
export async function buildAgencyContext(room: AgencyRoom, data: AgencyData): Promise<string> {
  const store = data.storeConfigs.find(config => config.unitId === data.unitId);
  const sales = completedSales(data.sales).filter(sale => sale.unitId === data.unitId);
  const lines = header(data, store);

  switch (room) {
    case 'recepcao':
      lines.push(...salesSection(data, sales));
      if (data.canSeeFinance) lines.push(...await cashSection(data.unitId, false));
      lines.push(...await alertsSection(data.unitId, 25));
      lines.push(...topProductsSection(data, sales, 30, 8, true));
      lines.push(...stockAlertsSection(data, sales, 10, false));
      lines.push(...workOrdersSection(data).slice(0, 4));
      break;
    case 'marketing':
      lines.push(...topProductsSection(data, sales, 30, 15, true));
      lines.push(...staleSection(data, sales, 20));
      lines.push(...categorySection(sales, data.products, 30));
      lines.push(...combosSection(sales, data.products));
      break;
    case 'vendas':
      lines.push(...salesSection(data, sales));
      lines.push(...sellersSection(data, sales));
      lines.push(...topProductsSection(data, sales, 30, 12, false));
      lines.push(...combosSection(sales, data.products));
      lines.push(...categorySection(sales, data.products, 30));
      lines.push(...returnsSection(sales));
      break;
    case 'financeiro':
      lines.push(...salesSection(data, sales));
      lines.push(...expensesSection(data));
      lines.push(...await cashSection(data.unitId, true));
      lines.push(...await billsSection(data));
      break;
    case 'compras':
      lines.push(...stockAlertsSection(data, sales, 40, true));
      lines.push(...topProductsSection(data, sales, 30, 20, true));
      lines.push(...staleSection(data, sales, 15));
      lines.push(...suppliersSection(data));
      if (data.canSeeFinance) lines.push(...await cashSection(data.unitId, true));
      break;
    case 'atendimento':
      lines.push(...workOrdersSection(data));
      lines.push(...returnsSection(sales));
      break;
  }

  return lines.join('\n');
}
