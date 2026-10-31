import type { StoreConfig, Supplier } from '../types';
import type { PurchaseOrder } from '../db/supplierCatalogs';
import { formatMoney } from '../db/finance';

// PDF do pedido de compra: pagina limpa (A4) com loja, fornecedor e itens separados por
// marca. Abre a janela de impressao do navegador ("Salvar como PDF" para enviar).

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

const STATUS_LABELS: Record<string, string> = { RASCUNHO: 'Rascunho', ENVIADO: 'Enviado', CANCELADO: 'Cancelado' };

const money4 = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });

function buildHtml(order: PurchaseOrder, supplier: Supplier | undefined, store: StoreConfig | undefined) {
  const byBrand = new Map<string, PurchaseOrder['items']>();
  order.items.forEach(item => {
    const brand = item.brand || 'Sem marca';
    byBrand.set(brand, [...(byBrand.get(brand) || []), item]);
  });
  const pendingCount = order.items.filter(item => item.pricePending).length;
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);

  const sections = [...byBrand.entries()].map(([brand, items]) => {
    const subtotal = items.reduce((sum, item) => sum + item.unitCost * item.quantity, 0);
    const rows = items.map(item => `
      <tr class="${item.pricePending ? 'pending' : ''}">
        <td class="mono">${escapeHtml(item.supplierCode || '-')}</td>
        <td>${escapeHtml(item.name)}${item.pricePending ? ' <strong>(preço a confirmar)</strong>' : ''}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${item.pricePending ? 'a confirmar' : money4(item.unitCost)}</td>
        <td class="num">${item.pricePending ? '-' : formatMoney(item.unitCost * item.quantity)}</td>
      </tr>`).join('');
    return `
      <h2>${escapeHtml(brand)}</h2>
      <table>
        <thead><tr><th>Código</th><th>Produto</th><th class="num">Qtd</th><th class="num">Preço unit.</th><th class="num">Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="4" class="num">Subtotal ${escapeHtml(brand)}</td><td class="num">${formatMoney(subtotal)}</td></tr></tfoot>
      </table>`;
  }).join('');

  const date = new Date(order.sentAt || order.createdAt).toLocaleDateString('pt-BR');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Pedido de compra nº ${order.orderNumber}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11px; margin: 0; }
  header { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 8px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 16px 0 4px; padding: 4px 6px; background: #eee; }
  .box { border: 1px solid #bbb; border-radius: 4px; padding: 8px; margin-top: 10px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .label { font-size: 9px; text-transform: uppercase; color: #555; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ddd; padding: 4px 5px; text-align: left; vertical-align: top; }
  th { font-size: 9px; text-transform: uppercase; color: #444; }
  tfoot td { font-weight: bold; border-bottom: 0; }
  .num { text-align: right; white-space: nowrap; }
  .mono { font-family: 'Courier New', monospace; }
  tr.pending td { background: #fff4d6; }
  .total { margin-top: 14px; text-align: right; font-size: 15px; font-weight: bold; }
  .warn { margin-top: 8px; padding: 6px 8px; background: #fff4d6; border: 1px solid #e0b84c; border-radius: 4px; }
  footer { margin-top: 26px; display: flex; justify-content: space-between; gap: 30px; }
  .sign { flex: 1; border-top: 1px solid #111; padding-top: 4px; text-align: center; font-size: 10px; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>PEDIDO DE COMPRA Nº ${order.orderNumber}</h1>
      <div>Data: ${date} · Situação: ${STATUS_LABELS[order.status] || order.status}</div>
    </div>
    <div style="text-align:right">
      <strong>${escapeHtml(store?.legalName || store?.tradeName || order.unitId)}</strong><br />
      ${store?.cnpj ? `CNPJ ${escapeHtml(store.cnpj)}<br />` : ''}
      ${store?.stateRegistration ? `IE ${escapeHtml(store.stateRegistration)}<br />` : ''}
      ${store?.phone ? `Tel. ${escapeHtml(store.phone)}` : ''}
    </div>
  </header>

  <div class="grid">
    <div class="box">
      <div class="label">Fornecedor</div>
      <strong>${escapeHtml(supplier?.name || '-')}</strong><br />
      ${supplier?.cnpj ? `CNPJ ${escapeHtml(supplier.cnpj)}<br />` : ''}
      ${supplier?.contact ? `Contato: ${escapeHtml(supplier.contact)}<br />` : ''}
      ${supplier?.phone ? `Tel. ${escapeHtml(supplier.phone)}` : ''}
    </div>
    <div class="box">
      <div class="label">Entregar em</div>
      <strong>${escapeHtml(store?.tradeName || order.unitId)}</strong><br />
      ${store?.address ? escapeHtml(store.address) : ''}
    </div>
  </div>

  ${sections}

  <div class="total">Total do pedido: ${formatMoney(order.total)} <span style="font-size:11px;font-weight:normal">(${order.items.length} itens, ${units} unidades)</span></div>
  ${pendingCount > 0 ? `<div class="warn">${pendingCount} item(ns) com <strong>preço a confirmar</strong> (sem preço na tabela do fornecedor): não entram no total.</div>` : ''}
  ${order.notes ? `<div class="box"><div class="label">Observações</div>${escapeHtml(order.notes).replace(/\n/g, '<br />')}</div>` : ''}

  <footer>
    <div class="sign">Comprador: ${escapeHtml(order.createdByName || '')}</div>
    <div class="sign">Fornecedor (confirmação)</div>
  </footer>
</body>
</html>`;
}

// Iframe invisivel (nao e bloqueado como pop-up), como na impressao do historico.
export function printPurchaseOrder(order: PurchaseOrder, supplier: Supplier | undefined, store: StoreConfig | undefined) {
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
  doc.write(buildHtml(order, supplier, store));
  doc.close();
  win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500), { once: true });
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => frame.isConnected && frame.remove(), 60000);
  }, 100);
}
