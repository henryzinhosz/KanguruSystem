import React, { useMemo, useState } from 'react';
import { Plus, Tag, Trash2, X } from 'lucide-react';
import type { Product, StockInventory, StoreConfig, TradeIn, TradeInStockLine, TradeInStockResult } from '../types';
import ValueInput from './ValueInput';
import LabelPrintModal, { LabelRequest } from './LabelPrintModal';
import { sanitizeItemCode } from '../db/itemCode';
import { CSOSNS, ICMS_ORIGINS, productFiscalError } from '../db/fiscal';

// "Conferir e Estocar" da Troca Gamer com varios itens (desenho aprovado em 2026-11-22).
// Cada linha e uma coisa que o cliente entregou: produto existente (aviso de "ja existe") ou novo,
// quantidade, serial e custo; a soma dos custos tem que dar o valor pago. Gravacao tudo ou nada.

type ItemType = 'VIDEOGAME' | 'CONTROLE' | 'JOGO' | 'IPHONE' | 'OUTRO';

// Dados fiscais por tipo (NCM do jogo informado pelo usuario em 2026-11-22; demais como antes).
const TYPE_INFO: Record<ItemType, { label: string; category: string; ncm: string; serialized: boolean; taxed: boolean }> = {
  VIDEOGAME: { label: 'Videogame', category: 'Videogames', ncm: '9504.50.00', serialized: true, taxed: true },
  CONTROLE: { label: 'Controle / acessório', category: 'Periféricos', ncm: '9504.50.00', serialized: false, taxed: true },
  JOGO: { label: 'Jogo', category: 'Videogames', ncm: '8523.49.90', serialized: false, taxed: true },
  IPHONE: { label: 'iPhone', category: 'Celulares', ncm: '8517.13.00', serialized: true, taxed: true },
  OUTRO: { label: 'Outro', category: 'Outros', ncm: '', serialized: false, taxed: false },
};
const TAX_BURDEN_DEFAULT = 26.87;

interface Line {
  key: number;
  mode: 'new' | 'existing' | 'skip';
  productId: string;
  search: string;
  type: ItemType;
  name: string;
  sku: string;
  sellPrice: number | null;
  warrantyMonths: number | null;
  isSerialized: boolean;
  quantity: number;
  serials: { serialNumber: string; imei: string }[];
  unitCost: number | null;
  ncm: string;
  origin: string;
  csosn: string;
}

let nextKey = 1;
const normalize = (value: string) => value
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(usado\)|usado|seminovo/g, '').replace(/[^a-z0-9]/g, '');

const toCents = (value: number) => Math.round(value * 100);
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function newLine(type: ItemType, patch: Partial<Line> = {}): Line {
  const info = TYPE_INFO[type];
  return {
    key: nextKey++, mode: 'new', productId: '', search: '', type,
    name: '', sku: '', sellPrice: null, warrantyMonths: 3, isSerialized: info.serialized,
    quantity: 1, serials: info.serialized ? [{ serialNumber: '', imei: '' }] : [],
    unitCost: null, ncm: info.ncm, origin: '0', csosn: info.taxed ? '102' : '',
    ...patch,
  };
}

interface Props {
  trade: TradeIn;
  products: Product[];
  inventory: StockInventory[];
  storeConfigs: StoreConfig[];
  onStock: (lines: TradeInStockLine[]) => Promise<TradeInStockResult[]>;
  onClose: () => void;
}

export default function TradeInStockModal({ trade, products, inventory, storeConfigs, onStock, onClose }: Props) {
  const isPhone = trade.deviceType === 'IPHONE';
  const activeProducts = useMemo(() => products.filter(product => !product.archivedAt), [products]);
  const [lines, setLines] = useState<Line[]>(() => [newLine(isPhone ? 'IPHONE' : 'VIDEOGAME', {
    name: trade.itemDescription,
    sellPrice: Math.round(trade.valuationAmount * 150) / 100,
    unitCost: trade.valuationAmount,
    serials: [{ serialNumber: trade.serialNumber || '', imei: trade.imei || '' }],
  })]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<TradeInStockResult[] | null>(null);
  const [labelRequest, setLabelRequest] = useState<LabelRequest | null>(null);

  const stockOf = (productId: string) => Object.entries(inventory.find(item => item.productId === productId)?.quantities ?? {})
    .filter(([unitId]) => unitId !== 'central')
    .reduce((sum, [, unit]) => sum + (unit.qty || 0), 0);
  const productOf = (line: Line) => (line.mode === 'existing' ? activeProducts.find(product => product.id === line.productId) : undefined);
  const serializedOf = (line: Line) => (line.mode === 'existing' ? Boolean(productOf(line)?.isSerialized) : line.isSerialized);
  const quantityOf = (line: Line) => (serializedOf(line) ? line.serials.length : line.quantity);
  const priceOf = (line: Line) => (line.mode === 'existing' ? productOf(line)?.sellPrice ?? 0 : line.sellPrice ?? 0);

  const update = (key: number, patch: Partial<Line>) =>
    setLines(previous => previous.map(line => (line.key === key ? { ...line, ...patch } : line)));

  const totalCents = lines.reduce((sum, line) =>
    line.mode === 'skip' ? sum : sum + toCents(line.unitCost ?? 0) * quantityOf(line), 0);
  const paidCents = toCents(trade.valuationAmount);
  const diffCents = paidCents - totalCents;

  // Produtos parecidos com o nome digitado (evita cadastro repetido).
  const similar = (line: Line) => {
    const key = normalize(line.name);
    if (key.length < 4) return [];
    return activeProducts
      .filter(product => {
        const other = normalize(product.name);
        return other.length >= 4 && (other.includes(key) || key.includes(other));
      })
      .slice(0, 3);
  };

  const searchResults = (line: Line) => {
    const query = line.search.trim().toLowerCase();
    if (!query) return [];
    return activeProducts
      .filter(product => product.name.toLowerCase().includes(query) || product.sku.toLowerCase().includes(query))
      .slice(0, 8);
  };

  const useExisting = (line: Line, product: Product) => update(line.key, {
    mode: 'existing',
    productId: product.id,
    search: '',
    serials: product.isSerialized ? (line.serials.length ? line.serials : [{ serialNumber: '', imei: '' }]) : [],
    quantity: product.isSerialized ? line.quantity : Math.max(1, line.quantity),
  });

  // Divide o valor pago proporcional ao preco de venda (centavos que sobram vao para um item de 1 unidade).
  const splitByPrice = () => {
    const active = lines.filter(line => line.mode !== 'skip');
    const weights = active.map(line => priceOf(line) * quantityOf(line));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    if (!active.length || totalWeight <= 0) {
      setError('Para dividir, informe o preço de venda de cada item.');
      return;
    }
    const costs = new Map<number, number>();
    let assigned = 0;
    active.forEach((line, index) => {
      const quantity = Math.max(1, quantityOf(line));
      const unitCents = Math.floor((paidCents * weights[index] / totalWeight) / quantity);
      costs.set(line.key, unitCents);
      assigned += unitCents * quantity;
    });
    const rest = paidCents - assigned;
    const single = [...active].sort((a, b) => priceOf(b) - priceOf(a)).find(line => quantityOf(line) === 1);
    if (rest !== 0 && single) costs.set(single.key, (costs.get(single.key) ?? 0) + rest);
    setLines(previous => previous.map(line => (costs.has(line.key) ? { ...line, unitCost: (costs.get(line.key) ?? 0) / 100 } : line)));
    setError(rest !== 0 && !single ? 'Sobrou uma diferença de centavos: ajuste o custo de um item.' : '');
  };

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError('');
    const payload: TradeInStockLine[] = [];
    for (const [index, line] of lines.entries()) {
      const label = `Item ${index + 1}`;
      if (line.mode === 'skip') {
        payload.push({ skip: true, quantity: 0, unitCost: 0 });
        continue;
      }
      if (line.mode === 'existing' && !productOf(line)) return setError(`${label}: escolha o produto.`);
      const serialized = serializedOf(line);
      const quantity = quantityOf(line);
      if (quantity <= 0) return setError(`${label}: informe a quantidade.`);
      if (line.unitCost === null || line.unitCost < 0) return setError(`${label}: informe o custo.`);
      const serials = serialized ? line.serials.map(serial => ({ serialNumber: serial.serialNumber.trim().toUpperCase(), imei: serial.imei.replace(/\s/g, '') })) : [];
      if (serialized && serials.some(serial => !serial.serialNumber)) return setError(`${label}: informe o número de série de cada unidade.`);
      if (serials.some(serial => serial.imei && !/^\d{15}$/.test(serial.imei))) return setError(`${label}: IMEI inválido (são 15 números).`);
      let newProduct: TradeInStockLine['newProduct'] = null;
      if (line.mode === 'new') {
        if (!line.name.trim()) return setError(`${label}: informe o nome do produto.`);
        if (!line.sellPrice || line.sellPrice <= 0) return setError(`${label}: informe o preço de venda.`);
        const taxed = TYPE_INFO[line.type].taxed || Boolean(line.ncm.trim());
        if (taxed) {
          const fiscal = productFiscalError({
            ncm: line.ncm.trim(), origin: line.origin, cst: '', csosn: line.csosn, cest: '',
            icmsRate: 0, icmsReduction: 0, taxBurden: TAX_BURDEN_DEFAULT,
          });
          if (fiscal) return setError(`${label}: ${fiscal}`);
        }
        newProduct = {
          sku: sanitizeItemCode(line.sku.trim()),
          name: line.name.trim(),
          category: TYPE_INFO[line.type].category,
          sellPrice: line.sellPrice,
          warrantyMonths: line.warrantyMonths ?? 0,
          isSerialized: line.isSerialized,
          ncm: line.ncm.trim(),
          cest: null,
          icmsOrigin: line.origin || null,
          icmsCst: null,
          csosn: line.csosn || null,
          icmsRate: taxed ? 0 : null,
          icmsReduction: taxed ? 0 : null,
          taxBurdenPercent: taxed ? TAX_BURDEN_DEFAULT : null,
        };
      }
      payload.push({
        productId: line.mode === 'existing' ? line.productId : null,
        newProduct,
        quantity,
        unitCost: line.unitCost,
        serials: serialized ? serials : undefined,
      });
    }
    if (!payload.some(line => !line.skip)) return setError('Ao menos um item precisa ir para o estoque.');
    if (diffCents !== 0) return setError(`A soma dos custos precisa ser igual ao valor pago (${money(trade.valuationAmount)}).`);

    setSaving(true);
    try {
      setDone(await onStock(payload));
    } catch (err) {
      setError((err as { message?: string })?.message || 'Não foi possível estocar a troca.');
    } finally {
      setSaving(false);
    }
  }

  const input = 'w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none';

  if (done) {
    return (
      <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-4 text-xs">
          <h3 className="text-sm font-bold text-slate-900">Troca estocada</h3>
          <p className="text-slate-500">Os itens entraram no estoque da loja. Imprima as etiquetas de cada um:</p>
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {done.map(item => {
              const product = products.find(entry => entry.id === item.productId);
              return (
                <div key={item.productId + item.serials.join()} className="flex items-center justify-between gap-2 p-2.5">
                  <span>
                    <strong className="text-slate-800">{product?.name ?? 'Produto'}</strong>
                    <span className="block text-slate-500">{item.serials.length ? `Serial: ${item.serials.join(', ')}` : `${item.quantity} unidade(s)`}</span>
                  </span>
                  {product && (
                    <button
                      type="button"
                      onClick={() => setLabelRequest({
                        title: 'Etiquetas da troca',
                        product,
                        quantity: item.serials.length ? undefined : item.quantity,
                        serials: item.serials.length ? item.serials : undefined,
                      })}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 font-semibold"
                    >
                      <Tag className="w-3.5 h-3.5" /> Etiquetas
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded">Concluir</button>
          </div>
        </div>
        {labelRequest && <LabelPrintModal request={labelRequest} storeConfigs={storeConfigs} onClose={() => setLabelRequest(null)} />}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-3xl w-full max-h-[92vh] overflow-hidden flex flex-col">
        <div className="bg-slate-900 text-white p-4 flex justify-between items-center">
          <h3 className="font-bold text-xs uppercase tracking-wider">Conferir e estocar a troca</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>

        <form onSubmit={confirm} className="p-4 space-y-4 text-xs overflow-y-auto">
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
            <span className="font-bold text-slate-800 text-sm block">{trade.tradeNumber ? `Nº ${trade.tradeNumber} · ` : ''}{trade.itemDescription}</span>
            {trade.accessories && <span className="text-slate-500 block">Itens informados no PDV: {trade.accessories}</span>}
            <span className="text-slate-500 block mt-0.5">Valor pago ao cliente: <strong className="text-slate-800">{money(trade.valuationAmount)}</strong></span>
          </div>

          {lines.map((line, index) => {
            const product = productOf(line);
            const serialized = serializedOf(line);
            const matches = line.mode === 'new' ? similar(line) : [];
            const results = line.mode === 'existing' && !product ? searchResults(line) : [];
            return (
              <div key={line.key} className={`border rounded-lg p-3 space-y-2.5 ${line.mode === 'skip' ? 'border-slate-200 bg-slate-50/60' : 'border-slate-200'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-slate-800">Item {index + 1}</span>
                  <div className="inline-flex rounded border border-slate-200 overflow-hidden">
                    {([['new', 'Produto novo'], ['existing', 'Já cadastrado'], ['skip', 'Não vai para o estoque']] as const).map(([mode, label]) => (
                      <button key={mode} type="button" onClick={() => update(line.key, { mode, productId: mode === 'existing' ? line.productId : '' })}
                        className={`px-2 py-1 font-semibold ${line.mode === mode ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</button>
                    ))}
                  </div>
                  {lines.length > 1 && (
                    <button type="button" onClick={() => setLines(previous => previous.filter(entry => entry.key !== line.key))} className="ml-auto p-1 text-slate-400 hover:text-rose-600" title="Remover item"><Trash2 className="w-4 h-4" /></button>
                  )}
                </div>

                {line.mode === 'skip' && <p className="text-slate-500">Fica fora do estoque, com custo zero (ex.: cabo sem valor de revenda).</p>}

                {line.mode === 'existing' && (
                  product ? (
                    <div className="flex items-center justify-between gap-2 bg-blue-50 border border-blue-100 rounded p-2">
                      <span><strong className="text-slate-800">{product.name}</strong> <span className="text-slate-500">· Cód. {product.sku} · {stockOf(product.id)} em estoque · venda {money(product.sellPrice)}</span></span>
                      <button type="button" onClick={() => update(line.key, { productId: '' })} className="text-blue-700 font-semibold">Trocar</button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <input className={input} placeholder="Buscar produto por nome ou código" value={line.search} onChange={event => update(line.key, { search: event.target.value })} />
                      {results.length > 0 && (
                        <div className="border border-slate-200 rounded divide-y divide-slate-100">
                          {results.map(result => (
                            <button key={result.id} type="button" onClick={() => useExisting(line, result)} className="w-full text-left px-2 py-1.5 hover:bg-slate-50">
                              <strong className="text-slate-800">{result.name}</strong> <span className="text-slate-500">· {result.sku} · {stockOf(result.id)} em estoque{result.isSerialized ? ' · com serial' : ''}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                )}

                {line.mode === 'new' && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-2">
                      <select className={input} value={line.type} onChange={event => {
                        const type = event.target.value as ItemType;
                        const info = TYPE_INFO[type];
                        update(line.key, {
                          type, ncm: info.ncm, csosn: info.taxed ? '102' : '', isSerialized: info.serialized,
                          serials: info.serialized ? (line.serials.length ? line.serials : [{ serialNumber: '', imei: '' }]) : [],
                        });
                      }}>
                        {(Object.keys(TYPE_INFO) as ItemType[]).map(type => <option key={type} value={type}>{TYPE_INFO[type].label}</option>)}
                      </select>
                      <input className={`${input} font-semibold`} placeholder="Nome do produto" value={line.name} onChange={event => update(line.key, { name: event.target.value })} />
                    </div>
                    {matches.length > 0 && (
                      <div className="bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
                        {matches.map(match => (
                          <div key={match.id} className="flex items-center justify-between gap-2">
                            <span className="text-amber-900">Já existe: <strong>{match.name}</strong> ({stockOf(match.id)} em estoque)</span>
                            <button type="button" onClick={() => useExisting(line, match)} className="font-bold text-amber-800 underline">Usar este</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <label className="space-y-1"><span className="font-bold text-slate-600">Código</span>
                        <input className={`${input} font-mono`} placeholder="Automático" value={line.sku} onChange={event => update(line.key, { sku: sanitizeItemCode(event.target.value) })} /></label>
                      <label className="space-y-1"><span className="font-bold text-slate-600">Preço de venda</span>
                        <ValueInput className={`${input} font-mono`} value={line.sellPrice} onValueChange={value => update(line.key, { sellPrice: value })} /></label>
                      <label className="space-y-1"><span className="font-bold text-slate-600">Garantia (meses)</span>
                        <ValueInput decimals={0} className={`${input} font-mono`} value={line.warrantyMonths} onValueChange={value => update(line.key, { warrantyMonths: value })} /></label>
                      <label className="space-y-1"><span className="font-bold text-slate-600">NCM</span>
                        <input className={`${input} font-mono`} value={line.ncm} onChange={event => update(line.key, { ncm: event.target.value })} /></label>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <label className="space-y-1 sm:col-span-2"><span className="font-bold text-slate-600">Origem</span>
                        <select className={input} value={line.origin} onChange={event => update(line.key, { origin: event.target.value })}>
                          {ICMS_ORIGINS.map(origin => <option key={origin.code} value={origin.code}>{origin.label}</option>)}
                        </select></label>
                      <label className="space-y-1"><span className="font-bold text-slate-600">CSOSN</span>
                        <select className={input} value={line.csosn} onChange={event => update(line.key, { csosn: event.target.value })}>
                          <option value="">—</option>
                          {CSOSNS.map(code => <option key={code} value={code}>{code}</option>)}
                        </select></label>
                      <label className="flex items-end gap-1.5 pb-1.5"><input type="checkbox" checked={line.isSerialized} onChange={event => update(line.key, {
                        isSerialized: event.target.checked,
                        serials: event.target.checked ? (line.serials.length ? line.serials : [{ serialNumber: '', imei: '' }]) : [],
                      })} /> <span className="font-semibold text-slate-700">Com serial</span></label>
                    </div>
                  </>
                )}

                {line.mode !== 'skip' && (line.mode === 'new' || product) && (
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2 items-start">
                    {serialized ? (
                      <div className="space-y-1.5">
                        {line.serials.map((serial, serialIndex) => (
                          <div key={serialIndex} className="grid grid-cols-[1fr_150px_24px] gap-1.5">
                            <input className={`${input} font-mono`} placeholder={`Nº de série ${serialIndex + 1}`} value={serial.serialNumber}
                              onChange={event => update(line.key, { serials: line.serials.map((entry, i) => (i === serialIndex ? { ...entry, serialNumber: event.target.value } : entry)) })} />
                            <input className={`${input} font-mono`} placeholder="IMEI (opcional)" inputMode="numeric" value={serial.imei}
                              onChange={event => update(line.key, { serials: line.serials.map((entry, i) => (i === serialIndex ? { ...entry, imei: event.target.value.replace(/\D/g, '').slice(0, 15) } : entry)) })} />
                            {line.serials.length > 1 ? (
                              <button type="button" onClick={() => update(line.key, { serials: line.serials.filter((_, i) => i !== serialIndex) })} className="text-slate-400 hover:text-rose-600" title="Remover unidade"><X className="w-4 h-4" /></button>
                            ) : <span />}
                          </div>
                        ))}
                        <button type="button" onClick={() => update(line.key, { serials: [...line.serials, { serialNumber: '', imei: '' }] })} className="text-blue-700 font-semibold">+ outra unidade deste produto</button>
                      </div>
                    ) : (
                      <label className="space-y-1 max-w-[140px]"><span className="font-bold text-slate-600">Quantidade</span>
                        <ValueInput decimals={0} className={`${input} font-mono`} value={line.quantity} onValueChange={value => update(line.key, { quantity: value ?? 0 })} /></label>
                    )}
                    <label className="space-y-1"><span className="font-bold text-slate-600">Custo por unidade</span>
                      <ValueInput className={`${input} font-mono`} value={line.unitCost} onValueChange={value => update(line.key, { unitCost: value })} /></label>
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setLines(previous => [...previous, newLine('CONTROLE')])} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-200 text-slate-700 font-semibold hover:bg-slate-50">
              <Plus className="w-3.5 h-3.5" /> Adicionar item
            </button>
            <button type="button" onClick={splitByPrice} className="px-2.5 py-1.5 rounded border border-blue-200 bg-blue-50 text-blue-700 font-semibold hover:bg-blue-100">
              Dividir pelo preço de venda
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 bg-slate-50 border border-slate-100 rounded-lg p-3">
            <div><span className="text-slate-500 block">Valor pago</span><strong className="font-mono text-slate-900">{money(paidCents / 100)}</strong></div>
            <div><span className="text-slate-500 block">Soma dos custos</span><strong className="font-mono text-slate-900">{money(totalCents / 100)}</strong></div>
            <div><span className="text-slate-500 block">Diferença</span><strong className={`font-mono ${diffCents === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{money(diffCents / 100)}</strong></div>
          </div>

          {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-3 py-1.5 border border-slate-200 text-slate-600 rounded hover:bg-slate-50">Voltar</button>
            <button type="submit" disabled={saving || diffCents !== 0} className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-bold rounded">
              {saving ? 'Estocando...' : 'Estocar itens'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
