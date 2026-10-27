import QRCode from 'qrcode';
import type { PosStoreProfile } from '../services/supabase/terminal';
import type { PosSaleReceipt } from '../services/supabase/sales';
import logoUrl from '../assets/beb-games-logo.png';

// Cupom da venda em bobina de 80 mm: DAV (Nao Fiscal, layout do cupom atual da rede) ou
// DANFE NFC-e (venda com NFC-e autorizada). Imprime
// pela impressora instalada no Windows (driver), entao serve para qualquer modelo de 80 mm.

const RECEIPT_FOOTER = 'TROCA APENAS NO ENDEREÇO ACIMA E COM APRESENTAÇÃO DO CUPOM E CPF.';
const ANONYMOUS_CPF = '999.999.999-99';

const PAYMENT_LABELS: Record<string, string> = {
  DINHEIRO: 'DINHEIRO',
  PIX: 'PIX',
  CREDITO: 'CARTÃO DE CRÉDITO',
  DEBITO: 'CARTÃO DE DÉBITO',
  VOUCHER: 'VOUCHER',
  CREDIARIO: 'CREDIÁRIO',
};

const money = (value: number) => value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

function formatCpf(value: string | null): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length === 11
    ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
    : ANONYMOUS_CPF;
}

// "@bebgames", "bebgames" ou o link inteiro -> link do perfil.
export function instagramUrl(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  const handle = text.replace(/^@/, '').replace(/^(www\.)?instagram\.com\//i, '').replace(/\/+$/, '');
  return handle ? `https://instagram.com/${handle}` : null;
}

export function formatReceiptNumber(value: number | null): string {
  return value == null ? '-----' : String(value).padStart(5, '0');
}

function formatAccessKey(key: string): string {
  return key.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
}

// DANFE NFC-e: so os produtos (servicos ficam fora da nota). Pagamentos cortados no valor
// dos produtos, na mesma ordem usada no envio (sinal primeiro).
function buildNfceSection(receipt: PosSaleReceipt, qrDataUrl: string | null, changeAmount: number): string {
  const e = escapeHtml;
  const nfce = receipt.nfce!;
  const items = receipt.items.filter((item) => item.quantity > 0 && item.itemType === 'PRODUCT');
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
  const listTotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const productsTotal = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
  const discount = Math.max(0, Math.round((listTotal - productsTotal) * 100) / 100);
  const source = [
    ...(receipt.depositApplied > 0 ? [{ paymentMethod: 'SINAL', amount: receipt.depositApplied }] : []),
    ...(receipt.payments.length > 0
      ? receipt.payments
      : [{ paymentMethod: receipt.paymentMethod, amount: Math.max(0, receipt.grossAmount - receipt.depositApplied) }]),
  ];
  let remaining = productsTotal;
  const payments = source.flatMap((payment) => {
    const amount = Math.round(Math.min(remaining, payment.amount) * 100) / 100;
    remaining = Math.round((remaining - amount) * 100) / 100;
    return amount > 0 ? [{ ...payment, amount }] : [];
  });
  const authorized = nfce.authorizedAt ? new Date(nfce.authorizedAt) : new Date(receipt.timestamp);
  const cpf = (receipt.clientCpf ?? '').replace(/\D/g, '');

  const itemRows = items.map((item, index) => `
    <div class="row"><span>${String(index + 1).padStart(3, '0')} ${e(item.itemSku)} ${e(item.itemName.toUpperCase())}</span><span>${money(item.lineTotal)}</span></div>
    <div class="sub">${money(item.quantity)} UN x ${money(item.unitPrice)}${item.discountPercent > 0 ? ` &nbsp;(desc. ${money(item.discountPercent)}%)` : ''}</div>
    ${item.serials.length ? `<div class="sub">S/N ${e(item.serials.join(', '))}</div>` : ''}`).join('');

  return `
  <div class="center title">DANFE NFC-e - Documento Auxiliar da<br>Nota Fiscal de Consumidor Eletrônica</div>
  ${nfce.environment === 'homologacao' ? '<div class="center">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO<br>SEM VALOR FISCAL</div>' : ''}
  <hr>
  <div class="head"><span>Item Código Descrição</span><span>Total</span></div>
  <div class="sub">Qtd. UN x Vl. Unit.</div>
  <hr>
  ${itemRows}
  <div class="totals">
    <div class="row"><span>Qtde. total de itens</span><span>${String(totalItems).padStart(3, '0')}</span></div>
    <div class="row"><span>Valor total R$</span><span>${money(listTotal)}</span></div>
    ${discount > 0 ? `<div class="row"><span>Desconto R$</span><span>-${money(discount)}</span></div>` : ''}
    <div class="row"><span>Valor a Pagar R$</span><span>${money(productsTotal)}</span></div>
  </div>
  <div class="block row"><span>FORMA PAGAMENTO</span><span>VALOR PAGO R$</span></div>
  ${payments.map((payment) => `<div class="row sub"><span>${payment.paymentMethod === 'SINAL' ? 'SINAL DA RESERVA' : e(PAYMENT_LABELS[payment.paymentMethod] ?? payment.paymentMethod)}</span><span>${money(payment.amount)}</span></div>`).join('')}
  ${changeAmount > 0 ? `<div class="row"><span>Troco R$</span><span>${money(changeAmount)}</span></div>` : ''}
  <hr>
  <div class="center">Consulte pela Chave de Acesso em</div>
  <div class="center small">${e(nfce.consultUrl ?? '')}</div>
  <div class="center small">${e(formatAccessKey(nfce.key ?? ''))}</div>
  <hr>
  <div class="center">${cpf.length === 11 ? `CONSUMIDOR - CPF ${formatCpf(cpf)}${receipt.clientName ? `<br>${e(receipt.clientName.toUpperCase())}` : ''}` : 'CONSUMIDOR NÃO IDENTIFICADO'}</div>
  <hr>
  <div class="center">NFC-e nº ${e(String(nfce.number ?? '').padStart(9, '0'))} Série ${e(String(nfce.series ?? '').padStart(3, '0'))} ${new Date(receipt.timestamp).toLocaleDateString('pt-BR')} ${new Date(receipt.timestamp).toLocaleTimeString('pt-BR')}</div>
  <div class="center">Protocolo de autorização: ${e(nfce.protocol ?? '')}</div>
  <div class="center">Data de autorização: ${authorized.toLocaleDateString('pt-BR')} ${authorized.toLocaleTimeString('pt-BR')}</div>
  ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="">` : ''}
  <div class="center">Tributos Totais Incidentes (Lei Federal 12.741/2012): R$ ${money(nfce.taxTotal ?? 0)}</div>
`;
}

function buildHtml(receipt: PosSaleReceipt, store: PosStoreProfile | null, logo: string, qrDataUrl: string | null, changeAmount: number): string {
  const e = escapeHtml;
  const isNfce = receipt.fiscalStatus === 'AUTORIZADA' && receipt.nfce != null;
  const issued = new Date(receipt.timestamp);
  const items = receipt.items.filter((item) => item.quantity > 0);
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
  const listTotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const discount = Math.max(0, Math.round((listTotal - receipt.grossAmount) * 100) / 100);
  const toPay = Math.max(0, Math.round((receipt.grossAmount - receipt.depositApplied) * 100) / 100);
  const payments = receipt.payments.length > 0
    ? receipt.payments
    : toPay > 0 ? [{ paymentMethod: receipt.paymentMethod, amount: toPay }] : [];
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0);

  const itemRows = items.map((item, index) => `
    <div class="row"><span>${String(index + 1).padStart(3, '0')} ${e(item.itemName.toUpperCase())}</span><span>${money(item.lineTotal)}</span></div>
    <div class="sub">${money(item.quantity)} x R$ ${money(item.unitPrice)} R$${item.discountPercent > 0 ? ` &nbsp;(desc. ${money(item.discountPercent)}%)` : ''}</div>
    ${item.serials.length ? `<div class="sub">S/N ${e(item.serials.join(', '))}</div>` : ''}`).join('');

  const storeLines = [
    store?.tradeName ? `<div class="store-name">${e(store.tradeName.toUpperCase())}</div>` : '',
    store?.cnpj || store?.stateRegistration
      ? `<div>${store?.cnpj ? `CNPJ: (${e(store.cnpj.replace(/\D/g, ''))})` : ''}${store?.stateRegistration ? ` &nbsp; IE: ${e(store.stateRegistration)}` : ''}</div>`
      : '',
    store?.address ? `<div>${e(store.address.toUpperCase())}</div>` : '',
    store?.phone ? `<div>Telefone :${e(store.phone.replace(/\s+/g, ''))}</div>` : '',
  ].join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${isNfce ? 'NFC-e' : 'Cupom'} ${formatReceiptNumber(receipt.receiptNumber)}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  /* Impressora termica pelo driver do Windows: fonte em negrito e preto puro, senao o texto sai fraco */
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; width: 80mm; padding: 4mm 4mm 6mm; font-family: 'Courier New', Courier, monospace; font-size: 12px; font-weight: bold; color: #000; line-height: 1.35; -webkit-font-smoothing: none; text-rendering: optimizeSpeed; }
  .center { text-align: center; }
  .logo { display: block; width: 46mm; margin: 0 auto 6px; filter: grayscale(1) contrast(2) brightness(0.85); }
  .store-name { font-weight: bold; font-size: 13px; margin-bottom: 2px; }
  .title { margin: 4px 0 2px; }
  hr { border: 0; border-top: 2px dashed #000; margin: 3px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .row span:last-child { white-space: nowrap; }
  .sub { padding-left: 2ch; }
  .head { display: flex; justify-content: space-between; }
  .totals { margin-top: 6px; }
  .bold { font-weight: bold; }
  .block { margin-top: 10px; }
  .qr { display: block; width: 32mm; height: 32mm; margin: 10px auto; image-rendering: pixelated; }
  .footer { margin-top: 8px; text-transform: uppercase; }
  .issued { margin-top: 16px; }
  .small { font-size: 10px; word-break: break-all; }
</style>
</head>
<body>
  <img class="logo" src="${logo}" alt="">
  <div class="center">
    ${storeLines}
    ${isNfce ? '' : '<div class="title">DAV - DOCUMENTO AUXILIAR DE VENDA</div>'}
  </div>
  ${isNfce ? `${buildNfceSection(receipt, qrDataUrl, changeAmount)}
  <div class="block row"><span>Cupom : &nbsp;${formatReceiptNumber(receipt.receiptNumber)}</span><span>${receipt.sellerName ? `Vendedor : ${e(receipt.sellerName.toUpperCase())}` : ''}</span></div>
  <div class="footer">${RECEIPT_FOOTER}</div>` : `
  <hr>
  <div class="head"><span>Seq. Descrição Produto</span><span>Total</span></div>
  <div class="sub">Qtd. &nbsp;&nbsp; Preço</div>
  <hr>
  ${itemRows}
  <div class="totals">
    <div class="row"><span>Quantidade total de Itens</span><span>${String(totalItems).padStart(3, '0')}</span></div>
    <div class="row"><span>Valor Total R$</span><span>${money(listTotal)}</span></div>
    ${discount > 0 ? `<div class="row"><span>Desconto R$</span><span>-${money(discount)}</span></div>` : ''}
    ${receipt.depositApplied > 0 ? `<div class="row"><span>Sinal da reserva R$</span><span>-${money(receipt.depositApplied)}</span></div>` : ''}
    <div class="row"><span>Valor a Pagar R$</span><span>${money(toPay)}</span></div>
  </div>
  <div class="block">Forma Pagamento</div>
  ${payments.map((payment) => `<div class="row sub"><span>${e(PAYMENT_LABELS[payment.paymentMethod] ?? payment.paymentMethod)}</span><span>${money(payment.amount)}</span></div>`).join('')}
  <hr>
  <div class="center bold">Total Pago : &nbsp; ${money(paid)}</div>
  ${changeAmount > 0 ? `<div class="center">Troco : &nbsp; ${money(changeAmount)}</div>` : ''}
  <div class="block row"><span>Cupom : &nbsp;${formatReceiptNumber(receipt.receiptNumber)}</span><span>Data : ${issued.toLocaleDateString('pt-BR')}</span></div>
  ${receipt.sellerName ? `<div>Vendedor : &nbsp;${e(receipt.sellerName.toUpperCase())}</div>` : ''}
  <div class="block">${receipt.clientName ? e(receipt.clientName.toUpperCase()) : 'CONSUMIDOR'}</div>
  <div>CPF : ${formatCpf(receipt.clientCpf)}</div>
  ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="">` : ''}
  <div class="footer">${RECEIPT_FOOTER}</div>
  <div class="issued">Emissão : &nbsp; ${issued.toLocaleDateString('pt-BR')} ${issued.toLocaleTimeString('pt-BR')}</div>`}
</body>
</html>`;
}

// Iframe invisivel; imprime depois que logo e QR carregarem (limite de 3 s).
export async function printSaleReceipt(receipt: PosSaleReceipt, store: PosStoreProfile | null, changeAmount = 0) {
  // NFC-e autorizada: QR code de consulta da Sefaz; Nao Fiscal: Instagram da loja.
  const link = receipt.fiscalStatus === 'AUTORIZADA' && receipt.nfce?.qrcodeUrl ? receipt.nfce.qrcodeUrl : instagramUrl(store?.instagram);
  const qrDataUrl = link ? await QRCode.toDataURL(link, { margin: 0, width: 256, errorCorrectionLevel: 'M' }).catch(() => null) : null;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(buildHtml(receipt, store, new URL(logoUrl, window.location.href).href, qrDataUrl, changeAmount));
  doc.close();

  const loaded = Promise.all(Array.from(doc.images).map((image) => image.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => { image.onload = () => resolve(); image.onerror = () => resolve(); })));
  await Promise.race([loaded, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);

  win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500), { once: true });
  win.focus();
  win.print();
  setTimeout(() => frame.isConnected && frame.remove(), 60000);
}
