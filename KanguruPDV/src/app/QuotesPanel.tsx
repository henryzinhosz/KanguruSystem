import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Copy, ExternalLink, Plus, Printer, Search, ShoppingCart, Trash2, X } from 'lucide-react';
import { searchPosItems, type PosCatalogItem } from '../services/supabase/products';
import type { PosSeller } from '../services/supabase/sellers';
import type { PosStoreProfile } from '../services/supabase/terminal';
import { cardFeeRate, getPosCardFees, type CardFeeTable } from '../services/supabase/sales';
import {
  PART_TYPES,
  cancelQuote,
  convertQuote,
  getQuoteSettings,
  listQuotes,
  saveQuote,
  searchPartSuggestions,
  type PartSuggestion,
  type QuoteConversion,
  type QuoteKind,
  type QuoteLine,
  type QuoteRecord,
  type QuoteSettings,
} from '../services/supabase/quotes';
import ValueInput from './ValueInput';
import { copyText, installmentPlan, printQuote, quoteWhatsappText } from './quotePrint';
import { formatDateOnly } from './workOrderPrint';

// Orcamento de PC: vendedor monta peca por peca com custo + margem, salva setups prontos,
// envia por WhatsApp ou PDF e converte em venda (etapa 2: o PC vira um cadastro com 1 unidade
// no estoque e a venda segue o caixa normal).

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function errorText(error: unknown): string {
  const message = (error as { message?: string })?.message ?? 'Ocorreu um erro inesperado.';
  if (/Manager password is not configured/i.test(message)) return 'Cadastre a senha Gerente da loja no ERP.';
  if (/Could not find the function|does not exist/i.test(message)) return 'Função ainda não liberada: confira se as migrations 20261127 e 20261128 foram aplicadas.';
  return message;
}

function dateAfter(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ageLabel(value: string): string {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  return days <= 0 ? 'hoje' : days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

async function openBoaDica(text: string) {
  if (text.trim()) await copyText(text.trim());
  if (isTauri()) await invoke('open_boadica');
  else window.open('https://www.boadica.com.br/', '_blank', 'noopener');
}

function statusBadge(quote: QuoteRecord) {
  if (quote.status === 'VENDIDO') return <span className="wo-status is-closed">Vendido</span>;
  if (quote.status === 'CONVERTIDO') return <span className="wo-status is-ready">Aguardando pagamento</span>;
  if (quote.isExpired) return <span className="wo-status is-waiting">Vencido</span>;
  return null;
}

interface DraftLine {
  key: number;
  source: 'TYPED' | 'STOCK';
  partType: string;
  description: string;
  productId: string | null;
  sku: string | null;
  quantity: number;
  cost: number | null;
  margin: number | null;
  price: number | null;
}

let nextLineKey = 1;

function lineFromRecord(line: QuoteLine, minMargin: number): DraftLine {
  return {
    key: nextLineKey++,
    source: line.source,
    partType: line.partType,
    description: line.description,
    productId: line.productId,
    sku: line.sku,
    quantity: line.quantity,
    cost: line.unitCost,
    margin: line.marginPercent ?? (line.source === 'TYPED' ? minMargin : null),
    price: line.unitPrice,
  };
}

function blankLine(minMargin: number): DraftLine {
  return { key: nextLineKey++, source: 'TYPED', partType: 'Processador', description: '', productId: null, sku: null, quantity: 1, cost: null, margin: minMargin, price: null };
}

interface QuotesPanelProps {
  seller: PosSeller | null;
  sellerSlot: ReactNode;
  loadStore: () => Promise<PosStoreProfile | null>;
  // Leva o PC (e as pecas do estoque) para o caixa; devolve o erro, se houver.
  onConvert: (conversion: QuoteConversion) => Promise<string | null>;
}

interface EditorProps extends QuotesPanelProps {
  mode: QuoteKind;
  initial: QuoteRecord | null;
  seed: QuoteRecord | null;
  settings: QuoteSettings;
  fees: CardFeeTable | null;
  templates: QuoteRecord[];
  onClose: (message: string | null) => void;
}

function QuoteEditor({ mode, initial, seed, settings, fees, templates, seller, sellerSlot, loadStore, onConvert, onClose }: EditorProps) {
  const origin = initial ?? seed;
  const isTemplate = mode === 'TEMPLATE';
  const [quote, setQuote] = useState<QuoteRecord | null>(initial);
  const [title, setTitle] = useState(origin?.title ?? '');
  const [customerName, setCustomerName] = useState(initial?.customerName ?? '');
  const [customerPhone, setCustomerPhone] = useState(initial?.customerPhone ?? '');
  const [validUntil, setValidUntil] = useState(initial?.validUntil?.slice(0, 10) ?? dateAfter(settings.validDays));
  const [lines, setLines] = useState<DraftLine[]>(() => origin?.items.map((line) => lineFromRecord(line, settings.minMargin)) ?? [blankLine(settings.minMargin)]);
  const [dirty, setDirty] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<{ key: number; items: PartSuggestion[] } | null>(null);
  const [stockQuery, setStockQuery] = useState('');
  const [stockResults, setStockResults] = useState<PosCatalogItem[]>([]);
  const suggestTimer = useRef<number | undefined>(undefined);
  const readOnly = Boolean(quote && quote.status !== 'ABERTO');

  useEffect(() => () => window.clearTimeout(suggestTimer.current), []);

  function patchLine(key: number, patch: Partial<DraftLine>) {
    setDirty(true);
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function changeCost(line: DraftLine, cost: number | null) {
    patchLine(line.key, { cost, price: cost ? round2(cost * (1 + (line.margin ?? 0) / 100)) : line.price });
  }

  function changeMargin(line: DraftLine, margin: number | null) {
    patchLine(line.key, { margin, price: line.cost ? round2(line.cost * (1 + (margin ?? 0) / 100)) : line.price });
  }

  function changePrice(line: DraftLine, price: number | null) {
    patchLine(line.key, { price, margin: line.cost && price ? round2((price / line.cost - 1) * 100) : line.margin });
  }

  function changeDescription(line: DraftLine, description: string) {
    patchLine(line.key, { description });
    window.clearTimeout(suggestTimer.current);
    if (description.trim().length < 3) {
      setSuggest(null);
      return;
    }
    suggestTimer.current = window.setTimeout(() => {
      searchPartSuggestions(description.trim())
        .then((items) => setSuggest(items.length > 0 ? { key: line.key, items } : null))
        .catch(() => setSuggest(null));
    }, 350);
  }

  function pickSuggestion(line: DraftLine, item: PartSuggestion) {
    patchLine(line.key, {
      description: item.name,
      partType: item.partType ?? line.partType,
      cost: item.cost,
      price: round2(item.cost * (1 + (line.margin ?? 0) / 100)),
    });
    setSuggest(null);
  }

  async function searchStock(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    if (!stockQuery.trim()) return;
    try {
      const found = (await searchPosItems(stockQuery.trim())).filter((item) => item.itemType === 'PRODUCT');
      setStockResults(found);
      if (found.length === 0) setError('Nenhum produto encontrado no estoque.');
    } catch (searchError) {
      setError(errorText(searchError));
    }
  }

  function addStock(item: PosCatalogItem) {
    setDirty(true);
    setLines((current) => [...current, {
      key: nextLineKey++, source: 'STOCK', partType: 'Outro', description: item.name, productId: item.id, sku: item.sku,
      quantity: 1, cost: null, margin: null, price: item.sellPrice,
    }]);
    setStockResults([]);
    setStockQuery('');
  }

  function loadTemplate(templateId: string) {
    const template = templates.find((item) => item.quoteId === templateId);
    if (!template) return;
    setDirty(true);
    setTitle(template.title);
    setLines(template.items.map((line) => lineFromRecord(line, settings.minMargin)));
  }

  async function persist(kind: QuoteKind, asNew: boolean, adminPassword: string | null) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await saveQuote({
        quoteId: asNew ? null : quote?.quoteId ?? null,
        kind,
        title,
        customerName: kind === 'QUOTE' ? customerName : '',
        customerPhone: kind === 'QUOTE' ? customerPhone : '',
        sellerCode: kind === 'QUOTE' ? seller?.code ?? null : null,
        validUntil: kind === 'QUOTE' ? validUntil : null,
        installmentMarkup: 0,
        items: lines.map((line) => ({
          partType: line.partType,
          description: line.description,
          productId: line.productId,
          quantity: line.quantity,
          unitCost: line.cost,
          unitPrice: line.price ?? 0,
        })),
        adminPassword,
      });
      if (result.status === 'PASSWORD_REQUIRED') {
        setPassword('');
        setPasswordError(null);
        setPasswordOpen(true);
        return;
      }
      if (result.status === 'INVALID') {
        setPassword('');
        setPasswordError(`Senha Gerente incorreta. Restam ${result.remainingAttempts} tentativa(s).`);
        return;
      }
      if (result.status === 'LOCKED') {
        setPassword('');
        setPasswordError('Senha bloqueada temporariamente por excesso de tentativas.');
        return;
      }
      if (result.status === 'INVALID_SELLER') {
        setError('Informe um código de vendedor válido.');
        setPasswordOpen(false);
        return;
      }
      setPasswordOpen(false);
      setPassword('');
      if (kind === 'TEMPLATE' && mode === 'QUOTE') {
        setMessage(`Setup "${result.quote.title}" salvo.`);
        return;
      }
      setQuote(result.quote);
      setLines(result.quote.items.map((line) => lineFromRecord(line, settings.minMargin)));
      setDirty(false);
      setMessage(kind === 'TEMPLATE' ? 'Setup salvo.' : `Orçamento nº ${result.quote.quoteNumber} salvo.`);
    } catch (saveError) {
      const text = errorText(saveError);
      if (passwordOpen) setPasswordError(text);
      else setError(text);
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    if (!quote) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const conversion = await convertQuote(quote.quoteId);
      setQuote(conversion.quote);
      const problem = await onConvert(conversion);
      if (problem) setError(problem);
    } catch (convertError) {
      setError(errorText(convertError));
    } finally {
      setBusy(false);
    }
  }

  async function copyWhatsapp() {
    if (!quote) return;
    setError(null);
    try {
      await copyText(quoteWhatsappText(quote, await loadStore(), rate));
      setMessage('Texto copiado. É só colar no WhatsApp.');
    } catch (copyError) {
      setError(errorText(copyError));
    }
  }

  async function printPdf() {
    if (!quote) return;
    setError(null);
    try {
      await printQuote(quote, await loadStore(), rate);
    } catch (printError) {
      setError(errorText(printError));
    }
  }

  async function remove() {
    if (!quote) return;
    const question = isTemplate
      ? `Excluir o setup "${quote.title}"?`
      : quote.status === 'CONVERTIDO'
        ? `Desfazer a conversão do orçamento nº ${quote.quoteNumber}? O computador sai do estoque e o orçamento volta a ficar em aberto.`
        : `Cancelar o orçamento nº ${quote.quoteNumber}?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      await cancelQuote(quote.quoteId);
      onClose(isTemplate ? 'Setup excluído.' : quote.status === 'CONVERTIDO' ? 'Conversão desfeita: o orçamento voltou a ficar em aberto.' : 'Orçamento cancelado.');
    } catch (removeError) {
      setError(errorText(removeError));
      setBusy(false);
    }
  }

  const total = round2(lines.reduce((sum, line) => sum + (line.price ?? 0) * line.quantity, 0));
  const typedLines = lines.filter((line) => line.source === 'TYPED');
  const typedPrice = round2(typedLines.reduce((sum, line) => sum + (line.price ?? 0) * line.quantity, 0));
  const typedCost = round2(typedLines.reduce((sum, line) => sum + (line.cost ?? 0) * line.quantity, 0));
  const hasStock = typedLines.length !== lines.length;
  // 12x pela mesma conta da venda: taxa da tabela do ERP repassada ao cliente.
  const rate = cardFeeRate(fees, 'CREDITO', 12);
  const plan = installmentPlan(total, rate);
  const isBelow = (line: DraftLine) => line.source === 'TYPED' && line.partType !== 'Montagem' && Boolean(line.cost)
    && (line.price ?? 0) < round2((line.cost ?? 0) * (1 + settings.minMargin / 100));
  const savedLabel = isTemplate ? 'Setup pronto' : quote ? `Orçamento nº ${quote.quoteNumber}` : 'Novo orçamento';
  const canSell = Boolean(quote) && !dirty && (quote?.status === 'CONVERTIDO' || (quote?.status === 'ABERTO' && !quote.isExpired));

  return (
    <section className="reservations-panel">
      <div className="wo-detail-heading">
        <h1>{savedLabel}</h1>
        {quote && statusBadge(quote)}
        <button className="text-action" type="button" onClick={() => onClose(null)}>Voltar para a lista</button>
      </div>
      {quote?.status === 'CONVERTIDO' && <p className="modal-copy wo-message">Este orçamento já virou um computador no estoque e está aguardando pagamento. Use "Ir para a venda" para cobrar.</p>}
      {quote?.status === 'VENDIDO' && <p className="modal-copy wo-message">Orçamento vendido{quote.soldAt ? ` em ${new Date(quote.soldAt).toLocaleDateString('pt-BR')}` : ''}.</p>}

      <fieldset className="qt-fieldset" disabled={readOnly}>
        <div className="qt-fields">
          <label className="qt-span-2">
            Nome do computador
            <input autoFocus maxLength={120} placeholder="Ex.: Computador Gamer (Intro Plus)" value={title} onChange={(event) => { setTitle(event.target.value); setDirty(true); }} />
          </label>
          {!isTemplate && (
            <>
              <label>Cliente (opcional)<input maxLength={120} value={customerName} onChange={(event) => { setCustomerName(event.target.value); setDirty(true); }} /></label>
              <label>Telefone (opcional)<input maxLength={30} inputMode="tel" value={customerPhone} onChange={(event) => { setCustomerPhone(event.target.value); setDirty(true); }} /></label>
              <label>Válido até<input type="date" value={validUntil} onChange={(event) => { setValidUntil(event.target.value); setDirty(true); }} /></label>
              <div>{sellerSlot}</div>
              {templates.length > 0 && !readOnly && (
                <label className="qt-span-2">
                  Usar setup pronto
                  <select value="" onChange={(event) => loadTemplate(event.target.value)}>
                    <option value="">Escolha para preencher as peças</option>
                    {templates.map((template) => <option key={template.quoteId} value={template.quoteId}>{template.title}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
        </div>

        <div className="qt-table">
          <div className="qt-line qt-head">
            <span>Tipo</span><span>Peça</span><span>Qtd</span><span>Custo</span><span>Margem %</span><span>Preço</span><span />
          </div>
          {lines.map((line) => (
            <div key={line.key} className={`qt-line${isBelow(line) ? ' is-below' : ''}`}>
              <select value={line.partType} onChange={(event) => patchLine(line.key, { partType: event.target.value })}>
                {PART_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <div className="qt-part">
                {line.source === 'STOCK'
                  ? <span className="qt-stock">{line.description}<small>Do estoque · {line.sku}</small></span>
                  : <input maxLength={200} placeholder="Ex.: RTX 4060 8GB Galax" value={line.description} onChange={(event) => changeDescription(line, event.target.value)} />}
                {suggest?.key === line.key && (
                  <div className="wo-service-results qt-suggest">
                    {suggest.items.map((item, index) => (
                      <button key={`${item.source}-${index}`} type="button" onClick={() => pickSuggestion(line, item)}>
                        <span><strong>{item.name}</strong><small>{item.source === 'COTACAO' ? `Última cotação ${ageLabel(item.date)}` : `Fornecedor ${item.supplier ?? ''}`}</small></span>
                        <span>{currency.format(item.cost)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ValueInput decimals={0} aria-label="Quantidade" value={line.quantity} onValueChange={(value) => patchLine(line.key, { quantity: Math.min(99, Math.max(1, value ?? 1)) })} />
              {line.source === 'STOCK'
                ? <><span className="qt-na">—</span><span className="qt-na">—</span><span className="qt-na">{currency.format(line.price ?? 0)}</span></>
                : <>
                    <ValueInput aria-label="Custo" value={line.cost} onValueChange={(value) => changeCost(line, value)} />
                    <ValueInput aria-label="Margem" value={line.margin} onValueChange={(value) => changeMargin(line, value)} />
                    <ValueInput aria-label="Preço" value={line.price} onValueChange={(value) => changePrice(line, value)} />
                  </>}
              <span className="qt-actions">
                {line.source === 'TYPED' && (
                  <button className="icon-button" type="button" title="Copia o nome da peça e abre o Boa Dica" onClick={() => void openBoaDica(line.description).catch((openError) => setError(errorText(openError)))}>
                    <ExternalLink size={16} />
                  </button>
                )}
                <button className="icon-button" type="button" title="Remover linha" onClick={() => { setDirty(true); setLines((current) => current.filter((item) => item.key !== line.key)); }}>
                  <Trash2 size={16} />
                </button>
              </span>
              {isBelow(line) && <small className="field-error qt-below">Abaixo da margem mínima de {settings.minMargin}%: vai pedir a senha Gerente.</small>}
            </div>
          ))}
        </div>

        {!readOnly && (
          <div className="qt-add">
            <button className="text-action" type="button" onClick={() => { setDirty(true); setLines((current) => [...current, blankLine(settings.minMargin)]); }}>
              <Plus size={16} /> Adicionar peça
            </button>
            <form className="wo-service-search" onSubmit={(event) => void searchStock(event)}>
              <input placeholder="Adicionar do estoque (nome ou código)" value={stockQuery} onChange={(event) => setStockQuery(event.target.value)} />
              <button className="icon-button search-button" type="submit" title="Buscar no estoque"><Search size={18} /></button>
            </form>
          </div>
        )}
        {stockResults.length > 0 && (
          <div className="wo-service-results">
            {stockResults.map((item) => (
              <button key={item.id} type="button" onClick={() => addStock(item)}>
                <span><strong>{item.name}</strong><small>{item.sku} · {item.availableQuantity} em estoque</small></span>
                <span>{currency.format(item.sellPrice)} <Plus size={15} /></span>
              </button>
            ))}
          </div>
        )}
      </fieldset>

      <div className="wo-summary qt-summary">
        <div><small>Total à vista</small><strong>{currency.format(total)}</strong></div>
        <div><small>Em 12x no cartão</small><strong>{currency.format(plan.installmentTotal)}</strong><span>12x de {currency.format(plan.installment)} · taxa de {rate.toLocaleString('pt-BR')}% da tabela do ERP</span></div>
        <div><small>Custo{hasStock ? ' das peças digitadas' : ''}</small><strong>{currency.format(typedCost)}</strong></div>
        <div><small>Lucro à vista{hasStock ? ' das peças digitadas' : ''}</small><strong>{currency.format(round2(typedPrice - typedCost))}</strong></div>
      </div>

      {error && <p className="field-error">{error}</p>}
      {message && <p className="modal-copy wo-message">{message}</p>}

      <div className="qt-buttons">
        {!readOnly && (
          <button className="primary-action" type="button" disabled={busy} onClick={() => void persist(mode, false, null)}>
            {busy ? 'Salvando...' : isTemplate ? 'Salvar setup' : 'Salvar orçamento'}
          </button>
        )}
        {!isTemplate && quote?.status !== 'VENDIDO' && (
          <button className="primary-action" type="button" disabled={busy || !canSell} title={dirty ? 'Salve antes de vender' : quote?.isExpired && quote.status === 'ABERTO' ? 'Orçamento vencido: atualize a validade e salve' : undefined} onClick={() => void convert()}>
            <ShoppingCart size={16} /> {quote?.status === 'CONVERTIDO' ? 'Ir para a venda' : 'Converter em venda'}
          </button>
        )}
        {!isTemplate && (
          <>
            <button className="text-action" type="button" disabled={!quote || dirty} title={dirty ? 'Salve antes de enviar' : undefined} onClick={() => void copyWhatsapp()}><Copy size={16} /> Copiar para WhatsApp</button>
            <button className="text-action" type="button" disabled={!quote || dirty} title={dirty ? 'Salve antes de imprimir' : undefined} onClick={() => void printPdf()}><Printer size={16} /> PDF / Imprimir</button>
            {!readOnly && <button className="text-action" type="button" disabled={busy} onClick={() => void persist('TEMPLATE', true, null)}>Salvar como setup pronto</button>}
          </>
        )}
        {quote && quote.status !== 'VENDIDO' && (
          <button className="text-action qt-danger" type="button" disabled={busy} onClick={() => void remove()}>
            {isTemplate ? 'Excluir setup' : quote.status === 'CONVERTIDO' ? 'Desfazer conversão' : 'Cancelar orçamento'}
          </button>
        )}
      </div>

      {passwordOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="qt-password-title" onSubmit={(event) => { event.preventDefault(); void persist(mode, false, password); }}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Margem abaixo do mínimo</p>
                <h2 id="qt-password-title">Senha Gerente</h2>
              </div>
              <button className="icon-button" type="button" title="Fechar" onClick={() => setPasswordOpen(false)}><X size={20} /></button>
            </div>
            <p className="modal-copy">Há peças com margem abaixo de {settings.minMargin}%. Digite a senha Gerente para salvar.</p>
            <label>
              Senha Gerente
              <input type="password" autoFocus autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
              {passwordError && <small className="field-error">{passwordError}</small>}
            </label>
            <div className="modal-actions">
              <button className="text-action" type="button" onClick={() => setPasswordOpen(false)}>Voltar</button>
              <button className="primary-action modal-confirm" type="submit" disabled={busy || !password}>Liberar e salvar</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

type View = { kind: 'list' } | { kind: 'edit'; mode: QuoteKind; initial: QuoteRecord | null; seed: QuoteRecord | null; id: number };

export function QuotesPanel({ seller, sellerSlot, loadStore, onConvert }: QuotesPanelProps) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [tab, setTab] = useState<QuoteKind>('QUOTE');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<QuoteRecord[]>([]);
  const [templates, setTemplates] = useState<QuoteRecord[]>([]);
  const [settings, setSettings] = useState<QuoteSettings | null>(null);
  const [fees, setFees] = useState<CardFeeTable | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const editorId = useRef(0);

  async function refresh(kind: QuoteKind = tab, search = query) {
    setLoading(true);
    setError(null);
    try {
      const [found, allTemplates] = await Promise.all([listQuotes(kind, search), listQuotes('TEMPLATE', '')]);
      setRows(found);
      setTemplates(allTemplates);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getQuoteSettings().then(setSettings).catch((loadError) => setError(errorText(loadError)));
    getPosCardFees().then(setFees).catch(() => setFees(null));
    void refresh('QUOTE', '');
  }, []);

  function open(mode: QuoteKind, initial: QuoteRecord | null, seed: QuoteRecord | null = null) {
    setMessage(null);
    editorId.current += 1;
    setView({ kind: 'edit', mode, initial, seed, id: editorId.current });
  }

  function changeTab(kind: QuoteKind) {
    setTab(kind);
    setQuery('');
    setMessage(null);
    void refresh(kind, '');
  }

  if (view.kind === 'edit' && settings) {
    return (
      <QuoteEditor
        key={view.id}
        mode={view.mode}
        initial={view.initial}
        seed={view.seed}
        settings={settings}
        fees={fees}
        templates={templates}
        seller={seller}
        sellerSlot={sellerSlot}
        loadStore={loadStore}
        onConvert={onConvert}
        onClose={(text) => {
          setMessage(text);
          setView({ kind: 'list' });
          void refresh();
        }}
      />
    );
  }

  const isTemplateTab = tab === 'TEMPLATE';

  return (
    <section className="reservations-panel">
      <div className="wo-detail-heading">
        <h1>Orçamentos de PC</h1>
        <button className="primary-action" type="button" disabled={!settings} onClick={() => open(tab, null)}>
          <Plus size={18} /> {isTemplateTab ? 'Novo setup pronto' : 'Novo orçamento'}
        </button>
      </div>
      <div className="qt-tabs">
        <button type="button" className={!isTemplateTab ? 'is-active' : ''} onClick={() => changeTab('QUOTE')}>Orçamentos</button>
        <button type="button" className={isTemplateTab ? 'is-active' : ''} onClick={() => changeTab('TEMPLATE')}>Setups prontos</button>
      </div>
      <form className="wo-service-search" onSubmit={(event) => { event.preventDefault(); void refresh(); }}>
        <input placeholder={isTemplateTab ? 'Buscar setup pelo nome' : 'Buscar por nº, nome do computador, cliente ou telefone'} value={query} onChange={(event) => setQuery(event.target.value)} />
        <button className="icon-button search-button" type="submit" title="Buscar"><Search size={18} /></button>
      </form>
      {message && <p className="modal-copy wo-message">{message}</p>}
      {error && <p className="field-error">{error}</p>}
      {loading && <p className="modal-copy">Carregando...</p>}
      {!loading && !error && rows.length === 0 && <p className="modal-copy">{isTemplateTab ? 'Nenhum setup pronto salvo.' : 'Nenhum orçamento.'}</p>}
      <div>
        {rows.map((quote) => (
          <div key={quote.quoteId} className="qt-row-wrap">
            <button type="button" className="wo-row" onClick={() => open(tab, quote)}>
              {!isTemplateTab && <span className="wo-row-number">nº {quote.quoteNumber}</span>}
              <span className="wo-row-main">
                <strong>{quote.title}</strong>
                <small>{isTemplateTab ? `${quote.items.length} peça(s)` : [quote.customerName, quote.customerPhone, quote.sellerName].filter(Boolean).join(' · ') || 'Sem cliente informado'}</small>
              </span>
              <span className="wo-row-side">
                <strong>{currency.format(quote.totalPrice)}</strong>
                {!isTemplateTab && (statusBadge(quote) ?? <small>Válido até {formatDateOnly(quote.validUntil)}</small>)}
              </span>
            </button>
            {isTemplateTab && <button className="text-action" type="button" disabled={!settings} onClick={() => open('QUOTE', null, quote)}>Usar em novo orçamento</button>}
          </div>
        ))}
      </div>
    </section>
  );
}
