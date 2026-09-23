/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Supplier, SupplierInvoiceReminder } from '../types';
import { supabaseService } from '../db/supabaseService';
import { 
  Trash2, 
  AlertTriangle, 
  CheckCircle, 
  Truck, 
  Plus,
  DollarSign,
  Calendar,
  Clock,
  AlertCircle,
  PlusCircle,
  X,
  Check,
  Edit
} from 'lucide-react';

interface AdminToolsViewProps {
  onResetDb: () => void;
  importBulkProducts: (csvText: string) => number;
  suppliers: Supplier[];
  addSupplier: (supplier: Omit<Supplier, 'id' | 'historyCount'>) => Supplier;
  editSupplier: (updatedSupplier: Supplier) => void;
  deleteSupplier: (id: string) => void;
}

export default function AdminToolsView({
  onResetDb,
  importBulkProducts,
  suppliers,
  addSupplier,
  editSupplier,
  deleteSupplier
}: AdminToolsViewProps) {
  const [reminders, setReminders] = useState<SupplierInvoiceReminder[]>([]);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [invoiceSuccess, setInvoiceSuccess] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<{ kind: 'invoice' | 'supplier'; id: string; name: string } | null>(null);

  // Supplier invoices are managed in Supabase because they are part of accounts payable.
  useEffect(() => {
    let active = true;

    void supabaseService.getSupplierInvoices()
      .then(invoices => {
        if (active) setReminders(invoices);
      })
      .catch(err => {
        if (active) setInvoiceError(err.message || 'Não foi possível carregar as contas a pagar.');
      });

    return () => {
      active = false;
    };
  }, []);

  // Form states
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [supplierId, setSupplierId] = useState<string>('');
  const [customSupplierName, setCustomSupplierName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [amount, setAmount] = useState<number>(0);
  const [dueDate, setDueDate] = useState<string>('');
  const [installments, setInstallments] = useState<string>('Boleto (A prazo)');
  const [notes, setNotes] = useState<string>('');
  const [formError, setFormError] = useState<string>('');

  // Supplier modal/editing states
  const [showSupplierModal, setShowSupplierModal] = useState<boolean>(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [supplierFormName, setSupplierFormName] = useState<string>('');
  const [supplierFormCnpj, setSupplierFormCnpj] = useState<string>('');
  const [supplierFormContact, setSupplierFormContact] = useState<string>('');
  const [supplierFormCategory, setSupplierFormCategory] = useState<string>('');
  const [supplierFormPhone, setSupplierFormPhone] = useState<string>('');
  const [supplierFormWebsite, setSupplierFormWebsite] = useState<string>('');
  const [supplierFormError, setSupplierFormError] = useState<string>('');

  // Handle supplier addition/editing
  const handleSupplierFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSupplierFormError('');

    if (!supplierFormName.trim()) {
      setSupplierFormError('Por favor, informe o nome do fornecedor.');
      return;
    }
    if (!supplierFormCnpj.trim()) {
      setSupplierFormError('Por favor, informe o CNPJ do fornecedor.');
      return;
    }

    if (editingSupplier) {
      editSupplier({
        ...editingSupplier,
        name: supplierFormName.trim(),
        cnpj: supplierFormCnpj.trim(),
        contact: supplierFormContact.trim(),
        category: supplierFormCategory.trim(),
        phone: supplierFormPhone.trim() || undefined,
        website: supplierFormWebsite.trim() || undefined,
      });
    } else {
      addSupplier({
        name: supplierFormName.trim(),
        cnpj: supplierFormCnpj.trim(),
        contact: supplierFormContact.trim(),
        category: supplierFormCategory.trim(),
        phone: supplierFormPhone.trim() || undefined,
        website: supplierFormWebsite.trim() || undefined,
      });
    }

    setShowSupplierModal(false);
    setEditingSupplier(null);
    setSupplierFormName('');
    setSupplierFormCnpj('');
    setSupplierFormContact('');
    setSupplierFormCategory('');
    setSupplierFormPhone('');
    setSupplierFormWebsite('');
  };

  // Handle reminder creation
  const handleAddReminder = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setInvoiceError(null);
    setInvoiceSuccess(null);

    if (!supplierId) {
      setFormError('Selecione um fornecedor ou insira um personalizado.');
      return;
    }

    let finalSupplierName = '';
    if (supplierId === 'custom') {
      if (!customSupplierName.trim()) {
        setFormError('Por favor, digite o nome do fornecedor personalizado.');
        return;
      }
      finalSupplierName = customSupplierName.trim();
    } else {
      const found = suppliers.find(s => s.id === supplierId);
      finalSupplierName = found ? found.name : 'Fornecedor';
    }

    if (!description.trim()) {
      setFormError('Por favor, descreva a fatura.');
      return;
    }

    if (amount <= 0) {
      setFormError('Insira um valor válido maior que zero.');
      return;
    }

    if (!dueDate) {
      setFormError('Selecione a data de vencimento.');
      return;
    }

    const newReminder: SupplierInvoiceReminder = {
      id: `rem-${Date.now()}`,
      supplierId,
      supplierName: finalSupplierName,
      description: description.trim(),
      amount,
      dueDate,
      installments: installments.trim(),
      status: 'PENDENTE',
      notes: notes.trim() || undefined,
      createdAt: new Date().toISOString().split('T')[0]
    };

    try {
      await supabaseService.upsertSupplierInvoice(newReminder);
      setReminders(previous => [newReminder, ...previous]);
      setInvoiceSuccess('Conta a pagar cadastrada com sucesso.');
    } catch (err: any) {
      setInvoiceError(err.message || 'Não foi possível salvar a conta a pagar.');
      return;
    }
    
    // Reset form states
    setSupplierId('');
    setCustomSupplierName('');
    setDescription('');
    setAmount(0);
    setDueDate('');
    setInstallments('Boleto (A prazo)');
    setNotes('');
    setShowAddForm(false);
  };

  // Toggle invoice status
  const handleToggleStatus = async (id: string) => {
    const current = reminders.find(rem => rem.id === id);
    if (!current) return;

    const updated = { ...current, status: current.status === 'PENDENTE' ? 'PAGO' as const : 'PENDENTE' as const };
    setInvoiceError(null);
    setInvoiceSuccess(null);

    try {
      await supabaseService.upsertSupplierInvoice(updated);
      setReminders(previous => previous.map(rem => rem.id === id ? updated : rem));
      setInvoiceSuccess(updated.status === 'PAGO' ? 'Conta marcada como paga.' : 'Conta marcada como pendente.');
    } catch (err: any) {
      setInvoiceError(err.message || 'Não foi possível atualizar a conta a pagar.');
    }
  };

  // Delete reminder
  const handleDeleteReminder = (id: string) => {
    const reminder = reminders.find(item => item.id === id);
    if (reminder) {
      setPendingDeletion({ kind: 'invoice', id, name: reminder.description });
    }
  };

  const handleConfirmDeletion = async () => {
    if (!pendingDeletion) return;

    const deletion = pendingDeletion;
    setPendingDeletion(null);

    if (deletion.kind === 'supplier') {
      deleteSupplier(deletion.id);
      return;
    }

    setInvoiceError(null);
    setInvoiceSuccess(null);
    try {
      await supabaseService.deleteSupplierInvoice(deletion.id);
      setReminders(previous => previous.filter(rem => rem.id !== deletion.id));
      setInvoiceSuccess('Conta a pagar excluída.');
    } catch (err: any) {
      setInvoiceError(err.message || 'Não foi possível excluir a conta a pagar.');
    }
  };

  // Statistics calculation
  const totalPending = reminders
    .filter(r => r.status === 'PENDENTE')
    .reduce((sum, r) => sum + r.amount, 0);

  const totalPaid = reminders
    .filter(r => r.status === 'PAGO')
    .reduce((sum, r) => sum + r.amount, 0);

  const todayStr = new Date().toISOString().split('T')[0];
  const totalOverdue = reminders
    .filter(r => r.status === 'PENDENTE' && r.dueDate < todayStr)
    .reduce((sum, r) => sum + r.amount, 0);

  const overdueCount = reminders.filter(r => r.status === 'PENDENTE' && r.dueDate < todayStr).length;

  return (
    <div className="space-y-6 w-full font-sans text-xs">
      {pendingDeletion && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/45 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-sm font-bold text-slate-900">Confirmar exclusão</h2>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              {pendingDeletion.kind === 'invoice'
                ? `Excluir a conta a pagar “${pendingDeletion.name}”?`
                : `Excluir o fornecedor “${pendingDeletion.name}”?`}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDeletion(null)}
                className="px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDeletion()}
                className="px-3 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg"
              >
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* LEFT COLUMN: Lembretes de Faturas a Prazo (Grid span 2) */}
      <div className="lg:col-span-2 space-y-6">
        
        {/* Statistics Widgets */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center justify-between">
            <div>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">A Pagar (Pendente)</p>
              <h3 className="text-lg font-black text-slate-800 mt-1 font-mono">
                R$ {totalPending.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </h3>
            </div>
            <div className="bg-amber-50 text-amber-600 border border-amber-100 p-2.5 rounded-lg">
              <Clock className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center justify-between">
            <div>
              <p className="text-[10px] text-rose-500 font-bold uppercase tracking-wider">Atrasado / Vencido</p>
              <h3 className="text-lg font-black text-rose-600 mt-1 font-mono">
                R$ {totalOverdue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </h3>
              <p className="text-[9px] text-rose-500 font-semibold mt-0.5">{overdueCount} {overdueCount === 1 ? 'fatura vencida' : 'faturas vencidas'}</p>
            </div>
            <div className="bg-rose-50 text-rose-600 border border-rose-100 p-2.5 rounded-lg">
              <AlertCircle className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center justify-between">
            <div>
              <p className="text-[10px] text-emerald-500 font-bold uppercase tracking-wider">Faturas Pagas</p>
              <h3 className="text-lg font-black text-emerald-600 mt-1 font-mono">
                R$ {totalPaid.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </h3>
            </div>
            <div className="bg-emerald-50 text-emerald-600 border border-emerald-100 p-2.5 rounded-lg">
              <CheckCircle className="w-5 h-5" />
            </div>
          </div>
        </div>

        {/* Reminders List & Form Box */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-4">
          <div className="flex justify-between items-center flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
                <Calendar className="w-5 h-5 text-blue-600 mr-2" />
                Lembretes de Faturas de Fornecedores (Prazo)
              </h3>
              <p className="text-xs text-slate-400">Gerencie e monitore duplicatas, notas promissórias e compras faturadas a prazo.</p>
            </div>
            
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition flex items-center space-x-1 shadow-xs text-xs"
            >
              {showAddForm ? (
                <>
                  <X className="w-3.5 h-3.5" />
                  <span>Cancelar</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Novo Lembrete</span>
                </>
              )}
            </button>
          </div>

          {invoiceError && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{invoiceError}</span>
            </div>
          )}

          {invoiceSuccess && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs font-medium flex items-center gap-2">
              <CheckCircle className="w-4 h-4 shrink-0" />
              <span>{invoiceSuccess}</span>
            </div>
          )}

          {/* Form to Add New Invoice Reminder */}
          {showAddForm && (
            <form onSubmit={handleAddReminder} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-4">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Cadastrar Lembrete de Fatura</h4>
              
              {formError && (
                <div className="p-2.5 bg-rose-50 border border-rose-100 text-rose-700 rounded-lg text-xs font-semibold flex items-center space-x-1.5">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Supplier selection */}
                <div className="space-y-1">
                  <label className="font-bold text-slate-600 block">Fornecedor</label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                  >
                    <option value="">-- Selecione o Fornecedor --</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                    <option value="custom">-- Outro Fornecedor (Personalizado) --</option>
                  </select>
                </div>

                {/* Custom supplier input */}
                {supplierId === 'custom' && (
                  <div className="space-y-1">
                    <label className="font-bold text-slate-600 block">Nome do Fornecedor</label>
                    <input
                      type="text"
                      placeholder="Ex: Copag Distribuição, Importador X"
                      value={customSupplierName}
                      onChange={(e) => setCustomSupplierName(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                    />
                  </div>
                )}

                {/* Amount (R$) */}
                <div className="space-y-1">
                  <label className="font-bold text-slate-600 block">Valor da Fatura (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount || ''}
                    onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none font-mono font-semibold"
                  />
                </div>

                {/* Description */}
                <div className="space-y-1 md:col-span-2">
                  <label className="font-bold text-slate-600 block">Descrição da Compra / Itens</label>
                  <input
                    type="text"
                    placeholder="Ex: Compra de 10 unidades de Consoles Nintendo Switch OLED"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                  />
                </div>

                {/* Due Date */}
                <div className="space-y-1">
                  <label className="font-bold text-slate-600 block">Data de Vencimento</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none font-mono font-semibold"
                  />
                </div>

                {/* Conditions / Installments */}
                <div className="space-y-1">
                  <label className="font-bold text-slate-600 block">Parcelamento / Condições</label>
                  <input
                    type="text"
                    placeholder="Ex: Boleto 30 dias, Parcelado 3x sem juros"
                    value={installments}
                    onChange={(e) => setInstallments(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                  />
                </div>

                {/* Observations */}
                <div className="space-y-1 md:col-span-2">
                  <label className="font-bold text-slate-600 block">Observações / Anotações</label>
                  <textarea
                    rows={2}
                    placeholder="Informações adicionais como agência, código do boleto, responsável pelo recebimento..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none font-semibold text-slate-700"
                  />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition shadow-xs text-xs"
                >
                  Confirmar Cadastro
                </button>
              </div>
            </form>
          )}

          {/* Table of Invoices */}
          <div className="overflow-x-auto border border-slate-200/80 rounded-xl">
            <table className="w-full text-xs text-left text-slate-500">
              <thead className="text-[10px] text-slate-400 uppercase bg-slate-50/80 font-bold border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3">Fornecedor / Compra</th>
                  <th className="px-3 py-3 text-right">Valor</th>
                  <th className="px-3 py-3 text-center">Vencimento</th>
                  <th className="px-3 py-3 text-center">Condições</th>
                  <th className="px-3 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {reminders.map((rem) => {
                  const isOverdue = rem.status === 'PENDENTE' && rem.dueDate < todayStr;
                  
                  // Calculate days left
                  const dueTime = new Date(rem.dueDate).getTime();
                  const todayTime = new Date(todayStr).getTime();
                  const diffDays = Math.ceil((dueTime - todayTime) / (1000 * 60 * 60 * 24));

                  return (
                    <tr key={rem.id} className={`hover:bg-slate-50/40 transition duration-150 ${isOverdue ? 'bg-rose-50/10' : ''}`}>
                      <td className="px-4 py-3">
                        <span className="font-bold text-slate-900 block">{rem.supplierName}</span>
                        <span className="text-[10px] text-slate-500 block leading-tight mt-0.5">{rem.description}</span>
                        {rem.notes && (
                          <span className="text-[9px] text-slate-400 block mt-1 italic font-medium">Obs: {rem.notes}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-mono font-bold text-slate-900">
                        R$ {rem.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-3 text-center font-mono">
                        <span className={`px-2 py-1 rounded-md text-[10px] font-bold inline-block ${
                          rem.status === 'PAGO'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                            : isOverdue
                              ? 'bg-rose-50 text-rose-600 border border-rose-200 font-black animate-pulse'
                              : diffDays <= 5
                                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                : 'bg-slate-50 text-slate-600 border border-slate-200'
                        }`}>
                          {rem.dueDate.split('-').reverse().join('/')}
                        </span>
                        
                        {rem.status === 'PENDENTE' && (
                          <span className={`block text-[9px] mt-1 font-semibold ${
                            isOverdue 
                              ? 'text-rose-600' 
                              : diffDays <= 5 
                                ? 'text-amber-600' 
                                : 'text-slate-400'
                          }`}>
                            {isOverdue 
                              ? `Vencido há ${Math.abs(diffDays)}d` 
                              : diffDays === 0 
                                ? 'Vence hoje!' 
                                : `Faltam ${diffDays} dias`}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center text-slate-600 font-medium">
                        {rem.installments}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <button
                          id={`btn-toggle-invoice-status-${rem.id}`}
                          onClick={() => handleToggleStatus(rem.id)}
                          className={`px-2.5 py-1 rounded text-[10px] font-bold border transition duration-150 inline-flex items-center space-x-1 ${
                            rem.status === 'PAGO'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100/50'
                              : 'bg-amber-50 text-amber-600 border-amber-200 hover:bg-amber-100/50'
                          }`}
                        >
                          {rem.status === 'PAGO' ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              <span>Pago</span>
                            </>
                          ) : (
                            <>
                              <Clock className="w-3.5 h-3.5" />
                              <span>Pendente</span>
                            </>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          id={`btn-delete-invoice-reminder-${rem.id}`}
                          onClick={() => handleDeleteReminder(rem.id)}
                          className="text-slate-400 hover:text-rose-600 p-1.5 hover:bg-rose-50 rounded-lg transition"
                          title="Excluir Lembrete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {reminders.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-slate-400 py-10">Nenhum lembrete de fatura cadastrado.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* RIGHT COLUMN: Fornecedores Homologados (Dados) */}
      <div className="space-y-6 lg:col-span-1">
        
        {/* Suppliers List Card */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
                <Truck className="w-5 h-5 text-blue-600 mr-2" />
                Fornecedores Homologados (Dados)
              </h3>
              <p className="text-xs text-slate-400">Contatos e dados com parceiros de distribuição.</p>
            </div>
            
            <button
              id="btn-add-supplier-top"
              onClick={() => {
                setEditingSupplier(null);
                setSupplierFormName('');
                setSupplierFormCnpj('');
                setSupplierFormContact('');
                setSupplierFormCategory('');
                setSupplierFormPhone('');
                setSupplierFormWebsite('');
                setSupplierFormError('');
                setShowSupplierModal(true);
              }}
              className="p-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200 rounded-lg transition"
              title="Adicionar Fornecedor"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-3">
            {suppliers.map(s => {
              // Calculate reminders count for this supplier
              const supplierReminders = reminders.filter(r => r.supplierId === s.id);
              const pendingReminders = supplierReminders.filter(r => r.status === 'PENDENTE');
              
              return (
                <div key={s.id} className="group relative p-3 bg-slate-50 rounded-lg border border-slate-200/60 space-y-1.5 hover:bg-slate-100/50 transition duration-150">
                  {/* Hover actions */}
                  <div className="absolute top-2 right-2 hidden group-hover:flex items-center space-x-1 bg-white p-1 rounded-md shadow-xs border border-slate-200/60 z-10">
                    <button
                      id={`btn-edit-supplier-${s.id}`}
                      onClick={() => {
                        setEditingSupplier(s);
                        setSupplierFormName(s.name);
                        setSupplierFormCnpj(s.cnpj);
                        setSupplierFormContact(s.contact);
                        setSupplierFormCategory(s.category);
                        setSupplierFormPhone(s.phone || '');
                        setSupplierFormWebsite(s.website || '');
                        setSupplierFormError('');
                        setShowSupplierModal(true);
                      }}
                      className="p-1 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded transition"
                      title="Editar Fornecedor"
                    >
                      <Edit className="w-3.5 h-3.5" />
                    </button>
                    <button
                      id={`btn-delete-supplier-${s.id}`}
                      onClick={() => setPendingDeletion({ kind: 'supplier', id: s.id, name: s.name })}
                      className="p-1 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded transition"
                      title="Excluir Fornecedor"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex justify-between items-start pr-12">
                    <span className="font-bold text-slate-800 text-[11px] leading-tight">{s.name}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 font-sans space-y-0.5">
                    <p>CNPJ: <span className="font-mono text-slate-700">{s.cnpj}</span></p>
                    <p>E-mail: <span className="text-slate-700">{s.contact || 'Não informado'}</span></p>
                    <p>Categoria: <span className="text-slate-700 font-medium">{s.category || 'Não informado'}</span></p>
                    <p>Número: <span className="text-slate-700">{s.phone || 'Não informado'}</span></p>
                    <p>Site: {s.website ? (
                      <a href={s.website.startsWith('http') ? s.website : `https://${s.website}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">{s.website}</a>
                    ) : (
                      <span className="text-slate-400">Não informado</span>
                    )}</p>
                  </div>

                  {/* Inline indicator of active invoices */}
                  {pendingReminders.length > 0 && (
                    <div className="pt-1.5 border-t border-slate-200/50 mt-1 flex justify-between items-center">
                      <span className="text-[9px] text-amber-600 font-bold flex items-center">
                        <Clock className="w-3 h-3 mr-0.5" />
                        A prazo pendente
                      </span>
                      <span className="text-[9px] font-mono font-bold text-slate-700">
                        {pendingReminders.length} fat. (R$ {pendingReminders.reduce((sum, r) => sum + r.amount, 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })})
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            {suppliers.length === 0 && (
              <p className="text-center text-slate-400 py-6">Nenhum fornecedor cadastrado.</p>
            )}
          </div>
        </div>

        {/* Small informational help widget */}
        <div className="bg-blue-50/45 p-4 rounded-xl border border-blue-200/50 space-y-2">
          <h4 className="text-xs font-bold text-blue-800 uppercase tracking-wider flex items-center">
            <AlertCircle className="w-4 h-4 mr-1.5 text-blue-600" />
            Compras a Prazo
          </h4>
          <p className="text-[11px] text-slate-600 leading-relaxed font-sans">
            Quando você adquire produtos com prazos de pagamento faturados (como duplicatas 30/60 dias, consignados ou boletos parcelados), cadastre-os aqui para manter as previsões do fluxo de caixa sob controle e nunca perder prazos críticos de vencimento.
          </p>
        </div>
      </div>

      {/* MODAL: ADICIONAR / EDITAR FORNECEDOR */}
      {showSupplierModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white w-full max-w-md rounded-xl shadow-lg border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="flex justify-between items-center bg-slate-50 px-4 py-3 border-b border-slate-100">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                {editingSupplier ? 'Editar Fornecedor' : 'Adicionar Novo Fornecedor'}
              </h3>
              <button 
                onClick={() => setShowSupplierModal(false)}
                className="text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSupplierFormSubmit} className="p-4 space-y-3">
              {supplierFormError && (
                <div className="p-2 bg-rose-50 border border-rose-100 text-rose-700 rounded text-[11px] font-semibold flex items-center space-x-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                  <span>{supplierFormError}</span>
                </div>
              )}

              <div className="space-y-1">
                <label className="font-bold text-slate-600 block">Nome do Fornecedor *</label>
                <input
                  type="text"
                  placeholder="Ex: Copag Distribuidora"
                  value={supplierFormName}
                  onChange={(e) => setSupplierFormName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-semibold text-slate-800"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="font-bold text-slate-600 block">CNPJ *</label>
                <input
                  type="text"
                  placeholder="Ex: 00.123.456/0001-99"
                  value={supplierFormCnpj}
                  onChange={(e) => setSupplierFormCnpj(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono font-semibold text-slate-800"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="font-bold text-slate-600 block">E-mail / Contato</label>
                <input
                  type="email"
                  placeholder="Ex: comercial@copag.com.br"
                  value={supplierFormContact}
                  onChange={(e) => setSupplierFormContact(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-semibold text-slate-800"
                />
              </div>

              <div className="space-y-1">
                <label className="font-bold text-slate-600 block">Categoria principal fornecida</label>
                <input
                  type="text"
                  placeholder="Ex: Cards Pokémon, Consoles"
                  value={supplierFormCategory}
                  onChange={(e) => setSupplierFormCategory(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-semibold text-slate-800"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="font-bold text-slate-600 block">Número (Telefone)</label>
                  <input
                    type="text"
                    placeholder="Ex: (11) 99999-9999"
                    value={supplierFormPhone}
                    onChange={(e) => setSupplierFormPhone(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-semibold text-slate-800"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-600 block">Site</label>
                  <input
                    type="text"
                    placeholder="Ex: www.copag.com.br"
                    value={supplierFormWebsite}
                    onChange={(e) => setSupplierFormWebsite(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-semibold text-slate-800"
                  />
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowSupplierModal(false)}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded font-bold transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold transition flex items-center space-x-1"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Salvar</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
    </div>
  );
}
