import type { OfflineSalePayload, OfflineSnapshot } from './offline';

// NFC-e sem internet pelo Comunicador Offline da Focus (programa instalado no PC da loja, com o
// certificado). O PDV envia o mesmo JSON da API da Focus para a API local; o Comunicador assina,
// gera a nota em contingencia e efetiva na Sefaz sozinho quando a internet volta. A referencia
// (ref) e a mesma consultada depois na nuvem (nfce-contingency-sync).

const PORT_KEY = 'kanguru-comunicador-port';

export function getComunicadorPort(): string | null {
  try {
    return localStorage.getItem(PORT_KEY);
  } catch {
    return null;
  }
}

export function setComunicadorPort(port: string | null) {
  try {
    if (port) localStorage.setItem(PORT_KEY, port);
    else localStorage.removeItem(PORT_KEY);
  } catch {
    // sem armazenamento: o Comunicador fica desligado neste PC
  }
}

const PAYMENT_CODES: Record<string, string> = { DINHEIRO: '01', CREDITO: '03', DEBITO: '04', CREDIARIO: '05', PIX: '17' };
const ST_CODES = new Set(['500', '60']);
const round2 = (value: number) => Math.round(value * 100) / 100;

function brasiliaNow(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 19) + '-03:00';
}

export interface LocalNfceResult {
  ok: boolean;
  message: string | null;
  nfce: Record<string, unknown> | null;
}

// Mesmas regras da Edge Function nfce-emit (CFOP, CSOSN/CST, PIS/COFINS, pagamentos).
function buildPayload(sale: OfflineSalePayload, snapshot: OfflineSnapshot): { payload: Record<string, unknown>; taxTotal: number } | string {
  const cnpj = String(snapshot.store.cnpj ?? '').replace(/\D/g, '');
  if (cnpj.length !== 14) return 'CNPJ da loja não cadastrado.';
  const products = sale.items.filter((item) => item.itemType === 'PRODUCT');
  if (products.length === 0) return 'Venda só com serviços não gera NFC-e.';
  let taxTotal = 0;
  let productsTotal = 0;
  const items = [];
  for (const [index, item] of products.entries()) {
    const product = snapshot.products.find((entry) => entry.id === item.productId);
    if (!product || !/^\d{8}$/.test(String(product.ncm ?? '').replace(/\./g, '')) || !product.icmsOrigin || !(product.csosn || product.icmsCst)) {
      return `Dados fiscais incompletos em ${item.itemName}.`;
    }
    const situation = String(product.csosn || product.icmsCst);
    const gross = round2(item.unitPrice * item.quantity);
    const lineTotal = round2(item.lineTotal);
    const itemTax = round2(lineTotal * Number(product.taxBurdenPercent ?? 0) / 100);
    taxTotal += itemTax;
    productsTotal += lineTotal;
    items.push({
      numero_item: String(index + 1),
      codigo_produto: item.itemSku || product.id,
      descricao: item.itemName.slice(0, 120),
      codigo_ncm: String(product.ncm).replace(/\./g, ''),
      cfop: ST_CODES.has(situation) ? '5405' : '5102',
      unidade_comercial: 'UN',
      quantidade_comercial: item.quantity,
      valor_unitario_comercial: item.unitPrice,
      unidade_tributavel: 'UN',
      quantidade_tributavel: item.quantity,
      valor_unitario_tributavel: item.unitPrice,
      valor_bruto: gross,
      icms_origem: product.icmsOrigin,
      icms_situacao_tributaria: situation,
      pis_situacao_tributaria: '49',
      cofins_situacao_tributaria: '49',
      valor_total_tributos: itemTax,
      ...(gross - lineTotal > 0.004 ? { valor_desconto: round2(gross - lineTotal) } : {}),
      ...(product.cest ? { cest: String(product.cest).replace(/\D/g, '') } : {}),
    });
  }
  let remaining = round2(productsTotal);
  const payments = sale.payments.flatMap((payment) => {
    const amount = round2(Math.min(remaining, payment.amount));
    remaining = round2(remaining - amount);
    if (amount <= 0) return [];
    const code = PAYMENT_CODES[payment.paymentMethod] ?? '99';
    return [{ forma_pagamento: code, valor_pagamento: amount, ...(code === '03' || code === '04' ? { tipo_integracao: '2' } : {}) }];
  });
  const cpf = String(sale.clientCpf ?? '').replace(/\D/g, '');
  return {
    taxTotal: round2(taxTotal),
    payload: {
      cnpj_emitente: cnpj,
      data_emissao: brasiliaNow(),
      natureza_operacao: 'VENDA AO CONSUMIDOR',
      presenca_comprador: '1',
      modalidade_frete: '9',
      local_destino: '1',
      indicador_inscricao_estadual_destinatario: '9',
      items,
      formas_pagamento: payments,
      ...(cpf.length === 11 ? { cpf_destinatario: cpf, ...(sale.clientName ? { nome_destinatario: sale.clientName.slice(0, 60) } : {}) } : {}),
    },
  };
}

export async function emitLocalNfce(sale: OfflineSalePayload, snapshot: OfflineSnapshot): Promise<LocalNfceResult> {
  const port = getComunicadorPort();
  if (!port) return { ok: false, message: 'Comunicador Offline não configurado neste computador.', nfce: null };
  const built = buildPayload(sale, snapshot);
  if (typeof built === 'string') return { ok: false, message: built, nfce: null };
  const ref = `${sale.saleId}-1`;
  try {
    const response = await fetch(`http://localhost:${port}/v2/fiscal/nfce?ref=${encodeURIComponent(ref)}&tipo_contingencia=offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(built.payload),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const status = String(body.status ?? '');
    if (!response.ok || (status && status !== 'autorizado' && body.contingencia_offline !== true)) {
      return { ok: false, message: String(body.mensagem_sefaz ?? body.mensagem ?? `Comunicador respondeu ${response.status}.`), nfce: null };
    }
    return {
      ok: true,
      message: null,
      nfce: {
        ref,
        environment: snapshot.nfce?.environment ?? 'homologacao',
        number: body.numero != null ? String(body.numero) : null,
        series: body.serie != null ? String(body.serie) : null,
        key: body.chave_nfe ?? null,
        protocol: body.protocolo ?? null,
        qrcodeUrl: body.qrcode_url ?? null,
        consultUrl: body.url_consulta_nf ?? null,
        taxTotal: built.taxTotal,
      },
    };
  } catch {
    return { ok: false, message: 'Comunicador Offline não respondeu. Confira se ele está aberto e a porta configurada.', nfce: null };
  }
}
