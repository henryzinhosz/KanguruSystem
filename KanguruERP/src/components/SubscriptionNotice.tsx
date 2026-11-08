import { AlertTriangle, LogOut, Mail, Phone, RefreshCw, ShieldX } from 'lucide-react';
import { SubscriptionStatus } from '../types';
import { SUPPORT_EMAIL, SUPPORT_PHONE, SubscriptionState, formatBillingDate, formatCompetence } from '../db/billing';

// Tela de assinatura bloqueada/cancelada e aviso de mensalidade em atraso.

export function SubscriptionBlockedScreen({ status, onLogout }: { status: SubscriptionStatus | null; onLogout: () => void }) {
  const cancelled = status === 'CANCELADO';
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 font-sans">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mb-4">
          <ShieldX className="w-7 h-7" />
        </div>
        <h1 className="text-xl font-bold text-slate-900">{cancelled ? 'Assinatura cancelada' : 'Assinatura bloqueada'}</h1>
        <p className="text-sm text-slate-500 mt-2">
          {cancelled
            ? 'O acesso ao Kanguru foi encerrado para esta empresa. Fale com o suporte para reativar.'
            : 'O acesso ao Kanguru foi suspenso por falta de pagamento da mensalidade. Fale com o suporte para regularizar.'}
        </p>
        <div className="mt-5 space-y-2 text-sm font-semibold text-slate-800">
          <p className="flex items-center justify-center gap-2"><Phone className="w-4 h-4 text-blue-600" />{SUPPORT_PHONE}</p>
          <p className="flex items-center justify-center gap-2"><Mail className="w-4 h-4 text-blue-600" />{SUPPORT_EMAIL}</p>
        </div>
        <div className="mt-6 flex gap-2">
          <button type="button" onClick={onLogout} className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
            <LogOut className="w-4 h-4" />Sair
          </button>
          <button type="button" onClick={() => window.location.reload()} className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-blue-700">
            <RefreshCw className="w-4 h-4" />Já regularizei
          </button>
        </div>
      </div>
    </div>
  );
}

export function SubscriptionOverdueBanner({ state }: { state: SubscriptionState }) {
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 text-sm text-amber-900 flex flex-wrap items-center gap-x-2 gap-y-1" role="alert">
      <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
      <strong>Mensalidade de {formatCompetence(state.competence)} em atraso</strong>
      <span>Venceu em {formatBillingDate(state.dueDate)}. Regularize até {formatBillingDate(state.blockAfter)} para evitar o bloqueio do sistema.</span>
      <span className="font-semibold">{SUPPORT_PHONE} · {SUPPORT_EMAIL}</span>
    </div>
  );
}
