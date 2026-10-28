import type { PosStoreProfile } from '../services/supabase/terminal';
import type { CashClosureSummary, CashCounts, CashSessionReport } from '../services/supabase/cash-register';
import { printHtmlDocument } from './receiptPrint';

// Relatorio Gerencial do caixa (abertura, sangria e suprimento) em bobina de 80 mm, no modelo
// pedido pelo usuario (referencia: KanguruPDV/docs/referencias/relatorio-abertura-caixa.png).

const money = (value: number) => value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

function formatCnpj(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 14
    ? `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
    : value;
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  return value;
}

export interface ManagerialReport {
  subtitle: 'Abertura de PDV' | 'Sangria' | 'Suprimento';
  date: Date;
  cashNumber: string;
  operator: string;
  cashAmount: number;
  reason?: string | null;
}

export function buildReportHtml(report: ManagerialReport, store: PosStoreProfile | null): string {
  const e = escapeHtml;
  const storeName = store?.tradeName || store?.legalName || '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Relatório Gerencial - ${e(report.subtitle)}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  /* Impressora termica pelo driver do Windows: preto puro e traço firme */
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; width: 80mm; padding: 4mm 4mm 6mm; font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: bold; color: #000; line-height: 1.4; -webkit-font-smoothing: none; }
  .store { text-align: center; font-size: 15px; font-weight: bold; }
  .rule { border-top: 2px solid #000; margin: 4px 0; }
  .title { margin-top: 14px; text-align: center; font-size: 19px; font-weight: bold; letter-spacing: 0.3px; }
  .subtitle { margin: 6px 0 22px; text-align: center; font-size: 14px; font-weight: normal; }
  .pair { display: flex; gap: 8px; }
  .pair span { flex: 1; }
  .signature { margin-top: 70px; border-top: 2px solid #000; padding-top: 3px; text-align: center; font-weight: normal; }
</style>
</head>
<body>
  ${storeName ? `<div class="store">${e(storeName)}</div>` : ''}
  ${store?.phone ? `<div>Telefone: &nbsp;${e(formatPhone(store.phone))}</div>` : ''}
  ${store?.cnpj || store?.stateRegistration
    ? `<div>${store?.cnpj ? `CNPJ: ${e(formatCnpj(store.cnpj))}` : ''}${store?.stateRegistration ? ` &nbsp; IE: ${e(store.stateRegistration)}` : ''}</div>`
    : ''}
  <div class="rule"></div>
  <div>Data: &nbsp;${report.date.toLocaleDateString('pt-BR')} ${report.date.toLocaleTimeString('pt-BR')}</div>
  <div class="title">RELATÓRIO GERENCIAL</div>
  <div class="subtitle">${e(report.subtitle)}</div>
  <div class="pair"><span>PDV: &nbsp;${e(report.cashNumber)}</span><span>Operador: &nbsp;${e(report.operator)}</span></div>
  <div>Dinheiro: R$ ${money(report.cashAmount)}</div>
  ${report.reason ? `<div>Motivo: ${e(report.reason)}</div>` : ''}
  <div>Total: &nbsp;R$ ${money(report.cashAmount)}</div>
  <div class="signature">ASSINATURA DO OPERADOR</div>
</body>
</html>`;
}

export function printManagerialReport(report: ManagerialReport, store: PosStoreProfile | null) {
  return printHtmlDocument(buildReportHtml(report, store));
}

// ---- Fechamento de caixa (adaptado da "Reducao de caixa" do Degust) ----
export interface ClosingReport {
  summary: CashClosureSummary;
  report: CashSessionReport | null;
  counts: CashCounts;
  closedBy: string;
  closedAt: Date;
}

const pad = (label: string, width: number) => (label + '.'.repeat(width)).slice(0, width);

function closingRow(label: string, value: string, width = 18) {
  return `<div class="line"><span>${escapeHtml(pad(label, width))}:</span><span>${escapeHtml(value)}</span></div>`;
}

export function buildClosingHtml(data: ClosingReport, store: PosStoreProfile | null): string {
  const e = escapeHtml;
  const { summary, report, counts } = data;
  const opened = new Date(summary.openedAt);
  // Dinheiro do sistema = gaveta: fundo + vendas/sinais em dinheiro + suprimentos - sangrias.
  const methods = [
    { label: 'DINHEIRO', expected: summary.expectedCashAmount, counted: counts.cash },
    { label: 'CREDITO', expected: summary.expectedCreditAmount, counted: counts.credit },
    { label: 'DEBITO', expected: summary.expectedDebitAmount, counted: counts.debit },
    { label: 'PIX', expected: summary.expectedPixAmount, counted: counts.pix },
    { label: 'VALE-TROCA', expected: summary.expectedVoucherAmount, counted: counts.voucher },
    { label: 'CREDIARIO', expected: summary.expectedCreditAccountAmount, counted: counts.creditAccount },
  ].filter((method, index) => index < 4 || method.expected !== 0 || method.counted !== 0);
  // Total finalizador = o que entrou por venda/sinal (sem fundo, suprimentos e sangrias).
  const cashFromSales = summary.expectedCashAmount - summary.openingFloatAmount - summary.suppliesAmount + summary.withdrawalsAmount;
  const finalizer = cashFromSales + methods.slice(1).reduce((sum, method) => sum + method.expected, 0);
  const discount = report ? Math.max(0, Math.round((report.listTotal - report.grossTotal) * 100) / 100) : 0;
  const ticket = report && report.saleCount > 0 ? report.grossTotal / report.saleCount : 0;
  const time = (date: Date) => date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Fechamento de caixa</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; width: 80mm; padding: 4mm 3mm 6mm; font-family: 'Courier New', Courier, monospace; font-size: 12px; font-weight: bold; color: #000; line-height: 1.35; -webkit-font-smoothing: none; }
  .dash { border-top: 2px dashed #000; margin: 4px 0; }
  .title { text-align: center; font-size: 15px; letter-spacing: 1px; }
  .store { text-align: center; font-family: Arial, Helvetica, sans-serif; font-size: 13px; margin-bottom: 2px; }
  .line { display: flex; justify-content: space-between; white-space: pre; }
  .gap { height: 8px; }
  .sum { border-top: 2px dashed #000; margin-left: 50%; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0; text-align: right; font-weight: bold; }
  th:first-child, td:first-child { text-align: left; }
  th { font-size: 11px; }
  .signature { margin-top: 60px; border-top: 2px solid #000; padding-top: 3px; text-align: center; font-family: Arial, Helvetica, sans-serif; font-weight: normal; }
</style>
</head>
<body>
  ${store?.tradeName ? `<div class="store">${e(store.tradeName)}</div>` : ''}
  <div class="dash"></div>
  <div class="title">FECHAMENTO DE CAIXA</div>
  <div class="dash"></div>
  <div>PDV: ${e(summary.cashNumber)}${report?.terminalName && report.terminalName !== summary.cashNumber ? ` (${e(report.terminalName)})` : ''}</div>
  ${closingRow('Data Abertura', `${opened.toLocaleDateString('pt-BR')} ${time(opened)}`)}
  ${closingRow('No. Abertura', report ? String(report.sessionNumber).padStart(2, '0') : '--')}
  ${closingRow('Fechamento', `${data.closedAt.toLocaleDateString('pt-BR')} ${time(data.closedAt)}`)}
  ${closingRow('Responsavel', summary.openedByName.toUpperCase())}
  ${closingRow('Operador', (data.closedBy || summary.openedByName).toUpperCase())}
  ${closingRow('Fundo Inicial', money(summary.openingFloatAmount))}
  <div class="gap"></div>
  ${report ? `
  ${closingRow('Venda Balcao', money(report.directTotal))}
  ${report.reservationTotal > 0 ? closingRow('Reserva convert.', money(report.reservationTotal)) : ''}
  ${closingRow('Faturamento Bruto', money(report.listTotal))}
  ${closingRow('(-) Desconto', money(discount))}
  <div class="sum"></div>
  ${closingRow('RES. OPERACIONAL', money(report.grossTotal))}
  ${report.depositsReceived > 0 || report.depositsRefunded > 0 ? closingRow('Sinais recebidos', money(report.depositsReceived)) : ''}
  ${report.depositsRefunded > 0 ? closingRow('Sinais devolvidos', money(report.depositsRefunded)) : ''}
  ${report.returnCount > 0 ? closingRow('Devolucoes (-)', money(report.returnRefunds)) : ''}
  ${report.returnCredits > 0 ? closingRow('Vales emitidos', money(report.returnCredits)) : ''}
  <div class="gap"></div>` : ''}
  <table>
    <tr><th>Contagem</th><th>Sistema</th><th>Contado</th><th>Dif.</th></tr>
    ${methods.map((method) => `<tr><td>${method.label}</td><td>${money(method.expected)}</td><td>${money(method.counted)}</td><td>${money(method.counted - method.expected)}</td></tr>`).join('')}
  </table>
  <div class="sum"></div>
  ${closingRow('TOTAL FINALIZADOR', money(finalizer))}
  <div class="gap"></div>
  ${closingRow('Suprimentos (+)', money(summary.suppliesAmount))}
  ${closingRow('Sangrias (-)', money(summary.withdrawalsAmount))}
  ${closingRow('Dinheiro gaveta', money(summary.expectedCashAmount))}
  ${report ? `
  <div class="dash"></div>
  ${closingRow('TC-Total Cupom', String(report.saleCount), 20)}
  ${closingRow('  NFC-e', String(report.nfceCount), 20)}
  ${closingRow('  Nao Fiscal', String(report.nonFiscalCount), 20)}
  ${closingRow('TM-Ticket Medio', money(ticket), 20)}
  ${closingRow('Estornadas', `${report.cancelledCount} (${money(report.cancelledTotal)})`, 20)}` : ''}
  <div class="dash"></div>
  <div class="signature">ASSINATURA DO OPERADOR</div>
</body>
</html>`;
}

export function printClosingReport(data: ClosingReport, store: PosStoreProfile | null) {
  return printHtmlDocument(buildClosingHtml(data, store));
}
