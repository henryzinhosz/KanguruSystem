import { FormEvent, useEffect, useState } from 'react';
import { Check, Pencil, Plus, Save, Trash2, Wrench } from 'lucide-react';
import { Service } from '../types';
import { supabaseService } from '../db/supabaseService';
import { sanitizeItemCode } from '../db/itemCode';
import ValueInput from './ValueInput';

interface ServicosViewProps {
  services: Service[];
  saveService: (service: Service) => Promise<void>;
  deleteService: (id: string) => Promise<void>;
}

const emptyForm = { sku: '', name: '', category: 'Serviço adicional', sellPrice: 0, isActive: true };
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ServicosView({ services, saveService, deleteService }: ServicosViewProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [nextItemCode, setNextItemCode] = useState('');

  // Proximo codigo automatico (produtos e servicos usam a mesma numeracao).
  useEffect(() => {
    if (editingId) return;
    let active = true;
    supabaseService.getNextItemCode()
      .then(code => { if (active) setNextItemCode(code); })
      .catch(() => { if (active) setNextItemCode(''); });
    return () => { active = false; };
  }, [editingId, services.length]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    // Codigo em branco: o banco gera o proximo numero automatico.
    if (!form.name.trim() || form.sellPrice < 0) {
      setError('Informe nome e preço válido para o serviço.');
      return;
    }

    setBusy(true);
    try {
      await saveService({ id: editingId || crypto.randomUUID(), ...form });
      setForm(emptyForm);
      setEditingId(null);
      setMessage('Serviço salvo.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Não foi possível salvar o serviço.');
    } finally {
      setBusy(false);
    }
  }

  function edit(service: Service) {
    setEditingId(service.id);
    setForm({
      sku: service.sku,
      name: service.name,
      category: service.category,
      sellPrice: service.sellPrice,
      isActive: service.isActive
    });
    setError('');
    setMessage('');
  }

  async function remove(service: Service) {
    setError('');
    setMessage('');
    try {
      await deleteService(service.id);
      if (editingId === service.id) {
        setEditingId(null);
        setForm(emptyForm);
      }
      setMessage('Serviço excluído.');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Não foi possível excluir o serviço.');
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-bold text-slate-900">Serviços</h2>
      </header>
      <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
                <tr><th className="p-3">Código</th><th className="p-3">Serviço</th><th className="p-3">Categoria</th><th className="p-3 text-right">Preço</th><th className="p-3">Situação</th><th className="p-3 text-right">Ações</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {services.map(service => (
                  <tr key={service.id}>
                    <td className="p-3 font-mono text-slate-500">{service.sku}</td>
                    <td className="p-3 font-bold text-slate-900">{service.name}</td>
                    <td className="p-3 text-slate-600">{service.category}</td>
                    <td className="p-3 text-right font-mono font-bold">{currency.format(service.sellPrice)}</td>
                    <td className="p-3"><span className={`px-2 py-1 rounded text-[10px] font-bold ${service.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{service.isActive ? 'ATIVO' : 'INATIVO'}</span></td>
                    <td className="p-3">
                      <div className="flex justify-end gap-1">
                        <button type="button" title="Editar serviço" aria-label={`Editar ${service.name}`} onClick={() => edit(service)} className="p-2 text-blue-700 rounded-lg hover:bg-blue-50"><Pencil className="w-4 h-4" /></button>
                        <button type="button" title="Excluir serviço" aria-label={`Excluir ${service.name}`} onClick={() => void remove(service)} className="p-2 text-rose-600 rounded-lg hover:bg-rose-50"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {services.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Nenhum serviço cadastrado.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 h-fit">
          <div className="flex items-center gap-2"><Wrench className="w-5 h-5 text-blue-600" /><h3 className="text-sm font-bold text-slate-900">{editingId ? 'Editar serviço' : 'Novo serviço'}</h3></div>
          {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
          {message && <p role="status" className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><Check className="w-4 h-4" />{message}</p>}
          <label className="block text-xs font-bold text-slate-700">Código<input value={form.sku} placeholder={nextItemCode ? `Automático: ${nextItemCode}` : 'Automático'} onChange={event => setForm({ ...form, sku: sanitizeItemCode(event.target.value) })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-mono outline-none" /><span className="block mt-1 text-[10px] font-normal text-slate-400">Deixe em branco para gerar o próximo número. Só letras, números e hífen.</span></label>
          <label className="block text-xs font-bold text-slate-700">Nome<input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" /></label>
          <label className="block text-xs font-bold text-slate-700">Categoria<input required value={form.category} onChange={event => setForm({ ...form, category: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" /></label>
          <label className="block text-xs font-bold text-slate-700">Preço de venda (R$)<ValueInput required value={form.sellPrice || null} onValueChange={value => setForm({ ...form, sellPrice: value ?? 0 })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" /></label>
          <label className="flex items-center gap-2 text-xs font-bold text-slate-700"><input type="checkbox" checked={form.isActive} onChange={event => setForm({ ...form, isActive: event.target.checked })} className="w-4 h-4" />Serviço ativo para venda</label>
          <div className="flex gap-2 pt-1">
            {editingId && <button type="button" onClick={() => { setEditingId(null); setForm(emptyForm); }} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>}
            <button type="submit" disabled={busy} className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-60 flex items-center gap-2">{editingId ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}{busy ? 'Salvando...' : editingId ? 'Salvar alterações' : 'Cadastrar serviço'}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
