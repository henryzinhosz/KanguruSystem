import type { PosStoreProfile } from '../services/supabase/terminal';
import type { TradeInRecord } from '../services/supabase/tradeIns';
import { printHtmlDocument } from './receiptPrint';
import { formatCpf } from './reservationVoucher';
import logoUrl from '../assets/beb-games-logo.png';

// Termo de compra de videogame usado (Troca Gamer), A4 em duas vias: uma fica na loja
// assinada e a outra vai para o cliente. As declaracoes podem ser trocadas por loja no ERP
// (Configuracoes; uma linha em branco separa os paragrafos).

export const DEFAULT_TRADE_IN_TERMS = [
  'Declaro, para todos os fins de direito, que sou o legítimo proprietário do equipamento descrito acima, que ele tem origem lícita e não é produto de furto, roubo, receptação ou de qualquer outro crime, assumindo integral responsabilidade civil e criminal por esta declaração.',
  'Declaro que o equipamento está livre de dívidas, alienação, penhora ou bloqueio, e transfiro à loja a sua propriedade pelo valor acima, dando plena e total quitação, sem nada mais a reclamar.',
  'Estou ciente de que a loja pode consultar a procedência do equipamento e comunicar às autoridades competentes qualquer suspeita de irregularidade.',
  'Autorizo o uso dos meus dados pessoais exclusivamente para o registro desta operação, nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018).',
].join('\n\n');

const PAYMENT_TEXT: Record<string, string> = {
  VALE: 'Abatido em compra na loja (vale-troca no CPF do cliente)',
  DINHEIRO: 'Pago em dinheiro',
  PIX: 'Pago por Pix',
};

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

function via(data: TradeInRecord, store: PosStoreProfile | null, logo: string, label: string): string {
  const e = escapeHtml;
  const terms = (data.terms?.trim() || DEFAULT_TRADE_IN_TERMS)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const date = new Date(data.createdAt);
  const longDate = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const storeLines = [
    store?.legalName ? `<strong>${e(store.legalName)}</strong>` : '',
    [store?.tradeName, store?.cnpj ? `CNPJ ${store.cnpj}` : ''].filter(Boolean).map((part) => e(String(part))).join(' · '),
    store?.address ? e(store.address) : '',
    store?.phone ? `Telefone: ${e(store.phone)}` : '',
  ].filter(Boolean);
  const row = (label: string, value: string | null) =>
    `<tr><th>${label}</th><td>${value ? e(value) : '—'}</td></tr>`;

  return `
  <section class="page">
    <header>
      <img src="${logo}" alt="BeB Games">
      <div class="title">
        <h1>TERMO DE COMPRA DE VIDEOGAME USADO</h1>
        <div class="meta">Troca Gamer nº ${data.tradeNumber} · ${date.toLocaleString('pt-BR')}</div>
      </div>
      <div class="via">${label}</div>
    </header>
    <div class="store">${storeLines.map((line) => `<div>${line}</div>`).join('')}</div>

    <h2>1. Vendedor do equipamento (cliente)</h2>
    <table>
      ${row('Nome', data.customerName)}
      ${row('CPF', formatCpf(data.customerCpf))}
      ${row('RG / CNH', data.document)}
      ${row('Telefone', data.customerPhone)}
      ${row('Endereço', data.customerAddress)}
    </table>

    <h2>2. Equipamento</h2>
    <table>
      ${row('Modelo', data.description)}
      ${row('Nº de série', data.serialNumber)}
      ${data.imei ? row('IMEI', data.imei) : ''}
      ${row('Itens que acompanham', data.accessories)}
      ${row('Estado', data.condition)}
    </table>

    <h2>3. Valor</h2>
    <table>
      ${row('Valor da compra', currency.format(data.amount))}
      ${row('Forma', PAYMENT_TEXT[data.paymentMethod] ?? data.paymentMethod)}
    </table>

    <h2>4. Declarações do vendedor</h2>
    <div class="terms">${terms.map((paragraph) => `<p>${e(paragraph)}</p>`).join('')}</div>

    <p class="date">${e(longDate)}</p>
    <div class="signs">
      <div class="sign">
        <div class="line"></div>
        <strong>Assinatura do cliente</strong>
        <span>${e(data.customerName)} · CPF ${e(formatCpf(data.customerCpf))}</span>
      </div>
      <div class="sign">
        <div class="line"></div>
        <strong>Responsável da loja</strong>
        <span>Nome: ____________________________</span>
      </div>
    </div>
    <footer>Atendido por: ${e(data.staffCode)} - ${e(data.staffName)}</footer>
  </section>`;
}

export function buildTradeInTermHtml(data: TradeInRecord, store: PosStoreProfile | null, logo: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Troca Gamer nº ${data.tradeNumber} - ${escapeHtml(data.customerName)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 11.5px; }
  .page { page-break-after: always; display: flex; flex-direction: column; min-height: 270mm; }
  .page:last-child { page-break-after: auto; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #000; padding-bottom: 8px; }
  header img { height: 46px; }
  .title { flex: 1; }
  h1 { font-size: 17px; margin: 0; letter-spacing: .3px; }
  .meta { font-size: 11px; margin-top: 3px; }
  .via { border: 1.5px solid #000; border-radius: 4px; padding: 4px 8px; font-weight: bold; font-size: 11px; white-space: nowrap; }
  .store { margin: 8px 0 4px; font-size: 10.5px; line-height: 1.45; }
  h2 { font-size: 12px; margin: 12px 0 4px; text-transform: uppercase; background: #eee; padding: 4px 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { width: 30%; font-weight: bold; background: #fafafa; }
  .terms p { margin: 0 0 7px; text-align: justify; line-height: 1.45; }
  .date { margin: 14px 0 0; }
  .signs { display: flex; gap: 28px; margin-top: auto; padding-top: 46px; }
  .sign { flex: 1; display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; }
  .sign .line { border-top: 1.5px solid #000; margin-bottom: 4px; }
  footer { margin-top: 14px; font-size: 10px; border-top: 1px solid #999; padding-top: 5px; }
</style>
</head>
<body>
  ${via(data, store, logo, 'VIA DA LOJA')}
  ${via(data, store, logo, 'VIA DO CLIENTE')}
</body>
</html>`;
}

export async function printTradeInTerm(data: TradeInRecord, store: PosStoreProfile | null) {
  await printHtmlDocument(buildTradeInTermHtml(data, store, new URL(logoUrl, window.location.href).href));
}
