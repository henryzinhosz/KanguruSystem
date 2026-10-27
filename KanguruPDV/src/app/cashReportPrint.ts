import type { PosStoreProfile } from '../services/supabase/terminal';
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
