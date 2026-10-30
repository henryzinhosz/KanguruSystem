import { Product, ProductStoreCost, StockCount, StockInventory } from '../types';
import { formatMoney } from '../db/finance';

// Relatorio do balanco: diferenca de cada produto contado (contado - sistema no momento
// da contagem), em quantidade e em R$ pelo custo medio da loja; seriais que faltaram ou
// sobraram; e produtos do escopo com estoque que ninguem contou (ignorados no ajuste).

export const STOCK_COUNT_STATUS_LABELS: Record<StockCount['status'], string> = {
  ABERTO: 'Em contagem',
  SALVO: 'Relatório salvo',
  APROVADO: 'Aprovado (estoque ajustado)',
  CANCELADO: 'Cancelado',
};

export interface StockCountRow {
  product: Product;
  systemQty: number;
  countedQty: number;
  diff: number;
  unitCost: number;
  diffValue: number;
  missingSerials: string[];
  extraSerials: string[];
  reservedMissing: string[];
  countedByName?: string;
}

export interface StockCountReportData {
  rows: StockCountRow[];
  notCounted: { product: Product; qty: number }[];
  missingUnits: number;
  extraUnits: number;
  missingValue: number;
  extraValue: number;
}

export function productsInScope(products: Product[], categories: string[] | null): Product[] {
  return products.filter(product => !categories || categories.includes(product.category));
}

export function buildStockCountReport(
  count: StockCount,
  products: Product[],
  inventory: StockInventory[],
  costs: ProductStoreCost[],
): StockCountReportData {
  const byId = new Map(products.map(product => [product.id, product]));
  const costOf = (product: Product) =>
    costs.find(cost => cost.productId === product.id && cost.unitId === count.unitId)?.avgCost ?? Math.max(product.costPrice || 0, 0);

  const rows: StockCountRow[] = count.items
    .map((item): StockCountRow | null => {
      const product = byId.get(item.productId);
      if (!product) return null;
      const unitCost = costOf(product);
      const diff = item.countedQty - item.systemQty;
      const counted = new Set(item.countedSerials);
      const known = new Set([...item.systemSerials, ...item.reservedSerials]);
      return {
        product,
        systemQty: item.systemQty,
        countedQty: item.countedQty,
        diff,
        unitCost,
        diffValue: diff * unitCost,
        missingSerials: item.systemSerials.filter(serial => !counted.has(serial)),
        extraSerials: item.countedSerials.filter(serial => !known.has(serial)),
        reservedMissing: item.reservedSerials.filter(serial => !counted.has(serial)),
        countedByName: item.countedByName,
      };
    })
    .filter((row): row is StockCountRow => row !== null)
    .sort((left, right) => Math.abs(right.diffValue) - Math.abs(left.diffValue) || left.product.name.localeCompare(right.product.name));

  const countedIds = new Set(count.items.map(item => item.productId));
  const notCounted = productsInScope(products, count.categories)
    .filter(product => !countedIds.has(product.id))
    .map(product => ({ product, qty: inventory.find(inv => inv.productId === product.id)?.quantities[count.unitId]?.qty ?? 0 }))
    .filter(entry => entry.qty > 0)
    .sort((left, right) => left.product.name.localeCompare(right.product.name));

  return {
    rows,
    notCounted,
    missingUnits: rows.reduce((sum, row) => sum + Math.max(0, -row.diff), 0),
    extraUnits: rows.reduce((sum, row) => sum + Math.max(0, row.diff), 0),
    missingValue: rows.reduce((sum, row) => sum + Math.min(0, row.diffValue), 0),
    extraValue: rows.reduce((sum, row) => sum + Math.max(0, row.diffValue), 0),
  };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

export function printStockCount(count: StockCount, report: StockCountReportData, storeName: string, companyName: string) {
  const e = escapeHtml;
  const status = STOCK_COUNT_STATUS_LABELS[count.status];
  const rows = report.rows.map(row => {
    const serialNotes = [
      row.missingSerials.length ? `Faltaram: ${row.missingSerials.join(', ')}` : '',
      row.reservedMissing.length ? `Reservados não encontrados: ${row.reservedMissing.join(', ')}` : '',
      row.extraSerials.length ? `Fora do sistema: ${row.extraSerials.join(', ')}` : '',
    ].filter(Boolean).join(' · ');
    return `<tr class="${row.diff < 0 ? 'neg' : row.diff > 0 ? 'pos' : ''}">
      <td>${e(row.product.sku)}</td>
      <td>${e(row.product.name)}${serialNotes ? `<div class="note">${e(serialNotes)}</div>` : ''}</td>
      <td class="num">${row.systemQty}</td>
      <td class="num">${row.countedQty}</td>
      <td class="num">${row.diff > 0 ? '+' : ''}${row.diff}</td>
      <td class="num">${formatMoney(row.diffValue)}</td>
    </tr>`;
  }).join('');
  const notCounted = report.notCounted.length
    ? `<h2>Não contados (ignorados no ajuste): ${report.notCounted.length}</h2>
       <table><thead><tr><th>Código</th><th>Produto</th><th class="num">Estoque no sistema</th></tr></thead><tbody>
       ${report.notCounted.map(entry => `<tr><td>${e(entry.product.sku)}</td><td>${e(entry.product.name)}</td><td class="num">${entry.qty}</td></tr>`).join('')}
       </tbody></table>`
    : '';

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Balanço nº ${count.countNumber} - ${e(storeName)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 11px; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  h2 { font-size: 12px; margin: 14px 0 4px; text-transform: uppercase; background: #eee; padding: 4px 6px; }
  .meta { margin-bottom: 8px; line-height: 1.5; }
  .totals { display: flex; gap: 18px; margin: 8px 0; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #fafafa; }
  .num { text-align: right; white-space: nowrap; }
  tr.neg td { background: #fde8e8; }
  tr.pos td { background: #fff6dd; }
  .note { font-size: 10px; color: #444; margin-top: 2px; }
  .signs { display: flex; gap: 30px; margin-top: 50px; }
  .signs div { flex: 1; border-top: 1px solid #000; padding-top: 4px; text-align: center; }
</style></head><body>
  <h1>Balanço de estoque nº ${count.countNumber}</h1>
  <div class="meta">
    ${e(companyName)} · Loja: <strong>${e(storeName)}</strong><br>
    Escopo: ${count.categories ? e(count.categories.join(', ')) : 'Loja inteira'} · Situação: ${e(status)}<br>
    Aberto em ${new Date(count.createdAt).toLocaleString('pt-BR')}${count.createdByName ? ` por ${e(count.createdByName)}` : ''}
    ${count.approvedAt ? `<br>Aprovado em ${new Date(count.approvedAt).toLocaleString('pt-BR')}${count.approvedByName ? ` por ${e(count.approvedByName)}` : ''}` : ''}
    ${count.notes ? `<br>Observação: ${e(count.notes)}` : ''}
  </div>
  <div class="totals">
    <span>Produtos contados: ${report.rows.length}</span>
    <span>Faltas: ${report.missingUnits} un (${formatMoney(report.missingValue)})</span>
    <span>Sobras: ${report.extraUnits} un (${formatMoney(report.extraValue)})</span>
    <span>Saldo: ${formatMoney(report.missingValue + report.extraValue)}</span>
  </div>
  <h2>Produtos contados</h2>
  <table><thead><tr><th>Código</th><th>Produto</th><th class="num">Sistema</th><th class="num">Contado</th><th class="num">Diferença</th><th class="num">Valor (custo)</th></tr></thead>
  <tbody>${rows}</tbody></table>
  ${notCounted}
  <div class="signs"><div>Responsável pela contagem</div><div>Aprovação do administrador</div></div>
</body></html>`;

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
  win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500), { once: true });
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => frame.isConnected && frame.remove(), 60000);
  }, 100);
}
