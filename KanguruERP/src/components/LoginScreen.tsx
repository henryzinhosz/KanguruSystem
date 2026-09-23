import React, { useState } from 'react';
import { supabase } from '../db/supabaseClient';
import { Lock, Mail, ChevronRight } from 'lucide-react';

interface LoginScreenProps {
  accessError?: string | null;
}

export default function LoginScreen({ accessError }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Por favor, preencha todos os campos.');
      return;
    }

    setIsSubmitting(true);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (signInError) {
        setError(signInError.message || 'E-mail ou senha incorretos.');
        return;
      }

      if (!data.user) {
        setError('Não foi possível autenticar o usuário.');
        return;
      }
    } catch (err: any) {
      setError(err?.message || 'Falha ao entrar no sistema.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col justify-center py-12 sm:px-6 lg:px-8 font-sans">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center space-y-3">
        <img
          src="/kanguru-erp-logo.png"
          alt="Kanguru ERP"
          className="mx-auto h-20 w-20 rounded-2xl object-cover shadow-lg shadow-blue-500/20"
        />
        <div>
          <h2 className="text-3xl font-extrabold text-white tracking-tight">Kanguru ERP</h2>
          <p className="mt-1 text-sm text-slate-400 font-medium">Controle Integrado de Lojas e Estoque</p>
        </div>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-slate-800/80 backdrop-blur-md py-8 px-4 border border-slate-700/60 shadow-2xl rounded-2xl sm:px-10 space-y-6">
          <form className="space-y-4" onSubmit={handleSubmit}>
            {(error || accessError) && (
              <div className="bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs p-3.5 rounded-xl font-medium">
                {error || accessError}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider">E-mail de Acesso</label>
              <div className="relative rounded-xl shadow-xs">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-4 w-4 text-slate-400" />
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="exemplo@vortex.com"
                  className="block w-full pl-10 pr-4 py-2.5 bg-slate-900/60 border border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder-slate-500 transition font-medium"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider">Senha Secreta</label>
              <div className="relative rounded-xl shadow-xs">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-4 w-4 text-slate-400" />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="block w-full pl-10 pr-4 py-2.5 bg-slate-900/60 border border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder-slate-500 transition font-mono"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex justify-center items-center py-2.5 px-4 border border-transparent rounded-xl shadow-md text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900 focus:ring-blue-500 transition duration-150 uppercase tracking-wider disabled:opacity-60"
            >
              <span>{isSubmitting ? 'Entrando...' : 'Entrar no Sistema'}</span>
              <ChevronRight className="w-4 h-4 ml-1 shrink-0" />
            </button>
          </form>

        </div>
      </div>
    </div>
  );
}
