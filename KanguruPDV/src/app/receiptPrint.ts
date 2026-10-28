import QRCode from 'qrcode';
import type { PosStoreProfile } from '../services/supabase/terminal';
import type { PosSaleReceipt } from '../services/supabase/sales';
import logoUrl from '../assets/beb-games-logo.png';
import { printReceiptDirect } from '../printing/directPrint';

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
  VOUCHER: 'VALE-TROCA',
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

// DANFE NFC-e no layout do cupom fiscal da Linx (logo da BeB no lugar da Linx). So os produtos
// (servicos ficam fora da nota); pagamentos cortados no valor dos produtos, na mesma ordem
// usada no envio (sinal primeiro).
function buildNfceHtml(receipt: PosSaleReceipt, store: PosStoreProfile | null, logo: string, qrDataUrl: string | null, changeAmount: number): string {
  const e = escapeHtml;
  const nfce = receipt.nfce!;
  const items = receipt.items.filter((item) => item.quantity > 0 && item.itemType === 'PRODUCT');
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

  // Tributos aproximados por item (VLTR): parte proporcional do total da nota.
  const taxTotal = nfce.taxTotal ?? 0;
  const itemTax = (lineTotal: number) => productsTotal > 0 ? Math.round(taxTotal * lineTotal / productsTotal * 100) / 100 : 0;
  const issued = new Date(receipt.timestamp);
  const qty = (value: number) => value.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const consultUrl = (nfce.consultUrl ?? '').replace(/^https?:\/\//i, '');

  const itemRows = items.map((item, index) => `
    <div class="mono">${String(index + 1).padStart(3, '0')} ${e(item.itemSku)} ${e(item.itemName.toUpperCase())}</div>
    <div class="mono row item-values"><span>${qty(item.quantity)} UN &nbsp;X ${money(item.unitPrice)}(${money(itemTax(item.lineTotal))})</span><span>${money(item.lineTotal)}</span></div>
    ${item.serials.length ? `<div class="mono item-values">S/N ${e(item.serials.join(', '))}</div>` : ''}`).join('');

  const storeLines = [
    `<div class="issuer-name">${e((store?.legalName || store?.tradeName || '').toUpperCase())}</div>`,
    store?.cnpj ? `<div class="issuer-cnpj">${e(formatCnpj(store.cnpj))}</div>` : '',
    store?.address || store?.phone
      ? `<div class="issuer-address">${e(store?.address ?? '')}${store?.phone ? ` - FONE ${e(store.phone.replace(/\s+/g, ''))}` : ''}</div>`
      : '',
  ].join('');

  // Contingencia offline: aviso no cupom e duas vias (consumidor e estabelecimento), como manda a lei.
  const contingency = nfce.contingency === true && nfce.contingencyDone !== true;
  const danfeSection = (via: string) => `
  <div class="issuer">
    <img src="${logo}" alt="">
    <div>${storeLines}</div>
  </div>
  <div class="title">DOCUMENTO AUXILIAR DA NOTA FISCAL<br>DE CONSUMIDOR ELETRÔNICA</div>
  ${nfce.environment === 'homologacao' ? '<div class="homolog">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL</div>' : ''}
  ${contingency ? '<div class="homolog contingency">EMITIDA EM CONTINGÊNCIA<br>Pendente de autorização</div>' : ''}
  <div class="columns">#|COD|DESC|QTD|UN| VL UN R$|(VLTR R$)*|VL ITEM R$</div>
  ${itemRows}
  <div class="totals">
    <div class="row"><span>QTD. TOTAL DE ITENS</span><span>${String(items.length).padStart(3, '0')}</span></div>
    <div class="row"><span>SUBTOTAL</span><span>${money(listTotal)}</span></div>
    <div class="row"><span>DESCONTOS</span><span>${money(discount)}</span></div>
    <div class="gap"></div>
    <div class="row"><span>VALOR TOTAL R$</span><span>${money(productsTotal)}</span></div>
    <div class="row"><span>FORMA DE PAGAMENTO</span><span>Valor Pago</span></div>
  </div>
  ${payments.map((payment) => `<div class="row payment"><span>${payment.paymentMethod === 'SINAL' ? 'Sinal da reserva' : e(PAYMENT_NFCE_LABELS[payment.paymentMethod] ?? payment.paymentMethod)}</span><span>${money(payment.amount)}</span></div>`).join('')}
  ${changeAmount > 0 ? `<div class="row payment"><span>Troco</span><span>${money(changeAmount)}</span></div>` : ''}
  <div class="consult">Consulte pela Chave de Acesso em<br>${e(consultUrl)}</div>
  <div class="access-key">${e(formatAccessKey(nfce.key ?? ''))}</div>
  <div class="auth">
    ${qrDataUrl ? `<img src="${qrDataUrl}" alt="">` : ''}
    <div class="auth-info">
      <strong>Número ${e(String(nfce.number ?? '').padStart(9, '0'))} - Série ${e(String(nfce.series ?? '').padStart(3, '0'))}</strong><br>
      Emissão ${issued.toLocaleDateString('pt-BR')} ${issued.toLocaleTimeString('pt-BR')}<br>
      ${via}<br><br>
      Protocolo de Autorização ${e(nfce.protocol ?? '')}<br>
      Data de Autorização ${authorized.toLocaleDateString('pt-BR')} ${authorized.toLocaleTimeString('pt-BR')}<br>
      ${cpf.length === 11 ? `CONSUMIDOR CPF: ${formatCpf(cpf)}${receipt.clientName ? `<br>${e(receipt.clientName.toUpperCase())}` : ''}` : 'CONSUMIDOR NÃO IDENTIFICADO'}
    </div>
  </div>
  <div class="taxes">*Tributos Totais Incidentes (Lei Federal 12.741/2012): R$ ${money(taxTotal)}</div>
  <div class="store-footer">
    <div class="row"><span>Cupom: ${formatReceiptNumber(receipt.receiptNumber)}</span><span>${receipt.sellerName ? `Vendedor: ${e(receipt.sellerName.toUpperCase())}` : ''}</span></div>
    <div>${RECEIPT_FOOTER}</div>
  </div>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>NFC-e ${e(String(nfce.number ?? ''))}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  /* Impressora termica pelo driver do Windows: fonte em negrito e preto puro, senao o texto sai fraco */
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; width: 80mm; padding: 4mm 3mm 6mm; font-family: Arial, Helvetica, sans-serif; font-size: 11px; font-weight: bold; color: #000; line-height: 1.3; -webkit-font-smoothing: none; }
  .issuer { display: flex; align-items: center; gap: 2mm; }
  .issuer img { width: 20mm; flex: 0 0 auto; filter: grayscale(1) contrast(2) brightness(0.85); }
  .issuer-name { font-size: 12px; font-weight: bold; }
  .issuer-cnpj { font-size: 12px; }
  .issuer-address { font-size: 10px; font-weight: normal; }
  .title { margin: 6px 0 2px; text-align: center; font-size: 13px; line-height: 1.25; }
  .homolog { text-align: center; font-size: 11px; margin: 2px 0; }
  .contingency { font-size: 13px; border: 2px solid #000; padding: 2px; }
  .page-break { break-after: page; page-break-after: always; height: 10mm; }
  .columns { font-size: 9px; font-weight: normal; margin-bottom: 1px; }
  .mono { font-family: 'Courier New', Courier, monospace; font-size: 11.5px; font-weight: bold; }
  .item-values { padding-left: 6ch; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .row span:last-child { white-space: nowrap; }
  .totals { margin-top: 6px; font-size: 13px; }
  .totals .gap { height: 10px; }
  .payment { font-size: 12px; font-weight: normal; }
  .consult { text-align: center; font-size: 10px; font-weight: normal; margin-top: 4px; }
  .access-key { text-align: center; font-size: 9.5px; white-space: nowrap; margin-top: 2px; }
  .auth { display: flex; gap: 3mm; margin-top: 8px; }
  .auth img { width: 30mm; height: 30mm; flex: 0 0 auto; image-rendering: pixelated; }
  .auth-info { font-size: 10px; font-weight: normal; line-height: 1.35; }
  .auth-info strong { font-weight: bold; }
  .taxes { margin-top: 6px; font-size: 10px; font-weight: normal; text-align: center; }
  .store-footer { margin-top: 10px; font-size: 11px; }
  .store-footer .row { margin-bottom: 2px; }
</style>
</head>
<body>
  ${contingency ? `${danfeSection('Via Consumidor')}<div class="page-break"></div>${danfeSection('Via Estabelecimento')}` : danfeSection('Via Consumidor')}
</body>
</html>`;
}

function formatCnpj(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 14
    ? `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
    : value;
}

const PAYMENT_NFCE_LABELS: Record<string, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'PIX',
  CREDITO: 'Cartão de Crédito',
  DEBITO: 'Cartão de Débito',
  VOUCHER: 'Vale-troca',
  CREDIARIO: 'Crédito Loja',
};

export function buildHtml(receipt: PosSaleReceipt, store: PosStoreProfile | null, logo: string, qrDataUrl: string | null, changeAmount: number): string {
  if (receipt.fiscalStatus === 'AUTORIZADA' && receipt.nfce != null) {
    return buildNfceHtml(receipt, store, logo, qrDataUrl, changeAmount);
  }
  const e = escapeHtml;
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
<title>Cupom ${formatReceiptNumber(receipt.receiptNumber)}</title>
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
</style>
</head>
<body>
  <img class="logo" src="${logo}" alt="">
  <div class="center">
    ${storeLines}
    <div class="title">DAV - DOCUMENTO AUXILIAR DE VENDA</div>
  </div>
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
  <div class="issued">Emissão : &nbsp; ${issued.toLocaleDateString('pt-BR')} ${issued.toLocaleTimeString('pt-BR')}</div>
</body>
</html>`;
}

// Iframe invisivel; imprime depois que logo e QR carregarem (limite de 3 s).
export async function printSaleReceipt(receipt: PosSaleReceipt, store: PosStoreProfile | null, changeAmount = 0) {
  // Impressora termica escolhida neste PC: imprime direto; senao (ou se falhar) janela do Windows.
  if (await printReceiptDirect(receipt, store, changeAmount)) return;
  // NFC-e autorizada: QR code de consulta da Sefaz; Nao Fiscal: Instagram da loja.
  const link = receipt.fiscalStatus === 'AUTORIZADA' && receipt.nfce?.qrcodeUrl ? receipt.nfce.qrcodeUrl : instagramUrl(store?.instagram);
  const qrDataUrl = link ? await QRCode.toDataURL(link, { margin: 0, width: 256, errorCorrectionLevel: 'M' }).catch(() => null) : null;
  await printHtmlDocument(buildHtml(receipt, store, new URL(logoUrl, window.location.href).href, qrDataUrl, changeAmount));
}

// Imprime um documento HTML pela impressora do Windows (iframe invisivel; espera as imagens
// carregarem, limite de 3 s). Usado pelo cupom e pelos relatorios gerenciais do caixa.
export async function printHtmlDocument(html: string) {
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
  doc.write(html);
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
