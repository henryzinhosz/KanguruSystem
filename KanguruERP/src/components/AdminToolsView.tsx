/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Product, StockInventory, StoreConfig, Supplier, User } from '../types';
import SupplierCatalogPanel from './SupplierCatalogPanel';
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
  currentUser: User;
  products: Product[];
  inventory: StockInventory[];
  storeConfigs: StoreConfig[];
  suppliers: Supplier[];
  addSupplier: (supplier: Omit<Supplier, 'id' | 'historyCount'>) => Promise<Supplier>;
  editSupplier: (updatedSupplier: Supplier) => Promise<void>;
  deleteSupplier: (id: string) => Promise<void>;
}

export default function AdminToolsView({
  currentUser,
  products,
  inventory,
  storeConfigs,
  suppliers,
  addSupplier,
  editSupplier,
  deleteSupplier
}: AdminToolsViewProps) {
  const [section, setSection] = useState<'contas' | 'catalogos'>('contas');
  const [listError, setListError] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<{ id: string; name: string } | null>(null);

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
  const handleSupplierFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSupplierFormError('');

    if (!supplierFormName.trim()) {
      setSupplierFormError('Por favor, informe o nome do fornecedor.');
      return;
    }
    try {
    if (editingSupplier) {
      await editSupplier({
        ...editingSupplier,
        name: supplierFormName.trim(),
        cnpj: supplierFormCnpj.trim(),
        contact: supplierFormContact.trim(),
        category: supplierFormCategory.trim(),
        phone: supplierFormPhone.trim() || undefined,
        website: supplierFormWebsite.trim() || undefined,
      });
    } else {
      await addSupplier({
        name: supplierFormName.trim(),
        cnpj: supplierFormCnpj.trim(),
        contact: supplierFormContact.trim(),
        category: supplierFormCategory.trim(),
        phone: supplierFormPhone.trim() || undefined,
        website: supplierFormWebsite.trim() || undefined,
      });
    }
    } catch (error) {
      setSupplierFormError(`Não foi possível salvar o fornecedor: ${error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco'}`);
      return;
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

const handleConfirmDeletion = async () => {
    if (!pendingDeletion) return;
    const deletion = pendingDeletion;
    setPendingDeletion(null);
    setListError(null);
    try {
      await deleteSupplier(deletion.id);
    } catch (error) {
      setListError(`Não foi possível excluir o fornecedor: ${error instanceof Error ? error.message : (error as { message?: string })?.message || 'erro no banco'}`);
    }
  };

  
  const sectionTabs = (
    <div className="flex gap-2">
      {([['contas', 'Fornecedores'], ['catalogos', 'Catálogos e pedidos de compra']] as const).map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => setSection(key)}
          className={`px-4 py-2 rounded-lg text-xs font-bold border transition ${section === key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (section === 'catalogos') {
    return (
      <div className="space-y-4 w-full font-sans">
        {sectionTabs}
        <SupplierCatalogPanel currentUser={currentUser} suppliers={suppliers} products={products} inventory={inventory} storeConfigs={storeConfigs} />
      </div>
    );
  }

  return (
    <div className="space-y-6 w-full font-sans text-xs">
      {sectionTabs}
      {pendingDeletion && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/45 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-sm font-bold text-slate-900">Confirmar exclusão</h2>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              {`Excluir o fornecedor “${pendingDeletion.name}”?`}
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
      
      <div className="space-y-6">
          {listError && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{listError}</span>
            </div>
          )}

      {/* RIGHT COLUMN: Fornecedores Homologados (Dados) */}
      <div className="space-y-6">
        
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

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {suppliers.map(s => {
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
                      onClick={() => setPendingDeletion({ id: s.id, name: s.name })}
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
                    <p>CNPJ: <span className="font-mono text-slate-700">{s.cnpj || 'Não informado'}</span></p>
                    {s.brands && s.brands.length > 0 && (
                      <p>Marcas (reposição): <span className="text-slate-700 font-medium">{s.brands.join(', ')}</span></p>
                    )}
                    <p>E-mail: <span className="text-slate-700">{s.contact || 'Não informado'}</span></p>
                    <p>Categoria: <span className="text-slate-700 font-medium">{s.category || 'Não informado'}</span></p>
                    <p>Número: <span className="text-slate-700">{s.phone || 'Não informado'}</span></p>
                    <p>Site: {s.website ? (
                      <a href={s.website.startsWith('http') ? s.website : `https://${s.website}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">{s.website}</a>
                    ) : (
                      <span className="text-slate-400">Não informado</span>
                    )}</p>
                  </div>

                </div>
              );
            })}
            {suppliers.length === 0 && (
              <p className="text-center text-slate-400 py-6 col-span-full">Nenhum fornecedor cadastrado.</p>
            )}
          </div>
        </div>

        {/* Small informational help widget */}
        <div className="bg-blue-50/45 p-4 rounded-xl border border-blue-200/50 space-y-2">
          <h4 className="text-xs font-bold text-blue-800 uppercase tracking-wider flex items-center">
            <AlertCircle className="w-4 h-4 mr-1.5 text-blue-600" />
            Contas a pagar
          </h4>
          <p className="text-[11px] text-slate-600 leading-relaxed font-sans">
Boletos e compras a prazo dos fornecedores agora ficam em Livro Caixa & DRE › Contas a Pagar, com vencimento, parcelas e baixa (a conta paga vira despesa).
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
                <label className="font-bold text-slate-600 block">CNPJ</label>
                <input
                  type="text"
                  placeholder="Opcional. Ex: 00.123.456/0001-99"
                  value={supplierFormCnpj}
                  onChange={(e) => setSupplierFormCnpj(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded p-1.5 outline-none font-mono font-semibold text-slate-800"
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
