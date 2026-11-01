import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Cancela as NFS-e de uma venda na Focus NFe (migration 20261113). Quem chama: o ERP, antes do
// estorno (junto com a NFC-e). O acesso a venda e conferido pela propria RLS do ERP.
// O prazo de cancelamento e o da prefeitura: se recusar, a mensagem volta para a tela.

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

function focusErrors(body: Record<string, unknown>): string {
  const errors = Array.isArray(body.erros) ? (body.erros as Record<string, unknown>[]) : [];
  const text = errors.map((error) => [error.codigo, error.mensagem].filter(Boolean).join(' - ')).join(' | ');
  return text || String(body.mensagem ?? '');
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
  const { data: visible } = await callerClient.from('sales').select('id, tenant_id, unit_id').eq('id', saleId).maybeSingle();
  if (!visible) return json({ error: 'Venda não encontrada.' }, 404);

  const { data: invoices } = await db
    .from('sale_service_invoices')
    .select('id, status, ref, environment, number')
    .eq('tenant_id', visible.tenant_id)
    .eq('sale_id', saleId);
  const pending = (invoices ?? []).filter((invoice) => invoice.status === 'PENDENTE');
  if (pending.length > 0) {
    return json({ error: 'Há NFS-e desta venda ainda em processamento. Aguarde a autorização para cancelar.' }, 409);
  }
  const authorized = (invoices ?? []).filter((invoice) => invoice.status === 'AUTORIZADA' && invoice.ref && invoice.environment);
  if (authorized.length === 0) return json({ status: 'SEM_NFSE' });

  const { data: setting } = await db
    .from('store_fiscal_settings')
    .select('focus_token')
    .eq('tenant_id', visible.tenant_id)
    .eq('unit_id', visible.unit_id)
    .maybeSingle();
  if (!setting) return json({ error: 'Nota fiscal não configurada para esta loja.' }, 409);

  const failures: string[] = [];
  for (const invoice of authorized) {
    const host = FOCUS_HOSTS[invoice.environment!];
    let response: Response;
    try {
      response = await fetch(`${host}/v2/nfsen/${encodeURIComponent(invoice.ref!)}`, {
        method: 'DELETE',
        headers: { Authorization: 'Basic ' + btoa(`${setting.focus_token}:`), 'Content-Type': 'application/json' },
        body: JSON.stringify({ justificativa: justification }),
      });
    } catch {
      failures.push(`NFS-e ${invoice.number ?? ''}: sem conexão com a Focus`);
      continue;
    }
    let body: Record<string, unknown> = {};
    try {
      body = await response.json();
    } catch {
      // resposta sem JSON
    }
    const message = focusErrors(body);
    await db.from('sale_service_invoice_events').insert({
      tenant_id: visible.tenant_id, unit_id: visible.unit_id, sale_id: saleId, invoice_id: invoice.id,
      action: 'CANCELAR', ref: invoice.ref, environment: invoice.environment, http_status: response.status,
      result_status: String(body.status ?? body.codigo ?? '') || null, message: message.slice(0, 1000) || null,
    });
    if (body.status === 'cancelado') {
      await db.from('sale_service_invoices').update({
        status: 'CANCELADA', cancelled_at: new Date().toISOString(), message: null, updated_at: new Date().toISOString(),
      }).eq('id', invoice.id);
    } else {
      failures.push(`NFS-e ${invoice.number ?? ''}: ${message || 'a prefeitura não aceitou o cancelamento'}`);
    }
  }

  if (failures.length > 0) return json({ error: failures.join(' | ') }, 422);
  return json({ status: 'CANCELADA' });
});
