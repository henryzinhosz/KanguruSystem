import { Sale, SALE_PAYMENT_METHOD_LABELS } from '../types';
import { DEPOSIT_PAYMENT_KEY, SellerSummary, formatMoney } from '../db/finance';

// Impressao do Historico de Vendas: monta uma pagina limpa (sem menu nem botoes)
// com o que esta filtrado na tela e abre a janela de impressao do navegador
// (impressora ou "Salvar como PDF"). Nao grava nada no banco.

export type HistoryPrintMode = 'simplificado' | 'analitico' | 'detalhado';

const MODE_LABELS: Record<HistoryPrintMode, string> = {
  simplificado: 'Simplificado',
  analitico: 'Analítico',
  detalhado: 'Detalhado',
};

const STATUS_LABELS: Record<string, string> = {
  CONCLUIDA: 'Concluída',
  PENDENTE_APROVACAO: 'Estorno pendente',
  CANCELADA: 'Estornada',
};

export interface HistoryPrintData {
  companyName: string;
  companyDocument?: string;
  scopeLabel: string;
  rangeLabel: string;
  mode: HistoryPrintMode;
  printedBy: string;
  sales: Sale[];
  completedCount: number;
  total: number;
  canceledTotal: number;
  pendingTotal: number;
  payments: [string, number][];
  sellers: SellerSummary[];
  storeName: (unitId: string) => string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

const methodLabel = (method: string) =>
  method === DEPOSIT_PAYMENT_KEY
    ? 'Sinal de reserva (recebido antes)'
    : (SALE_PAYMENT_METHOD_LABELS[method as keyof typeof SALE_PAYMENT_METHOD_LABELS] ?? method);

function buildHtml(data: HistoryPrintData): string {
  const e = escapeHtml;
  const now = new Date();

  const paymentRows = data.payments.length
    ? data.payments.map(([method, amount]) => `<tr><td>${e(methodLabel(method))}</td><td class="num">${formatMoney(amount)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="empty">Nenhuma venda concluída no período.</td></tr>';

  const extraTotals = [
    data.canceledTotal > 0 ? `<tr class="muted"><td>Estornado no período (fora do total)</td><td class="num">${formatMoney(data.canceledTotal)}</td></tr>` : '',
    data.pendingTotal > 0 ? `<tr class="muted"><td>Estorno pendente de aprovação (fora do total)</td><td class="num">${formatMoney(data.pendingTotal)}</td></tr>` : '',
  ].join('');

  const paymentsSection = `
    <section>
      <h2>Vendas por forma de pagamento</h2>
      <table>
        <tbody>${paymentRows}</tbody>
        <tfoot>
          <tr class="total"><td>Total (${data.completedCount} venda(s))</td><td class="num">${formatMoney(data.total)}</td></tr>
          ${extraTotals}
        </tfoot>
      </table>
    </section>`;

  const sellersSection = data.mode === 'simplificado' ? '' : `
    <section>
      <h2>Vendas por vendedor</h2>
      <table>
        <thead><tr><th>Vendedor</th><th class="center">Vendas</th><th class="num">Ticket médio</th><th class="num">Total</th></tr></thead>
        <tbody>${data.sellers.length
          ? data.sellers.map(seller => `<tr><td>${e(seller.label)}</td><td class="center">${seller.salesCount}</td><td class="num">${formatMoney(seller.total / seller.salesCount)}</td><td class="num">${formatMoney(seller.total)}</td></tr>`).join('')
          : '<tr><td colspan="4" class="empty">Nenhuma venda concluída no período.</td></tr>'}</tbody>
      </table>
    </section>`;

  const salesSection = data.mode !== 'detalhado' ? '' : `
    <section>
      <h2>Venda por venda</h2>
      <table class="dense">
        <thead><tr><th>Data</th><th>Vendedor</th><th>Fatura / Doc</th><th>Loja</th><th>Forma Pagto</th><th class="num">Valor Bruto</th><th class="num">Valor Líquido</th><th class="center">Status</th></tr></thead>
        <tbody>${data.sales.length
          ? data.sales.map(sale => {
            const date = new Date(sale.timestamp);
            const seller = sale.sellerName ? `${e(sale.sellerName)} (${e(sale.sellerCode || '')})` : '—';
            const finalizedBy = sale.finalizedByName && sale.finalizedByName !== sale.sellerName
              ? `<div class="sub">finalizada por ${e(sale.finalizedByName)}</div>` : '';
            const split = sale.payments && sale.payments.length > 1
              ? sale.payments.map(p => `<div class="sub">${e(methodLabel(p.paymentMethod))}: ${formatMoney(p.amount)}</div>`).join('') : '';
            const canceled = sale.status !== 'CONCLUIDA' ? ' class="canceled"' : '';
            return `<tr${canceled}>
              <td>${date.toLocaleDateString('pt-BR')} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</td>
              <td>${seller}${finalizedBy}</td>
              <td>${sale.receiptNumber != null ? `Cupom ${String(sale.receiptNumber).padStart(5, '0')}` : e(sale.invoiceNumber || '')}</td>
              <td>${e(data.storeName(sale.unitId))}</td>
              <td>${e(methodLabel(sale.paymentMethod))}${split}</td>
              <td class="num">${formatMoney(sale.grossAmount)}</td>
              <td class="num">${formatMoney(sale.netAmount)}</td>
              <td class="center">${e(STATUS_LABELS[sale.status] ?? sale.status)}</td>
            </tr>`;
          }).join('')
          : '<tr><td colspan="8" class="empty">Nenhuma venda no período.</td></tr>'}</tbody>
      </table>
    </section>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Histórico de Vendas - ${e(data.rangeLabel)}</title>
<style>
  @page { size: A4 ${data.mode === 'detalhado' ? 'landscape' : 'portrait'}; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; font-size: 11px; margin: 0; }
  header { border-bottom: 2px solid #0f172a; padding-bottom: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; gap: 16px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 6px; }
  .meta { font-size: 10px; color: #475569; line-height: 1.5; }
  .meta.right { text-align: right; }
  section { margin-bottom: 14px; page-break-inside: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; color: #475569; border-bottom: 1px solid #94a3b8; padding: 4px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .dense td { font-size: 10px; }
  .num { text-align: right; font-family: 'Courier New', monospace; white-space: nowrap; }
  .center { text-align: center; }
  .total td { font-weight: bold; border-top: 2px solid #0f172a; border-bottom: none; }
  .muted td { color: #64748b; font-size: 10px; border-bottom: none; }
  .canceled td { color: #94a3b8; }
  .canceled td.num { text-decoration: line-through; }
  .sub { font-size: 9px; color: #64748b; }
  .empty { text-align: center; color: #94a3b8; padding: 14px; }
  footer { margin-top: 10px; font-size: 9px; color: #94a3b8; text-align: center; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>Histórico de Vendas — ${e(MODE_LABELS[data.mode])}</h1>
      <div class="meta">
        ${data.companyName ? `<strong>${e(data.companyName)}</strong>${data.companyDocument ? ` · CNPJ ${e(data.companyDocument)}` : ''}<br>` : ''}
        Loja: ${e(data.scopeLabel)}<br>
        Período: ${e(data.rangeLabel)}
      </div>
    </div>
    <div class="meta right">
      Impresso em ${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}<br>
      por ${e(data.printedBy)}
    </div>
  </header>
  ${paymentsSection}
  ${sellersSection}
  ${salesSection}
  <footer>Totais consideram só vendas concluídas. Estornadas e pendentes aparecem à parte.</footer>
</body>
</html>`;
}

// Usa um iframe invisivel (nao e bloqueado como pop-up) e remove depois de imprimir.
export function printSalesHistory(data: HistoryPrintData) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.style.right = '0';
  frame.style.bottom = '0';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(buildHtml(data));
  doc.close();

  const cleanup = () => setTimeout(() => frame.remove(), 500);
  win.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(() => {
    win.focus();
    win.print();
    // Alguns navegadores nao disparam afterprint; garante a limpeza.
    setTimeout(() => frame.isConnected && frame.remove(), 60000);
  }, 100);
}
