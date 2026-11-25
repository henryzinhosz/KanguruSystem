import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';

// Agencia de IA, etapa C: VideoMaker (migration 20261212). Publicar SEM "Verify JWT": o retorno
// do Instagram (GET) chega sem login. Cada acao confere a permissao por conta propria:
// - GET  ?code&state       retorno do login do Instagram (state conferido no banco, vale 15 min)
// - POST {action:connect}  dono pede o endereco de login do Instagram da loja
// - POST {action:caption}  legenda pela IA a partir das fotos e da transcricao (conta no limite)
// - POST {action:tick}     agendador (pg_cron, a cada 5 min, com o segredo da tabela fechada):
//                          renova chaves, publica os videos aprovados na hora e limpa arquivos
//
// Segredos: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET (Meta › Instagram › API setup with Instagram
// login), ANTHROPIC_API_KEY (sem ela, legenda em modo de teste). Opcionais: ERP_ORIGINS
// (enderecos do ERP separados por virgula) e INSTAGRAM_API_VERSION.
// A chave do Instagram nunca sai do servidor e nunca vai para o log.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MODEL = 'claude-opus-5-5';
const BUCKET = 'agency-videos';
const SCOPES = 'instagram_business_basic,instagram_business_content_publish';
const IG_VERSION = Deno.env.get('INSTAGRAM_API_VERSION') || 'v27.0';
const GRAPH = `https://graph.instagram.com/${IG_VERSION}`;
const DEFAULT_ORIGINS = ['https://kanguruerp.vercel.app', 'http://localhost:3000'];
const EDITABLE = ['RASCUNHO', 'APROVADO', 'PAUSADO', 'ERRO'];
const MAX_FRAMES = 8;

// US$ por milhao de tokens (mesma tabela da agency-chat, conferida em 2026-11-24).
const PRICES: Record<string, { input: number; output: number; read: number; write: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2, write: 5 },
  'claude-opus-5': { input: 5, output: 25, read: 0.5, write: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.1, write: 2.5 },
  'claude-fable-5-2': { input: 8, output: 40, read: 0.2, write: 10 },
};

const REASON_MESSAGES: Record<string, string> = {
  LIMITE: 'O limite de perguntas da Agência deste mês acabou (cada legenda conta 1). Você ainda pode escrever a legenda à mão.',
  DESLIGADA: 'A Agência está desligada para esta empresa. Fale com o suporte.',
  BLOQUEADO: 'A assinatura da empresa está bloqueada. Fale com o suporte.',
};

const CAPTION_SYSTEM = `Você é o VideoMaker da "Agência Kanguru": escreve legendas de Reels do Instagram para uma loja de games, informática e acessórios no Brasil (franquia BeB Games).
Você recebe algumas fotos tiradas ao longo do vídeo (em ordem), a transcrição do áudio (pode ter erros ou vir vazia), uma frase opcional do dono e informações da loja.

Regras:
- Português do Brasil, tom animado e próximo, como a loja fala com o público dela.
- Primeira linha: um gancho curto que faça a pessoa parar para assistir.
- Depois, de 1 a 3 frases curtas sobre o que aparece no vídeo. Fale só do que dá para ver nas fotos, ouvir na transcrição ou ler na frase do dono. Nunca invente preço, promoção, prazo, estoque ou característica de produto.
- Termine com uma chamada para ação (por exemplo "Chama no direct" ou "Passa na loja"). Se o endereço da loja for informado, pode citar o bairro ou a cidade.
- No máximo 3 emojis. No total, até 900 caracteres.
- Na última linha, de 3 a 6 hashtags relevantes (produto, nicho, cidade).
- Proteja dados pessoais (LGPD): não cite nomes de clientes nem dados pessoais que apareçam no vídeo.
- Responda SOMENTE com a legenda pronta, sem aspas, sem título e sem comentários.`;

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const redirect = (url: string) => new Response(null, { status: 302, headers: { Location: url } });

const allowedOrigins = () => {
  const extra = (Deno.env.get('ERP_ORIGINS') || '').split(',').map(item => item.trim().replace(/\/+$/, '')).filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra];
};

const toBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(text);
};

const randomState = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

// ---------------- Instagram ----------------
type GraphError = { message: string; code: number | null; userMessage: string | null; transient: boolean };

class InstagramError extends Error {
  info: GraphError;
  constructor(info: GraphError) {
    super(info.message);
    this.info = info;
  }
}

// Resposta da Meta: alguns endpoints devolvem { data: [ ... ] }, outros o objeto direto.
const unwrap = (body: Record<string, unknown>) =>
  (Array.isArray(body?.data) && body.data.length > 0 ? body.data[0] : body) as Record<string, unknown>;

async function graph(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new InstagramError({ message: 'Sem conexão com o Instagram', code: null, userMessage: null, transient: true });
  }
  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    // corpo vazio
  }
  const error = body?.error as Record<string, unknown> | undefined;
  if (!response.ok || error) {
    const code = typeof error?.code === 'number' ? error.code : null;
    throw new InstagramError({
      message: String(error?.message || error?.error_message || `HTTP ${response.status}`),
      code,
      userMessage: (error?.error_user_msg as string) || null,
      transient: response.status >= 500 || code === 1 || code === 2 || code === 4 || code === 17 || code === 32 || code === 613,
    });
  }
  return body;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

const friendlyInstagram = (info: GraphError) => {
  if (info.code === 190) return 'A ligação com o Instagram expirou ou foi removida. O dono precisa clicar em "Conectar Instagram" de novo.';
  if (info.code === 10 || info.code === 200) return 'O Instagram não deu permissão para postar nesta conta. Conecte de novo e aceite todas as permissões.';
  if (info.code === 9 || info.code === 4 || info.code === 17 || info.code === 32 || info.code === 613) return 'O Instagram limitou as postagens desta conta por agora. Tente de novo mais tarde.';
  return `O Instagram recusou: ${info.userMessage || info.message}`.slice(0, 400);
};

type Account = {
  tenant_id: string;
  unit_id: string;
  ig_user_id: string;
  username: string;
  access_token: string;
  token_expires_at: string;
  token_refreshed_at: string;
  status: string;
};

type Video = {
  id: string;
  tenant_id: string;
  unit_id: string;
  file_name: string;
  storage_path: string;
  frame_paths: string[];
  duration_seconds: number;
  note: string;
  transcript: string;
  caption: string;
  status: string;
  ig_container_id: string | null;
  publish_started_at: string | null;
  attempts: number;
};

// ---------------- Retorno do login do Instagram ----------------
async function handleCallback(service: SupabaseClient, url: URL) {
  const fallback = allowedOrigins()[0];
  const state = url.searchParams.get('state') || '';
  const back = (origin: string, result: string, reason = '') =>
    redirect(`${origin}/?instagram=${result}${reason ? `&motivo=${encodeURIComponent(reason)}` : ''}`);

  const { data: pending } = state
    ? await service.from('agency_instagram_oauth_states').select('*').eq('state', state).maybeSingle()
    : { data: null };
  if (pending) await service.from('agency_instagram_oauth_states').delete().eq('state', state);
  if (!pending) return back(fallback, 'erro', 'expirou');
  const origin = String(pending.return_to);
  if (Date.now() - new Date(pending.created_at).getTime() > 15 * 60 * 1000) return back(origin, 'erro', 'expirou');
  if (url.searchParams.get('error')) return back(origin, 'erro', 'cancelado');

  const code = (url.searchParams.get('code') || '').replace(/#_$/, '');
  const appId = Deno.env.get('INSTAGRAM_APP_ID');
  const appSecret = Deno.env.get('INSTAGRAM_APP_SECRET');
  if (!code || !appId || !appSecret) return back(origin, 'erro', 'configuracao');
  const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/agency-videomaker`;

  try {
    const short = unwrap(await graph('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: form({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
    }));
    const permissions = Array.isArray(short.permissions) ? short.permissions.join(',') : String(short.permissions || '');
    if (permissions && !permissions.includes('instagram_business_content_publish')) return back(origin, 'erro', 'permissao');

    const long = await graph(`https://graph.instagram.com/access_token?${form({
      grant_type: 'ig_exchange_token',
      client_secret: appSecret,
      access_token: String(short.access_token),
    })}`);
    const token = String(long.access_token);
    const expiresIn = Number(long.expires_in || 5184000);

    const me = unwrap(await graph(`${GRAPH}/me?${form({ fields: 'user_id,username', access_token: token })}`));
    const igUserId = String(me.user_id || short.user_id || '');
    if (!igUserId) return back(origin, 'erro', 'conta');

    const { error } = await service.from('agency_instagram_accounts').upsert({
      tenant_id: pending.tenant_id,
      unit_id: pending.unit_id,
      ig_user_id: igUserId,
      username: String(me.username || ''),
      access_token: token,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      token_refreshed_at: new Date().toISOString(),
      status: 'ATIVA',
      last_error: null,
      connected_by: pending.user_id,
      connected_by_name: pending.user_name || '',
      connected_at: new Date().toISOString(),
    });
    if (error) return back(origin, 'erro', 'gravar');
    return redirect(`${origin}/?instagram=ok&loja=${encodeURIComponent(String(pending.unit_id))}`);
  } catch (error) {
    console.error('agency-videomaker callback', error instanceof InstagramError ? `${error.info.code} ${error.info.message}` : String(error));
    return back(origin, 'erro', 'instagram');
  }
}

// ---------------- Legenda pela IA ----------------
async function makeCaption(service: SupabaseClient, actor: Record<string, unknown>, video: Video, userId: string) {
  const tenantId = String(actor.tenantId);
  const [{ data: settings }, { data: store }] = await Promise.all([
    service.from('agency_videomaker_settings').select('niche').eq('tenant_id', tenantId).eq('unit_id', video.unit_id).maybeSingle(),
    service.from('store_configs').select('*').eq('tenant_id', tenantId).eq('unit_id', video.unit_id).maybeSingle(),
  ]);
  const storeName = String(store?.trade_name || store?.name || 'Loja BeB Games');
  const instagram = String(store?.instagram || '').replace(/^@/, '').trim();
  const address = String(store?.address || '').trim();
  const duration = Math.round(Number(video.duration_seconds || 0));

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    const caption = [
      '[LEGENDA DE TESTE: a IA ainda não foi ligada]',
      `Vídeo: ${video.file_name} (${duration} s)`,
      video.note ? `Frase do dono: ${video.note}` : 'Frase do dono: nenhuma',
      video.transcript ? `O que foi ouvido: ${video.transcript.slice(0, 300)}` : 'O que foi ouvido: nada (sem fala ou sem transcrição)',
      `Fotos lidas: ${Math.min(video.frame_paths.length, MAX_FRAMES)}`,
      '#teste #kanguru',
    ].join('\n');
    return { caption, source: 'TESTE', model: 'teste', inputTokens: 0, outputTokens: 0, cost: 0 };
  }

  const images: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const path of video.frame_paths.slice(0, MAX_FRAMES)) {
    const { data } = await service.storage.from(BUCKET).download(path);
    if (!data) continue;
    images.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: toBase64(await data.arrayBuffer()) } });
  }

  const text = [
    `LOJA: ${storeName}${instagram ? ` (Instagram @${instagram})` : ''}`,
    `ENDEREÇO DA LOJA: ${address || 'não informado'}`,
    `SOBRE A LOJA E O PÚBLICO: ${String(settings?.niche || '').trim() || 'não informado'}`,
    `FRASE DO DONO SOBRE ESTE VÍDEO: ${video.note?.trim() || 'nenhuma'}`,
    `DURAÇÃO: ${duration} segundos`,
    `TRANSCRIÇÃO DO ÁUDIO: ${video.transcript?.trim().slice(0, 6000) || 'sem fala ou não foi possível ouvir'}`,
    `FOTOS DO VÍDEO: ${images.length} (em ordem, acima)`,
    '',
    'Escreva a legenda deste Reels.',
  ].join('\n');

  const client = new Anthropic({ apiKey });
  const final = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: CAPTION_SYSTEM,
    messages: [{ role: 'user', content: [...images, { type: 'text', text }] }],
  });
  if (final.stop_reason === 'refusal') throw new Error('REFUSAL');

  let caption = final.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
    .replace(/^["“”]+|["“”]+$/g, '')
    .trim();
  if (caption.length > 2200) caption = caption.slice(0, 2200);
  const price = PRICES[final.model] ?? PRICES[MODEL];
  const usage = final.usage;
  const cost = (
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.read +
    (usage.cache_creation_input_tokens ?? 0) * price.write
  ) / 1_000_000;
  return { caption, source: 'IA', model: final.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cost, userId };
}

// ---------------- Publicacao (agendador) ----------------
async function tick(service: SupabaseClient) {
  const summary = { refreshed: 0, expired: 0, containers: 0, published: 0, errors: 0, cleaned: 0 };
  const now = Date.now();
  const accounts = new Map<string, Account | null>();
  const keyOf = (tenant: string, unit: string) => `${tenant}|${unit}`;

  const setVideo = (id: string, fields: Record<string, unknown>) =>
    service.from('agency_videos').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);

  const markAccountExpired = async (account: Account, message: string) => {
    account.status = 'EXPIRADA';
    await service.from('agency_instagram_accounts').update({ status: 'EXPIRADA', last_error: message })
      .eq('tenant_id', account.tenant_id).eq('unit_id', account.unit_id);
    summary.expired += 1;
  };

  // 1. Renova as chaves que vencem em ate 15 dias (a Meta exige chave com 24 h ou mais).
  const soon = new Date(now + 15 * 86400000).toISOString();
  const { data: renewing } = await service.from('agency_instagram_accounts').select('*').eq('status', 'ATIVA').lt('token_expires_at', soon);
  for (const account of (renewing || []) as Account[]) {
    if (new Date(account.token_expires_at).getTime() <= now) {
      await markAccountExpired(account, 'A chave do Instagram venceu. Conecte de novo.');
      continue;
    }
    if (now - new Date(account.token_refreshed_at).getTime() < 86400000) continue;
    try {
      const body = await graph(`https://graph.instagram.com/refresh_access_token?${form({ grant_type: 'ig_refresh_token', access_token: account.access_token })}`);
      await service.from('agency_instagram_accounts').update({
        access_token: String(body.access_token),
        token_expires_at: new Date(now + Number(body.expires_in || 5184000) * 1000).toISOString(),
        token_refreshed_at: new Date().toISOString(),
        last_error: null,
      }).eq('tenant_id', account.tenant_id).eq('unit_id', account.unit_id);
      summary.refreshed += 1;
    } catch (error) {
      const info = error instanceof InstagramError ? error.info : null;
      if (info?.code === 190) await markAccountExpired(account, friendlyInstagram(info));
      else await service.from('agency_instagram_accounts').update({ last_error: info ? friendlyInstagram(info) : 'Falha ao renovar a chave.' })
        .eq('tenant_id', account.tenant_id).eq('unit_id', account.unit_id);
    }
  }

  const accountFor = async (video: Video): Promise<Account | null> => {
    const key = keyOf(video.tenant_id, video.unit_id);
    if (!accounts.has(key)) {
      const { data } = await service.from('agency_instagram_accounts').select('*')
        .eq('tenant_id', video.tenant_id).eq('unit_id', video.unit_id).maybeSingle();
      accounts.set(key, (data as Account) || null);
    }
    return accounts.get(key) ?? null;
  };

  const fail = async (video: Video, message: string) => {
    await setVideo(video.id, { status: 'ERRO', error_message: message.slice(0, 500) });
    summary.errors += 1;
  };

  // Falha temporaria: volta para a fila (ate 3 tentativas); token invalido: conta expirada.
  const handleError = async (video: Video, account: Account | null, error: unknown) => {
    const info = error instanceof InstagramError ? error.info : null;
    console.error('agency-videomaker publish', video.id, info ? `${info.code} ${info.message}` : String(error));
    if (info?.code === 190 && account) await markAccountExpired(account, friendlyInstagram(info));
    if (info?.transient && video.attempts < 3) {
      await setVideo(video.id, { status: 'APROVADO', ig_container_id: null, error_message: null });
      return;
    }
    await fail(video, info ? friendlyInstagram(info) : 'Não foi possível publicar agora. Use "Tentar de novo".');
  };

  const checkContainer = async (video: Video): Promise<boolean> => {
    const account = await accountFor(video);
    if (!account || account.status !== 'ATIVA') {
      await fail(video, 'Instagram não conectado (ou a ligação expirou). O dono precisa clicar em "Conectar Instagram".');
      return true;
    }
    try {
      const status = await graph(`${GRAPH}/${video.ig_container_id}?${form({ fields: 'status_code,status', access_token: account.access_token })}`);
      const code = String(status.status_code || '');
      if (code === 'FINISHED') {
        const published = await graph(`${GRAPH}/${account.ig_user_id}/media_publish`, {
          method: 'POST',
          body: form({ creation_id: String(video.ig_container_id), access_token: account.access_token }),
        });
        const mediaId = String(published.id || '');
        let permalink: string | null = null;
        try {
          const media = await graph(`${GRAPH}/${mediaId}?${form({ fields: 'permalink', access_token: account.access_token })}`);
          permalink = (media.permalink as string) || null;
        } catch {
          // sem o link: o post ja saiu
        }
        await setVideo(video.id, { status: 'PUBLICADO', ig_media_id: mediaId, ig_permalink: permalink, published_at: new Date().toISOString(), error_message: null });
        summary.published += 1;
        return true;
      }
      if (code === 'PUBLISHED') {
        await setVideo(video.id, { status: 'PUBLICADO', published_at: new Date().toISOString(), error_message: null });
        summary.published += 1;
        return true;
      }
      if (code === 'ERROR' || code === 'EXPIRED') {
        await fail(video, `O Instagram não aceitou o vídeo${status.status ? ` (${String(status.status).slice(0, 200)})` : ''}. Confira se é MP4 ou MOV, vertical, de 3 s a 15 min.`);
        return true;
      }
      if (video.publish_started_at && now - new Date(video.publish_started_at).getTime() > 60 * 60 * 1000) {
        await fail(video, 'O Instagram não terminou de processar o vídeo em 1 hora. Use "Tentar de novo".');
        return true;
      }
      return false;
    } catch (error) {
      await handleError(video, account, error);
      return true;
    }
  };

  // 2. Videos ja enviados ao Instagram, esperando o processamento.
  const { data: processing } = await service.from('agency_videos').select('*').eq('status', 'PUBLICANDO').not('ig_container_id', 'is', null);
  for (const video of (processing || []) as Video[]) await checkContainer(video);

  // 3. Rodada anterior caiu no meio do envio.
  const stuckBefore = new Date(now - 15 * 60 * 1000).toISOString();
  const { data: stuck } = await service.from('agency_videos').select('*').eq('status', 'PUBLICANDO').is('ig_container_id', null).lt('publish_started_at', stuckBefore);
  for (const video of (stuck || []) as Video[]) await fail(video, 'O envio ao Instagram foi interrompido. Use "Tentar de novo".');

  // 4. Videos aprovados que chegaram na hora: envia ao Instagram (cria o "conteiner").
  const { data: due, error: dueError } = await service.rpc('agency_videomaker_claim_due');
  if (dueError) console.error('agency-videomaker claim', dueError.message);
  const fresh: Video[] = [];
  for (const video of (due || []) as Video[]) {
    const account = await accountFor(video);
    if (!account || account.status !== 'ATIVA' || new Date(account.token_expires_at).getTime() <= now) {
      await fail(video, 'Instagram não conectado (ou a ligação expirou). O dono precisa clicar em "Conectar Instagram".');
      continue;
    }
    try {
      const { data: signed, error: signError } = await service.storage.from(BUCKET).createSignedUrl(video.storage_path, 6 * 60 * 60);
      if (signError || !signed?.signedUrl) {
        await fail(video, 'O arquivo do vídeo não foi encontrado no Kanguru.');
        continue;
      }
      const container = await graph(`${GRAPH}/${account.ig_user_id}/media`, {
        method: 'POST',
        body: form({ media_type: 'REELS', video_url: signed.signedUrl, caption: video.caption, access_token: account.access_token }),
      });
      video.ig_container_id = String(container.id);
      video.publish_started_at = new Date().toISOString();
      await setVideo(video.id, { ig_container_id: video.ig_container_id });
      summary.containers += 1;
      fresh.push(video);
    } catch (error) {
      await handleError(video, account, error);
    }
  }

  // 5. Espera um pouco o Instagram processar os novos (o resto fica para a proxima rodada).
  let waiting = fresh;
  for (let round = 0; round < 4 && waiting.length > 0; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    const still: Video[] = [];
    for (const video of waiting) if (!(await checkContainer(video))) still.push(video);
    waiting = still;
  }

  // 6. Apaga o arquivo do video 7 dias depois de publicado ou cancelado (fica a 1a foto).
  const oldBefore = new Date(now - 7 * 86400000).toISOString();
  const { data: old } = await service.from('agency_videos').select('id, storage_path, frame_paths, status, published_at, updated_at')
    .is('video_deleted_at', null)
    .or(`and(status.eq.PUBLICADO,published_at.lt.${oldBefore}),and(status.eq.CANCELADO,updated_at.lt.${oldBefore})`)
    .limit(20);
  for (const video of (old || []) as Array<{ id: string; storage_path: string; frame_paths: string[] }>) {
    const frames = video.frame_paths || [];
    const { error } = await service.storage.from(BUCKET).remove([video.storage_path, ...frames.slice(1)]);
    if (error) continue;
    await service.from('agency_videos').update({ video_deleted_at: new Date().toISOString(), frame_paths: frames.slice(0, 1) }).eq('id', video.id);
    summary.cleaned += 1;
  }

  // Pedidos de conexao abandonados.
  await service.from('agency_instagram_oauth_states').delete().lt('created_at', new Date(now - 86400000).toISOString());
  return summary;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'VideoMaker indisponível.' }, 500);
  const service = createClient(supabaseUrl, serviceRoleKey);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.has('state')) return handleCallback(service, url);
    return new Response('VideoMaker Kanguru', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }

  // Agendador do banco (pg_cron): segredo guardado na tabela fechada agency_videomaker_cron.
  const cronHeader = request.headers.get('x-videomaker-cron');
  if (payload.action === 'tick') {
    if (!cronHeader) return json({ error: 'Não autorizado.' }, 401);
    const { data: secretRow } = await service.from('agency_videomaker_cron').select('secret').eq('id', 1).maybeSingle();
    if (!secretRow?.secret || secretRow.secret !== cronHeader) return json({ error: 'Não autorizado.' }, 401);
    try {
      return json({ ok: true, ...(await tick(service)) });
    } catch (error) {
      console.error('agency-videomaker tick', String(error));
      return json({ error: 'Falha na rodada.' }, 500);
    }
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Autenticação obrigatória.' }, 401);
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: 'Sessão inválida ou expirada.' }, 401);
  const userId = userData.user.id;

  const unitId = String(payload.unitId || '');
  if (!unitId) return json({ error: 'Escolha a loja.' }, 400);
  const { data: actor, error: actorError } = await service.rpc('videomaker_actor_of', { p_user: userId, p_unit_id: unitId });
  if (actorError || !actor) {
    const reason = /\((\w+)\)/.exec(actorError?.message || '')?.[1] || '';
    return json({ error: REASON_MESSAGES[reason] || 'Sem acesso ao VideoMaker nesta loja.' }, 403);
  }

  if (payload.action === 'connect') {
    if (!actor.isOwner) return json({ error: 'Só o dono da empresa conecta o Instagram.' }, 403);
    const appId = Deno.env.get('INSTAGRAM_APP_ID');
    if (!appId || !Deno.env.get('INSTAGRAM_APP_SECRET')) {
      return json({ error: 'A ligação com o Instagram ainda não foi configurada pela Kanguru.' }, 503);
    }
    const returnTo = String(payload.returnTo || '').replace(/\/+$/, '');
    if (!allowedOrigins().includes(returnTo)) return json({ error: 'Endereço do ERP não autorizado para o Instagram.' }, 400);
    const state = randomState();
    const { error } = await service.from('agency_instagram_oauth_states').insert({
      state,
      tenant_id: actor.tenantId,
      unit_id: unitId,
      user_id: userId,
      user_name: String(actor.name || ''),
      return_to: returnTo,
    });
    if (error) return json({ error: 'Não foi possível começar a conexão.' }, 500);
    const authorize = new URL('https://www.instagram.com/oauth/authorize');
    authorize.searchParams.set('client_id', appId);
    authorize.searchParams.set('redirect_uri', `${supabaseUrl}/functions/v1/agency-videomaker`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', SCOPES);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('enable_fb_login', 'false');
    authorize.searchParams.set('force_reauth', 'true');
    return json({ url: authorize.toString() });
  }

  if (payload.action === 'caption') {
    if (!actor.captionOk) return json({ error: REASON_MESSAGES[String(actor.reason)] || 'A Agência não pode escrever legendas agora.' }, 403);
    const videoId = String(payload.videoId || '');
    const { data: video } = await service.from('agency_videos').select('*').eq('id', videoId).maybeSingle();
    if (!video || video.tenant_id !== actor.tenantId || video.unit_id !== unitId) return json({ error: 'Vídeo não encontrado.' }, 404);
    if (!EDITABLE.includes(video.status)) return json({ error: 'Este vídeo não pode mais ser alterado.' }, 400);
    try {
      const result = await makeCaption(service, actor, video as Video, userId);
      if (!result.caption) return json({ error: 'A IA não devolveu a legenda. Tente de novo.' }, 502);
      const { data: updated, error: updateError } = await service.from('agency_videos').update({
        caption: result.caption,
        caption_source: result.source,
        caption_at: new Date().toISOString(),
        status: video.status === 'APROVADO' ? 'RASCUNHO' : video.status,
        approved_at: video.status === 'APROVADO' ? null : video.approved_at,
        updated_at: new Date().toISOString(),
      }).eq('id', videoId).in('status', EDITABLE).select('id').maybeSingle();
      if (updateError || !updated) return json({ error: 'O vídeo mudou enquanto a legenda era escrita. Tente de novo.' }, 409);
      await service.from('agency_video_captions').insert({
        tenant_id: actor.tenantId,
        video_id: videoId,
        user_id: userId,
        model: result.model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_usd: Number(result.cost.toFixed(6)),
      });
      return json({ caption: result.caption, source: result.source, used: Number(actor.used) + 1, limit: Number(actor.limit) });
    } catch (error) {
      console.error('agency-videomaker caption', error instanceof Anthropic.APIError ? `${error.status} ${error.name}` : String(error));
      if (error instanceof Error && error.message === 'REFUSAL') return json({ error: 'A IA não pode escrever a legenda deste vídeo. Escreva à mão.' }, 422);
      if (error instanceof Anthropic.RateLimitError) return json({ error: 'Muitos pedidos ao mesmo tempo. Tente de novo em 1 minuto.' }, 429);
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return json({ error: 'A chave da IA não está aceita. Avise o suporte da Kanguru.' }, 502);
      }
      return json({ error: 'Não foi possível escrever a legenda agora. Tente de novo.' }, 502);
    }
  }

  return json({ error: 'Ação inválida.' }, 400);
});
