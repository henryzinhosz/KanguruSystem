import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// NFS-e Nacional dos servicos de uma venda do PDV, pela Focus NFe (migration 20261113).
// Quem chama: o PDV, com a sessao do terminal.
//   { action: 'emit', saleId } -> emite (ou consulta a pendente) uma NFS-e por grupo de servico
//   { action: 'pdf', invoiceId } -> devolve o PDF do DANFSe (base64) para impressao
// A NFS-e nacional aceita 1 codigo de servico e 1 NBS por nota: servicos com codigos diferentes
// saem em notas separadas. A chave da Focus fica em store_fiscal_settings (service role).

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

type SaleItem = {
  itemType?: string;
  serviceId?: string;
  quantity: number;
  lineTotal: number;
  itemName?: string;
};

type Service = {
  id: string;
  name: string;
  nfse_service_code: string | null;
  nfse_nbs_code: string | null;
  nfse_municipal_code: string | null;
  nfse_description: string | null;
};

type Invoice = {
  id: string;
  group_key: string;
  status: string;
  ref: string | null;
  environment: string | null;
  attempts: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Horario de Brasilia (sem horario de verao).
function brasiliaNow(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 19) + '-03:00';
}

function focusUrl(host: string, path: unknown): string | null {
  if (!path) return null;
  const text = String(path);
  return /^https?:\/\//i.test(text) ? text : `${host}${text.startsWith('/') ? '' : '/'}${text}`;
}

function focusErrors(body: Record<string, unknown>): string {
  const errors = Array.isArray(body.erros) ? (body.erros as Record<string, unknown>[]) : [];
  const text = errors.map((error) => [error.codigo, error.mensagem, error.correcao].filter(Boolean).join(' - ')).join(' | ');
  return text || String(body.mensagem ?? body.mensagem_sefaz ?? '');
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
    console.error('Configuração de ambiente ausente para NFS-e.');
    return json({ error: 'Serviço de NFS-e indisponível.' }, 500);
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

  let payloadIn: Record<string, unknown> = {};
  try {
    payloadIn = await request.json();
  } catch {
    // corpo invalido: tratado abaixo
  }
  const action = String(payloadIn.action ?? 'emit');

  // ---- PDF do DANFSe (a URL da Focus nao aceita leitura direta pelo PDV) ----
  if (action === 'pdf') {
    const invoiceId = String(payloadIn.invoiceId ?? '');
    const { data: invoice } = await db
      .from('sale_service_invoices')
      .select('danfse_url, number')
      .eq('tenant_id', terminal.tenant_id)
      .eq('unit_id', terminal.unit_id)
      .eq('id', invoiceId)
      .maybeSingle();
    if (!invoice?.danfse_url) return json({ error: 'DANFSe ainda não disponível para esta nota.' }, 404);
    try {
      const response = await fetch(invoice.danfse_url);
      if (!response.ok) return json({ error: 'Não foi possível baixar o DANFSe.' }, 502);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return json({ pdf: btoa(binary), number: invoice.number });
    } catch {
      return json({ error: 'Sem conexão para baixar o DANFSe.' }, 502);
    }
  }

  if (action !== 'emit') return json({ error: 'Ação inválida.' }, 400);
  const saleId = String(payloadIn.saleId ?? '').trim();
  if (!saleId) return json({ error: 'Venda não informada.' }, 400);

  const { data: sale } = await db
    .from('sales')
    .select('id, tenant_id, unit_id, items, status, client_cpf, client_name')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .eq('id', saleId)
    .maybeSingle();
  if (!sale) return json({ error: 'Venda não encontrada nesta loja.' }, 404);
  if (sale.status !== 'CONCLUIDA') return json({ error: 'Só vendas concluídas geram NFS-e.' }, 409);

  const { data: setting } = await db
    .from('store_fiscal_settings')
    .select('focus_token, environment')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .maybeSingle();
  if (!setting) return json({ error: 'Nota fiscal não configurada para esta loja (chave da Focus no UCP).' }, 409);

  const { data: store } = await db
    .from('store_configs')
    .select('cnpj, municipal_registration, city_ibge_code, simples_nacional_option')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .maybeSingle();
  const cnpj = digits(store?.cnpj);
  if (cnpj.length !== 14) return json({ error: 'CNPJ da loja não cadastrado no ERP.' }, 409);
  const city = digits(store?.city_ibge_code);
  if (city.length !== 7) return json({ error: 'Município da loja (código IBGE) não cadastrado no ERP › Configurações.' }, 409);

  const items = ((sale.items ?? []) as SaleItem[]).filter((item) => String(item.itemType ?? '').toUpperCase() === 'SERVICE');
  if (items.length === 0) return json({ error: 'Esta venda não tem serviços.' }, 409);

  const serviceIds = Array.from(new Set(items.map((item) => String(item.serviceId))));
  const { data: services } = await db
    .from('services')
    .select('id, name, nfse_service_code, nfse_nbs_code, nfse_municipal_code, nfse_description')
    .eq('tenant_id', terminal.tenant_id)
    .in('id', serviceIds);
  const serviceMap = new Map(((services ?? []) as Service[]).map((service) => [service.id, service]));
  const missing = serviceIds
    .map((id) => serviceMap.get(id))
    .filter((service) => !service || !/^\d{6}$/.test(service.nfse_service_code ?? '') || !/^\d{9}$/.test(service.nfse_nbs_code ?? ''))
    .map((service) => service?.name ?? 'serviço removido');
  if (missing.length > 0) {
    return json({ error: `Dados fiscais do serviço incompletos (código nacional e NBS) em: ${missing.join(', ')}. Corrija no ERP › Serviços.` }, 422);
  }

  // Agrupa por codigo nacional + NBS + codigo municipal (uma NFS-e por grupo).
  const groups = new Map<string, { service: Service; amount: number; lines: string[] }>();
  for (const item of items) {
    const service = serviceMap.get(String(item.serviceId))!;
    const key = [service.nfse_service_code, service.nfse_nbs_code, service.nfse_municipal_code ?? ''].join('|');
    const group = groups.get(key) ?? { service, amount: 0, lines: [] };
    group.amount = round2(group.amount + Number(item.lineTotal));
    const text = (service.nfse_description || item.itemName || service.name).trim();
    group.lines.push(Number(item.quantity) > 1 ? `${item.quantity}x ${text}` : text);
    groups.set(key, group);
  }

  // Tomador: CPF da venda e, se houver cadastro, nome e endereco.
  const cpf = digits(sale.client_cpf);
  const tomador: Record<string, unknown> = {};
  if (cpf.length === 11) {
    tomador.cpf_tomador = cpf;
    const { data: customer } = await db
      .from('customers')
      .select('name, email, phone, cep, address, address_number, complement, district')
      .eq('tenant_id', terminal.tenant_id)
      .eq('cpf', cpf)
      .maybeSingle();
    tomador.razao_social_tomador = String(customer?.name ?? sale.client_name ?? '').slice(0, 150) || undefined;
    // So o CPF (janela "CPF na nota?"): a NFS-e sai sem identificar o cliente, para nao correr risco de recusa.
    if (!tomador.razao_social_tomador) delete tomador.cpf_tomador;
    if (customer?.email) tomador.email_tomador = String(customer.email).slice(0, 80);
    const phone = digits(customer?.phone);
    if (phone.length >= 6) tomador.telefone_tomador = phone.slice(0, 20);
    const cep = digits(customer?.cep);
    if (cep.length === 8 && customer?.address) {
      // Endereco so vai completo (precisa do municipio IBGE, consultado pelo CEP).
      try {
        const via = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
        if (via?.ibge) {
          tomador.codigo_municipio_tomador = String(via.ibge);
          tomador.cep_tomador = cep;
          tomador.logradouro_tomador = String(customer.address).slice(0, 255);
          tomador.numero_tomador = String(customer.address_number || 'S/N').slice(0, 60);
          if (customer.complement) tomador.complemento_tomador = String(customer.complement).slice(0, 156);
          tomador.bairro_tomador = String(customer.district || via.bairro || 'Centro').slice(0, 60);
        }
      } catch {
        // sem ViaCEP: a nota sai so com CPF e nome
      }
    }
  }

  const host = FOCUS_HOSTS[setting.environment];
  const auth = 'Basic ' + btoa(`${setting.focus_token}:`);
  const now = new Date().toISOString();

  const { data: existingRows } = await db
    .from('sale_service_invoices')
    .select('id, group_key, status, ref, environment, attempts')
    .eq('tenant_id', terminal.tenant_id)
    .eq('sale_id', sale.id);
  const existing = new Map(((existingRows ?? []) as Invoice[]).map((row) => [row.group_key, row]));

  const logEvent = (invoiceId: string, eventAction: string, ref: string, httpStatus: number | null, resultStatus: string, message: string) =>
    db.from('sale_service_invoice_events').insert({
      tenant_id: terminal.tenant_id, unit_id: terminal.unit_id, sale_id: sale.id, invoice_id: invoiceId,
      action: eventAction, ref, environment: setting.environment, http_status: httpStatus,
      result_status: resultStatus || null, message: message.slice(0, 1000) || null,
    });

  // Aplica a resposta da Focus (consulta ou envio) na linha da nota.
  async function applyStatus(invoiceId: string, body: Record<string, unknown>): Promise<string> {
    const status = String(body.status ?? '');
    if (status === 'autorizado') {
      await db.from('sale_service_invoices').update({
        status: 'AUTORIZADA', number: body.numero != null ? String(body.numero) : null,
        verification_code: body.codigo_verificacao ?? null, consult_url: body.url ?? null,
        danfse_url: focusUrl(host, body.url_danfse), xml_url: focusUrl(host, body.caminho_xml_nota_fiscal),
        message: null, authorized_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', invoiceId);
      return 'AUTORIZADA';
    }
    if (status === 'erro_autorizacao' || status === 'negado') {
      await db.from('sale_service_invoices').update({
        status: 'ERRO', message: focusErrors(body) || 'NFS-e não autorizada.', updated_at: new Date().toISOString(),
      }).eq('id', invoiceId);
      return 'ERRO';
    }
    if (status === 'cancelado') {
      await db.from('sale_service_invoices').update({ status: 'CANCELADA', updated_at: new Date().toISOString() }).eq('id', invoiceId);
      return 'CANCELADA';
    }
    return 'PENDENTE';
  }

  async function consult(invoiceId: string, ref: string): Promise<{ status: string; body: Record<string, unknown> } | null> {
    try {
      const response = await fetch(`${host}/v2/nfsen/${encodeURIComponent(ref)}`, { headers: { Authorization: auth } });
      if (response.status === 404) return { status: 'NAO_ENCONTRADA', body: {} };
      const body = await response.json();
      await logEvent(invoiceId, 'CONSULTAR', ref, response.status, String(body.status ?? ''), focusErrors(body));
      return { status: await applyStatus(invoiceId, body), body };
    } catch {
      return null;
    }
  }

  const results: Record<string, unknown>[] = [];
  let groupIndex = 0;
  for (const [key, group] of groups) {
    groupIndex += 1;
    let row = existing.get(key);
    if (row?.status === 'AUTORIZADA' || row?.status === 'CANCELADA') {
      results.push({ id: row.id, status: row.status });
      continue;
    }

    if (!row) {
      const { data: created, error } = await db.from('sale_service_invoices').insert({
        tenant_id: terminal.tenant_id, unit_id: terminal.unit_id, sale_id: sale.id, group_key: key,
        service_code: group.service.nfse_service_code, nbs_code: group.service.nfse_nbs_code,
        municipal_code: group.service.nfse_municipal_code, description: group.lines.join('; ').slice(0, 2000),
        amount: group.amount, environment: setting.environment,
      }).select('id, group_key, status, ref, environment, attempts').single();
      if (error || !created) {
        results.push({ status: 'ERRO', message: 'Não foi possível registrar a NFS-e.' });
        continue;
      }
      row = created as Invoice;
    }

    // Envio anterior sem resposta final: consulta antes de mandar de novo (evita nota em dobro).
    if (row.status === 'PENDENTE' && row.ref && row.environment === setting.environment) {
      const checked = await consult(row.id, row.ref);
      if (!checked) {
        results.push({ id: row.id, status: 'PENDENTE', message: 'Sem conexão com a Focus. Tente novamente em instantes.' });
        continue;
      }
      if (checked.status === 'AUTORIZADA' || checked.status === 'CANCELADA') {
        results.push({ id: row.id, status: checked.status });
        continue;
      }
      if (checked.status === 'PENDENTE') {
        results.push({ id: row.id, status: 'PENDENTE', message: 'A NFS-e ainda está em processamento. Tente novamente em instantes.' });
        continue;
      }
      // ERRO ou nao encontrada: segue para nova tentativa.
    }

    let finalStatus = 'PENDENTE';
    let finalMessage = '';
    // Numero de DPS ja usado (E0014): pega o proximo e tenta de novo.
    for (let retry = 0; retry < 3; retry += 1) {
      const attempt = row.attempts + 1;
      row.attempts = attempt;
      const ref = `${sale.id}-S${groupIndex}-${attempt}`;
      const { data: dps } = await db.rpc('next_nfse_dps_number', { p_tenant_id: terminal.tenant_id, p_unit_id: terminal.unit_id });
      const dpsRow = Array.isArray(dps) ? dps[0] : dps;
      if (!dpsRow) {
        finalStatus = 'ERRO';
        finalMessage = 'Numeração da NFS-e não encontrada (configuração da Focus da loja).';
        break;
      }
      await db.from('sale_service_invoices').update({
        status: 'PENDENTE', ref, attempts: attempt, environment: setting.environment, message: null,
        dps_series: dpsRow.series, dps_number: dpsRow.number, updated_at: now,
      }).eq('id', row.id);

      const option = String(store?.simples_nacional_option ?? '3');
      const payload: Record<string, unknown> = {
        data_emissao: brasiliaNow(),
        data_competencia: brasiliaNow().slice(0, 10),
        serie_dps: dpsRow.series,
        numero_dps: dpsRow.number,
        emitente_dps: 1,
        codigo_municipio_emissora: Number(city),
        cnpj_prestador: cnpj,
        codigo_opcao_simples_nacional: Number(option),
        regime_especial_tributacao: 0,
        codigo_municipio_prestacao: city,
        codigo_tributacao_nacional_iss: group.service.nfse_service_code,
        codigo_nbs: group.service.nfse_nbs_code,
        descricao_servico: group.lines.join('; ').slice(0, 2000),
        valor_servico: group.amount,
        tributacao_iss: 1,
        tipo_retencao_iss: 1,
        ...tomador,
      };
      if (option === '3') payload.regime_tributario_simples_nacional = 1;
      const registration = String(store?.municipal_registration ?? '').trim();
      if (registration) payload.inscricao_municipal_prestador = registration.slice(0, 15);
      if (group.service.nfse_municipal_code) payload.codigo_tributacao_municipal_iss = group.service.nfse_municipal_code;

      let response: Response;
      try {
        response = await fetch(`${host}/v2/nfsen?ref=${encodeURIComponent(ref)}`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch {
        await logEvent(row.id, 'EMITIR', ref, null, 'SEM_CONEXAO', '');
        finalMessage = 'Sem conexão com a Focus. A NFS-e ficou pendente.';
        break;
      }
      let body: Record<string, unknown> = {};
      try {
        body = await response.json();
      } catch {
        // resposta sem JSON (ex.: 401 em HTML)
      }
      await logEvent(row.id, 'EMITIR', ref, response.status, String(body.status ?? body.codigo ?? ''), focusErrors(body));

      if (response.status === 401) {
        finalStatus = 'ERRO';
        finalMessage = 'Chave da Focus recusada. Confira a configuração no UCP.';
        await db.from('sale_service_invoices').update({ status: 'ERRO', message: finalMessage }).eq('id', row.id);
        break;
      }
      if (response.status === 400 || response.status === 422) {
        finalStatus = 'ERRO';
        finalMessage = focusErrors(body) || 'Dados da NFS-e recusados pela Focus.';
        await db.from('sale_service_invoices').update({ status: 'ERRO', message: finalMessage }).eq('id', row.id);
        break;
      }
      if (response.status >= 500) {
        finalMessage = 'A Focus não respondeu. A NFS-e ficou pendente.';
        break;
      }

      // Aceita para processamento: acompanha por alguns segundos.
      let checked: { status: string; body: Record<string, unknown> } | null = null;
      for (let poll = 0; poll < 6; poll += 1) {
        await sleep(2000);
        checked = await consult(row.id, ref);
        if (checked && checked.status !== 'PENDENTE' && checked.status !== 'NAO_ENCONTRADA') break;
      }
      finalStatus = checked?.status === 'NAO_ENCONTRADA' || !checked ? 'PENDENTE' : checked.status;
      if (finalStatus === 'ERRO') {
        finalMessage = focusErrors(checked!.body);
        if (/E0014/.test(finalMessage) && retry < 2) continue; // numero de DPS repetido
      } else if (finalStatus === 'PENDENTE') {
        finalMessage = 'A NFS-e está em processamento. Ela aparece em Cupons e notas quando for autorizada.';
      }
      break;
    }
    results.push({ id: row.id, status: finalStatus, ...(finalMessage ? { message: finalMessage } : {}) });
  }

  const statuses = results.map((result) => String(result.status));
  const overall = statuses.every((status) => status === 'AUTORIZADA' || status === 'CANCELADA')
    ? 'AUTORIZADA'
    : statuses.includes('ERRO') ? 'ERRO' : 'PENDENTE';
  return json({ status: overall, invoices: results });
});
