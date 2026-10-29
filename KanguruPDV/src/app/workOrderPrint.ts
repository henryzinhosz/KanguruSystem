import type { PosStoreProfile } from '../services/supabase/terminal';
import type { WorkOrderRecord } from '../services/supabase/workOrders';
import { printHtmlDocument } from './receiptPrint';
import { formatCpf } from './reservationVoucher';
import logoUrl from '../assets/beb-games-logo.png';

// Comprovantes da Ordem de Servico, A4 em duas vias (loja assinada + cliente):
// entrada (cliente deixa o aparelho) e entrega (cliente retira). As condicoes podem
// ser trocadas por loja no ERP (Configuracoes; uma linha em branco separa os paragrafos).

export const DEFAULT_WORK_ORDER_TERMS = [
  'O valor dos serviços é uma estimativa e pode mudar após a análise técnica. A loja avisa o cliente e só executa serviço com valor diferente depois da autorização dele.',
  'A loja não se responsabiliza por dados, jogos, contas ou arquivos salvos no aparelho. Recomendamos fazer cópia de segurança antes de deixar o aparelho.',
  'A abertura do aparelho pode romper o selo de garantia do fabricante.',
  'Aparelho não retirado em até 90 (noventa) dias após o aviso de que está pronto poderá ser considerado abandonado, nos termos da lei.',
  'A retirada só é feita com este comprovante ou pelo próprio cliente com documento com foto.',
  'Autorizo o uso dos meus dados pessoais exclusivamente para o atendimento desta ordem de serviço, nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018).',
].join('\n\n');

export const DEFAULT_WORK_ORDER_DELIVERY_TERMS = [
  'Declaro que recebi o equipamento descrito acima, testado na minha presença, funcionando quanto aos serviços executados, nada mais tendo a reclamar.',
  'A garantia de 90 (noventa) dias cobre somente os serviços executados e as peças trocadas (Código de Defesa do Consumidor, art. 26). Não cobre mau uso, quedas, contato com líquidos, oxidação, descarga elétrica ou abertura do aparelho por terceiros.',
  'Para usar a garantia, apresente este comprovante.',
].join('\n\n');

const WITHOUT_REPAIR_TERMS = [
  'Declaro que recebi de volta o equipamento descrito acima, sem conserto, no mesmo estado em que o deixei na loja, nada mais tendo a reclamar.',
];

const PAYMENT_LABELS: Record<string, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'Pix',
  CREDITO: 'Crédito',
  DEBITO: 'Débito',
  VOUCHER: 'Vale-troca',
  CREDIARIO: 'Crediário',
};

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

// Data sem hora vinda do banco (aaaa-mm-dd): mostra sem mudar de dia pelo fuso.
export function formatDateOnly(value: string | null): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function paragraphs(value: string | null, fallback: string): string[] {
  return (value?.trim() || fallback).split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

type Kind = 'entry' | 'delivery';

function via(data: WorkOrderRecord, store: PosStoreProfile | null, logo: string, label: string, kind: Kind, storeCopy: boolean): string {
  const e = escapeHtml;
  const delivered = kind === 'delivery';
  const withoutRepair = data.status === 'DEVOLVIDO';
  const storeLines = [
    store?.legalName ? `<strong>${e(store.legalName)}</strong>` : '',
    [store?.tradeName, store?.cnpj ? `CNPJ ${store.cnpj}` : ''].filter(Boolean).map((part) => e(String(part))).join(' · '),
    store?.address ? e(store.address) : '',
    store?.phone ? `Telefone: ${e(store.phone)}` : '',
  ].filter(Boolean);
  const row = (name: string, value: string | null) => `<tr><th>${name}</th><td>${value ? e(value) : '—'}</td></tr>`;
  const title = delivered
    ? (withoutRepair ? 'COMPROVANTE DE DEVOLUÇÃO DA ORDEM DE SERVIÇO' : 'COMPROVANTE DE ENTREGA DA ORDEM DE SERVIÇO')
    : 'COMPROVANTE DE ABERTURA DA ORDEM DE SERVIÇO';
  const terms = delivered
    ? (withoutRepair ? WITHOUT_REPAIR_TERMS : paragraphs(data.deliveryTerms, DEFAULT_WORK_ORDER_DELIVERY_TERMS))
    : paragraphs(data.terms, DEFAULT_WORK_ORDER_TERMS);
  const created = new Date(data.createdAt).toLocaleString('pt-BR');

  // Entrada: servicos solicitados com o preco do cadastro (estimativa).
  // Entrega: o que foi cobrado na venda (com desconto), quando houver venda ligada.
  const charged = delivered && data.paidItems.length > 0;
  const serviceRows = charged
    ? data.paidItems.map((item) => `<tr><td>${e(item.sku)}</td><td>${e(item.name)}${item.quantity > 1 ? ` (${item.quantity}x)` : ''}</td><td class="num">${item.discountPercent > 0 ? `${item.discountPercent.toLocaleString('pt-BR')}%` : '—'}</td><td class="num">${currency.format(item.lineTotal)}</td></tr>`).join('')
    : data.items.map((item) => `<tr><td>${e(item.sku)}</td><td>${e(item.name)}</td><td class="num">—</td><td class="num">${currency.format(item.price)}</td></tr>`).join('');
  const totalLabel = delivered
    ? (withoutRepair ? 'Total (não cobrado)' : charged ? 'Total pago' : 'Total')
    : 'Total estimado';
  const totalValue = charged ? (data.paidTotal ?? 0) : data.total;
  const payment = data.payments.length
    ? data.payments.map((line) => `${PAYMENT_LABELS[line.paymentMethod] ?? line.paymentMethod} ${currency.format(line.amount)}`).join(' + ')
    : null;

  const paymentSection = delivered
    ? `<table>
        ${row('Entrada', created)}
        ${row(withoutRepair ? 'Devolução' : 'Entrega', data.deliveredAt ? new Date(data.deliveredAt).toLocaleString('pt-BR') : null)}
        ${withoutRepair ? '' : row('Pagamento', payment ? `${payment}${data.receiptNumber ? ` (cupom nº ${String(data.receiptNumber).padStart(5, '0')})` : ''}` : (data.total > 0 ? null : 'Sem custo'))}
        ${withoutRepair ? '' : row('Garantia do serviço até', formatDateOnly(data.warrantyUntil))}
      </table>
      ${withoutRepair ? '' : `<p class="check">${data.testedOnDelivery ? '☒' : '☐'} Equipamento testado na entrega diante do cliente.</p>`}`
    : `<table>
        ${row('Previsão de entrega', data.expectedDate ? formatDateOnly(data.expectedDate) : 'A combinar após a análise')}
        ${row('Pagamento', data.paidAt ? `Pago na abertura: ${payment ?? ''}` : 'Na retirada do aparelho')}
      </table>`;

  return `
  <section class="page">
    <header>
      <img src="${logo}" alt="BeB Games">
      <div class="title">
        <h1>${title}</h1>
        <div class="meta">OS nº ${data.orderNumber} · ${delivered ? `Entrada em ${created}` : created}</div>
      </div>
      <div class="via">${label}</div>
    </header>
    <div class="store">${storeLines.map((line) => `<div>${line}</div>`).join('')}</div>

    <h2>1. Cliente</h2>
    <table>
      ${row('Nome', data.customerName)}
      ${row('CPF', data.customerCpf ? formatCpf(data.customerCpf) : null)}
      ${row('Celular', data.customerPhone)}
      ${row('Endereço', data.customerAddress)}
    </table>

    <h2>2. Aparelho</h2>
    <table>
      ${row('Tipo', data.equipmentType)}
      ${row('Marca / modelo', data.equipment)}
      ${row('Nº de série', data.serialNumber)}
      ${row('Acessórios deixados', data.accessories ?? 'Nenhum')}
      ${row('Estado na entrada', data.entryCondition)}
      ${storeCopy && data.devicePassword ? row('Senha / desbloqueio', data.devicePassword) : ''}
    </table>

    <h2>3. ${delivered ? (withoutRepair ? 'Serviços solicitados' : 'Serviços executados') : 'Serviços solicitados'}</h2>
    <table class="services">
      <thead><tr><th>Código</th><th>Serviço</th><th class="num">Desconto</th><th class="num">Valor</th></tr></thead>
      <tbody>${serviceRows}</tbody>
      <tfoot><tr><td colspan="3">${totalLabel}</td><td class="num">${currency.format(totalValue)}</td></tr></tfoot>
    </table>
    ${data.notes ? `<p class="notes"><strong>Observação:</strong> ${e(data.notes)}</p>` : ''}
    ${delivered ? '' : '<p class="notes">Valores sujeitos a análise técnica.</p>'}

    <h2>4. ${delivered ? 'Entrega' : 'Prazo e pagamento'}</h2>
    ${paymentSection}

    <h2>5. ${delivered ? 'Declaração do cliente' : 'Condições'}</h2>
    <div class="terms">${terms.map((paragraph) => `<p>${e(paragraph)}</p>`).join('')}</div>

    <div class="signs">
      <div class="sign">
        <div class="line"></div>
        <strong>Assinatura do cliente</strong>
        <span>${e(data.customerName)}${data.customerCpf ? ` · CPF ${e(formatCpf(data.customerCpf))}` : ''}</span>
      </div>
      <div class="sign">
        <div class="line"></div>
        <strong>${delivered ? 'Responsável da loja' : 'Atendente'}</strong>
        <span>${delivered
          ? (data.deliveredByCode ? `${e(data.deliveredByCode)} - ${e(data.deliveredByName ?? '')}` : 'Nome: ____________________________')
          : (data.staffCode ? `${e(data.staffCode)} - ${e(data.staffName ?? '')}` : '')}</span>
      </div>
    </div>
    <footer>Atendido por: ${e(data.staffCode ?? '')} - ${e(data.staffName ?? '')}${store?.phone ? ` · Dúvidas: ${e(store.phone)}` : ''}</footer>
  </section>`;
}

export function buildWorkOrderHtml(data: WorkOrderRecord, store: PosStoreProfile | null, logo: string, kind: Kind): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${kind === 'entry' ? 'Abertura' : data.status === 'DEVOLVIDO' ? 'Devolução' : 'Entrega'} OS nº ${data.orderNumber} - ${escapeHtml(data.customerName)}</title>
<style>
  @page { size: A4 portrait; margin: 11mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 11px; }
  .page { page-break-after: always; display: flex; flex-direction: column; min-height: 272mm; }
  .page:last-child { page-break-after: auto; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #000; padding-bottom: 7px; }
  header img { height: 44px; }
  .title { flex: 1; }
  h1 { font-size: 15px; margin: 0; letter-spacing: .2px; }
  .meta { font-size: 11px; margin-top: 3px; }
  .via { border: 1.5px solid #000; border-radius: 4px; padding: 4px 8px; font-weight: bold; font-size: 11px; white-space: nowrap; }
  .store { margin: 7px 0 2px; font-size: 10.5px; line-height: 1.4; }
  h2 { font-size: 11.5px; margin: 10px 0 4px; text-transform: uppercase; background: #eee; padding: 4px 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 4px 7px; text-align: left; vertical-align: top; }
  th { width: 28%; font-weight: bold; background: #fafafa; }
  .services th { width: auto; }
  .services th:first-child, .services td:first-child { width: 14%; }
  .services .num { text-align: right; width: 14%; }
  .services tfoot td { font-weight: bold; background: #fafafa; }
  .notes { margin: 5px 0 0; }
  .check { margin: 6px 0 0; font-size: 12px; font-weight: bold; }
  .terms p { margin: 0 0 6px; text-align: justify; line-height: 1.4; }
  .signs { display: flex; gap: 28px; margin-top: auto; padding-top: 40px; }
  .sign { flex: 1; display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; }
  .sign .line { border-top: 1.5px solid #000; margin-bottom: 4px; }
  footer { margin-top: 12px; font-size: 10px; border-top: 1px solid #999; padding-top: 5px; }
</style>
</head>
<body>
  ${via(data, store, logo, 'VIA DA LOJA', kind, true)}
  ${via(data, store, logo, 'VIA DO CLIENTE', kind, false)}
</body>
</html>`;
}

export async function printWorkOrder(data: WorkOrderRecord, store: PosStoreProfile | null, kind: Kind) {
  await printHtmlDocument(buildWorkOrderHtml(data, store, new URL(logoUrl, window.location.href).href, kind));
}
