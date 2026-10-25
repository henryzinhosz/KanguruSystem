import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Check, Pencil, Plus, Save, Search, ShieldAlert, ShieldCheck, UserRound } from 'lucide-react';
import { Customer, Product, Sale, StoreConfig } from '../types';
import { supabaseService } from '../db/supabaseService';
import { formatMoney } from '../db/finance';

interface ClientesViewProps {
  sales: Sale[];
  products: Product[];
  storeConfigs: StoreConfig[];
}

type CustomerForm = {
  id: string | null;
  cpf: string;
  name: string;
  phone: string;
  email: string;
  cep: string;
  address: string;
  addressNumber: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  lgpdConsent: '' | 'SIM' | 'NAO';
  notes: string;
  isActive: boolean;
};

const EMPTY_FORM: CustomerForm = {
  id: null, cpf: '', name: '', phone: '', email: '', cep: '', address: '', addressNumber: '',
  complement: '', district: '', city: '', state: '', lgpdConsent: '', notes: '', isActive: true
};

const onlyDigits = (value: string) => value.replace(/\D/g, '');

export const formatCpf = (value: string | null | undefined) => {
  const digits = onlyDigits(value ?? '');
  return digits.length === 11 ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}` : value ?? '';
};

const maskCpf = (value: string) => {
  const digits = onlyDigits(value).slice(0, 11);
  return digits
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1-$2');
};

const maskCep = (value: string) => {
  const digits = onlyDigits(value).slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
};

// Mesma regra do banco (is_valid_cpf).
const isValidCpf = (value: string) => {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
};

// Fim da garantia: data da venda + meses (ate o fim do dia).
const warrantyEnd = (saleDate: string, months: number) => {
  const end = new Date(saleDate);
  end.setMonth(end.getMonth() + months);
  end.setHours(23, 59, 59, 999);
  return end;
};

const inputClass = 'mt-1 w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:ring-1 focus:ring-blue-500 font-medium';

export default function ClientesView({ sales, products, storeConfigs }: ClientesViewProps) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerForm>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [cepStatus, setCepStatus] = useState('');

  const storeName = (unitId: string) => storeConfigs.find(store => store.unitId === unitId)?.tradeName || unitId;

  const load = async () => {
    setLoading(true);
    try {
      setCustomers(await supabaseService.getCustomers());
    } catch (loadError: any) {
      setError(loadError?.message || 'Não foi possível carregar os clientes.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const digits = onlyDigits(search);
    if (!query) return customers;
    return customers.filter(customer =>
      customer.name.toLowerCase().includes(query)
      || (digits && (customer.cpf.startsWith(digits) || String(customer.code) === digits))
      || customer.phone.includes(search.trim()));
  }, [customers, search]);

  const selected = customers.find(customer => customer.id === selectedId) || null;

  // Historico: vendas com o CPF do cliente (de qualquer loja), uma linha por item de produto.
  const history = useMemo(() => {
    if (!selected) return [];
    return sales
      .filter(sale => onlyDigits(sale.clientCpf ?? '') === selected.cpf)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .flatMap(sale => (sale.items || [])
        .filter(item => (item.itemType ?? 'PRODUCT') === 'PRODUCT')
        .map(item => {
          const product = products.find(p => p.id === item.productId);
          const months = product?.warrantyMonths ?? 0;
          return { sale, item, product, months, end: months > 0 ? warrantyEnd(sale.timestamp, months) : null };
        }));
  }, [selected, sales, products]);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setError('');
    setMessage('');
    setCepStatus('');
  };

  const openEdit = (customer: Customer) => {
    setForm({
      id: customer.id,
      cpf: maskCpf(customer.cpf),
      name: customer.name,
      phone: customer.phone,
      email: customer.email ?? '',
      cep: maskCep(customer.cep ?? ''),
      address: customer.address ?? '',
      addressNumber: customer.addressNumber ?? '',
      complement: customer.complement ?? '',
      district: customer.district ?? '',
      city: customer.city ?? '',
      state: customer.state ?? '',
      lgpdConsent: customer.lgpdConsent ? 'SIM' : 'NAO',
      notes: customer.notes ?? '',
      isActive: customer.isActive
    });
    setFormOpen(true);
    setError('');
    setMessage('');
    setCepStatus('');
  };

  // Endereco pelo CEP (ViaCEP).
  const changeCep = async (value: string) => {
    const masked = maskCep(value);
    setForm(current => ({ ...current, cep: masked }));
    setCepStatus('');
    if (onlyDigits(masked).length !== 8) return;
    setCepStatus('Buscando endereço...');
    try {
      const response = await fetch(`https://viacep.com.br/ws/${onlyDigits(masked)}/json/`);
      const data = await response.json();
      if (!response.ok || data.erro) {
        setCepStatus('CEP não encontrado. Preencha o endereço à mão.');
        return;
      }
      setForm(current => ({
        ...current,
        address: data.logradouro || current.address,
        district: data.bairro || current.district,
        city: data.localidade || current.city,
        state: data.uf || current.state
      }));
      setCepStatus('');
    } catch {
      setCepStatus('Não foi possível consultar o CEP agora. Preencha o endereço à mão.');
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!isValidCpf(form.cpf)) { setError('CPF inválido. Confira os números.'); return; }
    if (!form.name.trim() || !form.phone.trim()) { setError('Informe nome e celular do cliente.'); return; }
    if (!form.lgpdConsent) { setError('Responda o consentimento LGPD do cliente.'); return; }
    setBusy(true);
    try {
      await supabaseService.saveCustomer({
        id: form.id,
        cpf: onlyDigits(form.cpf),
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        cep: onlyDigits(form.cep) || null,
        address: form.address.trim() || null,
        addressNumber: form.addressNumber.trim() || null,
        complement: form.complement.trim() || null,
        district: form.district.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim().toUpperCase() || null,
        lgpdConsent: form.lgpdConsent === 'SIM',
        notes: form.notes.trim() || null,
        isActive: form.isActive
      });
      await load();
      setFormOpen(false);
      setMessage(form.id ? 'Cliente atualizado.' : 'Cliente cadastrado.');
    } catch (saveError: any) {
      setError(saveError?.message || 'Não foi possível salvar o cliente.');
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof CustomerForm, label: string, extra: Record<string, unknown> = {}) => (
    <label className="block text-xs font-bold text-slate-700">
      {label}
      <input
        value={form[key] as string}
        onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))}
        className={inputClass}
        {...extra}
      />
    </label>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Clientes</h2>
          <p className="text-xs text-slate-500">Cadastro único para todas as lojas. Usado nas vendas do PDV, nas reservas e na garantia.</p>
        </div>
        <button type="button" onClick={openNew} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg flex items-center gap-2">
          <Plus className="w-4 h-4" /> Novo cliente
        </button>
      </header>

      {message && <p role="status" className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><Check className="w-4 h-4" />{message}</p>}
      {error && !formOpen && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}

      <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-3 border-b border-slate-100 relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-6 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Buscar por nome, CPF, código ou telefone"
              className="w-full bg-slate-50 text-xs rounded-lg pl-9 pr-3 py-2.5 border border-slate-200 outline-none focus:ring-1 focus:ring-blue-500 font-semibold"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-500 uppercase text-[10px]">
                <tr><th className="p-3">Código</th><th className="p-3">Cliente</th><th className="p-3">CPF</th><th className="p-3">Celular</th><th className="p-3">Cidade</th><th className="p-3 text-right">Ações</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map(customer => (
                  <tr key={customer.id} onClick={() => setSelectedId(customer.id)} className={`cursor-pointer ${customer.id === selectedId ? 'bg-blue-50/60' : 'hover:bg-slate-50'}`}>
                    <td className="p-3 font-mono text-slate-500">{customer.code}</td>
                    <td className="p-3 font-bold text-slate-900">
                      {customer.name}
                      {!customer.isActive && <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[9px] font-bold">INATIVO</span>}
                    </td>
                    <td className="p-3 font-mono text-slate-600">{formatCpf(customer.cpf)}</td>
                    <td className="p-3 text-slate-600">{customer.phone}</td>
                    <td className="p-3 text-slate-600">{customer.city ? `${customer.city}${customer.state ? `/${customer.state}` : ''}` : '—'}</td>
                    <td className="p-3 text-right">
                      <button type="button" title="Editar cliente" onClick={event => { event.stopPropagation(); openEdit(customer); }} className="p-2 text-blue-700 rounded-lg hover:bg-blue-50"><Pencil className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ))}
                {!loading && filtered.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Nenhum cliente encontrado.</td></tr>}
                {loading && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Carregando clientes...</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {formOpen ? (
          <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 h-fit">
            <div className="flex items-center gap-2"><UserRound className="w-5 h-5 text-blue-600" /><h3 className="text-sm font-bold text-slate-900">{form.id ? 'Editar cliente' : 'Novo cliente'}</h3></div>
            {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-bold text-slate-700">
                CPF
                <input required inputMode="numeric" placeholder="000.000.000-00" value={form.cpf} onChange={event => setForm(current => ({ ...current, cpf: maskCpf(event.target.value) }))} className={inputClass} />
              </label>
              {field('phone', 'Celular', { required: true, type: 'tel' })}
            </div>
            {field('name', 'Nome completo', { required: true, maxLength: 160 })}
            {field('email', 'E-mail (opcional)', { type: 'email' })}
            <div className="grid grid-cols-3 gap-3">
              <label className="block text-xs font-bold text-slate-700">
                CEP
                <input inputMode="numeric" placeholder="00000-000" value={form.cep} onChange={event => void changeCep(event.target.value)} className={inputClass} />
              </label>
              <div className="col-span-2">{field('address', 'Endereço')}</div>
            </div>
            {cepStatus && <p className="text-[11px] text-slate-500">{cepStatus}</p>}
            <div className="grid grid-cols-3 gap-3">
              {field('addressNumber', 'Número')}
              <div className="col-span-2">{field('complement', 'Complemento')}</div>
            </div>
            <div className="grid grid-cols-[1fr_1fr_70px] gap-3">
              {field('district', 'Bairro')}
              {field('city', 'Cidade')}
              {field('state', 'UF', { maxLength: 2 })}
            </div>
            <label className="block text-xs font-bold text-slate-700">
              Consentimento <span className="font-normal text-slate-400">(LGPD - Lei nº 13.709)</span>
              <select required value={form.lgpdConsent} onChange={event => setForm(current => ({ ...current, lgpdConsent: event.target.value as CustomerForm['lgpdConsent'] }))} className={inputClass}>
                <option value="">Selecione</option>
                <option value="SIM">Sim, o cliente autoriza o uso dos dados</option>
                <option value="NAO">Não autoriza</option>
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-700">
              Observação
              <textarea rows={2} value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} className={inputClass} />
            </label>
            <label className="flex items-center gap-2 text-xs font-bold text-slate-700"><input type="checkbox" checked={form.isActive} onChange={event => setForm(current => ({ ...current, isActive: event.target.checked }))} className="w-4 h-4" />Cliente ativo</label>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setFormOpen(false)} className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg">Cancelar</button>
              <button type="submit" disabled={busy} className="ml-auto px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-60 flex items-center gap-2">
                {form.id ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}{busy ? 'Salvando...' : form.id ? 'Salvar alterações' : 'Cadastrar cliente'}
              </button>
            </div>
          </form>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 h-fit">
            {!selected ? (
              <p className="text-xs text-slate-400 text-center py-8">Selecione um cliente na lista para ver os dados e o histórico de compras.</p>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Cliente código {selected.code}</p>
                    <h3 className="text-base font-bold text-slate-900">{selected.name}</h3>
                    <p className="text-xs text-slate-600">CPF {formatCpf(selected.cpf)} · {selected.phone}{selected.email ? ` · ${selected.email}` : ''}</p>
                    {selected.address && (
                      <p className="text-xs text-slate-500 mt-1">
                        {selected.address}{selected.addressNumber ? `, ${selected.addressNumber}` : ''}{selected.complement ? ` - ${selected.complement}` : ''}
                        {selected.district ? ` · ${selected.district}` : ''}{selected.city ? ` · ${selected.city}/${selected.state ?? ''}` : ''}
                      </p>
                    )}
                    <p className="text-[11px] text-slate-500 mt-1">
                      LGPD: {selected.lgpdConsent ? `autorizado${selected.lgpdConsentAt ? ` em ${new Date(selected.lgpdConsentAt).toLocaleDateString('pt-BR')}` : ''}` : 'não autorizado'}
                    </p>
                  </div>
                  <button type="button" onClick={() => openEdit(selected)} className="p-2 text-blue-700 rounded-lg hover:bg-blue-50" title="Editar cliente"><Pencil className="w-4 h-4" /></button>
                </div>
                <div>
                  <h4 className="text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-2">Compras e garantia</h4>
                  {history.length === 0 ? (
                    <p className="text-xs text-slate-400">Nenhuma compra registrada com este CPF.</p>
                  ) : (
                    <ul className="space-y-2">
                      {history.map(({ sale, item, product, months, end }, index) => {
                        const canceled = sale.status === 'CANCELADA';
                        const valid = !canceled && end !== null && end.getTime() >= Date.now();
                        return (
                          <li key={`${sale.id}-${index}`} className={`border rounded-lg p-3 text-xs ${canceled ? 'border-slate-200 bg-slate-50 text-slate-400' : 'border-slate-200'}`}>
                            <div className="flex justify-between gap-2">
                              <strong className="text-slate-900">{item.itemName || product?.name || 'Produto'}</strong>
                              <span className="font-mono">{formatMoney(item.lineTotal ?? item.unitPrice * item.quantity)}</span>
                            </div>
                            <p className="text-slate-500">
                              {new Date(sale.timestamp).toLocaleDateString('pt-BR')} · {storeName(sale.unitId)}{sale.sellerName ? ` · ${sale.sellerName}` : ''}
                              {item.serials?.length ? ` · Série ${item.serials.join(', ')}` : ` · ${item.quantity} un.`}
                            </p>
                            <p className={`mt-1 font-bold flex items-center gap-1 ${canceled ? 'text-slate-400' : valid ? 'text-emerald-700' : 'text-rose-600'}`}>
                              {valid ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                              {canceled ? 'Venda estornada' : end ? `${valid ? 'Em garantia' : 'Garantia vencida'} · até ${end.toLocaleDateString('pt-BR')} (${months} meses)` : 'Sem garantia'}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
