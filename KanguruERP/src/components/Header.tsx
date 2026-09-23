/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { User, UserRole } from '../types';
import { LayoutPanelTop, LogOut } from 'lucide-react';

interface HeaderProps {
  currentUser: User;
  onLogout: () => void;
  isUcpActive?: boolean;
  onToggleUcp?: () => void;
}

export default function Header({ currentUser, onLogout, isUcpActive = false, onToggleUcp }: HeaderProps) {
  return (
    <header className="bg-white text-slate-800 border-b border-slate-200 shadow-sm sticky top-0 z-50">
      <div className="w-full px-3 sm:px-4">
        <div className="flex items-center justify-between h-[72px]">
          {/* Logo & Brand */}
          <div className="flex items-center space-x-3">
            <img
              src="/kanguru-erp-logo.png"
              alt="Kanguru ERP"
              className="h-12 w-12 rounded-lg object-cover shadow-sm"
            />
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900 flex items-center">
                Kanguru <span className="text-blue-600 ml-1">ERP</span>
              </h1>
            </div>
          </div>

          {/* User Profile & Logout */}
          <div className="flex items-center space-x-3">
            {currentUser.role === UserRole.SUPER_ADMIN && onToggleUcp && (
              <button
                type="button"
                onClick={onToggleUcp}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold transition ${
                  isUcpActive
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300 hover:bg-blue-100'
                }`}
                title={isUcpActive ? 'Voltar ao ERP' : 'Abrir UCP'}
              >
                <LayoutPanelTop className="h-4 w-4" />
                {isUcpActive ? 'ERP' : 'UCP'}
              </button>
            )}
            <div className="flex items-center space-x-2 pl-2 border-l border-slate-200">
              <div className="text-right hidden sm:block">
                <div className="text-sm font-bold text-slate-900">{currentUser.name}</div>
                <div className="text-xs text-slate-400 font-medium leading-none">
                  {currentUser.role === UserRole.SUPER_ADMIN ? 'Administração da Plataforma' : 'Gestor Comercial'}
                </div>
              </div>
              <button
                id="btn-logout"
                onClick={onLogout}
                className="p-2.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg border border-transparent hover:border-rose-100 transition duration-150 flex items-center shadow-xs"
                title="Sair da Conta"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
