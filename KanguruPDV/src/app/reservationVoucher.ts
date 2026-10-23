import type { PosStoreProfile } from '../services/supabase/terminal';

// Voucher de reserva em uma folha A4: em cima a via da loja (controle da reserva,
// com assinatura do cliente) e, depois da linha de corte, o canhoto que o cliente
// apresenta na retirada. Abre a janela de impressao (impressora ou PDF).

export const DEFAULT_VOUCHER_TERMS =
  'Reserva de compra garantida. Para retirada do produto, apresente este voucher juntamente com a nota emitida. ' +
  'Não será aceita desistência nem devolução de valores e itens negociados. ' +
  'Através deste, o cliente declara estar ciente e de acordo.';

export interface ReservationVoucherItem {
  name: string;
  quantity: number;
  serialNumber: string | null;
  isBackorder: boolean;
}

export interface ReservationVoucherData {
  reservationId: string;
  customerName: string;
  customerCpf: string | null;
  customerPhone: string | null;
  items: ReservationVoucherItem[];
  total: number;
  depositAmount: number;
  depositPaymentMethod: string | null;
  createdAt: string;
  expiresAt: string;
  sellerName: string | null;
}

const PAYMENT_LABELS: Record<string, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'Pix',
  CREDITO: 'Cartão de crédito',
  DEBITO: 'Cartão de débito',
};

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

export function formatCpf(value: string | null): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length === 11
    ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
    : value ?? '';
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

export function reservationCode(reservationId: string): string {
  return reservationId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

// Pagou tudo: so o valor. Pagou parte ou nada: valor pago e o restante.
function paymentSummary(data: ReservationVoucherData): { value: string; method: string } {
  const paid = Math.min(data.depositAmount, data.total);
  const remaining = Math.max(0, Math.round((data.total - paid) * 100) / 100);
  const method = paid > 0 && data.depositPaymentMethod
    ? PAYMENT_LABELS[data.depositPaymentMethod] ?? data.depositPaymentMethod
    : 'A pagar na retirada';
  return {
    value: remaining > 0 ? `${currency.format(paid)} (Restante: ${currency.format(remaining)})` : currency.format(data.total),
    method,
  };
}

function productLines(items: ReservationVoucherItem[]): string {
  return items.map((item) => {
    const details = [
      item.quantity > 1 ? `${item.quantity} un.` : '',
      item.serialNumber ? `Série ${item.serialNumber}` : '',
      item.isBackorder && !item.serialNumber ? 'Encomenda' : '',
    ].filter(Boolean).join(' · ');
    return `<div>${escapeHtml(item.name)}${details ? ` <span class="muted">(${escapeHtml(details)})</span>` : ''}</div>`;
  }).join('');
}

function buildHtml(data: ReservationVoucherData, store: PosStoreProfile | null): string {
  const e = escapeHtml;
  const terms = store?.reservationVoucherTerms?.trim() || DEFAULT_VOUCHER_TERMS;
  const payment = paymentSummary(data);
  const code = reservationCode(data.reservationId);
  const storeInfo = [
    store?.legalName ? `<strong>${e(store.legalName)}</strong>` : '',
    store?.cnpj ? `CNPJ: ${e(store.cnpj)}` : '',
    store?.tradeName ? `Nome Fantasia: ${e(store.tradeName)}` : '',
    store?.address ? `Endereço: ${e(store.address)}` : '',
    store?.phone ? `Telefone: ${e(store.phone)}` : '',
  ].filter(Boolean).join('<br>');

  const rows: [string, string][] = [
    ['Nome do cliente', e(data.customerName)],
    ['Produto', productLines(data.items)],
    ['Valor', e(payment.value)],
    ['Forma de pagamento', e(payment.method)],
    ['Data da reserva', formatDate(data.createdAt)],
    ['Data de retirada prevista', formatDate(data.expiresAt)],
    ['CPF do cliente', e(formatCpf(data.customerCpf))],
    ['Telefone do cliente', e(data.customerPhone || '—')],
  ];
  const table = (list: [string, string][]) => list.map(([label, value]) =>
    `<tr><th>${label}</th><td>${value}</td></tr>`).join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Reserva ${code} - ${e(data.customerName)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111827; font-size: 11px; }
  .voucher { border: 1px solid #1f2937; border-radius: 6px; overflow: hidden; }
  .top { display: flex; justify-content: space-between; gap: 16px; background: #1f2433; color: #fff; padding: 12px 16px; border-bottom: 3px solid #f5c518; }
  .logo { font-size: 26px; font-weight: 900; letter-spacing: .02em; color: #f5c518; }
  .logo span { color: #fff; }
  .slogan { font-size: 8px; text-transform: uppercase; letter-spacing: .12em; color: #c4b5fd; margin-top: 2px; }
  .store { font-size: 9.5px; line-height: 1.5; text-align: left; border-left: 2px solid #f5c518; padding-left: 10px; }
  .title { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; border-bottom: 2px solid #a855f7; }
  .title h1 { margin: 0; font-size: 18px; letter-spacing: .04em; }
  .title h1 small { display: block; font-size: 11px; color: #a16207; letter-spacing: .1em; }
  .code { font-size: 11px; text-align: right; }
  .code strong { font-size: 15px; font-family: 'Courier New', monospace; }
  table { width: 100%; border-collapse: collapse; }
  th { width: 34%; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; background: #f3f4f6; }
  th, td { border-bottom: 1px solid #d1d5db; padding: 5px 10px; vertical-align: top; }
  td { font-weight: 600; }
  .muted { color: #6b7280; font-weight: 400; }
  .signature td { height: 38px; vertical-align: bottom; }
  .signature span { display: block; border-bottom: 1px solid #111827; width: 75%; }
  .bottom { display: flex; gap: 14px; background: #1f2433; color: #e5e7eb; padding: 10px 16px; font-size: 9px; line-height: 1.5; }
  .bottom h3 { margin: 0 0 3px; font-size: 10px; color: #f5c518; text-transform: uppercase; }
  .bottom .tagline { min-width: 120px; font-weight: 900; font-size: 13px; color: #fff; text-transform: uppercase; }
  .bottom .tagline span { color: #f5c518; display: block; }
  .meta { padding: 4px 16px; font-size: 9px; color: #6b7280; }
  .cut { margin: 14px 0; border-top: 2px dashed #6b7280; position: relative; text-align: center; }
  .cut span { position: relative; top: -8px; background: #fff; padding: 0 8px; font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: .1em; }
  .stub .top { padding: 8px 14px; }
  .stub .logo { font-size: 20px; }
  .stub th, .stub td { padding: 4px 10px; }
</style>
</head>
<body>
  <section class="voucher">
    <div class="top">
      <div><div class="logo">BeB <span>GAMES</span></div><div class="slogan">Games · Consoles · Jogos · Acessórios · Informática · Eletrônicos · Geek</div></div>
      <div class="store">${storeInfo}</div>
    </div>
    <div class="title">
      <h1>RESERVA GARANTIDA<small>VIA DA LOJA</small></h1>
      <div class="code">Reserva nº<br><strong>${code}</strong></div>
    </div>
    <table>
      ${table(rows)}
      <tr class="signature"><th>Assinatura do cliente</th><td><span></span></td></tr>
    </table>
    ${data.sellerName ? `<div class="meta">Vendedor: ${e(data.sellerName)}</div>` : ''}
    <div class="bottom">
      <div class="tagline">Sua diversão <span>começa aqui!</span></div>
      <div><h3>Regras do voucher</h3>${e(terms)}</div>
    </div>
  </section>

  <div class="cut"><span>✂ Corte aqui · destaque o canhoto</span></div>

  <section class="voucher stub">
    <div class="top">
      <div class="logo">BeB <span>GAMES</span></div>
      <div class="store">${storeInfo}</div>
    </div>
    <div class="title">
      <h1>CANHOTO<small>VIA DO CLIENTE · RESERVA GARANTIDA</small></h1>
      <div class="code">Reserva nº<br><strong>${code}</strong></div>
    </div>
    <table>
      ${table(rows)}
    </table>
    <div class="bottom">
      <div><h3>Regras do voucher</h3>${e(terms)}</div>
    </div>
  </section>
</body>
</html>`;
}

// Iframe invisivel (nao e bloqueado como pop-up); removido depois de imprimir.
export function printReservationVoucher(data: ReservationVoucherData, store: PosStoreProfile | null) {
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
  doc.write(buildHtml(data, store));
  doc.close();

  win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500), { once: true });
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => frame.isConnected && frame.remove(), 60000);
  }, 150);
}
