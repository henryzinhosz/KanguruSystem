import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Emite a NF-e de devolucao (entrada, finalidade 4, CFOP 1202) de uma troca/devolucao cuja
// venda teve NFC-e autorizada (2.9). Quem chama: o PDV, com a sessao do terminal, logo apos
// registrar a devolucao (ou para tentar de novo). A NF-e na Focus e assincrona: envia e
// consulta algumas vezes; se ainda estiver processando, fica PENDENTE para consultar depois.

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

const RETURN_CFOP = '1202';
const round2 = (value: number) => Math.round(value * 100) / 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function brasiliaNow(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 19) + '-03:00';
}

function focusUrl(host: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
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
    console.error('Configuração de ambiente ausente para NF-e.');
    return json({ error: 'Serviço de NF-e indisponível.' }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const db = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: 'Sessão inválida ou expirada.' }, 401);

  const { data: terminal } = await db
    .from('pos_terminals')
    .select('id, tenant_id, unit_id')
    .eq('device_auth_uid', userData.user.id)
    .eq('is_active', true)
    .maybeSingle();
  if (!terminal) return json({ error: 'Sessão de terminal ativa obrigatória.' }, 403);

  let returnId = '';
  try {
    returnId = String((await request.json())?.returnId ?? '').trim();
  } catch {
    // corpo invalido
  }
  if (!returnId) return json({ error: 'Devolução não informada.' }, 400);

  const { data: saleReturn } = await db
    .from('sale_returns')
    .select('id, tenant_id, unit_id, sale_id, return_number, customer_cpf, fiscal_status, nfe_ref, nfe_environment')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .eq('id', returnId)
    .maybeSingle();
  if (!saleReturn) return json({ error: 'Devolução não encontrada nesta loja.' }, 404);
  if (saleReturn.fiscal_status === 'AUTORIZADA') return json({ status: 'AUTORIZADA' });
  if (!saleReturn.fiscal_status) return json({ error: 'Esta devolução não precisa de nota fiscal.' }, 409);

  const { data: setting } = await db
    .from('store_fiscal_settings')
    .select('focus_token, environment')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .maybeSingle();
  if (!setting) return json({ error: 'Nota fiscal não configurada para esta loja.' }, 409);
  const host = FOCUS_HOSTS[setting.environment];
  const auth = 'Basic ' + btoa(`${setting.focus_token}:`);

  const logEvent = (action: string, ref: string, httpStatus: number | null, resultStatus: string | null, message: string | null) =>
    db.from('sale_fiscal_events').insert({
      tenant_id: terminal.tenant_id, unit_id: terminal.unit_id, sale_id: saleReturn.sale_id, action,
      nfce_ref: ref, environment: setting.environment, http_status: httpStatus,
      result_status: resultStatus, message: message?.slice(0, 1000) ?? null,
    });

  async function save(ref: string, body: Record<string, unknown>) {
    const status = String(body.status ?? '');
    if (status === 'autorizado') {
      await db.from('sale_returns').update({
        fiscal_status: 'AUTORIZADA', nfe_ref: ref, nfe_environment: setting!.environment,
        nfe_number: body.numero != null ? String(body.numero) : null,
        nfe_series: body.serie != null ? String(body.serie) : null,
        nfe_key: body.chave_nfe ?? null,
        nfe_protocol: (body.protocolo as string | undefined) ?? null,
        nfe_xml_url: focusUrl(host, body.caminho_xml_nota_fiscal),
        nfe_danfe_url: focusUrl(host, body.caminho_danfe),
        nfe_message: body.mensagem_sefaz ?? null,
        nfe_authorized_at: new Date().toISOString(),
      }).eq('id', saleReturn!.id);
      return json({ status: 'AUTORIZADA', number: body.numero ?? null });
    }
    if (status === 'processando_autorizacao') {
      await db.from('sale_returns').update({ fiscal_status: 'PENDENTE', nfe_ref: ref, nfe_environment: setting!.environment, nfe_message: null })
        .eq('id', saleReturn!.id);
      return json({ status: 'PENDENTE', message: 'A NF-e de devolução ainda está em processamento na Sefaz. Consulte de novo em instantes.' });
    }
    const errors = Array.isArray(body.erros) ? (body.erros as Array<Record<string, unknown>>).map((item) => item.mensagem).join('; ') : '';
    const message = String(body.mensagem_sefaz ?? body.mensagem ?? errors ?? 'NF-e de devolução não autorizada.') || 'NF-e de devolução não autorizada.';
    await db.from('sale_returns').update({ fiscal_status: 'ERRO', nfe_ref: ref, nfe_environment: setting!.environment, nfe_message: message })
      .eq('id', saleReturn!.id);
    return json({ status: 'ERRO', message });
  }

  // Consulta a NF-e ja enviada (ate ~10 s), protocolo incluido.
  async function poll(ref: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep(2000);
      try {
        const response = await fetch(`${host}/v2/nfe/${encodeURIComponent(ref)}?completa=1`, { headers: { Authorization: auth } });
        if (!response.ok) continue;
        const body = await response.json();
        if (body.status === 'processando_autorizacao') continue;
        body.protocolo = body.protocolo_nota_fiscal?.numero_protocolo ?? body.protocolo;
        await logEvent('CONSULTAR', ref, response.status, String(body.status ?? ''), body.mensagem_sefaz ?? null);
        return await save(ref, body);
      } catch {
        // tenta de novo
      }
    }
    return await save(ref, { status: 'processando_autorizacao' });
  }

  // Ja enviada e pendente: so consulta (reenviar poderia gerar duas notas).
  if (saleReturn.fiscal_status === 'PENDENTE' && saleReturn.nfe_ref && saleReturn.nfe_environment === setting.environment) {
    const response = await fetch(`${host}/v2/nfe/${encodeURIComponent(saleReturn.nfe_ref)}?completa=1`, { headers: { Authorization: auth } }).catch(() => null);
    if (response?.ok) {
      const body = await response.json();
      if (body.status === 'processando_autorizacao') return await poll(saleReturn.nfe_ref);
      if (body.status === 'autorizado') {
        body.protocolo = body.protocolo_nota_fiscal?.numero_protocolo ?? body.protocolo;
        return await save(saleReturn.nfe_ref, body);
      }
    } else if (response && response.status !== 404) {
      return json({ status: 'PENDENTE', message: 'Não foi possível consultar a NF-e anterior. Tente de novo em instantes.' });
    } else if (!response) {
      return json({ status: 'PENDENTE', message: 'Sem conexão com a Focus. Tente de novo em instantes.' });
    }
  }

  const { data: sale } = await db
    .from('sales')
    .select('id, nfce_key, fiscal_status')
    .eq('tenant_id', terminal.tenant_id)
    .eq('id', saleReturn.sale_id)
    .maybeSingle();
  const nfceKey = String(sale?.nfce_key ?? '').replace(/\D/g, '');
  if (nfceKey.length !== 44) return json({ error: 'Chave da NFC-e original não encontrada.' }, 409);

  const { data: store } = await db
    .from('store_configs')
    .select('cnpj')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .maybeSingle();
  const cnpj = String(store?.cnpj ?? '').replace(/\D/g, '');
  if (cnpj.length !== 14) return json({ error: 'CNPJ da loja não cadastrado no ERP.' }, 409);

  const { data: customer } = await db
    .from('customers')
    .select('name, cpf, phone, cep, address, address_number, complement, district, city, state')
    .eq('tenant_id', terminal.tenant_id)
    .eq('cpf', saleReturn.customer_cpf ?? '')
    .maybeSingle();
  if (!customer || !customer.address || !customer.address_number || !customer.district || !customer.city || !customer.state || !customer.cep) {
    return json({ error: 'Cadastro do cliente sem endereço completo (obrigatório na NF-e de devolução).' }, 422);
  }

  const { data: items } = await db
    .from('sale_return_items')
    .select('product_id, item_name, item_sku, quantity, unit_amount, line_amount, item_index')
    .eq('return_id', saleReturn.id)
    .order('item_index');
  const productIds = Array.from(new Set((items ?? []).map((item) => item.product_id)));
  const { data: products } = await db
    .from('products')
    .select('id, name, ncm, cest, icms_origin, icms_cst, csosn')
    .eq('tenant_id', terminal.tenant_id)
    .in('id', productIds);
  const productMap = new Map((products ?? []).map((product) => [product.id, product]));

  const focusItems = (items ?? []).map((item, index) => {
    const product = productMap.get(item.product_id);
    const quantity = Number(item.quantity);
    const lineAmount = round2(Number(item.line_amount));
    const focusItem: Record<string, unknown> = {
      numero_item: String(index + 1),
      codigo_produto: item.item_sku || item.product_id,
      descricao: String(item.item_name || product?.name || '').slice(0, 120),
      codigo_ncm: String(product?.ncm ?? '').replace(/\./g, ''),
      cfop: RETURN_CFOP,
      unidade_comercial: 'UN',
      quantidade_comercial: quantity,
      valor_unitario_comercial: round2(lineAmount / quantity),
      unidade_tributavel: 'UN',
      quantidade_tributavel: quantity,
      valor_unitario_tributavel: round2(lineAmount / quantity),
      valor_bruto: lineAmount,
      icms_origem: product?.icms_origin ?? '0',
      icms_situacao_tributaria: product?.csosn || product?.icms_cst || '102',
      pis_situacao_tributaria: '99',
      cofins_situacao_tributaria: '99',
    };
    if (product?.cest) focusItem.cest = String(product.cest).replace(/\D/g, '');
    return focusItem;
  });
  if (focusItems.length === 0) return json({ error: 'Devolução sem itens.' }, 409);

  const { count } = await db
    .from('sale_fiscal_events')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', terminal.tenant_id)
    .eq('sale_id', saleReturn.sale_id)
    .eq('action', 'EMITIR')
    .like('nfce_ref', `dev-${saleReturn.id}-%`);
  const ref = `dev-${saleReturn.id}-${(count ?? 0) + 1}`;

  const payload = {
    cnpj_emitente: cnpj,
    natureza_operacao: 'DEVOLUCAO DE VENDA',
    data_emissao: brasiliaNow(),
    tipo_documento: '0',
    finalidade_emissao: '4',
    local_destino: '1',
    consumidor_final: '1',
    presenca_comprador: '1',
    modalidade_frete: '9',
    nome_destinatario: String(customer.name).slice(0, 60),
    cpf_destinatario: customer.cpf,
    indicador_inscricao_estadual_destinatario: '9',
    logradouro_destinatario: customer.address,
    numero_destinatario: customer.address_number,
    ...(customer.complement ? { complemento_destinatario: customer.complement } : {}),
    bairro_destinatario: customer.district,
    municipio_destinatario: customer.city,
    uf_destinatario: customer.state,
    cep_destinatario: String(customer.cep).replace(/\D/g, ''),
    pais_destinatario: 'Brasil',
    ...(customer.phone ? { telefone_destinatario: String(customer.phone).replace(/\D/g, '') } : {}),
    notas_referenciadas: [{ chave_nfe: nfceKey }],
    items: focusItems,
    formas_pagamento: [{ forma_pagamento: '90', valor_pagamento: 0 }],
  };

  await db.from('sale_returns').update({ fiscal_status: 'PENDENTE', nfe_ref: ref, nfe_environment: setting.environment, nfe_message: null })
    .eq('id', saleReturn.id);

  let response: Response;
  try {
    response = await fetch(`${host}/v2/nfe?ref=${encodeURIComponent(ref)}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    await logEvent('EMITIR', ref, null, 'SEM_CONEXAO', null);
    return json({ status: 'PENDENTE', message: 'Sem conexão com a Focus. A NF-e de devolução ficou pendente.' });
  }
  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    // resposta sem JSON
  }
  await logEvent('EMITIR', ref, response.status, String(body.status ?? body.codigo ?? ''), String(body.mensagem_sefaz ?? body.mensagem ?? ''));

  if (response.status === 401) {
    await db.from('sale_returns').update({ fiscal_status: 'ERRO', nfe_message: 'Chave da Focus recusada.' }).eq('id', saleReturn.id);
    return json({ status: 'ERRO', message: 'Chave da Focus recusada. Confira a configuração no UCP.' });
  }
  if (response.status >= 500) {
    return json({ status: 'PENDENTE', message: 'A Focus/Sefaz não respondeu. A NF-e de devolução ficou pendente.' });
  }
  if (body.status === 'processando_autorizacao' || response.status === 202) return await poll(ref);
  const protocol = (body.protocolo_nota_fiscal as Record<string, unknown> | undefined)?.numero_protocolo;
  if (protocol) body.protocolo = protocol;
  return await save(ref, body);
});
