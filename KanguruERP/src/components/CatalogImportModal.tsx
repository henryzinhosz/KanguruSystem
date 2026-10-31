import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, X } from 'lucide-react';
import {
  COLUMN_ROLE_LABELS,
  CatalogReadingConfig,
  ColumnRole,
  ParsedCatalogItem,
  SheetReadingConfig,
  normalizeText,
  parseCatalog,
} from '../db/supplierCatalogParser';
import type { SupplierCatalogItem } from '../db/supplierCatalogs';
import { formatMoney } from '../db/finance';

// Conferencia da planilha do fornecedor: mostra o que a leitura automatica entendeu e
// deixa corrigir (colunas, marca da aba, nomes de marca e tipo). O que for corrigido fica
// salvo junto do catalogo e vale para a proxima planilha.

interface CatalogImportModalProps {
  supplierName: string;
  fileName: string;
  workbook: Record<string, unknown[][]>;
  savedConfig: CatalogReadingConfig | null;
  existingItems: SupplierCatalogItem[];
  onCancel: () => void;
  onImport: (config: CatalogReadingConfig, items: ParsedCatalogItem[]) => Promise<void>;
}

type PreviewFilter = 'todos' | 'avisos' | 'novos' | 'preco';

const ROLES: ColumnRole[] = ['code', 'name', 'brand', 'type', 'status', 'priceNoIpi', 'priceIpi', 'ipi', 'discount', 'finalPrice'];

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function CatalogImportModal({ supplierName, fileName, workbook, savedConfig, existingItems, onCancel, onImport }: CatalogImportModalProps) {
  const [config, setConfig] = useState<CatalogReadingConfig>(() => parseCatalog(workbook, savedConfig).config);
  const parsed = useMemo(() => parseCatalog(workbook, config), [workbook, config]);
  const [filter, setFilter] = useState<PreviewFilter>('todos');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const existingByKey = useMemo(() => new Map(existingItems.map(item => [item.itemKey, item])), [existingItems]);
  // Codigo repetido na planilha: vale a primeira linha (igual ao banco).
  const items = useMemo(() => {
    const seen = new Set<string>();
    return parsed.items.filter(item => (seen.has(item.key) ? false : (seen.add(item.key), true)));
  }, [parsed]);
  const keys = useMemo(() => new Set(items.map(item => item.key)), [items]);
  const isNew = (item: ParsedCatalogItem) => !existingByKey.has(item.key);
  const priceChange = (item: ParsedCatalogItem) => {
    const previous = existingByKey.get(item.key);
    return previous && Math.abs(previous.unitCost - Math.round(item.cost * 10000) / 10000) > 0.00005 ? previous.unitCost : null;
  };
  const newCount = items.filter(isNew).length;
  const changedCount = items.filter(item => priceChange(item) != null).length;
  const removedCount = existingItems.filter(item => item.isActive && !keys.has(item.itemKey)).length;
  const withoutBrand = items.filter(item => !item.brand).length;
  const zeroPrice = items.filter(item => !(item.cost > 0)).length;
  const duplicates = parsed.items.length - items.length;

  const brandCounts = useMemo(() => countBy(items, item => item.brand || '(sem marca)'), [items]);
  const typeCounts = useMemo(() => countBy(items, item => item.type || '(sem tipo)'), [items]);

  const updateSheet = (name: string, patch: Partial<SheetReadingConfig>) =>
    setConfig(previous => ({ ...previous, sheets: { ...previous.sheets, [name]: { ...previous.sheets[name], ...patch } } }));

  const redetectSheet = (name: string) =>
    setConfig(previous => {
      const sheets = { ...previous.sheets };
      delete sheets[name];
      return parseCatalog(workbook, { ...previous, sheets }).config;
    });

  // Renomear: grava o apelido do nome atual e atualiza apelidos que ja apontavam para ele.
  const rename = (kind: 'brandAliases' | 'typeAliases', current: string, next: string) => {
    const clean = next.trim();
    if (!clean || clean === current) return;
    setConfig(previous => {
      const aliases = Object.fromEntries(Object.entries(previous[kind]).map(([key, value]) => [key, value === current ? clean : value]));
      aliases[normalizeText(current)] = clean;
      return { ...previous, [kind]: aliases };
    });
  };

  const preview = items.filter(item => {
    if (filter === 'avisos') return item.warnings.length > 0;
    if (filter === 'novos') return isNew(item);
    if (filter === 'preco') return priceChange(item) != null;
    return true;
  });

  const handleImport = async () => {
    setBusy(true);
    setError('');
    try {
      await onImport(config, items);
    } catch (err) {
      setError(err instanceof Error ? err.message : (err as { message?: string })?.message || 'Não foi possível importar.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-6xl my-4 text-xs">
        <div className="p-4 border-b border-slate-100 flex justify-between items-start gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900">Conferir planilha · {supplierName}</h2>
            <p className="text-slate-500">{fileName} — confira o que o sistema entendeu. Só corrija se algo estiver errado: as correções ficam guardadas para a próxima planilha.</p>
          </div>
          <button type="button" onClick={onCancel} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-4">
          {/* Resumo */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Stat label="Itens" value={items.length} />
            <Stat label="Novos" value={newCount} tone="emerald" />
            <Stat label="Mudaram de preço" value={changedCount} tone="blue" />
            <Stat label="Saíram da lista" value={removedCount} tone="slate" />
            <Stat label="Sem marca" value={withoutBrand} tone={withoutBrand ? 'rose' : 'slate'} />
            <Stat label="Preço zerado" value={zeroPrice} tone={zeroPrice ? 'amber' : 'slate'} />
          </div>
          {duplicates > 0 && <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">{duplicates} linha(s) com código repetido na planilha: vale a primeira.</p>}

          {/* Abas */}
          <div className="space-y-3">
            <h3 className="font-bold text-slate-800 uppercase tracking-wider text-[10px]">Abas da planilha</h3>
            {parsed.sheets.map(sheet => (
              <div key={sheet.name} className={`border rounded-lg p-3 space-y-2 ${sheet.config.include ? 'border-slate-200' : 'border-slate-100 bg-slate-50 opacity-70'}`}>
                <div className="flex flex-wrap items-center gap-3 justify-between">
                  <label className="flex items-center gap-2 font-bold text-slate-800">
                    <input type="checkbox" checked={sheet.config.include} onChange={event => updateSheet(sheet.name, { include: event.target.checked })} />
                    {sheet.name}
                    <span className="font-normal text-slate-500">· {sheet.items.length} itens</span>
                    {!savedConfig?.sheets[sheet.name] ? <span className="text-[10px] font-bold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">lido automaticamente</span> : <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">configuração salva</span>}
                  </label>
                  <button type="button" onClick={() => redetectSheet(sheet.name)} className="flex items-center gap-1 text-blue-700 font-bold hover:underline"><RefreshCw className="w-3.5 h-3.5" />Ler de novo</button>
                </div>
                {sheet.config.include && (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-slate-500 font-bold">Linha do cabeçalho</span>
                        <input type="number" min={1} value={sheet.config.headerRow + 1} onChange={event => updateSheet(sheet.name, { headerRow: Math.max(0, Number(event.target.value) - 1) })} className="w-full border border-slate-200 rounded p-1.5" />
                      </label>
                      {ROLES.map(role => (
                        <label key={role} className="space-y-0.5">
                          <span className="text-[10px] text-slate-500 font-bold">{COLUMN_ROLE_LABELS[role]}</span>
                          <select
                            value={sheet.config.columns[role] ?? ''}
                            onChange={event => {
                              const columns = { ...sheet.config.columns };
                              if (event.target.value === '') delete columns[role];
                              else columns[role] = Number(event.target.value);
                              updateSheet(sheet.name, { columns });
                            }}
                            className="w-full border border-slate-200 rounded p-1.5 bg-white"
                          >
                            <option value="">— não tem —</option>
                            {sheet.headers.map((header, index) => header ? <option key={index} value={index}>{header}</option> : null)}
                          </select>
                        </label>
                      ))}
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-slate-500 font-bold">Marca da aba inteira</span>
                        <input value={sheet.config.fixedBrand} placeholder="automático" onChange={event => updateSheet(sheet.name, { fixedBrand: event.target.value })} className="w-full border border-slate-200 rounded p-1.5" />
                      </label>
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-slate-500 font-bold">Tipo vem de</span>
                        <select value={sheet.config.typeSource} onChange={event => updateSheet(sheet.name, { typeSource: event.target.value as SheetReadingConfig['typeSource'] })} className="w-full border border-slate-200 rounded p-1.5 bg-white">
                          <option value="column">Coluna Tipo</option>
                          <option value="firstWord">1ª palavra do nome</option>
                        </select>
                      </label>
                    </div>
                    <p className={`text-[11px] ${sheet.costMismatch ? 'text-rose-700' : 'text-slate-500'}`}>
                      Preço real: <strong>{sheet.costMethod || '—'}</strong>
                      {sheet.costMismatch > 0 && ` · ${sheet.costMismatch} linha(s) em que o cálculo não bate com o preço final da planilha`}
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Marcas e tipos */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <NameList title="Marcas encontradas" entries={brandCounts} onRename={(current, next) => rename('brandAliases', current, next)} />
            <NameList title="Tipos encontrados" entries={typeCounts} onRename={(current, next) => rename('typeAliases', current, next)} />
          </div>

          {/* Previa */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              <h3 className="font-bold text-slate-800 uppercase tracking-wider text-[10px] mr-2">Prévia</h3>
              {([['todos', 'Todos'], ['avisos', 'Com aviso'], ['novos', 'Novos'], ['preco', 'Mudaram de preço']] as [PreviewFilter, string][]).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setFilter(key)} className={`px-2.5 py-1 rounded-full border font-bold ${filter === key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`}>{label}</button>
              ))}
            </div>
            <div className="border border-slate-200 rounded-lg overflow-auto max-h-80">
              <table className="w-full">
                <thead className="bg-slate-50 sticky top-0">
                  <tr className="text-left text-[10px] uppercase text-slate-500">
                    <th className="p-2">Aba / linha</th><th className="p-2">Código</th><th className="p-2">Produto</th><th className="p-2">Marca</th><th className="p-2">Tipo</th><th className="p-2">Situação</th><th className="p-2 text-right">Preço real</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 200).map(item => {
                    const previous = priceChange(item);
                    return (
                      <tr key={`${item.sheet}-${item.row}`} className={`border-t border-slate-100 ${item.warnings.length ? 'bg-amber-50/60' : ''}`}>
                        <td className="p-2 text-slate-400 whitespace-nowrap">{item.sheet} · {item.row}</td>
                        <td className="p-2 font-mono">{item.code}</td>
                        <td className="p-2">
                          {item.name}
                          {isNew(item) && existingItems.length > 0 && <span className="ml-1 text-[9px] font-bold text-emerald-700 bg-emerald-50 px-1 rounded">NOVO</span>}
                          {item.warnings.map(warning => <span key={warning} className="block text-[10px] text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{warning}</span>)}
                        </td>
                        <td className={`p-2 ${item.brand ? '' : 'text-rose-600 font-bold'}`}>{item.brand || 'sem marca'}</td>
                        <td className="p-2">{item.type}</td>
                        <td className="p-2">{item.status}</td>
                        <td className="p-2 text-right font-mono whitespace-nowrap">
                          {money(item.cost)}
                          {previous != null && <span className={`block text-[10px] ${item.cost > previous ? 'text-rose-600' : 'text-emerald-600'}`}>antes {money(previous)}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {preview.length > 200 && <p className="p-2 text-slate-400">Mostrando 200 de {preview.length}.</p>}
              {preview.length === 0 && <p className="p-3 text-slate-400">Nada para mostrar neste filtro.</p>}
            </div>
          </div>

          {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</p>}
        </div>

        <div className="p-4 border-t border-slate-100 flex flex-wrap justify-between items-center gap-2">
          <span className="text-slate-500">Total da lista: {formatMoney(items.reduce((sum, item) => sum + item.cost, 0))} (soma de 1 unidade de cada)</span>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="px-4 py-2 border border-slate-200 rounded-lg font-bold text-slate-600 hover:bg-slate-50">Cancelar</button>
            <button type="button" disabled={busy || items.length === 0} onClick={() => void handleImport()} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-bold flex items-center gap-1.5">
              <Check className="w-4 h-4" />{busy ? 'Importando...' : `Importar ${items.length} itens`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function countBy(items: ParsedCatalogItem[], key: (item: ParsedCatalogItem) => string): [string, number][] {
  const counts = new Map<string, number>();
  items.forEach(item => counts.set(key(item), (counts.get(key(item)) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function Stat({ label, value, tone = 'slate' }: { label: string; value: number; tone?: 'slate' | 'emerald' | 'blue' | 'rose' | 'amber' }) {
  const tones = {
    slate: 'text-slate-800',
    emerald: 'text-emerald-700',
    blue: 'text-blue-700',
    rose: 'text-rose-700',
    amber: 'text-amber-700',
  };
  return (
    <div className="border border-slate-200 rounded-lg p-2">
      <span className="text-[10px] text-slate-500 font-bold uppercase block">{label}</span>
      <span className={`text-lg font-black ${tones[tone]}`}>{value}</span>
    </div>
  );
}

function NameList({ title, entries, onRename }: { title: string; entries: [string, number][]; onRename: (current: string, next: string) => void }) {
  return (
    <div className="space-y-1.5">
      <h3 className="font-bold text-slate-800 uppercase tracking-wider text-[10px]">{title} <span className="font-normal normal-case text-slate-400">(clique no nome para corrigir)</span></h3>
      <div className="border border-slate-200 rounded-lg max-h-56 overflow-auto divide-y divide-slate-100">
        {entries.map(([name, count]) => (
          <div key={name} className="flex items-center justify-between gap-2 p-1.5">
            {name.startsWith('(') ? (
              <span className="text-rose-600 font-bold px-1.5">{name}</span>
            ) : (
              <input
                defaultValue={name}
                key={name}
                onBlur={event => onRename(name, event.target.value)}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                className="flex-1 border border-transparent hover:border-slate-200 focus:border-blue-400 rounded px-1.5 py-1 outline-none"
              />
            )}
            <span className="text-slate-500 font-mono">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
