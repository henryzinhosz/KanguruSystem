import { FormEvent, useEffect, useState } from 'react';
import { Check, Pencil, Plus, Save, Trash2, Wrench } from 'lucide-react';
import { Service, StoreConfig, WorkOrder, WorkOrderStatus } from '../types';
import { supabaseService } from '../db/supabaseService';
import { sanitizeItemCode } from '../db/itemCode';
import ValueInput from './ValueInput';
import OrdensServicoPanel from './OrdensServicoPanel';

interface ServicosViewProps {
  services: Service[];
  saveService: (service: Service) => Promise<void>;
  deleteService: (id: string) => Promise<void>;
  workOrders: WorkOrder[];
  storeConfigs: StoreConfig[];
  updateWorkOrderStatus: (id: string, status: WorkOrderStatus) => Promise<void>;
}

const emptyForm = {
  sku: '', name: '', category: 'Serviço adicional', sellPrice: 0, isActive: true,
  nfseServiceCode: '', nfseNbsCode: '', nfseMunicipalCode: '', nfseDescription: ''
};

// Codigos mais usados nas lojas (tabela do contador). Outros podem ser digitados.
const NFSE_PRESETS = [
  { label: 'Assistência técnica — computador / notebook', serviceCode: '140201', nbsCode: '120012000' },
  { label: 'Assistência técnica — videogame / controle', serviceCode: '140201', nbsCode: '120013000' },
];

const nfseComplete = (service: { nfseServiceCode?: string; nfseNbsCode?: string }) =>
  /^\d{6}$/.test(service.nfseServiceCode || '') && /^\d{9}$/.test(service.nfseNbsCode || '');
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ServicosView({ services, saveService, deleteService, workOrders, storeConfigs, updateWorkOrderStatus }: ServicosViewProps) {
  // Ordens de servico ativas (abertas no PDV) e cadastro dos servicos usados nelas e na venda.
  const [tab, setTab] = useState<'ordens' | 'cadastro'>('ordens');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    // Codigo em branco: o banco gera o proximo numero automatico.
    if (!form.name.trim() || form.sellPrice < 0) {
      setError('Informe nome e preço válido para o serviço.');
      return;
    }
    if ((form.nfseServiceCode && !/^\d{6}$/.test(form.nfseServiceCode)) || (form.nfseNbsCode && !/^\d{9}$/.test(form.nfseNbsCode))) {
      setError('Código de tributação nacional tem 6 dígitos (ex.: 14.02.01) e o NBS tem 9 dígitos (ex.: 1.2001.30.00).');
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
      isActive: service.isActive,
      nfseServiceCode: service.nfseServiceCode || '',
      nfseNbsCode: service.nfseNbsCode || '',
      nfseMunicipalCode: service.nfseMunicipalCode || '',
      nfseDescription: service.nfseDescription || ''
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
      <header className="space-y-3">
        <h2 className="text-xl font-bold text-slate-900">Serviços / OS</h2>
        <div className="flex gap-1 border-b border-slate-200">
          {([['ordens', 'Ordens de serviço ativas'], ['cadastro', 'Cadastro de serviços']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`px-4 py-2 text-xs font-bold border-b-2 -mb-px ${tab === id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>
          ))}
        </div>
      </header>
      {tab === 'ordens' && <OrdensServicoPanel workOrders={workOrders} storeConfigs={storeConfigs} updateWorkOrderStatus={updateWorkOrderStatus} />}
      {tab === 'cadastro' && <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6">
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
                    <td className="p-3 font-bold text-slate-900">
                      {service.name}
                      {!nfseComplete(service) && <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100" title="Sem os códigos da NFS-e o serviço não sai em nota fiscal">DADOS FISCAIS PENDENTES</span>}
                    </td>
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
          <label className="block text-xs font-bold text-slate-700">Código<input value={form.sku} placeholder="Automático (gerado ao salvar)" onChange={event => setForm({ ...form, sku: sanitizeItemCode(event.target.value) })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-mono outline-none" /><span className="block mt-1 text-[10px] font-normal text-slate-400">Deixe em branco para o sistema gerar um código (6 ou 7 números, começando com 7 ou 9). Só letras, números e hífen.</span></label>
          <label className="block text-xs font-bold text-slate-700">Nome<input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" /></label>
          <label className="block text-xs font-bold text-slate-700">Categoria<input required value={form.category} onChange={event => setForm({ ...form, category: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" /></label>
          <label className="block text-xs font-bold text-slate-700">Preço de venda (R$)<ValueInput required value={form.sellPrice || null} onValueChange={value => setForm({ ...form, sellPrice: value ?? 0 })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" /></label>
          <fieldset className="border border-slate-200 rounded-lg p-3 space-y-2">
            <legend className="px-1 text-[10px] font-bold uppercase text-slate-500">Nota fiscal de serviço (NFS-e)</legend>
            <label className="block text-xs font-bold text-slate-700">Tipo de serviço
              <select
                value={NFSE_PRESETS.findIndex(preset => preset.serviceCode === form.nfseServiceCode && preset.nbsCode === form.nfseNbsCode)}
                onChange={event => {
                  const preset = NFSE_PRESETS[Number(event.target.value)];
                  if (preset) setForm({ ...form, nfseServiceCode: preset.serviceCode, nfseNbsCode: preset.nbsCode });
                }}
                className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none"
              >
                <option value={-1}>Outro (digitar os códigos)</option>
                {NFSE_PRESETS.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs font-bold text-slate-700">Cód. tributação nacional<input value={form.nfseServiceCode} placeholder="140201" onChange={event => setForm({ ...form, nfseServiceCode: event.target.value.replace(/\D/g, '').slice(0, 6) })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-mono outline-none" /></label>
              <label className="block text-xs font-bold text-slate-700">Código NBS<input value={form.nfseNbsCode} placeholder="120013000" onChange={event => setForm({ ...form, nfseNbsCode: event.target.value.replace(/\D/g, '').slice(0, 9) })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-mono outline-none" /></label>
            </div>
            <label className="block text-xs font-bold text-slate-700">Cód. tributação municipal <span className="font-normal text-slate-400">(só se a prefeitura exigir)</span><input value={form.nfseMunicipalCode} maxLength={3} onChange={event => setForm({ ...form, nfseMunicipalCode: event.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 3) })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 font-mono outline-none" /></label>
            <label className="block text-xs font-bold text-slate-700">Texto na nota <span className="font-normal text-slate-400">(em branco usa o nome)</span><input value={form.nfseDescription} onChange={event => setForm({ ...form, nfseDescription: event.target.value })} className="mt-1.5 w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none" /></label>
          </fieldset>
          <label className="flex items-center gap-2 text-xs font-bold text-slate-700"><input type="checkbox" checked={form.isActive} onChange={event => setForm({ ...form, isActive: event.target.checked })} className="w-4 h-4" />Serviço ativo para venda</label>
          <div className="flex gap-2 pt-1">
            {editingId && <button type="button" onClick={() => { setEditingId(null); setForm(emptyForm); }} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>}
            <button type="submit" disabled={busy} className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-60 flex items-center gap-2">{editingId ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}{busy ? 'Salvando...' : editingId ? 'Salvar alterações' : 'Cadastrar serviço'}</button>
          </div>
        </form>
      </section>}
    </div>
  );
}
