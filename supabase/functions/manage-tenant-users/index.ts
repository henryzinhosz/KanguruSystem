import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Usuarios do ERP criados pelo dono da empresa (ADMIN): criar login, trocar senha e
// ativar/desativar. Perfil, lojas e areas ficam no banco (save_tenant_user), que tambem
// confere se quem chama e o ADMIN daquela empresa.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Payload = {
  action?: 'create' | 'set_password' | 'set_active';
  authUid?: string;
  name?: string;
  email?: string;
  password?: string;
  role?: 'ADMIN' | 'MANAGER';
  stores?: string[];
  permissions?: Record<string, boolean>;
  active?: boolean;
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const MIN_PASSWORD = 8;

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

  const { data: caller } = await service
    .from('app_users')
    .select('role, tenant_id, is_active')
    .eq('auth_uid', callerId)
    .maybeSingle();
  if (!caller || caller.role !== 'ADMIN' || !caller.tenant_id || caller.is_active === false) {
    return json({ error: 'Só o administrador da empresa pode gerenciar usuários.' }, 403);
  }

  let payload: Payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }

  // Usuario alvo precisa ser da mesma empresa.
  const targetInTenant = async (authUid: string | undefined) => {
    if (!authUid) return false;
    const { data } = await service
      .from('app_users')
      .select('auth_uid')
      .eq('auth_uid', authUid)
      .eq('tenant_id', caller.tenant_id)
      .maybeSingle();
    return Boolean(data);
  };

  if (payload.action === 'create') {
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

    const { error: saveError } = await service.rpc('save_tenant_user', {
      p_caller: callerId,
      p_auth_uid: created.user.id,
      p_display_name: name,
      p_role: payload.role,
      p_stores: payload.stores ?? [],
      p_permissions: payload.permissions ?? null,
      p_create: true,
    });
    if (saveError) {
      await service.auth.admin.deleteUser(created.user.id);
      return json({ error: saveError.message || 'Não foi possível salvar o usuário.' }, 400);
    }
    return json({ authUid: created.user.id }, 201);
  }

  if (payload.action === 'set_password') {
    if (!(await targetInTenant(payload.authUid))) return json({ error: 'Usuário não encontrado nesta empresa.' }, 404);
    const password = payload.password || '';
    if (password.length < MIN_PASSWORD) return json({ error: `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.` }, 400);
    const { error } = await service.auth.admin.updateUserById(payload.authUid!, { password });
    if (error) return json({ error: 'Não foi possível trocar a senha.' }, 400);
    return json({ ok: true });
  }

  if (payload.action === 'set_active') {
    if (!(await targetInTenant(payload.authUid))) return json({ error: 'Usuário não encontrado nesta empresa.' }, 404);
    const active = payload.active === true;
    const { error: dbError } = await service.rpc('set_tenant_user_active', {
      p_caller: callerId,
      p_auth_uid: payload.authUid,
      p_active: active,
    });
    if (dbError) return json({ error: dbError.message || 'Não foi possível alterar o usuário.' }, 400);
    // Desativado: bloqueia o login (e as renovações de sessão).
    const { error } = await service.auth.admin.updateUserById(payload.authUid!, { ban_duration: active ? 'none' : '876000h' });
    if (error) return json({ error: 'Usuário marcado, mas o bloqueio do login falhou. Tente de novo.' }, 400);
    return json({ ok: true });
  }

  return json({ error: 'Ação inválida.' }, 400);
});
