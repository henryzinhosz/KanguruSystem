import { invoke, isTauri } from '@tauri-apps/api/core';
import type { PosSaleReceipt } from '../services/supabase/sales';
import type { PosStoreProfile } from '../services/supabase/terminal';
import { formatReceiptNumber, instagramUrl } from '../app/receiptPrint';
import logoUrl from '../assets/beb-games-logo.png';
import { COLUMNS, EscPos, imageToBits } from './escpos';

// Impressao direta na termica (2.8c): a impressora e escolhida pelo nome do Windows em cada PC
// (Menu › Configuracoes › Impressora). Sem impressora escolhida, ou se falhar, o PDV usa a
// janela de impressao do Windows (modo antigo).

const PRINTER_KEY = 'kanguru-direct-printer';
const RECEIPT_FOOTER = 'TROCA APENAS NO ENDEREÇO ACIMA E COM APRESENTAÇÃO DO CUPOM E CPF.';

const PAYMENT_LABELS: Record<string, string> = {
  DINHEIRO: 'DINHEIRO', PIX: 'PIX', CREDITO: 'CARTÃO DE CRÉDITO', DEBITO: 'CARTÃO DE DÉBITO',
  VOUCHER: 'VALE-TROCA', CREDIARIO: 'CREDIÁRIO', SINAL: 'SINAL DA RESERVA',
};

const money = (value: number) => value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function getDirectPrinter(): string | null {
  try {
    return isTauri() ? localStorage.getItem(PRINTER_KEY) : null;
  } catch {
    return null;
  }
}

export function setDirectPrinter(name: string | null) {
  try {
    if (name) localStorage.setItem(PRINTER_KEY, name);
    else localStorage.removeItem(PRINTER_KEY);
  } catch {
    // sem armazenamento: continua no modo da janela do Windows
  }
}

export async function listPrinters(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('list_printers');
}

async function send(printer: string, bytes: number[]) {
  await invoke('print_raw', { printer, data: bytes });
}

export async function openCashDrawer(): Promise<boolean> {
  const printer = getDirectPrinter();
  if (!printer) return false;
  try {
    await send(printer, new EscPos().drawer().build());
    return true;
  } catch {
    return false;
  }
}

export async function printTestPage(printer: string) {
  const doc = new EscPos().align('center').bold(true).size(2, 2).line('KANGURU PDV').size(1, 1).bold(false)
    .line('Teste de impressão direta').line('Acentos: ação, órgão, é, ê, ç, ã, õ')
    .line(new Date().toLocaleString('pt-BR')).feed(3).cut();
  await send(printer, doc.build());
}

let logoCache: Promise<{ bits: Uint8Array; width: number; height: number } | null> | null = null;
function logoBits() {
  if (!logoCache) logoCache = imageToBits(new URL(logoUrl, window.location.href).href, 384);
  return logoCache;
}

function formatCpf(value: string | null): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length === 11 ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}` : '999.999.999-99';
}

function formatCnpj(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 14 ? `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}` : value;
}

async function header(doc: EscPos, store: PosStoreProfile | null, legal: boolean) {
  const logo = await logoBits();
  doc.align('center');
  if (logo) doc.image(logo.bits, logo.width, logo.height).line();
  doc.bold(true).line((legal ? store?.legalName || store?.tradeName : store?.tradeName || store?.legalName || '')?.toUpperCase() ?? '').bold(false);
  if (store?.cnpj || store?.stateRegistration) {
    doc.line(`${store?.cnpj ? `CNPJ: ${formatCnpj(store.cnpj)}` : ''}${store?.stateRegistration ? `  IE: ${store.stateRegistration}` : ''}`);
  }
  if (store?.address) doc.wrap(store.address.toUpperCase());
  if (store?.phone) doc.line(`Telefone: ${store.phone.replace(/\s+/g, '')}`);
}

// Cupom Nao Fiscal (DAV), mesmo conteudo do cupom impresso pela janela do Windows.
async function buildDav(receipt: PosSaleReceipt, store: PosStoreProfile | null, changeAmount: number): Promise<number[]> {
  const doc = new EscPos();
  await header(doc, store, false);
  doc.bold(true).line('DAV - DOCUMENTO AUXILIAR DE VENDA').bold(false).align('left').rule();
  doc.pair('Seq. Descrição Produto', 'Total').line('  Qtd.   Preço').rule();
  const items = receipt.items.filter((item) => item.quantity > 0);
  items.forEach((item, index) => {
    doc.pair(`${String(index + 1).padStart(3, '0')} ${item.itemName.toUpperCase()}`, money(item.lineTotal));
    doc.line(`  ${money(item.quantity)} x R$ ${money(item.unitPrice)}${item.discountPercent > 0 ? ` (desc. ${money(item.discountPercent)}%)` : ''}`);
    if (item.serials.length) doc.line(`  S/N ${item.serials.join(', ')}`);
  });
  const listTotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const discount = Math.max(0, Math.round((listTotal - receipt.grossAmount) * 100) / 100);
  const toPay = Math.max(0, Math.round((receipt.grossAmount - receipt.depositApplied) * 100) / 100);
  const payments = receipt.payments.length > 0 ? receipt.payments : toPay > 0 ? [{ paymentMethod: receipt.paymentMethod, amount: toPay }] : [];
  doc.line().pair('Quantidade total de Itens', String(items.reduce((sum, item) => sum + item.quantity, 0)).padStart(3, '0'));
  doc.pair('Valor Total R$', money(listTotal));
  if (discount > 0) doc.pair('Desconto R$', `-${money(discount)}`);
  if (receipt.depositApplied > 0) doc.pair('Sinal da reserva R$', `-${money(receipt.depositApplied)}`);
  doc.bold(true).pair('Valor a Pagar R$', money(toPay)).bold(false);
  doc.line().line('Forma Pagamento');
  payments.forEach((payment) => doc.pair(`  ${PAYMENT_LABELS[payment.paymentMethod] ?? payment.paymentMethod}`, money(payment.amount)));
  doc.rule().align('center').bold(true).line(`Total Pago : ${money(payments.reduce((sum, item) => sum + item.amount, 0))}`).bold(false);
  if (changeAmount > 0) doc.line(`Troco : ${money(changeAmount)}`);
  const issued = new Date(receipt.timestamp);
  doc.align('left').line().pair(`Cupom : ${formatReceiptNumber(receipt.receiptNumber)}`, `Data : ${issued.toLocaleDateString('pt-BR')}`);
  if (receipt.sellerName) doc.line(`Vendedor : ${receipt.sellerName.toUpperCase()}`);
  doc.line().line(receipt.clientName ? receipt.clientName.toUpperCase() : 'CONSUMIDOR').line(`CPF : ${formatCpf(receipt.clientCpf)}`);
  const link = instagramUrl(store?.instagram);
  if (link) doc.align('center').line().qr(link, 6).line();
  doc.align('left').line().wrap(RECEIPT_FOOTER).line();
  doc.line(`Emissão : ${issued.toLocaleDateString('pt-BR')} ${issued.toLocaleTimeString('pt-BR')}`);
  return doc.feed(4).cut().build();
}

// DANFE NFC-e no modelo do cupom fiscal (mesmas regras do impresso pela janela do Windows).
async function buildNfce(receipt: PosSaleReceipt, store: PosStoreProfile | null, changeAmount: number): Promise<number[]> {
  const nfce = receipt.nfce!;
  const contingency = nfce.contingency === true && nfce.contingencyDone !== true;
  const items = receipt.items.filter((item) => item.quantity > 0 && item.itemType === 'PRODUCT');
  const listTotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const productsTotal = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
  const discount = Math.max(0, Math.round((listTotal - productsTotal) * 100) / 100);
  const taxTotal = nfce.taxTotal ?? 0;
  const source = [
    ...(receipt.depositApplied > 0 ? [{ paymentMethod: 'SINAL', amount: receipt.depositApplied }] : []),
    ...(receipt.payments.length > 0 ? receipt.payments : [{ paymentMethod: receipt.paymentMethod, amount: Math.max(0, receipt.grossAmount - receipt.depositApplied) }]),
  ];
  let remaining = productsTotal;
  const payments = source.flatMap((payment) => {
    const amount = Math.round(Math.min(remaining, payment.amount) * 100) / 100;
    remaining = Math.round((remaining - amount) * 100) / 100;
    return amount > 0 ? [{ ...payment, amount }] : [];
  });
  const issued = new Date(receipt.timestamp);
  const authorized = nfce.authorizedAt ? new Date(nfce.authorizedAt) : issued;
  const cpf = (receipt.clientCpf ?? '').replace(/\D/g, '');
  const key = (nfce.key ?? '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');

  const doc = new EscPos();
  const via = async (label: string) => {
    await header(doc, store, true);
    doc.bold(true).line('DOCUMENTO AUXILIAR DA NOTA FISCAL').line('DE CONSUMIDOR ELETRÔNICA').bold(false);
    if (nfce.environment === 'homologacao') doc.line('EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO').line('SEM VALOR FISCAL');
    if (contingency) doc.bold(true).line('EMITIDA EM CONTINGÊNCIA').line('Pendente de autorização').bold(false);
    doc.align('left').rule().line('#|COD|DESC|QTD|UN|VL UN R$|(VLTR R$)*|VL ITEM');
    items.forEach((item, index) => {
      const itemTax = productsTotal > 0 ? Math.round((taxTotal * item.lineTotal / productsTotal) * 100) / 100 : 0;
      doc.line(`${String(index + 1).padStart(3, '0')} ${item.itemSku} ${item.itemName.toUpperCase()}`.slice(0, COLUMNS));
      doc.pair(`   ${item.quantity.toLocaleString('pt-BR', { minimumFractionDigits: 3 })} UN X ${money(item.unitPrice)}(${money(itemTax)})`, money(item.lineTotal));
      if (item.serials.length) doc.line(`   S/N ${item.serials.join(', ')}`);
    });
    doc.rule().bold(true);
    doc.pair('QTD. TOTAL DE ITENS', String(items.length).padStart(3, '0'));
    doc.pair('SUBTOTAL', money(listTotal)).pair('DESCONTOS', money(discount));
    doc.pair('VALOR TOTAL R$', money(productsTotal)).pair('FORMA DE PAGAMENTO', 'Valor Pago').bold(false);
    payments.forEach((payment) => doc.pair(PAYMENT_LABELS[payment.paymentMethod] ?? payment.paymentMethod, money(payment.amount)));
    if (changeAmount > 0) doc.pair('Troco', money(changeAmount));
    doc.align('center').line().line('Consulte pela Chave de Acesso em').line((nfce.consultUrl ?? '').replace(/^https?:\/\//i, ''));
    doc.bold(true).line(key).bold(false).line();
    if (nfce.qrcodeUrl) doc.qr(nfce.qrcodeUrl, 4).line();
    doc.bold(true).line(`Número ${String(nfce.number ?? '').padStart(9, '0')} - Série ${String(nfce.series ?? '').padStart(3, '0')}`).bold(false);
    doc.line(`Emissão ${issued.toLocaleDateString('pt-BR')} ${issued.toLocaleTimeString('pt-BR')}`).line(label);
    doc.line(`Protocolo de Autorização ${nfce.protocol ?? ''}`);
    doc.line(`Data de Autorização ${authorized.toLocaleDateString('pt-BR')} ${authorized.toLocaleTimeString('pt-BR')}`);
    doc.line(cpf.length === 11 ? `CONSUMIDOR CPF: ${formatCpf(cpf)}` : 'CONSUMIDOR NÃO IDENTIFICADO');
    if (cpf.length === 11 && receipt.clientName) doc.line(receipt.clientName.toUpperCase());
    doc.line().wrap(`*Tributos Totais Incidentes (Lei Federal 12.741/2012): R$ ${money(taxTotal)}`);
    doc.align('left').line().pair(`Cupom: ${formatReceiptNumber(receipt.receiptNumber)}`, receipt.sellerName ? `Vendedor: ${receipt.sellerName.toUpperCase()}` : '');
    doc.wrap(RECEIPT_FOOTER).feed(4).cut();
  };
  await via('Via Consumidor');
  if (contingency) await via('Via Estabelecimento');
  return doc.build();
}

// Tenta imprimir direto; devolve false se nao ha impressora escolhida ou se falhou
// (quem chama usa a janela do Windows).
export async function printReceiptDirect(receipt: PosSaleReceipt, store: PosStoreProfile | null, changeAmount: number): Promise<boolean> {
  const printer = getDirectPrinter();
  if (!printer) return false;
  try {
    const bytes = receipt.fiscalStatus === 'AUTORIZADA' && receipt.nfce
      ? await buildNfce(receipt, store, changeAmount)
      : await buildDav(receipt, store, changeAmount);
    await send(printer, bytes);
    return true;
  } catch (error) {
    console.error('[impressao direta] falhou, usando a janela do Windows', error);
    return false;
  }
}
