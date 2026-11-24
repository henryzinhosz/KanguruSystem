import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { History, Loader2, MessageSquarePlus, Send, Sparkles, Trash2 } from 'lucide-react';
import type { Expense, PdvOperator, Product, ProductStoreCost, Sale, StockInventory, StoreConfig, Supplier, User, WorkOrder } from '../../types';
import { DEFAULT_MANAGER_PERMISSIONS, UserRole } from '../../types';
import type { OtherIncome } from '../../db/finance';
import {
  AGENCY_REASON_LABELS,
  AGENCY_TARGET_LABELS,
  askAgency,
  deleteAgencyConversation,
  getAgencyStatus,
  listAgencyConversations,
  listAgencyMessages,
  splitAnswer,
  type AgencyConversation,
  type AgencyRoom,
  type AgencyStatus,
  type AgencyTarget,
} from '../../db/agency';
import type { ErpAlert } from '../../db/insights';
import AgencyOffice, { ROOMS, type RoomState } from './AgencyOffice';
import { buildAgencyContext } from './agencyContext';
import { loadAgencyNotices, type AgencyNotice } from './agencyNotices';

// Agencia de IA (etapa A): escritorio com 6 salas + chat da sala escolhida.
// O agente so sugere; os botoes da resposta so abrem telas do ERP.

const INTROS: Record<AgencyRoom, string> = {
  recepcao: 'Eu dou a visão geral da loja: vendas, lucro, caixa e o que precisa de atenção hoje. Se for assunto de outra sala, eu te indico.',
  marketing: 'Eu crio ideias de post, legendas e promoções para o Instagram e o WhatsApp, usando o que mais vende e o que está parado no estoque.',
  vendas: 'Eu acompanho os vendedores contra a meta, sugiro combos para o balcão e escrevo mensagens para retomar clientes.',
  financeiro: 'Eu explico o dinheiro da loja: saldo das contas, o que está livre depois da reserva dos fornecedores, contas a pagar e o resultado do mês.',
  compras: 'Eu ajudo a decidir o que comprar e de qual fornecedor: o que está acabando, o que mais vende e o que é melhor não comprar agora.',
  atendimento: 'Eu cuido do pós-venda: ordens de serviço, garantias, trocas e respostas prontas para os clientes.',
};

const SUGGESTIONS: Record<AgencyRoom, string[]> = {
  recepcao: ['O que precisa de atenção hoje?', 'Como está o mês até agora?', 'Faça um resumo da semana para eu mandar ao meu sócio'],
  marketing: ['Me dê 3 ideias de post para esta semana', 'Monte uma promoção para os produtos parados', 'Escreva uma legenda para o produto mais vendido'],
  vendas: ['Como estão os vendedores contra a meta?', 'Que combos posso oferecer no balcão?', 'Escreva uma mensagem de WhatsApp para retomar um orçamento'],
  financeiro: ['Explica o meu resultado do mês', 'Posso gastar R$ 5.000 esta semana?', 'Quais contas vencem nos próximos 7 dias?'],
  compras: ['O que preciso comprar esta semana?', 'O que eu NÃO devo comprar agora?', 'Monte uma sugestão de pedido por fornecedor'],
  atendimento: ['Quais ordens de serviço estão atrasadas?', 'Escreva um aviso de aparelho pronto para retirada', 'Como responder um cliente pedindo troca fora do prazo?'],
};

interface ChatLine {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  currentUser: User;
  storeConfigs: StoreConfig[];
  products: Product[];
  inventory: StockInventory[];
  sales: Sale[];
  expenses: Expense[];
  otherIncome: OtherIncome[];
  workOrders: WorkOrder[];
  pdvOperators: PdvOperator[];
  suppliers: Supplier[];
  productStoreCosts: ProductStoreCost[];
  // Avisos do sino "Precisa de atenção" (mesmas regras); a Agência separa por sala.
  alerts: ErpAlert[];
  onNavigate: (target: AgencyTarget) => void;
}

const NOTICE_DOT: Record<AgencyNotice['level'], string> = { alto: '#f87171', medio: '#fbbf24', info: '#60a5fa' };

const errorText = (error: unknown, fallback: string) => (error as { message?: string })?.message || fallback;

function AnswerText({ text }: { text: string }) {
  // Negrito simples (**texto**) e quebras de linha; o resto fica como texto.
  return (
    <>
      {text.split('\n').map((line, index) => (
        <span key={index} className="block min-h-[1em]">
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, partIndex) =>
            part.startsWith('**') && part.endsWith('**')
              ? <strong key={partIndex} className="text-white">{part.slice(2, -2)}</strong>
              : <span key={partIndex}>{part}</span>,
          )}
        </span>
      ))}
    </>
  );
}

export default function AgencyView(props: Props) {
  const { currentUser, storeConfigs, onNavigate } = props;
  const stores = useMemo(() => storeConfigs.filter(store => store.unitId !== 'central'), [storeConfigs]);
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const permissions = currentUser.permissions ?? DEFAULT_MANAGER_PERMISSIONS;
  const canSeeFinance = isAdmin || Boolean(permissions.financeiro);

  // Gerente: Financeiro precisa de Caixa e Contas + Resultados; Compras do Estoque; Atendimento de Servicos.
  const roomAllowed = useCallback((room: AgencyRoom) => {
    if (isAdmin) return true;
    if (room === 'financeiro') return Boolean(permissions.financeiro);
    if (room === 'compras') return Boolean(permissions.estoque);
    if (room === 'atendimento') return Boolean(permissions.servicos);
    return true;
  }, [isAdmin, permissions.financeiro, permissions.estoque, permissions.servicos]);

  const [status, setStatus] = useState<AgencyStatus | null | undefined>(undefined);
  const [room, setRoom] = useState<AgencyRoom>('recepcao');
  const [unitId, setUnitId] = useState(() => {
    const own = stores.find(store => store.unitId === currentUser.unitId);
    return own?.unitId ?? stores[0]?.unitId ?? '';
  });
  const [conversations, setConversations] = useState<AgencyConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notices, setNotices] = useState<AgencyNotice[]>([]);
  const [noticesOpen, setNoticesOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!unitId && stores[0]) setUnitId(stores[0].unitId);
  }, [stores, unitId]);

  // Etapa B: avisos automáticos (sem IA, sem custo, não contam no limite).
  const { alerts, products, inventory, sales, pdvOperators, suppliers } = props;
  useEffect(() => {
    if (!unitId) return;
    let cancelled = false;
    loadAgencyNotices({ unitId, alerts, storeConfigs, products, inventory, sales, pdvOperators, suppliers, canSeeFinance, roomAllowed })
      .then(next => { if (!cancelled) setNotices(next); })
      .catch(() => { if (!cancelled) setNotices([]); });
    return () => { cancelled = true; };
  }, [unitId, alerts, storeConfigs, products, inventory, sales, pdvOperators, suppliers, canSeeFinance, roomAllowed]);

  const badges = useMemo(() => {
    const counts: Partial<Record<AgencyRoom, number>> = {};
    notices.forEach(notice => { counts[notice.room] = (counts[notice.room] ?? 0) + 1; });
    counts.recepcao = notices.length;
    return counts;
  }, [notices]);
  const roomNotices = room === 'recepcao' ? notices : notices.filter(notice => notice.room === room);

  const pickNotice = (notice: AgencyNotice) => {
    if (notice.room !== room) setRoom(notice.room);
    setDraft(notice.question);
    window.setTimeout(() => draftRef.current?.focus(), 50);
  };

  const loadStatus = useCallback(() => {
    getAgencyStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  const loadConversations = useCallback(async (target: AgencyRoom) => {
    try {
      setConversations(await listAgencyConversations(target));
    } catch {
      setConversations([]);
    }
  }, []);

  useEffect(() => {
    setConversationId(null);
    setLines([]);
    setError('');
    setHistoryOpen(false);
    void loadConversations(room);
  }, [room, loadConversations]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  const openConversation = async (conversation: AgencyConversation) => {
    setHistoryOpen(false);
    setError('');
    try {
      const messages = await listAgencyMessages(conversation.id);
      setConversationId(conversation.id);
      setLines(messages.map(message => ({ id: message.id, role: message.role, content: message.content })));
    } catch (loadError) {
      setError(errorText(loadError, 'Não foi possível abrir a conversa.'));
    }
  };

  const newConversation = () => {
    setConversationId(null);
    setLines([]);
    setError('');
    setHistoryOpen(false);
  };

  const removeConversation = async (conversation: AgencyConversation) => {
    if (!window.confirm(`Apagar a conversa "${conversation.title || 'sem título'}"?`)) return;
    try {
      await deleteAgencyConversation(conversation.id);
      if (conversation.id === conversationId) newConversation();
      await loadConversations(room);
    } catch (deleteError) {
      setError(errorText(deleteError, 'Não foi possível apagar a conversa.'));
    }
  };

  const allowed = roomAllowed(room);
  const canAsk = Boolean(status?.ok) && allowed && !sending && Boolean(unitId);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || !canAsk) return;
    setError('');
    setSending(true);
    setDraft('');
    const userLine: ChatLine = { id: `u-${Date.now()}`, role: 'user', content: text };
    const answerId = `a-${Date.now()}`;
    setLines(current => [...current, userLine, { id: answerId, role: 'assistant', content: '' }]);
    const store = stores.find(item => item.unitId === unitId);
    try {
      const context = conversationId
        ? undefined
        : await buildAgencyContext(room, { ...props, unitId, canSeeFinance });
      const result = await askAgency(
        { room, conversationId, message: text, context, scopeLabel: store?.tradeName || unitId },
        partial => setLines(current => current.map(line => (line.id === answerId ? { ...line, content: partial } : line))),
      );
      setLines(current => current.map(line => (line.id === answerId ? { ...line, content: result.text } : line)));
      setConversationId(result.conversationId);
      setStatus(current => (current ? { ...current, used: result.used, ok: result.used < result.limit, reason: result.used < result.limit ? null : 'LIMITE' } : current));
      void loadConversations(room);
    } catch (askError) {
      setLines(current => current.filter(line => line.id !== answerId && line.id !== userLine.id));
      setDraft(text);
      setError(errorText(askError, 'Não foi possível responder agora.'));
      loadStatus();
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void ask(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void ask(draft);
    }
  };

  const states = Object.fromEntries(ROOMS.map(item => [
    item.id,
    !roomAllowed(item.id) ? 'SEM_ACESSO' : item.id === room ? (sending ? 'PENSANDO' : 'EM_CONVERSA') : 'DISPONIVEL',
  ])) as Record<AgencyRoom, RoomState>;

  const panelStatus = !status
    ? { status: 'INDISPONÍVEL', statusColor: '#fca5a5' }
    : status.reason === 'LIMITE'
      ? { status: 'LIMITE DO MÊS', statusColor: '#fca5a5' }
      : status.reason === 'DESLIGADA'
        ? { status: 'DESLIGADA', statusColor: '#fca5a5' }
        : { status: 'OPERANDO', statusColor: '#86efac' };

  const currentRoom = ROOMS.find(item => item.id === room)!;
  const blockedMessage = status === null
    ? 'A Agência ainda não está disponível nesta empresa.'
    : status && !status.ok && status.reason
      ? AGENCY_REASON_LABELS[status.reason]
      : !allowed
        ? 'Esta sala usa dados de uma área que não está liberada para o seu usuário.'
        : '';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2"><Sparkles className="h-5 w-5 text-orange-500" />Agência de IA</h2>
          <p className="text-sm text-slate-500">Seis agentes que leem os dados da sua loja e sugerem o que fazer. Eles nunca lançam, pagam ou enviam nada sozinhos.</p>
        </div>
        {status && (
          <span className="text-xs font-semibold text-slate-500">Perguntas neste mês: <span className="font-mono text-slate-800">{status.used}/{status.limit}</span></span>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-3">
          <AgencyOffice
            selected={room}
            states={states}
            onSelect={setRoom}
            panel={{ used: status?.used ?? 0, limit: status?.limit ?? 0, ...panelStatus }}
            badges={badges}
          />
          <div className="flex flex-wrap gap-2 xl:hidden">
            {ROOMS.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setRoom(item.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${item.id === room ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 bg-white text-slate-600'} ${roomAllowed(item.id) ? '' : 'opacity-50'}`}
              >
                {item.short}{(badges[item.id] ?? 0) > 0 && roomAllowed(item.id) ? <span className="ml-1 rounded bg-rose-600 px-1 text-white">{badges[item.id]}</span> : null}
              </button>
            ))}
          </div>
        </div>

        <section
          aria-label={`Conversa com ${currentRoom.agent}`}
          className="flex min-h-[560px] flex-col overflow-hidden rounded-xl border-2 xl:max-h-[calc(100vh-180px)]"
          style={{ background: '#0f1a2c', borderColor: '#5b7fa8', boxShadow: '4px 4px 0 #070b14', fontFamily: "'Pixelify Sans', ui-monospace, monospace" }}
        >
          <div className="flex items-center justify-between gap-2 border-b-2 px-3 py-2" style={{ background: '#1f2f4b', borderColor: '#5b7fa8' }}>
            <span className="text-sm font-bold text-blue-100">{currentRoom.agent}</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setHistoryOpen(open => !open)} title="Conversas anteriores" aria-label="Conversas anteriores" className="rounded p-1.5 text-blue-200 hover:bg-white/10"><History className="h-4 w-4" /></button>
              <button type="button" onClick={newConversation} title="Nova conversa" aria-label="Nova conversa" className="rounded p-1.5 text-blue-200 hover:bg-white/10"><MessageSquarePlus className="h-4 w-4" /></button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs" style={{ borderColor: '#1f2f4b', fontFamily: 'var(--font-sans)' }}>
            <label className="flex items-center gap-2 text-slate-300">
              Loja
              <select
                value={unitId}
                onChange={event => { setUnitId(event.target.value); newConversation(); }}
                disabled={stores.length <= 1 || sending}
                className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-slate-100"
              >
                {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
              </select>
            </label>
            <span className="text-slate-400">{conversationId ? 'Dados do início desta conversa' : 'Dados atualizados ao enviar a 1ª pergunta'}</span>
          </div>

          {roomNotices.length > 0 && allowed && (
            <div className="border-b px-3 py-2" style={{ borderColor: '#1f2f4b', fontFamily: 'var(--font-sans)' }}>
              <button type="button" onClick={() => setNoticesOpen(open => !open)} className="flex w-full items-center justify-between text-xs font-bold text-amber-200">
                <span>{room === 'recepcao' ? `Avisos de hoje: ${roomNotices.length}` : `Avisos desta sala: ${roomNotices.length}`}</span>
                <span className="text-slate-400">{noticesOpen ? 'esconder' : 'mostrar'}</span>
              </button>
              {noticesOpen && (
                <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto">
                  {roomNotices.map(notice => {
                    const owner = ROOMS.find(item => item.id === notice.room)!;
                    return (
                      <li key={notice.id} className="flex items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-white/5">
                        <span className="mt-1 h-2 w-2 shrink-0" style={{ background: NOTICE_DOT[notice.level] }} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold text-slate-100">{room === 'recepcao' ? `${owner.short}: ` : ''}{notice.title}</span>
                          {notice.detail && <span className="block truncate text-slate-400" title={notice.detail}>{notice.detail}</span>}
                        </span>
                        <button
                          type="button"
                          onClick={() => pickNotice(notice)}
                          disabled={sending}
                          className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-semibold disabled:opacity-50"
                          style={{ background: '#0c1a33', borderColor: '#60a5fa', color: '#bfdbfe' }}
                        >
                          {notice.room === room ? 'Perguntar' : `Ir para ${owner.short}`}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {historyOpen && (
            <div className="max-h-56 overflow-y-auto border-b px-3 py-2" style={{ borderColor: '#1f2f4b', fontFamily: 'var(--font-sans)' }}>
              {conversations.length === 0 && <p className="text-xs text-slate-400">Nenhuma conversa anterior nesta sala.</p>}
              {conversations.map(conversation => (
                <div key={conversation.id} className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs ${conversation.id === conversationId ? 'bg-white/10' : 'hover:bg-white/5'}`}>
                  <button type="button" onClick={() => void openConversation(conversation)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate font-semibold text-slate-100">{conversation.title || 'Sem título'}</span>
                    <span className="text-slate-400">{new Date(conversation.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{conversation.scopeLabel ? ` · ${conversation.scopeLabel}` : ''}</span>
                  </button>
                  <button type="button" onClick={() => void removeConversation(conversation)} title="Apagar" aria-label="Apagar conversa" className="rounded p-1 text-slate-400 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              ))}
            </div>
          )}

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-[13px] leading-relaxed" style={{ fontFamily: 'var(--font-sans)' }}>
            <div>
              <span className="font-bold text-green-300" style={{ fontFamily: "'Pixelify Sans', monospace" }}>{currentRoom.short}:</span>{' '}
              <span className="text-slate-200">{INTROS[room]}</span>
            </div>
            {lines.map(line => {
              if (line.role === 'user') {
                return (
                  <div key={line.id}>
                    <span className="font-bold text-orange-300" style={{ fontFamily: "'Pixelify Sans', monospace" }}>Você:</span>{' '}
                    <span className="whitespace-pre-wrap text-slate-200">{line.content}</span>
                  </div>
                );
              }
              const { body, targets } = splitAnswer(line.content);
              return (
                <div key={line.id}>
                  <span className="font-bold text-green-300" style={{ fontFamily: "'Pixelify Sans', monospace" }}>{currentRoom.short}:</span>
                  <div className="mt-1 text-slate-200">
                    {body ? <AnswerText text={body} /> : <span className="inline-flex items-center gap-2 text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />Lendo os dados da loja...</span>}
                  </div>
                  {targets.length > 0 && !sending && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {targets.map(target => (
                        <button key={target} type="button" onClick={() => onNavigate(target)} className="rounded border-2 px-2 py-1 text-xs font-semibold" style={{ background: '#0c1a33', borderColor: '#60a5fa', color: '#bfdbfe' }}>
                          {AGENCY_TARGET_LABELS[target]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {lines.length === 0 && canAsk && (
              <div className="flex flex-wrap gap-2 pt-1">
                {SUGGESTIONS[room].map(suggestion => (
                  <button key={suggestion} type="button" onClick={() => void ask(suggestion)} className="rounded border-2 px-2 py-1 text-left text-xs font-semibold hover:bg-[#163a2a]" style={{ background: '#0b2418', borderColor: '#4ade80', color: '#bbf7d0' }}>
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>

          {(error || blockedMessage) && (
            <p className="border-t px-3 py-2 text-xs font-semibold text-rose-300" style={{ borderColor: '#1f2f4b', fontFamily: 'var(--font-sans)' }}>{error || blockedMessage}</p>
          )}

          <form onSubmit={onSubmit} className="flex items-end gap-2 border-t px-3 py-3" style={{ borderColor: '#1f2f4b' }}>
            <label className="flex-1">
              <span className="sr-only">Pergunte ao agente</span>
              <textarea
                ref={draftRef}
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                maxLength={2000}
                disabled={!canAsk}
                placeholder={canAsk ? `Pergunte ao ${currentRoom.short}... (Enter envia)` : 'Agência indisponível'}
                className="block w-full resize-none border-2 px-2 py-1.5 text-[13px] text-slate-100 outline-none disabled:opacity-60"
                style={{ background: '#0a1220', borderColor: '#3d4f6b', fontFamily: 'var(--font-sans)' }}
              />
            </label>
            <button type="submit" disabled={!canAsk || !draft.trim()} aria-label="Enviar" className="flex h-10 w-10 items-center justify-center border-2 text-blue-200 disabled:opacity-50" style={{ background: '#1f2f4b', borderColor: '#5b7fa8' }}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </form>
          <p className="px-3 pb-2 text-[11px] text-slate-400" style={{ fontFamily: 'var(--font-sans)' }}>A IA pode errar: confira os números no ERP antes de agir.</p>
        </section>
      </div>
    </div>
  );
}
