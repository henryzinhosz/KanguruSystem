import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ClipboardCheck, Printer, ScanLine, Trash2 } from 'lucide-react';
import { Product, ProductStoreCost, StockCount, StockInventory, StoreConfig, User, UserRole } from '../types';
import { supabaseService } from '../db/supabaseService';
import { formatMoney } from '../db/finance';
import ValueInput from './ValueInput';
import {
  STOCK_COUNT_STATUS_LABELS,
  buildStockCountReport,
  printStockCount,
  productsInScope,
  StockCountReportData,
} from './stockCountReport';

// Balanco em formato de checklist: abrir (loja inteira ou categorias), bipar/digitar o que
// encontra, ver na hora o que bateu, falta ou sobra, e no fim salvar so o relatorio ou
// aprovar (ADMIN) para o ERP ajustar o estoque.

interface BalancoPanelProps {
  currentUser: User;
  products: Product[];
  inventory: StockInventory[];
  storeConfigs: StoreConfig[];
  productStoreCosts: ProductStoreCost[];
  onStockChanged: () => Promise<void>;
}

type Filter = 'todos' | 'nao_contados' | 'diferenca';

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || fallback;

const STATUS_STYLES: Record<StockCount['status'], string> = {
  ABERTO: 'bg-blue-50 text-blue-700 border-blue-200',
  SALVO: 'bg-amber-50 text-amber-800 border-amber-200',
  APROVADO: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CANCELADO: 'bg-slate-100 text-slate-500 border-slate-200',
};

export function StockCountReportView({ report }: { report: StockCountReportData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        <div className="p-3 rounded-lg border border-slate-200 bg-slate-50"><span className="block text-[10px] font-bold uppercase text-slate-400">Produtos contados</span><span className="text-lg font-extrabold text-slate-900">{report.rows.length}</span></div>
        <div className="p-3 rounded-lg border border-rose-200 bg-rose-50"><span className="block text-[10px] font-bold uppercase text-rose-500">Faltas</span><span className="text-lg font-extrabold text-rose-700">{report.missingUnits} un · {formatMoney(report.missingValue)}</span></div>
        <div className="p-3 rounded-lg border border-amber-200 bg-amber-50"><span className="block text-[10px] font-bold uppercase text-amber-600">Sobras</span><span className="text-lg font-extrabold text-amber-800">{report.extraUnits} un · {formatMoney(report.extraValue)}</span></div>
        <div className="p-3 rounded-lg border border-slate-200 bg-slate-50"><span className="block text-[10px] font-bold uppercase text-slate-400">Saldo (custo)</span><span className={`text-lg font-extrabold ${report.missingValue + report.extraValue < 0 ? 'text-rose-700' : 'text-slate-900'}`}>{formatMoney(report.missingValue + report.extraValue)}</span></div>
      </div>
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
            <tr><th className="p-2.5">Produto</th><th className="p-2.5 text-center">Sistema</th><th className="p-2.5 text-center">Contado</th><th className="p-2.5 text-center">Diferença</th><th className="p-2.5 text-right">Valor (custo)</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {report.rows.map(row => (
              <tr key={row.product.id} className={row.diff < 0 ? 'bg-rose-50/50' : row.diff > 0 ? 'bg-amber-50/50' : ''}>
                <td className="p-2.5">
                  <span className="font-mono text-slate-400 mr-1.5">{row.product.sku}</span>
                  <span className="font-medium text-slate-900">{row.product.name}</span>
                  {row.missingSerials.length > 0 && <span className="block text-[11px] text-rose-700">Faltaram: {row.missingSerials.join(', ')}</span>}
                  {row.reservedMissing.length > 0 && <span className="block text-[11px] text-amber-700">Reservados não encontrados: {row.reservedMissing.join(', ')}</span>}
                  {row.extraSerials.length > 0 && <span className="block text-[11px] text-amber-700">Fora do sistema: {row.extraSerials.join(', ')}</span>}
                </td>
                <td className="p-2.5 text-center">{row.systemQty}</td>
                <td className="p-2.5 text-center font-bold">{row.countedQty}</td>
                <td className={`p-2.5 text-center font-bold ${row.diff < 0 ? 'text-rose-700' : row.diff > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{row.diff === 0 ? '✓' : `${row.diff > 0 ? '+' : ''}${row.diff}`}</td>
                <td className="p-2.5 text-right font-mono">{formatMoney(row.diffValue)}</td>
              </tr>
            ))}
            {report.rows.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-400">Nenhum produto contado.</td></tr>}
          </tbody>
        </table>
      </div>
      {report.notCounted.length > 0 && (
        <div className="text-xs">
          <p className="font-bold text-slate-700 mb-1">Não contados ({report.notCounted.length}): ignorados no ajuste</p>
          <p className="text-slate-500">{report.notCounted.map(entry => `${entry.product.name} (${entry.qty})`).join(' · ')}</p>
        </div>
      )}
    </div>
  );
}

export default function BalancoPanel({ currentUser, products, inventory, storeConfigs, productStoreCosts, onStockChanged }: BalancoPanelProps) {
  const isAdmin = currentUser.role === UserRole.ADMIN;
  const canChooseStore = currentUser.unitId === 'central';
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;
  const categories = useMemo(() => Array.from(new Set(products.map(product => product.category))).sort(), [products]);

  const [counts, setCounts] = useState<StockCount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newStore, setNewStore] = useState(canChooseStore ? '' : currentUser.unitId);
  const [wholeStore, setWholeStore] = useState(true);
  const [newCategories, setNewCategories] = useState<string[]>([]);
  const [serials, setSerials] = useState<{ productId: string; serial: string; status: string }[]>([]);
  const [scan, setScan] = useState('');
  const [filter, setFilter] = useState<Filter>('todos');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, number | null>>({});
  const [serialDrafts, setSerialDrafts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    try {
      setCounts(await supabaseService.getStockCounts());
    } catch (loadError) {
      setError(errorText(loadError, 'Não foi possível carregar os balanços.'));
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!newStore && stores.length) setNewStore(stores[0].unitId);
  }, [storeConfigs]);

  const count = counts.find(item => item.id === selectedId) ?? null;
  useEffect(() => {
    if (!count) return;
    supabaseService.getStoreSerials(count.unitId).then(setSerials).catch(() => setSerials([]));
    setNotes(count.notes ?? '');
  }, [count?.id]);

  const report = useMemo(
    () => (count ? buildStockCountReport(count, products, inventory, productStoreCosts) : null),
    [count, products, inventory, productStoreCosts],
  );

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await load();
      if (success) setMessage(success);
    } catch (actionError) {
      setError(errorText(actionError, 'Não foi possível concluir.'));
    } finally {
      setBusy(false);
    }
  }

  const start = (event: FormEvent) => {
    event.preventDefault();
    if (!newStore) return;
    if (!wholeStore && newCategories.length === 0) {
      setError('Escolha ao menos uma categoria ou marque "Loja inteira".');
      return;
    }
    void run(async () => {
      const id = await supabaseService.startStockCount(newStore, wholeStore ? null : newCategories);
      setSelectedId(id);
      setFilter('todos');
    }, 'Balanço aberto. Bipe ou digite as quantidades encontradas.');
  };

  // --- Tela de um balanco ---
  if (count && report) {
    const open = count.status === 'ABERTO';
    const scope = productsInScope(products, count.categories);
    const itemOf = (productId: string) => count.items.find(item => item.productId === productId);
    const currentQty = (productId: string) => inventory.find(inv => inv.productId === productId)?.quantities[count.unitId]?.qty ?? 0;

    const record = (product: Product, qty: number, productSerials: string[]) =>
      run(() => supabaseService.recordStockCountItem(count.id, product.id, qty, productSerials));

    const addSerial = (product: Product, raw: string) => {
      const serial = raw.trim().toUpperCase();
      if (!serial) return;
      const item = itemOf(product.id);
      const current = item?.countedSerials ?? [];
      if (current.includes(serial)) {
        setMessage(`Serial ${serial} já foi contado.`);
        return;
      }
      void record(product, 0, [...current, serial]);
    };

    const handleScan = (event: FormEvent) => {
      event.preventDefault();
      const code = scan.trim().toUpperCase();
      setScan('');
      if (!code) return;
      const bySerial = serials.find(entry => entry.serial === code);
      if (bySerial) {
        const product = scope.find(entry => entry.id === bySerial.productId);
        if (!product) {
          setError(`Serial ${code} é de um produto fora deste balanço.`);
          return;
        }
        addSerial(product, code);
        return;
      }
      const product = scope.find(entry => entry.sku.toUpperCase() === code);
      if (!product) {
        setError(`Código ${code} não encontrado nas categorias deste balanço. Serial fora do sistema: abra o produto na lista e adicione o serial à mão.`);
        return;
      }
      if (product.isSerialized) {
        setError(`${product.name} tem número de série: bipe o serial de cada unidade.`);
        return;
      }
      void record(product, (itemOf(product.id)?.countedQty ?? 0) + 1, []);
    };

    const text = search.trim().toLowerCase();
    const visible = scope
      .filter(product => !text || product.name.toLowerCase().includes(text) || product.sku.toLowerCase().includes(text))
      .filter(product => {
        const item = itemOf(product.id);
        if (filter === 'nao_contados') return !item && currentQty(product.id) > 0;
        if (filter === 'diferenca') return item ? item.countedQty !== item.systemQty || item.systemSerials.some(serial => !item.countedSerials.includes(serial)) : false;
        return item || currentQty(product.id) > 0;
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setSelectedId(null)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-600" title="Voltar"><ArrowLeft className="w-4 h-4" /></button>
          <div className="mr-auto">
            <h3 className="text-sm font-bold text-slate-900">Balanço nº {count.countNumber} · {storeName(count.unitId)}</h3>
            <p className="text-xs text-slate-500">{count.categories ? count.categories.join(', ') : 'Loja inteira'} · aberto em {new Date(count.createdAt).toLocaleString('pt-BR')}{count.createdByName ? ` por ${count.createdByName}` : ''}</p>
          </div>
          <span className={`px-2 py-1 rounded border text-[10px] font-bold ${STATUS_STYLES[count.status]}`}>{STOCK_COUNT_STATUS_LABELS[count.status]}</span>
          <button type="button" onClick={() => printStockCount(count, report, storeName(count.unitId), stores.find(store => store.unitId === count.unitId)?.legalName || '')} className="px-3 py-2 text-xs font-bold border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5"><Printer className="w-4 h-4" />Imprimir</button>
        </div>

        {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
        {message && <p role="status" className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{message}</p>}

        {open ? (
          <>
            <form onSubmit={handleScan} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-3">
              <ScanLine className="w-5 h-5 text-blue-600 shrink-0" />
              <input autoFocus value={scan} onChange={event => setScan(event.target.value)} placeholder="Bipe o código do produto (cada bipada soma 1) ou o número de série e aperte Enter" className="flex-1 bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-sm outline-none" />
              <button type="submit" disabled={busy} className="px-3 py-2.5 bg-blue-600 text-white text-xs font-bold rounded-lg disabled:opacity-60">Contar</button>
            </form>

            <div className="flex flex-wrap items-center gap-2">
              {([['todos', 'Todos'], ['nao_contados', 'Não contados'], ['diferenca', 'Com diferença']] as const).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setFilter(id)} className={`px-3 py-1.5 text-xs font-bold rounded-lg border ${filter === id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>{label}</button>
              ))}
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar produto" className="ml-auto bg-white border border-slate-200 rounded-lg p-2 text-xs outline-none w-56" />
              <span className="text-xs text-slate-500">{count.items.length} contado(s)</span>
            </div>

            <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
                  <tr><th className="p-2.5">Produto</th><th className="p-2.5 text-center">Sistema</th><th className="p-2.5 text-center">Contado</th><th className="p-2.5 text-center">Situação</th><th className="p-2.5 text-right"></th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map(product => {
                    const item = itemOf(product.id);
                    const system = item ? item.systemQty : currentQty(product.id);
                    const counted = item?.countedQty ?? null;
                    const diff = item ? item.countedQty - item.systemQty : null;
                    const missing = item ? item.systemSerials.filter(serial => !item.countedSerials.includes(serial)) : [];
                    const status = !item ? '⏳ Não contado' : diff === 0 && missing.length === 0 ? '✅ Bateu' : (diff ?? 0) < 0 || missing.length ? `🔴 Falta ${Math.max(-(diff ?? 0), missing.length)}` : `🟡 Sobra ${diff}`;
                    return (
                      <tr key={product.id} className="align-top">
                        <td className="p-2.5">
                          <span className="font-mono text-slate-400 mr-1.5">{product.sku}</span>
                          <span className="font-medium text-slate-900">{product.name}</span>
                          {product.isSerialized && (
                            <div className="mt-1.5 space-y-1">
                              {(item?.countedSerials ?? []).length > 0 && <p className="text-[11px] text-slate-600">Bipados: {item!.countedSerials.join(', ')}</p>}
                              {missing.length > 0 && <p className="text-[11px] text-rose-700">Faltando: {missing.join(', ')}</p>}
                              <div className="flex gap-1.5">
                                <input
                                  value={serialDrafts[product.id] ?? ''}
                                  onChange={event => setSerialDrafts(previous => ({ ...previous, [product.id]: event.target.value }))}
                                  onKeyDown={event => {
                                    if (event.key !== 'Enter') return;
                                    event.preventDefault();
                                    addSerial(product, serialDrafts[product.id] ?? '');
                                    setSerialDrafts(previous => ({ ...previous, [product.id]: '' }));
                                  }}
                                  placeholder="Serial (Enter)"
                                  className="bg-slate-50 border border-slate-200 rounded p-1.5 text-[11px] font-mono outline-none w-44"
                                />
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="p-2.5 text-center">{system}</td>
                        <td className="p-2.5 text-center">
                          {product.isSerialized ? (
                            <span className="font-bold">{counted ?? '—'}</span>
                          ) : (
                            <ValueInput
                              decimals={0}
                              value={product.id in drafts ? drafts[product.id] : counted}
                              onValueChange={value => setDrafts(previous => ({ ...previous, [product.id]: value }))}
                              onBlur={() => {
                                if (!(product.id in drafts)) return;
                                const value = drafts[product.id];
                                setDrafts(previous => {
                                  const next = { ...previous };
                                  delete next[product.id];
                                  return next;
                                });
                                if (value !== null && value !== counted) void record(product, value, []);
                              }}
                              placeholder="—"
                              className="w-16 text-center bg-slate-50 border border-slate-200 rounded p-1.5 outline-none"
                            />
                          )}
                        </td>
                        <td className="p-2.5 text-center font-semibold whitespace-nowrap">{status}</td>
                        <td className="p-2.5 text-right">
                          {item && (
                            <button type="button" title="Tirar da contagem" onClick={() => void run(() => supabaseService.removeStockCountItem(count.id, product.id))} className="p-1.5 text-rose-600 rounded hover:bg-rose-50"><Trash2 className="w-4 h-4" /></button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {visible.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-400">Nada para mostrar neste filtro.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <StockCountReportView report={report} />
        )}

        {(count.status === 'ABERTO' || count.status === 'SALVO') && (
          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
            {open && (
              <label className="block text-xs font-bold text-slate-700">Observação (opcional)
                <input value={notes} onChange={event => setNotes(event.target.value)} className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none font-normal" />
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => { if (window.confirm('Cancelar este balanço? Nada no estoque muda.')) void run(() => supabaseService.cancelStockCount(count.id), 'Balanço cancelado.'); }} className="px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50 rounded-lg">Cancelar balanço</button>
              {open && (
                <button type="button" disabled={busy} onClick={() => void run(() => supabaseService.saveStockCount(count.id, notes), 'Relatório salvo. O estoque não foi alterado.')} className="ml-auto px-3 py-2 text-xs font-bold border border-slate-300 rounded-lg hover:bg-slate-50">Salvar relatório (sem ajustar)</button>
              )}
              {isAdmin && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Aprovar o balanço nº ${count.countNumber}? O estoque da loja será ajustado: faltas ${report.missingUnits} un (${formatMoney(report.missingValue)}), sobras ${report.extraUnits} un (${formatMoney(report.extraValue)}). Não contados ficam como estão.`)) return;
                    void run(async () => {
                      const adjusted = await supabaseService.approveStockCount(count.id);
                      await onStockChanged();
                      setMessage(`Balanço aprovado: ${adjusted} produto(s) ajustado(s) no estoque.`);
                    });
                  }}
                  className={`${open ? '' : 'ml-auto '}px-3 py-2 bg-emerald-600 text-white text-xs font-bold rounded-lg hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-1.5`}
                >
                  <ClipboardCheck className="w-4 h-4" />Aprovar e ajustar estoque
                </button>
              )}
            </div>
            {!isAdmin && <p className="text-[11px] text-slate-500">Só o administrador aprova o ajuste do estoque. Salve o relatório para ele conferir.</p>}
          </div>
        )}
      </div>
    );
  }

  // --- Lista e novo balanco ---
  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {message && <p role="status" className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{message}</p>}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-5">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
              <tr><th className="p-3">Nº</th><th className="p-3">Loja</th><th className="p-3">Escopo</th><th className="p-3">Aberto em</th><th className="p-3 text-center">Contados</th><th className="p-3">Situação</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {counts.map(item => (
                <tr key={item.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => { setSelectedId(item.id); setError(''); setMessage(''); }}>
                  <td className="p-3 font-mono font-bold">{item.countNumber}</td>
                  <td className="p-3">{storeName(item.unitId)}</td>
                  <td className="p-3 text-slate-600">{item.categories ? item.categories.join(', ') : 'Loja inteira'}</td>
                  <td className="p-3 text-slate-600">{new Date(item.createdAt).toLocaleString('pt-BR')}</td>
                  <td className="p-3 text-center">{item.items.length}</td>
                  <td className="p-3"><span className={`px-2 py-1 rounded border text-[10px] font-bold ${STATUS_STYLES[item.status]}`}>{STOCK_COUNT_STATUS_LABELS[item.status]}</span></td>
                </tr>
              ))}
              {counts.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Nenhum balanço ainda.</td></tr>}
            </tbody>
          </table>
        </div>

        <form onSubmit={start} className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 h-fit">
          <h3 className="text-sm font-bold text-slate-900">Novo balanço</h3>
          {canChooseStore && (
            <label className="block text-xs font-bold text-slate-700">Loja
              <select value={newStore} onChange={event => setNewStore(event.target.value)} className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none font-normal">
                {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-xs font-bold text-slate-700">
            <input type="checkbox" checked={wholeStore} onChange={event => setWholeStore(event.target.checked)} className="w-4 h-4" />
            Loja inteira
          </label>
          {!wholeStore && (
            <div className="grid grid-cols-2 gap-1.5">
              {categories.map(category => (
                <label key={category} className="flex items-center gap-1.5 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={newCategories.includes(category)}
                    onChange={event => setNewCategories(previous => event.target.checked ? [...previous, category] : previous.filter(item => item !== category))}
                  />
                  {category}
                </label>
              ))}
            </div>
          )}
          <p className="text-[11px] text-slate-500">Não precisa fechar a loja: o sistema anota o estoque de cada produto no momento em que ele é contado. Dá para pausar e continuar depois.</p>
          <button type="submit" disabled={busy || !newStore} className="w-full px-3 py-2.5 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-60">Abrir balanço</button>
        </form>
      </div>
    </div>
  );
}

// Relatorios Gerais › Produtos: balancos salvos e aprovados (consultar e imprimir).
export function BalancosReportPanel({ products, inventory, storeConfigs, productStoreCosts, activeUnitId }: {
  products: Product[];
  inventory: StockInventory[];
  storeConfigs: StoreConfig[];
  productStoreCosts: ProductStoreCost[];
  activeUnitId: string;
}) {
  const stores = storeConfigs.filter(store => store.unitId !== 'central');
  const [counts, setCounts] = useState<StockCount[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    supabaseService.getStockCounts().then(setCounts).catch(() => setCounts([]));
  }, []);
  const visible = counts.filter(count => (count.status === 'SALVO' || count.status === 'APROVADO') && (activeUnitId === 'consolidado' || count.unitId === activeUnitId));
  const storeName = (unitId: string) => stores.find(store => store.unitId === unitId)?.tradeName || unitId;
  return (
    <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
      <div>
        <h4 className="text-sm font-bold text-slate-900 font-sans uppercase tracking-wider">Balanços</h4>
        <p className="text-xs text-slate-400">Relatórios salvos e balanços aprovados. Para contar, use Catálogo & Estoque › Balanço.</p>
      </div>
      <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
        {visible.map(count => {
          const report = buildStockCountReport(count, products, inventory, productStoreCosts);
          return (
            <div key={count.id} className="p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="font-mono font-bold">Nº {count.countNumber}</span>
                <span className="text-slate-700">{storeName(count.unitId)}</span>
                <span className="text-slate-500">{new Date(count.approvedAt || count.savedAt || count.createdAt).toLocaleDateString('pt-BR')}</span>
                <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${STATUS_STYLES[count.status]}`}>{STOCK_COUNT_STATUS_LABELS[count.status]}</span>
                <span className="text-rose-700 font-semibold">Faltas {formatMoney(report.missingValue)}</span>
                <span className="text-amber-700 font-semibold">Sobras {formatMoney(report.extraValue)}</span>
                <button type="button" onClick={() => setOpenId(openId === count.id ? null : count.id)} className="ml-auto px-2.5 py-1 font-bold border border-slate-200 rounded hover:bg-slate-50">{openId === count.id ? 'Fechar' : 'Ver'}</button>
                <button type="button" onClick={() => printStockCount(count, report, storeName(count.unitId), stores.find(store => store.unitId === count.unitId)?.legalName || '')} className="px-2.5 py-1 font-bold border border-slate-200 rounded hover:bg-slate-50 flex items-center gap-1"><Printer className="w-3.5 h-3.5" />Imprimir</button>
              </div>
              {openId === count.id && <StockCountReportView report={report} />}
            </div>
          );
        })}
        {visible.length === 0 && <p className="p-6 text-center text-xs text-slate-400">Nenhum balanço salvo ou aprovado.</p>}
      </div>
    </div>
  );
}
