import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Acompanha as NFC-e emitidas em contingencia offline (Sefaz fora do ar) ate a Sefaz efetivar.
// Quem chama: o PDV da loja (sessao de terminal), ao abrir e periodicamente. Consulta na Focus
// as notas da loja ainda nao efetivadas e atualiza a venda: efetivada, ou ERRO com o motivo
// (a loja precisa corrigir dentro do prazo legal de 24 horas).

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

  const { data: setting } = await db
    .from('store_fiscal_settings')
    .select('focus_token')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .maybeSingle();
  if (!setting) return json({ pending: 0, effective: 0, errors: 0 });

  const { data: sales } = await db
    .from('sales')
    .select('id, nfce_ref, nfce_environment, nfce_number, timestamp')
    .eq('tenant_id', terminal.tenant_id)
    .eq('unit_id', terminal.unit_id)
    .eq('fiscal_status', 'AUTORIZADA')
    .eq('nfce_contingency', true)
    .eq('nfce_contingency_done', false)
    .limit(50);

  let effective = 0;
  let errors = 0;
  let pending = 0;
  const auth = 'Basic ' + btoa(`${setting.focus_token}:`);
  for (const sale of sales ?? []) {
    if (!sale.nfce_ref || !sale.nfce_environment) continue;
    const host = FOCUS_HOSTS[sale.nfce_environment];
    let body: Record<string, unknown> = {};
    let httpStatus: number | null = null;
    try {
      const response = await fetch(`${host}/v2/nfce/${encodeURIComponent(sale.nfce_ref)}?completa=1`, { headers: { Authorization: auth } });
      httpStatus = response.status;
      if (!response.ok) {
        pending += 1;
        continue;
      }
      body = await response.json();
    } catch {
      pending += 1;
      continue;
    }

    await db.from('sale_fiscal_events').insert({
      tenant_id: terminal.tenant_id, unit_id: terminal.unit_id, sale_id: sale.id, action: 'CONSULTAR',
      nfce_ref: sale.nfce_ref, environment: sale.nfce_environment, http_status: httpStatus,
      result_status: `contingencia:${String(body.status ?? '')}:${String(body.contingencia_offline_efetivada ?? '')}`,
      message: (body.mensagem_sefaz as string | undefined)?.slice(0, 1000) ?? null,
    });

    if (body.status === 'erro_autorizacao' || body.status === 'denegado') {
      // A Sefaz recusou a nota ja entregue ao cliente: precisa de correcao pela loja.
      await db.from('sales').update({
        fiscal_status: 'ERRO',
        nfce_message: `Contingência recusada pela Sefaz: ${String(body.mensagem_sefaz ?? 'sem motivo informado')}`,
      }).eq('tenant_id', terminal.tenant_id).eq('id', sale.id);
      errors += 1;
    } else if (body.contingencia_offline_efetivada === true || (body.status === 'autorizado' && body.contingencia_offline !== true)) {
      const protocol = (body.protocolo_nota_fiscal as Record<string, unknown> | undefined)?.numero_protocolo;
      await db.from('sales').update({
        nfce_contingency_done: true,
        ...(protocol ? { nfce_protocol: String(protocol) } : {}),
        ...(body.mensagem_sefaz ? { nfce_message: String(body.mensagem_sefaz) } : {}),
      }).eq('tenant_id', terminal.tenant_id).eq('id', sale.id);
      effective += 1;
    } else {
      pending += 1;
    }
  }

  return json({ pending, effective, errors });
});
