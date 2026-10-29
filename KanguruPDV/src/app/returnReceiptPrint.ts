import type { PosStoreProfile } from '../services/supabase/terminal';
import type { SaleReturnReceipt } from '../services/supabase/returns';
import { formatReceiptNumber, printHtmlDocument } from './receiptPrint';

// Comprovante de troca/devolucao em 80 mm (via do cliente, com assinatura).

const money = (value: number) => value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

const REFUND_LABELS: Record<string, string> = {
  TROCA: 'TROCA (crédito usado na nova compra)',
  VALE: 'VALE-TROCA no CPF do cliente',
  DINHEIRO: 'DEVOLUÇÃO EM DINHEIRO',
  PIX: 'DEVOLUÇÃO POR PIX',
  CREDITO: 'ESTORNO NO CARTÃO DE CRÉDITO',
  DEBITO: 'ESTORNO NO CARTÃO DE DÉBITO',
};

function formatCpf(value: string | null): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length === 11 ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}` : '-';
}

export function buildReturnReceiptHtml(data: SaleReturnReceipt, store: PosStoreProfile | null): string {
  const e = escapeHtml;
  const created = new Date(data.createdAt);
  const saleDate = new Date(data.saleTimestamp);
  const isCredit = data.refundMethod === 'TROCA' || data.refundMethod === 'VALE';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Devolução ${data.returnNumber}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; width: 80mm; padding: 4mm 3mm 6mm; font-family: 'Courier New', Courier, monospace; font-size: 12px; font-weight: bold; color: #000; line-height: 1.35; -webkit-font-smoothing: none; }
  .center { text-align: center; }
  .store { font-family: Arial, Helvetica, sans-serif; font-size: 13px; }
  .title { font-size: 15px; letter-spacing: 1px; margin: 4px 0; }
  .dash { border-top: 2px dashed #000; margin: 4px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .row span:last-child { white-space: nowrap; }
  .sub { padding-left: 2ch; font-weight: normal; }
  .total { font-size: 14px; margin-top: 4px; }
  .signature { margin-top: 55px; border-top: 2px solid #000; padding-top: 3px; text-align: center; font-family: Arial, Helvetica, sans-serif; font-weight: normal; }
</style>
</head>
<body>
  ${store?.tradeName ? `<div class="center store">${e(store.tradeName)}</div>` : ''}
  <div class="dash"></div>
  <div class="center title">${data.refundMethod === 'TROCA' ? 'COMPROVANTE DE TROCA' : 'COMPROVANTE DE DEVOLUÇÃO'}</div>
  <div class="dash"></div>
  <div class="row"><span>Nº ${String(data.returnNumber).padStart(5, '0')}</span><span>${created.toLocaleDateString('pt-BR')} ${created.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span></div>
  <div>Venda: cupom ${formatReceiptNumber(data.saleReceiptNumber)} de ${saleDate.toLocaleDateString('pt-BR')}</div>
  <div>Cliente: ${e((data.customerName ?? 'CONSUMIDOR').toUpperCase())}</div>
  <div>CPF: ${formatCpf(data.customerCpf)}</div>
  <div class="dash"></div>
  ${data.items.map((item) => `
    <div class="row"><span>${item.quantity}x ${e(item.name.toUpperCase())}</span><span>${money(item.lineAmount)}</span></div>
    ${item.serials.length ? `<div class="sub">S/N ${e(item.serials.join(', '))}</div>` : ''}
    ${item.destination === 'AVARIADO' ? '<div class="sub">Produto avariado</div>' : ''}`).join('')}
  <div class="dash"></div>
  <div class="row total"><span>TOTAL</span><span>R$ ${money(data.totalAmount)}</span></div>
  <div>${e(REFUND_LABELS[data.refundMethod] ?? data.refundMethod)}</div>
  ${isCredit && data.creditBalance != null ? `<div>Saldo do vale-troca: R$ ${money(data.creditBalance)}</div>` : ''}
  <div class="sub">Motivo: ${e(data.reason)}</div>
  ${data.outOfPeriod ? '<div class="sub">Fora do prazo de troca (liberado com senha)</div>' : ''}
  ${data.fiscalStatus === 'AUTORIZADA' && data.nfeNumber ? `<div class="sub">NF-e de devolução nº ${e(data.nfeNumber)} série ${e(data.nfeSeries ?? '')}</div>` : ''}
  ${data.fiscalStatus && data.fiscalStatus !== 'AUTORIZADA' ? '<div class="sub">NF-e de devolução pendente</div>' : ''}
  <div class="sub">Atendente: ${e(data.operatorName)}</div>
  <div class="signature">ASSINATURA DO CLIENTE</div>
</body>
</html>`;
}

export function printReturnReceipt(data: SaleReturnReceipt, store: PosStoreProfile | null) {
  return printHtmlDocument(buildReturnReceiptHtml(data, store));
}
