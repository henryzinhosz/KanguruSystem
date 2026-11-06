import { useEffect, useState } from 'react';
import { Printer, RefreshCw, X } from 'lucide-react';
import { getPosSellerReport, type SellerReport } from '../services/supabase/insights';
import type { PosStoreProfile } from '../services/supabase/terminal';
import { printHtmlDocument } from './receiptPrint';

// Vendas por vendedor (menu Consultas): hoje, no mes, meta e quanto falta. Todos podem ver.
// So produtos (servicos/OS fora), sem os juros do cartao, menos devolucoes.

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

function progressClass(percent: number) {
  return percent >= 100 ? 'is-done' : percent >= 70 ? 'is-mid' : '';
}

function buildReportHtml(report: SellerReport, store: PosStoreProfile | null): string {
  const e = escapeHtml;
  const now = new Date();
  const rows = report.sellers.map((row) => {
    const missing = row.goal ? Math.max(0, row.goal - row.monthAmount) : 0;
    return `<div class="seller">
      <div class="pair"><span>${e(row.code)} ${e(row.name)}</span></div>
      <div class="pair"><span>Hoje (${row.todayCount})</span><span>${currency.format(row.todayAmount)}</span></div>
      <div class="pair"><span>Mês (${row.monthCount})</span><span>${currency.format(row.monthAmount)}</span></div>
      ${row.goal ? `<div class="pair"><span>Meta</span><span>${currency.format(row.goal)} (${Math.round((row.monthAmount / row.goal) * 100)}%)</span></div>
      <div class="pair"><span>Falta</span><span>${currency.format(missing)}</span></div>` : ''}
    </div>`;
  }).join('');
  const today = report.sellers.reduce((sum, row) => sum + row.todayAmount, 0);
  const month = report.sellers.reduce((sum, row) => sum + row.monthAmount, 0);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Vendas por vendedor</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; width: 80mm; padding: 4mm 4mm 6mm; font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: bold; color: #000; line-height: 1.4; }
  .store { text-align: center; font-size: 15px; }
  .rule { border-top: 2px solid #000; margin: 4px 0; }
  .title { text-align: center; font-size: 17px; margin: 8px 0 2px; }
  .subtitle { text-align: center; font-weight: normal; margin-bottom: 8px; }
  .pair { display: flex; justify-content: space-between; gap: 8px; }
  .seller { border-bottom: 1px dashed #000; padding: 4px 0; }
  .seller .pair:first-child { font-size: 13px; }
</style>
</head>
<body>
  ${store?.tradeName || store?.legalName ? `<div class="store">${e(store?.tradeName || store?.legalName || '')}</div>` : ''}
  <div class="rule"></div>
  <div>Data: ${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR')}</div>
  <div class="title">VENDAS POR VENDEDOR</div>
  <div class="subtitle">Só produtos · menos devoluções · faltam ${report.daysLeft} dia(s) no mês</div>
  ${rows}
  <div class="pair" style="margin-top:6px"><span>Total hoje</span><span>${currency.format(today)}</span></div>
  <div class="pair"><span>Total no mês</span><span>${currency.format(month)}</span></div>
</body>
</html>`;
}

export function SellerReportModal({ onClose, loadStoreProfile }: { onClose: () => void; loadStoreProfile: () => Promise<PosStoreProfile | null> }) {
  const [report, setReport] = useState<SellerReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError('');
    try {
      setReport(await getPosSellerReport());
    } catch {
      setError('Não foi possível carregar o relatório. Confira a internet e se o sistema foi atualizado.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function print() {
    if (!report) return;
    await printHtmlDocument(buildReportHtml(report, await loadStoreProfile()));
  }

  const todayTotal = report?.sellers.reduce((sum, row) => sum + row.todayAmount, 0) ?? 0;
  const monthTotal = report?.sellers.reduce((sum, row) => sum + row.monthAmount, 0) ?? 0;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal report-modal" role="dialog" aria-modal="true" aria-labelledby="seller-report-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Consultas</p>
            <h2 id="seller-report-title">Vendas por vendedor</h2>
          </div>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button className="icon-button" type="button" title="Atualizar" disabled={busy} onClick={() => void load()}><RefreshCw size={20} /></button>
            <button className="icon-button" type="button" title="Imprimir" disabled={!report} onClick={() => void print()}><Printer size={20} /></button>
            <button className="icon-button" type="button" title="Fechar" onClick={onClose}><X size={20} /></button>
          </div>
        </div>
        <p className="modal-copy">Só produtos (serviços e OS não contam), sem os juros do cartão e menos as devoluções. Reserva convertida conta para quem iniciou.</p>
        {error && <p className="empty-state">{error}</p>}
        {busy && !report && <p className="empty-state">Carregando...</p>}
        {report && (
          <>
            <div className="report-summary">
              <div><small>Loja hoje</small><strong>{currency.format(todayTotal)}</strong></div>
              <div><small>Loja no mês</small><strong>{currency.format(monthTotal)}</strong></div>
              <div><small>Dias restantes no mês</small><strong>{report.daysLeft}</strong></div>
            </div>
            <div className="product-list lookup-list">
              {report.sellers.length === 0 && <p className="empty-state">Nenhum vendedor cadastrado nesta loja.</p>}
              {report.sellers.map((row) => {
                const percent = row.goal ? (row.monthAmount / row.goal) * 100 : 0;
                const missing = row.goal ? Math.max(0, row.goal - row.monthAmount) : 0;
                const perDay = report.daysLeft > 0 ? missing / report.daysLeft : missing;
                return (
                  <div className="seller-row" key={row.code}>
                    <div className="seller-row-head">
                      <strong>{row.code} · {row.name}</strong>
                      <strong>{currency.format(row.monthAmount)}</strong>
                    </div>
                    <small>Hoje: {currency.format(row.todayAmount)} em {row.todayCount} venda(s) · Mês: {row.monthCount} venda(s){row.monthCount > 0 ? ` · ticket ${currency.format(row.monthAmount / row.monthCount)}` : ''}</small>
                    {row.goal ? (
                      <>
                        <div className="goal-bar"><span className={progressClass(percent)} style={{ width: `${Math.min(100, percent)}%` }} /></div>
                        <small>
                          Meta {currency.format(row.goal)} · {percent.toFixed(0)}%
                          {missing > 0 ? ` · faltam ${currency.format(missing)} (${currency.format(perDay)} por dia)` : ' · meta batida!'}
                        </small>
                      </>
                    ) : (
                      <small>Sem meta cadastrada (ERP › Configurações do PDV › Vendedores).</small>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
