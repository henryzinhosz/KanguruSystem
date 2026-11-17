import React, { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, Save, Search, Smartphone, Trash2, X } from 'lucide-react';
import type { TradeInPhoneModel } from '../types';
import ValueInput from './ValueInput';
import { deletePhoneModel, listPhoneModels, loadDefaultPhoneModels, phoneCashValue, savePhoneModel } from '../db/phoneTradeIn';

// Tabela de avaliacao de iPhone da Troca Gamer (so o dono edita). O PDV calcula:
// Pix/dinheiro = valor base - desconto do estado (A/B/C) - bateria (84% ou menos);
// vale-troca = Pix + bonus da loja (Configuracoes > loja > Regras do PDV).

type Draft = Omit<TradeInPhoneModel, 'id' | 'sortOrder' | 'updatedAt' | 'updatedByName'>;

const toDraft = (model: TradeInPhoneModel): Draft => ({
  modelName: model.modelName,
  storage: model.storage,
  baseValue: model.baseValue,
  gradeAPercent: model.gradeAPercent,
  gradeBPercent: model.gradeBPercent,
  gradeCPercent: model.gradeCPercent,
  batteryDeduction: model.batteryDeduction,
  isActive: model.isActive
});

const EMPTY_DRAFT: Draft = {
  modelName: '',
  storage: '',
  baseValue: 0,
  gradeAPercent: 50,
  gradeBPercent: 60,
  gradeCPercent: 75,
  batteryDeduction: 200,
  isActive: true
};

const sameDraft = (a: Draft, b: Draft) =>
  a.modelName === b.modelName && a.storage === b.storage && a.baseValue === b.baseValue
  && a.gradeAPercent === b.gradeAPercent && a.gradeBPercent === b.gradeBPercent && a.gradeCPercent === b.gradeCPercent
  && a.batteryDeduction === b.batteryDeduction && a.isActive === b.isActive;

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || fallback;

const cell = 'w-full bg-slate-50 border border-slate-300 rounded-md px-2 py-1 outline-none focus:ring-1 focus:ring-blue-500 font-mono text-right';

export default function IphoneTablePanel({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<TradeInPhoneModel[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newDraft, setNewDraft] = useState<Draft | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const rows = await listPhoneModels();
      setModels(rows);
      setDrafts(Object.fromEntries(rows.map(row => [row.id, toDraft(row)])));
      setError('');
    } catch (err) {
      setError(`Não foi possível carregar a tabela: ${errorText(err, 'erro no banco')}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return models;
    return models.filter(model => `${model.modelName} ${model.storage}`.toLowerCase().includes(term));
  }, [models, search]);

  const dirtyCount = models.filter(model => drafts[model.id] && !sameDraft(drafts[model.id], toDraft(model))).length;

  const patch = (id: string, field: keyof Draft, value: Draft[keyof Draft]) =>
    setDrafts(current => ({ ...current, [id]: { ...current[id], [field]: value } }));

  const saveRow = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    setSavingId(id);
    setError('');
    setNotice('');
    try {
      await savePhoneModel({ id, ...draft });
      const saved = { ...models.find(model => model.id === id)!, ...draft };
      setModels(current => current.map(model => model.id === id ? saved : model));
    } catch (err) {
      setError(errorText(err, 'Não foi possível salvar o modelo.'));
    } finally {
      setSavingId(null);
    }
  };

  const saveAll = async () => {
    const ids = models.filter(model => drafts[model.id] && !sameDraft(drafts[model.id], toDraft(model))).map(model => model.id);
    for (const id of ids) {
      await saveRow(id);
    }
  };

  const removeRow = async (model: TradeInPhoneModel) => {
    if (!window.confirm(`Excluir ${model.modelName} ${model.storage} da tabela? As trocas já feitas não mudam.`)) return;
    setSavingId(model.id);
    setError('');
    try {
      await deletePhoneModel(model.id);
      setModels(current => current.filter(item => item.id !== model.id));
    } catch (err) {
      setError(errorText(err, 'Não foi possível excluir o modelo.'));
    } finally {
      setSavingId(null);
    }
  };

  const createModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDraft) return;
    if (!newDraft.modelName.trim() || !newDraft.storage.trim()) return setError('Informe o modelo e a memória.');
    if (newDraft.baseValue <= 0) return setError('Informe o valor base.');
    setSavingId('new');
    setError('');
    try {
      await savePhoneModel(newDraft);
      setNewDraft(null);
      setNotice(`${newDraft.modelName} ${newDraft.storage.toUpperCase()} incluído no topo da tabela.`);
      await reload();
    } catch (err) {
      setError(errorText(err, 'Não foi possível incluir o modelo.'));
    } finally {
      setSavingId(null);
    }
  };

  const loadDefaults = async () => {
    if (!window.confirm('Incluir na tabela os modelos padrão que estão faltando? Os modelos que você já editou não mudam.')) return;
    setSavingId('defaults');
    setError('');
    try {
      const added = await loadDefaultPhoneModels();
      setNotice(added > 0 ? `${added} modelo(s) incluído(s).` : 'Nenhum modelo faltando: a tabela já tem todos os modelos padrão.');
      await reload();
    } catch (err) {
      setError(errorText(err, 'Não foi possível carregar a tabela padrão.'));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-6xl max-h-[94vh] overflow-hidden flex flex-col">
        <div className="bg-slate-900 text-white p-4 flex justify-between items-center">
          <h3 className="font-bold text-sm flex items-center"><Smartphone className="w-4 h-4 mr-2" />Tabela de avaliação de iPhone</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto text-xs">
          <p className="text-slate-500">
            O PDV calcula: <strong>Pix/dinheiro = valor base − desconto do estado − bateria</strong> (o desconto da bateria vale com saúde em 84% ou menos).
            O vale-troca soma o bônus da loja (Configurações › loja › Regras do PDV). Acima da tabela, o PDV pede a senha Gerente.
            Os valores vieram do sistema antigo: <strong>revise antes de usar</strong>.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar modelo (ex.: 15 Pro)"
                className="w-full bg-slate-50 border border-slate-300 rounded-lg pl-8 pr-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <button type="button" onClick={() => { setNewDraft({ ...EMPTY_DRAFT }); setNotice(''); }} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold">
              <Plus className="w-4 h-4" />Novo modelo
            </button>
            <button type="button" onClick={() => void loadDefaults()} disabled={savingId !== null} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 font-bold disabled:opacity-60">
              <RotateCcw className="w-4 h-4" />Incluir modelos padrão que faltam
            </button>
            {dirtyCount > 0 && (
              <button type="button" onClick={() => void saveAll()} disabled={savingId !== null} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-60">
                <Save className="w-4 h-4" />Salvar {dirtyCount} alteração(ões)
              </button>
            )}
          </div>

          {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
          {notice && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{notice}</div>}

          {newDraft && (
            <form onSubmit={createModel} className="p-3 rounded-lg border border-blue-200 bg-blue-50/50 grid grid-cols-2 md:grid-cols-8 gap-2 items-end">
              <label className="col-span-2 font-bold text-slate-700">Modelo
                <input value={newDraft.modelName} onChange={e => setNewDraft({ ...newDraft, modelName: e.target.value })} placeholder="iPhone 18 Pro" className="mt-1 w-full bg-white border border-slate-300 rounded-md px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500" />
              </label>
              <label className="font-bold text-slate-700">Memória
                <input value={newDraft.storage} onChange={e => setNewDraft({ ...newDraft, storage: e.target.value.toUpperCase() })} placeholder="256GB" className="mt-1 w-full bg-white border border-slate-300 rounded-md px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500" />
              </label>
              <label className="font-bold text-slate-700">Valor base
                <ValueInput value={newDraft.baseValue || null} onValueChange={v => setNewDraft({ ...newDraft, baseValue: v ?? 0 })} className={`mt-1 ${cell} bg-white`} />
              </label>
              <label className="font-bold text-slate-700">A %
                <ValueInput value={newDraft.gradeAPercent} onValueChange={v => setNewDraft({ ...newDraft, gradeAPercent: Math.min(100, v ?? 0) })} className={`mt-1 ${cell} bg-white`} />
              </label>
              <label className="font-bold text-slate-700">B %
                <ValueInput value={newDraft.gradeBPercent} onValueChange={v => setNewDraft({ ...newDraft, gradeBPercent: Math.min(100, v ?? 0) })} className={`mt-1 ${cell} bg-white`} />
              </label>
              <label className="font-bold text-slate-700">C %
                <ValueInput value={newDraft.gradeCPercent} onValueChange={v => setNewDraft({ ...newDraft, gradeCPercent: Math.min(100, v ?? 0) })} className={`mt-1 ${cell} bg-white`} />
              </label>
              <label className="font-bold text-slate-700">Bateria R$
                <ValueInput value={newDraft.batteryDeduction} onValueChange={v => setNewDraft({ ...newDraft, batteryDeduction: v ?? 0 })} className={`mt-1 ${cell} bg-white`} />
              </label>
              <div className="col-span-2 md:col-span-8 flex justify-end gap-2">
                <button type="button" onClick={() => setNewDraft(null)} className="px-3 py-1.5 border border-slate-300 rounded-md text-slate-600 hover:bg-white">Cancelar</button>
                <button type="submit" disabled={savingId !== null} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-md disabled:opacity-60">{savingId === 'new' ? 'Salvando...' : 'Incluir'}</button>
              </div>
            </form>
          )}

          {loading ? (
            <p className="text-slate-500 py-6 text-center">Carregando a tabela...</p>
          ) : models.length === 0 ? (
            <p className="text-slate-500 py-6 text-center">A tabela está vazia. Use “Incluir modelos padrão que faltam” para carregar os modelos.</p>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left">
                <thead className="text-[10px] text-slate-500 uppercase bg-slate-50 font-bold">
                  <tr>
                    <th className="px-2 py-2">Modelo</th>
                    <th className="px-2 py-2">Memória</th>
                    <th className="px-2 py-2 text-right w-28">Valor base</th>
                    <th className="px-2 py-2 text-right w-20">A %</th>
                    <th className="px-2 py-2 text-right w-20">B %</th>
                    <th className="px-2 py-2 text-right w-20">C %</th>
                    <th className="px-2 py-2 text-right w-24">Bateria R$</th>
                    <th className="px-2 py-2 text-right">Pix A · B · C</th>
                    <th className="px-2 py-2 text-center">Ativo</th>
                    <th className="px-2 py-2 w-20"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map(model => {
                    const draft = drafts[model.id] ?? toDraft(model);
                    const dirty = !sameDraft(draft, toDraft(model));
                    return (
                      <tr key={model.id} className={`${dirty ? 'bg-amber-50/60' : ''} ${draft.isActive ? '' : 'opacity-60'}`}>
                        <td className="px-2 py-1.5 font-semibold text-slate-800 whitespace-nowrap">{model.modelName}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-600">{model.storage}</td>
                        <td className="px-2 py-1.5"><ValueInput value={draft.baseValue} onValueChange={v => patch(model.id, 'baseValue', v ?? 0)} className={cell} /></td>
                        <td className="px-2 py-1.5"><ValueInput value={draft.gradeAPercent} onValueChange={v => patch(model.id, 'gradeAPercent', Math.min(100, v ?? 0))} className={cell} /></td>
                        <td className="px-2 py-1.5"><ValueInput value={draft.gradeBPercent} onValueChange={v => patch(model.id, 'gradeBPercent', Math.min(100, v ?? 0))} className={cell} /></td>
                        <td className="px-2 py-1.5"><ValueInput value={draft.gradeCPercent} onValueChange={v => patch(model.id, 'gradeCPercent', Math.min(100, v ?? 0))} className={cell} /></td>
                        <td className="px-2 py-1.5"><ValueInput value={draft.batteryDeduction} onValueChange={v => patch(model.id, 'batteryDeduction', v ?? 0)} className={cell} /></td>
                        <td className="px-2 py-1.5 text-right font-mono text-slate-600 whitespace-nowrap">
                          {[draft.gradeAPercent, draft.gradeBPercent, draft.gradeCPercent].map(percent => money(phoneCashValue(draft, percent, false))).join(' · ')}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <input type="checkbox" checked={draft.isActive} onChange={e => patch(model.id, 'isActive', e.target.checked)} className="w-4 h-4 accent-blue-600" aria-label="Modelo ativo no PDV" />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex justify-end gap-1">
                            {dirty && (
                              <button type="button" title="Salvar" onClick={() => void saveRow(model.id)} disabled={savingId !== null} className="p-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60">
                                <Save className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button type="button" title="Excluir" onClick={() => void removeRow(model)} disabled={savingId !== null} className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-60">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-slate-400">{models.length} modelo(s) · "Pix A · B · C" = valor com bateria boa. Desmarcar "Ativo" esconde o modelo no PDV.</p>
        </div>
      </div>
    </div>
  );
}
