import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Emite a NFC-e de uma venda do PDV pela Focus NFe (2.8b).
// Quem chama: o PDV, com a sessao do terminal. A chave da Focus fica em store_fiscal_settings
// e so e lida aqui (service role); nunca volta para o PDV nem aparece em log.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const FOCUS_HOSTS: Record<string, string> = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
};

// Formas de pagamento da NFC-e (tabela da Sefaz).
const PAYMENT_CODES: Record<string, string> = {
  DINHEIRO: '01',
  CREDITO: '03',
  DEBITO: '04',
  CREDIARIO: '05',
  VOUCHER: '10',
  PIX: '17',
};

// CSOSN/CST com ICMS ja recolhido por substituicao tributaria: CFOP 5405; demais 5102.
const ST_CODES = new Set(['500', '60']);

type SaleItem = {
  itemType?: string;
  productId?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  itemSku?: string;
  itemName?: string;
};

type Product = {
  id: string;
  name: string;
  ncm: string | null;
  cest: string | null;
  icms_origin: string | null;
  icms_cst: string | null;
  csosn: string | null;
  icms_rate: number | null;
  tax_burden_percent: number | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

// Horario de Brasilia (sem horario de verao): a Sefaz aceita no maximo 5 min de diferenca.
function brasiliaNow(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 19) + '-03:00';
}

function focusUrl(host: string, path: string | null | undefined): string | null {
  if (!path) return null;
  return /^https?:\/\//i.test(path) ? path : `${host}${path.startsWith('/') ? '' : '/'}${path}`;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Autenticação obrigatória.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('Configuração de ambiente ausente para NFC-e.');
    return json({ error: 'Serviço de NFC-e indisponível.' }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const db = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: 'Sessão inválida ou expirada.' }, 401);

  // Sessao de terminal do PDV (mesmo padrao das RPCs do PDV).
  const { data: terminal } = await db
    .from('pos_terminals')
    .select('id, tenant_id, unit_id')
    .eq('device_auth_uid', userData.user.id)
    .eq('is_active', true)
    .maybeSingle();
  if (!terminal) return json({ error: 'Sessão de terminal ativa obrigatória.' }, 403);

  let saleId = '';
  try {
    saleId = String((await request.json())?.saleId ?? '').trim();
  } catch {
    // corpo invalido: tratado abaixo
  }
  if (!saleId) return json({ error: 'Venda não informada.' }, 400);

  const { data: sale } = await db
    .from('sales')
    .select('id, tenant_id, unit_id, items, gross_amount, payment_method, status, client_cpf, client_name, reservation_deposit_applied, fiscal_status, nfce_ref, nfce_environment')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .eq('id', saleId)
    .maybeSingle();
  if (!sale) return json({ error: 'Venda não encontrada nesta loja.' }, 404);
  if (sale.fiscal_status === 'AUTORIZADA') return json({ status: 'AUTORIZADA' });
  if (sale.fiscal_status === 'CANCELADA') return json({ error: 'A NFC-e desta venda foi cancelada.' }, 409);
  if (sale.status !== 'CONCLUIDA') return json({ error: 'Só vendas concluídas geram NFC-e.' }, 409);

  const { data: setting } = await db
    .from('store_fiscal_settings')
    .select('focus_token, environment')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .maybeSingle();
  if (!setting) return json({ error: 'NFC-e não configurada para esta loja.' }, 409);

  const { data: store } = await db
    .from('store_configs')
    .select('cnpj')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .maybeSingle();
  const cnpj = String(store?.cnpj ?? '').replace(/\D/g, '');
  if (cnpj.length !== 14) return json({ error: 'CNPJ da loja não cadastrado no ERP.' }, 409);

  // Servicos nao entram na NFC-e (ISS); a nota sai so com os produtos.
  const items = ((sale.items ?? []) as SaleItem[]).filter((item) => (item.itemType ?? 'PRODUCT').toUpperCase() === 'PRODUCT');
  if (items.length === 0) return json({ error: 'Venda só com serviços não gera NFC-e.' }, 409);

  const productIds = Array.from(new Set(items.map((item) => String(item.productId))));
  const { data: products } = await db
    .from('products')
    .select('id, name, ncm, cest, icms_origin, icms_cst, csosn, icms_rate, tax_burden_percent')
    .eq('tenant_id', terminal.tenant_id)
    .in('id', productIds);
  const productMap = new Map(((products ?? []) as Product[]).map((product) => [product.id, product]));

  const missing = productIds
    .map((id) => productMap.get(id))
    .filter((product): product is Product => !product || !/^\d{8}$/.test(String(product.ncm ?? '').replace(/\./g, '')) || !product.icms_origin || !(product.csosn || product.icms_cst))
    .map((product) => product?.name ?? 'produto removido');
  if (missing.length > 0 || productMap.size < productIds.length) {
    return json({ error: `Dados fiscais incompletos (NCM, origem, CSOSN/CST) em: ${missing.join(', ')}. Corrija no ERP.` }, 422);
  }

  let taxTotal = 0;
  let productsTotal = 0;
  const focusItems = items.map((item, index) => {
    const product = productMap.get(String(item.productId))!;
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    const gross = round2(unitPrice * quantity);
    const lineTotal = round2(Number(item.lineTotal));
    const situation = product.csosn || product.icms_cst!;
    const itemTax = round2(lineTotal * Number(product.tax_burden_percent ?? 0) / 100);
    taxTotal += itemTax;
    productsTotal += lineTotal;
    const focusItem: Record<string, unknown> = {
      numero_item: String(index + 1),
      codigo_produto: item.itemSku || product.id,
      descricao: (item.itemName || product.name).slice(0, 120),
      codigo_ncm: String(product.ncm).replace(/\./g, ''),
      cfop: ST_CODES.has(situation) ? '5405' : '5102',
      unidade_comercial: 'UN',
      quantidade_comercial: quantity,
      valor_unitario_comercial: unitPrice,
      unidade_tributavel: 'UN',
      quantidade_tributavel: quantity,
      valor_unitario_tributavel: unitPrice,
      valor_bruto: gross,
      icms_origem: product.icms_origin,
      icms_situacao_tributaria: situation,
      pis_situacao_tributaria: '49',
      cofins_situacao_tributaria: '49',
      valor_total_tributos: itemTax,
    };
    if (gross - lineTotal > 0.004) focusItem.valor_desconto = round2(gross - lineTotal);
    if (product.cest) focusItem.cest = String(product.cest).replace(/\D/g, '');
    // Regime normal com ICMS proprio (CST 00/20): base = valor do item.
    if (!product.csosn && ['00', '20'].includes(String(product.icms_cst))) {
      const rate = Number(product.icms_rate ?? 0);
      focusItem.icms_modalidade_base_calculo = '3';
      focusItem.icms_base_calculo = lineTotal;
      focusItem.icms_aliquota = rate;
      focusItem.icms_valor = round2(lineTotal * rate / 100);
    }
    return focusItem;
  });
  productsTotal = round2(productsTotal);

  // Pagamentos: linhas da venda (ou metodo legado) + sinal da reserva. Com servico na venda,
  // a nota cobre so o valor dos produtos (corta o excedente das ultimas formas).
  const { data: paymentRows } = await db
    .from('sale_payments')
    .select('payment_method, amount, created_at')
    .eq('tenant_id', terminal.tenant_id)
    .eq('sale_id', sale.id)
    .order('created_at');
  const payments: { method: string; amount: number }[] = [];
  const deposit = Number(sale.reservation_deposit_applied ?? 0);
  if (deposit > 0) {
    const { data: reservation } = await db
      .from('product_reservations')
      .select('deposit_payment_method')
      .eq('tenant_id', terminal.tenant_id)
      .eq('sale_id', sale.id)
      .maybeSingle();
    payments.push({ method: reservation?.deposit_payment_method ?? 'DINHEIRO', amount: deposit });
  }
  if ((paymentRows ?? []).length > 0) {
    for (const row of paymentRows!) payments.push({ method: row.payment_method, amount: Number(row.amount) });
  } else {
    const rest = round2(Number(sale.gross_amount) - deposit);
    if (rest > 0) payments.push({ method: sale.payment_method, amount: rest });
  }
  let remaining = productsTotal;
  const focusPayments = payments.flatMap((payment) => {
    const amount = round2(Math.min(remaining, payment.amount));
    remaining = round2(remaining - amount);
    if (amount <= 0) return [];
    const code = PAYMENT_CODES[String(payment.method).toUpperCase()] ?? '99';
    return [{
      forma_pagamento: code,
      valor_pagamento: amount,
      ...(code === '03' || code === '04' ? { tipo_integracao: '2' } : {}),
    }];
  });
  if (remaining > 0.009 || focusPayments.length === 0) {
    return json({ error: 'As formas de pagamento não cobrem o valor dos produtos.' }, 422);
  }

  const host = FOCUS_HOSTS[setting.environment];
  const auth = 'Basic ' + btoa(`${setting.focus_token}:`);
  const logEvent = (action: string, ref: string, httpStatus: number | null, resultStatus: string | null, message: string | null) =>
    db.from('sale_fiscal_events').insert({
      tenant_id: terminal.tenant_id, unit_id: terminal.unit_id, sale_id: sale.id, action,
      nfce_ref: ref, environment: setting.environment, http_status: httpStatus,
      result_status: resultStatus, message: message?.slice(0, 1000) ?? null,
    });

  // Grava o resultado da Focus na venda.
  async function saveResult(ref: string, body: Record<string, unknown>) {
    const status = String(body.status ?? '');
    if (status === 'autorizado') {
      await db.from('sales').update({
        fiscal_type: 'NFCE', fiscal_status: 'AUTORIZADA', nfce_ref: ref, nfce_environment: setting!.environment,
        nfce_number: body.numero != null ? String(body.numero) : null,
        nfce_series: body.serie != null ? String(body.serie) : null,
        nfce_key: body.chave_nfe ?? null,
        nfce_protocol: (body.protocolo as string | undefined) ?? null,
        nfce_qrcode_url: body.qrcode_url ?? null,
        nfce_consult_url: body.url_consulta_nf ?? null,
        nfce_xml_url: focusUrl(host, body.caminho_xml_nota_fiscal as string),
        nfce_danfe_url: focusUrl(host, body.caminho_danfe as string),
        nfce_message: body.mensagem_sefaz ?? null,
        nfce_authorized_at: new Date().toISOString(),
        nfce_tax_total: round2(taxTotal),
      }).eq('tenant_id', terminal!.tenant_id).eq('id', sale!.id);
      return json({ status: 'AUTORIZADA', number: body.numero ?? null });
    }
    const message = String(body.mensagem_sefaz ?? body.mensagem ?? 'NFC-e não autorizada pela Sefaz.');
    await db.from('sales').update({
      fiscal_type: 'NFCE', fiscal_status: 'ERRO', nfce_ref: ref, nfce_environment: setting!.environment, nfce_message: message,
    }).eq('tenant_id', terminal!.tenant_id).eq('id', sale!.id);
    return json({ status: 'ERRO', message });
  }

  // Envio anterior sem resposta (queda de conexao): consulta antes de reenviar.
  if (sale.fiscal_status === 'PENDENTE' && sale.nfce_ref && sale.nfce_environment === setting.environment) {
    try {
      const response = await fetch(`${host}/v2/nfce/${encodeURIComponent(sale.nfce_ref)}?completa=1`, { headers: { Authorization: auth } });
      if (response.ok) {
        const body = await response.json();
        await logEvent('CONSULTAR', sale.nfce_ref, response.status, String(body.status ?? ''), body.mensagem_sefaz ?? null);
        if (body.status === 'autorizado') {
          body.protocolo = body.protocolo_nota_fiscal?.numero_protocolo ?? body.protocolo;
          return await saveResult(sale.nfce_ref, body);
        }
        // Ainda em processamento: reenviar agora poderia gerar duas notas.
        if (body.status !== 'erro_autorizacao' && body.status !== 'denegado') {
          return json({ status: 'PENDENTE', message: 'A NFC-e ainda está em processamento. Tente novamente em instantes.' });
        }
      } else if (response.status !== 404) {
        return json({ status: 'PENDENTE', message: 'Não foi possível consultar a NFC-e anterior. Tente novamente em instantes.' });
      }
    } catch {
      return json({ status: 'PENDENTE', message: 'Sem conexão com a Focus. Tente novamente em instantes.' });
    }
  }

  // Cada tentativa nova usa uma referencia nova (uma recusada nao pode ser reaproveitada).
  const { count } = await db
    .from('sale_fiscal_events')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', terminal.tenant_id)
    .eq('sale_id', sale.id)
    .eq('action', 'EMITIR');
  const ref = `${sale.id}-${(count ?? 0) + 1}`;

  await db.from('sales').update({
    fiscal_type: 'NFCE', fiscal_status: 'PENDENTE', nfce_ref: ref, nfce_environment: setting.environment, nfce_message: null,
  }).eq('tenant_id', terminal.tenant_id).eq('id', sale.id);

  const clientCpf = String(sale.client_cpf ?? '').replace(/\D/g, '');
  const payload: Record<string, unknown> = {
    cnpj_emitente: cnpj,
    data_emissao: brasiliaNow(),
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    presenca_comprador: '1',
    modalidade_frete: '9',
    local_destino: '1',
    indicador_inscricao_estadual_destinatario: '9',
    items: focusItems,
    formas_pagamento: focusPayments,
  };
  if (clientCpf.length === 11) {
    payload.cpf_destinatario = clientCpf;
    if (sale.client_name) payload.nome_destinatario = String(sale.client_name).slice(0, 60);
  }

  let response: Response;
  try {
    response = await fetch(`${host}/v2/nfce?ref=${encodeURIComponent(ref)}&completa=1`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    await logEvent('EMITIR', ref, null, 'SEM_CONEXAO', null);
    return json({ status: 'PENDENTE', message: 'Sem conexão com a Focus. A venda ficou com NFC-e pendente.' });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    // resposta sem JSON (ex.: 401 em HTML)
  }
  await logEvent('EMITIR', ref, response.status, String(body.status ?? body.codigo ?? ''), String(body.mensagem_sefaz ?? body.mensagem ?? ''));

  if (response.status === 401) {
    await db.from('sales').update({ fiscal_status: 'ERRO', nfce_message: 'Chave da Focus recusada.' })
      .eq('tenant_id', terminal.tenant_id).eq('id', sale.id);
    return json({ status: 'ERRO', message: 'Chave da Focus recusada. Confira a configuração no UCP.' });
  }
  if (response.status >= 500 || body.codigo === 'pending_operation') {
    return json({ status: 'PENDENTE', message: 'A Focus/Sefaz não respondeu. A venda ficou com NFC-e pendente.' });
  }
  const protocol = (body.protocolo_nota_fiscal as Record<string, unknown> | undefined)?.numero_protocolo;
  if (protocol) body.protocolo = protocol;
  return await saveResult(ref, body);
});
