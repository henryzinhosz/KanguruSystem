import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Cancela a NFC-e de uma venda na Focus NFe (2.8b). Quem chama: o ERP, antes do estorno.
// O acesso a venda e conferido pela propria RLS do ERP (o usuario precisa enxergar a venda).
// A Sefaz so aceita cancelamento ate 30 minutos depois da autorizacao.

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

const CANCEL_WINDOW_MS = 30 * 60 * 1000;

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

  let saleId = '';
  let justification = '';
  try {
    const body = await request.json();
    saleId = String(body?.saleId ?? '').trim();
    justification = String(body?.justification ?? '').trim();
  } catch {
    // corpo invalido: tratado abaixo
  }
  if (!saleId) return json({ error: 'Venda não informada.' }, 400);
  if (justification.length < 15 || justification.length > 255) {
    return json({ error: 'A justificativa precisa ter entre 15 e 255 caracteres.' }, 400);
  }

  // RLS do ERP: so devolve a venda se o usuario tem acesso ao tenant/loja.
  const { data: visible } = await callerClient.from('sales').select('id').eq('id', saleId).maybeSingle();
  if (!visible) return json({ error: 'Venda não encontrada.' }, 404);

  const { data: sale } = await db
    .from('sales')
    .select('id, tenant_id, unit_id, fiscal_status, nfce_ref, nfce_environment, nfce_authorized_at')
    .eq('id', saleId)
    .maybeSingle();
  if (!sale) return json({ error: 'Venda não encontrada.' }, 404);
  if (sale.fiscal_status === 'CANCELADA') return json({ status: 'CANCELADA' });
  if (sale.fiscal_status !== 'AUTORIZADA' || !sale.nfce_ref || !sale.nfce_environment) {
    return json({ error: 'Esta venda não tem NFC-e autorizada.' }, 409);
  }
  if (!sale.nfce_authorized_at || Date.now() - new Date(sale.nfce_authorized_at).getTime() > CANCEL_WINDOW_MS) {
    return json({ error: 'O prazo de 30 minutos para cancelar a NFC-e já passou.' }, 409);
  }

  const { data: setting } = await db
    .from('store_fiscal_settings')
    .select('focus_token')
    .eq('tenant_id', sale.tenant_id)
    .eq('unit_id', sale.unit_id)
    .maybeSingle();
  if (!setting) return json({ error: 'NFC-e não configurada para esta loja.' }, 409);

  const host = FOCUS_HOSTS[sale.nfce_environment];
  let response: Response;
  try {
    response = await fetch(`${host}/v2/nfce/${encodeURIComponent(sale.nfce_ref)}`, {
      method: 'DELETE',
      headers: { Authorization: 'Basic ' + btoa(`${setting.focus_token}:`), 'Content-Type': 'application/json' },
      body: JSON.stringify({ justificativa: justification }),
    });
  } catch {
    return json({ error: 'Sem conexão com a Focus. Tente novamente.' }, 502);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    // resposta sem JSON
  }
  const message = String(body.mensagem_sefaz ?? body.mensagem ?? '');
  await db.from('sale_fiscal_events').insert({
    tenant_id: sale.tenant_id, unit_id: sale.unit_id, sale_id: sale.id, action: 'CANCELAR',
    nfce_ref: sale.nfce_ref, environment: sale.nfce_environment, http_status: response.status,
    result_status: String(body.status ?? body.codigo ?? ''), message: message.slice(0, 1000) || null,
  });

  if (body.status !== 'cancelado') {
    return json({ error: message || 'A Sefaz não aceitou o cancelamento da NFC-e.' }, 422);
  }

  const xmlPath = body.caminho_xml_cancelamento as string | undefined;
  await db.from('sales').update({
    fiscal_status: 'CANCELADA',
    nfce_cancelled_at: new Date().toISOString(),
    nfce_cancel_xml_url: xmlPath ? (/^https?:\/\//i.test(xmlPath) ? xmlPath : `${host}${xmlPath}`) : null,
    nfce_message: message || null,
  }).eq('tenant_id', sale.tenant_id).eq('id', sale.id);

  return json({ status: 'CANCELADA' });
});
