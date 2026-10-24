import type { PosStoreProfile } from '../services/supabase/terminal';
import logoUrl from '../assets/beb-games-logo.png';

// Voucher de reserva em uma folha A4, no layout do voucher em papel da rede: em cima
// a via da loja (controle da reserva, com assinatura do cliente) e, depois da linha
// de corte, o canhoto horizontal que o cliente apresenta na retirada.

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

function productText(items: ReservationVoucherItem[]): string {
  return items.map((item) => {
    const details = [
      item.quantity > 1 ? `${item.quantity} un.` : '',
      item.serialNumber ? `Série ${item.serialNumber}` : '',
      item.isBackorder && !item.serialNumber ? 'Encomenda' : '',
    ].filter(Boolean).join(' · ');
    return `${item.name}${details ? ` (${details})` : ''}`;
  }).join(' + ');
}

// Icones de traco (estilo dos icones do voucher em papel).
const ICONS = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  gamepad: '<rect x="2" y="6" width="20" height="12" rx="5"/><path d="M6 12h4M8 10v4"/><circle cx="15.5" cy="11" r=".6"/><circle cx="18" cy="13.2" r=".6"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  id: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2.2"/><path d="M13 10h5M13 14h4"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  ticket: '<path d="M2 9a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3a3 3 0 0 0 0-6V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M9 15l6-6"/><circle cx="9.5" cy="9.5" r=".8"/><circle cx="14.5" cy="14.5" r=".8"/>',
  warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
};
const icon = (name: keyof typeof ICONS, size = 14) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

function buildHtml(data: ReservationVoucherData, store: PosStoreProfile | null, logo: string): string {
  const e = escapeHtml;
  const terms = store?.reservationVoucherTerms?.trim() || DEFAULT_VOUCHER_TERMS;
  const payment = paymentSummary(data);
  const code = reservationCode(data.reservationId);
  const product = productText(data.items);
  const storeLines = [
    store?.cnpj ? `CNPJ: ${e(store.cnpj)}` : '',
    store?.tradeName ? `Nome Fantasia: ${e(store.tradeName)}` : '',
    store?.address ? `Endereço: ${e(store.address)}` : '',
  ].filter(Boolean);
  const storeBlock = `
    ${store?.legalName ? `<div class="store-name">${e(store.legalName)}</div>` : ''}
    ${storeLines.map((line) => `<div>${line}</div>`).join('')}
    ${store?.phone ? `<div class="store-phone">${icon('phone', 12)} ${e(store.phone)}</div>` : ''}`;

  const rows: [keyof typeof ICONS, string, string][] = [
    ['user', 'Nome do cliente', e(data.customerName)],
    ['gamepad', 'Produto', e(product)],
    ['money', 'Valor', e(payment.value)],
    ['card', 'Forma de pagamento', e(payment.method)],
    ['calendar', 'Data de compra', formatDate(data.createdAt)],
    ['calendar', 'Data de retirada prevista', formatDate(data.expiresAt)],
    ['id', 'CPF do cliente', e(formatCpf(data.customerCpf))],
    ['phone', 'Telefone do cliente', e(data.customerPhone || '—')],
  ];
  const stubPairs: [string, string][][] = [
    [['Nome do cliente', e(data.customerName)], ['Produto', e(product)]],
    [['Valor', e(payment.value)], ['Forma de pagamento', e(payment.method)]],
    [['Data de compra', formatDate(data.createdAt)], ['Data de retirada prevista', formatDate(data.expiresAt)]],
    [['CPF do cliente', e(formatCpf(data.customerCpf))], ['Telefone do cliente', e(data.customerPhone || '—')]],
  ];

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Reserva ${code} - ${e(data.customerName)}</title>
<style>
  @page { size: A4 portrait; margin: 8mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  :root { --dark: #2b2d3b; --dark-2: #3a3c4b; --yellow: #f3c22c; --purple: #b23fd3; --purple-2: #8f2db3; --pink: #e46fd6; }
  body { margin: 0; font-family: 'Segoe UI', Arial, Helvetica, sans-serif; color: #1d1f2a; font-size: 11px; }
  .ico { display: inline-block; vertical-align: -2px; flex: none; }

  /* ---- Via da loja ---- */
  .voucher { border-radius: 10px; overflow: hidden; border: 1px solid #c9cad3; }
  .header { position: relative; display: flex; justify-content: space-between; gap: 18px; padding: 14px 18px 12px;
    background: linear-gradient(118deg, var(--purple) 0 7%, transparent 7% 9.5%, var(--purple-2) 9.5% 11%, transparent 11%), var(--dark); color: #fff; }
  .brand { padding-left: 34px; }
  .brand img { height: 46px; display: block; }
  .tags { margin-top: 6px; font-size: 7.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #fff; }
  .store { border-left: 3px solid var(--yellow); padding-left: 12px; font-size: 9.5px; line-height: 1.55; min-width: 230px; }
  .store-name { font-weight: 800; font-size: 11px; }
  .store-phone { margin-top: 3px; font-weight: 700; }
  .store-phone .ico { color: var(--yellow); }
  .stripe { height: 7px; background: linear-gradient(100deg, transparent 0 3%, var(--yellow) 3%); background-color: var(--dark); }

  .title { position: relative; margin: 12px 14px 10px; border-radius: 6px; padding: 10px 16px; display: flex; align-items: center; justify-content: center; gap: 16px;
    background: linear-gradient(118deg, transparent 0 82%, var(--purple) 82% 86%, transparent 86% 88%, var(--purple-2) 88% 90%, transparent 90%), var(--dark);
    color: #fff; border-bottom: 3px solid var(--purple); }
  .title .ticket { color: var(--yellow); border: 2px solid var(--yellow); border-radius: 8px; padding: 4px 8px; }
  .title h1 { margin: 0; font-size: 22px; font-weight: 900; letter-spacing: .03em; line-height: 1.05; text-align: center; }
  .title h1 span { display: block; color: var(--yellow); font-size: 15px; }
  .title .code { position: absolute; left: 16px; bottom: 6px; font-size: 8px; color: #b9bccb; letter-spacing: .05em; }

  .rows { margin: 0 14px; }
  .row { display: grid; grid-template-columns: 34% 1fr; margin-bottom: 3px; }
  .row .label { display: flex; align-items: center; gap: 8px; background: var(--dark-2); color: #fff; padding: 5px 10px;
    font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; border-radius: 3px 0 0 3px; }
  .row .value { border: 1.5px solid var(--dark-2); border-left: 0; padding: 4px 10px; font-weight: 700; font-size: 11px; border-radius: 0 3px 3px 0; }
  .row.sign .label { background: var(--dark); }
  .row.sign .value { height: 34px; display: flex; align-items: flex-end; gap: 6px; font-weight: 400; }
  .row.sign .line { flex: 1; border-bottom: 1px solid #1d1f2a; margin-bottom: 4px; }

  .footer { margin-top: 10px; display: grid; grid-template-columns: 150px 1fr 90px; gap: 14px; align-items: center; padding: 14px 18px;
    background: var(--dark); color: #fff; border-top: 3px solid var(--purple); }
  .slogan { font-size: 15px; font-weight: 900; line-height: 1.1; text-transform: uppercase; }
  .slogan span { display: block; color: var(--yellow); }
  .rules { border-left: 3px solid var(--yellow); padding-left: 12px; font-size: 8.5px; line-height: 1.5; text-transform: uppercase; }
  .rules h3 { margin: 0 0 4px; font-size: 10px; color: #fff; letter-spacing: .04em; }
  .rules h3 .ico { color: var(--yellow); }
  .pad { color: var(--pink); text-align: center; }

  /* ---- Corte ---- */
  .cut { margin: 12px 0; display: flex; align-items: center; gap: 8px; color: #555867; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  .cut::before, .cut::after { content: ''; flex: 1; border-top: 1.5px dashed #555867; }

  /* ---- Canhoto (horizontal) ---- */
  .stub { display: grid; grid-template-columns: 1fr 36%; border-radius: 10px; overflow: hidden; border: 1px solid #c9cad3; }
  .stub-left { padding: 12px 16px 12px; background: #fff; }
  .stub-left img { height: 34px; display: block; margin-bottom: 8px; }
  .stub-grid { border-top: 3px solid var(--purple); }
  .stub-grid .pair { display: grid; grid-template-columns: 24% 26% 24% 26%; border-bottom: 1px solid #e3e4ea; }
  .stub-grid .k { padding: 6px 6px 6px 0; font-size: 8px; font-weight: 800; text-transform: uppercase; color: #2b2d3b; }
  .stub-grid .v { padding: 6px 8px 6px 0; font-size: 9.5px; font-weight: 600; }
  .stub-sign { display: grid; grid-template-columns: 24% 1fr; align-items: end; padding-top: 10px; }
  .stub-sign .k { font-size: 8px; font-weight: 800; text-transform: uppercase; }
  .stub-sign .line { border-bottom: 1px solid #1d1f2a; height: 26px; width: 70%; }
  .stub-right { background: linear-gradient(160deg, transparent 0 88%, var(--purple) 88% 92%, transparent 92%), var(--dark); color: #fff; padding: 14px 16px; border-top: 3px solid var(--purple); }
  .stub-right h2 { margin: 0; color: var(--yellow); font-size: 20px; font-weight: 900; letter-spacing: .04em; text-align: right; }
  .stub-right .sub { text-align: right; font-size: 8px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; margin-bottom: 10px; }
  .stub-right .store { min-width: 0; font-size: 8.5px; margin-bottom: 10px; }
  .stub-right .rules { font-size: 7.8px; text-transform: none; }
  .stub-right .rules h3 { color: var(--yellow); text-transform: uppercase; }
  .stub-code { margin-top: 8px; font-size: 7.5px; color: #8d90a0; }
</style>
</head>
<body>
  <section class="voucher">
    <div class="header">
      <div class="brand">
        <img src="${logo}" alt="BeB Games">
        <div class="tags">Games • Consoles • Jogos • Acessórios • Informática • Eletrônicos • Celulares • Geek</div>
      </div>
      <div class="store">${storeBlock}</div>
    </div>
    <div class="stripe"></div>

    <div class="title">
      <div class="ticket">${icon('ticket', 30)}</div>
      <h1>RESERVA GARANTIDA<span>BEB GAMES</span></h1>
      <div class="code">RESERVA Nº ${code}</div>
    </div>

    <div class="rows">
      ${rows.map(([ico, label, value]) => `<div class="row"><div class="label">${icon(ico)} ${label}</div><div class="value">${value}</div></div>`).join('')}
      <div class="row sign"><div class="label">${icon('pen')} Assinatura do cliente</div><div class="value">X <span class="line"></span></div></div>
    </div>

    <div class="footer">
      <div class="slogan">Sua diversão <span>começa aqui!</span></div>
      <div class="rules"><h3>${icon('warning', 13)} Regras do voucher:</h3>${e(terms)}</div>
      <div class="pad">${icon('gamepad', 64)}</div>
    </div>
  </section>

  <div class="cut">${icon('scissors', 12)} Corte / destaque aqui ${icon('scissors', 12)}</div>

  <section class="stub">
    <div class="stub-left">
      <img src="${logo}" alt="BeB Games">
      <div class="stub-grid">
        ${stubPairs.map((pair) => `<div class="pair">${pair.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>`).join('')}
      </div>
      <div class="stub-sign"><div class="k">Assinatura do cliente</div><div class="line"></div></div>
    </div>
    <div class="stub-right">
      <h2>CANHOTO</h2>
      <div class="sub">Via destacável - Reserva garantida</div>
      <div class="store">${storeBlock}</div>
      <div class="rules"><h3>Regras do voucher</h3>${e(terms)}</div>
      <div class="stub-code">Reserva nº ${code}</div>
    </div>
  </section>
</body>
</html>`;
}

// Iframe invisivel (nao e bloqueado como pop-up); imprime depois que o logo carregar
// e e removido em seguida.
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
  doc.write(buildHtml(data, store, new URL(logoUrl, window.location.href).href));
  doc.close();

  const images = Array.from(doc.images);
  const loaded = Promise.all(images.map((image) => image.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => { image.onload = () => resolve(); image.onerror = () => resolve(); })));
  // Limite de espera: se o logo nao carregar, imprime assim mesmo.
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));

  win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500), { once: true });
  void Promise.race([loaded, timeout]).then(() => {
    win.focus();
    win.print();
    setTimeout(() => frame.isConnected && frame.remove(), 60000);
  });
}
