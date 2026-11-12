import type { QuoteRecord } from '../services/supabase/quotes';
import type { PosStoreProfile } from '../services/supabase/terminal';
import { printHtmlDocument } from './receiptPrint';
import { formatDateOnly } from './workOrderPrint';
import logoUrl from '../assets/beb-games-logo.png';

// O que vai para o cliente: texto do WhatsApp e PDF. Custo e margem nunca entram aqui.

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// Parcelado em 12x: mesma conta da venda (taxa da tabela do ERP repassada, a loja recebe o total).
export function installmentPlan(total: number, rate: number) {
  const installmentTotal = rate > 0 && rate < 100 ? round2(total / (1 - rate / 100)) : total;
  return { installmentTotal, installment: round2(installmentTotal / 12) };
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // WebView sem permissao para a area de transferencia: usa o metodo antigo.
  }
  const area = document.createElement('textarea');
  area.value = text;
  Object.assign(area.style, { position: 'fixed', opacity: '0' });
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Não foi possível copiar o texto.');
}

export function quoteWhatsappText(quote: QuoteRecord, store: PosStoreProfile | null, rate: number): string {
  const plan = installmentPlan(quote.totalPrice, rate);
  const lines = quote.items.map((item) => {
    const quantity = item.quantity > 1 ? `${item.quantity}x ` : '';
    return `• ${item.partType}: ${quantity}${item.description} — ${currency.format(item.lineTotal)}`;
  });
  return [
    `*${quote.title}*`,
    `Orçamento nº ${quote.quoteNumber ?? ''}${store?.tradeName ? ` · ${store.tradeName}` : ''}`,
    '',
    ...lines,
    '',
    `*Total à vista: ${currency.format(quote.totalPrice)}*`,
    `Ou em 12x de ${currency.format(plan.installment)} (total ${currency.format(plan.installmentTotal)})`,
    `Válido até ${formatDateOnly(quote.validUntil)}`,
  ].join('\n');
}

function buildQuoteHtml(quote: QuoteRecord, store: PosStoreProfile | null, logo: string, rate: number): string {
  const e = escapeHtml;
  const plan = installmentPlan(quote.totalPrice, rate);
  const storeLines = [
    store?.legalName ? `<strong>${e(store.legalName)}</strong>` : '',
    [store?.tradeName, store?.cnpj ? `CNPJ ${store.cnpj}` : ''].filter(Boolean).map((part) => e(String(part))).join(' · '),
    store?.address ? e(store.address) : '',
    store?.phone ? `Telefone: ${e(store.phone)}` : '',
  ].filter(Boolean);
  const rows = quote.items.map((item) => `<tr>
      <td>${e(item.partType)}</td>
      <td>${e(item.description)}</td>
      <td class="num">${item.quantity}</td>
      <td class="num">${currency.format(item.unitPrice)}</td>
      <td class="num">${currency.format(item.lineTotal)}</td>
    </tr>`).join('');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Orçamento nº ${quote.quoteNumber ?? ''} - ${e(quote.title)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 12px; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #000; padding-bottom: 8px; }
  header img { height: 46px; }
  .title { flex: 1; }
  h1 { font-size: 17px; margin: 0; }
  .meta { margin-top: 3px; }
  .store { margin: 8px 0; font-size: 11px; line-height: 1.4; }
  .customer { margin: 8px 0 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin: 14px 0 0 auto; width: 55%; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .main { font-size: 15px; font-weight: bold; border-top: 2px solid #000; padding-top: 7px; }
  footer { margin-top: 18px; font-size: 11px; border-top: 1px solid #999; padding-top: 6px; }
</style>
</head>
<body>
  <header>
    <img src="${logo}" alt="">
    <div class="title">
      <h1>${e(quote.title)}</h1>
      <div class="meta">Orçamento nº ${quote.quoteNumber ?? ''} · Válido até ${formatDateOnly(quote.validUntil)}</div>
    </div>
  </header>
  <div class="store">${storeLines.join('<br>')}</div>
  ${quote.customerName || quote.customerPhone ? `<div class="customer"><strong>Cliente:</strong> ${e([quote.customerName, quote.customerPhone].filter(Boolean).join(' · '))}</div>` : ''}
  <table>
    <thead><tr><th>Tipo</th><th>Peça</th><th class="num">Qtd</th><th class="num">Valor</th><th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div class="main"><span>Total à vista</span><span>${currency.format(quote.totalPrice)}</span></div>
    <div><span>Em 12x de ${currency.format(plan.installment)}</span><span>${currency.format(plan.installmentTotal)}</span></div>
  </div>
  <footer>Atendido por: ${e(quote.sellerCode ?? '')} - ${e(quote.sellerName ?? '')}. Preços e disponibilidade sujeitos a alteração após a validade.</footer>
</body>
</html>`;
}

export async function printQuote(quote: QuoteRecord, store: PosStoreProfile | null, rate: number) {
  await printHtmlDocument(buildQuoteHtml(quote, store, new URL(logoUrl, window.location.href).href, rate));
}
