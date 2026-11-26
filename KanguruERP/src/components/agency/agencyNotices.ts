import type { PdvOperator, Product, Sale, StockInventory, StoreConfig, Supplier } from '../../types';
import type { AgencyRoom } from '../../db/agency';
import type { ErpAlert } from '../../db/insights';
import { completedSales, formatMoney, sellerBreakdown } from '../../db/finance';
import { computeStockAlerts } from '../../db/stockAlerts';
import { getCashOverview, getRestockReserves, listCardAportes } from '../../db/cashAccounts';
import { computeCashForecast } from '../../db/cashForecast';
import { listPayableBills } from '../../db/payables';
import { listOpenReceivableInstallments } from '../../db/receivableTitles';
import { addDaysKey, listPayoutChecks, todayKey } from '../../db/receivables';

// Agencia de IA, etapa B: avisos automaticos de cada sala. Regras fixas, sem IA, sem custo
// e sem contar no limite. Clicar no aviso so preenche a pergunta no chat (o dono decide enviar).

export interface AgencyNotice {
  id: string;
  room: AgencyRoom;
  level: 'alto' | 'medio' | 'info';
  title: string;
  detail?: string;
  question: string;
  // Aviso do VideoMaker: abre o VideoMaker em vez de preencher a pergunta.
  action?: 'videomaker';
}

export interface NoticeInput {
  unitId: string;
  alerts: ErpAlert[];
  storeConfigs: StoreConfig[];
  products: Product[];
  inventory: StockInventory[];
  sales: Sale[];
  pdvOperators: PdvOperator[];
  suppliers: Supplier[];
  canSeeFinance: boolean;
  roomAllowed: (room: AgencyRoom) => boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const money = (value: number) => formatMoney(Math.round(value * 100) / 100);
const ddmm = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
const keyOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const pctText = (value: number) => `${Math.round(value)}%`;

// ---------- Financeiro ----------
async function financeNotices(input: NoticeInput): Promise<AgencyNotice[]> {
  const notices: AgencyNotice[] = [];
  const today = todayKey();
  const week = addDaysKey(today, 7);
  const store = input.storeConfigs.find(config => config.unitId === input.unitId);

  const [bills, openReceivables] = await Promise.all([
    listPayableBills().catch(() => []),
    listOpenReceivableInstallments().catch(() => []),
  ]);

  const soon = bills.filter(bill => bill.unitId === input.unitId && bill.status === 'PENDENTE' && bill.dueDate <= week);
  if (soon.length) {
    const overdue = soon.filter(bill => bill.dueDate < today);
    notices.push({
      id: 'fin-contas',
      room: 'financeiro',
      level: overdue.length ? 'alto' : 'medio',
      title: `${soon.length} conta(s) a pagar até ${ddmm(week)} (${money(soon.reduce((sum, bill) => sum + bill.amount, 0))})${overdue.length ? `, ${overdue.length} vencida(s)` : ''}`,
      detail: soon.slice(0, 4).map(bill => `${ddmm(bill.dueDate)} ${bill.description}`).join(', ') + (soon.length > 4 ? '...' : ''),
      question: 'Quais contas vencem nos próximos 7 dias e qual eu devo pagar primeiro?',
    });
  }

  input.alerts
    .filter(alert => alert.unitId === input.unitId && (alert.kind === 'CONTA_RECEBER' || alert.kind === 'RECEBIMENTO'))
    .forEach(alert => notices.push({
      id: `fin-${alert.kind}`,
      room: 'financeiro',
      level: 'medio',
      title: alert.kind === 'CONTA_RECEBER' ? `Contas a receber: ${alert.title}` : `Recebimentos: ${alert.title}`,
      detail: alert.detail ?? undefined,
      question: alert.kind === 'CONTA_RECEBER'
        ? 'Tenho parcelas a receber vencidas. Como devo cobrar? Escreva uma mensagem educada de cobrança.'
        : 'Tenho dias de repasse do cartão sem conferir. O que isso quer dizer e como eu resolvo?',
    }));

  // Previsão de 30 dias (mesma conta da tela Caixa e Bancos).
  if (store) {
    try {
      const [overview, reserves] = await Promise.all([
        getCashOverview(input.unitId),
        getRestockReserves(input.unitId).catch(() => null),
      ]);
      const accounts = overview.accounts.filter(account => account.isActive);
      if (accounts.length) {
        const earliest = overview.accounts.reduce((min, account) => account.openingDate < min ? account.openingDate : min, today);
        const [checks, cardAportes] = await Promise.all([
          listPayoutChecks(earliest, addDaysKey(today, 40)).catch(() => []),
          listCardAportes(earliest, addDaysKey(today, 40)).catch(() => []),
        ]);
        const total = accounts.reduce((sum, account) => sum + account.balance, 0);
        const forecast = computeCashForecast({
          today,
          unitId: input.unitId,
          store,
          accounts: overview.accounts,
          settings: overview.settings,
          total,
          sales: input.sales,
          cardAportes: cardAportes.filter(item => item.unitId === input.unitId),
          checks: checks.filter(item => item.unitId === input.unitId),
          openReceivables,
          payables: bills,
        });
        const reserved = (reserves?.suppliers ?? []).reduce((sum, row) => sum + Math.max(0, row.reserve), 0);
        if (forecast.lowest.value < 0) {
          notices.push({
            id: 'fin-saldo-negativo',
            room: 'financeiro',
            level: 'alto',
            title: `Saldo previsto fica negativo em ${ddmm(forecast.lowest.day)} (${money(forecast.lowest.value)})`,
            detail: 'Previsão dos próximos 30 dias do Caixa e Bancos.',
            question: `A previsão mostra o saldo negativo em ${ddmm(forecast.lowest.day)}. O que eu posso fazer para não faltar dinheiro?`,
          });
        } else if (reserved > 0 && forecast.lowest.value < reserved) {
          notices.push({
            id: 'fin-saldo-baixo',
            room: 'financeiro',
            level: 'medio',
            title: `Saldo previsto cai para ${money(forecast.lowest.value)} em ${ddmm(forecast.lowest.day)}, abaixo da reserva dos fornecedores (${money(reserved)})`,
            question: 'A previsão de caixa fica abaixo da reserva de reposição dos fornecedores. Isso é um problema? O que você sugere?',
          });
        }
      }
    } catch {
      // Caixa e Bancos não configurado ou sem acesso: sem aviso.
    }
  }
  return notices;
}

// ---------- Compras ----------
function purchaseNotices(input: NoticeInput, sales: Sale[]): AgencyNotice[] {
  const alerts = computeStockAlerts(input.products, input.inventory, sales, input.unitId);
  if (alerts.length === 0) return [];
  const supplierOf = new Map<string, string>();
  input.suppliers.forEach(supplier => (supplier.brands || []).forEach(brand => supplierOf.set(brand.trim().toLowerCase(), supplier.name)));
  const bySupplier = new Map<string, number>();
  alerts.forEach(alert => {
    const name = supplierOf.get((alert.product.brand || '').trim().toLowerCase()) || 'Outros';
    bySupplier.set(name, (bySupplier.get(name) || 0) + 1);
  });
  const critical = alerts.filter(alert => alert.risk === 'ALTO').length;
  return [{
    id: 'compras-alerta',
    room: 'compras',
    level: critical ? 'alto' : 'medio',
    title: `${alerts.length} produto(s) em alerta de estoque${critical ? `, ${critical} crítico(s)` : ''}`,
    detail: Array.from(bySupplier.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}: ${count}`).join(' | '),
    question: 'Monte uma sugestão de pedido por fornecedor para os produtos em alerta de estoque.',
  }];
}

// ---------- Atendimento ----------
function serviceNotices(input: NoticeInput): AgencyNotice[] {
  const mine = input.alerts.filter(alert => alert.unitId === input.unitId);
  const notices: AgencyNotice[] = [];
  const group = (kind: ErpAlert['kind']) => mine.filter(alert => alert.kind === kind);
  const late = group('OS_ATRASADA');
  if (late.length) notices.push({
    id: 'atend-os-atrasada',
    room: 'atendimento',
    level: 'alto',
    title: `${late.length} ordem(ns) de serviço atrasada(s)`,
    detail: late.slice(0, 4).map(alert => alert.title).join(', '),
    question: 'Quais ordens de serviço estão atrasadas? Escreva uma mensagem para avisar os clientes do novo prazo.',
  });
  const stopped = group('OS_PARADA');
  if (stopped.length) notices.push({
    id: 'atend-os-parada',
    room: 'atendimento',
    level: 'medio',
    title: `${stopped.length} aparelho(s) pronto(s) há mais de 30 dias sem retirada`,
    detail: stopped.slice(0, 4).map(alert => alert.title).join(', '),
    question: 'Tenho aparelhos prontos há mais de 30 dias. Escreva uma mensagem pedindo para o cliente retirar.',
  });
  const reservations = group('RESERVA');
  if (reservations.length) notices.push({
    id: 'atend-reserva',
    room: 'atendimento',
    level: 'medio',
    title: `${reservations.length} reserva(s) vencida(s)`,
    detail: reservations.slice(0, 4).map(alert => alert.title).join(', '),
    question: 'Tenho reservas vencidas. Como falo com esses clientes? Escreva uma mensagem curta.',
  });
  return notices;
}

// ---------- Vendas ----------
function salesNotices(input: NoticeInput, sales: Sale[]): AgencyNotice[] {
  const now = new Date();
  const day = now.getDate();
  if (day < 5) return []; // começo do mês: ritmo ainda não diz muito
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const expected = day / daysInMonth;
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const groups = sellerBreakdown(sales.filter(sale => new Date(sale.timestamp).getTime() >= start));
  const below = input.pdvOperators
    .filter(op => op.isActive && op.unitId === input.unitId && op.code && (op.monthlyGoal ?? 0) > 0)
    .map(op => {
      const total = groups.find(item => item.key.startsWith(`${op.code}|`))?.total ?? 0;
      return { op, ratio: total / (op.monthlyGoal as number) };
    })
    .filter(row => row.ratio < expected * 0.9)
    .sort((a, b) => a.ratio - b.ratio);
  if (below.length === 0) return [];
  return [{
    id: 'vendas-meta',
    room: 'vendas',
    level: 'medio',
    title: `${below.length} vendedor(es) abaixo do ritmo da meta`,
    detail: `Esperado até hoje: ${pctText(expected * 100)} da meta. ` + below.slice(0, 4).map(row => `${row.op.name} ${pctText(row.ratio * 100)}`).join(', '),
    question: 'Quais vendedores estão abaixo do ritmo da meta e o que posso fazer para ajudar cada um?',
  }];
}

// ---------- Marketing ----------
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

function commercialDates(year: number): { name: string; date: Date }[] {
  const thanksgiving = nthWeekday(year, 10, 4, 4);
  return [
    { name: 'Volta às aulas', date: new Date(year, 0, 20) },
    { name: 'Dia do Consumidor', date: new Date(year, 2, 15) },
    { name: 'Dia das Mães', date: nthWeekday(year, 4, 0, 2) },
    { name: 'Dia dos Namorados', date: new Date(year, 5, 12) },
    { name: 'Férias de julho', date: new Date(year, 6, 1) },
    { name: 'Dia dos Pais', date: nthWeekday(year, 7, 0, 2) },
    { name: 'Dia do Gamer', date: new Date(year, 7, 29) },
    { name: 'Dia das Crianças', date: new Date(year, 9, 12) },
    { name: 'Black Friday', date: new Date(year, 10, thanksgiving.getDate() + 1) },
    { name: 'Natal', date: new Date(year, 11, 25) },
  ];
}

function marketingNotices(input: NoticeInput, sales: Sale[]): AgencyNotice[] {
  const notices: AgencyNotice[] = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const limit = today.getTime() + 30 * DAY_MS;
  [...commercialDates(now.getFullYear()), ...commercialDates(now.getFullYear() + 1)]
    .filter(item => item.date.getTime() >= today.getTime() && item.date.getTime() <= limit)
    .forEach(item => {
      const days = Math.round((item.date.getTime() - today.getTime()) / DAY_MS);
      notices.push({
        id: `mkt-data-${item.name}-${item.date.getFullYear()}`,
        room: 'marketing',
        level: days <= 7 ? 'medio' : 'info',
        title: `${item.name} ${days === 0 ? 'é hoje' : `em ${days} dia(s)`} (${ddmm(keyOf(item.date))})`,
        question: `Me dê 3 ideias de post e uma promoção para o ${item.name}, usando os produtos da loja.`,
      });
    });

  const last = new Map<string, number>();
  sales.forEach(sale => {
    const time = new Date(sale.timestamp).getTime();
    (sale.items || []).forEach(item => {
      if (item.productId && time > (last.get(item.productId) || 0)) last.set(item.productId, time);
    });
  });
  const cutoff = Date.now() - 60 * DAY_MS;
  const stale = input.products
    .filter(product => !product.archivedAt && !product.loosePart)
    .map(product => ({ product, qty: Math.max(0, input.inventory.find(inv => inv.productId === product.id)?.quantities[input.unitId]?.qty || 0) }))
    .filter(row => row.qty > 0 && (last.get(row.product.id) || 0) < cutoff);
  if (stale.length) {
    const value = stale.reduce((sum, row) => sum + row.qty * row.product.sellPrice, 0);
    notices.push({
      id: 'mkt-parados',
      room: 'marketing',
      level: 'medio',
      title: `${stale.length} produto(s) parado(s) há 60+ dias (${money(value)} em estoque a preço de venda)`,
      detail: stale.sort((a, b) => b.qty * b.product.sellPrice - a.qty * a.product.sellPrice).slice(0, 4).map(row => row.product.name).join(', '),
      question: 'Monte uma promoção para os produtos parados há mais de 60 dias.',
    });
  }
  return notices;
}

const LEVEL_ORDER = { alto: 0, medio: 1, info: 2 } as const;

export const sortNotices = (notices: AgencyNotice[]) =>
  [...notices].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

// Avisos calculados na hora (sem consultar o banco).
export function quickAgencyNotices(input: NoticeInput): AgencyNotice[] {
  const sales = completedSales(input.sales).filter(sale => sale.unitId === input.unitId);
  const notices: AgencyNotice[] = [];
  if (input.roomAllowed('compras')) notices.push(...purchaseNotices(input, sales));
  if (input.roomAllowed('atendimento')) notices.push(...serviceNotices(input));
  if (input.roomAllowed('vendas')) notices.push(...salesNotices(input, sales));
  if (input.roomAllowed('marketing')) {
    // VideoMaker (mesmos avisos do sino): clicar abre o VideoMaker em vez de perguntar.
    input.alerts
      .filter(alert => alert.kind === 'VIDEO' && alert.unitId === input.unitId)
      .forEach(alert => notices.push({
        id: `vm-${alert.ref}`,
        room: 'marketing',
        level: alert.ref?.startsWith('video-fila') ? 'medio' : 'alto',
        title: `VideoMaker: ${alert.title}`,
        detail: alert.detail ?? undefined,
        question: '',
        action: 'videomaker',
      }));
    notices.push(...marketingNotices(input, sales));
  }
  return notices;
}

// Avisos do Financeiro (consultam contas, caixa e previsão).
export async function financeAgencyNotices(input: NoticeInput): Promise<AgencyNotice[]> {
  if (!input.roomAllowed('financeiro') || !input.canSeeFinance) return [];
  return financeNotices(input);
}
