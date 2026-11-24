import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';

// Agencia de IA (etapa A, migration 20261211). Recebe a pergunta de uma sala do escritorio,
// confere login/permissao/limite no banco, chama a IA com a chave guardada so aqui e devolve
// a resposta aos poucos (SSE). O agente so SUGERE: esta funcao nao grava nada alem da conversa.
//
// O retrato dos dados da loja vem do ERP (as mesmas contas das telas, so com o que o login ja
// enxerga) e fica fixo na conversa. Nunca inclui CPF, telefone, e-mail ou endereco de cliente.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MODEL = 'claude-opus-5-5';
const MAX_QUESTION = 2000;
const MAX_CONTEXT = 40000;
const MAX_QUESTIONS_PER_CONVERSATION = 20;

// US$ por milhao de tokens (pagina oficial de precos, conferida em 2026-11-24).
const PRICES: Record<string, { input: number; output: number; read: number; write: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2, write: 5 },
  'claude-opus-5': { input: 5, output: 25, read: 0.5, write: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, read: 0.5, write: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.1, write: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, read: 0.2, write: 2.5 },
  'claude-fable-5-2': { input: 8, output: 40, read: 0.2, write: 10 },
};

type Room = 'recepcao' | 'marketing' | 'vendas' | 'financeiro' | 'compras' | 'atendimento';

const COMMON = `Você é um agente da "Agência Kanguru", a equipe de inteligência artificial do Kanguru ERP.
Você trabalha para o dono de uma loja de games, informática e acessórios no Brasil (franquia BeB Games): videogames, controles, jogos, PCs montados, peças, acessórios, cartas Pokémon e assistência técnica.

Regras que valem sempre:
- Responda em português do Brasil, com palavras simples, como um funcionário experiente explicando para o dono. Nada de jargão.
- Seja direto: comece pela resposta. Em geral, de 3 a 10 linhas. Use listas curtas com "- " quando ajudar. Não use tabelas nem títulos.
- Use SOMENTE os números que estão em "DADOS DA LOJA". Nunca invente valores, nomes, datas ou produtos. Se um dado não estiver lá, diga que não tem essa informação e em qual tela do ERP ela pode ser vista.
- Valores em reais no formato R$ 1.234,56. Datas no formato dd/mm.
- Você só SUGERE. Você não lança, não paga, não envia mensagens, não posta e não altera nada no sistema. Quando sugerir uma ação, diga qual tela do ERP o dono deve abrir para fazer.
- Quando escrever uma mensagem pronta (WhatsApp, post, legenda), coloque o texto entre aspas para o dono copiar.
- Proteja dados pessoais (LGPD): não peça nem repita CPF, telefone, e-mail ou endereço de clientes.
- Se a pergunta for de outra área, responda o básico e indique a sala certa da Agência: Gerente (Recepção), Marketing, Vendas, Financeiro, Compras ou Atendimento.
- Se a pergunta não tiver nada a ver com a loja, diga com educação que você só ajuda com a loja.

Botões: se fizer sentido o dono abrir uma tela do ERP, termine a resposta com no máximo 2 marcadores, cada um sozinho na última linha, escolhendo entre:
[[abrir:dashboard]] Relatórios Gerais | [[abrir:estoque]] Catálogo & Estoque | [[abrir:servicos]] Serviços / OS | [[abrir:clientes]] Clientes | [[abrir:caixa]] Caixa e Bancos | [[abrir:contas]] Contas a Pagar | [[abrir:areceber]] Contas a Receber | [[abrir:recebimentos]] Recebimentos | [[abrir:resultados]] Indicadores & DRE | [[abrir:fornecedores]] Fornecedores`;

const ROOMS: Record<Room, string> = {
  recepcao: `Sua função: GERENTE DA AGÊNCIA (Recepção).
Você dá a visão geral da loja: como estão as vendas do mês, o lucro, o caixa e o que precisa de atenção hoje.
- Quando perguntarem "o que precisa de atenção", priorize: dinheiro (contas vencidas, caixa apertado), depois clientes esperando (ordens de serviço, reservas), depois estoque.
- Explique em poucas linhas e diga qual sala da Agência resolve cada ponto.`,
  marketing: `Sua função: AGENTE DE MARKETING.
Você cria ideias de posts, legendas, stories, Reels e promoções para o Instagram e o WhatsApp da loja.
- Use os produtos mais vendidos (o que o público quer) e os produtos parados (o que precisa girar).
- Só sugira promoção de produto que tem estoque. Respeite o limite de desconto de cada produto, quando informado.
- Legendas curtas, com chamada para ação ("chama no direct", "passa na loja") e no máximo 3 a 5 hashtags.
- Você ainda não posta sozinho: entregue o texto pronto para o dono copiar.`,
  vendas: `Sua função: AGENTE DE VENDAS.
Você ajuda a vender mais: acompanha os vendedores contra a meta, o ticket médio, os combos e as oportunidades de venda.
- Sugira combos e vendas adicionais típicos de loja de games (console + controle extra, jogo, headset, carregador; PC + monitor, periféricos).
- Quando o dono pedir, escreva mensagens de WhatsApp curtas e simpáticas, sem pressionar o cliente.
- Ao falar dos vendedores, seja justo e prático: reconheça quem está bem e sugira como ajudar quem está abaixo da meta.`,
  financeiro: `Sua função: AGENTE FINANCEIRO.
Você explica o dinheiro da loja: saldo das contas, o que está livre depois da reserva de reposição dos fornecedores, contas a pagar e a receber, previsão de recebimentos e o resultado (DRE).
- Diferencie sempre LUCRO (resultado do mês) de CAIXA (dinheiro disponível). Muita loja lucra e fica sem caixa.
- Para "posso gastar X?", compare com o caixa livre e com as contas que vencem nos próximos dias e diga o risco em uma frase.
- Nunca dê conselho de investimento, empréstimo ou imposto como certeza: para isso, indique o contador.`,
  compras: `Sua função: AGENTE DE COMPRAS.
Você ajuda a decidir o que comprar e de qual fornecedor: produtos acabando, cobertura em dias, mais vendidos e a reserva de reposição de cada fornecedor.
- Sugira quantidades pensando em cerca de 30 dias de venda, sem passar da reserva do fornecedor quando ela for informada.
- Aponte o que NÃO comprar agora (produto parado, estoque alto).
- O pedido de compra é feito pelo dono em Fornecedores › Catálogos e pedidos de compra.`,
  atendimento: `Sua função: AGENTE DE ATENDIMENTO.
Você cuida do pós-venda: ordens de serviço (assistência técnica), garantias, trocas e devoluções e respostas a clientes.
- Escreva respostas educadas e curtas para WhatsApp, explicando prazos e próximos passos.
- Use as regras da loja que vierem nos dados (prazo de troca). Se não tiver a regra, diga para conferir no ERP.
- Ordens de serviço atrasadas ou prontas há muitos dias: sugira avisar o cliente.`,
};

const ROOM_IDS = Object.keys(ROOMS) as Room[];

const REASON_MESSAGES: Record<string, string> = {
  SEM_ACESSO: 'Seu login não tem acesso à Agência.',
  SEM_PERMISSAO: 'O dono da empresa ainda não liberou a Agência para o seu usuário.',
  BLOQUEADO: 'A assinatura da empresa está bloqueada. Fale com o suporte.',
  DESLIGADA: 'A Agência está desligada para esta empresa. Fale com o suporte.',
  LIMITE: 'O limite de perguntas da Agência deste mês acabou. Ele volta no dia 1º.',
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

type Payload = {
  room?: string;
  conversationId?: string | null;
  message?: string;
  context?: string;
  scopeLabel?: string;
};

type MessageRow = { role: 'user' | 'assistant'; content: string; blocks: unknown };

const costOf = (model: string, usage: Anthropic.Beta.BetaUsage) => {
  const price = PRICES[model] ?? PRICES[MODEL];
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return (
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    read * price.read +
    write * price.write
  ) / 1_000_000;
};

// Modo de teste: mostra os dados que a sala recebeu (o que a IA vai ler) e um botao de exemplo.
const TEST_BUTTON: Record<Room, string> = {
  recepcao: 'dashboard',
  marketing: 'estoque',
  vendas: 'dashboard',
  financeiro: 'contas',
  compras: 'estoque',
  atendimento: 'servicos',
};

const testAnswer = (room: Room, question: string, context: string | null) => [
  '**Resposta de teste: a IA ainda não foi ligada.**',
  `Quando a chave da IA for cadastrada no Supabase, este agente vai responder de verdade a: "${question}"`,
  '',
  context
    ? `**Dados que esta sala recebeu (é isso que a IA vai ler):**\n${context}`
    : 'Os dados são os mesmos do início desta conversa.',
  '',
  `[[abrir:${TEST_BUTTON[room]}]]`,
].join('\n');

const friendlyError = (error: unknown) => {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return 'A chave da IA não está aceita. Avise o suporte da Kanguru.';
  }
  if (error instanceof Anthropic.RateLimitError) return 'Muitas perguntas ao mesmo tempo. Tente de novo em 1 minuto.';
  if (error instanceof Anthropic.BadRequestError) return 'A IA recusou a pergunta neste formato. Comece uma nova conversa e tente de novo.';
  if (error instanceof Anthropic.APIConnectionError) return 'Sem conexão com a IA agora. Tente de novo em instantes.';
  if (error instanceof Anthropic.APIError) return 'A IA está instável agora. Tente de novo em instantes.';
  return 'Não foi possível responder agora. Tente de novo.';
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Autenticação obrigatória.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'Agência indisponível.' }, 500);
  // Sem a chave da IA: MODO DE TESTE (resposta simulada, custo zero) para testar a tela inteira.
  const testMode = !apiKey;

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const service = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json({ error: 'Sessão inválida ou expirada.' }, 401);
  const userId = userData.user.id;

  let payload: Payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }

  const room = payload.room as Room;
  if (!ROOM_IDS.includes(room)) return json({ error: 'Sala inválida.' }, 400);
  const question = (payload.message || '').trim();
  if (!question) return json({ error: 'Escreva a pergunta.' }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `A pergunta pode ter até ${MAX_QUESTION} caracteres.` }, 400);

  const { data: access, error: accessError } = await service.rpc('agency_access_of', { p_user: userId });
  if (accessError || !access) return json({ error: 'Não foi possível conferir o acesso à Agência.' }, 500);
  if (!access.ok) return json({ error: REASON_MESSAGES[access.reason as string] || 'Sem acesso à Agência.', reason: access.reason }, 403);
  const tenantId = access.tenantId as string;

  // Conversa: existente (da propria pessoa, mesma sala) ou nova com o retrato dos dados.
  let conversationId = payload.conversationId || null;
  const isNew = !conversationId;
  let context = '';
  let history: MessageRow[] = [];
  if (conversationId) {
    const { data: conversation } = await service
      .from('agency_conversations')
      .select('id, user_id, tenant_id, room, context')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conversation || conversation.user_id !== userId || conversation.tenant_id !== tenantId || conversation.room !== room) {
      return json({ error: 'Conversa não encontrada.' }, 404);
    }
    context = conversation.context;
    const { data: rows, error: rowsError } = await service
      .from('agency_messages')
      .select('role, content, blocks')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (rowsError) return json({ error: 'Não foi possível ler a conversa.' }, 500);
    history = (rows || []) as MessageRow[];
    if (history.filter(row => row.role === 'user').length >= MAX_QUESTIONS_PER_CONVERSATION) {
      return json({ error: 'Esta conversa ficou longa. Comece uma nova conversa (ela também traz os dados atualizados da loja).' }, 400);
    }
  } else {
    context = (payload.context || '').slice(0, MAX_CONTEXT);
    if (!context.trim()) return json({ error: 'Sem dados da loja para a Agência ler.' }, 400);
    const { data: created, error: createError } = await service
      .from('agency_conversations')
      .insert({
        tenant_id: tenantId,
        user_id: userId,
        room,
        title: question.slice(0, 80),
        scope_label: (payload.scopeLabel || '').slice(0, 120),
        context,
      })
      .select('id')
      .single();
    if (createError || !created) return json({ error: 'Não foi possível abrir a conversa.' }, 500);
    conversationId = created.id as string;
  }

  const { data: userRow, error: userRowError } = await service
    .from('agency_messages')
    .insert({ conversation_id: conversationId, tenant_id: tenantId, user_id: userId, role: 'user', content: question })
    .select('id')
    .single();
  if (userRowError || !userRow) return json({ error: 'Não foi possível registrar a pergunta.' }, 500);

  // Historico como foi recebido da IA (blocos completos), so acrescentando no fim.
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map(row =>
    row.role === 'assistant' && Array.isArray(row.blocks)
      ? { role: 'assistant', content: row.blocks as Anthropic.Beta.BetaContentBlockParam[] }
      : { role: row.role, content: row.content },
  );
  messages.push({ role: 'user', content: question });

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: `${COMMON}\n\n${ROOMS[room]}` },
    { type: 'text', text: `Você está falando com: ${access.displayName}.\n\nDADOS DA LOJA (retrato do início desta conversa):\n${context}` },
  ];

  const client = testMode ? null : new Anthropic({ apiKey });
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: Record<string, unknown>) =>
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Falhou: a pergunta nao conta e some (conversa nova inteira some junto).
      const dropQuestion = async () => {
        if (isNew) await service.from('agency_conversations').delete().eq('id', conversationId);
        else await service.from('agency_messages').delete().eq('id', userRow.id);
      };
      try {
        send(controller, 'start', {});

        if (!client) {
          const text = testAnswer(room, question, isNew ? context : null);
          const parts = text.match(/[\s\S]{1,160}/g) || [text];
          for (const part of parts) {
            send(controller, 'delta', { text: part });
            await new Promise(resolve => setTimeout(resolve, 15));
          }
          const { data: answerRow } = await service
            .from('agency_messages')
            .insert({
              conversation_id: conversationId,
              tenant_id: tenantId,
              user_id: userId,
              role: 'assistant',
              content: text,
              blocks: null,
              model: 'teste',
              cost_usd: 0,
            })
            .select('id')
            .single();
          await service.from('agency_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
          send(controller, 'done', {
            conversationId,
            messageId: answerRow?.id ?? null,
            text,
            used: Number(access.used) + 1,
            limit: Number(access.limit),
          });
          return;
        }

        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 6000,
          betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          system,
          messages,
        });
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            send(controller, 'delta', { text: event.delta.text });
          }
        }
        const final = await stream.finalMessage();

        if (final.stop_reason === 'refusal') {
          await dropQuestion();
          send(controller, 'error', { message: 'A IA não pode ajudar com esse pedido. Tente perguntar de outro jeito.' });
          return;
        }

        let text = final.content
          .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
          .map(block => block.text)
          .join('')
          .trim();
        if (final.stop_reason === 'max_tokens') text += '\n\n(A resposta ficou longa e foi cortada. Peça para continuar.)';

        const cost = costOf(final.model, final.usage);
        const { data: answerRow } = await service
          .from('agency_messages')
          .insert({
            conversation_id: conversationId,
            tenant_id: tenantId,
            user_id: userId,
            role: 'assistant',
            content: text,
            blocks: final.content,
            model: final.model,
            input_tokens: final.usage.input_tokens,
            output_tokens: final.usage.output_tokens,
            cache_read_tokens: final.usage.cache_read_input_tokens ?? 0,
            cache_write_tokens: final.usage.cache_creation_input_tokens ?? 0,
            cost_usd: Number(cost.toFixed(6)),
          })
          .select('id')
          .single();
        await service.from('agency_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);

        send(controller, 'done', {
          conversationId,
          messageId: answerRow?.id ?? null,
          text,
          used: Number(access.used) + 1,
          limit: Number(access.limit),
        });
      } catch (error) {
        console.error('agency-chat', error instanceof Anthropic.APIError ? `${error.status} ${error.name}` : String(error));
        await dropQuestion();
        send(controller, 'error', { message: friendlyError(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { ...corsHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
});
