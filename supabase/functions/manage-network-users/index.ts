import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Logins do Painel da Rede (migration 20261115).
// - SUPER_ADMIN (UCP): cria o dono (OWNER) de qualquer rede e troca senha/ativa qualquer login.
// - Dono da rede: cria gerentes (MANAGER) da propria rede, troca senha e ativa/desativa gerentes.
// Acoes: create { networkId?, role, name, email, password } | set_password { authUid, password }
//        | set_active { authUid, active }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const MIN_PASSWORD = 8;

type Payload = {
  action?: 'create' | 'set_password' | 'set_active';
  networkId?: string;
  role?: 'OWNER' | 'MANAGER';
  name?: string;
  email?: string;
  password?: string;
  authUid?: string;
  active?: boolean;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Autenticação obrigatória.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'Serviço de usuários indisponível.' }, 500);

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const service = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: 'Sessão inválida ou expirada.' }, 401);
  const callerId = userData.user.id;

  // Quem chama: SUPER_ADMIN da plataforma ou dono ativo de uma rede.
  const { data: appUser } = await service.from('app_users').select('role').eq('auth_uid', callerId).maybeSingle();
  const isSuperAdmin = appUser?.role === 'SUPER_ADMIN';
  const { data: callerNetwork } = await service
    .from('network_users')
    .select('network_id, role, is_active')
    .eq('auth_uid', callerId)
    .maybeSingle();
  const isOwner = callerNetwork?.role === 'OWNER' && callerNetwork.is_active === true;
  if (!isSuperAdmin && !isOwner) return json({ error: 'Só a plataforma ou o dono da rede gerenciam estes logins.' }, 403);

  let payload: Payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }

  // Login alvo precisa ser da rede do dono (a plataforma pode qualquer um). Dono nao mexe em outro dono.
  async function loadTarget(authUid: string | undefined) {
    if (!authUid) return null;
    const { data } = await service.from('network_users').select('auth_uid, network_id, role, display_name, is_active').eq('auth_uid', authUid).maybeSingle();
    if (!data) return null;
    if (!isSuperAdmin && (data.network_id !== callerNetwork!.network_id || data.role !== 'MANAGER')) return null;
    return data;
  }

  if (payload.action === 'create') {
    const role = payload.role === 'OWNER' ? 'OWNER' : 'MANAGER';
    const networkId = isSuperAdmin ? payload.networkId : callerNetwork!.network_id;
    if (!isSuperAdmin && role !== 'MANAGER') return json({ error: 'O dono da rede cria apenas gerentes.' }, 403);
    if (!networkId) return json({ error: 'Rede não informada.' }, 400);
    const { data: network } = await service.from('networks').select('id').eq('id', networkId).maybeSingle();
    if (!network) return json({ error: 'Rede não encontrada.' }, 404);

    const name = payload.name?.trim() || '';
    const email = payload.email?.trim().toLowerCase() || '';
    const password = payload.password || '';
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'Informe nome e e-mail válidos.' }, 400);
    if (password.length < MIN_PASSWORD) return json({ error: `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.` }, 400);

    const { data: created, error: createError } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    });
    if (createError || !created.user) {
      const already = /already|registered|exists/i.test(createError?.message || '');
      return json({ error: already ? 'Já existe uma conta com este e-mail.' : 'Não foi possível criar o login.' }, 400);
    }
    const { error: saveError } = await service.rpc('service_save_network_user', {
      p_auth_uid: created.user.id,
      p_network_id: networkId,
      p_role: role,
      p_display_name: name,
      p_active: true,
    });
    if (saveError) {
      await service.auth.admin.deleteUser(created.user.id);
      return json({ error: saveError.message || 'Não foi possível salvar o login da rede.' }, 400);
    }
    return json({ authUid: created.user.id }, 201);
  }

  if (payload.action === 'set_password') {
    const target = await loadTarget(payload.authUid);
    if (!target) return json({ error: 'Login não encontrado nesta rede.' }, 404);
    const password = payload.password || '';
    if (password.length < MIN_PASSWORD) return json({ error: `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.` }, 400);
    const { error } = await service.auth.admin.updateUserById(target.auth_uid, { password });
    if (error) return json({ error: 'Não foi possível trocar a senha.' }, 400);
    return json({ ok: true });
  }

  if (payload.action === 'set_active') {
    const target = await loadTarget(payload.authUid);
    if (!target) return json({ error: 'Login não encontrado nesta rede.' }, 404);
    if (target.auth_uid === callerId) return json({ error: 'Você não pode desativar o seu próprio login.' }, 400);
    const active = payload.active === true;
    const { error: dbError } = await service.rpc('service_save_network_user', {
      p_auth_uid: target.auth_uid,
      p_network_id: target.network_id,
      p_role: target.role,
      p_display_name: target.display_name,
      p_active: active,
    });
    if (dbError) return json({ error: 'Não foi possível alterar o login.' }, 400);
    const { error } = await service.auth.admin.updateUserById(target.auth_uid, { ban_duration: active ? 'none' : '876000h' });
    if (error) return json({ error: 'Login marcado, mas o bloqueio falhou. Tente de novo.' }, 400);
    return json({ ok: true });
  }

  return json({ error: 'Ação inválida.' }, 400);
});
