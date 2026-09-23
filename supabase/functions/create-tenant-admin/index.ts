import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type CreateTenantRequest = {
  legalName?: string;
  cnpj?: string;
  adminEmail?: string;
  initialPassword?: string;
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Método não permitido.' }, 405);
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization) {
    return json({ error: 'Autenticação obrigatória.' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('Configuração de ambiente ausente para provisionamento.');
    return json({ error: 'Serviço de provisionamento indisponível.' }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ error: 'Sessão inválida ou expirada.' }, 401);
  }

  const { data: callerProfile, error: profileError } = await serviceClient
    .from('app_users')
    .select('role')
    .eq('auth_uid', userData.user.id)
    .maybeSingle();

  if (profileError || callerProfile?.role !== 'SUPER_ADMIN') {
    return json({ error: 'Acesso restrito à administração da plataforma.' }, 403);
  }

  let payload: CreateTenantRequest;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Dados de criação inválidos.' }, 400);
  }

  const legalName = payload.legalName?.trim() || '';
  const cnpj = (payload.cnpj || '').replace(/\D/g, '');
  const adminEmail = payload.adminEmail?.trim().toLowerCase() || '';
  const initialPassword = payload.initialPassword || '';

  if (!legalName || !/^\d{14}$/.test(cnpj) || !/^\S+@\S+\.\S+$/.test(adminEmail)) {
    return json({ error: 'Informe razão social, CNPJ válido e e-mail válido.' }, 400);
  }

  if (initialPassword.length < 12) {
    return json({ error: 'A senha inicial precisa ter ao menos 12 caracteres.' }, 400);
  }

  const { data: createdUser, error: createUserError } = await serviceClient.auth.admin.createUser({
    email: adminEmail,
    password: initialPassword,
    email_confirm: true,
    user_metadata: { name: legalName },
  });

  if (createUserError || !createdUser.user) {
    return json({ error: createUserError?.message || 'Não foi possível criar o administrador.' }, 400);
  }

  const { data: tenantId, error: provisioningError } = await serviceClient.rpc('provision_tenant_admin', {
    p_auth_uid: createdUser.user.id,
    p_legal_name: legalName,
    p_cnpj: cnpj,
  });

  if (provisioningError || !tenantId) {
    await serviceClient.auth.admin.deleteUser(createdUser.user.id);
    console.error('Falha ao criar tenant:', provisioningError);
    return json({ error: 'Não foi possível concluir o cadastro do cliente.' }, 400);
  }

  return json({ tenantId, adminEmail }, 201);
});